// r253 §122.132 The player card: a status line (red; amber when playing through it) and the History behind a button.
//   node tools/harness/test-player-history-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
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
const now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
const who = await page.evaluate(async ({ theme, now }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js'); const DE = await import('/baseball-gm/engine/DevelopmentEngine.js'); const PW = await import('/baseball-gm/engine/PlayerWork.js');
  const id = SM.get().userTeam.lineupSlots[2].playerId;
  SM.mutate(s => {
    s.settings.theme = theme;
    DE.setUnavailable(s, id, { reason: 'rest', games: 1 }, now - 5 * 86_400_000);
    s.players[id].unavailable = null;
    PW.startWork(s, { playerId: id, skill: 'speed', owner: 'hittingCoach', days: 2, gain: 3, source: 'test' }, now - 3600_000);
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return { id, name: SM.get().players[id].name };
}, { theme, now });
await page.waitForTimeout(800);
await page.tap('.nav-item[data-tab="roster"]'); await page.waitForTimeout(500);
await page.evaluate(async (id) => { const PC = await import("/baseball-gm/ui/components/PlayerCard.js"); const SM = await import("/baseball-gm/store/StateManager.js"); PC.openPlayerCard(id, SM.get()); }, who.id);
await page.waitForTimeout(600);
const card = await page.evaluate(() => ({ status: document.querySelector('.pc-status')?.textContent || '', cls: document.querySelector('.pc-status')?.className || '',
  btn: document.getElementById('pc-hist-btn')?.textContent || '', hidden: document.getElementById('pc-hist-list')?.hidden }));
check(`the status line: “${card.status}”`, /^Away training\. Back /.test(card.status) && /pc-status-bad/.test(card.cls));
check(`the History behind a button (“${card.btn}”), shut`, /^Show history \(2\)$/.test(card.btn) && card.hidden === true);
await page.evaluate(() => document.getElementById('pc-hist-btn').scrollIntoView({ block: 'center' }));
await page.tap('#pc-hist-btn'); await page.waitForTimeout(300);
const rows = await page.evaluate(() => [...document.querySelectorAll('.pc-hist-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
check(`tapped: newest first (${rows.join(' | ')})`, rows.length === 2 && /^Today Training: speed with the hitting coach \(2 days away\)$/.test(rows[0]) && /^5 days ago Rested \(1 game\)$/.test(rows[1]));
check('…and the button says Hide', /^Hide history/.test(await page.evaluate(() => document.getElementById('pc-hist-btn').textContent)));
await page.screenshot({ path: `${out}/player-history-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
