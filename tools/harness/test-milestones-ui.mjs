// §111 The end-of-season screens in the real app: Champions; Season Over (knocked out, and missed the playoffs).
// Queued as the engine queues them; the app's tick shows them one at a time; Continue dismisses each.
//   node tools/harness/test-milestones-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const screens = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { MILESTONE_SCREENS: M } = await import('/baseball-gm/data/constants.js');
  const list = [
    { ...M.CHAMPIONS, subtitle: `World Series won 4–2 over the Harborview Gulls. ${M.CHAMPIONS.subtitle}` },
    { ...M.SEASON_OVER, subtitle: `Eliminated 1–3 by the Seagrove Osprey in the Division Series. ${M.SEASON_OVER.subtitle}` },
    { ...M.SEASON_OVER, subtitle: `Finished 74–68. Sixth in the division, 3 games out of the last playoff spot. ${M.SEASON_OVER.subtitle}` },
  ];
  SM.mutate(s => { s.settings.theme = theme; s.milestoneQueue = list; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return list.map(m => ({ title: m.title, subtitle: m.subtitle }));
}, theme);
const names = ['champions', 'eliminated', 'missed'];
for (let k = 0; k < screens.length; k++) {
  await page.waitForSelector('#milestone-overlay.active', { timeout: 20000 });
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => ({ title: document.getElementById('milestone-title')?.textContent, subtitle: document.getElementById('milestone-subtitle')?.textContent }));
  check(`${screens[k].title} shows (“${shown.subtitle}”)`, shown.title === screens[k].title && shown.subtitle === screens[k].subtitle, JSON.stringify(shown));
  await page.screenshot({ path: `${out}/milestone-${names[k]}-${theme}.png` });
  await page.click('#milestone-continue');
  await page.waitForTimeout(300);
  check(`…and Continue dismisses it`, !(await page.$('#milestone-overlay.active')) || k < screens.length - 1);
  if (k < screens.length - 1) await page.waitForTimeout(5500);   // (the next one on the app's next tick)
}
check('none left waiting', await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().milestoneQueue.length === 0));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
