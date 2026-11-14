import type { Step, Trace } from '../trace/parse';
import type { Beat } from '../trace/timeline';

export interface ViewProps {
  trace: Trace;
  step: Step;
  beat: Beat;
  /** progress through the beat, 0..1 (1 under prefers-reduced-motion) */
  p: number;
  record: boolean;
  width: number;
  height: number;
  /** fork from a candidate (live engine only) */
  onFork?: (step: number, tokenId: number) => void;
}
