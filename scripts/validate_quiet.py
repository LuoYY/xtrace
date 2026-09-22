#!/usr/bin/env python3
"""Validate a v3 trace with NO default API expectations (N4 helper).

The CLI defaults to the fingerprint profile when --expect is omitted;
drivers that only need the structural contract (schema, single capture,
count closure, ignition fields) call this helper instead.

Usage: python3 scripts/validate_quiet.py <trace.ndjson>
Exit 0 = valid; nonzero with a message on stdout otherwise.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_trace  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_quiet.py <trace.ndjson>", file=sys.stderr)
        return 2
    try:
        validate_trace.validate_trace(
            Path(sys.argv[1]), expected=[], schema_version=3)
    except validate_trace.TraceValidationError as error:
        print(f"FAIL: {error}")
        return 1
    print("VALID")
    return 0


if __name__ == "__main__":
    sys.exit(main())
