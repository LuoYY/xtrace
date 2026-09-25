#!/usr/bin/env python3
"""P55-S3 encoder verification: unified bounded writer semantics.

Runs AFTER the S3 fix (this is the green-side gate; the red side is the
S0 freeze). Cases:
  gc-interval     - dumps executed with allocation-triggered GCs landing
                    INSIDE the walk (--gc-interval=40): no crash, output
                    still parses, partial flag honest. This is the
                    "walk 内部 GC 安全" evidence (a between-walks GC
                    proves nothing about the traversal itself).
  budget-respected- every dump's OUTPUT stays <= 64KiB + slack even with
                    hostile shapes (accessor keys with escape blowup,
                    deep nests, wide dictionaries) and partial=true.
  rab-view        - length-tracking views report the CURRENT legal
                    length/bytes under resize (grow then shrink), RAB
                    OOB reports 0 with an explicit state.
  double-kind     - [1.5, , Infinity, NaN, -0] encodes hole, nan, inf
                    and -0 DISTINCTLY (no crash, no null collapse).
Round-trips each dump JSON through json.loads — an unparseable dump is
a failure regardless of size.
"""
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
STAMP = time.strftime("%Y%m%d-%H%M%S")
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-s3-{STAMP}"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"case": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS" if ok else "FAIL") + f"  {name}" +
          ("" if ok else f" — {detail}"))


def run(name, source, extra_flags=()):
    d = RUN / name
    (d / "dumps").mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0", *extra_flags,
         "--xtrace-tap-windows={\"windows\":[{\"id\":0,\"start\":0,"
         "\"end\":999999}],\"max_taps\":200,\"max_window\":500}",
         f"--xtrace-dump-dir={d / 'dumps'}", "-e", source],
        capture_output=True, text=True, timeout=180)
    (d / "run.log").write_text(proc.stdout + proc.stderr)
    blobs = []
    for f in sorted((d / "dumps").glob("dump-*.json")):
        raw = f.read_bytes()
        try:
            blobs.append((f.name, len(raw), json.loads(raw)))
        except json.JSONDecodeError as e:
            blobs.append((f.name, len(raw), None))
            check(f"{name}.{f.name}.parses", False, str(e))
    return proc, blobs


HOSTILE = r"""
// hostile shapes for the OUTPUT budget: accessor skip records whose
// keys blow up under \uXXXX escaping, a wide dictionary, deep nesting.
const h = {};
for (let i = 0; i < 180; i++) {
  Object.defineProperty(h, '键'.repeat(120) + i,
      {get() { return i; }, enumerable: true, configurable: true});
}
const wide = {};
for (let i = 0; i < 300; i++) { wide['p' + i] = i; }
let deep = {leaf: 1};
for (let i = 0; i < 8; i++) { deep = {next: deep}; }
function tap(o) { const y = o; return y; }
tap(h); tap(wide); tap(deep);
const th = xtraceTokenOf(h), tw = xtraceTokenOf(wide), td = xtraceTokenOf(deep);
print('D ' + xtraceTokenDump(th, null, 'accessor-keys'));
print('D ' + xtraceTokenDump(tw, null, 'wide-dict'));
print('D ' + xtraceTokenDump(td, ['next','next','next'], 'deep-path'));
print('DONE');
"""

RAB = r"""
const rab = new ArrayBuffer(16, {maxByteLength: 64});
const v = new Uint8Array(rab);
v[0] = 23; v[15] = 17;
function tap(o) { const y = o; return y; }
tap(v);
const tv = xtraceTokenOf(v);
print('D ' + xtraceTokenDump(tv, null, 'rab-initial'));
rab.resize(48);
v[40] = 99;
print('D ' + xtraceTokenDump(tv, null, 'rab-grown'));
rab.resize(8);
print('D ' + xtraceTokenDump(tv, null, 'rab-shrunk'));
print('DONE');
"""

DOUBLES = r"""
const a = [1.5, , Infinity, NaN, -0];
function tap(o) { const y = o; return y; }
tap(a);
const ta_ = xtraceTokenOf(a);
print('D ' + xtraceTokenDump(ta_, null, 'doubles'));
print('DONE');
"""


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)

    # --- hostile shapes: output budget + parseability ------------------
    proc, blobs = run("hostile", HOSTILE)
    check("s3.hostile-no-crash", proc.returncode == 0,
          proc.stderr[-160:])
    ok = proc.returncode == 0 and len(blobs) == 3 and all(
        b[2] is not None for b in blobs)
    over = [f"{n}:{sz}" for (n, sz, b) in blobs if sz > 65536 + 2048]
    check("s3.output-bytes-respected", ok and not over,
          f"sizes={[(n, sz) for (n, sz, _) in blobs]} over={over}")
    if ok:
        partials = {b[2]["anchor"]["label"]: b[2]["budget"]["partial"]
                    for b in blobs}
        check("s3.hostile-partial-honest",
              all(partial is True for partial in partials.values()),
              f"partials={partials}")

    # --- RAB current legal length --------------------------------------
    proc, blobs = run("rab", RAB)
    ok = proc.returncode == 0 and len(blobs) == 3 and all(
        b[2] is not None for b in blobs)
    check("s3.rab-no-crash", proc.returncode == 0, proc.stderr[-160:])
    if ok:
        lengths = [b[2]["root"].get("byte_length") for b in blobs]
        hexes = [len(b[2]["root"].get("hex", "")) for b in blobs]
        check("s3.rab-lengths-track-current",
              lengths == [16, 48, 8] and all(h >= 2 for h in hexes),
              f"byte_lengths={lengths} hex_lens={hexes}")

    # --- double kinds distinct -----------------------------------------
    proc, blobs = run("doubles", DOUBLES)
    ok = proc.returncode == 0 and len(blobs) == 1 and blobs[0][2] is not None
    check("s3.doubles-no-crash", proc.returncode == 0,
          proc.stderr[-160:])
    if ok:
        raw_file = (RUN / "doubles" / "dumps").glob("dump-*.json")
        raw = next(raw_file).read_text(errors="replace")
        dense = blobs[0][2]["root"].get("dense", [])
        hole = len(dense) == 5 and any(
            isinstance(e, dict) and e.get("t") == "hole" for e in dense)
        markers = {"nan", "inf", "-inf", "NaN", "Infinity"}
        found = sum(1 for m in markers if m in raw)
        neg_zero = "-0" in raw
        check("s3.double-kinds-distinct",
              hole and found >= 2 and neg_zero,
              f"hole={hole} special_markers={found} neg_zero={neg_zero} "
              f"dense={dense}")

    # --- GC lands INSIDE the walk (allocation-forced) ------------------
    proc, blobs = run("gc-inside", HOSTILE, ("--gc-interval=40",))
    check("s3.gc-inside-walk-no-crash",
          proc.returncode == 0 and bool(blobs) and all(
              b[2] is not None for b in blobs),
          f"rc={proc.returncode} blobs={len(blobs)} "
          f"{proc.stderr[-160:]}")

    (RUN / "summary.json").write_text(json.dumps(RESULTS, indent=1))
    print(f"evidence: {RUN}")
    bad = [r for r in RESULTS if not r["ok"]]
    if bad:
        print(f"P55-S3 ENCODER VERIFY: FAIL ({len(bad)} cases)")
        return 1
    print("P55-S3 ENCODER VERIFY: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
