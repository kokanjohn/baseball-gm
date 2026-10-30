// §100 (2e) The full radar at every zoom × loop, in a theme, at a stormy moment: a contact sheet for review.
//   node tools/harness/radar-gallery.mjs outDir theme [query]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark', query = 'region=north&day=101&hour=22'] = process.argv.slice(2);
const browser = await chromium.launch();
const shots = [];
for (const loop of ['past2h', 'next6h', 'next24h']) for (const zoom of [0, 1, 2]) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:8765/baseball-gm/tools/harness/radar-sheet-test.html?${query}&theme=${theme}&loop=${loop}&zoom=${zoom}`);
  await page.waitForFunction(() => window.sheet && window.sheet.state.frames && window.sheet.state.loaded === window.sheet.state.frames, null, { timeout: 120000 });
  await page.click('.rs-play');
  // A frame partway through: an hour ago, three hours ahead, twelve hours ahead.
  const idx = { past2h: 6, next6h: 12, next24h: 12 }[loop];
  await page.$eval('.rs-scrub', (el, i) => { el.value = String(i); el.dispatchEvent(new Event('input', { bubbles: true })); }, idx);
  await page.waitForTimeout(300);
  const file = `${out}/g-${theme}-${loop}-${zoom}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  await page.close();
}
await browser.close();
console.log(shots.join('\n'));
