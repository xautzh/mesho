import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodex, agentErrorMessage } from "../electron/runner";
import { defaults, Task } from "../electron/types";

test("nested API errors are extracted without request context", () => {
  const reason = "The 'gpt-6-astra' model requires a newer version of Codex.";
  assert.equal(agentErrorMessage({type:"turn.failed",error:{message:JSON.stringify({error:{message:reason},instructions:"private context"})}}),reason);
  assert.equal(agentErrorMessage({request:{instructions:"private context"}}),"");
  assert.equal(agentErrorMessage('Error: failed\nsecret context'),'Error: failed');
});

test("structured failure wins over noisy stderr even when CLI exits zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-error-"));
  try {
    const fixture = join(dir,"error.js");
    writeFileSync(fixture, `process.stdin.resume();process.stdin.on('end',()=>{console.error('private skill instructions '.repeat(1000));console.log(JSON.stringify({type:'turn.failed',error:{message:JSON.stringify({error:{message:'Please upgrade Codex'}})}}));});`);
    await assert.rejects(runCodex({id:'error',project:'local',input:'check',peer:'alice',kind:'request'} as Task,
      {...defaults,codexPath:fixture,projects:{local:dir}},undefined,new AbortController().signal,()=>{}),
      (error:Error)=>error.message.includes('Please upgrade Codex') && !error.message.includes('private skill') && error.message.length < 200);
  } finally { rmSync(dir,{recursive:true}); }
});

test("real child process receives untrusted content on stdin, resumes the recorded session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-runner-"));
  try {
    const config = {
      ...defaults,
      projects: { orders: dir },
      codexPath: resolve("tests/fake-codex.js"),
    };
    const task: Task = {
      id: "t",
      messageId: "m",
      topic: "topic",
      peer: "alice",
      project: "orders",
      state: "running",
      kind: "request",
      input: '"; $(echo not-a-command)\n中文内容',
      output: "",
      created: 1,
      updated: 1,
    };
    let session = "";
    const result = await runCodex(
      task,
      config,
      undefined,
      new AbortController().signal,
      (id) => (session = id),
    );
    assert.ok(session);
    assert.match(result.text, /模拟执行器/);
    await runCodex(
      task,
      config,
      session,
      new AbortController().signal,
      () => {},
    );
    const records = readFileSync(join(dir, "fixture-executions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v));
    assert.equal(records[0].args.at(-1), "-");
    assert.ok(
      !records[0].args.some((x: string) => x.includes("not-a-command")),
    );
    assert.match(records[0].input, /not-a-command/);
    assert.ok(records[1].args.includes(session));
    assert.ok(records[1].args.includes("resume"));
    assert.ok(records[0].args.includes("--skip-git-repo-check"));
    assert.ok(records[1].args.includes("--skip-git-repo-check"));
    assert.ok(!records[0].args.some((a: string) => /sandbox_mode|approval_policy|developer_instructions|multi_agent/.test(a)));

  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("plain Codex directory error is reported without leaking surrounding stderr", async () => {
  const dir=mkdtempSync(join(tmpdir(),'mesho-directory-error-'));
  try {
    const fixture=join(dir,'error.cjs');
    writeFileSync(fixture,`process.stdin.resume();process.stdin.on('end',()=>{console.error('private skill instructions');console.error('Not inside a trusted directory and --skip-git-repo-check was not specified.');process.exitCode=1;});`);
    await assert.rejects(runCodex({id:'error',project:'local',input:'check',peer:'alice',kind:'request'} as Task,
      {...defaults,codexPath:fixture,projects:{local:dir}},undefined,new AbortController().signal,()=>{}),
      (error:Error)=>error.message.includes('Git') && !error.message.includes('private skill') && !error.message.includes('未返回明确错误'));
  }finally{rmSync(dir,{recursive:true});}
});
test("abort terminates a real running process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-abort-"));
  try {
    const path = join(dir, "wait.js");
    writeFileSync(path, "setInterval(()=>{},1000)");
    const config = { ...defaults, projects: { orders: dir }, codexPath: path };
    const task = {
      id: "t",
      project: "orders",
      peer: "alice",
      kind: "request",
      input: "wait",
    } as Task;
    const controller = new AbortController();
    const result = runCodex(
      task,
      config,
      undefined,
      controller.signal,
      () => {},
    );
    setTimeout(() => controller.abort(new Error("test stop")), 300);
    await assert.rejects(result, /test stop/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
