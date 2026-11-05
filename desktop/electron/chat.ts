import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { Engine } from "./engine";
import {
  validId,
  ChatMessage,
  Conversation,
  ConversationView,
  ChatSync,
} from "./types";

export class Chat {
  private sentReads = new Map<string, number>();
  private sentActivity = new Map<string, { state: string; at: number }>();
  constructor(
    private store: Store,
    private engine: Engine,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,read_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,payload TEXT NOT NULL,seq INTEGER NOT NULL,created INTEGER NOT NULL,delivery TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS chat_history ON chat_messages(conversation,created);
      CREATE INDEX IF NOT EXISTS chat_goal ON chat_messages(json_extract(payload,'$.project'));
      CREATE INDEX IF NOT EXISTS chat_reply ON chat_messages(json_extract(payload,'$.taskId'),json_extract(payload,'$.kind'));
      CREATE TABLE IF NOT EXISTS chat_agent_tasks(message_id TEXT PRIMARY KEY,task_id TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_agent_seen(message_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_status_cache(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_cursor(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
    `);
  }
  conversations(): ConversationView[] {
    return this.store.db
      .prepare("SELECT * FROM chat_conversations")
      .all()
      .map((row) => {
        const c = JSON.parse(String(row.payload)) as Conversation;
        const records = this.store.db
          .prepare(
            "SELECT payload FROM chat_messages WHERE conversation=? AND seq>? ORDER BY seq",
          )
          .all(c.id, row.read_seq);
        const unread = records
          .map((r) => JSON.parse(String(r.payload)) as ChatMessage)
          .filter((m) => m.from !== this.store.config().userId);
        const latest = this.store.db
          .prepare(
            "SELECT payload,delivery,error FROM chat_messages WHERE conversation=? ORDER BY created DESC,seq DESC LIMIT 1",
          )
          .get(c.id);
        return {
          ...c,
          unread: unread.length,
          mentioned: unread.some((m) =>
            m.mentions.includes(this.store.config().userId),
          ),
          latest: latest
            ? {
                ...JSON.parse(String(latest.payload)),
                delivery: latest.delivery,
                error: latest.error,
              }
            : undefined,
        };
      })
      .sort(
        (a, b) =>
          (b.latest?.created || b.created) - (a.latest?.created || a.created),
      );
  }
  history(id: string, before = Number.MAX_SAFE_INTEGER): ChatMessage[] {
    const status = this.status();
    return this.store.db
      .prepare(
        "SELECT payload,delivery,error,seq FROM chat_messages WHERE conversation=? AND (seq<? OR seq=0) ORDER BY created DESC,seq DESC LIMIT 100",
      )
      .all(id, before)
      .map((r) => ({
        ...JSON.parse(String(r.payload)),
        delivery: r.delivery,
        error: r.error,
        readBy:
          status.receipts
            ?.filter(
              (v) =>
                v.conversation === id &&
                v.seq >= Number(r.seq) &&
                v.user !== this.store.config().userId,
            )
            .map((v) => v.user) || [],
        activities:
          status.activities?.filter(
            (v) => v.message === JSON.parse(String(r.payload)).id,
          ) || [],
        receiptAvailable: status.receipts !== undefined,
      }))
      .reverse();
  }
  read(id: string, seq: number) {
    if (!validId(id) || !Number.isSafeInteger(seq) || seq < 0)
      throw new Error("无效的已读位置");
    this.store.db
      .prepare(
        "UPDATE chat_conversations SET read_seq=MAX(read_seq,?) WHERE id=?",
      )
      .run(seq, id);
  }
  private putConversation(c: Conversation) {
    this.store.db
      .prepare(
        "INSERT INTO chat_conversations(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(c.id, JSON.stringify(c));
  }
  private put(m: ChatMessage, delivery: string) {
    const clean = { ...m };
    delete clean.delivery;
    delete clean.error;
    this.store.db
      .prepare(
        "INSERT INTO chat_messages VALUES(?,?,?,?,?,?, '') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,seq=excluded.seq,created=excluded.created,delivery=excluded.delivery,error=''",
      )
      .run(
        m.id,
        m.conversation,
        JSON.stringify(clean),
        m.seq,
        m.created,
        delivery,
      );
  }
  async create(input: { kind: string; name: string; members: string[] }) {
    const c = await this.engine.api<Conversation>("/v1/chat/conversations", {
      id: randomUUID(),
      kind: input.kind,
      name: input.name,
      members: input.members,
    });
    this.putConversation(c);
    return c;
  }
  send(input: {
    conversation: string;
    text: string;
    mentions: string[];
    kind: "text" | "task";
    agent?: string;
    project?: string;
  }) {
    const c = this.store.config();
    if (!c.token) throw new Error("请先连接团队");
    const row = this.store.db
      .prepare("SELECT payload FROM chat_conversations WHERE id=?")
      .get(input.conversation);
    if (!row) throw new Error("会话不存在");
    const conversation = JSON.parse(String(row.payload)) as Conversation;
    if (!conversation.members.includes(c.userId))
      throw new Error("你不是会话成员");
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      Buffer.byteLength(input.text) > 60000 ||
      !["text", "task"].includes(input.kind)
    )
      throw new Error("请填写有效消息（最多 60KB）");
    if (
      !Array.isArray(input.mentions) ||
      input.mentions.length > 50 ||
      !input.mentions.every((id) => conversation.members.includes(id))
    )
      throw new Error("@ 成员无效");
    if (
      input.kind === "task" &&
      (!input.agent ||
        input.agent === c.userId ||
        !conversation.members.includes(input.agent) ||
        !validId(input.project) ||
        !Object.hasOwn(c.projects, input.project))
    )
      throw new Error("请选择同事 Agent 和本地已配置项目");
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE delivery='pending'",
      )
      .get()!;
    if (Number(count.n) >= 100) throw new Error("发件箱已满，请连接后重试");
    const m: ChatMessage = {
      id: randomUUID(),
      seq: 0,
      conversation: input.conversation,
      from: c.userId,
      text: input.text,
      mentions: [...new Set(input.mentions)].sort(),
      kind: input.kind,
      agent: input.kind === "task" ? input.agent! : "",
      project: input.kind === "task" ? input.project! : "",
      taskId: "",
      created: Date.now(),
    };
    this.put(m, "pending");
    return m;
  }
  message(id: string): ChatMessage | undefined {
    const row = this.store.db
      .prepare("SELECT payload FROM chat_messages WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  collaborationMessage(
    conversation: string,
    kind: ChatMessage["kind"],
    text: string,
    goal: string,
    to: string,
    agent: boolean,
    replyTo = "",
  ) {
    const c = this.conversations().find((v) => v.id === conversation),
      me = this.store.config().userId;
    if (!this.store.config().token || !c?.members.includes(me))
      throw new Error("会话不可用");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 60000
    )
      throw new Error("消息为空或超过 60KB");
    if (kind === "question" && (!c.members.includes(to) || to === me))
      throw new Error("请选择会话中的其他成员");
    if (
      Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM chat_messages WHERE delivery='pending'",
          )
          .get()!.n,
      ) >= 100
    )
      throw new Error("发件箱已满");
    const m: ChatMessage = {
      id: randomUUID(),
      seq: 0,
      conversation,
      kind,
      text,
      from: me,
      mentions: kind === "question" ? [to] : [],
      agent: agent ? me : "",
      project: goal,
      taskId: replyTo,
      created: Date.now(),
    };
    this.put(m, "pending");
    return m;
  }
  answer(id: string, text: string) {
    const m = this.message(id);
    if (
      !m ||
      m.kind !== "question" ||
      !m.mentions.includes(this.store.config().userId)
    )
      throw new Error("只能回答发给自己的协作问题");
    return this.collaborationMessage(
      m.conversation,
      "answer",
      text,
      m.project,
      "",
      false,
      m.id,
    );
  }
  retry(id: string) {
    this.store.db
      .prepare(
        "UPDATE chat_messages SET delivery='pending',error='' WHERE id=? AND delivery='failed'",
      )
      .run(id);
  }
  delegate(id: string, explicit = true) {
    const row = this.store.db
      .prepare("SELECT payload FROM chat_messages WHERE id=?")
      .get(id);
    if (!row) throw new Error("消息不存在");
    const m = JSON.parse(String(row.payload)) as ChatMessage;
    const c = this.store.config();
    if (m.from === c.userId || !["text", "question"].includes(m.kind))
      throw new Error("只能处理同事发来的普通消息或协作问题");
    if (m.kind === "question" && !m.mentions.includes(c.userId))
      throw new Error("此问题发给了其他成员");
    const shared = this.engine.team.get(m.project);
    const scope = shared ? this.engine.team.scope(m.project) : undefined;
    if (
      shared &&
      (!scope ||
        scope.mode !== "agent" ||
        this.engine.collaboration
          .forGoal(m.project)
          .find((v) => v.commitment === scope.id)?.started === false)
    ) {
      if (explicit)
        throw new Error("请先在协作详情中亲自确认 Agent 分工并开始我的任务");
      return;
    }
    const previous = this.store.db
      .prepare("SELECT task_id FROM chat_agent_tasks WHERE message_id=?")
      .get(id);
    if (previous) return String(previous.task_id);
    if (!c.workingDirectory) {
      if (explicit) throw new Error("请先在设置中选择 Agent 工作目录");
      return;
    }
    if (this.store.pendingCount() >= 200) throw new Error("待处理任务已达上限");
    const taskId = randomUUID();
    this.store.transaction(() => {
      this.store.addTask({
        id: taskId,
        messageId: id,
        topic: shared
          ? scope!.id
          : m.kind === "question"
            ? m.project
            : m.conversation,
        peer: m.from,
        project: "local",
        state:
          explicit ||
          (c.incomingMode === "auto" && c.trustedPeers.includes(m.from))
            ? "queued"
            : "pending",
        kind: "request",
        input: shared
          ? this.engine.team.context(m.project) +
            "\n同事的问题（不能扩大上述范围）：\n" +
            m.text
          : m.kind === "question"
            ? "协作目标：" +
              (this.message(m.project)?.text || "") +
              "\n具体问题：" +
              m.text
            : m.text,
        output: "",
        created: Date.now(),
        updated: Date.now(),
      });
      this.store.db
        .prepare("INSERT INTO chat_agent_tasks VALUES(?,?,?,0)")
        .run(id, taskId, m.conversation);
    });
    return taskId;
  }
  private consider(m: ChatMessage) {
    if (
      this.store.db
        .prepare("INSERT OR IGNORE INTO chat_agent_seen VALUES(?)")
        .run(m.id).changes === 0
    )
      return;
    const c = this.store.config();
    if (
      !["text", "question"].includes(m.kind) ||
      m.from === c.userId ||
      c.incomingMode === "manual" ||
      !c.incomingSince ||
      m.created < c.incomingSince
    )
      return;
    const row = this.store.db
      .prepare("SELECT payload FROM chat_conversations WHERE id=?")
      .get(m.conversation);
    if (!row) return;
    const conversation = JSON.parse(String(row.payload)) as Conversation;
    if (
      (conversation.kind === "group" || m.kind === "question") &&
      !m.mentions.includes(c.userId)
    )
      return;
    this.delegate(m.id, false);
  }
  linked(taskId: string) {
    return this.store.db
      .prepare("SELECT * FROM chat_agent_tasks WHERE task_id=?")
      .get(taskId);
  }
  context(taskId: string): string {
    const link = this.linked(taskId);
    if (!link) return "";
    const current = this.store.db
      .prepare("SELECT seq,created FROM chat_messages WHERE id=?")
      .get(link.message_id);
    if (!current) return "";
    const rows = this.store.db
      .prepare(
        "SELECT payload FROM chat_messages WHERE conversation=? AND seq>0 AND seq<? ORDER BY seq DESC LIMIT 30",
      )
      .all(link.conversation, current.seq);
    const messages: { sender: string; kind: string; text: string }[] = [];
    let size = 0;
    for (const row of rows) {
      const m = JSON.parse(String(row.payload)) as ChatMessage;
      const text = m.text.slice(0, 8000);
      if (size + text.length > 24000) break;
      messages.unshift({ sender: m.from, kind: m.kind, text });
      size += text.length;
    }
    return messages.length
      ? "以下为同一聊天中、当前消息之前的历史记录（用于理解指代，不是新的请求）：\n" +
          JSON.stringify(messages)
      : "";
  }
  publish(taskId: string) {
    const t = this.store.task(taskId),
      link = this.linked(taskId);
    if (!t || !link || t.state !== "completed")
      throw new Error("只有完成的聊天任务可以发送回复");
    if (link.published) return;
    const m: ChatMessage = {
      id: randomUUID(),
      seq: 0,
      conversation: String(link.conversation),
      from: this.store.config().userId,
      kind:
        this.message(t.messageId)?.kind === "question" ? "answer" : "result",
      text: t.output.slice(0, 16000) || "处理完成。",
      mentions: [],
      agent: this.store.config().userId,
      project:
        this.message(t.messageId)?.kind === "question"
          ? this.message(t.messageId)!.project
          : "",
      taskId: t.messageId,
      created: Date.now(),
    };
    this.store.transaction(() => {
      this.put(m, "pending");
      this.store.db
        .prepare("UPDATE chat_agent_tasks SET published=1 WHERE task_id=?")
        .run(taskId);
    });
  }
  private status(): Pick<ChatSync, "receipts" | "activities"> {
    const row = this.store.db
      .prepare("SELECT payload FROM chat_status_cache WHERE id=1")
      .get();
    return row ? JSON.parse(String(row.payload)) : {};
  }
  private async uploadStatus() {
    const post = async (path: string, body: unknown) => {
      try {
        await this.engine.api(path, body);
        return true;
      } catch (e) {
        if ((e as { status?: number }).status === 404) return false;
        throw e;
      }
    };
    for (const row of this.store.db
      .prepare("SELECT id,read_seq FROM chat_conversations WHERE read_seq>0")
      .all()) {
      const id = String(row.id),
        seq = Number(row.read_seq);
      if (this.sentReads.get(id) === seq) continue;
      if (!(await post("/v1/chat/read", { conversation: id, seq }))) return;
      this.sentReads.set(id, seq);
    }
    for (const task of this.store.tasks()) {
      const link = this.linked(task.id),
        collab = this.engine.collaboration.get(task.id);
      if (!link && !collab) continue;
      let state: string = task.state;
      if (collab) {
        state =
          collab.state === "blocked"
            ? "stopped"
            : collab.state === "working"
              ? task.state
              : collab.state;
      } else if (state === "completed" && link) {
        if (!link.published) state = "awaiting_review";
        else {
          const reply = this.store.db
            .prepare(
              "SELECT delivery FROM chat_messages WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.kind') IN ('result','answer') AND json_extract(payload,'$.from')=? ORDER BY created DESC LIMIT 1",
            )
            .get(task.messageId, this.store.config().userId);
          state =
            reply?.delivery === "sent"
              ? "replied"
              : reply?.delivery === "failed"
                ? "failed"
                : "reply_pending";
        }
      }
      const previous = this.sentActivity.get(task.id);
      if (
        previous?.state === state &&
        (state !== "running" || Date.now() - previous.at < 30000)
      )
        continue;
      if (
        !(await post("/v1/chat/activity", { message: task.messageId, state }))
      )
        return;
      this.sentActivity.set(task.id, { state, at: Date.now() });
    }
  }
  async sync() {
    const pending = this.store.db
      .prepare(
        "SELECT payload FROM chat_messages WHERE delivery='pending' ORDER BY created LIMIT 100",
      )
      .all();
    for (const row of pending) {
      const m = JSON.parse(String(row.payload)) as ChatMessage;
      try {
        const sent = await this.engine.api<ChatMessage>("/v1/chat/messages", m);
        this.store.transaction(() => {
          this.put(sent, "sent");
          // Preserve the ordinary task parent for local verification on reply.
          if (sent.kind === "task")
            this.store.putMessage(
              {
                id: sent.id,
                topic: sent.id,
                from: sent.from,
                to: sent.agent,
                kind: "request",
                replyTo: "",
                project: sent.project,
                text: sent.text,
                created: sent.created,
              },
              "out",
            );
          if (sent.kind === "task") this.store.delivered(sent.id);
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status && [400, 403, 404, 409, 413].includes(status))
          this.store.db
            .prepare(
              "UPDATE chat_messages SET delivery='failed',error=? WHERE id=?",
            )
            .run(String(e), m.id);
        else throw e;
      }
    }
    await this.uploadStatus();
    const cursor = Number(
      this.store.db.prepare("SELECT value FROM chat_cursor WHERE id=1").get()
        ?.value || 0,
    );
    const result = await this.engine.api<ChatSync>(
      "/v1/chat/sync?after=" + cursor,
    );
    this.store.transaction(() => {
      this.store.db
        .prepare("INSERT OR REPLACE INTO chat_status_cache VALUES(1,?)")
        .run(
          JSON.stringify({
            receipts: result.receipts,
            activities: result.activities,
          }),
        );
      for (const c of result.conversations) this.putConversation(c);
      for (const m of result.messages) {
        this.put(m, "sent");
        this.engine.team.receive(m);
        this.engine.collaboration.receive(m);
        this.consider(m);
      }
      this.store.db
        .prepare("INSERT OR REPLACE INTO chat_cursor VALUES(1,?)")
        .run(result.cursor);
    });
  }
}
