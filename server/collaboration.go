package main

import (
	"database/sql"
	"errors"
)

func collaborationKind(kind string) bool {
	return teamKind(kind) || kind == "goal" || kind == "question" || kind == "answer" || kind == "progress" || kind == "decision"
}

func validateCollaboration(tx *sql.Tx, m *ChatMessage) error {
	if m.Agent != "" {
		m.Agent = m.From
	}
	if m.Kind == "goal" || m.Kind == "proposal" {
		if m.Project != "" || m.TaskID != "" || m.Agent != "" {
			return errors.New("Invalid goal")
		}
		return nil
	}
	goal, err := scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.id=?`, m.Project))
	if err != nil || (goal.Kind != "goal" && goal.Kind != "proposal") || goal.Conversation != m.Conversation {
		return errors.New("Goal must belong to this conversation")
	}
	if goal.Kind == "proposal" {
		return validateTeam(tx, m, goal)
	}
	if m.Kind == "answer" {
		q, e := scanChat(tx.QueryRow(`SELECT `+chatCols+` FROM chat_messages c WHERE c.id=?`, m.TaskID))
		if e != nil || q.Kind != "question" || q.Conversation != m.Conversation || q.Project != m.Project || len(q.Mentions) != 1 || q.Mentions[0] != m.From {
			return errors.New("Only the addressed member can answer this question")
		}
	} else {
		if goal.From != m.From || m.TaskID != "" {
			return errors.New("Only the goal owner can update this task")
		}
		if m.Kind == "question" && (len(m.Mentions) != 1 || m.Mentions[0] == m.From) {
			return errors.New("Choose one colleague for this question")
		}
	}
	if m.Kind == "decision" {
		m.Agent = ""
	}
	return nil
}
