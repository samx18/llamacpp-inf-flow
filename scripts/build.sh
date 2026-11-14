#!/usr/bin/env bash
# Configure and build the tracer plus the llama.cpp reference examples (CPU only).
set -euo pipefail
cd "$(dirname "$0")/.."
cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build -j --target ${TARGETS:-tracer simple-ids llama-eval-callback llama-simple}
