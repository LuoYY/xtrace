#!/usr/bin/env bash
# XTrace test-target gate (P5 re-freeze §17.2 remediation).
#
# Discipline: every test target is REBUILT before it is run — a red or a
# green from a stale binary counts for nothing. The gate fails if any
# rebuild or any suite fails. Targets cover BOTH xtrace suites: the
# renderer-side producer tests (blink_platform_unittests) and the
# browser-side controller tests (content_unittests).
#
# Usage: scripts/run_test_target_gates.sh [jobs]
# Evidence: out/XTraceIntegration/validation/test-target-gates-<ts>.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_REL="chromium/src/out/XTraceIntegration"
OUT="$ROOT/$OUT_REL"
JOBS="${1:-6}"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT/validation/test-target-gates-$STAMP.json"
mkdir -p "$OUT/validation"

fail() { echo "TEST-TARGET GATES: FAIL — $*" | tee -a "$REPORT.log" >&2; exit 1; }

run_suite() {
  local binary="$1" filter="$2" name="$3"
  local log="$OUT/validation/test-target-gates-$STAMP-$name.log"
  if ! "$OUT/$binary" --gtest_filter="$filter" >"$log" 2>&1; then
    echo "  suite FAILED (log: $log)"
    return 1
  fi
  grep -q "SUCCESS: all tests passed." "$log" || {
    echo "  suite did not report SUCCESS (log: $log)"
    return 1
  }
  local count
  count=$(grep -cE '^\[[0-9]+/[0-9]+\]' "$log" || true)
  echo "  $name: $count tests, SUCCESS"
  return 0
}

TARGETS="content_unittests blink_platform_unittests"
filter_for() {
  case "$1" in
    content_unittests) echo "XTraceCaptureControllerTest.*" ;;
    blink_platform_unittests) echo "XTraceProducerTest.*" ;;
    *) return 1 ;;
  esac
}

echo "== XTrace test-target gate: rebuild ALL targets first (stale binaries count for nothing)"
for target in $TARGETS; do
  echo "-- rebuilding $target (jobs=$JOBS, coordinator)"
  python3 "$ROOT/scripts/xtrace_build_coordinator.py" "$OUT_REL" "$target" \
    --jobs "$JOBS" || fail "rebuild of $target failed"
done

echo "== running suites on the fresh binaries"
PASS=1
RESULTS=""
for target in $TARGETS; do
  FILTER="$(filter_for "$target")" || fail "no filter for $target"
  echo "-- $target ($FILTER)"
  if run_suite "$target" "$FILTER" "$target"; then
    RESULTS+="\"$target\": \"pass\", "
  else
    RESULTS+="\"$target\": \"fail\", "
    PASS=0
  fi
done

BIN_INFO=""
for target in $TARGETS; do
  BIN_INFO+="\"$target.mtime\": \"$(stat -f '%Sm' "$OUT/$target")\", "
done

cat > "$REPORT" <<EOF
{
  "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "discipline": "rebuild-before-run (P5 re-freeze section 17.2): stale-binary results are void",
  "results": { ${RESULTS%, } },
  "binaries": { ${BIN_INFO%, } },
  "verdict": "$([ "$PASS" = 1 ] && echo pass || echo fail)"
}
EOF
echo "report: $REPORT"
[ "$PASS" = 1 ] || fail "one or more suites failed"
echo "TEST-TARGET GATES: PASS (controller + producer rebuilt and green)"
