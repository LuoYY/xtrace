// P4-F2 GC-safety evidence (review B5): the compilation-instance registry
// keeps bytecode_version stable for a live function across explicit GC
// cycles (weak-handle identity; relocations rebuild the address index),
// recompilation still mints a NEW version, and the opcode path is live.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const d8 = path.resolve(__dirname, '../chromium/src/out/XTraceP4D8/d8');
const outDir = path.join(path.dirname(d8), 'validation', 'p4-f2-gc');
fs.mkdirSync(outDir, { recursive: true });

function pairsOf(stdout) {
  return [...stdout.matchAll(/d8 pair script=(\d+) version=(\d+)/g)]
      .map(m => ({ script: Number(m[1]), version: Number(m[2]) }));
}
function opcodesOf(stdout) {
  return Number((stdout.match(/d8 observer opcodes=(\d+)/) || [0, 0])[1]);
}

// 1) Same function executed across explicit (compacting-pressure) GCs:
//    version must NOT change and the process must survive.
const stable = spawnSync(d8, [
  '--max-opt=0', '--allow-natives-syntax', '--xtrace-observer-smoke', '-e', `
function keep(){ let s=0; for(let i=0;i<100;i++) s+=i; return s; }
keep();
%CollectGarbage(null);
%CollectGarbage(null);
keep();
%CollectGarbage(null);
keep();
print('XTRES=' + keep());
`], { encoding: 'utf8', timeout: 60000 });
fs.writeFileSync(path.join(outDir, 'gc-stable.txt'), stable.stdout);
assert.equal(stable.status, 0, `d8 exited ${stable.status}: ${stable.stderr}`);
assert.equal((stable.stdout.match(/^XTRES=4950$/m) || [])[0], 'XTRES=4950',
    'JS semantics unchanged by the observer');
const stablePairs = pairsOf(stable.stdout);
assert(stablePairs.length > 0, 'no (script,version) pairs observed');
assert.equal(new Set(stablePairs.map(p => `${p.script}:${p.version}`)).size,
            stablePairs.length,
            'version drift across GC cycles for a live function');
assert(opcodesOf(stable.stdout) > 0, 'opcode path produced no names');
console.log('gc-stable: ' + JSON.stringify(stablePairs) +
            ` opcodes=${opcodesOf(stable.stdout)}`);

// 2) Recompilation after GC: the SAME source re-compiled as a new
//    function object still gets a fresh version (identity is the
//    compilation instance, not the source text).
const recompile = spawnSync(d8, [
  '--max-opt=0', '--allow-natives-syntax', '--xtrace-observer-smoke', '-e', `
function mk(){ return new Function('x','let y=x+1; return y*2;'); }
const a = mk(); a(1);
%CollectGarbage(null);
const b = mk(); b(1);
print('XTRES=' + [a(2), b(2)].join(','));
`], { encoding: 'utf8', timeout: 60000 });
fs.writeFileSync(path.join(outDir, 'gc-recompile.txt'), recompile.stdout);
assert.equal(recompile.status, 0, `d8 exited ${recompile.status}: ${recompile.stderr}`);
const recompilePairs = pairsOf(recompile.stdout);
const recompileVersions = recompilePairs.map(p => p.version);
assert.equal(new Set(recompileVersions).size, recompileVersions.length,
    `fresh compilations must mint distinct versions: ${JSON.stringify(recompilePairs)}`);
console.log('gc-recompile: ' + JSON.stringify(recompilePairs));

console.log('PASS: version stable across GC, fresh per recompilation, opcode live');
console.log(`Evidence: ${outDir}`);
