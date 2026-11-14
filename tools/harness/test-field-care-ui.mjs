// r170 the groundskeeper on screen: Compose → Head Groundskeeper lists "Get the field ready"; the
// message before a wet home game (Bring In the Crew / We'll Manage), tapped; the drainage pitch.
//   node tools/harness/test-field-care-ui.mjs outDir [theme]
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
const now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const info = await page.evaluate(async ({ theme, now }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const g = SM.get().schedule.find(x => x.isHome && !x.isSpring && x.gameTime > now + 2 * 86_400_000);
  // (a home game two days out, rain likely; the message as if it came now)
  SM.mutate(s => { const x = s.schedule.find(y => y.gameTime === g.gameTime); x.opponent ||= 'Gulfport Mullets'; });
  CE.deliverFieldPrepCard({ gameTime: g.gameTime, opp: SM.get().schedule.find(y => y.gameTime === g.gameTime).opponent, chance: 70, kind: 'storms', wetIn: 0.9, costK: 17, drainage: 0 }, now - 60_000);
  CE.deliverDrainageCard({ level: 1, costK: 150, wet: 4, startAt: now + 9 * 86_400_000, readyAt: now + 15 * 86_400_000, homeAt: now + 17 * 86_400_000 }, now - 30_000);
  CE.releaseDueCards(now);
  const ib = SM.get().inbox;
  return { prep: ib.find(c => c.cardId === 'field_prep')?.instanceId, drain: ib.find(c => c.cardId === 'field_drainage')?.instanceId, gameTime: g.gameTime };
}, { theme, now });
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="decisions"]');
await tap('#itab-compose');
await tap('[data-channel="groundskeeper"]');
check('Head Groundskeeper: "Get the field ready" is a topic', !!(await page.$('[data-topic="gk_prep"]')));
await tap('#itab-todo');
await tap(`[data-open="${info.prep}"]`);
await page.waitForTimeout(2600);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()), from: document.querySelector('.mr-from, .mr-sender')?.textContent || '' }));
check(`the message: ${read.btn.join(' / ')}`, /extra crew/.test(read.body) && read.btn.includes('Bring In the Crew ($17K)') && read.btn.includes("We'll Manage"));
await page.screenshot({ path: `${out}/field-prep-${theme}.png` });
await tap(`[data-resolve="${info.prep}"][data-choice="yes"]`);
await page.waitForTimeout(800);
const booked = await page.evaluate(async (gt) => { const SM = await import('/baseball-gm/store/StateManager.js'); return !!SM.get().fieldPrep?.[gt]; }, info.gameTime);
check('tapped: the crew is booked', booked);
await tap(`[data-open="${info.drain}"]`);
await page.waitForTimeout(2600);
const dr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`the drainage pitch: ${dr.btn.join(' / ')}`, /drainage/i.test(dr.body) && dr.btn.includes('Put In the Drainage ($150K)'));
await page.screenshot({ path: `${out}/field-drainage-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
