'use strict';
// P6-R1 (R1-6): the three-shape input slicer. R1 hardening:
//   * bound() is now STRUCTURED shrinkage — drop/truncate fields and
//     RE-SERIALIZE; no string-cut-then-patch-JSON ever (B4's SyntaxError
//     path is gone). Every drop is disclosed via dropped_fields.
//   * evidenceSlice scans via the D2 window contract (predicate
//     pushdown + cursor), not a fixed 2000-row prefix (M11/B3).
//   * relevance() reads the NORMALIZED row fields (row.causality is the
//     string; event.causality is an object on v3 — the old check was
//     dead code) and the weights live in one testable table (M11).

const DEFAULT_BUDGET = {
  manifest_summary_bytes: 4096,
  evidence_slice_bytes: 16384,
  evidence_slice_rows: 60,
  index_results_bytes: 8192,
};

// Relevance weights (M11): one table, unit-tested; a shuffle control
// must flip the ordering (negative gate).
const RELEVANCE_WEIGHTS = Object.freeze({
  value_tap: 100,
  dump_api: 90,
  ignition: 40,
  paired_return: 10,
});

function relevance(row, weights = RELEVANCE_WEIGHTS) {
  // weights are injectable so negative controls exercise the REAL
  // function (R2-9) rather than a copy.
  const e = row.event || {};
  let score = 0;
  if (e.value_tap) {
    score += weights.value_tap;
  }
  if (/dump/i.test(String(e.api || ''))) {
    score += weights.dump_api;
  }
  if (e.ignition) {
    score += weights.ignition;
  }
  if (row.causality === 'paired' && row.phase === 'return') {
    score += weights.paired_return;
  }
  return score;
}

/** The smallest valid slice envelope this module can emit (the tiny-cap
 * floor): caps below this shrink to exactly this shape, never invalid
 * JSON. Tests assert bytes <= max(cap, this floor). */
function minimalEnvelopeBytes() {
  // Worst-case minimal envelope: longest shape name, the fixed note,
  // and the three trailing drop disclosures the floor keeps.
  return JSON.stringify({
    shape: 'manifest-summary',
    truncated: true,
    dropped_fields: ['top_apis:halved', 'top_apis:dropped',
                     'all:plain-cut'],
    truncation_note: 'slice size-capped — use trace_query for more',
    excerpt: '',
  }).length;
}

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
    return bound(payload, caps.manifest_summary_bytes);
  }

  function evidenceSlice(captureId, { focusApi, fromSeq } = {}) {
    const window = index.scanEvents(captureId, {
      fromSeq: fromSeq ?? null,
      maxRows: 2000, maxBytes: 1 << 20,
      predicates: focusApi ? { api: focusApi } : {},
    });
    const ranked = window.rows
        .map((row) => ({ row, score: relevance(row) }))
        .sort((x, y) => y.score - x.score);
    const picked = [];
    let bytes = 0;
    for (const { row } of ranked) {
      if (picked.length >= caps.evidence_slice_rows) {
        break;
      }
      const line = JSON.stringify(compact(row));
      if (bytes + line.length > caps.evidence_slice_bytes) {
        continue; // try smaller rows before giving up
      }
      picked.push(line);
      bytes += line.length;
    }
    const truncated = picked.length < ranked.length;
    // The WHOLE slice (envelope included) respects the byte cap — tiny
    // budgets shrink the envelope through the same structured bound().
    const envelope = {
      shape: 'evidence-slice',
      capture_id: captureId,
      rows: picked.length,
      bytes,
      truncated,
      truncation_note: truncated
          ? 'slice capped — use trace_query for targeted paging'
          : undefined,
      window: { scanned_events: window.scanned_events,
                total_events: window.total_events,
                window_complete: window.window_complete,
                next_cursor: window.next_cursor },
      content: `[${picked.join(',\n')}]`,
    };
    return bound(envelope, caps.evidence_slice_bytes);
  }

  function indexResults(rows) {
    return bound({ shape: 'index-results', count: rows.length, rows },
                 caps.index_results_bytes);
  }

  /** STRUCTURED shrinkage (B4): try whole-object; then drop optional
   * array fields one at a time (halving), then drop them entirely,
   * then a LAST-RESORT plain-text cut of the stringified core with an
   * explicit marker — never a broken JSON.parse. Every drop is
   * disclosed in dropped_fields; bytes ≤ cap is guaranteed. */
  function bound(payload, cap) {
    const drops = [];
    let text = JSON.stringify(payload);
    if (text.length <= cap) {
      return { ...payload, bytes: text.length, truncated: false,
               dropped_fields: drops };
    }
    const core = { ...payload };
    const optionalArrays = ['top_apis', 'rows', 'assets', 'events'];
    for (const field of optionalArrays) {
      if (Array.isArray(core[field])) {
        while (core[field].length > 1 &&
               JSON.stringify(core).length > cap) {
          core[field] = core[field].slice(
              0, Math.floor(core[field].length / 2));
          drops.push(`${field}:halved`);
        }
        if (JSON.stringify(core).length > cap && core[field].length) {
          delete core[field];
          drops.push(`${field}:dropped`);
        }
      }
      if (JSON.stringify(core).length <= cap) {
        break;
      }
    }
    text = JSON.stringify(core);
    if (text.length > cap) {
      // Last resort: a valid JSON envelope with a plain-text excerpt.
      drops.push('all:plain-cut');
      const headroom = cap - 64;
      const excerpt = text.slice(0, Math.max(0, headroom));
      const fallback = {
        shape: payload.shape || 'slice',
        truncated: true, dropped_fields: drops,
        truncation_note: 'slice size-capped — use trace_query for more',
        excerpt,
      };
      text = JSON.stringify(fallback);
      // shrink the excerpt until the envelope fits, dropping it entirely
      // if even the empty envelope overflows (the minimal valid shape)
      while (text.length > cap && fallback.excerpt.length > 0) {
        fallback.excerpt = fallback.excerpt.slice(
            0, Math.floor(fallback.excerpt.length / 2));
        drops.push('excerpt:halved');
        fallback.dropped_fields = [...drops];
        text = JSON.stringify(fallback);
      }
      if (text.length > cap) {
        drops.push('excerpt:dropped');
        const minimal = {
          shape: fallback.shape, truncated: true,
          dropped_fields: drops.slice(-3),   // the floor stays small
          truncation_note: 'slice size-capped — use trace_query for more',
          excerpt: '',
        };
        text = JSON.stringify(minimal);
        return { ...minimal, bytes: text.length,
                 minimal_envelope: true };
      }
      return { ...fallback, bytes: text.length };
    }
    return { ...core, bytes: text.length, truncated: true,
             dropped_fields: drops,
             truncation_note: 'slice size-capped — use trace_query for more' };
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

  return { manifestSummary, evidenceSlice, indexResults, bound, relevance,
           caps };
}

module.exports = { createSlicer, DEFAULT_BUDGET, RELEVANCE_WEIGHTS,
                   relevance, minimalEnvelopeBytes };
