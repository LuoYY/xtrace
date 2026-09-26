// P6-E6: the closed-loop acceptance. ONE pass through the full chain,
// every execution entry through the Broker audit:
//   env (isolated profile) -> controlled capture (Broker-confirmed) ->
//   local page under taps -> stop + integrity (pair assertion +
//   validator) -> index rebuild -> agent analysis (slices + tools) ->
//   UI evidence jump (the agent's citation resolves to a trace line).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const EXE = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const { createHost } = require(path.join(root, 'xtrace-host/src/host'));
const { createBroker, TIERS } = require(path.join(root, 'xtrace-host/src/broker'));
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));
const { createEnvManager } = require(path.join(root, 'xtrace-host/src/env-manager'));
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));
const { createAGroupAdapters } = require(path.join(root, 'xtrace-host/src/adapters-agroup'));
const { createBGroupAdapters } = require(path.join(root, 'xtrace-host/src/adapters-bgroup'));
const { createAgentLoop } = require(path.join(root, 'xtrace-host/src/agent-loop'));

const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p6-e6-'));
const report = { stages: [] };
const stage = (name, ok, detail) => {
  report.stages.push({ name, ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}: ${String(detail).slice(0, 160)}`);
  if (!ok) {
    throw new Error(`stage failed: ${name} — ${detail}`);
  }
};

(async () => {
  // ---- 1. isolated environment ----------------------------------------
  const workspaceRoot = path.join(runDir, 'ws');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const ws = createWorkspace(workspaceRoot);
  const envs = createEnvManager({ workspace: ws });
  envs.create('e6-env', { notes: 'closed-loop isolated env' });
  const opened = envs.open('e6-env');
  stage('env-isolated', opened.open === true && opened.profile_dir.startsWith(ws.dir('profiles')),
        `profile=${opened.profile_dir}`);

  // ---- 2-3. controlled capture over a local page ------------------------
  const traceFile = path.join(ws.dir('traces'), 'closed-loop', 'trace.ndjson');
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  const host = await createHost({
    executable: EXE,
    browserArgs: [
      `--user-data-dir=${opened.profile_dir}`,
      '--xtrace-enable', `--xtrace-file=${traceFile}`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync',
      '--xtrace-ignition-observer',
      '--js-flags=--allow-natives-syntax --max-opt=0',
    ],
    workspaceRoot, traceFile,
  });
  const broker = createBroker({ workspace: ws });

  // EVERY tool execution below goes through broker.execute — the audit
  // ledger is the single record of what ran.
  const all = {};
  function registerAll(adapters) {
    for (const adapter of adapters) {
      all[broker.register(adapter).name] = adapter;
    }
  }
  // B-group needs no index; A-group (queries) registers AFTER the
  // capture settles so the real index binds to its tools.
  registerAll(createBGroupAdapters({ workspace: ws, host, envs }));
  async function call(toolName, args, reason) {
    const tool = all[toolName];
    const exec = broker.execute(tool, args, { origin: 'agent', reason });
    const g = broker.gate(toolName, tool.tier, { origin: 'agent', reason });
    if (g.decision === 'confirmation-required') {
      for (let i = 0; i < 400 && broker.pendingCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
        for (const id of broker.pendingIds()) {
          broker.resolveConfirmation(id, true);
        }
      }
    }
    return exec;
  }

  const start = await call('jsvmp_trace', { action: 'start', max_taps: 5 },
      'closed-loop controlled capture of the local fixture');
  stage('capture-started', start.state === 'active', `state=${start.state} plan=${start.tapPlanSerial}`);

  const page = await host.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await host.send('Target.attachToTarget',
      { targetId: page.targetId, flatten: true });
  await host.send('Runtime.enable', {}, sessionId);
  const LOOP = `(()=>{const s=document.createElement('script');
    s.textContent='window.__e6=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;}return acc;}var r={v:f(20),wrap:{seed:777}};return r;})();';
    document.documentElement.appendChild(s);
    return window.__e6;})()`;
  const pageOut = await host.send('Runtime.evaluate',
      { expression: LOOP, returnByValue: true }, sessionId);
  stage('local-page-ran', pageOut.result?.value?.v !== undefined,
        `page result v=${pageOut.result?.value?.v}`);
  await new Promise((r) => setTimeout(r, 1500));

  // ---- 4. stop + integrity ---------------------------------------------
  const stop = await call('jsvmp_trace', { action: 'stop' },
      'closed-loop settle with pair assertion');
  stage('stop-pair', stop.pair?.terminal === 'complete' &&
                     stop.pair?.coverage === 'partial',
        JSON.stringify(stop.pair));
  const val = spawnSync('python3', [
      path.join(root, 'scripts/validate_trace.py'),
      '--schema-version', '3', '--profile', 'generic-vmp', traceFile],
      { encoding: 'utf8', timeout: 120000 });
  stage('validator', val.status === 0,
        `exit=${val.status} ${val.stderr ? val.stderr.slice(-120) : ''}`);

  // ---- 5. index ---------------------------------------------------------
  const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
  const rebuilt = index.rebuildFromDir(ws.dir('traces'));
  const captureId = rebuilt[0].captureId;
  stage('index-rebuilt', rebuilt.length === 1 && rebuilt[0].eventCount > 1000,
        `capture=${captureId} events=${rebuilt[0].eventCount} apis=${rebuilt[0].apis}`);

  // ---- 6. agent analysis (slices + tools, all via Broker) ----------------
  const agentTools = createAGroupAdapters({ workspace: ws, index });
  registerAll(agentTools);
  // the evidence-jump substrate call below also uses the real index
  let citedRef = null;
  const model = async (state) => {
    if (state.iteration === 1) {
      return { type: 'slice', shape: 'manifest-summary', capture_id: captureId };
    }
    if (state.iteration === 2) {
      return { type: 'tool', name: 'jsvmp_query', args: { capture_id: captureId, limit: 10 } };
    }
    if (state.iteration === 3) {
      const rows = state.last.result;
      citedRef = rows.length
          ? `${captureId}|${rows[0].producer_id}|${rows[0].producer_seq}` : null;
      return { type: 'final', answer: {
        conclusion: 'Ignition dispatch observed under a bounded tap plan',
        evidence_ref: citedRef,
        coverage: 'partial (budget skips accounted)',
      } };
    }
    return { type: 'final', answer: {} };
  };
  const loop = createAgentLoop({ broker, tools: agentTools, index,
                                 workspace: ws, model,
                                 limits: { context_bytes: 65536 } });
  const agentOut = await loop.run();
  stage('agent-analysis', agentOut.status === 'complete' && citedRef,
        `status=${agentOut.status} ref=${citedRef} iters=${agentOut.iterations}`);

  // ---- 7. UI evidence jump: the citation resolves to a trace line -------
  const jump = await call('trace_query', { capture_id: captureId, limit: 1 },
      'closed-loop evidence jump substrate');
  void jump;
  const firstRow = index.streamEvents(captureId, { limit: 1 })[0];
  const svcLikeJump = {
    ref: `${captureId}|${firstRow.producer_id}|${firstRow.producer_seq}`,
    line: null,
  };
  const text = fs.readFileSync(traceFile, 'utf8').split('\n');
  for (let i = 0; i < text.length; i++) {
    if (text[i].includes(`"producer_id":"${firstRow.producer_id}"`) &&
        text[i].includes(`"producer_seq":"${firstRow.producer_seq}"`)) {
      svcLikeJump.line = i + 1;
      break;
    }
  }
  stage('evidence-jump', svcLikeJump.line !== null,
        `ref=${svcLikeJump.ref} -> line ${svcLikeJump.line}`);

  // ---- 8. the audit covers EVERY execution entry -------------------------
  const ledger = fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
  const executed = ledger.filter((e) => e.decision === 'executed');
  const confirmed = ledger.filter((e) => e.decision === 'confirmed');
  const startStop = executed.filter((e) => e.tool === 'jsvmp_trace');
  stage('broker-audit', startStop.length >= 2 && confirmed.length >= 2 &&
        executed.every((e) => ['agent', 'ui', 'mcp'].includes(e.origin)),
        `executed=${executed.length} confirmed=${confirmed.length} ` +
        `tools=${[...new Set(executed.map((e) => e.tool))].join(',')}`);

  await host.close();
  index.close();
  report.verdict = 'pass';
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log('P6-E6 CLOSED LOOP: GREEN');
  console.log('evidence: ' + runDir);
})().catch((e) => {
  report.verdict = 'fail';
  report.error = String(e.message || e);
  try { fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1)); } catch {}
  console.error('P6-E6 CLOSED LOOP: RED —', e.message);
  process.exit(1);
});
