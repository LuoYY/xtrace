#!/usr/bin/env python3
"""P55-E1 D1 d8-first verification (execution handoff E1 acceptance).

Runs the instance-key fixture under the observer d8 in the DEDICATED
P5.5 output dir (out/XTraceP55D8 — never the P0 baseline out/XTraceD8Verify
and never XTraceP4D8), then asserts the contract §3 invariants on the
emitted metadata files:

  - exactly-once per compilation instance; unique (script_id, version)
  - required fields, ascending full offset/opcode/operand tables
  - sha1 source digest; bounded string constants; NO native addresses
  - distinguishability: same-name anonymous functions, same-source evals
    and same-script recompilations all carry DISTINCT instance keys
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
FIXTURE = ROOT / "test-pages/p55/d1-instance-keys.js"
EVIDENCE = ROOT / "chromium/src/out/XTraceP55D8/validation/d1-verify"


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8} (build out/XTraceP55D8 first)", file=sys.stderr)
        return 2
    run = EVIDENCE
    meta = run / "metadata"
    if meta.exists():
        for f in meta.iterdir():
            f.unlink()
    meta.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke",
         f"--xtrace-metadata-dir={meta}",
         "--allow-natives-syntax", str(FIXTURE)],
        capture_output=True, text=True, timeout=120)
    (run / "stdout.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0:
        print(f"d8 exited {proc.returncode}", file=sys.stderr)
        return 1

    files = sorted(meta.glob("*.json"))
    assert files, "no metadata assets emitted"
    blobs = {}
    for f in files:
        b = json.loads(f.read_text())
        key = (b["script_id"], b["bytecode_version"])
        assert key not in blobs, f"duplicate instance key {key}"
        blobs[key] = b
        for field in ("kind", "schema", "script_id", "bytecode_version",
                      "source", "parameter_count", "frame_size",
                      "instructions", "constants", "source_positions"):
            assert field in b, f"missing {field} in {f.name}"
        assert b["kind"] == "v8.bytecode-metadata" and b["schema"] == 1
        assert re.fullmatch(r"[0-9a-f]{40}", b["source"]["sha1"])
        ins = b["instructions"]
        n = ins["count"]
        assert n > 0
        for arr in ("offsets", "opcodes", "operands", "register_operands"):
            assert len(ins[arr]) == n, f"{arr} length mismatch in {f.name}"
        assert ins["offsets"] == sorted(ins["offsets"])
        assert "0x" not in f.read_text().lower(), "native address leaked"
        for c in b["constants"]:
            if "s" in c:
                assert len(c["s"]) <= 128

    names = {}
    for key, b in blobs.items():
        names.setdefault(b.get("function_name", ""), []).append(key)
    same_name = [v for v in names.values() if len(v) > 1]
    assert same_name, "fixture no longer produces same-name instances"
    for group in same_name:
        assert len(set(group)) == len(group)
    from collections import Counter
    sha_counts = Counter(b["source"]["sha1"] for b in blobs.values())
    multi = {s for s, c in sha_counts.items() if c > 1}
    assert multi, "fixture no longer produces same-source eval instances"
    for sha in multi:
        keys = [k for k, b in blobs.items() if b["source"]["sha1"] == sha]
        assert len(set(keys)) == len(keys)

    summary = {
        "instances": len(blobs),
        "same_name_groups": same_name,
        "same_source_digest_groups": len(multi),
        "verdict": "pass",
    }
    (run / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))
    print(f"P55-E1 D1 d8 VERIFY: PASS ({len(blobs)} instances)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
