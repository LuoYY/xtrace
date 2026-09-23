# P5 review fix 3: the generation-frozen WebIDL coverage table must equal
# the ACTUAL injection set in the generated bindings code. The table is
# derived from per-interface fragments written by bind_gen's own injection
# registry; this test is the permanent guard against the two drifting
# apart (the review found a 12-vs-18+ understatement).
#
# It scans the compiled tree's generated v8_*.cc files for scope
# constructions and TryEnter-gated NADC constructions, extracts
# (interface, member) pairs from the literal arguments, and asserts set
# equality with gen/xtrace/webidl_coverage.json.
import json
import os
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "chromium/src/out/XTraceIntegration"

SCOPE_RE = re.compile(
    r'XTraceGeneratedScope xtrace_generated_scope\("'
    r'(?P<api>[^"]+)", '
    r'blink::xtrace::XTraceGeneratedScope::k(?P<kind>\w+), '
    r'"(?P<interface>[^"]+)", "(?P<member>[^"]+)", '
    r'(?P<overloads>\d+)'
)

EXPECTED_INTERFACES = {
    "URL", "Element", "Response", "Performance", "NADCAttributeTest",
}


def _out_dir() -> Path:
    return Path(os.environ.get("XTRACE_OUT_DIR", str(DEFAULT_OUT)))


def _scan_generated_code(bindings_gen: Path) -> dict:
    injected = {}
    v8_files = sorted(bindings_gen.glob("*/v8/v8_*.cc"))
    for path in v8_files:
        text = path.read_text(errors="replace")
        for match in SCOPE_RE.finditer(text):
            interface = match.group("interface")
            member = match.group("member")
            injected.setdefault(interface, set()).add(member)
    return injected


class WebIdlCoverageConsistency(unittest.TestCase):
    def setUp(self):
        out_dir = _out_dir()
        coverage_path = out_dir / "gen/xtrace/webidl_coverage.json"
        bindings_gen = out_dir / "gen/third_party/blink/renderer/bindings"
        if not coverage_path.is_file() or not bindings_gen.is_dir():
            self.skipTest(
                f"no instrumented build under {out_dir} "
                "(run the Chromium bindings generation first)"
            )
        self.table = json.loads(coverage_path.read_text())
        self.injected = _scan_generated_code(bindings_gen)

    def test_table_interfaces_are_exactly_the_first_batch(self):
        listed = set(self.table.get("interfaces", {}))
        self.assertEqual(listed, EXPECTED_INTERFACES)

    def test_injected_interfaces_are_all_first_batch(self):
        self.assertTrue(
            set(self.injected) <= EXPECTED_INTERFACES,
            f"out-of-batch injections found: "
            f"{sorted(set(self.injected) - EXPECTED_INTERFACES)}",
        )

    def test_table_equals_actual_injection_set(self):
        """The anti-lying guard: every supported/partial member in the
        table has a scope construction in the generated code, and every
        construction is listed. `unavailable` members must have none."""
        interfaces = self.table["interfaces"]
        problems = []
        for interface in EXPECTED_INTERFACES:
            listed_members = interfaces[interface]["members"]
            actual_members = self.injected.get(interface, set())
            for member, info in sorted(listed_members.items()):
                # v1 tables carried bare status strings; normalize.
                if isinstance(info, str):
                    info = {"status": info}
                status = info.get("status")
                if status in ("supported", "partial"):
                    if member not in actual_members:
                        problems.append(
                            f"{interface}.{member}: table says {status}, "
                            "no scope construction found"
                        )
                elif status == "unavailable":
                    if member in actual_members:
                        problems.append(
                            f"{interface}.{member}: table says unavailable, "
                            "but a scope construction exists"
                        )
            for member in sorted(actual_members - set(listed_members)):
                problems.append(
                    f"{interface}.{member}: scope construction exists, "
                    "table does not list it"
                )
        self.assertEqual(problems, [], "\n".join(problems))

    def test_entry_kinds_are_from_the_six_kind_set(self):
        allowed = {
            "getter", "setter", "overload-dispatcher", "constructor",
            "nadc-callback", "operation",
        }
        for interface in EXPECTED_INTERFACES:
            for member, info in (
                    self.table["interfaces"][interface]["members"].items()):
                if isinstance(info, str):
                    continue  # v1 shape: no entry-kind detail
                for kind in info.get("entry_kinds", []):
                    self.assertIn(kind, allowed)


if __name__ == "__main__":
    unittest.main()
