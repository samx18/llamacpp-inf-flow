#!/usr/bin/env bash
# Fetch stories260K.gguf into models/ and verify its SHA-256.
# The ggml-org/models repo was renamed to ggml-org/models-moved (old URL 307-redirects there).
set -euo pipefail
cd "$(dirname "$0")/.."
URL="https://huggingface.co/ggml-org/models-moved/resolve/main/tinyllamas/stories260K.gguf"
SHA256="270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d"
OUT="models/stories260K.gguf"
mkdir -p models
if [[ ! -f "$OUT" ]]; then
  curl -fL --retry 3 -o "$OUT.part" "$URL"
  mv "$OUT.part" "$OUT"
fi
echo "$SHA256  $OUT" | shasum -a 256 -c -
