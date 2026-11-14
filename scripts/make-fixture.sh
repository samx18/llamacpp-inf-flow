#!/usr/bin/env bash
# Regenerate web/public/demo-trace.jsonl (the UI development fixture) and validate it.
set -euo pipefail
cd "$(dirname "$0")/.."
engine/build/bin/tracer --model models/stories260K.gguf --prompt "Once upon a time" \
  --seed 1 --n-predict 12 > web/public/demo-trace.jsonl
node scripts/validate-trace.mjs web/public/demo-trace.jsonl
