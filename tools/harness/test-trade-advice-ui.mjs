// r150 In the real app: ask about a trade on the table; r202 §122.79 one person, the Scouting Director
// (the manager's read of the field passed on by name): from the offer itself (Ask the Director) or from
// Compose (the person → the topic → which deal → Send). The reply comes back before the deal is due; its
// deal table switches between the deal as offered and our counter; the counter is a decision: adjust it
// in the composer, or send it as the next round.
//   node tools/harness/test-trade-advice-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
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
const deal = await page.evaluate(async () => {
  const TA = await import('/baseball-gm/engine/TradeAdvice.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  return TA.dealsOnTable(SM.get(), Date.now())[0] || null;
});
check(`a trade is on the table (“${deal?.label}”)`, !!deal);
// r152 the offer itself: every player in the deal is a link to the player's card.
await page.click(`[data-open="${deal.instanceId}"]`); await page.waitForTimeout(300);
const offerLinks = await page.$$eval('.msg-player', bs => bs.map(b => b.dataset.msgPlayer));
const inDeal = [...deal.offer.incomingIds, ...deal.offer.outgoingIds];
check(`the offer links every player in the deal (${offerLinks.length} links)`, inDeal.every(id => offerLinks.includes(id)));
await page.click(`.msg-player[data-msg-player="${inDeal[0]}"]`); await page.waitForTimeout(400);
check('…and a tap opens the player', await page.evaluate(() => !!document.querySelector('.modal-sheet, .player-modal, [class*="player-card"]')));
await page.screenshot({ path: `${out}/trade-offer-links-${theme}.png` });
await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach(e => e.remove()));
await page.click('#mr-back').catch(() => {}); await page.waitForTimeout(200);
// r202 / r208 §122.86 the offer itself: Ask Scouting. Asked from the counter screen, it's asked everywhere.
await page.click(`[data-open="${deal.instanceId}"]`); await page.waitForTimeout(300);
const btnOf = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel); return b ? { text: b.textContent.trim(), off: b.disabled } : null; }, sel);
const msgBtn = `#inbox-content [data-ask-scouting="${deal.key}"]`;
check('the offer has Ask Scouting', JSON.stringify(await btnOf(msgBtn)) === JSON.stringify({ text: 'Ask Scouting', off: false }), JSON.stringify(await btnOf(msgBtn)));
await page.$eval(msgBtn, el => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${out}/trade-ask-director-button-${theme}.png` });
// Counter: the trade composer's button is the same question about the same deal.
await page.click(`[data-revise="${deal.instanceId}"]`); await page.waitForTimeout(500);
const tcBtn = `#tc-overlay [data-ask-scouting="${deal.key}"]`;
check('counter: the composer has Ask Scouting (about this deal)', JSON.stringify(await btnOf(tcBtn)) === JSON.stringify({ text: 'Ask Scouting', off: false }), JSON.stringify(await btnOf(tcBtn)));
await page.click(tcBtn); await page.waitForTimeout(500);
const asked = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const c = (SM.get().scheduledCards || []).find(x => x.isCompose && x._composeTopic === 'sc_trade');
  return { key: c?._composeArg?.key, read: !!document.querySelector('#tc-overlay .tc-read') };
});
check(`…which sends the question with the deal picked (${asked.key}), a message to come (no read on the spot)`, asked.key === deal.key && !asked.read, JSON.stringify(asked));
check('…and reads Scouting Asked, disabled', JSON.stringify(await btnOf(tcBtn)) === JSON.stringify({ text: 'Scouting Asked', off: true }), JSON.stringify(await btnOf(tcBtn)));
await page.screenshot({ path: `${out}/trade-ask-composer-${theme}.png` });
await page.click('#tc-close'); await page.waitForTimeout(300);
check('back on the message: Scouting Asked, disabled', JSON.stringify(await btnOf(msgBtn)) === JSON.stringify({ text: 'Scouting Asked', off: true }), JSON.stringify(await btnOf(msgBtn)));
await page.click('#mr-back').catch(() => {}); await page.waitForTimeout(200);
await page.click('#itab-compose');
await page.waitForSelector('.compose-person', { timeout: 5000 });

// Compose: the manager no longer has a trade topic; the director's is “A trade on the table”.
await page.click('.compose-person[data-channel="manager"]');
check('the manager has no trade topic', !(await page.$('.compose-topic-btn[data-topic="mgr_trade"]')));
await page.click('#compose-back').catch(() => {}); await page.waitForTimeout(200);
await page.click('.compose-person[data-channel="scouting"]');
const topic = await page.$$eval('.compose-topic-btn', els => els.map(el => el.textContent.replace(/\s+/g, ' ').trim()).find(t => /A trade on the table/.test(t)) || '');   // (asked: disabled, no data-topic)
check(`the director's topic: “${topic}” — asked already`, /A trade on the table/.test(topic) && /awaiting reply|Already asked/.test(topic));
await page.screenshot({ path: `${out}/trade-ask-director-${theme}.png` });
await page.click('#compose-back').catch(() => {});

// The reply comes back before the deal is due; until it carries a counter.
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
  return { due, expires: deal.expiresAtMs, sc: { id: sc?.instanceId, body: sc?.body, counter: !!sc?._ideaOffer, offer: sc?._ideaOffer } };
}, deal);
check('the reply came back before the deal is due', got.due.every(t => t < got.expires));
check('gender-neutral', !GEN.test(got.sc.body || ''), ((got.sc.body || '').match(GEN) || []).join());
check('the director has a counter for us', got.sc.counter);
check('…and passes on the manager\'s read of the field', /read on the field: /.test(got.sc.body || ''));
console.log('\n' + got.sc.body + '\n');
await page.click('#itab-todo'); await page.waitForTimeout(300);

// The director's, opened: the decision.
if (got.sc.id) {
  await page.click(`[data-open="${got.sc.id}"]`); await page.waitForTimeout(400);
  const view = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('[data-resolve], [data-revise]')].map(b => b.textContent.trim()),
    text: document.body.innerText,
  }));
  check(`the counter is a decision (${view.buttons.join(' · ')})`, ['Counter with This', 'Not Now', 'Adjust It First'].every(l => view.buttons.includes(l)));
  check('…with a link per player', await page.$$eval('.msg-player', bs => bs.length >= 2));
  await page.screenshot({ path: `${out}/trade-reply-director-${theme}.png`, fullPage: true });
  // r202 the deal table: the counter first, and a switch to the deal as offered.
  await page.click(`[data-deal-sheet="${got.sc.id}"]`); await page.waitForTimeout(500);
  const sheet = async () => page.evaluate(() => ({ tabs: [...document.querySelectorAll('.ds-sw')].map(b => `${b.textContent.trim()}${b.classList.contains('on') ? '*' : ''}`),
    names: [...document.querySelectorAll('.ds-name')].map(b => b.textContent.trim()), cash: [...document.querySelectorAll('.ds-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ') }));
  const a = await sheet();
  check(`the deal table opens on our counter (${a.tabs.join(' / ')})`, a.tabs.join() === 'As Offered,Our Counter*');
  await page.screenshot({ path: `${out}/trade-sheet-counter-${theme}.png` });
  await page.click('.ds-sw:not(.on)'); await page.waitForTimeout(300);
  const b = await sheet();
  check(`…and switches to the deal as offered (${b.tabs.join(' / ')})`, b.tabs.join() === 'As Offered*,Our Counter' && (JSON.stringify(a) !== JSON.stringify(b)));
  await page.screenshot({ path: `${out}/trade-sheet-offered-${theme}.png` });
  await page.click('#ds-close'); await page.waitForTimeout(300);
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
  // r195 a name is a link the first time only (the payroll paragraph names the bids' players again).
  const ids = await page.$$eval('.msg-player', bs => bs.map(b => b.dataset.msgPlayer));
  const shown = await page.evaluate((names) => names.filter(n => (document.querySelector('.mr-body')?.innerText.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length > 1), await page.$$eval('.msg-player', bs => bs.map(b => b.textContent)));
  check(`each player is a link once (${ids.length} links; named again as text: ${shown.join(', ') || 'none'})`, ids.length > 0 && new Set(ids).size === ids.length);
  await page.screenshot({ path: `${out}/trade-shop-reply-${theme}.png` });
}
// r209 §122.87 a new offer in the trade composer: Ask Scouting sends it; the answer comes later, as a message.
await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(e => e.remove()));
await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const st = SM.get();
  const them = st.leagueTeams[5];
  const theirs = them.rosterIds.map(id => st.players[id]).find(p => p && !p.isInjured && p.pos === 'RP');
  const { openTradeComposer } = await import('/baseball-gm/ui/components/TradeComposer.js');
  openTradeComposer({ teamId: them.id, theirIds: [theirs.id] });
});
await page.waitForTimeout(500);
const draftBtn = () => page.evaluate(() => { const b = document.querySelector('#tc-overlay [data-ask-draft]'); return b ? `${b.textContent.trim()}${b.disabled ? ' (off)' : ''}` : null; });
check(`a new offer: Ask Scouting (${await draftBtn()})`, await draftBtn() === 'Ask Scouting');
await page.click('#tc-overlay [data-ask-draft]'); await page.waitForTimeout(500);
const sent = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const c = (SM.get().scheduledCards || []).find(x => x.isCompose && x._composeTopic === 'sc_offer');
  return { waits: c ? Math.round((c.deliverAtMs - Date.now()) / 60_000) : null, read: !!document.querySelector('#tc-overlay .tc-read') };
});
check(`…sends the offer to Scouting: an answer in about ${sent.waits} minutes, nothing on the spot`, sent.waits > 5 && !sent.read, JSON.stringify(sent));
check(`…and reads Scouting Asked (${await draftBtn()})`, await draftBtn() === 'Scouting Asked (off)');
await page.screenshot({ path: `${out}/trade-ask-draft-${theme}.png` });
await page.click('#tc-overlay [data-cash="50"]'); await page.waitForTimeout(300);
check(`a change to the offer is a new question (${await draftBtn()})`, await draftBtn() === 'Ask Scouting');
await page.click('#tc-overlay [data-cash="-50"]'); await page.waitForTimeout(300);
check(`…and back to the one asked about: Scouting Asked (${await draftBtn()})`, await draftBtn() === 'Scouting Asked (off)');
await page.click('#tc-close'); await page.waitForTimeout(200);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
