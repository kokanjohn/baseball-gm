// r150 the staff weigh in on a trade on the table: the manager's read of the
// field (and the coaches' on who's coming in), the scouting director's counter
// (read through the director's eye) with the payroll, the reply before the
// deal's deadline, the counter sent as the next round, and a counter that goes
// away with the deal.
//   node tools/harness/check-trade-advice.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, deliverComposeCard, syncRosterCards } from '../../engine/CardEngine.js';
import { dealsOnTable, dealsFor, fieldRead, suggestCounter, readError } from '../../engine/TradeAdvice.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { cpuRespond, evaluateForClub, clubBar } from '../../engine/TradeEngine.js';
import { talkWith } from '../../engine/Negotiation.js';
import { COMPOSE_REPLY } from '../../data/constants.js';

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

seedRandom(7);
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

// ── The manager ────────────────────────────────────────────────
console.log('The manager');
const fr = fieldRead(S(), deal);
check(`the field read names everyone in the deal (${fr.leaving.length} leaving, ${fr.arriving.length} arriving)`,
      fr.leaving.length === deal.offer.outgoingIds.length && fr.arriving.length === deal.offer.incomingIds.length);
const mgr = writeComposeReply(S(), { topicId: 'mgr_trade', channelId: 'manager', atMs: t0 + H, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId } });
console.log(`    ${mgr?.body.replace(/\n\n/g, '\n    ')}`);
const everyone = [...deal.offer.incomingIds, ...deal.offer.outgoingIds];
check('the manager talks about every player in the deal', everyone.every(id => mgr.body.includes(S().players[id].name)));
check('…and every player named is real (linked)', everyone.every(id => mgr.named.includes(id)) && mgr.named.every(id => S().players[id]));
check('…ends with the bottom line on the field', /On the field today, (this makes us|it's about a wash)/.test(mgr.body));
check('…with a coach on who is coming in', /I asked \w+ about/.test(mgr.body));
check('…and no decision attached', !mgr.trade && !mgr.decision);
check('gender-neutral, nothing missing', !GEN.test(mgr.body) && !BAD.test(mgr.body), (mgr.body.match(GEN) || mgr.body.match(BAD) || []).join());

// ── The director ───────────────────────────────────────────────
console.log('The director');
setDirector(85);
const sc = writeComposeReply(S(), { topicId: 'sc_trade', channelId: 'scouting', atMs: t0 + H, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId } });
console.log(`    ${sc?.body.replace(/\n\n/g, '\n    ')}`);
check(`signed by the director (${sc?.sender})`, sc?.sender?.startsWith(S().userTeam.coachingStaff.scoutingDirector.name));
check('reads the deal as it stands, then counters or says why not', /^As it stands/m.test(sc.body) && /(My counter:|I wouldn't counter|nothing worth asking|out of rounds)/.test(sc.body));
check('…with the payroll paragraph', /On payroll(, with the counter)?: /.test(sc.body) && /ownership's target/.test(sc.body));
check('gender-neutral, nothing missing', !GEN.test(sc.body) && !BAD.test(sc.body), (sc.body.match(GEN) || sc.body.match(BAD) || []).join());
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
/** Ask both, and let the replies come back. */
const ask = () => {
  const c = deliverComposeCard('sc_trade', 'scouting', { topicLabel: deal.label, arg, nowMs: t0 });
  const m = deliverComposeCard('mgr_trade', 'manager', { topicLabel: deal.label, arg, nowMs: t0 });
  releaseDueCards(Math.max(c.deliverAtMs, m.deliverAtMs));
  return { c, m, reply: getInbox().find(x => x.instanceId === c.instanceId), mgrCard: getInbox().find(x => x.instanceId === m.instanceId) };
};
const countered = SM.speculate(() => {
  const { c, m, reply, mgrCard } = ask();
  check('the reply lands before the deal is due', c.deliverAtMs <= deal.expiresAtMs - COMPOSE_REPLY.beforeDeadlineMs && m.deliverAtMs <= deal.expiresAtMs - COMPOSE_REPLY.beforeDeadlineMs);
  check('…carrying the deal it asks about', c._composeArg?.key === deal.key);
  check(`written as it comes back: “${reply?.subject}” from ${reply?.sender}`, !!reply && reply.subject === `Re: ${deal.label}` && /Scouting Director/.test(reply.sender) && /^As it stands/m.test(reply.body));
  check('the manager\'s too, and every name links to a real player', !!mgrCard && (mgrCard._playerIds || []).length >= everyone.length && mgrCard._playerIds.every(id => S().players[id]));
  if (!reply?._ideaOffer) return false;
  check('the counter is a decision: Counter with This / Not Now, or adjust it first', reply.yesLabel === 'Counter with This' && reply.noLabel === 'Not Now'
        && reply._reviseOffer?.round === 2 && reply._reviseLabel === 'Adjust It First' && reply.expiresAtMs === deal.expiresAtMs);
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
        : st === 'agreed' ? next?.kind === 'agreed' && !dealsFor('sc_trade', S(), talk.replyAtMs).some(d => d.key === next.key)
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
