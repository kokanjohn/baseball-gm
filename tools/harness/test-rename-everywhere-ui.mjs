// r284 §122.163 a rename reaches everywhere a name shows. A three-season save (STATE: /ms-state.json, made by
// multi-season.mjs with STATE_DUMP), everyone in the record renamed, then every screen read for any old name:
// the Dashboard (and its Recent feed), Team (Staff, Finances), League (Teams, Moves and its feed, Standings), the
// Schedule's team sheets, Messages (the inbox, each message, Completed and each thread, Compose).
// Also: the rename itself from the staff sheet (the check as it's typed, then saved).
//   node tools/harness/test-rename-everywhere-ui.mjs outDir [theme]
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
const people = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { state } = await (await fetch('/ms-state.json')).json();
  state.settings = { ...(state.settings || {}), theme };
  SM.mutate(s => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, state); });   // (this slot, holding the save)
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return Object.values(SM.get().people).map(p => ({ id: p.id, name: p.name, role: p.role }));
}, theme);
await page.waitForTimeout(1500);
// (the save's milestones queue up on opening: out of the way)
await page.addStyleTag({ content: '#milestone-overlay{display:none!important;pointer-events:none!important}' });
check(`a three-season save: ${people.length} people in the record`, people.length >= 25);

const click = (sel) => page.evaluate(async (sel) => {
  const m = sel.match(/^\.nav-item\[data-tab="(\w+)"\]$/);
  const App = await import('/baseball-gm/ui/App.js');
  App.clearMilestone();   // (the save's milestones, as if seen)
  if (m) { App.switchTab(m[1]); return; }   // (the nav, as a tap does)
  document.querySelector(sel)?.click();
}, sel);
// ── the rename itself, from the staff sheet ──
await click('.nav-item[data-tab="roster"]'); await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('tsubtab-staff')?.click()); await page.waitForTimeout(400);
const mgrName = await page.$eval('.staff-card-tap[data-staff="manager"] .staff-card-name', e => e.textContent.trim());
await click('.staff-card-tap[data-staff="manager"]'); await page.waitForTimeout(400);
check('the staff sheet has Rename', !!(await page.$('#staff-rename')));
await click('#staff-rename'); await page.waitForTimeout(400);
const tryName = async (v) => { await page.fill('#rename-input', v); await page.waitForTimeout(100); return page.evaluate(() => ({ why: document.getElementById('rename-why').textContent, off: document.getElementById('rename-save').disabled })); };
const taken = people.find(p => p.name !== mgrName).name;
const club = await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().userTeam.city);
const t1 = await tryName(taken), t2 = await tryName('Rain'), t3 = await tryName('x'), t4 = await tryName(club);
check(`refused as it's typed: in use (“${t1.why}”), a word the game uses (“${t2.why}”), not a name (“${t3.why}”), a club's`, t1.off && /already goes by/.test(t1.why) && t2.off && /word the game uses/.test(t2.why) && t3.off && t4.off);
await tryName('Rain'); await page.screenshot({ path: `${out}/rename-refused-${theme}.png` });
const t5 = await tryName('Quillfeather');
check('a good name: Save', !t5.off && t5.why === '');
await click('#rename-save'); await page.waitForTimeout(800);
const after = await page.$eval('.staff-card-tap[data-staff="manager"] .staff-card-name', e => e.textContent.trim());
check(`saved: the staff card reads ${after}`, after === 'Quillfeather');
check('…the owner has a card too (tap to rename)', !!(await page.$('.staff-card-tap[data-staff="owner"]')));

// ── everyone renamed ──
const pairs = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { renamePerson } = await import('/baseball-gm/engine/People.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const out = [];
  SM.mutate(s => { for (const p of Object.values(s.people)) { const was = [p.name, ...(p.aka || [])]; const now = `Zed${p.id.replace(/\D/g, '')}son`; renamePerson(s, p.id, now); out.push([was, now]); } });
  EB.emit('roster:changed', { source: 'test' });
  return out;
});
console.log('    after the renames, our manager:', await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().userTeam.coachingStaff.manager.name));
await page.evaluate(() => document.querySelectorAll('#toast, .toast').forEach(t => t.remove()));   // (the rename's toast)
const olds = [...new Set(pairs.flatMap(p => p[0]))];
const scan = async (where) => {
  const text = await page.evaluate(() => document.body.innerText);
  const found = olds.filter(n => new RegExp(`(^|[^\\p{L}])${n}(?=$|[^\\p{L}])`, 'u').test(text));
  return { where, found, news: (text.match(/Zed\d+son/g) || []).length };
};
const results = [];
const visit = async (label, steps) => { for (const s of steps) { await s(); await page.waitForTimeout(350); } results.push(await scan(label)); };
const tap = (sel) => async () => { await click(sel); };

await visit('Dashboard', [tap('.nav-item[data-tab="dashboard"]'), tap('#recent-toggle')]);
await visit('Team · Staff', [tap('.nav-item[data-tab="roster"]'), tap('#tsubtab-staff')]);
await visit('Team · Finances', [tap('#tsubtab-finances')]);
await visit('League · Teams', [tap('.nav-item[data-tab="league"]'), tap('#ltab-teams')]);
const teamIds = await page.$$eval('.lgt-card[data-team]', els => els.map(e => e.dataset.team).slice(0, 4));
for (const id of teamIds) { await visit(`League · team ${id}`, [tap(`.lgt-card[data-team="${id}"]`)]); await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(m => m.remove())); }
await visit('League · Moves', [tap('#ltab-moves')]);
await visit('League · Standings', [tap('#ltab-standings')]);
await visit('Schedule', [tap('.nav-item[data-tab="schedule"]')]);
const oppIds = await page.$$eval('.game-opp-name[data-opp]', els => [...new Set(els.map(e => e.dataset.opp))].slice(0, 3));
for (const id of oppIds) await visit(`Schedule · team sheet ${id}`, [async () => { await page.evaluate((id) => document.querySelector(`.game-opp-name[data-opp="${id}"]`)?.click(), id); }, async () => {}]).then(async () => { await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(m => m.remove())); });
await visit('Messages · Inbox', [tap('.nav-item[data-tab="decisions"]'), tap('#itab-todo')]);
const inboxIds = await page.$$eval('.ml-row[data-open]', els => els.map(e => e.dataset.open).slice(0, 12));
for (const id of inboxIds) { await visit(`Messages · ${id.slice(0, 8)}`, [async () => { await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.click(), id); }]); await page.evaluate(() => document.getElementById('mr-back')?.click()); await page.waitForTimeout(250); }
await visit('Messages · Completed', [tap('#itab-completed')]);
const doneIds = await page.$$eval('.ml-row[data-open]', els => els.map(e => e.dataset.open).slice(0, 25));
for (const id of doneIds) { await visit(`Completed · ${id.slice(0, 8)}`, [async () => { await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.click(), id); }]); await page.evaluate(() => document.getElementById('mr-back')?.click()); await page.waitForTimeout(250); }
await visit('Messages · Compose', [tap('#itab-compose')]);
for (const ch of await page.$$eval('[data-channel]', els => els.map(e => e.dataset.channel))) await visit(`Compose · ${ch}`, [tap(`[data-channel="${ch}"]`)]);

const bad = results.filter(r => r.found.length);
const seen = results.reduce((a, r) => a + r.news, 0);
console.log(`    ${results.length} views read; the new names shown ${seen} times`);
check(`no old name anywhere (${results.length} views: ${inboxIds.length} messages, ${doneIds.length} threads)`, bad.length === 0 && seen > 50,
  bad.slice(0, 6).map(r => `${r.where}: ${r.found.join(', ')}`).join(' | '));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
