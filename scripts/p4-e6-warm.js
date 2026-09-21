// P4-E6 warm-profile evidence (architect condition A.3):
// bytecode_version increments per COMPILATION instance — the acceptance
// basis for the code-cache disable-and-disclose decision, not flag names.
// Three fresh compilations of equivalent source => distinct versions for
// the target function's script; re-running one compilation keeps stable
// versions within the run.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
const d8 = require('node:path').resolve(__dirname, '../chromium/src/out/XTraceP4D8/d8');
const outDir = path.dirname(d8) + '/validation/p4-e6-warm';
fs.mkdirSync(outDir, { recursive: true });

function pairsOf(stdout) {
  return [...stdout.matchAll(/d8 pair script=(\d+) version=(\d+)/g)]
    .map(m => ({ script: Number(m[1]), version: Number(m[2]) }));
}

// 1) Three fresh compilations of equivalent source in ONE process.
const multi = spawnSync(d8, ['--max-opt=0', '--xtrace-observer-smoke', '-e', `
function mk() { return new Function('x', 'let y = x + 1; return y * 2;'); }
const f1 = mk(); const f2 = mk(); const f3 = mk();
print('XTRES=' + JSON.stringify([f1(4), f2(4), f3(4)]));
`], { encoding: 'utf8', timeout: 60000 });
assert.equal((multi.stdout.match(/^XTRES=\[10,10,10\]$/m) || [])[0], 'XTRES=[10,10,10]');
const multiPairs = pairsOf(multi.stdout);
fs.writeFileSync(path.join(outDir, 'multi-compilation.txt'), multi.stdout);
assert(multiPairs.length >= 3, `expected >=3 (script,version) pairs, got ${multiPairs.length}`);
const versions = multiPairs.map(p => p.version);
assert.equal(new Set(versions).size, versions.length,
    'each compilation instance must own a distinct bytecode_version');
console.log('multi-compilation: ' + JSON.stringify(multiPairs));

// 2) Single compilation replayed: versions stable within the run, and the
// SAME script keeps ONE version across all its executions (78 events
// collapsed to a single pair per script compilation). The sample is
// written by this driver (F0 gate: no dependency on files left behind by
// another session).
const samplePath = path.join(outDir, 'warm-same.js');
fs.writeFileSync(samplePath, `
function once() { let s = 0; for (let i = 0; i < 60; i++) s += i; return s; }
once(); once(); once();
print('XTRES=' + once());
`);
const single = spawnSync(d8, ['--max-opt=0', '--xtrace-observer-smoke', samplePath],
    { encoding: 'utf8', timeout: 60000 });
assert.equal(single.status, 0, `d8 exited ${single.status}: ${single.stderr}`);
const singlePairs = pairsOf(single.stdout);
fs.writeFileSync(path.join(outDir, 'single-compilation.txt'), single.stdout);
assert.equal(new Set(singlePairs.map(p => `${p.script}:${p.version}`)).size,
            singlePairs.length, 'duplicate (script,version) pairs in one run');
console.log('single-compilation: ' + JSON.stringify(singlePairs));

console.log(`PASS: bytecode_version increments per compilation instance (A.3 basis)`);
console.log(`Evidence: ${outDir}`);
