import "./style.css";
import { renderMarkdown } from "./markdown";
import "./chat.css";
import { ChatUI, ChatAPI, icon } from "./chat-ui";
import type {
  Config,
  Message,
  Profile,
  Task,
  ConversationView,
} from "../electron/types";
type Snapshot = {
  teamGoals: import("../electron/team").TeamGoal[];
  collaborations: import("../electron/collaboration").Collaboration[];
  conversations: ConversationView[];
  config: Omit<Config, "token">;
  registered: boolean;
  peers: Profile[];
  messages: (Message & {
    direction: string;
    delivered: boolean;
    error: string;
  })[];
  tasks: Task[];
  connected: boolean;
  error: string;
  activeId?: string;
  bridgePath: string;
};
interface API extends ChatAPI {
  snapshot(): Promise<Snapshot>;
  setup(c: unknown, i: string, t: string): Promise<void>;
  configure(c: unknown): Promise<void>;
  send(m: unknown): Promise<void>;
  chatPublish(id: string): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  pause(v: boolean): Promise<void>;
  sync(): Promise<void>;
  pickDirectory(): Promise<string>;
}
declare global {
  interface Window {
    mesho: API;
  }
}
const api = window.mesho;
const root = document.querySelector<HTMLDivElement>("#app")!;
let s: Snapshot;
let tab = "chat";
let selected = "";
let filter = "all";
let busy = false;
let compose = false;
let recipient = "";
let refreshError = "";
let lastRendered = "";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const chat = new ChatUI(
  api,
  () => render(true),
  toast,
  action,
  (id) => {
    selected = id;
    tab = "tasks";
    render(true);
  },
);
let composingIME = false;
const labels: Record<string, string> = {
  review: "待验收",
  accepted: "已验收",
  waiting: "等待答复",
  pending: "待审批",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  stopped: "已停止",
  interrupted: "需核对",
  request: "请求",
  result: "结果",
  notice: "通知",
};
const time = (n: number) =>
  new Date(n).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const peerName = (id: string) => s.peers.find((p) => p.id === id)?.name || id;
const tag = (state: string) =>
  `<span class="badge ${esc(state)}">${esc(labels[state] || state)}</span>`;
function toast(message: string) {
  const el = document.querySelector<HTMLElement>("#toast")!;
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 5000);
}
async function action(fn: () => Promise<unknown> | unknown, success = "") {
  if (busy) return;
  busy = true;
  root.setAttribute("aria-busy", "true");
  try {
    await fn();
    if (success) toast(success);
    s = await api.snapshot();
    render(true);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
  } finally {
    busy = false;
    root.removeAttribute("aria-busy");
  }
}
function field(
  label: string,
  name: string,
  value = "",
  type = "text",
  extra = "",
) {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function setup() {
  return `<div class="onboarding"><div class="brand big"><img class="brand-logo" src="./logo.png" alt="Mesho">mesho<span class="version">TEAM / 0.6.1</span></div><div class="welcome"><span class="eyebrow">YOUR AGENTS, CONNECTED</span><h1>让协作，接着发生。</h1><p>连接团队，配置自己的职责。每个 Agent 都在本机的规则下工作。</p></div><form id="setup" class="setup-form"><div class="section-label">01 / 连接团队</div>${field("服务地址", "server", s.config.server, "url", 'placeholder="https://mesho.your-team.com" required')}${field("团队邀请码", "invite", "", "password", 'autocomplete="off" placeholder="向服务管理员获取"')}<details><summary>已有账号？使用访问凭证恢复</summary>${field("访问凭证（填写后不使用邀请码）", "token", "", "password", 'autocomplete="off"')}</details><div class="section-label">02 / 介绍自己</div><div class="two">${field("唯一用户 ID", "userId", "", "text", 'placeholder="例如 wang-dev" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}" required')}${field("显示姓名", "name", "", "text", 'placeholder="例如 小王" required')}</div><label>职责描述<textarea name="role" placeholder="例如：负责订单服务的后端开发、接口问题排查" rows="2"></textarea></label><p class="hint">连接后在「本地设置」添加项目目录和自动处理规则。默认请求需要你接受。</p><button class="primary" type="submit">连接团队 <span>→</span></button></form></div>`;
}
function nav() {
  const pending = s.tasks.filter((t) => t.state === "pending").length;
  const unread = s.conversations.reduce((n, c) => n + c.unread, 0);
  return `<aside class="app-rail"><button class="rail-brand" data-tab="chat" aria-label="Mesho 首页"><img src="./logo.png" alt="Mesho"></button><nav>${[
    ["chat", "chat", "消息", unread],
    ["peers", "people", "通讯录", 0],
    ["tasks", "task", "Agent 任务", pending],
  ]
    .map(
      ([id, i, name, count]) =>
        `<button data-tab="${id}" class="rail-item ${tab === id ? "active" : ""}" aria-label="${name}" title="${name}">${icon(String(i))}<small>${name}</small>${count ? `<span class="rail-badge">${count}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</nav><div class="rail-bottom"><button data-tab="settings" class="rail-item ${tab === "settings" ? "active" : ""}" aria-label="本地设置" title="本地设置">${icon("settings")}<small>设置</small></button><div class="avatar self-avatar" title="${esc(s.config.name)} · ${esc(s.config.userId)}">${esc(s.config.name.slice(0, 1))}</div><span class="rail-version">0.6.1</span></div></aside>`;
}
function header() {
  const titles: Record<string, [string, string]> = {
    tasks: ["任务工作台", "接收请求，由你决定接下来如何执行。"],
    peers: ["团队成员", "找到合适的同事，让 Agent 接力协作。"],
    messages: ["消息记录", "请求、结果与通知，都有迹可循。"],
    settings: ["本地设置", "身份公开，目录与执行权限留在这台电脑。"],
  };
  return `<header><div><span class="eyebrow">${tab.toUpperCase()}</span><h1>${titles[tab][0]}</h1><p>${titles[tab][1]}</p></div><div class="header-actions">${tab === "tasks" ? '<button data-tab="messages">投递记录</button>' : ""}<button id="pause" class="${s.config.paused ? "warning" : ""}">${s.config.paused ? "▶ 恢复执行" : "Ⅱ 暂停执行"}</button><button id="compose" class="primary">＋ 发消息</button></div></header>${s.error || refreshError ? `<div class="banner error">${esc(s.error || refreshError)}<button id="retry">重新连接</button></div>` : ""}${s.config.paused ? '<div class="banner">本机执行已暂停。消息仍会接收，正在运行的任务会停止。</div>' : ""}`;
}
function tasks() {
  const list = s.tasks.filter(
    (t) =>
      filter === "all" ||
      (filter === "pending"
        ? t.state === "pending"
        : ["queued", "running", "waiting"].includes(t.state)),
  );
  const current = s.tasks.find((t) => t.id === selected) || list[0];
  return `<div class="stats"><div><span>待你决定</span><strong>${s.tasks.filter((t) => t.state === "pending").length}</strong></div><div><span>正在处理</span><strong>${s.tasks.filter((t) => ["queued", "running", "waiting"].includes(t.state)).length}</strong></div><div><span>已完成</span><strong>${s.tasks.filter((t) => t.state === "completed").length}</strong></div><div class="stat-note"><span class="dot online"></span>执行权限始终由本机掌握</div></div><div class="task-board"><section class="task-list"><div class="list-top">协作任务 <span>${s.tasks.length}</span></div><div class="filters">${[
    ["all", "全部"],
    ["pending", "待审批"],
    ["active", "处理中"],
  ]
    .map(
      ([id, name]) =>
        `<button data-filter="${id}" class="${filter === id ? "active" : ""}">${name}</button>`,
    )
    .join(
      "",
    )}</div>${list.length ? list.map((t) => `<button class="task-row ${current?.id === t.id ? "selected" : ""}" data-task="${t.id}"><div class="row-top">${tag(t.state)}<time>${time(t.created)}</time></div><strong>${esc(t.project)}</strong><p>${esc(t.input.slice(0, 100))}</p><small>${esc(peerName(t.peer))} <span>·</span> ${t.kind === "verify" ? "本地复验" : "协作请求"}</small></button>`).join("") : '<div class="empty compact"><div class="empty-icon">↔</div><h3>这里还没有任务</h3><p>同事发来的请求会出现在这里。<br>也可以先向团队发起一个请求。</p></div>'}</section><section class="task-detail">${current ? detail(current) : '<div class="empty"><div class="empty-icon">m</div><h2>协作，从一个请求开始</h2><p>连接同事的 Agent，保留自己的执行边界。<br>收到的请求会先经过本地规则，再进入工作队列。</p><button class="primary" id="empty-compose">开始聊天 →</button></div>'}</section></div>`;
}
function detail(t: Task) {
  const collab = s.collaborations?.find((c) => c.task === t.id);
  const collabActions = collab
    ? `<div class="collaboration-actions">${collab.state === "review" ? `<button class="primary" data-collab-accept="${t.id}">验收完成并发布结果</button>` : ""}${!["accepted", "cancelled"].includes(collab.state) && !["running", "queued"].includes(t.state) ? `<button data-collab-feedback="${t.id}">补充要求</button>` : ""}</div>`
    : "";
  return `<div class="detail-head"><div><span class="eyebrow">${collab ? "COLLABORATION" : t.kind === "verify" ? "LOCAL VERIFICATION" : "INCOMING REQUEST"}</span><h2>${collab ? "我发起的协作" : esc(t.project)}</h2></div>${collab?.state === "review" ? tag("review") : collab?.state === "accepted" ? tag("accepted") : tag(t.state)}</div><div class="metadata"><span>来自 <strong>${esc(peerName(t.peer))}</strong></span><span>${time(t.created)}</span></div><div class="section-label">请求内容</div><pre class="content">${esc(t.input)}</pre><div class="section-label">处理结果</div><div class="content output markdown-body">${renderMarkdown(t.output || (t.state === "running" ? "Agent 正在本地处理。结果按你的回复设置处理。" : "尚未产生执行结果。"), {})}</div>${collabActions}<div class="detail-foot"><small>话题 ${esc(t.topic)}<br>执行上限 ${s.config.maxRuns} 次 · 沿用本机 CLI 权限</small><div>${t.state === "pending" ? `<button data-reject="${t.id}">拒绝</button><button data-approve="${t.id}" class="primary">接受并执行</button>` : ""}${t.state === "completed" && t.chatReply === "draft" ? `<button data-publish="${t.id}" class="primary">发送 Agent 回复</button>` : ""}${t.chatReply === "sent" ? "<span>回复已加入聊天</span>" : ""}${["running", "queued"].includes(t.state) ? `<button class="danger" data-stop="${t.id}">停止任务</button>` : ""}</div></div>`;
}
function peers() {
  const list = s.peers.filter((p) => p.id !== s.config.userId);
  return `<div class="section-line"><h2>同事目录 <span class="muted">${list.length}</span></h2><button id="refresh-peers">刷新目录</button></div><div class="peer-grid">${list.length ? list.map((p) => `<article class="peer-card"><div class="peer-head"><div class="avatar large">${esc(p.name.slice(0, 1))}</div><div><h3>${esc(p.name)}</h3><small>${esc(p.id)}</small></div><span class="presence"><span class="dot ${Date.now() - p.seen < 15000 ? "online" : ""}"></span>${Date.now() - p.seen < 15000 ? "在线" : "离线"}</span></div><p>${esc(p.role || "尚未填写职责")}</p><div class="chips">${(p.projects || []).map((v) => `<span>${esc(v)}</span>`).join("") || "<span>未发布项目</span>"}</div><div class="peer-footer"><small>${s.config.trustedPeers.includes(p.id) ? "已加入本机信任列表" : "按本地审批规则处理"}</small><button data-peer="${esc(p.id)}">发消息</button></div></article>`).join("") : '<div class="empty"><h2>等待同事加入</h2><p>同事连接同一个服务后，会自动出现在这里。</p></div>'}</div>`;
}
function messages() {
  return `<div class="section-line"><h2>最近消息</h2><span class="muted">最多显示 300 条 · 发件箱自动补发</span></div><div class="message-list">${s.messages.length ? s.messages.map((m) => `<article class="message"><div class="row-top"><strong>${esc(peerName(m.from))} <span class="muted">→</span> ${esc(peerName(m.to))}</strong><time>${time(m.created)}</time></div><div class="chips">${tag(m.kind)}<span>${esc(m.project)}</span><span>${m.direction === "out" ? (m.error ? "投递失败：" + esc(m.error) : m.delivered ? "服务端已收件" : "待投递") : "本机已收件"}</span></div><pre>${esc(m.text)}</pre><small>话题 ${esc(m.topic)}</small></article>`).join("") : '<div class="empty"><h2>还没有消息</h2><p>发起协作后，可以在这里追踪请求和回告。</p></div>'}</div>`;
}
function settings() {
  const c = s.config;
  return `<form id="settings" class="settings-form"><section><div class="section-label">公开身份</div><div class="two">${field("显示姓名", "name", c.name, "text", "required")}${field("用户 ID", "userId", c.userId, "text", "disabled")}</div><label>职责描述<textarea name="role" rows="2">${esc(c.role)}</textarea></label></section><section><div class="section-label">收到消息后</div><label>处理方式<select name="incomingMode" aria-label="处理方式"><option value="manual" ${c.incomingMode === "manual" ? "selected" : ""}>自己回复（可逐条交给我的 Agent）</option><option value="approval" ${c.incomingMode === "approval" ? "selected" : ""}>Agent 处理前由我确认</option><option value="auto" ${c.incomingMode === "auto" ? "selected" : ""}>信任同事的消息自动交给 Agent</option></select></label><p class="hint">处理启用后收到的私聊、群内 @ 我的普通消息，以及明确发给我的协作问题。普通 Agent 回复和进度不会触发执行；自己发起的协作任务按创建时的选择续接。</p>${field("信任同事的用户 ID（逗号分隔）", "trustedPeers", c.trustedPeers.join(", "))}<label>Agent 回复方式<select name="replyMode" aria-label="Agent 回复方式"><option value="draft" ${c.replyMode === "draft" ? "selected" : ""}>先留作待确认回复，由我决定是否发送</option><option value="auto" ${c.replyMode === "auto" ? "selected" : ""}>处理成功后自动回复到原聊天</option></select></label></section><section><div class="section-label">Agent 工作目录</div>${field("本机目录", "workingDirectory", c.workingDirectory, "text", 'placeholder="选择 Agent 可以工作的本地文件夹"')}<button type="button" id="pick-workspace">选择文件夹</button><p class="hint">只在本机设置一次，不需要与同事约定项目 ID。人工聊天无需配置目录。Agent 的职责、回复语言和处理要求可在下方本地规则中填写。</p></section><section><div class="section-label">Agent 执行器</div><label>执行器类型<select name="provider" id="provider"><option value="codex" ${c.provider === "codex" ? "selected" : ""}>Codex · GPT</option><option value="claude" ${c.provider === "claude" ? "selected" : ""}>Claude Code</option><option value="custom" ${c.provider === "custom" ? "selected" : ""}>自定义 CLI</option></select></label>${field("本地运行命令", "runCommand", c.runCommand, "text", 'placeholder="例如 claude --model sonnet 或 python C:\\tools\\agent.py"')}<p class="hint">填写程序和固定参数，带空格的路径用双引号包裹。Codex / Claude 自动追加非交互执行参数，留空使用默认命令。自定义 CLI 从标准输入读取任务、以标准输出返回结果；必须能无人值守运行，不使用交互式终端。命令仅保存在本机。</p><p class="hint runner-boundary">沿用本机 CLI 的配置、Skills、插件、MCP 和权限策略。Mesho 不覆盖沙箱、审批策略或工具列表。桌面专属工具仍需相应宿主支持。</p>${field("Codex 可执行文件或安装路径", "codexPath", c.codexPath, "text", "required")}<div class="two">${field("单次执行超时（秒）", "timeoutSeconds", String(c.timeoutSeconds), "number", 'min="10" max="3600" required')}</div>${field("每个话题最多执行次数", "maxRuns", String(c.maxRuns), "number", 'min="1" max="20" required')}<label>我的处理偏好（可选）<textarea name="localInstructions" rows="4">${esc(c.localInstructions)}</textarea></label></section><div class="settings-footer"><span class="hint">修改只影响本机。每小时最多启动 20 次执行。</span><button type="submit" class="primary">保存设置</button></div><details><summary>CLI 接入信息</summary><p class="hint">桌面端运行时，使用随项目提供的 mesho-cli.mjs 查询同事或发送请求。凭证文件仅供本机 CLI 读取，不要分享。</p><code>${esc(s.bridgePath)}</code></details></form>`;
}
function modal() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="compose-title"><div class="detail-head"><h2 id="compose-title">发起协作请求</h2><button id="close-compose" aria-label="关闭">×</button></div><p class="hint">你提出请求，由对方的本地规则决定是否接受。</p><form id="send"><label>接收同事<select name="to" aria-label="接收同事" required><option value="">选择同事</option>${s.peers
    .filter((p) => p.id !== s.config.userId)
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${recipient === p.id ? "selected" : ""}>${esc(p.name)} · ${esc(p.role.slice(0, 35))}</option>`,
    )
    .join(
      "",
    )}</select></label><label>项目<select name="project" aria-label="项目" required><option value="">选择本地已配置项目</option>${Object.keys(
    s.config.projects,
  )
    .map((p) => `<option>${esc(p)}</option>`)
    .join(
      "",
    )}</select></label><label>请求内容<textarea name="text" rows="6" placeholder="描述问题、复现步骤、证据与期望结果……" required maxlength="16000"></textarea></label>${field("话题编号（可选，留空创建新话题）", "topic")}<div class="modal-footer"><button type="button" id="cancel-compose">取消</button><button class="primary" type="submit">发送请求 →</button></div></form></section></div>`;
}
function render(force = false) {
  if (!s) return;
  chat.update(s);
  const signature = JSON.stringify([
    s,
    tab,
    selected,
    filter,
    compose,
    chat.selected,
    chat.history,
    chat.teamInspect ? chat.teamDetail : null,
  ]);
  if (composingIME) return;
  if (!force && signature === lastRendered) return;
  if (
    !force &&
    lastRendered &&
    (compose ||
      chat.popup ||
      chat.collaborationPopup ||
      tab === "settings" ||
      !s.registered)
  )
    return;
  const scroll = document.querySelector(".main")?.scrollTop || 0;
  const active = document.activeElement as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const focusId = active?.id;
  const selection =
    active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const timeline = document.querySelector(".chat-timeline");
  const previousConversation = timeline?.getAttribute("data-current");
  const timelineScroll = timeline?.scrollTop || 0;
  const atBottom =
    !timeline ||
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
  const conversationScroll =
    document.querySelector(".conversation-list")?.scrollTop || 0;
  const teamScroll =
    document.querySelector(".team-drawer-body")?.scrollTop || 0;
  const teamDetails = new Map(
    Array.from(
      document.querySelectorAll<HTMLDetailsElement>(
        ".team-goal, .team-member details",
      ),
    ).map((el) => [
      el.dataset.teamGoal ||
        el.closest<HTMLElement>("[data-team-member]")?.dataset.teamMember,
      el.open,
    ]),
  );
  lastRendered = signature;
  root.innerHTML = s.registered
    ? `<div class="shell">${nav()}${tab === "chat" ? chat.render() : `<main class="main">${header()}${tab === "tasks" ? tasks() : tab === "peers" ? peers() : tab === "messages" ? messages() : settings()}</main>`}</div>${compose ? modal() : ""}${chat.modal()}`
    : setup();
  bind();
  chat.bind();
  const nextTimeline = document.querySelector(".chat-timeline");
  if (nextTimeline) {
    nextTimeline.setAttribute("data-current", chat.selected);
    nextTimeline.scrollTop =
      atBottom || previousConversation !== chat.selected
        ? nextTimeline.scrollHeight
        : timelineScroll;
  }
  const conversationList = document.querySelector(".conversation-list");
  if (conversationList) conversationList.scrollTop = conversationScroll;
  if (previousConversation === chat.selected) {
    document
      .querySelectorAll<HTMLDetailsElement>(".team-goal, .team-member details")
      .forEach((el) => {
        const key =
          el.dataset.teamGoal ||
          el.closest<HTMLElement>("[data-team-member]")?.dataset.teamMember;
        if (teamDetails.has(key)) el.open = teamDetails.get(key)!;
      });
    const panel = document.querySelector(".team-drawer-body");
    if (panel) panel.scrollTop = teamScroll;
  }
  if (focusId) {
    const next = document.getElementById(focusId) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (next) {
      next.focus({ preventScroll: true });
      if (selection && selection[0] !== null && selection[1] !== null)
        try {
          next.setSelectionRange(selection[0], selection[1]);
        } catch {}
    }
  }
  const main = document.querySelector(".main");
  if (main) main.scrollTop = scroll;
  if (compose)
    document.querySelector<HTMLSelectElement>("#send select")?.focus();
}
function bind() {
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach(
    (el) =>
      (el.onclick = () => {
        tab = el.dataset.tab!;
        render(true);
      }),
  );
  document.querySelectorAll<HTMLElement>("[data-filter]").forEach(
    (el) =>
      (el.onclick = () => {
        filter = el.dataset.filter!;
        selected = "";
        render(true);
      }),
  );
  document.querySelectorAll<HTMLElement>("[data-task]").forEach(
    (el) =>
      (el.onclick = () => {
        selected = el.dataset.task!;
        render(true);
      }),
  );
  const on = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  const open = (id = "") => {
    tab = "chat";
    if (id) {
      void chat.direct(id);
      return;
    }
    chat.popup = true;
    render(true);
  };
  on("compose", () => open());
  on("empty-compose", () => open());
  on("close-compose", () => {
    compose = false;
    render(true);
  });
  on("cancel-compose", () => {
    compose = false;
    render(true);
  });
  on("pause", () => void action(() => api.pause(!s.config.paused)));
  on("retry", () => void action(() => api.sync()));
  on("refresh-peers", () => void action(() => api.sync()));
  document.querySelectorAll<HTMLElement>("[data-peer]").forEach(
    (el) =>
      (el.onclick = () => {
        tab = "chat";
        void chat.direct(el.dataset.peer!);
      }),
  );
  document
    .querySelectorAll<HTMLElement>("[data-agent-peer]")
    .forEach((el) => (el.onclick = () => open(el.dataset.agentPeer)));
  for (const key of ["approve", "reject", "stop"] as const)
    document
      .querySelectorAll<HTMLElement>(`[data-${key}]`)
      .forEach(
        (el) =>
          (el.onclick = () => void action(() => api[key](el.dataset[key]!))),
      );
  const form = (id: string, fn: (f: FormData) => Promise<unknown>) => {
    const el = document.getElementById(id) as HTMLFormElement | null;
    if (el)
      el.onsubmit = (e) => {
        e.preventDefault();
        void action(() => fn(new FormData(el)));
      };
  };
  form("setup", async (f) => {
    await api.setup(
      {
        server: String(f.get("server")),
        userId: String(f.get("userId")),
        name: String(f.get("name")),
        role: String(f.get("role")),
      },
      String(f.get("invite")),
      String(f.get("token")),
    );
    tab = "chat";
    toast("已连接团队，可以开始聊天；Agent 执行请先配置本地设置");
  });
  form("settings", async (f) => {
    await api.configure({
      provider: String(f.get("provider")),
      runCommand: String(f.get("runCommand")),
      name: String(f.get("name")),
      role: String(f.get("role")),
      incomingMode: String(f.get("incomingMode")),
      replyMode: String(f.get("replyMode")),
      workingDirectory: String(f.get("workingDirectory")).trim(),
      trustedPeers: String(f.get("trustedPeers"))
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      maxRuns: Number(f.get("maxRuns")),
      timeoutSeconds: Number(f.get("timeoutSeconds")),
      codexPath: String(f.get("codexPath")),
      localInstructions: String(f.get("localInstructions")),
    });
    toast("本地设置已保存");
  });
  form("send", async (f) => {
    await api.send({
      to: String(f.get("to")),
      project: String(f.get("project")),
      text: String(f.get("text")),
      topic: String(f.get("topic")) || undefined,
    });
    compose = false;
    tab = "tasks";
    toast("请求已加入发件箱");
  });
  on("pick-workspace", () => {
    void api
      .pickDirectory()
      .then((path) => {
        if (path)
          document.querySelector<HTMLInputElement>(
            "[name=workingDirectory]",
          )!.value = path;
      })
      .catch((e) => toast(String(e)));
  });
  document
    .querySelectorAll<HTMLElement>("[data-publish]")
    .forEach(
      (el) =>
        (el.onclick = () =>
          void action(() => api.chatPublish(el.dataset.publish!))),
    );
  on("browse", () => {
    void api
      .pickDirectory()
      .then((path) => {
        if (path) {
          const textarea =
            document.querySelector<HTMLTextAreaElement>("[name=projects]")!;
          textarea.value +=
            (textarea.value ? "\n" : "") +
            `project-${Object.keys(s.config.projects).length + 1} = ${path}`;
          toast("目录已填入，请编辑项目 ID 后保存设置");
        }
      })
      .catch((e) => toast(String(e)));
  });
}
async function refresh() {
  if (busy) return;
  try {
    s = await api.snapshot();
    chat.update(s);
    if (tab === "chat") await chat.refresh();
    refreshError = "";
    render();
  } catch (e) {
    refreshError = String(e);
    toast(refreshError);
  }
}
document.addEventListener("compositionstart", () => (composingIME = true));
document.addEventListener("compositionend", () => {
  composingIME = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && chat.teamInspect && !chat.collaborationPopup) {
    chat.teamInspect = false;
    render(true);
    document.getElementById("team-open")?.focus();
  }
  if (e.key === "Escape" && chat.collaborationPopup) {
    chat.collaborationPopup = false;
    render(true);
  }
  if (e.key === "Escape" && chat.popup) {
    chat.popup = false;
    render(true);
  }
  if (
    e.key === "Tab" &&
    (compose || chat.popup || chat.collaborationPopup || chat.teamInspect)
  ) {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".modal button,.modal input,.modal select,.modal textarea",
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusable[0],
      last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  if (e.key === "Escape" && compose) {
    compose = false;
    render(true);
  }
});
if (!api) {
  root.innerHTML =
    '<div class="empty"><h1>请通过 Mesho 桌面客户端打开</h1><p>此界面需要本地执行与凭证保护，请运行 npm start。</p></div>';
} else {
  void refresh();
  setInterval(() => void refresh(), 2000);
}
