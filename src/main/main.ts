import * as path from "node:path";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  shell,
} from "electron";
import { configPath } from "../core/config";
import { startControlServer } from "../core/control";
import { Engine } from "../core/engine";
import type { ActiveBreak } from "../core/scheduler";

const ROOT = path.join(__dirname, "..", "..");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(boot);
}

let tray: Tray | null = null;
let breakWindows: BrowserWindow[] = [];
let currentBreak: ActiveBreak | null = null;
let lastPhase: string | null = null;

function boot(): void {
  if (process.platform === "darwin") app.dock?.hide();
  // Starting with the computer is part of being strict: quitting can't be a way out.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });

  const engine = new Engine({ idleSeconds: () => powerMonitor.getSystemIdleTime() });

  engine.on("break-start", (brk: ActiveBreak) => showBreak(brk));
  engine.on("break-end", () => hideBreak());
  engine.on("break-warning", ({ kind }: { kind: string }) => {
    new Notification({
      title: kind === "long" ? "Long break in 30 seconds" : "Eye break in 30 seconds",
      body: "Wrap up your sentence.",
      silent: true,
    }).show();
  });
  engine.on("status", (st: ReturnType<Engine["status"]>) => {
    if (st.phase === "deferred" && lastPhase !== "deferred") {
      new Notification({
        title: "Break is waiting for you",
        body: `It starts as soon as you're free (${st.reason}).`,
        silent: true,
      }).show();
    }
    lastPhase = st.phase;
    updateTray(engine);
  });

  let awaySince: number | null = null;
  const away = () => (awaySince ??= Date.now());
  const back = () => {
    if (awaySince !== null) engine.markAway(awaySince, Date.now());
    awaySince = null;
  };
  powerMonitor.on("suspend", away);
  powerMonitor.on("lock-screen", away);
  powerMonitor.on("resume", back);
  powerMonitor.on("unlock-screen", back);

  screen.on("display-added", () => currentBreak && showBreak(currentBreak));
  ipcMain.handle("break:current", () => currentBreak);

  app.on("before-quit", (e) => {
    if (currentBreak) e.preventDefault();
    else engine.stop();
  });
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });

  createTray(engine);
  void startControlServer(engine);
  engine.start();
}

function showBreak(brk: ActiveBreak): void {
  currentBreak = brk;
  const covered = new Set(breakWindows.filter((w) => !w.isDestroyed()).map((w) => w.getBounds().x + ":" + w.getBounds().y));
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.bounds;
    if (covered.has(`${x}:${y}`)) continue;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      show: false,
      fullscreen: process.platform !== "darwin",
      simpleFullscreen: process.platform === "darwin",
      kiosk: display.id === screen.getPrimaryDisplay().id,
      alwaysOnTop: true,
      skipTaskbar: true,
      closable: false,
      minimizable: false,
      maximizable: false,
      resizable: false,
      movable: false,
      backgroundColor: "#10221c",
      webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("close", (e) => {
      if (currentBreak) e.preventDefault();
    });
    // Losing focus (Cmd+Tab, Alt+Tab, a notification) pulls the break straight back.
    win.on("blur", () => {
      if (currentBreak && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.focus(), 50);
    });
    win.webContents.on("before-input-event", (e, input) => {
      if (input.meta || input.control || input.alt || input.key === "Escape" || input.key.startsWith("F")) e.preventDefault();
    });
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    void win.loadFile(path.join(ROOT, "src", "renderer", "break.html"));
    breakWindows.push(win);
  }
}

function hideBreak(): void {
  currentBreak = null;
  for (const win of breakWindows) if (!win.isDestroyed()) win.destroy();
  breakWindows = [];
}

const fmt = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function createTray(engine: Engine): void {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Go Away");
  updateTray(engine);
}

let lastMenuKey = "";
function updateTray(engine: Engine): void {
  if (!tray) return;
  const st = engine.status();
  const now = Date.now();
  const next = [st.nextMicroAt, st.nextLongAt].filter((t): t is number => t !== null);
  const nextIn = next.length ? fmt(Math.min(...next) - now) : "off";
  const title =
    st.phase === "on_break" ? "break" : st.phase === "deferred" ? "waiting" : st.phase === "holding" ? `focus` : nextIn;
  if (process.platform === "darwin") tray.setTitle(` ${title}`);
  tray.setToolTip(`Go Away: ${title}`);

  const lines = [
    st.phase === "deferred" ? `Break waiting: ${st.reason}` : null,
    st.phase === "holding" ? `Long break held: ${st.reason}` : null,
    st.nextMicroAt ? `Eye break in ${fmt(st.nextMicroAt - now)}` : "Eye breaks off",
    st.nextLongAt ? `Long break in ${fmt(st.nextLongAt - now)}` : "Long breaks off",
    st.meeting ? `In meeting: ${st.meeting.title}` : st.nextMeeting ? `Next meeting: ${st.nextMeeting.title} in ${fmt(st.nextMeeting.start.getTime() - now)}` : null,
    st.focus ? `Focus: ${st.focus.title} (${fmt(st.focus.end.getTime() - now)} left)` : null,
    st.calendarError ? `Calendar error: ${st.calendarError}` : null,
    st.pendingConfig ? "Settings change waiting for the next break" : null,
  ].filter((l): l is string => l !== null);

  const key = JSON.stringify([lines, st.phase]);
  if (key === lastMenuKey) return;
  lastMenuKey = key;

  const focus = (minutes: number) => () => {
    engine.startFocus(minutes);
    updateTray(engine);
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...lines.map((label) => ({ label, enabled: false })),
      { type: "separator" },
      { label: "Start focus: 25 min", click: focus(25) },
      { label: "Start focus: 50 min", click: focus(50) },
      { label: "Start focus: 90 min", click: focus(90) },
      { label: "End focus session", enabled: st.focus?.source === "manual", click: () => engine.endFocus() },
      { type: "separator" },
      { label: "Open settings file", click: () => void shell.openPath(configPath()) },
      {
        label: "Copy MCP server config",
        click: () =>
          clipboard.writeText(
            JSON.stringify(
              { mcpServers: { "go-away": { command: "node", args: [path.join(ROOT, "dist", "mcp", "server.js")] } } },
              null,
              2,
            ),
          ),
      },
      { type: "separator" },
      { label: "Quit", enabled: st.phase !== "on_break", click: () => app.quit() },
    ]),
  );
}
