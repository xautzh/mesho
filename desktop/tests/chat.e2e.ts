import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { quit } from "./helpers";

test("three clients: human DM, group mentions, receiver-owned agent handling, reply, drafts and offline history", async () => {
  test.setTimeout(150000);
  const dir = mkdtempSync(join(tmpdir(), "mesho-group-e2e-"));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const invite = "mesho-group-test-invite";
  const server = spawn(
    process.env.MESHO_SERVER_BINARY || resolve("../server/mesho-server.exe"),
    ["--listen", `127.0.0.1:${port}`, "--db", join(dir, "server.db")],
    { env: { ...process.env, MESHO_INVITE: invite }, windowsHide: true },
  );
  const apps: ElectronApplication[] = [];
  const errors: string[] = [];
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
    async function launch(id: string, name: string, setup = true) {
      const app = await electron.launch({
        args: process.env.MESHO_DESKTOP_BINARY ? [] : [resolve(".")],
        executablePath: process.env.MESHO_DESKTOP_BINARY,
        env: { ...process.env, MESHO_DATA_DIR: join(dir, id) },
      });
      apps.push(app);
      const page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      if (setup) {
        await page.getByLabel("服务地址").fill(base);
        await page.getByLabel("团队邀请码", { exact: true }).fill(invite);
        await page.getByLabel("唯一用户 ID").fill(id);
        await page.getByLabel("显示姓名", { exact: true }).fill(name);
        await page
          .getByLabel("职责描述")
          .fill(
            id === "alice"
              ? "产品与研发协作"
              : id === "bob"
                ? "后端开发与问题修复"
                : "质量保障与接口验证",
          );
        await page.getByRole("button", { name: "连接团队" }).click();
        await expect(page.locator(".conversation-sidebar")).toBeVisible();
      }
      return { app, page };
    }
    const alice = await launch("alice", "林晓 · 产品");
    const bob = await launch("bob", "陈宇 · 开发");
    const carol = await launch("carol", "苏然 · 测试");
    await alice.page.locator("[data-tab=peers]").click();
    await expect(alice.page.locator("[data-peer=bob]")).toBeVisible({
      timeout: 15000,
    });
    await alice.page.locator("[data-peer=bob]").click();
    await expect(alice.page.locator("#chat-input")).toBeVisible();
    await alice.page
      .getByLabel("聊天消息")
      .fill("你好，今天一起看一下发布计划。<script>alert(1)</script>");
    await alice.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await expect(bob.page.locator(".conversation-row")).toContainText(
      "今天一起",
      { timeout: 15000 },
    );
    await bob.page.locator(".conversation-row").click();
    await expect(bob.page.locator(".bubble-text")).toContainText(
      "<script>alert(1)</script>",
    );
    await expect(alice.page.locator(".delivery").first()).toContainText("已读", {timeout:15000});
    await bob.page.getByLabel("聊天消息").fill("收到，接口已经准备好了。");
    await bob.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await expect(alice.page.locator(".bubble-text").last()).toHaveText(
      "收到，接口已经准备好了。",
      { timeout: 15000 },
    );
    await alice.page.locator("#new-conversation").click();
    await alice.page.getByLabel("群聊名称").fill("Mesho · 产品研发协作");
    await alice.page.locator("input[name=members][value=bob]").check();
    await alice.page.locator("input[name=members][value=carol]").check();
    await alice.page
      .getByRole("button", { name: "创建聊天", exact: true })
      .click();
    await expect(alice.page.locator(".chat-heading")).toContainText(
      "产品研发协作",
    );
    await alice.page.getByLabel("聊天消息").fill("@");
    await alice.page.locator("[data-mention=bob]").click();
    await expect(alice.page.getByLabel("聊天消息")).toHaveValue("@bob ");
    await alice.page
      .getByLabel("聊天消息")
      .fill("@bob 麻烦确认登录接口，@carol 下午一起回归。");
    await alice.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await expect(bob.page.locator(".mention-alert")).toBeVisible({
      timeout: 15000,
    });
    await bob.page
      .locator(".conversation-row")
      .filter({ hasText: "产品研发协作" })
      .click();
    await expect(bob.page.locator(".mention")).toHaveCount(2);
    await expect(carol.page.locator(".conversation-row")).toContainText(
      "产品研发协作",
      { timeout: 15000 },
    );
    for (const p of [alice.page, bob.page, carol.page]) {
      const state = await p.evaluate(() => window.mesho.snapshot());
      expect(state.tasks).toHaveLength(0);
    }
    // Draft remains intact while another member sends a message and refreshes the view.
    await bob.page.getByLabel("聊天消息").fill("这是一条未发送的草稿");
    await alice.page
      .getByLabel("聊天消息")
      .fill("大家在这个群同步进展，Agent 的处理结果也会回来。");
    await alice.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await expect(bob.page.locator(".bubble-text").last()).toContainText(
      "同步进展",
      { timeout: 15000 },
    );
    await expect(bob.page.getByLabel("聊天消息")).toHaveValue(
      "这是一条未发送的草稿",
    );
    for (const p of [alice.page, bob.page]) {
      const project = join(
        dir,
        p === alice.page ? "alice-project" : "bob-project",
      );
      mkdirSync(project);
      await p.locator("[data-tab=settings]").click();
      await p.getByLabel("本机目录", {exact:true}).fill(project);
      if (p === bob.page) { await p.getByLabel("处理方式", {exact:true}).selectOption("approval"); await p.getByLabel("Agent 回复方式").selectOption("draft"); }
      await p
        .getByLabel("Codex 可执行文件或安装路径")
        .fill(resolve("tests/fake-codex.js"));
      await p.getByRole("button", { name: "保存设置" }).click();
      await expect(p.locator("#toast")).toContainText("本地设置已保存");
      await p.locator("[data-tab=chat]").first().click();
    }
    await expect(alice.page.locator("#mention-button, #chat-agent, #chat-project")).toHaveCount(0);
    await alice.page
      .getByLabel("聊天消息")
      .fill("@bob 检查登录接口的参数校验，并回告验证结果。");
    await alice.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await expect(bob.page.locator("[data-chat-task]")).toBeVisible({
      timeout: 15000,
    });
    await expect(alice.page.locator(".remote-activity").last()).toContainText("等待对方确认执行", {timeout:15000});
    await bob.page.locator("[data-chat-task]").click();
    await bob.page.getByRole("button", { name: "接受并执行" }).click();
    await expect(bob.page.locator(".task-detail .badge")).toHaveText("已完成", {
      timeout: 20000,
    });
    await expect(alice.page.locator(".agent-message")).toHaveCount(0);
    await expect(alice.page.locator(".remote-activity").last()).toContainText("等待对方确认回复", {timeout:15000});
    await bob.page.getByRole("button", {name:"发送 Agent 回复", exact:true}).click();
    await bob.page.locator("[data-tab=chat]").first().click();
    await expect(alice.page.locator(".agent-message")).toContainText(
      "模拟执行器",
      { timeout: 15000 },
    );
    await carol.page
      .locator(".conversation-row")
      .filter({ hasText: "产品研发协作" })
      .click();
    await expect(carol.page.locator(".agent-message")).toContainText(
      "模拟执行器",
      { timeout: 15000 },
    );
    await expect(alice.page.locator(".agent-message table")).toHaveCount(1);
    await expect(alice.page.locator(".agent-message strong")).toContainText("验证结果");
    await expect(alice.page.locator(".agent-message pre code")).toContainText("安全代码块");
    expect(await alice.page.evaluate(()=> (window as any).fixtureInjected)).toBeUndefined();
    await expect(alice.page.locator(".remote-activity").last()).toContainText("Agent 已回复", {timeout:15000});
    await alice.page.screenshot({
      path: "test-results/mesho-chat.png",
      fullPage: true,
    });
    await alice.page.setViewportSize({ width: 800, height: 700 });
    expect(
      await alice.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await alice.page.screenshot({
      path: "test-results/mesho-chat-narrow.png",
      fullPage: true,
    });
    await quit(carol.app);
    apps.splice(apps.indexOf(carol.app), 1);
    await alice.page
      .getByLabel("聊天消息")
      .fill("@carol 离线消息：明早继续验收。");
    await alice.page
      .locator("#chat-send")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    const carol2 = await launch("carol", "苏然 · 测试", false);
    await expect(carol2.page.locator(".conversation-row")).toContainText(
      "明早继续验收",
      { timeout: 15000 },
    );
    await carol2.page
      .locator(".conversation-row")
      .filter({ hasText: "产品研发协作" })
      .click();
    await expect(carol2.page.locator(".bubble-text").last()).toContainText(
      "明早继续验收",
    );
    expect(errors).toEqual([]);
  } finally {
    for (const app of apps) await quit(app).catch(() => app.process().kill());
    server.kill();
    console.log("Group E2E data:", dir);
  }
});
