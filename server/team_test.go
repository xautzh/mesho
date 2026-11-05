package main

import (
	"path/filepath"
	"testing"
)

func TestSharedGoalRequiresOwnAgreementAndAllCompletions(t *testing.T) {
	s, e := openServer(filepath.Join(t.TempDir(), "team.db"), "test-invitation-12345")
	if e != nil {
		t.Fatal(e)
	}
	defer s.db.Close()
	a, b, c := user(t, s, "a"), user(t, s, "b"), user(t, s, "c")
	call(s, "POST", "/v1/chat/conversations", a, Conversation{ID: "room", Kind: "group", Name: "Team", Members: []string{"b", "c"}})
	send := func(token, id, kind, goal, ref, text string, to []string, want int) {
		t.Helper()
		code, body := call(s, "POST", "/v1/chat/messages", token, ChatMessage{ID: id, Conversation: "room", Kind: kind, Project: goal, TaskID: ref, Text: text, Mentions: to})
		if code != want {
			t.Fatalf("%s %s: %d %s", id, kind, code, body)
		}
	}
	scope := `{"role":"backend","scope":"API","acceptance":"tests pass","mode":"agent"}`
	send(a, "goal", "proposal", "", "", "Ship feature", nil, 201)
	send(b, "before", "question", "goal", "", "Do work", []string{"c"}, 400)
	send(a, "ca", "commitment", "goal", "goal", scope, nil, 201)
	send(b, "cb", "commitment", "goal", "goal", scope, nil, 201)
	send(c, "cc", "commitment", "goal", "goal", scope, nil, 201)
	send(b, "q", "question", "goal", "cb", "Need tests", []string{"c"}, 201)
	send(c, "ans", "answer", "goal", "q", "Test evidence", nil, 201)
	send(a, "fake", "completion", "goal", "cb", "Done for B", nil, 400)
	send(a, "early", "closure", "goal", "goal", "All done", nil, 400)
	send(c, "new", "amendment", "goal", "goal", "New acceptance criteria", nil, 201)
	send(b, "stale", "question", "goal", "cb", "Old request", []string{"c"}, 400)
	send(a, "ca2", "commitment", "goal", "new", scope, nil, 201)
	send(b, "cb2", "commitment", "goal", "new", scope, nil, 201)
	send(c, "cc2", "commitment", "goal", "new", scope, nil, 201)
	send(a, "da", "completion", "goal", "ca2", "A done", nil, 201)
	send(b, "db", "completion", "goal", "cb2", "B done", nil, 201)
	send(a, "early2", "closure", "goal", "new", "All done", nil, 400)
	send(c, "dc", "completion", "goal", "cc2", "C done", nil, 201)
	send(a, "closed", "closure", "goal", "new", "All done", nil, 201)
	send(a, "closed", "closure", "goal", "new", "All done", nil, 200)
	send(b, "late", "amendment", "goal", "new", "Reopen", nil, 400)
}
