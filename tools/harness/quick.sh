#!/usr/bin/env bash
# The per-release run (§122.78): only what the change touches. The full suite (suite.sh) runs every few releases.
#   bash tools/harness/quick.sh OUTDIR [--season] [--multi] name ...
#   name: a check (check-contracts) or a screen test (test-team-roster-ui, run dark and light)
# Results in OUTDIR/quick.txt ("name EXIT n"); the season and multi-season run alongside the checks.
# Screen tests need the test server: (cd /root && python3 -m http.server 8765) in the background.
S=${1:-/tmp/tfo-quick}; shift; mkdir -p "$S/shots"
R=$S/quick.txt; : > "$R"
for a in "$@"; do
  case "$a" in
    --season) (TZ=UTC timeout 1500 node tools/harness/sim-season.js 142 1 > "$S/season.txt" 2>&1; echo "season EXIT $?" >> "$R") & ;;
    --multi)  (timeout 1500 node tools/harness/multi-season.mjs > "$S/multi.txt" 2>&1; echo "multi EXIT $?" >> "$R") & ;;
  esac
done
for a in "$@"; do
  case "$a" in
    --*) ;;
    test-*) for t in dark light; do timeout 900 node "tools/harness/$a.mjs" "$S/shots" "$t" > "$S/u-$a-$t.txt" 2>&1; echo "$a $t EXIT $?" >> "$R"; done ;;
    *) timeout 900 node "tools/harness/$a.mjs" > "$S/c-$a.txt" 2>&1; echo "$a EXIT $?" >> "$R" ;;
  esac
done
wait; echo DONE >> "$R"
