#!/usr/bin/env bash
# The full suite: the season sim, multi-season, every check-*.mjs, and every test-*-ui.mjs
# in dark and light. Outputs go to OUT (default /tmp/tfo-suite): suite.txt (one line per
# run with its exit code; DONE at the end), season.txt, multi.txt, c-<name>.txt, u-<name>-<theme>.txt,
# and screenshots in shots/. UI tests need a static server on :8765 serving the repo's parent:
#   cd /root && python3 -m http.server 8765        (start it in the background first)
#   bash tools/harness/suite.sh [OUT]
#   grep -v "EXIT 0" OUT/suite.txt                 (what failed)
cd "$(dirname "$0")/../.." || exit 1
S=${1:-/tmp/tfo-suite}; mkdir -p "$S/shots"
R=$S/suite.txt; : > "$R"
(timeout 1500 node tools/harness/sim-season.js 142 1 > "$S/season.txt" 2>&1; echo "season EXIT $?" >> "$R") &
(timeout 1500 node tools/harness/multi-season.mjs > "$S/multi.txt" 2>&1; echo "multi EXIT $?" >> "$R") &
for f in tools/harness/check-*.mjs; do n=$(basename "$f" .mjs); timeout 900 node "$f" > "$S/c-$n.txt" 2>&1; echo "$n EXIT $?" >> "$R"; done
for f in tools/harness/test-*-ui.mjs; do n=$(basename "$f" .mjs); for t in dark light; do timeout 900 node "$f" "$S/shots" "$t" > "$S/u-$n-$t.txt" 2>&1; echo "$n $t EXIT $?" >> "$R"; done; done
wait; echo DONE >> "$R"
