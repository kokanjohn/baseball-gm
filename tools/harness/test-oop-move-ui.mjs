// r165 §122.35 MOVE with out-of-position spots: the eligible spots first; "Show out-of-position spots
// (N)" below them opens the rest (each marked, with how familiar he is there); choosing one puts him
// there and the Team row says "out of position".
//   node tools/harness/test-oop-move-ui.mjs outDir [theme]
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
await page.clock.setFixedTime(Date.now());
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const S = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const id = SM.get().userTeam.lineupSlots.find(s => s.slot === '1B').playerId;
  SM.mutate(s => { s.settings.theme = theme; const p = s.players[id]; p.positions.primary = '1B'; p.positions.elig = ['1B']; p.pos = p.nativePos = '1B'; p.positions.fam = { '3B': 0.3 }; });
  return { id, name: SM.get().players[id].name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="roster"]');
await tap(`.tr-move[data-move="${S.id}"]`);
const sheet = await page.evaluate(() => ({
  visible: [...document.querySelectorAll('.sm-row[data-key]')].filter(r => r.offsetParent).map(r => r.querySelector('.sm-slot-label').textContent.trim()),
  btn: document.querySelector('.sm-oop-toggle')?.textContent.trim() || '',
  hidden: document.querySelector('.sm-oop-list')?.hidden,
}));
check(`the sheet: the eligible spots shown (${sheet.visible.join(', ')})`, sheet.visible.length > 0 && !sheet.visible.some(x => ['C', '2B', '3B', 'SS', 'OF'].includes(x)));
check(`…"${sheet.btn}" below them, the rest hidden`, /^Show out-of-position spots \(\d+\)$/.test(sheet.btn) && sheet.hidden === true);
await page.screenshot({ path: `${out}/oop-move-closed-${theme}.png` });
await tap('.sm-oop-toggle');
const open = await page.evaluate(() => [...document.querySelectorAll('.sm-oop-list .sm-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
check(`tapped: each marked, how familiar he is — ${open.slice(0, 3).join(' | ')}`, open.length >= 5 && open.every(x => /Out of position/i.test(x)) && open.some(x => /^3B .*practiced/i.test(x)) && open.some(x => /unfamiliar/.test(x)));
await page.screenshot({ path: `${out}/oop-move-open-${theme}.png` });
await tap('.sm-oop-list .sm-row[data-key^="oop:"]:has(.sm-slot-label:text-is("3B"))');
await page.waitForTimeout(500);
const row = await page.evaluate((id) => {
  const r = document.querySelector(`.tr-row[data-player="${id}"]`);
  return { slot: r?.querySelector('.tr-slot')?.textContent.trim(), sub: r?.innerText || '' };
}, S.id);
check(`chosen: ${S.name} plays 3B, "out of position" on the row`, row.slot === '3B' && /out of position/.test(row.sub));
await page.screenshot({ path: `${out}/oop-move-row-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
