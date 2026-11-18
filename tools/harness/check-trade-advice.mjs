// r150 the staff weigh in on a trade on the table (and r151: shop one of our players); r202 §122.79 one reply,
// the director's: the manager's read of the field passed on by name (and the coaches' on who's coming in), the counter
// (read through the director's eye) with the payroll, the reply before the
// deal's deadline, the counter sent as the next round, and a counter that goes
// away with the deal.
//   node tools/harness/check-trade-advice.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, deliverComposeCard, syncRosterCards } from '../../engine/CardEngine.js';
import { dealsOnTable, dealsFor, fieldRead, suggestCounter, readError, shopPlayer, shoppable, clubsCalled } from '../../engine/TradeAdvice.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { cpuRespond, evaluateForClub, clubBar, dealOfCard } from '../../engine/TradeEngine.js';
import { talkWith } from '../../engine/Negotiation.js';
import * as NG from '../../engine/Negotiation.js';
import { COMPOSE_REPLY } from '../../data/constants.js';
import { namedTwice } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const BAD = /undefined|NaN|\[object|null\b/;
const H = 3_600_000;
const S = () => SM.get();
const setDirector = (q) => SM.mutate(s => { Object.assign(s.userTeam.coachingStaff.scoutingDirector, { quality: q, specialty: 'pro' }); });
const lcg = (seed) => { let x = seed >>> 0 || 1; return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296); };

seedRandom(8);   // (r205 a world whose first offer has room for a counter)
clock.set(clock.real());
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });

// ── The deals on the table ─────────────────────────────────────
console.log('The deals on the table');
const t0 = clock.get();
const deals = dealsOnTable(S(), t0);
const deal = deals[0];
check(`a new club's seed offer is on the table (“${deal?.label}”)`, !!deal && deal.kind === 'offer' && deal.round === 2 && Number.isFinite(deal.expiresAtMs));
check('the director can be asked about an offer', dealsFor('sc_trade', S(), t0).some(d => d.key === deal.key));

// ── The director's reply ───────────────────────────────────────
console.log('The director\'s reply');
const fr = fieldRead(S(), deal);
check(`the field read places everyone in the deal (${fr.leaving.length} leaving, ${fr.arriving.length} arriving)`,
      fr.leaving.length === deal.offer.outgoingIds.length && fr.arriving.length === deal.offer.incomingIds.length);
setDirector(85);
const sc = writeComposeReply(S(), { topicId: 'sc_trade', channelId: 'scouting', atMs: t0 + H, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId } });
console.log(`    ${sc?.body.replace(/\n\n/g, '\n    ')}`);
const everyone = [...deal.offer.incomingIds, ...deal.offer.outgoingIds];
const paras = sc.body.split('\n\n').slice(1, -1);   // (between the greeting and the signature)
const mgrName = S().userTeam.coachingStaff.manager?.name;
check(`signed by the director (${sc?.sender})`, sc?.sender?.startsWith(S().userTeam.coachingStaff.scoutingDirector.name));
check(`opens with the manager's read on the field, by name (${mgrName})`, paras[0].startsWith(`${mgrName}'`) && /read on the field: /.test(paras[0]));
check('…about every player in the deal, ending on the bottom line', everyone.every(id => paras[0].includes(S().players[id].name)) && /On the field today, (this makes us( a little)? (better|worse)|it's about a wash)\.$/.test(paras[0]), JSON.stringify([everyone.map(id => S().players[id].name), paras[0].slice(-60)]));
check('…with a coach on who is coming in', /\w+ says this one /.test(paras[0]));
check('then the deal as it stands, and a counter or why not', /^As it stands/.test(paras[1]) && /(My counter:|I wouldn't counter|nothing worth asking|out of rounds)/.test(sc.body));
{ const before = sc.body.split('On payroll')[0];   // (the payroll paragraph names who's signed past this season)
  const ps = [...new Set([...everyone, ...(sc.trade?.offer?.incomingIds || []), ...(sc.trade?.offer?.outgoingIds || [])])].map(id => S().players[id]);
  const twice = namedTwice(before, ps).filter(p => !(sc.trade && /keep .* out of it|in place of/.test(before)));
  check('…naming each player once before the payroll (a counter may name the one it changes)', !twice.length, twice.map(p => p.name).join()); }
check('…and last the payroll', /^On payroll(, with the counter)?: /.test(paras.at(-1)) && /ownership's target/.test(sc.body));
check('every player named is real (linked)', everyone.every(id => sc.named.includes(id)) && sc.named.every(id => S().players[id]));
check('gender-neutral, nothing missing', !GEN.test(sc.body) && !BAD.test(sc.body), (sc.body.match(GEN) || sc.body.match(BAD) || []).join());
check('the deal as it\'s on the table goes with the reply (the deal table)', sc.sheet?.teamId === deal.teamId && sc.sheet.offer === deal.offer);
if (sc.trade) check('a counter is a decision: the counter, its round, the deal it answers', sc.trade.round === 2 && sc.trade.dealKey === deal.key && sc.trade.teamId === deal.teamId);

// How good the read is: a counter the club really takes, by the director's quality.
const odds = (q) => SM.speculate(() => {
  setDirector(q);
  let n = 0, took = 0, gain = 0, agree = 0, sampled = 0;
  for (let i = 1; i <= 400; i++) {
    const a = suggestCounter(S(), deal, lcg(i * 7919), t0);
    if (!a.counter) continue;
    n++; gain += a.after.gain;
    if (a.after.slack >= 0) took++;
    if (i % 25 === 0) {   // the read's truth is the club's own answer
      sampled++;
      const r = cpuRespond(a.counter, S(), deal.teamId, { round: deal.round, atMs: t0 });
      if ((r.decision === 'accept') === (a.after.slack >= 0)) agree++;
    }
  }
  return { n, rate: n ? took / n : 0, gain: n ? gain / n : 0, agree, sampled };
});
const good = odds(90), weak = odds(40);
console.log(`    a 90 (pro): ${good.n} counters, ${Math.round(good.rate * 100)}% taken, +${good.gain.toFixed(1)} each · a 40: ${weak.n} counters, ${Math.round(weak.rate * 100)}% taken, +${weak.gain.toFixed(1)} each`);
check(`a great director's counters are usually taken (${Math.round(good.rate * 100)}%)`, good.n > 50 && good.rate >= 0.8);
check(`a weak director's are not as often (${Math.round(weak.rate * 100)}%)`, weak.rate <= good.rate - 0.12);
check(`the read is the club's real answer (${good.agree + weak.agree} of ${good.sampled + weak.sampled})`, good.agree + weak.agree === good.sampled + weak.sampled);
check(`the read's error: ${readError({ scoutingDirector: { quality: 40 } }).toFixed(1)} (40) → ${readError({ scoutingDirector: { quality: 90, specialty: 'pro' } }).toFixed(1)} (90)`,
      readError({ scoutingDirector: { quality: 90, specialty: 'pro' } }) < readError({ scoutingDirector: { quality: 40 } }) / 2);
check('a counter on the last round says so; past it, there is none',
      suggestCounter(S(), { ...deal, round: 3 }, lcg(5), t0).lastRound && !suggestCounter(S(), { ...deal, round: 4 }, lcg(5), t0).counter);
setDirector(85);

// ── Asking, from the compose screen ────────────────────────────
console.log('Asking');
const arg = { key: deal.key, label: deal.label, instanceId: deal.instanceId, expiresAtMs: deal.expiresAtMs };
SM.speculate(() => {
  const short = { ...arg, expiresAtMs: t0 + 40 * 60_000 };
  const c = deliverComposeCard('sc_trade', 'scouting', { topicLabel: deal.label, arg: short, nowMs: t0 });
  check(`a deal due in 40 minutes: the director answers inside it (${Math.round((c.deliverAtMs - t0) / 60_000)} min)`, c.deliverAtMs > t0 && c.deliverAtMs < short.expiresAtMs);
});
/** Ask the director, and let the reply come back. */
const ask = () => {
  const c = deliverComposeCard('sc_trade', 'scouting', { topicLabel: deal.label, arg, nowMs: t0 });
  releaseDueCards(c.deliverAtMs);
  return { c, reply: getInbox().find(x => x.instanceId === c.instanceId) };
};
const countered = SM.speculate(() => {
  const { c, reply } = ask();
  check('the reply lands before the deal is due', c.deliverAtMs <= deal.expiresAtMs - COMPOSE_REPLY.beforeDeadlineMs);
  check('…carrying the deal it asks about', c._composeArg?.key === deal.key);
  check(`written as it comes back: “${reply?.subject}” from ${reply?.sender}`, !!reply && reply.subject === `Re: ${deal.label}` && /Scouting Director/.test(reply.sender) && /^As it stands/m.test(reply.body));
  check('every name links to a real player', (reply._playerIds || []).length >= everyone.length && reply._playerIds.every(id => S().players[id]));
  check('the card carries the deal table (the deal as offered)', reply._dealOffer?.offer && JSON.stringify(reply._dealOffer.offer) === JSON.stringify(deal.offer));
  if (!reply?._ideaOffer) return false;
  check('the counter is a decision: Counter with This / Not Now, or adjust it first', reply.yesLabel === 'Counter with This' && reply.noLabel === 'Not Now'
        && reply._reviseOffer?.round === 2 && reply._reviseLabel === 'Adjust It First' && reply.expiresAtMs === deal.expiresAtMs);
  const d = dealOfCard(S(), reply);
  check('…and its table switches between the deal as offered and our counter', d?.versions?.map(v => v.label).join() === 'As Offered,Our Counter'
        && d.versions[0].offer === reply._adviceOffer && d.versions[1].offer === reply._ideaOffer && d.offer === reply._ideaOffer);
  return true;
});
// A counter from a director who sees room (so the decision is there to check).
const withCounter = () => { setDirector(countered ? 85 : 30); for (let i = 0; i < 40; i++) { const { reply } = ask(); if (reply?._ideaOffer) return reply; SM.mutate(s => { s.composeLog = []; }); clock.set(clock.get() + 60_000); } return null; };
if (!countered) console.log('    (no counter from the first ask — asking until the director sees one)');
SM.speculate(() => {
  const t = clock.get();
  const reply = withCounter();
  check('a counter came', !!reply);
  if (!reply) return;
  resolve(reply.instanceId, 'yes');
  const talk = talkWith(S(), deal.teamId);
  check(`sent as round 2 of the talks (${talk?.status})`, !!talk && talk.round === 2 && JSON.stringify(talk.offer.incomingIds) === JSON.stringify(reply._ideaOffer.incomingIds) && talk.offer.cashK === reply._ideaOffer.cashK);
  check('…replacing their offer', !getInbox().some(x => x.instanceId === deal.instanceId && !x.resolved));
  check('…and the deal is off the table until they answer', !dealsOnTable(S(), clock.get()).some(d => d.key === deal.key));
  // Their answer: a counter of theirs is the next deal on the table (the director can be asked again, round 3).
  releaseDueCards(talk.replyAtMs);
  const next = dealsOnTable(S(), talk.replyAtMs).find(d => d.teamId === deal.teamId);
  const st = talkWith(S(), deal.teamId)?.status;
  check(`their answer (${st}) is the next deal on the table: ${next ? `${next.kind}, round ${next.round}` : 'none'}`,
        st === 'countered' ? next?.kind === 'counter' && next.round === 3 && dealsFor('sc_trade', S(), talk.replyAtMs).some(d => d.key === next.key)
        : st === 'agreed' ? next?.kind === 'agreed' && dealsFor('sc_trade', S(), talk.replyAtMs).some(d => d.key === next.key)
        : !next);
  clock.set(t);
});
SM.speculate(() => {
  const t = clock.get();
  const reply = withCounter();
  if (!reply) return;
  resolve(deal.instanceId, 'yes');
  advanceClock(clock.get());
  syncRosterCards([], clock.get());
  check('take their offer instead, and the counter goes away', !getInbox().some(x => x.instanceId === reply.instanceId && !x.resolved));
  clock.set(t);
});

// A reply about a deal that's already settled.
SM.speculate(() => {
  resolve(deal.instanceId, 'no');
  const late = writeComposeReply(S(), { topicId: 'sc_trade', channelId: 'scouting', atMs: t0 + H, arg });
  check(`a deal settled before the reply: says so (“${late.body.split('\n\n')[1]}”)`, /already|settled/.test(late.body) && !late.trade);
});

// ── r202 §122.79 a deal they've agreed to ─────────────────────
console.log('A deal they agreed to');
/** Their own offer, sent back as ours: they say yes. → { agreed (the deal), card (their yes) } */
const agreedDeal = () => {
  const { proposeTrade } = NG;
  proposeTrade(deal.teamId, deal.offer, clock.get());
  const talk = talkWith(S(), deal.teamId);
  releaseDueCards(talk.replyAtMs);
  clock.set(talk.replyAtMs);
  const d = dealsOnTable(S(), talk.replyAtMs).find(x => x.teamId === deal.teamId && x.kind === 'agreed');
  return { d, card: d && getInbox().find(c => c.instanceId === d.instanceId) };
};
/** The director's reply about it. */
const askAgreed = (d) => {
  const c = deliverComposeCard('sc_trade', 'scouting', { topicLabel: d.label, arg: { key: d.key, label: d.label, instanceId: d.instanceId, expiresAtMs: d.expiresAtMs }, nowMs: clock.get() });
  releaseDueCards(c.deliverAtMs);
  return getInbox().find(x => x.instanceId === c.instanceId);
};
for (const how of ['reply', 'theirs', 'walk']) SM.speculate(() => {
  const t = clock.get();
  const { d, card } = agreedDeal();
  if (how === 'reply') check(`their yes is on the table, and the director can be asked about it (${d?.key})`, !!d && dealsFor('sc_trade', S(), clock.get()).some(x => x.key === d.key));
  if (!d) { clock.set(t); return; }
  const reply = askAgreed(d);
  if (how === 'reply') {
    console.log(`    ${reply?.body.replace(/\n\n/g, '\n    ')}`);
    check('the reply: they said yes — make it official or walk away', /have said yes/.test(reply?.body || '') && reply.yesLabel === 'Make It Official' && reply.noLabel === 'Walk Away' && !reply._ideaOffer);
    check('…with the deal table', JSON.stringify(dealOfCard(S(), reply)?.offer) === JSON.stringify(d.offer));
    resolve(reply.instanceId, 'yes');
    const queued = (S().transactions || []).some(x => JSON.stringify(x).includes(d.offer.incomingIds[0]));
    check('Make It Official: the deal goes through (queued, as from their yes)', queued && talkWith(S(), deal.teamId)?.status === 'done', talkWith(S(), deal.teamId)?.status);
    check('…and their yes goes away (one decision)', !getInbox().some(x => x.instanceId === card.instanceId && !x.resolved));
  } else if (how === 'theirs') {
    resolve(card.instanceId, 'yes');
    syncRosterCards([], clock.get());
    check('answered on their yes instead: the reply goes away', !getInbox().some(x => x.instanceId === reply.instanceId && !x.resolved));
  } else {
    resolve(reply.instanceId, 'no');
    check('Walk Away: no deal, and their yes goes away', talkWith(S(), deal.teamId)?.status === 'closed' && !(S().transactions || []).some(x => JSON.stringify(x).includes(d.offer.incomingIds[0]))
          && !getInbox().some(x => x.instanceId === card.instanceId && !x.resolved));
  }
  clock.set(t);
});

// ── r151 What could we get for him? ───────────────────────────
console.log('Shopping a player');
const shopAll = (q) => SM.speculate(() => {
  setDirector(q);
  const out = [];
  for (const p of shoppable(S(), t0)) out.push({ p, ...shopPlayer(S(), p.id, lcg(p.id.length * 31 + q), t0) });
  return out;
});
const shops = shopAll(85);
const withBids = shops.filter(x => x.bids.length);
check(`the director can shop our players (${shops.length}); clubs bid on ${withBids.length}`, shops.length >= 20 && withBids.length >= 3);
const replies = withBids.flatMap(x => x.bids.map(b => ({ x, b, r: cpuRespond({ ...b.offer }, S(), b.teamId, { round: 1, atMs: t0 }) })));
check(`every bid is one its club would accept as it stands (${replies.filter(y => y.r.decision === 'accept').length} of ${replies.length})`,
      replies.every(y => y.r.decision === 'accept'), replies.filter(y => y.r.decision !== 'accept').map(y => `${y.x.p.name}→${y.b.team}: ${y.r.decision} ${y.r.reason || ''}`).join('; '));
check('…and fair to us, or said to be short (never more than 15% under)', withBids.every(x => x.bids.every(b => b.ourNet >= -0.15 * 400)));
check(`a better director calls more clubs (${clubsCalled({ scoutingDirector: { quality: 40 } })} at 40, ${clubsCalled({ scoutingDirector: { quality: 90 } })} at 90)`,
      clubsCalled({ scoutingDirector: { quality: 90 } }) > clubsCalled({ scoutingDirector: { quality: 40 } }));
const weakShops = shopAll(40);
const found = (xs) => xs.reduce((a, x) => a + x.bids.length, 0);
check(`…and comes back with more offers (${found(shops)} at 85, ${found(weakShops)} at 40)`, found(shops) > found(weakShops));
const one = withBids.sort((a, b) => b.bids.length - a.bids.length)[0];
const shopArg = { playerId: one.p.id, label: one.p.name };
const sr = writeComposeReply(S(), { topicId: 'sc_shop', channelId: 'scouting', atMs: t0 + H, arg: shopArg });
console.log(`    ${sr.body.replace(/\n\n/g, '\n    ')}`);
check('the reply: who could use the player, the calls, each bid, the pick, the payroll',
      /could use/.test(sr.body) && /I called/.test(sr.body) && /They'd give/.test(sr.body) && /the one I'd take|comes closest/.test(sr.body) && /On payroll, with/.test(sr.body));
check('gender-neutral, nothing missing, every name real', !GEN.test(sr.body) && !BAD.test(sr.body) && sr.named.every(id => S().players[id]), (sr.body.match(GEN) || sr.body.match(BAD) || []).join());
check('a decision: make the best offer', sr.trade?.yesLabel === 'Make the Offer' && sr.trade.round == null && !sr.trade.dealKey);
const reg = shops.find(x => !x.bids.length && x.key && x.called);
if (reg) {
  const rr = writeComposeReply(S(), { topicId: 'sc_shop', channelId: 'scouting', atMs: t0 + H, arg: { playerId: reg.p.id, label: reg.p.name } });
  check(`a regular nobody bids enough for: says why, and where to build a bigger deal (${reg.p.name})`, /trade composer/.test(rr.body) && !rr.trade);
}
SM.speculate(() => {
  const c = deliverComposeCard('sc_shop', 'scouting', { topicLabel: `What could we get for ${one.p.name}?`, arg: shopArg, nowMs: t0 });
  releaseDueCards(c.deliverAtMs);
  const card = getInbox().find(x => x.instanceId === c.instanceId);
  check(`it comes back as a decision (“${card?.subject}”: ${card?.yesLabel} / ${card?.noLabel} / ${card?._reviseLabel})`,
        card?.yesLabel === 'Make the Offer' && card?.noLabel === 'Not Now' && card?._reviseLabel === 'Adjust It First' && !card._adviceDeal);
  const teamId = card._ideaTeamId;
  clock.set(c.deliverAtMs + 60_000);
  resolve(card.instanceId, 'yes');
  const talk = talkWith(S(), teamId);
  check(`Make the Offer starts talks (round ${talk?.round}), and they take it (${talk?.status})`, talk?.round === 1 && talk?.status === 'agreed');
  clock.set(t0);
});
SM.speculate(() => {
  SM.mutate(s => { s.players[one.p.id].teamId = 'X'; });
  const gone = writeComposeReply(S(), { topicId: 'sc_shop', channelId: 'scouting', atMs: t0 + H, arg: shopArg });
  check('a player no longer ours: says so', /isn't ours anymore/.test(gone.body) && !gone.trade);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
