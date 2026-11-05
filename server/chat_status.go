package main

import (
	"net/http"
	"time"
)

type ChatRead struct {
	Conversation string `json:"conversation"`
	User         string `json:"user"`
	Seq          int64  `json:"seq"`
}
type ChatActivity struct {
	Message string `json:"message"`
	User    string `json:"user"`
	State   string `json:"state"`
	Updated int64  `json:"updated"`
}

func (s *Server) readChat(w http.ResponseWriter, r *http.Request, id string) {
	var v ChatRead
	if !decode(w, r, &v) {
		return
	}
	var n int
	if s.db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation=? AND user_id=?`, v.Conversation, id).Scan(&n) != nil || n != 1 {
		fail(w, 403, "Conversation members only")
		return
	}
	if v.Seq < 1 || s.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE conversation=? AND seq=?`, v.Conversation, v.Seq).Scan(&n) != nil || n != 1 {
		fail(w, 400, "Invalid read position")
		return
	}
	if _, err := s.db.Exec(`INSERT INTO chat_reads VALUES(?,?,?) ON CONFLICT(conversation,user_id) DO UPDATE SET seq=MAX(seq,excluded.seq)`, v.Conversation, id, v.Seq); err != nil {
		fail(w, 500, "Storage failure")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (s *Server) activityChat(w http.ResponseWriter, r *http.Request, id string) {
	var v ChatActivity
	if !decode(w, r, &v) {
		return
	}
	allowed := map[string]bool{"waiting": true, "review": true, "accepted": true, "cancelled": true, "pending": true, "queued": true, "running": true, "awaiting_review": true, "reply_pending": true, "replied": true, "failed": true, "stopped": true, "rejected": true, "interrupted": true}
	if !allowed[v.State] {
		fail(w, 400, "Invalid activity")
		return
	}
	var n int
	if s.db.QueryRow(`SELECT COUNT(*) FROM chat_messages c JOIN conversation_members m ON m.conversation=c.conversation AND m.user_id=? WHERE c.id=? AND ((c.sender<>? AND (c.kind='text' OR (c.kind='question' AND EXISTS (SELECT 1 FROM json_each(c.mentions) WHERE value=m.user_id)))) OR (c.sender=m.user_id AND c.kind IN ('goal','commitment')))`, id, v.Message, id).Scan(&n) != nil || n != 1 {
		fail(w, 403, "Only the receiving member may report activity")
		return
	}
	if _, err := s.db.Exec(`INSERT INTO chat_activity VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET state=excluded.state,updated=excluded.updated`, v.Message, id, v.State, time.Now().UnixMilli()); err != nil {
		fail(w, 500, "Storage failure")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (s *Server) chatStatus(id string) ([]ChatRead, []ChatActivity, error) {
	reads := []ChatRead{}
	activities := []ChatActivity{}
	rows, err := s.db.Query(`SELECT r.conversation,r.user_id,r.seq FROM chat_reads r JOIN conversation_members m ON m.conversation=r.conversation AND m.user_id=?`, id)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var v ChatRead
		if err = rows.Scan(&v.Conversation, &v.User, &v.Seq); err != nil {
			rows.Close()
			return nil, nil, err
		}
		reads = append(reads, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	rows, err = s.db.Query(`SELECT a.message_id,a.user_id,a.state,a.updated FROM chat_activity a JOIN chat_messages c ON c.id=a.message_id JOIN conversation_members m ON m.conversation=c.conversation AND m.user_id=? ORDER BY a.updated DESC LIMIT 1000`, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v ChatActivity
		if err = rows.Scan(&v.Message, &v.User, &v.State, &v.Updated); err != nil {
			return nil, nil, err
		}
		activities = append(activities, v)
	}
	return reads, activities, rows.Err()
}
