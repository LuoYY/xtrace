// P4-N1 (review R1): weak-handle COLLECTION must not kill the process.
// 40 short dynamic functions go out of scope, then explicit GC fires the
// registry's weak callbacks. Observer ON must exit 0 and print the
// sentinel — the merged-bool-era build exited -5 with
// "Handle not reset in first callback". The control run (observer OFF)
// proves the script itself is benign.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const d8 = path.resolve(__dirname, '../chromium/src/out/XTraceP4D8/d8');
const outDir = path.join(path.dirname(d8), 'validation', 'p4-n1-weak-gc');
fs.mkdirSync(outDir, { recursive: true });

const script = `
function allocate(){for(let i=0;i<40;i++){const f=new Function('x','return x+'+i);f(1);}}
allocate(); gc(); gc();
print('REVIEW_GC_SURVIVED');
`;

// R1 acceptance: compile cache OFF and ON are separate cases. With the
// cache ON the dynamic functions stay retained (no weak callbacks fire);
// with it OFF they become unreachable and the registry's first-pass weak
// callbacks run — the re-review's fatal path (-5, "Handle not reset in
// first callback") is the OFF case with the observer on.
for (const [name, flags] of [
  ['observer-on-cache-off', ['--no-compilation-cache', '--xtrace-observer-smoke']],
  ['observer-on-cache-on', ['--xtrace-observer-smoke']],
  ['observer-off-control', ['--no-compilation-cache']],
]) {
  const run = spawnSync(d8,
      ['--max-opt=0', '--expose-gc', ...flags, '-e', script],
      { encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(outDir, `${name}.stdout`), run.stdout || '');
  fs.writeFileSync(path.join(outDir, `${name}.stderr`), run.stderr || '');
  fs.writeFileSync(path.join(outDir, `${name}.status`), String(run.status));
  console.log(`${name}: exit=${run.status} survived=${(run.stdout || '').includes('REVIEW_GC_SURVIVED')}`);
  if (run.stderr) console.log(`${name} stderr: ${run.stderr.slice(0, 200)}`);
  assert.strictEqual(run.status, 0, `${name}: d8 exited ${run.status}`);
  assert.ok((run.stdout || '').includes('REVIEW_GC_SURVIVED'),
      `${name}: sentinel missing`);
}
console.log('PASS: weak-handle collection survives GC in both states');
console.log(`Evidence: ${outDir}`);
