package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func call(s *Server, method, path, token string, body any) (int, []byte) {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}
func user(t *testing.T, s *Server, id string) string {
	t.Helper()
	code, b := call(s, "POST", "/v1/register", "", map[string]any{"invite": "test-invitation-12345", "profile": Profile{ID: id, Name: id, Projects: []string{"orders"}}})
	if code != 201 {
		t.Fatalf("register: %d %s", code, b)
	}
	var result map[string]string
	_ = json.Unmarshal(b, &result)
	return result["token"]
}
func TestDeliveryIdentityAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	a, b, c := user(t, s, "alice"), user(t, s, "bob"), user(t, s, "eve")
	if code, _ := call(s, "GET", "/v1/peers", "bad", nil); code != 401 {
		t.Fatal("anonymous peers allowed")
	}
	m := Message{ID: "msg1", Topic: "topic1", From: "eve", To: "bob", Kind: "request", Project: "orders", Text: "Investigate"}
	code, body := call(s, "POST", "/v1/messages", a, m)
	if code != 201 {
		t.Fatalf("send: %d %s", code, body)
	}
	var sent Message
	_ = json.Unmarshal(body, &sent)
	if sent.From != "alice" {
		t.Fatal("sender spoofing")
	}
	if code, _ = call(s, "POST", "/v1/messages", a, m); code != 200 {
		t.Fatal("retry not idempotent")
	}
	m.Text = "different"
	if code, _ = call(s, "POST", "/v1/messages", a, m); code != 409 {
		t.Fatal("conflicting duplicate accepted")
	}
	m.ID = "msg2"
	m.To = "bob"
	if code, _ = call(s, "POST", "/v1/messages", c, m); code != 403 {
		t.Fatal("topic hijack accepted")
	}
	if code, _ = call(s, "POST", "/v1/ack", c, map[string]any{"ids": []string{"msg1"}}); code != 200 {
		t.Fatal(code)
	}
	_ = s.db.Close()
	s, err = openServer(path, "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	_, body = call(s, "GET", "/v1/inbox", b, nil)
	var inbox []Message
	_ = json.Unmarshal(body, &inbox)
	if len(inbox) != 1 {
		t.Fatalf("offline message lost: %s", body)
	}
	result := Message{ID: "reply1", Topic: "topic1", To: "alice", Kind: "result", ReplyTo: "msg1", Project: "orders", Text: "done"}
	if code, body = call(s, "POST", "/v1/messages", b, result); code != 201 {
		t.Fatalf("reply: %d %s", code, body)
	}
	result.ID = "reply2"
	result.ReplyTo = "missing"
	if code, _ = call(s, "POST", "/v1/messages", b, result); code != 400 {
		t.Fatal("unrelated result accepted")
	}
	call(s, "POST", "/v1/ack", b, map[string]any{"ids": []string{"msg1"}})
	_, body = call(s, "GET", "/v1/inbox", b, nil)
	_ = json.Unmarshal(body, &inbox)
	if len(inbox) != 0 {
		t.Fatal("ack not persisted")
	}
}
func TestRejectMalformedAndUntrustedFields(t *testing.T) {
	s, err := openServer(filepath.Join(t.TempDir(), "test.db"), "test-invitation-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	token := user(t, s, "alice")
	if code, _ := call(s, "POST", "/v1/register", "", map[string]any{"invite": "wrong", "profile": Profile{ID: "bob", Name: "Bob"}}); code != 403 {
		t.Fatal("bad invite accepted")
	}
	if code, _ := call(s, "POST", "/v1/messages", token, map[string]string{"sessionId": "foreign", "command": "deploy"}); code != 400 {
		t.Fatal("external execution fields accepted")
	}
	if code, _ := call(s, "PUT", "/v1/profile", token, Profile{ID: "bob", Name: "Alice", Projects: []string{"orders"}}); code != 200 {
		t.Fatal(code)
	}
	_, body := call(s, "GET", "/v1/me", token, nil)
	var me map[string]string
	_ = json.Unmarshal(body, &me)
	if me["id"] != "alice" {
		t.Fatal("identity changed")
	}
}
