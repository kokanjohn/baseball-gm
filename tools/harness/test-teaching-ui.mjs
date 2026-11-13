// r166 §122.35 Compose → Bench Coach → "Teach a player a position" → a hitter → a position (each with
// where it stands: "new", "practiced", "3/10") → Send; the coach's reply arrives as a decision.
//   node tools/harness/test-teaching-ui.mjs outDir [theme]
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
let now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const who = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const id = SM.get().userTeam.lineupSlots.find(s => s.slot === 'SS').playerId;
  SM.mutate(s => { s.settings.theme = theme; const p = s.players[id]; p.positions.elig = ['SS']; p.positions.primary = 'SS'; p.pos = p.nativePos = 'SS'; p.positions.fam = { '2B': 0.2 }; });
  return { id, name: SM.get().players[id].name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="decisions"]');
await tap('#itab-compose');
await tap('[data-channel="bench_coach"]');
check('Bench Coach: "Teach a player a position" is a topic', !!(await page.$('[data-topic="bc_teach"]')));
await tap('[data-topic="bc_teach"]');
await page.selectOption('#compose-player', who.id);
await page.waitForTimeout(400);
const picks = await page.$$eval('.compose-skill', els => els.map(e => `${e.querySelector('.cs-name')?.textContent.trim()} ${e.querySelector('.cs-val')?.textContent.trim()}`));
check(`a shortstop picked: the positions to teach, each with where it stands (${picks.join(' · ')})`, picks.length === 5 && !picks.some(x => /^SS /.test(x)) && picks.includes('2B practiced') && picks.includes('3B new'));
check('…Send waits for a position', await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled));
await tap('.compose-skill[data-skill="3B"]');
await page.screenshot({ path: `${out}/teach-compose-${theme}.png` });
await tap('#compose-send-btn');
const sent = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return (SM.get().scheduledCards || []).find(c => c._composeTopic === 'bc_teach'); });
check(`sent: "${sent?._composeLabel}"`, !!sent && sent._composeArg?.skill === '3B' && sent._composeArg?.playerId === who.id);
now = sent.deliverAtMs + 60_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
await tap('.nav-item[data-tab="dashboard"]');
await tap('.nav-item[data-tab="decisions"]');
const id = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c._composeTopic === 'bc_teach')?.instanceId; });
await tap(`[data-open="${id}"]`);
await page.waitForTimeout(2600);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`the reply: the coach's read, ${read.btn.join(' / ')}`, /extra reps at third/.test(read.body) && read.btn.includes('Start Teaching') && read.btn.includes('Not Now'));
await page.screenshot({ path: `${out}/teach-reply-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
