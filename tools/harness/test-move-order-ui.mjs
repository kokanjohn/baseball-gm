// r286 §122.165 the Move sheet lists players in the Team screen's order: a bench outfielder's "Play at" spots have the
// three OF spots by their outfielder's OVR (as the Team screen lists them); who could come in, by OVR; a pitcher's
// rotation and bullpen spots by OVR.
//   node tools/harness/test-move-order-ui.mjs outDir [theme]
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
const S = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const s0 = SM.get(), slots = s0.userTeam.lineupSlots;
  // the three outfielders out of OVR order in the lineup (lowest in the first OF spot)
  const ofIdx = slots.map((sl, i) => (sl.slot === 'OF' ? i : -1)).filter(i => i >= 0);
  const ids = ofIdx.map(i => slots[i].playerId);
  SM.mutate(s => { s.settings.theme = theme; [80, 72, 64].forEach((o, k) => { s.players[ids[2 - k]].ovr = o; }); });
  const seated = new Set(slots.map(sl => sl.playerId));
  const benchOf = s0.userTeam.rosterIds.map(id => s0.players[id]).find(p => !seated.has(p.id) && p.group === 'bh' && (p.positions?.elig || []).includes('OF'))
               || s0.userTeam.rosterIds.map(id => s0.players[id]).find(p => !seated.has(p.id) && p.group === 'bh');
  if (benchOf) SM.mutate(s => { const p = s.players[benchOf.id]; p.positions.primary = 'OF'; p.positions.elig = ['OF']; p.pos = p.nativePos = 'OF'; });
  return { bench: benchOf?.id, sp: SM.get().userTeam.rotation.order[0] };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.evaluate((sel) => document.querySelector(sel)?.click(), sel); await page.waitForTimeout(450); };
await page.evaluate(async () => (await import('/baseball-gm/ui/App.js')).switchTab('roster')); await page.waitForTimeout(500);

// the Team screen's outfield order
const teamOf = await page.evaluate(() => [...document.querySelectorAll('.tr-row[data-player]')]
  .filter(r => /^OF/.test(r.querySelector('.tr-slot')?.textContent.trim() || ''))
  .map(r => r.querySelector('.tr-name-line')?.textContent.trim()).filter(Boolean));
await tap(`.tr-move[data-move="${S.bench}"]`);
const sheet = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#ts-swap-modal .sm-head')];
  const rows = [...document.querySelectorAll('#ts-swap-modal .sm-row[data-key^="slot:"]')].filter(r => r.offsetParent);
  return rows.filter(r => r.querySelector('.sm-pick-name')?.textContent.trim() === 'OF')
    .map(r => ({ who: r.querySelector('.sm-pick-sub')?.textContent.replace(/^(For|Swap with) /, '').trim(), ovr: +r.querySelector('.sm-pick-ovr')?.textContent }));
});
console.log(`    Team screen OF: ${teamOf.join(', ')}; Move sheet OF: ${sheet.map(x => `${x.who} ${x.ovr}`).join(', ')}`);
check('a bench outfielder\'s "Play at": the OF spots by OVR, highest first', sheet.length === 3 && sheet.every((x, i) => !i || sheet[i - 1].ovr >= x.ovr));
check('…in the Team screen\'s order', teamOf.length === 3 && teamOf.slice(0, 3).join() === sheet.map(x => x.who).join());
await page.screenshot({ path: `${out}/move-order-${theme}.png` });
await page.evaluate(() => document.getElementById('ts-swap-modal')?.remove());

// a pitcher on the pitcher bench: the rotation and the bullpen by OVR
const pb = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); return s.userTeam.rosterIds.find(id => s.players[id]?.group === 'pb'); });
await tap(`.tr-move[data-move="${pb}"]`);
const pit = await page.evaluate(() => {
  const groups = {};
  let head = null;
  for (const el of document.querySelectorAll('#ts-swap-modal .sm-head, #ts-swap-modal .sm-row')) {
    if (el.classList.contains('sm-head')) { head = el.textContent.trim(); continue; }
    if (!el.offsetParent) continue;
    (groups[head] ||= []).push(+el.querySelector('.sm-pick-ovr')?.textContent || -1);
  }
  return groups;
});
const sorted = Object.values(pit).every(v => v.every((x, i) => !i || v[i - 1] >= x));
check(`a pitcher-bench arm's sheet: each group by OVR (${Object.entries(pit).map(([h, v]) => `${h}: ${v.join('/')}`).join(' · ')})`, sorted);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
