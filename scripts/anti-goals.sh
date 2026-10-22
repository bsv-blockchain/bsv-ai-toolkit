#!/usr/bin/env bash
# Anti-goal grep: the kit never waits for confirmation, never uses ARC (`/v1/tx`, the SDK `ARC` class,
# `ARC_URL`) and never treats WhatsOnChain as truth for a known txid. Any line that mentions one of these
# must be a "never do this" sentence, i.e. carry an allowlist marker.
#
# usage: scripts/anti-goals.sh [path ...]
#   With no arguments, scans the default paths relative to the repo root. Paths that do not exist are skipped.
#   Exits 0 when clean, 1 on an unmarked hit, 2 when grep cannot read the paths.
set -euo pipefail

# Prose: matched as fixed strings, ignoring case.
prose=(
  'wait for confirmation'
  'waiting for confirmation'
  'fetch the parent from WhatsOnChain'
)
# Code tokens: matched as fixed strings, case-sensitive (so `ARCADE_URL` and `arcade` never match).
tokens=(
  '/v1/tx'
  'ARC_URL'
  'new ARC('
)
# `import { ARC` as a named import of the whole word ARC anywhere in the braces, never `ArcadeClient`.
import_arc='import \{([^}]*[^A-Za-z0-9_$])?ARC([^A-Za-z0-9_$]|$)'
markers="never|not |don't|anti-goal|forbidden|G-0|G-1"

if [ "$#" -eq 0 ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  set -- "$root/content" "$root/packages/skill/skills" "$root/docs/writechoice" "$root"/samples/*/README.md
fi

paths=()
for p in "$@"; do
  [ -e "$p" ] && paths+=("$p")
done
if [ "${#paths[@]}" -eq 0 ]; then
  echo "anti-goals: ok (no paths to scan)"
  exit 0
fi

# Runs grep with the given flags and patterns over the paths and appends its hits to $hits.
# grep exits 1 when nothing matches (the clean case); any other non-zero status is an error.
hits=""
scan() {
  local out status=0
  out="$(grep -rnHI "$@" -- "${paths[@]}")" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "anti-goals: grep failed (exit $status); not reporting clean" >&2
    exit 2
  fi
  [ -n "$out" ] && hits+="$out"$'\n'
  return 0
}

args=()
for p in "${prose[@]}"; do args+=(-e "$p"); done
scan -iF "${args[@]}"
args=()
for t in "${tokens[@]}"; do args+=(-e "$t"); done
scan -F "${args[@]}"
scan -E -e "$import_arc"

failed=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  text="${hit#*:}"
  text="${text#*:}"
  if ! printf '%s\n' "$text" | grep -qiE -- "$markers"; then
    echo "anti-goal hit (line carries no allowlist marker): $hit"
    failed=1
  fi
done <<< "$hits"

if [ "$failed" -ne 0 ]; then
  echo "anti-goals: FAILED. Reword the line, or make it a \"never do this\" sentence (markers: $markers)." >&2
  exit 1
fi
echo "anti-goals: ok (${#paths[@]} path(s) scanned)"
