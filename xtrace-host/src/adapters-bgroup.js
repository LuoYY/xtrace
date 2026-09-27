'use strict';
// P6-R1 B-group control adapters — frozen first-batch five, all
// STATEFUL_CONTROL (per-call confirmation + reason + audit through the
// Broker). R1 hardening:
//   * jsvmp_trace gains a real 'cancel' action (the UI's cancel entry
//     is a side effect and must go through the Broker like everything
//     else — B1).
//   * 'clear' has REAL semantics now (M3): the Host drops its active
//     capture reference; subsequent stop/status answer an explicit
//     no-active-capture state. No more success-shaped no-ops.
//   * Precise-mode rejections map to a machine-readable precondition
//     error `preciseModeRequires` (M8) instead of a bare CDP string.
//   * stop returns the settled (terminal, coverage) PAIR plus drop
//     counters (unchanged contract).

const fs = require('node:fs');
const path = require('node:path');
const { TIERS } = require('./broker');

function createBGroupAdapters({ workspace, host, envs }) {
  const a = [];

  function requireHost() {
    if (!host || host.closed) {
      throw new Error('no live browser connection (host closed)');
    }
    return host;
  }

  function manifestAt(traceFile) {
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

  function preciseError(error) {
    // M8: precise-mode rejections become machine-readable preconditions.
    const message = String(error.message || error);
    if (/ignition-precise unavailable|must lock Ignition/.test(message)) {
      const err = new Error(
          'preciseModeRequires: launch spec must include ' +
          '--xtrace-causality=sync, --xtrace-ignition-observer and ' +
          '--js-flags with --max-opt=0 (Host buildLaunchSpec provides it)');
      err.code = 'PRECISE_MODE_PRECONDITION';
      throw err;
    }
    throw error;
  }

  a.push({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    input: { action: 'start|stop|status|cancel|clear',
             script_pattern: 'string?', max_taps: 'int?' },
    output: 'capture state; stop returns the (terminal, coverage) pair',
    sideEffects: 'capture lifecycle over the owned browser',
    run: async (args) => {
      const action = args && args.action;
      const h = requireHost();
      if (action === 'start') {
        try {
          const out = await h.send('XTrace.startCapture', {
            categories: 'reverse',
            mode: 'ignition-precise', tier: 'ignition',
            valueObservation: {
              scriptPattern: (args.script_pattern != null &&
                              String(args.script_pattern)) || '',
              windows: [{ id: 0, start: 0, end: 4000000 }],
              maxTapsPerActivation: args.max_taps || 50000,
              maxTapsPerWindow: args.max_taps || 50000,
            },
          });
          h.activeCapture = { captureId: out.captureId,
                              generation: out.generation,
                              startedMs: Date.now() };
          return { action, state: out.state,
                   captureId: out.captureId, generation: out.generation,
                   tapPlanSerial: out.tapPlanSerial };
        } catch (error) {
          preciseError(error);
        }
      }
      if (action === 'stop') {
        // R2-2: the frozen §11.3 stop-timeout scenario. A deadline miss
        // (or a hung browser surfacing as CDP_TIMEOUT) settles as
        // stop-timeout with the REAL elapsed time — the caller keeps
        // polling Status for the eventual terminal.
        const started = Date.now();
        const deadlineMs = Number(args.deadline_ms) > 0
            ? Number(args.deadline_ms) : 8000;
        const stages = ['stop-requested'];
        let out;
        // m-R3-4: the deadline timer MUST clear on the success path —
        // a leaked 8s timer per stop dragged CLI exits and piled up.
        let deadlineTimer = null;
        try {
          out = await Promise.race([
            h.send('XTrace.stopCapture'),
            new Promise((_, reject) => {
              deadlineTimer = setTimeout(() => {
                const e = new Error('stop deadline elapsed');
                e.code = 'STOP_DEADLINE';
                reject(e);
              }, deadlineMs);
            }),
          ]);
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        } catch (error) {
          if (deadlineTimer) {
            clearTimeout(deadlineTimer);
          }
          if (error.code === 'STOP_DEADLINE' || error.code === 'CDP_TIMEOUT') {
            stages.push('deadline-missed');
            return { action, state: 'stop-timeout', terminal: 'stop-timeout',
                     stages, elapsed_ms: Date.now() - started,
                     reason: error.code === 'CDP_TIMEOUT'
                         ? 'browser did not answer (CDP timeout)'
                         : 'stop deadline elapsed; capture may still settle',
                     pair: { terminal: 'stop-timeout', coverage: null } };
          }
          throw error;
        }
        stages.push('stop-answered');
        const traceFile = h.traceFile;
        let coverage = null;
        let counts = null;
        if (traceFile) {
          const manifest = manifestAt(traceFile);
          coverage = manifest?.observation_coverage ?? null;
          counts = manifest?.counts ?? null;
          stages.push('manifest-settled');
        }
        h.activeCapture = null;
        return { action, terminal: out.state, reason: out.reason || null,
                 coverage, counts, trace_file: traceFile || null,
                 stages, elapsed_ms: Date.now() - started,
                 pair: { terminal: out.state, coverage } };
      }
      if (action === 'status') {
        const out = await h.send('XTrace.getCaptureStatus');
        return { action, ...out,
                 active_capture: h.activeCapture || null };
      }
      if (action === 'cancel') {
        // Real semantics: retire every pending stop/confirmation for
        // this host and abandon any in-flight wait. The Broker rows say
        // 'confirmation-cancelled'; the wait resolves cancelled.
        const retired = h.broker ? h.broker.cancelAllPending() : [];
        return { action, cancelled: true,
                 retired_confirmations: retired.length };
      }
      if (action === 'clear') {
        // M3: REAL semantics — drop the Host's active-capture
        // reference. Later stop/status answer no-active-capture.
        const previous = h.activeCapture || null;
        h.activeCapture = null;
        h.activeCaptureCleared = true;
        const status = await h.send('XTrace.getCaptureStatus')
            .catch(() => ({}));
        return { action, cleared: true,
                 previous_capture: previous ? previous.captureId : null,
                 domain_state_after: status.state ?? 'unknown',
                 note: 'host active-capture reference dropped; ' +
                       'products on disk are untouched evidence' };
      }
      throw new Error(`jsvmp_trace: unknown action ${action}`);
    },
  });

  a.push({
    name: 'jsvmp_status', tier: TIERS.READ_EVIDENCE,
    input: {},
    output: 'capture + capability posture',
    sideEffects: 'none (read via the control domain)',
    run: async () => {
      const h = requireHost();
      const status = await h.send('XTrace.getCaptureStatus');
      const caps = await h.capabilities();
      return {
        capture: status,
        active_capture: h.activeCapture || null,
        enhanced: caps.enhanced,
        capability_counts: {
          available: caps.tools.filter((t) => t.state === 'available').length,
          degraded: caps.tools.filter((t) => t.state === 'degraded').length,
          unavailable: caps.tools.filter((t) => t.state === 'unavailable')
              .length,
        },
        degraded_tools: caps.tools.filter((t) => t.state === 'degraded')
            .map((t) => ({ name: t.name, reason: t.reason })),
      };
    },
  });

  a.push({
    name: 'webapi_trace', tier: TIERS.STATEFUL_CONTROL,
    degradedReason: 'first-batch WebIDL interface set only (P5 frozen scope)',
    input: { action: 'start|stop|status' },
    output: 'capture state for the WebIDL event surface',
    sideEffects: 'capture lifecycle over the owned browser',
    run: async (args) => {
      const action = args && args.action;
      const h = requireHost();
      if (action === 'start') {
        try {
          const out = await h.send('XTrace.startCapture', {
            categories: 'reverse',
            mode: 'ignition-precise', tier: 'ignition',
          });
          h.activeCapture = { captureId: out.captureId,
                              generation: out.generation,
                              startedMs: Date.now() };
          return { action, state: out.state, captureId: out.captureId };
        } catch (error) {
          preciseError(error);
        }
      }
      if (action === 'stop') {
        const started = Date.now();
        const out = await h.send('XTrace.stopCapture');
        const traceFile = h.traceFile;
        let coverage = null;
        if (traceFile) {
          coverage = manifestAt(traceFile)?.observation_coverage ?? null;
        }
        h.activeCapture = null;
        return { action, terminal: out.state, coverage,
                 elapsed_ms: Date.now() - started,
                 pair: { terminal: out.state, coverage } };
      }
      if (action === 'status') {
        return { action, ...(await h.send('XTrace.getCaptureStatus')) };
      }
      throw new Error(`webapi_trace: unknown action ${action}`);
    },
  });

  a.push({
    name: 'scripts_capture_all', tier: TIERS.STATEFUL_CONTROL,
    input: { action: 'start|stop' },
    output: 'capture state with capture-assets=full',
    sideEffects: 'capture lifecycle; full script assets on disk',
    run: async (args) => {
      const action = args && args.action;
      const h = requireHost();
      if (action === 'start') {
        try {
          const out = await h.send('XTrace.startCapture', {
            categories: 'reverse', captureAssets: 'full',
            mode: 'ignition-precise', tier: 'ignition',
          });
          h.activeCapture = { captureId: out.captureId,
                              generation: out.generation,
                              startedMs: Date.now() };
          return { action, state: out.state, captureId: out.captureId };
        } catch (error) {
          preciseError(error);
        }
      }
      if (action === 'stop') {
        const out = await h.send('XTrace.stopCapture');
        h.activeCapture = null;
        return { action, terminal: out.state };
      }
      throw new Error(`scripts_capture_all: unknown action ${action}`);
    },
  });

  // ---- the env seven ----------------------------------------------------
  // Inventory 需确认 column: env_list/env_status are 否 (pure reads);
  // the five mutating operations stay stateful-control.
  const envSpec = {
    env_create: { tier: TIERS.STATEFUL_CONTROL,
      run: (args) => envs.create(requireName(args), { notes: args.notes }) },
    env_list: { tier: TIERS.READ_EVIDENCE, run: () => envs.list() },
    env_status: { tier: TIERS.READ_EVIDENCE,
      run: (args) => envs.status(requireName(args)) },
    env_update: { tier: TIERS.STATEFUL_CONTROL,
      run: (args) => envs.update(requireName(args),
                                 { notes: args && args.notes }) },
    env_open: { tier: TIERS.STATEFUL_CONTROL,
      run: (args) => envs.open(requireName(args)) },
    env_close: { tier: TIERS.STATEFUL_CONTROL,
      run: (args) => envs.close(requireName(args)) },
    env_delete: { tier: TIERS.STATEFUL_CONTROL,
      run: (args) => envs.delete(requireName(args)) },
  };
  for (const [name, spec] of Object.entries(envSpec)) {
    a.push({
      name, tier: spec.tier,
      input: { name: 'string', notes: 'string?' },
      output: 'env record',
      sideEffects: name.startsWith('env_create') || name === 'env_delete' ||
                   name.startsWith('env_open')
          ? 'workspace profile lifecycle' : 'env metadata',
      run: async (args) => spec.run(args || {}),
    });
  }

  return a;
}

function requireName(args) {
  const v = args && args.name;
  if (typeof v !== 'string' || !v) {
    throw new Error('missing required string argument: name');
  }
  return v;
}

module.exports = { createBGroupAdapters };
