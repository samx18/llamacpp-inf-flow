// Overview tab check (saved trace): plays end to end, every phase shows the trace's numbers,
// stepping backward restores the exact earlier state, and the tab switch keeps both views working.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TRACE = readFileSync(path.join(process.cwd(), 'public/demo-trace.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ofType = (t: string) => TRACE.filter((e) => e.type === t);
const fmtUs = (v: number) => `${v.toLocaleString('en-US')} µs`;

const attr = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLElement>('.canvas')!;
  return { beat: Number(c.dataset.beat), stage: c.dataset.stage!, step: Number(c.dataset.step), view: c.dataset.view };
});
const snapshot = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLElement>('.canvas')!.cloneNode(true) as HTMLElement;
  c.querySelector('.transport')?.remove();
  c.querySelector('.prompt-bar')?.remove();
  return c.innerHTML;
});
const panelText = (page: Page) => page.locator('[data-stage-panel]').innerText();

async function open(page: Page) {
  await page.goto('/?view=overview');
  await page.waitForSelector('[data-stage-panel]');
  expect((await attr(page)).view).toBe('overview');
}

/** step forward until (step, stage) is the current beat, at its end state */
async function goTo(page: Page, step: number, stage: string) {
  for (let i = 0; i < 100; i++) {
    const a = await attr(page);
    if (a.step === step && a.stage === stage) return panelText(page);
    await page.keyboard.press('ArrowRight');
  }
  throw new Error(`never reached ${step}/${stage}`);
}

test('overview plays end to end', async ({ page }) => {
  await open(page);
  await page.selectOption('.transport select', '8');
  await page.click('.transport .play');
  const seen = new Set<string>();
  const t0 = Date.now();
  while ((await page.getAttribute('.transport .play', 'data-playing')) !== 'false') {
    seen.add((await attr(page)).stage);
    if (Date.now() - t0 > 60_000) throw new Error('did not finish');
    await page.waitForTimeout(80);
  }
  console.log(`overview played in ${(Date.now() - t0) / 1000}s at 8x; stages: ${[...seen].join(', ')}`);
  expect([...seen].sort()).toEqual(['build', 'dispatch', 'prefill', 'repeat', 'sample', 'tokenize']);
  const done = ofType('done')[0];
  const txt = await panelText(page);
  expect(txt.replace(/\s+/g, ' ')).toContain(done.text.trim().replace(/\s+/g, ' '));
  expect(txt).toContain(fmtUs(done.totals_us.total));
  expect(txt).toContain(String(done.n_graphs_reused));
});

test('every overview phase shows the trace\'s numbers', async ({ page }) => {
  await open(page);
  const info = ofType('model_info')[0];
  const tok = ofType('tokenize')[0];
  const g = ofType('graph');
  const dec = ofType('decode_end');
  const stages0 = ofType('sampler_stage').filter((e) => e.step === 0);
  const sel = ofType('token_selected');

  let t = await goTo(page, 0, 'tokenize');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); // end state of tokenize
  t = await panelText(page);
  expect(t).toContain(String(info.n_vocab));
  for (const k of tok.tokens) expect(t).toContain(String(k.id));

  t = await goTo(page, 0, 'prefill');
  expect(t).toContain(String(ofType('batch')[0].n_tokens));

  t = await goTo(page, 0, 'build');
  expect(t).toContain(String(g[0].n_nodes));
  expect(t).toContain(String(info.n_layer));
  expect(t).toContain('new plan');

  t = await goTo(page, 0, 'dispatch');
  expect(t).toContain(fmtUs(dec[0].dur_us));
  expect(t).toContain(String(dec[0].n_computed));

  t = await goTo(page, 0, 'sample');
  for (const s of stages0.filter((s) => s.name === 'top-k' || s.name === 'top-p')) expect(t).toContain(String(s.size));
  expect(t).toContain(sel[0].piece.replace(/ /g, '␣'));

  t = await goTo(page, 0, 'repeat');
  expect(t).toContain(String(info.settings.n_predict));

  t = await goTo(page, 1, 'build');
  expect(t).toContain(g[1].reused ? 'plan reused' : 'new plan');

  t = await goTo(page, 2, 'repeat');
  expect(t).toContain(g[2].reused ? 'plan reused' : 'rebuilt');
});

test('overview: stepping backward restores the exact earlier state', async ({ page }) => {
  await open(page);
  const forward = new Map<number, string>();
  let last = -1;
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('ArrowRight');
    const a = await attr(page);
    if (a.beat === last) break;
    last = a.beat;
    await page.waitForTimeout(350);                  // let CSS transitions settle before snapshotting
    forward.set(a.beat, await snapshot(page));
  }
  let compared = 0;
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('ArrowLeft');
    const a = await attr(page);
    await page.waitForTimeout(350);
    expect(await snapshot(page), `beat ${a.beat} (${a.stage}, step ${a.step})`).toBe(forward.get(a.beat));
    compared++;
    if (a.beat === 0) break;
  }
  console.log(`overview: ${forward.size} beats forward, ${compared} compared backward: identical`);
  expect(compared).toBe(forward.size - 1);
});

test('tabs switch between the two views on the same trace', async ({ page }) => {
  await open(page);
  await page.click('[data-tab="detail"]');
  expect((await attr(page)).view).toBe('detail');
  await expect(page.locator('.stage-header code').first()).toHaveText(ofType('model_info')[0].sources.tokenize.fn);
  await page.click('[data-tab="overview"]');
  expect((await attr(page)).view).toBe('overview');
  await expect(page.locator('.ov-title').first()).toContainText('Tokenize');
});
