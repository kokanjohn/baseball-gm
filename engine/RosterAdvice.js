/**
 * engine/RosterAdvice.js
 * r162 §122.34 What the staff would change about our roster, and a new club's
 * starting roster left with a few of those to find.
 *
 *   adviceFor(state)      — the suggestions now, each a move the GM could make:
 *     'bat'       a better bat on the bench than the starter at a position (hitting coach)
 *     'rotation'  a better starter on the pitcher bench than one in the rotation (pitching coach)
 *     'pen'       a better reliever on the pitcher bench than one in the bullpen (pitching coach)
 *     'prospect'  a young bench player who'd grow with regular playing time, and
 *                 isn't far behind the regular (Scouting/Dev)
 *   adviceStamp(state, s) — the situation a "I have a plan" was given in (who's
 *                 where, healthy or not): when it changes, the quiet ends.
 *   leaveIssues(draft, rand, n) — a new club: n of those suggestions made true.
 *
 * Pure: never imports StateManager. Moves are RosterEngine's (the Team screen's MOVE).
 */

import { PLAYER_GROUP, ROSTER_ADVICE, POSITION_RULES } from '../data/constants.js';
import { canPlay, difficulty, familiarity } from './Positions.js';
import { activeTeaching, teachablePositions, teachRead, startTeaching } from './PlayerWork.js';
import { isAvailable, computeAge, baseballYear } from './PlayerFactory.js';
import { eligibleSlotsFor, moveOptions, applyMove, tradedAway } from './RosterEngine.js';

const A = ROSTER_ADVICE;
const START_MAX_GAP = 12;   // a new club's problems: real, not glaring (no ace left on the bench)

function _ours(state) {
  const u = state.userTeam, players = state.players || {};
  const ok = (p) => p && p.teamId === 'user' && isAvailable(p) && !p.isInjured && !tradedAway(state, p.id);
  const all = (u?.rosterIds || []).map(id => players[id]).filter(ok);
  const seated = new Set((u?.lineupSlots || []).map(sl => sl.playerId).filter(Boolean));
  return { u, players, ok, all, seated, year: baseballYear(state) };
}

/** A move that exists now (the same options the Team screen offers). */
const _can = (state, playerId, key) => moveOptions(state, playerId).some(o => o.key === key);

/**
 * adviceFor(state, skip) → [{ kind, key, inId, outId, slot, gap, move: { playerId, key } }]
 * (`skip(s)`: suggestions to leave out before the one-per-player rule — those the GM has answered)
 * `inId` is who the staff wants playing, `outId` who'd give way.
 */
export function adviceFor(state, skip = null) {
  const { u, players, ok, all, seated, year } = _ours(state);
  if (!u) return [];
  const out = [];
  const bench = all.filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS && !['SP', 'RP'].includes(p.pos) && !seated.has(p.id));
  // ── Bats: the best bench bat for each spot, when clearly better than the starter there ──
  (u.lineupSlots || []).forEach((sl, j) => {
    const o = sl.playerId ? players[sl.playerId] : null;
    if (!ok(o)) return;
    const fits = bench.filter(b => eligibleSlotsFor(b).includes(sl.slot));
    const best = fits.sort((a, b) => b.ovr - a.ovr)[0];
    if (best && best.ovr - o.ovr >= A.hitterGap && _can(state, best.id, `slot:${j}`)) {
      out.push({ kind: 'bat', key: `bat:${best.id}:${o.id}`, inId: best.id, outId: o.id, slot: sl.slot, gap: best.ovr - o.ovr,
                 move: { playerId: best.id, key: `slot:${j}` } });
      return;
    }
    // ── A prospect: young, behind the regular but not by much ──
    const young = fits.filter(b => computeAge(b.dob, year) <= A.prospectAge && o.ovr - b.ovr <= A.prospectGap && o.ovr >= b.ovr)
      .sort((a, b) => b.ovr - a.ovr)[0];
    if (young && _can(state, o.id, `in:${young.id}`)) {
      out.push({ kind: 'prospect', key: `prospect:${young.id}:${o.id}`, inId: young.id, outId: o.id, slot: sl.slot, gap: young.ovr - o.ovr,
                 move: { playerId: o.id, key: `in:${young.id}` } });
    }
  });
  // ── Arms ──
  const order = u.rotation?.order || [];
  const rot = order.map((id, k) => ({ p: players[id], k })).filter(x => ok(x.p));
  const benchSP = all.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'SP').sort((a, b) => b.ovr - a.ovr);
  const weakest = [...rot].sort((a, b) => a.p.ovr - b.p.ovr)[0];
  if (weakest && benchSP[0]) {
    const b = benchSP[0], gap = b.ovr - weakest.p.ovr;
    if (gap >= A.armGap && _can(state, b.id, `turn:${weakest.k}`)) {
      out.push({ kind: 'rotation', key: `rotation:${b.id}:${weakest.p.id}`, inId: b.id, outId: weakest.p.id, slot: 'rotation', gap,
                 move: { playerId: b.id, key: `turn:${weakest.k}` } });
    } else {
      const y = benchSP.find(x => computeAge(x.dob, year) <= A.prospectAge && weakest.p.ovr - x.ovr <= A.prospectGap && weakest.p.ovr >= x.ovr);
      if (y && _can(state, y.id, `turn:${weakest.k}`)) {
        out.push({ kind: 'prospect', key: `prospect:${y.id}:${weakest.p.id}`, inId: y.id, outId: weakest.p.id, slot: 'rotation', gap: y.ovr - weakest.p.ovr,
                   move: { playerId: y.id, key: `turn:${weakest.k}` } });
      }
    }
  }
  const pen = all.filter(p => p.group === PLAYER_GROUP.BULLPEN && p.pos === 'RP').sort((a, b) => a.ovr - b.ovr);
  const benchRP = all.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'RP').sort((a, b) => b.ovr - a.ovr);
  if (pen[0] && benchRP[0] && benchRP[0].ovr - pen[0].ovr >= A.armGap && _can(state, benchRP[0].id, `pen:${pen[0].id}`)) {
    out.push({ kind: 'pen', key: `pen:${benchRP[0].id}:${pen[0].id}`, inId: benchRP[0].id, outId: pen[0].id, slot: 'bullpen',
               gap: benchRP[0].ovr - pen[0].ovr, move: { playerId: benchRP[0].id, key: `pen:${pen[0].id}` } });
  }
  // r166 §122.35 a thin spot: nobody on the bench can play a fielding position, and the Bench Coach is
  // free — the bench player who'd pick it up most easily (then the most familiar, then the best) could
  // be taught it.
  if (!activeTeaching(state)) {
    const healthyBench = bench.filter(b => !b.isInjured);
    const seenPos = new Set();
    for (const sl of u.lineupSlots || []) {
      if (sl.slot === 'DH' || seenPos.has(sl.slot)) continue;
      seenPos.add(sl.slot);
      if (healthyBench.some(b => canPlay(b, sl.slot))) continue;
      const D = { easy: 0, hard: 1, C: 2 };
      const pick = healthyBench.filter(b => teachablePositions(b).includes(sl.slot) && familiarity(b, sl.slot) < POSITION_RULES.famCap[difficulty(b, sl.slot)] - 1e-9)
        .sort((a, b) => (D[difficulty(a, sl.slot)] - D[difficulty(b, sl.slot)]) || (familiarity(b, sl.slot) - familiarity(a, sl.slot)) || (b.ovr - a.ovr))[0];
      if (pick) out.push({ kind: 'cover', key: `cover:${sl.slot}:${pick.id}`, inId: pick.id, outId: null, slot: sl.slot, gap: 0,
                           difficulty: difficulty(pick, sl.slot), move: null });
    }
  }
  // One suggestion per player: the clearest first (a better player, then a prospect, then a spot to cover; the widest gap first).
  const rank = { prospect: 1, cover: 2 };
  out.sort((a, b) => ((rank[a.kind] || 0) - (rank[b.kind] || 0)) || (b.gap - a.gap));
  // (r166 a suggestion the GM has answered, or was just asked, doesn't hold another back: `skip` first)
  const seen = new Set();
  return out.filter(x => !(skip && skip(x))).filter(x => !seen.has(x.inId) && !(x.outId && seen.has(x.outId)) && (seen.add(x.inId), x.outId && seen.add(x.outId), true));
}

/** The situation of a suggestion's two players: where they are, healthy or not, still ours. */
export function adviceStamp(state, s) {
  return [s.inId, s.outId].map(id => {
    const p = state.players?.[id];
    return p ? `${p.teamId}|${p.group}|${p.isInjured ? 1 : 0}|${(p.injuryLog || []).length}` : 'gone';
  }).join('/');
}

/** Carry out a suggestion's move (on a draft; the caller reconciles). False when it no longer exists. */
export function applyAdvice(draft, s, atMs = 0) {
  if (s.kind === 'cover') {   // r166 the Bench Coach starts teaching the spot
    const read = teachRead(draft, s.inId, s.slot);
    return !!read && !read.busy && startTeaching(draft, { playerId: s.inId, pos: s.slot, odds: read.odds }, atMs).length > 0;
  }
  return applyMove(draft, s.move.playerId, s.move.key);
}

/**
 * leaveIssues(draft, rand, n) — r162 a new club's roster, not quite sorted: n
 * of the kinds the staff would raise made true (a better bat sent to the bench,
 * a better arm to the pitcher bench), different each time. Returns what it did ([{ kind, gap }]).
 */
export function leaveIssues(draft, rand, n) {
  const u = draft.userTeam, players = draft.players;
  const done = [];
  const ok = (p) => p && isAvailable(p) && !p.isInjured;
  const ops = [];
  // A starter and a bench bat at his spot, the starter clearly better: they trade places.
  // (Fielding spots only — r163: a DH swap could bat the backup catcher at DH, leaving nobody on the
  //  bench to catch; the staff can still raise a DH change that comes up on its own.)
  (u.lineupSlots || []).forEach((sl, j) => {
    const o = players[sl.playerId];
    if (!ok(o) || sl.slot === 'DH') return;
    const seated = new Set(u.lineupSlots.map(x => x.playerId));
    const b = (u.rosterIds || []).map(id => players[id]).find(p => ok(p) && p.group === PLAYER_GROUP.BENCH_HITTERS && !['SP', 'RP'].includes(p.pos)
      && !seated.has(p.id) && eligibleSlotsFor(p).includes(sl.slot) && o.ovr - p.ovr >= A.hitterGap && o.ovr - p.ovr <= START_MAX_GAP);
    if (b) ops.push({ kind: 'bat', gap: o.ovr - b.ovr, run: () => _can(draft, b.id, `slot:${j}`) && applyMove(draft, b.id, `slot:${j}`) });
  });
  // A rotation arm and a weaker pitcher-bench starter: they trade places.
  const order = u.rotation?.order || [];
  order.forEach((id, k) => {
    const r = players[id];
    const b = (u.rosterIds || []).map(x => players[x]).find(p => ok(p) && p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'SP' && r && r.ovr - p.ovr >= A.armGap && r.ovr - p.ovr <= START_MAX_GAP);
    if (b && k > 0) ops.push({ kind: 'rotation', gap: r.ovr - b.ovr, run: () => _can(draft, b.id, `turn:${k}`) && applyMove(draft, b.id, `turn:${k}`) });
  });
  // A bullpen arm and a weaker pitcher-bench reliever.
  for (const r of (u.rosterIds || []).map(id => players[id]).filter(p => ok(p) && p.group === PLAYER_GROUP.BULLPEN && p.pos === 'RP')) {
    const b = (u.rosterIds || []).map(x => players[x]).find(p => ok(p) && p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'RP' && r.ovr - p.ovr >= A.armGap && r.ovr - p.ovr <= START_MAX_GAP);
    if (b) ops.push({ kind: 'pen', gap: r.ovr - b.ovr, run: () => _can(draft, b.id, `pen:${r.id}`) && applyMove(draft, b.id, `pen:${r.id}`) });
  }
  // Shuffle, then at most one of the arms of each kind (a club with two rotation problems reads as broken).
  for (let i = ops.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ops[i], ops[j]] = [ops[j], ops[i]]; }
  const used = new Set();
  for (const op of ops) {
    if (done.length >= n) break;
    if (op.kind !== 'bat' && used.has(op.kind)) continue;
    if (op.run()) { done.push({ kind: op.kind, gap: op.gap }); used.add(op.kind); }
  }
  return done;
}
