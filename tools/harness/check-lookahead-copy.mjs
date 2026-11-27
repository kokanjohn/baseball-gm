/**
 * tools/harness/check-lookahead-copy.mjs
 * DEV/TEST ONLY — r293 §122.175 (foundation step 5): the look-ahead's worker gets the save less the league's finished
 * box scores (LookAhead.lookAheadCopy), and foresees exactly what it would from the whole save.
 *
 * At moments through spring and 50 games (game days, mornings, nights, an off day), the worker's work
 * (StateManager.adopt, then foresee) is run on a copy of the whole save and on lookAheadCopy, and the answers
 * compared: our next game and every message through the next day, serialized byte for byte.
 *
 *   node tools/harness/check-lookahead-copy.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { foresee, lookAheadCopy, catchUp } from '../../engine/LookAhead.js';
import { runAt, setClock } from '../../engine/Clock.js';
import { setSeenMoments, deliverComposeCard } from '../../engine/CardEngine.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000;
const GAME_HORIZON_MS = 36 * HOUR, MESSAGES_AHEAD_MS = 24 * HOUR;   // (as ui/PushClient.js)

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(2931);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'ember', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'south' });
const slotId = SM.getActiveSlotId();

/** The worker's work on a copy of `state` (structured, as postMessage copies it). */
function worker(state, nowMs) {
  SM.adopt(structuredClone(state));
  setSeenMoments([]);
  return JSON.stringify(foresee(nowMs, nowMs + MESSAGES_AHEAD_MS, GAME_HORIZON_MS));
}
/** Stricter: the same look-ahead, and everything it made — each new message in full (its words included), and the
 *  whole state after it, less the league's box scores (the copy has none to compare). */
const noLeagueBoxes = (st) => JSON.stringify(lookAheadCopy(st));
function inside(state, nowMs) {
  SM.adopt(structuredClone(state));
  setSeenMoments([]);
  return SM.speculate(() => runAt(nowMs, () => {
    const before = new Set((SM.get().inbox || []).map(c => c.instanceId));
    setClock(nowMs + MESSAGES_AHEAD_MS);
    catchUp(nowMs + MESSAGES_AHEAD_MS);
    const made = (SM.get().inbox || []).filter(c => !before.has(c.instanceId));
    return { made: JSON.stringify(made), n: made.length, state: noLeagueBoxes(SM.get()) };
  }));
}
let compared = 0, games = 0, messages = 0, savedKB = 0, bullpen = 0;
const differ = [], differInside = [];
let made = 0;
let asked = 0;
async function at(label) {
  // a question whose answer is written from our last games' box scores (the pitching coach on the bullpen),
  // pending, so the look-ahead writes it: what in a look-ahead does read finished box scores
  if (S().schedule.some(g => g._committed && !g.isSpring)) { deliverComposeCard('pc_bullpen', 'pitching_coach', { topicLabel: 'the bullpen', nowMs: clock.get() }); asked++; }
  await SM.save();   // (the worker's adopt() sets the save aside; load() brings back what was saved)
  const real = S(), now = clock.get();
  const full = structuredClone(real);
  const lean = lookAheadCopy(real);
  const a = worker(full, now), b = worker(lean, now);
  const ia = inside(full, now), ib = inside(lean, now);
  made += ia.n;
  if (ia.made !== ib.made) differInside.push(`${label}: the messages made (${ia.n})`);
  if (ia.state !== ib.state) differInside.push(`${label}: the state after`);
  await SM.load(slotId);   // (the real save back: adopt() set it aside)
  const out = JSON.parse(a);
  bullpen += (out.foreseen?.messages || []).filter(m => m.cardId === 'compose_pc_bullpen' || m._composeTopic === 'pc_bullpen' || /bullpen/i.test(m.subject || '')).length;
  compared++; if (out.game) games++; messages += out.foreseen?.messages?.length || 0;
  savedKB = Math.max(savedKB, (JSON.stringify(real).length - JSON.stringify(lean).length) / 1024);
  if (a !== b) differ.push(`${label}: ${a.length} against ${b.length}`);
  check(`…the copy the real state was: not changed (${label})`, JSON.stringify(S()) === JSON.stringify(real));
}

const sched = () => S().schedule;
const regular = sched().filter(g => !g.isSpring);
const spring = sched().filter(g => g.isSpring);
await liveUntil(spring[3].gameTime - 3 * HOUR); await at('spring, before a game');
for (const i of [4, 12, 25, 38, 49]) {
  const g = regular[i];
  await liveUntil(g.gameTime - 5 * HOUR); await at(`game ${i + 1}, the morning`);
  await liveUntil(g.gameTime + 20 * 60_000); await at(`game ${i + 1}, under way`);
  await liveUntil(g.gameTime + 8 * HOUR); await at(`game ${i + 1}, that night`);
}
const off = regular.findIndex((g, i) => i > 0 && g.gameTime - regular[i - 1].gameTime > 40 * HOUR);
if (off > 0) { await liveUntil(regular[off - 1].gameTime + 20 * HOUR); await at('an off day'); }

check(`the worker foresees the same from the copy as from the whole save (${compared} moments; ${games} next games, ${messages} messages foreseen; ${asked} questions on the bullpen pending, ${bullpen} answered in the look-ahead)`,
  differ.length === 0 && compared >= 10 && messages > 0 && bullpen > 0, differ.slice(0, 4).join('; '));
check(`…and inside it, the same: every message made, in full (${made}, the bullpen answers among them), and the state after`,
  differInside.length === 0 && made > 0, differInside.slice(0, 4).join('; '));
check(`…and the copy is smaller by the league's finished box scores (up to ${Math.round(savedKB)} KB)`, savedKB > 100);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
