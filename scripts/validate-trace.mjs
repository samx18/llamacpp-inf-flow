#!/usr/bin/env node
// Validate a tracer .jsonl trace against web/src/trace/trace.schema.json, then check the
// ordering and cross-reference invariants the player relies on.
//
//   node scripts/validate-trace.mjs trace.jsonl        (or "-" for stdin)
//
// Exits non-zero on the first schema error or on any invariant violation.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'web', 'package.json'));
const Ajv = require('ajv');

const schema = JSON.parse(readFileSync(path.join(root, 'web/src/trace/trace.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: false, strict: false });
const validate = ajv.compile(schema);

const file = process.argv[2];
if (!file) {
  console.error('usage: validate-trace.mjs <trace.jsonl | ->');
  process.exit(2);
}
const text = readFileSync(file === '-' ? 0 : file, 'utf8');
const lines = text.split('\n').filter((l) => l.length > 0);

const errors = [];
const fail = (i, msg) => errors.push(`line ${i + 1}: ${msg}`);

const events = [];
for (let i = 0; i < lines.length; i++) {
  let ev;
  try {
    ev = JSON.parse(lines[i]);
  } catch (e) {
    console.error(`line ${i + 1}: not JSON: ${e.message}`);
    process.exit(1);
  }
  if (!validate(ev)) {
    // anyOf errors are noisy; report the errors for the branch matching ev.type
    const typed = ajv.compile({ ...schema, anyOf: undefined, $ref: `#/definitions/${defFor(ev.type)}` });
    typed(ev);
    console.error(`line ${i + 1} (${ev.type}): schema error`);
    console.error(JSON.stringify(typed.errors ?? validate.errors, null, 2).slice(0, 2000));
    process.exit(1);
  }
  events.push(ev);
}

function defFor(type) {
  const map = {
    model_info: 'ModelInfoEvent', tokenize: 'TokenizeEvent', batch: 'BatchEvent', graph: 'GraphEvent',
    node_exec: 'NodeExecEvent', decode_end: 'DecodeEndEvent', logits: 'LogitsEvent',
    sampler_stage: 'SamplerStageEvent', token_selected: 'TokenSelectedEvent', done: 'DoneEvent',
  };
  return map[type] ?? 'ModelInfoEvent';
}

// ---- invariants --------------------------------------------------------------------------
if (events[0]?.type !== 'model_info') fail(0, 'first event must be model_info');
if (events[1]?.type !== 'tokenize') fail(1, 'second event must be tokenize');
if (events.at(-1)?.type !== 'done') fail(events.length - 1, 'last event must be done');

const info = events[0];
const nVocab = info?.n_vocab;
const graphs = new Map(); // graph_id -> { n_nodes, n_leafs }
let lastT = -1;
let expectStep = 0;
let cur = null; // per-decode state
let nGenerated = 0;

for (let i = 0; i < events.length; i++) {
  const ev = events[i];
  if (ev.t_us < lastT) fail(i, `t_us went backwards (${ev.t_us} < ${lastT})`);
  lastT = ev.t_us;

  switch (ev.type) {
    case 'model_info':
    case 'tokenize':
      if (ev.step !== 0) fail(i, `${ev.type} must have step 0`);
      if (ev.type === 'tokenize') {
        for (const t of ev.tokens) if (t.id < 0 || t.id >= nVocab) fail(i, `token id ${t.id} out of vocab`);
      }
      break;
    case 'batch':
      if (cur) fail(i, 'batch before the previous step finished');
      if (ev.step !== expectStep) fail(i, `batch step ${ev.step}, expected ${expectStep}`);
      if (ev.rows.length !== ev.n_tokens) fail(i, 'rows.length != n_tokens');
      cur = { step: ev.step, phase: 'batch', graph: null, seen: new Set(), seq: 0 };
      break;
    case 'graph': {
      if (!cur || cur.phase !== 'batch') { fail(i, 'graph must follow batch'); break; }
      if (ev.step !== cur.step) fail(i, 'graph step mismatch');
      cur.phase = 'graph';
      if (ev.reused) {
        if (ev.nodes || ev.edges) fail(i, 'reused graph must not carry nodes/edges');
        const g = graphs.get(ev.graph_id);
        if (!g) fail(i, `reused graph_id ${ev.graph_id} was never built`);
        else if (g.n_nodes !== ev.n_nodes) fail(i, `reused graph n_nodes ${ev.n_nodes} != built ${g.n_nodes}`);
      } else {
        if (!ev.nodes || !ev.edges) { fail(i, 'built graph must carry nodes and edges'); break; }
        if (graphs.has(ev.graph_id)) fail(i, `graph_id ${ev.graph_id} built twice`);
        const total = ev.n_nodes + ev.n_leafs;
        if (ev.nodes.length !== total) fail(i, `nodes.length ${ev.nodes.length} != n_nodes + n_leafs ${total}`);
        ev.nodes.forEach((n, k) => {
          if (n.id !== k) fail(i, `node at index ${k} has id ${n.id}`);
          if ((k < ev.n_nodes) !== (n.kind === 'op')) fail(i, `node ${k} kind ${n.kind} inconsistent with index`);
          if (n.group < 0 || n.group >= total) fail(i, `node ${k} group ${n.group} out of range`);
        });
        for (const [a, b] of ev.edges) {
          if (a < 0 || a >= total || b < 0 || b >= ev.n_nodes) fail(i, `edge [${a},${b}] out of range`);
        }
        graphs.set(ev.graph_id, { n_nodes: ev.n_nodes, n_leafs: ev.n_leafs });
      }
      cur.graph = ev;
      break;
    }
    case 'node_exec':
      if (!cur || cur.phase !== 'graph') { fail(i, 'node_exec must follow graph'); break; }
      if (ev.id < 0 || ev.id >= cur.graph.n_nodes) fail(i, `node_exec id ${ev.id} out of range`);
      if (cur.seen.has(ev.id)) fail(i, `node ${ev.id} executed twice`);
      if (ev.seq !== cur.seq) fail(i, `node_exec seq ${ev.seq}, expected ${cur.seq}`);
      if (ev.computed && !ev.stats && !ev.values) { /* non-float tensors carry no stats */ }
      cur.seen.add(ev.id);
      cur.seq++;
      break;
    case 'decode_end':
      if (!cur || cur.phase !== 'graph') { fail(i, 'decode_end must follow graph/node_exec'); break; }
      if (cur.seen.size !== cur.graph.n_nodes) fail(i, `${cur.seen.size} node_exec events for ${cur.graph.n_nodes} nodes`);
      if (ev.n_nodes !== cur.graph.n_nodes) fail(i, 'decode_end n_nodes mismatch');
      if (ev.reused !== cur.graph.reused || ev.graph_id !== cur.graph.graph_id) fail(i, 'decode_end graph mismatch');
      cur.phase = 'decoded';
      break;
    case 'logits':
      if (!cur || cur.phase !== 'decoded') { fail(i, 'logits must follow decode_end'); break; }
      if (ev.values.length !== nVocab) fail(i, `logits length ${ev.values.length} != n_vocab ${nVocab}`);
      cur.phase = 'logits';
      break;
    case 'sampler_stage':
      if (!cur || (cur.phase !== 'logits' && cur.phase !== 'sampling')) { fail(i, 'sampler_stage must follow logits'); break; }
      cur.phase = 'sampling';
      for (const c of ev.candidates) if (c.id < 0 || c.id >= nVocab) fail(i, `candidate id ${c.id} out of vocab`);
      break;
    case 'token_selected':
      if (!cur || cur.phase !== 'sampling') { fail(i, 'token_selected must follow sampler_stage'); break; }
      nGenerated++;
      if (ev.n_generated !== nGenerated) fail(i, `n_generated ${ev.n_generated}, expected ${nGenerated}`);
      cur = null;
      expectStep++;
      break;
    case 'done':
      if (cur) fail(i, 'done in the middle of a step');
      if (ev.n_generated !== nGenerated) fail(i, `done.n_generated ${ev.n_generated} != ${nGenerated}`);
      break;
  }
}

const counts = {};
for (const ev of events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;

if (errors.length) {
  console.error(errors.slice(0, 50).join('\n'));
  console.error(`FAIL: ${errors.length} invariant violation(s) in ${events.length} events`);
  process.exit(1);
}
console.log(`OK: ${events.length} events valid against trace.schema.json; invariants hold`);
console.log('    ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
