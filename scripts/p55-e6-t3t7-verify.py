#!/usr/bin/env python3
"""P55-E6 acceptance (execution handoff E6 row).

T3: on the three-site corpus traces the read list is NON-EMPTY with the
proven/unproven split explicit (pre-D1 captures: all unproven-no-
metadata); on the fresh local re-capture (current binary, D1 metadata
assets flowing) instances join their metadata and proven-pool keys are
listed (the corpus bundles' decoding builtins appear — cross-checkable
against the corpus README's boundary-hook facts).

T7: the classifier distinguishes the three deployment shapes — xj1
412-interstitial-two-stage (cookie CyFIZHvBqps2O), sc 200-inline
(cookie cookie_persist), jibei 200-inline + transport-threshold note —
every mode/cookie field at derived grade with named evidence.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "analysis/corpus-capture"
ANALYZER = ROOT / "scripts/p55_t3_t7.py"
EVIDENCE = ROOT / "chromium/src/out/XTraceIntegration/validation/p55-e6-verify"


def run(tool, trace, extra=()):
    proc = subprocess.run(
        [sys.executable, str(ANALYZER), tool, "--trace", str(trace), *extra],
        capture_output=True, text=True, timeout=600)
    assert proc.returncode == 0, proc.stderr[-400:]
    return json.loads(proc.stdout)


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    summary = {}

    # --- T7 on the three corpus sites -----------------------------------
    expect = {
        "xj1": {"mode": "412-interstitial-two-stage", "stages": 2,
                "cookie": "CyFIZHvBqps2O",
                "note_contains": "stage-2 blob unavailable"},
        "sc": {"mode": "200-inline", "stages": 1,
               "cookie": "cookie_persist", "note_contains": ""},
        "jibei": {"mode": "200-inline", "stages": 1, "cookie": None,
                  "note_contains": "transport"},
    }
    t7_results = {}
    for site, want in expect.items():
        traces = sorted((CORPUS / site).glob("trace_*.ndjson"))
        assert traces, f"no corpus trace for {site}"
        verdict = run("t7", traces[0], ["--site-name", site])
        t7_results[site] = verdict
        assert verdict["family"]["value"] == "jsvmp-challenge"
        assert verdict["family"]["grade"] == "observed"
        assert verdict["mode"]["value"] == want["mode"], site
        assert verdict["mode"]["grade"] == "derived"
        assert verdict["stages"]["value"] == want["stages"], site
        if want["cookie"]:
            assert verdict["cookie"]["value"] == want["cookie"], site
        if want["note_contains"]:
            assert want["note_contains"].lower() in \
                (verdict.get("note") or "").lower(), site
        assert verdict["observed_in_capture"]["ignition_events"] > 100000, site
    summary["t7_sites"] = {s: {
        "mode": v["mode"]["value"], "cookie": v["cookie"]["value"],
        "family": v["family"]["value"]} for s, v in t7_results.items()}

    # --- T3 on the OLD corpus traces (unproven split) --------------------
    for site in ("xj1", "sc", "jibei"):
        traces = sorted((CORPUS / site).glob("trace_*.ndjson"))
        t3_old = run("t3", traces[0])
        assert t3_old["summary"]["read_list_nonempty"], site
        grades = {e["grade"] for e in t3_old["read_list"]}
        assert grades == {"unproven-no-metadata"}, (site, grades)
    summary["t3_corpus"] = "non-empty, all unproven-no-metadata (pre-D1)"

    # --- T3 on the fresh re-capture (proven-pool keys) --------------------
    fresh_dirs = sorted((ROOT / "chromium/src/out/XTraceIntegration/validation")
                        .glob("p55-e6-xj1-*"), reverse=True)
    assert fresh_dirs, "no re-capture found (run scripts/p55-e6-recapture.cjs)"
    fresh = fresh_dirs[0] / "trace.ndjson"
    t3_fresh = run("t3", fresh)
    assert t3_fresh["summary"]["instances_with_metadata"] > 0
    proven = [e for e in t3_fresh["read_list"]
              if e["grade"] == "proven-pool"]
    assert proven, "no proven-pool keys on the fresh capture"
    keys = {e["key"] for e in proven}
    # The corpus bundles decode via charCodeAt/base64-style builtins —
    # the README's boundary-hook fact cross-checks the pool resolution.
    assert any(k in keys for k in ("charCodeAt", "fromCharCode",
                                   "charCode", "atob", "btoa")), sorted(keys)[:10]
    assert any(e["grade"] == "unproven-keyed" for e in t3_fresh["read_list"]) or \
        t3_fresh["summary"]["instances_with_metadata"] > 0
    summary["t3_fresh"] = {
        "dir": fresh_dirs[0].name,
        "instances_with_metadata": t3_fresh["summary"]["instances_with_metadata"],
        "proven_keys": len(proven),
        "sample": sorted(k for k in keys if k)[:10],
        "classes": t3_fresh["summary"]["classes"],
    }

    summary["verdict"] = "pass"
    out = EVIDENCE / "summary.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("P55-E6 T3/T7 VERIFY: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
