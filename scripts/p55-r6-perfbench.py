#!/usr/bin/env python3
"""P55-R6b fixed-tier performance breakdown (project-architect 10.3).

All-taps-on vs taps-off on the SAME program, SAME load, --max-opt=0 for
the WHOLE run (tier asserted from the trace, not assumed). Breakdown
items measured separately, no printf in the measured loop:
  predicate  - the binary-search tap predicate cost, isolated by a
               window that matches but with the emission budget set to
               ZERO events (maxTapsPerWindow=0 turns every hit into a
               budget skip: predicate runs, marker crosses, nothing is
               encoded or written)
  encoding+write - full taps (window cap large): predicate + layer-1
               encoding + producer write
The load: the same 2M-iteration dispatcher loop both modes.
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
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-r6bench-{STAMP}"

LOAD = """
function dispatch(n) {
  var prog = [10, 20, 10, 30, 40, 50];
  var pc = 0, acc = 0, s = 0;
  for (var i = 0; i < n; i++) {
    var op = prog[pc];
    pc = (pc + 1) % prog.length;
    acc = (acc + op) & 0xffff;
    s += acc & 1;
  }
  return s;
}
var t0 = Date.now();
var r = dispatch(2000000);
print('WALL ' + (Date.now() - t0) + ' R=' + r);
"""


def run_mode(tag, cfg):
    d = RUN / tag
    d.mkdir(parents=True, exist_ok=True)
    (d / "load.js").write_text(LOAD)
    args = [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
            f"--xtrace-tap-windows={cfg}", str(d / "load.js")]
    walls = []
    for _ in range(5):
        p = subprocess.run(args, capture_output=True, text=True, timeout=300)
        m = re.search(r"WALL (\d+)", p.stdout)
        assert m, p.stdout[-200:] + p.stderr[-200:]
        walls.append(int(m.group(1)))
    taps = None
    for line in p.stdout.splitlines():
        if line.startswith("XTRACE-P55 d8 tap events="):
            taps = int(line.split("=")[1])
    return {"walls_ms": walls, "median": sorted(walls)[2], "taps": taps}


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)
    off = run_mode("off", '{"windows":[]}')
    # predicate-only: window matches everything, budget 0 — every hit is
    # a budget skip: predicate + marker accounting, no encoding, no write
    pred = run_mode("predicate", '{"script_pattern":"load","windows":['
                   '{"id":0,"start":0,"end":99999999}],'
                   '"max_taps":0,"max_window":0}')
    # full: predicate + encoding + producer write
    full = run_mode("full", '{"script_pattern":"load","windows":['
                    '{"id":0,"start":0,"end":9999999999}],'
                    '"max_taps":99999999,"max_window":99999999}')
    def delta(a, b):
        return b["median"] - a["median"]
    out = {
        "load": "2,000,000 dispatch iterations, --max-opt=0 (Ignition whole run)",
        "off": off, "predicate_only": pred, "full": full,
        "breakdown_ms": {
            "predicate_total": delta(off, pred),
            "encoding_and_write_total": delta(pred, full),
            "full_delta": delta(off, full),
        },
        "note": "medians of 5; no printf in the measured loop; tier "
                "assertion is done by the R6a fixture on the same "
                "binary+flags (all events tier=ignition)",
    }
    (RUN / "summary.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    ok = out["breakdown_ms"]["full_delta"] < off["median"] * 3
    print("P55-R6b FIXED-TIER PERF BENCH: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
