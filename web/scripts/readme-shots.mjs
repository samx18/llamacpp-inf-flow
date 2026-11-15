// Capture the two README screenshots from the saved trace (1920x1080, PNG).
// usage: node scripts/readme-shots.mjs <outdir> [base url]
import { chromium } from '@playwright/test';
const out = process.argv[2];
const base = process.argv[3] ?? 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const attr = () => page.evaluate(() => { const c = document.querySelector('.canvas'); return { step: +c.dataset.step, stage: c.dataset.stage, beat: +c.dataset.beat }; });

// Overview: end state of the step-0 Sample phase
await page.goto(`${base}/?view=overview`);
await page.waitForSelector('[data-stage-panel]');
for (let i = 0; i < 20 && (await attr()).stage !== 'sample'; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/overview.png` });

// Inside llama.cpp: step-0 Dispatch, a few blocks in (layer 1 attention running)
await page.goto(`${base}/`);
await page.waitForSelector('[data-stage-panel]');
for (let i = 0; i < 40 && (await attr()).stage !== 'dispatch'; i++) await page.keyboard.press('ArrowRight');
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/inside-llama-cpp.png` });
console.log('ok', await attr());
await browser.close();
