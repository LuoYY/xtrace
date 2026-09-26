const state = {
  events: [],
  assets: [],
  report: null,
  tracePath: null,
  detailMode: "event",
  selected: null,
  captureGate: null,
  running: false
};

const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function renderEvents() {
  const filter = $("filter").value.trim().toLowerCase();
  const visible = state.events.filter((event) => {
    if (!filter) return true;
    return String(event.category || "").toLowerCase().includes(filter) ||
      String(event.api || "").toLowerCase().includes(filter);
  });
  $("events").innerHTML = visible.slice(-400).reverse().map((event, index) => `
    <div class="event-row" data-index="${state.events.indexOf(event)}">
      <div class="row-main">
        <strong>${event.api || "unknown"}</strong>
        <span>${event.category || "-"}</span>
      </div>
      <div class="row-meta">${event.phase || event.t || "-"} seq=${event.seq ?? "-"} pid=${event.pid ?? "-"}</div>
    </div>
  `).join("");
}

function renderCaptureGate() {
  const element = $("captureGateState");
  if (!element) return;
  const helper = window.xtraceCaptureGate;
  if (!helper?.buildRealtimeCaptureGate || !helper?.formatRealtimeCaptureGate) {
    element.textContent = "-";
    element.classList.remove("gate-passed", "gate-pending");
    return;
  }
  const gate = helper.buildRealtimeCaptureGate(state.events, {startUrl: $("url").value});
  state.captureGate = gate;
  element.textContent = helper.formatRealtimeCaptureGate(gate);
  element.classList.toggle("gate-passed", gate.status === "passed");
  element.classList.toggle("gate-pending", gate.status !== "passed");
}

function renderDetail(event) {
  $("detail").classList.toggle("report-detail", state.detailMode === "report");
  $("detail").classList.toggle("json-detail", state.detailMode !== "report");
  if (state.detailMode === "assets") {
    $("detail").textContent = JSON.stringify(state.assets, null, 2);
    return;
  }
  if (state.detailMode === "report") {
    if (window.xtraceReportView?.renderReportHtml) {
      $("detail").innerHTML = window.xtraceReportView.renderReportHtml(state.report);
    } else {
      $("detail").textContent = JSON.stringify(state.report || {}, null, 2);
    }
    return;
  }
  $("detail").textContent = JSON.stringify(event || {}, null, 2);
}

function setDetailMode(mode) {
  state.detailMode = mode;
  for (const id of ["showEvent", "showAssets", "showReport"]) {
    $(id).classList.toggle("active", id.toLowerCase().includes(mode));
  }
  renderDetail(state.events[state.events.length - 1]);
}

async function loadAssetsForTrace(tracePath) {
  state.assets = await window.xtrace.readAssets(tracePath);
}

async function refreshLogs() {
  const logs = await window.xtrace.listLogs($("logDir").value);
  $("logList").innerHTML = logs.map((log) => `
    <div class="log-row" data-path="${log.path}">
      <div class="row-main">
        <strong>${log.name}</strong>
        <span>${formatBytes(log.size)}</span>
      </div>
      <div class="row-meta">${new Date(log.modifiedMs).toLocaleString()}</div>
    </div>
  `).join("");
}

function setRunning(running) {
  state.running = running;
  $("runState").textContent = running ? "Running" : "Idle";
  $("startRun").disabled = running;
  $("stopRun").disabled = !running;
  updateRecipeButtons();
}

function currentRerunRecipe() {
  return window.xtraceRerunRecipe?.recipeFromReport
    ? window.xtraceRerunRecipe.recipeFromReport(state.report)
    : null;
}

function updateRecipeButtons() {
  const disabled = state.running || !currentRerunRecipe();
  $("applyRecipe").disabled = disabled;
  $("runRecipe").disabled = disabled;
}

function applyCurrentRerunRecipe() {
  const recipe = currentRerunRecipe();
  const applied = window.xtraceRerunRecipe?.applyRerunRecipeToForm?.(recipe, $);
  if (applied) {
    $("runState").textContent = "Recipe applied";
  }
  return Boolean(applied);
}

async function startRunFromForm(extraOptions = {}) {
  const options = window.xtraceRerunRecipe?.launchOptionsFromForm
    ? window.xtraceRerunRecipe.launchOptionsFromForm($)
    : {
        chromiumPath: $("chromiumPath").value,
        url: $("url").value,
        logDir: $("logDir").value,
        categories: $("categories").value,
        captureValues: $("captureValues").value,
        maxValueBytes: Number($("maxValueBytes").value),
        captureAssets: $("captureAssets").value,
        assetMaxBytes: Number($("assetMaxBytes").value)
      };
  const run = await window.xtrace.start({...options, ...extraOptions});
  state.events = [];
  state.assets = [];
  state.report = null;
  state.captureGate = null;
  updateRecipeButtons();
  state.tracePath = run.tracePath;
  $("pid").textContent = run.pid;
  $("profilePath").textContent = run.profilePath;
  $("tracePath").textContent = run.tracePath;
  $("agentPackPath").textContent = "-";
  setRunning(true);
  renderEvents();
  renderCaptureGate();
  return run;
}

async function runCurrentRerunRecipe() {
  const recipe = currentRerunRecipe();
  if (!applyCurrentRerunRecipe()) return null;
  return startRunFromForm({
    recipeSourceTracePath: state.tracePath,
    rerunRecipe: recipe
  });
}

async function boot() {
  const defaults = await window.xtrace.getDefaults();
  $("chromiumPath").value = defaults.chromiumPath;
  $("url").value = defaults.url;
  $("logDir").value = defaults.logDir;
  $("categories").value = defaults.categories;
  $("captureValues").value = defaults.captureValues;
  $("maxValueBytes").value = defaults.maxValueBytes;
  $("captureAssets").value = defaults.captureAssets;
  $("assetMaxBytes").value = defaults.assetMaxBytes;
  setRunning(false);
  updateRecipeButtons();
  await refreshLogs();

  $("chooseChromium").addEventListener("click", async () => {
    const selected = await window.xtrace.chooseChromium();
    if (selected) $("chromiumPath").value = selected;
  });
  $("chooseLogDir").addEventListener("click", async () => {
    const selected = await window.xtrace.chooseLogDir();
    if (selected) {
      $("logDir").value = selected;
      await refreshLogs();
    }
  });
  $("refreshLogs").addEventListener("click", refreshLogs);
  $("clearEvents").addEventListener("click", () => {
    state.events = [];
    state.captureGate = null;
    renderEvents();
    renderCaptureGate();
    renderDetail(null);
  });
  $("showEvent").addEventListener("click", () => setDetailMode("event"));
  $("showAssets").addEventListener("click", () => setDetailMode("assets"));
  $("showReport").addEventListener("click", () => setDetailMode("report"));
  $("filter").addEventListener("input", renderEvents);
  $("events").addEventListener("click", (event) => {
    const row = event.target.closest(".event-row");
    if (!row) return;
    renderDetail(state.events[Number(row.dataset.index)]);
  });
  $("logList").addEventListener("click", async (event) => {
    const row = event.target.closest(".log-row");
    if (!row) return;
    state.events = await window.xtrace.readLog(row.dataset.path);
    state.tracePath = row.dataset.path;
    state.report = null;
    updateRecipeButtons();
    await loadAssetsForTrace(row.dataset.path);
    $("tracePath").textContent = row.dataset.path;
    $("agentPackPath").textContent = "-";
    renderEvents();
    renderCaptureGate();
    renderDetail(state.events[state.events.length - 1]);
  });
  $("generateReport").addEventListener("click", async () => {
    if (!state.tracePath) return;
    const result = await window.xtrace.generateReport(state.tracePath);
    state.report = result.report;
    $("agentPackPath").textContent = result.agentPackMarkdownPath || result.agentPackJsonPath || "-";
    updateRecipeButtons();
    setDetailMode("report");
    renderDetail(null);
    await refreshLogs();
  });
  $("startRun").addEventListener("click", async () => {
    await startRunFromForm();
  });
  $("stopRun").addEventListener("click", async () => {
    await window.xtrace.stop();
  });
  $("applyRecipe").addEventListener("click", applyCurrentRerunRecipe);
  $("runRecipe").addEventListener("click", runCurrentRerunRecipe);

  window.xtrace.onStatus(async (status) => {
    if (Object.prototype.hasOwnProperty.call(status, "running")) {
      setRunning(status.running);
      if (!status.running) {
        $("pid").textContent = "-";
        await refreshLogs();
      }
    }
    if (status.tracePath) $("tracePath").textContent = status.tracePath;
    if (status.tracePath) state.tracePath = status.tracePath;
    if (status.profilePath) $("profilePath").textContent = status.profilePath;
    if (status.pid) $("pid").textContent = status.pid;
  });
  window.xtrace.onEvents((events) => {
    state.events.push(...events);
    renderEvents();
    renderCaptureGate();
    renderDetail(events[events.length - 1]);
  });
  renderCaptureGate();
}

boot().catch((error) => {
  $("runState").textContent = "Error";
  renderDetail({error: String(error), stack: error.stack});
});

// P6-R1 evidence panel wiring — all interaction through the preload
// bridge (no Node in the renderer). The E2E workspace hook remains
// ONLY as a labeled harness accelerator; humans use the directory
// picker (M7).
(function initEvidencePanel() {
  const panel = document.getElementById("evidencePanel");
  const pendingBox = document.getElementById("evidencePending");
  if (!panel || !window.xtrace || !window.xtraceEvidencePanel) {
    return;
  }
  const lib = window.xtraceEvidencePanel;
  let workspaceRoot = null;
  const $ = (id) => document.getElementById(id);
  const setPanel = (text) => { panel.textContent = text; };

  async function refreshPending() {
    if (!workspaceRoot) {
      return;
    }
    try {
      const items = await window.xtrace.evidencePending();
      pendingBox.innerHTML = "";
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "pending-confirmation";
        row.dataset.confirmationId = item.id;
        row.dataset.testid = "pending-confirmation";
        row.textContent = `PENDING ${item.tool} via ${item.origin} — ${item.reason}`;
        const approve = document.createElement("button");
        approve.dataset.testid = "confirm-approve";
        approve.textContent = "Approve";
        approve.addEventListener("click", () =>
            window.xtrace.evidenceConfirmation(item.id, true).then(refreshPending));
        const deny = document.createElement("button");
        deny.dataset.testid = "confirm-deny";
        deny.textContent = "Deny";
        deny.addEventListener("click", () =>
            window.xtrace.evidenceConfirmation(item.id, false).then(refreshPending));
        row.appendChild(approve);
        row.appendChild(deny);
        pendingBox.appendChild(row);
      }
    } catch {
      /* no live host yet */
    }
  }

  $("btnEvidenceChoose").addEventListener("click", async () => {
    const dir = await window.xtrace.evidenceChooseWorkspace();
    if (!dir) {
      setPanel("workspace selection cancelled");
      return;
    }
    workspaceRoot = dir;
    const out = await window.xtrace.evidenceOpenWorkspace(dir);
    setPanel(`workspace open: ${out.root} captures=${out.captures}`);
  });

  $("btnEvidenceOpen").addEventListener("click", async () => {
    try {
      // harness accelerator (labeled): E2E sets the workspace via
      // window.__xtraceE2EWorkspace; humans use Choose workspace…
      workspaceRoot = workspaceRoot || window.__xtraceE2EWorkspace || null;
      if (!workspaceRoot) {
        setPanel("no workspace selected — use Choose workspace…");
        return;
      }
      const out = await window.xtrace.evidenceOpenWorkspace(workspaceRoot);
      setPanel(`workspace open: ${out.root} captures=${out.captures}`);
    } catch (error) {
      setPanel(`open failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceStart").addEventListener("click", async () => {
    try {
      const out = await window.xtrace.evidenceStart({
        workspaceRoot,
        targetUrl: $("evidenceTargetUrl").value.trim() || "about:blank",
        maxTaps: window.__xtraceE2EMaxTaps ?? 5,
        reason: $("evidenceReason").value.trim() || "UI start capture",
      });
      setPanel(`capture ${out.state} id=${out.captureId}`);
    } catch (error) {
      setPanel(`start failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceStop").addEventListener("click", async () => {
    try {
      const out = await window.xtrace.evidenceStop({
        reason: $("evidenceReason").value.trim() || "stop via evidence panel",
      });
      setPanel(lib.renderStopProgress(out));
    } catch (error) {
      setPanel(`stop failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceCancel").addEventListener("click", async () => {
    try {
      const out = await window.xtrace.evidenceCancel({
        reason: $("evidenceReason").value.trim() || "cancel via evidence panel",
      });
      setPanel(lib.renderCancel(out));
    } catch (error) {
      setPanel(`cancel failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceClear").addEventListener("click", async () => {
    try {
      const out = await window.xtrace.evidenceClear({
        reason: $("evidenceReason").value.trim() || "clear via panel",
      });
      setPanel(`cleared (previous=${out.previous_capture ?? "none"})`);
    } catch (error) {
      setPanel(`clear failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceStatus").addEventListener("click", async () => {
    try {
      const rows = await window.xtrace.evidenceStatus();
      setPanel(lib.renderCaptureStatus(rows));
    } catch (error) {
      setPanel(`status failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceAuth").addEventListener("click", async () => {
    try {
      const rows = await window.xtrace.evidenceAuthRecords();
      setPanel(lib.renderAuthorizationRecords(rows));
    } catch (error) {
      setPanel(`auth failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceCaps").addEventListener("click", async () => {
    try {
      const caps = await window.xtrace.evidenceCapabilities();
      setPanel(lib.renderCapabilities(caps));
    } catch (error) {
      setPanel(`capabilities failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceJump").addEventListener("click", async () => {
    try {
      const ref = $("evidenceJumpRef").value.trim();
      const out = await window.xtrace.evidenceJump(ref);
      setPanel(lib.renderEvidenceJump(out));
    } catch (error) {
      setPanel(`jump failed: ${error.message || error}`);
    }
  });

  $("btnEvidenceAgent").addEventListener("click", async () => {
    // parks at the pending queue (origin=agent never self-confirms)
    try {
      const out = await window.xtrace.evidenceAgentCall(
          "jsvmp_trace", { action: "status" },
          $("evidenceReason").value.trim() || "agent probe");
      setPanel(`agent call: ${JSON.stringify(out).slice(0, 200)}`);
    } catch (error) {
      setPanel(`agent call: ${error.message || error}`);
    }
    refreshPending();
  });

  // keep the pending queue fresh while the panel is alive
  setInterval(refreshPending, 800);
})();
