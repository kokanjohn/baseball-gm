// r167 §122.35 phase 5 — pitchers' designations. SP and RP are earned in the regular season (three
// starts, five relief outings) and kept by the season's work; a starter in relief gets an age-based
// short-stint boost, takes the outing harder without RP, and pushes the next start; a reliever can be
// put in the rotation any time but tires early until stretched out (starts, long outings, spring, or
// the pitching coach's sim games). The pitching coach suggests role moves from what the arms have done;
// some new clubs start with a swingman.
//   node tools/harness/check-pitcher-roles.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, gmMove } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Pos from '../../engine/Positions.js';
import { starterRested, tireAfterBF, dayOf } from '../../engine/PitchingEngine.js';
import { moveOptions, reconcileRoster, applyRosterMutation } from '../../engine/RosterEngine.js';
import { stretchRead, activeSimGames } from '../../engine/PlayerWork.js';
import { adviceFor, adviceStamp } from '../../engine/RosterAdvice.js';
import { liveUntil } from './drive.mjs';
import { POSITION_RULES, ROSTER_ADVICE, PLAYER_GROUP } from '../../data/constants.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000, R = POSITION_RULES.pitch;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const mk = (pos, extra = {}) => { const p = { id: pos + Math.random(), pos, nativePos: pos, subRatings: { stamina: 60, stuff: 60, control: 60 }, ...extra }; p.positions = Pos.seedPositions(p); return p; };

// ── The rules on their own ──────────────────────────────────────
console.log('A starter in relief');
const sp = mk('SP'), rp = mk('RP'), sw = mk('SP');
sw.positions.roles = ['SP', 'RP'];
const b24 = Pos.reliefBoost(sp, 24), b36 = Pos.reliefBoost(sp, 36);
check(`the short-stint boost by age: 24 → stuff +${b24.stuff}, control ${b24.control}; 36 → +${b36.stuff}, ${b36.control}`, b24.stuff > b36.stuff && b24.control < b36.control && b36.control === 0);
check('…a reliever gets none (it\'s the role already)', Pos.reliefBoost(rp, 24).stuff === 0);
check(`the next start waits: ${Pos.reliefPushDays(sp)} days for a starter, ${Pos.reliefPushDays(sw)} for a swingman, ${Pos.reliefPushDays(rp)} for a reliever`, Pos.reliefPushDays(sp) === R.pushNoRP && Pos.reliefPushDays(sw) === R.pushRP && Pos.reliefPushDays(rp) === 0);
const t0 = Date.UTC(2027, 4, 1, 23);
for (const p of [sp, sw]) p.arm = [{ at: t0 - 10 * DAY, day: dayOf(t0 - 10 * DAY), bf: 25, outs: 18, start: true }, { at: t0, day: dayOf(t0), bf: 4, outs: 3, start: false }];
check('…the starter can\'t start the next day or the one after', !starterRested(sp, t0 + DAY) && !starterRested(sp, t0 + 2 * DAY) && starterRested(sp, t0 + 3 * DAY));
check('…the swingman one day', !starterRested(sw, t0 + DAY) && starterRested(sw, t0 + 2 * DAY));
check(`the outing takes more out of a starter without RP (×${Pos.reliefLoadMult(sp)}) than a swingman (×${Pos.reliefLoadMult(sw)})`, Pos.reliefLoadMult(sp) === R.extraLoad && Pos.reliefLoadMult(sw) === 1);

console.log('A reliever in the rotation');
const bf0 = tireAfterBF(rp, true), bf3 = tireAfterBF(sp, true);
const rp2 = mk('RP'); rp2.positions.stretch = 2;
check(`a reliever starting tires early (${bf0} batters), part way stretched out longer (${tireAfterBF(rp2, true)}), a starter ${bf3}`, bf0 < tireAfterBF(rp2, true) && tireAfterBF(rp2, true) < bf3 && bf0 === tireAfterBF(rp, false));

console.log('Earned in the regular season');
const r1 = mk('RP');
let got = null;
for (let k = 0; k < 4; k++) got = Pos.recordOuting(r1, { start: true, bf: 18, kind: 'spring' }) || got;
check(`spring starts stretch out (to ${Pos.stretchOf(r1)}) but don't count toward SP`, Pos.stretchOf(r1) === 3 && !got && !Pos.pitchRoles(r1).includes('SP'));
const r2 = mk('RP'); const gains = [];
for (let k = 0; k < R.gainStarts; k++) gains.push(Pos.recordOuting(r2, { start: true, bf: 15 }));
check(`three regular-season starts: SP earned on the third (${Pos.posLabel(r2)})`, gains.slice(0, -1).every(x => !x) && gains.at(-1) === 'SP' && Pos.posLabel(r2) === 'RP/SP' && r2.pos === 'RP');
const s2 = mk('SP'); const g2 = [];
for (let k = 0; k < R.gainRelief; k++) g2.push(Pos.recordOuting(s2, { start: false, bf: 4 }));
check(`five relief outings: RP earned (${Pos.posLabel(s2)})`, g2.at(-1) === 'RP' && Pos.posLabel(s2) === 'SP/RP');
const r3 = mk('RP'); Pos.recordOuting(r3, { start: false, bf: R.longBF });
check(`a long relief outing (${R.longBF} batters) stretches a reliever a step`, Pos.stretchOf(r3) === 1);

console.log('The season turn');
const a = mk('SP'); a.positions.roles = ['SP', 'RP']; a.positions.starts = 2; a.positions.relief = 30;
Pos.pitcherSeasonTurn(a);
check(`a swingman who mostly relieved: RP now, SP lost, a head start kept (${Pos.posLabel(a)}, stretch ${Pos.stretchOf(a)})`, Pos.posLabel(a) === 'RP' && a.pos === 'RP' && Pos.stretchOf(a) === R.keepHead);
const b = mk('SP'); b.positions.roles = ['SP', 'RP']; b.positions.starts = 25; b.positions.relief = 9;
Pos.pitcherSeasonTurn(b);
check(`a starter who relieved ${R.keepRelief}+ times keeps both (${Pos.posLabel(b)})`, Pos.posLabel(b) === 'SP/RP');
const c = mk('RP'); Pos.pitcherSeasonTurn(c);
check('a pitcher who never pitched keeps everything', Pos.posLabel(c) === 'RP');

// ── In a club ───────────────────────────────────────────────────
seedRandom(167);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'lab', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id], U = () => S().userTeam;
const ours = () => U().rosterIds.map(P).filter(Boolean);

console.log('A new club\'s swingman');
const fakeDraft = structuredClone(S());
for (const p of Object.values(fakeDraft.players)) if (p.teamId === 'user' && p.positions?.roles) p.positions.roles = [p.positions.primary];
const swingId = Pos.seedSwingman(fakeDraft, 'lab', () => 0);
const swing = fakeDraft.players[swingId];
check(`a starter on the pitcher bench relieves too: ${swing?.name} (${Pos.posLabel(swing)}), still listed as ${swing?.pos}`, !!swing && Pos.posLabel(swing) === 'SP/RP' && swing.pos === 'SP' && !fakeDraft.userTeam.rotation.order.includes(swingId));
check('…not on every club (the institution rolls high: none)', Pos.seedSwingman(structuredClone(fakeDraft), 'institution', () => 0.5) === null);

console.log('MOVE for pitchers');
const reliever = ours().filter(p => p.group === PLAYER_GROUP.BULLPEN && Pos.pitchRoles(p).join() === 'RP').sort((x, y) => y.ovr - x.ovr)[0];
const opts = moveOptions(S(), reliever.id);
console.log(`    ${reliever.name} (RP): ${opts.map(o => `${o.label}${o.oop ? '*' : ''} — ${o.detail}`).join(' · ')}`);
check('a reliever: the bullpen moves first, the rotation after, marked out of role', opts.some(o => o.oop && o.label === 'Rotation') && opts.findIndex(o => o.oop) > opts.findIndex(o => !o.oop) && opts.filter(o => o.label === 'Rotation').every(o => o.oop));
check('…with how far stretched out ("not stretched out: a short start")', opts.find(o => o.label === 'Rotation')?.detail.startsWith('not stretched out'));
const rotKey = opts.find(o => o.label === 'Rotation').key;
check(`the GM puts ${reliever.name} in the rotation`, gmMove(reliever.id, rotKey, clock.get()).ok && U().rotation.order.includes(reliever.id));
SM.mutate(s => applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() })));
check('…and the roster\'s tidy-up leaves it there', U().rotation.order.includes(reliever.id));

console.log('The pitching coach\'s sim games');
SM.mutate(s => { const p = s.players[reliever.id]; p.positions.stretch = 0; });
const read = stretchRead(S(), reliever.id);
check(`the read: ${read.need} sim games, ${read.days} days`, read.need === 3 && read.days === 3 * R.simEveryDays);
CE.deliverComposeCard('pc_stretch', 'pitching_coach', { topicLabel: 'test', arg: { playerId: reliever.id, label: reliever.name }, nowMs: clock.get() });
const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === 'pc_stretch').sort((x, y) => y._sentAtMs - x._sentAtMs)[0];
if (pending) { clock.set(pending.deliverAtMs + 1000); CE.releaseDueCards(clock.get()); }
const card = pending && CE.getInbox().find(c => c.instanceId === pending.instanceId);
console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body?.replace(/\n/g, ' / ')}  [${card?.yesLabel} / ${card?.noLabel}]`);
check('Compose → the pitching coach → the read and a decision', !!card && card._raw?.onYes === 'sim_games' && /sim games?/.test(card.body) && card.yesLabel === 'Start the Sim Games');
check('…in the coach\'s own voice, gender-neutral', !!card && voiceProblems(card, () => null).filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(card.body));
CE.resolve(card.instanceId, 'yes');
const sim = activeSimGames(S());
check('yes: the sim games are on the clock, one at a time', !!sim && sim.playerId === reliever.id && sim.steps.length === 3);
let sawOut = false;
for (const st of sim.steps) { await liveUntil(st.atMs + 3 * 3600_000); if (P(reliever.id).unavailable?.reason === 'sim game') sawOut = true; }
await liveUntil(sim.steps.at(-1).atMs + 6 * 3600_000);
check(`three sim games later: stretched out (${Pos.stretchOf(P(reliever.id))} of 3)`, Pos.stretchOf(P(reliever.id)) === 3 && !activeSimGames(S()));
check('…out of the bullpen the day of a sim game', sawOut);
check('…still a reliever by designation: three starts makes it official', !Pos.pitchRoles(P(reliever.id)).includes('SP'));
const report = [...(S().inbox || [])].find(c => c.cardId === 'sim_report' && c._targetPlayerId === reliever.id);
console.log(`    “${report?.subject}” (${report?.sender}) — ${report?.body}`);
check('the pitching coach reports it', !!report && /stretched out/.test(report.subject) && !GEN.test(report.body));
check('…the MOVE note now says stretched out', moveOptions(S(), reliever.id).every(o => o.label !== 'Rotation' || !/short start/.test(o.detail)));

console.log('The pitching coach\'s suggestions');
// a reliever with a starter's stamina, at least as good as the weakest starter
SM.mutate(s => {
  const order = s.userTeam.rotation.order.map(id => s.players[id]);
  const weakest = order.sort((x, y) => x.ovr - y.ovr)[0];
  const r = s.userTeam.rosterIds.map(id => s.players[id]).find(p => p.group === PLAYER_GROUP.BULLPEN && Pos.pitchRoles(p).join() === 'RP' && p.id !== reliever.id);
  r.subRatings.stamina = 70; r.ovr = Math.max(r.ovr, weakest.ovr + 1); r.positions.stretch = 0;
  s._testStretch = r.id;
});
const st1 = adviceFor(S()).find(x => x.kind === 'stretch');
const sp1 = st1 && P(st1.inId);
check(`a reliever with a starter's stamina (${sp1?.name}, ${sp1?.subRatings?.stamina}): stretch out`, !!sp1 && sp1.subRatings.stamina >= ROSTER_ADVICE.stretchStamina && !Pos.pitchRoles(sp1).includes('SP') && Pos.stretchOf(sp1) < 3);
// a starter who can't go deep but has the stuff
SM.mutate(s => {
  const p = s.players[s.userTeam.rotation.order.find(id => id !== reliever.id)];
  p.positions.starts = ROSTER_ADVICE.toPenStarts + 2; p.stats = { ...(p.stats || {}), ip: (ROSTER_ADVICE.toPenStarts + 2) * 4.1 };
  p.subRatings.stuff = 75; s._testPen = p.id;
});
const tp = adviceFor(S()).find(x => x.kind === 'to_pen');
check(`a starter going ${tp?.ipPerStart} innings a start, with the stuff: to the bullpen`, !!tp && tp.inId === S()._testPen);
// the card
SM.mutate(s => { s.adviceWatch = {}; s.adviceQuiet = {}; s.inbox = s.inbox.filter(c => c.cardId !== 'roster_advice'); s.scheduledCards = (s.scheduledCards || []).filter(c => c.cardId !== 'roster_advice'); });
// (only this suggestion in view: anything else the staff raises gets "I Have a Plan")
let sug = null;
for (let k = 0; k < 10 && !sug; k++) {
  SM.mutate(s => { s.adviceWatch = {}; s.adviceQuiet = { ...(s.adviceQuiet || {}), ...Object.fromEntries(adviceFor(s).filter(x => x.kind !== 'to_pen').map(x => [x.key, { atMs: clock.get(), gap: x.gap, stamp: adviceStamp(s, x) }])) }; });
  CE.syncRosterCards([], clock.get());
  const c = [...(S().inbox || []), ...(S().scheduledCards || [])].find(c => c.cardId === 'roster_advice' && !c.resolved);
  if (!c) continue;
  if (c._advice?.kind === 'to_pen') { sug = c; break; }
  CE.releaseDueCards(Math.max(clock.get(), c.deliverAtMs + 1000));
  const inb = CE.getInbox().find(x => x.instanceId === c.instanceId);
  if (inb) CE.resolve(inb.instanceId, 'no'); else SM.mutate(s => { s.scheduledCards = s.scheduledCards.filter(x => x.instanceId !== c.instanceId); });
}
if (sug) CE.releaseDueCards(Math.max(clock.get(), sug.deliverAtMs + 1000));
console.log(`    “${sug?.subject}” (${sug?.sender}) — ${sug?.body}  [${sug?.yesLabel} / ${sug?.noLabel}]`);
if (process.env.DBG) console.log('    dbg', adviceFor(S()).map(x => x.key).join(' '), JSON.stringify(S().adviceWatch), (S().inbox || []).filter(c => c.cardId === 'roster_advice').map(c => c._advice?.key + ':' + c.resolved).join(' '));
if (sug) {
  check('the pitching coach writes: move to the bullpen, or "I Have a Plan"', /Bullpen/.test(sug.yesLabel) && sug.noLabel === 'I Have a Plan' && !GEN.test(sug.body));
  CE.resolve(sug.instanceId, 'yes');
  check('yes: in the bullpen, out of the rotation', !U().rotation.order.includes(S()._testPen) && P(S()._testPen).group === PLAYER_GROUP.BULLPEN);
} else check('the pitching coach writes about the starter', false, 'no card');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
