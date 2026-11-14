#!/usr/bin/env bash
# Phase 0 check: llama-eval-callback runs on the model with a story prompt and prints
# named tensors including kq_soft_max-0 and result_output.
# Flash attention must be off: with the default (auto) the CPU backend fuses attention into
# FLASH_ATTN_EXT and no kq_soft_max-N tensor exists.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=engine/build/bin/llama-eval-callback
OUT=$(mktemp)
"$BIN" -m models/stories260K.gguf -p "Once upon a time" -t 1 -fa off >"$OUT" 2>&1
names=$(grep "common_debug_cb_eval:" "$OUT" | sed -E 's/^.*common_debug_cb_eval: *//; s/ = .*//')
echo "nodes printed: $(echo "$names" | wc -l | tr -d ' ')"
for want in kq_soft_max-0 result_output; do
  line=$(grep -m1 "common_debug_cb_eval: *$want = " "$OUT" | sed -E 's/^.*common_debug_cb_eval: *//')
  if [[ -z "$line" ]]; then echo "FAIL: $want not printed"; exit 1; fi
  echo "found: $line"
done
echo "named tensors (layer 0 + head):"
echo "$names" | grep -E -- '-0$|^result|^embd|^norm$' | sort -u | tr '\n' ' '; echo
echo "PASS"
