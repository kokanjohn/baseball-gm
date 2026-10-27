/**
 * engine/DevelopmentEngine.js
 * Player development and day-to-day condition (§71).
 *
 *   Development plans — what training, coaching and good decisions do to a
 *   player's ratings. User decision: "a gradual ratings gain that varies —
 *   sometimes an immediate bump, other times more gradual." Every plan rolls
 *   an outcome when it starts:
 *     quick    (~20%)  most of it shows the next day, the rest within a week
 *     gradual  (~55%)  a little at a time over 1–3 weeks
 *     slow     (~15%)  nothing for 10–20 days, then it comes over two weeks
 *     flop     (~10%)  it doesn't take — a fraction of the hoped-for gain
 *   The size scales with age, trait and the relevant coach's relationship.
 *   Increments land on the real clock (state.developmentPlans, applied by
 *   GameEngine's roster step); an injury pauses a plan; a player who isn't
 *   getting into games develops more slowly.
 *
 *   Availability — `player.unavailable = { reason, gamesLeft, since, slot, rotationIndex }`:
 *   resting, sick, at a training program, benched, on leave. Counted down in
 *   the club's games; when it ends he gets his lineup spot / rotation turn back.
 *
 *   Condition — `player.condition = { subRating, amount, gamesLeft, reason }`:
 *   playing sick or hurt. A temporary dip the sim applies, gone after N games.
 *
 * Pure: never imports StateManager. Functions mutate the draft the caller
 * passes (inside StateManager.mutate) and return events.
 */

import {
  PLAYER_GROUP,
  SUB_RATING_MIN,
  SUB_RATING_MAX,
  OVR_H_CONTACT_WEIGHT,
  OVR_H_POWER_WEIGHT,
  OVR_H_SPEED_WEIGHT,
  OVR_P_STUFF_WEIGHT,
  OVR_P_CONTROL_WEIGHT,
  OVR_P_STAMINA_WEIGHT,
} from '../data/constants.js';
import { computeOVR, computeAge, baseballYear } from './PlayerFactory.js';

const DAY = 86_400_000;
const WEIGHT = {
  contact: OVR_H_CONTACT_WEIGHT, power: OVR_H_POWER_WEIGHT, speed: OVR_H_SPEED_WEIGHT,
  stuff: OVR_P_STUFF_WEIGHT, control: OVR_P_CONTROL_WEIGHT, stamina: OVR_P_STAMINA_WEIGHT,
};
const isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);

export const DEV_PROFILES = Object.freeze([
  { id: 'quick',   p: 0.20 },
  { id: 'gradual', p: 0.55 },
  { id: 'slow',    p: 0.15 },
  { id: 'flop',    p: 0.10 },
]);

// ─────────────────────────────────────────────────────────────
// DEVELOPMENT PLANS
// ─────────────────────────────────────────────────────────────

/** Default focus by role when a card doesn't name one. */
export function defaultFocus(player) {
  if (!player) return [];
  if (player.pos === 'SP') return ['control', 'stuff'];
  if (player.pos === 'RP') return ['stuff', 'control'];
  return ['contact', 'power'];
}

/** How much of a hoped-for gain this player can realistically take on. */
export function gainMultiplier(draft, player) {
  const age = computeAge(player.dob, baseballYear(draft));
  let m = age <= 24 ? 1.3 : age <= 29 ? 1.0 : age <= 33 ? 0.7 : 0.4;
  if (player.trait === 'youngGun' && age < 28) m *= 1.2;
  const coach = draft.userTeam?.coachingStaff?.[isPitcher(player) ? 'pitchingCoach' : 'hittingCoach'];
  const rel = player.teamId === 'user' && Number.isFinite(coach?.relationship) ? coach.relationship : 50;
  m *= 0.85 + 0.3 * (rel / 100);
  return m;
}

/**
 * startPlan(draft, playerId, { gain, focus, source }, atMs)
 * Rolls the outcome and schedules its increments on the clock.
 * `gain` is in OVR points (the card's _trainGain or its ovr effect).
 * @returns {Object|null} the plan
 */
export function startPlan(draft, playerId, { gain, focus = null, source = 'card' }, atMs) {
  const p = draft.players?.[playerId];
  if (!p || !gain) return null;
  const keys = (focus && focus.length ? focus : defaultFocus(p)).filter(k => p.subRatings?.[k] != null);
  if (!keys.length) return null;

  const active = (draft.developmentPlans || []).filter(x => x.playerId === playerId && x.status === 'active'
    && x.keys.some(k => keys.includes(k)));
  // One plan per skill at a time: overlapping work has diminishing returns.
  let planned = gain * gainMultiplier(draft, p) * (active.length ? 0.5 : 1);

  const volatile = p.trait === 'volatile', steady = p.trait === 'consistent';
  let profile = _pick(DEV_PROFILES);
  if (steady && profile === 'flop') profile = 'gradual';
  let realized = planned * (volatile ? _between(0.5, 1.6) : steady ? _between(0.9, 1.1) : _between(0.75, 1.25));
  if (profile === 'flop') realized = planned * _between(0, 0.25);

  const steps = _schedule(profile, realized, atMs);
  const plan = {
    id: _uuid(), playerId, source, keys, profile,
    planned: _round1(planned), realized: _round1(realized), applied: 0,
    steps, createdAt: atMs, status: 'active', pausedSince: null,
    gamesAtStart: _gamesPlayed(p), teamGamesAtStart: _teamGames(draft, p.teamId),
    carry: Object.fromEntries(keys.map(k => [k, 0])),
  };
  draft.developmentPlans = [...(draft.developmentPlans || []), plan];
  return plan;
}

function _schedule(profile, total, atMs) {
  const steps = [];
  const add = (at, amt) => steps.push({ atMs: Math.round(at), amount: amt });
  if (profile === 'quick') {
    add(atMs + _between(0.6, 1.2) * DAY, total * 0.6);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= n; i++) add(atMs + (1 + i * 6 / n) * DAY, total * 0.4 / n);
  } else if (profile === 'slow') {
    const start = atMs + _between(10, 20) * DAY;
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) add(start + i * (14 / n) * DAY, total / n);
  } else {
    const span = _between(7, 21);
    const n = 5 + Math.floor(Math.random() * 6);
    for (let i = 1; i <= n; i++) add(atMs + i * (span / n) * DAY, total / n);
  }
  return steps;
}

/** Is any increment due by `atMs`? (cheap — called every clock step) */
export function developmentDue(state, atMs) {
  return (state.developmentPlans || []).some(x => x.status === 'active' && x.steps.some(s => !s.done && s.atMs <= atMs));
}

/**
 * applyDevelopment(draft, atMs)
 * Lands every increment due by `atMs`. Injured: the plan pauses (its future
 * increments slide by the time missed). Not getting into games: each due
 * increment waits a day, up to three times.
 * @returns {Object[]} events — DEV_DONE when a plan completes
 */
export function applyDevelopment(draft, atMs) {
  const events = [];
  for (const plan of draft.developmentPlans || []) {
    if (plan.status !== 'active') continue;
    const p = draft.players[plan.playerId];
    if (!p || [PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED].includes(p.group)) { plan.status = 'cancelled'; continue; }
    if (p.isInjured) { if (plan.pausedSince == null) plan.pausedSince = atMs; continue; }
    if (plan.pausedSince != null) {
      const shift = atMs - plan.pausedSince;
      for (const s of plan.steps) if (!s.done) s.atMs += shift;
      plan.pausedSince = null;
    }
    for (const s of plan.steps) {
      if (s.done || s.atMs > atMs) continue;
      if (!_gettingReps(draft, plan, p) && (s.waited || 0) < 3 && p.unavailable?.reason !== 'training') {
        s.waited = (s.waited || 0) + 1;
        s.atMs += DAY;
        continue;
      }
      _land(p, plan, s.amount);
      s.done = true;
      plan.applied += s.amount;
    }
    if (plan.steps.every(s => s.done)) {
      plan.status = 'done';
      plan.doneAt = atMs;
      events.push({ type: 'DEV_DONE', playerId: p.id, teamId: p.teamId, planId: plan.id,
                    planned: plan.planned, realized: plan.realized, profile: plan.profile, source: plan.source, atMs });
    }
  }
  // Keep the ledger short: finished plans older than 60 days go.
  draft.developmentPlans = (draft.developmentPlans || [])
    .filter(x => x.status === 'active' || (x.doneAt || x.createdAt) > atMs - 60 * DAY);
  return events;
}

/** Spread `amount` OVR points over the plan's skills; whole sub-rating points only. */
function _land(p, plan, amount) {
  const sr = p.subRatings;
  const w = plan.keys.reduce((a, k) => a + (WEIGHT[k] || 0.33), 0) || 1;
  for (const k of plan.keys) {
    plan.carry[k] = (plan.carry[k] || 0) + amount / w;   // sub-rating points needed for `amount` OVR
    const whole = plan.carry[k] >= 0 ? Math.floor(plan.carry[k]) : Math.ceil(plan.carry[k]);
    if (whole) {
      sr[k] = Math.max(SUB_RATING_MIN, Math.min(SUB_RATING_MAX, sr[k] + whole));
      plan.carry[k] -= whole;
    }
  }
  p.ovr = computeOVR(sr);
  if (p.careerStats && p.ovr > (p.careerStats.peakOvr || 0)) p.careerStats.peakOvr = p.ovr;
}

/** Has he been playing since the plan began (by role)? */
function _gettingReps(draft, plan, p) {
  const teamGames = _teamGames(draft, p.teamId) - plan.teamGamesAtStart;
  if (teamGames < 3) return true;
  const share = (_gamesPlayed(p) - plan.gamesAtStart) / teamGames;
  const need = p.pos === 'SP' ? 0.12 : p.pos === 'RP' ? 0.2 : 0.35;
  return share >= need;
}

function _gamesPlayed(p) {
  return (p.stats?.g || 0) + (p.springStats?.g || 0) + (p.postseasonStats?.g || 0);
}

function _teamGames(draft, teamId) {
  const t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  if (!t) return 0;
  return (t.wins || 0) + (t.losses || 0) + (t.ties || 0) + (t.springWins || 0) + (t.springLosses || 0)
       + (t.springTies || 0) + (t.postseasonWins || 0) + (t.postseasonLosses || 0);
}

/** The player's development in progress: applied so far and the plans still running. */
export function developmentStatus(state, playerId) {
  const plans = (state.developmentPlans || []).filter(x => x.playerId === playerId);
  const active = plans.filter(x => x.status === 'active');
  return {
    active: active.length,
    appliedActive: _round1(active.reduce((a, x) => a + x.applied, 0)),   // OVR points landed so far
    recent: plans.filter(x => x.status === 'done').map(x => ({ realized: x.realized, profile: x.profile })),
  };
}

// ─────────────────────────────────────────────────────────────
// AVAILABILITY & CONDITION
// ─────────────────────────────────────────────────────────────

/**
 * setUnavailable(draft, playerId, { reason, games }, atMs)
 * Away for his club's next `games` games. Remembers his lineup spot and
 * rotation turn so he gets them back.
 */
export function setUnavailable(draft, playerId, { reason, games }, atMs) {
  const p = draft.players?.[playerId];
  if (!p || !(games > 0)) return null;
  const t = p.teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === p.teamId);
  const slot = (t?.lineupSlots || []).findIndex(s => s.playerId === playerId);
  const rot  = (t?.rotation?.order || []).indexOf(playerId);
  const prev = p.unavailable;
  p.unavailable = {
    reason, since: atMs,
    gamesLeft: Math.max(games, prev?.gamesLeft || 0),
    slot: slot >= 0 ? slot : (prev?.slot ?? null),
    rotationIndex: rot >= 0 ? rot : (prev?.rotationIndex ?? null),
  };
  return { type: 'UNAVAILABLE', playerId, reason, games, atMs };
}

/** A temporary dip in one skill for his next `games` games (playing sick / hurt). */
export function setCondition(draft, playerId, { subRating, amount, games, reason }) {
  const p = draft.players?.[playerId];
  if (!p || !(games > 0) || !amount) return null;
  const key = subRating || (isPitcher(p) ? 'stuff' : 'contact');
  p.condition = { subRating: key, amount, gamesLeft: games, reason };
  return { type: 'CONDITION', playerId, reason, games };
}

/**
 * countGame(draft, teamId)
 * After each of the club's games: away players and conditions count down one.
 * A player whose absence ends gets his lineup spot / rotation turn back (the
 * fill-in returns to the bench; reconcileRoster tidies the rest).
 * @returns {Object[]} events — AVAILABLE when someone is back
 */
export function countGame(draft, teamId) {
  const events = [];
  const t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  if (!t) return events;
  for (const id of t.rosterIds || []) {
    const p = draft.players[id];
    if (!p) continue;
    if (p.condition) {
      p.condition.gamesLeft -= 1;
      if (p.condition.gamesLeft <= 0) p.condition = null;
    }
    if (!p.unavailable) continue;
    p.unavailable.gamesLeft -= 1;
    if (p.unavailable.gamesLeft > 0) continue;
    const { slot, rotationIndex, reason } = p.unavailable;
    p.unavailable = null;
    events.push({ type: 'AVAILABLE', playerId: id, teamId, reason });
    if (p.isInjured || p.isSuspended) continue;
    if (Number.isInteger(slot) && t.lineupSlots?.[slot] && !isPitcher(p)) {
      const already = t.lineupSlots.findIndex(s => s.playerId === id);
      if (already >= 0 && already !== slot) t.lineupSlots[already].playerId = null;
      t.lineupSlots[slot].playerId = id;
      delete t.lineupSlots[slot].emergency;
    }
    if (Number.isInteger(rotationIndex) && p.group === PLAYER_GROUP.STARTING_PITCHERS && t.rotation?.order
        && !t.rotation.order.includes(id)) {
      t.rotation.order.splice(Math.min(rotationIndex, t.rotation.order.length), 0, id);
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _pick(profiles) {
  let r = Math.random();
  for (const x of profiles) { if ((r -= x.p) < 0) return x.id; }
  return profiles[profiles.length - 1].id;
}
function _between(lo, hi) { return lo + Math.random() * (hi - lo); }
function _round1(x) { return Math.round(x * 10) / 10; }
function _uuid() { return crypto.randomUUID(); }
