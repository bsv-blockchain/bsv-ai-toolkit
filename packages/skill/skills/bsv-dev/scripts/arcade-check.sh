#!/usr/bin/env bash
# Reads a transaction's status from Arcade and prints the app's gate verdict.
#
# usage: scripts/arcade-check.sh <txid> [arcadeUrl]
#        scripts/arcade-check.sh --policy [arcadeUrl]
#   The URL defaults to ARCADE_URL, else to the public Arcade for BSV_NETWORK (unset means testnet).
#   Prints the GET /tx/{txid} JSON, then one line:
#     verdict: <seen-no-competitor|on-network-not-seen|pending|terminal|no-verdict>
#   using the same rules as the bsv-mcp arcade_status tool. Only seen-no-competitor is final for the app.
#   With --policy, prints the GET /policy JSON, then `satPerKb: <n>`.
#   Exits 0 on any answer from Arcade (a 404 is no-verdict: this Arcade never saw the txid, which is not a
#   rejection), 2 on a usage error, 3 when Arcade cannot be reached or gives no usable answer.
#   Uses jq when it is installed, else grep and sed.
set -euo pipefail

usage_line="usage: arcade-check.sh <txid> [arcadeUrl] | arcade-check.sh --policy [arcadeUrl]"
usage() {
  echo "$usage_line" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
case "$1" in
  -h | --help) echo "$usage_line"; exit 0 ;;
esac

mode=tx
txid=""
if [ "$1" = "--policy" ]; then
  mode=policy
else
  txid="$(printf '%s' "$1" | tr 'A-F' 'a-f')"
  hex64='^[0-9a-f]{64}$'
  if ! [[ "$txid" =~ $hex64 ]]; then
    echo "arcade-check: txid must be 64 hex characters" >&2
    usage
  fi
fi

url="${2:-${ARCADE_URL:-}}"
if [ -z "$url" ]; then
  network="${BSV_NETWORK:-testnet}"
  case "$network" in
    testnet) url="https://arcade-testnet-us-1.bsvblockchain.tech" ;;
    mainnet) url="https://arcade-us-1.bsvblockchain.tech" ;;
    *)
      printf 'BSV_NETWORK must be testnet or mainnet (got: %s)\n' "$network" >&2
      exit 2
      ;;
  esac
fi
while [ "${url%/}" != "$url" ]; do url="${url%/}"; done
http_url='^https?://[^[:space:]]+$'
if ! [[ "$url" =~ $http_url ]]; then
  echo "arcade-check: arcadeUrl must start with http:// or https://" >&2
  exit 2
fi

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1

# GET $1 with a 10 s timeout, ignoring ~/.curlrc (-q) and URL globbing (-g); sets $code (HTTP status) and $body. Exits 3 when Arcade cannot be reached.
code=""
body=""
fetch() {
  local out nl=$'\n'
  if ! out="$(curl -q -g -sS -m 10 -w '\n%{http_code}' "$1")"; then
    echo "arcade-check: could not reach Arcade" >&2
    exit 3
  fi
  code="${out##*"$nl"}"
  body="${out%"$nl"*}"
}

# The same rules as verdictOf in @bsv/mcp (src/arcade/classify.ts). $1 txStatus, $2 number of competing txids.
verdict_of() {
  case "$1" in
    REJECTED | DOUBLE_SPEND_ATTEMPTED) echo terminal; return ;;
  esac
  if [ "$2" -gt 0 ]; then
    echo pending
    return
  fi
  case "$1" in
    SEEN_ON_NETWORK | SEEN_MULTIPLE_NODES | MINED | STUMP_PROCESSING | IMMUTABLE) echo seen-no-competitor ;; # past the gate; never wait for MINED
    RECEIVED | SENT_TO_NETWORK | ACCEPTED_BY_NETWORK) echo on-network-not-seen ;;
    UNKNOWN | PENDING_RETRY) echo pending ;;
    *) echo no-verdict ;;
  esac
}

if [ "$mode" = policy ]; then
  fetch "$url/policy"
  if [ "$code" != 200 ]; then
    echo "arcade-check: GET /policy answered HTTP $code" >&2
    exit 3
  fi
  printf '%s\n' "$body"
  if [ "$have_jq" = 1 ]; then
    sats="$(printf '%s' "$body" | jq -r '.policy.miningFee.satoshis // empty' 2>/dev/null || true)"
    bytes="$(printf '%s' "$body" | jq -r '.policy.miningFee.bytes // empty' 2>/dev/null || true)"
  else
    fee="$(printf '%s' "$body" | tr -d '\r\n' | sed -n 's/.*"miningFee"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')"
    sats="$(printf '%s' "$fee" | sed -n 's/.*"satoshis"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')"
    bytes="$(printf '%s' "$fee" | sed -n 's/.*"bytes"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')"
  fi
  number='^[0-9]+(\.[0-9]+)?$'
  if ! [[ "$sats" =~ $number && "$bytes" =~ $number ]]; then
    echo "arcade-check: the answer has no policy.miningFee" >&2
    exit 3
  fi
  awk -v s="$sats" -v b="$bytes" 'BEGIN {
    if (b + 0 <= 0) exit 1
    v = s * 1000 / b
    if (v == int(v)) printf "satPerKb: %d\n", v; else printf "satPerKb: %.6g\n", v
  }' || { echo "arcade-check: policy.miningFee.bytes is zero" >&2; exit 3; }
  exit 0
fi

fetch "$url/tx/$txid"
case "$code" in
  200) ;;
  404)
    if [ -n "$body" ]; then printf '%s\n' "$body"; fi
    echo "arcade-check: 404 means this Arcade never saw the txid; it is not a rejection" >&2
    echo "verdict: no-verdict"
    exit 0
    ;;
  *)
    echo "arcade-check: GET /tx answered HTTP $code; no answer yet, read again later" >&2
    exit 3
    ;;
esac

printf '%s\n' "$body"
if [ "$have_jq" = 1 ]; then
  tx_status="$(printf '%s' "$body" | jq -r '.txStatus // empty | strings' 2>/dev/null || true)"
  competitors="$(printf '%s' "$body" | jq -r '(.competingTxs // []) | length' 2>/dev/null || true)"
else
  flat="$(printf '%s' "$body" | tr -d '\r\n')"
  tx_status="$(printf '%s' "$flat" | sed -n 's/.*"txStatus"[[:space:]]*:[[:space:]]*"\([A-Za-z_]*\)".*/\1/p')"
  competitors=0
  if grep -q '"competingTxs"[[:space:]]*:[[:space:]]*\[[[:space:]]*"' <<<"$flat"; then competitors=1; fi
fi
case "$competitors" in '' | *[!0-9]*) competitors=0 ;; esac

echo "verdict: $(verdict_of "$tx_status" "$competitors")"
