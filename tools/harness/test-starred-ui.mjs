// r274 §122.153 starred players: the player card's Star toggle; a star beside the name on the League list;
// the "Starred" filter shows only them (hitters and pitchers, ours, other clubs' and free agents alike).
//   node tools/harness/test-starred-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
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
await page.waitForTimeout(800);
const S = (fn) => page.evaluate(async (src) => { const SM = await import('/baseball-gm/store/StateManager.js'); return new Function('s', `return (${src})(s)`)(SM.get()); }, fn.toString());

await page.tap('.nav-item[data-tab="league"]'); await page.waitForTimeout(500);
await page.selectOption('#lp-view-select', 'all'); await page.waitForTimeout(400);
const rows = await page.$$eval('.lp-row[data-player]:not(.user-player-row)', els => els.map(e => e.dataset.player));
const hitterId = rows[3];
// r275 §122.154 one of ours: no Star on the card
const ourId = await page.$eval('.lp-row.user-player-row[data-player]', e => e.dataset.player).catch(() => null);
if (ourId) {
  await page.tap(`.lp-row[data-player="${ourId}"] .lp-name-line`); await page.waitForTimeout(500);
  check('one of ours: no Star on the player card', await page.evaluate(() => !!document.getElementById('player-card-overlay')?.classList.contains('open') && !document.getElementById('pc-star')));
  await page.tap('#player-card-close'); await page.waitForTimeout(400);
} else check('one of ours on the All list', false);
check(`League → All lists players, none starred yet (${rows.length})`, rows.length > 20 && await page.$$eval('.lp-star', e => e.length) === 0);

// star a hitter from his card
await page.tap(`.lp-row[data-player="${hitterId}"] .lp-name-line`); await page.waitForTimeout(500);
let btn = await page.evaluate(() => { const b = document.getElementById('pc-star'); return b && { text: b.textContent.trim(), on: b.classList.contains('on') }; });
check(`the player card has the toggle (“${btn?.text}”)`, btn?.text === '☆ Star' && !btn.on);
await page.tap('#pc-star'); await page.waitForTimeout(300);
btn = await page.evaluate(() => { const b = document.getElementById('pc-star'); return { text: b.textContent.trim(), on: b.classList.contains('on') }; });
check(`tapped: “${btn.text}”, and kept`, btn.text === '★ Starred' && btn.on && await S((s) => !!s.starred) && (await S((s) => Object.keys(s.starred))).includes(hitterId));
await page.screenshot({ path: `${out}/starred-card-${theme}.png` });
await page.tap('#player-card-close'); await page.waitForTimeout(400);
check('the list marks the player with a star (no reload)', await page.evaluate((id) => !!document.querySelector(`.lp-row[data-player="${id}"] .lp-star`), hitterId));

// star a pitcher too (from the Pitchers list)
await page.tap('.lp-pos-btn[data-pos="pitchers"]'); await page.waitForTimeout(400);
const pitcherId = await page.$eval('.lp-row[data-player]:not(.user-player-row)', e => e.dataset.player);
await page.tap(`.lp-row[data-player="${pitcherId}"] .lp-name-line`); await page.waitForTimeout(500);
await page.tap('#pc-star'); await page.waitForTimeout(300);
await page.tap('#player-card-close'); await page.waitForTimeout(400);

// the Starred filter
await page.selectOption('#lp-view-select', 'starred'); await page.waitForTimeout(400);
const pit = await page.$$eval('.lp-row[data-player]', els => els.map(e => e.dataset.player));
check(`Starred, Pitchers: only the starred pitcher (${pit.length})`, pit.length === 1 && pit[0] === pitcherId);
await page.tap('.lp-pos-btn[data-pos="batters"]'); await page.waitForTimeout(400);
const bat = await page.$$eval('.lp-row[data-player]', els => els.map(e => e.dataset.player));
check(`Starred, Batters: only the starred hitter (${bat.length})`, bat.length === 1 && bat[0] === hitterId);
check('…each with its star', await page.$$eval('.lp-row .lp-star', e => e.length) === 1);
await page.screenshot({ path: `${out}/starred-list-${theme}.png` });

// unstar from the Starred list: it leaves the list
await page.tap(`.lp-row[data-player="${hitterId}"] .lp-name-line`); await page.waitForTimeout(500);
await page.tap('#pc-star'); await page.waitForTimeout(300);
check('untapped: “☆ Star” again', await page.evaluate(() => document.getElementById('pc-star').textContent.trim()) === '☆ Star');
await page.tap('#player-card-close'); await page.waitForTimeout(400);
check('…and gone from the Starred list', await page.$$eval('.lp-row[data-player]', e => e.length) === 0
  && /No starred players/.test(await page.evaluate(() => document.getElementById('lp-list')?.textContent || '')));

// kept across a reload
await page.waitForTimeout(2500);   // (the save is debounced)
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(2000);
// r275 §122.154 the Scouting Director on our starred players
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(400);
await page.tap('#itab-compose'); await page.waitForTimeout(300);
await page.tap('[data-channel="scouting"]'); await page.waitForTimeout(300);
const topic = await page.evaluate(() => document.querySelector('[data-topic="sc_starred"]')?.innerText.replace(/\s+/g, ' ').trim() || '');
check(`Scouting Director: “${topic}”`, /Our starred players/.test(topic));
await page.tap('[data-topic="sc_starred"]'); await page.waitForTimeout(300);
await page.tap('#compose-send-btn'); await page.waitForTimeout(500);
const sent = await S((s) => (s.scheduledCards || []).some(c => c._composeTopic === 'sc_starred'));
check('sent: waiting on the director\'s report', sent);
await page.screenshot({ path: `${out}/starred-compose-${theme}.png` });
check('the star is kept after reopening the app', (await S((s) => Object.keys(s.starred || {}))).join() === pitcherId);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
