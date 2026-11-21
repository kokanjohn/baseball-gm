// r224 §122.103 In the real app: Team → Finances → the Payroll card says it can be selected; selecting it opens the
// breakdown — players (highest paid first, a share another club pays, a player retiring), traded away, staff —
// and a player opens their card.
//   node tools/harness/test-payroll-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', timezoneId: 'America/New_York' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const set = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const F = await import('/baseball-gm/engine/FinanceEngine.js');
  const R = await import('/baseball-gm/engine/Retirement.js');
  let o = {};
  SM.mutate(s => {
    s.settings.theme = theme; s.phase = 'REGULAR_SEASON'; R.settlePlans(s);
    const rows = F.payrollBreakdown(s).players;
    const top = rows[0].id, ret = rows[1].id, other = s.leagueTeams[0];
    F.retainSalary(s, other.id, top, 0.25);
    s.players[ret].contractExpiry = (s.seasonNum || 1) + 2;
    s.players[ret].retireIntent = { season: s.seasonNum || 1, retiring: true, tell: 10, told: true };
    F.retainSalary(s, 'user', other.rosterIds[0], 0.4);
    o = { top, topName: s.players[top].name, ret, retName: s.players[ret].name, club: other.name, awayName: s.players[other.rosterIds[0]].name };
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return o;
}, { theme });
await page.waitForTimeout(800);
await page.click('.nav-item[data-tab="roster"]');
await page.waitForTimeout(450);
await page.click('#tsubtab-finances');
await page.waitForSelector('#fin-payroll-card', { timeout: 5000 });
const cardTxt = (await page.textContent('#fin-payroll-card')).replace(/\s+/g, ' ').trim();
check(`the Payroll card says it can be selected (“${cardTxt.slice(-30)}”)`, /Select to see a breakdown/.test(cardTxt));
await page.$eval('#fin-payroll-card', el => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${out}/payroll-card-${theme}.png` });
await page.click('#fin-payroll-card');
await page.waitForSelector('.pay-sheet', { timeout: 5000 });
await page.waitForTimeout(400);
const sheet = await page.evaluate(() => ({
  heads: [...document.querySelectorAll('.pay-head')].map(h => h.textContent.replace(/\s+/g, ' ').trim()),
  rows: [...document.querySelectorAll('.pay-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
  sub: document.querySelector('#ts-swap-modal .modal-header')?.textContent.replace(/\s+/g, ' ').trim(),
}));
check(`sections: ${sheet.heads.join(' | ')}`, /^Players/.test(sheet.heads[0] || '') && sheet.heads.some(h => /^Traded away/.test(h)) && sheet.heads.some(h => /^Staff/.test(h)));
check(`the header: “${sheet.sub}”`, /this season · .* committed for next season/.test(sheet.sub || ''));
const topRow = sheet.rows.find(r => r.startsWith(set.topName));
check(`a share another club pays: “${topRow}”`, new RegExp(`The ${set.club} pay 25% of`).test(topRow || ''));
const retRow = sheet.rows.find(r => r.startsWith(set.retName));
check(`a player retiring: “${retRow}”`, /This season only · retiring/.test(retRow || ''));
check('traded away: our share', sheet.rows.some(r => r.startsWith(set.awayName) && /we pay 40% this season/.test(r)));
await page.screenshot({ path: `${out}/payroll-sheet-${theme}.png` });
await page.evaluate(() => document.querySelector('.pay-head:last-of-type')?.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/payroll-sheet-staff-${theme}.png` });
await page.click(`.pay-row[data-pid="${set.ret}"]`);
await page.waitForTimeout(600);
const pc = await page.evaluate(() => document.body.innerText.includes('Retiring after the season'));
check('a player opens their card', pc);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
