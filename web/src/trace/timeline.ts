// The player's timeline: a list of beats laid end to end. A beat is one stage of one step, or a
// sub-part of it (one dispatch block, one sampler stage). Everything shown is a pure function of
// (trace, beat, progress), so seeking to any time restores exactly that state.
import type { Trace } from './parse';
import { FIRST_LOOP_SPLIT, INTERACTIVE_DURATIONS, OVERVIEW_DURATIONS, OVERVIEW_SECOND_SPLIT, RECORD_DURATIONS } from '../record/script';

export const STAGES = ['tokenize', 'prefill', 'build', 'dispatch', 'sample', 'repeat'] as const;
export type StageKey = (typeof STAGES)[number];

export interface Beat {
  index: number;
  step: number;
  stage: StageKey;
  /** sub-beat index within the stage (dispatch: block index; sample: 0 logits, 1..n samplers, n+1 chosen) */
  sub: number;
  nSub: number;
  /** quick: compressed later-token beat in Record mode; final: the held last frame */
  kind: 'full' | 'quick' | 'final';
  start: number;
  dur: number;
}

/** interactive / record: the technical tab; overview: the plain-language tab (one beat per phase) */
export type Mode = 'interactive' | 'record' | 'overview';

function subCount(trace: Trace, step: number, stage: StageKey): number {
  const s = trace.steps[step];
  if (stage === 'dispatch') return Math.max(1, s.graph.blocks.length);
  if (stage === 'sample') return s.stages.length + 2;
  return 1;
}

export function buildTimeline(trace: Trace, mode: Mode): Beat[] {
  const beats: Beat[] = [];
  let t = 0;
  const push = (step: number, stage: StageKey, total: number, kind: Beat['kind'] = 'full') => {
    const n = kind === 'full' && mode !== 'overview' ? subCount(trace, step, stage) : 1;
    for (let sub = 0; sub < n; sub++) {
      beats.push({ index: beats.length, step, stage, sub, nSub: n, kind, start: t, dur: total / n });
      t += total / n;
    }
  };
  const nSteps = trace.steps.length;

  if (mode === 'interactive') {
    const d = INTERACTIVE_DURATIONS;
    for (let s = 0; s < nSteps; s++) {
      if (s === 0) { push(0, 'tokenize', d.tokenize); push(0, 'prefill', d.prefill); }
      push(s, 'build', d.build);
      push(s, 'dispatch', d.dispatch);
      push(s, 'sample', d.sample);
      push(s, 'repeat', d.repeat);
    }
    push(nSteps - 1, 'repeat', d.hold, 'final');
    return beats;
  }

  if (mode === 'overview') {
    const o = OVERVIEW_DURATIONS;
    push(0, 'tokenize', o.tokenize);
    push(0, 'prefill', o.prefill);
    push(0, 'build', o.build);
    push(0, 'dispatch', o.dispatch);
    push(0, 'sample', o.sample);
    push(0, 'repeat', o.repeat);
    if (nSteps > 1) {
      push(1, 'build', o.secondToken * OVERVIEW_SECOND_SPLIT.build);
      push(1, 'dispatch', o.secondToken * OVERVIEW_SECOND_SPLIT.dispatch);
      push(1, 'sample', o.secondToken * OVERVIEW_SECOND_SPLIT.sample);
      push(1, 'repeat', o.secondToken * OVERVIEW_SECOND_SPLIT.repeat);
    }
    for (let s = 2; s < nSteps; s++) push(s, 'repeat', o.laterToken, 'quick');
    push(nSteps - 1, 'repeat', o.hold, 'final');
    return beats;
  }

  const d = RECORD_DURATIONS;
  push(0, 'tokenize', d.tokenize);
  push(0, 'prefill', d.prefill);
  push(0, 'build', d.build);
  push(0, 'dispatch', d.dispatch);
  push(0, 'sample', d.sample);
  push(0, 'repeat', d.firstLoop * FIRST_LOOP_SPLIT.repeat0);
  if (nSteps > 1) {
    push(1, 'build', d.firstLoop * FIRST_LOOP_SPLIT.build);
    push(1, 'dispatch', d.firstLoop * FIRST_LOOP_SPLIT.dispatch);
    push(1, 'sample', d.firstLoop * FIRST_LOOP_SPLIT.sample);
    push(1, 'repeat', d.firstLoop * FIRST_LOOP_SPLIT.repeat1);
  }
  for (let s = 2; s < nSteps; s++) push(s, 'repeat', d.laterToken, 'quick');
  push(nSteps - 1, 'repeat', d.hold, 'final');
  return beats;
}

export function totalDuration(beats: Beat[]): number {
  const last = beats[beats.length - 1];
  return last.start + last.dur;
}

/** Beat containing time t (binary search) */
export function beatAt(beats: Beat[], t: number): Beat {
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return beats[lo];
}

/** First beat of a stage in a step, if that stage exists in the timeline for the step */
export function findBeat(beats: Beat[], step: number, stage: StageKey): Beat | undefined {
  return beats.find((b) => b.step === step && b.stage === stage && b.kind !== 'final');
}
