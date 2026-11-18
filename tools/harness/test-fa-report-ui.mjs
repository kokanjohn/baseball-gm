// r204 §122.82 In the real app: the scouts' free-agent report is a decision. A row per player: Sign (the
// sign sheet) or Watch, with how many we're watching (of three); the message stays open after each, and
// Done moves it to Completed with what came of each player.
//   node tools/harness/test-fa-report-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
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
const id = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; s.push = { ...(s.push || {}), quietStart: '23:59', quietEnd: '00:00' }; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const c = CE.deliverComposeCard('sc_free_agents', 'scouting', { topicLabel: 'Free agents worth a look', nowMs: Date.now() - 2 * 86_400_000 });
  CE.releaseDueCards(Date.now());
  App.switchTab('decisions');
  return c.instanceId;
}, { theme });
await page.waitForTimeout(400);
await page.click(`[data-open="${id}"]`); await page.waitForTimeout(400);
const rows = async () => page.evaluate(() => ({
  rows: [...document.querySelectorAll('.fa-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
  limit: document.querySelector('.fa-limit')?.textContent.trim(),
  done: [...document.querySelectorAll('[data-choice="yes"]')].map(b => b.textContent.trim()),
}));
const r0 = await rows();
check(`a row per player, each Sign and Watch (${r0.rows.length})`, r0.rows.length >= 1 && r0.rows.every(t => /Sign \(\$/.test(t) && /Watch/.test(t)), r0.rows.join(' | '));
check(`how many we're watching: “${r0.limit}”`, r0.limit === 'Watching 0 of 3');
check('…and Done', r0.done.join() === 'Done');
await page.$eval('.fa-rows', el => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${out}/fa-report-${theme}.png` });

// Watch the first: the row says so; the message stays open.
await page.click('[data-fa-watch]'); await page.waitForTimeout(500);
const r1 = await rows();
check(`Watch: the row says Watching, and 1 of 3 (“${r1.limit}”)`, /Watching$/.test(r1.rows[0]) && r1.limit === 'Watching 1 of 3', r1.rows[0]);
check('…the message is still open', r1.done.join() === 'Done' || r1.rows.length === 1);

// Sign the second: the sign sheet, then the row says Signed.
if (r1.rows.length > 1) {
  await page.click('[data-fa-sign]'); await page.waitForTimeout(500);
  check('Sign opens the sign sheet', await page.evaluate(() => !!document.querySelector('.ss-sheet')));
  await page.screenshot({ path: `${out}/fa-report-sign-${theme}.png` });
  await page.evaluate(() => { const b = document.querySelector('[data-drop]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  await page.click('#ss-go'); await page.waitForTimeout(700);
  const r2 = await rows();
  check(`…signed: the row says so (${r2.rows[1]})`, /Signed$/.test(r2.rows[1] || ''), r2.rows.join(' | '));
  await page.$eval('.fa-rows', el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${out}/fa-report-after-${theme}.png` });
}

// Done: to Completed, with what came of each.
const open = await page.$('[data-choice="yes"]');
if (open) { await open.click(); await page.waitForTimeout(500); }
await page.click('#itab-completed').catch(() => {}); await page.waitForTimeout(400);
const snip = await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"] .ml-snip`)?.textContent.replace(/\s+/g, ' ').trim(), id);
check(`Completed: “${snip}”`, /Watching/.test(snip || '') && /Signed|Passed on/.test(snip || ''));
await page.screenshot({ path: `${out}/fa-report-completed-${theme}.png` });

check('no errors', !errors.length, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
