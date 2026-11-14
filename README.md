# Inside llama.cpp: Inference Flow Visualizer

A native tracer records one llama.cpp run as newline-delimited JSON events; a web page plays the
trace back stage by stage. See `PLAN.md` for the design.

## Pinned llama.cpp

`engine/third_party/llama.cpp` is a git submodule pinned to release tag **b12387**
(commit `a956a852c`, 2026-11-14). Internal tensor names shift between versions; bump the tag
deliberately and rerun the phase checks.

## Build and run

```sh
git submodule update --init
./scripts/fetch-model.sh        # models/stories260K.gguf from ggml-org/models-moved, SHA-256 checked
./scripts/build.sh              # CMake, CPU backend only
```

Model: `stories260K.gguf` from the `tinyllamas` folder of
<https://huggingface.co/ggml-org/models-moved>.

## Tracer

```sh
engine/build/bin/tracer --model models/stories260K.gguf --prompt "Once upon a time" --seed 1 --n-predict 12 > trace.jsonl
node scripts/validate-trace.mjs trace.jsonl     # needs: (cd web && npm install)
```

Regenerate the saved UI fixture with `./scripts/make-fixture.sh` (writes `web/public/demo-trace.jsonl`).
Checks: `./scripts/check-phase0.sh`, `python3 -I scripts/check-phase1.py`.
