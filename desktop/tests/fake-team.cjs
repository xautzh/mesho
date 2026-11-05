// Test-only fixture for several independently authorized collaborators.
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  try {
    const args = process.argv.slice(2),
      resume = args.indexOf("resume"),
      sid = resume >= 0 ? args[resume + 1] : "team-" + Date.now();
    fs.appendFileSync(
      "team-executions.jsonl",
      JSON.stringify({ args, input }) + "\n",
    );
    console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
    let text = "CANSWER：测试验证通过。";
    if (
      input.includes("第二项协作：验证只读阻塞") &&
      process.env.MESHO_COLLAB_URL
    ) {
      const r = await fetch(process.env.MESHO_COLLAB_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.MESHO_COLLAB_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "blocked",
          text: "当前执行环境只读，无法写入文件；尚未完成开发。",
        }),
      });
      if (!r.ok) throw Error(await r.text());
      console.log(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "没有修改文件或完成开发" },
        }),
      );
      console.log(JSON.stringify({ type: "turn.completed" }));
      return;
    }

    if (
      process.env.MESHO_COLLAB_URL &&
      /来自 Mesho 联系人 alice 的消息/.test(input)
    ) {
      if (resume < 0) {
        const match = input.match(
          /本轮接口信息在本机文件 ("(?:[^"\\]|\\.)*") 中/,
        );
        if (!match) throw Error("No connection file");
        const c = JSON.parse(fs.readFileSync(JSON.parse(match[1]), "utf8"));
        const r = await fetch(c.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + c.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "ask",
            to: ["bob", "carol"],
            text: "请后端提供接口说明，测试提供验收结果。",
          }),
        });
        if (!r.ok) throw Error(await r.text());
        text = "已询问后端和测试，等待全部答复。";
      } else {
        if (!input.includes("BANSWER") || !input.includes("CANSWER"))
          throw Error("Missing one participant answer");
        text = "本人前端交付完成，已结合后端 BANSWER 与测试 CANSWER 验证。";
      }
    }
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text },
      }),
    );
    console.log(JSON.stringify({ type: "turn.completed" }));
  } catch (e) {
    console.error("Error: " + e.message);
    process.exitCode = 1;
  }
});
