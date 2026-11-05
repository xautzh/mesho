import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, extname, isAbsolute } from "node:path";
import { Executor, Config } from "./types";

// Read only the documented error fields; never stringify a request or context.
export function agentErrorMessage(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    return (
      agentErrorMessage(v.error, depth + 1) ||
      agentErrorMessage(v.message, depth + 1)
    );
  }
  if (typeof value !== "string") return "";
  const text = value.trim();
  try {
    return agentErrorMessage(JSON.parse(text), depth + 1);
  } catch {
    /* plain diagnostic */
  }
  if (text.startsWith("{") || text.startsWith("[")) return "";
  return text
    .split(/\r?\n|\\n/)[0]
    .split(/(?:request body|request payload|instructions)\s*[:=]/i)[0]
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 1200);
}

export function command(
  path: string,
  provider = "codex",
): {
  exe: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
} {
  const env = { ...process.env };
  let found = path;
  if (!isAbsolute(path)) {
    const dirs = (process.env.PATH || "").split(delimiter);
    const names =
      process.platform === "win32"
        ? [path + ".exe", path + ".cmd", path]
        : [path];
    found =
      dirs.flatMap((d) => names.map((n) => join(d, n))).find(existsSync) || "";
  }
  if (!found || !existsSync(found))
    throw new Error(
      "找不到本地执行程序。请先安装、登录对应 CLI，并在设置中填写可执行文件路径。",
    );
  if (extname(found).toLowerCase() === ".cmd") {
    const entry =
      provider === "claude"
        ? join(
            dirname(found),
            "node_modules",
            "@anthropic-ai",
            "claude-code",
            "cli.js",
          )
        : provider === "codex"
          ? join(
              dirname(found),
              "node_modules",
              "@openai",
              "codex",
              "bin",
              "codex.js",
            )
          : "";
    if (!entry || !existsSync(entry))
      throw new Error(
        "自定义命令请使用 .exe / .js / .mjs；批处理请显式配置解释器，不自动经过 shell",
      );
    found = entry;
  }
  if ([".js", ".mjs", ".cjs"].includes(extname(found)))
    return {
      exe: process.execPath,
      prefix: [found],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  return { exe: found, prefix: [], env };
}
// Parse a locally authored command without invoking a shell. Backslashes in Windows paths stay literal.
export function parseCommand(value: string): string[] {
  const parts: string[] = [];
  let part = "",
    quote = "",
    started = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = "";
      else part += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        parts.push(part);
        part = "";
        started = false;
      }
    } else {
      part += ch;
      started = true;
    }
  }
  if (quote) throw new Error("运行命令的引号未闭合");
  if (started) parts.push(part);
  if (!parts.length) throw new Error("运行命令不能为空");
  return parts;
}
export function configuredCommand(c: Config) {
  const parts = c.runCommand.trim()
    ? parseCommand(c.runCommand)
    : [c.provider === "claude" ? "claude" : c.codexPath];
  const resolved = command(parts[0], c.provider);
  return { ...resolved, prefix: [...resolved.prefix, ...parts.slice(1)] };
}
export const runAgent: Executor = (task, c, sessionId, signal, onSession) =>
  new Promise((resolve, reject) => {
    const cmd = configuredCommand(c);
    // Inherit native CLI configuration, skills, plugins and permission policy.
    // Mesho only supplies transport arguments and locally authored preferences.
    let args = sessionId
      ? ["exec", "--skip-git-repo-check", "resume", sessionId, "--json", "-"]
      : ["exec", "--skip-git-repo-check", "--json", "-"];
    // The user explicitly selects the working directory in Mesho. General
    // consultation need not live in a Git repo; native sandbox/approval rules
    // still apply and are not changed by this transport option.
    if (c.provider === "claude") {
      args = ["-p", "--output-format", "json"];
      if (sessionId) args.push("--resume", sessionId);
    }
    if (c.provider === "custom") args = [];
    if (task.collaborationRuntime) {
      cmd.env.MESHO_COLLAB_URL = task.collaborationRuntime.url;
      cmd.env.MESHO_COLLAB_TOKEN = task.collaborationRuntime.token;
    }
    const prompt = `${task.collaborationRuntime ? task.collaborationRuntime.instructions + "\n\n" : ""}${c.localInstructions.trim() ? "本机用户的处理偏好：\n" + c.localInstructions + "\n\n" : ""}来自 Mesho 联系人 ${task.peer} 的消息：\n${task.input}`;
    const child = spawn(cmd.exe, [...cmd.prefix, ...args], {
      cwd: c.projects[task.project],
      env: cmd.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let buffer = "",
      last = "",
      sid = sessionId,
      errors = "",
      stderrBuffer = "",
      protocolError = "",
      bytes = 0,
      settled = false;
    let outputError: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32")
        execFile(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {},
        );
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", kill);
      if (error) reject(error);
      else
        resolve({
          text: last,
          sessionId: c.provider === "custom" ? undefined : sid,
        });
    };
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    const line = (value: string) => {
      if (c.provider === "custom") {
        last += value + "\n";
        return;
      }
      try {
        const event = JSON.parse(value);
        if (c.provider === "claude") {
          if (typeof event.session_id === "string") {
            sid = event.session_id;
            onSession(sid!);
          }
          if (event.type === "result") {
            if (
              event.is_error ||
              (event.subtype && event.subtype !== "success")
            )
              outputError = new Error(
                event.result || JSON.stringify(event.errors || event),
              );
            else if (typeof event.result === "string") last = event.result;
          }
          return;
        }
        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        ) {
          sid = event.thread_id;
          onSession(sid!);
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          last = event.item.text;
        if (event.type === "error" || event.type === "turn.failed")
          protocolError =
            agentErrorMessage(event) ||
            "Agent 报告执行失败，但未提供明确原因。";
      } catch {
        /* Non-JSON CLI diagnostics are not messages. */
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputError) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) {
        outputError = new Error("Agent 输出超过 8MB 上限");
        kill();
        return;
      }
      buffer += chunk;
      if (c.provider === "claude") return;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    const diagnostic = (value: string) => {
      const clean = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (clean.startsWith("Not inside a trusted directory")) {
        errors = "Codex 拒绝在当前目录启动：该目录不是 Git 仓库。请更新 Mesho，或选择已有 Git 项目的工作目录。";
        return;
      }
      if (/^(?:Error|Fatal|error|fatal)(?:\b|:)/.test(clean))
        errors = agentErrorMessage(clean) || errors;
      else if (clean.startsWith("{")) {
        try {
          const event = JSON.parse(clean);
          if (event.type === "error" || event.type === "turn.failed")
            errors = agentErrorMessage(event) || errors;
        } catch {
          /* ignore context */
        }
      }
    };
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let i;
      while ((i = stderrBuffer.indexOf("\n")) >= 0) {
        diagnostic(stderrBuffer.slice(0, i));
        stderrBuffer = stderrBuffer.slice(i + 1);
      }
      // Bound diagnostics independently from stdout without retaining payload tails.
      if (stderrBuffer.length > 16000) {
        diagnostic(stderrBuffer);
        stderrBuffer = "";
      }
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (buffer) line(buffer);
      if (stderrBuffer) diagnostic(stderrBuffer);
      if (outputError) {
        finish(outputError);
        return;
      }
      if (signal.aborted) {
        finish(new Error(String(signal.reason)));
        return;
      }
      if (code !== 0 || protocolError) {
        finish(
          new Error(
            `Agent 执行失败（退出码 ${code}）：${protocolError || errors || "执行器未返回明确错误，请检查本地 CLI 的安装、登录和配置。"}`,
          ),
        );
        return;
      }
      if (!last) {
        finish(
          new Error(
            `Agent 没有完成最终回复：${errors || "执行器未返回最终消息。"}`,
          ),
        );
        return;
      }
      finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });

// Backward-compatible export for Codex integrations.
export const runCodex = runAgent;
