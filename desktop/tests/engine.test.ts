import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { Engine } from "../electron/engine";
import { defaults, Message, Executor } from "../electron/types";
const m = (id = "m1", kind: Message["kind"] = "request"): Message => ({
  id,
  topic: "topic1",
  from: "alice",
  to: "bob",
  project: "orders",
  kind,
  replyTo: "",
  text: "Please inspect",
  created: Date.now(),
});
function fixture(executor?: Executor) {
  const store = new Store(":memory:");
  store.saveConfig({
    ...defaults,
    server: "http://127.0.0.1:7331",
    token: "test",
    userId: "bob",
    name: "Bob",
    projects: { orders: process.cwd() },
  });
  let calls = 0;
  const engine = new Engine(
    store,
    executor ||
      (async () => {
        calls++;
        return { text: "done", sessionId: "session-local" };
      }),
  );
  let incoming: Message[] = [];
  const sent: Message[] = [];
  engine.api = async <T>(path: string, body?: any) => {
    if (path.startsWith("/v1/chat/sync")) return {conversations:[],messages:[],cursor:0} as T;
    if (path === "/v1/inbox") return incoming as T;
    if (path === "/v1/peers") return [] as T;
    if (path === "/v1/messages") sent.push(body);
    return {} as T;
  };
  return {
    store,
    engine,
    sent,
    calls: () => calls,
    inbox: (items: Message[]) => {
      incoming = items;
    },
  };
}
test("untrusted request remains pending; duplicate and notice never execute", async () => {
  const f = fixture();
  f.inbox([m(), m("notice", "notice")]);
  await f.engine.sync();
  await f.engine.sync();
  assert.equal(f.calls(), 0);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.tasks()[0].state, "pending");
  f.store.close();
});
test("approval executes once and replies without running on acknowledgement", async () => {
  const f = fixture();
  f.inbox([m()]);
  await f.engine.sync();
  f.engine.approve(f.store.tasks()[0].id);
  await f.engine.pump();
  assert.equal(f.calls(), 1);
  assert.equal(f.store.tasks()[0].state, "completed");
  assert.equal(f.store.outbox()[0].kind, "result");
  assert.equal(f.store.outbox()[0].replyTo, "m1");
  await f.engine.sync();
  assert.equal(f.calls(), 1);
  f.store.close();
});
test("local topic budget cannot be reset by a new message ID", async () => {
  const f = fixture();
  f.store.saveConfig({
    ...f.store.config(),
    autoAccept: true,
    trustedPeers: ["alice"],
    maxRuns: 1,
  });
  f.inbox([m()]);
  await f.engine.sync();
  while (f.engine.active) await new Promise((r) => setTimeout(r, 1));
  f.inbox([m("m2")]);
  await f.engine.sync();
  while (f.engine.active) await new Promise((r) => setTimeout(r, 1));
  assert.equal(f.calls(), 1);
  assert.equal(f.store.tasks().filter((t) => t.state === "rejected").length, 1);
  f.store.close();
});
test("unknown project is rejected even for a trusted peer", async () => {
  const f = fixture();
  f.store.saveConfig({
    ...f.store.config(),
    autoAccept: true,
    trustedPeers: ["alice"],
  });
  f.inbox([{ ...m(), project: "production" }]);
  await f.engine.sync();
  assert.equal(f.calls(), 0);
  assert.equal(f.store.tasks()[0].state, "rejected");
  f.store.close();
});

test("prototype property names cannot masquerade as configured projects", async () => {
  const f = fixture();
  f.store.saveConfig({
    ...f.store.config(),
    autoAccept: true,
    trustedPeers: ["alice"],
  });
  f.inbox([{ ...m(), project: "constructor" }]);
  await f.engine.sync();
  assert.equal(f.calls(), 0);
  assert.equal(f.store.tasks()[0].state, "rejected");
  f.store.close();
});

test("local pause blocks even trusted automatic requests", async () => {
  const f = fixture();
  f.store.saveConfig({
    ...f.store.config(),
    autoAccept: true,
    trustedPeers: ["alice"],
    paused: true,
  });
  f.inbox([m()]);
  await f.engine.sync();
  assert.equal(f.calls(), 0);
  assert.equal(f.store.tasks()[0].state, "queued");
  f.engine.pause(false);
  await f.engine.pump();
  assert.equal(f.calls(), 1);
  f.store.close();
});
test("only a correlated result can trigger one locally authorized verification", async () => {
  const f = fixture();
  f.store.saveConfig({
    ...f.store.config(),
    verifyResults: true,
    trustedPeers: ["alice"],
  });
  const outbound = f.engine.send({
    to: "alice",
    project: "orders",
    text: "Fix this",
    topic: "topic1",
  });
  f.inbox([{ ...m("r1", "result"), replyTo: "missing" }]);
  await f.engine.sync();
  assert.equal(f.calls(), 0);
  f.inbox([{ ...m("r2", "result"), replyTo: outbound.id }]);
  await f.engine.sync();
  while (f.engine.active) await new Promise((r) => setTimeout(r, 1));
  assert.equal(f.calls(), 1);
  assert.equal(f.store.outbox()[0]?.kind, "notice");
  f.inbox([{ ...m("r3", "result"), replyTo: outbound.id }]);
  await f.engine.sync();
  assert.equal(f.calls(), 1);
  f.store.close();
});
test("stop aborts active execution and returns a stopped result", async () => {
  const f = fixture(
    async (_t, _c, _s, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("stopped"))),
      ),
  );
  f.inbox([m()]);
  await f.engine.sync();
  const id = f.store.tasks()[0].id;
  f.engine.approve(id);
  const running = f.engine.pump();
  assert.equal(f.store.task(id)?.state, "running");
  f.engine.stopTask(id);
  await running;
  assert.equal(f.store.task(id)?.state, "stopped");
  assert.match(f.store.outbox()[0].text, /未完成/);
  f.store.close();
});
test("restart preserves outbox and never blindly reruns interrupted work", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-"));
  const path = join(dir, "client.db");
  let store = new Store(path);
  store.putMessage(m(), "out");
  store.addTask({
    id: "task",
    messageId: "m1",
    topic: "t",
    peer: "alice",
    project: "orders",
    state: "running",
    kind: "request",
    input: "x",
    output: "",
    created: 1,
    updated: 1,
  });
  store.close();
  store = new Store(path);
  assert.equal(store.outbox().length, 1);
  assert.equal(store.task("task")?.state, "interrupted");
  assert.equal(store.next(), undefined);
  store.close();
  rmSync(dir, { recursive: true });
});
test("session mapping is local and isolated by peer and project", async () => {
  let seen: (string | undefined)[] = [];
  const f = fixture(async (_t, _c, sid) => {
    seen.push(sid);
    return { text: "done", sessionId: "local-session" };
  });
  f.store.saveConfig({
    ...f.store.config(),
    autoAccept: true,
    trustedPeers: ["alice"],
  });
  for (const id of ["m1", "m2"]) {
    f.inbox([m(id)]);
    await f.engine.sync();
    while (f.engine.active) await new Promise((r) => setTimeout(r, 1));
  }
  assert.deepEqual(seen, [undefined, "local-session"]);
  f.store.close();
});
