#!/usr/bin/env bash
# CLI walkthrough against a deployed Steady Pay contract on testnet.
# Usage: scripts/walkthrough.sh <contract> <freelancer> <client> <tax_wallet>
# Signs with the legacy keychain (~/.near-credentials). Prints each step and its transaction ID.
set -u
C=$1; ME=$2; CLIENT=$3; TAX=$4
NET="network-config testnet"
call() { # signer method args deposit
  echo "### $1 -> $2 $3 (attach $4)"
  near contract call-function as-transaction "$C" "$2" json-args "$3" prepaid-gas '50 Tgas' \
    attached-deposit "$4" sign-as "$1" $NET sign-with-legacy-keychain send 2>&1 \
    | grep -E "Transaction ID|panicked|Error|error:|succeeded|failed" | sed 's/\x1b\[[0-9;]*m//g'
  echo
}
view() { echo "### get_vault"; near contract call-function as-read-only "$C" get_vault json-args "{\"owner\":\"$ME\"}" $NET now 2>&1 | sed -n '/^{/,/^}/p'; echo; }

call "$ME" create_vault "{\"salary\":\"500000000000000000000000\",\"period_ms\":60000,\"tax_percent\":30,\"tax_wallet\":\"$TAX\"}" '0.01 NEAR'
call "$CLIENT" deposit "{\"owner\":\"$ME\"}" '3 NEAR'
view
echo "--- claiming before payday (should fail)"; call "$ME" claim_salary '{}' '0 NEAR'
echo "--- waiting 65 s for payday"; sleep 65
call "$ME" claim_salary '{}' '0 NEAR'
echo "--- trying to raise salary (should fail)"; call "$ME" lower_salary '{"new_salary":"900000000000000000000000"}' '0 NEAR'
call "$ME" lower_salary '{"new_salary":"400000000000000000000000"}' '0 NEAR'
call "$ME" withdraw_tax '{}' '0 NEAR'
echo "--- quiet months: waiting 125 s without claiming"; sleep 125
view
call "$ME" claim_salary '{}' '0 NEAR'
view
