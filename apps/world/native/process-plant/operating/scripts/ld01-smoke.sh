#!/bin/sh
# LD-01 smoke (resume plan P6 (a)): at most about 2 minutes on one core.
#
# Runs `water-ffi/tests/ld01_regression.rs::smoke` against the cached
# builds named by the environment, compiling nothing beyond the test binary
# (cached in CARGO_TARGET_DIR after the first run):
#   LD01_OPERATING_WATER_LIB_DIR     cached IF97 adapter (water-build.json)
#   LD01_OPERATING_SUNDIALS_PREFIX   cached stock SUNDIALS 7.5.0 + KLU prefix
#   LD01_OPERATING_HOT_SPINE_PACKET  cached joined packet; its sha256 must be
#                                    the expectation's environment.packet_sha256
#   LD01_WIKI_ROOT                   wiki archive (the ld01-s1-gates block)
# The census, Z1, the block-Jacobian oracle on 200 random columns, 1 s of
# settling and the release restart run in one process; their counts are
# compared with water-ffi/tests/ld01_regression/smoke-<os>-<arch>.json and a
# mismatch prints the differing paths and exits non-zero.
#
# Usage: scripts/ld01-smoke.sh            (from anywhere)
#        LD01_SMOKE_RECORD=<new file> scripts/ld01-smoke.sh
#            also writes the actual counts there (never over a file); a
#            changed expectation is committed only with the lead's reason.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
missing=""
for v in LD01_OPERATING_WATER_LIB_DIR LD01_OPERATING_SUNDIALS_PREFIX LD01_OPERATING_HOT_SPINE_PACKET LD01_WIKI_ROOT; do
  eval "value=\${$v:-}"
  [ -n "$value" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "ld01-smoke: set$missing (e.g. '. \$SP/env.sh <lane>')" >&2
  exit 2
fi
: "${CARGO_BUILD_JOBS:=2}"
export CARGO_BUILD_JOBS
log=$(mktemp "${TMPDIR:-/tmp}/ld01-smoke.XXXXXX")
started=$(date +%s)
cd "$here/water-ffi"
cargo test --release --features ida --test ld01_regression --no-run --quiet
built=$(date +%s)
status=0
cargo test --release --features ida --test ld01_regression -- \
  --ignored --exact smoke --test-threads=1 --nocapture >"$log" 2>&1 || status=$?
ended=$(date +%s)
# The summary: the run's info line (CPU by phase) and, on failure, the diff.
# libtest prints "test smoke ... " before the test's own output line.
summary=$(grep -o '{"info".*' "$log" | head -1 || true)
if [ -n "$summary" ] && command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "$summary" | python3 -c '
import json, sys
info = json.loads(sys.stdin.read())["info"]
phases = ", ".join("%s %.1f" % (k, v) for k, v in info["phase_cpu_s"].items())
print("ld01-smoke: process CPU %.1f s (%s); load %s" % (info["process_cpu_s"], phases, info["load_average"]))'
fi
if [ "$status" -ne 0 ]; then
  sed -n -E '/differs from|no committed|panicked/,/^note:/p' "$log" >&2
  echo "ld01-smoke: FAILED after $((ended - started)) s (build $((built - started)) s); full log $log" >&2
  exit "$status"
fi
echo "ld01-smoke: ok in $((ended - built)) s (build check $((built - started)) s)"
[ $((ended - built)) -le 120 ] || echo "ld01-smoke: over the 2-minute target (machine load?)" >&2
rm -f "$log"
