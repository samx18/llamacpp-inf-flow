// Screenshot each Overview beat (end state) for steps 0-2 and the final frame (review aid).
// usage: node scripts/shots-overview.mjs <outdir> [url]
import { chromium } from '@playwright/test';
const out = process.argv[2];
const url = process.argv[3] ?? 'http://localhost:5173/?view=overview';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(url);
await page.waitForSelector('[data-stage-panel]');
const attr = () => page.evaluate(() => { const c = document.querySelector('.canvas'); return { step: +c.dataset.step, stage: c.dataset.stage, beat: +c.dataset.beat }; });
const shots = [];
let prev = -1;
for (let i = 0; i < 100; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(40);
  const a = await attr();
  if (a.beat === prev) break;
  prev = a.beat;
  if (a.step > 2 && a.step < 11) continue;
  await page.waitForTimeout(400);
  const name = `ov-b${String(a.beat).padStart(2, '0')}-${a.step}-${a.stage}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  shots.push(name);
}
console.log('shots:', shots.join(' '));
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await browser.close();
