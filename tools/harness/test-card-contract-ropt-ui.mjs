// r172 two small Team-screen changes: the player card shows the contract (a free agent's ask) right
// under the name, before the ratings; the hitters' and the pitchers' bars each have their own "?",
// each with its own moves (the lineup / the staff) or its own "as good as it gets".
//   node tools/harness/test-card-contract-ropt-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
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
await page.waitForTimeout(400);
const made = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const st = SM.get(), P = (id) => st.players[id];
  // a bench bat better than the starter at a spot it plays, and a bench arm better than a starter in the rotation
  const slot = st.userTeam.lineupSlots.find(x => x.slot === 'OF');
  const bench = st.userTeam.rosterIds.map(P).find(p => p.group === 'bench' && /OF/.test(p.pos));
  const sp = st.userTeam.rosterIds.map(P).find(p => p.group === 'pb' && p.pos === 'SP');
  SM.mutate(s => { if (bench) s.players[bench.id].ovr = 95; if (sp) s.players[sp.id].ovr = 95; });
  return { bench: bench?.name, sp: sp?.name, hitter: slot.playerId };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };
await tap('.nav-item[data-tab="roster"]');

const toast = async (sel) => { await tap(sel); const t = await page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(e => e.innerText).filter(Boolean).pop() || ''); await page.waitForTimeout(100); return t; };
const btns = await page.$$eval('.ropt-hint-btn', els => els.map(e => e.id));
check(`two "?" buttons, one per bar (${btns.join(', ')})`, btns.join() === 'ropt-hint-hitters,ropt-hint-pitchers');
const th = await toast('#ropt-hint-hitters');
check(`hitters: "${th}"`, /lineup/.test(th) && (!made.bench || th.includes(made.bench)) && !/rotation|bullpen/.test(th));
await page.screenshot({ path: `${out}/ropt-hitters-${theme}.png` });
await page.waitForTimeout(5800);
const tp = await toast('#ropt-hint-pitchers');
check(`pitchers: "${tp}"`, /staff|rotation/.test(tp) && (!made.sp || tp.includes(made.sp)) && !/lineup/.test(tp));

await tap(`.tr-row[data-player="${made.hitter}"] .tr-name`);
const order = await page.evaluate(() => [...document.querySelectorAll('#player-card-sheet .pc-section-label')].map(e => e.textContent.trim()));
check(`the card: the contract first (${order.slice(0, 3).join(', ')}…)`, order[0] === 'Contract');
await page.screenshot({ path: `${out}/card-contract-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
