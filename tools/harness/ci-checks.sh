#!/usr/bin/env bash
# §122.168 every check-*.mjs (the record check among them), for CI: a few at a time, each with its own log.
#   bash tools/harness/ci-checks.sh [OUT] [JOBS]
# Run in New York time, as the checks were written (some time the staff's working day by the local clock).
# Exits 1 if any check fails, and prints the failing lines of each. KNOWN lists checks that already failed at r288,
# skipped until they're fixed (each is named in the plan, §122.168); take a name off the list once it passes.
cd "$(dirname "$0")/../.." || exit 1
OUT=${1:-/tmp/tfo-ci}; JOBS=${2:-3}; mkdir -p "$OUT"; : > "$OUT/ci.txt"
KNOWN=" "
ls tools/harness/check-*.mjs | while read -r f; do
  n=$(basename "$f" .mjs)
  case "$KNOWN" in *" $n "*) echo "$n SKIP" >> "$OUT/ci.txt"; continue ;; esac
  echo "$f"
done | xargs -P "$JOBS" -I{} bash -c 'n=$(basename {} .mjs); TZ=America/New_York timeout 1500 node {} > "'"$OUT"'/$n.txt" 2>&1; echo "$n EXIT $?" >> "'"$OUT"'/ci.txt"'
FAILED=$(grep " EXIT " "$OUT/ci.txt" | grep -v " EXIT 0" | cut -d' ' -f1)
echo "$(grep -c ' EXIT 0' "$OUT/ci.txt") passed, $(grep -c ' SKIP' "$OUT/ci.txt") skipped (known), $(echo -n "$FAILED" | grep -c .) failed"
for n in $FAILED; do echo "── $n"; grep -E "FAIL|Error" "$OUT/$n.txt" | head -12; done
[ -z "$FAILED" ]
