// r279 §122.158 a follow-up in Messages: the message comes back unread at the top, its snippet the follow-up; the
// reading view shows the follow-up under the message, from the sender; answering closes the one message, and
// Completed keeps the thread (the message, the follow-up, my reply).
//   node tools/harness/test-follow-up-ui.mjs outDir [theme]
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
  const F = await import('/baseball-gm/engine/FollowUps.js');
  SM.mutate(s => { s.settings.theme = theme; s._followUpsFrom = Date.now() - 20 * 3_600_000; });
  const c = CE.deliverCardById('sp12');
  // (arrived yesterday, read, due tomorrow; the follow-up came this morning)
  SM.mutate(s => {
    const x = s.inbox.find(y => y.instanceId === c.instanceId);
    x.arrivedAtMs = Date.now() - 18 * 3_600_000; x._readAt = Date.now() - 17 * 3_600_000; x.expiresAt = null; x.expiresAtMs = Date.now() + 9 * 3_600_000;
    const at = Date.now() - 30 * 60_000;
    x._followUp = { atMs: at, text: F.followUpText(x, s, at) };
    x._readAt = null;
    for (const y of s.inbox) if (y.instanceId !== c.instanceId) y._readAt = Date.now();
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  const x = SM.get().inbox.find(y => y.instanceId === c.instanceId);
  return { id: c.instanceId, text: x._followUp.text, subject: x.subject };
}, theme);
await page.waitForTimeout(800);
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(500);
const list = await page.evaluate(async (id) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const by = Object.fromEntries(SM.get().inbox.map(c => [c.instanceId, Math.max(c.arrivedAtMs || 0, c._followUp?.atMs || 0)]));
  const rows = [...document.querySelectorAll('.ml-row')].map(r => ({ id: r.dataset.open, t: by[r.dataset.open], unread: r.classList.contains('unread'), snip: r.querySelector('.ml-snip')?.textContent.trim() }));
  return { rows, me: rows.find(r => r.id === id), older: rows.filter(r => r.id !== id && SM.get().inbox.find(c => c.instanceId === r.id)?.arrivedAtMs < SM.get().inbox.find(c => c.instanceId === id).arrivedAtMs + 1e9).length };
}, made.id);
const ordered = list.rows.every((r, i) => !i || list.rows[i - 1].t >= r.t);
const pos = list.rows.findIndex(r => r.id === made.id);
check(`by its latest word (the follow-up): row ${pos + 1} of ${list.rows.length}, ahead of everything older, unread, the follow-up as its snippet`,
  ordered && list.me?.unread && list.me.snip === made.text && list.rows.slice(pos + 1).every(r => r.t <= list.rows[pos].t));
const badge = await page.evaluate(() => document.getElementById('inbox-badge')?.textContent.trim());
check(`the badge counts it unread (${badge})`, badge === '1');
await page.tap(`.ml-row[data-open="${made.id}"]`); await page.waitForTimeout(500);
const read = await page.evaluate(() => ({ follow: document.querySelector('.mt-follow .mr-body')?.textContent.trim(), from: document.querySelector('.mt-follow .mr-name')?.textContent.trim(),
  first: document.querySelector('.mr > .mr-sender .mr-name')?.textContent.trim(), after: !!document.querySelector('.mr-body + .mt-follow') }));
check(`the reading view: the follow-up under the message, from ${read.from}`, read.follow === made.text && read.from === read.first && read.after);
await page.screenshot({ path: `${out}/follow-up-${theme}.png` });
await page.tap(`[data-resolve="${made.id}"][data-choice="yes"]`); await page.waitForTimeout(4500);
const left = await page.evaluate((id) => !!document.querySelector(`.ml-row[data-open="${id}"]`), made.id);
check('answered: the one message leaves the inbox', !left);
await page.tap('#itab-completed'); await page.waitForTimeout(400);
await page.evaluate((id) => document.querySelector(`.ml-row[data-open="${id}"]`)?.scrollIntoView({ block: 'center' }), made.id);
await page.tap(`.ml-row[data-open="${made.id}"]`);
await page.waitForTimeout(400);
const th = await page.evaluate(() => ({ parts: [...document.querySelectorAll('.mt-msg:not(.mi)')].map(e => e.classList.contains('mt-follow') ? 'follow' : e.classList.contains('mt-reply') ? 'reply' : 'msg') }));
check(`Completed keeps the thread: ${th.parts.join(' → ')}`, th.parts.join() === 'msg,follow,reply');
await page.screenshot({ path: `${out}/follow-up-done-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
