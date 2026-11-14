// Overview tab: the same trace and the same six phases, explained for an audience that does not
// know transformer internals. Captions are static copy (all of it in COPY below); every number in
// them and every visual comes from the tracer's events, exactly as in the technical tab.
import type { ReactNode } from 'react';
import { piece, type Step, type Trace } from '../trace/parse';
import type { Beat, StageKey } from '../trace/timeline';
import { TokenChip, fmtNum, showPiece } from '../ui/common';
import { segments } from '../stages/TokenizeView';

export interface OvProps { trace: Trace; step: Step; beat: Beat; p: number; record: boolean }

const B = ({ children }: { children: ReactNode }) => <b className="ov-num">{children}</b>;
const us = (v: number) => `${v.toLocaleString('en-US')} µs`;

// ---- copy -------------------------------------------------------------------------------------

export const PHASE_PLAIN: Record<StageKey, string> = {
  tokenize: 'split the text',
  prefill: 'read the prompt',
  build: 'plan the math',
  dispatch: 'run the math',
  sample: 'pick a token',
  repeat: 'add it, go again',
};

const COPY = {
  tokenize: (t: Trace) => (
    <>The model can’t read letters. llama.cpp breaks your text into <em>tokens</em>: pieces from a fixed
      list of <B>{t.info.n_vocab}</B> that this model knows. Each piece is replaced by its ID number.
      Common words are one piece; others split into several. <code>&lt;s&gt;</code> marks the start.</>
  ),
  prefill: (t: Trace, s: Step) => (
    <>All <B>{s.batch.n_tokens}</B> tokens go into the model together, in a single pass. While reading,
      the model stores a short summary of every token in its <em>memory</em> (the KV cache), so it
      never has to reread the prompt.</>
  ),
  build: (t: Trace, s: Step) => s.graphEvent.reused ? (
    <>The input has the same shape as last time (<B>{s.batch.n_tokens}</B> token), so llama.cpp
      <em> reuses</em> the plan it already wrote instead of writing a new one.</>
  ) : s.step === 0 ? (
    <>Before calculating anything, llama.cpp writes a plan: the list of every calculation to run.
      This model has <B>{t.info.n_layer}</B> layers, and the plan has <B>{s.graphEvent.n_nodes}</B> small
      operations. In each layer the model first looks back at earlier tokens (<em>attention</em>),
      then transforms what it found (<em>feed-forward</em>).</>
  ) : (
    <>Now the input is just <B>{s.batch.n_tokens}</B> new token, not <B>{t.steps[0].batch.n_tokens}</B>,
      so llama.cpp writes a new, smaller plan. From the next token on, it will reuse this one.</>
  ),
  dispatch: (t: Trace, s: Step) => (
    <>The CPU works through the plan in order, layer by layer, and ends with a score for every
      possible next token. This pass ran <B>{s.decodeEnd.n_computed}</B> operations
      in <B>{us(s.decodeEnd.dur_us)}</B>{s.step === 0 ? ' (millionths of a second)' : ''}.</>
  ),
  sample: (t: Trace, s: Step) => {
    const st = s.stages;
    if (st.length === 1) return (
      <>Every one of the <B>{t.info.n_vocab}</B> tokens got a score. In greedy mode llama.cpp simply takes
        the highest score.</>
    );
    const k = st.find((x) => x.name === 'top-k'), tp = st.find((x) => x.name === 'top-p');
    return (
      <>Every one of the <B>{t.info.n_vocab}</B> known tokens got a score. llama.cpp keeps the
        best {k && <><B>{k.size}</B> (top-k), </>}then the smallest group that together covers
        {tp && <> <B>{fmtNum(tp.params.p, 2)}</B> of the probability (top-p): <B>{tp.size}</B> left</>}.
        Then it draws one at random, weighted by its chance.</>
    );
  },
  repeat: (t: Trace, s: Step) => (
    <>The chosen token is added to the text and fed back in. Thanks to the memory, the next pass only
      has to process this <em>one</em> new token. This repeats until <B>{t.info.settings.n_predict}</B> tokens
      are written or the model says it is done.</>
  ),
  quick: (t: Trace, s: Step) => (
    <>Token <B>{s.selected.n_generated}</B> of <B>{t.info.settings.n_predict}</B>: one quick pass,
      plan {s.graphEvent.reused ? 'reused' : 'rebuilt'}, one more slot in memory.</>
  ),
  final: (t: Trace) => (
    <>Done: <B>{t.done.n_generated}</B> tokens. llama.cpp wrote the plan <B>{t.done.n_graphs_built}</B> times
      and reused it <B>{t.done.n_graphs_reused}</B> times. The whole run took <B>{us(t.done.totals_us.total)}</B>.</>
  ),
};

const TITLE: Record<StageKey, string> = {
  tokenize: 'Tokenize', prefill: 'Prefill', build: 'Build graph', dispatch: 'Dispatch', sample: 'Sample', repeat: 'Repeat',
};

function Caption({ stage, children, extra }: { stage: StageKey; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="ov-caption">
      <div className="ov-title"><span>{TITLE[stage]}</span><span className="ov-plain">{PHASE_PLAIN[stage]}</span>{extra}</div>
      <p className="ov-body">{children}</p>
    </div>
  );
}

// ---- shared visuals ---------------------------------------------------------------------------

/** The model's memory: one slot per KV cache cell, labelled with the token stored there */
function Memory({ trace, filled, adding, big }: { trace: Trace; filled: Set<number>; adding: Set<number>; big?: boolean }) {
  return (
    <div className={`ov-memory${big ? ' big' : ''}`}>
      <div className="ov-memory-label">memory (KV cache)</div>
      <div className="ov-slots">
        {Array.from({ length: trace.nCells }, (_, c) => {
          const row = trace.cellRow.get(c);
          const on = filled.has(c), add = adding.has(c);
          return (
            <div key={c} className={`ov-slot${on ? ' on' : ''}${add ? ' add' : ''}`}>
              {(on || add) && row ? showPiece(piece(trace, row.token)) : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The sentence so far: prompt in grey, generated tokens in ink, the newest one highlighted */
export function Sentence({ trace, upTo, highlight, big }: { trace: Trace; upTo: number; highlight?: number; big?: boolean }) {
  return (
    <div className={`ov-sentence${big ? ' big' : ''}`}>
      <span className="ov-prompt">{trace.tokenize.prompt}</span>
      {trace.steps.filter((s) => s.step < upTo && !s.selected.is_eog).map((s) => (
        <span key={s.step} className={`ov-gen${s.step === highlight ? ' new' : ''}`} data-token-id={s.selected.id}>{s.selected.piece}</span>
      ))}
    </div>
  );
}

/** The plan: input, one box per layer (attention + feed-forward), output scores */
function Plan({ trace, step, shown, cursor, done }: { trace: Trace; step: Step; shown: number; cursor?: number; done?: boolean }) {
  const boxes: { key: string; title: string; sub?: string[] }[] = [{ key: 'in', title: 'token IDs → numbers' }];
  for (let l = 0; l < trace.info.n_layer; l++) boxes.push({ key: `l${l}`, title: `layer ${l + 1}`, sub: ['attention', 'feed-forward'] });
  boxes.push({ key: 'out', title: `${trace.info.n_vocab} scores` });
  return (
    <div className="ov-plan">
      {boxes.map((b, i) => {
        const state = cursor === undefined ? '' : done || i < cursor ? ' done' : i === cursor ? ' running' : ' pending';
        return (
          <div key={b.key} className={`ov-box${i < shown ? ' shown' : ''}${state}`}>
            <div className="ov-box-title">{b.title}</div>
            {b.sub && <div className="ov-box-sub">{b.sub.map((x) => <span key={x}>{x}</span>)}</div>}
            {i < boxes.length - 1 && <div className="ov-arrow">→</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---- phase views ------------------------------------------------------------------------------

export function OvTokenize({ trace, p }: OvProps) {
  const tk = trace.tokenize;
  const n = tk.tokens.length;
  const visible = Math.min(n, Math.ceil(p * 1.4 * n + 0.0001));
  const segs = segments(tk.prompt, tk.tokens);
  return (
    <div className="ov-view" data-stage-panel="tokenize">
      <Caption stage="tokenize">{COPY.tokenize(trace)}</Caption>
      <div className="ov-prompt-text">
        {segs.map((s, i) => <span key={i} className={s.tok !== null && s.tok < visible ? `ov-seg on c${s.tok % 2}` : 'ov-seg'}>{s.text}</span>)}
      </div>
      <div className="ov-chips">
        {tk.tokens.map((t, i) => (
          <div key={i} className={i < visible ? 'chip-slot shown' : 'chip-slot'}><TokenChip id={t.id} text={t.piece} big active={t.special} /></div>
        ))}
      </div>
    </div>
  );
}

export function OvPrefill({ trace, step, p }: OvProps) {
  const cells = step.decodeEnd.kv_cells;
  const added = new Set(cells.slice(0, Math.ceil(Math.max(0, p * 1.5 - 0.25) * cells.length)));
  return (
    <div className="ov-view" data-stage-panel="prefill">
      <Caption stage="prefill">{COPY.prefill(trace, step)}</Caption>
      <div className="ov-batch">
        {step.batch.rows.map((r, i) => <TokenChip key={i} id={r.token} text={piece(trace, r.token)} big />)}
        <div className="ov-batch-label">one batch, one pass</div>
      </div>
      <Memory trace={trace} filled={step.cellsBefore} adding={added} big />
    </div>
  );
}

export function OvBuild({ trace, step, p }: OvProps) {
  const reused = step.graphEvent.reused;
  const n = trace.info.n_layer + 2;
  const shown = reused ? n : Math.ceil(p * 1.3 * n + 0.0001);
  return (
    <div className="ov-view" data-stage-panel="build">
      <Caption stage="build" extra={<span className={`ov-badge ${reused ? 'reused' : 'built'}`}>{reused ? 'plan reused' : 'new plan'}</span>}>
        {COPY.build(trace, step)}
      </Caption>
      <Plan trace={trace} step={step} shown={shown} />
      <div className="ov-stat"><B>{step.graphEvent.n_nodes}</B> operations in the plan</div>
    </div>
  );
}

export function OvDispatch({ trace, step, p }: OvProps) {
  const n = trace.info.n_layer + 2;
  const cursor = Math.min(n - 1, Math.floor(p * 1.15 * n));
  const done = p >= 0.999 || p * 1.15 * n >= n;
  return (
    <div className="ov-view" data-stage-panel="dispatch">
      <Caption stage="dispatch">{COPY.dispatch(trace, step)}</Caption>
      <Plan trace={trace} step={step} shown={n} cursor={cursor} done={done} />
      <Memory trace={trace} filled={done ? new Set([...step.cellsBefore, ...step.decodeEnd.kv_cells]) : step.cellsBefore}
        adding={done ? new Set() : new Set(step.decodeEnd.kv_cells)} big />
    </div>
  );
}

export function OvSample({ trace, step, p }: OvProps) {
  const st = step.stages;
  const last = st[st.length - 1];
  const sel = step.selected;
  const funnel = [{ label: 'all tokens scored', size: trace.info.n_vocab }, ...st.filter((s) => s.name !== 'dist' && s.name !== 'greedy' && s.name !== 'temp').map((s) => ({ label: s.name, size: s.size })), { label: 'picked', size: 1 }];
  const shownRows = Math.min(funnel.length, Math.ceil(p * 2.2 * funnel.length + 0.0001));
  const showCands = p > 0.45;
  const picked = p > 0.75;
  const greedy = last.name === 'greedy';
  // candidates in llama.cpp's array order; for greedy the array is unsorted, so order by logit (layout)
  const cands = greedy ? [...last.candidates].sort((a, b) => (b.logit ?? -Infinity) - (a.logit ?? -Infinity)).slice(0, 6) : last.candidates.slice(0, 6);
  const maxP = greedy ? 1 : Math.max(...cands.map((c) => c.p ?? 0), 1e-9);
  return (
    <div className="ov-view" data-stage-panel="sample">
      <Caption stage="sample">{COPY.sample(trace, step)}</Caption>
      <div className="ov-sample">
        <div className="ov-funnel">
          {funnel.map((f, i) => (
            <div key={i} className={`ov-funnel-row${i < shownRows ? ' shown' : ''}${i === funnel.length - 1 && picked ? ' picked' : ''}`}>
              <span className="ov-funnel-bar" style={{ width: `${Math.sqrt(f.size / trace.info.n_vocab) * 100}%` }} />
              <span className="ov-funnel-n">{f.size}</span>
              <span className="ov-funnel-label">{f.label}</span>
            </div>
          ))}
        </div>
        <div className={`ov-cands${showCands ? ' shown' : ''}`}>
          <div className="ov-cands-title">{greedy ? 'highest scores' : 'chance of each remaining token'}</div>
          {cands.map((c) => (
            <div key={c.id} className={`ov-cand${picked && c.id === sel.id ? ' picked' : ''}`}>
              <span className="ov-cand-piece">{showPiece(piece(trace, c.id))}</span>
              <span className="ov-cand-track"><span className="ov-cand-bar" style={{ width: `${greedy ? 100 : ((c.p ?? 0) / maxP) * 100}%` }} /></span>
              <span className="ov-cand-val">{greedy ? fmtNum(c.logit, 2) : fmtNum(c.p, 2)}</span>
            </div>
          ))}
        </div>
        <div className={`ov-picked${picked ? ' shown' : ''}`}>
          <TokenChip id={sel.id} text={sel.piece} big active />
          <span>picked</span>
        </div>
      </div>
    </div>
  );
}

export function OvRepeat({ trace, step, beat, p }: OvProps) {
  if (beat.kind === 'final') {
    return (
      <div className="ov-view" data-stage-panel="repeat">
        <Caption stage="repeat">{COPY.final(trace)}</Caption>
        <Sentence trace={trace} upTo={trace.steps.length} big />
      </div>
    );
  }
  const next = trace.steps[step.step + 1];
  const quick = beat.kind === 'quick';
  const grown = quick || p > 0.3;
  const filled = new Set([...step.cellsBefore, ...step.decodeEnd.kv_cells]);
  return (
    <div className="ov-view" data-stage-panel="repeat">
      <Caption stage="repeat">{quick ? COPY.quick(trace, step) : COPY.repeat(trace, step)}</Caption>
      <Sentence trace={trace} upTo={grown ? step.step + 1 : step.step} highlight={step.step} big />
      <Memory trace={trace} filled={filled} adding={next && (quick || p > 0.6) ? new Set(next.decodeEnd.kv_cells) : new Set()} big />
      {!quick && <div className="ov-stat">token <B>{step.selected.n_generated}</B> of <B>{trace.info.settings.n_predict}</B></div>}
    </div>
  );
}

export const OV_VIEWS: Record<StageKey, (p: OvProps) => ReactNode> = {
  tokenize: OvTokenize, prefill: OvPrefill, build: OvBuild, dispatch: OvDispatch, sample: OvSample, repeat: OvRepeat,
};
