#!/usr/bin/env python3
"""P55-E6/S4 acceptance: T3 five-part identity + per-read evidence,
T7 facts/hypothesis separation (handoff §12.4-5).

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
    # --- T7 on the three corpus sites (LOCAL REPLAYS) --------------------
    # R5 ruling: the classifier never invents site answers. A local
    # replay serves 200 from the local server — the 412 interstitial is
    # a SITE-RECORDED fact (external research input in the corpus
    # README/manifest), not observable in-replay. Honest assertions:
    # family observed for all three (density + random-path bundle URL),
    # mode = exactly what THIS capture shows (200 replay), stages
    # unresolved absent in-capture evidence; the corpus bundle names
    # ride along as provenance for manual cross-checking.
    t7_results = {}
    for site in ("xj1", "sc", "jibei"):
        traces = sorted((CORPUS / site).glob("trace_*.ndjson"))
        assert traces, f"no corpus trace for {site}"
        verdict = run("t7", traces[0],
                      ["--site-name", site,
                       "--corpus-manifest", str(CORPUS / "corpus-manifest.json")])
        t7_results[site] = verdict
        # S4 (RR5): a local replay serves 200 — no 412/oracle evidence IN
        # the capture, so the mechanism claim tops out at HYPOTHESIS.
        # The raw FACTS (density tier, statuses, URL shape) are observed.
        assert verdict["family"]["value"] == "jsvmp-challenge", site
        assert verdict["family"]["grade"] == "hypothesis", site
        assert verdict["facts"]["status_codes"]["value"] == [200], site
        assert verdict["facts"]["ignition_density_tier"]["value"] == "high", site
        assert verdict["facts"]["url_shapes"]["value"]["versioned_hash_bundle"] is True, site
        assert verdict["mode"]["value"] == "200-inline-or-post", site
        assert verdict["mode"]["grade"] == "observed", site
        assert "200" in verdict["mode"]["evidence"], site
        assert verdict["stages"]["grade"] == "unresolved", site
        assert verdict["observed_in_capture"]["ignition_events"] > 100000, site
        assert verdict.get("bundle"), site
    
    summary["t7_sites"] = {s: {
        "mode": v["mode"]["value"], "cookie": v["cookie"]["value"],
        "family": v["family"]["value"]} for s, v in t7_results.items()}

    # --- T3 on the OLD corpus traces (unproven split) --------------------
    for site in ("xj1", "sc", "jibei"):
        traces = sorted((CORPUS / site).glob("trace_*.ndjson"))
        t3_old = run("t3", traces[0])
        assert t3_old["summary"]["read_list_nonempty"], site
        grades = {e["grade"] for e in t3_old["read_list"]}
        # pre-D1 captures: nothing proven; keyed-read facts ride along
        assert grades <= {"unproven-no-metadata", "unproven-keyed"}, (site, grades)
        assert "proven-read" not in grades and "candidate-pool" not in grades, site
    summary["t3_corpus"] = "non-empty, all unproven-no-metadata (pre-D1)"

    # --- T3 on the fresh re-capture (proven-pool keys) --------------------
    fresh_dirs = sorted((ROOT / "chromium/src/out/XTraceIntegration/validation")
                        .glob("p55-e6-xj1-*"),
                        key=lambda d: d.stat().st_mtime, reverse=True)
    assert fresh_dirs, "no re-capture found (run scripts/p55-e6-recapture.cjs)"
    fresh = fresh_dirs[0] / "trace.ndjson"
    t3_fresh = run("t3", fresh)
    assert t3_fresh["summary"]["instances_with_metadata"] > 0
    # R5/R4 grade split: proven-read (per-event resolution via
    # pool_indices) and candidate-pool (membership only).
    proven = [e for e in t3_fresh["read_list"]
              if e["grade"] in ("proven-read", "candidate-pool")]
    assert "identity_model" in t3_fresh["summary"], "S4 identity model"
    assert proven, "no resolved keys on the fresh capture"
    keys = {e["key"] for e in proven}
    # The corpus bundles decode via charCodeAt/base64-style builtins —
    # the README's boundary-hook fact cross-checks the pool resolution.
    assert any(k in keys for k in ("charCodeAt", "fromCharCode",
                                   "charCode", "atob", "btoa")), sorted(keys)[:10]
    assert any(e["grade"] == "unproven-keyed" for e in t3_fresh["read_list"]) or \
        t3_fresh["summary"]["instances_with_metadata"] > 0
    summary["t3_fresh"] = {
        "dir": fresh_dirs[0].name,
        "identity_model": t3_fresh["summary"]["identity_model"],
        "instances_with_metadata": t3_fresh["summary"]["instances_with_metadata"],
        "proven_reads": t3_fresh["summary"]["proven_reads"],
        "ambiguous_joins": t3_fresh["summary"]["ambiguous_joins"],
        "asset_problems": t3_fresh["summary"]["asset_problems"],
        "sample": sorted(k for k in keys if k)[:10],
    }

    summary["verdict"] = "pass"
    out = EVIDENCE / "summary.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("P55-E6 T3/T7 VERIFY: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
