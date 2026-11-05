import type { TeamGoal, Participant } from "../electron/team";
import { renderMarkdown } from "./markdown";
const e = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const states: Record<string, string> = {
  ready: "待本人开始",
  queued: "排队中",
  running: "Agent 执行中",
  waiting: "等待协作答复",
  pending: "等待本人确认继续",
  review: "本轮结束 · 待核对结果",
  blocked: "任务阻塞",
  failed: "执行失败",
  stopped: "已停止",
  interrupted: "执行中断",
  rejected: "执行被拒绝或预算耗尽",
};
const labels: Record<string, string> = {
  proposal: "目标提案",
  commitment: "确认分工",
  amendment: "目标变更",
  question: "提出问题",
  answer: "答复",
  progress: "进展与结果",
  completion: "本人验收",
  withdrawal: "退出",
  closure: "关闭",
};
function status(p: Participant, g: TeamGoal) {
  const last = g.events
    .filter(
      (m) => m.from === p.user && m.taskId === p.id && m.kind === "progress",
    )
    .at(-1);
  return p.withdrawn
    ? "已退出"
    : !p.current
      ? "目标有更新 · 待重新确认"
      : p.completed
        ? "本人已确认完成"
        : last?.text.startsWith("[任务阻塞]")
          ? "任务阻塞"
          : states[p.state || ""] ||
            (p.mode === "human" ? "人工参与" : "待本人开始");
}
export function teamPanel(
  goals: TeamGoal[],
  me: string,
  name: (id: string) => string,
  selected = "",
) {
  if (!goals.length) return "";
  const g = goals.find((g) => g.id === selected) || goals[0],
    own = g.participants.find((p) => p.user === me);
  return `<div class="team-panel team-bar"><span>协作 ${goals.filter((g) => !g.closed).length}</span><select id="team-select" aria-label="选择协作任务">${goals.map((g) => `<option value="${e(g.id)}" ${g.id === selected || (!selected && g === goals[0]) ? "selected" : ""}>${g.closed ? "[已关闭] " : ""}${e(g.text.split("\n")[0].slice(0, 90))}</option>`).join("")}</select><small>${g.closed ? "已共同完成" : own ? e(status(own, g)) : "待确认分工"}</small><button id="team-open" data-team-id="${e(g.id)}">查看协作</button></div>`;
}
export function teamDrawer(
  g: TeamGoal,
  me: string,
  name: (id: string) => string,
) {
  const own = g.participants.find((p) => p.user === me),
    joined = own?.current && !own.withdrawn,
    active = g.participants.filter((p) => !p.withdrawn),
    canClose =
      active.length > 0 && active.every((p) => p.current && p.completed);
  const button = (action: string, text: string, primary = false) =>
    `<button ${primary ? 'class="primary"' : ""} data-team-action="${action}" data-team-id="${e(g.id)}" ${action === "start" && !own?.synced ? 'disabled title="正在同步分工，完成后可开始"' : ""}>${text}</button>`;
  return `<div class="modal-backdrop team-backdrop"><section class="modal team-drawer" role="dialog" aria-modal="true" aria-labelledby="team-detail-title"><div class="detail-head"><h2 id="team-detail-title">协作详情</h2><button id="team-close" aria-label="关闭协作详情">×</button></div><div class="team-drawer-body"><p class="team-stage">${g.closed ? "已共同完成" : "确认分工 → 各自开始 → 沟通与交付 → 本人验收"} · ${active.filter((p) => p.current).length} 人确认 / ${active.filter((p) => p.current && p.completed).length} 人完成</p><div class="team-objective">${e(g.text)}</div><h3>分工与状态</h3><div class="team-members">${g.participants.map((p) => `<article class="team-member" data-team-member="${e(p.id)}"><div><strong>${e(name(p.user))} · ${e(p.role)}</strong><span>${e(status(p, g))}</span></div><p>负责：${e(p.scope)}</p><small>验收：${e(p.acceptance)}</small></article>`).join("") || '<p class="hint">尚无人确认分工，发布提案不会启动 Agent。</p>'}</div>${g.closed ? "" : `<div class="team-actions">${button("commit", joined ? "调整我的分工" : "确认我的分工")}${button("amend", "补充共同目标")}${joined ? `${own?.state === "ready" ? button("start", "开始我的任务", true) : ""}${own?.task ? `<button data-chat-task="${e(own.task)}">查看我的执行记录</button>` : ""}${!own?.completed && (own?.state === "review" || own?.mode === "human") ? button("complete", "确认我的完成") : ""}${own?.state === "pending" && own.task ? `<button data-collab-approve="${e(own.task)}">确认继续</button>` : ""}${own?.task && ["review", "blocked", "failed", "stopped", "waiting", "interrupted", "rejected"].includes(own.state || "") ? `<button data-collab-feedback="${e(own.task)}">补充反馈并继续</button>` : ""}${button("withdraw", "退出本轮协作")}` : ""}${g.owner === me ? `<button data-team-action="close" data-team-id="${e(g.id)}" ${canClose ? "" : "disabled"}>汇总关闭协作</button>` : ""}</div>`}<h3>沟通与交付记录 <small>最近 200 条 · 仅本项协作</small></h3><div class="team-events">${g.events.map((m) => `<article class="team-event"><header><strong>${e(name(m.from))}${m.agent ? " · Agent" : ""}</strong><span>${e(labels[m.kind] || m.kind)}${m.mentions?.length ? " → " + e(m.mentions.map(name).join("、")) : ""}</span><time>${new Date(m.created).toLocaleString("zh-CN")}</time></header>${m.kind === "commitment" ? "<p>已确认自己的角色与范围。</p>" : `<div class="markdown-body">${renderMarkdown(m.text)}</div>`}${m.delivery === "failed" ? '<small class="failed">发送失败，尚未送达</small>' : m.delivery === "pending" ? "<small>等待发送</small>" : ""}${m.kind === "question" && m.mentions.includes(me) ? `<button data-answer="${e(m.id)}">我来回答</button>` : ""}</article>`).join("")}</div></div></section></div>`;
}
export function teamModal(action: string, g: TeamGoal | undefined, me: string) {
  const own = g?.participants.find((p) => p.user === me);
  const title = (
    {
      propose: "发起多人协作提案",
      commit: "确认我的协作分工",
      amend: "补充共同目标",
      complete: "确认本人完成",
    } as Record<string, string>
  )[action];
  const field = (label: string, key: string, value = "", rows = 3) =>
    `<label>${label}<textarea name="${key}" rows="${rows}" maxlength="4000" required>${e(value)}</textarea></label>`;
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="team-title"><div class="detail-head"><h2 id="team-title">${title}</h2><button id="close-collaboration" aria-label="关闭">×</button></div><form id="team-form">${action === "commit" ? `<div class="team-objective">共同目标提案：${e(g?.text)}</div><label>我的角色<input name="role" maxlength="40" required placeholder="例如：后端开发、前端开发、测试" value="${e(own?.role)}"></label>${field("我负责的范围", "scope", own?.scope)}${field("我的验收标准", "acceptance", own?.acceptance)}<label>我的参与方式<select name="mode"><option value="human" ${own?.mode === "agent" ? "" : "selected"}>人工参与，不启动 Agent</option><option value="agent" ${own?.mode === "agent" ? "selected" : ""}>Agent 参与，确认后手动开始</option></select></label><label class="check"><input type="checkbox" name="autoResume">收到全部关联答复后，允许我的 Agent 自动继续</label><p class="hint">确认仅保存分工，不会启动 Agent。之后由你点击“开始我的任务”。沿用本机 CLI 权限；只读环境无法落盘代码。调整分工会停止旧任务。</p>` : action === "complete" ? field("交付结果与验收证据", "text") : field("共同目标与验收提案", "text", action === "amend" ? g?.text : "", 5)}${action === "propose" ? '<p class="hint">提案对当前聊天中的所有成员可见。发布后，每个人分别确认自己的角色、范围和参与方式；不会自动启动 Agent。</p>' : action === "amend" ? '<p class="hint">提交后，本轮所有分工需要重新确认。客户端收到变更后会停止旧任务，已执行的操作不会自动回滚。</p>' : ""}<div class="modal-footer"><button type="button" id="cancel-collaboration">取消</button><button class="primary" type="submit">${action === "propose" ? "发布协作提案" : action === "commit" ? "确认我的分工" : action === "amend" ? "提交共同目标提案" : "发布本人完成结果"}</button></div></form></section></div>`;
}
