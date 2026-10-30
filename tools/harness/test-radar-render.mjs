// §100 (2b) Radar renderer checks in Chromium: the radar over each park agrees with its report.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('http://localhost:8765/baseball-gm/tools/harness/radar-consistency-test.html');
await page.waitForSelector('body[data-result]', { state: 'attached', timeout: 600000 });
const r = JSON.parse(await page.getAttribute('body', 'data-result'));
const ok = r.badCount === 0 && r.wet > 10;
console.log(`${ok ? 'PASS' : 'FAIL'}  the radar's colour over every park agrees with its report (${r.checked} park views, ${r.wet} wet)${r.badCount ? ' — ' + r.bad.join(' | ') : ''}`);
await browser.close();
process.exit(ok ? 0 : 1);
