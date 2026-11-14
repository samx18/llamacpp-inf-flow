import { useLayoutEffect, useRef, useState } from 'react';
import { StageHeader, TokenChip } from '../ui/common';
import type { ViewProps } from './types';

interface Seg { text: string; tok: number | null }

/** Split the prompt into segments at the token byte spans the tracer reported */
export function segments(prompt: string, spans: { start: number | null; end: number | null }[]): Seg[] {
  // byte offset -> UTF-16 index (layout only)
  const enc = new TextEncoder();
  const byteToChar: number[] = [];
  let b = 0;
  for (let i = 0; i < prompt.length; ) {
    const cp = prompt.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const n = enc.encode(ch).length;
    for (let k = 0; k < n; k++) byteToChar[b + k] = i;
    b += n;
    i += ch.length;
  }
  byteToChar[b] = prompt.length;
  const segs: Seg[] = [];
  let pos = 0;
  spans.forEach((s, ti) => {
    if (s.start === null || s.end === null || s.end <= s.start) return;
    const a = byteToChar[s.start] ?? pos, e = byteToChar[s.end] ?? prompt.length;
    if (a > pos) segs.push({ text: prompt.slice(pos, a), tok: null });
    segs.push({ text: prompt.slice(a, e), tok: ti });
    pos = e;
  });
  if (pos < prompt.length) segs.push({ text: prompt.slice(pos), tok: null });
  return segs;
}

export function TokenizeView({ trace, p, width }: ViewProps) {
  const tk = trace.tokenize;
  const n = tk.tokens.length;
  const visible = Math.min(n, Math.ceil(p * n + 0.0001));
  const segs = segments(tk.prompt, tk.tokens);
  const root = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number; tok: number }[]>([]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // layout offsets relative to the view (unaffected by the chips' CSS transitions)
    const off = (n: HTMLElement) => {
      let x = 0, y = 0, c: HTMLElement | null = n;
      while (c && c !== el) { x += c.offsetLeft; y += c.offsetTop; c = c.offsetParent as HTMLElement | null; }
      return { x, y, w: n.offsetWidth, h: n.offsetHeight };
    };
    const out: typeof lines = [];
    el.querySelectorAll<HTMLElement>('[data-chip]').forEach((chip) => {
      const ti = Number(chip.dataset.chip);
      const seg = el.querySelector<HTMLElement>(`[data-seg="${ti}"]`);
      if (!seg) return;
      const a = off(seg), c = off(chip);
      out.push({ x1: a.x + a.w / 2, y1: a.y + a.h + 4, x2: c.x + c.w / 2, y2: c.y - 4, tok: ti });
    });
    setLines(out);
  }, [visible, width, tk]);

  return (
    <div className="view tokenize-view" ref={root} data-stage-panel="tokenize">
      <StageHeader trace={trace} keys={['tokenize', 'token_to_piece']} />
      <div className="prompt-text">
        {segs.map((s, i) => (
          <span key={i} data-seg={s.tok ?? undefined} className={s.tok !== null && s.tok < visible ? 'seg on' : 'seg'}>
            {s.text}
          </span>
        ))}
      </div>
      <svg className="tok-lines" width="100%" height="100%">
        {lines.filter((l) => l.tok < visible).map((l) => (
          <path key={l.tok} d={`M${l.x1},${l.y1} C${l.x1},${(l.y1 + l.y2) / 2} ${l.x2},${(l.y1 + l.y2) / 2} ${l.x2},${l.y2}`} className="tok-line" />
        ))}
      </svg>
      <div className="chip-row tokenize-chips">
        {tk.tokens.map((t, i) => (
          <div key={i} data-chip={i} className={i < visible ? 'chip-slot shown' : 'chip-slot'}>
            <TokenChip id={t.id} text={t.piece} big active={t.special} />
          </div>
        ))}
      </div>
    </div>
  );
}
