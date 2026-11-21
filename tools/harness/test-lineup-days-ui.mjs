// r242 §122.121 The day strip on the Team screen: the next game and the games set ahead, each its lineup.
//   node tools/harness/test-lineup-days-ui.mjs outDir [theme]
// Choosing tomorrow shows the lineup carried to it; MOVE there sets tomorrow on its own (the next game's lineup
// is untouched), the chip gets its mark, the note says so, and "Same as the day before" puts it back.
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
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
await page.clock.setFixedTime(Date.now());
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
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(450); };
const lineup = () => page.evaluate(() => [...document.querySelectorAll('.tr-row')].slice(0, 9).map(r => r.querySelector('.tr-name-line')?.textContent.trim()));
const eng = () => page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const R = await import('/baseball-gm/engine/RosterEngine.js');
  const st = SM.get(); const gs = R.lineupGames(st);
  return { next: st.userTeam.lineupSlots.map(s => s.playerId), g2: gs[1] && R.lineupFor(st, gs[1]).map(s => s.playerId), own2: gs[1] && R.hasOwnLineup(st, gs[1]), n: gs.length };
});

await tap('.nav-item[data-tab="roster"]');
const chips = await page.evaluate(() => [...document.querySelectorAll('.ds-chip')].map(c => c.innerText.replace(/\s+/g, ' ').trim()));
check(`the day strip: ${chips.join(' | ')}`, chips.length >= 2 && /SP /.test(chips[0]));
check('the next game is chosen', await page.evaluate(() => document.querySelector('.ds-chip')?.classList.contains('on')));
const today = await lineup();
await page.screenshot({ path: `${out}/lineup-days-next-${theme}.png` });

// Tomorrow: carried from the next game
await tap('.ds-chip:nth-child(2)');
check('tomorrow chosen', await page.evaluate(() => document.querySelectorAll('.ds-chip')[1]?.classList.contains('on')));
check(`tomorrow takes the lineup before it (${(await lineup()).join(', ')})`, JSON.stringify(await lineup()) === JSON.stringify(today));
check(`the note: “${await page.evaluate(() => document.querySelector('.ds-note span')?.textContent)}”`, await page.evaluate(() => /Takes the lineup of the game before it/.test(document.querySelector('.ds-note')?.textContent || '')));

// MOVE the DH to the bench for tomorrow only
const dhRow = await page.evaluate(() => [...document.querySelectorAll('.tr-row[data-player]')].slice(0, 9).find(r => r.querySelector('.tr-slot')?.textContent.trim().startsWith('DH'))?.dataset.player);
await tap(`.tr-move[data-move="${dhRow}"]`);
const sub = await page.evaluate(() => document.querySelector('#ts-swap-modal .modal-header')?.innerText || '');
check(`the Move sheet names the day (“${sub.replace(/\s+/g, ' ')}”)`, /Tomorrow's game|'s game/.test(sub));
const benchKey = await page.evaluate(() => [...document.querySelectorAll('.sm-row[data-key]')].find(r => r.dataset.key.startsWith('in:'))?.dataset.key);
await tap(`.sm-row[data-key="${benchKey}"]`);
let e = await eng();
check('tomorrow is set on its own, the DH changed', e.own2 && e.g2[8] !== e.next[8]);
check('the next game\'s lineup is untouched', JSON.stringify(e.next) === JSON.stringify(await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().userTeam.lineupSlots.map(s => s.playerId))) && e.next[8] === (await page.evaluate(async (id) => id, dhRow)));
check('the chip has its mark', await page.evaluate(() => !!document.querySelectorAll('.ds-chip')[1]?.querySelector('.ds-own')));
check('the note: set for this game', await page.evaluate(() => /Set for this game/.test(document.querySelector('.ds-note')?.textContent || '')));
await page.screenshot({ path: `${out}/lineup-days-tomorrow-${theme}.png` });

// Back to the next game: unchanged
await tap('.ds-chip:nth-child(1)');
check('the next game still shows its lineup', JSON.stringify(await lineup()) === JSON.stringify(today));

// "Same as the day before"
await tap('.ds-chip:nth-child(2)');
await tap('#ds-same');
e = await eng();
check('"Same as the day before" puts it back', !e.own2 && JSON.stringify(e.g2) === JSON.stringify(e.next));
check('…the mark is gone', await page.evaluate(() => !document.querySelectorAll('.ds-chip')[1]?.querySelector('.ds-own')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
