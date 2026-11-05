import type { ElectronApplication } from "@playwright/test";
// Mesho intentionally hides on BrowserWindow.close(). Quit the application,
// not just its window, so the tray and local execution engine stop cleanly.
export async function quit(app: ElectronApplication) {
  // Playwright also disconnects its Node inspector, allowing Electron to exit.
  await app.close();
}
