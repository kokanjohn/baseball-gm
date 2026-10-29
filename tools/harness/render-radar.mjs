// §100 Renders radar frames (precipitation over the base map) to a PNG for review.
//   node tools/harness/render-radar.mjs out.png "region=south&seed=wx-a&frames=115:12,115:15&zoom=0"
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out, query] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1140, height: 800 } });
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`http://localhost:8765/baseball-gm/tools/harness/radar-preview.html?${query}`);
await page.waitForSelector('body[data-done]', { timeout: 120000 });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('wrote', out);
