// r166 §122.35 phase 4 — the Bench Coach teaches a position. Compose → Bench Coach → "Teach a player a
// position" → a hitter and a position: the coach's read (how hard, how many days of reps, the odds),
// a decision; free, in practice already on the schedule (no time away), one player at a time. Each
// day of reps takes or doesn't; familiarity rises toward its cap (never eligibility — that's games);
// the coach reports when it's done. And the staff's new suggestion: a thin spot the coach could cover.
//   node tools/harness/check-teaching.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Pos from '../../engine/Positions.js';
import { teachRead, activeTeaching } from '../../engine/PlayerWork.js';
import { adviceFor, adviceStamp } from '../../engine/RosterAdvice.js';
import { liveUntil } from './drive.mjs';
import { POSITION_RULES as R } from '../../data/constants.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

seedRandom(101);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id];
const bench = () => S().userTeam.lineupSlots.map(s => s.playerId);
const coach = () => S().userTeam.coachingStaff?.benchCoach?.name;
function ask(arg) {
  CE.deliverComposeCard('bc_teach', 'bench_coach', { topicLabel: 'test', arg, nowMs: clock.get() });
  const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === 'bc_teach').sort((a, b) => b._sentAtMs - a._sentAtMs)[0];
  clock.set(pending.deliverAtMs + 1000);
  CE.releaseDueCards(clock.get());
  return CE.getInbox().find(c => c.instanceId === pending.instanceId);
}

// ── The read ────────────────────────────────────────────────────
console.log('The Bench Coach\'s read');
const ss = S().players[S().userTeam.lineupSlots.find(s => s.slot === 'SS').playerId];
const first = S().players[S().userTeam.lineupSlots.find(s => s.slot === '1B').playerId];
SM.mutate(s => { for (const p of [s.players[ss.id], s.players[first.id]]) { p.positions.elig = [p.positions.primary]; p.positions.fam = {}; p.pos = p.nativePos = p.positions.primary; } });
const rEasy = teachRead(S(), ss.id, '3B'), rHard = teachRead(S(), first.id, 'SS'), rC = teachRead(S(), ss.id, 'C');
check(`a shortstop to third: easy, ${rEasy.days} days, odds ${rEasy.oddsWord}`, rEasy.difficulty === 'easy' && rEasy.days === R.teach.days.easy);
check(`a first baseman to short: hard, ${rHard.days} days, odds ${rHard.oddsWord}`, rHard.difficulty === 'hard' && rHard.days === R.teach.days.hard && rHard.odds < rEasy.odds);
check(`anyone to catcher: its own road, ${rC.days} days, odds ${rC.oddsWord}`, rC.difficulty === 'C' && rC.days === R.teach.days.C && rC.odds < rHard.odds);
check('a position he already plays isn\'t offered', !teachRead(S(), ss.id, 'SS'));

// ── Ask through Compose ─────────────────────────────────────────
console.log('Compose → Bench Coach → teach a position');
const card = ask({ playerId: ss.id, skill: '3B', label: ss.name });
console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body}  [${card?.yesLabel} / ${card?.noLabel}]`);
check('the reply: the coach\'s read, a decision', !!card && card._raw?.onYes === 'teach_position' && /days? of extra reps at third/.test(card.body) && /costs us nothing/.test(card.body) && /ten starts at 3B/.test(card.body));
check('…in the coach\'s own voice, gender-neutral', voiceProblems(card, () => null).filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(card.body));
CE.resolve(card.instanceId, 'yes');
const t = activeTeaching(S());
check(`yes: the work is on (${t?.days} days), and ${ss.name} stays in the lineup`, !!t && t.playerId === ss.id && t.pos === '3B' && bench().includes(ss.id) && !P(ss.id).unavailable);
const busy = ask({ playerId: first.id, skill: 'SS', label: first.name });
check(`one at a time: asked about ${first.name} meanwhile, the coach is busy ("${busy?.body?.slice(0, 70)}…")`, !!busy && !busy._raw?.onYes && /one player at a time/.test(busy.body));

// ── The days of reps ────────────────────────────────────────────
console.log('The days of reps');
const f0 = Pos.familiarity(P(ss.id), '3B');
await liveUntil(t.startAt + (t.days + 1) * DAY);
const done = (S().teaching || []).find(x => x.id === t.id);
const f1 = Pos.familiarity(P(ss.id), '3B');
const took = done.steps.filter(s => s.took).length;
check(`${done.days} days: ${took} took — familiarity at 3B ${f0} → ${f1} (cap ${R.famCap.easy})`, done.status === 'done' && f1 > f0 && f1 <= R.famCap.easy + 1e-9 && Math.abs(f1 - Math.min(R.famCap.easy, took * R.famStep.easy)) < 1e-6);
check('…not eligible: that takes games', !Pos.canPlay(P(ss.id), '3B'));
const report = CE.getInbox().find(c => c.cardId === 'teach_report' && c._targetPlayerId === ss.id);
console.log(`    “${report?.subject}” (${report?.sender}) — ${report?.body?.replace(/\n/g, ' / ')}`);
check('the coach reports how it went', !!report && report.sender === (coach() || 'Bench Coach') && !GEN.test(report.body));
check('…and is free again', !activeTeaching(S()));
const rAgain = teachRead(S(), ss.id, '3B');
if (rAgain.maxed) check('fully practiced: the coach says it\'s games from here', /it's games/.test(ask({ playerId: ss.id, skill: '3B', label: ss.name })?.body || ''));
else check('not fully practiced yet: more reps can be asked for', !rAgain.busy);

// ── A thin spot ─────────────────────────────────────────────────
console.log('A thin spot: the staff suggests who to teach');
SM.mutate(s => {
  // nobody on the bench plays SS any more
  const seated = new Set(s.userTeam.lineupSlots.map(x => x.playerId));
  for (const id of s.userTeam.rosterIds) {
    const p = s.players[id];
    if (!p || seated.has(id) || ['SP', 'RP'].includes(p.pos) || !p.positions) continue;
    p.positions.elig = (p.positions.elig || []).filter(x => x !== 'SS');
    if (p.positions.primary === 'SS') { p.positions.primary = p.positions.elig[0] || 'DH'; }
    p.pos = p.nativePos = Pos.posLabel(p);
  }
  s.adviceWatch = {}; s.adviceQuiet = {};
});
const cover = adviceFor(S(), (a) => a.kind !== 'cover').find(a => a.kind === 'cover' && a.slot === 'SS');
if (process.env.DBG) { const sea = new Set(bench()); console.log('    dbg', adviceFor(S()).map(a => a.key).join(' '), '| bench:', S().userTeam.rosterIds.map(P).filter(p => p && !sea.has(p.id) && !['SP','RP'].includes(p.pos)).map(p => `${p.name}:${Pos.posLabel(p)}:${p.group}:${p.isInjured}:${!!p.unavailable}`).join(' '), 'teach', !!activeTeaching(S())); }
check(`nobody behind the shortstop: the staff would teach ${cover ? P(cover.inId).name : '—'} (${cover?.difficulty})`, !!cover && !bench().includes(cover.inId));
// only that suggestion in view
SM.mutate(s => { s.adviceQuiet = Object.fromEntries(adviceFor(s, (a) => a.kind === 'cover').map(a => [a.key, { atMs: clock.get(), gap: a.gap, stamp: adviceStamp(s, a) }])); });
for (const c of [...(S().inbox || [])].filter(c => !c.resolved && (c.cardId === 'roster_advice' || c.cardId === 'rest_ask'))) CE.resolve(c.instanceId, 'no');
SM.mutate(s => { s.adviceWatch = {}; s.inbox = s.inbox.filter(c => !['rest_ask', 'roster_advice'].includes(c.cardId)); s.scheduledCards = (s.scheduledCards || []).filter(c => !['rest_ask', 'roster_advice'].includes(c.cardId)); });
const t2 = S().schedule.find(g => !g._committed && !g.cancelled && g.gameTime > clock.get());
await liveUntil(t2.gameTime + 5 * 3600_000);
// (only this suggestion in view: everything else quiet, nothing waiting)
SM.mutate(s => {
  s.adviceWatch = {};
  s.adviceQuiet = Object.fromEntries(adviceFor(s, (a) => a.kind === 'cover').map(a => [a.key, { atMs: clock.get(), gap: a.gap, stamp: adviceStamp(s, a) }]));
  s.inbox = s.inbox.filter(c => !['rest_ask', 'roster_advice', 'lineup_return'].includes(c.cardId));
  s.scheduledCards = (s.scheduledCards || []).filter(c => !['rest_ask', 'roster_advice', 'lineup_return'].includes(c.cardId));
});
if (process.env.DBG) console.log('    dbg', adviceFor(S(), (a) => !!S().adviceQuiet[a.key]).map(a => a.kind).join(','), !!activeTeaching(S()), S().phase, S().schedule[S().currentGameIndex]?.gameTime - clock.get(), Object.keys(S().adviceQuiet).length);
CE.syncRosterCards([], clock.get());
const sug = [...(S().inbox || []), ...(S().scheduledCards || [])].find(c => c.cardId === 'roster_advice' && c._advice?.kind === 'cover' && !c.resolved);
if (sug) CE.releaseDueCards(Math.max(clock.get(), sug.deliverAtMs + 1000));
console.log(`    “${sug?.subject}” (${sug?.sender}) — ${sug?.body}  [${sug?.yesLabel} / ${sug?.noLabel}]`);
check('the Bench Coach writes: who to teach, and "I Have a Plan"', !!sug && sug.sender === (coach() || 'Bench Coach') && sug.noLabel === 'I Have a Plan' && /Teach .+ SS/.test(sug.yesLabel) && !GEN.test(sug.body));
if (sug) {
  CE.resolve(sug.instanceId, 'yes');
  const t3 = activeTeaching(S());
  check(`yes: the coach starts teaching ${P(cover.inId).name} at SS`, !!t3 && t3.playerId === sug._advice.inId && t3.pos === 'SS');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
