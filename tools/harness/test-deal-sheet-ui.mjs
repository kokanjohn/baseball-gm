// r198 §122.75 In the real app: a trade message's "See the Deal" opens the deal as a table — what
// we get and what we send side by side, each player's salary and years, and the money under both.
// Also three a side (the most a deal holds), salary kept both ways and cash, to see it fits at 390px.
//   node tools/harness/test-deal-sheet-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
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
await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; s.push = { ...(s.push || {}), quietStart: '23:59', quietEnd: '00:00' }; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  App.switchTab('decisions');
}, { theme });

// A club's offer: "See the Deal" under the message.
const deal = await page.evaluate(async () => {
  const TA = await import('/baseball-gm/engine/TradeAdvice.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  return TA.dealsOnTable(SM.get(), Date.now())[0] || null;
});
check(`a trade is on the table (“${deal?.label}”)`, !!deal);
await page.click(`[data-open="${deal.instanceId}"]`); await page.waitForTimeout(300);
check('the offer has "See the Deal", above the decision', await page.evaluate(() => {
  const b = document.querySelector('[data-deal-sheet]'), r = document.querySelector('.mr-reply');
  return !!b && /See the Deal/.test(b.textContent) && !!(b.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING);
}));
await page.click('[data-deal-sheet]'); await page.waitForTimeout(500);
const sheet = await page.evaluate(() => {
  const s = document.querySelector('.ds-sheet');
  const names = (i) => [...s.querySelectorAll('.ds-col')[i].querySelectorAll('.ds-name')].map(b => b.textContent);
  return { get: names(0), send: names(1), heads: [...s.querySelectorAll('.ds-colh')].map(h => h.textContent),
           rows: [...s.querySelectorAll('.ds-row')].map(r => [...r.children].map(c => c.textContent.trim()).join(' ')),
           money: [...s.querySelectorAll('.ds-money tbody tr')].map(r => [...r.children].map(c => c.textContent.trim()).join(' ')) };
});
const SM = async () => page.evaluate(async () => { const S = await import('/baseball-gm/store/StateManager.js'); return S.get(); });
const st = await SM();
check(`the table: We Get ${sheet.get.join(', ')} | We Send ${sheet.send.join(', ') || '—'}`,
      sheet.heads.join() === 'We Get,We Send' && deal.offer.incomingIds.every(id => sheet.get.includes(st.players[id].name)) && deal.offer.outgoingIds.every(id => sheet.send.includes(st.players[id].name)));
check(`the money: ${sheet.money.join(' · ')}`, sheet.money.some(r => /^Salary a year/.test(r)) && sheet.money.some(r => /^Later seasons/.test(r)));
check(`the totals: ${sheet.rows.join(' · ')}`, sheet.rows.some(r => /^This season, net/.test(r)) && sheet.rows.some(r => /^Payroll after the deal .*target/.test(r)) && sheet.rows.some(r => /^Later seasons, net/.test(r)));
await page.screenshot({ path: `${out}/deal-sheet-offer-${theme}.png` });
await page.click('.ds-name'); await page.waitForTimeout(500);
check('a name opens the player', await page.evaluate(() => document.querySelectorAll('.modal-overlay').length >= 2));
await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(e => e.remove()));

// Three a side, salary kept both ways, cash to us: fits at 390px.
await page.evaluate(async () => {
  const S = await import('/baseball-gm/store/StateManager.js'); const st = S.get();
  const pick = (ids) => ids.map(id => st.players[id]).filter(p => p && p.contractSalary > 0 && !['SP', 'RP'].includes(p.pos)).sort((a, b) => b.contractSalary - a.contractSalary).slice(0, 3);
  const them = st.leagueTeams[3];
  const ins = pick(them.rosterIds), outs = pick(st.userTeam.rosterIds);
  const { openDealSheet } = await import('/baseball-gm/ui/components/DealSheet.js');
  openDealSheet({ offer: { incomingIds: ins.map(p => p.id), outgoingIds: outs.map(p => p.id), cashK: 250, retain: { [ins[0].id]: 0.5, [outs[1].id]: 0.25 } }, teamName: them.name });
});
await page.waitForTimeout(500);
const fit = await page.evaluate(() => {
  const s = document.querySelector('.ds-sheet');
  const cells = [...s.querySelectorAll('.ds-player')];
  const over = cells.filter(c => c.scrollWidth > c.clientWidth + 1).length;
  const names = [...s.querySelectorAll('.ds-name')].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent);
  return { cells: cells.length, over, cut: names, wide: s.scrollWidth > s.clientWidth + 1, kept: [...s.querySelectorAll('.ds-kept')].map(k => k.textContent),
           cash: [...s.querySelectorAll('.ds-row')].find(r => /^Cash/.test(r.textContent)) && [...[...s.querySelectorAll('.ds-row')].find(r => /^Cash/.test(r.textContent)).children].map(c => c.textContent.trim()).join(' ') };
});
check(`three a side fits: ${fit.cells} players, none spilling over (names cut: ${fit.cut.join(', ') || 'none'})`, fit.cells === 6 && fit.over === 0 && !fit.wide && fit.cut.length === 0);
check(`kept salary on both sides (${fit.kept.join(' / ')}), cash (${fit.cash})`, fit.kept.length === 2 && fit.kept.some(k => /^They keep/.test(k)) && fit.kept.some(k => /^We keep/.test(k)) && /\$250K to us/.test(fit.cash || ''));
await page.screenshot({ path: `${out}/deal-sheet-three-${theme}.png` });
await page.evaluate(() => document.querySelector('.ds-sheet').scrollTo(0, 9999)); await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/deal-sheet-three-totals-${theme}.png` });
await page.click('#ds-close'); await page.waitForTimeout(200);
check('Close closes it', await page.evaluate(() => !document.getElementById('ds-overlay')));

// A message with no deal: no button.
await page.click('#mr-back').catch(() => {}); await page.waitForTimeout(200);
const other = await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js'); const TE = await import('/baseball-gm/engine/TradeEngine.js'); const S = await import('/baseball-gm/store/StateManager.js');
  return CE.getInbox().find(c => !c.resolved && !TE.dealOfCard(S.get(), c))?.instanceId;
});
if (other) {
  await page.click(`[data-open="${other}"]`); await page.waitForTimeout(300);
  check('a message with no deal has no "See the Deal"', !(await page.$('[data-deal-sheet]')));
}
check(`no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`, errors.length === 0);
await browser.close();
process.exit(ok ? 0 : 1);
