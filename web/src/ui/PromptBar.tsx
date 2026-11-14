import { useState } from 'react';

export interface RunSettings {
  prompt: string;
  seed: number;
  n_predict: number;
  greedy: boolean;
  top_k: number;
  top_p: number;
  temp: number;
}

export const PRESETS = ['Once upon a time', 'One day, a little girl', 'The little dog', 'Lily and Tom went to the park'];

export function PromptBar({ settings, onRun, busy, status, error }: {
  settings: RunSettings;
  onRun: (s: RunSettings) => void;
  busy: boolean;
  status: string;
  error: string | null;
}) {
  // f32 settings echoed by the tracer (0.949999988) are shown at input precision
  const [s, setS] = useState({ ...settings, top_p: Number(settings.top_p.toPrecision(6)), temp: Number(settings.temp.toPrecision(6)) });
  const set = <K extends keyof RunSettings>(k: K, v: RunSettings[K]) => setS((o) => ({ ...o, [k]: v }));
  // sampler knobs rerun immediately with the same seed
  const knob = <K extends keyof RunSettings>(k: K, v: RunSettings[K]) => { const n = { ...s, [k]: v }; setS(n); onRun(n); };
  return (
    <div className="prompt-bar">
      <form className="prompt-form" onSubmit={(e) => { e.preventDefault(); onRun(s); }}>
        <input className="prompt-input" value={s.prompt} onChange={(e) => set('prompt', e.target.value)} placeholder="prompt" data-prompt-input />
        <button type="submit" className="run-btn" disabled={busy} data-run>Run</button>
      </form>
      <div className="presets">
        {PRESETS.map((p) => <button key={p} onClick={() => { set('prompt', p); onRun({ ...s, prompt: p }); }}>{p}</button>)}
      </div>
      <div className="knobs">
        <label>seed <input type="number" value={s.seed} onChange={(e) => set('seed', Number(e.target.value))} /></label>
        <label>n_predict <input type="number" min={1} max={64} value={s.n_predict} onChange={(e) => set('n_predict', Number(e.target.value))} /></label>
        <label><input type="checkbox" checked={s.greedy} onChange={(e) => knob('greedy', e.target.checked)} /> greedy</label>
        <label>top-k <input type="number" min={0} value={s.top_k} disabled={s.greedy} onChange={(e) => knob('top_k', Number(e.target.value))} /></label>
        <label>top-p <input type="number" step={0.05} min={0} max={1} value={s.top_p} disabled={s.greedy} onChange={(e) => knob('top_p', Number(e.target.value))} /></label>
        <label>temp <input type="number" step={0.1} min={0} value={s.temp} disabled={s.greedy} onChange={(e) => knob('temp', Number(e.target.value))} /></label>
      </div>
      <div className="status">
        <span className="caveat">stories260K knows TinyStories English only</span>
        <span className={error ? 'err' : 'ok'} data-status>{error ?? status}</span>
      </div>
    </div>
  );
}
