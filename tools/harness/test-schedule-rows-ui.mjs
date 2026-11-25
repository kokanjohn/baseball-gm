// r266 §122.145 Schedule: every game card the same height — the opponent and its tags (ST, DH, MAKEUP, the series)
// on one line, a long name shortened ("…") rather than the tag dropping to a line of its own.
//   node tools/harness/test-schedule-rows-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
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
await page.tap('.nav-item[data-tab="schedule"]'); await page.waitForTimeout(600);
const m = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.game-item')].filter(r => r.offsetParent && !r.querySelector('.game-wx-notes'));
  return rows.map(r => {
    const opp = r.querySelector('.game-opp'), name = r.querySelector('.game-opp-name'), tags = [...r.querySelectorAll('.game-opp .game-badge')];
    const line = parseFloat(getComputedStyle(opp).lineHeight) || 20;
    return { fc: !!r.querySelector('.game-fc'), h: Math.round(r.getBoundingClientRect().height), oppH: Math.round(opp.getBoundingClientRect().height), line,
             tags: tags.map(t => t.textContent.trim()), cut: name.scrollWidth > name.clientWidth + 1,
             tagTop: tags.length ? Math.round(tags[0].getBoundingClientRect().top - name.getBoundingClientRect().top) : 0, name: name.textContent.trim() };
  });
});
const tagged = m.filter(r => r.tags.length);
// (cards with a forecast line — the next week's games — have that line; the rest don't)
const hf = [...new Set(m.filter(r => r.fc).map(r => r.h))], hn = [...new Set(m.filter(r => !r.fc).map(r => r.h))];
check(`cards alike are one height: with a forecast (${m.filter(r => r.fc).length}) ${hf.join(', ')}; without (${m.filter(r => !r.fc).length}) ${hn.join(', ')}`,
  m.length >= 8 && hf.length <= 1 && hn.length <= 1, JSON.stringify(m.map(r => [r.name, r.fc, r.h])));
check(`the opponent line stays one line, the tag beside the name (${tagged.length})`, tagged.length > 0 && tagged.every(r => r.oppH <= r.line * 1.4 && Math.abs(r.tagTop) < 12));
console.log(`    shortened at 360px: ${m.filter(r => r.cut).map(r => r.name).join(', ') || 'none'}`);
await page.screenshot({ path: `${out}/schedule-rows-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
