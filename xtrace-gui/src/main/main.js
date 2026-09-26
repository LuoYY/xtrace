const {app, BrowserWindow, dialog, ipcMain} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const {
  DEFAULT_CHROMIUM_APP,
  DEFAULT_LOG_DIR,
  DEFAULT_ASSET_MAX_BYTES,
  startChromiumRun,
  readEventsSince,
  listTraceFiles
} = require("./xtraceProcess");
const {attachAssetContent, readAssetManifest} = require("./xtraceAssets");
const {generateReportForTrace} = require("./xtraceReport");
// P6-R1: the evidence surface over the HOST COMPOSITION ROOT. There
// is exactly one Broker (inside the host) — this file never constructs
// one, never stubs a workspace, and every side-effect entry (start/
// stop/cancel/clear) goes through host.callTool, i.e. through the
// Broker with confirmation + audit (B1). Read entries ride the
// read-evidence tier (granted rows). resolveConfirmation is called
// ONLY from the evidence:confirmation handler below (B2/R1.6-D1).
const {createHost} = require("../../../xtrace-host/src/host");
const {resolveOrphan} = require("../../../xtrace-host/src/host");
const {BASES} = require("../../../xtrace-host/src/broker");

function electronAppRoot() {
  // xtrace-gui/src/main/main.js -> repo root
  return path.resolve(__dirname, "..", "..", "..");
}

let evidenceHost = null;          // the composition root (or null)

function requireHost() {
  if (!evidenceHost || evidenceHost.closed) {
    throw new Error("no live host — open a workspace and start a capture first");
  }
  return evidenceHost;
}

// ---- read entries (Broker read tier: granted rows, no dialogs) ------
ipcMain.handle("evidence:open-workspace", async (_e, dir) => {
  if (evidenceHost && !evidenceHost.closed) {
    try { await evidenceHost.close(); } catch {}
  }
  // NOTE: the capture counter is NOT reset — every start gets a fresh
  // trace directory, so reopening a workspace can never overwrite a
  // prior capture's products.
  evidenceHost = await createHost({
    executable: CHROMIUM_X(),
    workspaceRoot: dir,
    skipBrowserLaunch: true,       // the browser launches on start
  });
  evidenceWorkspaceRoot = evidenceHost.workspace.root;
  return { root: evidenceHost.workspace.root,
           captures: evidenceHost.reindex().length };
});

ipcMain.handle("evidence:capture-status", (_e, captureId) =>
    requireHost().callTool("trace_summary",
        captureId ? { capture_id: captureId } : {}, { origin: "ui" }));

ipcMain.handle("evidence:auth-records", () =>
    requireHost().callTool("recall", { limit: 60 }, { origin: "ui" }));

ipcMain.handle("evidence:jump", (_e, ref) =>
    requireHost().callTool("evidence_jump", { ref }, { origin: "ui" }));

ipcMain.handle("evidence:capabilities", async () => {
  const caps = await requireHost().capabilities();
  return { enhanced: caps.enhanced,
           counts: {
             available: caps.tools.filter((t) => t.state === "available").length,
             degraded: caps.tools.filter((t) => t.state === "degraded").length,
             unavailable: caps.tools.filter((t) => t.state === "unavailable").length,
           },
           gaps: caps.tools.filter((t) => t.state !== "available")
               .map((t) => ({ name: t.name, state: t.state, reason: t.reason })) };
});

ipcMain.handle("evidence:pending", () => {
  const host = requireHost();
  return host.broker.pendingList();
});

// ---- THE confirmation handler (the ONLY resolveConfirmation caller) --
ipcMain.handle("evidence:confirmation", (_e, { id, approved }) => {
  const host = requireHost();
  return host.broker.resolveConfirmation(id, Boolean(approved));
});

// ---- side-effect entries: host.callTool ONLY (B1) --------------------
const CHROMIUM_X = () => path.join(electronAppRoot(), "chromium", "src",
    "out", "XTraceIntegration", "ChromiumX.app/Contents/MacOS/Chromium");

let evidenceStartCount = 0;
let evidenceWorkspaceRoot = null;

ipcMain.handle("evidence:start", async (_e, options = {}) => {
  const root = options.workspaceRoot || evidenceWorkspaceRoot;
  if (!root) {
    throw new Error("open a workspace first");
  }
  evidenceWorkspaceRoot = root;
  // one hosted browser at a time (a second launch on one profile hits
  // the ChromiumX singleton lock): retire any previous host first
  if (evidenceHost && !evidenceHost.closed) {
    try { await evidenceHost.close(); } catch {}
    evidenceHost = null;
  }
  evidenceStartCount += 1;
  const traceFile = options.traceFile ||
      path.join(root, "traces", `ui-capture-${evidenceStartCount}`,
                "trace.ndjson");
  const {createHost: relaunch} = require("../../../xtrace-host/src/host");
  const host = evidenceHost = await relaunch({
    executable: CHROMIUM_X(),
    workspaceRoot: root,
    traceFile,
    browserArgs: [options.targetUrl || "about:blank"],
  });
  // The START itself is a side effect: through the Broker. UI-origin
  // direct click IS the confirmation (R1.6-D1), recorded as such.
  const out = await host.callTool("jsvmp_trace",
      { action: "start", max_taps: options.maxTaps ?? 5 },
      { origin: "ui", reason: options.reason || "UI start capture",
        basisHint: BASES.UI_DIRECT_CLICK });
  return { state: out.state, captureId: out.captureId, traceFile };
});

ipcMain.handle("evidence:stop", (_e, options = {}) => {
  const host = requireHost();
  // UI direct click = the confirmation; reason comes from the panel's
  // editable control (renderer passes it), never a hardcoded string.
  return host.callTool("jsvmp_trace", { action: "stop" },
      { origin: "ui",
        reason: options.reason || "stop via evidence panel",
        basisHint: BASES.UI_DIRECT_CLICK });
});

ipcMain.handle("evidence:cancel", (_e, options = {}) => {
  const host = requireHost();
  // cancel is a SIDE EFFECT too: the Broker-registered cancel action.
  return host.callTool("jsvmp_trace", { action: "cancel" },
      { origin: "ui", reason: options.reason || "cancel via evidence panel",
        basisHint: BASES.UI_DIRECT_CLICK });
});

ipcMain.handle("evidence:clear", (_e, options = {}) =>
    requireHost().callTool("jsvmp_trace", { action: "clear" },
        { origin: "ui", reason: options.reason || "clear via panel",
          basisHint: BASES.UI_DIRECT_CLICK }));

// M7: a REAL directory picker — the E2E workspace hook stays only as a
// harness accelerator and is labeled as such in the renderer.
ipcMain.handle("evidence:choose-workspace", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose an XTrace evidence workspace",
  });
  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
});

// The AGENT/MCP entry through the same Broker: agent-origin stateful
// calls NEVER self-confirm (R1.6-D1) — they park at the pending queue
// until a human answers on the panel.
ipcMain.handle("evidence:agent-call", (_e, { tool, args, reason }) => {
  const host = requireHost();
  return host.callTool(tool, args || {},
      { origin: "agent", reason: reason || "agent-initiated call" });
});

// §5.4 restart entry: adopt-or-terminate a leftover browser.
ipcMain.handle("evidence:resolve-orphan", (_e, { pid, traceDir }) => {
  const host = requireHost();
  const { resolveOrphan: decide } =
      require("../../../xtrace-host/src/host");
  const decision = decide({ pid, traceDir,
      pidAlive: (p) => { try { process.kill(p, 0); return true; }
                         catch { return false; } } });
  if (decision.action === "adopt-read-only") {
    host.index.ingestCaptureDir(traceDir);
  }
  return decision;
});

let mainWindow = null;
let currentRun = null;
let tailTimer = null;
let tailOffset = 0;

if (process.platform === "darwin") {
  app.setActivationPolicy("regular");
  app.dock.show();
}

function createWindow() {
  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setSkipTaskbar(false);
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    if (process.platform === "darwin") {
      app.dock.show();
      app.focus({steal: true});
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(false);
        }
      }, 250);
    }
  };
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "XTrace Workbench",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once("ready-to-show", showMainWindow);
  mainWindow.webContents.once("did-finish-load", showMainWindow);
  setTimeout(showMainWindow, 1000);
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function sendStatus(payload) {
  if (mainWindow) {
    mainWindow.webContents.send("xtrace:status", payload);
  }
}

function stopTail() {
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = null;
  }
}

function startTail(tracePath) {
  stopTail();
  tailOffset = 0;
  tailTimer = setInterval(() => {
    const result = readEventsSince(tracePath, tailOffset);
    tailOffset = result.offset;
    if (result.events.length && mainWindow) {
      mainWindow.webContents.send("xtrace:events", result.events);
    }
  }, 500);
}

ipcMain.handle("xtrace:get-defaults", () => ({
  chromiumPath: DEFAULT_CHROMIUM_APP,
  logDir: DEFAULT_LOG_DIR,
  url: "http://127.0.0.1:8765/reverse-smoke.html",
  categories: "reverse,fingerprint",
  captureValues: "full",
  maxValueBytes: 262144,
  captureAssets: "full",
  assetMaxBytes: DEFAULT_ASSET_MAX_BYTES
}));

ipcMain.handle("xtrace:choose-chromium", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "openDirectory"],
    message: "Select Chromium.app or Chromium executable"
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("xtrace:choose-log-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    message: "Select XTrace log directory"
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("xtrace:start", async (_event, options) => {
  if (currentRun) {
    throw new Error("Chromium is already running");
  }
  currentRun = startChromiumRun(options);
  startTail(currentRun.tracePath);
  currentRun.child.stdout.on("data", (chunk) => sendStatus({stream: "stdout", text: chunk.toString()}));
  currentRun.child.stderr.on("data", (chunk) => sendStatus({stream: "stderr", text: chunk.toString()}));
  currentRun.child.on("exit", (code, signal) => {
    stopTail();
    sendStatus({running: false, code, signal});
    currentRun = null;
  });
  sendStatus({
    running: true,
    tracePath: currentRun.tracePath,
    profilePath: currentRun.profilePath,
    metadataPath: currentRun.metadataPath,
    pid: currentRun.child.pid
  });
  return {
    tracePath: currentRun.tracePath,
    profilePath: currentRun.profilePath,
    metadataPath: currentRun.metadataPath,
    pid: currentRun.child.pid
  };
});

ipcMain.handle("xtrace:stop", async () => {
  if (!currentRun) return false;
  currentRun.child.kill("SIGTERM");
  return true;
});

ipcMain.handle("xtrace:list-logs", (_event, logDir) => listTraceFiles(logDir));

ipcMain.handle("xtrace:read-log", (_event, tracePath) => {
  if (!fs.existsSync(tracePath)) return [];
  return readEventsSince(tracePath, 0).events;
});

ipcMain.handle("xtrace:read-assets", (_event, tracePath) => {
  if (!tracePath || !fs.existsSync(tracePath)) return [];
  return attachAssetContent(tracePath, readAssetManifest(tracePath), {maxBytes: 64 * 1024});
});

ipcMain.handle("xtrace:generate-report", (_event, tracePath) => {
  if (!tracePath || !fs.existsSync(tracePath)) {
    throw new Error("Trace file not found");
  }
  return generateReportForTrace(tracePath);
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (currentRun) {
    currentRun.child.kill("SIGTERM");
  }
  stopTail();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
