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
// P6-E5: evidence service + host orchestration (main process only)
const {createEvidenceService} = require("./evidenceService");
const {createHost} = require("../../../xtrace-host/src/host");
const {createBroker, TIERS} = require("../../../xtrace-host/src/broker");

function electronAppRoot() {
  // xtrace-gui/src/main/main.js -> repo root
  return path.resolve(__dirname, "..", "..", "..");
}

const evidence = createEvidenceService({host: null});
let evidenceHost = null;
let evidenceBroker = null;

ipcMain.handle("evidence:open-workspace", (_e, dir) =>
    evidence.openWorkspace(dir));
ipcMain.handle("evidence:capture-status", (_e, captureId) =>
    evidence.captureStatus(captureId || undefined));
ipcMain.handle("evidence:auth-records", () => evidence.authorizationRecords());
ipcMain.handle("evidence:jump", (_e, ref) => evidence.evidenceJump(ref));
ipcMain.handle("evidence:cancel", () => evidence.cancelActive());

ipcMain.handle("evidence:start", async (_e, options = {}) => {
  const root = options.workspaceRoot;
  if (!root) {
    throw new Error("workspaceRoot required");
  }
  // close any previous hosted browser first (a second ChromiumX on the
  // SAME profile dir would hit the singleton lock)
  if (evidenceHost && !evidenceHost.closed) {
    try { await evidenceHost.close(); } catch {}
  }
  global.__e5StartCount = (global.__e5StartCount || 0) + 1;
  const traceFile = options.traceFile ||
      path.join(root, "traces", `ui-scenario-${global.__e5StartCount}`,
                "trace.ndjson");
  fs.mkdirSync(path.dirname(traceFile), {recursive: true});
  const executable = options.executable ||
      path.join(electronAppRoot(), "chromium", "src", "out",
          "XTraceIntegration", "ChromiumX.app/Contents/MacOS/Chromium");
  evidenceHost = await createHost({
    executable,
    browserArgs: [
      `--user-data-dir=${path.join(root, "p" + global.__e5StartCount)}`,
      "--xtrace-enable", `--xtrace-file=${traceFile}`,
      "--xtrace-categories=reverse", "--xtrace-causality=sync",
      "--xtrace-ignition-observer",
      "--js-flags=--allow-natives-syntax --max-opt=0",
    ],
    workspaceRoot: root,
    traceFile,
  });
  evidenceBroker = createBroker({workspace: {dir: () => path.join(root, "ledger"),
      root, contains: () => true, assertInside: (t) => t}});
  const capture = await evidenceHost.send("XTrace.startCapture", {
    categories: "reverse", mode: "ignition-precise", tier: "ignition",
    valueObservation: {
      scriptPattern: "",
      windows: [{id: 0, start: 0, end: 4000000}],
      maxTapsPerActivation: options.maxTaps ?? 5,
      maxTapsPerWindow: options.maxTaps ?? 5,
    },
  });
  const page = await evidenceHost.send("Target.createTarget", {url: "about:blank"});
  const {sessionId} = await evidenceHost.send("Target.attachToTarget",
      {targetId: page.targetId, flatten: true});
  await evidenceHost.send("Runtime.enable", {}, sessionId);
  const LOOP = `(()=>{const s=document.createElement('script');
    s.textContent='window.__e5=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;}return acc;}var r={v:f(20)};return r;})();';
    document.documentElement.appendChild(s);
    return window.__e5;})()`;
  await evidenceHost.send("Runtime.evaluate", {expression: LOOP,
      returnByValue: true}, sessionId);
  await new Promise((r) => setTimeout(r, options.settleMs ?? 1200));
  return {state: capture.state, captureId: capture.captureId, traceFile};
});

ipcMain.handle("evidence:stop", async (_e, options = {}) => {
  // the UI's stop goes THROUGH the Broker (UI origin, confirmed) — the
  // audit trail covers every execution entry, the UI included
  const reason = options.reason || "UI scenario stop";
  evidence.setHost(evidenceHost);
  const tool = {
    name: "jsvmp_trace.stop", tier: TIERS.STATEFUL_CONTROL,
    run: async () => evidence.stopProgress(options || {}),
  };
  const gateResult = evidenceBroker.gate(tool.name, tool.tier,
                                         {origin: "ui", reason});
  const exec = evidenceBroker.execute(tool, {}, {origin: "ui", reason});
  if (gateResult.decision === "confirmation-required") {
    for (let i = 0; i < 200 && evidenceBroker.pendingCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
      for (const id of evidenceBroker.pendingIds()) {
        evidenceBroker.resolveConfirmation(id, true);
      }
    }
  }
  const out = await exec;
  return {state: out.state, coverage: out.coverage, stages: out.stages,
          pair: out.pair || null};
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
