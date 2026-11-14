// Screenshot every beat of the first two steps of the saved trace at its end state, plus the
// op-level expansion and the attention hover (review aid).
// usage: node scripts/shots.mjs <outdir> [url]
import { chromium } from '@playwright/test';
const out = process.argv[2];
const url = process.argv[3] ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url);
await page.waitForSelector('[data-stage-panel]');
const attr = () => page.evaluate(() => { const c = document.querySelector('.canvas'); return { step: +c.dataset.step, stage: c.dataset.stage, beat: +c.dataset.beat }; });
const shots = [];
let prev = -1;
for (let i = 0; i < 200; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(40);
  const a = await attr();
  if (a.beat === prev) break;
  prev = a.beat;
  if (a.step > 1) break;
  await page.waitForTimeout(350);
  const name = `${a.step}-${a.stage}-b${a.beat}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  shots.push(name);
}
// op-level expansion of layer 0 (Build graph, step 0)
await page.click('[data-rail="build"]');
await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
await page.click('[data-rail="build"]');
await page.click('[data-block="attn_out-0"]');
await page.waitForTimeout(800);
await page.mouse.move(700, 450);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/expand-layer0.png` });
shots.push('expand-layer0');
// attention on hover of the 2nd generated token
const chips = await page.$$('[data-output] [data-token-id]');
await page.click('[data-rail="repeat"]');
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
const chips2 = await page.$$('[data-output] [data-token-id]');
if (chips2[1]) { await chips2[1].hover(); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/attention-hover.png` }); shots.push('attention-hover'); }
console.log('shots:', shots.join(' '));
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await browser.close();
