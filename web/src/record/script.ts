// Record mode script: the fixed run and every stage duration, in one place. Tune by watching.
//
// The trace is the saved fixture, so every retake is identical. scripts/make-fixture.sh generates
// it from RECORD_RUN below; Record mode refuses to start if the trace's settings differ.
export const RECORD_RUN = {
  trace: '/demo-trace.jsonl',
  // chosen in Phase 5: reads as a sentence, and step 0's top-p keeps 22 candidates, so the
  // fully played sample stage shows a real draw (p = 0.26) rather than a single survivor
  prompt: 'Lily wanted to',
  seed: 11,
  n_predict: 12,
};

/** Milliseconds. Starting values from PLAN.md; total budget about 50 s. */
export const RECORD_DURATIONS = {
  tokenize: 4000,
  prefill: 5000,
  build: 6000,
  dispatch: 10000,
  sample: 8000,
  /** step 0's repeat + all of step 1 (build, dispatch, sample, repeat), compressed */
  firstLoop: 8000,
  /** each later token: one quick beat (cache column, chosen token, output strip) */
  laterToken: 500,
  /** final frame held after the last token */
  hold: 2500,
};

/** Shares of firstLoop per stage */
export const FIRST_LOOP_SPLIT = { repeat0: 0.18, build: 0.2, dispatch: 0.24, sample: 0.22, repeat1: 0.16 };

/** Budget the Playwright record check reports against (ms) */
export const RECORD_BUDGET_MS = 55000;

/** Interactive playback at 1x, per stage (ms). Every step plays in full. */
export const INTERACTIVE_DURATIONS = {
  tokenize: 2500,
  prefill: 3000,
  build: 3000,
  dispatch: 5000,
  sample: 4500,
  repeat: 1800,
  hold: 1000,
};

/**
 * Overview tab (plain-language version), used both interactively and in its Record mode.
 * Slower than the technical pass so captions can be read. Every phase is one beat.
 */
export const OVERVIEW_DURATIONS = {
  tokenize: 7000,
  prefill: 7000,
  build: 7000,
  dispatch: 6000,
  sample: 9000,
  repeat: 5000,
  /** step 1: the one-token pass (new, smaller plan), shown briefly */
  secondToken: 12000,
  /** each later token: one beat (sentence grows, memory gains a slot) */
  laterToken: 1200,
  hold: 5000,
};

/** Shares of secondToken per phase */
export const OVERVIEW_SECOND_SPLIT = { build: 0.3, dispatch: 0.2, sample: 0.3, repeat: 0.2 };

/** Budget the Overview record check reports against (ms) */
export const OVERVIEW_BUDGET_MS = 85000;
