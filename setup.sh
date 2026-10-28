#!/usr/bin/env bash
# Clones the BSV repositories that @bsv/mcp searches (code_search, find_function_definition) and reads
# BRCs from (brc_lookup), then prints the BSV_REPOS_DIR line to set for the server.
#
#   setup.sh <target_dir>   shallow-clone (--depth 1) each repository into <target_dir>/<name>
#   setup.sh --list         print the repository URLs, one per line, and exit
#
# A repository whose directory already exists is left alone; run `git pull` inside it to update.
set -uo pipefail

REPOS=(
  "https://github.com/bsv-blockchain/ts-stack"
  "https://github.com/bsv-blockchain/BRCs"
  "https://github.com/bsv-blockchain/arcade"
  "https://github.com/bsv-blockchain/bsv-desktop"
  "https://github.com/bsv-blockchain/go-wallet-toolbox"
  "https://github.com/icellan/runar"
)

usage() {
  echo "usage: $(basename "$0") <target_dir> | --list" >&2
}

case "${1:-}" in
  --list)
    printf '%s\n' "${REPOS[@]}"
    exit 0
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  "")
    usage
    exit 1
    ;;
  -*)
    echo "unknown option: $1" >&2
    usage
    exit 1
    ;;
esac

if ! mkdir -p -- "$1"; then
  echo "error: cannot create $1" >&2
  exit 1
fi
# CDPATH= keeps cd from resolving a relative name elsewhere (and from printing that path into TARGET_DIR).
TARGET_DIR="$(CDPATH= cd -- "$1" && pwd)" || { echo "error: cannot enter $1" >&2; exit 1; }

failures=0
for url in "${REPOS[@]}"; do
  name="$(basename "$url")"
  dest="$TARGET_DIR/$name"
  if [ -d "$dest" ]; then
    echo "skip   $name (already present; git pull inside it to update)"
    continue
  fi
  echo "clone  $url"
  if ! git clone --quiet --depth 1 "$url" "$dest"; then
    echo "error: failed to clone $url" >&2
    failures=$((failures + 1))
  fi
done

echo
if [ "$failures" -ne 0 ]; then
  echo "warning: $failures repository clone(s) failed; see above" >&2
fi
echo "Set this for @bsv/mcp (or pass it as -e BSV_REPOS_DIR=... to your MCP client):"
printf 'export BSV_REPOS_DIR=%q\n' "$TARGET_DIR"
[ "$failures" -eq 0 ]
