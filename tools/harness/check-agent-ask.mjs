// r201 §122.78 After a breakout, the agent asks to redo the deal (OffseasonEngine.breakoutAsks →
// CardEngine.deliverAgentAsk): the market price from next season, replacing the current deal.
// Extend, counter (less money / fewer years — the agent may say no, and the ask then stands for a
// day), or not now (the player's view of the GM drops, the next deal costs 10% more; twice, and
// the player plays out the deal and leaves). A signed deal waits for contract day — no salary
// changes mid-contract — and goes with the player in a trade.
//   node tools/harness/check-agent-ask.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { breakoutAsks, counterOdds, contractDay, marketTerms, yearsLeft } from '../../engine/OffseasonEngine.js';
import { deliverAgentAsk, releaseDueCards, getInbox, resolve } from '../../engine/CardEngine.js';
import { dice, diceSeed } from '../../engine/Dice.js';
import { MARKET_PERF, AGENT_ASK } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const S = () => SM.get();
const H = 3600_000, D = 86_400_000;

seedRandom(4343);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const season = S().seasonNum || 1;
const L = S().leagueTalentOffset || 0;
const impFor = (ovr) => MARKET_PERF.impAt0 + MARKET_PERF.impPer * (ovr - L);
const hitters = Object.values(S().players).filter(p => p.teamId === 'user' && !['SP', 'RP'].includes(p.pos) && p.ovr >= 55)
  .sort((a, b) => a.ovr - b.ovr);
// (the youngest: the market's length is longest, so a fewer-years counter is on the table)
const star = [...hitters].sort((a, b) => String(b.dob).localeCompare(String(a.dob)))[0];
const [steady, expiring] = hitters.filter(p => p.id !== star.id);

// A breakout (playing 12 OVR past the rating over a full season, on a cheap deal through season+2);
// a player at the rating; a breakout whose deal is up this season.
SM.mutate(d => {
  d.impScores = d.impScores || {};
  const set = (id, ovrGap, expiry, salary) => {
    const p = d.players[id];
    p.stats = { ...(p.stats || {}), g: 120, ab: 480, bb: 40, h: 150, hr: 28, tb: 280, hbp: 2 };
    p.contractExpiry = expiry; p.contractSalary = salary; p.gmRelationship = 50;
    delete p._agentAsk; delete p._willWalk; delete p.pendingContract; delete p._agentGrudge;
    d.impScores[id] = { impS: impFor(p.ovr + ovrGap) };
  };
  set(star.id, 12, season + 3, 100);
  set(steady.id, 0, season + 3, 300);
  set(expiring.id, 12, season + 1, 100);
});
const base = structuredClone(S());

console.log('\nWho gets asked');
{
  const asks = breakoutAsks(S(), 10);
  const mine = asks.find(x => x.player.id === star.id);
  check(`the breakout under contract is asked (${star.name}, shift ${mine?.shift})`, !!mine && mine.shift >= AGENT_ASK.minShift);
  check('…at the market price, a real raise', !!mine && mine.terms.salary === marketTerms(S(), S().players[star.id]).salary
    && mine.terms.salary >= 100 * AGENT_ASK.minRaise, JSON.stringify(mine?.terms));
  check('…for the market\'s length past the current deal', !!mine && mine.terms.years === Math.min(AGENT_ASK.maxYears, yearsLeft(S().players[star.id], season) - 1 + marketTerms(S(), S().players[star.id]).years), JSON.stringify(mine?.terms));
  check('…with a money counter between the salary and the ask', !!mine && mine.counters.money.salary > 100 && mine.counters.money.salary < mine.terms.salary);
  check('a player playing to the rating isn\'t asked', !asks.some(x => x.player.id === steady.id));
  check('a player whose deal is up this season isn\'t (the re-sign card handles it)', !asks.some(x => x.player.id === expiring.id));
  check('the biggest raise comes first', asks.every((x, i) => !i || (asks[i - 1].terms.salary - asks[i - 1].player.contractSalary) >= (x.terms.salary - x.player.contractSalary)));
}

/** Deliver the ask now and return the card. */
function ask(atMs = clock.get()) {
  const c = breakoutAsks(S(), 10).find(x => x.player.id === star.id);
  deliverAgentAsk(c, atMs, 'break');
  releaseDueCards(atMs + 1);
  return getInbox().find(x => x.cardId === 'agent_ask' && x._targetPlayerId === star.id && !x.resolved);
}

console.log('\nThe message');
let card;
{
  card = ask();
  check('delivered, from the agent', !!card && card.sender === `${star.name}'s agent`, card?.sender);
  check('Extend / Counter money / Counter years / Not now, nothing recommended',
    card?._choices?.map(c => c.key).join() === 'ask,money,years' && card.noLabel === 'Not now' && card._noRec, card?._choices?.map(c => c.key).join());
  if (process.env.SHOW) console.log(card.subject, '\n', card.preview, '\n', card.body, '\n', JSON.stringify(card._choices));
  check('the body names the terms and when they start', /starting next season and replacing it/.test(card?.body || ''), card?.body);
  check('once a season: no second ask', breakoutAsks(S(), 10).every(x => x.player.id !== star.id));
}

console.log('\nExtend');
SM.speculate(() => {
  const before = S().players[star.id].contractSalary;
  resolve(card.instanceId, 'yes', { pick: 'ask' });
  const p = S().players[star.id];
  check('a new deal waits for next season (the salary doesn\'t change now)', p.pendingContract?.replaces && p.contractSalary === before
    && p.pendingContract.salary === card._agentTerms.salary, JSON.stringify(p.pendingContract));
  SM.mutate(d => contractDay(d, clock.get()));
  const q = S().players[star.id];
  check('on contract day it replaces the current deal', q.contractSalary === card._agentTerms.salary
    && q.contractExpiry === season + 1 + card._agentTerms.years && !q.pendingContract, `${q.contractSalary} exp ${q.contractExpiry}`);
});

console.log('\nA counter');
for (const kind of ['money', 'years']) SM.speculate(() => {
  if (!card._agentCounters[kind]) { check(`${kind}: a counter is offered`, false); return; }
  const p = S().players[star.id];
  const takes = dice(diceSeed(S()), 'agent-counter', star.id, season, kind)() < counterOdds(p, kind);
  resolve(card.instanceId, 'yes', { pick: kind });
  const q = S().players[star.id];
  if (takes) {
    check(`${kind}: the agent takes it — the countered deal waits for next season`,
      q.pendingContract?.salary === card._agentCounters[kind].salary && q.pendingContract?.years === card._agentCounters[kind].years);
  } else {
    check(`${kind}: the agent says no — no deal yet`, !q.pendingContract);
    releaseDueCards(clock.get() + 4 * H);
    const hold = getInbox().find(x => x.cardId === 'agent_hold' && x._targetPlayerId === star.id && !x.resolved);
    if (process.env.SHOW) console.log(hold.subject, '\n', hold.preview, '\n', hold.body);
    check('…and the ask stands for a day', !!hold && hold.expiresAtMs - hold.deliverAtMs <= D + 1 && hold._agentTerms.salary === card._agentTerms.salary, hold?.body);
    resolve(hold.instanceId, 'yes');
    check('…Extend there signs at the ask', S().players[star.id].pendingContract?.salary === card._agentTerms.salary);
  }
});
// The odds: closer to the ask and a better view of the GM help.
{
  const p = { gmRelationship: 50 };
  check('a counter closer to the ask (fewer years) has better odds than less money', counterOdds(p, 'years') > counterOdds(p, 'money'));
  check('a player who likes the GM takes a counter more often', counterOdds({ gmRelationship: 90 }, 'money') > counterOdds({ gmRelationship: 20 }, 'money'));
}

console.log('\nNot now');
SM.speculate(() => {
  const rel = S().players[star.id].gmRelationship;
  const price = marketTerms(S(), S().players[star.id]).salary;
  resolve(card.instanceId, 'no');
  const p = S().players[star.id];
  check(`the player's view of the GM drops (${rel} → ${p.gmRelationship})`, p.gmRelationship === rel - AGENT_ASK.relHit);
  check('the agent asks more at the next deal', p._agentGrudge === 'extension' && marketTerms(S(), p).salary > price);
  check('the first time, the player stays open to a deal', !p._willWalk);
});
SM.speculate(() => {
  // A second ask, a season later (the first was put off).
  SM.mutate(d => { d.players[star.id]._agentAsk = { season: season - 1, answer: 'no', declined: 1 }; });
  SM.mutate(d => { d.inbox = (d.inbox || []).filter(c => c.cardId !== 'agent_ask'); d.scheduledCards = (d.scheduledCards || []).filter(c => c.cardId !== 'agent_ask'); });
  const again = (() => {
    const c = breakoutAsks(S(), 10).find(x => x.player.id === star.id);
    deliverAgentAsk(c, clock.get(), 'end');
    releaseDueCards(clock.get() + 1);
    return getInbox().find(x => x.cardId === 'agent_ask' && x._targetPlayerId === star.id && !x.resolved);
  })();
  check('the second ask says what not now means', /second time/.test(again?.body || '') && /tests free agency/.test(again?.body || ''), again?.body);
  resolve(again.instanceId, 'no');
  const p = S().players[star.id];
  check('not now twice: the player plays out the deal and leaves', p._willWalk === true);
  check('…and isn\'t asked again', !breakoutAsks(S(), 10).some(x => x.player.id === star.id));
});

console.log('\nA signed deal goes with the player in a trade');
SM.speculate(() => {
  resolve(card.instanceId, 'yes', { pick: 'ask' });
  const club = S().leagueTeams[0];
  SM.mutate(d => {
    d.userTeam.rosterIds = d.userTeam.rosterIds.filter(id => id !== star.id);
    d.leagueTeams[0].rosterIds = [...(d.leagueTeams[0].rosterIds || []), star.id];
    d.players[star.id].teamId = club.id;
    contractDay(d, clock.get());
  });
  const q = S().players[star.id];
  check('their club gets the new deal on contract day', q.contractSalary === card._agentTerms.salary && !q.pendingContract, `${q.contractSalary}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
