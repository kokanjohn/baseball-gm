// r296 §122.180 the Messages mode in Settings: the row reads Normal; it opens to Important only and Normal (not
// Hardcore yet); choosing Important only saves it, the row says so, and it holds after a reload. Then an optional
// message that arrives is the staff's: not in Messages, not in Completed; an important one is in Messages.
//   node tools/harness/test-message-mode-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);

const openSettings = async () => { await page.tap('#settings-btn'); await page.waitForTimeout(300); };
await openSettings();
const row = async () => page.evaluate(() => document.getElementById('settings-mode-value')?.textContent.trim());
check(`Settings: the Messages row reads “${await row()}”`, (await row()) === 'Normal');
await page.evaluate(() => document.getElementById('settings-mode-row')?.scrollIntoView({ block: 'center' }));
await page.tap('#settings-mode-row'); await page.waitForTimeout(250);
const opts = await page.evaluate(() => [...document.querySelectorAll('#settings-mode-options [data-mode]')].map(b => ({ m: b.dataset.mode, t: b.textContent.trim(), on: b.classList.contains('active') })));
check(`…it opens to ${opts.map(o => o.t).join(' and ')} (Normal chosen), not Hardcore yet`,
  opts.length === 2 && opts[0].t === 'Important only' && opts[1].t === 'Normal' && opts[1].on && !opts.some(o => o.m === 'hardcore'));
await page.screenshot({ path: `${out}/message-mode-${theme}.png` });
await page.tap('#settings-mode-options [data-mode="important"]'); await page.waitForTimeout(300);
const saved = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().settings.messageMode; });
const about = await page.evaluate(() => document.getElementById('settings-mode-about')?.textContent.trim());
check(`choosing Important only saves it (${saved}); the row says so (“${await row()}”) with its words (“${about}”)`, saved === 'important' && (await row()) === 'Important only' && /staff answer the rest/.test(about));
await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); await SM.save(); });
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
await openSettings();
check(`…and holds after a reload (“${await row()}”)`, (await row()) === 'Important only');
await page.evaluate(() => document.getElementById('settings-close')?.click());

// An optional message and an important one arrive.
const ids = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const { _createInstance } = await import('/baseball-gm/engine/cards/Selection.js');
  const { toInbox, VIA } = await import('/baseball-gm/engine/cards/Entry.js');
  const mk = (id, tag, subject) => _createInstance({ id, tag, sender: 'Community Relations', avatar: '🎈', type: 'normal', subject, body: 'Test.', yesLabel: 'Yes', noLabel: 'No', autoResolve: 'no', yesEffect: {}, noEffect: {} }, {}, SM.get());
  const opt = mk('test_ui_optional', 'CULTURE', 'A mural for the concourse'), imp = mk('test_ui_important', 'OPERATIONS', 'The scoreboard is out');
  SM.mutate(s => { toInbox(s, [opt, imp], () => Date.now(), VIA.SEED); });
  CE.releaseDueCards(Date.now());
  return { opt: opt.instanceId, imp: imp.instanceId };
});
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(500);
const shown = await page.evaluate(() => document.body.innerText);
check('an optional message is the staff\'s: not in Messages', !shown.includes('A mural for the concourse'));
check('…an important one is', shown.includes('The scoreboard is out'));
// answer the important one: Completed shows it, and not the staff's
await page.evaluate(async (id) => { const CE = await import('/baseball-gm/engine/CardEngine.js'); CE.resolve(id, 'yes'); const EB = await import('/baseball-gm/ui/EventBus.js'); EB.emit('inbox:changed'); }, ids.imp);
await page.tap('#itab-completed'); await page.waitForTimeout(500);
const done = await page.evaluate(() => document.body.innerText);
check('…Completed shows the one answered, and not the staff\'s', done.includes('The scoreboard is out') && !done.includes('A mural for the concourse'));
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
