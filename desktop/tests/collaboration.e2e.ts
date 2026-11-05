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

test("goal → CLI asks → human/agent answers → same session resumes → human accepts; restart preserves waiting", async () => {
  test.setTimeout(180000);
  const dir = mkdtempSync(join(tmpdir(), "mesho-collab-"));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const base = `http://127.0.0.1:${port}`,
    invite = "collaboration-test-invite";
  const server = spawn(
    process.env.MESHO_SERVER_BINARY ||
      resolve("../server/mesho-server-0.5.exe"),
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
    async function launch(id: string, setup = true) {
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
        await page
          .getByLabel("显示姓名", { exact: true })
          .fill(id === "alice" ? "林晓" : "小王");
        await page.getByLabel("职责描述").fill("协作测试");
        await page.getByRole("button", { name: "连接团队" }).click();
        await expect(page.locator(".conversation-sidebar")).toBeVisible();
        const project = join(dir, id + "-project");
        mkdirSync(project);
        await page.locator("[data-tab=settings]").click();
        await page.getByLabel("本机目录", { exact: true }).fill(project);
        await page
          .getByLabel("Codex 可执行文件或安装路径")
          .fill(resolve("tests/fake-collaboration.cjs"));
        await page.getByRole("button", { name: "保存设置" }).click();
        await expect(page.locator("#toast")).toContainText("本地设置已保存");
        await page.locator("[data-tab=chat]").first().click();
      }
      return { app, page };
    }
    let alice = await launch("alice");
    const bob = await launch("bob");
    await alice.page.locator("[data-tab=peers]").click();
    await expect(alice.page.locator("[data-peer=bob]")).toBeVisible({
      timeout: 15000,
    });
    await alice.page.locator("[data-peer=bob]").click();
    async function start(page: Page, goal: string) {
      await expect(
        page.getByRole("button", { name: "发起协作", exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.mesho.snapshot())).conversations
              .length,
        )
        .toBeGreaterThan(0);
      await page.evaluate(async (goal) => {
        const s = await window.mesho.snapshot();
        await window.mesho.collaborationStart(
          s.conversations[0].id,
          goal,
          true,
        );
      }, goal);
    }
    await start(alice.page, "完成注册联调，验证必填字段");
    await expect(alice.page.locator(".collaboration-panel")).toContainText(
      "等待同事答复",
      { timeout: 20000 },
    );
    await expect(bob.page.locator(".conversation-row")).toBeVisible({
      timeout: 15000,
    });
    await bob.page.locator(".conversation-row").click();
    await expect(
      bob.page.getByRole("button", { name: "我来回答" }),
    ).toBeVisible();
    expect(
      (await bob.page.evaluate(() => window.mesho.snapshot())).tasks,
    ).toHaveLength(0);
    await quit(alice.app);
    apps.splice(apps.indexOf(alice.app), 1);
    alice = await launch("alice", false);
    await expect(alice.page.locator(".conversation-row")).toBeVisible();
    await alice.page.locator(".conversation-row").click();
    await expect(alice.page.locator(".collaboration-panel")).toContainText(
      "等待同事答复",
    );
    await bob.page.getByRole("button", { name: "我来回答" }).click();
    await bob.page.getByLabel("聊天消息").fill("必填字段是 customerId");
    await bob.page.locator("#chat-send button[type=submit]").click();
    await expect(alice.page.locator(".collaboration-panel")).toContainText(
      "等待你验收",
      { timeout: 20000 },
    );
    await alice.page.getByRole("button", { name: "验收完成" }).click();
    await expect(alice.page.locator(".collaboration-panel")).toContainText(
      "已验收",
    );
    const executions = readFileSync(
      join(dir, "alice-project", "collaboration-executions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(executions).toHaveLength(2);
    expect(executions[1].args).toContain("resume");
    expect(executions[1].input).toContain("customerId");
    await bob.page.locator("[data-tab=settings]").click();
    await bob.page.getByLabel("处理方式", { exact: true }).selectOption("auto");
    await bob.page.getByLabel("Agent 回复方式").selectOption("auto");
    await bob.page.locator("[name=trustedPeers]").fill("alice");
    await bob.page.getByRole("button", { name: "保存设置" }).click();
    await expect(bob.page.locator("#toast")).toContainText("本地设置已保存");
    await bob.page.locator("[data-tab=chat]").first().click();
    await start(alice.page, "再次联调，由同事按本地配置交给 Agent 回答");
    await expect(
      alice.page.locator(".collaboration-row").first(),
    ).toContainText("等待你验收", { timeout: 30000 });
    await expect(bob.page.locator(".mine.agent-message").last()).toContainText(
      "customerId",
    );
    const local = await alice.page.evaluate(() => window.mesho.snapshot());
    expect(local.collaborations).toHaveLength(2);
    expect(local.tasks.filter((t) => t.state === "completed")).toHaveLength(2);
    await alice.page.screenshot({
      path: "test-results/mesho-collaboration.png",
    });
    await alice.page.setViewportSize({ width: 800, height: 700 });
    expect(
      await alice.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await alice.page.screenshot({
      path: "test-results/mesho-collaboration-narrow.png",
    });
    expect(errors).toEqual([]);
  } finally {
    for (const app of apps) await quit(app).catch(() => app.process().kill());
    server.kill();
    console.log("Collaboration test data:", dir);
  }
});
