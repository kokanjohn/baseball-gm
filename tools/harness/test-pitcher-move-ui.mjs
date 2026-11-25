// r167 §122.35 MOVE for a pitcher: the moves in his role first; "Show out-of-role spots (N)" opens the
// rotation for a reliever (each with how far stretched out); choosing one puts the reliever in the
// rotation and the Team row says "out of role". The player card's Roles section: designations, the
// one being earned, how stretched out.
//   node tools/harness/test-pitcher-move-ui.mjs outDir [theme]
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
  const st = SM.get();
  const rp = st.userTeam.rosterIds.map(id => st.players[id]).filter(p => p.group === 'bp' && p.pos === 'RP').sort((a, b) => b.ovr - a.ovr)[0];
  SM.mutate(s => { s.settings.theme = theme; const p = s.players[rp.id]; p.positions = { primary: 'RP', roles: ['RP'], stretch: 1, starts: 0, relief: 0 }; p.pos = p.nativePos = 'RP'; });
  return { id: rp.id, name: rp.name };
}, theme);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="roster"]');
await tap(`.tr-move[data-move="${S.id}"]`);
const sheet = await page.evaluate(() => ({
  visible: [...document.querySelectorAll('.sm-row[data-key]')].filter(r => r.offsetParent).map(r => r.innerText.replace(/\s+/g, ' ').trim()),
  heads: [...document.querySelectorAll('.sm-head')].filter(r => r.offsetParent).map(r => r.textContent.trim()),
  btn: document.querySelector('.sm-oop-toggle')?.textContent.trim() || '',
  hidden: document.querySelector('.sm-oop-list')?.hidden,
}));
check(`the sheet: the bullpen moves shown (${sheet.visible.length}; ${sheet.heads.join(', ')}), no rotation`, sheet.visible.length > 0 && sheet.heads.includes('Replace in the bullpen') && !sheet.heads.includes('Into the rotation'));
check(`…"${sheet.btn}" below them, the rest hidden`, /^Out of role \(\d+\)$/.test(sheet.btn) && sheet.hidden === true);
await tap('.sm-oop-toggle');
const open = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.sm-oop-list .sm-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()),
  heads: [...document.querySelectorAll('.sm-oop-list .sm-head')].map(r => r.textContent.trim()) }));
// r263 §122.142 no words about the role on the row ("stretched out 1 of 3", "a starter in relief"); a wear bar beside the OVR
check(`tapped: into the rotation, no role words — ${open.rows[0]}`, open.rows.length >= 4 && open.heads.join() === 'Into the rotation' && !open.rows.some(x => /stretched|starter in relief|short start/i.test(x)));
const pb = await page.evaluate(() => [...document.querySelectorAll('#ts-swap-modal .sm-row')].filter(r => r.querySelector('.sm-pick-ovr')).map(r => !!r.querySelector('.sm-rate .tr-wear-bar i')));
check(`a wear bar beside every OVR (${pb.filter(Boolean).length} of ${pb.length})`, pb.length > 0 && pb.every(Boolean));
await page.screenshot({ path: `${out}/pitcher-move-open-${theme}.png` });
await tap('.sm-oop-list .sm-row[data-key^="turn:"]');
await page.waitForTimeout(500);
const row = await page.evaluate((id) => { const r = document.querySelector(`.tr-row[data-player="${id}"]`);
  return { mark: r?.querySelector('.tr-slot.tr-oop .tr-oop-mark')?.dataset.oop || '', sub: r?.querySelector('.tr-sub')?.innerText || '' }; }, S.id);
check(`chosen: ${S.name} in the rotation, a red "!" (“${row.mark}”), no words in the name column`, /out of role in the rotation/.test(row.mark) && !/out of role/.test(row.sub));
await page.screenshot({ path: `${out}/pitcher-move-row-${theme}.png` });
await tap(`.tr-row[data-player="${S.id}"] .tr-name`);
const card = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('#player-card-sheet .pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Roles');
  return sec ? sec.innerText.replace(/\s+/g, ' ').trim() : null;
});
check(`the card's Roles: ${card}`, !!card && /RP/.test(card) && /Stretched out 1 of 3/.test(card));
await page.evaluate(() => document.querySelector('#player-card-sheet .pc-section-label:is(*)') && [...document.querySelectorAll('#player-card-sheet .pc-section')].find(s => s.querySelector('.pc-section-label')?.textContent.trim() === 'Roles')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/pitcher-roles-card-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
