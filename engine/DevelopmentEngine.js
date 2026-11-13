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

import { dice, diceSeed, diceId } from './Dice.js';
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
  DIAMOND,
  WEAR,
  PLAYER_WORK,
  ARM_LOAD,
} from '../data/constants.js';
import { ageWearMult, armLoad } from './PitchingEngine.js';
import { computeOVR, computeAge, baseballYear } from './PlayerFactory.js';
import { exposeRatings } from './Diamonds.js';
import { devFactor } from './CoachEngine.js';
import { trainingDevFactor } from './FrontOffice.js';
import { canPlay, primaryPos } from './Positions.js';

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
  // §112.2 the coach's quality, and a youth specialist with the young ones.
  if (player.teamId === 'user') m *= devFactor(draft.userTeam?.coachingStaff, player, age) * trainingDevFactor(draft.userTeam);   // §112.4 the training center
  return m;
}

/** r159 §122.31 the share of a hoped-for gain left in a skill at this level (a 90 has little left to find). */
export function roomLeft(value) {
  for (const [at, share] of PLAYER_WORK.room) if (value >= at) return share;
  return 1;
}

/**
 * startPlan(draft, playerId, { gain, focus, source, owner }, atMs)
 * Rolls the outcome and schedules its increments on the clock.
 * `gain` is in OVR points (the card's _trainGain or its ovr effect).
 * @returns {Object|null} the plan
 */
export function startPlan(draft, playerId, { gain, focus = null, source = 'card', owner = null }, atMs) {
  const p = draft.players?.[playerId];
  if (!p || !gain) return null;
  const keys = (focus && focus.length ? focus : defaultFocus(p)).filter(k => p.subRatings?.[k] != null);
  if (!keys.length) return null;
  exposeRatings(p, DIAMOND.trainExposure);   // §122.9 the coaches see what he really has

  const active = (draft.developmentPlans || []).filter(x => x.playerId === playerId && x.status === 'active'
    && x.keys.some(k => keys.includes(k)));
  // One plan per skill at a time: overlapping work has diminishing returns.
  let planned = gain * gainMultiplier(draft, p) * (active.length ? 0.5 : 1);
  // r159 one skill, worked on purpose: the room left in it.
  if (keys.length === 1) planned *= roomLeft(p.subRatings[keys[0]]);

  // §118 how the plan goes is its own draw (the player, the moment, what started it).
  const rand = dice(diceSeed(draft), 'dev-plan', playerId, atMs, source);
  const _between = (lo, hi) => lo + rand() * (hi - lo);
  const volatile = p.trait === 'volatile', steady = p.trait === 'consistent';
  let profile = _pick(DEV_PROFILES, rand);
  if (steady && profile === 'flop') profile = 'gradual';
  let realized = planned * (volatile ? _between(0.5, 1.6) : steady ? _between(0.9, 1.1) : _between(0.75, 1.25));
  if (profile === 'flop') realized = planned * _between(0, 0.25);

  const steps = _schedule(profile, realized, atMs, rand);
  const plan = {
    id: diceId(rand), playerId, source, keys, profile,
    owner,   // r159 who is doing the work: 'hittingCoach' | 'pitchingCoach' | 'program' (one at a time each)
    from: Object.fromEntries(keys.map(k => [k, p.subRatings[k]])),   // where the skills stood (the report)
    planned: _round1(planned), realized: _round1(realized), applied: 0,
    steps, createdAt: atMs, status: 'active', pausedSince: null,
    gamesAtStart: _gamesPlayed(p), teamGamesAtStart: _teamGames(draft, p.teamId),
    carry: Object.fromEntries(keys.map(k => [k, 0])),
  };
  draft.developmentPlans = [...(draft.developmentPlans || []), plan];
  return plan;
}

function _schedule(profile, total, atMs, rand) {
  const steps = [];
  const add = (at, amt) => steps.push({ atMs: Math.round(at), amount: amt });
  if (profile === 'quick') {
    add(atMs + _btw(rand, 0.6, 1.2) * DAY, total * 0.6);
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 1; i <= n; i++) add(atMs + (1 + i * 6 / n) * DAY, total * 0.4 / n);
  } else if (profile === 'slow') {
    const start = atMs + _btw(rand, 10, 20) * DAY;
    const n = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) add(start + i * (14 / n) * DAY, total / n);
  } else {
    const span = _btw(rand, 7, 21);
    const n = 5 + Math.floor(rand() * 6);
    for (let i = 1; i <= n; i++) add(atMs + i * (span / n) * DAY, total / n);
  }
  return steps;
}

/** r159 the plan `owner` is running now (one player at a time per coach; one program at a time). */
export function activeWork(state, owner) {
  return (state.developmentPlans || []).find(x => x.status === 'active' && x.owner === owner) || null;
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
                    planned: plan.planned, realized: plan.realized, profile: plan.profile, source: plan.source, atMs,
                    owner: plan.owner || null, keys: plan.keys, from: plan.from || null,
                    to: Object.fromEntries(plan.keys.map(k => [k, p.subRatings[k]])) });
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
export function setUnavailable(draft, playerId, { reason, games = 0, untilMs = null }, atMs) {
  const p = draft.players?.[playerId];
  // r159 away for a stretch of days (focused work, a program) rather than a count of games.
  if (!p || !(games > 0 || untilMs > atMs)) return null;
  const t = p.teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === p.teamId);
  const slot = (t?.lineupSlots || []).findIndex(s => s.playerId === playerId);
  const rot  = (t?.rotation?.order || []).indexOf(playerId);
  const prev = p.unavailable;
  p.unavailable = {
    reason, since: atMs,
    gamesLeft: untilMs ? null : Math.max(games, prev?.gamesLeft || 0),
    untilMs: untilMs || null,
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
 * countGame(draft, teamId, atMs)
 * After each of the club's games: away players and conditions count down one.
 * A player whose absence ends gets his lineup spot / rotation turn back (the
 * fill-in returns to the bench; reconcileRoster tidies the rest).
 * r159 §122.31 and the hitters' wear: a start adds to it, a game off or an off
 * day takes it away. r160 §122.32 a CPU manager sits the most worn-down regular
 * at WEAR.cpuRest for the next game; ours never does on his own (the lineup is
 * the GM's — the staff writes instead: CardEngine's rest watch).
 * @returns {Object[]} events — AVAILABLE when someone is back, RESTED when a CPU manager sits someone
 */
export function countGame(draft, teamId, atMs = null) {
  const events = [];
  const t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  if (!t) return events;
  // Off days since the club's last game: each beyond the first takes some wear off.
  const offDays = atMs && t._lastGameAt ? Math.max(0, Math.floor((atMs - t._lastGameAt) / DAY) - 1) : 0;
  if (atMs) t._lastGameAt = atMs;
  const inLineup = new Set((t.lineupSlots || []).map(x => x.playerId).filter(Boolean));
  const caught = (t.lineupSlots || []).find(x => x.slot === 'C')?.playerId || null;   // r161 who caught (the slot, not the listing)
  const year = baseballYear(draft);
  for (const id of t.rosterIds || []) {
    const p = draft.players[id];
    if (!p) continue;
    // (an away or hurt player keeps his lineup slot until he's back: he didn't start)
    if (!isPitcher(p)) _wear(p, inLineup.has(id) && !p.unavailable && !p.isInjured && !p.isSuspended, offDays,
                             { catcher: id === caught, mult: ageWearMult(computeAge(p.dob, year)) });
    if (p.condition) {
      p.condition.gamesLeft -= 1;
      if (p.condition.gamesLeft <= 0) p.condition = null;
    }
    if (!p.unavailable) continue;
    if (p.unavailable.untilMs) continue;   // away for a stretch of days: back on the clock (releaseDue)
    p.unavailable.gamesLeft -= 1;
    if (p.unavailable.gamesLeft > 0) continue;
    _back(draft, t, p, teamId, events);
  }
  // A CPU manager's call: the most worn-down regular at the limit sits the next game (one a game —
  // never half the lineup at once), and the best bench bat takes that spot now (the regular gets it
  // back after the game off). r160 §122.32 not ours: our lineup is the GM's.
  if (teamId === 'user') return events;
  const worn = [...inLineup].map(id => draft.players[id])
    .filter(p => p && !isPitcher(p) && !p.unavailable && !p.isInjured && !p.isSuspended && (p.wear || 0) >= WEAR.cpuRest)
    .sort((a, b) => (b.wear || 0) - (a.wear || 0));
  for (const p of worn) {
    const sub = _fillIn(draft, t, p);
    if (!sub) continue;
    const slot = t.lineupSlots.findIndex(s => s.playerId === p.id);
    setUnavailable(draft, p.id, { reason: 'rest', games: 1 }, atMs || 0);
    if (slot >= 0) t.lineupSlots[slot].playerId = sub.id;
    events.push({ type: 'RESTED', playerId: p.id, teamId, by: 'manager', wear: Math.round(p.wear), subId: sub.id, atMs });
    break;
  }
  // r161 §122.33 and the arms: the most worn at the limit rests (a starter skips a turn, a reliever
  // gets two days down) — one a game.
  if (atMs) {
    const arm = (t.rosterIds || []).map(id => draft.players[id])
      .filter(p => p && isPitcher(p) && !p.unavailable && !p.isInjured && armLoad(p, atMs) >= ARM_LOAD.cpuRest)
      .sort((a, b) => armLoad(b, atMs) - armLoad(a, atMs))[0];
    if (arm && givePitcherRest(draft, arm.id, atMs)) events.push({ type: 'RESTED', playerId: arm.id, teamId, by: 'manager', atMs });
  }
  return events;
}

/**
 * r159 a hitter's wear after a game: a start adds to it, off days take some away.
 * r160 §122.32 a game off clears it, however it came (a day off asked for, the GM
 * sitting the player on the Team screen, the bench): a day off is a day off.
 * `straight` counts the starts in a row (the staff's "caught seven straight").
 * r161 §122.33 a start behind the plate adds the catcher's rate (whoever is in the
 * C slot that day), and every start is times WEAR.age (young legs carry more).
 */
function _wear(p, started, offDays, { catcher = false, mult = 1 } = {}) {
  let w = Math.max(0, (p.wear || 0) - offDays * WEAR.offDay);
  // r161 §122.33 behind the plate is what wears (the slot played, not the listed position), and by age.
  if (started) w += (catcher ? WEAR.catcher : 1) * mult;
  else w = 0;
  p.wear = Math.round(w * 10) / 10;
  p.straight = started ? (p.straight || 0) + 1 : 0;
}

/**
 * r159 a day off: `p` sits the next game and the manager puts the best bench bat in the spot now.
 * @returns {Object|null} the UNAVAILABLE event (null: nobody to fill in)
 */
export function giveDayOff(draft, playerId, atMs) {
  const p = draft.players?.[playerId];
  const t = p?.teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === p?.teamId);
  if (!p || !t) return null;
  const sub = _fillIn(draft, t, p);
  if (!sub) return null;
  const slot = (t.lineupSlots || []).findIndex(s => s.playerId === p.id);
  const ev = setUnavailable(draft, p.id, { reason: 'rest', games: 1 }, atMs);
  if (slot >= 0) t.lineupSlots[slot].playerId = sub.id;
  return ev;
}

/**
 * r161 §122.33 rest for an arm: a starter skips his next turn (the rotation moves up behind him), a
 * reliever is down for ARM_LOAD.relieverDays days.
 * @returns {Object|null} the UNAVAILABLE event
 */
export function givePitcherRest(draft, playerId, atMs) {
  const p = draft.players?.[playerId];
  if (!p || !isPitcher(p)) return null;
  const t = p.teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === p.teamId);
  const starter = (t?.rotation?.order || []).includes(p.id);
  if (starter) return setUnavailable(draft, p.id, { reason: 'rest', games: 1 }, atMs);
  // (ours on the clock — two days, as the message says; a CPU club's by its games: only our roster's
  //  days-away come back on the clock, every club's games count down)
  return p.teamId === 'user' ? setUnavailable(draft, p.id, { reason: 'rest', untilMs: atMs + ARM_LOAD.relieverDays * DAY }, atMs)
                             : setUnavailable(draft, p.id, { reason: 'rest', games: ARM_LOAD.relieverDays }, atMs);
}

/** The bench bat who fills in for `p`: one who plays the position first, then the best (null: nobody to spare). */
/** r160 who would fill in for `p` (read-only: the staff names the backup). */
export function fillInFor(draft, t, p) { return _fillIn(draft, t, p); }
function _fillIn(draft, t, p) {
  // (r163 §122.35 who can play the spot p holds today — or p's own position, off the lineup)
  const spot = (t.lineupSlots || []).find(s => s.playerId === p.id)?.slot || primaryPos(p);
  const fits = (x) => canPlay(x, spot);
  const bench = (t.rosterIds || []).map(id => draft.players[id])
    .filter(x => x && !isPitcher(x) && x.id !== p.id && !x.unavailable && !x.isInjured && !x.isSuspended
      && [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(x.group) && !(t.lineupSlots || []).some(s => s.playerId === x.id));
  return bench.sort((a, b) => (fits(b) - fits(a)) || ((b.ovr || 0) - (a.ovr || 0)))[0] || null;
}

/** The player is back: his lineup spot and rotation turn return. */
function _back(draft, t, p, teamId, events) {
  const id = p.id;
  const { slot, rotationIndex, reason } = p.unavailable;
  p.unavailable = null;
  events.push({ type: 'AVAILABLE', playerId: id, teamId, reason });
  if (p.isInjured || p.isSuspended) return;
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

/** r159 is anyone away for a stretch of days due back by `atMs`? (cheap — every clock step) */
export function availabilityDue(state, atMs) {
  for (const id of state.userTeam?.rosterIds || []) {
    const u = state.players?.[id]?.unavailable;
    if (u?.untilMs && u.untilMs <= atMs) return true;
  }
  return false;
}

/** r159 back from a stretch of days away (focused work, a program): on the clock, not by games. */
export function releaseDue(draft, atMs) {
  const events = [];
  const t = draft.userTeam;
  for (const id of t?.rosterIds || []) {
    const p = draft.players[id];
    if (p?.unavailable?.untilMs && p.unavailable.untilMs <= atMs) _back(draft, t, p, 'user', events);
  }
  return events;
}

/**
 * r159 a hitter's wear in words and numbers, for the staff, the Team screen and the player card.
 * r160 §122.32 `level` / `word` (WEAR.levels), `share` for a meter, `straight` starts in a row.
 * r161 §122.33 pitchers too (their workload at `atMs`); `left` = what's left of the meter (1 fresh).
 */
export function wearOf(p, atMs = null) {
  // r161 §122.33 a pitcher's is the arm's workload now (it comes off by the day).
  const pitcher = isPitcher(p);
  const w = pitcher ? Math.round(armLoad(p, atMs) * 10) / 10 : (p?.wear || 0);
  const dip = w < WEAR.tired ? 0 : Math.min(WEAR.dipMax, WEAR.dip + Math.floor((w - WEAR.tired) / WEAR.dipStep));
  const lv = [...WEAR.levels].reverse().find(([, from]) => w >= from) || WEAR.levels[0];
  return { wear: w, tired: w >= WEAR.tired, worn: w >= WEAR.worn, dip, level: lv[0], word: lv[2], pitcher,
           share: Math.min(1, w / WEAR.meterMax), left: Math.max(0, 1 - w / WEAR.meterMax), straight: pitcher ? 0 : (p?.straight || 0) };
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _pick(profiles, rand) {
  let r = rand();
  for (const x of profiles) { if ((r -= x.p) < 0) return x.id; }
  return profiles[profiles.length - 1].id;
}
function _btw(rand, lo, hi) { return lo + rand() * (hi - lo); }
function _round1(x) { return Math.round(x * 10) / 10; }
