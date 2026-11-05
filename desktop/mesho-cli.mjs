#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const command = args.shift();
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || args[i + 1] === undefined)
    throw new Error("参数格式：--名称 值");
  opts[args[i].slice(2)] = args[i + 1];
}
if (!["peers", "status", "send"].includes(command)) {
  console.log(
    'Mesho CLI\n  node mesho-cli.mjs peers\n  node mesho-cli.mjs send --to wang --project orders --text "请排查接口"\n可选：--topic 话题ID --bridge bridge.local.json路径\n需要桌面客户端正在运行。',
  );
  process.exit(0);
}
if (command === "send" && process.env.MESHO_AGENT_RESTRICTED === "1")
  throw new Error("接收方自动执行期间禁止再次自动委派；结果由客户端回传。");
const base =
  process.env.MESHO_DATA_DIR ||
  (process.platform === "win32"
    ? join(process.env.APPDATA || homedir(), "Mesho")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Mesho")
      : join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          "Mesho",
        ));
try {
  const c = JSON.parse(
    readFileSync(opts.bridge || join(base, "bridge.local.json"), "utf8"),
  );
  const data =
    command === "send"
      ? {
          to: opts.to,
          project: opts.project,
          text: opts.text,
          topic: opts.topic,
        }
      : undefined;
  const response = await fetch(`http://127.0.0.1:${c.port}/${command}`, {
    method: data ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  console.log(JSON.stringify(body, null, 2));
} catch (e) {
  console.error("Mesho: " + e.message);
  process.exitCode = 1;
}
