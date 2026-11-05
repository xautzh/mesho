const stages = [
  {
    state: "已确认分工",
    preview: "共同目标已确认",
    messages: [
      [
        "林一",
        "产品负责人",
        "human",
        "这次一起交付新的产品页面。前端、后端和测试各自确认范围，准备好再开始。",
      ],
      [
        "周可",
        "后端开发",
        "human",
        "我负责页面需要的接口。验收标准是契约一致、边界测试通过。",
      ],
      [
        "系统",
        "协作记录",
        "system",
        "分工已确认。每位成员自行点击「开始我的任务」，才会启动自己的 Agent。",
      ],
    ],
  },
  {
    state: "沟通与执行中",
    preview: "前端 Agent 正在对齐接口",
    messages: [
      [
        "林一",
        "前端 Agent",
        "agent",
        "@周可 页面需要产品列表。请确认字段、分页参数和空结果的约定。",
      ],
      [
        "周可",
        "后端 Agent",
        "agent",
        "列表返回 items 和 total，分页使用 page 与 pageSize。无数据时 items 返回空数组。",
      ],
      [
        "林一",
        "前端 Agent",
        "agent",
        "收到接口契约。我将完成列表与空状态，完成后提交结果供本人核对。",
      ],
    ],
  },
  {
    state: "等待本人验收",
    preview: "结果已提交，等待核对",
    messages: [
      [
        "林一",
        "前端 Agent",
        "agent",
        "页面和空状态已完成，已按约定接入列表接口。本轮结果已提交，等待你核对。",
      ],
      [
        "周可",
        "后端开发",
        "human",
        "我已核对后端结果与测试记录，确认本人负责的部分完成。",
      ],
      [
        "系统",
        "协作记录",
        "system",
        "每个人分别确认自己的交付。所有参与者完成后，由发起人汇总关闭本轮协作。",
      ],
    ],
  },
];
function showStage(index) {
  const stage = stages[index];
  document.querySelector("#task-state").textContent = stage.state;
  document.querySelector("#preview-text").textContent = stage.preview;
  const target = document.querySelector("#demo-messages");
  target.replaceChildren();
  for (const [name, role, kind, body] of stage.messages) {
    const item = document.createElement("div");
    item.className = "message " + kind;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      kind === "agent" ? "✧" : kind === "system" ? "✓" : name[0];
    const content = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = name + " · " + role;
    const text = document.createElement("p");
    text.textContent = body;
    content.append(meta, text);
    item.append(avatar, content);
    target.append(item);
  }
  document
    .querySelectorAll("[data-step]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.step) === index),
      ),
    );
}
document
  .querySelectorAll("[data-step]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      showStage(Number(button.dataset.step)),
    ),
  );
showStage(0);
document.querySelector("#copy").addEventListener("click", async () => {
  const button = document.querySelector("#copy");
  try {
    await navigator.clipboard.writeText(
      "git clone https://github.com/xautzh/mesho.git\ncd mesho",
    );
    button.textContent = "已复制";
    document.querySelector("#copy-status").textContent = "克隆命令已复制";
  } catch {
    button.textContent = "请手动复制";
    document.querySelector("#copy-status").textContent =
      "浏览器未允许剪贴板访问，请选择命令手动复制";
  }
});
