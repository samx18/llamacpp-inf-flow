// Phase 2 check (saved trace only, no engine):
// 1. the saved trace plays end to end
// 2. every stage shows data from the trace (values compared against the trace file)
// 3. stepping backward restores the exact earlier state (DOM identical at every beat)
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TRACE = readFileSync(path.join(process.cwd(), 'public/demo-trace.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ofType = (t: string) => TRACE.filter((e) => e.type === t);

const canvasAttr = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLElement>('.canvas')!;
  return { beat: Number(c.dataset.beat), stage: c.dataset.stage!, step: Number(c.dataset.step) };
});
// everything the player renders except the scrubber thumb position
const snapshot = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLElement>('.canvas')!.cloneNode(true) as HTMLElement;
  c.querySelector('.transport')?.remove();
  c.querySelector('.prompt-bar')?.remove();
  return c.innerHTML;
});
const panelText = (page: Page) => page.locator('[data-stage-panel]').innerText();

test('saved trace plays end to end', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  await page.selectOption('.transport select', '8');
  await page.click('.transport .play');
  const seen = new Set<string>();
  const t0 = Date.now();
  for (;;) {
    const a = await canvasAttr(page);
    seen.add(a.stage);
    const playing = await page.getAttribute('.transport .play', 'data-playing');
    if (playing === 'false') break;
    if (Date.now() - t0 > 200_000) throw new Error('playback did not finish');
    await page.waitForTimeout(100);
  }
  const end = await canvasAttr(page);
  const steps = ofType('token_selected').length;
  console.log(`played to beat ${end.beat}, step ${end.step}; stages seen: ${[...seen].join(', ')}; ${(Date.now() - t0) / 1000}s at 8x`);
  expect(end.step).toBe(steps - 1);
  expect([...seen].sort()).toEqual(['build', 'dispatch', 'prefill', 'repeat', 'sample', 'tokenize']);
  // the final frame shows the tracer's done event
  const done = ofType('done')[0];
  const txt = await panelText(page);
  expect(txt).toContain(done.reason);
  expect(txt).toContain(`${done.totals_us.decode.toLocaleString('en-US')} µs`);
  // the output strip holds every generated token id
  const ids = await page.$$eval('[data-output] [data-token-id]', (els) => els.map((e) => Number((e as HTMLElement).dataset.tokenId)));
  expect(ids).toEqual(ofType('token_selected').map((e) => e.id));
});

test('every stage shows data from the trace', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  const visit = async (stage: string) => {
    await page.click(`[data-rail="${stage}"]`);
    // go to the end of the stage's last sub-beat
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowRight');
      if ((await canvasAttr(page)).stage !== stage) { await page.keyboard.press('ArrowLeft'); break; }
    }
    expect((await canvasAttr(page)).stage).toBe(stage);
    return panelText(page);
  };
  const tok = ofType('tokenize')[0];
  const batch0 = ofType('batch')[0];
  const graph0 = ofType('graph')[0];
  const dec0 = ofType('decode_end')[0];
  const sel0 = ofType('token_selected')[0];
  const batch1 = ofType('batch')[1];
  const info = ofType('model_info')[0];

  let t = await visit('tokenize');
  for (const k of tok.tokens) expect(t).toContain(String(k.id));
  expect(t).toContain(info.sources.tokenize.fn);

  t = await visit('prefill');
  for (const r of batch0.rows) expect(t).toContain(String(r.token));
  expect(t).toContain(String(dec0.kv_pos_max));

  t = await visit('build');
  for (const b of graph0.blocks) expect(t).toContain(b.name);
  expect(t).toContain(String(graph0.n_nodes));
  expect(t).toContain('built');

  t = await visit('dispatch');
  expect(t).toContain(dec0.op_time_us[0].op);
  expect(t).toContain(`${dec0.op_time_us[0].us} µs`);
  const lastExec = ofType('node_exec').filter((e) => e.step === 0).at(-1);
  expect(t).toContain(String(lastExec.dur_us));

  t = await visit('sample');
  expect(t).toContain(String(sel0.id));
  for (const s of ofType('sampler_stage').filter((e) => e.step === 0)) expect(t).toContain(s.name);

  t = await visit('repeat');
  expect(t).toContain(String(batch1.rows[0].token));
  expect(t).toContain(String(batch1.rows[0].pos));
});

test('stepping backward restores the exact earlier state', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  const forward = new Map<number, string>();
  let last = -1;
  for (let i = 0; i < 2000; i++) {
    await page.keyboard.press('ArrowRight');
    const a = await canvasAttr(page);
    if (a.beat === last) break;
    last = a.beat;
    forward.set(a.beat, await snapshot(page));
  }
  console.log(`captured ${forward.size} beats forward`);
  expect(forward.size).toBeGreaterThan(50);
  let compared = 0;
  for (let i = 0; i < 2000; i++) {
    await page.keyboard.press('ArrowLeft');
    const a = await canvasAttr(page);
    if (!forward.has(a.beat)) break;
    expect(await snapshot(page), `beat ${a.beat} (${a.stage}, step ${a.step})`).toBe(forward.get(a.beat));
    compared++;
    if (a.beat === 0) break;
  }
  console.log(`compared ${compared} beats backward: identical`);
  expect(compared).toBe(forward.size - 1); // every beat except the last one, where stepping back started
});

test('prefers-reduced-motion renders each beat in its end state', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForSelector('[data-stage-panel]');
  // at t = 0 the tokenize beat would show no chips if it animated
  const shown = await page.$$eval('.chip-slot.shown', (e) => e.length);
  expect(shown).toBe(ofType('tokenize')[0].tokens.length);
  await ctx.close();
});
