// r159 §122.31 In the app: Compose → Hitting Coach → "Work with a hitter on…" → pick the hitter →
// pick the skill (the rating under each) → Send; the coach's reply arrives with the call and a decision.
// The Team Physician is on the list. And a player away for days shows "training, N days" on Team.
//   node tools/harness/test-player-work-ui.mjs outDir [theme]
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
// r251 §122.130 all the development work is the Bench Coach's
await tap('[data-channel="hitting_coach"]');
check('Hitting Coach: no "Work with a hitter on…" (the Bench Coach has it)', !(await page.$('[data-topic="hc_work"]')));
await tap('#compose-back');
await tap('[data-channel="scouting"]');
check('Scouting: no development program (the Bench Coach has it)', !(await page.$('[data-topic="sc_program"]')));
await tap('#compose-back');
await tap('[data-channel="bench_coach"]');
const bcTopics = await page.$$eval('.compose-topic-btn[data-topic]', els => els.map(e => e.dataset.topic));
check(`Bench Coach: the running game and all the development work (${bcTopics.join(', ')})`, ['bc_tactics', 'bc_work', 'bc_who', 'sc_program', 'bc_teach'].every(t => bcTopics.includes(t)) && !bcTopics.includes('bc_defense'));
await tap('[data-topic="bc_work"]');
check('"Work with a player on…" asks which player (hitters and pitchers)', await page.evaluate(() => { const s = document.getElementById('compose-player'); return !!s && [...s.querySelectorAll('optgroup')].map(g => g.label).join() === 'Hitters,Pitchers'; }));
check('…and Send waits for a player', await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled && /Pick a player/.test(document.getElementById('compose-send-btn').textContent)));
await page.selectOption('#compose-player', who.id);
await page.waitForTimeout(400);
const skills = await page.$$eval('.compose-skill', els => els.map(e => `${e.querySelector('.cs-name')?.textContent.trim()} ${e.querySelector('.cs-val')?.textContent.trim()}`));
check(`a hitter picked: contact, power, speed and defense, each with its rating (${skills.join(' · ')})`, skills.length === 4 && /Contact 44/.test(skills[0]) && /^Defense \d/.test(skills[3]) && skills.every(x => /\d/.test(x)));
check('…and Send waits for a skill', await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled && /Pick a skill/.test(document.getElementById('compose-send-btn').textContent)));
await tap('.compose-skill[data-skill="contact"]');
await page.screenshot({ path: `${out}/work-compose-${theme}.png` });
check('a skill picked: Send is ready', await page.evaluate(() => !document.getElementById('compose-send-btn')?.disabled));
await page.waitForTimeout(500);
{ // r197 right under the last step (the skills), on screen above the tab bar
  const at = await page.evaluate(() => { const b = document.getElementById('compose-send-btn'), r = b.getBoundingClientRect(), nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
    return { after: b.previousElementSibling?.className, inView: r.top >= 0 && r.bottom <= (nav?.top ?? window.innerHeight) }; });
  check(`…right under the skills, on screen (${at.after})`, /compose-skills/.test(at.after || '') && at.inView, JSON.stringify(at));
}
await tap('#compose-send-btn');
const sent = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return (SM.get().scheduledCards || []).find(c => c._composeTopic === 'bc_work'); });
check(`sent: the message waits for the coach's reply ("${sent?._composeLabel}")`, !!sent && sent._composeArg?.skill === 'contact' && sent._composeArg?.playerId === who.id);

// ── The reply ──
now = sent.deliverAtMs + 60_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
await tap('.nav-item[data-tab="dashboard"]');
await tap('.nav-item[data-tab="decisions"]');
const reply = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c._composeTopic === 'bc_work')?.instanceId; });
await tap(`[data-open="${reply}"]`);
await page.waitForTimeout(400);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', yes: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check('the reply (the Bench Coach, the hitting coach named): days away, the cost, and the games those days cover', /contact is 44/.test(read.body) && /days away/.test(read.body) && /\$\d+K/.test(read.body) && /If we start today/.test(read.body) && !/with me at the complex/.test(read.body), read.body.slice(0, 200));
check(`…a decision: ${read.yes.join(' / ')}`, read.yes.some(t => /Start the Work Now/.test(t)) && read.yes.some(t => /Not Now/.test(t)));
await page.waitForTimeout(2600);   // (the "message sent" toast clears)
await page.screenshot({ path: `${out}/work-reply-${theme}.png` });
await tap(`[data-resolve="${reply}"][data-choice="yes"]`);
await page.waitForTimeout(600);
const after = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().players[id].unavailable; }, who.id);
check(`yes: ${who.name} is away for development work`, after?.reason === 'training' && after.untilMs > now);

// ── Team: away for days ──
await tap('.nav-item[data-tab="roster"]');
// r252 §122.131 a red mark with the days ("3 days"); tapping it says what it is
const status = await page.evaluate((id) => { const b = document.querySelector(`.tr-row[data-player="${id}"] .tr-stat`); return { short: b?.textContent.trim() || '', full: b?.dataset.stat || '' }; }, who.id);
check(`Team marks the absence in days ("${status.short}": “${status.full}”)`, /^\d+ days?$/.test(status.short) && /Away training\. Back /.test(status.full));
await tap(`.tr-row[data-player="${who.id}"] .tr-stat`);
const toast = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
check('…tapped: it says so, and the player card stays closed', /Away training/.test(toast) && !(await page.evaluate(() => !!document.querySelector('#player-card-overlay.open'))));

// ── r251 "Who should we work on…?": a skill, how to rank, where ──
await tap('.nav-item[data-tab="decisions"]');
await tap('#itab-compose');
await tap('[data-channel="bench_coach"]');
await tap('[data-topic="bc_who"]');
const grid = await page.$$eval('.compose-skill[data-skill]', els => els.map(e => e.dataset.skill));
check(`"Who should we work on…?": the seven skills (${grid.join(', ')})`, grid.join() === 'contact,power,speed,defense,stuff,control,stamina');
await tap('.compose-skill[data-skill="stuff"]');   // (the hitting coach is busy with the work just started: the pitching coach is free)
await tap('.compose-skill[data-rank="help"]');
check('…then where: with the coach or at the complex', await page.evaluate(() => document.querySelectorAll('.compose-skill[data-where]').length === 2 && document.getElementById('compose-send-btn').disabled));
await tap('.compose-skill[data-where="coach"]');
await page.screenshot({ path: `${out}/who-compose-${theme}.png` });
await tap('#compose-send-btn');
const whoSent = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return (SM.get().scheduledCards || []).find(c => c._composeTopic === 'bc_who'); });
check(`sent: "${whoSent?._composeLabel}"`, whoSent?._composeArg?.skill === 'stuff' && whoSent._composeArg.rank === 'help' && whoSent._composeArg.where === 'coach');
now = whoSent.deliverAtMs + 60_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
await tap('.nav-item[data-tab="dashboard"]');
await tap('.nav-item[data-tab="decisions"]');
const whoReply = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c._composeTopic === 'bc_who')?.instanceId; });
await tap(`[data-open="${whoReply}"]`);
await page.waitForTimeout(400);
const wr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', picks: [...document.querySelectorAll('[data-resolve]')].map(b => b.innerText.replace(/\s+/g, ' ').trim()) }));
check(`the reply: three names, best first, a button each (${wr.picks.join(' / ')})`, (wr.body.match(/^\d\. /gm) || []).length === 3 && wr.picks.filter(t => /^Work with /.test(t)).length === 3 && wr.picks.some(t => /Not Now/.test(t)), wr.body.slice(0, 200));
await page.waitForTimeout(2600);
await page.screenshot({ path: `${out}/who-reply-${theme}.png` });
// r251 asking about a skill whose coach is busy: the list, and who they're with (no buttons)
{ const busy = await page.evaluate(async () => { const R = await import('/baseball-gm/engine/ComposeReplies.js'); const SM = await import('/baseball-gm/store/StateManager.js');
    const r = R.writeComposeReply(SM.get(), { topicId: 'bc_who', channelId: 'bench_coach', atMs: Date.now(), arg: { skill: 'power', rank: 'help', where: 'coach' } });
    return { body: String(r?.body || ''), decision: !!r?.decision }; });
  check('power while the hitting coach is busy: the list, who they\'re with, no buttons', /has \w+ right now/.test(busy.body) && (busy.body.match(/^\d\. /gm) || []).length === 3 && !busy.decision, busy.body.slice(-160)); }

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
