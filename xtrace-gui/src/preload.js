const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("xtrace", {
  getDefaults: () => ipcRenderer.invoke("xtrace:get-defaults"),
  chooseChromium: () => ipcRenderer.invoke("xtrace:choose-chromium"),
  chooseLogDir: () => ipcRenderer.invoke("xtrace:choose-log-dir"),
  start: (options) => ipcRenderer.invoke("xtrace:start", options),
  stop: () => ipcRenderer.invoke("xtrace:stop"),
  listLogs: (logDir) => ipcRenderer.invoke("xtrace:list-logs", logDir),
  readLog: (tracePath) => ipcRenderer.invoke("xtrace:read-log", tracePath),
  readAssets: (tracePath) => ipcRenderer.invoke("xtrace:read-assets", tracePath),
  generateReport: (tracePath) => ipcRenderer.invoke("xtrace:generate-report", tracePath),
  onStatus: (callback) => {
    ipcRenderer.on("xtrace:status", (_event, payload) => callback(payload));
  },
  onEvents: (callback) => {
    ipcRenderer.on("xtrace:events", (_event, events) => callback(events));
  },
  // P6-E5 evidence surface (main-process owned; no Node in renderer)
  evidenceOpenWorkspace: (dir) => ipcRenderer.invoke("evidence:open-workspace", dir),
  evidenceStatus: (captureId) => ipcRenderer.invoke("evidence:capture-status", captureId),
  evidenceStart: (options) => ipcRenderer.invoke("evidence:start", options),
  evidenceStop: (options) => ipcRenderer.invoke("evidence:stop", options),
  evidenceCancel: () => ipcRenderer.invoke("evidence:cancel"),
  evidenceJump: (ref) => ipcRenderer.invoke("evidence:jump", ref),
  evidenceAuthRecords: () => ipcRenderer.invoke("evidence:auth-records")
});
