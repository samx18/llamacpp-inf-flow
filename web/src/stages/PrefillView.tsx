import { KvGrid, StageHeader, kvRowLabels, showPiece } from '../ui/common';
import { piece } from '../trace/parse';
import type { ViewProps } from './types';

/** llama_batch rows beside the KV cache cells this batch will occupy */
export function BatchTable({ trace, rows, highlight }: { trace: ViewProps['trace']; rows: ViewProps['step']['batch']['rows']; highlight?: number }) {
  return (
    <table className="batch-table">
      <thead>
        <tr><th className="num">token</th><th>piece</th><th className="num">pos</th><th className="num">seq_id</th><th>logits</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={`${r.logits ? 'logits-row' : ''}${highlight !== undefined && i >= highlight ? ' pending' : ''}`}>
            <td className="num">{r.token}</td>
            <td className="piece">{showPiece(piece(trace, r.token))}</td>
            <td className="num">{r.pos}</td>
            <td className="num">{r.seq_id.join(',')}</td>
            <td className="flag">{r.logits ? 'true' : 'false'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PrefillView({ trace, step, p, width }: ViewProps) {
  const b = step.batch;
  const rowsShown = Math.ceil(p * 2 * b.rows.length);           // rows appear over the first half
  const sweep = Math.max(0, Math.min(1, p * 2 - 1));             // cache columns sweep over the second half
  const cells = step.decodeEnd.kv_cells;
  const swept = new Set(cells.slice(0, Math.ceil(sweep * cells.length)));
  return (
    <div className="view prefill-view" data-stage-panel="prefill">
      <StageHeader trace={trace} keys={['batch_init', 'decode']} />
      <div className="prefill-body">
        <div className="prefill-batch">
          <BatchTable trace={trace} rows={b.rows.slice(0, Math.max(0, rowsShown))} />
          <div className="kv-note">
            <span className="mono">llama_memory_seq_pos_max</span>
            <span className="kv-val">{sweep >= 1 ? step.decodeEnd.kv_pos_max : b.kv_pos_max_before}</span>
          </div>
        </div>
        <div className="prefill-kv">
          <KvGrid
            rowLabels={kvRowLabels(trace)}
            nPos={trace.nCells}
            width={width * 0.62}
            state={(_, cell) => (step.cellsBefore.has(cell) ? 'filled' : swept.has(cell) ? 'target' : 'empty')}
            posLabels={(cell) => (cells.includes(cell) ? String(cell) : null)}
          />
        </div>
      </div>
    </div>
  );
}
