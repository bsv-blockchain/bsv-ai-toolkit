#!/usr/bin/env bash
# Anti-goal grep: the kit never waits for confirmation, never uses ARC (`/v1/tx`, the SDK `ARC` class,
# `ARC_URL`) and never treats WhatsOnChain as truth for a known txid. Any line that mentions one of these
# must be a "never do this" sentence, i.e. carry an allowlist marker.
#
# usage: scripts/anti-goals.sh [path ...]
#   With no arguments, scans the default paths relative to the repo root. Paths that do not exist are skipped.
set -euo pipefail

forbidden=(
  'wait for confirmation'
  'waiting for confirmation'
  '/v1/tx'
  'ARC_URL'
  'fetch the parent from WhatsOnChain'
  'new ARC('
  'import { ARC'
)
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

patterns=()
for f in "${forbidden[@]}"; do patterns+=(-e "$f"); done

# grep exits 1 when nothing matches; that is the clean case.
hits="$(grep -rnHIiF "${patterns[@]}" -- "${paths[@]}" || true)"

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
