import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { quit } from "./helpers";

test("two desktop clients: onboard, approve, execute, reply, verify, resume and offline delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesho-e2e-"));
  const projects = join(dir, "project");
  mkdirSync(projects);
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const invite = "integration-test-invitation";
  const server = spawn(
    process.env.MESHO_SERVER_BINARY || resolve("../server/mesho-server.exe"),
    ["--listen", `127.0.0.1:${port}`, "--db", join(dir, "server.db")],
    { env: { ...process.env, MESHO_INVITE: invite }, windowsHide: true },
  );
  let logs = "";
  server.stderr?.on("data", (v) => (logs += v));
  const apps: ElectronApplication[] = [];
  const errors: string[] = [];
  const base = `http://127.0.0.1:${port}`;
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
        { timeout: 20000, message: "server " + logs },
      )
      .toBe(200);
    async function launch(name: string) {
      const app = await electron.launch({
        args: process.env.MESHO_DESKTOP_BINARY ? [] : [resolve(".")],
        executablePath: process.env.MESHO_DESKTOP_BINARY,
        env: { ...process.env, MESHO_DATA_DIR: join(dir, name) },
        timeout: 30000,
      });
      apps.push(app);
      const page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      return { app, page };
    }
    async function onboard(page: Page, id: string, name: string) {
      await page.getByLabel("服务地址").fill(base);
      await page.getByLabel("团队邀请码", { exact: true }).fill(invite);
      await page.getByLabel("唯一用户 ID").fill(id);
      await page.getByLabel("显示姓名", { exact: true }).fill(name);
      await page.getByLabel("职责描述").fill("订单服务接口测试与开发");
      await page.getByRole("button", { name: "连接团队" }).click();
      await page.locator("[data-tab=settings]").click();
      await expect(
        page.getByRole("heading", { name: "本地设置" }),
      ).toBeVisible();
      await page.getByLabel("本机目录", {exact:true}).fill(projects);
      await page.evaluate(async (path) => { await window.mesho.configure({projects:{orders:path}}); }, projects);
      await page
        .getByLabel("Codex 可执行文件或安装路径")
        .fill(resolve("tests/fake-codex.js"));
      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(page.locator("#toast")).toContainText("本地设置已保存");
    }
    const alice = await launch("alice");
    await onboard(alice.page, "alice", "小张 · 测试");
    const bob = await launch("bob");
    await onboard(bob.page, "bob", "小王 · 开发");
    await alice.page.getByLabel("信任同事的用户 ID（逗号分隔）").fill("bob");
    await alice.page.getByRole("button", { name: "保存设置" }).click();
    await expect(alice.page.locator("#toast")).toContainText("本地设置已保存");
    await alice.page.evaluate(async () => {
      await window.mesho.configure({verifyResults:true, trustedPeers:["bob"]});
      await window.mesho.send({to:"bob",project:"orders",text:"订单接口传入空 ID 返回 500，请排查。<script>alert(1)</script>"});
    });
    await bob.page.locator("[data-tab=tasks]").click();
    await expect(
      bob.page.getByRole("button", { name: "接受并执行" }),
    ).toBeVisible({ timeout: 15000 });
    await bob.page.screenshot({
      path: "test-results/mesho-pending.png",
      fullPage: true,
    });
    await bob.page.getByRole("button", { name: "接受并执行" }).click();
    await expect(bob.page.locator(".task-detail .badge")).toHaveText("已完成", {
      timeout: 20000,
    });
    await alice.page.locator("[data-tab=tasks]").click();
    await expect(alice.page.locator(".task-detail .badge")).toHaveText(
      "已完成",
      { timeout: 20000 },
    );
    await expect(alice.page.locator(".task-detail")).toContainText(
      "本地复验".replace("本地复验", "LOCAL VERIFICATION"),
    );
    await alice.page.screenshot({
      path: "test-results/mesho-workspace.png",
      fullPage: true,
    });
    const firstCount = readFileSync(
      join(projects, "fixture-executions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n").length;
    expect(firstCount).toBe(2);
    await alice.page.waitForTimeout(6000);
    expect(
      readFileSync(join(projects, "fixture-executions.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    const state = await alice.page.evaluate(() => window.mesho.snapshot());
    const topic = state.messages.find((m: any) => m.kind === "request")!.topic;
    await alice.page.evaluate(
      (topic) =>
        window.mesho.send({
          to: "bob",
          project: "orders",
          topic,
          text: "同一话题继续检查边界条件。",
        }),
      topic,
    );
    await expect(bob.page.locator("[data-approve]")).toBeVisible({
      timeout: 15000,
    });
    await bob.page.locator("[data-approve]").click();
    await expect
      .poll(
        () =>
          readFileSync(join(projects, "fixture-executions.jsonl"), "utf8")
            .trim()
            .split("\n").length,
        { timeout: 20000 },
      )
      .toBe(4);
    const records = readFileSync(
      join(projects, "fixture-executions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(records[2].args).toContain("resume");
    expect(records.every((r: any) => !r.restricted)).toBeTruthy();
    await alice.page.setViewportSize({ width: 800, height: 700 });
    await alice.page.screenshot({
      path: "test-results/mesho-narrow.png",
      fullPage: true,
    });
    expect(
      await alice.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await quit(bob.app);
    apps.splice(apps.indexOf(bob.app), 1);
    await alice.page.evaluate(() =>
      window.mesho.send({
        to: "bob",
        project: "orders",
        text: "离线投递验证：重新上线后应收到。",
      }),
    );
    await alice.page.waitForTimeout(3500);
    const bob2 = await launch("bob");
    await bob2.page.locator("[data-tab=tasks]").click();
    await expect(
      bob2.page
        .getByText("离线投递验证：重新上线后应收到。", { exact: false })
        .first(),
    ).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    for (const app of apps)
      await quit(app).catch(() => {
        app.process().kill();
      });
    server.kill();
    console.log("E2E data:", dir);
  }
});
