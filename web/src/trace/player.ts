// Trace player: a clock over the timeline. State shown on screen is derived from `t` only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Beat, StageKey, beatAt, findBeat, totalDuration } from './timeline';

const EPS = 0.001;

export interface Player {
  t: number;
  total: number;
  beat: Beat;
  progress: number;
  playing: boolean;
  speed: number;
  ended: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  setSpeed(s: number): void;
  stepForward(): void;
  stepBack(): void;
  stageForward(): void;
  stageBack(): void;
  jumpTo(step: number, stage: StageKey): void;
}

const end = (b: Beat) => b.start + b.dur - EPS;

export function usePlayer(beats: Beat[], opts: { autoplay?: boolean; onEnd?: () => void } = {}): Player {
  const total = useMemo(() => totalDuration(beats), [beats]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(!!opts.autoplay);
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(0);
  const onEnd = useRef(opts.onEnd);
  onEnd.current = opts.onEnd;

  const seek = useCallback((v: number) => {
    const c = Math.min(Math.max(v, 0), total);
    tRef.current = c;
    setT(c);
  }, [total]);

  // restart when a new timeline is loaded
  useEffect(() => { tRef.current = 0; setT(0); setPlaying(!!opts.autoplay); }, [beats]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const next = tRef.current + dt * speed;
      if (next >= total) {
        tRef.current = total;
        setT(total);
        setPlaying(false);
        onEnd.current?.();
        return;
      }
      tRef.current = next;
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total]);

  const beat = beatAt(beats, Math.min(t, total - EPS));
  const raw = (Math.min(t, total) - beat.start) / beat.dur;
  // a seek to a beat's end (start + dur - EPS) shows that beat's final state exactly
  const progress = raw >= 1 - (2 * EPS) / beat.dur ? 1 : Math.max(0, raw);

  const stepForward = useCallback(() => {
    setPlaying(false);
    const cur = beatAt(beats, tRef.current);
    if (tRef.current < end(cur) - EPS) seek(end(cur));
    else if (cur.index + 1 < beats.length) seek(end(beats[cur.index + 1]));
  }, [beats, seek]);

  const stepBack = useCallback(() => {
    setPlaying(false);
    const cur = beatAt(beats, tRef.current);
    if (cur.index > 0) seek(end(beats[cur.index - 1]));
    else seek(0);
  }, [beats, seek]);

  const stageForward = useCallback(() => {
    setPlaying(false);
    const cur = beatAt(beats, tRef.current);
    const nxt = beats.find((b) => b.index > cur.index && (b.step !== cur.step || b.stage !== cur.stage));
    if (nxt) seek(nxt.start);
  }, [beats, seek]);

  const stageBack = useCallback(() => {
    setPlaying(false);
    const cur = beatAt(beats, tRef.current);
    const first = beats.find((b) => b.step === cur.step && b.stage === cur.stage && b.kind === cur.kind)!;
    if (tRef.current > first.start + EPS && first.index !== cur.index) { seek(first.start); return; }
    const prev = [...beats].reverse().find((b) => b.index < first.index);
    if (prev) seek(beats.find((b) => b.step === prev.step && b.stage === prev.stage && b.kind === prev.kind)!.start);
    else seek(0);
  }, [beats, seek]);

  const jumpTo = useCallback((step: number, stage: StageKey) => {
    const b = findBeat(beats, step, stage) ?? findBeat(beats, 0, stage);
    if (b) { setPlaying(false); seek(b.start); }
  }, [beats, seek]);

  return {
    t, total, beat, progress, playing, speed, ended: t >= total,
    play: () => { if (tRef.current >= total) seek(0); setPlaying(true); },
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => { if (!p && tRef.current >= total) seek(0); return !p; }),
    seek, setSpeed, stepForward, stepBack, stageForward, stageBack, jumpTo,
  };
}

/** prefers-reduced-motion: views render each beat's end state instead of animating */
export function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [v, setV] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setV(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return v;
}
