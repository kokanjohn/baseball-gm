// r257 §122.136 The dashboard's banner names the game being played or next up, and in spring the cards count spring games.
//   node tools/harness/test-spring-banner-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(900);
const read = () => page.evaluate(() => ({
  game: document.querySelector('.week-text')?.textContent.trim(), sub: document.querySelector('.week-sub')?.textContent.trim(),
  wl: document.querySelector('#dash-wins-card .stat-label')?.textContent.trim(), w: document.querySelector('#dash-wins-card .stat-value')?.textContent.trim(),
  ll: document.querySelector('#dash-losses-card .stat-label')?.textContent.trim(), l: document.querySelector('#dash-losses-card .stat-value')?.textContent.trim(),
  hdr: document.getElementById('head-season')?.textContent.trim() || '' }));
const a = await read();
check(`before the first spring game: “${a.game}” / “${a.sub}”`, a.game === 'SPRING GAME 1' && a.sub === '1 of 10');
check(`the cards count the spring (“${a.wl} ${a.w}”, “${a.ll} ${a.l}”)`, a.wl === 'Wins' && a.w === '0' && a.ll === 'Losses' && a.l === '0');

// The first game played and won (as the final's commit leaves it).
await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { const g = s.schedule[0]; g._committed = true; g.played = true; g.status = 'final'; g.result = 'win'; g.score = { us: 5, them: 2 }; s.userTeam.springWins = 1; s.currentGameIndex = 1; });
  (await import('/baseball-gm/ui/App.js')).updateHeader(SM.get());
});
await page.tap('.nav-item[data-tab="schedule"]'); await page.waitForTimeout(300);
await page.tap('.nav-item[data-tab="dashboard"]'); await page.waitForTimeout(500);
const b = await read();
check(`after game 1, won: “${b.game}” / “${b.sub}”`, b.game === 'SPRING GAME 2' && b.sub === '2 of 10 · 1–0');
check(`Wins 1 in spring (“${b.wl} ${b.w}”), the header's game “${b.hdr}”`, b.wl === 'Wins' && b.w === '1' && / · G2$/.test(b.hdr));
await page.screenshot({ path: `${out}/spring-banner-${theme}.png`, clip: { x: 0, y: 0, width: 390, height: 330 } });
await page.tap('#dash-wins-card'); await page.waitForTimeout(400);
const title = await page.evaluate(() => document.querySelector('#dash-game-log-overlay')?.innerText.split('\n')[0] || '');
check(`the wins list is the spring's (“${title}”)`, /Spring Wins \(1\)/.test(title));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
