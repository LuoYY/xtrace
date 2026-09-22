#!/usr/bin/env bash
# One-click: generate + build a RELEASE, non-debug XTrace Chromium.
#
# The debug+component build (out/XTrace) is great for hacking on the C++/patch
# but runs JS/rendering ~an order of magnitude slower, so heavy SPAs can
# appear to "white-screen" while they crawl through startup. This builds a
# release flavour into a SEPARATE out dir so your debug build stays intact.
#
# The XTrace patches are applied to the source tree, not per-out-dir, so this
# build is still fully instrumented.
#
# Usage:   scripts/build_xtrace_release.sh                 # state B: observer compiled
#          OBSERVER=off scripts/build_xtrace_release.sh    # state A: observer NOT compiled
# Override out dir: OUT_DIR=out/XTrace-fast scripts/build_xtrace_release.sh
#   (defaults: on -> out/XTrace-release, off -> out/XTrace-release-A)
#
# F5 (review B6): upstream per-bytecode print tracing is explicitly OFF in
# these args — the perf baseline must not carry tracing cost. States A and
# B are matched except for the observer compile flag.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPOT_TOOLS="$ROOT/depot_tools"
SRC="$ROOT/chromium/src"
OBSERVER="${OBSERVER:-on}"
if [[ "$OBSERVER" != "on" && "$OBSERVER" != "off" ]]; then
  echo "OBSERVER must be 'on' or 'off' (got: $OBSERVER)" >&2
  exit 2
fi
DEFAULT_OUT="$([[ "$OBSERVER" == "on" ]] && echo out/XTrace-release || echo out/XTrace-release-A)"
OUT_DIR="${OUT_DIR:-$DEFAULT_OUT}"
NINJA_BIN="${NINJA_BIN:-$(command -v ninja || echo "$DEPOT_TOOLS/ninja")}"
GN_BIN="${GN_BIN:-"$SRC/buildtools/mac/gn"}"
# Prefer the tree-local ninja when present (same binary the debug build uses).
[[ -x "$SRC/third_party/ninja/ninja" ]] && NINJA_BIN="$SRC/third_party/ninja/ninja"

if [[ ! -d "$SRC" ]]; then
  echo "Chromium source not found at $SRC. Run scripts/bootstrap_chromium.sh first." >&2
  exit 1
fi

unset GOROOT GOTOOLDIR

# System python drives gn/ninja here (same interpreter selection as the
# P1-P3 XTraceIntegration builds); depot_tools bootstrapping is not needed.
python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("Chromium build requires python3 >= 3.10")
PY

if ! xcodebuild -version >/dev/null 2>&1 &&
  [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

cd "$SRC"

# Release args. Only is_debug/is_component_build differ from gn_gen_xtrace.sh;
# codecs are kept so media-heavy sites render realistically. Flip
# is_component_build=true if you want faster incremental relinks.
"$GN_BIN" gen "$OUT_DIR" --args="
is_debug=false
is_component_build=false
symbol_level=1
blink_symbol_level=1
treat_warnings_as_errors=false
use_siso=false
use_reclient=false
proprietary_codecs=true
ffmpeg_branding=\"Chrome\"
rtc_use_h264=true

# XTRACE F5 (B6): upstream print tracing OFF in the perf baseline; the
# structured observer's compile state selects the A/B state pair.
v8_enable_trace_unoptimized=false
v8_enable_trace_ignition=false
v8_enable_xtrace_ignition_observer=$([[ "$OBSERVER" == "on" ]] && echo true || echo false)
"

echo "==> gn gen done: $SRC/$OUT_DIR"
# N5 (resource plan §3/§4): every ninja invocation goes through the
# project coordinator — two-tier throttling (interactive -j2/-l3/-k1
# default, idle -j4/-l6), project-wide exclusive lock, QoS scheduling,
# and the disk/pressure watchdog over the managed group only. NINJA_BIN,
# BUILD_PROFILE, JOBS, LOAD_LIMIT and GEN_ONLY pass straight through;
# RESUME=1 keeps the confirmed args (skips the gn gen above).
if [[ "${RESUME:-0}" != "1" ]]; then :; fi
echo "==> building via the resource coordinator (${BUILD_PROFILE:-interactive})…"
python3 "$ROOT/scripts/xtrace_build_coordinator.py" "$SRC/$OUT_DIR" chrome \
  --profile "${BUILD_PROFILE:-interactive}" \
  ${NINJA_BIN:+--ninja-bin "$NINJA_BIN"} \
  ${JOBS:+--jobs "$JOBS"} ${LOAD_LIMIT:+--load-limit "$LOAD_LIMIT"} \
  ${GEN_ONLY:+--gen-only}

# XTRACE P3-E9: the bundle directory is ChromiumX.app (executable inside
# remains Contents/MacOS/Chromium).
APP="$SRC/$OUT_DIR/ChromiumX.app"
echo
echo "==> Done. Release XTrace build: $APP"
echo "    Run a real page with it, e.g.:"
echo
echo "    cd xtrace-launcher && PYTHONPATH=. python3 -m xtrace_launcher run \\"
echo "      --chromium $APP \\"
echo "      --url 'https://example.com/' \\"
echo "      --log-dir ../logs/release-smoke --xtrace-categories fingerprint \\"
echo "      --xtrace-capture-values summary --xtrace-capture-assets summary"
