// r162 §122.34 A staff roster suggestion as the GM reads it: the inbox message (who it's from, the two
// players tappable), "Start X at 1B" / "I Have a Plan" — and the reply after "I Have a Plan".
//   node tools/harness/test-roster-advice-ui.mjs outDir [theme]
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
const first = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  CE.syncRosterCards([], Date.now());
  const c = (SM.get().scheduledCards || []).find(x => x.cardId === 'roster_advice');
  return c ? { id: c.instanceId, at: c.deliverAtMs, kind: c._advice.kind, inName: SM.get().players[c._advice.inId].name, outName: SM.get().players[c._advice.outId].name } : null;
}, theme);
check('a new club: the staff\'s first suggestion is on its way', !!first);
await page.clock.setFixedTime(first.at + 60_000);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="decisions"]');
await tap(`[data-open="${first.id}"]`);
await page.waitForTimeout(2600);   // (toasts clear)
const read = await page.evaluate(() => ({
  from: document.querySelector('.mr-from, .mr-sender')?.textContent.trim() || '',
  body: document.querySelector('.mr-body')?.innerText || '',
  btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()),
  links: [...document.querySelectorAll('.mr-body .msg-player')].map(a => a.textContent.trim()),
}));
check(`the message: ${read.btn.join(' / ')}`, read.btn.some(b => /^(Start|Put) /.test(b)) && read.btn.includes('I Have a Plan'));
check(`…both players tappable (${[...new Set(read.links)].join(', ')})`, read.links.includes(first.inName) && read.links.includes(first.outName));
await page.screenshot({ path: `${out}/advice-message-${theme}.png` });

await page.tap(`[data-resolve="${first.id}"][data-choice="no"]`);
await page.waitForTimeout(800);
const after = await page.evaluate(async (id) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const c = SM.get().inbox.find(x => x.instanceId === id);
  return { choice: c?.choice, quiet: Object.keys(SM.get().adviceQuiet || {}).length, text: document.body.innerText };
}, first.id);
check('"I Have a Plan": answered, and quiet for that pairing', after.choice === 'no' && after.quiet === 1);
check('…the reply shows', /leave it unless something changes/.test(after.text));
await page.waitForTimeout(2600);
await page.screenshot({ path: `${out}/advice-plan-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
