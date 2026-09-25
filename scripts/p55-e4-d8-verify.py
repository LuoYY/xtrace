#!/usr/bin/env python3
"""P55-E4 materialized dump, d8 acceptance (execution handoff E4 row).

Matrix: cyclic graph (back-reference, no expansion), long string
(truncated+length), sparse array (dictionary entries), detached
ArrayBuffer/TypedArray (recorded, no crash), BigInt (bounded decimal),
accessor-only property (skip+reason), Proxy (skip+reason), budget axes
reported, depth cap enforced. Chrome asset-channel quadruples and
window_id anchoring ride the E7 control-plane batch.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
EVIDENCE = ROOT / "chromium/src/out/XTraceP55D8/validation/e4-verify"
FIXTURE = ROOT / "test-pages/p55/e4-dump.js"

FIXTURE.parent.mkdir(parents=True, exist_ok=True)
FIXTURE.write_text("""
var a = { name: 'root' };
a.self = a;                                  // cycle
a.child = { leaf: true, deep: { deeper: 1, obj: { x: 1 } } };  // 'obj' at level 3 -> depth skip
a.long = 'x'.repeat(500);                    // truncated string
a.big = 123456789012345678901234567890n;     // BigInt bounded
Object.defineProperty(a, 'acc', { get: function () { return 1; }, configurable: true });
var holey = [1, , , , 5];                     // fast holey elements
var sparse = [1]; sparse[100000] = 5; sparse[200000] = 9;  // dictionary elements
var ab = new ArrayBuffer(16);
var dv = new Uint8Array(ab); dv[0] = 0xAA;
var ta = new Uint8Array([1, 2, 3, 4]);
var detached = new ArrayBuffer(8);
%ArrayBufferDetach(detached);
var proxy = new Proxy({}, {});
var r1 = xtraceDump(a, 'root-graph', 7);
var r2 = xtraceDump(sparse, 'sparse', 7);
var r7 = xtraceDump(holey, 'holey', 7);
var big = new ArrayBuffer(20000);                 // > per-value cap -> truncated hex
var r8 = xtraceDump(big, 'bigbuf', 7);
var r3 = xtraceDump(dv, 'typed-view', 7);
var r4 = xtraceDump(detached, 'detached', 7);
var r5 = xtraceDump(proxy, 'proxy', 7);
var r6 = xtraceDump(ta, 'typed-live', 7);
print('DUMPS ' + [r1, r2, r3, r4, r5, r6, r7, r8].join(','));
""")

def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    run = EVIDENCE
    dumps = run / "dumps"
    dumps.mkdir(parents=True, exist_ok=True)
    for f in dumps.iterdir():
        f.unlink()
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--allow-natives-syntax",
         f"--xtrace-dump-dir={dumps}", str(FIXTURE)],
        capture_output=True, text=True, timeout=120)
    (run / "run.log").write_text(proc.stdout + proc.stderr)
    assert proc.returncode == 0, proc.stderr[-400:]
    results = re.search(r"^DUMPS (.*)$", proc.stdout, re.M).group(1)
    assert results == ",".join(["true"] * 8), results
    files = sorted(dumps.glob("dump-*.json"))
    assert len(files) == 8, f"expected 8 dumps, got {len(files)}"
    blobs = [json.loads(f.read_text(errors="replace")) for f in files]
    for b in blobs:
        assert b["kind"] == "v8.materialized-dump" and b["schema"] == 1
        assert b["anchor"]["type"] == "custom" and b["anchor"]["window_id"] == 7
        assert "budget" in b and b["budget"]["max_nodes"] > 0
        # R0 (chief review F7): the old `... or True` made this vacuous.
        # Strict: no native-address-shaped tokens in any dump payload.
        assert "0x" not in json.dumps(b).lower(), "native address leaked"
    root = blobs[0]
    props = {p["k"]: p.get("v") for p in root["root"]["props"]}
    skips = {p["k"]: p["reason"] for p in root["root"]["props"] if "reason" in p}
    assert root["root"]["id"] == 0
    assert props["self"] == {"t": "cycle", "ref": 0}, "cycle must back-ref node 0"
    assert props["name"]["v"] == "root"
    assert props["long"]["state"] == "truncated" and props["long"]["len"] == 500
    assert props["big"]["t"] == "bigint" and props["big"]["v"].startswith("1234567890")
    assert skips.get("acc") == "accessor", skips
    child = props["child"]
    assert child["t"] == "object"
    deep = {p["k"]: p.get("v") for p in child["props"]}["deep"]
    # depth semantics: level-2 receivers EXPAND; level-3 receivers skip.
    deep_props = {p["k"]: p.get("v", p.get("reason")) for p in deep["props"]}
    assert deep_props["deeper"] == {"t": "i", "v": 1}, deep_props
    assert deep_props["obj"] == {"t": "skip", "reason": "depth"}, deep_props
    sparse = blobs[1]["root"]
    assert sparse["t"] == "array" and sparse["length"] == 200001
    indices = [e["i"] for e in sparse["sparse"]]
    assert 0 in indices and 200000 in indices, indices
    holey = blobs[2]["root"]
    assert holey["t"] == "array" and holey["length"] == 5
    kinds = [e.get("t") for e in holey["dense"]]
    assert kinds == ["i", "hole", "hole", "hole", "i"], kinds
    view = blobs[4]["root"]
    assert view["t"] == "typedarray" and view["byte_length"] == 16
    # 16 bytes < per-value cap: fully captured with the AA sentinel byte.
    assert view["hex_state"] == "captured" and view["hex"].startswith("aa")
    big = blobs[3]["root"]
    assert big["t"] == "arraybuffer" and big["byte_length"] == 20000
    assert big["hex_state"] == "truncated", big
    detached = blobs[5]["root"]
    assert detached["t"] == "arraybuffer" and detached.get("detached") is True
    proxy = blobs[6]["root"]
    assert proxy["t"] == "skip" and proxy["reason"] == "proxy"
    live = blobs[7]["root"]
    assert live["t"] == "typedarray" and live["byte_length"] == 4
    assert live["hex_state"] == "captured" and live["hex"] == "01020304"
    summary = {"dumps": len(blobs), "verdict": "pass"}
    (run / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))
    print("P55-E4 DUMP d8 VERIFY: PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
