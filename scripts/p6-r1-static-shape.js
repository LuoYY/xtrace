#!/usr/bin/env node
// P6-R1 static source-shape gate (architect's review anchors):
//   1. createBroker( call sites = composition root + unit tests ONLY
//   2. contains:()=>true / assertInside:(t)=>t stubs: ZERO hits
//   3. resolveConfirmation( call sites in the GUI = ONLY the
//      evidence:confirmation IPC handler
//   4. run_tests.sh includes the xtrace-host suite
//   5. no harness hooks in product paths (window.__xtraceE2E* may only
//      appear in app.js as a labeled accelerator + drivers/tests)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ` — ${detail}`));
}
function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' ||
          e.name === 'dist' || e.name === 'out') {
        continue;
      }
      walk(p, exts, out);
    } else if (exts.includes(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}
const files = walk(ROOT, ['.js', '.cjs', '.mjs']);
const rel = (p) => path.relative(ROOT, p);

// 1. createBroker call sites
const isGateItself = (f) => rel(f) === 'scripts/p6-r1-static-shape.js';
const brokerSites = files.filter((f) => !isGateItself(f))
    .filter((f) =>
    /createBroker\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .filter((f) => !/\/test\//.test(rel(f)) && !rel(f).startsWith('docs/'));
const allowed = (f) => {
  const r = rel(f);
  return r === 'xtrace-host/src/broker.js' ||           // definition
         r === 'xtrace-host/src/host.js' ||             // composition root
         r.startsWith('docs/review-artifacts/');       // architect probes
};
check('createBroker sites = definition + composition root (+probes)',
    brokerSites.every(allowed),
    brokerSites.filter((f) => !allowed(f)).map(rel).join(', ') || 'none outside');

// 2. stub workspaces
const stubs = files.filter((f) => !isGateItself(f))
    .filter((f) =>
    /contains\s*:\s*\(\s*\)\s*=>\s*true/.test(fs.readFileSync(f, 'utf8')) ||
    /assertInside\s*:\s*\(\s*t\s*\)\s*=>\s*t/.test(fs.readFileSync(f, 'utf8')));
check('workspace stubs zero', stubs.length === 0,
    stubs.map(rel).join(', '));

// 3. resolveConfirmation call sites in the GUI product code
const guiFiles = files.filter((f) => rel(f).startsWith('xtrace-gui/src/'));
const resolveSites = guiFiles.filter((f) =>
    /resolveConfirmation\s*\(/.test(fs.readFileSync(f, 'utf8')));
const confirmHandlerOk = resolveSites.every((f) =>
    rel(f) === 'xtrace-gui/src/main/main.js' &&
    /evidence:confirmation/.test(fs.readFileSync(f, 'utf8')));
check('GUI resolveConfirmation only in the confirmation IPC handler',
    confirmHandlerOk, resolveSites.map(rel).join(', '));

// 4. run_tests.sh wires the host suite
const runTests = fs.readFileSync(path.join(ROOT, 'scripts/run_tests.sh'),
    'utf8');
check('run_tests.sh includes xtrace-host suite',
    /xtrace-host/.test(runTests) && /npm.*test/.test(runTests),
    'npm --prefix xtrace-host test expected');

// 5. harness hooks in product paths
const hookFiles = guiFiles.filter((f) =>
    /__xtraceE2E/.test(fs.readFileSync(f, 'utf8')));
const hooksOk = hookFiles.every((f) => rel(f) === 'xtrace-gui/src/renderer/app.js');
check('E2E hooks only in app.js (labeled accelerator)',
    hooksOk, hookFiles.map(rel).join(', '));

const bad = results.filter((r) => !r.ok);
console.log(bad.length
    ? `P6-R1 STATIC SHAPE: FAIL (${bad.length})`
    : 'P6-R1 STATIC SHAPE: GREEN');
process.exit(bad.length ? 1 : 0);
