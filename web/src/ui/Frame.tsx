import type { Trace } from '../trace/parse';
import type { Beat, StageKey } from '../trace/timeline';
import { STAGES } from '../trace/timeline';
import type { Player } from '../trace/player';
import { TokenChip, fmtNum, showPiece } from './common';

const STAGE_TITLE: Record<StageKey, string> = {
  tokenize: 'Tokenize', prefill: 'Prefill', build: 'Build graph', dispatch: 'Dispatch', sample: 'Sample', repeat: 'Repeat',
};

export function PipelineRail({ beat, onStage, subtitles }: { beat: Beat; onStage: (s: StageKey) => void; subtitles?: Record<StageKey, string> }) {
  const pulsing = beat.stage === 'repeat';
  return (
    <div className="rail">
      <div className="rail-chips">
        {STAGES.map((s) => (
          <button key={s} className={`rail-chip${beat.stage === s ? ' active' : ''}`} onClick={() => onStage(s)} data-rail={s}>
            {STAGE_TITLE[s]}
            {subtitles && <span className="rail-sub">{subtitles[s]}</span>}
          </button>
        ))}
      </div>
      <svg className={`rail-loop${pulsing ? ' pulse' : ''}`} viewBox="0 0 1000 40" preserveAspectRatio="none">
        <path d="M 735 4 C 735 36, 735 36, 700 36 L 400 36 C 365 36, 365 36, 365 8" />
        <path d="M 357 14 L 365 4 L 373 14" className="arrowhead" />
      </svg>
      <div className="rail-step" data-step={beat.step}><span>step</span>{beat.step}</div>
    </div>
  );
}

/** Whether the token chosen in step s is already in the output at this beat */
function produced(beat: Beat, s: number): boolean {
  if (beat.step > s) return true;
  if (beat.step < s) return false;
  return beat.stage === 'repeat';
}

export function OutputStrip({ trace, beat, onToken, onHover, record }: {
  trace: Trace; beat: Beat; onToken: (step: number) => void; onHover: (step: number | null) => void; record: boolean;
}) {
  return (
    <div className="output-strip">
      <div className="out-prompt">
        {trace.tokenize.tokens.map((t, i) => <TokenChip key={i} id={t.id} text={t.piece} dim />)}
      </div>
      <div className="out-gen" data-output>
        {trace.steps.filter((s) => produced(beat, s.step)).map((s) => (
          <TokenChip key={s.step} id={s.selected.id} text={s.selected.piece} active={s.step === beat.step}
            dataId onClick={record ? undefined : () => onToken(s.step)} onHover={record ? undefined : (on) => onHover(on ? s.step : null)} />
        ))}
      </div>
    </div>
  );
}

export function Transport({ player }: { player: Player }) {
  return (
    <div className="transport">
      <button onClick={player.stepBack} title="step back (←)">⏮</button>
      <button onClick={player.toggle} title="play / pause (space)" className="play" data-playing={player.playing}>{player.playing ? '⏸' : '▶'}</button>
      <button onClick={player.stepForward} title="step forward (→)">⏭</button>
      <select value={player.speed} onChange={(e) => player.setSpeed(Number(e.target.value))} title="speed">
        {[0.25, 0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input type="range" className="scrubber" min={0} max={player.total} step={1} value={player.t}
        onChange={(e) => { player.pause(); player.seek(Number(e.target.value)); }} />
    </div>
  );
}

/** Attention from the captured kq_soft_max-N tensors of one decode: query = that decode's last batch row */
export function AttentionPopover({ trace, step }: { trace: Trace; step: number }) {
  const s = trace.steps[step];
  const g = s.graph;
  const layers = g.nodes.filter((n) => n.kind === 'op' && n.base === 'kq_soft_max' && n.name === `kq_soft_max-${n.layer}`);
  const cells = [...trace.cellRow.entries()].filter(([, r]) => r.step <= step).map(([c]) => c).sort((a, b) => a - b);
  const cs = 14;
  return (
    <div className="attn-pop">
      <div className="attn-title">kq_soft_max · step {step} · query pos {s.batch.rows[s.batch.rows.length - 1].pos}</div>
      <div className="attn-cells">{cells.map((c) => <span key={c}><b>{c}</b>{showPiece(trace.info.vocab[trace.cellRow.get(c)!.token])}</span>)}</div>
      <div className="attn-layers">
        {layers.map((n) => {
          const ex = s.execById.get(n.id);
          if (!ex?.values) return null;
          const [ne0, ne1, ne2] = n.shape;
          const q = ne1 - 1;
          return (
            <div key={n.id} className="attn-layer">
              <code>{n.name}</code>
              <svg width={cells.length * cs} height={ne2 * cs}>
                {Array.from({ length: ne2 }, (_, h) => cells.map((c, ci) => {
                  const v = ex.values![h * ne1 * ne0 + q * ne0 + c] ?? 0;
                  return (
                    <rect key={`${h}-${c}`} x={ci * cs} y={h * cs} width={cs - 1} height={cs - 1} style={{ fill: heat(v ?? 0) }}>
                      <title>{`head ${h} · cell ${c} (${showPiece(trace.info.vocab[trace.cellRow.get(c)!.token])}) · ${fmtNum(v, 4)}`}</title>
                    </rect>
                  );
                }))}
              </svg>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Sequential blue ramp for 0..1 on the dark surface (dark = near zero) */
function heat(v: number): string {
  const ramp = ['#1d2633', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#cde2fb'];
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(Math.sqrt(Math.max(0, v)) * (ramp.length - 1))));
  return ramp[i];
}
