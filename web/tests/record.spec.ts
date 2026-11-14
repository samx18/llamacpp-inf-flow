// Record mode check, for both tabs: start Record mode, wait for it to finish, assert every stage
// panel rendered non-empty, and report the total duration against the budget.
//   RECORD_OUT=<dir>  also saves one screenshot per stage and a video of each pass
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { OVERVIEW_BUDGET_MS, RECORD_BUDGET_MS } from '../src/record/script';

const OUT = process.env.RECORD_OUT;

for (const cfg of [
  { view: 'detail', label: 'Inside llama.cpp', budget: RECORD_BUDGET_MS, stages: ['tokenize', 'prefill', 'build', 'dispatch', 'sample', 'repeat', 'repeat (quick)', 'final frame'] },
  { view: 'overview', label: 'Overview', budget: OVERVIEW_BUDGET_MS, stages: ['tokenize', 'prefill', 'build', 'dispatch', 'sample', 'repeat', 'repeat (quick)', 'final frame'] },
]) {
  test(`Record mode (${cfg.label}) plays the scripted pass within budget`, async ({ browser }) => {
    test.setTimeout(cfg.budget * 2 + 30_000);
    const dir = OUT ? `${OUT}/${cfg.view}` : undefined;
    if (dir) mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ...(dir ? { recordVideo: { dir, size: { width: 1920, height: 1080 } } } : {}),
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/');
    await page.waitForSelector('[data-stage-panel]');
    await page.click(`[data-tab="${cfg.view}"]`);
    const t0 = Date.now();
    await page.keyboard.press('r');                       // the one key that starts Record mode
    await page.waitForFunction(() => document.body.dataset.recordState === 'playing');
    expect(await page.locator('.prompt-bar').count()).toBe(0);
    expect(await page.locator('.transport').count()).toBe(0);
    expect(await page.locator('.tabs').count()).toBe(0);
    expect(await page.getAttribute('.canvas', 'data-view')).toBe(cfg.view);

    const shot = new Set<string>();
    for (;;) {
      if (await page.evaluate(() => document.body.dataset.recordState) === 'done') break;
      if (Date.now() - t0 > cfg.budget * 2) throw new Error('Record mode did not finish');
      if (dir) {
        const key = await page.evaluate(() => { const c = document.querySelector<HTMLElement>('.canvas')!; return `${c.dataset.step}-${c.dataset.stage}`; });
        if (!shot.has(key)) { shot.add(key); await page.waitForTimeout(250); await page.screenshot({ path: `${dir}/record-${key}.png` }); }
      }
      await page.waitForTimeout(50);
    }
    const wall = Date.now() - t0;
    const log = await page.evaluate(() => window.__recordLog!);
    const byStage = new Map<string, { beats: number; minElements: number; minText: number }>();
    for (const e of log) {
      const k = e.kind === 'quick' ? 'repeat (quick)' : e.kind === 'final' ? 'final frame' : e.stage;
      const v = byStage.get(k) ?? { beats: 0, minElements: Infinity, minText: Infinity };
      v.beats++; v.minElements = Math.min(v.minElements, e.elements); v.minText = Math.min(v.minText, e.text);
      byStage.set(k, v);
    }
    console.log(`[${cfg.label}] stage           beats  min elements  min text chars`);
    for (const [k, v] of byStage) console.log(`[${cfg.label}] ${k.padEnd(16)}${String(v.beats).padStart(5)}${String(v.minElements).padStart(14)}${String(v.minText).padStart(16)}`);
    console.log(`[${cfg.label}] total: ${(wall / 1000).toFixed(1)} s wall clock (key press to done); budget ${(cfg.budget / 1000).toFixed(0)} s; page errors: ${errors.length}`);
    for (const s of cfg.stages) {
      const v = byStage.get(s);
      expect(v, `stage ${s} rendered`).toBeTruthy();
      expect(v!.minElements, `stage ${s} has elements`).toBeGreaterThan(3);
      expect(v!.minText, `stage ${s} has text`).toBeGreaterThan(10);
    }
    expect(errors).toEqual([]);
    expect(wall).toBeLessThan(cfg.budget);
    await ctx.close();
  });
}
