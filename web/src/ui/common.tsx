import type { ReactNode } from 'react';
import type { SrcLoc } from '../trace/schema';
import type { Trace } from '../trace/parse';

/** Visible form of a token piece: spaces shown as an open box, newlines as a return arrow */
export function showPiece(p: string): string {
  return p.replace(/ /g, '␣').replace(/\n/g, '↵');
}

export function fmtUs(us: number): string {
  return `${us.toLocaleString('en-US')} µs`;
}

export function fmtNum(v: number | null, digits = 3): string {
  if (v === null) return '−∞';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.001) return v.toExponential(2);
  return v.toFixed(digits);
}

export function fmtShape(s: number[]): string {
  let n = s.length;
  while (n > 1 && s[n - 1] === 1) n--;
  return `[${s.slice(0, n).join(', ')}]`;
}

/** The panel's only label: the llama.cpp function, with a link to it at the pinned commit */
export function StageHeader({ trace, keys, extra }: { trace: Trace; keys: string[]; extra?: ReactNode }) {
  const locs = keys.map((k) => trace.info.sources[k]).filter((x): x is SrcLoc => !!x);
  return (
    <div className="stage-header">
      {locs.map((l, i) => (
        <span key={l.fn ?? l.file} className="fn">
          {i > 0 && <span className="fn-sep">→</span>}
          <code>{l.fn}</code>
          <a href={l.url} target="_blank" rel="noreferrer" className="src-link">
            {l.file}:{l.line}
          </a>
        </span>
      ))}
      {extra}
    </div>
  );
}

export function TokenChip({ id, text, active, dim, onClick, onHover, big, dataId }: {
  id: number; text: string; active?: boolean; dim?: boolean; big?: boolean;
  onClick?: () => void; onHover?: (on: boolean) => void; dataId?: boolean;
}) {
  return (
    <div
      className={`chip${active ? ' active' : ''}${dim ? ' dim' : ''}${big ? ' big' : ''}${onClick ? ' clickable' : ''}`}
      onClick={onClick}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      data-token-id={dataId ? id : undefined}
    >
      <span className="chip-piece">{showPiece(text)}</span>
      <span className="chip-id">{id}</span>
    </div>
  );
}

export type CellState = 'empty' | 'filled' | 'target' | 'writing';

/** KV cache: one row per layer (labelled with the llama.cpp cache tensor names), one column per position */
export function KvGrid({ rowLabels, nPos, state, width, cell = 0, posLabels }: {
  rowLabels: string[];
  nPos: number;
  state: (row: number, pos: number) => CellState;
  width: number;
  cell?: number;
  posLabels?: (pos: number) => string | null;
}) {
  const labelW = Math.max(60, ...rowLabels.map((l) => l.length * 9.4 + 20));
  const gap = 3;
  const c = cell || Math.max(10, Math.min(44, Math.floor((width - labelW) / nPos) - gap));
  const h = rowLabels.length * (c + gap) + 26;
  return (
    <svg className="kv-grid" width={labelW + nPos * (c + gap)} height={h}>
      {rowLabels.map((lab, r) => (
        <g key={r} transform={`translate(0, ${r * (c + gap)})`}>
          <text x={labelW - 12} y={c / 2 + 6} textAnchor="end" className="kv-label">{lab}</text>
          {Array.from({ length: nPos }, (_, pos) => {
            const st = state(r, pos);
            return <rect key={pos} x={labelW + pos * (c + gap)} y={0} width={c} height={c} rx={4} className={`kv-cell ${st}`} />;
          })}
        </g>
      ))}
      {posLabels && Array.from({ length: nPos }, (_, pos) => {
        const l = posLabels(pos);
        return l === null ? null : (
          <text key={pos} x={labelW + pos * (c + gap) + c / 2} y={rowLabels.length * (c + gap) + 18} textAnchor="middle" className="kv-pos">{l}</text>
        );
      })}
    </svg>
  );
}

/** Row labels for the KV grid: the cache tensor names the graph references, per layer */
export function kvRowLabels(trace: Trace): string[] {
  const g = trace.steps[0].graph;
  const out: string[] = [];
  for (let l = 0; l < trace.info.n_layer; l++) {
    const names = g.nodes.filter((n) => n.kind === 'kv_cache' && n.layer === l).map((n) => n.name);
    out.push(names.length ? names.join(' · ') : '');
  }
  return out;
}
