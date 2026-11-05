package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

func teamKind(k string) bool {
	return k == "proposal" || k == "amendment" || k == "commitment" || k == "completion" || k == "withdrawal" || k == "closure"
}

func validateTeam(tx *sql.Tx, m *ChatMessage, goal ChatMessage) error {
	bad := func() error {
		return errors.New("Collaboration requires current, personally confirmed scope; refresh and confirm your own participation")
	}
	var closed int
	if err := tx.QueryRow("SELECT COUNT(*) FROM chat_messages WHERE project=? AND kind='closure'", goal.ID).Scan(&closed); err != nil {
		return err
	}
	if closed > 0 {
		return errors.New("Collaboration is closed")
	}
	revision := goal.ID
	var newest string
	err := tx.QueryRow("SELECT id FROM chat_messages WHERE project=? AND kind='amendment' ORDER BY seq DESC LIMIT 1", goal.ID).Scan(&newest)
	if err == nil {
		revision = newest
	} else if err != sql.ErrNoRows {
		return err
	}
	latest := func(user string) (ChatMessage, error) {
		return scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.project=? AND c.sender=? AND c.kind='commitment' ORDER BY c.seq DESC LIMIT 1`, goal.ID, user))
	}
	active := func(c ChatMessage) bool {
		if c.TaskID != revision {
			return false
		}
		var n int
		return tx.QueryRow("SELECT COUNT(*) FROM chat_messages WHERE task_id=? AND kind='withdrawal'", c.ID).Scan(&n) == nil && n == 0
	}
	if m.Kind == "amendment" {
		if m.Agent != "" || m.TaskID != revision {
			return bad()
		}
		return nil
	}
	if m.Kind == "commitment" {
		var v struct {
			Role       string `json:"role"`
			Scope      string `json:"scope"`
			Acceptance string `json:"acceptance"`
			Mode       string `json:"mode"`
		}
		if m.Agent != "" || m.TaskID != revision || json.Unmarshal([]byte(m.Text), &v) != nil || strings.TrimSpace(v.Role) == "" || strings.TrimSpace(v.Scope) == "" || strings.TrimSpace(v.Acceptance) == "" || len(v.Role) > 120 || len(v.Scope) > 12000 || len(v.Acceptance) > 12000 || (v.Mode != "agent" && v.Mode != "human") {
			return bad()
		}
		return nil
	}
	if m.Kind == "closure" {
		if m.From != goal.From || m.Agent != "" || m.TaskID != revision {
			return bad()
		}
		rows, e := tx.Query(`SELECT `+chatCols+` FROM chat_messages c WHERE c.project=? AND c.kind='commitment' AND c.seq=(SELECT MAX(x.seq) FROM chat_messages x WHERE x.project=c.project AND x.sender=c.sender AND x.kind='commitment')`, goal.ID)
		if e != nil {
			return e
		}
		members := []ChatMessage{}
		for rows.Next() {
			c, e := scanChat(rows)
			if e != nil {
				rows.Close()
				return e
			}
			members = append(members, c)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		count := 0
		for _, c := range members {
			var withdrawn int
			if e = tx.QueryRow("SELECT COUNT(*) FROM chat_messages WHERE task_id=? AND kind='withdrawal'", c.ID).Scan(&withdrawn); e != nil {
				return e
			}
			if withdrawn > 0 {
				continue
			}
			if !active(c) {
				return bad()
			}
			count++
			var n int
			if e = tx.QueryRow("SELECT COUNT(*) FROM chat_messages WHERE task_id=? AND kind='completion' AND sender=?", c.ID, c.From).Scan(&n); e != nil {
				return e
			}
			if n == 0 {
				return errors.New("Every participant must confirm their own completion first")
			}
		}
		if count == 0 {
			return bad()
		}
		return nil
	}
	own, e := latest(m.From)
	if e != nil || !active(own) {
		return bad()
	}
	if m.Kind == "answer" {
		q, e := scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.id=?`, m.TaskID))
		if e != nil || q.Kind != "question" || q.Project != goal.ID || q.Conversation != m.Conversation || len(q.Mentions) != 1 || q.Mentions[0] != m.From {
			return bad()
		}
		sender, e := latest(q.From)
		if e != nil || !active(sender) || sender.ID != q.TaskID {
			return bad()
		}
		return nil
	}
	if m.TaskID != own.ID {
		return bad()
	}
	if m.Kind == "completion" || m.Kind == "withdrawal" {
		if m.Agent != "" {
			return bad()
		}
		return nil
	}
	if m.Kind == "question" {
		if len(m.Mentions) != 1 || m.Mentions[0] == m.From {
			return bad()
		}
		other, e := latest(m.Mentions[0])
		if e != nil || !active(other) {
			return bad()
		}
		return nil
	}
	if m.Kind == "progress" {
		return nil
	}
	return bad()
}
