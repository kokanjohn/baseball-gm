// r150 In the real app: ask the Manager and the Scouting Director about a trade
// on the table (Compose → the person → the topic → which deal → Send), the
// replies come back before the deal is due, and the director's counter is a
// decision: adjust it in the composer, or send it as the next round.
//   node tools/harness/test-trade-advice-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', timezoneId: 'America/New_York' });
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
const deal = await page.evaluate(async () => {
  const TA = await import('/baseball-gm/engine/TradeAdvice.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  return TA.dealsOnTable(SM.get(), Date.now())[0] || null;
});
check(`a trade is on the table (“${deal?.label}”)`, !!deal);
await page.click('#itab-compose');
await page.waitForSelector('.compose-person', { timeout: 5000 });

// The manager.
await page.click('.compose-person[data-channel="manager"]');
await page.click('.compose-topic-btn[data-topic="mgr_trade"]');
await page.waitForTimeout(200);
const picker = await page.evaluate(() => ({
  deals: [...document.querySelectorAll('.compose-deal')].map(b => ({ text: b.textContent.replace(/\s+/g, ' ').trim(), sel: b.classList.contains('selected') })),
  send: document.getElementById('compose-send-btn')?.textContent.trim(),
}));
check(`the topic shows the deals on the table, with when each is due (${picker.deals.map(d => `“${d.text}”`).join(', ')})`,
      picker.deals.length >= 1 && picker.deals.every(d => /Answer due/.test(d.text)) && picker.deals.some(d => d.text.includes(deal.label)));
check(`one deal: picked already, ready to send (“${picker.send}”)`, picker.deals.length > 1 || (picker.deals[0].sel && picker.send === 'Send Message'));
await page.screenshot({ path: `${out}/trade-ask-manager-${theme}.png` });
await page.click('#compose-send-btn');
await page.waitForTimeout(300);

// The director.
await page.click('.compose-person[data-channel="scouting"]');
await page.click('.compose-topic-btn[data-topic="sc_trade"]');
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/trade-ask-director-${theme}.png` });
await page.click('#compose-send-btn');
await page.waitForTimeout(300);
const waiting = await page.$eval('.compose-waiting', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
check(`both wait under the deal's name (“${waiting}”)`, (waiting.match(new RegExp(deal.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 2);
await page.click('.compose-person[data-channel="scouting"]');
const note = await page.$eval('.compose-topic-btn.disabled[class*="compose-topic-btn"]', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
check(`asked: the topic says so (“${note}”)`, /awaiting reply|Already asked/.test(note));
await page.click('#compose-back');

// The replies come back before the deal is due; the director's until it carries a counter.
const got = await page.evaluate(async (deal) => {
  const CE = await import('/baseball-gm/engine/CardEngine.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  const pend = (SM.get().scheduledCards || []).filter(c => c.isCompose);
  const due = pend.map(c => c.deliverAtMs);
  CE.releaseDueCards(Math.max(...due));
  const find = (t) => SM.get().inbox.find(c => c.isCompose && c._composeTopic === t);
  let sc = find('sc_trade'), tries = 0;
  // (the read depends on the moment it's written: ask again until the director sees room for a counter)
  while (!sc?._ideaOffer && tries++ < 60) {
    SM.mutate(s => { s.inbox = s.inbox.filter(c => c !== sc && c.instanceId !== sc?.instanceId); s.composeLog = []; });
    const c = CE.deliverComposeCard('sc_trade', 'scouting', { topicLabel: deal.label, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId, expiresAtMs: deal.expiresAtMs }, nowMs: Date.now() + tries * 600_000 });
    CE.releaseDueCards(c.deliverAtMs);
    sc = find('sc_trade');
  }
  const mgr = find('mgr_trade');
  return { due, expires: deal.expiresAtMs, mgr: { id: mgr?.instanceId, body: mgr?.body, subject: mgr?.subject }, sc: { id: sc?.instanceId, body: sc?.body, counter: !!sc?._ideaOffer, offer: sc?._ideaOffer } };
}, deal);
check('both replies came back before the deal is due', got.due.every(t => t < got.expires));
check(`the manager's reply (“${got.mgr.subject}”) and the director's are in the inbox`, !!got.mgr.id && !!got.sc.id);
check('gender-neutral', !GEN.test(got.mgr.body + got.sc.body), ((got.mgr.body + got.sc.body).match(GEN) || []).join());
check('the director has a counter for us', got.sc.counter);
console.log('\n' + got.mgr.body + '\n\n' + got.sc.body + '\n');

// The manager's reply, opened.
await page.click('#itab-todo'); await page.waitForTimeout(300);
await page.click(`[data-open="${got.mgr.id}"]`); await page.waitForTimeout(400);
const mgrView = await page.evaluate(() => ({ links: document.querySelectorAll('.msg-player').length, buttons: [...document.querySelectorAll('.msg-choice, [data-resolve]')].map(b => b.textContent.trim()) }));
check(`the manager's reply links the players (${mgrView.links})`, mgrView.links >= 2);
await page.screenshot({ path: `${out}/trade-reply-manager-${theme}.png`, fullPage: true });
await page.click('#mr-back'); await page.waitForTimeout(300);

// The director's, opened: the decision.
if (got.sc.id) {
  await page.click(`[data-open="${got.sc.id}"]`); await page.waitForTimeout(400);
  const view = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('[data-resolve], [data-revise]')].map(b => b.textContent.trim()),
    text: document.body.innerText,
  }));
  check(`the counter is a decision (${view.buttons.join(' · ')})`, ['Counter with This', 'Not Now', 'Adjust It First'].every(l => view.buttons.includes(l)));
  await page.screenshot({ path: `${out}/trade-reply-director-${theme}.png` });
  await page.$eval('[data-revise]', el => el.scrollIntoView({ block: 'end' })); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/trade-reply-director-decision-${theme}.png` });
  // Adjust it first: the composer, with the counter in it.
  await page.click('[data-revise]'); await page.waitForTimeout(500);
  const tc = await page.evaluate(async (offer) => {
    const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
    const txt = document.getElementById('tc-body')?.innerText || '';
    return { open: !!document.getElementById('tc-body'), names: [...offer.incomingIds, ...offer.outgoingIds].map(id => s.players[id].name).filter(n => !txt.includes(n)) };
  }, got.sc.offer);
  check('Adjust It First opens the trade composer with the counter in it', tc.open && tc.names.length === 0, `missing ${tc.names.join(', ')}`);
  await page.screenshot({ path: `${out}/trade-counter-composer-${theme}.png` });
  await page.click('#tc-close'); await page.waitForTimeout(400);
  // Counter with this: the next round of the talks.
  await page.click(`[data-resolve="${got.sc.id}"][data-choice="yes"]`); await page.waitForTimeout(600);
  const sent = await page.evaluate(async (deal) => {
    const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
    const talk = s.tradeTalks?.[deal.teamId]?.talk;
    return { talk: talk && { round: talk.round, status: talk.status }, offerOpen: (s.inbox || []).some(c => c.instanceId === deal.instanceId && !c.resolved) };
  }, deal);
  check(`Counter with This sends it as round 2 of the talks (${JSON.stringify(sent.talk)}), replacing their offer`, sent.talk?.round === 2 && !sent.offerOpen);
  await page.screenshot({ path: `${out}/trade-counter-sent-${theme}.png` });
}
// r151 What could we get for…? — pick one of ours, the director calls around.
await page.click('#mr-back').catch(() => {}); await page.waitForTimeout(200);
await page.click('#itab-compose'); await page.waitForTimeout(200);
await page.click('.compose-person[data-channel="scouting"]');
await page.click('.compose-topic-btn[data-topic="sc_shop"]'); await page.waitForTimeout(200);
const opts = await page.$$eval('#compose-player option', os => os.map(o => ({ v: o.value, t: o.textContent })));
check(`the topic lists our players to shop (${opts.length - 1}), by name, position and rating`, opts.length > 10 && opts.slice(1).every(o => /^\S.* — [A-Z0-9/]+, OVR \d+$/.test(o.t)));
check(`Send waits for a player (“${await page.textContent('#compose-send-btn')}”)`, (await page.textContent('#compose-send-btn')).trim() === 'Pick a player');
const target = await page.evaluate(async () => {
  const TA = await import('/baseball-gm/engine/TradeAdvice.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  const s = SM.get(); let r = 1;
  for (const p of TA.shoppable(s, Date.now())) { const x = TA.shopPlayer(s, p.id, () => (r = (r * 9301 + 49297) % 233280) / 233280, Date.now()); if (x.bids.length) return { id: p.id, name: p.name }; }
  return null;
});
await page.selectOption('#compose-player', target.id); await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/trade-shop-pick-${theme}.png` });
await page.click('#compose-send-btn'); await page.waitForTimeout(300);
const shop = await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  const c = (SM.get().scheduledCards || []).find(x => x.isCompose && x._composeTopic === 'sc_shop');
  CE.releaseDueCards(c.deliverAtMs);
  const r = SM.get().inbox.find(x => x.instanceId === c.instanceId);
  return { id: r?.instanceId, subject: r?.subject, body: r?.body, offer: !!r?._ideaOffer };
});
check(`the director's answer: “${shop.subject}”`, shop.subject === `Re: What could we get for ${target.name}?` && /I called/.test(shop.body || ''));
console.log('\n' + shop.body + '\n');
await page.click('#itab-todo'); await page.waitForTimeout(300);
if (shop.id) {
  await page.click(`[data-open="${shop.id}"]`); await page.waitForTimeout(400);
  const btns = await page.$$eval('[data-resolve], [data-revise]', bs => bs.map(b => b.textContent.trim()));
  check(`an offer to make (${btns.join(' · ')})`, !shop.offer || ['Make the Offer', 'Not Now', 'Adjust It First'].every(l => btns.includes(l)));
  await page.screenshot({ path: `${out}/trade-shop-reply-${theme}.png` });
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
