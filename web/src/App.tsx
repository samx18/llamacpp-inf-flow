import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { indexTrace, loadTraceUrl, parseLines, type Trace } from './trace/parse';
import { buildTimeline, type Mode, type StageKey } from './trace/timeline';
import { usePlayer, useReducedMotion } from './trace/player';
import type { TraceEvent } from './trace/schema';
import { RECORD_RUN } from './record/script';
import { TokenizeView } from './stages/TokenizeView';
import { PrefillView } from './stages/PrefillView';
import { BuildView } from './stages/BuildView';
import { DispatchView } from './stages/DispatchView';
import { SampleView } from './stages/SampleView';
import { RepeatView } from './stages/RepeatView';
import type { ViewProps } from './stages/types';
import { AttentionPopover, OutputStrip, PipelineRail, Transport } from './ui/Frame';
import { PromptBar, type RunSettings } from './ui/PromptBar';

const W = 1920, H = 1080;

declare global {
  interface Window {
    __recordLog?: { t: number; step: number; stage: string; kind: string; sub: number; elements: number; text: number }[];
    __lastRun?: { ms: number; ids: number[]; settings: RunSettings & { force?: number[] } };
  }
}

/** Fetch a live trace from the dev-server bridge; resolves when the tracer's done event arrives */
async function runLive(req: RunSettings & { force?: number[] }): Promise<{ trace: Trace; ms: number }> {
  const t0 = performance.now();
  const res = await fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  if (!res.ok || !res.body) throw new Error(`bridge: HTTP ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: TraceEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: true });
      const nl = buf.lastIndexOf('\n');
      if (nl >= 0) { events.push(...parseLines(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
    }
    if (done) break;
  }
  if (buf.trim()) events.push(...parseLines(buf));
  return { trace: indexTrace(events), ms: performance.now() - t0 };
}

function settingsOf(trace: Trace): RunSettings {
  const s = trace.info.settings;
  return { prompt: s.prompt, seed: s.seed, n_predict: s.n_predict, greedy: s.sampling === 'greedy', top_k: s.top_k, top_p: s.top_p, temp: s.temp };
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [mode, setMode] = useState<Mode>('interactive');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('saved trace');
  const [busy, setBusy] = useState(false);
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const pendingJump = useRef<{ step: number; stage: StageKey } | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const f = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    f();
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);

  const startRecord = useCallback(async () => {
    try {
      const t = await loadTraceUrl(RECORD_RUN.trace);
      const s = t.info.settings;
      if (s.prompt !== RECORD_RUN.prompt || s.seed !== RECORD_RUN.seed || s.n_predict !== RECORD_RUN.n_predict) {
        throw new Error(`record trace settings (${JSON.stringify([s.prompt, s.seed, s.n_predict])}) differ from record/script.ts; run scripts/make-fixture.sh`);
      }
      window.__recordLog = [];
      document.body.dataset.recordState = 'playing';
      setTrace(t);
      setMode('record');
    } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => {
    if (params.get('record') === '1') { startRecord(); return; }
    loadTraceUrl(params.get('trace') ?? '/demo-trace.jsonl').then(setTrace, (e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const beats = useMemo(() => (trace ? buildTimeline(trace, mode) : null), [trace, mode]);
  const player = usePlayer(beats ?? [{ index: 0, step: 0, stage: 'tokenize', sub: 0, nSub: 1, kind: 'full', start: 0, dur: 1 }], {
    autoplay: mode === 'record',
    onEnd: () => { if (mode === 'record') document.body.dataset.recordState = 'done'; },
  });

  // apply a jump requested before the new trace was loaded (fork)
  useEffect(() => {
    if (beats && pendingJump.current) { player.jumpTo(pendingJump.current.step, pendingJump.current.stage); pendingJump.current = null; }
  }, [beats]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (s: RunSettings & { force?: number[] }, jump?: { step: number; stage: StageKey }) => {
    setBusy(true); setError(null); setStatus('running tracer…');
    try {
      const { trace: t, ms } = await runLive(s);
      window.__lastRun = { ms, ids: t.steps.map((x) => x.selected.id), settings: s };
      pendingJump.current = jump ?? null;
      setMode('interactive');
      setTrace(t);
      setStatus(`live trace · totals_us.total ${t.done.totals_us.total.toLocaleString('en-US')} µs`);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    setBusy(false);
  }, []);

  const onFork = useCallback((step: number, id: number) => {
    if (!trace) return;
    const force = [...trace.steps.slice(0, step).map((s) => s.selected.id), id];
    const s = settingsOf(trace);
    run({ ...s, n_predict: Math.max(s.n_predict, force.length), force }, { step, stage: 'sample' });
  }, [trace, run]);

  // keyboard: space play/pause, ←/→ step, ↑/↓ stage, r Record mode, Escape leaves it
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); player.toggle(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); player.stepForward(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); player.stepBack(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); player.stageForward(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); player.stageBack(); }
      else if (e.key === 'r' && mode !== 'record') startRecord();
      else if (e.key === 'Escape' && mode === 'record') { setMode('interactive'); document.body.dataset.recordState = ''; }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [player, mode, startRecord]);

  const record = mode === 'record';
  const beat = player.beat;
  const p = reduced ? 1 : player.progress;

  // Record mode log for the Playwright check: what each beat rendered
  useEffect(() => {
    if (!record || !window.__recordLog) return;
    const el = document.querySelector('[data-stage-panel]');
    window.__recordLog.push({
      t: player.t, step: beat.step, stage: beat.stage, kind: beat.kind, sub: beat.sub,
      elements: el ? el.querySelectorAll('*').length : 0, text: el ? (el.textContent ?? '').trim().length : 0,
    });
  }, [record, beat.index]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!trace || !beats) {
    return <div className="loading-screen">{error ?? 'loading trace…'}</div>;
  }

  const step = trace.steps[Math.min(beat.step, trace.steps.length - 1)];
  const panelW = W - 64;
  const panelH = record ? 780 : 690;
  const vp: ViewProps = { trace, step, beat, p, record, width: panelW, height: panelH, onFork: record ? undefined : onFork };
  const View = { tokenize: TokenizeView, prefill: PrefillView, build: BuildView, dispatch: DispatchView, sample: SampleView, repeat: RepeatView }[beat.stage];

  return (
    <div className="viewport">
      <div className={`canvas${record ? ' record' : ''}`} style={{ width: W, height: H, transform: `scale(${scale})` }}
           data-mode={mode} data-beat={beat.index} data-stage={beat.stage} data-step={beat.step}>
        {!record && (
          <PromptBar settings={settingsOf(trace)} onRun={(s) => run(s)} busy={busy} status={status} error={error} key={JSON.stringify(settingsOf(trace))} />
        )}
        <PipelineRail beat={beat} onStage={(s) => player.jumpTo(s === 'tokenize' || s === 'prefill' ? 0 : beat.step, s)} />
        <div className="panel" style={{ height: panelH }}>
          <View key={`${beat.stage}-${beat.kind}`} {...vp} />
        </div>
        <OutputStrip trace={trace} beat={beat} record={record} onToken={(s) => player.jumpTo(s, 'sample')} onHover={setHoverStep} />
        {!record && hoverStep !== null && <AttentionPopover trace={trace} step={hoverStep} />}
        {!record && <Transport player={player} />}
      </div>
    </div>
  );
}
