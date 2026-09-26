'use strict';
// P6-R1: thin GUI-side rendering helpers over the HOST COMPOSITION
// ROOT (the service state moved into the host itself in R1-1; this
// module keeps only the renderer-facing formatting used by tests).
// Every data access now flows through host.callTool — no hardcoded
// trace filenames anywhere (B5): the index row names the trace file.

function dropCountersFromManifest(manifest) {
  const counts = manifest?.counts || {};
  return {
    dropped: Number(counts.dropped ?? 0),
    failed: Number(counts.failed ?? 0),
    sampled_out: Number(counts.sampled_out ?? 0),
    partial_observations: Number(counts.partial_observations ?? 0),
  };
}

function unconfirmedProducers(manifest) {
  return (manifest?.producers || [])
      .filter((p) => p.watermark?.received === false)
      .map((p) => p.producer_id);
}

/** Enrich a trace_summary row with the drop counters + unconfirmed
 * list read from the capture's manifest via the host index dir. */
function enrichStatusRows(rows, readManifest) {
  return (rows || []).map((row) => {
    const manifest = readManifest(row);
    return { ...row,
      terminal_reason: manifest?.terminal?.reason ?? null,
      drop_counters: dropCountersFromManifest(manifest),
      unconfirmed_producers: unconfirmedProducers(manifest) };
  });
}

module.exports = { dropCountersFromManifest, unconfirmedProducers,
                   enrichStatusRows };
