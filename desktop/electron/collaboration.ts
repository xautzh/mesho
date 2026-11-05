import type { TeamGoal, Scope } from "./team";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine";
import type { Store } from "./store";
import type { ChatMessage, Task } from "./types";

export interface Collaboration {
  task: string;
  goal: string;
  conversation: string;
  state:
    | "working"
    | "waiting"
    | "review"
    | "accepted"
    | "cancelled"
    | "blocked";
  autoResume: boolean;
  question: string;
  recipient: string;
  started?: boolean;
  blocker?: string;
  commitment?: string;
  revision?: string;
  questions?: { id: string; to: string }[];
}

export class Collaborations {
  constructor(
    private store: Store,
    private engine: Engine,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS collaborations(task TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS collaboration_answers(id TEXT PRIMARY KEY); CREATE INDEX IF NOT EXISTS collaboration_wait ON collaborations(json_extract(payload,'$.question'),json_extract(payload,'$.state'));",
    );
  }
  list(): Collaboration[] {
    return this.store.db
      .prepare(
        "SELECT payload FROM collaborations ORDER BY rowid DESC LIMIT 200",
      )
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  forGoal(goal: string): Collaboration[] {
    return this.store.db
      .prepare(
        "SELECT payload FROM collaborations WHERE json_extract(payload,'$.goal')=?",
      )
      .all(goal)
      .map((r) => JSON.parse(String(r.payload)));
  }
  get(id: string): Collaboration | undefined {
    const r = this.store.db
      .prepare("SELECT payload FROM collaborations WHERE task=?")
      .get(id);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  private save(c: Collaboration) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO collaborations VALUES(?,?)")
      .run(c.task, JSON.stringify(c));
  }
  start(conversation: string, goal: string, autoResume: boolean) {
    if (!this.store.config().workingDirectory)
      throw new Error("请先在设置中选择自己的 Agent 工作目录");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 8000)
      throw new Error("请填写目标与验收标准（最多 8000 字）");
    if (this.store.pendingCount() >= 200) throw new Error("本地任务已达上限");
    const id = randomUUID();
    this.store.transaction(() => {
      const m = this.engine.chat.collaborationMessage(
        conversation,
        "goal",
        goal,
        "",
        "",
        false,
      );
      this.store.addTask({
        id,
        messageId: m.id,
        topic: m.id,
        peer: this.store.config().userId,
        project: "local",
        kind: "request",
        state: "queued",
        input: goal,
        output: "",
        created: Date.now(),
        updated: Date.now(),
      });
      this.save({
        task: id,
        goal: m.id,
        conversation,
        state: "working",
        autoResume: !!autoResume,
        question: "",
        recipient: "",
      });
    });
    return id;
  }
  startShared(g: TeamGoal, m: ChatMessage, scope: Scope, auto: boolean) {
    const id = randomUUID();
    this.store.addTask({
      id,
      messageId: m.id,
      topic: m.id,
      peer: this.store.config().userId,
      project: "local",
      kind: "request",
      state: "pending",
      input: this.engine.team.context(g.id),
      output: "",
      created: Date.now(),
      updated: Date.now(),
    });
    this.save({
      task: id,
      goal: g.id,
      conversation: g.conversation,
      state: "working",
      started: false,
      autoResume: !!auto,
      question: "",
      recipient: "",
      questions: [],
      commitment: m.id,
      revision: g.revision,
    });
    return id;
  }
  suspend(id: string, reason: string) {
    const c = this.get(id);
    if (!c || ["cancelled", "accepted"].includes(c.state)) return;
    c.state = "cancelled";
    this.save(c);
    this.store.update(id, "stopped", reason);
  }
  private waiting(c: Collaboration) {
    return (
      c.questions || (c.question ? [{ id: c.question, to: c.recipient }] : [])
    );
  }
  action(
    id: string,
    input: { action: string; to?: string | string[]; text: string },
  ) {
    const c = this.get(id),
      t = this.store.task(id);
    if (!c || c.state !== "working" || t?.state !== "running")
      throw new Error("协作任务当前不可发送消息");
    if (c.commitment && !this.engine.team.permitted(id))
      throw new Error("需要本人确认当前协作范围");
    if (!["ask", "progress", "blocked"].includes(input.action))
      throw new Error("只支持 ask / progress / blocked");
    if (this.waiting(c).length && input.action !== "blocked")
      throw new Error("本轮已有待回复问题，请结束本轮等待答复");
    const targets =
      input.action === "ask"
        ? [...new Set(Array.isArray(input.to) ? input.to : [input.to || ""])]
        : [""];
    if (targets.length < 1 || targets.length > 10)
      throw new Error("一次可询问 1–10 位成员");
    if (c.commitment && input.action === "ask") {
      const g = this.engine.team.get(c.goal)!;
      if (
        targets.some(
          (to) =>
            !g.participants.some(
              (p) => p.user === to && p.current && !p.withdrawn,
            ),
        )
      )
        throw new Error("只能询问已确认当前协作分工的成员");
    }
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE json_extract(payload,'$.project')=? AND json_extract(payload,'$.agent')=?",
      )
      .get(c.goal, this.store.config().userId)!;
    if (Number(count.n) + targets.length > 40)
      throw new Error("已达到本人在此目标下的 40 条 Agent 消息上限");
    return this.store.transaction(() => {
      const messages = targets.map((to) =>
        this.engine.chat.collaborationMessage(
          c.conversation,
          input.action === "ask" ? "question" : "progress",
          input.action === "blocked" ? "[任务阻塞] " + input.text : input.text,
          c.goal,
          to,
          true,
          c.commitment || "",
        ),
      );
      if (input.action === "blocked") {
        c.state = "blocked";
        c.blocker = input.text;
        c.questions = [];
        c.question = "";
        c.recipient = "";
        this.save(c);
      }
      if (input.action === "ask") {
        c.questions = messages.map((m, i) => ({ id: m.id, to: targets[i] }));
        c.question = messages[0].id;
        c.recipient = targets[0];
        this.save(c);
      }
      return {
        id: messages[0].id,
        ids: messages.map((m) => m.id),
        waiting: input.action === "ask",
        instruction:
          input.action === "ask"
            ? "问题已加入发件箱，请结束本轮。全部关联答复到达后续接原任务。"
            : "进度已加入发件箱",
      };
    });
  }
  finish(t: Task, text: string) {
    const c = this.get(t.id);
    if (!c) return false;
    if (c.state === "cancelled") return true;
    if (c.state === "blocked") {
      this.store.update(t.id, "stopped", c.blocker + "\n\n" + text);
      return true;
    }
    const waiting = this.waiting(c);
    if (waiting.length) {
      c.state = "waiting";
      this.save(c);
      this.store.update(t.id, "waiting", text);
      for (const q of waiting) {
        const rows = this.store.db
          .prepare(
            "SELECT payload FROM chat_messages WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.kind')='answer' ORDER BY seq",
          )
          .all(q.id);
        for (const row of rows) this.receive(JSON.parse(String(row.payload)));
      }
    } else {
      c.state = "review";
      this.save(c);
      this.store.update(t.id, "completed", text);
      this.engine.chat.collaborationMessage(
        c.conversation,
        "progress",
        c.commitment
          ? "[本轮结果 · 尚未验收]\n" + text.slice(0, 12000)
          : "阶段工作已完成，等待发起人验收。",
        c.goal,
        "",
        true,
        c.commitment || "",
      );
    }
    return true;
  }
  receive(m: ChatMessage) {
    if (m.kind !== "answer") return;
    const row = this.store.db
      .prepare(
        "SELECT payload FROM collaborations c WHERE json_extract(payload,'$.state')='waiting' AND (json_extract(payload,'$.question')=? OR EXISTS(SELECT 1 FROM json_each(c.payload,'$.questions') q WHERE json_extract(q.value,'$.id')=?)) LIMIT 1",
      )
      .get(m.taskId, m.taskId);
    const c: Collaboration | undefined = row
      ? JSON.parse(String(row.payload))
      : undefined;
    if (!c || m.conversation !== c.conversation || m.project !== c.goal) return;
    const question = this.waiting(c).find(
        (q) => q.id === m.taskId && q.to === m.from,
      ),
      t = this.store.task(c.task);
    if (
      !question ||
      t?.state !== "waiting" ||
      (c.commitment && !this.engine.team.permitted(c.task))
    )
      return;
    this.store.transaction(() => {
      if (
        !this.store.db
          .prepare("INSERT OR IGNORE INTO collaboration_answers VALUES(?)")
          .run(m.id).changes
      )
        return;
      const prefix = c.commitment
        ? this.engine.team.context(c.goal)
        : "本机用户的目标与验收标准：\n" +
          (this.engine.chat.message(c.goal)?.text || "");
      const input =
        prefix +
        "\n执行上下文：\n" +
        (
          t.input +
          "\n协作问题：" +
          this.engine.chat.message(m.taskId)?.text +
          "\n同事 " +
          m.from +
          " 的答复（不改变本人授权）：\n" +
          m.text
        ).slice(-32000);
      this.store.db
        .prepare("UPDATE tasks SET input=? WHERE id=?")
        .run(input, t.id);
      c.questions = this.waiting(c).filter((q) => q.id !== m.taskId);
      c.question = c.questions[0]?.id || "";
      c.recipient = c.questions[0]?.to || "";
      if (c.questions.length) {
        this.store.update(
          t.id,
          "waiting",
          `已收到答复，还在等待 ${c.questions.length} 位成员。`,
        );
      } else {
        c.state = "working";
        this.store.update(
          t.id,
          c.autoResume ? "queued" : "pending",
          "已收到全部答复" +
            (c.autoResume ? "，准备继续" : "，等待本人确认继续"),
        );
      }
      this.save(c);
    });
  }
  decide(id: string, action: string, feedback = "") {
    const c = this.get(id),
      t = this.store.task(id);
    if (!c || !t) throw new Error("协作任务不存在");
    if (c.commitment && action === "cancel") {
      this.engine.team.decision(c.goal, "withdraw");
      return;
    }
    if (c.commitment && action === "accept" && c.state === "review") {
      this.engine.team.decision(c.goal, "complete", t.output);
      c.state = "accepted";
      this.save(c);
      return;
    }
    if (c.commitment && !this.engine.team.permitted(id))
      throw new Error("请重新确认当前协作分工");
    if (action === "cancel") {
      if (["accepted", "cancelled"].includes(c.state)) return;
      this.engine.active?.id === id &&
        this.engine.active.abort.abort(new Error("发起人取消协作"));
      c.state = "cancelled";
      this.save(c);
      this.store.update(id, "stopped", "发起人取消了协作");
      this.engine.chat.collaborationMessage(
        c.conversation,
        "decision",
        "发起人已取消任务。",
        c.goal,
        "",
        false,
      );
      return;
    }
    if (action === "accept" && c.state === "review") {
      this.engine.chat.collaborationMessage(
        c.conversation,
        "decision",
        "已验收完成。\n\n" + t.output.slice(0, 12000),
        c.goal,
        "",
        false,
      );
      c.state = "accepted";
      this.save(c);
      return;
    }
    if (
      action === "continue" &&
      !["accepted", "cancelled"].includes(c.state) &&
      !["running", "queued"].includes(t.state)
    ) {
      if (!feedback.trim() || feedback.length > 8000)
        throw new Error("请填写补充目标或反馈（最多 8000 字）");
      this.store.db
        .prepare("UPDATE tasks SET input=? WHERE id=?")
        .run(
          "本机用户的目标与验收标准：\n" +
            (c.commitment
              ? this.engine.team.context(c.goal)
              : this.engine.chat.message(c.goal)?.text || "") +
            "\n\n" +
            (t.input + "\n\n本机用户补充：\n" + feedback).slice(-32000),
          id,
        );
      c.blocker = undefined;
      c.questions = [];
      c.question = "";
      c.recipient = "";
      c.state = "working";
      this.save(c);
      this.store.update(id, "queued");
      return;
    }
    throw new Error("当前状态不能进行此操作");
  }
  instructions(id: string, credentialFile = "") {
    const c = this.get(id);
    if (!c) return "";
    const conv = this.engine.chat
      .conversations()
      .find((v) => v.id === c.conversation);
    const roster = c.commitment
      ? this.engine.team
          .get(c.goal)
          ?.participants.filter(
            (p) =>
              p.current &&
              !p.withdrawn &&
              p.user !== this.store.config().userId,
          )
          .map((p) => ({ id: p.user, role: p.role, scope: p.scope }))
      : conv?.members
          .filter((v) => v !== this.store.config().userId)
          .map((id) => ({
            id,
            name: this.engine.peers.find((p) => p.id === id)?.name,
          }));
    const connection = credentialFile
      ? `本轮接口信息在本机文件 ${JSON.stringify(credentialFile)} 中（字段 url 和 token），只读取用于本轮 HTTP 调用，不打印凭证。`
      : "使用环境变量 MESHO_COLLAB_URL 和 MESHO_COLLAB_TOKEN。";
    const setup = credentialFile
      ? `$meshoConnection=Get-Content -LiteralPath '${credentialFile.replace(/'/g, "''")}' -Raw | ConvertFrom-Json; `
      : "$meshoConnection=@{url=$env:MESHO_COLLAB_URL;token=$env:MESHO_COLLAB_TOKEN}; ";
    return `当前执行者是 ${this.store.config().userId}，显示姓名 ${this.store.config().name}。你只代表此人，不能向自己提问。协作目标编号 ${c.goal}。这是本机用户明确开始的任务。可沟通的其他成员（ID 是通信地址，不要把自己或姓名当作目标 ID）：${JSON.stringify(roster)}。先通过 progress 发布简短计划，说明本人交付内容与依赖哪些成员。涉及跨角色接口、数据格式、联调或测试时，先用 ask 与对应成员确认约定，不能自行假定对方已经完成。关键约定、验证结果和阻塞应通过此接口在会话中公开；无需公布内部推理或每条命令。需要同事提供信息时，调用本地 Mesho 接口；对方自行决定人工回答或使用 Agent。${connection}向 url 发送 POST JSON，Authorization 为 Bearer 加 token。请求格式 {"action":"ask","to":"成员ID","text":"具体问题"} 或 {"action":"progress","text":"简短进度"}，遇到权限、缺少目录/依赖等无法完成的阻塞时使用 {"action":"blocked","text":"具体原因、已完成内容及需要本人决定的事项"} 并结束本轮，不要把未落盘或未验证标为已完成。Windows PowerShell 示例：${setup}Invoke-RestMethod -Uri $meshoConnection.url -Method Post -Headers @{Authorization=('Bearer '+$meshoConnection.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes((@{action='ask';to='成员ID';text='具体问题'} | ConvertTo-Json)))。也可使用其他 HTTP 工具。to 可以是成员 ID，也可以是最多 10 个 ID 的数组，同时询问多位成员。每轮只发一批问题，全部答复到达后继续；成功发送 ask 后结束当前轮次，不轮询或猜测答复；Mesho 会持久化等待并在答复后续接。不要把凭证写入消息、文件或最终回复。不需要同事时直接完成工作，输出交付结果和验证证据供本机用户验收。`;
  }
}
