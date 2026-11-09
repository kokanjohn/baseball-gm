// §122 the injury decision: IL him (still paid) and sign a replacement, IL him and pick,
// or cut him (waivers, salary off at once); day-to-day for short timelines. Plus the
// open-spot card's free agents and the winter roster call.
//   node tools/harness/check-injury-decision.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { deliverInjuryAct2, releaseDueCards, resolve, getInbox } from '../../engine/CardEngine.js';
import { beginInjury, dayToDayAllowed } from '../../engine/InjuryEngine.js';
import { payrollOf } from '../../engine/FinanceEngine.js';
import { vacancyDeadline, decisionDeadlineAfter } from '../../engine/TransactionEngine.js';
import { PLAYER_GROUP, ROSTER_DECISION_LEAD_MS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

seedRandom(3);
clock.set(clock.real());
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const P = (id) => SM.get().players[id], U = () => SM.get().userTeam;
// Into the season: the first regular-season game's morning.
const g0 = SM.get().schedule.find(g => !g.isSpring);
const morning = (ms) => { const d = new Date(ms); d.setHours(9, 0, 0, 0); return d.getTime(); };
let t = morning(g0.gameTime) - 86_400_000;
clock.set(t); advanceClock(t); releaseDueCards();

function injure(slot, severity) {
  const id = U().lineupSlots.find(sl => sl.slot === slot)?.playerId;
  const now = clock.get();
  SM.mutate(s => { Object.assign(s.players[id], beginInjury(s.players[id], now, severity, Math.random)); });
  deliverInjuryAct2(id, now);
  releaseDueCards();
  return { id, card: getInbox().find(c => c.cardId === 'injury_act2' && c._targetPlayerId === id && !c.resolved) };
}

console.log('The diagnosis: IL or cut');
const a = injure('SS', 'moderate');
const c = a.card;
console.log(`    “${c?.subject}” — ${c?.body}`);
console.log(`    choices: ${(c?._choices || []).map(x => `${x.label} [${x.sub}]`).join(' | ')}  no: ${c?.noLabel}`);
check('it names the salary on the IL and what cutting saves', !!c && /stays on our payroll/.test(c.body) && /comes off at once/.test(c.body));
check('it offers free agents who fit, with prices, and IL-and-pick, and cut',
      c._choices.some(x => x.key.startsWith('il:') && /a year/.test(x.sub)) && c._choices.some(x => x.key === 'il') && c._choices.some(x => x.key === 'cut'));
check('the free agents fit the spot', c._choices.filter(x => x.key.startsWith('il:')).every(x => P(x.key.slice(3))?.group === PLAYER_GROUP.FREE_AGENT));
check('gender-neutral', !GEN.test(c.body + c._choices.map(x => x.label + x.sub).join(' ')), (c.body.match(GEN) || []).join());
const signee = c._choices.find(x => x.key.startsWith('il:')).key.slice(3);
const pay0 = payrollOf(SM.get(), 'user');
resolve(c.instanceId, 'yes', { pick: `il:${signee}` }); advanceClock(clock.get());
check(`IL + sign: ${P(a.id).name} on the IL (still paid), ${P(signee).name} reporting tomorrow`,
      P(a.id).group === PLAYER_GROUP.IL && P(a.id).teamId === 'user'
      && SM.get().transactions.some(x => x.status === 'pending' && x.kind === 'arrival' && x.playerId === signee && x.teamId === 'user'));

const b = injure('2B', 'severe');
const salaryB = P(b.id).contractSalary || 0;
const payB = payrollOf(SM.get(), 'user');
resolve(b.card.instanceId, 'yes', { pick: 'cut' }); advanceClock(clock.get());
check(`cut: ${P(b.id).name} on waivers, injured; ${salaryB}K off the payroll at once`,
      P(b.id).onWaivers && P(b.id).isInjured && P(b.id).teamId !== 'user' && payrollOf(SM.get(), 'user') <= payB - salaryB + 1);

const d = injure('C', 'minor');
console.log(`    minor: no = “${d.card?.noLabel}”`);
check(`day-to-day is offered exactly when the timeline is short enough (${P(d.id).injury.days} days: ${dayToDayAllowed(P(d.id)) ? 'yes' : 'no'})`,
      !!d.card && (dayToDayAllowed(P(d.id)) ? d.card.noLabel?.startsWith('Day-to-day') && d.card._raw.onNo === 'day_to_day' : !d.card.noLabel && !d.card._raw.onNo));

console.log('Open spots');
releaseDueCards();
const need = getInbox().find(c => c.cardId === 'roster_need' && !c.resolved);
console.log(`    “${need?.body}”`);
console.log(`    choices: ${(need?._choices || []).map(x => `${x.label} [${x.sub}]`).join(' | ')}`);
check('the open-spot card offers free agents with prices', !!need && need._choices?.length >= 1 && need._choices.every(x => /a year/.test(x.sub)));
check('it says nothing about the farm', !/farm|call(ed)? up/i.test(need.body + need.subject));
const st = SM.get();
const dl = vacancyDeadline(st, clock.get()), game = decisionDeadlineAfter(st, clock.get());
const day = new Date(game + ROSTER_DECISION_LEAD_MS); day.setHours(0, 0, 0, 0);
check('with time to spare, the deadline is the night before the game day (a signing reports for that game)',
      dl === day.getTime() - ROSTER_DECISION_LEAD_MS || dl === game);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
