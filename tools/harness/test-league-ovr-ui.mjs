// r173 League → Players: OVR (it said RTG) sits right of the name in the frozen column, large and
// colored like the Team screen's; tapping it sorts by it; the stat columns no longer end with it.
//   node tools/harness/test-league-ovr-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);
await page.tap('.nav-item[data-tab="league"]'); await page.waitForTimeout(400);
const tab = await page.$('#ltab-players'); if (tab) { await tab.tap(); await page.waitForTimeout(500); }
const geo = await page.evaluate(() => {
  const head = [...document.querySelectorAll('.lp-header > .lp-th')].map(h => h.textContent.trim());
  const row = document.querySelector('.lp-row'), name = row.querySelector('.lp-name-block'), ovr = row.querySelector('.lp-td-name .lp-ovr');
  const sticky = getComputedStyle(row.querySelector('.lp-td-name')).position;
  return { head, ovrHead: document.querySelector('.lp-col-sticky .lp-th-ovr')?.textContent, ovr: ovr?.textContent.trim(),
           right: ovr && name.getBoundingClientRect().right <= ovr.getBoundingClientRect().left + 1,
           size: ovr ? parseFloat(getComputedStyle(ovr.querySelector('.rating-num')).fontSize) : 0, sticky,
           rtg: document.body.innerText.includes('RTG') };
});
check(`the stat columns: ${geo.head.join(', ')} (no RTG, no OVR at the end)`, !geo.rtg && !geo.head.includes('RTG') && !geo.head.includes('OVR'));
check(`OVR right of the name, in the frozen column, large (${geo.ovrHead}: ${geo.ovr}, ${geo.size}px, ${geo.sticky})`, geo.ovrHead === 'OVR' && geo.right && geo.size >= 18 && geo.sticky === 'sticky' && /^\d+$/.test(geo.ovr));
const sorted = async () => page.$$eval('.lp-row .lp-ovr', els => els.slice(0, 30).map(e => +e.textContent));
await page.click('.lp-th-ovr'); await page.waitForTimeout(300);
const a = await sorted();
await page.click('.lp-th-ovr'); await page.waitForTimeout(300);
const b = await sorted();
const mono = (xs, f) => xs.every((x, i) => !i || f(xs[i - 1], x));
check(`tapping OVR sorts by it (${a.slice(0, 5).join(', ')}…), and again flips it (${b.slice(0, 5).join(', ')}…)`,
      (mono(a, (x, y) => x >= y) && mono(b, (x, y) => x <= y)) || (mono(a, (x, y) => x <= y) && mono(b, (x, y) => x >= y)));
const sc = await page.$('.lp-scroll-wrap'); await sc.evaluate(e => { e.scrollLeft = 0; });
await page.screenshot({ path: `${out}/league-ovr-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
