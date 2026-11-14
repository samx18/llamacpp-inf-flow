import type { BuiltGraph } from '../trace/parse';
import type { GraphBlock } from '../trace/schema';
import { fmtShape } from '../ui/common';

export type BlockState = 'hidden' | 'shown' | 'pending' | 'running' | 'done';

/** Rows of blocks: whole-model blocks before the layers, one row per layer, whole-model blocks after */
export function blockRows(g: BuiltGraph): GraphBlock[][] {
  const rows: GraphBlock[][] = [];
  let curKey: string | null = null;
  for (const b of g.blocks) {
    const key = b.layer === null ? (rows.length === 0 ? 'pre' : 'post') : `l${b.layer}`;
    if (key !== curKey) { rows.push([]); curKey = key; }
    rows[rows.length - 1].push(b);
  }
  return rows;
}

export function BlockGrid({ graph, state, runFrac, onSelect, selectedLayer, compact, timeUs }: {
  graph: BuiltGraph;
  state: (b: GraphBlock, i: number) => BlockState;
  /** progress through the running block, 0..1 */
  runFrac?: number;
  onSelect?: (layer: number | null, block: GraphBlock) => void;
  selectedLayer?: number | null;
  compact?: boolean;
  /** decode_end.block_time_us, shown on finished blocks */
  timeUs?: Map<number, number>;
}) {
  const rows = blockRows(graph);
  let i = 0;
  return (
    <div className={`block-grid${compact ? ' compact' : ''}`}>
      {rows.map((row, r) => (
        <div key={r} className="block-row">
          {row.map((b) => {
            const idx = i++;
            const st = state(b, idx);
            const anchor = graph.nodes[b.id];
            const t = timeUs?.get(b.id);
            return (
              <div
                key={b.id}
                className={`block ${st}${b.layer !== null && b.layer === selectedLayer ? ' selected' : ''}${onSelect ? ' clickable' : ''}`}
                onClick={onSelect ? () => onSelect(b.layer, b) : undefined}
                data-block={b.name}
              >
                <div className="block-name">{b.name}</div>
                <div className="block-meta">
                  <span>{anchor.op}</span>
                  <span>{fmtShape(anchor.shape)}</span>
                  <span>{b.n_ops} ops</span>
                  {st === 'done' && t !== undefined && <span className="block-time">{t} µs</span>}
                </div>
                {st === 'running' && <div className="block-progress" style={{ width: `${(runFrac ?? 0) * 100}%` }} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
