import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { quit } from "./helpers";

test("four people own their scopes, duplicate roles, parallel requests, revisions and joint closure", async () => {
  test.setTimeout(240000);
  const dir = mkdtempSync(join(tmpdir(), "mesho-team-"));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const base = `http://127.0.0.1:${port}`,
    invite = "mesho-team-test-invite";
  const server = spawn(
    process.env.MESHO_SERVER_BINARY ||
      resolve("../server/mesho-server-0.6.exe"),
    ["--listen", `127.0.0.1:${port}`, "--db", join(dir, "server.db")],
    { env: { ...process.env, MESHO_INVITE: invite }, windowsHide: true },
  );
  const apps: ElectronApplication[] = [],
    errors: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(base + "/health")).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20000 },
      )
      .toBe(200);
    async function launch(id: string) {
      const app = await electron.launch({
        args: process.env.MESHO_DESKTOP_BINARY ? [] : [resolve(".")],
        executablePath: process.env.MESHO_DESKTOP_BINARY,
        env: { ...process.env, MESHO_DATA_DIR: join(dir, id) },
      });
      apps.push(app);
      const p = await app.firstWindow();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.getByLabel("服务地址").fill(base);
      await p.getByLabel("团队邀请码", { exact: true }).fill(invite);
      await p.getByLabel("唯一用户 ID").fill(id);
      await p.getByLabel("显示姓名", { exact: true }).fill(id);
      await p.getByRole("button", { name: "连接团队" }).click();
      await expect(p.locator(".conversation-sidebar")).toBeVisible();
      const work = join(dir, id + "-work");
      mkdirSync(work);
      await p.locator("[data-tab=settings]").click();
      await p.getByLabel("本机目录", { exact: true }).fill(work);
      await p
        .getByLabel("Codex 可执行文件或安装路径")
        .fill(resolve("tests/fake-team.cjs"));
      await p.getByLabel("处理方式", { exact: true }).selectOption("auto");
      await p.getByLabel("Agent 回复方式").selectOption("auto");
      await p.locator("[name=trustedPeers]").fill("alice,bob,carol,dave");
      await p.getByRole("button", { name: "保存设置" }).click();
      await expect(p.locator("#toast")).toContainText("本地设置已保存");
      await p.locator("[data-tab=chat]").first().click();
      return p;
    }
    const alice = await launch("alice"),
      bob = await launch("bob"),
      carol = await launch("carol"),
      dave = await launch("dave");
    const pages = [alice, bob, carol, dave];
    await alice.locator("[data-tab=peers]").click();
    await expect(alice.locator("[data-peer=dave]")).toBeVisible({
      timeout: 15000,
    });
    await alice.locator("[data-tab=chat]").first().click();
    await alice.locator("#new-conversation").click();
    await alice.getByLabel("群聊名称").fill("多角色交叉协作");
    for (const id of ["bob", "carol", "dave"])
      await alice.locator(`input[name=members][value=${id}]`).check();
    await alice.getByRole("button", { name: "创建聊天", exact: true }).click();
    await alice.getByRole("button", { name: "发起协作", exact: true }).click();
    await alice
      .getByLabel("共同目标与验收提案")
      .fill("共同交付注册功能，接口、页面与测试均通过");
    await alice
      .getByRole("button", { name: "发布协作提案", exact: true })
      .click();
    for (const p of [bob, carol, dave]) {
      await expect(p.locator(".conversation-row")).toBeVisible({
        timeout: 15000,
      });
      await p.locator(".conversation-row").click();
      await expect(p.locator(".team-panel")).toContainText("待确认分工");
    }
    for (const p of pages)
      expect(
        (await p.evaluate(() => window.mesho.snapshot())).tasks,
      ).toHaveLength(0);
    async function openDetails(p: Page) {
      if (!(await p.locator(".team-drawer").count()))
        await p.getByRole("button", { name: "查看协作", exact: true }).click();
    }
    async function closeDetails(p: Page) {
      if (await p.locator(".team-drawer").count())
        await p.getByRole("button", { name: "关闭协作详情" }).click();
    }
    async function commit(p: Page, role: string, mode: string) {
      await openDetails(p);
      await p
        .locator(".team-actions")
        .getByRole("button", { name: "确认我的分工", exact: true })
        .click();
      await p.getByLabel("我的角色", { exact: true }).fill(role);
      await p.getByLabel("我负责的范围").fill(role + "：只处理本人模块");
      await p.getByLabel("我的验收标准").fill(role + "单元测试通过");
      await p.getByLabel("我的参与方式").selectOption(mode);
      if (mode === "agent") await p.locator("[name=autoResume]").check();
      await p
        .locator("#team-form")
        .getByRole("button", { name: "确认我的分工", exact: true })
        .click();
      await expect(p.locator("#team-form")).toHaveCount(0);
    }
    await commit(bob, "后端", "human");
    await commit(dave, "后端", "human");
    await commit(carol, "测试", "agent");
    expect(
      (await carol.evaluate(() => window.mesho.snapshot())).tasks[0].state,
    ).toBe("pending");
    await carol
      .getByRole("button", { name: "开始我的任务", exact: true })
      .click();
    await closeDetails(carol);
    await openDetails(alice);
    await expect(alice.locator(".team-members .team-member")).toHaveCount(3, {
      timeout: 15000,
    });
    await commit(alice, "前端", "agent");
    expect(
      (await alice.evaluate(() => window.mesho.snapshot())).tasks[0].state,
    ).toBe("pending");
    await alice
      .getByRole("button", { name: "开始我的任务", exact: true })
      .click();
    await expect(
      alice.locator(".team-member").filter({ hasText: "alice · 前端" }),
    ).toContainText("等待协作答复", { timeout: 25000 });
    await closeDetails(alice);
    await closeDetails(bob);
    await expect(bob.getByRole("button", { name: "我来回答" })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      alice.locator(".agent-message").filter({ hasText: "CANSWER" }).last(),
    ).toBeVisible({ timeout: 25000 });
    expect(
      (await alice.evaluate(() => window.mesho.snapshot())).tasks.find(
        (t) => t.peer === "alice",
      )?.state,
    ).toBe("waiting");
    await bob.getByRole("button", { name: "我来回答" }).click();
    await bob
      .getByLabel("聊天消息")
      .fill("BANSWER：接口字段 customerId 已准备");
    await bob.locator("#chat-send button[type=submit]").click();
    await openDetails(alice);
    await expect(
      alice.locator(".team-member").filter({ hasText: "alice · 前端" }),
    ).toContainText("待核对结果", { timeout: 25000 });
    await expect(alice.locator(".team-events")).toContainText(
      "本人前端交付完成",
    );
    const logs = readFileSync(
      join(dir, "alice-work", "team-executions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logs).toHaveLength(2);
    expect(logs[1].args).toContain("resume");
    expect(logs[1].input).toContain("BANSWER");
    expect(logs[1].input).toContain("CANSWER");
    await expect(
      alice.getByRole("button", { name: "汇总关闭协作" }),
    ).toBeDisabled();
    await alice.screenshot({ path: "test-results/mesho-team-details.png" });
    await closeDetails(alice);
    expect(
      await alice
        .locator(".team-panel")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(60);
    await alice.screenshot({ path: "test-results/mesho-team.png" });
    await alice.setViewportSize({ width: 800, height: 700 });
    expect(
      await alice.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await alice.screenshot({ path: "test-results/mesho-team-narrow.png" });
    await alice.setViewportSize({ width: 1280, height: 850 });
    // A colleague can propose a changed objective, but nobody inherits it as execution authority.
    await openDetails(bob);
    await bob.getByRole("button", { name: "补充共同目标" }).click();
    await bob
      .getByLabel("共同目标与验收提案")
      .fill("共同交付注册功能，补充兼容性验收");
    await bob.getByRole("button", { name: "提交共同目标提案" }).click();
    for (const p of pages) {
      await openDetails(p);
      await expect(
        p.locator(".team-member").filter({ hasText: "待重新确认" }),
      ).toHaveCount(4, { timeout: 15000 });
    }
    for (const [p, role] of [
      [alice, "前端"],
      [bob, "后端"],
      [carol, "测试"],
      [dave, "后端"],
    ] as [Page, string][]) {
      await commit(p, role, "human");
      await p
        .getByRole("button", { name: "确认我的完成", exact: true })
        .click();
      await p
        .getByLabel("交付结果与验收证据")
        .fill(role + "验收完成，提供测试证据");
      await p.getByRole("button", { name: "发布本人完成结果" }).click();
    }
    await expect(
      alice.getByRole("button", { name: "汇总关闭协作" }),
    ).toBeEnabled({ timeout: 15000 });
    await alice.getByRole("button", { name: "汇总关闭协作" }).click();
    for (const p of pages)
      await expect(p.locator(".team-stage")).toContainText("已共同完成", {
        timeout: 15000,
      });
    const first = (await alice.evaluate(() => window.mesho.snapshot()))
      .teamGoals[0].id;
    await closeDetails(alice);
    await alice.getByRole("button", { name: "发起协作", exact: true }).click();
    await alice
      .getByLabel("共同目标与验收提案")
      .fill("第二项协作：验证只读阻塞");
    await alice
      .getByRole("button", { name: "发布协作提案", exact: true })
      .click();
    const second = (
      await alice.evaluate(() => window.mesho.snapshot())
    ).teamGoals.find((g) => g.id !== first)!.id;
    await alice.getByLabel("选择协作任务").selectOption(second);
    await commit(alice, "后端", "agent");
    await alice
      .getByRole("button", { name: "开始我的任务", exact: true })
      .click();
    await expect(alice.locator(".team-member")).toContainText("任务阻塞", {
      timeout: 20000,
    });
    await expect(alice.locator(".team-events")).toContainText("无法写入文件");
    await expect(alice.locator(".team-events")).not.toContainText("BANSWER");
    await expect(
      alice.getByRole("button", { name: "确认我的完成", exact: true }),
    ).toHaveCount(0);
    await closeDetails(alice);
    await expect(alice.locator("#team-select option")).toHaveCount(2);
    expect(
      await alice
        .locator(".team-panel")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(60);
    await alice.screenshot({ path: "test-results/mesho-multiple-tasks.png" });
    await alice.getByLabel("选择协作任务").selectOption(first);
    await openDetails(alice);
    await expect(alice.locator(".team-events")).toContainText("BANSWER");
    await expect(alice.locator(".team-events")).not.toContainText(
      "无法写入文件",
    );
    expect(errors).toEqual([]);
  } finally {
    for (const app of apps) await quit(app).catch(() => app.process().kill());
    server.kill();
    console.log("Team E2E data:", dir);
  }
});
