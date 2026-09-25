#!/usr/bin/env python3
"""P5.5 E6/S4 analysis layer: T3 environment read-surface reconstruction +
T7 deployment-shape classification (design contract §9).

S4 (re-review RR5) semantics:
  - Identity: metadata assets join on the FIVE-PART namespace
    (producer_id, process_epoch, isolate_epoch, script_id,
    bytecode_version) — asset identity fields are validated (digest
    match, explicit problem reports, never silent skips); legacy assets
    without identity fields join ONLY when the capture has exactly one
    producer and are labeled as such.
  - T3: every PROVEN read carries recomputable evidence
    (offset -> pool_index -> constant) as a per-read row; aggregates
    never replace the rows. Ambiguous joins (multiple isolates for one
    4-tuple) are REPORTED, never guessed.
  - T7: `facts` carries raw observations only (density, statuses, URL
    shapes — each independently graded); the `family` MECHANISM claim
    is at most a hypothesis unless oracle-level evidence exists (a 412
    interstitial observed IN the capture, or corpus-recorded two-stage
    412 with citation). Density + URL shape alone never proves a
    challenge deployment.

Usage:
  python3 scripts/p55_t3_t7.py t3 --trace T.ndjson
  python3 scripts/p55_t3_t7.py t7 --trace T.ndjson --site-name xj1 \
      [--corpus-manifest analysis/corpus-capture/corpus-manifest.json]
"""
from __future__ import annotations

import argparse
import hashlib
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
    """D1 metadata blobs keyed by the FIVE-PART identity namespace, plus
    an explicit problem list (RR5: bad records are REPORTED, never
    silently skipped; digests are verified before analysis)."""
    root = trace.parent / "assets"
    assets = {}       # (producer, process_epoch, isolate_epoch, script, ver)
    legacy = {}       # (script, ver) -> blob   (no identity fields)
    problems = []
    for manifest in root.glob("*/manifest.ndjson"):
        with open(manifest, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as e:
                    problems.append({"manifest": str(manifest),
                                     "problem": f"bad-json: {e}"})
                    continue
                if row.get("kind") != "v8-bytecode-metadata":
                    continue
                url = row.get("url", "")
                m = re.search(r"/(\d+)/(\d+)$", url)
                if not m:
                    problems.append({"manifest": str(manifest),
                                     "problem": f"bad-url: {url!r}"})
                    continue
                script, version = int(m.group(1)), int(m.group(2))
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
                    problems.append({"manifest": str(manifest),
                                     "problem": "content-file-missing"})
                    continue
                blob_text = content_path.read_text(encoding="utf-8",
                                                   errors="replace")
                # S4: digest boundary check BEFORE analysis — the asset
                # id is sha1(kind + "\n" + url + "\n" + content), the
                # producer's dedup formula; the reconstructed digest must
                # equal the manifest row's id or the record is rejected
                # (reported, never silently skipped).
                material = (str(row.get("kind", "")) + "\n" +
                            str(row.get("url", "")) + "\n" +
                            blob_text).encode("utf-8")
                digest = hashlib.sha1(material).hexdigest().upper()
                want = str(row.get("asset_id", "")).split("sha1:")[-1].upper()
                if want and digest != want:
                    problems.append({"manifest": str(manifest),
                                     "problem": f"digest-mismatch "
                                                f"(row={want[:12]} got={digest[:12]})"})
                    continue
                try:
                    blob = json.loads(blob_text)
                except json.JSONDecodeError as e:
                    problems.append({"manifest": str(manifest),
                                     "problem": f"bad-content-json: {e}"})
                    continue
                iso = blob.get("isolate_epoch")
                producer = blob.get("producer_id") or row.get("producer_id")
                epoch = blob.get("process_epoch") or row.get("process_epoch")
                if producer and epoch and iso is not None:
                    key = (str(producer), str(epoch), str(iso), script, version)
                    assets[key] = blob
                else:
                    # Legacy asset (pre-S4 producer): usable ONLY with a
                    # single-producer capture, and labeled as legacy.
                    legacy[(script, version)] = blob
    return assets, legacy, problems


def t3(trace: pathlib.Path) -> dict:
    assets, legacy, problems = load_metadata_assets(trace)
    # (producer, process_epoch, script, version) -> [assets with distinct
    # isolate epochs]; the join key events can express (no isolate id on
    # event rows yet — S4 keeps ambiguity REPORTED rather than guessed).
    per_instance = defaultdict(lambda: {
        "named": 0, "keyed": 0, "offsets_named": set(),
        "events": [], "producer": None, "process_epoch": None})
    producers_seen = set()  # producers with IGNITION events only
    for event in load_events(trace):
        ign = event.get("ignition")
        if not ign:
            continue
        producers_seen.add(event.get("producer_id"))
        opcode = ign.get("opcode", "")
        # Events may carry string ids; assets parse ints — normalize so
        # the join never fails on representation.
        def as_int(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return v
        key = (event.get("producer_id"), event.get("process_epoch"),
               as_int(ign.get("script_id")), as_int(ign.get("bytecode_version")))
        inst = per_instance[key]
        inst["producer"], inst["process_epoch"] = key[0], key[1]
        if opcode in NAMED_OPCODES:
            inst["named"] += 1
            inst["offsets_named"].add(ign.get("bytecode_offset"))
            inst["events"].append(ign.get("bytecode_offset"))
        elif opcode in KEYED_OPCODES:
            inst["keyed"] += 1

    reads = []          # S4: per-read recomputable evidence rows
    ambiguous = []
    unproven_keyed = Counter()
    unproven_no_meta = Counter()
    candidate_rows = []  # pool membership candidates (never proven)
    with_meta = without_meta = 0
    legacy_joins = 0
    for (producer, epoch, script, version), inst in per_instance.items():
        if inst["named"] == 0 and inst["keyed"] == 0:
            continue
        matches = [blob for key, blob in assets.items()
                   if key[0] == producer and key[1] == epoch and
                   key[3] == script and key[4] == version]
        blob = None
        if len(matches) == 1:
            blob = matches[0]
        elif len(matches) > 1:
            # Multiple ISOLATES registered this (script, version) in the
            # same process: the event row cannot name its isolate — the
            # join is AMBIGUOUS and stays unproven (never guessed).
            ambiguous.append({
                "producer_id": producer, "process_epoch": epoch,
                "script_id": script, "bytecode_version": version,
                "candidate_isolate_epochs": sorted({k[2] for k in assets
                                                    if k[0] == producer and
                                                    k[3] == script and
                                                    k[4] == version})})
            blob = None
        if blob is None and not matches and len(producers_seen) == 1 and \
                (script, version) in legacy:
            blob = legacy[(script, version)]
            legacy_joins += 1
        if blob is None:
            if matches:
                pass  # ambiguous already recorded
            else:
                without_meta += 1
                unproven_no_meta["<instance-without-metadata>"] += inst["named"]
            if inst["keyed"]:
                unproven_keyed[f"<keyed:{script}/{version}>"] += inst["keyed"]
            continue
        with_meta += 1
        pool_indices = blob["instructions"].get("pool_indices")
        offsets_by_pos = {str(off): i for i, off in enumerate(
            blob["instructions"]["offsets"])}
        consts = blob.get("constants", [])
        resolved = set()
        for offset in inst["events"]:
            pos = offsets_by_pos.get(str(offset))
            if pos is None:
                continue
            idx = int(pool_indices[pos])
            if 0 <= idx < len(consts) and "s" in consts[idx]:
                key_str = consts[idx]["s"]
                resolved.add(key_str)
                reads.append({          # the recomputable evidence row
                    "key": key_str,
                    "grade": "proven-read",
                    "producer_id": producer,
                    "process_epoch": epoch,
                    "script_id": int(script), "bytecode_version": int(version),
                    "offset": str(offset),
                    "pool_index": idx,
                    "classification": classify_key(key_str),
                })
        for const in consts:
            if "s" in const and const["s"] not in resolved:
                candidate_rows.append({
                    "key": const["s"],
                    "script_id": int(script), "bytecode_version": int(version),
                    "classification": classify_key(const["s"]),
                })

    read_list = ([{**r} for r in
                  sorted(reads, key=lambda r: (r["script_id"],
                                               int(r["offset"])))] +
                 [{"key": k, "reads": v, "grade": "candidate-pool",
                   "classification": "pool-membership"}
                  for k, v in ((r["key"], 1) for r in candidate_rows)] +
                 [{"key": k, "reads": v, "grade": "unproven-keyed",
                   "classification": "runtime-value"}
                  for k, v in unproven_keyed.most_common()] +
                 [{"key": k, "reads": v, "grade": "unproven-no-metadata",
                   "classification": "unknown"}
                  for k, v in unproven_no_meta.most_common()])
    summary = {
        "tool": "p55-t3", "grade-discipline": "five-level",
        "identity_model": "five-part (producer, process_epoch, "
                          "isolate_epoch, script_id, bytecode_version)",
        "instances_reading": with_meta + without_meta,
        "instances_with_metadata": with_meta,
        "instances_without_metadata": without_meta,
        "proven_reads": len(reads),
        "ambiguous_joins": len(ambiguous),
        "legacy_asset_joins": legacy_joins,
        "asset_problems": len(problems),
        "read_list_len": len(read_list),
        "read_list_nonempty": bool(read_list),
    }
    return {"summary": {k: (dict(v) if isinstance(v, Counter) else v)
                        for k, v in summary.items()},
            "reads": reads, "ambiguous_joins": ambiguous,
            "asset_problems": problems, "read_list": read_list}


def t7(trace: pathlib.Path, site_name: str, corpus_manifest) -> dict:
    # Corpus manifest = EXTERNAL RESEARCH INPUT ONLY (R5 ruling): the
    # bundle name is listed as provenance metadata; a corpus-recorded
    # 412 TWO-STAGE mode is the one oracle-level citation that may raise
    # the family claim above hypothesis.
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

    # ---- S4: `facts` = raw observations, each independently graded ----
    versioned_hash_bundle = any(
        re.search(r"/[A-Za-z0-9]{8,}\.[0-9a-f]{6,8}\.(js)$", url)
        for url in script_urls)
    facts = {
        "ignition_events": {"value": ignition, "grade": "observed"},
        "ignition_density_tier": {
            "value": ("none" if ignition == 0 else
                      "high" if ignition >= 100000 else "low"),
            "grade": "observed",
            "evidence": f"{ignition} Ignition.execute events in this capture"},
        "status_codes": {"value": sorted(set(status_codes)),
                         "grade": "observed" if status_codes else "unresolved"},
        "url_shapes": {
            "value": {"versioned_hash_bundle": versioned_hash_bundle},
            "grade": "observed" if script_urls else "unresolved",
            "evidence": f"{len(script_urls)} request URLs observed"},
        "cookie_event_names": {
            "value": dict(cookie_events),
            "grade": "observed" if cookie_events else "unresolved"},
    }
    interstitial_412 = 412 in status_codes

    # ---- family: mechanism claim, hypothesis without an oracle -------
    if ignition == 0:
        family = {"value": "unresolved", "grade": "unresolved",
                  "evidence": "empty trace: no ignition events"}
    elif interstitial_412 and versioned_hash_bundle and ignition >= 100000:
        family = {"value": "jsvmp-challenge", "grade": "observed",
                  "evidence": "ORACLE: 412 interstitial observed in this "
                              "capture + random-path versioned bundle + "
                              "high ignition density"}
    elif recorded.get("mode") == "412-interstitial-two-stage" and \
            versioned_hash_bundle and ignition >= 100000:
        family = {"value": "jsvmp-challenge", "grade": "observed",
                  "evidence": f"ORACLE: corpus-recorded two-stage 412 for "
                              f"{site_name} (citation: corpus-manifest) + "
                              f"capture-side density/URL facts"}
    elif versioned_hash_bundle and ignition >= 100000:
        family = {"value": "jsvmp-challenge", "grade": "hypothesis",
                  "evidence": "high density + versioned-hash bundle URL — "
                              "consistent with a JSVMP challenge AND with "
                              "ordinary hashed SPA bundles; no 412/oracle "
                              "evidence in this capture"}
    elif ignition >= 100000:
        family = {"value": "jsvmp-challenge", "grade": "hypothesis",
                  "evidence": f"ignition density {ignition}; no "
                              "random-path bundle URL observed — script "
                              "shape unconfirmed"}
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
                                'without the first-response record"'}
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
        "facts": facts, "family": family, "mode": mode,
        "stages": stages, "cookie": cookie,
        "observed_in_capture": {
            "ignition_events": ignition,
            "status_codes": sorted(set(status_codes)),
            "cookie_event_names": dict(cookie_events),
            "script_urls": dict(script_urls),
            "capture_context": "local replay (dead-proxy guard, no origin)",
        },
        "bundle": recorded.get("js"),
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
