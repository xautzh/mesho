import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Menu,
  Tray,
  nativeImage,
} from "electron";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store";
import { Engine } from "./engine";
import { runCodex } from "./runner";

app.setName("Mesho");
app.setPath(
  "userData",
  process.env.MESHO_DATA_DIR || join(app.getPath("appData"), "Mesho"),
);
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
}
let win: BrowserWindow;
let engine: Engine;
let store: Store;
let quitting = false;
let tray: Tray;
let bridgePath = "";
let bridge: ReturnType<typeof createServer>;
function openWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 780,
    minHeight: 620,
    title: "Mesho",
    backgroundColor: "#fafbfc",
    icon: join(__dirname, "../assets/icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_w, _p, callback) =>
    callback(false),
  );
  void win.loadFile(join(__dirname, "../dist/index.html"));
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}
function expose(name: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args) => {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("Untrusted frame");
    return handler(...args);
  });
}
if (locked)
  void app
    .whenReady()
    .then(async () => {
      const dir = app.getPath("userData");
      mkdirSync(dir, { recursive: true });
      const seal = (s: string) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统凭证加密不可用，不能保存登录凭证");
        return safeStorage.encryptString(s).toString("base64");
      };
      const unseal = (s: string) =>
        safeStorage.decryptString(Buffer.from(s, "base64"));
      store = new Store(join(dir, "mesho.db"), seal, unseal);
      engine = new Engine(store, runCodex);
      expose("snapshot", () => ({ ...engine.snapshot(), bridgePath }));
      expose("setup", (c, i, t) => engine.setup(c, i, t));
      expose("configure", (c) => engine.configure(c));
      expose("send", (m) => engine.send(m));
      expose("openExternal", async (value) => {
        const url = new URL(String(value));
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("只允许打开 HTTP(S) 链接");
        await shell.openExternal(url.href);
      });
      expose("teamPropose", (conversation, text) =>
        engine.team.propose(conversation, text),
      );
      expose("teamAmend", (goal, revision, text) =>
        engine.team.amend(goal, revision, text),
      );
      expose("teamDetails", (goal) => engine.team.get(goal, true));
      expose("teamCommit", (goal, revision, scope, auto) => {
        const id = engine.team.commit(goal, revision, scope, auto);
        void engine.pump();
        return id;
      });
      expose("teamDecision", (goal, action, text) => {
        const result = engine.team.decision(goal, action, text);
        void engine.pump();
        return result;
      });
      expose("collaborationStart", (conversation, goal, auto) => {
        const id = engine.collaboration.start(conversation, goal, auto);
        void engine.pump();
        return id;
      });
      expose("collaborationDecide", (id, action, feedback) => {
        engine.collaboration.decide(id, action, feedback);
        void engine.pump();
      });
      expose("chatAnswer", (id, text) => engine.chat.answer(id, text));
      expose("chatCreate", (c) => engine.chat.create(c));
      expose("chatSend", (m) => engine.chat.send(m));
      expose("chatHistory", (id, before) => engine.chat.history(id, before));
      expose("chatRead", (id, seq) => engine.chat.read(id, seq));
      expose("chatDelegate", (id) => {
        const task = engine.chat.delegate(id);
        void engine.pump();
        return task;
      });
      expose("chatPublish", (id) => engine.chat.publish(id));
      expose("chatRetry", (id) => engine.chat.retry(id));
      expose("approve", (id) => {
        engine.approve(id);
        void engine.pump();
      });
      expose("reject", (id) => engine.reject(id));
      expose("stop", (id) => engine.stopTask(id));
      expose("pause", (v) => engine.pause(!!v));
      expose("sync", () => engine.sync());
      expose("pickDirectory", async () => {
        const r = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
        });
        return r.canceled ? "" : r.filePaths[0];
      });
      const secret = randomBytes(32).toString("hex");
      bridge = createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const supplied = Buffer.from(req.headers.authorization || "");
        const expected = Buffer.from("Bearer " + secret);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          res.writeHead(401).end('{"error":"Unauthorized"}');
          return;
        }
        try {
          if (req.method === "GET" && req.url === "/peers") {
            res.end(JSON.stringify(engine.peers));
            return;
          }
          if (req.method === "GET" && req.url === "/status") {
            const s = engine.snapshot();
            res.end(
              JSON.stringify({
                connected: s.connected,
                tasks: s.tasks,
                error: s.error,
              }),
            );
            return;
          }
          if (req.method === "POST" && req.url === "/send") {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (Buffer.byteLength(body) > 65536)
                throw new Error("Message too large");
            }
            const message = engine.send(JSON.parse(body));
            res.end(JSON.stringify(message));
            return;
          }
          res.writeHead(404).end("{}");
        } catch (e) {
          res.writeHead(400).end(JSON.stringify({ error: String(e) }));
        }
      });
      bridge.headersTimeout = 5000;
      bridge.requestTimeout = 10000;
      await new Promise<void>((resolve) =>
        bridge.listen(0, "127.0.0.1", resolve),
      );
      const address = bridge.address();
      bridgePath = join(dir, "bridge.local.json");
      writeFileSync(
        bridgePath,
        JSON.stringify({
          port: typeof address === "object" && address ? address.port : 0,
          token: secret,
        }),
        { mode: 0o600 },
      );
      const icon = nativeImage
        .createFromPath(join(__dirname, "../assets/icon.png"))
        .resize({ width: 32, height: 32 });
      tray = new Tray(icon);
      tray.setToolTip("Mesho · Agent collaboration");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 Mesho", click: openWindow },
          { label: "暂停执行", click: () => engine.pause(true) },
          { label: "退出 Mesho", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", openWindow);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Mesho",
            submenu: [
              { label: "打开窗口", click: openWindow },
              { label: "退出", click: () => app.quit() },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "视图",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
        ]),
      );
      openWindow();
      engine.start();
    })
    .catch((e) => {
      dialog.showErrorBox("Mesho 启动失败", String(e));
      app.exit(1);
    });
app.on("second-instance", openWindow);
app.on("activate", () => {
  if (engine) openWindow();
});
app.on("window-all-closed", () => {});
app.on("before-quit", (e) => {
  if (!quitting && engine) {
    e.preventDefault();
    quitting = true;
    void engine
      .stop()
      .then(() => {
        bridge?.close();
        try {
          unlinkSync(bridgePath);
        } catch {}
        store.close();
      })
      .catch((error) => console.error("Mesho shutdown:", String(error)))
      .finally(() => app.exit(0));
  }
});
