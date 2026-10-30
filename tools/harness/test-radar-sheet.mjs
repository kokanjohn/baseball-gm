// §100 (2c) The full-screen radar in Chromium at a phone's size: loads, plays, switches loops / zooms / parks,
// pauses and scrubs, closes cleanly. Screenshots to the given folder.
//   node tools/harness/test-radar-sheet.mjs outDir [throttle]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', throttle = '1'] = process.argv.slice(2);
const browser = await chromium.launch();
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
if (+throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +throttle }); }
const st = () => page.evaluate(() => window.sheet.state);
const waitLoaded = async (ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await st(); if (s.loaded === s.frames) return Date.now() - t0; await page.waitForTimeout(100); } return -1; };
await page.goto('http://localhost:8765/baseball-gm/tools/harness/radar-sheet-test.html?region=north&day=101&hour=23&loop=past2h&zoom=1');
await page.waitForFunction(() => window.sheet && window.sheet.state.frames > 0);
let t = await waitLoaded();
let s = await st();
check(`past 2 hrs loads all ${s.frames} frames through the worker (${t} ms)`, t >= 0 && s.usesWorker);
const i0 = s.index; await page.waitForTimeout(2400); s = await st();   // (it holds on Now 1.6 s before starting over)
check(`it plays (frame ${i0} → ${s.index})`, s.playing && s.index !== i0);
await page.screenshot({ path: `${out}/sheet-past-metro.png` });
await page.click('[data-loop="next6h"]'); t = await waitLoaded(); s = await st();
check(`next 6 hrs: ${s.frames} frames load (${t} ms)`, t >= 0 && s.loop === 'next6h' && s.frames === 25);
await page.click('.rs-play'); s = await st();
check('Pause stops the loop', !s.playing && (await page.textContent('.rs-play')) === 'Play');
await page.$eval('.rs-scrub', (el) => { el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); });
s = await st();
const tag = await page.textContent('.rs-tag');
check(`scrubbing shows frame 12, a FORECAST (${tag}, ${await page.textContent('.rs-time')})`, s.index === 12 && tag === 'FORECAST');
await page.screenshot({ path: `${out}/sheet-next6-metro-forecast.png` });
await page.click('[data-zoom="0"]'); t = await waitLoaded(); s = await st();
check(`zooming out keeps the time shown (frame ${s.index}) and loads (${t} ms)`, s.zoomIdx === 0 && s.index === 12 && t >= 0);
await page.screenshot({ path: `${out}/sheet-next6-region.png` });
await page.selectOption('.rs-park', 'FBG'); t = await waitLoaded(); s = await st();
check(`centring on another park (${s.focusId}) loads (${t} ms)`, s.focusId === 'FBG' && t >= 0);
await page.click('[data-loop="next24h"]'); await page.click('[data-zoom="2"]'); t = await waitLoaded(); s = await st();
check(`next 24 hrs at Ballpark loads (${t} ms)`, s.loop === 'next24h' && s.zoomIdx === 2 && t >= 0);
await page.screenshot({ path: `${out}/sheet-next24-ballpark.png` });
await page.click('.rs-done'); await page.waitForTimeout(400);
check('Done closes it and removes it', (await page.$('#radar-sheet')) === null);
check('no page errors', errors.length === 0, errors.join(' | '));
// Light theme, snow.
const p2 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
await p2.goto('http://localhost:8765/baseball-gm/tools/harness/radar-sheet-test.html?theme=light&region=north&day=14&hour=6&loop=past2h&zoom=1');
await p2.waitForFunction(() => window.sheet && window.sheet.state.loaded === window.sheet.state.frames, null, { timeout: 60000 });
await p2.click('.rs-play');
await p2.screenshot({ path: `${out}/sheet-light-snow.png` });
await browser.close();
process.exit(ok ? 0 : 1);
