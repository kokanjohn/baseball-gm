// r264 §122.143 every Compose topic, sent through the screen: once its reply arrives it's no longer "awaiting reply";
// a topic with a wait says when it's back ("Available again Saturday") and is back five days on; the free-agent
// looks say when the next look comes; an old save's game-count wait doesn't shut a topic.
//   node tools/harness/test-compose-reopen-ui.mjs outDir [theme]
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
  // an old save's wait, counted in games (late last season): it doesn't shut the topic now
  SM.mutate(s => { s.settings.theme = theme; s.composeCooldowns = { mgr_morale: 158 }; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(300);
await page.tap('#itab-compose'); await page.waitForTimeout(300);
const tap = async (sel) => { await page.evaluate((s) => { document.querySelectorAll('.modal-overlay').forEach(o => o.remove()); document.querySelector(s)?.scrollIntoView({ block: 'center' }); }, sel); await page.tap(sel, { timeout: 5000 }); await page.waitForTimeout(200); };
const channels = await page.evaluate(() => [...document.querySelectorAll('[data-channel]')].map(e => e.dataset.channel));
const topicRow = (ch, id) => page.evaluate(({ id }) => {
  const rows = [...document.querySelectorAll('.compose-topic-btn')];
  const r = rows.find(x => x.dataset.topic === id) || rows.find(x => x.querySelector('span')?.textContent.trim() === id);
  return r ? { off: r.classList.contains('disabled'), note: r.querySelector('.topic-desc')?.textContent.trim() } : null;
}, { id });
const results = [];
for (const ch of channels) {
  await tap(`[data-channel="${ch}"]`);
  const topics = await page.evaluate(() => [...document.querySelectorAll('.compose-topic-btn')].map(r => ({ id: r.dataset.topic || null, label: r.querySelector('span')?.textContent.trim(), off: r.classList.contains('disabled'), note: r.querySelector('.topic-desc')?.textContent.trim() })));
  for (const t of topics) {
    if (!t.id) { results.push({ ch, label: t.label, before: `off: ${t.note}` }); continue; }
    await tap(`[data-topic="${t.id}"]`);
    if (await page.$('.compose-deal')) await tap('.compose-deal');
    if (await page.$('#compose-player')) { await page.selectOption('#compose-player', { index: 1 }); await page.waitForTimeout(250); }
    if (await page.$('.compose-skill[data-skill]')) await tap('.compose-skill[data-skill]');
    if (await page.$('[data-rank]')) await tap('[data-rank]');
    if (await page.$('[data-where]')) await tap('[data-where]');
    const ready = await page.evaluate(() => { const b = document.getElementById('compose-send-btn'); return b && !b.disabled; });
    if (!ready) { results.push({ ch, label: t.label, before: 'could not send' }); await page.evaluate(() => document.getElementById('compose-back')?.click()); await page.waitForTimeout(200); await tap(`[data-channel="${ch}"]`); continue; }
    await tap('#compose-send-btn');
    await page.waitForTimeout(300);
    // the reply arrives now (as it would at its time)
    const arrived = await page.evaluate(async (id) => {
      const SM = await import('/baseball-gm/store/StateManager.js'); const CE = await import('/baseball-gm/engine/CardEngine.js');
      const now = Date.now();
      SM.mutate(s => { for (const c of s.scheduledCards || []) if (c.isCompose && c._composeTopic === id) { c.deliverAtMs = now - 1000; c.deliveredAt = now - 1000; } });
      CE.releaseDueCards(now);
      return SM.get().inbox.some(c => c.isCompose && c._composeTopic === id);
    }, t.id);
    await page.waitForTimeout(300);
    if (!(await page.$(`[data-channel="${ch}"]`)) && !(await page.$('.compose-topic-btn'))) { await page.tap('#itab-compose'); await page.waitForTimeout(200); }
    if (await page.$(`[data-channel="${ch}"]`)) await tap(`[data-channel="${ch}"]`);
    const after = await topicRow(ch, t.id) || await topicRow(ch, t.label);
    // five days later (the wait set back five days; the moment it was asked kept to put back)
    const keep = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); const v = SM.get().composeCooldowns?.[id];
      if (Number.isFinite(v)) SM.mutate(s => { s.composeCooldowns[id] = v - 5 * 86_400_000; }); (await import('/baseball-gm/ui/screens/InboxScreen.js')).refresh(); return v; }, t.id);
    await page.waitForTimeout(200);
    const later = await topicRow(ch, t.id) || await topicRow(ch, t.label);
    await page.evaluate(async ({ id, v }) => { const SM = await import('/baseball-gm/store/StateManager.js'); if (Number.isFinite(v)) SM.mutate(s => { s.composeCooldowns[id] = v; }); (await import('/baseball-gm/ui/screens/InboxScreen.js')).refresh(); }, { id: t.id, v: keep });
    await page.waitForTimeout(150);
    results.push({ ch, label: t.label, id: t.id, arrived, after: after ? `${after.off ? 'OFF' : 'on'}: ${after.note}` : 'gone', later: later ? `${later.off ? 'OFF' : 'on'}: ${later.note}` : 'gone' });
  }
  await page.evaluate(() => document.getElementById('compose-back')?.click()); await page.waitForTimeout(200);
}
for (const r of results) console.log(`    ${r.ch.padEnd(16)} ${String(r.label).slice(0, 34).padEnd(34)} ${r.before ? `[${r.before}]` : `after reply → ${r.after} | 5 days on → ${r.later}`}`);
const sent = results.filter(r => !r.before);
check(`every topic sent got its reply and isn't "awaiting reply" once it came (${sent.length})`, sent.length >= 20 && sent.every(r => r.arrived && !/awaiting reply/.test(r.after)),
  sent.filter(r => !r.arrived || /awaiting reply/.test(r.after)).map(r => r.label).join(', '));
const waits = sent.filter(r => /^OFF: Available again/.test(r.after));
check(`a topic with a wait says the day it's back (${waits.length}: “${waits[0]?.after.slice(5)}”)`, waits.length >= 10 && waits.every(r => /^OFF: Available again (today|tomorrow|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|in \d+ days)$/.test(r.after)));
check('…and five days on, every one is open again', waits.every(r => /^on: /.test(r.later)), waits.filter(r => !/^on: /.test(r.later)).map(r => r.label).join(', '));
const fa = sent.find(r => /Free agents/.test(r.label));
// r265 §122.144 one report is one look (a few players): the topic stays open for the rest of the week's
check(`the free-agent looks: one report, the topic still open (“${fa?.after}”)`, !!fa && /^on: .*\d of \d looks left this week$/.test(fa.after) && !/ 0 of /.test(fa.after));
const morale = sent.find(r => /morale/i.test(r.label));
check('an old save\'s wait counted in games didn\'t shut its topic (sent from it)', !!morale && morale.arrived);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
