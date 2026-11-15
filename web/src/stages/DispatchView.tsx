import { useState } from 'react';
import { KvGrid, StageHeader, fmtShape, kvRowLabels } from '../ui/common';
import { GraphBadge, Expansion } from './BuildView';
import { BlockGrid } from './BlockGrid';
import type { ViewProps } from './types';

/** Executed-node cursor for a dispatch beat: the scheduler computes nodes in id order */
export function dispatchCursor(step: ViewProps['step'], sub: number, p: number, perBlock: boolean): number {
  const blocks = step.graph.blocks;
  if (!blocks.length) return Math.floor(p * step.graph.event.n_nodes);
  const b = blocks[Math.min(sub, blocks.length - 1)];
  if (perBlock) return b.last;
  const span = b.last - b.first + 1;
  return Math.min(b.last, b.first + Math.floor(p * span));
}

/** KV cell state while dispatching: a layer's cells are written when its cache SET_ROWS node runs */
export function kvState(trace: ViewProps['trace'], step: ViewProps['step'], cursor: number) {
  const writes = new Map<number, number>();    // layer -> id of the node writing cache_k_l<layer>
  for (const n of step.graph.nodes) {
    if (n.kind === 'op' && n.op === 'SET_ROWS' && n.layer !== null && n.name.startsWith('cache_k_') && !writes.has(n.layer)) writes.set(n.layer, n.id);
  }
  const target = new Set(step.decodeEnd.kv_cells);
  return (layer: number, cell: number) => {
    if (step.cellsBefore.has(cell)) return 'filled' as const;
    if (!target.has(cell)) return 'empty' as const;
    const w = writes.get(layer);
    if (w === undefined) return 'target' as const;
    if (w < cursor) return 'filled' as const;
    if (w === cursor) return 'writing' as const;
    return 'target' as const;
  };
}

export function OpTimeBars({ step, limit = 8 }: { step: ViewProps['step']; limit?: number }) {
  const rows = step.decodeEnd.op_time_us.slice(0, limit);
  const max = rows[0]?.us || 1;
  return (
    <div className="op-bars">
      <div className="op-bars-title"><code>op_time_us</code> <span className="muted">instrumented</span></div>
      {rows.map((r) => (
        <div key={r.op} className="op-bar-row">
          <span className="op-bar-label">{r.op}</span>
          <span className="op-bar-track"><span className="op-bar" style={{ width: `${(r.us / max) * 100}%` }} /></span>
          <span className="op-bar-val">{r.us} µs</span>
          <span className="op-bar-n">×{r.n}</span>
        </div>
      ))}
    </div>
  );
}

export function DispatchView({ trace, step, beat, p, record, width, height }: ViewProps) {
  const g = step.graph;
  const cursor = dispatchCursor(step, beat.sub, p, record);
  const cur = g.blocks[Math.min(beat.sub, g.blocks.length - 1)];
  const [sel, setSel] = useState<{ layer: number | null; block: number } | null>(null);
  const blockTime = new Map(step.decodeEnd.block_time_us.map((b) => [b.block, b.us]));
  const listIds = g.nodes.filter((n) => n.kind === 'op' && n.block === cur?.id && n.id <= cursor).map((n) => n.id);
  const listRows = record ? 12 : 14;
  const shownIds = listIds.slice(-listRows);
  return (
    <div className="view dispatch-view" data-stage-panel="dispatch">
      <StageHeader trace={trace} keys={['graph_compute', 'sched_compute', 'sched_splits']} extra={<GraphBadge step={step} />} />
      {sel && !record ? (
        <Expansion graph={g} sel={sel} onClose={() => setSel(null)} width={width - 48} height={height - 150} execById={step.execById} cursor={cursor} />
      ) : (
        <div className="dispatch-body">
          <div className="dispatch-left">
            <BlockGrid graph={g} compact
              state={(_, i) => (i < beat.sub ? 'done' : i === beat.sub ? (record ? 'done' : 'running') : 'pending')}
              runFrac={p} timeUs={blockTime}
              onSelect={record ? undefined : (layer, b) => setSel({ layer, block: b.id })} />
            <KvGrid rowLabels={kvRowLabels(trace)} nPos={trace.nCells} width={width * 0.5} cell={record ? 24 : 18}
              state={kvState(trace, step, cursor)} />
          </div>
          <div className="dispatch-right">
            <table className="exec-list">
              <thead><tr><th className="num">id</th><th>op</th><th>name</th><th>shape</th><th className="num">dur_us</th></tr></thead>
              <tbody>
                {shownIds.map((id) => {
                  const n = g.nodes[id];
                  const e = step.execById.get(id);
                  return (
                    <tr key={id} className={`${id === cursor ? 'current' : ''}${!n.computed ? ' skipped' : ''}`}>
                      <td className="num">{id}</td>
                      <td>{n.op}</td>
                      <td className="mono">{n.name}</td>
                      <td className="mono">{fmtShape(n.shape)}</td>
                      <td className="num">{e ? e.dur_us : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OpTimeBars step={step} limit={6} />
          </div>
        </div>
      )}
    </div>
  );
}
