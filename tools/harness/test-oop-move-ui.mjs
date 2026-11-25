// r165 §122.35 MOVE with out-of-position spots: the eligible spots first; "Show out-of-position spots
// (N)" below them opens the rest (each marked, with how familiar he is there); choosing one puts him
// there and the Team row says "out of position".
//   node tools/harness/test-oop-move-ui.mjs outDir [theme]
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
  visible: [...document.querySelectorAll('.sm-row[data-key]')].filter(r => r.offsetParent).map(r => r.querySelector('.sm-pick-name').textContent.trim()),
  btn: document.querySelector('.sm-oop-toggle')?.textContent.trim() || '',
  hidden: document.querySelector('.sm-oop-list')?.hidden,
}));
check(`the sheet: the eligible spots shown (${sheet.visible.join(', ')})`, sheet.visible.length > 0 && !sheet.visible.some(x => ['C', '2B', '3B', 'SS', 'OF'].includes(x)));
check(`…"${sheet.btn}" below them, the rest hidden`, /^Out of position \(\d+\)$/.test(sheet.btn) && sheet.hidden === true);
await page.screenshot({ path: `${out}/oop-move-closed-${theme}.png` });
await tap('.sm-oop-toggle');
const open = await page.evaluate(() => [...document.querySelectorAll('.sm-oop-list .sm-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
// r263 §122.142 under the button: the spot, who's there and their OVR, no words about familiarity
check(`tapped: the spots, no familiarity words — ${open.slice(0, 3).join(' | ')}`, open.length >= 5 && !open.some(x => /practiced|unfamiliar|\d+ of \d+/i.test(x)));
const bars = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#ts-swap-modal .sm-row')].filter(r => r.querySelector('.sm-pick-ovr')).length,
  withBar: [...document.querySelectorAll('#ts-swap-modal .sm-row')].filter(r => r.querySelector('.sm-pick-ovr') && r.querySelector('.sm-rate .tr-wear .tr-wear-bar i')).length,
  me: !!document.querySelector('#ts-swap-modal .sm-sub-me .tr-wear-bar i') }));
check(`a wear bar beside every OVR (${bars.withBar} of ${bars.rows}) and the player's own under his name`, bars.rows > 0 && bars.withBar === bars.rows && bars.me);
await page.screenshot({ path: `${out}/oop-move-open-${theme}.png` });
await tap('.sm-oop-list .sm-row[data-key^="oop:"]:has(.sm-pick-name:text-is("3B"))');
await page.waitForTimeout(500);
const row = await page.evaluate((id) => {
  const r = document.querySelector(`.tr-row[data-player="${id}"]`);
  const slot = r?.querySelector('.tr-slot');
  return { slot: slot?.firstChild?.textContent.trim(), red: !!slot?.classList.contains('tr-oop'), mark: !!slot?.querySelector('.tr-oop-mark'), sub: r?.querySelector('.tr-sub')?.innerText || '' };
}, S.id);
// r237 §122.116 a red slot and a "!" to tap; no words in the name column
check(`chosen: ${S.name} plays 3B, the slot red with a "!", no words in the name column`, row.slot === '3B' && row.red && row.mark && !/out of position/i.test(row.sub), JSON.stringify(row));
await tap(`.tr-row[data-player="${S.id}"] .tr-oop-mark`);
await page.waitForTimeout(400);
const toast = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
check(`tapping the "!": “${toast.trim()}”`, /out of position at 3B/.test(toast));
const cardOpen = await page.evaluate(() => !!document.querySelector('#player-card-overlay.open'));
check('…and the player card stays closed', !cardOpen);
await page.screenshot({ path: `${out}/oop-move-row-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
