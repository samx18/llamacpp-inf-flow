#!/usr/bin/env bash
# Regenerate web/public/demo-trace.jsonl (the UI fixture and the Record mode trace) from the
# run in web/src/record/script.ts (RECORD_RUN), and validate it.
set -euo pipefail
cd "$(dirname "$0")/.."
read_field() { node -e '
  const s = require("fs").readFileSync("web/src/record/script.ts", "utf8");
  const run = s.slice(s.indexOf("RECORD_RUN"));
  const m = run.match(new RegExp(process.argv[1] + ":\\s*(\x27([^\x27]*)\x27|(\\d+))"));
  if (!m) { console.error("field not found: " + process.argv[1]); process.exit(1); }
  process.stdout.write(m[2] ?? m[3]);' "$1"; }
PROMPT=$(read_field prompt); SEED=$(read_field seed); N=$(read_field n_predict)
echo "fixture: prompt=\"$PROMPT\" seed=$SEED n_predict=$N"
engine/build/bin/tracer --model models/stories260K.gguf --prompt "$PROMPT" \
  --seed "$SEED" --n-predict "$N" > web/public/demo-trace.jsonl
node scripts/validate-trace.mjs web/public/demo-trace.jsonl
