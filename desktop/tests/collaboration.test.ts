import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../electron/engine";
import { Store } from "../electron/store";
import { defaults, ChatMessage } from "../electron/types";
import { collaborationBridge } from "../electron/collaboration-bridge";

test("collaboration waits for correlated answer, resumes same session once, and requires human acceptance", async () => {
  const store = new Store(":memory:");
  store.saveConfig({
    ...defaults,
    token: "local",
    userId: "alice",
    name: "Alice",
    workingDirectory: process.cwd(),
  });
  let runs = 0;
  const engine = new Engine(store, async (task, config, session) => {
    runs++;
    if (runs === 1) {
      engine.collaboration.action(task.id, {
        action: "ask",
        to: "bob",
        text: "接口字段是什么？",
      });
      return { text: "等待接口说明", sessionId: "stable-session" };
    }
    assert.equal(session, "stable-session");
    assert.match(task.input, /customerId/);
    return { text: "已完成页面与接口联调", sessionId: session };
  });
  store.db
    .prepare("INSERT INTO chat_conversations(id,payload) VALUES(?,?)")
    .run(
      "room",
      JSON.stringify({
        id: "room",
        kind: "direct",
        members: ["alice", "bob"],
        created: 1,
      }),
    );
  const id = engine.collaboration.start("room", "完成联调", true);
  await engine.pump();
  assert.equal(store.task(id)?.state, "waiting");
  const q = engine.chat.history("room").find((m) => m.kind === "question")!;
  const answer: ChatMessage = {
    ...q,
    id: "answer",
    kind: "answer",
    from: "bob",
    text: "customerId 是必填字段",
    taskId: q.id,
    agent: "",
    seq: 10,
  };
  engine.collaboration.receive({ ...answer, from: "mallory" });
  assert.equal(store.task(id)?.state, "waiting");
  for (let n = 0; n < 201; n++)
    store.db
      .prepare("INSERT INTO collaborations VALUES(?,?)")
      .run(
        "closed-" + n,
        JSON.stringify({ task: "closed-" + n, state: "accepted" }),
      );
  engine.collaboration.receive(answer);
  await engine.pump();
  engine.collaboration.receive(answer);
  await engine.pump();
  assert.equal(runs, 2);
  assert.equal(engine.collaboration.list()[0].state, "review");
  engine.collaboration.decide(id, "accept");
  assert.equal(engine.collaboration.list()[0].state, "accepted");
  store.close();
});

test("manual continuation and cancellation cannot be overridden by remote replies", async () => {
  const store = new Store(":memory:");
  store.saveConfig({
    ...defaults,
    token: "local",
    userId: "alice",
    workingDirectory: process.cwd(),
  });
  const engine = new Engine(store, async (t) => {
    engine.collaboration.action(t.id, {
      action: "ask",
      to: "bob",
      text: "确认接口",
    });
    return { text: "等待" };
  });
  store.db
    .prepare("INSERT INTO chat_conversations(id,payload) VALUES(?,?)")
    .run(
      "room",
      JSON.stringify({
        id: "room",
        kind: "direct",
        members: ["alice", "bob"],
        created: 1,
      }),
    );
  const id = engine.collaboration.start("room", "开发页面", false);
  await engine.pump();
  const q = engine.chat.history("room").find((m) => m.kind === "question")!;
  engine.collaboration.receive({
    ...q,
    id: "answer",
    kind: "answer",
    from: "bob",
    taskId: q.id,
    text: "已确认",
  });
  assert.equal(store.task(id)?.state, "pending");
  engine.collaboration.decide(id, "cancel");
  engine.collaboration.receive({
    ...q,
    id: "answer2",
    kind: "answer",
    from: "bob",
    taskId: q.id,
    text: "继续！",
  });
  assert.equal(store.task(id)?.state, "stopped");
  assert.throws(() =>
    engine.collaboration.action(id, {
      action: "ask",
      to: "bob",
      text: "不能发送",
    }),
  );
  store.close();
});

test("execution bridge rejects unauthenticated and browser-origin requests and closes after use", async () => {
  let calls = 0;
  const bridge = await collaborationBridge(() => {
    calls++;
    return { ok: true };
  });
  try {
    assert.equal(
      (await fetch(bridge.url, { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + bridge.token,
            Origin: "https://example.com",
          },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: { Authorization: "Bearer " + bridge.token },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    bridge.close();
  }
  await assert.rejects(() => fetch(bridge.url));
});

test("a reply arriving before CLI exits is consumed after the wait checkpoint", async () => {
  const store = new Store(":memory:");
  store.saveConfig({
    ...defaults,
    token: "local",
    userId: "alice",
    workingDirectory: process.cwd(),
  });
  const engine = new Engine(store, async (t) => {
    const result = engine.collaboration.action(t.id, {
      action: "ask",
      to: "bob",
      text: "接口字段？",
    });
    const q = engine.chat.message(result.id)!;
    const answer = {
      ...q,
      id: "early",
      kind: "answer",
      from: "bob",
      taskId: q.id,
      text: "customerId",
      seq: 12,
    };
    store.db
      .prepare("INSERT INTO chat_messages VALUES(?,?,?,?,?,?,'')")
      .run(
        answer.id,
        answer.conversation,
        JSON.stringify(answer),
        12,
        Date.now(),
        "sent",
      );
    engine.collaboration.receive(answer as ChatMessage);
    return { text: "等待", sessionId: "same" };
  });
  store.db
    .prepare("INSERT INTO chat_conversations(id,payload) VALUES(?,?)")
    .run(
      "room",
      JSON.stringify({
        id: "room",
        kind: "direct",
        members: ["alice", "bob"],
        created: 1,
      }),
    );
  const id = engine.collaboration.start("room", "完成接口联调", true);
  await engine.pump();
  assert.equal(store.task(id)?.state, "queued");
  assert.match(store.task(id)!.input, /customerId/);
  assert.equal(store.session(store.task(id)!), "same");
  store.close();
});
