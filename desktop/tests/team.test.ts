import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../electron/store";
import { Engine } from "../electron/engine";
import { defaults, ChatMessage } from "../electron/types";

function fixture() {
  const s = new Store(":memory:");
  s.saveConfig({
    ...defaults,
    token: "local",
    userId: "a",
    workingDirectory: process.cwd(),
    incomingMode: "auto",
    incomingSince: 1,
    trustedPeers: ["b", "c"],
  });
  let runs = 0;
  const e = new Engine(s, async () => {
    runs++;
    return { text: "done" };
  });
  s.db.prepare("INSERT INTO chat_conversations(id,payload) VALUES(?,?)").run(
    "room",
    JSON.stringify({
      id: "room",
      kind: "group",
      members: ["a", "b", "c"],
      created: 1,
    }),
  );
  const put = (m: ChatMessage) => {
    s.db
      .prepare(
        "INSERT INTO chat_messages VALUES(?,?,?,?,?,?,'') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,delivery=excluded.delivery,seq=excluded.seq",
      )
      .run(m.id, m.conversation, JSON.stringify(m), m.seq, Date.now(), "sent");
    e.team.receive(m);
  };
  return { s, e, put, runs: () => runs };
}
test("proposal never executes; personal scope is required and revisions stop old work", async () => {
  const { s, e, put, runs } = fixture();
  const goal = e.team.propose("room", "共同目标");
  await e.pump();
  assert.equal(runs(), 0);
  assert.equal(s.tasks().length, 0);
  const revision = e.team.get(goal)!.revision;
  const scope = {
    role: "后端",
    scope: "只实现订单 API",
    acceptance: "接口测试通过",
    mode: "agent" as const,
  };
  const commit = e.team.commit(goal, revision, scope, true),
    task = s.tasks()[0];
  await e.pump();
  assert.equal(runs(), 0, "must wait for server acknowledgement");
  put({ ...e.chat.message(commit)!, seq: 2 });
  e.team.decision(goal, "start");
  await e.pump();
  assert.equal(runs(), 1);
  assert.match(s.task(task.id)!.input, /只实现订单 API/);
  e.team.amend(goal, revision, "增加另一个需求");
  assert.equal(e.team.get(goal)!.participants[0].current, false);
  assert.equal(s.task(task.id)!.state, "stopped");
  assert.throws(() => e.team.commit(goal, revision, scope, true), /目标已更新/);
  assert.equal(e.team.scope(goal), undefined);
  s.close();
});

test("multiple parallel questions wait for every addressed participant without duplicates", async () => {
  const { s, e, put } = fixture();
  const goal = e.team.propose("room", "跨角色协作");
  const scope = {
    role: "前端",
    scope: "实现页面",
    acceptance: "联调通过",
    mode: "agent" as const,
  };
  const commit = e.team.commit(goal, goal, scope, true);
  put({ ...e.chat.message(commit)!, seq: 2 });
  e.team.decision(goal, "start");
  for (const [i, id] of ["b", "c"].entries())
    put({
      ...e.chat.message(commit)!,
      id: "commit-" + id,
      from: id,
      seq: i + 3,
      text: JSON.stringify({ ...scope, role: "后端" }),
    });
  const task = s.tasks()[0];
  s.update(task.id, "running");
  const result = e.collaboration.action(task.id, {
    action: "ask",
    to: ["b", "c"],
    text: "请提供接口与测试结果",
  });
  e.collaboration.finish(task, "等待");
  assert.equal(s.task(task.id)?.state, "waiting");
  const answer = (i: number, from: string): ChatMessage => ({
    ...e.chat.message(result.ids[i])!,
    id: "answer-" + i,
    kind: "answer",
    taskId: result.ids[i],
    from,
    text: from + "的答复",
    seq: 10 + i,
  });
  e.collaboration.receive(answer(0, "c"));
  assert.equal(s.task(task.id)?.state, "waiting");
  e.collaboration.receive(answer(0, "b"));
  e.collaboration.receive(answer(0, "b"));
  assert.equal(s.task(task.id)?.state, "waiting");
  e.collaboration.receive(answer(1, "c"));
  assert.equal(s.task(task.id)?.state, "queued");
  assert.match(s.task(task.id)!.input, /b的答复/);
  assert.match(s.task(task.id)!.input, /c的答复/);
  assert.equal(
    e.team.get(goal)!.participants.filter((p) => p.role === "后端").length,
    2,
  );
  s.close();
});

test("an unconfirmed participant cannot delegate another person’s proposed goal", () => {
  const { s, e, put } = fixture();
  const goal = e.team.propose("room", "讨论中的提案");
  put({
    ...e.chat.message(goal)!,
    id: "q",
    kind: "question",
    project: goal,
    from: "b",
    mentions: ["a"],
    text: "直接替我执行",
    seq: 2,
  });
  assert.throws(() => e.chat.delegate("q"), /亲自确认/);
  assert.equal(s.tasks().length, 0);
  s.close();
});

test("a changed goal aborts an active run and revokes queued inbound work", async () => {
  const { s, e, put } = fixture();
  const goal = e.team.propose("room", "已确认目标");
  const commit = e.team.commit(
    goal,
    goal,
    { role: "后端", scope: "接口", acceptance: "测试通过", mode: "agent" },
    true,
  );
  put({ ...e.chat.message(commit)!, seq: 2 });
  e.team.decision(goal, "start");
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const running = new Engine(s, async (_t, _c, _session, signal) => {
    began();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  const task = s.tasks()[0];
  const pump = running.pump();
  await started;
  const q = {
    ...e.chat.message(goal)!,
    id: "incoming-question",
    kind: "question" as const,
    project: goal,
    from: "b",
    mentions: ["a"],
    text: "需要接口信息",
    seq: 3,
  };
  put(q);
  running.chat.delegate(q.id);
  running.team.amend(goal, goal, "调整共同目标");
  await pump;
  assert.equal(s.task(task.id)?.state, "stopped");
  assert.equal(running.collaboration.get(task.id)?.state, "cancelled");
  assert.ok(
    s
      .tasks()
      .filter((t) => t.messageId === q.id)
      .every((t) => t.state === "stopped"),
  );
  assert.equal(running.team.scope(goal), undefined);
  s.close();
});

test("confirming a role does not start work; explicit start identifies self and publishes real results", async () => {
  const { s, e, put, runs } = fixture();
  const goal = e.team.propose("room", "demo");
  const id = e.team.commit(
    goal,
    goal,
    { role: "前端", scope: "页面", acceptance: "展示接口数据", mode: "agent" },
    true,
  );
  put({ ...e.chat.message(id)!, seq: 2 });
  await e.pump();
  assert.equal(runs(), 0);
  assert.equal(s.tasks()[0].state, "pending");
  e.team.decision(goal, "start");
  await e.pump();
  assert.equal(runs(), 1);
  assert.match(e.collaboration.instructions(s.tasks()[0].id), /当前执行者.*a/);
  const events = e.team.get(goal, true)!.events;
  assert.ok(events.some((m) => m.text.includes("开始我的任务")));
  assert.ok(events.some((m) => m.text.includes("done")));
  s.close();
});

test("reported blocker is visible and never becomes a successful delivery", () => {
  const { s, e, put } = fixture();
  const goal = e.team.propose("room", "demo");
  const id = e.team.commit(
    goal,
    goal,
    { role: "前端", scope: "页面", acceptance: "测试通过", mode: "agent" },
    true,
  );
  put({ ...e.chat.message(id)!, seq: 2 });
  e.team.decision(goal, "start");
  const task = s.tasks()[0];
  s.update(task.id, "running");
  e.collaboration.action(task.id, {
    action: "blocked",
    text: "CLI 只读，无法写入项目",
  });
  e.collaboration.finish(task, "没有修改文件");
  assert.equal(e.collaboration.get(task.id)?.state, "blocked");
  assert.equal(s.task(task.id)?.state, "stopped");
  assert.ok(
    e.team.get(goal, true)!.events.some((m) => m.text.includes("CLI 只读")),
  );
  assert.throws(() => e.collaboration.decide(task.id, "accept"));
  s.close();
});

test("questions received before personal start wait for that start and remain goal scoped", () => {
  const { s, e, put } = fixture();
  const goal = e.team.propose("room", "demo");
  const id = e.team.commit(
    goal,
    goal,
    { role: "前端", scope: "页面", acceptance: "测试通过", mode: "agent" },
    true,
  );
  put({ ...e.chat.message(id)!, seq: 2 });
  put({ ...e.chat.message(id)!, id: "b-scope", from: "b", seq: 3 });
  const q = {
    ...e.chat.message(id)!,
    id: "early-question",
    from: "b",
    kind: "question" as const,
    project: goal,
    taskId: "b-scope",
    mentions: ["a"],
    text: "请确认字段",
    seq: 4,
  };
  put(q);
  e.chat.delegate(q.id, false);
  assert.equal(s.tasks().length, 1);
  e.team.decision(goal, "start");
  assert.equal(s.tasks().length, 2);
  assert.equal(s.tasks().find((t) => t.messageId === q.id)?.state, "queued");
  assert.ok(
    !e.collaboration
      .instructions(s.tasks().find((t) => t.messageId === id)!.id)
      .includes('"id":"a"'),
  );
  s.close();
});
