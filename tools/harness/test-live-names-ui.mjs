// r283 §122.162 messages show people as they're called now: after renames, the inbox list, the reading view, the
// sender line and Completed all read the new names — none of the old ones — for every person a message names.
//   node tools/harness/test-live-names-ui.mjs outDir [theme]
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
const made = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  // messages from and about the staff and the owner
  for (const id of ['sp12', 'o1', 'x5', 'bg12']) CE.deliverCardById(id);
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return true;
}, theme);
await page.waitForTimeout(1200);
// rename everyone the messages name
const renamed = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { renamePerson } = await import('/baseball-gm/engine/People.js');
  const named = new Set(SM.get().inbox.flatMap(c => Object.keys(c._people || {})));
  const pairs = [];
  SM.mutate(s => { for (const id of named) { const was = s.people[id].name; const now = `Newname${id.replace(/\D/g, '')}`; renamePerson(s, id, now); pairs.push([was, now]); } });
  return { pairs, msgs: SM.get().inbox.filter(c => Object.keys(c._people || {}).length).map(c => c.instanceId) };
});
console.log(`    renamed: ${renamed.pairs.map(([a, b]) => `${a} → ${b}`).join(', ')}`);
check(`messages name people (${renamed.msgs.length} messages, ${renamed.pairs.length} people)`, renamed.msgs.length >= 3 && renamed.pairs.length >= 2);
const olds = renamed.pairs.map(p => p[0]), news = renamed.pairs.map(p => p[1]);
const has = (text, names) => names.filter(n => new RegExp(`(^|[^\\p{L}])${n}(?=$|[^\\p{L}])`, 'u').test(text));

await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(600);
const list = await page.evaluate(() => document.querySelector('#inbox-content')?.innerText || '');
check(`the inbox list: no old names (${has(list, olds).join(', ') || 'none'}), the new ones there (${has(list, news).length})`, has(list, olds).length === 0 && has(list, news).length >= 1);
const id = renamed.msgs[0];
await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
await page.tap(`.ml-row[data-open="${id}"]`); await page.waitForTimeout(500);
const reader = await page.evaluate(() => ({ text: document.querySelector('.mr')?.innerText || '', from: document.querySelector('.mr .mr-name')?.textContent.trim() }));
check(`the reading view (from ${reader.from}): no old names`, has(reader.text, olds).length === 0 && has(reader.text, news).length >= 1, has(reader.text, olds).join());
await page.screenshot({ path: `${out}/live-names-${theme}.png` });
await page.tap(`[data-resolve="${id}"][data-choice="yes"], [data-resolve="${id}"]`); await page.waitForTimeout(4500);
await page.tap('#itab-completed'); await page.waitForTimeout(400);
const done = await page.evaluate(() => document.querySelector('#inbox-content')?.innerText || '');
check('Completed: no old names', has(done, olds).length === 0, has(done, olds).join());
await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
await page.tap(`.ml-row[data-open="${id}"]`); await page.waitForTimeout(400);
const thread = await page.evaluate(() => document.querySelector('.mr')?.innerText || '');
check('…and the thread: no old names', has(thread, olds).length === 0 && has(thread, news).length >= 1, has(thread, olds).join());
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
