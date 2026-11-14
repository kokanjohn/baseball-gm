/**
 * engine/LeaguePositions.js
 * r168 §122.35 phase 6 — positions around the league.
 *
 * In season, every few days a club somewhere moves a player to a new spot (a hitter picks up a
 * position — the one his club is thinnest at when it can; a starter goes to the bullpen or a
 * reliever is stretched out); every week or two a free agent works out at a new position. The
 * player gains it outright (`Positions.grantPosition`); the season's keep rules apply as usual.
 *
 *   leaguePositionsDue(state, atMs)        — a change is due
 *   leaguePositionSteps(draft, atMs, rand) — the changes due: [{ type: 'LEAGUE_POS', ... }]
 *   fitsUs(state, p, pos)                  — would the player start for us there (or cover a thin spot)?
 *
 * Pure: never imports StateManager. What the GM hears about it is CardEngine's.
 */

import { LEAGUE_POSITIONS as L, PHASE, PLAYER_GROUP } from '../data/constants.js';
import { FIELD_POSITIONS, isPitcher, canPlay, eligibleAt, difficulty, pitchRoles, grantPosition } from './Positions.js';
import { isAvailable } from './PlayerFactory.js';

const DAY = 86_400_000;
const IN_SEASON = new Set([PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK]);
const FA_PHASES = new Set([...IN_SEASON, PHASE.SPRING_TRAINING, PHASE.OFFSEASON]);
const between = (rand, [lo, hi]) => lo + rand() * (hi - lo);
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];

/** The next moments (made the first time they're asked for). */
function _clock(draft, atMs, rand) {
  const c = (draft.leaguePos ||= {});
  c.nextAt ??= atMs + between(rand, L.cpuGapDays) * DAY;
  c.faNextAt ??= atMs + between(rand, L.faGapDays) * DAY;
  return c;
}

export function leaguePositionsDue(state, atMs) {
  const c = state.leaguePos;
  if (!c) return IN_SEASON.has(state.phase) || FA_PHASES.has(state.phase);   // (the first look sets the clock)
  return (IN_SEASON.has(state.phase) && c.nextAt <= atMs) || (FA_PHASES.has(state.phase) && c.faNextAt <= atMs);
}

/**
 * leaguePositionSteps(draft, atMs, rand) — the club move and/or the free agent due now.
 * Out of season the club clock waits (it picks up a few days into the next season's games).
 */
export function leaguePositionSteps(draft, atMs, rand = Math.random) {
  const c = _clock(draft, atMs, rand), out = [];
  if (c.nextAt <= atMs) {
    if (IN_SEASON.has(draft.phase)) {
      const ev = _clubMove(draft, rand);
      if (ev) out.push({ ...ev, atMs: c.nextAt });
      c.nextAt = Math.max(c.nextAt, atMs - DAY) + between(rand, L.cpuGapDays) * DAY;
    } else c.nextAt = atMs + between(rand, L.cpuGapDays) * DAY;
  }
  if (c.faNextAt <= atMs) {
    if (FA_PHASES.has(draft.phase)) {
      const ev = _freeAgent(draft, rand);
      if (ev) out.push({ ...ev, atMs: c.faNextAt });
    }
    c.faNextAt = Math.max(c.faNextAt, atMs - DAY) + between(rand, L.faGapDays) * DAY;
  }
  return out;
}

/** A hitter's new spot: one his club has nobody behind if he can (easy first), else an easy one, sometimes a hard one. */
function _hitterSpot(p, thin, rand) {
  const open = FIELD_POSITIONS.filter(x => !eligibleAt(p).includes(x) && x !== 'C');
  if (!open.length) return null;
  const easy = open.filter(x => difficulty(p, x) === 'easy');
  const thinOk = open.filter(x => thin.has(x) && (difficulty(p, x) === 'easy' || rand() < L.hardShare));
  if (thinOk.length) return pick(rand, thinOk);
  if (easy.length && rand() >= L.hardShare) return pick(rand, easy);
  return pick(rand, open);
}

function _clubMove(draft, rand) {
  const teams = (draft.leagueTeams || []).filter(t => (t.rosterIds || []).length);
  if (!teams.length) return null;
  const t = pick(rand, teams);
  const roster = t.rosterIds.map(id => draft.players[id]).filter(p => p && isAvailable(p) && !p.isInjured);
  if (rand() < L.pitcherShare) {
    // a starter to the bullpen as well, or a reliever stretched out
    const order = new Set(t.rotation?.order || []);
    const arms = roster.filter(p => isPitcher(p) && pitchRoles(p).length === 1);
    const cand = arms.filter(p => (pitchRoles(p)[0] === 'SP' && !order.has(p.id)) || (pitchRoles(p)[0] === 'RP' && (p.subRatings?.stamina ?? 0) >= 55));
    const p = cand.length ? pick(rand, cand) : null;
    if (!p) return null;
    const role = pitchRoles(p)[0] === 'SP' ? 'RP' : 'SP';
    return grantPosition(p, role) ? { type: 'LEAGUE_POS', kind: 'cpu', playerId: p.id, teamId: t.id, pos: role } : null;
  }
  // a hitter: bench players more often than starters
  const seated = new Set((t.lineupSlots || []).map(sl => sl.playerId).filter(Boolean));
  const bats = roster.filter(p => !isPitcher(p));
  const bench = bats.filter(p => !seated.has(p.id));
  const thin = new Set(FIELD_POSITIONS.filter(x => !bench.some(b => canPlay(b, x))));
  const pool = bench.length && rand() < 0.7 ? bench : bats;
  if (!pool.length) return null;
  const p = pick(rand, pool);
  const pos = _hitterSpot(p, thin, rand);
  return pos && grantPosition(p, pos) ? { type: 'LEAGUE_POS', kind: 'cpu', playerId: p.id, teamId: t.id, pos } : null;
}

function _freeAgent(draft, rand) {
  const fa = Object.values(draft.players || {}).filter(p => p.group === PLAYER_GROUP.FREE_AGENT && !p.retired && (p.ovr || 0) >= L.faFloorOvr && !p.isInjured);
  if (!fa.length) return null;
  const p = pick(rand, fa);
  if (isPitcher(p)) {
    if (pitchRoles(p).length > 1) return null;
    const role = pitchRoles(p)[0] === 'SP' ? 'RP' : 'SP';
    return grantPosition(p, role) ? { type: 'LEAGUE_POS', kind: 'fa', playerId: p.id, teamId: null, pos: role } : null;
  }
  const pos = _hitterSpot(p, new Set(), rand);
  return pos && grantPosition(p, pos) ? { type: 'LEAGUE_POS', kind: 'fa', playerId: p.id, teamId: null, pos } : null;
}

/**
 * fitsUs(state, p, pos) — would the player start for us at `pos` (better than our starter there,
 * or than our weakest starter / reliever for a pitcher's new role), or cover a spot nobody on our
 * bench can play (better than our weakest bench bat)? → { start, thin, over } | null
 */
export function fitsUs(state, p, pos) {
  const u = state.userTeam, P = state.players || {};
  if (!u || !p) return null;
  const ok = (x) => x && isAvailable(x) && !x.isInjured;
  if (pos === 'SP') {
    const rot = (u.rotation?.order || []).map(id => P[id]).filter(ok).sort((a, b) => a.ovr - b.ovr);
    return rot.length < 5 || p.ovr >= rot[0].ovr + L.fitGap ? { start: true, thin: false, over: rot[0]?.id || null } : null;
  }
  if (pos === 'RP') {
    const pen = (u.rosterIds || []).map(id => P[id]).filter(x => ok(x) && x.group === PLAYER_GROUP.BULLPEN).sort((a, b) => a.ovr - b.ovr);
    return pen.length && p.ovr >= pen[0].ovr + L.fitGap ? { start: true, thin: false, over: pen[0].id } : null;
  }
  const sl = (u.lineupSlots || []).filter(s => s.slot === pos).map(s => P[s.playerId]).filter(ok).sort((a, b) => a.ovr - b.ovr)[0];
  if (sl && p.ovr >= sl.ovr + L.fitGap) return { start: true, thin: false, over: sl.id };
  const seated = new Set((u.lineupSlots || []).map(s => s.playerId));
  const bench = (u.rosterIds || []).map(id => P[id]).filter(x => ok(x) && !isPitcher(x) && !seated.has(x.id) && x.group === PLAYER_GROUP.BENCH_HITTERS);
  if (!bench.some(b => canPlay(b, pos)) && bench.length && p.ovr > Math.min(...bench.map(b => b.ovr))) return { start: false, thin: true, over: null };
  return null;
}
