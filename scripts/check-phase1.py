#!/usr/bin/env python3
"""Phase 1 checks for the native tracer.

1. A default (dist sampling) trace validates against the JSON Schema and invariants.
2. Greedy: tracer token ids == examples/simple token ids on the same prompt, for several prompts.
   - ids: engine/ref/simple_ids.cpp (examples/simple + one line printing ids)
   - text: the unmodified llama-simple binary, byte for byte
3. Node count and edges are stable across two runs (every graph event identical).

Run: python3 scripts/check-phase1.py   (after ./scripts/build.sh)
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "engine", "build", "bin")
MODEL = os.path.join(ROOT, "models", "stories260K.gguf")
TRACER = os.path.join(BIN, "tracer")

PROMPTS = ["Once upon a time", "The little dog", "Lily and Tom went to the park", "One day, a"]
N_PREDICT = 32

failures = []


def check(cond, msg):
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def run_tracer(args, env=None):
    p = subprocess.run([TRACER, "--model", MODEL] + args, capture_output=True, env=env)
    if p.returncode != 0:
        print(p.stderr.decode(errors="replace"))
        raise SystemExit("tracer failed")
    return p.stdout.decode()


def events(text):
    return [json.loads(l) for l in text.splitlines() if l]


def validate(text, label):
    p = subprocess.run(["node", os.path.join(ROOT, "scripts", "validate-trace.mjs"), "-"],
                       input=text.encode(), capture_output=True)
    out = (p.stdout + p.stderr).decode().strip()
    check(p.returncode == 0, f"{label}: {out.splitlines()[0] if out else ''}")
    for line in out.splitlines()[1:]:
        print("        " + line.strip())


print("== 1. schema validation")
default_trace = run_tracer(["--prompt", "Once upon a time", "--seed", "1", "--n-predict", "12"])
validate(default_trace, "dist sampling, seed 1, n_predict 12")

print(f"== 2. greedy token ids vs examples/simple (n_predict {N_PREDICT})")
for prompt in PROMPTS:
    tr = events(run_tracer(["--prompt", prompt, "--greedy", "--n-predict", str(N_PREDICT)]))
    tr_ids = [e["id"] for e in tr if e["type"] == "token_selected"]
    tok = next(e for e in tr if e["type"] == "tokenize")
    tr_text = "".join(t["piece"] for t in tok["tokens"]) + \
        "".join(e["piece"] for e in tr if e["type"] == "token_selected" and not e["is_eog"])

    ref = subprocess.run([os.path.join(BIN, "simple-ids"), "-m", MODEL, "-n", str(N_PREDICT), prompt],
                         capture_output=True)
    ref_ids = [int(l.split()[1]) for l in ref.stderr.decode(errors="replace").splitlines() if l.startswith("ID ")]

    simple = subprocess.run([os.path.join(BIN, "llama-simple"), "-m", MODEL, "-n", str(N_PREDICT), prompt],
                            capture_output=True)
    simple_text = simple.stdout.decode(errors="replace")
    if simple_text.endswith("\n"):
        simple_text = simple_text[:-1]

    print(f"  prompt {prompt!r}: prompt ids {[t['id'] for t in tok['tokens']]}")
    print(f"    tracer ids     {tr_ids}")
    print(f"    simple-ids ids {ref_ids}")
    check(ref.returncode == 0 and tr_ids == ref_ids and len(tr_ids) > 0, f"{prompt!r}: token ids equal ({len(tr_ids)} tokens)")
    check(simple.returncode == 0 and tr_text == simple_text, f"{prompt!r}: text equals unmodified llama-simple stdout")
    if tr_text != simple_text:
        print(f"    tracer: {tr_text!r}\n    simple: {simple_text!r}")
    validate("\n".join(json.dumps(e) for e in tr) + "\n", f"{prompt!r} greedy trace")

print("== 3. graph stability across two runs")
for label, args in [("dist", ["--prompt", "Once upon a time", "--seed", "1", "--n-predict", "12"]),
                    ("greedy", ["--prompt", "The little dog", "--greedy", "--n-predict", "12"])]:
    a = events(run_tracer(args))
    b = events(run_tracer(args))
    ga = [e for e in a if e["type"] == "graph"]
    gb = [e for e in b if e["type"] == "graph"]
    strip = lambda g: {k: v for k, v in g.items() if k != "t_us"}
    same = len(ga) == len(gb) and all(strip(x) == strip(y) for x, y in zip(ga, gb))
    ids_a = [e["id"] for e in a if e["type"] == "token_selected"]
    ids_b = [e["id"] for e in b if e["type"] == "token_selected"]
    order_a = [(e["step"], e["id"]) for e in a if e["type"] == "node_exec"]
    order_b = [(e["step"], e["id"]) for e in b if e["type"] == "node_exec"]
    built = [g for g in ga if not g["reused"]]
    print(f"  {label}: graphs per step n_nodes={[g['n_nodes'] for g in ga]}")
    print(f"  {label}: built graphs: " + ", ".join(
        f"step {g['step']} id {g['graph_id']} ({g['n_nodes']} nodes, {g['n_leafs']} leaves, {len(g['edges'])} edges)" for g in built))
    check(same, f"{label}: all {len(ga)} graph events identical (nodes, edges, reused flags)")
    check(order_a == order_b, f"{label}: node execution order identical ({len(order_a)} node_exec events)")
    check(ids_a == ids_b, f"{label}: token ids identical {ids_a}")

print()
if failures:
    print(f"FAIL: {len(failures)} check(s) failed")
    sys.exit(1)
print("PASS: all Phase 1 checks")
