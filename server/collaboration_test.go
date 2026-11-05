package main

import (
	"path/filepath"
	"testing"
)

func TestCollaborationOwnershipAndReplyCorrelation(t *testing.T) {
	s, err := openServer(filepath.Join(t.TempDir(), "collab.db"), "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	a, b, c := user(t, s, "alice"), user(t, s, "bob"), user(t, s, "carol")
	call(s, "POST", "/v1/chat/conversations", a, Conversation{ID: "room", Kind: "group", Name: "Team", Members: []string{"bob", "carol"}})
	send := func(token string, m ChatMessage, want int) {
		t.Helper()
		code, body := call(s, "POST", "/v1/chat/messages", token, m)
		if code != want {
			t.Fatalf("%s: %d %s", m.Kind, code, body)
		}
	}
	goal := ChatMessage{ID: "goal", Conversation: "room", Kind: "goal", Text: "Build feature"}
	send(a, goal, 201)
	q := ChatMessage{ID: "q1", Conversation: "room", Kind: "question", Project: "goal", Text: "What is the API?", Mentions: []string{"bob"}, Agent: "alice"}
	send(b, q, 400)
	send(a, q, 201)
	send(a, q, 200)
	answer := ChatMessage{ID: "a1", Conversation: "room", Kind: "answer", Project: "goal", TaskID: "q1", Text: "customerId"}
	send(c, answer, 400)
	send(b, answer, 201)
	send(b, answer, 200)
	answer.ID = "cross"
	answer.Project = "absent"
	send(b, answer, 400)
	decision := ChatMessage{ID: "decision", Conversation: "room", Kind: "decision", Project: "goal", Text: "Accepted"}
	send(b, decision, 400)
	send(a, decision, 201)
	if code, _ := call(s, "POST", "/v1/chat/activity", b, ChatActivity{Message: "q1", State: "running"}); code != 200 {
		t.Fatal("recipient cannot report progress", code)
	}
	if code, _ := call(s, "POST", "/v1/chat/activity", c, ChatActivity{Message: "q1", State: "running"}); code != 403 {
		t.Fatal("unaddressed member can report progress", code)
	}
	if code, _ := call(s, "POST", "/v1/chat/activity", a, ChatActivity{Message: "goal", State: "waiting"}); code != 200 {
		t.Fatal("owner cannot report task state", code)
	}
}
