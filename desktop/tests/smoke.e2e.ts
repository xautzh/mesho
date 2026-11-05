import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {quit} from './helpers';
test("onboarding renders in an isolated real Electron window", async () => {
  const app = await electron.launch({
    args: process.env.MESHO_DESKTOP_BINARY ? [] : [resolve(".")],
    executablePath: process.env.MESHO_DESKTOP_BINARY,
    env: {
      ...process.env,
      MESHO_DATA_DIR: mkdtempSync(join(tmpdir(), "mesho-smoke-")),
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "让协作，接着发生。" }),
    ).toBeVisible();
    await expect(page.getByLabel("服务地址")).toBeVisible();
    await page.screenshot({
      path: "test-results/mesho-onboarding.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await quit(app);
  }
});
