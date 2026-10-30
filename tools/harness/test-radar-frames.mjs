// §100 (2a) Runs radar-frames-test.html in Chromium (optionally CPU-throttled like a phone).
//   node tools/harness/test-radar-frames.mjs [throttle=4]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const throttle = +(process.argv[2] || 4);
const browser = await chromium.launch();
let ok = true;
for (const [label, query] of [['worker, metro, next 6 hrs', 'zoom=1&loop=next6h'], ['worker, region, past 2 hrs', 'zoom=0&loop=past2h&region=south'],
                              ['no worker (fallback), ballpark, next 24 hrs', 'zoom=2&loop=next24h&worker=0']]) {
  const page = await browser.newPage();
  page.on('pageerror', e => { console.error('page error:', e.message); ok = false; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(`http://localhost:8765/baseball-gm/tools/harness/radar-frames-test.html?${query}`);
  await page.waitForSelector('body[data-result]', { state: 'attached', timeout: 600000 });
  const r = JSON.parse(await page.getAttribute('body', 'data-result'));
  const pass = r.got === r.frames && r.same === 3 && (label.startsWith('no worker') ? !r.worker : r.worker && r.mainThreadLongestStallMs < 150);
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label} (CPU ×${throttle}): ${JSON.stringify(r)}`);
  await page.close();
}
await browser.close();
process.exit(ok ? 0 : 1);
