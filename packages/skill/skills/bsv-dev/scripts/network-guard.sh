#!/usr/bin/env bash
# Network guard: call it when the app boots and refuse to start on a non-zero exit.
#
# usage: scripts/network-guard.sh
#   Reads BSV_NETWORK only (unset or empty means testnet). The one variable switches the app's network;
#   there is no second opt-in for apps.
#   Exits 0 for testnet or mainnet (mainnet prints a banner), 2 for any other value.
set -euo pipefail

network="${BSV_NETWORK:-testnet}"

case "$network" in
  testnet)
    echo "network: testnet"
    ;;
  mainnet)
    echo "**************************************************"
    echo "*** MAINNET: real money. BSV_NETWORK=mainnet ***"
    echo "**************************************************"
    ;;
  *)
    printf 'BSV_NETWORK must be testnet or mainnet (got: %s)\n' "$network" >&2
    exit 2
    ;;
esac
