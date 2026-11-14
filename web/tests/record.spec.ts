// Phase 4 check: start Record mode, wait for it to finish, assert every stage panel rendered
// non-empty, and report the total duration against the budget.
//   RECORD_OUT=<dir>  also saves one screenshot per stage beat and a video of the pass
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { RECORD_BUDGET_MS, RECORD_DURATIONS } from '../src/record/script';

const OUT = process.env.RECORD_OUT;

test('Record mode plays the scripted pass within budget', async ({ browser }) => {
  if (OUT) mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(OUT ? { recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } } : {}),
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  const t0 = Date.now();
  await page.keyboard.press('r');                       // the one key that starts Record mode
  await page.waitForFunction(() => document.body.dataset.recordState === 'playing');

  // settings and transport are hidden in Record mode
  expect(await page.locator('.prompt-bar').count()).toBe(0);
  expect(await page.locator('.transport').count()).toBe(0);

  const shot = new Set<string>();
  for (;;) {
    const st = await page.evaluate(() => document.body.dataset.recordState);
    if (st === 'done') break;
    if (Date.now() - t0 > RECORD_BUDGET_MS * 2) throw new Error('Record mode did not finish');
    if (OUT) {
      const key = await page.evaluate(() => { const c = document.querySelector<HTMLElement>('.canvas')!; return `${c.dataset.step}-${c.dataset.stage}`; });
      if (!shot.has(key)) { shot.add(key); await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/record-${key}.png` }); }
    }
    await page.waitForTimeout(50);
  }
  const wall = Date.now() - t0;
  const log = await page.evaluate(() => window.__recordLog!);
  const planned = log.length ? Math.round(log[log.length - 1].t) : 0;

  const byStage = new Map<string, { beats: number; minElements: number; minText: number }>();
  for (const e of log) {
    const k = e.kind === 'quick' ? 'repeat (quick)' : e.kind === 'final' ? 'final frame' : e.stage;
    const v = byStage.get(k) ?? { beats: 0, minElements: Infinity, minText: Infinity };
    v.beats++; v.minElements = Math.min(v.minElements, e.elements); v.minText = Math.min(v.minText, e.text);
    byStage.set(k, v);
  }
  console.log('stage           beats  min elements  min text chars');
  for (const [k, v] of byStage) console.log(`${k.padEnd(16)}${String(v.beats).padStart(5)}${String(v.minElements).padStart(14)}${String(v.minText).padStart(16)}`);
  const scripted = Object.values(RECORD_DURATIONS);
  console.log(`total: ${(wall / 1000).toFixed(1)} s wall clock (key press to done); budget ${(RECORD_BUDGET_MS / 1000).toFixed(0)} s; script durations ${JSON.stringify(RECORD_DURATIONS)}`);
  console.log(`last beat started at ${(planned / 1000).toFixed(1)} s of timeline; page errors: ${errors.length}`);

  for (const s of ['tokenize', 'prefill', 'build', 'dispatch', 'sample', 'repeat', 'repeat (quick)', 'final frame']) {
    const v = byStage.get(s);
    expect(v, `stage ${s} rendered`).toBeTruthy();
    expect(v!.minElements, `stage ${s} has elements`).toBeGreaterThan(3);
    expect(v!.minText, `stage ${s} has text`).toBeGreaterThan(10);
  }
  expect(errors).toEqual([]);
  expect(wall).toBeLessThan(RECORD_BUDGET_MS);
  expect(scripted.length).toBeGreaterThan(0);
  await ctx.close();
});
