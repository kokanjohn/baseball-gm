// r222/r223 §122.101–102 In the real app: (1) one of our players who has told us they're retiring shows it on the
// player card (and one who hasn't, doesn't); (2) Compose → Scouting → "Is … retiring?": the league's veterans by
// club, free agents first; the reply waits, then arrives from the director as "Re: Is X retiring?".
//   node tools/harness/test-retire-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', timezoneId: 'America/New_York' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const ids = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const R = await import('/baseball-gm/engine/Retirement.js');
  let out = {};
  SM.mutate(s => {
    s.settings.theme = theme;
    s.phase = 'REGULAR_SEASON';
    R.settlePlans(s);
    const [a, b] = s.userTeam.lineupSlots.map(x => x.playerId);
    s.players[a].retireIntent = { season: s.seasonNum || 1, retiring: true, tell: 10, told: true };
    s.players[b].retireIntent = { season: s.seasonNum || 1, retiring: false, tell: 10 };
    out = { a, b, aName: s.players[a].name };
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return out;
}, { theme });
await page.waitForTimeout(800);

// 1. The player card.
const cardText = async (id) => {
  await page.evaluate(async (id) => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); const SM = await import('/baseball-gm/store/StateManager.js'); PC.openPlayerCard(id, SM.get()); }, id);
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => [...document.querySelectorAll('.pc-section')].find(x => /Contract/.test(x.textContent))?.textContent.replace(/\s+/g, ' ').trim() || '');
  return t;
};
const ta = await cardText(ids.a);
await page.evaluate(() => [...document.querySelectorAll('.pc-section')].find(x => /Contract/.test(x.textContent))?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/retire-card-${theme}.png` });
check(`our player who told us: “${ta}”`, /Retiring after the season/.test(ta));
await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
await page.waitForTimeout(300);
const tb = await cardText(ids.b);
check('one who isn\'t retiring: no line', !/Retiring/.test(tb), tb);
await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
await page.waitForTimeout(300);

// 2. Compose → Scouting → Is … retiring?
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
await page.click('#itab-compose');
await page.waitForSelector('.compose-person[data-channel="scouting"]', { timeout: 5000 });
await page.click('.compose-person[data-channel="scouting"]');
await page.waitForSelector('.compose-topic-btn[data-topic="sc_retire"]', { timeout: 5000 });
await page.click('.compose-topic-btn[data-topic="sc_retire"]');
await page.waitForSelector('#compose-player', { timeout: 5000 });
const sel = await page.evaluate(() => {
  const s = document.getElementById('compose-player');
  return { groups: [...s.querySelectorAll('optgroup')].map(g => ({ label: g.label, n: g.children.length, first: g.children[0]?.textContent })),
           send: document.getElementById('compose-send-btn')?.textContent.trim() };
});
check(`the picker: veterans by club${sel.groups[0]?.label === 'Free agents' ? ', free agents first' : ''} (${sel.groups.length} groups; e.g. “${sel.groups[0]?.first}”)`,
  sel.groups.length >= 2 && sel.groups.every(g => g.n > 0) && /OVR \d+, age 3\d/.test(sel.groups[0]?.first || ''));
check(`Send waits for a player (“${sel.send}”)`, sel.send === 'Pick a player');
await page.screenshot({ path: `${out}/retire-compose-${theme}.png` });
const pick = await page.evaluate(() => { const o = document.querySelector('#compose-player optgroup option'); return { id: o.value, name: o.textContent.split(' — ')[0] }; });
await page.selectOption('#compose-player', pick.id);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/retire-compose-picked-${theme}.png` });
await page.click('#compose-send-btn');
await page.waitForTimeout(400);
const got = await page.evaluate(async (pid) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const sch = (SM.get().scheduledCards || []).find(c => c.isCompose && c._composeTopic === 'sc_retire');
  const wait = document.querySelector('.compose-waiting')?.textContent.replace(/\s+/g, ' ').trim();
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  CE.releaseDueCards(sch.deliverAtMs);
  const c = (SM.get().inbox || []).find(x => x.isCompose && x._composeTopic === 'sc_retire');
  return { wait, at: sch?.deliverAtMs, arg: sch?._composeArg?.playerId === pid, subject: c?.subject, body: c?.body, sender: c?.sender };
}, pick.id);
check(`sent: waiting to hear back (“${got.wait}”)`, /Is .+ retiring\?/.test(got.wait || '') && got.arg);
check(`the reply: “${got.subject}” from ${got.sender}`, got.subject === `Re: Is ${pick.name} retiring?` && /Scout/i.test(got.sender || ''));
console.log('\n' + got.body + '\n');
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
