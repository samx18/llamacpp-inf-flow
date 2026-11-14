import { StageHeader, TokenChip, fmtNum, showPiece } from '../ui/common';
import { piece } from '../trace/parse';
import type { ViewProps } from './types';

export function SampleView({ trace, step, beat, p, record, width, onFork }: ViewProps) {
  const S = step.stages.length;
  const stageIx = beat.sub - 1;                      // -1: raw logits; S: chosen
  const stage = stageIx >= 0 && stageIx < S ? step.stages[stageIx] : stageIx >= S ? step.stages[S - 1] : null;
  const chosen = beat.sub === S + 1;
  const logits = step.logits.values;
  const nV = logits.length;

  // vertical scale shared by every stage of this step (layout only)
  let lo = Infinity, hi = -Infinity;
  for (const v of logits) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const s of step.stages) for (const c of s.candidates) if (c.logit !== null) hi = Math.max(hi, c.logit);
  const chartW = width - 64, chartH = record ? 330 : 300;
  const bw = chartW / nV;
  const y = (v: number) => chartH - ((v - lo) / (hi - lo || 1)) * (chartH - 34);

  const cand = stage ? new Map(stage.candidates.map((c) => [c.id, c])) : null;
  // bars drop out over the first part of the beat
  const fade = Math.min(1, p * 2.5);
  const sel = step.selected;
  const keys = ['get_logits_ith', 'sampler_apply', ...(stage ? [`sampler_${stage.name}`] : []), ...(chosen ? ['sampler_accept'] : [])];
  const rows = (stage?.candidates ?? []).slice(0, record ? 8 : 10);

  return (
    <div className="view sample-view" data-stage-panel="sample">
      <StageHeader trace={trace} keys={keys} />
      <div className="sampler-chain">
        <span className={`sampler-pill${stageIx === -1 ? ' on' : ''}`}><code>logits</code><span className="pill-n">{nV}</span></span>
        {step.stages.map((s, i) => (
          <span key={i} className={`sampler-pill${i === stageIx ? ' on' : ''}${i < stageIx ? ' past' : ''}`}>
            <code>{s.name}</code>
            {Object.entries(s.params).map(([k, v]) => <span key={k} className="pill-param">{k}={fmtNum(v, 2)}</span>)}
            {i <= stageIx && <span className="pill-n">{s.size}</span>}
          </span>
        ))}
      </div>
      <svg className="logit-chart" width={chartW} height={chartH + 30}>
        <line x1={0} x2={chartW} y1={y(Math.max(lo, 0))} y2={y(Math.max(lo, 0))} className="baseline" />
        {logits.map((v, id) => {
          if (v === null) return null;
          const c = cand?.get(id);
          const val = c ? c.logit ?? v : v;
          const keep = !cand || !!c;
          const isSel = chosen && id === sel.id;
          const top = y(val), base = y(Math.max(lo, 0));
          return (
            <rect key={id} x={id * bw} width={Math.max(1, bw - 0.6)} y={Math.min(top, base)} height={Math.max(1, Math.abs(base - top))}
              className={`logit-bar${isSel ? ' chosen' : keep ? ' keep' : ' drop'}`}
              style={{ opacity: keep ? 1 : 1 - 0.85 * fade }}>
              <title>{`${id} ${showPiece(piece(trace, id))}  logit ${fmtNum(val)}`}</title>
            </rect>
          );
        })}
        {chosen && (
          <g transform={`translate(${sel.id * bw + bw / 2}, ${y(sel.logit ?? hi) - 12})`} className="chosen-marker">
            <path d="M-9,-14 L9,-14 L0,0 Z" />
          </g>
        )}
        <text x={0} y={chartH + 22} className="axis-label">0</text>
        <text x={chartW} y={chartH + 22} textAnchor="end" className="axis-label">{nV - 1}</text>
      </svg>
      <div className="sample-bottom">
        {stage && (
          <table className="cand-table">
            <thead><tr><th className="num">id</th><th>piece</th><th className="num">logit</th><th className="num">p</th>{onFork && !record && <th />}</tr></thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={c.id} className={`${chosen && c.id === sel.id ? 'chosen' : ''}${i === stage.selected ? ' selected' : ''}`}>
                  <td className="num">{c.id}</td>
                  <td className="piece">{showPiece(piece(trace, c.id))}</td>
                  <td className="num">{fmtNum(c.logit)}</td>
                  <td className="num p-cell"><span className="p-bar" style={{ width: `${(c.p ?? 0) * 100}%` }} /><span className="p-val">{fmtNum(c.p, 4)}</span></td>
                  {onFork && !record && (
                    <td>{c.id !== sel.id && <button className="fork-btn" onClick={() => onFork(step.step, c.id)}>fork</button>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {chosen && (
          <div className="chosen-box">
            <TokenChip id={sel.id} text={sel.piece} big active />
            <div className="chosen-kv"><span>p</span>{fmtNum(sel.p, 4)}</div>
            <div className="chosen-kv"><span>selected</span>{sel.selected}</div>
            {sel.forced && <div className="chosen-kv forced"><span>--force</span>true</div>}
          </div>
        )}
      </div>
    </div>
  );
}
