// r159 §122.31 In the app: Compose → Hitting Coach → "Work with a hitter on…" → pick the hitter →
// pick the skill (the rating under each) → Send; the coach's reply arrives with the call and a decision.
// The Team Physician is on the list. And a player away for days shows "training, N days" on Team.
//   node tools/harness/test-player-work-ui.mjs outDir [theme]
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
  // A regular with a weak contact tool: the coach's call is focused work.
  const id = SM.get().userTeam.lineupSlots.map(x => x.playerId).find(i => !['SP', 'RP'].includes(SM.get().players[i]?.pos));
  SM.mutate(s => { s.settings.theme = theme; s.players[id].subRatings.contact = 44; });
  return { id, name: SM.get().players[id].name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

// ── Compose: the hitting coach, a hitter, a skill ──
await tap('.nav-item[data-tab="decisions"]');
await tap('#itab-compose');
check('the Team Physician is on the list', await page.evaluate(() => [...document.querySelectorAll('.compose-person')].some(b => /Team Physician/.test(b.textContent))));
await tap('[data-channel="hitting_coach"]');
check('Hitting Coach: "Work with a hitter on…" is a topic', !!(await page.$('[data-topic="hc_work"]')));
await tap('[data-topic="hc_work"]');
check('picking it asks which player (hitters only)', await page.evaluate(() => { const s = document.getElementById('compose-player'); return !!s && ![...s.querySelectorAll('optgroup')].some(g => g.label === 'Pitchers'); }));
check('…and Send waits for a player', await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled && /Pick a player/.test(document.getElementById('compose-send-btn').textContent)));
await page.selectOption('#compose-player', who.id);
await page.waitForTimeout(400);
const skills = await page.$$eval('.compose-skill', els => els.map(e => `${e.querySelector('.cs-name')?.textContent.trim()} ${e.querySelector('.cs-val')?.textContent.trim()}`));
check(`a player picked: the three skills, each with its rating (${skills.join(' · ')})`, skills.length === 3 && /Contact 44/.test(skills[0]) && skills.every(x => /\d/.test(x)));
check('…and Send waits for a skill', await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled && /Pick a skill/.test(document.getElementById('compose-send-btn').textContent)));
await tap('.compose-skill[data-skill="contact"]');
await page.screenshot({ path: `${out}/work-compose-${theme}.png` });
check('a skill picked: Send is ready', await page.evaluate(() => !document.getElementById('compose-send-btn')?.disabled));
await tap('#compose-send-btn');
const sent = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return (SM.get().scheduledCards || []).find(c => c._composeTopic === 'hc_work'); });
check(`sent: the message waits for the coach's reply ("${sent?._composeLabel}")`, !!sent && sent._composeArg?.skill === 'contact' && sent._composeArg?.playerId === who.id);

// ── The reply ──
now = sent.deliverAtMs + 60_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
await tap('.nav-item[data-tab="dashboard"]');
await tap('.nav-item[data-tab="decisions"]');
const reply = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c._composeTopic === 'hc_work')?.instanceId; });
await tap(`[data-open="${reply}"]`);
await page.waitForTimeout(400);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', yes: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check('the reply: the coach\'s call — days away, the cost, and the games those days cover', /contact is 44/.test(read.body) && /days away/.test(read.body) && /\$\d+K/.test(read.body) && /If we start today/.test(read.body), read.body.slice(0, 200));
check(`…a decision: ${read.yes.join(' / ')}`, read.yes.some(t => /Start the Work Now/.test(t)) && read.yes.some(t => /Not Now/.test(t)));
await page.waitForTimeout(2600);   // (the "message sent" toast clears)
await page.screenshot({ path: `${out}/work-reply-${theme}.png` });
await tap(`[data-resolve="${reply}"][data-choice="yes"]`);
await page.waitForTimeout(600);
const after = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().players[id].unavailable; }, who.id);
check(`yes: ${who.name} is away for development work`, after?.reason === 'training' && after.untilMs > now);

// ── Team: away for days ──
await tap('.nav-item[data-tab="roster"]');
const status = await page.evaluate((name) => [...document.querySelectorAll('#tab-roster *')].map(e => e.textContent).find(t => /training, \d+ days?/.test(t) && t.length < 120) || '', who.name);
check(`Team shows the absence in days ("${status.trim().slice(0, 60)}")`, /training, \d+ days?/.test(status));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
