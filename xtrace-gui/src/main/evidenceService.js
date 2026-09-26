'use strict';
// P6-E5 (first slice): the main-process evidence service — bridges the
// xtrace-host package (workspace + derived index + Broker) into the
// Electron GUI. ALL Node power stays here; the renderer sees only the
// IPC surface (contextIsolation on, nodeIntegration off).
//
// Surface:
//   openWorkspace(dir)          — workspace + index (rebuild) + broker
//   captureStatus(captureId)    — state/terminal + coverage + drop
//                                 counters from the manifest
//   stopProgress(stopDeadlineMs)— stop the owned capture with staged
//                                 progress + timeout semantics
//   cancelActive()              — cancel an in-flight stop/operation
//   evidenceJump(ref)           — capture|producer|seq -> trace line
//   authorizationRecords()      — broker audit rows (decision trail)
//   adoptReadOnly(traceDir)     — the §5.4 resume path after restart

const fs = require('node:fs');
const path = require('node:path');
const { createWorkspace, createBroker } = require('../../../xtrace-host/src/index');
const { createEvidenceIndex } = require('../../../xtrace-host/src/evidence-index');

function createEvidenceService({ host }) {
  let workspace = null;
  let index = null;
  let broker = null;
  let activeCancel = null;

  function openWorkspace(dir) {
    workspace = createWorkspace(dir);
    index = createEvidenceIndex(path.join(workspace.dir('index'), 'index.db'));
    index.rebuildFromDir(path.join(dir, 'traces'));
    broker = createBroker({ workspace });
    return { root: workspace.root,
             captures: index.listCaptures().length };
  }

  function requireWorkspace() {
    if (!workspace || !index) {
      throw new Error('no workspace open');
    }
  }

  function captureStatus(captureId) {
    requireWorkspace();
    const rows = index.listCaptures()
        .filter((c) => !captureId || c.capture_id === captureId);
    if (captureId && !rows.length) {
      throw new Error(`unknown capture: ${captureId}`);
    }
    return rows.map((c) => {
      const manifest = readManifestFor(c);
      return {
        capture_id: c.capture_id,
        state: c.terminal ? 'settled' : 'unknown',
        terminal: c.terminal,
        terminal_reason: manifest?.terminal?.reason ?? null,
        coverage: c.coverage,
        event_count: c.event_count,
        drop_counters: {
          dropped: Number(manifest?.counts?.dropped ?? 0),
          failed: Number(manifest?.counts?.failed ?? 0),
          sampled_out: Number(manifest?.counts?.sampled_out ?? 0),
          partial_observations: Number(
              manifest?.counts?.partial_observations ?? 0),
        },
        unconfirmed_producers: (manifest?.producers ?? [])
            .filter((p) => p.watermark?.received === false)
            .map((p) => p.producer_id),
      };
    });
  }

  /** Stop the owned capture, reporting STAGED progress; a deadline
   * miss resolves to {state:'stop-timeout'} (scenario 2), cancellation
   * resolves to {state:'cancelled'} (scenario 4). */
  async function stopProgress({ deadlineMs = 8000, pollMs = 200 } = {}) {
    requireWorkspace();
    if (!host || host.closed) {
      return { state: 'stop-timeout', stage: 'no-browser',
               reason: 'browser pipe already closed' };
    }
    activeCancel = { cancelled: false };
    const started = Date.now();
    const stages = [];
    try {
      stages.push('stop-requested');
      const stopPromise = host.send('XTrace.stopCapture');
      while (true) {
        if (activeCancel.cancelled) {
          return { state: 'cancelled', stages, elapsed_ms: Date.now() - started };
        }
        const outcome = await Promise.race([
          stopPromise.then((value) => ({ done: true, value })),
          new Promise((r) => setTimeout(() => r({ done: false }), pollMs)),
        ]);
        if (outcome.done) {
          stages.push('stop-answered');
          const terminal = outcome.value.state;
          // coverage axis settles with the manifest shortly after
          let coverage = null;
          for (let i = 0; i < 10; i++) {
            const manifest = host.traceFile
                ? readManifestAt(host.traceFile) : null;
            if (manifest && manifest.terminal) {
              coverage = manifest.observation_coverage ?? null;
              break;
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
          stages.push('manifest-settled');
          return { state: terminal, coverage, stages,
                   elapsed_ms: Date.now() - started };
        }
        if (Date.now() - started > deadlineMs) {
          return { state: 'stop-timeout', stages,
                   elapsed_ms: Date.now() - started };
        }
      }
    } finally {
      activeCancel = null;
    }
  }

  function cancelActive() {
    if (activeCancel) {
      activeCancel.cancelled = true;
      return true;
    }
    return false;
  }

  /** Evidence jump: capture|producer|seq -> the trace file + line. */
  function evidenceJump(ref) {
    requireWorkspace();
    const parts = String(ref).split('|');
    if (parts.length < 3) {
      throw new Error(`bad evidence reference: ${ref}`);
    }
    const [captureId, producerId, seq] = parts;
    const rows = index.streamEvents(captureId, { limit: 100000 });
    const hit = rows.find((r) => r.producer_id === producerId &&
                                 String(r.producer_seq) === String(seq));
    if (!hit) {
      throw new Error(`reference not found: ${ref}`);
    }
    const lineIndex = findLine(host, captureId, producerId, seq);
    return {
      capture_id: captureId, producer_id: producerId, producer_seq: seq,
      api: hit.api,
      trace_file: index.listCaptures()
          .filter((c) => c.capture_id === captureId)[0]?.dir,
      line: lineIndex,
      event: hit.event,
    };
  }

  function authorizationRecords(limit = 100) {
    requireWorkspace();
    const ledgerDir = workspace.dir('ledger');
    const rows = [];
    if (!fs.existsSync(ledgerDir)) {
      return rows;
    }
    for (const file of fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl')).sort().reverse()) {
      for (const line of fs.readFileSync(path.join(ledgerDir, file), 'utf8')
          .split('\n').filter((l) => l.trim()).reverse()) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          continue;
        }
        if (rows.length >= limit) {
          return rows;
        }
      }
    }
    return rows;
  }

  /** §5.4 resume: after a Host restart, adopt on-disk artifacts
   * read-only (index them; no capture continuation assumed). */
  function adoptReadOnly(traceDir) {
    requireWorkspace();
    workspace.assertInside(traceDir, 'trace dir');
    const out = index.ingestCaptureDir(traceDir);
    return { adopted: true, ...out };
  }

  function readManifestFor(captureRow) {
    try {
      return JSON.parse(fs.readFileSync(
          path.join(captureRow.dir, 'trace.manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function readManifestAt(traceFile) {
    const stem = path.basename(traceFile, '.ndjson');
    for (const candidate of [
      path.join(path.dirname(traceFile), `${stem}.manifest.json`),
      path.join(path.dirname(traceFile), 'trace.manifest.json'),
    ]) {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
    }
    return null;
  }

  function findLine(hostRef, captureId, producerId, seq) {
    void hostRef;
    const captures = index.listCaptures()
        .filter((c) => c.capture_id === captureId);
    if (!captures.length) {
      return null;
    }
    const text = fs.readFileSync(
        path.join(captures[0].dir, path.basename(captures[0].dir)
            .replace(/$/, '') && 'trace.ndjson'), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`"producer_id":"${producerId}"`) &&
          lines[i].includes(`"producer_seq":"${seq}"`)) {
        return i + 1;
      }
    }
    return null;
  }

  return { openWorkspace, captureStatus, stopProgress, cancelActive,
           evidenceJump, authorizationRecords, adoptReadOnly };
}

module.exports = { createEvidenceService };
