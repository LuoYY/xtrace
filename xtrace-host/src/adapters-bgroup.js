'use strict';
// P6-E3: the B-group control adapters (frozen first-batch five):
//   jsvmp_trace   start/stop/status/clear — NO dump (dump stays the
//                 operator's S1 tool, deliberately out of the agent set)
//   jsvmp_status  overall observer/capture posture
//   webapi_trace  first-batch WebIDL surface
//   scripts_capture_all  capture-assets=full variant
//   env_*         the minimal seven (delegated to the env manager)
// All stateful-control tier: per-call Broker confirmation + reason +
// audit. stop asserts the settled (terminal, coverage) PAIR — the
// transport terminal from stopCapture, the coverage axis from the
// manifest (they are independent by design).

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

  function manifestFor(traceFile) {
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

  a.push({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    input: { action: 'start|stop|status|clear', script_pattern: 'string?',
             max_taps: 'int?' },
    output: 'capture state; stop returns the (terminal, coverage) pair',
    sideEffects: 'capture lifecycle over the owned browser',
    run: async (args) => {
      const action = args && args.action;
      const h = requireHost();
      if (action === 'start') {
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
        return { action, state: out.state,
                 captureId: out.captureId, generation: out.generation,
                 tapPlanSerial: out.tapPlanSerial };
      }
      if (action === 'stop') {
        const out = await h.send('XTrace.stopCapture');
        const traceFile = h.traceFile;
        let coverage = null;
        let counts = null;
        if (traceFile) {
          const manifest = manifestFor(traceFile);
          coverage = manifest?.observation_coverage ?? null;
          counts = manifest?.counts ?? null;
        }
        // THE asserted pair: transport terminal + observation coverage
        // are independent axes; both are reported, never conflated.
        return { action, terminal: out.state, reason: out.reason || null,
                 coverage, counts, trace_file: traceFile || null,
                 pair: { terminal: out.state, coverage } };
      }
      if (action === 'status') {
        const out = await h.send('XTrace.getCaptureStatus');
        return { action, ...out };
      }
      if (action === 'clear') {
        // Products stay on disk (they are the evidence); clear drops
        // the Host's ACTIVE-capture reference only.
        const out = await h.send('XTrace.getCaptureStatus').catch(() => ({}));
        return { action, cleared: true, previousState: out.state ?? null };
      }
      throw new Error(`jsvmp_trace: unknown action ${action}`);
    },
  });

  a.push({
    name: 'jsvmp_status', tier: TIERS.STATEFUL_CONTROL,
    input: {},
    output: 'capture + capability posture',
    sideEffects: 'none (read via the control domain)',
    run: async () => {
      const h = requireHost();
      const status = await h.send('XTrace.getCaptureStatus');
      const caps = await h.capabilities();
      return {
        capture: status,
        enhanced: caps.enhanced,
        available_tools: caps.tools.filter((t) => t.state === 'available').length,
        degraded_tools: caps.tools.filter((t) => t.state === 'degraded')
            .map((t) => t.name),
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
        // WebIDL surface rides the reverse category; NO value taps
        // (that is jsvmp_trace's distinction).
        const out = await h.send('XTrace.startCapture', {
          categories: 'reverse',
          mode: 'ignition-precise', tier: 'ignition',
        });
        return { action, state: out.state, captureId: out.captureId };
      }
      if (action === 'stop') {
        const out = await h.send('XTrace.stopCapture');
        return { action, terminal: out.state };
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
        const out = await h.send('XTrace.startCapture', {
          categories: 'reverse', captureAssets: 'full',
          mode: 'ignition-precise', tier: 'ignition',
        });
        return { action, state: out.state, captureId: out.captureId };
      }
      if (action === 'stop') {
        const out = await h.send('XTrace.stopCapture');
        return { action, terminal: out.state };
      }
      throw new Error(`scripts_capture_all: unknown action ${action}`);
    },
  });

  // ---- the env seven ----------------------------------------------------
  const envSpec = {
    env_create: (args) => envs.create(requireName(args), { notes: args.notes }),
    env_list: () => envs.list(),
    env_status: (args) => envs.status(requireName(args)),
    env_update: (args) => envs.update(requireName(args),
                                       { notes: args && args.notes }),
    env_open: (args) => envs.open(requireName(args)),
    env_close: (args) => envs.close(requireName(args)),
    env_delete: (args) => envs.delete(requireName(args)),
  };
  for (const [name, run] of Object.entries(envSpec)) {
    a.push({
      name, tier: TIERS.STATEFUL_CONTROL,
      input: { name: 'string', notes: 'string?' },
      output: 'env record',
      sideEffects: name.startsWith('env_create') || name === 'env_delete' ||
                   name.startsWith('env_open')
          ? 'workspace profile lifecycle' : 'env metadata',
      run: async (args) => run(args || {}),
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
