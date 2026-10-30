// §100 (2e) Radar performance in the real app at phone speed (CPU ×N):
// dashboard load, the radar's long tasks, the small loop's CPU (running vs paused),
// the full radar's open and switch times, memory and workers after repeated use.
//   node tools/harness/perf-radar.mjs [throttle=4]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const throttle = +(process.argv[2] || 4);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 932 }, deviceScaleFactor: 3, serviceWorkers: 'block' });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true });
});
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'south', gameMode: 'live' });
});
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === name).value;
const t0 = await page.evaluate(() => performance.now());
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForSelector('#dash-radar-slot .radar-card', { state: 'attached', timeout: 60000 });
const dashMs = Math.round(await page.evaluate(() => performance.now()) - t0);
const tFirst = Date.now();
await page.waitForFunction(() => document.querySelector('.radar-card')?.radarCard?.state.loaded > 0, null, { timeout: 60000 });
const firstFrameMs = Date.now() - tFirst + dashMs;
await page.waitForFunction(() => { const s = document.querySelector('.radar-card').radarCard.state; return s.loaded === s.frames; }, null, { timeout: 120000 });
const loopMs = Date.now() - tFirst + dashMs;
const longs = await page.evaluate((t0) => window.__long.filter(l => l.t >= t0), t0);
// Steady state: CPU over 10 s while the small loop runs, then paused.
const cpu = async (ms) => { const a = await metric('TaskDuration'); await page.waitForTimeout(ms); return (await metric('TaskDuration') - a) / (ms / 1000); };
const running = await cpu(10000);
const d0 = await page.evaluate(() => document.querySelector('.radar-card').radarCard.state.draws);
await page.evaluate(() => document.querySelector('.radar-card').radarCard.pause());
const paused = await cpu(10000);
const d1 = await page.evaluate(() => document.querySelector('.radar-card').radarCard.state.draws);
await page.waitForTimeout(1000);
const d2 = await page.evaluate(() => document.querySelector('.radar-card').radarCard.state.draws);
await page.evaluate(() => document.querySelector('.radar-card').radarCard.resume());
// Hidden app: the loop stops.
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(1500);
const h0 = await page.evaluate(() => document.querySelector('.radar-card').radarCard.state.draws);
await page.waitForTimeout(3000);
const h1 = await page.evaluate(() => document.querySelector('.radar-card').radarCard.state.draws);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
// The full radar: open, every loop and zoom, close — ten times.
const workers = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(t => t.type === 'worker').length;
const heap = async () => { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); return Math.round((await metric('JSHeapUsedSize')) / 1e6); };
const heapStart = await heap(), workersStart = await workers();
const opens = [], switches = [];
const waitSheet = async () => { const t = Date.now(); await page.waitForFunction(() => !document.querySelector('.rs-status')?.textContent, null, { timeout: 120000 }); return Date.now() - t; };
for (let k = 0; k < 10; k++) {
  const t = Date.now();
  await page.click('.radar-card');
  await page.waitForSelector('#radar-sheet.open');
  opens.push(Date.now() - t + await waitSheet());
  if (k < 2) for (const loop of ['next6h', 'next24h', 'past2h']) for (const z of [0, 2, 1]) {
    const t2 = Date.now();
    await page.click(`[data-loop="${loop}"]`); await page.click(`[data-zoom="${z}"]`);
    switches.push(Date.now() - t2 + await waitSheet());
  }
  await page.click('.rs-done'); await page.waitForTimeout(300);
}
const heapEnd = await heap(), workersEnd = await workers();
const pct = (a) => { const s = [...a].sort((x, y) => x - y); return `median ${s[Math.floor(s.length / 2)]} ms, worst ${s.at(-1)} ms`; };
console.log(`CPU ×${throttle}`);
console.log(`  dashboard with radar ready: ${dashMs} ms; first radar frame ${firstFrameMs} ms; whole loop ${loopMs} ms`);
console.log(`  long tasks during load: ${longs.length}, longest ${Math.max(0, ...longs.map(l => l.d))} ms, total ${longs.reduce((a, l) => a + l.d, 0)} ms`);
console.log(`  small loop CPU: running ${(100 * running).toFixed(1)}% of a core, paused ${(100 * paused).toFixed(1)}%; draws while paused ${d2 - d1}; while hidden ${h1 - h0}`);
console.log(`  full radar: open → loop ready ${pct(opens)}; loop/zoom switch → ready ${pct(switches)}`);
console.log(`  after 10 opens: heap ${heapStart} → ${heapEnd} MB; workers ${workersStart} → ${workersEnd}`);
console.log(`  page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await browser.close();
