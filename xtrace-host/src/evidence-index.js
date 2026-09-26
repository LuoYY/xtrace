'use strict';
// P6-E2: the derived evidence index (frozen decision §5.1).
//
// SQLite (better-sqlite3) inside the Node Host, in its OWN database
// file (index.db — sibling of, never merged with, a future ledger.db).
// DERIVED data only: capture rows, producer counters, api aggregates,
// asset registry. Event-level queries NEVER touch the index — they
// stream the NDJSON directly. The index is fully REBUILDABLE from the
// capture directories (rebuild-from-dirs is itself the acceptance
// case): anything rebuildable must not become a second source of
// truth.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  capture_id TEXT PRIMARY KEY,
  dir TEXT NOT NULL,
  trace_file TEXT NOT NULL,
  terminal TEXT,
  terminal_reason TEXT,
  coverage TEXT,
  accounting_model TEXT,
  schema_version INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  total_eligible INTEGER NOT NULL DEFAULT 0,
  total_sampled_out INTEGER NOT NULL DEFAULT 0,
  total_partial_observations INTEGER NOT NULL DEFAULT 0,
  indexed_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS producers (
  capture_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  process_epoch TEXT,
  kind TEXT,
  eligible INTEGER, enqueued INTEGER, dropped INTEGER,
  sampled_out INTEGER, partial_observations INTEGER,
  accepted INTEGER, written INTEGER, failed INTEGER,
  watermark_received INTEGER,
  PRIMARY KEY (capture_id, producer_id)
);
CREATE TABLE IF NOT EXISTS api_counts (
  capture_id TEXT NOT NULL,
  api TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (capture_id, api)
);
CREATE TABLE IF NOT EXISTS assets (
  capture_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT,
  url TEXT,
  content_path TEXT,
  PRIMARY KEY (capture_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_api_capture ON api_counts (capture_id, count DESC);
`;

function createEvidenceIndex(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  function ingestCaptureDir(captureDir) {
    const dir = path.resolve(captureDir);
    const traceFile = findTraceFile(dir);
    if (!traceFile) {
      throw new Error(`no trace ndjson in ${dir}`);
    }
    const manifest = readManifest(dir, traceFile);
    const captureId = (manifest && manifest.capture_id) ||
        path.basename(dir);
    const stats = streamTrace(traceFile);

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM captures WHERE capture_id = ?').run(captureId);
      db.prepare('DELETE FROM producers WHERE capture_id = ?').run(captureId);
      db.prepare('DELETE FROM api_counts WHERE capture_id = ?').run(captureId);
      db.prepare('DELETE FROM assets WHERE capture_id = ?').run(captureId);

      db.prepare(`INSERT INTO captures
        (capture_id, dir, trace_file, terminal, terminal_reason, coverage,
         accounting_model, schema_version, event_count, total_eligible,
         total_sampled_out, total_partial_observations, indexed_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(captureId, dir, traceFile,
               manifest?.terminal?.state ?? null,
               manifest?.terminal?.reason ?? null,
               manifest?.observation_coverage ?? null,
               manifest?.accounting_model ?? null,
               manifest?.schema_version ?? null,
               stats.eventCount,
               Number(manifest?.counts?.eligible ?? 0),
               Number(manifest?.counts?.sampled_out ?? 0),
               Number(manifest?.counts?.partial_observations ?? 0),
               Date.now());

      const insProducer = db.prepare(`INSERT OR REPLACE INTO producers
        (capture_id, producer_id, process_epoch, kind, eligible, enqueued,
         dropped, sampled_out, partial_observations, accepted, written,
         failed, watermark_received)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of manifest?.producers ?? []) {
        insProducer.run(captureId, p.producer_id, p.process_epoch ?? null,
                        p.kind ?? null,
                        intOrNull(p.eligible), intOrNull(p.enqueued),
                        intOrNull(p.dropped), intOrNull(p.sampled_out),
                        intOrNull(p.partial_observations),
                        intOrNull(p.accepted), intOrNull(p.written),
                        intOrNull(p.failed),
                        p.watermark?.received === true ? 1 :
                            p.watermark?.received === false ? 0 : null);
      }

      const insApi = db.prepare(`INSERT INTO api_counts
        (capture_id, api, count) VALUES (?, ?, ?)`);
      for (const [api, count] of stats.apiCounts) {
        insApi.run(captureId, api, count);
      }

      const insAsset = db.prepare(`INSERT OR REPLACE INTO assets
        (capture_id, asset_id, kind, url, content_path)
        VALUES (?, ?, ?, ?, ?)`);
      for (const a of readAssetRows(dir, traceFile)) {
        insAsset.run(captureId, a.asset_id, a.kind ?? null, a.url ?? null,
                     a.content_path ?? null);
      }
    });
    tx();
    return { captureId, eventCount: stats.eventCount,
             apis: stats.apiCounts.size };
  }

  function rebuildFromDir(rootDir) {
    // THE acceptance case: a complete rebuild from capture directories.
    const db2 = db.transaction(() => {
      db.exec('DELETE FROM captures; DELETE FROM producers; ' +
              'DELETE FROM api_counts; DELETE FROM assets;');
    });
    db2();
    const ingested = [];
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(rootDir, entry.name);
      if (!findTraceFile(dir)) {
        continue;
      }
      ingested.push(ingestCaptureDir(dir));
    }
    return ingested;
  }

  // ---- queries (references ALWAYS carry capture + producer + seq) ----
  function listCaptures() {
    return db.prepare(`SELECT capture_id, dir, terminal, coverage,
        event_count, total_sampled_out, total_partial_observations
        FROM captures ORDER BY indexed_ms DESC`).all();
  }

  function topApis(captureId, limit = 20) {
    return db.prepare(`SELECT api, count FROM api_counts
        WHERE capture_id = ? ORDER BY count DESC LIMIT ?`).all(captureId, limit);
  }

  function assetRows(captureId, kind) {
    return kind
        ? db.prepare(`SELECT asset_id, kind, url, content_path FROM assets
            WHERE capture_id = ? AND kind = ?`).all(captureId, kind)
        : db.prepare(`SELECT asset_id, kind, url, content_path FROM assets
            WHERE capture_id = ?`).all(captureId);
  }

  /** EVENT-LEVEL: streams the NDJSON (never the index) with an api
   * filter; every row carries its capture + producer + seq reference. */
  function streamEvents(captureId, { api, limit = 100 } = {}) {
    const capture = db.prepare(
        'SELECT trace_file FROM captures WHERE capture_id = ?').get(captureId);
    if (!capture) {
      throw new Error(`unknown capture: ${captureId}`);
    }
    const out = [];
    const text = fs.readFileSync(capture.trace_file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (api && event.api !== api) {
        continue;
      }
      out.push({
        capture_id: captureId,
        producer_id: event.producer_id ?? null,
        producer_seq: event.producer_seq ?? null,
        api: event.api ?? null,
        phase: event.phase ?? null,
        causality: event.causality?.kind ?? event.causality_kind ?? null,
        event,
      });
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  return { ingestCaptureDir, rebuildFromDir, listCaptures, topApis,
           assetRows, streamEvents,
           close: () => db.close() };
}

function findTraceFile(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.ndjson') && name.startsWith('trace')) {
      return path.join(dir, name);
    }
  }
  return null;
}

function readManifest(dir, traceFile) {
  const stem = path.basename(traceFile, '.ndjson');
  for (const candidate of [path.join(dir, `${stem}.manifest.json`),
                           path.join(dir, 'trace.manifest.json')]) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
  }
  return null;
}

function readAssetRows(dir, traceFile) {
  const stem = path.basename(traceFile, '.ndjson');
  const candidates = [
    path.join(dir, 'assets', stem, 'manifest.ndjson'),
    path.join(dir, 'assets', 'trace', 'manifest.ndjson'),
  ];
  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const rows = [];
    for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        rows.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return rows;
  }
  return [];
}

function streamTrace(traceFile) {
  let eventCount = 0;
  const apiCounts = new Map();
  const text = fs.readFileSync(traceFile, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      eventCount += 1;
      const api = event.api ?? '(none)';
      apiCounts.set(api, (apiCounts.get(api) ?? 0) + 1);
    } catch {
      eventCount += 1; // unparseable lines still count as events
    }
  }
  return { eventCount, apiCounts };
}

function intOrNull(v) {
  return v == null ? null : Number(v);
}

module.exports = { createEvidenceIndex };
