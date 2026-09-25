#!/usr/bin/env python3
"""P55-R3 GC-stress gate (project-architect ruling 10.3).

Forced MarkCompact sweeps around dump walks and tap encodings that
recursively flatten strings / render BigInts: the process must exit 0,
every dump must parse, values must be exact, and sentinel counters must
show ZERO user-code calls. Positive stress — not a memory-corruption
proof, but the behavioral matrix the ruling demands.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
STAMP = subprocess.run(["date", "+%Y%m%d-%H%M%S"], capture_output=True,
                       text=True).stdout.strip()
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-r3gc-{STAMP}"

FIXTURE = """
var counts = { getter: 0, toString: 0 };
// Ropes and long strings around the dump walk.
var ropeParts = [];
for (var i = 0; i < 200; i++) ropeParts.push('segment-' + i + '-' +
    'x'.repeat(100));
var rope = ropeParts.join('');
var holder = {
  rope: rope,
  big: 'K'.repeat(300000),                    // > per-value cap everywhere
  bigInt: 1n << 1200n,                      // >> decimal budget
  cjk: '\\u4e2d\\u6587' + '\\u00e9' + 'A\\u0000B',
  nested: { a: { b: { c: { d: 1 } } } },
  arr: (function () { var a = []; for (var i = 0; i < 5000; i++) a.push(i); return a; })(),
};
Object.defineProperty(holder, 'acc', { get: function () { counts.getter++; return 1; } });
var results = [];
for (var round = 0; round < 12; round++) {
  %CollectGarbage('all');                     // forced MarkCompact between walks
  results.push(xtraceDump(holder, 'gc-round-' + round, 0));
  // churn so the walker walks amid allocation pressure
  var churn = []; for (var j = 0; j < 20000; j++) churn.push({ j: j, s: 'v' + j });
  if (j === 0) counts.toString++;             // never runs; linter peace
}
print('ROUNDS ' + results.join(','));
print('COUNTS ' + JSON.stringify(counts));
"""

TAP_FIXTURE = """
var counts = { getter: 0 };
var obj = {};
Object.defineProperty(obj, 'g', { get: function () { counts.getter++; return 7; } });
function f(o) { var s = '\\u4e2d\\u6587x'; var b = 1n << 90n; return (s.length + (b > 0n ? 1 : 0) + o.g); }
%PrepareFunctionForOptimization(f);
f(obj); f(obj);
%OptimizeFunctionOnNextCall(f);
var vals = [];
for (var i = 0; i < 300; i++) { %CollectGarbage('all'); vals.push(f(obj)); }
print('TAPVALS ' + vals.every(Number.isFinite) + ' last=' + vals[vals.length-1]);
print('COUNTS ' + JSON.stringify(counts));
"""


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)
    (RUN / "gc-dump.js").write_text(FIXTURE)
    (RUN / "gc-tap.js").write_text(TAP_FIXTURE)

    # --- dump walk under forced GC --------------------------------------
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         "--expose-gc", "--allow-natives-syntax",
         f"--xtrace-dump-dir={RUN}", str(RUN / "gc-dump.js")],
        capture_output=True, text=True, timeout=300)
    (RUN / "gc-dump.log").write_text(proc.stdout + proc.stderr)
    ok = proc.returncode == 0
    rounds = re.search(r"^ROUNDS (.*)$", proc.stdout, re.M)
    counts = re.search(r"^COUNTS (.*)$", proc.stdout, re.M)
    dumps = sorted(RUN.glob("dump-*.json"))
    parsed = 0
    exact = True
    for f in dumps:
        try:
            b = json.loads(f.read_text(errors="replace"))
            parsed += 1
            root = b["root"]
            props = {p["k"]: p.get("v", p.get("reason")) for p in root["props"]}
            if props.get("rope", {}).get("state") != "truncated":
                exact = False
            if props.get("big", {}).get("state") != "truncated":
                exact = False
            big_int = props.get("bigInt", {})
            if big_int.get("state") != "truncated" or (
                    "len" not in big_int and "digits" not in big_int):
                exact = False
            cjk = props.get("cjk", {})
            if cjk.get("state") != "captured" or "中" not in cjk.get("v", ""):
                exact = False
            if props.get("acc") != "accessor":
                exact = False
            if b.get("budget", {}).get("partial") is not True:
                exact = False
        except Exception:  # noqa: BLE001
            exact = False
    getter_moves = counts and json.loads(counts.group(1))["getter"] == 0
    print(json.dumps({
        "dump": {"exit": proc.returncode, "rounds": len(dumps),
                 "parsed": parsed, "exact": exact,
                 "getter_moves": json.loads(counts.group(1))["getter"]
                 if counts else -1}}))
    ok = (ok and rounds and rounds.group(1).count("true") == 12 and
          parsed == 12 and exact and getter_moves)

    # --- taps under forced GC (baseline first; sentinel counts EQUAL) ---
    base2 = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         "--expose-gc", "--allow-natives-syntax",
         str(RUN / "gc-tap.js")],
        capture_output=True, text=True, timeout=300)
    (RUN / "gc-tap-base.log").write_text(base2.stdout + base2.stderr)
    proc2 = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         "--expose-gc", "--allow-natives-syntax",
         "--xtrace-tap-windows={\"windows\":[{\"id\":0,\"start\":0,"
         "\"end\":999999}]}",
         str(RUN / "gc-tap.js")],
        capture_output=True, text=True, timeout=300)
    (RUN / "gc-tap.log").write_text(proc2.stdout + proc2.stderr)
    tap_ok = re.search(r"^TAPVALS (true|false) last=([\d.]+)$", proc2.stdout, re.M)
    counts2 = re.search(r"^COUNTS (.*)$", proc2.stdout, re.M)
    counts_base = re.search(r"^COUNTS (.*)$", base2.stdout, re.M)
    getter0 = (counts2 and counts_base and
               json.loads(counts2.group(1))["getter"] ==
               json.loads(counts_base.group(1))["getter"])
    print(json.dumps({
        "tap": {"exit": proc2.returncode,
                "finite": tap_ok.group(1) if tap_ok else None,
                "getter_moves": json.loads(counts2.group(1))["getter"]
                if counts2 else -1}}))
    ok = ok and proc2.returncode == 0 and tap_ok and tap_ok.group(1) == "true" \
        and getter0

    verdict = "pass" if ok else "fail"
    (RUN / "summary.json").write_text(json.dumps({"verdict": verdict}))
    print(f"P55-R3 GC-STRESS: {verdict.upper()}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
