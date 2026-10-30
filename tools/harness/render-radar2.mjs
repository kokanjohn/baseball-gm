// §100 (2b) Screenshots of the radar renderer (radar-render-preview.html).
//   node tools/harness/render-radar2.mjs out.png "query"
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out, query, throttle] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1250, height: 700 }, deviceScaleFactor: 2 });
if (throttle) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +throttle }); }
page.on('pageerror', e => console.error('page error:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.goto(`http://localhost:8765/baseball-gm/tools/harness/radar-render-preview.html?${query}`);
await page.waitForSelector('body[data-done]', { state: 'attached', timeout: 120000 });
await page.screenshot({ path: out, fullPage: true });
console.log((await page.$$eval('.ms', els => els.map(e => e.textContent))).join('\n'));
await browser.close();
