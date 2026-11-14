// Op-level view of one layer (or one whole-model block): the real ggml nodes and the edges the
// tracer recorded, laid out with elkjs. Reshape/view/permute/transpose can be collapsed: their
// node is hidden and its inputs are wired straight to its consumers (layout only).
import { useEffect, useMemo, useState } from 'react';
import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { BuiltGraph } from '../trace/parse';
import type { GraphNode, NodeExecEvent } from '../trace/schema';
import { fmtShape } from '../ui/common';

const elk = new ELK();
const LAYOUT_OPS = new Set(['RESHAPE', 'VIEW', 'PERMUTE', 'TRANSPOSE']);

interface Laid { nodes: { n: GraphNode; x: number; y: number; w: number; h: number }[]; edges: { id: string; pts: [number, number][] }[]; w: number; h: number }

export function OpGraph({ graph, layer, blockId, collapse, execById, cursor, onHover, width, height }: {
  graph: BuiltGraph;
  layer: number | null;
  blockId: number;
  collapse: boolean;
  execById?: Map<number, NodeExecEvent>;
  /** highest executed node id (dispatch); undefined: no execution state */
  cursor?: number;
  onHover: (n: GraphNode | null, x: number, y: number) => void;
  width: number;
  height: number;
}) {
  const { nodes, edges } = useMemo(() => {
    const opIds = graph.nodes.filter((n) => n.kind === 'op' && (layer !== null ? n.layer === layer : n.block === blockId)).map((n) => n.id);
    const inSet = new Set(opIds);
    const hidden = new Set(collapse ? opIds.filter((id) => LAYOUT_OPS.has(graph.nodes[id].op)) : []);
    const srcOf = new Map<number, number[]>();
    for (const [a, b] of graph.edges) {
      if (!srcOf.has(b)) srcOf.set(b, []);
      srcOf.get(b)!.push(a);
    }
    // resolve a source through hidden nodes
    const resolve = (id: number, seen = new Set<number>()): number[] => {
      if (!hidden.has(id) || seen.has(id)) return [id];
      seen.add(id);
      return (srcOf.get(id) ?? []).flatMap((s) => resolve(s, seen));
    };
    const shown = new Set(opIds.filter((id) => !hidden.has(id)));
    const es = new Set<string>();
    const outEdges: [number, number][] = [];
    for (const id of shown) {
      for (const s of srcOf.get(id) ?? []) {
        for (const r of resolve(s)) {
          const n = graph.nodes[r];
          if (!inSet.has(r) && n.kind === 'op') continue;        // producers in other layers are not drawn
          if (!shown.has(r) && n.kind === 'op') continue;
          const k = `${r}-${id}`;
          if (es.has(k)) continue;
          es.add(k);
          outEdges.push([r, id]);
          if (n.kind !== 'op') shown.add(r);
        }
      }
    }
    return { nodes: [...shown].sort((a, b) => a - b).map((id) => graph.nodes[id]), edges: outEdges };
  }, [graph, layer, blockId, collapse]);

  const [laid, setLaid] = useState<Laid | null>(null);
  useEffect(() => {
    let cancelled = false;
    const nodeW = (n: GraphNode) => Math.max(140, Math.min(320, 10 * Math.max(n.name.length, n.op.length + 12) + 24));
    const graphIn: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '36', 'elk.spacing.nodeNode': '14',
        'elk.edgeRouting': 'ORTHOGONAL', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      },
      children: nodes.map((n) => ({ id: String(n.id), width: nodeW(n), height: 50 })),
      edges: edges.map(([a, b]) => ({ id: `${a}-${b}`, sources: [String(a)], targets: [String(b)] })),
    };
    elk.layout(graphIn).then((res: ElkNode) => {
      if (cancelled) return;
      const byId = new Map(nodes.map((n) => [String(n.id), n]));
      setLaid({
        nodes: (res.children ?? []).map((c) => ({ n: byId.get(c.id)!, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 })),
        edges: ((res.edges ?? []) as ElkExtendedEdge[]).map((e) => {
          const s = e.sections?.[0];
          const pts: [number, number][] = s ? [[s.startPoint.x, s.startPoint.y], ...(s.bendPoints ?? []).map((b: { x: number; y: number }) => [b.x, b.y] as [number, number]), [s.endPoint.x, s.endPoint.y]] : [];
          return { id: e.id, pts };
        }),
        w: res.width ?? 0, h: res.height ?? 0,
      });
    });
    return () => { cancelled = true; };
  }, [nodes, edges]);

  if (!laid) return <div className="op-graph loading" style={{ width, height }} />;
  // shrink to fit, but never below a readable scale; scroll beyond that
  const scale = Math.max(0.8, Math.min(1, width / (laid.w + 20), height / (laid.h + 20)));
  return (
    <div className="op-scroll" style={{ width, height }}>
    <svg className="op-graph" width={(laid.w + 20) * scale} height={(laid.h + 20) * scale} onMouseLeave={() => onHover(null, 0, 0)}>
      <g transform={`translate(10,10) scale(${scale})`}>
        {laid.edges.map((e) => (
          <polyline key={e.id} points={e.pts.map((p) => p.join(',')).join(' ')} className="op-edge" />
        ))}
        {laid.nodes.map(({ n, x, y, w, h }) => {
          const ex = execById?.get(n.id);
          const state = n.kind !== 'op' ? `leaf ${n.kind}` : !n.computed ? 'skipped' : cursor === undefined ? '' : n.id <= cursor ? (n.id === cursor ? 'running' : 'done') : 'pending';
          return (
            <g key={n.id} transform={`translate(${x},${y})`} className={`op-node ${state}`}
               onMouseEnter={(ev) => onHover(n, ev.clientX, ev.clientY)}>
              <rect width={w} height={h} rx={6} />
              <text x={10} y={21} className="op-name">{n.name || '(unnamed)'}</text>
              <text x={10} y={41} className="op-meta">{n.kind === 'op' ? n.op : n.kind} {fmtShape(n.shape)}{ex && cursor !== undefined && n.id <= cursor ? ` · ${ex.dur_us} µs` : ''}</text>
            </g>
          );
        })}
      </g>
    </svg>
    </div>
  );
}

export function NodeTooltip({ node, x, y }: { node: GraphNode | null; x: number; y: number }) {
  if (!node) return null;
  return (
    <div className="node-tip" style={{ left: x + 14, top: y + 14 }}>
      <div className="tip-name">{node.name || '(unnamed)'}</div>
      <div>{node.kind === 'op' ? node.op : node.kind} · {node.dtype} · {fmtShape(node.shape)}</div>
      {!node.computed && node.kind === 'op' && <div className="tip-muted">GGML_TENSOR_FLAG_COMPUTE not set</div>}
      {node.named_at.map((s) => (
        <div key={s.url} className="tip-src">{s.file}:{s.line}</div>
      ))}
    </div>
  );
}
