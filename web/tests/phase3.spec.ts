// Phase 3 check: typing a prompt produces a trace in under a second, and its token ids equal a
// direct CLI run with the same prompt, seed and settings. Also: sampler knobs rerun, fork, errors.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(process.cwd(), '..');
const TRACER = path.join(ROOT, 'engine/build/bin/tracer');
const MODEL = path.join(ROOT, 'models/stories260K.gguf');

function cliIds(args: string[]): number[] {
  const out = execFileSync(TRACER, ['--model', MODEL, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'token_selected').map((e) => e.id);
}

async function uiIds(page: Page) {
  return page.$$eval('[data-output] [data-token-id]', (els) => els.map((e) => Number((e as HTMLElement).dataset.tokenId)));
}

/** Click Run (or press a knob) and wait for the live trace; returns click-to-rendered wall time */
async function runAndWait(page: Page, act: () => Promise<void>) {
  const before = await page.evaluate(() => window.__lastRun?.ms ?? null);
  const t0 = Date.now();
  await act();
  await page.waitForFunction((b) => window.__lastRun && window.__lastRun.ms !== b, before, { timeout: 10_000 });
  await page.waitForSelector('[data-stage-panel]');
  const wall = Date.now() - t0;
  const run = await page.evaluate(() => window.__lastRun!);
  return { wall, run };
}

async function seekToEnd(page: Page) {
  await page.evaluate(() => {
    const r = document.querySelector<HTMLInputElement>('.scrubber')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(r, r.max);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('typed prompt -> live trace under 1 s, ids equal a direct CLI run', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  const cases = [
    { prompt: 'The cat sat on the mat', seed: 7, n_predict: 12 },
    { prompt: 'Once upon a time there was a frog', seed: 42, n_predict: 16 },
  ];
  for (const c of cases) {
    await page.fill('[data-prompt-input]', c.prompt);
    await page.fill('.knobs label:has-text("seed") input', String(c.seed));
    await page.fill('.knobs label:has-text("n_predict") input', String(c.n_predict));
    const { wall, run } = await runAndWait(page, () => page.click('[data-run]'));
    const cli = cliIds(['--prompt', c.prompt, '--seed', String(c.seed), '--n-predict', String(c.n_predict)]);
    await seekToEnd(page);
    const shown = await uiIds(page);
    console.log(`${JSON.stringify(c.prompt)} seed ${c.seed}: bridge ${Math.round(run.ms)} ms, click-to-render ${wall} ms`);
    console.log(`  ui  ${JSON.stringify(shown)}\n  cli ${JSON.stringify(cli)}`);
    expect(run.ms).toBeLessThan(1000);
    expect(wall).toBeLessThan(1000);
    expect(run.ids).toEqual(cli);
    expect(shown).toEqual(cli);
  }
});

test('sampler knob reruns with the same seed (greedy) and matches the CLI', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  const { run } = await runAndWait(page, () => page.check('.knobs label:has-text("greedy") input'));
  const s = run.settings;
  const cli = cliIds(['--prompt', s.prompt, '--seed', String(s.seed), '--n-predict', String(s.n_predict), '--greedy']);
  console.log(`greedy ${JSON.stringify(s.prompt)}: ${Math.round(run.ms)} ms, ids ${JSON.stringify(run.ids)}`);
  expect(run.ids).toEqual(cli);
});

test('fork from a candidate resumes with the forced token', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  await runAndWait(page, () => page.click('[data-run]'));
  // step 1, Sample stage, top-k sub-beat: candidates with fork buttons
  await seekToEnd(page);
  await page.click('[data-output] [data-token-id] >> nth=1');           // jumps to step 1 sample
  await page.keyboard.press('ArrowRight');                               // logits -> end
  await page.keyboard.press('ArrowRight');                               // top-k
  const btn = page.locator('.fork-btn').first();
  const row = btn.locator('xpath=ancestor::tr');
  const forkId = Number(await row.locator('td').first().innerText());
  const before = await page.evaluate(() => window.__lastRun!.ids);
  const { run } = await runAndWait(page, () => btn.click());
  console.log(`fork at step 1 with ${forkId}: before ${JSON.stringify(before)} after ${JSON.stringify(run.ids)}`);
  expect(run.ids[0]).toBe(before[0]);
  expect(run.ids[1]).toBe(forkId);
  const s = run.settings;
  const cli = cliIds(['--prompt', s.prompt, '--seed', String(s.seed), '--n-predict', String(s.n_predict), '--force', s.force!.join(',')]);
  expect(run.ids).toEqual(cli);
});

test('tracer errors reach the page', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  await page.fill('.knobs label:has-text("n_predict") input', '0');
  await page.click('[data-run]');
  await expect(page.locator('[data-status]')).toContainText('n_predict', { timeout: 5000 });
  console.log('error shown:', await page.locator('[data-status]').innerText());
});

test('tracer stderr reaches the client as bridge_error', async ({ page }) => {
  await page.goto('/');
  const body = await page.evaluate(async () => {
    const r = await fetch('/api/trace', { method: 'POST', body: JSON.stringify({ prompt: 'Once upon a time', n_predict: 2, force: [99999] }) });
    return r.text();
  });
  const last = JSON.parse(body.trim().split('\n').at(-1)!);
  console.log('bridge_error:', last.bridge_error);
  expect(last.bridge_error).toContain('out of vocab');
});
