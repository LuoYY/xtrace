"""Schema v3 validator contract tests (P4-F0).

Deterministic synthetic fixtures pin the F0 hardening: the ignition
six-field contract (B4), activation_ref resolution, single-capture
identity, and the manifest `written` versus observed-record closure.
All fixtures are generated in-memory; no browser or recorded trace is
required to reproduce these assertions.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_validator():
    spec = importlib.util.spec_from_file_location(
        "validate_trace",
        Path(__file__).resolve().parents[1] / "scripts" / "validate_trace.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load_validator()


def ignition_field(**overrides):
    field = {
        "script_id": "12",
        "bytecode_version": "3",
        "bytecode_offset": "0",
        "opcode": "Ldar",
        "tier": "ignition",
        "activation_ref": "call-1",
    }
    field.update(overrides)
    return field


class V3TraceBuilder:
    """Builds one capture: NDJSON events plus a matching v3 manifest."""

    def __init__(self, capture_id="c-f0-0001"):
        self.capture_id = capture_id
        self.events = []
        self._writer_seq = 0
        self._producer_seq = {}

    def add(self, *, producer_id, api, category="reverse", phase="call",
            causality=None, ignition=None, config_generation="1",
            capture_id=None):
        self._writer_seq += 1
        seq = self._producer_seq.get(producer_id, 0) + 1
        self._producer_seq[producer_id] = seq
        event = {
            "schema_version": 3,
            "capture_id": capture_id or self.capture_id,
            "producer_id": producer_id,
            "process_epoch": "1",
            "producer_seq": str(seq),
            "writer_seq": str(self._writer_seq),
            "config_generation": config_generation,
            "mono_time_us": str(1000 + self._writer_seq),
            "wall_time_us": str(1700000000000000 + self._writer_seq),
            "pid": 100,
            "tid": 200,
            "category": category,
            "phase": phase,
            "api": api,
            "args": [],
            "stack": [],
            "attribution": {"status": "unresolved"},
            "causality": causality or {"kind": "external"},
        }
        if ignition is not None:
            event["ignition"] = ignition
        self.events.append(event)
        return event

    def standard(self):
        """One renderer producer (paired call + ignition records) and one
        browser producer; complete manifest; all counts closed."""
        self.add(
            producer_id="renderer-r1",
            api="JSON.stringify",
            causality={"kind": "paired", "call_id": "call-1"},
        )
        self.add(producer_id="renderer-r1", api="Ignition.execute",
                 ignition=ignition_field(bytecode_offset="0", opcode="Ldar"))
        self.add(producer_id="renderer-r1", api="Ignition.execute",
                 ignition=ignition_field(bytecode_offset="5", opcode="Star0"))
        self.add(
            producer_id="renderer-r1",
            api="JSON.stringify",
            phase="return",
            causality={
                "kind": "paired",
                "call_id": "call-1",
                "duration_us": "42",
            },
        )
        self.add(producer_id="browser-bnet-1", category="network",
                 api="fetch")
        return self

    def manifest_for(self, events, state="complete"):
        per_producer = {}
        for event in events:
            per_producer.setdefault(event["producer_id"], []).append(event)
        producers = []
        totals = {key: 0 for key in (
            "eligible", "enqueued", "dropped", "accepted", "written", "failed")}
        for pid, rows in per_producer.items():
            count = len(rows)
            producers.append({
                "producer_id": pid,
                "watermark": {"received": True},
                "eligible": str(count),
                "enqueued": str(count),
                "dropped": "0",
                "accepted": str(count),
                "written": str(count),
                "failed": "0",
                "assets_out": "0",
                "assets_written": "0",
                "assets_failed": "0",
                "final_producer_seq": rows[-1]["producer_seq"],
            })
            for key in ("eligible", "enqueued", "accepted", "written"):
                totals[key] += count
        return {
            "schema_version": 3,
            "manifest_version": 3,
            "capture_id": self.capture_id,
            "producers": producers,
            "counts": {key: str(value) for key, value in totals.items()},
            "terminal": {
                "state": state,
                "reason": None,
                "unconfirmed_producers": [],
            },
        }

    def write(self, directory, *, drop_last=False, manifest_state="complete",
              manifest_from_full=False, name="trace.ndjson"):
        written = self.events[:-1] if drop_last else self.events
        basis = self.events if (drop_last or manifest_from_full) else written
        trace_path = Path(directory) / name
        trace_path.write_text(
            "".join(json.dumps(event) + "\n" for event in written),
            encoding="utf-8",
        )
        manifest_path = trace_path.parent / (
            trace_path.stem + ".manifest.json")
        manifest_path.write_text(
            json.dumps(self.manifest_for(basis, state=manifest_state),
                       indent=2),
            encoding="utf-8",
        )
        return trace_path


class V3ValidatorContractTest(unittest.TestCase):
    def validate(self, path):
        validator.validate_trace(path, expected=[], schema_version=3)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def test_standard_fixture_passes(self):
        builder = V3TraceBuilder().standard()
        path = builder.write(self.dir)
        self.validate(path)  # must not raise

    def test_ignition_object_required(self):
        builder = V3TraceBuilder().standard()
        del builder.events[1]["ignition"]
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_missing_opcode_rejected(self):
        builder = V3TraceBuilder().standard()
        ignition = dict(builder.events[1]["ignition"])
        del ignition["opcode"]
        builder.events[1]["ignition"] = ignition
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_extra_field_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(extra_probe="x")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_unsupported_tier_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(tier="turbofan")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_negative_offset_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(bytecode_offset="-1")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_numeric_type_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(script_id=12)
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_bad_opcode_mnemonic_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(opcode="Ldar!")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_fabricated_opcode_rejected(self):
        # N0/R7: syntactically valid but not a bytecode of the pinned V8.
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(opcode="NotARealOpcode")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_future_activation_ref_rejected(self):
        # N0/R7: the ref resolves only to a paired activation that appears
        # AFTER the ignition record — temporally impossible.
        builder = V3TraceBuilder()
        builder.add(producer_id="renderer-r1", api="Ignition.execute",
                    ignition=ignition_field(activation_ref="late-call"))
        builder.add(
            producer_id="renderer-r1",
            api="JSON.stringify",
            causality={"kind": "paired", "call_id": "late-call"},
        )
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_null_activation_ref_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(activation_ref=None)
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_unresolved_activation_ref_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.events[1]["ignition"] = ignition_field(
            activation_ref="does-not-exist")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_ignition_ref_across_producers_rejected(self):
        # renderer-r2 references call-1 which lives in renderer-r1: same
        # call_id, wrong producer scope.
        builder = V3TraceBuilder().standard()
        builder.add(
            producer_id="renderer-r2",
            api="Ignition.execute",
            ignition=ignition_field(activation_ref="call-1"),
        )
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_mixed_capture_identity_rejected(self):
        builder = V3TraceBuilder().standard()
        builder.add(producer_id="renderer-r1", api="JSON.stringify",
                    capture_id="c-f0-9999")
        path = builder.write(self.dir)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_manifest_capture_mismatch_rejected(self):
        builder = V3TraceBuilder(capture_id="c-f0-0001").standard()
        path = builder.write(self.dir)
        manifest_path = path.parent / (path.stem + ".manifest.json")
        manifest = json.loads(manifest_path.read_text())
        manifest["capture_id"] = "c-f0-8888"
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_deleted_tail_with_complete_manifest_rejected(self):
        builder = V3TraceBuilder().standard()
        path = builder.write(self.dir, drop_last=True)
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_manifest_written_overcount_rejected(self):
        builder = V3TraceBuilder().standard()
        path = builder.write(self.dir)
        manifest_path = path.parent / (path.stem + ".manifest.json")
        manifest = json.loads(manifest_path.read_text())
        producer = manifest["producers"][0]
        producer["written"] = str(int(producer["written"]) + 1)
        manifest["counts"]["written"] = str(
            int(manifest["counts"]["written"]) + 1)
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)

    def test_corrupt_json_line_rejected(self):
        builder = V3TraceBuilder().standard()
        path = builder.write(self.dir)
        lines = path.read_text().splitlines()
        lines[1] = "{\"schema_version\": 3, \"broken\""
        path.write_text("\n".join(lines) + "\n")
        with self.assertRaises(validator.TraceValidationError):
            self.validate(path)


if __name__ == "__main__":
    unittest.main()
