package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Profile struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Role     string   `json:"role"`
	Projects []string `json:"projects"`
	Seen     int64    `json:"seen"`
}
type Message struct {
	ID      string `json:"id"`
	Topic   string `json:"topic"`
	From    string `json:"from"`
	To      string `json:"to"`
	Kind    string `json:"kind"`
	ReplyTo string `json:"replyTo"`
	Project string `json:"project"`
	Text    string `json:"text"`
	Created int64  `json:"created"`
}
type window struct {
	Count int
	Until time.Time
}
type Server struct {
	db      *sql.DB
	invite  string
	mu      sync.Mutex
	windows map[string]window
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$`)

func openServer(path, invite string) (*Server, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, projects TEXT NOT NULL, seen INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL, topic TEXT NOT NULL,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,reply_to TEXT NOT NULL,project TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS inbox_idx ON messages(recipient,acked,seq);
 CREATE INDEX IF NOT EXISTS topic_idx ON messages(topic,seq);
 CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,a TEXT NOT NULL,b TEXT NOT NULL,project TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	if _, err = db.Exec(chatSchema); err != nil {
		db.Close()
		return nil, err
	}
	s := &Server{db: db, invite: invite, windows: map[string]window{}}
	if err = s.migrateChat(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 131072)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		fail(w, 400, "Invalid JSON body")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		fail(w, 400, "Only one JSON object is allowed")
		return false
	}
	return true
}
func validProfile(p Profile) bool {
	if !identifier.MatchString(p.ID) || len(strings.TrimSpace(p.Name)) == 0 || len(p.Name) > 120 || len(p.Role) > 1000 || len(p.Projects) > 30 {
		return false
	}
	for _, v := range p.Projects {
		if !identifier.MatchString(v) {
			return false
		}
	}
	return true
}
func (s *Server) allow(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.windows) > 5000 {
		for k, v := range s.windows {
			if now.After(v.Until) {
				delete(s.windows, k)
			}
		}
	}
	if _, exists := s.windows[key]; !exists && len(s.windows) >= 5000 {
		return false
	}
	v := s.windows[key]
	if now.After(v.Until) {
		v = window{Until: now.Add(time.Minute)}
	}
	v.Count++
	s.windows[key] = v
	return v.Count <= 180
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/health" && r.Method == "GET" {
		respond(w, 200, map[string]string{"status": "ok", "service": "mesho"})
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	limitKey := "anonymous:" + host
	if token := r.Header.Get("Authorization"); strings.HasPrefix(token, "Bearer ") {
		limitKey = "credential:" + hash(token)
	}
	if !s.allow(limitKey) {
		fail(w, 429, "Too many requests; retry later")
		return
	}
	if r.URL.Path == "/v1/register" && r.Method == "POST" {
		s.register(w, r)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	var id string
	if token == "" || s.db.QueryRow("SELECT id FROM users WHERE token=?", hash(token)).Scan(&id) != nil {
		fail(w, 401, "Invalid access token")
		return
	}
	switch {
	case strings.HasPrefix(r.URL.Path, "/v1/chat/"):
		s.chat(w, r, id)
	case r.URL.Path == "/v1/me" && r.Method == "GET":
		respond(w, 200, map[string]string{"id": id})
	case r.URL.Path == "/v1/profile" && r.Method == "PUT":
		var p Profile
		if !decode(w, r, &p) {
			return
		}
		p.ID = id
		if !validProfile(p) {
			fail(w, 400, "Invalid profile")
			return
		}
		projects, _ := json.Marshal(p.Projects)
		if _, err := s.db.Exec("UPDATE users SET name=?,role=?,projects=?,seen=? WHERE id=?", p.Name, p.Role, string(projects), time.Now().UnixMilli(), id); err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	case r.URL.Path == "/v1/peers" && r.Method == "GET":
		rows, err := s.db.Query("SELECT id,name,role,projects,seen FROM users ORDER BY name LIMIT 1000")
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		defer rows.Close()
		list := []Profile{}
		for rows.Next() {
			var p Profile
			var projects string
			if rows.Scan(&p.ID, &p.Name, &p.Role, &projects, &p.Seen) != nil {
				fail(w, 500, "Storage failure")
				return
			}
			_ = json.Unmarshal([]byte(projects), &p.Projects)
			list = append(list, p)
		}
		respond(w, 200, list)
	case r.URL.Path == "/v1/messages" && r.Method == "POST":
		s.send(w, r, id)
	case r.URL.Path == "/v1/inbox" && r.Method == "GET":
		rows, err := s.db.Query("SELECT id,topic,sender,recipient,kind,reply_to,project,body,created FROM messages WHERE recipient=? AND acked=0 ORDER BY seq LIMIT 100", id)
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		defer rows.Close()
		items := []Message{}
		for rows.Next() {
			var m Message
			if rows.Scan(&m.ID, &m.Topic, &m.From, &m.To, &m.Kind, &m.ReplyTo, &m.Project, &m.Text, &m.Created) != nil {
				fail(w, 500, "Storage failure")
				return
			}
			items = append(items, m)
		}
		respond(w, 200, items)
	case r.URL.Path == "/v1/ack" && r.Method == "POST":
		var v struct {
			IDs []string `json:"ids"`
		}
		if !decode(w, r, &v) {
			return
		}
		if len(v.IDs) > 100 {
			fail(w, 400, "At most 100 receipts")
			return
		}
		tx, err := s.db.Begin()
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		defer tx.Rollback()
		for _, mid := range v.IDs {
			if _, err = tx.Exec("UPDATE messages SET acked=1 WHERE id=? AND recipient=?", mid, id); err != nil {
				fail(w, 500, "Storage failure")
				return
			}
		}
		if tx.Commit() != nil {
			fail(w, 500, "Storage failure")
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	default:
		fail(w, 404, "Not found")
	}
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Invite  string  `json:"invite"`
		Profile Profile `json:"profile"`
	}
	if !decode(w, r, &v) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(hash(v.Invite)), []byte(hash(s.invite))) != 1 {
		fail(w, 403, "Invalid invitation")
		return
	}
	if !validProfile(v.Profile) {
		fail(w, 400, "Invalid profile")
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		fail(w, 500, "Unable to create identity")
		return
	}
	token := hex.EncodeToString(b)
	p, _ := json.Marshal(v.Profile.Projects)
	_, err := s.db.Exec("INSERT INTO users VALUES(?,?,?,?,?,?)", v.Profile.ID, hash(token), v.Profile.Name, v.Profile.Role, string(p), time.Now().UnixMilli())
	if err != nil {
		fail(w, 409, "Identity already exists or cannot be created")
		return
	}
	respond(w, 201, map[string]string{"token": token, "id": v.Profile.ID})
}
func (s *Server) send(w http.ResponseWriter, r *http.Request, id string) {
	var m Message
	if !decode(w, r, &m) {
		return
	}
	m.From = id
	m.Created = time.Now().UnixMilli()
	if !identifier.MatchString(m.ID) || !identifier.MatchString(m.Topic) || !identifier.MatchString(m.To) || !identifier.MatchString(m.Project) || m.To == id || len(strings.TrimSpace(m.Text)) == 0 || len(m.Text) > 64000 || (m.Kind != "request" && m.Kind != "result" && m.Kind != "notice") {
		fail(w, 400, "Invalid message")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		fail(w, 500, "Storage failure")
		return
	}
	defer tx.Rollback()
	var old Message
	err = tx.QueryRow("SELECT id,topic,sender,recipient,kind,reply_to,project,body,created FROM messages WHERE id=?", m.ID).Scan(&old.ID, &old.Topic, &old.From, &old.To, &old.Kind, &old.ReplyTo, &old.Project, &old.Text, &old.Created)
	if err == nil {
		m.Created = old.Created
		if m != old {
			fail(w, 409, "Message ID already used")
			return
		}
		respond(w, 200, old)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "Storage failure")
		return
	}
	var exists string
	if tx.QueryRow("SELECT id FROM users WHERE id=?", m.To).Scan(&exists) != nil {
		fail(w, 404, "Recipient not found")
		return
	}
	var a, b, project string
	err = tx.QueryRow("SELECT a,b,project FROM topics WHERE id=?", m.Topic).Scan(&a, &b, &project)
	if errors.Is(err, sql.ErrNoRows) {
		if m.Kind != "request" {
			fail(w, 400, "A topic starts with a request")
			return
		}
		if _, err = tx.Exec("INSERT INTO topics VALUES(?,?,?,?)", m.Topic, id, m.To, m.Project); err != nil {
			fail(w, 500, "Storage failure")
			return
		}
	} else if err != nil {
		fail(w, 500, "Storage failure")
		return
	} else if !((a == id && b == m.To) || (b == id && a == m.To)) || project != m.Project {
		fail(w, 403, "Topic participants and project are fixed")
		return
	}
	if m.Kind == "result" && m.ReplyTo == "" {
		fail(w, 400, "Result requires replyTo")
		return
	}
	if m.ReplyTo != "" {
		var parent Message
		err = tx.QueryRow("SELECT topic,sender,recipient,kind FROM messages WHERE id=?", m.ReplyTo).Scan(&parent.Topic, &parent.From, &parent.To, &parent.Kind)
		if err != nil || parent.Topic != m.Topic || parent.From != m.To || parent.To != id || (m.Kind == "result" && parent.Kind != "request") {
			fail(w, 400, "Invalid reply relationship")
			return
		}
	}
	_, err = tx.Exec("INSERT INTO messages(id,topic,sender,recipient,kind,reply_to,project,body,created) VALUES(?,?,?,?,?,?,?,?,?)", m.ID, m.Topic, id, m.To, m.Kind, m.ReplyTo, m.Project, m.Text, m.Created)
	if err == nil {
		err = mirrorReply(tx, m)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "Storage failure")
		return
	}
	respond(w, 201, m)
}
func main() {
	addr := flag.String("listen", "127.0.0.1:7331", "listen address")
	db := flag.String("db", "mesho.db", "SQLite database path")
	cert := flag.String("tls-cert", "", "TLS certificate")
	key := flag.String("tls-key", "", "TLS private key")
	insecure := flag.Bool("allow-insecure-lan", false, "explicitly allow plaintext LAN traffic for development")
	flag.Parse()
	invite := os.Getenv("MESHO_INVITE")
	if len(invite) < 16 {
		log.Fatal("Set MESHO_INVITE to a random invitation of at least 16 characters")
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatal(err)
	}
	ip := net.ParseIP(host)
	if (ip == nil || !ip.IsLoopback()) && *cert == "" && !*insecure {
		log.Fatal("LAN binding requires TLS, or explicit --allow-insecure-lan for development")
	}
	s, err := openServer(*db, invite)
	if err != nil {
		log.Fatal(err)
	}
	defer s.db.Close()
	h := &http.Server{Addr: *addr, Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Shutdown(c)
	}()
	fmt.Printf("Mesho listening on %s\n", *addr)
	if *cert != "" {
		err = h.ListenAndServeTLS(*cert, *key)
	} else {
		err = h.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
