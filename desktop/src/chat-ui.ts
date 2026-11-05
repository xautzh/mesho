import { teamPanel, teamModal, teamDrawer } from "./team-ui";
import type { TeamGoal, Scope } from "../electron/team";
import type { Collaboration } from "../electron/collaboration";
import { renderMarkdown } from "./markdown";
import type {
  ChatMessage,
  Conversation,
  ConversationView,
  Config,
  Profile,
  Task,
} from "../electron/types";
export const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const e = escapeHTML;
export const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5"/>', task: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 12l2 2 4-4M9 18h6"/>', settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>', plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', send: '<path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14"/>', bot: '<rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 2v4M8 12h.01M16 12h.01M9 16h6"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>' } as Record<string, string>)[name] || ""}</svg>`;
interface State {
  config: Omit<Config, "token">;
  peers: Profile[];
  conversations: ConversationView[];
  tasks: Task[];
  collaborations: Collaboration[];
  teamGoals: TeamGoal[];
  connected: boolean;
  error: string;
}
export interface ChatAPI {
  teamDetails(goal: string): Promise<TeamGoal | undefined>;
  teamPropose(conversation: string, text: string): Promise<string>;
  teamAmend(goal: string, revision: string, text: string): Promise<void>;
  teamCommit(
    goal: string,
    revision: string,
    scope: Scope,
    auto: boolean,
  ): Promise<string>;
  teamDecision(goal: string, action: string, text?: string): Promise<void>;
  collaborationStart(
    conversation: string,
    goal: string,
    auto: boolean,
  ): Promise<string>;
  collaborationDecide(
    id: string,
    action: string,
    feedback?: string,
  ): Promise<void>;
  approve(id: string): Promise<void>;
  chatAnswer(id: string, text: string): Promise<ChatMessage>;
  chatCreate(c: unknown): Promise<Conversation>;
  chatSend(m: unknown): Promise<ChatMessage>;
  chatHistory(id: string, before?: number): Promise<ChatMessage[]>;
  chatRead(id: string, seq: number): Promise<void>;
  chatRetry(id: string): Promise<void>;
  chatDelegate(id: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}
export class ChatUI {
  selected = "";
  search = "";
  filter = "all";
  popup = false;
  collaborationPopup = false;
  feedbackTask = "";
  teamDetail?: TeamGoal;
  teamInspect = false;
  selectedTeam = "";
  teamAction = "";
  teamGoal = "";
  teamRevision = "";
  replyTo = "";
  members = false;
  loading = false;
  history: ChatMessage[] = [];
  more = true;
  modalKind = "group";
  private drafts = new Map<string, string>();
  private sendBusy = false;
  private loadVersion = 0;
  private state!: State;
  private mentionStart = -1;
  private mentionEnd = 0;
  private mentionQuery = "";
  private mentionIndex = 0;
  constructor(
    private api: ChatAPI,
    private redraw: () => void,
    private notify: (s: string) => void,
    private run: (f: () => Promise<unknown>) => Promise<void>,
    private openTask: (id: string) => void,
  ) {}
  name(c: Conversation) {
    return c.kind === "group"
      ? c.name
      : this.person(
          c.members.find((x) => x !== this.state.config.userId) || "",
        );
  }
  person(id: string) {
    if (id === this.state.config.userId) return this.state.config.name;
    return this.state.peers.find((p) => p.id === id)?.name || id;
  }
  update(s: State) {
    this.state = s;
  }
  async refresh() {
    if (!this.selected) return;
    const id = this.selected;
    const version = this.loadVersion;
    const data = await this.api.chatHistory(id);
    if (id !== this.selected || version !== this.loadVersion) return;
    const all = new Map(this.history.map((m) => [m.id, m]));
    data.forEach((m) => all.set(m.id, m));
    this.history = [...all.values()].sort(
      (a, b) => a.created - b.created || a.seq - b.seq,
    );
    if (this.teamInspect) {
      const goal = this.selectedTeam;
      const detail = await this.api.teamDetails(goal);
      if (this.selectedTeam === goal) this.teamDetail = detail;
    }
    if (document.hasFocus()) await this.markRead();
  }
  async markRead() {
    const seq = Math.max(0, ...this.history.map((m) => m.seq));
    if (seq) await this.api.chatRead(this.selected, seq);
  }
  async select(id: string) {
    this.selected = id;
    this.selectedTeam = "";
    this.teamInspect = false;
    this.replyTo = "";
    this.loadVersion++;
    this.history = [];
    this.members = false;
    this.loading = true;
    this.more = true;
    this.mentionStart = -1;
    this.redraw();
    try {
      await this.refresh();
      await this.markRead();
    } finally {
      this.loading = false;
      this.redraw();
      document.getElementById("chat-input")?.focus();
    }
  }
  async direct(peer: string) {
    await this.run(async () => {
      const c = await this.api.chatCreate({
        kind: "direct",
        name: "",
        members: [peer],
      });
      if (!this.state.conversations.some((x) => x.id === c.id))
        this.state.conversations.push({ ...c, unread: 0, mentioned: false });
      await this.select(c.id);
    });
  }
  render() {
    const s = this.state;
    const current = s.conversations.find((c) => c.id === this.selected);
    const list = s.conversations.filter(
      (c) =>
        (this.filter === "all" ||
          (this.filter === "unread" ? c.unread > 0 : c.kind === "group")) &&
        (this.name(c) + " " + (c.latest?.text || ""))
          .toLowerCase()
          .includes(this.search.toLowerCase()),
    );
    return `<section class="conversation-sidebar"><div class="conversation-title"><h1>消息</h1><button id="new-conversation" class="icon-button" aria-label="新建聊天" title="新建聊天">${icon("plus")}</button></div><div class="conversation-search">${icon("search")}<input id="chat-search" aria-label="搜索会话" placeholder="搜索会话或最近消息" value="${e(this.search)}"></div><div class="chat-filters">${[
      ["all", "全部"],
      ["unread", "未读"],
      ["group", "群聊"],
    ]
      .map(
        ([id, name]) =>
          `<button data-chat-filter="${id}" class="${this.filter === id ? "active" : ""}">${name}</button>`,
      )
      .join(
        "",
      )}</div><div class="conversation-list">${list.map((c) => `<button class="conversation-row ${c.id === this.selected ? "selected" : ""}" data-conversation="${e(c.id)}"><div class="avatar ${c.kind === "group" ? "group-avatar" : ""}">${c.kind === "group" ? icon("people") : e(this.name(c).slice(0, 1))}</div><div class="conversation-copy"><div><strong>${e(this.name(c))}</strong><time>${c.latest ? new Date(c.latest.created).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</time></div><p>${c.mentioned ? '<span class="mention-alert">[有人 @ 我]</span> ' : ""}${e(c.latest ? (c.latest.kind === "task" ? "[Agent 任务] " : c.latest.kind === "result" ? "[Agent 回复] " : "") + c.latest.text : "开始新的对话")}</p></div>${c.unread ? `<span class="unread">${Math.min(c.unread, 99)}${c.unread > 99 ? "+" : ""}</span>` : ""}</button>`).join("") || '<div class="list-empty">暂无会话<br><small>点击 + 发起私聊或创建群聊</small></div>'}</div><div class="list-connection"><span class="dot ${s.connected ? "online" : ""}"></span>${s.connected ? "消息已连接" : "离线 · 消息将在连接后发送"}</div></section><section class="chat-panel">${current ? this.conversation(current) : `<div class="chat-welcome"><img src="./logo.png" alt="Mesho"><h2>让人与 Agent，在这里协作</h2><p>给同事发消息，或创建一个工作群聊。</p><button class="primary" id="welcome-chat">开始聊天</button><div class="welcome-captions"><span>${icon("chat")} 即时沟通</span><span>${icon("bot")} 人机协作</span></div></div>`}</section>`;
  }
  private conversation(c: ConversationView) {
    const s = this.state;
    const others = c.members.filter((id) => id !== s.config.userId);
    const draft = this.drafts.get(c.id) || "";
    return `<div class="chat-heading"><div><h2>${e(this.name(c))}${c.kind === "group" ? ` <span class="muted">${c.members.length}</span>` : ""}</h2><p>${c.kind === "group" ? "群聊 · 人与 Agent 一起协作" : e(s.peers.find((p) => p.id === others[0])?.role || "直接与同事沟通")}</p></div><button id="start-collaboration">发起协作</button><button class="icon-button" id="chat-members" aria-label="查看会话成员" title="查看会话成员">${icon("people")}</button></div>${s.error ? `<div class="chat-error" role="status">连接异常，未发出的消息会保留。${e(s.error)}</div>` : ""}${this.members ? `<div class="member-strip">${c.members.map((id) => `<span>${e(this.person(id))}${id === s.config.userId ? "（我）" : ""}<small>${e(id)}</small></span>`).join("")}</div>` : ""}${teamPanel(
      (s.teamGoals || []).filter((g) => g.conversation === c.id),
      s.config.userId,
      (id) => this.person(id),
      this.selectedTeam,
    )}${this.collaborationPanel(c.id)}<div class="chat-timeline" role="log" aria-label="聊天内容">${this.loading ? '<div class="timeline-note">正在加载消息…</div>' : ""}${this.history.length >= 100 && this.more ? '<button class="history-more" id="chat-more">加载更早消息</button>' : ""}<div class="timeline-note">${new Date(c.created).toLocaleDateString("zh-CN")} · ${c.kind === "group" ? "群聊已创建" : "对话开始"}</div>${this.history.map((m) => this.bubble(m)).join("")}${!this.loading && !this.history.length ? '<div class="timeline-note">还没有消息，发送第一条问候吧。</div>' : ""}</div><form id="chat-send" class="chat-composer"><div class="composer-toolbar"><span class="composer-identity">以 ${e(s.config.name)} 的身份发送 · 由对方决定如何处理</span></div>${this.replyTo ? `<div class="reply-context">正在回答协作问题：${e(this.history.find((m) => m.id === this.replyTo)?.text.slice(0, 80))}<button type="button" id="cancel-answer">取消</button></div>` : ""}<div class="editor-wrap"><textarea id="chat-input" aria-label="聊天消息" placeholder="输入消息，输入 @ 选择成员" rows="3" maxlength="16000" required>${e(draft)}</textarea><div id="mention-picker"></div></div><div class="composer-bottom"><small>Enter 发送 · Shift + Enter 换行</small><button type="submit" class="primary" ${this.sendBusy ? "disabled" : ""}>${this.sendBusy ? "发送中…" : "发送"} ${icon("send")}</button></div></form>`;
  }
  private bubble(m: ChatMessage) {
    const mine = m.from === this.state.config.userId;
    const task = this.state.tasks.find(
      (t) => t.messageId === m.id || t.messageId === m.taskId,
    );
    const text = renderMarkdown(
      m.kind === "commitment"
        ? (() => {
            try {
              const p = JSON.parse(m.text);
              return `我确认参与本轮协作。\n\n角色：${p.role}\n负责范围：${p.scope}\n验收标准：${p.acceptance}\n参与方式：${p.mode === "agent" ? "Agent（由本人单独开始）" : "人工"}`;
            } catch {
              return m.text;
            }
          })()
        : m.text,
      Object.fromEntries(m.mentions.map((id) => [id, this.person(id)])),
    );
    return `<article class="chat-message ${mine ? "mine" : ""} ${m.agent && m.kind !== "task" ? "agent-message" : ""}" data-message="${e(m.id)}"><div class="avatar">${m.agent && m.kind !== "task" ? icon("bot") : e(this.person(m.from).slice(0, 1))}</div><div class="bubble-column"><div class="message-author">${e(this.person(m.from))}${m.agent && m.kind !== "task" ? '<span class="ai-label">Agent</span>' : ""}<time>${new Date(m.created).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div><div class="bubble">${m.kind === "task" ? `<div class="task-bubble-title">${icon("bot")}交给 ${e(this.person(m.agent))} 的 Agent <span>${e(m.project)}</span></div>` : ""}${this.state.teamGoals.some((g) => g.id === (m.kind === "proposal" ? m.id : m.project)) ? `<button class="task-link" data-view-team="${e(m.kind === "proposal" ? m.id : m.project)}">协作：${e(this.state.teamGoals.find((g) => g.id === (m.kind === "proposal" ? m.id : m.project))?.text.slice(0, 48))}</button>` : ""}<div class="collaboration-label">${e(({ proposal: "协作提案", amendment: "共同目标更新 · 需重新确认", commitment: "本人确认分工", completion: "本人确认完成", withdrawal: "退出本轮协作", closure: "协作已共同完成", goal: "协作目标", question: "协作提问", answer: "协作答复", progress: "任务进度", decision: "发起人决定" } as Record<string, string>)[m.kind] || "")}</div><div class="bubble-text markdown-body">${text}</div>${!mine && m.kind === "question" && m.mentions.includes(this.state.config.userId) ? `<button class="task-link" data-answer="${e(m.id)}">我来回答</button>` : ""}${!mine && (m.kind === "text" || (m.kind === "question" && m.mentions.includes(this.state.config.userId))) && !task ? `<button class="task-link" data-delegate="${e(m.id)}">交给我的 Agent</button>` : ""}${task ? `<button class="task-link" data-chat-task="${e(task.id)}">查看任务与审批 →</button>` : ""}</div>${mine ? `<small class="delivery ${m.delivery === "failed" ? "failed" : ""}">${m.delivery === "pending" ? "等待发送" : m.delivery === "failed" ? `发送失败：${e(m.error)} <button data-chat-retry="${e(m.id)}">重试</button>` : this.deliveryStatus(m)}</small>` : ["goal", "commitment"].includes(m.kind) ? `<small class="delivery">${this.activityStatus(m)}</small>` : ""}</div></article>`;
  }
  private deliveryStatus(m: ChatMessage) {
    const c = this.state.conversations.find((v) => v.id === m.conversation);
    const readers = m.readBy || [];
    const read = m.receiptAvailable
      ? c?.kind === "group"
        ? `${readers.length}/${Math.max(0, c.members.length - 1)} 人已读`
        : readers.length
          ? "已读"
          : "已发送 · 未读"
      : "已发送 · 回执暂不可用";
    return (
      `<span title="${e(readers.map((id) => this.person(id)).join("、"))}">${e(read)}</span>` +
      this.activityStatus(m)
    );
  }
  private activityStatus(m: ChatMessage) {
    const c = this.state.conversations.find((v) => v.id === m.conversation);
    const labels: Record<string, string> = {
      waiting: "等待协作答复",
      review: "等待发起人验收",
      accepted: "发起人已验收",
      cancelled: "协作已取消",
      pending: "等待对方确认执行",
      queued: "Agent 排队中",
      running: "Agent 执行中",
      awaiting_review: "执行完成 · 等待对方确认回复",
      reply_pending: "正在发送回复",
      replied: "Agent 已回复",
      failed: "Agent 执行或回复失败",
      stopped: "对方已停止执行",
      rejected: "对方未接受执行",
      interrupted: "执行中断",
    };
    return (m.activities || [])
      .map(
        (a) =>
          `<span class="remote-activity state-${e(a.state)}">${c?.kind === "group" ? e(this.person(a.user)) + "：" : ""}${e(labels[a.state] || a.state)}${a.state === "running" && Date.now() - a.updated > 60000 ? "（状态待更新）" : ""}</span>`,
      )
      .join("");
  }

  private collaborationPanel(conversation: string) {
    const labels: Record<string, string> = {
      working: "处理中",
      waiting: "等待同事答复",
      review: "等待你验收",
      accepted: "已验收",
      cancelled: "已取消",
    };
    const items = (this.state.collaborations || []).filter(
      (c) => c.conversation === conversation && !c.commitment,
    );
    return items.length
      ? `<div class="collaboration-panel">${items
          .map((c) => {
            const task = this.state.tasks.find((t) => t.id === c.task);
            const closed = ["accepted", "cancelled"].includes(c.state);
            const status =
              c.state === "working"
                ? (
                    {
                      pending: "等待你确认继续",
                      queued: "排队中",
                      running: "Agent 执行中",
                      failed: "执行失败",
                      stopped: "已停止",
                      interrupted: "执行中断",
                      rejected: "执行预算耗尽或被拒绝",
                    } as Record<string, string>
                  )[task?.state || ""] || labels[c.state]
                : labels[c.state];
            return `<div class="collaboration-row"><div><strong>${e(this.history.find((m) => m.id === c.goal)?.text.slice(0, 70) || "协作任务")}</strong><small>${e(status)} · ${c.autoResume ? "答复后自动继续" : "继续前由我确认"}</small></div><div class="collaboration-actions"><button data-chat-task="${e(c.task)}">查看结果</button>${task?.state === "pending" ? `<button data-collab-approve="${e(c.task)}">确认继续</button>` : ""}${c.state === "review" ? `<button class="primary" data-collab-accept="${e(c.task)}">验收完成</button>` : ""}${!closed && !["running", "queued"].includes(task?.state || "") ? `<button data-collab-feedback="${e(c.task)}">补充要求</button>` : ""}${!closed ? `<button data-collab-cancel="${e(c.task)}">停止协作</button>` : ""}</div></div>`;
          })
          .join("")}</div>`
      : "";
  }
  modal() {
    if (this.collaborationPopup && this.teamAction)
      return teamModal(
        this.teamAction,
        this.state.teamGoals?.find((g) => g.id === this.teamGoal),
        this.state.config.userId,
      );
    if (this.collaborationPopup)
      return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="collaboration-title"><div class="detail-head"><h2 id="collaboration-title">${this.feedbackTask ? "补充要求" : "发起协作任务"}</h2><button id="close-collaboration" aria-label="关闭">×</button></div><form id="collaboration-form"><label>${this.feedbackTask ? "补充要求与反馈" : "目标与验收标准"}<textarea name="goal" rows="6" maxlength="8000" required placeholder="例如：完成注册页面与接口联调；遇到接口问题可向本聊天中的同事询问，完成后提供测试结果。"></textarea></label>${this.feedbackTask ? "" : '<label class="check"><input name="autoResume" type="checkbox" checked>收到所询问同事的答复后，允许我的 Agent 自动继续</label><p class="hint">从你的工作目录开始执行，可向本聊天成员发送问题和进度。对方自行决定如何处理；最终结果由你验收。沿用本机执行次数上限。</p>'}<div class="modal-footer"><button type="button" id="cancel-collaboration">取消</button><button class="primary" type="submit">${this.feedbackTask ? "继续执行" : "开始协作"}</button></div></form></section></div>`;
    if (this.teamInspect) {
      const g =
        this.teamDetail?.id === this.selectedTeam ? this.teamDetail : undefined;
      if (g)
        return teamDrawer(g, this.state.config.userId, (id) => this.person(id));
    }
    if (!this.popup) return "";
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title"><div class="detail-head"><h2 id="new-chat-title">新建聊天</h2><button id="close-chat-modal" aria-label="关闭">×</button></div><form id="create-chat"><label>聊天类型<select id="new-chat-kind" name="kind"><option value="group" ${this.modalKind === "group" ? "selected" : ""}>创建群聊</option><option value="direct" ${this.modalKind === "direct" ? "selected" : ""}>发起私聊</option></select></label>${this.modalKind === "group" ? '<label>群聊名称<input name="name" maxlength="40" placeholder="例如：产品研发协作群" required></label>' : ""}<div class="section-label">选择同事${this.modalKind === "direct" ? "（选择一位）" : ""}</div><div class="member-picker">${
      this.state.peers
        .filter((p) => p.id !== this.state.config.userId)
        .map(
          (p) =>
            `<label class="member-option"><input type="${this.modalKind === "direct" ? "radio" : "checkbox"}" name="members" value="${e(p.id)}"><div class="avatar">${e(p.name.slice(0, 1))}</div><span>${e(p.name)}<small>${e(p.id)} · ${e(p.role)}</small></span></label>`,
        )
        .join("") ||
      '<p class="hint">还没有同事加入，请先在另一客户端连接同一团队。</p>'
    }</div><p class="hint">直接输入 @ 提醒成员。每位成员按自己的本地配置决定如何处理。</p><div class="modal-footer"><button type="button" id="cancel-chat-modal">取消</button><button class="primary" type="submit">创建聊天</button></div></form></section></div>`;
  }
  bind() {
    const on = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    document.querySelectorAll<HTMLElement>("[data-conversation]").forEach(
      (el) =>
        (el.onclick = () => {
          void this.run(() => this.select(el.dataset.conversation!));
        }),
    );
    document.querySelectorAll<HTMLElement>("[data-chat-filter]").forEach(
      (el) =>
        (el.onclick = () => {
          this.filter = el.dataset.chatFilter!;
          this.redraw();
        }),
    );
    const search = document.querySelector<HTMLInputElement>("#chat-search");
    if (search)
      search.oninput = () => {
        this.search = search.value;
        this.redraw();
      };
    const popup = () => {
      this.popup = true;
      this.redraw();
      document
        .querySelector<HTMLInputElement>("#create-chat input[name=name]")
        ?.focus();
    };
    on("new-conversation", popup);
    on("welcome-chat", popup);
    on("close-chat-modal", () => {
      this.popup = false;
      this.redraw();
    });
    on("cancel-chat-modal", () => {
      this.popup = false;
      this.redraw();
    });
    on("chat-members", () => {
      this.members = !this.members;
      this.redraw();
    });
    const kind = document.querySelector<HTMLSelectElement>("#new-chat-kind");
    if (kind)
      kind.onchange = () => {
        this.modalKind = kind.value;
        this.redraw();
      };
    const form = document.querySelector<HTMLFormElement>("#create-chat");
    if (form)
      form.onsubmit = (ev) => {
        ev.preventDefault();
        void this.run(async () => {
          const f = new FormData(form);
          const members = f.getAll("members").map(String);
          if (!members.length) throw new Error("请选择至少一位同事");
          const c = await this.api.chatCreate({
            kind: f.get("kind"),
            name: f.get("name") || "",
            members,
          });
          this.state.conversations.unshift({
            ...c,
            unread: 0,
            mentioned: false,
          });
          this.popup = false;
          await this.select(c.id);
        });
      };
    const selector = document.querySelector<HTMLSelectElement>("#team-select");
    if (selector)
      selector.onchange = () => {
        this.selectedTeam = selector.value;
        this.redraw();
      };
    const openTeam = (id: string) => {
      void this.run(async () => {
        this.selectedTeam = id;
        this.teamDetail = await this.api.teamDetails(id);
        this.teamInspect = true;
        this.redraw();
        document.getElementById("team-close")?.focus();
      });
    };
    on("team-open", () =>
      openTeam(document.getElementById("team-open")!.dataset.teamId!),
    );
    document
      .querySelectorAll<HTMLElement>("[data-view-team]")
      .forEach((el) => (el.onclick = () => openTeam(el.dataset.viewTeam!)));
    on("team-close", () => {
      this.teamInspect = false;
      this.redraw();
      document.getElementById("team-open")?.focus();
    });
    on("start-collaboration", () => {
      this.teamAction = "propose";
      this.teamGoal = "";
      this.teamRevision = "";
      this.collaborationPopup = true;
      this.feedbackTask = "";
      this.redraw();
      document
        .querySelector<HTMLTextAreaElement>("#collaboration-form textarea")
        ?.focus();
    });
    const closeCollaboration = () => {
      this.collaborationPopup = false;
      this.teamAction = "";
      this.feedbackTask = "";
      this.redraw();
    };
    on("close-collaboration", closeCollaboration);
    on("cancel-collaboration", closeCollaboration);
    document.querySelectorAll<HTMLElement>("[data-team-action]").forEach(
      (el) =>
        (el.onclick = () => {
          const action = el.dataset.teamAction!,
            id = el.dataset.teamId!,
            g = this.state.teamGoals.find((g) => g.id === id);
          if (!g) return;
          if (["withdraw", "close", "start"].includes(action)) {
            void this.run(async () => {
              await this.api.teamDecision(id, action);
              await this.refresh();
            });
            return;
          }
          this.teamAction = action;
          this.teamGoal = id;
          this.teamRevision = g.revision;
          this.collaborationPopup = true;
          this.redraw();
          document
            .querySelector<HTMLElement>("#team-form input,#team-form textarea")
            ?.focus();
        }),
    );
    const teamForm = document.querySelector<HTMLFormElement>("#team-form");
    if (teamForm)
      teamForm.onsubmit = (ev) => {
        ev.preventDefault();
        void this.run(async () => {
          const f = new FormData(teamForm),
            text = String(f.get("text") || "");
          if (this.teamAction === "propose")
            this.selectedTeam = await this.api.teamPropose(this.selected, text);
          else if (this.teamAction === "amend")
            await this.api.teamAmend(this.teamGoal, this.teamRevision, text);
          else if (this.teamAction === "commit")
            await this.api.teamCommit(
              this.teamGoal,
              this.teamRevision,
              {
                role: String(f.get("role")),
                scope: String(f.get("scope")),
                acceptance: String(f.get("acceptance")),
                mode: String(f.get("mode")) as Scope["mode"],
              },
              f.has("autoResume"),
            );
          else await this.api.teamDecision(this.teamGoal, "complete", text);
          this.collaborationPopup = false;
          this.teamAction = "";
          await this.refresh();
        });
      };
    const collabForm = document.querySelector<HTMLFormElement>(
      "#collaboration-form",
    );
    if (collabForm)
      collabForm.onsubmit = (ev) => {
        ev.preventDefault();
        void this.run(async () => {
          const data = new FormData(collabForm),
            goal = String(data.get("goal") || "");
          if (this.feedbackTask)
            await this.api.collaborationDecide(
              this.feedbackTask,
              "continue",
              goal,
            );
          else
            await this.api.collaborationStart(
              this.selected,
              goal,
              data.has("autoResume"),
            );
          this.collaborationPopup = false;
          this.feedbackTask = "";
          await this.refresh();
        });
      };
    for (const action of ["accept", "cancel", "feedback", "approve"])
      document.querySelectorAll<HTMLElement>(`[data-collab-${action}]`).forEach(
        (el) =>
          (el.onclick = () => {
            const id = el.getAttribute(`data-collab-${action}`)!;
            if (action === "feedback") {
              this.teamAction = "";
              this.feedbackTask = id;
              this.collaborationPopup = true;
              this.redraw();
              return;
            }
            void this.run(async () => {
              if (action === "approve") await this.api.approve(id);
              else await this.api.collaborationDecide(id, action);
              await this.refresh();
            });
          }),
      );
    document.querySelectorAll<HTMLElement>("[data-answer]").forEach(
      (el) =>
        (el.onclick = () => {
          this.replyTo = el.dataset.answer!;
          this.teamInspect = false;
          this.redraw();
          document.getElementById("chat-input")?.focus();
        }),
    );
    on("cancel-answer", () => {
      this.replyTo = "";
      this.redraw();
    });
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (input) {
      input.oninput = () => {
        this.drafts.set(this.selected, input.value);
        this.detectMention(input);
      };
      input.onkeydown = (ev) => {
        if (ev.isComposing) return;
        if (this.mentionStart >= 0) {
          if (ev.key === "Escape") {
            this.mentionStart = -1;
            this.showMentions();
            ev.preventDefault();
            return;
          }
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            this.mentionIndex += ev.key === "ArrowDown" ? 1 : -1;
            this.showMentions();
            ev.preventDefault();
            return;
          }
          if (ev.key === "Enter" && this.mentionCandidates().length) {
            this.chooseMention(this.mentionCandidates()[this.mentionIndex]?.id);
            ev.preventDefault();
            return;
          }
        }
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          document
            .querySelector<HTMLFormElement>("#chat-send")
            ?.requestSubmit();
        }
      };
    }
    const send = document.querySelector<HTMLFormElement>("#chat-send");
    if (send)
      send.onsubmit = (ev) => {
        ev.preventDefault();
        if (this.sendBusy) return;
        void this.run(async () => {
          this.sendBusy = true;
          try {
            const text = input?.value || "";
            const members =
              this.state.conversations.find((c) => c.id === this.selected)
                ?.members || [];
            const mentions = [
              ...text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_.-]{0,79})(?=\s|$)/g),
            ]
              .map((v) => v[1])
              .filter((id) => members.includes(id));
            if (this.replyTo) {
              await this.api.chatAnswer(this.replyTo, text);
              this.replyTo = "";
            } else
              await this.api.chatSend({
                conversation: this.selected,
                text,
                mentions,
                kind: "text",
              });
            this.drafts.delete(this.selected);
            this.mentionStart = -1;
            await this.refresh();
          } finally {
            this.sendBusy = false;
          }
        });
      };
    document.querySelectorAll<HTMLElement>("[data-chat-retry]").forEach(
      (el) =>
        (el.onclick = () =>
          void this.run(async () => {
            await this.api.chatRetry(el.dataset.chatRetry!);
            await this.refresh();
          })),
    );
    document.querySelectorAll<HTMLElement>("[data-chat-task]").forEach(
      (el) =>
        (el.onclick = () => {
          this.teamInspect = false;
          this.openTask(el.dataset.chatTask!);
        }),
    );
    document.querySelectorAll<HTMLElement>("[data-delegate]").forEach(
      (el) =>
        (el.onclick = () =>
          void this.run(async () => {
            const id = await this.api.chatDelegate(el.dataset.delegate!);
            this.openTask(id);
          })),
    );
    on(
      "chat-more",
      () =>
        void this.run(async () => {
          const seq = Math.min(
            ...this.history.filter((m) => m.seq > 0).map((m) => m.seq),
          );
          const more = await this.api.chatHistory(this.selected, seq);
          this.more = more.length === 100;
          const ids = new Set(this.history.map((m) => m.id));
          this.history = [
            ...more.filter((m) => !ids.has(m.id)),
            ...this.history,
          ];
        }),
    );
    document.querySelectorAll<HTMLAnchorElement>(".markdown-body a").forEach(
      (a) =>
        (a.onclick = (ev) => {
          ev.preventDefault();
          void this.run(() => this.api.openExternal(a.href));
        }),
    );
    this.showMentions();
  }
  private mentionCandidates() {
    const c = this.state.conversations.find((v) => v.id === this.selected);
    return this.state.peers.filter(
      (p) =>
        c?.members.includes(p.id) &&
        p.id !== this.state.config.userId &&
        (p.id + " " + p.name)
          .toLowerCase()
          .includes(this.mentionQuery.toLowerCase()),
    );
  }
  private detectMention(input: HTMLTextAreaElement) {
    const end = input.selectionStart;
    const match = input.value.slice(0, end).match(/(?:^|\s)@([^\s@]*)$/);
    this.mentionStart = match ? end - match[1].length - 1 : -1;
    this.mentionEnd = end;
    this.mentionQuery = match?.[1] || "";
    this.mentionIndex = 0;
    this.showMentions();
  }
  private chooseMention(id?: string) {
    if (!id) return;
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (!input) return;
    input.setRangeText(
      "@" + id + " ",
      this.mentionStart,
      this.mentionEnd,
      "end",
    );
    this.drafts.set(this.selected, input.value);
    this.mentionStart = -1;
    this.showMentions();
    input.focus();
  }
  private showMentions() {
    const picker = document.getElementById("mention-picker");
    if (!picker) return;
    if (this.mentionStart < 0) {
      picker.innerHTML = "";
      return;
    }
    const candidates = this.mentionCandidates();
    this.mentionIndex = Math.max(
      0,
      Math.min(candidates.length - 1, this.mentionIndex),
    );
    picker.innerHTML = `<div class="mention-menu" role="listbox" aria-label="选择 @ 成员">${candidates.map((p, i) => `<button type="button" role="option" aria-selected="${i === this.mentionIndex}" data-mention="${e(p.id)}">${e(p.name)}<small>@${e(p.id)}</small></button>`).join("") || "<p>没有匹配成员</p>"}</div>`;
    picker
      .querySelectorAll<HTMLElement>("[data-mention]")
      .forEach(
        (el) => (el.onclick = () => this.chooseMention(el.dataset.mention)),
      );
  }
}
