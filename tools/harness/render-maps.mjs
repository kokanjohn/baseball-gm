// §100 Renders the regional base maps (all zoom levels) to PNGs for review.
// Needs a static server with the repo at /baseball-gm/ (see harness notes):
//   node tools/harness/render-maps.mjs [outDir] [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
// Playwright is installed globally; ES modules ignore NODE_PATH.
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const out = process.argv[2] || '.', theme = process.argv[3] || 'dark';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1140, height: 1600 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('page error:', e.message));
for (const r of ['north', 'south', 'east', 'west']) {
  await page.goto(`http://localhost:8765/baseball-gm/tools/harness/map-preview.html?regions=${r}&theme=${theme}`);
  await page.waitForSelector('body[data-done]');
  await page.screenshot({ path: `${out}/map-${r}-${theme}.png`, fullPage: true });
  console.log('wrote', `${out}/map-${r}-${theme}.png`);
}
await browser.close();
