// r175 Sideways: with the phone on its side, Team and League spread to the full width and the
// header and nav slim down; the other screens keep the phone-width column. Upright, the Team
// screen's name column is narrower (the wear bar sits right after the name), and the card's
// Wear note states the status only (no age line).
//   node tools/harness/test-landscape-ui.mjs outDir [theme]
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
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);

// ── Upright: Team ──
await page.tap('.nav-item[data-tab="roster"]'); await page.waitForTimeout(600);
const up = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tr-row[data-player]')];
  const gaps = rows.map(r => {
    const line = r.querySelector('.tr-name-line'), bar = r.querySelector('.tr-wearc');
    const rg = document.createRange(); rg.selectNodeContents(line);
    return Math.round(bar.getBoundingClientRect().left - Math.min(rg.getBoundingClientRect().right, line.getBoundingClientRect().right));
  });
  const cut = rows.filter(r => { const l = r.querySelector('.tr-name-line'); return l.scrollWidth > l.clientWidth + 1; }).length;
  return { fz: document.querySelector('.tr-row .tr-fz').getBoundingClientRect().width, nm: document.querySelector('.tr-row .tr-name').getBoundingClientRect().width, gaps, cut, rows: rows.length,
           body: document.body.getBoundingClientRect().width };
});
const minGap = Math.min(...up.gaps);   // after the longest name
check(`upright: the name column is ${up.nm}px (was 98), the frozen part ${up.fz}px (was 262); after the longest name the wear bar is ${minGap}px away`, up.nm <= 78 && up.fz <= 242);
check(`upright: ${up.cut} of ${up.rows} names cut short`, up.cut <= Math.ceil(up.rows * 0.25));
await page.screenshot({ path: `${out}/landscape-team-upright-${theme}.png` });

// ── Card: Wear note without the age line ──
await page.tap('.tr-row[data-player] .tr-name'); await page.waitForTimeout(600);
const note = await page.evaluate(() => {
  const lab = [...document.querySelectorAll('.pc-section-label')].find(l => l.textContent.trim() === 'Wear');
  return lab?.parentElement.querySelector('.pc-ask-note')?.textContent.trim() || '';
});
check(`card Wear note states the status only: "${note}"`, note.length > 0 && !/\bAt \d+/.test(note) && !/builds (slower|faster)/.test(note));
await page.evaluate(() => document.querySelector('.modal-overlay.open')?.click());
await page.keyboard.press('Escape').catch(() => {});
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('dashboard'); });
await page.waitForTimeout(300);

// ── Sideways ──
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(400);
const chrome = () => page.evaluate(() => ({
  body: Math.round(document.body.getBoundingClientRect().width),
  head: Math.round(document.querySelector('.app-header').getBoundingClientRect().height),
  nav: Math.round(document.querySelector('.bottom-nav').getBoundingClientRect().height),
}));
const dash = await chrome();
check(`sideways, Dashboard: the phone-width column (${dash.body}px), slim header ${dash.head}px and nav ${dash.nav}px`, dash.body <= 430 && dash.head <= 46 && dash.nav <= 44);
await page.screenshot({ path: `${out}/landscape-dashboard-${theme}.png` });

await page.tap('.nav-item[data-tab="roster"]'); await page.waitForTimeout(600);
const team = await page.evaluate(() => {
  const sc = document.querySelector('.tr-scroll');
  return { body: Math.round(document.body.getBoundingClientRect().width), sc: Math.round(sc.getBoundingClientRect().width),
           hidden: sc.scrollWidth - sc.clientWidth };
});
check(`sideways, Team: full width (${team.body}px), the table ${team.sc}px wide, ${team.hidden}px left to scroll`, team.body >= 840 && team.sc >= 800);
await page.screenshot({ path: `${out}/landscape-team-${theme}.png` });

await page.tap('.nav-item[data-tab="league"]'); await page.waitForTimeout(400);
const tab = await page.$('#ltab-players'); if (tab) { await tab.tap(); await page.waitForTimeout(500); }
const league = await page.evaluate(() => {
  const sc = document.querySelector('.lp-scroll-wrap');
  return { body: Math.round(document.body.getBoundingClientRect().width), sc: Math.round(sc.getBoundingClientRect().width),
           hidden: sc.scrollWidth - sc.clientWidth };
});
check(`sideways, League players: full width (${league.body}px), the table ${league.sc}px wide, ${league.hidden}px left to scroll`, league.body >= 840 && league.sc >= 800);
await page.screenshot({ path: `${out}/landscape-league-${theme}.png` });

// Back upright: the column comes back.
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
const back = await chrome();
check(`upright again: ${back.body}px wide, header ${back.head}px`, back.body <= 390 && back.head >= 50);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
