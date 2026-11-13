// r159 §122.31 Work the GM asks for, one player at a time — through Compose, as the GM would:
//   the hitting / pitching coach on one skill (the coach's call: tweaks, or days away at a cost),
//   one player per coach; Scouting/Dev's program; a day off; the physician's read; and the wear
//   that makes a day off matter (every club alike).
//   node tools/harness/check-player-work.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { liveUntil } from './drive.mjs';
import * as CE from '../../engine/CardEngine.js';
import * as Dev from '../../engine/DevelopmentEngine.js';
import { coachRead, programRead, bestStart, gamesMissed, skillsOf, focusedDayK, programCostK } from '../../engine/PlayerWork.js';
import { WEAR, PLAYER_WORK } from '../../data/constants.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

seedRandom(31);
clock.set(clock.real());
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const S = () => SM.get();
const P = (id) => S().players[id];
const isArm = (p) => p.pos === 'SP' || p.pos === 'RP';
const ours = () => S().userTeam.rosterIds.map(P).filter(Boolean);
const funds = () => S().userTeam.finances.funds ?? S().userTeam.finances.cash ?? 0;

/** Ask through Compose, let the reply come back, return it (as the GM reads it). */
function ask(topicId, channelId, arg) {
  const at = clock.get();
  CE.deliverComposeCard(topicId, channelId, { topicLabel: 'test', arg, nowMs: at });
  const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === topicId).sort((a, b) => b._sentAtMs - a._sentAtMs)[0];
  clock.set(pending.deliverAtMs + 1000);
  CE.releaseDueCards(clock.get());
  return CE.getInbox().find(c => c.instanceId === pending.instanceId);
}
/** Live the game as the app does, through `toMs` (the shared driver). */
const playThrough = (toMs) => liveUntil(toMs);
const decision = (c) => !!c?._raw?.onYes;
const voiceOk = (c) => voiceProblems(c, () => null).filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(c.body);

// ── The hitting coach, focused work (a weak skill) ─────────────
console.log('The hitting coach: a weak skill takes days away, at a cost');
const hitters = ours().filter(p => !isArm(p));
// A regular (a bench player develops more slowly — no reps): make the contact weak, so the call is focused work.
const weak = S().userTeam.lineupSlots.map(x => P(x.playerId)).find(p => p && !isArm(p));
SM.mutate(s => { s.players[weak.id].subRatings.contact = 44; });
let read = coachRead(S(), weak.id, 'contact', clock.get());
const dayK = focusedDayK(P(weak.id));
check(`the coach's call for contact 44: focused, ${read.days} days, ${read.costK}K (OVR ${P(weak.id).ovr}: ${dayK}K a day)`, read.kind === 'focused' && read.days === PLAYER_WORK.coach.focusedDaysLow && read.costK === read.days * dayK);
// r160 §122.32 the costs by OVR: a focused day $5K–$10K for nearly everyone, $20K only at the very top;
// a program $25K–$75K for nearly everyone, never $100K.
const day = [50, 60, 70, 75, 85, 92].map(o => focusedDayK({ ovr: o }));
check(`a focused day by OVR 50/60/70/75/85/92: ${day.map(k => `$${k}K`).join(' ')}`, day[0] === 5 && day[2] <= 10 && day[3] <= 13 && day[5] === 20 && day[4] < 20);
const progK = [50, 60, 70, 80, 92].map(o => programCostK({ ovr: o }, 5));
check(`a program by OVR 50/60/70/80/92: ${progK.map(k => `$${k}K`).join(' ')} (7 days at 70: $${programCostK({ ovr: 70 }, 7)}K)`,
      progK[0] === 25 && progK[2] <= 55 && progK[3] <= 80 && progK[4] < 100 && programCostK({ ovr: 70 }, 7) > progK[2]);
const ourCosts = ours().map(p => focusedDayK(p));
check(`our roster: a focused day ${Math.min(...ourCosts)}–${Math.max(...ourCosts)}K, most at $10K or less`, ourCosts.filter(k => k <= 10).length >= ourCosts.length * 0.6 && Math.max(...ourCosts) <= 20);
let c = ask('hc_work', 'hitting_coach', { playerId: weak.id, skill: 'contact' });
console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
check('the reply names the skill, where it stands, the days and the cost', !!c && /contact is 44/.test(c.body) && /3 days away/.test(c.body) && c.body.includes(`$${3 * dayK}K`));
check('…and the games those days cover if started now (and a cheaper start, when there is one)', /If we start today/.test(c.body));
check('…it is a decision: start the work now, or not now', c?.yesLabel === 'Start the Work Now' && c?._raw?.onYes === 'coach_work' && c._raw._workDays === 3 && c._budgetCost === 3 * dayK);
check('…in the coach\'s own voice, gender-neutral', voiceOk(c), c?.body);
const f0 = funds();
CE.resolve(c.instanceId, 'yes');
const away = P(weak.id).unavailable;
check(`yes: ${weak.name} is away for 3 days (by the clock, not games)`, away?.reason === 'training' && away.untilMs - clock.get() <= 3 * DAY && away.untilMs - clock.get() > 3 * DAY - 60_000 && away.gamesLeft == null);
check(`…the work costs what the reply said (${Math.round(f0 - funds())}K)`, Math.round(f0 - funds()) === 3 * dayK);
const plan = (S().developmentPlans || []).find(x => x.playerId === weak.id && x.status === 'active');
check('…and a plan on contact runs, the hitting coach\'s', !!plan && plan.owner === 'hittingCoach' && plan.keys.join() === 'contact' && plan.from.contact === 44);

// ── One player at a time ───────────────────────────────────────
console.log('One player per coach');
const other = hitters.find(p => p.id !== weak.id && !P(p.id).unavailable);
c = ask('hc_work', 'hitting_coach', { playerId: other.id, skill: 'power' });
console.log(`    “${c?.subject}” — ${c?.body?.replace(/\n+/g, ' ')}`);
check(`a second hitter while ${weak.name}'s work runs: the coach is busy, no decision`, !!c && /one player at a time/.test(c.body) && !decision(c));

// ── Back on the clock ──────────────────────────────────────────
console.log('Back after the days away');
await playThrough(away.untilMs + 60_000);
check(`${weak.name} is back when the days are up`, !P(weak.id).unavailable);

// ── The pitching coach: tweaks (a good skill) ──────────────────
console.log('The pitching coach: a good skill takes tweaks — no time away, no cost');
const arm = ours().filter(isArm).sort((a, b) => (b.subRatings.control || 0) - (a.subRatings.control || 0))[0];
SM.mutate(s => { const sr = s.players[arm.id].subRatings; sr.control = 72; sr.stuff = 70; sr.stamina = 66; });
read = coachRead(S(), arm.id, 'control', clock.get());
check('control 72 (the best of the three): tweaks, no days, no cost', read.kind === 'tweaks' && read.days === 0 && read.costK === 0);
c = ask('pc_work', 'pitching_coach', { playerId: arm.id, skill: 'control' });
console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
check('the reply says it needs no time away and costs nothing', !!c && /doesn't need time away/.test(c.body) && /costs us nothing/.test(c.body) && c.yesLabel === 'Start the Work' && !c._budgetCost);
CE.resolve(c.instanceId, 'yes');
check(`yes: ${arm.name} stays available, and the pitching coach's plan on control runs`, !P(arm.id).unavailable
      && (S().developmentPlans || []).some(x => x.playerId === arm.id && x.owner === 'pitchingCoach' && x.keys.join() === 'control'));
check('the room left: a 90 has a quarter of the gain left, a 50 all of it', Dev.roomLeft(90) === 0.25 && Dev.roomLeft(50) === 1);

// ── Scouting/Dev's program ─────────────────────────────────────
console.log('A development program (Scouting/Dev)');
const prog = hitters.find(p => p.id !== weak.id && !P(p.id).unavailable && P(p.id).subRatings.speed < 80);
c = ask('sc_program', 'scouting', { playerId: prog.id, skill: 'speed' });
console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
const pr = programRead(S(), prog.id, 'speed', clock.get());
check(`the program: ${pr?.days} days, ${pr?.costK}K, said in the reply`, !!c && new RegExp(`${pr.days} days`).test(c.body) && c._budgetCost === pr.costK && c._raw?.onYes === 'dev_program');
const f1 = funds();
CE.resolve(c.instanceId, 'yes');
check(`yes: ${prog.name} leaves for ${pr.days} days, the program's plan runs, it costs ${pr.costK}K`, P(prog.id).unavailable?.untilMs > clock.get()
      && (S().developmentPlans || []).some(x => x.playerId === prog.id && x.owner === 'program') && Math.round(f1 - funds()) === pr.costK);

// ── The calendar: days, not games ──────────────────────────────
console.log('Days, not games: the cheapest start');
const w = bestStart(S(), clock.get(), 2);
check(`starting now covers ${w.now.games.length} games; ${w.best ? `after the next game, ${w.best.games.length}` : 'no cheaper start in the window'}`,
      w.now.games.length === gamesMissed(S(), clock.get(), 2).length && (!w.best || w.best.games.length < w.now.games.length));

// ── Wear and a day off ─────────────────────────────────────────
console.log('Wear, and a day off');
const reg = S().userTeam.lineupSlots.map(x => P(x.playerId)).find(p => p && !P(p.id).unavailable && p.id !== weak.id && p.id !== prog.id);
SM.mutate(s => { s.players[reg.id].wear = 0; });
for (let i = 0; i < 3; i++) SM.mutate(s => { Dev.countGame(s, 'user', clock.get() + i * DAY); });
check(`a start adds wear (${reg.name}: ${P(reg.id).wear} after 3 straight)`, P(reg.id).wear >= 3);
SM.mutate(s => { s.players[reg.id].wear = 15; });
check(`at ${WEAR.tired}+ a hitter is worn down: contact and power dip (${Dev.wearOf(P(reg.id)).dip})`, Dev.wearOf(P(reg.id)).tired && Dev.wearOf(P(reg.id)).dip >= WEAR.dip);
c = ask('mgr_rest', 'manager', { playerId: reg.id });
console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
check('the manager: worn down, a day off clears it — a decision', !!c && /needs it/.test(c.body) && c._raw?.onYes === 'day_off' && voiceOk(c));
CE.resolve(c.instanceId, 'yes');
check(`yes: ${reg.name} sits the next game`, P(reg.id).unavailable?.reason === 'rest' && P(reg.id).unavailable.gamesLeft === 1);
SM.mutate(s => { Dev.countGame(s, 'user', clock.get() + DAY); });
check('after the game off: the wear is gone and the hitter is back', (P(reg.id).wear || 0) === 0 && !P(reg.id).unavailable);
// r160 §122.32 our manager never sits anyone on the manager's own say: the lineup is the GM's.
const mine = S().userTeam.lineupSlots.map(x => P(x.playerId)).find(p => p && !isArm(p) && !p.unavailable && !p.isInjured);
SM.mutate(s => { s.players[mine.id].wear = WEAR.cpuRest + 4; s.userTeam._lastGameAt = clock.get(); });
let evU = [];
SM.mutate(s => { evU = Dev.countGame(s, 'user', clock.get() + DAY); });
check(`ours at the CPU limit (${mine.name}): still in the lineup — the GM decides`, !P(mine.id).unavailable && !evU.some(e => e.type === 'RESTED')
      && S().userTeam.lineupSlots.some(x => x.playerId === mine.id));
SM.mutate(s => { s.players[mine.id].wear = 0; });
// A CPU manager sits anyone at the limit.
const cpu = S().leagueTeams[0];
const cpuReg = cpu.lineupSlots.map(x => P(x.playerId)).find(p => p && !isArm(p) && !p.unavailable && !p.isInjured);
// (their last game yesterday: no off days to take the wear back down first)
SM.mutate(s => { s.players[cpuReg.id].wear = WEAR.cpuRest; s.leagueTeams[0]._lastGameAt = clock.get(); });
let ev = [];
SM.mutate(s => { ev = Dev.countGame(s, cpu.id, clock.get() + DAY); });
check(`a CPU club's regular at the limit sits the next game (${cpuReg.name})`, P(cpuReg.id).unavailable?.reason === 'rest' && ev.some(e => e.type === 'RESTED' && e.playerId === cpuReg.id));

// ── The physician ──────────────────────────────────────────────
console.log("The team physician on one player");
const doc = hitters.find(p => p.id !== weak.id && p.id !== prog.id && !P(p.id).unavailable && !P(p.id).isInjured);
SM.mutate(s => { const q = s.players[doc.id]; q.condition = null; q.wear = 14; q.straight = 11; q.injuryLog = [{ label: 'Hamstring Strain', severity: 'minor', days: 9, atMs: clock.get() - 20 * DAY }]; });
c = ask('doc_health', 'physician', { playerId: doc.id });
console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
check('the physician: health now, the file, the wear — read-only, in the first person', !!c && /healthy/.test(c.body) && /hamstring strain/.test(c.body) && /is tired: 11 straight starts/.test(c.body) && !decision(c) && voiceOk(c) && c.sender === 'Team Physician');
check('an injury goes in the player\'s file', Array.isArray(P(doc.id).injuryLog) && P(doc.id).injuryLog.length === 1);

// ── The coach's report when the work is done ───────────────────
console.log("The coach reports back");
// Play on until the work is done (a player who sits develops more slowly; capped at 40 days).
const until = clock.get() + 40 * DAY;
while (clock.get() < until && (S().developmentPlans || []).some(x => x.id === plan.id && x.status === 'active')) await playThrough(clock.get() + 2 * DAY);
const rep = (S().inbox || []).find(x => x.cardId === 'work_report' && (x._playerIds || []).includes(weak.id));   // (read or not)
console.log(`    “${rep?.subject}” (${rep?.sender}) — ${rep?.body}`);
check(`${weak.name}'s work is done: the hitting coach says how it went, contact from 44 to ${P(weak.id).subRatings.contact}`,
      !!rep && /Hitting Coach/.test(rep.sender) && new RegExp(`contact`).test(rep.body) && voiceOk(rep));
check(`…and the coach is free again`, !Dev.activeWork(S(), 'hittingCoach') || Dev.activeWork(S(), 'hittingCoach').playerId !== weak.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
