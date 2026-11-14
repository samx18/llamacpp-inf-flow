// Index a trace (array of events) by step. No values are derived here: this only groups events
// and resolves a reused graph to the graph event that built it.
import type {
  BatchEvent, DecodeEndEvent, DoneEvent, GraphEvent, GraphNode, LogitsEvent, ModelInfoEvent,
  NodeExecEvent, SamplerStageEvent, TokenizeEvent, TokenSelectedEvent, TraceEvent,
} from './schema';

export interface BuiltGraph {
  event: GraphEvent;
  nodes: GraphNode[];
  edges: [number, number][];
  blocks: NonNullable<GraphEvent['blocks']>;
}

export interface Step {
  step: number;
  batch: BatchEvent;
  graphEvent: GraphEvent;
  /** The graph used by this decode (the step's own, or the one it reused) */
  graph: BuiltGraph;
  execs: NodeExecEvent[];
  /** node id -> exec event */
  execById: Map<number, NodeExecEvent>;
  decodeEnd: DecodeEndEvent;
  logits: LogitsEvent;
  stages: SamplerStageEvent[];
  selected: TokenSelectedEvent;
  /** KV cells written by earlier decodes (from decode_end.kv_cells) */
  cellsBefore: Set<number>;
}

export interface Trace {
  info: ModelInfoEvent;
  tokenize: TokenizeEvent;
  steps: Step[];
  done: DoneEvent;
  graphs: Map<number, BuiltGraph>;
  /** Number of KV cells to draw: highest cell any decode wrote, plus one (layout) */
  nCells: number;
  /** cell -> the batch row (token, pos) the tracer saw written into it */
  cellRow: Map<number, { token: number; pos: number; step: number }>;
}

export class TraceError extends Error {}

export function parseLines(text: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if ('bridge_error' in obj) throw new TraceError(String(obj.bridge_error));
    out.push(obj as TraceEvent);
  }
  return out;
}

export function indexTrace(events: TraceEvent[]): Trace {
  let info: ModelInfoEvent | undefined;
  let tokenize: TokenizeEvent | undefined;
  let done: DoneEvent | undefined;
  const graphs = new Map<number, BuiltGraph>();
  const steps: Step[] = [];
  let cur: Partial<Step> & { execs: NodeExecEvent[]; stages: SamplerStageEvent[] } | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'model_info': info = ev; break;
      case 'tokenize': tokenize = ev; break;
      case 'batch': cur = { step: ev.step, batch: ev, execs: [], stages: [] }; break;
      case 'graph': {
        if (!cur) throw new TraceError('graph before batch');
        if (!ev.reused) {
          graphs.set(ev.graph_id, { event: ev, nodes: ev.nodes ?? [], edges: ev.edges ?? [], blocks: ev.blocks ?? [] });
        }
        const g = graphs.get(ev.graph_id);
        if (!g) throw new TraceError(`graph ${ev.graph_id} reused before it was built`);
        cur.graphEvent = ev;
        cur.graph = g;
        break;
      }
      case 'node_exec': cur?.execs.push(ev); break;
      case 'decode_end': if (cur) cur.decodeEnd = ev; break;
      case 'logits': if (cur) cur.logits = ev; break;
      case 'sampler_stage': cur?.stages.push(ev); break;
      case 'token_selected': {
        if (!cur) throw new TraceError('token_selected outside a step');
        cur.selected = ev;
        cur.execById = new Map(cur.execs.map((e) => [e.id, e]));
        steps.push(cur as Step);
        cur = null;
        break;
      }
      case 'done': done = ev; break;
    }
  }
  if (!info || !tokenize || !done) throw new TraceError('trace is missing model_info, tokenize or done');
  if (steps.length === 0) throw new TraceError('trace has no decode steps');
  const cellRow = new Map<number, { token: number; pos: number; step: number }>();
  const written = new Set<number>();
  for (const s of steps) {
    s.cellsBefore = new Set(written);
    s.decodeEnd.kv_cells.forEach((c, i) => {
      const r = s.batch.rows[i];
      if (r) cellRow.set(c, { token: r.token, pos: r.pos, step: s.step });
      written.add(c);
    });
  }
  const nCells = Math.max(0, ...written) + 1;
  return { info, tokenize, steps, done, graphs, nCells, cellRow };
}

export async function loadTraceUrl(url: string): Promise<Trace> {
  const res = await fetch(url);
  if (!res.ok) throw new TraceError(`${url}: HTTP ${res.status}`);
  return indexTrace(parseLines(await res.text()));
}

/** Piece for a token id, from the vocab the tracer reported */
export function piece(trace: Trace, id: number): string {
  return trace.info.vocab[id] ?? '';
}
