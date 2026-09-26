// P6-R1 closed loop — every stage through the HOST COMPOSITION ROOT
// (one broker, one workspace; the driver never constructs a broker):
//   env (isolated, activeProfile consumed by the launch spec) ->
//   Broker-confirmed start -> local page under taps -> stop pair +
//   validator -> index -> agent analysis (slices+tools, all Broker) ->
//   UI evidence jump resolving THE AGENT'S OWN citedRef -> audit covers
//   every execution entry.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const EXE = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const { createHost } = require(path.join(root, 'xtrace-host/src/host'));
const { createAgentLoop } = require(path.join(root, 'xtrace-host/src/agent-loop'));
const { BASES } = require(path.join(root, 'xtrace-host/src/broker'));

const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p6-e6-'));
const report = { stages: [] };
const stage = (name, ok, detail) => {
  report.stages.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}: ${String(detail).slice(0, 160)}`);
  if (!ok) {
    throw new Error(`stage failed: ${name} — ${detail}`);
  }
};

(async () => {
  // ---- 1. composition root over an ISOLATED env -----------------------
  const workspaceRoot = path.join(runDir, 'ws');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  // env manager FIRST (host consumes its active profile in the spec)
  const host0 = await createHost({ executable: EXE,
      workspaceRoot, skipBrowserLaunch: true });
  // R2-6: agent-origin calls PARK at the pending queue — the driver
  // answers them through the SAME resolveConfirmation path the UI's
  // human surface uses (never a basisHint self-confirm).
  async function agentCall(host, tool, args, reason) {
    const exec = host.callTool(tool, args, { origin: 'agent', reason });
    for (let i = 0; i < 600 && host.broker.pendingCount() > 0; i++) {
      await new Promise((r2) => setTimeout(r2, 5));
      for (const id of host.broker.pendingIds()) {
        host.broker.resolveConfirmation(id, true);   // human-approved
      }
    }
    return exec;
  }
  const envCreated = await agentCall(host0, 'env_create',
      { name: 'e6-env', notes: 'closed-loop isolated env' },
      'create the isolated env for the closed loop');
  const opened = await agentCall(host0, 'env_open', { name: 'e6-env' },
      'activate the env so the launch spec consumes its profile');
  stage('env-isolated', opened.open === true &&
      opened.profile_dir.startsWith(host0.workspace.dir('profiles')),
      `profile=${opened.profile_dir}`);
  await host0.close();

  // ---- 2-3. controlled capture over a local page -----------------------
  const traceFile = path.join(workspaceRoot, 'traces', 'closed-loop',
      'trace.ndjson');
  const host = await createHost({ executable: EXE, workspaceRoot,
      traceFile, browserArgs: ['about:blank'] });
  const specUsedProfile = host.profileDir === opened.profile_dir;
  stage('launch-spec-consumes-env-profile', specUsedProfile,
      `spec profile == env profile: ${host.profileDir}`);

  const page = await host.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await host.send('Target.attachToTarget',
      { targetId: page.targetId, flatten: true });
  await host.send('Runtime.enable', {}, sessionId);

  const start = await host.callTool('jsvmp_trace',
      { action: 'start', max_taps: 5 },
      { origin: 'ui', reason: 'closed-loop controlled capture',
        basisHint: BASES.UI_DIRECT_CLICK });
  stage('capture-started', start.state === 'active',
        `state=${start.state} plan=${start.tapPlanSerial}`);

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
  const stop = await host.callTool('jsvmp_trace', { action: 'stop' },
      { origin: 'ui', reason: 'closed-loop settle with pair assertion',
        basisHint: BASES.UI_DIRECT_CLICK });
  stage('stop-pair', stop.pair?.terminal === 'complete' &&
                     stop.pair?.coverage === 'partial',
        JSON.stringify(stop.pair));
  const val = spawnSync('python3', [
      path.join(root, 'scripts/validate_trace.py'),
      '--schema-version', '3', '--profile', 'generic-vmp', traceFile],
      { encoding: 'utf8', timeout: 120000 });
  stage('validator', val.status === 0, `exit=${val.status}`);

  // ---- 5. index ---------------------------------------------------------
  const rebuilt = host.reindex();
  const captureId = rebuilt[0].captureId;
  stage('index-rebuilt', rebuilt.length === 1 && rebuilt[0].eventCount > 1000,
        `capture=${captureId} events=${rebuilt[0].eventCount}`);

  // ---- 6. agent analysis (composition-root tools only) ------------------
  let citedRef = null;
  const model = async (state) => {
    if (state.iteration === 1) {
      return { type: 'slice', shape: 'manifest-summary', capture_id: captureId };
    }
    if (state.iteration === 2) {
      return { type: 'tool', name: 'jsvmp_query',
               args: { capture_id: captureId, limit: 10 } };
    }
    if (state.iteration === 3) {
      const out = state.last.result;
      citedRef = out && out.events && out.events.length
          ? `${captureId}|${out.events[0].producer_id}|${out.events[0].producer_seq}`
          : null;
      return { type: 'final', answer: {
        conclusion: 'Ignition dispatch observed under a bounded tap plan',
        evidence_ref: citedRef,
        window: out && out.window_complete !== undefined
            ? { complete: out.window_complete, matched: out.matched,
                total: out.total_events } : null,
      } };
    }
    return { type: 'final', answer: {} };
  };
  const loop = createAgentLoop({ broker: host.broker,
      tools: [...host.tools.values()], index: host.index,
      workspace: host.workspace, model, host,
      limits: { context_bytes: 65536 } });
  const agentOut = await loop.run();
  stage('agent-analysis', agentOut.status === 'complete' && citedRef,
        `status=${agentOut.status} ref=${citedRef} iters=${agentOut.iterations}`);

  // ---- 7. UI evidence jump resolving THE AGENT'S citation (M6) ---------
  const jump = await host.callTool('evidence_jump', { ref: citedRef },
      { origin: 'ui' });
  stage('evidence-jump', jump.line >= 1 &&
      Number.isInteger(jump.byte_offset) &&
      jump.trace_file === traceFile,
        `ref=${citedRef} -> line ${jump.line} @ ${jump.byte_offset}`);

  // ---- 8. audit covers EVERY execution entry ----------------------------
  const ledger = fs.readFileSync(host.broker.ledgerPath, 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
  const executed = ledger.filter((e) => e.decision === 'executed');
  const confirmed = ledger.filter((e) => e.decision === 'confirmed');
  const granted = ledger.filter((e) => e.decision === 'granted');
  stage('broker-audit',
      executed.length >= 4 && confirmed.length >= 2 && granted.length >= 2 &&
      executed.every((e) => ['agent', 'ui', 'mcp'].includes(e.origin)) &&
      ledger.filter((e) => e.decision === 'confirmed')
          .every((e) => e.basis),
      `executed=${executed.length} confirmed=${confirmed.length} ` +
      `granted=${granted.length} tools=${[...new Set(executed.map((e) => e.tool))].join(',')}`);

  await host.close();
  report.verdict = 'pass';
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log('P6-R1 CLOSED LOOP: GREEN');
  console.log('evidence: ' + runDir);
  process.exit(0);
})().catch((e) => {
  report.verdict = 'fail';
  report.error = String(e.message || e);
  try { fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1)); } catch {}
  console.error('P6-R1 CLOSED LOOP: RED —', e.message);
  process.exit(1);
});
