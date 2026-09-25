#!/usr/bin/env python3
"""P55-R0 (chief review F4/F5 counterexamples, frozen as red tests).

Expresses the DESIRED contract; every case is RED on the defect-carrying
d8 and must turn GREEN only after R3/R5 fixes:
  width       - 300 own props must yield <= 256 entries + partial=true
  large-key   - a 70k-char key must not blow the per-dump byte budget
  nul-value   - an embedded NUL in a tap value must survive verbatim
  shared      - SharedArrayBuffer/view must be explicitly unavailable
  array-len   - dense array dump reports the LOGICAL length, not backing
  capacity
  non-ascii   - tap values must round-trip non-ASCII (UTF-16 escapes or
                correct UTF-8), never corrupt
  t3-decoy    - an unreferenced constant must NOT be proven-pool
  t7-empty    - an empty trace must NOT classify as observed JSVMP
Outputs to a fresh directory per run; never touches existing evidence.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
STAMP = pathlib.Path(
    subprocess.run(["date", "+%Y%m%d-%H%M%S"], capture_output=True,
                   text=True).stdout.strip())
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-r0-{STAMP}"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"case": name, "ok": bool(ok), "detail": str(detail)[:200]})
    print(("PASS" if ok else "FAIL") + f"  {name}" +
          ("" if ok else f" — {detail}"))


def d8_dump(name, source):
    d = RUN / name
    (d / "dumps").mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         f"--xtrace-dump-dir={d / 'dumps'}", "-e", source],
        capture_output=True, text=True, timeout=120)
    (d / "run.log").write_text(proc.stdout + proc.stderr)
    blobs = [json.loads(f.read_text(errors="replace"))
             for f in sorted((d / "dumps").glob("dump-*.json"))]
    return proc, blobs


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)

    # --- width: 300 props -> <=256 entries + partial ---------------------
    proc, blobs = d8_dump(
        "width", "const o={};for(let i=0;i<300;i++)o['p'+i]=i;"
        "xtraceDump(o,'width',0);print('DONE');")
    ok = proc.returncode == 0 and blobs
    if ok:
        props = len(blobs[0]["root"].get("props", []))
        ok = (props <= 256 and blobs[0]["budget"]["partial"] is True)
        check("r0.dump-width", ok,
              f"props={props} partial={blobs[0]['budget']['partial']}")
    else:
        check("r0.dump-width", False, proc.stderr[-120:])

    # --- large key: per-dump byte budget respected ------------------------
    proc, blobs = d8_dump(
        "large-key", "const o={};o['K'.repeat(70000)]=1;"
        "xtraceDump(o,'large-key',0);print('DONE');")
    ok = proc.returncode == 0 and blobs
    if ok:
        raw = (RUN / "large-key" / "dumps" / "dump-000.json").stat().st_size
        ok = raw <= 65536 + 2048 and blobs[0]["budget"]["partial"] is True
        check("r0.dump-large-key", ok, f"bytes={raw}")
    else:
        check("r0.dump-large-key", False, proc.stderr[-120:])

    # --- SharedArrayBuffer: explicitly unavailable ------------------------
    proc, blobs = d8_dump(
        "shared",
        "const sab=new SharedArrayBuffer(8);const v=new Uint8Array(sab);"
        "xtraceDump(v,'shared',0);xtraceDump(sab,'shared-ab',0);print('DONE');")
    ok = proc.returncode == 0 and len(blobs) == 2
    if ok:
        states = [b["root"].get("state") or
                  ("detached" if b["root"].get("detached") else None)
                  for b in blobs]
        ok = all(s == "unavailable" for s in states)
        check("r0.dump-shared-unavailable", ok, f"states={states}")
    else:
        check("r0.dump-shared-unavailable", False, proc.stderr[-120:])

    # --- array logical length vs backing capacity -------------------------
    proc, blobs = d8_dump(
        "array-len", "const a=[];a.push(7);"
        "xtraceDump(a,'array-len',0);print('DONE');")
    ok = proc.returncode == 0 and blobs
    if ok:
        dense = blobs[0]["root"].get("dense", [])
        ok = (blobs[0]["root"].get("length") == 1 and len(dense) == 1)
        check("r0.dump-array-logical-length", ok,
              f"length={blobs[0]['root'].get('length')} "
              f"dense={len(dense)}")
    else:
        check("r0.dump-array-logical-length", False, proc.stderr[-120:])

    # --- tap value fidelity: NUL + non-ASCII -------------------------------
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         "--xtrace-tap-windows={\"windows\":[{\"id\":0,\"start\":0,"
         "\"end\":999999}]}",
         "-e", "function f(){const a='A\\u0000B';const b='中文';"
               "return [a.length,b.length];}f();print('DONE');"],
        capture_output=True, text=True, timeout=120)
    (RUN / "tap-values.log").write_text(proc.stdout + proc.stderr)
    taps = [l for l in proc.stdout.splitlines() if l.startswith("TAP ")]
    check("r0.tap-nul-and-cjk-fidelity",
          proc.returncode == 0 and bool(taps) and
          any("\\u0000" in l for l in taps) and
          any("中文" in l or "\\u4e2d" in l for l in taps),
          f"taps={len(taps)} sample={taps[:3]}")

    # --- T3 decoy: unreferenced constant must not be proven ----------------
    d = RUN / "t3-decoy"
    (d / "metadata").mkdir(parents=True, exist_ok=True)
    decoy = ("const o={actualKey:1};function g(){return o.actualKey;}"
             "g();print('DONE');")
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         f"--xtrace-metadata-dir={d / 'metadata'}", "-e", decoy],
        capture_output=True, text=True, timeout=120)
    (d / "run.log").write_text(proc.stdout + proc.stderr)
    # NOTE: the decoy constant is introduced via a literal that is never
    # read; after R5, T3 must resolve keys per event offset. The CURRENT
    # analyzer promotes the whole pool — probe it with a synthetic pool.
    # Here we freeze the ANALYZER contract on a synthetic metadata+trace:
    synth = d / "synthetic"
    (synth / "assets" / "t" ).mkdir(parents=True, exist_ok=True)
    trace = synth / "trace.ndjson"
    trace.write_text(json.dumps({
        "schema_version": 3, "producer_id": "r1", "process_epoch": "1",
        "producer_seq": "1", "writer_seq": "1", "config_generation": "1",
        "mono_time_us": "1", "wall_time_us": "1", "pid": 1, "tid": 1,
        "category": "reverse", "phase": "call", "api": "Ignition.execute",
        "args": [], "stack": [], "attribution": {"status": "unresolved"},
        "causality": {"kind": "external"},
        "ignition": {"script_id": "1", "bytecode_version": "1",
                     "bytecode_offset": "0", "opcode": "GetNamedProperty",
                     "tier": "ignition", "activation_ref": None}}) + "\n")
    meta = {"kind": "v8.bytecode-metadata", "schema": 1, "script_id": 1,
            "bytecode_version": 1,
            "instructions": {"count": 1, "offsets": [0], "opcodes": [1],
                             "operands": [1], "register_operands": [0]},
            "constants": [{"s": "NOT_READ_decoy"}, {"s": "actualKey"}]}
    (synth / "assets" / "t" / "sha1_DECOYDECOYDECOYDECOYDECOYDECOYDECOY1234.js"
     ).write_text(json.dumps(meta))
    (synth / "assets" / "t" / "manifest.ndjson").write_text(json.dumps({
        "kind": "v8-bytecode-metadata",
        "asset_id": "sha1:DECOYDECOYDECOYDECOYDECOYDECOYDECOY1234",
        "url": "v8-bytecode-metadata://1/1"}) + "\n")
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts/p55_t3_t7.py"), "t3",
         "--trace", str(trace)], capture_output=True, text=True, timeout=120)
    try:
        t3 = json.loads(proc.stdout)
        keys = {e["key"] for e in t3["read_list"]
                if e["grade"] == "proven-pool"}
        check("r0.t3-decoy-not-proven", "NOT_READ_decoy" not in keys,
              f"proven keys={sorted(keys)}")
    except Exception as e:  # noqa: BLE001
        check("r0.t3-decoy-not-proven", False, f"analyzer error {e}")

    # --- T7 empty trace: no observed family -------------------------------
    empty = RUN / "empty.ndjson"
    empty.write_text("")
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts/p55_t3_t7.py"), "t7",
         "--trace", str(empty), "--site-name", "nowhere"],
        capture_output=True, text=True, timeout=120)
    try:
        t7 = json.loads(proc.stdout)
        fam = t7["family"]["value"]
        grade = t7["family"]["grade"]
        check("r0.t7-empty-not-observed",
              fam != "jsvmp-challenge" or grade != "observed",
              f"family={fam}/{grade}")
    except Exception as e:  # noqa: BLE001
        check("r0.t7-empty-not-observed", False, f"analyzer error {e}")

    (RUN / "summary.json").write_text(json.dumps(RESULTS, indent=1))
    print(f"evidence: {RUN}")
    red = [r for r in RESULTS if not r["ok"]]
    if red:
        print(f"P55-R0 COUNTEREXAMPLES: RED ({len(red)}/{len(RESULTS)} "
              "defects present)")
        return 1
    print("P55-R0 COUNTEREXAMPLES: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
