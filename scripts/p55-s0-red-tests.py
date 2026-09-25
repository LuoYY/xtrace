#!/usr/bin/env python3
"""P55-S0 re-review counterexamples (RR2-RR6), frozen as red tests.

Each case expresses the DESIRED contract from handoff §12/§13 rulings;
every case is RED on the defect-carrying tree (71a69c1) and must turn
GREEN only after the matching S1-S5 fix:

  accessor-byte-budget (RR4) - accessor skip records reserve NO output
      bytes: 180 accessor props with 120-CJK-char keys blow past the
      64 KiB per-dump cap (135 KB observed) with partial=false.
  rab-length-tracking (RR4)  - a length-tracking view over a resizable
      ArrayBuffer reports byte_length=0 (storage field, not the current
      legal length); first bytes lost.
  double-hole (RR4)          - [1.5, , Infinity, NaN] hits
      FixedDoubleArray::get_scalar DCHECK -> exit -5; hole and special
      doubles must be distinct, encodable, crash-free.
  tap-budget-per-activation (RR3) - max_taps lives on the compile Entry
      and only a NEW config resets it: the second Script activation of
      the same compiled function gets ZERO taps (per-ACTIVATION reset
      is the §10.2 ruling; the "generation boundary" comment is not).
  d8-no-per-event-print (RR6)- D8TapCallback/D8ObserverCallback printf
      every event; taps/observations must be counted, not printed.
  t3-cross-producer (RR5)    - metadata join key is (script_id, version)
      only: a second producer's asset with the same ids overwrites the
      pool and its constants are reported as proven-reads of the first
      capture (deterministic mis-join).
  t7-ordinary-bundle (RR5)   - density + ANY content-hashed SPA bundle
      URL (webpack [contenthash].js) yields family=jsvmp-challenge at
      grade observed; a mechanism claim is at most a hypothesis without
      an oracle (echo/412).
  no-timedwait-stack-capture (RR2) - the bridge posts a lambda that
      captures addresses of call-stack locals and waits with TimedWait;
      the pattern itself must be deleted (source-level freeze).

Outputs to a fresh directory per run; never touches existing evidence.
"""
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
BRIDGE = (ROOT / "chromium/src/third_party/blink/renderer/platform/xtrace/"
          "xtrace-ignition-bridge.cc")
STAMP = time.strftime("%Y%m%d-%H%M%S")
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-s0-{STAMP}"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"case": name, "ok": bool(ok), "detail": str(detail)[:300]})
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
    return proc, blobs, d


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)

    # --- RR4: accessor skip records must reserve encoded bytes ----------
    proc, blobs, d = d8_dump(
        "accessor-budget",
        "const o={};"
        "for(let i=0;i<180;i++)"
        "Object.defineProperty(o,'键'.repeat(120)+i,"
        "{get(){return i;},enumerable:true,configurable:true});"
        "xtraceDump(o,'accessor-budget',0);print('DONE');")
    if proc.returncode == 0 and blobs:
        raw = (d / "dumps" / "dump-000.json").stat().st_size
        ok = raw <= 65536 + 2048 and blobs[0]["budget"]["partial"] is True
        check("s0.dump-accessor-byte-budget", ok,
              f"bytes={raw} partial={blobs[0]['budget']['partial']}")
    else:
        check("s0.dump-accessor-byte-budget", False,
              f"rc={proc.returncode} {proc.stderr[-120:]}")

    # --- RR4: length-tracking view over a resizable ArrayBuffer ----------
    proc, blobs, _ = d8_dump(
        "rab-view",
        "const rab=new ArrayBuffer(16,{maxByteLength:64});"
        "const v=new Uint8Array(rab);"
        "v[0]=23;v[15]=17;"
        "xtraceDump(v,'rab-view',0);print('DONE');")
    if proc.returncode == 0 and blobs:
        root = blobs[0]["root"]
        hexstr = root.get("hex", "")
        ok = (root.get("byte_length") == 16 and len(hexstr) >= 2)
        check("s0.dump-rab-length-tracking", ok,
              f"byte_length={root.get('byte_length')} hex={hexstr[:16]!r}")
    else:
        check("s0.dump-rab-length-tracking", False,
              f"rc={proc.returncode} {proc.stderr[-120:]}")

    # --- RR4: holey doubles must not crash; hole/specials distinct -------
    proc, blobs, _ = d8_dump(
        "double-hole",
        "const a=[1.5,,Infinity,NaN,-0];"
        "xtraceDump(a,'double-hole',0);print('DONE');")
    if proc.returncode == 0 and blobs:
        raw = (RUN / "double-hole" / "dumps" / "dump-000.json").read_text(
            errors="replace")
        hole_ok = '"hole"' in raw
        specials = len({m for m in ("Infinity", "NaN", "-0", "inf", "nan")
                        if m in raw})
        ok = hole_ok and specials >= 2  # at least two distinct encodings
        check("s0.dump-double-hole", ok,
              f"hole={hole_ok} distinct_special_markers={specials}")
    else:
        check("s0.dump-double-hole", False,
              f"rc={proc.returncode} (DCHECK crash) {proc.stderr[-150:]}")

    # --- RR3: per-ACTIVATION tap budget reset ----------------------------
    # f is compiled ONCE (script 1); activations 1/2 are the top-level
    # runs of scripts 2/3. max_taps=5: each activation may record 5 taps.
    cfg = ('{"windows":[{"id":0,"start":0,"end":999999}],"max_taps":5,'
           '"max_window":100}')
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         f"--xtrace-tap-windows={cfg}",
         "-e", "function f(n){var a=0;for(var i=0;i<n;i++)a=a+i*3%97;return a;}"
               "print('ACT1-BEGIN');f(60);print('ACT1-END');",
         "-e", "print('ACT2-BEGIN');f(60);print('ACT2-END');"],
        capture_output=True, text=True, timeout=120)
    (RUN / "per-activation.log").write_text(proc.stdout + proc.stderr)
    # Per-(activation, compile-instance) tap counts: the budget is
    # per-activation AND per-instance (two instances may each tap 5 in
    # one activation), and the ACTIVATION RESET means activation 2 sees
    # fresh taps even after activation 1 exhausted its instances.
    import collections
    seg_inst = collections.defaultdict(int)  # (act, script) -> taps
    cur = None
    for line in proc.stdout.splitlines():
        if line.startswith("ACT"):
            cur = line.split("-")[0]
        elif line.startswith("TAP ") and cur:
            # budget skips ride the same callback with value
            # {"budget_skip":1} — only REAL taps (hits) count here.
            if "budget_skip" in line:
                continue
            script = line.split("script=")[1].split()[0]
            seg_inst[(cur, script)] += 1
    per_ok = all(1 <= n <= 5 for n in seg_inst.values()) and seg_inst
    act2_ok = any(act == "ACT2" for (act, _) in seg_inst)
    ok = proc.returncode == 0 and per_ok and act2_ok
    detail = {f"{a}/{s}": n for (a, s), n in sorted(seg_inst.items())}
    check("s0.tap-budget-per-activation", ok,
          f"per-(activation,instance) taps {detail} — activation 2 must "
          f"see fresh taps within max_taps=5 after activation 1 "
          f"exhausted its budgets (per-activation reset)")

    # --- RR6: taps/observations are counted, never printed per event -----
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0",
         f"--xtrace-tap-windows={cfg}",
         "-e", "function g(){var a=0;for(var i=0;i<10;i++)a=a+i;return a;}"
               "g();print('DONE');"],
        capture_output=True, text=True, timeout=120)
    (RUN / "print-proof.log").write_text(proc.stdout + proc.stderr)
    taps = sum(1 for l in proc.stdout.splitlines() if l.startswith("TAP "))
    obs = sum(1 for l in proc.stdout.splitlines() if l.startswith("OBS "))
    summary_ok = "d8 tap events=" in proc.stdout and \
        "d8 observer events=" in proc.stdout
    check("s0.d8-no-per-event-print",
          proc.returncode == 0 and taps == 0 and obs == 0 and summary_ok,
          f"tap_lines={taps} obs_lines={obs} counters_at_exit={summary_ok}")

    # --- RR5: cross-producer mis-join (synthetic two-pool fixture) -------
    synth = RUN / "t3-cross"
    assets = synth / "assets" / "t"
    assets.mkdir(parents=True, exist_ok=True)
    trace = synth / "trace.ndjson"
    trace.write_text(json.dumps({
        "schema_version": 3, "producer_id": "producerA", "process_epoch": "1",
        "producer_seq": "1", "writer_seq": "1", "config_generation": "1",
        "mono_time_us": "1", "wall_time_us": "1", "pid": 1, "tid": 1,
        "category": "reverse", "phase": "call", "api": "Ignition.execute",
        "args": [], "stack": [], "attribution": {"status": "unresolved"},
        "causality": {"kind": "external"},
        "ignition": {"script_id": "1", "bytecode_version": "1",
                     "bytecode_offset": "0", "opcode": "GetNamedProperty",
                     "tier": "ignition", "activation_ref": None}}) + "\n")

    def meta_blob(first_constant):
        return {"kind": "v8.bytecode-metadata", "schema": 1, "script_id": 1,
                "bytecode_version": 1,
                "instructions": {"count": 1, "offsets": [0], "opcodes": [1],
                                 "operands": [1], "register_operands": [0],
                                 "pool_indices": [0]},
                "constants": [{"s": first_constant}]}

    # SAME (script_id, bytecode_version) from TWO producers; the loader's
    # dict overwrite hands capture A's reads to whichever row sorts last.
    (assets / ("sha1_" + "A" * 40 + ".js")).write_text(
        json.dumps(meta_blob("actualKey")))
    (assets / ("sha1_" + "B" * 40 + ".js")).write_text(
        json.dumps(meta_blob("foreignB")))
    (assets / "manifest.ndjson").write_text(
        json.dumps({"kind": "v8-bytecode-metadata",
                    "asset_id": "sha1:" + "A" * 40,
                    "url": "v8-bytecode-metadata://1/1",
                    "producer_id": "producerA"}) + "\n" +
        json.dumps({"kind": "v8-bytecode-metadata",
                    "asset_id": "sha1:" + "B" * 40,
                    "url": "v8-bytecode-metadata://1/1",
                    "producer_id": "producerFOREIGN"}) + "\n")
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts/p55_t3_t7.py"), "t3",
         "--trace", str(trace)], capture_output=True, text=True, timeout=120)
    (synth / "t3.out").write_text(proc.stdout + proc.stderr)
    try:
        t3 = json.loads(proc.stdout)
        proven_foreign = [e for e in t3["read_list"]
                          if e["key"] == "foreignB" and
                          e["grade"] == "proven-read"]
        read_list = json.dumps(
            [{k: e.get(k) for k in ("key", "grade")}
             for e in t3["read_list"]])
        check("s0.t3-cross-producer", not proven_foreign,
              f"read_list={read_list} — capture A (producerA) must "
              f"never prove the FOREIGN pool as its read surface")
    except Exception as e:  # noqa: BLE001
        check("s0.t3-cross-producer", False, f"analyzer error {e}")

    # --- RR5: ordinary content-hashed SPA bundle is not observed JSVMP ---
    t7d = RUN / "t7-ordinary"
    t7d.mkdir(parents=True, exist_ok=True)
    t7trace = t7d / "trace.ndjson"
    lines = ['{"api":"Ignition.execute"}'] * 100001
    lines.append(json.dumps({
        "api": "BrowserNetwork.request",
        "args": [{"url":
                  "https://cdn.example-app.com/static/9f8e7d6c5b4a."
                  "1058d2a.js"}]}))
    t7trace.write_text("\n".join(lines) + "\n")
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts/p55_t3_t7.py"), "t7",
         "--trace", str(t7trace), "--site-name", "ordinary-spa"],
        capture_output=True, text=True, timeout=120)
    (t7d / "t7.out").write_text(proc.stdout + proc.stderr)
    try:
        t7 = json.loads(proc.stdout)
        fam, grade = t7["family"]["value"], t7["family"]["grade"]
        check("s0.t7-ordinary-bundle",
              not (fam == "jsvmp-challenge" and grade == "observed"),
              f"family={fam}/{grade} — density + a content-hash URL "
              f"(webpack [contenthash].js) is ordinary SPA shape, at most "
              f"a hypothesis without an oracle")
    except Exception as e:  # noqa: BLE001
        check("s0.t7-ordinary-bundle", False, f"analyzer error {e}")

    # --- RR2: the TimedWait / stack-capture pattern must not exist -------
    src = BRIDGE.read_text(encoding="utf-8", errors="replace")
    timedwait = len(re.findall(r"\bTimedWait\s*\(", src))
    waitable = src.count("WaitableEvent")
    check("s0.no-timedwait-stack-capture",
          timedwait == 0 and waitable == 0,
          f"TimedWait( occurrences={timedwait}, WaitableEvent mentions="
          f"{waitable} — request ownership must be heap-owned/epoch-keyed, "
          f"never a posted lambda capturing call-stack locals")

    (RUN / "summary.json").write_text(json.dumps(RESULTS, indent=1))
    print(f"evidence: {RUN}")
    red = [r for r in RESULTS if not r["ok"]]
    if red:
        print(f"P55-S0 COUNTEREXAMPLES: RED ({len(red)}/{len(RESULTS)} "
              "defects present — expected before S1-S5)")
        return 1
    print("P55-S0 COUNTEREXAMPLES: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
