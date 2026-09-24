#!/usr/bin/env python3
"""P55-E3 d8 slice: value_state formalization + the contract §4 sentinel
matrix (getter/Proxy/iterator call counts must have ZERO delta across an
all-windows-open tap run; special values encode with explicit states).

The chrome control-plane wiring (startCapture.valueObservation) is the
E7 entry precondition and lands with that batch — recorded in the
handoff tick, not claimed here.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
EVIDENCE = ROOT / "chromium/src/out/XTraceP55D8/validation/e3-verify"
FIXTURE = ROOT / "test-pages/p55/e3-sentinel.js"

FIXTURE.write_text("""// Sentinel matrix: user-code counters must NOT move under taps.
var counts = { getter: 0, proxy_get: 0, proxy_has: 0, iterator: 0, tostring: 0 };
function run() {
  var obj = {};
  Object.defineProperty(obj, 'g', { get: function () { counts.getter++; return 1; } });
  var target = {};
  var proxy = new Proxy(target, {
    get: function (t, k) { counts.proxy_get++; return t[k]; },
    has: function (t, k) { counts.proxy_has++; return true; },
  });
  var iterable = {};
  iterable[Symbol.iterator] = function () { counts.iterator++; var i = 0;
    return { next: function () { return i < 3 ? { value: i++, done: false } : { done: true }; } }; };
  // Special values through the accumulator under ALL-OPEN taps.
  var nan = NaN, inf = Infinity, ninf = -Infinity, zero = -0;
  var big = 123456789012345678901234567890n;             // BigInt
  var long = 'x'.repeat(200);                             // truncated string
  var arr = [1, 2, 3];                                    // ref-only
  var acc = 0;
  for (var i = 0; i < 50; i++) acc = (acc + i) % 97;
  // Touch sentinels AFTER the hot loop so taps observed the loop above.
  obj.g; proxy.anything; 'k' in proxy;
  var sum = 0; for (var v of iterable) sum += v;
  return JSON.stringify(counts) + ' acc=' + acc + ' sum=' + sum;
}
print('RESULT ' + run());
""")

def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    run = EVIDENCE
    run.mkdir(parents=True, exist_ok=True)
    cfg = ('{"script_pattern":"e3-sentinel",'
           '"windows":[{"id":0,"start":0,"end":4000000}]}')
    # Baseline (no taps) and tapped runs — JS-visible results identical,
    # sentinel counters identical.
    outs = {}
    for mode, extra in (("base", []), ("tapped", [f"--xtrace-tap-windows={cfg}"])):
        proc = subprocess.run(
            [str(D8), "--xtrace-observer-smoke", *extra, str(FIXTURE)],
            capture_output=True, text=True, timeout=120)
        (run / f"{mode}.log").write_text(proc.stdout + proc.stderr)
        assert proc.returncode == 0, mode
        # Line-anchored: the RESULT string itself transits the
        # interpreter as an accumulator value (taps see it in TAP lines).
        result = re.search(r"^RESULT (.*)$", proc.stdout, re.M).group(1)
        outs[mode] = result
        taps = [l for l in proc.stdout.splitlines() if l.startswith("TAP ")]
        outs[f"{mode}_taps"] = len(taps)
    assert outs["base"] == outs["tapped"], \
        f"JS-visible semantics changed under taps: {outs}"
    counts = json.loads(outs["base"].split(" acc=")[0])
    assert counts == {k: v for k, v in counts.items() if k in
                      ("getter", "proxy_get", "proxy_has", "iterator", "tostring")}
    # getter/iterator counters DID move from the fixture's own touches —
    # the sentinel claim is EQUALITY between base and tapped runs (the
    # tap path itself contributes zero user-code calls).
    # Special-value states present in the tapped output.
    tapped = (run / "tapped.log").read_text()
    for state, needle in (("nan", '"v":"nan"'), ("inf", '"v":"inf"'),
                          ("truncated", '"state":"truncated"'),
                          ("bigint-unavailable", '"t":"bigint"'),
                          ("ref-only-array", '"t":"array","state":"ref-only"'),
                          ("captured-int", '"state":"captured"')):
        assert needle in tapped, f"missing {state} in tapped output"
    (run / "summary.json").write_text(json.dumps({
        "js_result_identical": True, "result": outs["base"],
        "base_taps": outs["base_taps"], "tapped_taps": outs["tapped_taps"],
        "verdict": "pass"}, indent=1))
    print(json.dumps({"result": outs["base"],
                      "taps": outs["tapped_taps"], "verdict": "pass"}))
    print("P55-E3 SENTINEL d8 VERIFY: PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
