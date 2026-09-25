#!/usr/bin/env python3
"""P55-S5 performance bench: phase-separated, zero per-event printing.

Re-review RR6 ruling: no per-event printf may sit in the measured path
(d8 taps/observations are COUNTED — the counters print once at exit),
and the report must separate gate/predicate/encode phases with every
round's stdout/stderr/exit code and effective tap counts preserved.
Transport/write (the browser-side settle) is evidenced separately by
the browser gates (interleave/config drivers) and is cited, not
re-measured here.

Phases (same fixed workload, fixed tier via --max-opt=0):
  baseline    observer switch absent  — dispatch-cost floor
  gate-only   gate open, NO windows   — adds the gate+registry lookup
  full-tap    windows + budgets       — adds predicate hit + encode
Per-event phase deltas = (phase_time - prev_time) / observer_events.
"""
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
STAMP = time.strftime("%Y%m%d-%H%M%S")
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-s5-perf-{STAMP}"
ROUNDS = 5
ITER = "6000000"
WORKLOAD = (f"function work(n){{var acc=0;for(var i=0;i<n;i++)"
            f"{{acc=(acc+i*7)&0xffff;}}return acc;}}"
            f"work({ITER});print('W'+work(1));")
WINDOWS = ('{"windows":[{"id":0,"start":0,"end":999999999}],'
           '"max_taps":100000,"max_window":100000}')

CONFIGS = {
    "baseline": ["--max-opt=0"],
    "gate-only": ["--xtrace-observer-smoke", "--max-opt=0"],
    "full-tap": ["--xtrace-observer-smoke", "--max-opt=0",
                 f"--xtrace-tap-windows={WINDOWS}"],
}


def one_round(config, flags, r):
    d = RUN / config / f"r{r}"
    d.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    proc = subprocess.run([str(D8), *flags, "-e", WORKLOAD],
                          capture_output=True, text=True, timeout=300)
    elapsed = time.perf_counter() - started
    (d / "stdout.log").write_text(proc.stdout)
    (d / "stderr.log").write_text(proc.stderr)
    counters = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"XTRACE-P55 d8 tap events=(\d+) hits=(\d+) skips=(\d+)", line)
        if m:
            counters["tap_events"], counters["hits"], counters["skips"] = \
                (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = re.match(r"XTRACE-P4 d8 observer events=(\d+)", line)
        if m:
            counters["observer_events"] = int(m.group(1))
    # ZERO per-event printing: the default path must not emit TAP/OBS
    per_event_lines = sum(1 for l in proc.stdout.splitlines()
                          if l.startswith("TAP ") or l.startswith("OBS "))
    return {
        "round": r, "exit": proc.returncode, "wall_s": round(elapsed, 3),
        "counters": counters, "per_event_lines": per_event_lines,
        "work_ok": "W0" in proc.stdout or "W" in proc.stdout,
    }


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)
    report = {"rounds": ROUNDS, "iterations": int(ITER), "configs": {}}
    problems = []
    for config, flags in CONFIGS.items():
        rounds = []
        for r in range(1, ROUNDS + 1):
            res = one_round(config, flags, r)
            rounds.append(res)
            if res["exit"] != 0:
                problems.append(f"{config} r{r}: exit {res['exit']}")
            if res["per_event_lines"] != 0:
                problems.append(f"{config} r{r}: {res['per_event_lines']} "
                                "per-event lines printed")
        walls = sorted(x["wall_s"] for x in rounds)
        median = walls[len(walls) // 2]
        obs = [x["counters"].get("observer_events", 0) for x in rounds]
        hits = [x["counters"].get("hits", 0) for x in rounds]
        report["configs"][config] = {
            "median_wall_s": median,
            "walls": walls,
            "observer_events_consistent": len(set(obs)) == 1,
            "observer_events": obs[0] if obs else 0,
            "tap_hits": hits[0] if hits else 0,
            "per_event_lines_total": sum(x["per_event_lines"] for x in rounds),
        }
    # phase deltas (medians)
    b = report["configs"]["baseline"]["median_wall_s"]
    g = report["configs"]["gate-only"]["median_wall_s"]
    f = report["configs"]["full-tap"]["median_wall_s"]
    events = report["configs"]["gate-only"]["observer_events"] or 1
    report["phases"] = {
        "gate_plus_lookup_ns_per_event": round((g - b) / events * 1e9, 2),
        "predicate_plus_encode_ns_per_event": round((f - g) / events * 1e9, 2),
        "full_overhead_ns_per_event": round((f - b) / events * 1e9, 2),
        "note": "transport/write (browser-side settle) is evidenced by "
                "the browser gates (p55-s2-config-interleave et al.), "
                "not re-measured in d8",
    }
    if report["configs"]["full-tap"]["tap_hits"] <= 0:
        problems.append("full-tap config recorded zero tap hits")
    if not report["configs"]["gate-only"]["observer_events_consistent"]:
        problems.append("observer events inconsistent across rounds")
    report["problems"] = problems
    (RUN / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    print(f"evidence: {RUN}")
    if problems:
        print(f"P55-S5 PERF BENCH: FAIL ({len(problems)} problems)")
        return 1
    print("P55-S5 PERF BENCH: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
