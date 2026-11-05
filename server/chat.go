package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const chatSchema = `
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,owner TEXT NOT NULL,created INTEGER NOT NULL,direct_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS conversation_members(conversation TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(conversation,user_id));
CREATE INDEX IF NOT EXISTS members_user ON conversation_members(user_id,conversation);
CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL,sender TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,mentions TEXT NOT NULL,agent TEXT NOT NULL,project TEXT NOT NULL,task_id TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_conversation ON chat_messages(conversation,seq);
CREATE INDEX IF NOT EXISTS chat_task ON chat_messages(task_id);
CREATE INDEX IF NOT EXISTS chat_goal_events ON chat_messages(project,kind,seq);
CREATE TABLE IF NOT EXISTS chat_reads(conversation TEXT NOT NULL,user_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(conversation,user_id));
CREATE TABLE IF NOT EXISTS chat_activity(message_id TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(message_id,user_id));
`

type Conversation struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	Name    string   `json:"name"`
	Owner   string   `json:"owner"`
	Members []string `json:"members"`
	Created int64    `json:"created"`
}
type ChatMessage struct {
	Seq          int64    `json:"seq"`
	ID           string   `json:"id"`
	Conversation string   `json:"conversation"`
	From         string   `json:"from"`
	Kind         string   `json:"kind"`
	Text         string   `json:"text"`
	Mentions     []string `json:"mentions"`
	Agent        string   `json:"agent"`
	Project      string   `json:"project"`
	TaskID       string   `json:"taskId"`
	Created      int64    `json:"created"`
}

const chatCols = `c.seq,c.id,c.conversation,c.sender,c.kind,c.body,c.mentions,c.agent,c.project,c.task_id,c.created`

func scanChat(row interface{ Scan(...any) error }) (ChatMessage, error) {
	var m ChatMessage
	var mentions string
	err := row.Scan(&m.Seq, &m.ID, &m.Conversation, &m.From, &m.Kind, &m.Text, &mentions, &m.Agent, &m.Project, &m.TaskID, &m.Created)
	_ = json.Unmarshal([]byte(mentions), &m.Mentions)
	if m.Mentions == nil {
		m.Mentions = []string{}
	}
	return m, err
}
func (s *Server) chat(w http.ResponseWriter, r *http.Request, id string) {
	switch {
	case r.URL.Path == "/v1/chat/read" && r.Method == "POST":
		s.readChat(w, r, id)
	case r.URL.Path == "/v1/chat/activity" && r.Method == "POST":
		s.activityChat(w, r, id)
	case r.URL.Path == "/v1/chat/conversations" && r.Method == "POST":
		s.createConversation(w, r, id)
	case r.URL.Path == "/v1/chat/messages" && r.Method == "POST":
		s.sendChat(w, r, id)
	case r.URL.Path == "/v1/chat/sync" && r.Method == "GET":
		after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		if err != nil || after < 0 {
			fail(w, 400, "Invalid cursor")
			return
		}
		rows, err := s.db.Query(`SELECT c.id,c.kind,c.name,c.owner,c.created,m.user_id FROM conversations c JOIN conversation_members own ON own.conversation=c.id AND own.user_id=? JOIN conversation_members m ON m.conversation=c.id ORDER BY c.created,c.id,m.user_id`, id)
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		list := []Conversation{}
		positions := map[string]int{}
		for rows.Next() {
			var c Conversation
			var member string
			if rows.Scan(&c.ID, &c.Kind, &c.Name, &c.Owner, &c.Created, &member) != nil {
				rows.Close()
				fail(w, 500, "Storage failure")
				return
			}
			index, ok := positions[c.ID]
			if !ok {
				index = len(list)
				positions[c.ID] = index
				c.Members = []string{}
				list = append(list, c)
			}
			list[index].Members = append(list[index].Members, member)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		rows, err = s.db.Query(`SELECT `+chatCols+` FROM chat_messages c JOIN conversation_members m ON m.conversation=c.conversation AND m.user_id=? WHERE c.seq>? ORDER BY c.seq LIMIT 200`, id, after)
		if err != nil {
			fail(w, 500, "Storage failure")
			return
		}
		defer rows.Close()
		messages := []ChatMessage{}
		cursor := after
		for rows.Next() {
			m, e := scanChat(rows)
			if e != nil {
				fail(w, 500, "Storage failure")
				return
			}
			messages = append(messages, m)
			cursor = m.Seq
		}
		if rows.Err() != nil {
			fail(w, 500, "Storage failure")
			return
		}
		rows.Close()
		receipts, activities, statusErr := s.chatStatus(id)
		if statusErr != nil {
			fail(w, 500, "Storage failure")
			return
		}
		respond(w, 200, map[string]any{"conversations": list, "messages": messages, "cursor": cursor, "receipts": receipts, "activities": activities})
	default:
		fail(w, 404, "Not found")
	}
}
func (s *Server) createConversation(w http.ResponseWriter, r *http.Request, id string) {
	var c Conversation
	if !decode(w, r, &c) {
		return
	}
	c.Name = strings.TrimSpace(c.Name)
	if !identifier.MatchString(c.ID) || (c.Kind != "direct" && c.Kind != "group") || len(c.Members) < 1 || len(c.Members) > 49 || (c.Kind == "group" && (c.Name == "" || len(c.Name) > 120)) {
		fail(w, 400, "Invalid conversation")
		return
	}
	set := map[string]bool{id: true}
	for _, v := range c.Members {
		if !identifier.MatchString(v) {
			fail(w, 400, "Invalid member")
			return
		}
		set[v] = true
	}
	c.Members = []string{}
	for v := range set {
		c.Members = append(c.Members, v)
	}
	sort.Strings(c.Members)
	if len(c.Members) < 2 || len(c.Members) > 50 || (c.Kind == "direct" && len(c.Members) != 2) {
		fail(w, 400, "Invalid member count")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		fail(w, 500, "Storage failure")
		return
	}
	defer tx.Rollback()
	var key any
	if c.Kind == "direct" {
		key = strings.Join(c.Members, ":")
		c.Name = ""
		var old Conversation
		err = tx.QueryRow(`SELECT id,kind,name,owner,created FROM conversations WHERE direct_key=?`, key).Scan(&old.ID, &old.Kind, &old.Name, &old.Owner, &old.Created)
		if err == nil {
			old.Members = c.Members
			respond(w, 200, old)
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			fail(w, 500, "Storage failure")
			return
		}
	}
	for _, v := range c.Members {
		var n int
		if tx.QueryRow(`SELECT COUNT(*) FROM users WHERE id=?`, v).Scan(&n) != nil || n != 1 {
			fail(w, 400, "Member not found")
			return
		}
		if tx.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE user_id=?`, v).Scan(&n) != nil || n >= 200 {
			fail(w, 409, "Member conversation limit reached")
			return
		}
	}
	c.Owner = id
	c.Created = time.Now().UnixMilli()
	_, err = tx.Exec(`INSERT INTO conversations VALUES(?,?,?,?,?,?)`, c.ID, c.Kind, c.Name, c.Owner, c.Created, key)
	if err != nil {
		fail(w, 409, "Conversation ID already exists")
		return
	}
	for _, v := range c.Members {
		if _, err = tx.Exec(`INSERT INTO conversation_members VALUES(?,?)`, c.ID, v); err != nil {
			fail(w, 500, "Storage failure")
			return
		}
	}
	if tx.Commit() != nil {
		fail(w, 500, "Storage failure")
		return
	}
	respond(w, 201, c)
}
func (s *Server) sendChat(w http.ResponseWriter, r *http.Request, id string) {
	var m ChatMessage
	if !decode(w, r, &m) {
		return
	}
	m.From = id
	m.Created = time.Now().UnixMilli()
	m.Seq = 0
	if m.Kind != "result" && !collaborationKind(m.Kind) {
		m.TaskID = ""
	}
	if !identifier.MatchString(m.ID) || !identifier.MatchString(m.Conversation) || len(strings.TrimSpace(m.Text)) == 0 || len(m.Text) > 60000 || len(m.Mentions) > 50 || (m.Kind != "text" && m.Kind != "task" && m.Kind != "result" && !collaborationKind(m.Kind)) {
		fail(w, 400, "Invalid chat message")
		return
	}
	sort.Strings(m.Mentions)
	mentions := []string{}
	for _, v := range m.Mentions {
		if !identifier.MatchString(v) {
			fail(w, 400, "Invalid mention")
			return
		}
		if len(mentions) == 0 || mentions[len(mentions)-1] != v {
			mentions = append(mentions, v)
		}
	}
	m.Mentions = mentions
	if m.Kind == "text" && (m.Agent != "" || m.Project != "") {
		fail(w, 400, "Text messages cannot start agents")
		return
	}
	if m.Kind == "task" && (!identifier.MatchString(m.Agent) || m.Agent == id || !identifier.MatchString(m.Project)) {
		fail(w, 400, "Choose a colleague agent and project")
		return
	}
	if m.Kind == "task" {
		m.TaskID = m.ID
	}
	tx, err := s.db.Begin()
	if err != nil {
		fail(w, 500, "Storage failure")
		return
	}
	defer tx.Rollback()
	member := func(user string) bool {
		var n int
		return tx.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation=? AND user_id=?`, m.Conversation, user).Scan(&n) == nil && n == 1
	}
	if !member(id) {
		fail(w, 403, "Conversation members only")
		return
	}
	for _, v := range m.Mentions {
		if !member(v) {
			fail(w, 400, "Mention must be a conversation member")
			return
		}
	}
	if m.Kind == "task" && !member(m.Agent) {
		fail(w, 403, "Agent must be a conversation member")
		return
	}
	if m.Kind == "result" {
		parent, lookupErr := scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.id=?`, m.TaskID))
		if lookupErr != nil || parent.Conversation != m.Conversation || parent.Kind != "text" || parent.From == id {
			fail(w, 400, "Agent reply requires a colleague message in this conversation")
			return
		}
		m.Agent = id
		m.Project = ""
	}
	old, err := scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.id=?`, m.ID))
	if err == nil {
		m.Seq = old.Seq
		m.Created = old.Created
		a, _ := json.Marshal(m)
		b, _ := json.Marshal(old)
		if string(a) != string(b) {
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
	if collaborationKind(m.Kind) {
		if err := validateCollaboration(tx, &m); err != nil {
			fail(w, 400, err.Error())
			return
		}
	}
	if m.Kind == "task" {
		// One explicit target, one ordinary task. Mentions alone never start execution.
		_, err = tx.Exec(`INSERT INTO topics VALUES(?,?,?,?)`, m.ID, id, m.Agent, m.Project)
		if err == nil {
			_, err = tx.Exec(`INSERT INTO messages(id,topic,sender,recipient,kind,reply_to,project,body,created) VALUES(?,?,?,?,?,?,?,?,?)`, m.ID, m.ID, id, m.Agent, "request", "", m.Project, m.Text, m.Created)
		}
		if err != nil {
			fail(w, 409, "Task ID already used")
			return
		}
	}
	seq, err := insertChat(tx, m)
	if err != nil || tx.Commit() != nil {
		fail(w, 500, "Storage failure")
		return
	}
	m.Seq = seq
	respond(w, 201, m)
}
func insertChat(tx *sql.Tx, m ChatMessage) (int64, error) {
	mentions, _ := json.Marshal(m.Mentions)
	result, err := tx.Exec(`INSERT INTO chat_messages(id,conversation,sender,kind,body,mentions,agent,project,task_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)`, m.ID, m.Conversation, m.From, m.Kind, m.Text, string(mentions), m.Agent, m.Project, m.TaskID, m.Created)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}
func mirrorReply(tx *sql.Tx, m Message) error {
	if m.Kind == "request" {
		members := []string{m.From, m.To}
		sort.Strings(members)
		key := strings.Join(members, ":")
		var conversation string
		err := tx.QueryRow("SELECT id FROM conversations WHERE direct_key=?", key).Scan(&conversation)
		if errors.Is(err, sql.ErrNoRows) {
			conversation = "direct-" + hash(key)[:40]
			if _, err = tx.Exec("INSERT INTO conversations VALUES(?,?,?,?,?,?)", conversation, "direct", "", m.From, m.Created, key); err != nil {
				return err
			}
			for _, id := range members {
				if _, err = tx.Exec("INSERT INTO conversation_members VALUES(?,?)", conversation, id); err != nil {
					return err
				}
			}
		} else if err != nil {
			return err
		}
		_, err = insertChat(tx, ChatMessage{ID: "task-" + hash(m.ID)[:40], Conversation: conversation, From: m.From, Kind: "task", Text: m.Text, Mentions: []string{}, Agent: m.To, Project: m.Project, TaskID: m.ID, Created: m.Created})
		return err
	}
	if m.ReplyTo == "" {
		return nil
	}
	var conversation string
	err := tx.QueryRow(`SELECT conversation FROM chat_messages WHERE task_id=?`, m.ReplyTo).Scan(&conversation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = insertChat(tx, ChatMessage{ID: "reply-" + hash(m.ID)[:40], Conversation: conversation, From: m.From, Kind: "result", Text: m.Text, Mentions: []string{}, Agent: m.From, Project: m.Project, TaskID: m.ID, Created: m.Created})
	return err
}

// Import existing task conversations once, preserving original message timestamps.
func (s *Server) migrateChat() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS chat_migrations(id INTEGER PRIMARY KEY)`); err != nil {
		return err
	}
	var done int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM chat_migrations WHERE id=1").Scan(&done); err != nil {
		return err
	}
	if done == 1 {
		return nil
	}
	rows, err := s.db.Query(`SELECT id,topic,sender,recipient,kind,reply_to,project,body,created FROM messages ORDER BY seq`)
	if err != nil {
		return err
	}
	list := []Message{}
	for rows.Next() {
		var m Message
		if err = rows.Scan(&m.ID, &m.Topic, &m.From, &m.To, &m.Kind, &m.ReplyTo, &m.Project, &m.Text, &m.Created); err != nil {
			rows.Close()
			return err
		}
		list = append(list, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, m := range list {
		var n int
		if err = tx.QueryRow("SELECT COUNT(*) FROM chat_messages WHERE task_id=?", m.ID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if err = mirrorReply(tx, m); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec("INSERT INTO chat_migrations VALUES(1)"); err != nil {
		return err
	}
	return tx.Commit()
}
