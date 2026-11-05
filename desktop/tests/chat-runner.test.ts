import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent, parseCommand } from "../electron/runner";
import { defaults, Task } from "../electron/types";
import { Store } from "../electron/store";
import { Engine } from "../electron/engine";
const task = {
  id: "task",
  messageId: "msg",
  topic: "topic",
  peer: "alice",
  project: "demo",
  state: "running",
  kind: "request",
  input: "hello $(do-not-run) 中文",
  output: "",
  created: 1,
  updated: 1,
} as Task;
test("Claude CLI inherits native tools and plugins and resumes only its recorded session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-claude-"));
  const fixture = join(dir, "claude.js");
  writeFileSync(
    fixture,
    `const fs=require('fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.appendFileSync('calls.jsonl',JSON.stringify({args:process.argv.slice(2),input})+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',session_id:'claude-local',result:'Claude fixture result'}));});`,
  );
  const config = {
    ...defaults,
    provider: "claude" as const,
    projects: { demo: dir },
    runCommand: '"' + fixture + '" --model fixture',
  };
  let sid = "";
  const result = await runAgent(
    task,
    config,
    undefined,
    new AbortController().signal,
    (id) => (sid = id),
  );
  assert.equal(result.text, "Claude fixture result");
  assert.equal(sid, "claude-local");
  await runAgent(task, config, sid, new AbortController().signal, () => {});
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.ok(!calls[0].args.includes("--permission-mode"));
  assert.ok(!calls[0].args.includes("--tools"));
  assert.ok(!calls[0].args.includes("--strict-mcp-config"));
  assert.ok(calls[1].args.includes("--resume"));
  assert.ok(calls[1].args.includes(sid));
  assert.ok(!calls[0].args.some((v: string) => v.includes("do-not-run")));
  assert.match(calls[0].input, /do-not-run/);
});
test("custom command preserves local argv and receives external data only on stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-custom-"));
  const script = join(dir, "custom runner.js");
  writeFileSync(
    script,
    `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:s})));`,
  );
  const result = await runAgent(
    task,
    {
      ...defaults,
      provider: "custom",
      projects: { demo: dir },
      runCommand: '"' + script + '" "fixed argument"',
    },
    "old-provider-session",
    new AbortController().signal,
    () => {
      throw new Error("custom session callback");
    },
  );
  const data = JSON.parse(result.text);
  assert.deepEqual(data.args, ["fixed argument"]);
  assert.match(data.input, /do-not-run/);
  assert.match(data.input, /Mesho 联系人/);
  assert.equal(result.sessionId, undefined);
  assert.deepEqual(
    parseCommand('"C:\\Program Files\\agent.exe" --model "a b"'),
    ["C:\\Program Files\\agent.exe", "--model", "a b"],
  );
  assert.throws(() => parseCommand('"oops'), /引号/);
});
test("chat read markers, mentions, offline outbox survive restart and do not start agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-chat-"));
  const path = join(dir, "local.db");
  let store = new Store(path);
  store.saveConfig({ ...defaults, token: "t", userId: "bob", name: "Bob" });
  let executed = 0;
  let engine = new Engine(store, async () => {
    executed++;
    return { text: "x" };
  });
  const convo = {
    id: "group",
    kind: "group",
    name: "Team",
    owner: "alice",
    members: ["alice", "bob"],
    created: 1,
  };
  const incoming = {
    seq: 1,
    id: "msg",
    conversation: "group",
    from: "alice",
    kind: "text",
    text: "@bob hi",
    mentions: ["bob"],
    agent: "",
    project: "",
    taskId: "",
    created: 2,
  };
  engine.api = async <T>(p: string) =>
    ({ conversations: [convo], messages: [incoming], cursor: 1 }) as T;
  await engine.chat.sync();
  assert.equal(engine.chat.conversations()[0].unread, 1);
  assert.equal(engine.chat.conversations()[0].mentioned, true);
  assert.equal(executed, 0);
  assert.equal(store.tasks().length, 0);
  engine.chat.read("group", 1);
  assert.equal(engine.chat.conversations()[0].unread, 0);
  engine.chat.send({
    conversation: "group",
    text: "my reply",
    mentions: [],
    kind: "text",
  });
  assert.equal(engine.chat.history("group")[1].delivery, "pending");
  store.close();
  store = new Store(path);
  engine = new Engine(store, async () => ({ text: "x" }));
  assert.equal(engine.chat.conversations()[0].unread, 0);
  assert.equal(engine.chat.history("group")[1].delivery, "pending");
  const firstKey = store.contextKey(task);
  store.saveConfig({ ...store.config(), provider: "claude" });
  assert.notEqual(store.contextKey(task), firstKey);
  store.close();
});
