'use strict';
// P6-E4: the three-shape input slicer (frozen decision §5.3).
//
// The raw trace NEVER enters the model context. Exactly three slice
// shapes exist, each bounded and each carrying capture+producer+seq
// references so any claim can be walked back to its event:
//   manifest-summary — capture/producer/coverage counters
//   evidence-slice   — top-K rows ranked by analysis relevance with
//                      VALUE-BOUNDARY events prioritized (value_tap,
//                      dumps, first/last of each api family) + line refs
//   index-results    — outputs of Host index queries (already bounded)
// A slice that would exceed its cap is TRUNCATED WITH A MARKER and a
// pointer to the trace_query tool — asking for more goes through the
// tool, never through dumping.

const DEFAULT_BUDGET = {
  manifest_summary_bytes: 4096,
  evidence_slice_bytes: 16384,
  evidence_slice_rows: 60,
  index_results_bytes: 8192,
};

function createSlicer({ index, budget }) {
  const caps = { ...DEFAULT_BUDGET, ...(budget || {}) };

  function manifestSummary(captureId) {
    const captures = index.listCaptures()
        .filter((c) => c.capture_id === captureId);
    if (!captures.length) {
      throw new Error(`unknown capture: ${captureId}`);
    }
    const c = captures[0];
    const payload = {
      shape: 'manifest-summary',
      capture_id: c.capture_id,
      terminal: c.terminal,
      coverage: c.coverage,
      event_count: c.event_count,
      sampled_out: c.total_sampled_out,
      partial_observations: c.total_partial_observations,
      top_apis: index.topApis(captureId, 8),
    };
    return bound(payload, caps.manifest_summary_bytes, 'manifest-summary');
  }

  function evidenceSlice(captureId, { focusApi } = {}) {
    // Relevance ranking: value-bearing events FIRST (value_tap, dump
    // assets), then boundaries (first/last per api), then recency.
    const streamed = index.streamEvents(captureId, { limit: 2000 });
    const rows = streamed
        .map((r) => ({ row: r, score: relevance(r) }))
        .sort((x, y) => y.score - x.score);
    const picked = [];
    let bytes = 0;
    for (const { row } of rows) {
      if (picked.length >= caps.evidence_slice_rows) {
        break;
      }
      if (focusApi && row.api !== focusApi) {
        continue;
      }
      const line = JSON.stringify(compact(row));
      if (bytes + line.length > caps.evidence_slice_bytes) {
        continue; // try smaller rows before giving up
      }
      picked.push(line);
      bytes += line.length;
    }
    const truncated = picked.length < rows.length;
    return {
      shape: 'evidence-slice',
      capture_id: captureId,
      rows: picked.length,
      bytes,
      truncated,
      truncation_note: truncated
          ? 'slice capped — use trace_query for targeted paging'
          : undefined,
      content: `[${picked.join(',\n')}]`,
    };
  }

  function indexResults(rows) {
    const payload = { shape: 'index-results', count: rows.length, rows };
    return bound(payload, caps.index_results_bytes, 'index-results');
  }

  function bound(payload, cap, shape) {
    let text = JSON.stringify(payload);
    let truncated = false;
    if (text.length > cap) {
      // shrink: drop the least-essential array fields first, then hard-cut
      const slim = { ...payload };
      for (const key of ['top_apis', 'rows', 'assets']) {
        if (slim[key] && text.length > cap) {
          slim[key] = Array.isArray(slim[key])
              ? slim[key].slice(0, Math.max(1, Math.floor(slim[key].length / 2)))
              : slim[key];
        }
      }
      text = JSON.stringify(slim);
      if (text.length > cap) {
        text = text.slice(0, cap);
        truncated = true;
      }
      payload = JSON.parse(text.endsWith('}') ? text : text + '"}');
      payload.shape = shape;
    }
    return { ...payload, bytes: text.length, truncated,
             truncation_note: truncated
                 ? 'slice size-capped — use trace_query for more' : undefined };
  }

  function relevance(row) {
    const e = row.event || {};
    let score = 0;
    if (e.value_tap) {
      score += 100; // value-bearing observation
    }
    if (/dump/i.test(String(e.api || ''))) {
      score += 90;
    }
    if (e.ignition) {
      score += 40;
    }
    if (e.causality === 'paired' && e.phase === 'return') {
      score += 10;
    }
    return score;
  }

  function compact(row) {
    return {
      ref: `${row.capture_id}|${row.producer_id}|${row.producer_seq}`,
      api: row.api,
      phase: row.phase,
      value_tap: row.event.value_tap || undefined,
      ignition: row.event.ignition || undefined,
      args: row.event.args || undefined,
      causality: row.causality,
    };
  }

  return { manifestSummary, evidenceSlice, indexResults, caps };
}

module.exports = { createSlicer, DEFAULT_BUDGET };
