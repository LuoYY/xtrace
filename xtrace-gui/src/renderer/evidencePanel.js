(function initEvidencePanel(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.xtraceEvidencePanel = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  // P6-E5 renderer panel: pure rendering logic over the evidence
  // service payloads (no Node access in the renderer by design).
  function renderCaptureStatus(status) {
    if (!Array.isArray(status) || !status.length) {
      return "no captures in workspace";
    }
    return status.map((c) => {
      // R2-1: the index rows carry the REAL counters (dropped/failed/
      // sampled_out/partial + unconfirmed_count) — the panel never
      // invents zeros.
      const drops = c.drop_counters || {
        dropped: c.total_dropped, failed: c.total_failed,
        sampled_out: c.total_sampled_out,
        partial_observations: c.total_partial_observations,
      };
      const unconfirmed = c.unconfirmed_count ??
          (c.unconfirmed_producers || []).length;
      return [
        `capture ${c.capture_id}`,
        `terminal=${c.terminal || "unknown"}${c.terminal_reason ? ` (${c.terminal_reason})` : ""}`,
        `coverage=${c.coverage || "unknown"}`,
        `events=${c.event_count}`,
        `drops: dropped=${drops.dropped ?? 0} failed=${drops.failed ?? 0} ` +
          `sampled_out=${drops.sampled_out ?? 0} partial=${drops.partial_observations ?? 0}`,
        unconfirmed ? `unconfirmed producers: ${unconfirmed}` : null
      ].filter(Boolean).join(" | ");
    }).join("\n");
  }

  function renderStopProgress(outcome) {
    // the broker tool result uses `terminal` for the settled state
    const state = outcome && (outcome.state || outcome.terminal);
    if (!state) {
      return "stop: unknown";
    }
    const stages = (outcome.stages || []).join(" -> ");
    switch (state) {
      case "complete":
      case "settled":
        return `stop: ${state} coverage=${outcome.coverage || "unknown"} [${stages}] ${outcome.elapsed_ms || 0}ms`;
      case "incomplete":
        return `stop: incomplete [${stages}]`;
      case "stop-timeout":
        return `stop: TIMEOUT after ${outcome.elapsed_ms || 0}ms [${stages}] — capture may still be settling`;
      case "cancelled":
        return `stop: cancelled by user [${stages}]`;
      default:
        return `stop: ${state} [${stages}]`;
    }
  }

  function renderAuthorizationRecords(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return "no authorization records";
    }
    return rows.slice(0, 30).map((r) =>
        `${r.tool || "?"} ${r.decision || "?"}` +
        `${r.origin ? ` via ${r.origin}` : ""}` +
        `${r.reason ? ` — ${String(r.reason).slice(0, 60)}` : ""}`
    ).join("\n");
  }

  function evidenceRefFromEvent(event) {
    if (!event || !event.producer_id || event.producer_seq == null) {
      return null;
    }
    return `${event.capture_id}|${event.producer_id}|${event.producer_seq}`;
  }

  function renderCancel(outcome) {
    if (!outcome) {
      return "cancel: no-op";
    }
    return `cancel: retired=${outcome.retired_confirmations ?? 0} ` +
           `pending confirmation(s) retired; the underlying stop wait ` +
           `is abandoned — check Status for the settled terminal`;
  }

  function renderCapabilities(caps) {
    if (!caps || !caps.counts) {
      return "capabilities: unknown";
    }
    const head = `capabilities: available=${caps.counts.available} ` +
        `degraded=${caps.counts.degraded} unavailable=${caps.counts.unavailable}`;
    const gaps = (caps.gaps || []).map((g) =>
        `  ${g.name} [${g.state}] ${g.reason || ""}`);
    return [head, ...gaps].join("\n");
  }

  function renderEvidenceJump(out) {
    if (!out) {
      return "jump: no result";
    }
    return `jump: ${out.capture_id}|${out.producer_id}|${out.producer_seq} ` +
        `-> line ${out.line} @ byte ${out.byte_offset} ` +
        `(${out.trace_file || "trace"}) api=${out.api || out.event?.api || "?"}`;
  }

  return { renderCaptureStatus, renderStopProgress,
           renderAuthorizationRecords, evidenceRefFromEvent,
           renderCancel, renderCapabilities, renderEvidenceJump };
});
