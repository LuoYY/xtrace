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
  // P6-R1 evidence surface (main-process owned; no Node in renderer)
  evidenceOpenWorkspace: (dir) => ipcRenderer.invoke("evidence:open-workspace", dir),
  evidenceChooseWorkspace: () => ipcRenderer.invoke("evidence:choose-workspace"),
  evidenceStatus: (captureId) => ipcRenderer.invoke("evidence:capture-status", captureId),
  evidenceStart: (options) => ipcRenderer.invoke("evidence:start", options),
  evidenceStop: (options) => ipcRenderer.invoke("evidence:stop", options),
  evidenceCancel: (options) => ipcRenderer.invoke("evidence:cancel", options),
  evidenceClear: (options) => ipcRenderer.invoke("evidence:clear", options),
  evidenceJump: (ref) => ipcRenderer.invoke("evidence:jump", ref),
  evidenceAuthRecords: () => ipcRenderer.invoke("evidence:auth-records"),
  evidenceCapabilities: () => ipcRenderer.invoke("evidence:capabilities"),
  evidencePending: () => ipcRenderer.invoke("evidence:pending"),
  evidenceConfirmation: (id, approved) => ipcRenderer.invoke("evidence:confirmation", {id, approved}),
  evidenceResolveOrphan: (pid, traceDir) => ipcRenderer.invoke("evidence:resolve-orphan", {pid, traceDir}),
  evidenceAgentCall: (tool, args, reason) => ipcRenderer.invoke("evidence:agent-call", {tool, args, reason})
});
