import { Team } from "./team";
import { randomUUID } from "node:crypto";
import { isAbsolute, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { Store } from "./store";
import { Config, Executor, Message, Profile, Task, validId } from "./types";

import { Collaborations } from "./collaboration";
import { collaborationBridge } from "./collaboration-bridge";
import { Chat } from "./chat";

class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Engine {
  chat: Chat;
  collaboration: Collaborations;
  team: Team;
  peers: Profile[] = [];
  connected = false;
  error = "";
  active?: { id: string; abort: AbortController };
  private syncing = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    public store: Store,
    private execute: Executor,
  ) {
    this.chat = new Chat(store, this);
    this.collaboration = new Collaborations(store, this);
    this.team = new Team(store, this);
  }
  snapshot() {
    const { token, ...config } = this.store.config();
    return {
      config,
      registered: !!token,
      peers: this.peers,
      messages: this.store.messages(),
      tasks: this.store.tasks().map((t) => {
        const link = this.chat.linked(t.id);
        return {
          ...t,
          ...(link ? { chatReply: link.published ? "sent" : "draft" } : {}),
        };
      }),
      conversations: this.chat.conversations(),
      collaborations: this.collaboration.list(),
      teamGoals: this.team.list(),
      connected: this.connected,
      error: this.error,
      activeId: this.active?.id,
    };
  }
  async api<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const c = this.store.config();
    return this.request<T>(c.server, path, c.token, body, method);
  }
  private async request<T>(
    base: string,
    path: string,
    token: string,
    body?: unknown,
    method = "POST",
  ): Promise<T> {
    const r = await fetch(base.replace(/\/$/, "") + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const data = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new APIError(r.status, data.error || `HTTP ${r.status}`);
    return data;
  }
  validate(c: Config) {
    const u = new URL(c.server);
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error("服务地址必须是 HTTP(S) origin，不含路径或凭证");
    if (
      !validId(c.userId) ||
      !c.name.trim() ||
      c.name.length > 120 ||
      c.role.length > 1000
    )
      throw new Error("请填写有效的用户 ID、姓名与职责");
    if (
      !c.projects ||
      Object.keys(c.projects).length > 30 ||
      !Object.entries(c.projects).every(
        ([id, path]) =>
          validId(id) &&
          typeof path === "string" &&
          isAbsolute(path) &&
          existsSync(path),
      )
    )
      throw new Error(
        "项目 ID 必须为英文/数字/横线，目录必须是本机已存在的绝对路径",
      );
    if (!Array.isArray(c.trustedPeers) || !c.trustedPeers.every(validId))
      throw new Error("信任同事 ID 格式错误");
    if (
      !Number.isInteger(c.maxRuns) ||
      c.maxRuns < 1 ||
      c.maxRuns > 20 ||
      !Number.isInteger(c.timeoutSeconds) ||
      c.timeoutSeconds < 10 ||
      c.timeoutSeconds > 3600
    )
      throw new Error("执行预算应为 1–20 次，单次超时 10–3600 秒");
    if (
      !["read-only", "workspace-write"].includes(c.sandbox) ||
      !c.codexPath ||
      c.codexPath.length > 2000 ||
      typeof c.localInstructions !== "string" ||
      c.localInstructions.length > 8000
    )
      throw new Error("执行配置无效");
    if (
      !["codex", "claude", "custom"].includes(c.provider) ||
      typeof c.runCommand !== "string" ||
      c.runCommand.length > 4000 ||
      (c.provider === "custom" && !c.runCommand.trim())
    )
      throw new Error("请选择执行器并填写有效的本地运行命令");
    if (
      !["manual", "approval", "auto"].includes(c.incomingMode) ||
      !["draft", "auto"].includes(c.replyMode)
    )
      throw new Error("消息处理方式无效");
    if (
      typeof c.workingDirectory !== "string" ||
      (c.workingDirectory &&
        (!isAbsolute(c.workingDirectory) || !existsSync(c.workingDirectory)))
    )
      throw new Error("请选择本机存在的 Agent 工作目录");
    if (c.incomingMode !== "manual" && !c.workingDirectory)
      throw new Error("启用 Agent 接收消息前，请选择工作目录");
    for (const key of ["autoAccept", "verifyResults", "paused"] as const)
      if (typeof c[key] !== "boolean") throw new Error("开关配置无效");
  }
  async setup(input: Partial<Config>, invite: string, existingToken = "") {
    if (this.store.config().token)
      throw new Error("客户端已经注册，请修改本地设置");
    const c = { ...this.store.config(), ...input, token: "" };
    this.validate(c);
    if (existingToken) {
      const peers = await this.request<Profile[]>(
        c.server,
        "/v1/peers",
        existingToken,
        undefined,
        "GET",
      );
      if (!peers.some((p) => p.id === c.userId))
        throw new Error("找不到指定身份");
      // PUT binds the authenticated identity; verify identity using a dedicated endpoint.
      const me = await this.request<{ id: string }>(
        c.server,
        "/v1/me",
        existingToken,
        undefined,
        "GET",
      );
      if (me.id !== c.userId) throw new Error("访问凭证不属于此用户");
      c.token = existingToken;
    } else {
      const result = await this.request<{ token: string }>(
        c.server,
        "/v1/register",
        "",
        {
          invite,
          profile: {
            id: c.userId,
            name: c.name,
            role: c.role,
            projects: Object.keys(c.projects),
            seen: 0,
          },
        },
      );
      c.token = result.token;
    }
    this.store.saveConfig(c);
    await this.sync();
  }
  async configure(input: Partial<Config>) {
    if (this.active) throw new Error("请等待当前执行完成后修改配置");
    const deadline = Date.now() + 10000;
    while (this.syncing && !this.active && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (this.active || this.syncing)
      throw new Error("当前执行或同步尚未完成，请稍后保存设置");
    const old = this.store.config();
    const c = {
      ...old,
      ...input,
      token: old.token,
      userId: old.userId,
      server: old.server,
    };
    c.incomingSince =
      old.incomingMode !== c.incomingMode ? Date.now() : old.incomingSince;
    this.validate(c);
    this.store.saveConfig(c);
    await this.sync();
  }
  send(input: { to: string; project: string; text: string; topic?: string }) {
    const c = this.store.config();
    if (!c.token) throw new Error("请先连接团队");
    if (
      !validId(input.to) ||
      input.to === c.userId ||
      !validId(input.project) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      Buffer.byteLength(input.text) > 60000
    )
      throw new Error("接收者、项目或消息正文无效");
    if (!Object.hasOwn(c.projects, input.project))
      throw new Error("请先在本机配置该项目");
    const m: Message = {
      id: randomUUID(),
      topic: input.topic || randomUUID(),
      from: c.userId,
      to: input.to,
      kind: "request",
      replyTo: "",
      project: input.project,
      text: input.text,
      created: Date.now(),
    };
    if (!validId(m.topic)) throw new Error("话题编号无效");
    if (this.store.outbox().length >= 100)
      throw new Error("发件箱已满，请恢复连接后重试");
    this.store.putMessage(m, "out");
    return m;
  }
  private receive(m: Message) {
    const c = this.store.config();
    if (m.to !== c.userId) throw new Error("接收者不匹配");
    this.store.transaction(() => {
      if (!this.store.putMessage(m, "in")) return;
      let kind: "request" | "verify" = "request";
      let auto = c.autoAccept && c.trustedPeers.includes(m.from);
      let input = m.text;
      if (m.kind === "notice") return;
      if (m.kind === "result") {
        const parent = this.store.message(m.replyTo);
        if (
          !parent ||
          parent.kind !== "request" ||
          parent.from !== c.userId ||
          parent.to !== m.from ||
          parent.topic !== m.topic ||
          parent.project !== m.project
        )
          return;
        if (!this.store.consumeResult(parent.id)) return;
        if (!c.verifyResults) return;
        kind = "verify";
        auto = c.trustedPeers.includes(m.from);
        input = `本地配置要求复核自己发出请求的处理结果。请检查证据和实际状态，无法复验则明确说明。只输出结论，不发送新的任务。\n原请求：${parent.text}\n对方结果：${m.text}`;
      }
      const now = Date.now();
      const reason = !Object.hasOwn(c.projects, m.project)
        ? "本机没有配置该项目，未启动 Agent。"
        : this.store.pendingCount() >= 200
          ? "本地待处理任务已达到 200 条上限，未启动 Agent。"
          : "";
      const allowed = !reason;
      const t: Task = {
        id: randomUUID(),
        messageId: m.id,
        topic: m.topic,
        peer: m.from,
        project: m.project,
        state: allowed ? (auto ? "queued" : "pending") : "rejected",
        kind,
        input,
        output: reason,
        created: now,
        updated: now,
      };
      this.store.addTask(t);
      if (!allowed) this.reply(t, t.output);
    });
  }
  private reply(t: Task, text: string) {
    const c = this.store.config();
    if (this.collaboration.get(t.id)) return;
    if (this.chat.linked(t.id)) {
      if (
        this.store.task(t.id)?.state === "completed" &&
        c.replyMode === "auto"
      )
        this.chat.publish(t.id);
      return;
    }
    const m: Message = {
      id: randomUUID(),
      topic: t.topic,
      from: c.userId,
      to: t.peer,
      kind: t.kind === "request" ? "result" : "notice",
      replyTo: t.messageId,
      project: t.project,
      text: text.slice(0, 16000) || "执行结束，无输出。",
      created: Date.now(),
    };
    this.store.putMessage(m, "out");
  }
  approve(id: string) {
    const t = this.store.task(id);
    if (!t || t.state !== "pending") throw new Error("只有待审批任务可以接受");
    const staged = this.collaboration.get(id);
    if (staged?.started === false) {
      this.team.decision(staged.goal, "start");
      return;
    }
    if (
      this.chat.linked(t.id) || this.collaboration.get(t.id)
        ? !this.store.config().workingDirectory
        : !Object.hasOwn(this.store.config().projects, t.project)
    )
      throw new Error("项目未配置");
    this.store.update(id, "queued");
  }
  reject(id: string) {
    const t = this.store.task(id);
    if (!t || !["pending", "queued"].includes(t.state))
      throw new Error("任务当前不能拒绝");
    this.store.transaction(() => {
      this.store.update(id, "rejected", "接收方拒绝了此请求。");
      this.reply(t, "接收方拒绝了此请求。");
    });
  }
  stopTask(id: string) {
    if (this.collaboration.get(id)) {
      this.collaboration.decide(id, "cancel");
      return;
    }
    if (this.active?.id === id) {
      this.active.abort.abort(new Error("本机用户停止了执行"));
      return;
    }
    const t = this.store.task(id);
    if (t?.state === "queued") this.reject(id);
  }
  pause(paused: boolean) {
    const c = this.store.config();
    this.store.saveConfig({ ...c, paused });
    if (paused && this.active)
      this.active.abort.abort(new Error("本机暂停执行"));
  }
  async sync() {
    if (this.syncing || this.stopped || !this.store.config().token) return;
    this.syncing = true;
    try {
      const c = this.store.config();
      await this.api(
        "/v1/profile",
        {
          id: c.userId,
          name: c.name,
          role: c.role,
          projects: Object.keys(c.projects),
          seen: 0,
        },
        "PUT",
      );
      this.peers = await this.api<Profile[]>("/v1/peers");
      for (const m of this.store.outbox()) {
        try {
          await this.api("/v1/messages", m);
          this.store.delivered(m.id);
        } catch (e) {
          if (
            e instanceof APIError &&
            [400, 403, 404, 409, 413].includes(e.status)
          ) {
            this.store.deliveryFailed(m.id, e.message);
            continue;
          }
          throw e;
        }
      }
      await this.chat.sync();
      const inbox = await this.api<Message[]>("/v1/inbox");
      for (const m of inbox) this.receive(m);
      if (inbox.length)
        await this.api("/v1/ack", { ids: inbox.map((m) => m.id) });
      this.connected = true;
      this.error = "";
    } catch (e) {
      this.connected = false;
      this.error = String(e);
    } finally {
      this.syncing = false;
    }
    void this.pump();
  }
  async pump() {
    const c = this.store.config();
    if (this.active || this.stopped || c.paused) return;
    const t = this.store.next();
    if (!t) return;
    if (!this.team.permitted(t.id)) {
      const row = this.store.db
        .prepare("SELECT delivery FROM chat_messages WHERE id=?")
        .get(t.messageId);
      if (row?.delivery === "failed")
        this.collaboration.suspend(
          t.id,
          "分工未获服务器确认，请检查发送状态并重新确认。",
        );
      return;
    }
    if (this.chat.linked(t.id) || this.collaboration.get(t.id))
      c.projects = { local: c.workingDirectory };
    if (
      !Object.hasOwn(c.projects, t.project) ||
      !existsSync(c.projects[t.project])
    ) {
      this.store.transaction(() => {
        this.store.update(t.id, "rejected", "本地项目目录不存在");
        this.reply(t, "本地项目目录不存在，未执行。");
      });
      return;
    }
    if (!this.store.reserve(t, c.maxRuns)) {
      this.store.transaction(() => {
        this.store.update(
          t.id,
          "rejected",
          "达到本地话题预算或每小时 20 次执行上限",
        );
        this.reply(t, "本地执行预算耗尽，已停止自动处理。");
      });
      return;
    }
    const abort = new AbortController();
    this.active = { id: t.id, abort };
    this.store.update(t.id, "running");
    const timer = setTimeout(
      () => abort.abort(new Error("达到单次执行时间上限")),
      c.timeoutSeconds * 1000,
    );
    let bridge: Awaited<ReturnType<typeof collaborationBridge>> | undefined;
    try {
      if (this.collaboration.get(t.id))
        bridge = await collaborationBridge(
          (input) => this.collaboration.action(t.id, input),
          this.store.path === ":memory:"
            ? undefined
            : join(dirname(this.store.path), "agent-runtime"),
        );
      const history = this.chat.context(t.id);
      const executionTask = {
        ...t,
        input: history ? history + "\n\n当前消息：\n" + t.input : t.input,
        ...(bridge
          ? {
              collaborationRuntime: {
                url: bridge.url,
                token: bridge.token,
                instructions: this.collaboration.instructions(
                  t.id,
                  bridge.file,
                ),
              },
            }
          : {}),
      };
      const result = await this.execute(
        executionTask,
        c,
        this.store.session(t),
        abort.signal,
        (id) => this.store.setSession(t, id),
      );
      if (abort.signal.aborted) throw abort.signal.reason;
      this.store.transaction(() => {
        if (result.sessionId) this.store.setSession(t, result.sessionId);
        if (this.collaboration.finish(t, result.text)) return;
        this.store.update(t.id, "completed", result.text);
        this.reply(t, result.text);
      });
    } catch (e) {
      const text = abort.signal.aborted
        ? String(abort.signal.reason)
        : String(e);
      this.store.transaction(() => {
        this.store.update(
          t.id,
          abort.signal.aborted ? "stopped" : "failed",
          text,
        );
        this.reply(t, `执行未完成：${text}`);
      });
    } finally {
      bridge?.close();
      clearTimeout(timer);
      this.active = undefined;
    }
  }
  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.sync(), 2500);
    void this.sync();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.active?.abort.abort(new Error("客户端退出"));
    for (let n = 0; (this.active || this.syncing) && n < 150; n++)
      await new Promise((r) => setTimeout(r, 100));
  }
}
