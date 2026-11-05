package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestChatMembershipMentionsTasksAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	s, err := openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	a, b, c, d := user(t, s, "alice"), user(t, s, "bob"), user(t, s, "carol"), user(t, s, "outsider")
	group := Conversation{ID: "group1", Kind: "group", Name: "研发群", Members: []string{"bob", "carol"}}
	if code, body := call(s, "POST", "/v1/chat/conversations", a, group); code != 201 {
		t.Fatalf("create %d %s", code, body)
	}
	sync := func(token string) struct {
		Conversations []Conversation `json:"conversations"`
		Messages      []ChatMessage  `json:"messages"`
		Cursor        int64          `json:"cursor"`
	} {
		t.Helper()
		var v struct {
			Conversations []Conversation `json:"conversations"`
			Messages      []ChatMessage  `json:"messages"`
			Cursor        int64          `json:"cursor"`
		}
		code, body := call(s, "GET", "/v1/chat/sync?after=0", token, nil)
		if code != 200 {
			t.Fatalf("sync %d %s", code, body)
		}
		if err := json.Unmarshal(body, &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	text := ChatMessage{ID: "hello1", Conversation: "group1", From: "outsider", Kind: "text", Text: "@bob 请看一下", Mentions: []string{"bob"}}
	if code, body := call(s, "POST", "/v1/chat/messages", a, text); code != 201 {
		t.Fatalf("send %d %s", code, body)
	}
	if code, _ := call(s, "POST", "/v1/chat/messages", a, text); code != 200 {
		t.Fatal("chat retry not idempotent")
	}
	text.Text = "changed"
	if code, _ := call(s, "POST", "/v1/chat/messages", a, text); code != 409 {
		t.Fatal("conflicting duplicate")
	}
	text.ID = "forbidden"
	if code, _ := call(s, "POST", "/v1/chat/messages", d, text); code != 403 {
		t.Fatal("outsider sent to group")
	}
	text.Mentions = []string{"outsider"}
	if code, _ := call(s, "POST", "/v1/chat/messages", a, text); code != 400 {
		t.Fatal("external mention accepted")
	}
	for _, token := range []string{a, b, c} {
		v := sync(token)
		if len(v.Messages) != 1 || v.Messages[0].From != "alice" || len(v.Conversations[0].Members) != 3 {
			t.Fatal("identity/membership", v)
		}
	}
	if v := sync(d); len(v.Messages) != 0 || len(v.Conversations) != 0 {
		t.Fatal("private data leaked")
	}
	_, inbox := call(s, "GET", "/v1/inbox", b, nil)
	var requests []Message
	_ = json.Unmarshal(inbox, &requests)
	if len(requests) != 0 {
		t.Fatal("mention started agent")
	}
	task := ChatMessage{ID: "task1", Conversation: "group1", Kind: "task", Text: "检查 orders", Agent: "bob", Project: "orders", Mentions: []string{}}
	if code, body := call(s, "POST", "/v1/chat/messages", a, task); code != 201 {
		t.Fatalf("task %d %s", code, body)
	}
	if code, _ := call(s, "POST", "/v1/chat/messages", a, task); code != 200 {
		t.Fatal("task retry")
	}
	_, inbox = call(s, "GET", "/v1/inbox", b, nil)
	_ = json.Unmarshal(inbox, &requests)
	if len(requests) != 1 || requests[0].ID != "task1" {
		t.Fatal("task delivery", string(inbox))
	}
	_, inbox = call(s, "GET", "/v1/inbox", c, nil)
	_ = json.Unmarshal(inbox, &requests)
	if len(requests) != 0 {
		t.Fatal("untargeted member ran task")
	}
	reply := Message{ID: "reply1", Topic: "task1", To: "alice", Kind: "result", ReplyTo: "task1", Project: "orders", Text: "检查完成"}
	if code, body := call(s, "POST", "/v1/messages", b, reply); code != 201 {
		t.Fatalf("reply %d %s", code, body)
	}
	if code, _ := call(s, "POST", "/v1/messages", b, reply); code != 200 {
		t.Fatal("reply retry")
	}
	for _, token := range []string{a, b, c} {
		v := sync(token)
		if len(v.Messages) != 3 || v.Messages[2].Kind != "result" {
			t.Fatal("group result lost/duplicated", v)
		}
	}
	dm := Conversation{ID: "direct1", Kind: "direct", Members: []string{"bob"}}
	if code, _ := call(s, "POST", "/v1/chat/conversations", a, dm); code != 201 {
		t.Fatal("dm create")
	}
	dm.ID = "direct2"
	dm.Members = []string{"alice"}
	code, body := call(s, "POST", "/v1/chat/conversations", b, dm)
	var direct Conversation
	_ = json.Unmarshal(body, &direct)
	if code != 200 || direct.ID != "direct1" {
		t.Fatal("duplicate dm", string(body))
	}
	s.db.Close()
	s, err = openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	if len(sync(c).Messages) != 3 {
		t.Fatal("restart lost chat history")
	}
	if code, _ := call(s, "GET", "/v1/chat/sync?after=-1", a, nil); code != 400 {
		t.Fatal("invalid cursor")
	}
}

func TestLegacyTasksAppearInChatAndMigrationIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	a := user(t, s, "alice")
	b := user(t, s, "bob")
	req := Message{ID: "old1", Topic: "old-topic", From: "alice", To: "bob", Kind: "request", Project: "orders", Text: "legacy request", Created: 1}
	_, err = s.db.Exec("INSERT INTO messages(id,topic,sender,recipient,kind,reply_to,project,body,created) VALUES(?,?,?,?,?,?,?,?,?)", req.ID, req.Topic, req.From, req.To, req.Kind, "", req.Project, req.Text, req.Created)
	if err != nil {
		t.Fatal(err)
	}
	s.db.Exec("DELETE FROM chat_migrations")
	s.db.Close()
	s, err = openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	check := func(token string) {
		t.Helper()
		code, body := call(s, "GET", "/v1/chat/sync?after=0", token, nil)
		var v struct {
			Messages []ChatMessage `json:"messages"`
		}
		json.Unmarshal(body, &v)
		if code != 200 || len(v.Messages) != 1 || v.Messages[0].TaskID != "old1" {
			t.Fatal("migration", string(body))
		}
	}
	check(a)
	check(b)
	s.db.Close()
	s, err = openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	check(a)
}
