// r198 §122.75 The deal on paper (TradeEngine.dealSheet): the players each way and the money —
// a year, the rest of this season, later seasons, cash, and the payroll after. Its totals agree
// with the trade engine's own (evaluateTrade), and with the books once the deal is done and the
// players report. dealOfCard finds the deal behind every kind of trade message.
//   node tools/harness/check-deal-sheet.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, getInbox } from '../../engine/CardEngine.js';
import { dealSheet, dealOfCard, evaluateTrade, queueTrade, remainingShare, yearsAfterThis } from '../../engine/TradeEngine.js';
import { dealsOnTable } from '../../engine/TradeAdvice.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { PLAYER_GROUP } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const S = () => SM.get(), P = (id) => S().players[id];

seedRandom(11);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
advanceClock(clock.get()); releaseDueCards();   // (morning of opening day: the club's first offer is in)

console.log('Every kind of trade message has its deal');
{
  const d = dealsOnTable(S(), clock.get())[0];
  const card = getInbox().find(c => c.instanceId === d?.instanceId);
  const got = dealOfCard(S(), card);
  check(`a club's offer (“${card?.subject}”)`, !!got && JSON.stringify(got.offer) === JSON.stringify(d.offer) && got.team === d.team);
  const offer = { incomingIds: d.offer.incomingIds, outgoingIds: d.offer.outgoingIds, cashK: 0 };
  check('Pro Scouting\'s package', dealOfCard(S(), { _ideaOffer: offer, _ideaTeamId: d.teamId })?.offer === offer);
  check('their counter', dealOfCard(S(), { cardId: 'talk_counter', _reviseOffer: { teamId: d.teamId, offer } })?.offer === offer);
  check('a deal they accepted', dealOfCard(S(), { cardId: 'talk_accepted', _dealOffer: { teamId: d.teamId, offer } })?.offer === offer);
  check('…and a message with no deal has none', dealOfCard(S(), { cardId: 'talk_passed', _talkTeamId: d.teamId }) === null);
}

console.log('The numbers');
// Three of theirs for three of ours (the most the table holds), salary kept both ways, cash to us.
const them = S().leagueTeams.find(t => (t.rosterIds || []).filter(id => P(id)?.contractSalary > 0 && !P(id).isInjured && P(id).group !== PLAYER_GROUP.IL).length >= 3);
const pick = (ids) => ids.map(P).filter(p => p && p.contractSalary > 0 && !p.isInjured && ![PLAYER_GROUP.IL, PLAYER_GROUP.IN_TRANSIT].includes(p.group)
  && !['SP', 'RP'].includes(p.pos)).sort((a, b) => b.contractSalary - a.contractSalary).slice(0, 3);
const ins = pick(them.rosterIds), outs = pick(S().userTeam.rosterIds);
const offer = { incomingIds: ins.map(p => p.id), outgoingIds: outs.map(p => p.id), cashK: 150,
                retain: { [ins[0].id]: 0.5, [outs[0].id]: 0.25 } };
const d = dealSheet(S(), offer, { teamName: them.name });
const ev = evaluateTrade(offer, S());
check(`three a side: ${d.get.map(r => r.name).join(', ')} for ${d.send.map(r => r.name).join(', ')}`, d.get.length === 3 && d.send.length === 3);
check(`salary a year: ${d.salary.get}K in, ${d.salary.send}K out, net ${d.salary.net}K — the trade engine's ${ev.payrollDelta}K`, d.salary.net === ev.payrollDelta);
const byHand = ins.reduce((s, p) => s + p.contractSalary * (p.id === ins[0].id ? 0.5 : 1), 0) - outs.reduce((s, p) => s + p.contractSalary * (p.id === outs[0].id ? 0.75 : 1), 0);
check(`…by hand, salary kept each way: ${Math.round(byHand)}K`, Math.abs(d.salary.net - byHand) <= 1);
check(`kept salary marked on its player (them ${d.get[0].kept}, us ${d.send[0].kept})`, d.get[0].keptBy === 'them' && d.send[0].keptBy === 'us');
const rem = remainingShare(S());
check(`the rest of this season: ${Math.round(rem * 100)}% of it, ${d.rest.net}K net`, Math.abs(d.rest.net - Math.round(d.salary.get * rem) + Math.round(d.salary.send * rem)) <= 1);
check(`this season, net: the rest of the salary less the cash (${d.netThisSeason}K)`, d.netThisSeason === d.rest.net - 150);
const later = ins.reduce((s, p) => s + p.contractSalary * yearsAfterThis(p, S()), 0) - outs.reduce((s, p) => s + p.contractSalary * yearsAfterThis(p, S()), 0);
check(`later seasons, one total: ${d.later.net}K net`, d.later.net === later);
check(`payroll after: ${d.payroll.after}K — the trade engine's ${Math.round(ev.newPayroll)}K, against a ${d.payroll.target}K target`,
      d.payroll.after === Math.round(ev.newPayroll) && d.payroll.target === Finance.seasonTarget(S().userTeam.finances));

console.log('The books, once the deal is done');
{
  const before = Finance.payrollOf(S(), 'user');
  SM.mutate(s => { s.transactions = [...(s.transactions || []), queueTrade(offer, them.id, clock.get())]; });
  advanceClock(clock.get() + 60_000); releaseDueCards();
  const out = outs.every(p => P(p.id).teamId === them.id);
  // (both ways they report tomorrow, after today's game: here, a minute from now, through the same arrivals —
  //  the share we keep paying on one we sent counts once that player is paid by the new club)
  SM.mutate(s => { for (const t of s.transactions || []) if (t.kind === 'arrival' && t.status === 'pending' && [...ins, ...outs].some(p => p.id === t.playerId)) t.effectiveAt = clock.get() + 60_000; });
  clock.set(clock.get() + 120_000); advanceClock(clock.get()); releaseDueCards();
  const arrived = ins.every(p => P(p.id).teamId === 'user' && Finance.isPaid(P(p.id)));
  const after = Finance.payrollOf(S(), 'user');
  check(`the trade went through and everyone reported (${out}, ${arrived})`, out && arrived);
  check(`payroll ${before}K → ${after}K: the table said ${d.payroll.after}K`, after === d.payroll.after, `moved ${after - before}K, table ${d.salary.net}K`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
