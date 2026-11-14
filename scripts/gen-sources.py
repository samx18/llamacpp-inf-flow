#!/usr/bin/env python3
"""Generate engine/build/generated/llama_sources.h from the pinned llama.cpp source.

The tracer reports where each stage's function and each named tensor live in llama.cpp, so the
UI's labels and source links come from the trace, and the locations are read from the exact
source that was built. The build fails if a required function definition is not found.

usage: gen-sources.py <llama.cpp dir> <output header>
"""
import os
import re
import sys

src_dir, out_path = sys.argv[1], sys.argv[2]

# key -> (file, regex matching the line that starts the definition, display name)
FUNCTIONS = {
    "tokenize":          ("src/llama-vocab.cpp",     r"^int32_t llama_tokenize\(",                          "llama_tokenize"),
    "token_to_piece":    ("src/llama-vocab.cpp",     r"^int32_t llama_token_to_piece\(",                    "llama_token_to_piece"),
    "vocab_is_eog":      ("src/llama-vocab.cpp",     r"^bool llama_vocab_is_eog\(",                         "llama_vocab_is_eog"),
    "batch_init":        ("src/llama-batch.cpp",     r"^struct llama_batch llama_batch_init\(",             "llama_batch_init"),
    "decode":            ("src/llama-context.cpp",   r"^int32_t llama_decode\(",                            "llama_decode"),
    "process_ubatch":    ("src/llama-context.cpp",   r"^llm_graph_result \* llama_context::process_ubatch\(", "llama_context::process_ubatch"),
    "build_graph":       ("src/llama-model.cpp",     r"^ggml_cgraph \* llama_model::build_graph\(",         "llama_model::build_graph"),
    "graph_compute":     ("src/llama-context.cpp",   r"^ggml_status llama_context::graph_compute\(",        "llama_context::graph_compute"),
    "sched_compute":     ("ggml/src/ggml-backend.cpp", r"^enum ggml_status ggml_backend_sched_graph_compute_async\(", "ggml_backend_sched_graph_compute_async"),
    "sched_splits":      ("ggml/src/ggml-backend.cpp", r"^static enum ggml_status ggml_backend_sched_compute_splits\(", "ggml_backend_sched_compute_splits"),
    "memory_pos_max":    ("src/llama-context.cpp",   r"^llama_pos llama_memory_seq_pos_max\(",              "llama_memory_seq_pos_max"),
    "get_logits_ith":    ("src/llama-context.cpp",   r"^float \* llama_get_logits_ith\(",                   "llama_get_logits_ith"),
    "sampler_apply":     ("src/llama-sampler.cpp",   r"^void llama_sampler_apply\(",                        "llama_sampler_apply"),
    "sampler_accept":    ("src/llama-sampler.cpp",   r"^void llama_sampler_accept\(",                       "llama_sampler_accept"),
    "sampler_greedy":    ("src/llama-sampler.cpp",   r"^static void llama_sampler_greedy_apply\(",          "llama_sampler_greedy_apply"),
    "sampler_dist":      ("src/llama-sampler.cpp",   r"^static void llama_sampler_dist_apply\(",            "llama_sampler_dist_apply"),
    "sampler_top-k":     ("src/llama-sampler.cpp",   r"^static void llama_sampler_top_k_apply\(",           "llama_sampler_top_k_apply"),
    "sampler_top-p":     ("src/llama-sampler.cpp",   r"^static void llama_sampler_top_p_apply\(",           "llama_sampler_top_p_apply"),
    "sampler_temp":      ("src/llama-sampler.cpp",   r"^static void llama_sampler_temp_apply\(",            "llama_sampler_temp_apply"),
}

# Per-architecture graph builders: src/models/<arch>.cpp, "llama_model_<arch>::graph<...>::graph(".
ARCH_GRAPH = re.compile(r"^llama_model_(\w+)::graph<\w+>::graph\(")

NAME_PATTERNS = [
    re.compile(r'\bcb\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*"([^"]+)"'),
    re.compile(r'\bggml_set_name\(\s*[^,]+,\s*"([^"]+)"'),
    re.compile(r'\bggml_format_name\(\s*[^,]+,\s*"([^"]+)"'),
]


def c_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def read(rel):
    with open(os.path.join(src_dir, rel), encoding="utf-8", errors="replace") as f:
        return f.read().split("\n")


errors = []
funcs = []
for key, (rel, pat, disp) in FUNCTIONS.items():
    rx = re.compile(pat)
    lines = read(rel)
    hits = [i + 1 for i, l in enumerate(lines) if rx.search(l)]
    if len(hits) != 1:
        errors.append(f"{key}: expected 1 definition matching {pat!r} in {rel}, found {len(hits)}")
        continue
    funcs.append((key, disp, rel, hits[0]))

arch_graphs = []
models_dir = os.path.join(src_dir, "src", "models")
for fn in sorted(os.listdir(models_dir)):
    if not fn.endswith(".cpp"):
        continue
    rel = f"src/models/{fn}"
    for i, l in enumerate(read(rel)):
        m = ARCH_GRAPH.search(l)
        if m:
            arch_graphs.append((rel, i + 1, f"llama_model_{m.group(1)}::graph"))
            break

names = []
scan = [f"src/{f}" for f in sorted(os.listdir(os.path.join(src_dir, "src"))) if f.endswith(".cpp")]
scan += [f"src/models/{f}" for f in sorted(os.listdir(models_dir)) if f.endswith(".cpp")]
for rel in scan:
    for i, l in enumerate(read(rel)):
        for rx in NAME_PATTERNS:
            for m in rx.finditer(l):
                names.append((m.group(1), rel, i + 1))

if errors:
    sys.stderr.write("gen-sources: llama.cpp source does not match the tracer's expectations:\n  " + "\n  ".join(errors) + "\n")
    sys.exit(1)

os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    f.write("// generated by scripts/gen-sources.py from the pinned llama.cpp source; do not edit\n#pragma once\n")
    f.write("struct SrcFunc { const char * key; const char * fn; const char * file; int line; };\n")
    f.write("struct SrcName { const char * name; const char * file; int line; };\n")
    f.write("static const SrcFunc k_src_funcs[] = {\n")
    for key, disp, rel, line in funcs:
        f.write(f"    {{{c_str(key)}, {c_str(disp)}, {c_str(rel)}, {line}}},\n")
    f.write("};\nstatic const SrcFunc k_src_arch_graphs[] = {\n")
    for rel, line, disp in arch_graphs:
        f.write(f"    {{{c_str(rel)}, {c_str(disp)}, {c_str(rel)}, {line}}},\n")
    f.write("};\nstatic const SrcName k_src_names[] = {\n")
    for name, rel, line in names:
        f.write(f"    {{{c_str(name)}, {c_str(rel)}, {line}}},\n")
    f.write("};\n")
print(f"gen-sources: {len(funcs)} functions, {len(arch_graphs)} arch graph builders, {len(names)} tensor name sites")
