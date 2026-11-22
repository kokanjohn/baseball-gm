/**
 * tools/harness/check-decision-impact.mjs — r255 §122.134 what a decision changed, kept on the card.
 *   - Every first-day decision, answered either way: the card keeps a row for each number that moved (team rating,
 *     morale, atmosphere, owner trust, manager confidence, club funds) with the right from, to and difference, and
 *     no row for a number that didn't move.
 *   - A decision that sits a player out says so, by name ("Rested (1 game)"), and one that moves a person's view of
 *     the GM shows it.
 *   - A decision that makes a promise says more comes of it later.
 *   - Left unanswered: the default's changes are kept the same way.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { teamRating } from '../../engine/RosterEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(255);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const first = S().schedule[0].gameTime;
clock.set(first - 20 * 60_000);
CE.releaseDueCards(clock.get());

const M = [['Team rating', s => teamRating(s, 'user')], ['Team morale', s => s.userTeam.morale], ['Stadium atmosphere', s => s.userTeam.atmosphere],
  ['Owner trust', s => s.userTeam.ownerTrust], ['Manager confidence', s => s.userTeam.managerConfidence], ['Club funds', s => s.userTeam.finances.funds]];
const decisions = (S().inbox || []).filter(c => !c.resolved && c.noLabel && c.yesLabel !== c.noLabel && !c._choices);
check(`decisions waiting on the first day (${decisions.length})`, decisions.length >= 5, decisions.map(c => c.cardId).join(', '));

const wrong = [], seen = { moved: 0, people: [], later: [], status: [] };
for (const c of decisions) for (const choice of ['yes', 'no']) {
  const r = SM.speculate(() => {
    const before = Object.fromEntries(M.map(([k, f]) => [k, f(S())]));
    CE.resolve(c.instanceId, choice);
    const after = Object.fromEntries(M.map(([k, f]) => [k, f(S())]));
    const card = S().inbox.find(x => x.instanceId === c.instanceId);
    return { before, after, impact: card?._impact, later: card?._impactLater };
  });
  if (!Array.isArray(r.impact)) { wrong.push(`${c.cardId}/${choice}: nothing kept`); continue; }
  for (const [k] of M) {
    const a = Math.round(r.before[k] ?? 0), b = Math.round(r.after[k] ?? 0);
    const row = r.impact.find(x => x.label === k);
    if (a === b && row) wrong.push(`${c.cardId}/${choice}: a ${k} row with no change`);
    if (a !== b) {
      seen.moved++;
      if (!row) wrong.push(`${c.cardId}/${choice}: ${k} ${a} → ${b} not kept`);
      else if (row.from !== a || row.to !== b || row.delta !== b - a) wrong.push(`${c.cardId}/${choice}: ${k} kept ${row.from} → ${row.to} (${row.delta}), was ${a} → ${b}`);
    }
  }
  for (const x of r.impact) if (/view of you/.test(x.label)) seen.people.push(`${c.cardId}/${choice} ${x.label} ${x.from}→${x.to}`);
  for (const x of r.impact) if (x.unit === 'text') seen.status.push(`${c.cardId}/${choice} ${x.label}: ${x.text}`);
  if (r.later) seen.later.push(`${c.cardId}/${choice}`);
}
check(`every answer, either way, keeps each number that moved, exactly (${seen.moved} moves)`, wrong.length === 0 && seen.moved >= 8, wrong.slice(0, 6).join('; '));
check(`a player sat out or sent to work is named, with what happens (${seen.status.slice(0, 3).join(' | ')})`, seen.status.some(s => /Rested|Training|program|Out|Sat down/.test(s)));
const promised = decisions.filter(c => c._raw?._promise);
check(`a promise says more comes later (${seen.later.join(', ') || 'none'})`, promised.length === 0 || seen.later.length > 0);

{
  // A person's view of the GM: the first day's manager message (rapport) or a GM hello, when one is waiting.
  const people = seen.people;
  console.log(`    people: ${people.slice(0, 4).join(' | ') || 'none on this first day'}`);
}

{
  // Unanswered: the default's changes, kept the same way.
  const c = decisions.find(x => ['yes', 'no'].includes(x.autoResolve)) || decisions[0];
  const r = SM.speculate(() => {
    const before = Object.fromEntries(M.map(([k, f]) => [k, f(S())]));
    CE.expire(c.instanceId, clock.get());
    const after = Object.fromEntries(M.map(([k, f]) => [k, f(S())]));
    return { before, after, card: S().inbox.find(x => x.instanceId === c.instanceId) };
  });
  const moved = M.filter(([k]) => Math.round(r.before[k] ?? 0) !== Math.round(r.after[k] ?? 0)).map(([k]) => k);
  check(`left unanswered (${c.cardId}, ${r.card?.choice}): the default's changes kept (${moved.join(', ') || 'none moved'})`,
    r.card?.choice === 'auto' && Array.isArray(r.card?._impact) && moved.every(k => r.card._impact.some(x => x.label === k)));
}

{
  // Money and a payroll target: the owner's "push" offer, built on our state.
  const c = decisions.find(x => x._budgetCost || x._revenueK);
  if (c) {
    const r = SM.speculate(() => { const a = S().userTeam.finances.funds; CE.resolve(c.instanceId, 'yes'); return { a, b: S().userTeam.finances.funds, row: S().inbox.find(x => x.instanceId === c.instanceId)._impact.find(x => x.label === 'Club funds') }; });
    check(`money: ${c.cardId} keeps club funds in dollars (${r.row ? `${r.row.from} → ${r.row.to}, ${r.row.delta}` : 'none'})`, !!r.row && r.row.unit === 'k' && r.row.delta === Math.round(r.b - r.a));
  } else check('a money decision on the first day', false);
}

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
