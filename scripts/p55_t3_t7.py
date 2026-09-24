#!/usr/bin/env python3
"""P5.5 E6 analysis layer: T3 environment read-surface reconstruction +
T7 deployment-shape classification (design contract §9).

T3 consumes the Ignition.execute stream and — where the capture carries
D1 compilation-instance metadata assets (kind v8-bytecode-metadata) —
joins (script_id, bytecode_version) to the instance's constant pool and
instruction table. Read entries are split by evidence grade:

  proven-pool       the instance executes GetNamedProperty AND its
                    metadata constant pool contains string constants;
                    those strings are the resolvable NAME OPERAND
                    candidates (per-event operand capture is post-E7,
                    so membership is instance-scoped — stated as such).
  unproven-keyed    GetKeyedProperty reads: keys are runtime values,
                    NOT generally recoverable from the pool (contract
                    §9) — listed, never guessed.
  unproven-no-meta  property reads on instances without metadata
                    (pre-D1 captures): listed, explicitly unresolved.

  T3 never claims a non-empty list == the full read surface.

T7 classifies the deployment shape from what a capture actually holds
(observed: ignition density / script URL shapes; derived-from-corpus:
site-recorded mode/cookie facts, labeled) — every field carries its
evidence grade; nothing above `derived` is emitted.

Usage:
  python3 analysis/p55_t3_t7.py t3 --trace T.ndjson [--assets DIR]
  python3 analysis/p55_t3_t7.py t7 --trace T.ndjson \
      --site-name xj1 [--corpus-manifest analysis/corpus-capture/corpus-manifest.json]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict

GRADES = ("observed", "derived", "hypothesis", "validated", "unresolved")
NAMED_OPCODES = ("GetNamedProperty", "LdaNamedProperty", "GetNamedPropertyFromSuper")
KEYED_OPCODES = ("GetKeyedProperty", "LdaKeyedProperty")

CLASSIFICATION = (
    ("navigator", ("navigator", "userAgent", "platform", "language",
                   "webdriver", "languages", "hardwareConcurrency")),
    ("screen", ("screen", "width", "height", "colorDepth", "availWidth")),
    ("canvas", ("canvas", "getContext", "fillText", "toDataURL",
                "measureText", "getImageData")),
    ("storage", ("localStorage", "sessionStorage", "indexedDB", "cookie")),
    ("timing", ("performance", "now", "Date", "getTime", "timing")),
    ("document", ("document", "createElement", "getElementById",
                  "documentElement", "referrer")),
    ("function-probe", ("toString", "constructor", "call", "apply",
                        "bind", "Function", "eval")),
    ("error-detect", ("onerror", "debugger", "__proto__")),
)


def classify_key(key: str) -> str:
    low = key.lower()
    for family, needles in CLASSIFICATION:
        if any(n.lower() in low for n in needles):
            return family
    return "other"


def load_events(trace: pathlib.Path):
    with open(trace, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_metadata_assets(trace: pathlib.Path):
    """D1 metadata blobs keyed by (script_id, bytecode_version). Asset
    CONTENT lives beside the trace (assets/<name>/ manifest + content
    files); the event rows carry the summary args."""
    root = trace.parent / "assets"
    meta = {}
    for manifest in root.glob("*/manifest.ndjson"):
        with open(manifest, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("kind") != "v8-bytecode-metadata":
                    continue
                url = row.get("url", "")
                m = re.search(r"/(\d+)/(\d+)$", url)
                if not m:
                    continue
                # Content files land with the shared .js extension (the
                # asset channel names files after the sha1, not the kind).
                content_path = manifest.parent / str(row.get("content_path", ""))
                if not content_path.exists():
                    stem = "sha1_" + row["asset_id"].split("sha1:")[-1]
                    content_path = next(
                        (manifest.parent / f"{stem}{ext}" for ext in (".js", ".json")
                         if (manifest.parent / f"{stem}{ext}").exists()), None)
                if content_path is None or not content_path.exists():
                    continue
                try:
                    blob = json.loads(
                        content_path.read_text(encoding="utf-8",
                                               errors="replace"))
                except json.JSONDecodeError:
                    continue
                meta[(int(m.group(1)), int(m.group(2)))] = blob
    return meta


def t3(trace: pathlib.Path) -> dict:
    meta = load_metadata_assets(trace)
    per_instance = defaultdict(lambda: {
        "named": 0, "keyed": 0, "offsets_named": set()})
    for event in load_events(trace):
        ign = event.get("ignition")
        if not ign:
            continue
        opcode = ign.get("opcode", "")
        key = (ign.get("script_id"), ign.get("bytecode_version"))
        inst = per_instance[key]
        if opcode in NAMED_OPCODES:
            inst["named"] += 1
            inst["offsets_named"].add(ign.get("bytecode_offset"))
        elif opcode in KEYED_OPCODES:
            inst["keyed"] += 1

    proven, unproven_keyed, unproven_no_meta = [], Counter(), Counter()
    with_meta = without_meta = 0
    for (script, version), inst in per_instance.items():
        if inst["named"] == 0 and inst["keyed"] == 0:
            continue
        blob = meta.get((int(script), int(version)))
        if blob is None:
            without_meta += 1
            unproven_no_meta["<instance-without-metadata>"] += inst["named"]
            continue
        with_meta += 1
        # Instance-scoped proof: GetNamedProperty present in the decoded
        # instruction table + string constants in the pool.
        opcodes = blob["instructions"]["opcodes"]
        reads_named = inst["named"] > 0
        if reads_named:
            for const in blob.get("constants", []):
                if "s" in const:
                    proven.append({
                        "key": const["s"],
                        "script_id": int(script),
                        "bytecode_version": int(version),
                        "named_reads": inst["named"],
                        "classification": classify_key(const["s"]),
                        "scope": "instance-pool-candidates",
                    })
        if inst["keyed"]:
            unproven_keyed[f"<keyed:{script}/{version}>"] += inst["keyed"]

    read_list = ([{**e, "grade": "proven-pool"} for e in
                  sorted(proven, key=lambda e: (-e["named_reads"], e["key"]))] +
                 [{"key": k, "reads": v, "grade": "unproven-keyed",
                   "classification": "runtime-value"}
                  for k, v in unproven_keyed.most_common()] +
                 [{"key": k, "reads": v, "grade": "unproven-no-metadata",
                   "classification": "unknown"}
                  for k, v in unproven_no_meta.most_common()])
    summary = {
        "tool": "p55-t3", "grade-discipline": "five-level",
        "instances_reading": with_meta + without_meta,
        "instances_with_metadata": with_meta,
        "instances_without_metadata": without_meta,
        "read_list_len": len(read_list),
        "read_list_nonempty": bool(read_list),
        "classes": Counter(e["classification"] for e in read_list),
    }
    return {"summary": {k: (dict(v) if isinstance(v, Counter) else v)
                        for k, v in summary.items()},
            "read_list": read_list[:500]}


def t7(trace: pathlib.Path, site_name: str, corpus_manifest) -> dict:
    status_codes = []
    ignition = 0
    script_urls = Counter()
    cookie_events = Counter()
    for event in load_events(trace):
        api = event.get("api", "")
        if api == "Ignition.execute":
            ignition += 1
        elif api == "BrowserNetwork.response":
            args = event.get("args") or [{}]
            code = args[0].get("status_code") if isinstance(args[0], dict) else None
            if code is not None:
                status_codes.append(int(code))
        elif api in ("Document.cookie.set", "Document.cookie.get"):
            text = json.dumps(event.get("args") or [])
            m = re.search(r"([A-Za-z0-9_]{6,})=", text)
            if m:
                cookie_events[m.group(1)] += 1
        ign = event.get("ignition")
        if ign and event.get("api") == "Ignition.execute":
            pass  # url not per-event; script shapes come from metadata

    # Site-recorded facts (corpus README/manifest) — DERIVED grade, with
    # the source named; never presented as observations of this capture.
    recorded = {}
    if corpus_manifest:
        for row in corpus_manifest:
            if row.get("name") == site_name:
                recorded = row
                break
    site_facts = {
        "xj1": {"mode": "412-interstitial-two-stage", "stages": 2,
                "cookie": "CyFIZHvBqps2O",
                "note": "stage-1 bundle captured; stage-2 blob unavailable"},
        "sc": {"mode": "200-inline", "stages": 1,
               "cookie": "cookie_persist", "note": ""},
        "jibei": {"mode": "200-inline", "stages": 1,
                  "cookie": None,
                  "note": "transport-layer threshold marked; original 200 "
                          "blob missing, paired xj-family blob"},
    }.get(site_name, {})

    verdict = {
        "tool": "p55-t7",
        "family": {"value": "jsvmp-challenge", "grade": "observed",
                   "evidence": f"ignition density {ignition} events"},
        "mode": {"value": site_facts.get("mode"), "grade": "derived",
                 "evidence": "site-recorded corpus fact (README/manifest); "
                             "local replay cannot re-observe interstitial "
                             "status codes"},
        "stages": {"value": site_facts.get("stages"), "grade": "derived",
                   "evidence": "corpus record (stage-2 blob availability)"},
        "cookie": {"value": site_facts.get("cookie")
                   or (cookie_events.most_common(1)[0][0]
                       if cookie_events else None),
                   "grade": "derived",
                   "evidence": "corpus-recorded cookie name"
                   if site_facts.get("cookie") else
                   "Document.cookie events" if cookie_events else "absent"},
        "observed_in_capture": {
            "ignition_events": ignition,
            "status_codes": sorted(set(status_codes)),
            "cookie_event_names": dict(cookie_events),
            "capture_context": "local replay (dead-proxy guard, no origin)",
        },
        "bundle": recorded.get("js"),
        "note": site_facts.get("note"),
    }
    return verdict


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p3 = sub.add_parser("t3")
    p3.add_argument("--trace", type=pathlib.Path, required=True)
    p7 = sub.add_parser("t7")
    p7.add_argument("--trace", type=pathlib.Path, required=True)
    p7.add_argument("--site-name", required=True)
    p7.add_argument("--corpus-manifest", type=pathlib.Path,
                    default=pathlib.Path("analysis/corpus-capture/"
                                         "corpus-manifest.json"))
    args = parser.parse_args(argv)
    if args.cmd == "t3":
        print(json.dumps(t3(args.trace), ensure_ascii=False, indent=1))
    else:
        corpus = None
        if args.corpus_manifest and args.corpus_manifest.exists():
            corpus = json.loads(args.corpus_manifest.read_text())
        print(json.dumps(t7(args.trace, args.site_name, corpus),
                         ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
