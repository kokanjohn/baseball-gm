// r164 §122.35 Positions on screen: a Team row working toward a new position ("3B 6/10"), and the
// player card's Positions section — each eligible position with its starts (and what keeping it
// takes), each one in progress (practiced or not, starts of the ten).
//   node tools/harness/test-positions-ui.mjs outDir [theme]
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
await page.clock.setFixedTime(Date.now());
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const S = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const Pos = await import('/baseball-gm/engine/Positions.js');
  const u = SM.get().userTeam;
  const id = u.lineupSlots.find(s => s.slot === '1B').playerId;
  const util = u.rosterIds.find(i => i !== id && Pos.eligibleAt(SM.get().players[i]).length >= 2);
  SM.mutate(s => {
    s.settings.theme = theme;
    s.phase = 'REGULAR_SEASON';
    const p = s.players[id];
    p.positions.primary = '1B'; p.positions.elig = ['1B']; p.pos = p.nativePos = '1B';   // (a first baseman only)
    p.positions.starts = { '1B': 40, '3B': 6 };
    p.positions.fam = { '3B': 0.24 };
    const q = s.players[util];
    q.positions.starts = { [q.positions.elig[0]]: 60, [q.positions.elig[1]]: 3 };
  });
  return { id, name: SM.get().players[id].name, util, uName: SM.get().players[util].name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="roster"]');
const row = await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"] .tr-learn`)?.textContent.trim() || '', S.id);
check(`Team: ${S.name}'s row shows the new position in progress ("${row}")`, row === '3B 6/10');
await page.screenshot({ path: `${out}/positions-team-${theme}.png` });

await tap(`.tr-row[data-player="${S.id}"] .tr-name`);
const card = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('#player-card-sheet .pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Positions');
  return sec ? [...sec.querySelectorAll('.pc-pos-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) : null;
});
check(`the card's Positions: ${card?.join(' | ')}`, !!card && /^1B primary 40 starts$/.test(card[0]) && card.some(r => /^3B practiced 6 of 10 starts$/.test(r)));
await page.screenshot({ path: `${out}/positions-card-${theme}.png` });
await tap('#player-card-close');

await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"]`)?.scrollIntoView({ block: 'center' }), S.util);
await tap(`.tr-row[data-player="${S.util}"] .tr-name`);
const card2 = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('#player-card-sheet .pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Positions');
  return sec ? [...sec.querySelectorAll('.pc-pos-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) : null;
});
check(`a utility player at risk: ${card2?.join(' | ')}`, !!card2 && card2.some(r => /needs \d+ more starts? to keep it 3 starts$/.test(r)));
await page.screenshot({ path: `${out}/positions-risk-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
