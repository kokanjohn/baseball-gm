// r162 §122.34 The staff's roster suggestions. A new club starts with a few things to fix (a better bat
// on the bench, a better arm on the pitcher bench). The staff says so — the hitting coach about bats,
// the pitching coach about arms, the scouting director about a young player who'd grow with playing
// time — as a decision: make the change (the move happens), or "I Have a Plan" (quiet for that pairing
// until something changes). Never a pile-up. And playing time now matters to a young player's winter.
//   node tools/harness/check-roster-advice.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, gmMove } from '../../engine/GameEngine.js';
import { liveUntil } from './drive.mjs';
import * as CE from '../../engine/CardEngine.js';
import { adviceFor, adviceStamp } from '../../engine/RosterAdvice.js';
import { ROSTER_ADVICE, PLAYER_GROUP } from '../../data/constants.js';
import { moveOptions } from '../../engine/RosterEngine.js';
import { developForWinter } from '../../engine/OffseasonEngine.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const S = () => SM.get();
const P = (id) => S().players[id];
const advCards = () => [...(S().inbox || []), ...(S().scheduledCards || [])].filter(c => c.cardId === 'roster_advice');
const staff = () => S().userTeam.coachingStaff || {};
const personOf = (sender) => Object.values(staff()).find(x => x?.name && sender === x.name)?.name || null;

seedRandom(61);
clock.set(Number(process.env.T0) || Date.UTC(2026, 10, 13, 15, 0));
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });

// ── A new club: a few things to fix ────────────────────────────
console.log('A new club starts with a few things to fix');
const issues = S().userTeam._startIssues || [];
const adv0 = adviceFor(S());
console.log(`    left: ${issues.map(i => `${i.kind} (${i.gap})`).join(', ')} · the staff sees: ${adv0.map(a => `${a.kind} ${P(a.inId).name}(${P(a.inId).ovr}) over ${P(a.outId).name}(${P(a.outId).ovr})`).join(' · ')}`);
check(`${issues.length} problems left (between ${ROSTER_ADVICE.startIssues.join(' and ')})`, issues.length >= ROSTER_ADVICE.startIssues[0] && issues.length <= ROSTER_ADVICE.startIssues[1]);
check('…each one a suggestion the staff would make', issues.every(i => adv0.some(a => a.kind === i.kind)));
check(`…real but not glaring (each 4–12 apart: ${issues.map(i => i.gap).join(', ')})`, issues.every(i => i.gap >= 4 && i.gap <= 12));
check('…one suggestion per player', new Set(adv0.flatMap(a => [a.inId, a.outId].filter(Boolean))).size === adv0.reduce((n, a) => n + (a.outId ? 2 : 1), 0));

// ── Spring, nobody answering: what arrives, and how often ─────
console.log('Spring, nobody answering');
const t0 = clock.get();
const seen = new Map();
const onStep = () => { for (const c of S().inbox || []) if ((c.cardId === 'roster_advice' || c.cardId === 'rest_ask') && !seen.has(c.instanceId)) seen.set(c.instanceId, { ...c }); };
await liveUntil(t0 + 10 * DAY, { onStep });
const got = [...seen.values()].filter(c => c.cardId === 'roster_advice').sort((a, b) => a.deliverAtMs - b.deliverAtMs);
for (const c of got) console.log(`    ${new Date(c.deliverAtMs).toISOString().slice(5, 16)}  “${c.subject}” (${c.sender}) — ${c.body}  [${c.yesLabel} / ${c.noLabel}]`);
check(`the staff speaks up (${got.length} in the first ten days)`, got.length >= 2 && got.length <= 6);
check('…the first soon after the takeover, never before it', got.length && got[0].deliverAtMs > S().userTeam._takeoverAt && got[0].deliverAtMs - S().userTeam._takeoverAt < 3 * DAY);
const gaps = got.slice(1).map((c, i) => c.deliverAtMs - got[i].deliverAtMs);
check(`…never two close together (shortest ${(Math.min(...gaps, Infinity) / DAY).toFixed(1)} days)`, gaps.every(g => g >= ROSTER_ADVICE.gapMs));
const rest = [...seen.values()].filter(c => c.cardId === 'rest_ask');
check('…nor within half a day of a rest message', got.every(c => rest.every(r => Math.abs(r.deliverAtMs - c.deliverAtMs) >= 12 * 3600_000)));
const who = { bat: staff().hittingCoach?.name, rotation: staff().pitchingCoach?.name, pen: staff().pitchingCoach?.name, prospect: staff().scoutingDirector?.name, cover: staff().benchCoach?.name };
check('…each from the right person (bats: the hitting coach; arms: the pitching coach; a prospect: the scouting director)', got.every(c => c.sender === who[c._advice.kind]), got.map(c => `${c._advice.kind}:${c.sender}`).join(' '));
check('…each a decision: make the change, or "I Have a Plan"', got.every(c => c._raw.onYes === 'advice_move' && c.noLabel === 'I Have a Plan'));
const bad = got.map(c => [c, voiceProblems(c, personOf)]).filter(([c, v]) => v.length || GEN.test(c.body) || GEN.test(c.yesLabel));
check('…in the sender\'s own voice, gender-neutral', !bad.length, bad.map(([c, v]) => `${c.subject}: ${v}`).join(' | '));

// ── Make the change ────────────────────────────────────────────
console.log('Make the change');
for (const c of advCards().filter(c => !c.resolved)) CE.resolve(c.instanceId, 'no');
SM.mutate(s => { s.adviceWatch = {}; s.adviceQuiet = {}; });
let card;
const fresh = () => { CE.syncRosterCards([], clock.get()); card = advCards().find(c => !c.resolved); if (card) CE.releaseDueCards(Math.max(clock.get(), card.deliverAtMs + 1000)); return card; };
// (the quiet from above lifted: the first suggestion again)
fresh();
check('a suggestion waits', !!card, JSON.stringify(adviceFor(S()).map(a => a.key)));
const a1 = card._advice;
CE.resolve(card.instanceId, 'yes');
const inNow = a1.kind === 'bat' || a1.kind === 'prospect' ? S().userTeam.lineupSlots.some(sl => sl.playerId === a1.inId)
            : a1.kind === 'rotation' ? S().userTeam.rotation.order.includes(a1.inId) : P(a1.inId).group === PLAYER_GROUP.BULLPEN;
check(`yes: ${P(a1.inId).name} is in (${a1.kind}), ${P(a1.outId).name} out`, inNow && !adviceFor(S()).some(a => a.key === a1.key));

// ── The GM makes the move instead: the message goes ───────────
console.log('The GM makes the move on the Team screen instead');
SM.mutate(s => { s.adviceWatch = {}; });
fresh();
if (card) {
  const a = card._advice;
  const ok = gmMove(a.move.playerId, a.move.key, clock.get()).ok;
  check(`the GM moves ${P(a.inId).name} in: the message about it is withdrawn`, ok && !advCards().some(c => c.instanceId === card.instanceId));
} else check('a second suggestion to act on', false);

// ── I Have a Plan: quiet until something changes ───────────────
console.log('"I Have a Plan"');
// (a bench bat made clearly better than a starter at a spot it plays)
const u = S().userTeam;
const sl = u.lineupSlots.find(x => x.slot !== 'C' && x.playerId && moveOptions(S(), x.playerId).some(o => o.key.startsWith('in:')));
const starter = P(sl.playerId), sub = P(moveOptions(S(), sl.playerId).find(o => o.key.startsWith('in:')).key.slice(3));
SM.mutate(s => { s.adviceWatch = {}; s.adviceQuiet = {}; s.players[sub.id].ovr = s.players[starter.id].ovr + 6; });
for (const c of advCards().filter(c => !c.resolved)) CE.resolve(c.instanceId, 'no');
SM.mutate(s => { s.adviceWatch = {}; s.adviceQuiet = {}; });
const want = adviceFor(S()).find(a => a.inId === sub.id);
check(`${sub.name} (${P(sub.id).ovr}) on the bench behind ${starter.name} (${starter.ovr}): a suggestion`, !!want);
// keep only that one in view: quiet the others
SM.mutate(s => { for (const a of adviceFor(s)) if (a.key !== want.key) s.adviceQuiet[a.key] = { atMs: clock.get(), gap: a.gap, stamp: adviceStamp(s, a) }; });
fresh();
check('…the hitting coach writes', card?._advice?.key === want.key && card.sender === staff().hittingCoach?.name, card?._advice?.key);
CE.resolve(card.instanceId, 'no');
check(`"I Have a Plan": the reply — "${card.noMsg}"`, /leave it unless something changes/.test(card.noMsg) && !!S().adviceQuiet?.[want.key]);
// (time passing for the quiet without skipping past games — the staff only writes between games)
const again = (days) => {
  // (only the suggestions in view: no rest message holding them back)
  SM.mutate(s => { s.inbox = (s.inbox || []).filter(c => c.cardId !== 'rest_ask'); s.scheduledCards = (s.scheduledCards || []).filter(c => c.cardId !== 'rest_ask'); s.restWatch = { lastAt: clock.get() }; });
  // (another suggestion that came meanwhile — the same bench bat at another spot — answered, out of the way)
  for (const c of advCards().filter(c => !c.resolved && c._advice?.key !== want.key)) { CE.releaseDueCards(Math.max(clock.get(), c.deliverAtMs + 1000)); if (CE.getInbox().some(x => x.instanceId === c.instanceId)) CE.resolve(c.instanceId, 'no'); }
  SM.mutate(s => { s.adviceWatch = {}; if (s.adviceQuiet?.[want.key]) s.adviceQuiet[want.key].atMs -= days * DAY; });
  CE.syncRosterCards([], clock.get());
  const c = advCards().find(c => !c.resolved && c._advice?.key === want.key);
  if (c) CE.releaseDueCards(Math.max(clock.get(), c.deliverAtMs + 1000));
  return c;
};
check('…not raised again a week later, nothing changed', !again(7));
SM.mutate(s => { s.players[sub.id].ovr += 2; });
check('…nor when the gap grows a little (+2)', !again(1));
SM.mutate(s => { s.players[sub.id].ovr += 3; });
const back1 = again(1);
check('…but again once it grows clearly (+5 in all)', !!back1);
if (back1) CE.resolve(back1.instanceId, 'no');
// something changes: the starter is hurt and back (a new injury on the file)
SM.mutate(s => { (s.players[want.outId].injuryLog ||= []).push({ atMs: clock.get(), type: 'test', days: 1 }); });
if (process.env.DBG) { const a = adviceFor(S()).find(x => x.key === want.key); console.log('    dbg', !!a, a && adviceStamp(S(), a), JSON.stringify(S().adviceQuiet?.[want.key]), advCards().filter(c => !c.resolved).length, [...(S().inbox||[])].filter(c => !c.resolved && /rest|advice/.test(c.cardId)).map(c=>c.cardId)); }
const back2 = again(1);
if (process.env.DBG) console.log('    dbg2', !!back2, JSON.stringify(S().adviceWatch), S().schedule[S().currentGameIndex]?.gameTime - clock.get());
check('…and again when someone involved has been hurt since', !!back2);
if (back2) CE.resolve(back2.instanceId, 'no');
check(`…and after ${ROSTER_ADVICE.quietMs / DAY} days, whatever happened`, !!again(ROSTER_ADVICE.quietMs / DAY + 1));

// ── A prospect ─────────────────────────────────────────────────
console.log('A prospect');
for (const c of advCards().filter(c => !c.resolved)) CE.resolve(c.instanceId, 'no');
{
  const s0 = S(), uu = s0.userTeam;
  const slot = uu.lineupSlots.find(x => x.slot !== 'C' && moveOptions(s0, x.playerId).some(o => o.key.startsWith('in:')));
  const reg = P(slot.playerId), kid = P(moveOptions(s0, slot.playerId).find(o => o.key.startsWith('in:')).key.slice(3));
  const year = new Date(clock.get()).getUTCFullYear();
  SM.mutate(s => {
    s.adviceWatch = {}; s.adviceQuiet = {};
    s.players[kid.id].ovr = s.players[reg.id].ovr - 3;
    s.players[kid.id].dob = `${(s.baseYear || year) + (s.seasonNum || 1) - 1 - 22}-04-01`;
    for (const a of adviceFor(s, (x) => x.kind === 'prospect' && x.inId === kid.id)) s.adviceQuiet[a.key] = { atMs: clock.get(), gap: a.gap, stamp: adviceStamp(s, a) };   // (all but the prospect one)
  });
  fresh();
  console.log(`    “${card?.subject}” (${card?.sender}) — ${card?.body}  [${card?.yesLabel} / ${card?.noLabel}]`);
  check(`${kid.name}, 22, three behind ${reg.name}: the scouting director asks for playing time`, card?._advice?.kind === 'prospect' && card._advice.inId === kid.id
        && card.sender === staff().scoutingDirector?.name && /grow/.test(card.body) && !GEN.test(card.body));
}

// ── Playing time and a young player's winter ──────────────────
console.log('A young player\'s winter: playing time matters');
{
  const base = Object.values(S().players).find(p => p.teamId === 'user' && !['SP', 'RP'].includes(p.pos));
  const year = 2030;
  const run = (played) => {
    let sum = 0;
    for (let i = 0; i < 300; i++) {
      const p = structuredClone(base);
      p.dob = `${year - 22}-04-01`; p.trait = 'consistent';
      p.subRatings = { contact: 55, power: 55, speed: 55 };
      developForWinter(p, year, 1, null, 0, played);
      sum += p.subRatings.contact + p.subRatings.power + p.subRatings.speed - 165;
    }
    return sum / 300;
  };
  const reg = run(0.8), sat = run(0.05), none = run(null);
  check(`22-year-old hitter, per winter (three ratings): a regular +${reg.toFixed(1)}, untracked +${none.toFixed(1)}, one who sat +${sat.toFixed(1)}`, reg > none + 0.6 && sat < none - 0.6);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
