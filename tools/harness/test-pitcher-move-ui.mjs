// r167 §122.35 MOVE for a pitcher: the moves in his role first; "Show out-of-role spots (N)" opens the
// rotation for a reliever (each with how far stretched out); choosing one puts the reliever in the
// rotation and the Team row says "out of role". The player card's Roles section: designations, the
// one being earned, how stretched out.
//   node tools/harness/test-pitcher-move-ui.mjs outDir [theme]
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
  btn: document.querySelector('.sm-oop-toggle')?.textContent.trim() || '',
  hidden: document.querySelector('.sm-oop-list')?.hidden,
}));
check(`the sheet: the bullpen moves shown (${sheet.visible.length}), no rotation`, sheet.visible.length > 0 && !sheet.visible.some(x => /^Rotation/.test(x)));
check(`…"${sheet.btn}" below them, the rest hidden`, /^Show out-of-role spots \(\d+\)$/.test(sheet.btn) && sheet.hidden === true);
await tap('.sm-oop-toggle');
const open = await page.evaluate(() => [...document.querySelectorAll('.sm-oop-list .sm-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
check(`tapped: the rotation, how far stretched out — ${open[0]}`, open.length >= 4 && open.every(x => /^Rotation/.test(x) && /stretched out 1 of 3/.test(x)));
await page.screenshot({ path: `${out}/pitcher-move-open-${theme}.png` });
await tap('.sm-oop-list .sm-row[data-key^="turn:"]');
await page.waitForTimeout(500);
const row = await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"]`)?.innerText || '', S.id);
check(`chosen: ${S.name} in the rotation, "out of role" on the row`, /out of role/.test(row));
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
