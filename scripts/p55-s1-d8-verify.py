#!/usr/bin/env python3
"""P55-S1 d8 verification: token-rooted dump contract.

RR1/RR2 ruling — the ONLY dump root is a tap-registered token; the
expression path is gone. Verifies on d8 (all cases must hold on the
FIXED binary; this is not a red-freeze suite):
  root-dump      - a receiver tap registers a token; dumping it saves a
                   full own-data envelope with anchor.type=token
  path-dump      - own-data path ["a","b"] walks nested receivers and
                   elements, recorded in the envelope
  unknown-token  - a never-registered serial rejects (status 1)
  collected      - after the only strong ref is dropped and GC runs, the
                   weak two-phase token reports collected (status 2),
                   never a fabricated dump
  accessor-path  - an accessor path step rejects (status 4) and the
                   getter body NEVER runs (sentinel counter)
  proxy-path     - a Proxy step rejects (status 4); trap never runs
  miss-path      - a missing own property rejects (status 4)
  scalar-path    - a path ending at a scalar rejects (status 4)
  bad-json       - malformed path JSON rejects (status 3)

Object liveness in the interpreter is sensitive to the tapping shape (a
closure-captured slot, or a returned object lingering in a live frame
register, roots the object legitimately — the token registry itself is
weak). The collected case therefore runs in its OWN d8 process with the
proven parameter shape.
"""
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
D8 = ROOT / "chromium/src/out/XTraceP55D8/d8"
STAMP = time.strftime("%Y%m%d-%H%M%S")
RUN = ROOT / f"chromium/src/out/XTraceP55D8/validation/p55-s1-{STAMP}"
RESULTS = []

SRC = r"""
const holder = {a: {deep: 1, b: [7, 8, 9]}, g: 5};
Object.defineProperty(holder, 'trap', {
  get() { globalThis.trapRuns = (globalThis.trapRuns || 0) + 1; return 1; },
  configurable: true});
holder.proxyStep = new Proxy({}, {
  get() { globalThis.proxyRuns = (globalThis.proxyRuns || 0) + 1; return 2; }});
function f() { for (let i = 0; i < 2; i++) { const x = holder; } return 1; }
f();
// Deterministic token discovery: the registry answers for THIS object.
const tok = xtraceTokenOf(holder);
print('TOKEN holder=' + tok);
print('CASE root ' + xtraceTokenDump(tok, null, 'root'));
print('CASE path ' + xtraceTokenDump(tok, '["a","b"]', 'via-path'));
print('CASE unknown ' + xtraceTokenDump(99999999, null, 'x'));
print('CASE accessor ' + xtraceTokenDump(tok, '["trap"]', 'x'));
print('CASE proxy ' + xtraceTokenDump(tok, '["proxyStep","anything"]', 'x'));
print('CASE miss ' + xtraceTokenDump(tok, '["nope"]', 'x'));
print('CASE scalar ' + xtraceTokenDump(tok, '["g"]', 'x'));
print('CASE badjson ' + xtraceTokenDump(tok, 'not-json', 'x'));
print('SENSE trapRuns=' + (globalThis.trapRuns || 0) +
      ' proxyRuns=' + (globalThis.proxyRuns || 0));
print('DONE');
"""

DEAD_SRC = r"""
// frame-death shape: the object lives ONLY in probe()'s frame registers
// (no closure/context capture — the tap helper takes a parameter); the
// frame dies at return and only the numeric token escapes, so the weak
// two-phase handle deterministically retires under the forced GCs.
function probe(tag) {
  let o = {tag: tag, nested: [tag.charCodeAt(0)]};
  function t(x) { const y = x; return y; }
  t(o);
  const tok = xtraceTokenOf(o);
  return tok;
}
const pTok = probe('P');
const qTok = probe('Q');
gc(); gc(); gc();
print('CASE dead ' + xtraceTokenDump(pTok, null, 'x'));
print('CASE dead2 ' + xtraceTokenDump(qTok, null, 'x'));
print('DONE');
"""


def check(name, ok, detail=""):
    RESULTS.append({"case": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS" if ok else "FAIL") + f"  {name}" +
          ("" if ok else f" — {detail}"))


def run(name, source):
    d = RUN / name
    (d / "dumps").mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(D8), "--xtrace-observer-smoke", "--max-opt=0", "--expose-gc",
         "--xtrace-tap-windows={\"windows\":[{\"id\":0,\"start\":0,"
         "\"end\":999999}],\"max_taps\":200,\"max_window\":500}",
         f"--xtrace-dump-dir={d / 'dumps'}", "-e", source],
        capture_output=True, text=True, timeout=120)
    (d / "run.log").write_text(proc.stdout + proc.stderr)
    return proc, d


def parse_cases(out):
    rc = {}
    tok = "0"
    for line in out.splitlines():
        if line.startswith("CASE ") or line.startswith("SENSE "):
            parts = line.split()
            rc[parts[1]] = parts[2] if len(parts) > 2 else ""
        elif line.startswith("TOKEN holder="):
            tok = line.split("holder=")[1].split()[0]
    return rc, tok


def main() -> int:
    if not D8.is_file():
        print(f"d8 missing: {D8}", file=sys.stderr)
        return 2
    RUN.mkdir(parents=True, exist_ok=True)

    proc, d = run("token-matrix", SRC)
    rc, tok = parse_cases(proc.stdout)
    dumps = {}
    for f in sorted((d / "dumps").glob("dump-*.json")):
        dumps[f.name] = json.loads(f.read_text(errors="replace"))

    check("s1.root-dump-saved", rc.get("root") == "0" and len(dumps) >= 1,
          f"rc={rc.get('root')} dumps={sorted(dumps)}")
    if dumps:
        first = dumps[sorted(dumps)[0]]
        check("s1.root-envelope-token-anchor",
              first["anchor"].get("type") == "token" and
              first["anchor"].get("token") == int(tok) and
              "g" in json.dumps(first["root"]),
              json.dumps(first["anchor"]))
        want_dense = [{"t": "i", "v": n} for n in (7, 8, 9)]
        via = [v for v in dumps.values()
               if v["anchor"].get("path") == ["a", "b"]]
        check("s1.path-dump-walks-own-data",
              rc.get("path") == "0" and
              any(v["root"].get("t") == "array" and
                  v["root"].get("dense") == want_dense for v in via),
              f"rc={rc.get('path')} via={[v['root'].get('dense') for v in via]}")
    check("s1.unknown-token-rejects", rc.get("unknown") == "1", rc)
    check("s1.accessor-path-rejects-without-invoking",
          rc.get("accessor") == "4" and "trapRuns=0" in proc.stdout,
          f"rc={rc.get('accessor')} sense={rc.get('SENSE', '')}")
    check("s1.proxy-step-rejects",
          rc.get("proxy") == "4" and "proxyRuns=0" in proc.stdout,
          f"rc={rc.get('proxy')}")
    check("s1.miss-path-rejects", rc.get("miss") == "4", rc)
    check("s1.scalar-path-rejects", rc.get("scalar") == "4", rc)
    check("s1.bad-json-rejects", rc.get("badjson") == "3", rc)

    # dead-token contract in its own process (see module docstring)
    dead_proc, _ = run("dead-token", DEAD_SRC)
    dead_rc, _ = parse_cases(dead_proc.stdout)
    check("s1.dead-token-reports-collected",
          dead_rc.get("dead") == "2" and dead_rc.get("dead2") == "2",
          f"dead={dead_rc.get('dead')} dead2={dead_rc.get('dead2')}")

    (RUN / "summary.json").write_text(json.dumps(RESULTS, indent=1))
    print(f"evidence: {RUN}")
    bad = [r for r in RESULTS if not r["ok"]]
    if bad:
        print(f"P55-S1 D8 VERIFY: FAIL ({len(bad)} cases)")
        return 1
    print("P55-S1 D8 VERIFY: GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
