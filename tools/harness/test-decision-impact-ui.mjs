// r255 §122.134 A completed message shows what the decision changed, and by how much.
//   node tools/harness/test-decision-impact-ui.mjs outDir [theme]
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
const made = await page.evaluate(async ({ theme, now }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js'); const CE = await import('/baseball-gm/engine/CardEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  // Every first-day message in now; answer one that costs money and moves the team, and one that sits a player.
  SM.mutate(s => { for (const c of s.scheduledCards || []) c.deliverAtMs = now - 60_000; });
  CE.releaseDueCards(now);
  const open = SM.get().inbox.filter(c => !c.resolved && c.noLabel);
  const money = open.find(c => c._budgetCost && c.cardId !== 'fd_trainer_heavy');
  const rest = open.find(c => /^fd_trainer/.test(c.cardId));
  if (money) CE.resolve(money.instanceId, 'yes');
  if (rest) CE.resolve(rest.instanceId, 'yes');
  // One decided before r255: nothing was kept, so nothing is shown.
  const old = open.find(c => c !== money && c !== rest && c.noLabel);
  if (old) { CE.resolve(old.instanceId, 'no'); SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === old.instanceId); delete c._impact; delete c._impactLater; }); }
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  const get = (c) => c && SM.get().inbox.find(x => x.instanceId === c.instanceId);
  const next = SM.get().inbox.find(c => !c.resolved && c.noLabel && c.yesMsg && !c._choices);
  return { next: next && { id: next.instanceId, yesLabel: next.yesLabel, yesMsg: next.yesMsg }, money: money && { id: money.instanceId, impact: get(money)._impact, yesMsg: money.yesMsg }, rest: rest && { id: rest.instanceId, impact: get(rest)._impact }, old: old && old.instanceId };
}, { theme, now });
check('a money decision and a player decision answered', !!made.money && !!made.rest);
await page.waitForTimeout(800);
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(400);
// r271 §122.150 answering shows what you chose, never the sender's reply
if (made.next) {
  await page.evaluate((id) => document.querySelector(`[data-open="${id}"], [data-card="${id}"]`)?.scrollIntoView({ block: 'center' }), made.next.id);
  await page.tap(`[data-open="${made.next.id}"], [data-card="${made.next.id}"]`); await page.waitForTimeout(400);
  await page.tap(`[data-resolve="${made.next.id}"][data-choice="yes"]`); await page.waitForTimeout(300);
  const shown = await page.evaluate(() => (document.querySelector('.ep-title')?.textContent || '') + ' ' + (document.getElementById('toast')?.textContent || ''));
  check(`answered: the toast is your choice (“${shown.trim()}”), not their reply`, shown.includes(made.next.yesLabel) && !shown.includes(made.next.yesMsg));
  await page.waitForTimeout(3800);
}
await page.tap('#itab-completed'); await page.waitForTimeout(400);

const openThread = async (id) => {
  await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
  await page.tap(`.ml-row[data-open="${id}"]`); await page.waitForTimeout(400);
  return page.evaluate(() => ({ h: document.querySelector('.mi-h')?.textContent || '',
    rows: [...document.querySelectorAll('.mi-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()),
    ups: document.querySelectorAll('.mi-d.up').length, downs: document.querySelectorAll('.mi-d.down').length }));
};
const m = await openThread(made.money.id);
const fundsRow = m.rows.find(r => /^Club funds/.test(r)) || '';
check(`the money decision: “What changed” (${m.rows.join(' | ')})`, m.h === 'What changed' && m.rows.length === made.money.impact.length && m.rows.length > 0);
check(`club funds from → to, and the difference in red (“${fundsRow}”)`, /^Club funds \$[\d.]+[KM] → \$[\d.]+[KM] −\$\d+K$/.test(fundsRow) && m.downs >= 1);
const pts = m.rows.find(r => /^(Team morale|Stadium atmosphere|Owner trust)/.test(r)) || '';
check(`a rating from → to with its difference (“${pts}”)`, /^(Team morale|Stadium atmosphere|Owner trust) \d+ → \d+ [+−]\d+$/.test(pts));
const thread = await page.evaluate(() => ({ msgs: document.querySelectorAll('.mt-msg:not(.mi)').length, text: document.querySelector('.mr')?.innerText || '' }));
check(`the thread is the message and your reply — no reply from them (${thread.msgs} parts)`, thread.msgs === 2 && !thread.text.includes(made.money.yesMsg));
await page.screenshot({ path: `${out}/decision-impact-${theme}.png`, fullPage: false });
await page.evaluate(() => document.querySelector('.mi')?.scrollIntoView({ block: 'center' })); await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/decision-impact-rows-${theme}.png` });
await page.tap('#mr-back'); await page.waitForTimeout(300);

const r = await openThread(made.rest.id);
check(`the player decision names the player and what happens (${r.rows.join(' | ')})`, r.rows.some(x => /Rested \(1 game\)|Training/.test(x)));
await page.tap('#mr-back'); await page.waitForTimeout(300);

if (made.old) {
  const o = await openThread(made.old);
  check('a decision from before shows no “What changed”', o.h === '' && o.rows.length === 0);
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
