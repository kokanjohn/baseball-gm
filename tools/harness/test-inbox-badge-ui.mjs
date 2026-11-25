// r267 §122.146 the Messages badges (nav bar, Inbox tab): red with the unread count, counting down as each is
// opened; with none unread, muted with how many still need an answer; none waiting: no badge.
//   node tools/harness/test-inbox-badge-ui.mjs outDir [theme]
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
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(900);
const read = () => page.evaluate(() => {
  const nb = document.getElementById('inbox-badge'), tb = document.querySelector('#itab-todo .tab-badge');
  const n = (window.__sm || null);
  return { nav: nb?.classList.contains('visible') ? nb.textContent.trim() : '', navMuted: !!nb?.classList.contains('muted'),
           tab: tb?.textContent.trim() || '', tabMuted: !!tb?.classList.contains('muted'),
           rows: document.querySelectorAll('.ml-row').length, unreadRows: document.querySelectorAll('.ml-row.unread').length };
});
const counts = () => page.evaluate(async () => (await import('/baseball-gm/engine/CardEngine.js')).inboxCounts());
let c = await counts();
let b = await read();
check(`at first: the nav badge red with the unread (${b.nav}; ${c.unread} unread of ${c.todo})`, c.unread > 1 && b.nav === String(c.unread) && !b.navMuted);
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(400);
b = await read();
check(`the Inbox tab the same (${b.tab})`, b.tab === String(c.unread) && !b.tabMuted);
// open one: one fewer, at once, in both places
await page.tap('.ml-row.unread'); await page.waitForTimeout(300);
b = await read();
check(`one opened: ${c.unread - 1} unread on the nav badge (${b.nav})`, b.nav === String(c.unread - 1) && !b.navMuted);
await page.tap('#mr-back'); await page.waitForTimeout(300);
b = await read();
check(`…and on the tab (${b.tab})`, b.tab === String(c.unread - 1));
// open the rest
for (let i = 0; i < 40; i++) {
  if (!(await page.$('.ml-row.unread'))) break;
  await page.tap('.ml-row.unread'); await page.waitForTimeout(200); await page.tap('#mr-back'); await page.waitForTimeout(200);
}
c = await counts(); b = await read();
check(`all read: muted, with how many still need an answer (${b.nav} / ${b.tab}; ${c.todo} waiting)`, c.unread === 0 && c.todo > 0 && b.nav === String(c.todo) && b.navMuted && b.tab === String(c.todo) && b.tabMuted);
await page.screenshot({ path: `${out}/inbox-badge-muted-${theme}.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });
await page.screenshot({ path: `${out}/inbox-badge-nav-${theme}.png`, clip: { x: 0, y: 760, width: 390, height: 84 } });
// a new message arrives: red again with 1
await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js'); const EB = await import('/baseball-gm/ui/EventBus.js');
  CE.deliverComposeCard('mgr_morale', 'manager', { topicLabel: 'Team morale check-in', nowMs: Date.now() - 6 * 3600_000 });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { for (const x of s.scheduledCards || []) if (x.isCompose) { x.deliverAtMs = Date.now() - 1000; x.deliveredAt = Date.now() - 1000; } });
  CE.releaseDueCards(Date.now()); EB.emit('card:delivered', { source: 'test' });
});
await page.waitForTimeout(400);
b = await read();
check(`a new message: red, 1 (${b.nav} / ${b.tab})`, b.nav === '1' && !b.navMuted && b.tab === '1' && !b.tabMuted);
// answer everything: no badge
await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js'); const EB = await import('/baseball-gm/ui/EventBus.js');
  for (const x of CE.getInbox()) { CE.resolve(x.instanceId, 'yes'); }
  const SM = await import('/baseball-gm/store/StateManager.js');   // (anything a plain yes can't settle)
  SM.mutate(s => { for (const x of s.inbox || []) x.resolved = true; });
  EB.emit('card:resolved', {});
});
await page.waitForTimeout(400);
c = await counts(); b = await read();
// (answering can bring a follow-up; then the badge is that one)
check(`answered: the badge is what's left (${c.todo} left, ${c.unread} unread; nav “${b.nav}”, tab “${b.tab}”)`,
  c.todo === 0 ? (b.nav === '' && b.tab === '') : (b.nav === String(c.badge.n) && b.tab === String(c.badge.n) && b.navMuted === (c.badge.tone === 'waiting')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
