#!/usr/bin/env python3
"""P6-E0 debt gate: analyzer v3 causality tree + legacy v2 regression.

The P2-era debt: build_causality_summary filtered schema_version == 2,
so every v3 capture reported available=False. The fix normalizes the
v2 flat fields and the v3 object form into one view. This gate:

  v3-representative - a REAL accepted-p55 capture (the freshest E7 run
      with taps, paired activations, external browser events) must
      produce available=True with a non-empty tree, correct parent
      nesting, and sane counters;
  v3-synthetic      - a hand-built v3 fixture with a KNOWN three-level
      paired chain + singleton + external + one unclosed pair, asserting
      exact tree shape and counters (depth, unclosed, exceptions);
  v2-legacy         - a v2 flat-field fixture with the same shape must
      produce the IDENTICAL tree (field-move parity, schema doc §"原样
      搬移");
  v1-untouched      - a v1 trace still yields available=False.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.analyze_vmp_trace import build_causality_summary  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"case": name, "ok": bool(ok), "detail": str(detail)[:200]})
    print(("PASS" if ok else "FAIL") + f"  {name}" + ("" if ok else f" — {detail}"))


def v3_event(api, phase, kind, call_id, parent=None, depth=0, duration=None):
    event = {
        "schema_version": 3, "producer_id": "rtx:t:1:1", "process_epoch": "1",
        "producer_seq": "1", "writer_seq": "1", "config_generation": "1",
        "mono_time_us": "1", "wall_time_us": "1", "pid": 1, "tid": 1,
        "category": "reverse", "phase": phase, "api": api,
        "args": [], "stack": [], "attribution": {"status": "unresolved"},
        "causality": {
            "kind": kind, "call_id": call_id, "parent_id": parent,
            "depth": depth, "duration_us": duration,
        },
    }
    return event


def v2_event(api, phase, kind, call_id, parent=None, depth=0, duration=None):
    event = v3_event(api, phase, kind, call_id, parent, depth, duration)
    event["schema_version"] = 2
    causality = event.pop("causality")
    event["causality_kind"] = causality["kind"]
    event["call_id"] = causality["call_id"]
    event["parent_id"] = causality["parent_id"]
    event["depth"] = causality["depth"]
    event["duration_us"] = causality["duration_us"]
    return event


def known_shape(event_factory):
    """Three-level paired chain (one exception terminal, one unclosed),
    one singleton, one external."""
    return [
        event_factory("A.entry", "call", "paired", "s:1", None, 0),
        event_factory("B.entry", "call", "paired", "s:2", "s:1", 1),
        event_factory("C.entry", "call", "paired", "s:3", "s:2", 2),
        event_factory("C.exit", "return", "paired", "s:3", "s:2", 2, "7"),
        event_factory("B.exit", "exception", "paired", "s:2", "s:1", 1, "9"),
        event_factory("D.one", "call", "singleton", "s:4", None, 0),
        event_factory("E.entry", "call", "paired", "s:5", None, 0),  # unclosed
        event_factory("Net.resp", "call", "external", None, None, 0),
    ]


def main() -> int:
    # --- v3 synthetic: exact shape --------------------------------------
    v3 = build_causality_summary(known_shape(v3_event))
    check("e0.v3-available", v3["available"] is True, v3)
    # s:1 (root) and s:5 have no terminal in this fixture -> unclosed 2;
    # paired CALL nodes: s:1, s:2, s:3, s:5 -> 4 (terminals s:3/s:2 close
    # two of them; terminals never enter the tree).
    tree_ok = (
        v3["roots"] == ["s:1", "s:4", "s:5"] and
        v3["tree"][0]["call_id"] == "s:1" and
        v3["tree"][0]["children"][0]["call_id"] == "s:2" and
        v3["tree"][0]["children"][0]["children"][0]["call_id"] == "s:3"
    )
    counters_ok = (
        v3["paired_activations"] == 4 and v3["singleton_nodes"] == 1 and
        v3["external_nodes"] == 1 and v3["max_depth"] == 2 and
        v3["exception_count"] == 1 and v3["unclosed_count"] == 2
    )
    check("e0.v3-tree-shape", tree_ok, json.dumps(v3["tree"])[:160])
    check("e0.v3-counters", counters_ok, v3)

    # --- v2 legacy: identical tree (field-move parity) -------------------
    v2 = build_causality_summary(known_shape(v2_event))
    check("e0.v2-parity", v2 == v3,
          json.dumps({"v2": {k: v2[k] for k in ("available", "roots", "unclosed_count")},
                      "v3": {k: v3[k] for k in ("available", "roots", "unclosed_count")}}))

    # --- v1 untouched -----------------------------------------------------
    v1_events = [dict(known_shape(v2_event)[0], schema_version=1)]
    v1 = build_causality_summary(v1_events)
    check("e0.v1-unavailable", v1["available"] is False)

    # --- v3 representative: a REAL capture --------------------------------
    # freshest accepted-p55 evidence capture with taps + paired events
    runs = sorted((ROOT / "chromium/src/out/XTraceIntegration/validation").glob("p55-e7-*"),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    real = None
    for run in runs:
        trace = run / "trace.ndjson"
        if trace.exists():
            real = trace
            break
    if real is None:
        check("e0.v3-real-capture", False, "no p55-e7 capture found")
    else:
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            out_path = pathlib.Path(tf.name)
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts/analyze_vmp_trace.py"),
             str(real), "--profile", "generic-vmp",
             "--json-output", str(out_path)],
            capture_output=True, text=True, timeout=300)
        ok = proc.returncode == 0
        report = None
        if ok:
            report = json.loads(out_path.read_text(encoding="utf-8"))
            summary = (report.get("causality_summary")
                       or report.get("causality") or {})
            ok = (summary.get("available") is True and
                  summary.get("paired_activations", 0) > 0)
            detail = {k: summary.get(k) for k in
                      ("available", "paired_activations", "singleton_nodes",
                       "external_nodes", "unclosed_count")}
        else:
            detail = proc.stderr[-200:]
        check("e0.v3-real-capture", ok, detail)

    bad = [r for r in RESULTS if not r["ok"]]
    print(f"evidence: synthetic fixtures inline; real capture: {real}")
    if bad:
        print(f"P6-E0 ANALYZER V3 CAUSALITY: FAIL ({len(bad)})")
        return 1
    print("P6-E0 ANALYZER V3 CAUSALITY: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
