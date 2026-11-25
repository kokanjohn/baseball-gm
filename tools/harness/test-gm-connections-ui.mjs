// r212 §122.90 Who a message is from, on screen ("Name, Role"); Compose → Other GMs: "Talk trade" opens the trade
// screen, "Welcome a new GM" picks a new GM and sends.
//   node tools/harness/test-gm-connections-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
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
await page.clock.setFixedTime(Date.now());
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const who = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const F = await import('/baseball-gm/engine/FirstDay.js');
  // Season two, with a new GM at one club; a message from the owner and one from the scouting director (by name only).
  SM.mutate(s => {
    s.settings.theme = theme;
    s.seasonNum = 2;
    for (const t of s.leagueTeams) t.gm = { name: F.cpuGmName(s, t.id), since: 1 };
    s.leagueTeams[3].gm = { name: 'Newcomb', since: 2, prev: s.leagueTeams[3].gm.name };
  });
  const st = SM.get();
  const add = (id, sender, subject) => ({ instanceId: id, cardId: id, sender, subject, preview: 'A note.', body: 'A note.', type: 'normal', tag: 'OPERATIONS',
                                       avatar: '📋', autoResolved: true, resolved: false, arrivedAtMs: Date.now() });
  SM.mutate(s => { s.inbox = [...(s.inbox || []), add('t-owner', st.userTeam.ownerName, 'A word from the owner'),
                                                  add('t-scout', st.userTeam.coachingStaff.scoutingDirector.name, 'A note from scouting')]; });
  return { owner: st.userTeam.ownerName, scout: st.userTeam.coachingStaff.scoutingDirector.name, club: st.leagueTeams[3].name, clubId: st.leagueTeams[3].id };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="decisions"]');
const froms = await page.$$eval('.ml-from', els => els.map(e => e.textContent.trim()));
check(`the inbox: "${who.owner}, Owner" and "${who.scout}, Scouting Director"`, froms.includes(`${who.owner}, Owner`) && froms.includes(`${who.scout}, Scouting Director`), froms.slice(0, 8).join(' | '));
check('…no bare names from our people', !froms.includes(who.owner) && !froms.includes(who.scout));
await page.screenshot({ path: `${out}/gm-inbox-${theme}.png` });

await tap('#itab-compose');
const sub = await page.$eval('[data-channel="other_gms"]', el => el.textContent.replace(/\s+/g, ' ').trim());
check(`Other GMs: "${sub}"`, /1 new GM to welcome/.test(sub));
await tap('[data-channel="other_gms"]');
check('two topics: Talk trade, Welcome a new GM', !!(await page.$('[data-topic="gm_trade"]')) && !!(await page.$('[data-topic="gm_welcome"]')));
await tap('[data-topic="gm_trade"]');
await page.waitForTimeout(400);
check('Talk trade opens the trade screen', !!(await page.$('#tc-overlay')));
await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(e => e.remove()));
await tap('[data-topic="gm_welcome"]');
const opts = await page.$$eval('.compose-deal .cd-label', els => els.map(e => e.textContent.trim()));
check(`Welcome a new GM: ${opts.join(', ')} (picked already: the only one)`, opts.length === 1 && opts[0] === `Newcomb, ${who.club}` && !(await page.evaluate(() => document.getElementById('compose-send-btn')?.disabled)));
await page.screenshot({ path: `${out}/gm-welcome-${theme}.png` });
await tap('#compose-send-btn');
const sent = await page.evaluate(async (id) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const c = (SM.get().scheduledCards || []).find(x => x.isCompose && x._composeTopic === 'gm_welcome');
  return { key: c?._composeArg?.key, rel: SM.get().userTeam.gmRelationships?.[id] };
}, who.clubId);
check(`sent: the welcome is on its way, and our standing is up (${sent.rel})`, sent.key === who.clubId && sent.rel === 58, JSON.stringify(sent));
await tap('[data-channel="other_gms"]');
const note = await page.$$eval('.compose-topic-btn', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()).find(t => /Welcome a new GM/.test(t)) || '');
check(`…and the topic waits on the reply ("${note}")`, /awaiting reply/.test(note));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
