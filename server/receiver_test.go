package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestReceiverOwnedReply(t *testing.T) {
	s, err := openServer(filepath.Join(t.TempDir(), "reply.db"), "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	a, b, c := user(t, s, "alice"), user(t, s, "bob"), user(t, s, "outsider")
	call(s, "POST", "/v1/chat/conversations", a, Conversation{ID: "dm", Kind: "direct", Members: []string{"bob"}})
	call(s, "POST", "/v1/chat/messages", a, ChatMessage{ID: "hello", Conversation: "dm", Kind: "text", Text: "hello", Mentions: []string{}})
	reply := ChatMessage{ID: "reply", Conversation: "dm", Kind: "result", Text: "answer", TaskID: "hello", Agent: "alice", Mentions: []string{}}
	code, body := call(s, "POST", "/v1/chat/messages", b, reply)
	if code != 201 {
		t.Fatalf("reply %d %s", code, body)
	}
	var result ChatMessage
	json.Unmarshal(body, &result)
	if result.From != "bob" || result.Agent != "bob" {
		t.Fatal("reply spoofed identity")
	}
	if code, _ := call(s, "POST", "/v1/chat/messages", b, reply); code != 200 {
		t.Fatal("reply retry failed")
	}
	reply.ID = "outside"
	if code, _ := call(s, "POST", "/v1/chat/messages", c, reply); code != 403 {
		t.Fatal("outsider reply accepted")
	}
	reply.ID = "loop"
	reply.TaskID = "reply"
	if code, _ := call(s, "POST", "/v1/chat/messages", a, reply); code != 400 {
		t.Fatal("reply to agent accepted")
	}
}
