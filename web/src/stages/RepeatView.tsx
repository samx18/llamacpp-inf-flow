import { KvGrid, StageHeader, TokenChip, fmtUs, kvRowLabels } from '../ui/common';
import { BatchTable } from './PrefillView';
import { GraphBadge } from './BuildView';
import { kvState } from './DispatchView';
import type { ViewProps } from './types';

function StageTimeBars({ trace }: { trace: ViewProps['trace'] }) {
  const t = trace.done.totals_us;
  const rows = Object.entries(t).filter(([k]) => k !== 'total');
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <div className="op-bars stage-bars">
      <div className="op-bars-title"><code>totals_us</code> <span className="muted">instrumented</span></div>
      {rows.map(([k, v]) => (
        <div key={k} className="op-bar-row">
          <span className="op-bar-label wide">{k}</span>
          <span className="op-bar-track"><span className="op-bar" style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="op-bar-val">{fmtUs(v)}</span>
        </div>
      ))}
    </div>
  );
}

export function DonePanel({ trace }: { trace: ViewProps['trace'] }) {
  const d = trace.done;
  return (
    <div className="done-panel">
      <div className="done-kv">
        <div><span>reason</span><code>{d.reason}</code></div>
        <div><span>n_prompt</span>{d.n_prompt}</div>
        <div><span>n_generated</span>{d.n_generated}</div>
        <div><span>n_graphs_built</span>{d.n_graphs_built}</div>
        <div><span>n_graphs_reused</span>{d.n_graphs_reused}</div>
      </div>
      <StageTimeBars trace={trace} />
    </div>
  );
}

export function RepeatView({ trace, step, beat, p, record, width }: ViewProps) {
  const sel = step.selected;
  const next = trace.steps[step.step + 1];
  const rowLabels = kvRowLabels(trace);

  if (beat.kind === 'final') {
    return (
      <div className="view repeat-view" data-stage-panel="repeat">
        <StageHeader trace={trace} keys={['vocab_is_eog']} />
        <DonePanel trace={trace} />
      </div>
    );
  }

  if (beat.kind === 'quick') {
    // compressed later-token beat: this step's cache column, the reuse badge and the chosen token
    return (
      <div className="view repeat-view quick" data-stage-panel="repeat">
        <StageHeader trace={trace} keys={['decode']} extra={<GraphBadge step={step} />} />
        <div className="quick-body">
          <KvGrid rowLabels={rowLabels} nPos={trace.nCells} width={width - 80} cell={34}
            state={kvState(trace, step, Number.MAX_SAFE_INTEGER)}
            posLabels={(cell) => (step.decodeEnd.kv_cells.includes(cell) ? String(cell) : null)} />
          <div className="quick-token"><TokenChip id={sel.id} text={sel.piece} big active /></div>
        </div>
      </div>
    );
  }

  const fly = Math.min(1, p * 1.6);
  return (
    <div className="view repeat-view" data-stage-panel="repeat">
      <StageHeader trace={trace} keys={next ? ['vocab_is_eog', 'batch_init', 'decode'] : ['vocab_is_eog']} />
      <div className="repeat-body">
        <div className="repeat-token" style={{ transform: `translate(${fly * 40}px, ${fly * (record ? 330 : 260)}px) scale(${1 - fly * 0.35})`, opacity: 1 - Math.max(0, fly - 0.85) * 4 }}>
          <TokenChip id={sel.id} text={sel.piece} big active />
          <div className="repeat-eog"><code>llama_vocab_is_eog</code> {sel.is_eog ? 'true' : 'false'}</div>
        </div>
        {next ? (
          <div className="repeat-next" style={{ opacity: Math.max(0, p * 2 - 0.6) }}>
            <div className="repeat-step"><span>step</span>{next.step}</div>
            <BatchTable trace={trace} rows={next.batch.rows} />
          </div>
        ) : (
          <div className="repeat-next" style={{ opacity: Math.max(0, p * 2 - 0.6) }}>
            <DonePanel trace={trace} />
          </div>
        )}
      </div>
    </div>
  );
}
