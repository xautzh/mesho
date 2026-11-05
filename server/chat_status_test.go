package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestReadAndAgentStatusOwnership(t *testing.T) {
	s, err := openServer(filepath.Join(t.TempDir(), "status.db"), "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	a, b, out := user(t, s, "alice"), user(t, s, "bob"), user(t, s, "outsider")
	call(s, "POST", "/v1/chat/conversations", a, Conversation{ID: "dm", Kind: "direct", Members: []string{"bob"}})
	_, body := call(s, "POST", "/v1/chat/messages", a, ChatMessage{ID: "hello", Conversation: "dm", Kind: "text", Text: "hello", Mentions: []string{}})
	var m ChatMessage
	json.Unmarshal(body, &m)
	for _, token := range []string{out} {
		if code, _ := call(s, "POST", "/v1/chat/read", token, ChatRead{Conversation: "dm", Seq: m.Seq}); code != 403 {
			t.Fatal("outsider read accepted")
		}
	}
	if code, _ := call(s, "POST", "/v1/chat/read", b, ChatRead{Conversation: "dm", User: "alice", Seq: m.Seq}); code != 200 {
		t.Fatal("read failed")
	}
	if code, _ := call(s, "POST", "/v1/chat/read", b, ChatRead{Conversation: "dm", Seq: m.Seq + 100}); code != 400 {
		t.Fatal("future read accepted")
	}
	for _, token := range []string{a, out} {
		if code, _ := call(s, "POST", "/v1/chat/activity", token, ChatActivity{Message: "hello", State: "running"}); code != 403 {
			t.Fatal("invalid reporter accepted")
		}
	}
	if code, _ := call(s, "POST", "/v1/chat/activity", b, ChatActivity{Message: "hello", User: "alice", State: "running"}); code != 200 {
		t.Fatal("activity failed")
	}
	reads, activities, err := s.chatStatus("alice")
	if err != nil || len(reads) != 1 || reads[0].User != "bob" || len(activities) != 1 || activities[0].User != "bob" {
		t.Fatal("status identity", reads, activities, err)
	}
	reads, activities, err = s.chatStatus("outsider")
	if err != nil || len(reads) != 0 || len(activities) != 0 {
		t.Fatal("status privacy")
	}
	if code, _ := call(s, "GET", "/v1/chat/sync?after=0", a, nil); code != 200 {
		t.Fatal("sync failed")
	}
}
