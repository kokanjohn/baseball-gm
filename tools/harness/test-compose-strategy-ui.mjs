// r169 Compose on screen: the recipients (no Media Relations, Community Affairs or Facilities); the
// Bullpen Coach's "A reliever's role" (pick a pitcher, pick a role); the Manager's batting order reply
// with its three choices (the recommended first), tapped; the Ticket Office's promotion.
//   node tools/harness/test-compose-strategy-ui.mjs outDir [theme]
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
  SM.mutate(s => { s.settings.theme = theme; });
  const rp = SM.get().userTeam.rosterIds.map(id => SM.get().players[id]).filter(p => p.group === 'bp').sort((a, b) => a.ovr - b.ovr)[0];
  return { id: rp.id, name: rp.name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };
const release = async (topic) => {
  const sent = await page.evaluate(async (t) => { const SM = await import('/baseball-gm/store/StateManager.js'); return (SM.get().scheduledCards || []).find(c => c._composeTopic === t); }, topic);
  now = Math.max(now, sent.deliverAtMs + 60_000);
  await page.clock.setFixedTime(now);
  await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
  await tap('.nav-item[data-tab="dashboard"]');
  await tap('.nav-item[data-tab="decisions"]');
  const id = await page.evaluate(async (t) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c._composeTopic === t)?.instanceId; }, topic);
  await tap(`[data-open="${id}"]`);
  await page.waitForTimeout(2600);
  return id;
};

await tap('.nav-item[data-tab="decisions"]');
await tap('#itab-compose');
const people = await page.$$eval('[data-channel]', els => els.map(e => e.dataset.channel));
check(`recipients: ${people.join(', ')}`, !people.some(x => ['media_relations', 'community', 'facilities'].includes(x)) && people.includes('bullpen_coach'));
await page.screenshot({ path: `${out}/compose-recipients-${theme}.png` });

// a reliever's role
await tap('[data-channel="bullpen_coach"]');
await tap('[data-topic="bpc_roles"]');
await page.selectOption('#compose-player', who.id);
await page.waitForTimeout(400);
const roles = await page.$$eval('.compose-skill', els => els.map(e => `${e.querySelector('.cs-name')?.textContent.trim()}${e.querySelector('.cs-val')?.textContent.trim() ? ' (' + e.querySelector('.cs-val').textContent.trim() + ')' : ''}`));
check(`Bullpen Coach → a reliever's role → ${who.name}: ${roles.join(' · ')}`, roles.length === 3 && roles[0].startsWith('Closer') && roles.includes("Manager's call (now)"));
await tap('.compose-skill[data-skill="closer"]');
await page.screenshot({ path: `${out}/compose-roles-${theme}.png` });
await tap('#compose-send-btn');
await release('bpc_roles');
const rr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`the reply: ${rr.btn.join(' / ')}`, rr.btn.includes(`Make ${who.name} the Closer`) && /manager would go with/i.test(rr.body));
await tap(`[data-resolve][data-choice="yes"]`);
await page.waitForTimeout(800);
const closer = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().userTeam.penRoles?.closer; });
check(`tapped: ${who.name} is the closer`, closer === who.id);

// the batting order
await tap('#itab-compose');
await tap('[data-channel="manager"]');
await tap('[data-topic="mgr_lineup"]');
await tap('#compose-send-btn');
await release('mgr_lineup');
const ch = await page.$$eval('.msg-choice', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
check(`the Manager's reply: ${ch.length} choices, the first recommended`, ch.length === 3 && /recommended/i.test(ch[0]) && ch.some(x => /Best Bats at the Top/.test(x)));
await page.evaluate(() => document.querySelector('.msg-choices')?.scrollIntoView({ block: 'end' }));
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/compose-order-${theme}.png`, fullPage: false });
const best = await page.$('.msg-choice[data-pick="order:best"]');
await best.scrollIntoViewIfNeeded();
await best.tap();
await page.waitForTimeout(800);
const order = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().userTeam.strategy?.order; });
check('tapped "Best Bats at the Top": set', order === 'best');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
