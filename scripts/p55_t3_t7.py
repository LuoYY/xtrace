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
                raw_content = row.get("content_path")
                content_path = (manifest.parent / str(raw_content)
                                if raw_content else None)
                if content_path is None or not content_path.exists() or \
                        not content_path.is_file():
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
        "named": 0, "keyed": 0, "offsets_named": set(), "events": []})
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
            inst["events"].append(ign.get("bytecode_offset"))
        elif opcode in KEYED_OPCODES:
            inst["keyed"] += 1

    # R5 (chief review F5): CANDIDATES are not READS. Until D1 carries
    # per-instruction operand indices (R4), pool strings on an instance
    # that executes GetNamedProperty are CANDIDATES — never proven reads
    # — and every entry says so. Keyed reads stay explicitly unresolved.
    candidates, unproven_keyed, unproven_no_meta = [], Counter(), Counter()
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
        pool_indices = blob["instructions"].get("pool_indices")
        if pool_indices and inst["named"] > 0:
            # R4+R5: with per-instruction pool indices, NAMED-READ
            # instructions resolve their key operand EXACTLY — offset
            # -> pool_indices[offset] -> constants[idx]. This is a
            # READ-proven entry; unreferenced pool strings stay
            # candidates.
            offsets_by_pos = {str(off): i for i, off in enumerate(
                blob["instructions"]["offsets"])}
            consts = blob.get("constants", [])
            resolved_keys = set()
            for event in inst.get("events", []):
                pos = offsets_by_pos.get(str(event))
                if pos is None:
                    continue
                idx = int(pool_indices[pos])
                if 0 <= idx < len(consts) and "s" in consts[idx]:
                    resolved_keys.add(consts[idx]["s"])
            for key in resolved_keys:
                candidates.append({
                    "key": key,
                    "script_id": int(script),
                    "bytecode_version": int(version),
                    "named_reads_on_instance": inst["named"],
                    "classification": classify_key(key),
                    "grade_override": "proven-read",
                })
            for const in consts:
                if "s" in const and const["s"] not in resolved_keys:
                    candidates.append({
                        "key": const["s"],
                        "script_id": int(script),
                        "bytecode_version": int(version),
                        "named_reads_on_instance": 0,
                        "classification": classify_key(const["s"]),
                    })
        if inst["keyed"]:
            unproven_keyed[f"<keyed:{script}/{version}>"] += inst["keyed"]

    read_list = ([{**{k: v for k, v in e.items()
                        if k != "grade_override"},
                   "grade": e.get("grade_override", "candidate-pool"),
                   **({} if e.get("grade_override")
                      else {"note": "pool membership only; per-event "
                                    "resolution needs D1 pool_indices"})}
                  for e in sorted(candidates,
                                  key=lambda e: -e["named_reads_on_instance"])] +
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
    # Corpus manifest = EXTERNAL RESEARCH INPUT ONLY (R5 ruling): the
    # bundle name is listed as provenance metadata; it never feeds the
    # classification rules below.
    recorded = {}
    if corpus_manifest:
        for row in corpus_manifest:
            if row.get("name") == site_name:
                recorded = row
                break
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
            # field name varies by hook vintage: status_code /
            # response_code both observed in captured corpora
            code = None
            if isinstance(args[0], dict):
                code = args[0].get("status_code", args[0].get("response_code"))
            if code is not None:
                status_codes.append(int(code))
        elif api in ("Document.cookie.set", "Document.cookie.get"):
            text = json.dumps(event.get("args") or [])
            m = re.search(r"([A-Za-z0-9_]{6,})=", text)
            if m:
                cookie_events[m.group(1)] += 1
        elif api == "BrowserNetwork.request":
            args = event.get("args") or [{}]
            if isinstance(args[0], dict):
                url = args[0].get("url") or ""
                if url:
                    script_urls[url] += 1


    # R5 (chief review F5): NO site-name dictionary. Classification is
    # rule-based over THIS capture's evidence; missing/conflicting
    # evidence yields unresolved/hypothesis — never a confident label.
    evidence = {
        "ignition_events": ignition,
        "status_codes": sorted(set(status_codes)),
        "cookie_event_names": dict(cookie_events),
        "script_urls": dict(script_urls),
        "capture_context": "local replay (dead-proxy guard, no origin)",
    }
    # family: a JSVMP challenge claim needs BOTH heavy interpreter
    # activity AND a distinctive script shape (random-path bundle) —
    # density alone proves nothing (any hot page has ignition events).
    dense_vm = ignition >= 100000
    # corpus bundles carry 6-8 hex version tags (W1bH0CpS9gGF.1058d2a.js)
    random_path_bundle = any(
        re.search(r"/[A-Za-z0-9]{8,}\.[0-9a-f]{6,8}\.(js)$", url)
        for url in script_urls)
    if ignition == 0:
        family = {"value": "unresolved", "grade": "unresolved",
                  "evidence": "empty trace: no ignition events"}
    elif dense_vm and random_path_bundle:
        family = {"value": "jsvmp-challenge", "grade": "observed",
                  "evidence": f"ignition density {ignition} + "
                              "random-path versioned bundle URL"}
    elif dense_vm:
        family = {"value": "jsvmp-challenge", "grade": "hypothesis",
                  "evidence": f"ignition density {ignition}; no "
                              "random-path bundle URL observed — "
                              "script shape unconfirmed"}
    else:
        family = {"value": "unresolved", "grade": "unresolved",
                  "evidence": f"ignition density {ignition} below "
                              "challenge threshold; ordinary script "
                              "activity"}
    # mode: only observable when the capture actually SAW the statuses.
    if status_codes:
        if 412 in status_codes:
            mode = {"value": "412-interstitial", "grade": "observed",
                    "evidence": f"status codes {sorted(set(status_codes))}"}
        elif 200 in status_codes:
            mode = {"value": "200-inline-or-post", "grade": "observed",
                    "evidence": f"status codes {sorted(set(status_codes))}; "
                                "two-stage vs inline not distinguishable "
                                "without the first-response record"}
        else:
            mode = {"value": "unresolved", "grade": "unresolved",
                    "evidence": f"status codes {sorted(set(status_codes))}"}
    else:
        mode = {"value": "unresolved", "grade": "unresolved",
                "evidence": "no response statuses in this capture"}
    # stages/cookie: unresolved unless the capture itself shows them.
    stages = {"value": None, "grade": "unresolved",
              "evidence": "stage count needs the nav_chain record (E5) "
                          "or multi-stage script observation"}
    if cookie_events:
        top, _ = cookie_events.most_common(1)[0]
        cookie = {"value": top, "grade": "observed",
                  "evidence": f"Document.cookie events naming {top!r}"}
    else:
        cookie = {"value": None, "grade": "unresolved",
                  "evidence": "no Document.cookie events in this capture"}
    return {
        "tool": "p55-t7", "site_name": site_name,
        "family": family, "mode": mode, "stages": stages, "cookie": cookie,
        "observed_in_capture": evidence, "bundle": recorded.get("js"),
    }


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
