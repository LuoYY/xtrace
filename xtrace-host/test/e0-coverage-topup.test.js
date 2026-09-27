'use strict';
// M4-E0 coverage-debt top-up (register M4-7, MD4): every available/
// degraded tool that shipped as "(none — disclosed gap)" gets a REAL
// product-path gate through the composition root — live browser, live
// control domain, real filesystem (MD4 anchor 2: fake hosts are for
// unit layers only). Covers ten tools: jsvmp_status, webapi_trace,
// scripts_capture_all, env_list, env_status, env_update, env_close,
// env_delete, env_current, fs_mkdir. Remaining disclosed gaps after
// this file: the six unavailable fingerprint-family rows + three
// internal primitives (9 <= the MD4 ceiling).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { createHost } = require('../src/host');
const { BASES } = require('../src/broker');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT,
    'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

const source = 'import importlib.util, pathlib, socketserver\n'
    + 'p = pathlib.Path(' + JSON.stringify(path.join(ROOT, 'scripts',
        'serve_test_page.py')) + ')\n'
    + 'spec = importlib.util.spec_from_file_location(\'s\', p)\n'
    + 'm = importlib.util.module_from_spec(spec)\n'
    + 'spec.loader.exec_module(m)\n'
    + 'with socketserver.TCPServer((\'127.0.0.1\', 0), '
    + 'm.make_test_page_handler(p.parent.parent / \'test-pages\')) as server:\n'
    + ' print(server.server_address[1], flush=True)\n'
    + ' server.serve_forever()\n';

async function uiCall(host, name, args) {
  return host.callTool(name, args, {
    origin: 'ui', reason: 'M4-E0 coverage gate',
    basisHint: BASES.UI_DIRECT_CLICK,
  });
}

test('E0 top-up: env seven via the TOOL path (callTool, real workspace)',
    { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-e0-env-'));
  const host = await createHost({ executable: EXE, workspaceRoot: root,
      traceFile: path.join(root, 'traces', 'e0', 'trace.ndjson'),
      browserArgs: ['about:blank'] });
  try {
    await uiCall(host, 'env_create', { name: 'e0-env', notes: 'first' });
    const listed = await uiCall(host, 'env_list', {});
    assert.ok(listed.some((e) => e.name === 'e0-env' || e === 'e0-env'),
        'env_list names the created env');

    const before = await uiCall(host, 'env_status', { name: 'e0-env' });
    assert.equal(before.notes, 'first');

    await uiCall(host, 'env_update', { name: 'e0-env', notes: 'second' });
    const after = await uiCall(host, 'env_status', { name: 'e0-env' });
    assert.equal(after.notes, 'second', 'env_update really persists');

    await uiCall(host, 'env_open', { name: 'e0-env' });
    const current = await uiCall(host, 'env_current', {});
    assert.equal(current.open_env, 'e0-env');
    assert.ok(current.profile, 'env_current names the active profile');
    assert.ok(Array.isArray(current.instances));

    await uiCall(host, 'env_close', { name: 'e0-env' });
    const closed = await uiCall(host, 'env_current', {});
    assert.equal(closed.open_env, null, 'env_close returns to no-open');

    await uiCall(host, 'env_delete', { name: 'e0-env' });
    const final = await uiCall(host, 'env_list', {});
    assert.ok(!final.some((e) => e.name === 'e0-env' || e === 'e0-env'),
        'env_delete removes the record');
  } finally {
    await host.close();
  }
});

test('E0 top-up: capture family on the live browser (jsvmp_status / ' +
    'webapi_trace / scripts_capture_all)',
    { timeout: 180000 }, async () => {
  const server = spawn('python3', ['-u', '-c', source],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-e0-cap-'));
  const traceFile = path.join(root, 'traces', 'e0cap', 'trace.ndjson');
  try {
    const port = await new Promise((r) => {
      let t = '';
      server.stdout.on('data', (c) => {
        t += c;
        if (t.includes('\n')) {
          r(Number(t.trim()));
        }
      });
    });
    const URL = `http://127.0.0.1:${port}/causality-smoke.html`;
    const host = await createHost({ executable: EXE, workspaceRoot: root,
        traceFile, browserArgs: ['about:blank'] });
    try {
      // E6 harness discipline (the PROVEN-green shape): ONE created
      // target on the local page, activity via the attached session.
      // page_navigate-style flows leave extra renderers whose producers
      // miss the stop confirmation deadline and the terminal judge
      // honestly rules stop-timeout/incomplete.
      const page = await host.send('Target.createTarget', { url: URL });
      const { sessionId } = await host.send('Target.attachToTarget',
          { targetId: page.targetId, flatten: true });
      await host.send('Runtime.enable', {}, sessionId);
      await new Promise((r) => setTimeout(r, 800));

      // jsvmp_status: control-domain status + negotiated posture in one
      const idle = await uiCall(host, 'jsvmp_status', {});
      assert.ok(idle.capture && 'state' in idle.capture,
          'jsvmp_status carries XTrace.getCaptureStatus');
      assert.equal(typeof idle.enhanced, 'boolean');
      assert.ok(idle.capability_counts.available > 0);
      assert.ok(idle.degraded_tools.some((t) => t.name === 'webapi_query'),
          'degraded posture discloses the first-batch WebIDL reason');

      // webapi_trace: real start/status/stop with the PAIR contract —
      // same-document activity inside the window, then settle (E6)
      const started = await uiCall(host, 'webapi_trace',
          { action: 'start' });
      assert.ok(started.captureId, 'webapi_trace start yields captureId');
      const mid = await uiCall(host, 'webapi_trace', { action: 'status' });
      assert.equal(mid.captureId ?? mid.capture?.captureId, started.captureId,
          'status names the running capture');
      const inject = (name, mod) => host.send('Runtime.evaluate',
          { expression:
              '(()=>{const s=document.createElement(\'script\');' +
              's.textContent=\'window.' + name + '=(function(){var a=' +
              mod + ';for(var i=0;i<40;i++){a=(a+i*7)%4096;}return a;})();\';' +
              'document.documentElement.appendChild(s);' +
              'return window.' + name + ';})()',
            returnByValue: true }, sessionId);
      const ran = await inject('__e0w', '0');
      assert.ok(ran.result && ran.result.value !== undefined,
          'in-window page activity really ran');
      await new Promise((r) => setTimeout(r, 1500));
      const stopped = await uiCall(host, 'webapi_trace', { action: 'stop' });
      assert.equal(stopped.terminal, 'complete');
      assert.ok(stopped.coverage,
          'stop returns the (terminal, coverage) PAIR — coverage non-empty');

      // scripts_capture_all: captureAssets=full window, same discipline
      const capStart = await uiCall(host, 'scripts_capture_all',
          { action: 'start' });
      assert.ok(capStart.captureId);
      const ran2 = await inject('__e0c', '1');
      assert.ok(ran2.result && ran2.result.value !== undefined);
      await new Promise((r) => setTimeout(r, 1500));
      const capStop = await uiCall(host, 'scripts_capture_all',
          { action: 'stop' });
      assert.equal(capStop.terminal, 'complete');
      assert.ok(fs.existsSync(traceFile) &&
                fs.statSync(traceFile).size > 0,
          'the capture window really landed rows on disk');
    } finally {
      await host.close();
    }
  } finally {
    server.kill();
  }
});

test('E0 top-up: fs_mkdir through the tool path (real filesystem)',
    { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-e0-fs-'));
  const host = await createHost({ executable: EXE, workspaceRoot: root,
      traceFile: path.join(root, 'traces', 'e0fs', 'trace.ndjson'),
      browserArgs: ['about:blank'] });
  try {
    const made = await uiCall(host, 'fs_mkdir', { path: 'made/by/e0' });
    assert.ok(made.path && made.path.includes('made'),
        'fs_mkdir returns the created path');
    const stat = fs.statSync(path.join(root, 'made', 'by', 'e0'));
    assert.ok(stat.isDirectory(), 'the directory really exists');
    const outside = await uiCall(host, 'fs_list', { path: 'made' })
        .then((r) => JSON.stringify(r));
    assert.match(outside, /e0/, 'fs_list sees the created entry');
  } finally {
    await host.close();
  }
});
