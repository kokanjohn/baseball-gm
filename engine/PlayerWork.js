/**
 * engine/PlayerWork.js
 * r159 §122.31 Work the GM asks for, one player at a time.
 *
 *   Coach work  — the hitting or pitching coach works with one player on one
 *                 skill (one player per coach at a time). The coach makes the
 *                 call: 'tweaks' (extra reps in practice already on the
 *                 schedule — no time away, no cost, a small gain) or 'focused'
 *                 (days away from the club, at a cost, a bigger gain). Days,
 *                 not games: a GM who starts it before an off day or a travel
 *                 day loses fewer games — the coach says which games the days
 *                 cover now and when the cheapest start is.
 *   A program   — Scouting/Dev's off-site development program: a week away,
 *                 a real price, the biggest possible gain (one at a time).
 *   A day off   — the manager sits a hitter for the next game: his wear clears.
 *   Health read — the team physician on one player: what's wrong now, what's
 *                 happened before, how worn down, the age.
 *
 * Every plan runs on DevelopmentEngine (it can land fast, slowly, or fizzle).
 * Pure: never imports StateManager. Reads take the state; `start*` mutate the
 * draft the caller passes (inside StateManager.mutate) and return events.
 */

import { PLAYER_WORK, PLAYER_GROUP, POSITION_RULES } from '../data/constants.js';
import { difficulty, familiarity, eligibleAt, startsAt, addFamiliarity, FIELD_POSITIONS, isPitcher as isP, pitchRoles, stretchOf, addStretch } from './Positions.js';
import { dice, diceSeed, withDice, eventRand } from './Dice.js';
import { computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import { gainMultiplier, roomLeft, activeWork, setUnavailable, startPlan, wearOf, developmentStatus } from './DevelopmentEngine.js';
import { armLoad } from './PitchingEngine.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const GAME_SPAN = 3.5 * HOUR;   // a game, first pitch to the last out (when a start "after the game" begins)

export const SKILLS = Object.freeze({ hitter: ['contact', 'power', 'speed'], pitcher: ['stuff', 'control', 'stamina'] });
export const SKILL_WORDS = Object.freeze({
  contact: 'contact', power: 'power', speed: 'speed', stuff: 'stuff', control: 'control', stamina: 'stamina',
});
export const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';
export const coachOf = (p) => (isPitcher(p) ? 'pitchingCoach' : 'hittingCoach');
export const skillsOf = (p) => (isPitcher(p) ? SKILLS.pitcher : SKILLS.hitter);

/** Ours, on the club (active or bench), not hurt, not away. */
export function workable(state, p) {
  return !!p && p.teamId === 'user' && (state.userTeam?.rosterIds || []).includes(p.id)
    && ![PLAYER_GROUP.IL, PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED].includes(p.group);
}

/** The players a topic can be about: ours, best first (hitters or pitchers or both). */
export function workPlayers(state, kind = 'any') {
  return (state.userTeam?.rosterIds || []).map(id => state.players?.[id])
    .filter(p => workable(state, p) && (kind === 'any'
      || (kind === 'relievers' ? isPitcher(p) && [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group)   // r169
         : (kind === 'pitchers') === isPitcher(p))))
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
}

// ─────────────────────────────────────────────────────────────
// THE CALENDAR: which games a stretch of days covers
// ─────────────────────────────────────────────────────────────

const ourGames = (state, fromMs) => (state.schedule || [])
  .filter(g => !g._committed && !g.cancelled && Number.isFinite(g.gameTime) && g.gameTime + GAME_SPAN > fromMs)
  .sort((a, b) => a.gameTime - b.gameTime);

/** The games of ours a player away from `fromMs` for `days` days would miss. */
export function gamesMissed(state, fromMs, days) {
  const until = fromMs + days * DAY;
  return ourGames(state, fromMs).filter(g => g.gameTime >= fromMs && g.gameTime < until);
}

/**
 * Starting now, or after one of the next few games (within the offer's life):
 * the start that costs the fewest games (the earliest of those).
 */
export function bestStart(state, atMs, days, horizonMs = PLAYER_WORK.offerDays * DAY) {
  const now = { atMs, games: gamesMissed(state, atMs, days) };
  let best = now;
  for (const g of ourGames(state, atMs)) {
    const t = g.gameTime + GAME_SPAN;
    if (t > atMs + horizonMs) break;
    if (t <= atMs) continue;
    const games = gamesMissed(state, t, days);
    if (games.length < best.games.length) best = { atMs: t, games, after: g };
  }
  return { now, best: best === now ? null : best };
}

// ─────────────────────────────────────────────────────────────
// THE READS (what the staff would tell the GM)
// ─────────────────────────────────────────────────────────────

/** Between two points, by OVR (clamped). */
const _lerp = (ovr, x0, x1, y0, y1) => y0 + (y1 - y0) * Math.max(0, Math.min(1, (ovr - x0) / (x1 - x0)));

/**
 * r160 §122.32 a focused day's cost, by the player's OVR: $5K for most of the
 * roster, about $10K for a good regular, $20K only for the very best.
 */
export function focusedDayK(p) {
  const D = PLAYER_WORK.coach.dayK, ovr = p?.ovr || 0;
  const k = ovr <= D.midOvr ? _lerp(ovr, D.fromOvr, D.midOvr, D.min, D.mid) : _lerp(ovr, D.midOvr, D.topOvr, D.mid, D.max);
  return Math.round(k);
}

/** r160 §122.32 the program's whole cost, by OVR ($25K–$75K for nearly everyone), a longer stay a little more. */
export function programCostK(p, days) {
  const G = PLAYER_WORK.program, ovr = p?.ovr || 0;
  const k = ovr <= G.midOvr ? _lerp(ovr, G.fromOvr, G.midOvr, G.minK, G.midK)
          : ovr <= G.highOvr ? _lerp(ovr, G.midOvr, G.highOvr, G.midK, G.highK)
          : _lerp(ovr, G.highOvr, G.highOvr + 10, G.highK, G.maxK);
  const stay = days > G.days ? 1 + 0.04 * (days - G.days) : 1;
  return Math.min(G.maxK, Math.max(G.minK, Math.round(k * stay / 5) * 5));
}

/** How much a player has left to find in a skill, in words for the reply. */
function roomWord(v) {
  const share = roomLeft(v);
  return share >= 1 ? 'lots' : share >= 0.8 ? 'some' : share >= 0.5 ? 'a little' : 'very little';
}

/** The odds as the coach would put them (age, trait, the coach, the room left). */
function oddsWord(mult) {
  return mult >= 1.15 ? 'good' : mult >= 0.85 ? 'fair' : mult >= 0.55 ? 'modest' : 'slim';
}

/**
 * coachRead(state, playerId, skill, atMs)
 * The coach's call on working with a player on one skill.
 * @returns {Object|null} { p, skill, value, coach, busy, already, kind, days, costK, gain, room, odds, window }
 */
export function coachRead(state, playerId, skill, atMs) {
  const p = state.players?.[playerId];
  if (!workable(state, p) || !skillsOf(p).includes(skill)) return null;
  const C = PLAYER_WORK.coach, sr = p.subRatings || {};
  const value = sr[skill] ?? 50;
  const coach = coachOf(p);
  const busy = activeWork(state, coach);
  const already = (state.developmentPlans || []).some(x => x.status === 'active' && x.playerId === p.id && x.keys.includes(skill));
  const best = Math.max(...skillsOf(p).map(k => sr[k] ?? 0));
  const focused = value < C.focusedBelow || (best - value >= C.focusedGap && value < C.focusedCap);
  const kind = focused ? 'focused' : 'tweaks';
  const days = focused ? (value < C.lowSkill ? C.focusedDaysLow : C.focusedDays) : 0;
  const mult = gainMultiplier(state, p) * roomLeft(value);
  return {
    p, skill, value, coach, busy, already,
    kind, days, costK: days * focusedDayK(p), gain: focused ? C.focusedGain : C.tweaksGain,
    room: roomWord(value), odds: oddsWord(mult), age: computeAge(p.dob, baseballYear(state)),
    window: days ? bestStart(state, atMs, days) : null,
  };
}

/**
 * programRead(state, playerId, skill, atMs)
 * Scouting/Dev's off-site program for one player on one skill.
 */
export function programRead(state, playerId, skill, atMs) {
  const p = state.players?.[playerId];
  if (!workable(state, p) || !skillsOf(p).includes(skill)) return null;
  const G = PLAYER_WORK.program, value = p.subRatings?.[skill] ?? 50;
  const age = computeAge(p.dob, baseballYear(state));
  const days = age <= 24 ? G.days : G.daysLow;
  const mult = gainMultiplier(state, p) * roomLeft(value);
  return {
    p, skill, value, age, busy: activeWork(state, 'program'), days, costK: programCostK(p, days), gain: G.gain,
    room: roomWord(value), odds: oddsWord(mult), window: bestStart(state, atMs, days),
    already: (state.developmentPlans || []).some(x => x.status === 'active' && x.playerId === p.id && x.keys.includes(skill)),
  };
}

/** The manager's read on a day off for one hitter. */
export function restRead(state, playerId, atMs) {
  const p = state.players?.[playerId];
  if (!workable(state, p) || isPitcher(p)) return null;
  const next = ourGames(state, atMs).find(g => g.gameTime > atMs) || null;
  const inLineup = (state.userTeam?.lineupSlots || []).some(s => s.playerId === p.id);
  return { p, ...wearOf(p, atMs), next, inLineup, away: !isAvailable(p) };
}

/** The team physician on one player. */
export function healthRead(state, playerId, atMs) {
  const p = state.players?.[playerId];
  if (!p || p.teamId !== 'user') return null;
  const age = computeAge(p.dob, baseballYear(state));
  const log = (p.injuryLog || []).filter(x => x.atMs <= atMs);
  return {
    p, age, now: p.isInjured ? (p.injury || {}) : null, playingHurt: p.condition || null,
    log, recent: log.filter(x => atMs - x.atMs < 120 * DAY), wear: wearOf(p, atMs),   // (r161 a pitcher's: the arm's workload)
    away: p.unavailable || null, dev: developmentStatus(state, p.id),
  };
}

// ─────────────────────────────────────────────────────────────
// STARTING THE WORK (inside StateManager.mutate)
// ─────────────────────────────────────────────────────────────

/**
 * startWork(draft, { playerId, skill, owner, kind, days, gain, source }, atMs)
 * Days away (if any) and the plan, run by its owner. Returns events.
 */
export function startWork(draft, { playerId, skill, owner, days = 0, gain, source }, atMs) {
  const out = [];
  if (days > 0) out.push(setUnavailable(draft, playerId, { reason: 'training', untilMs: atMs + days * DAY }, atMs));
  const plan = startPlan(draft, playerId, { gain, focus: [skill], source, owner }, atMs);
  if (plan) out.push({ type: 'DEV_STARTED', playerId, owner, skill, days });
  return out.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// r166 §122.35 PHASE 4 — THE BENCH COACH TEACHES A POSITION
// ─────────────────────────────────────────────────────────────
//   state.teaching = [{ id, playerId, pos, status: 'active'|'done', startAt, days, steps: [{ atMs, done, took }], gained }]
// Free, in practice already on the schedule (no time away), one player at a time. Each day of
// reps takes (one famStep of familiarity) or doesn't; familiarity never passes its cap, and only
// games (ten regular-season starts) make the position official.

const DAYMS = 86_400_000;

/** The positions a hitter could be taught: the fielding ones he isn't eligible at. */
export function teachablePositions(p) {
  if (!p || isP(p)) return [];
  const elig = eligibleAt(p);
  return FIELD_POSITIONS.filter(x => !elig.includes(x));
}

/** The Bench Coach's teaching now (or null). */
export const activeTeaching = (state) => (state.teaching || []).find(t => t.status === 'active') || null;

/**
 * teachRead(state, playerId, pos) — the Bench Coach's read on teaching a player a position:
 * how hard, how many days, the odds a day takes, where familiarity stands, whether it can go further.
 */
export function teachRead(state, playerId, pos) {
  const p = state.players?.[playerId];
  if (!workable(state, p) || isP(p) || !teachablePositions(p).includes(pos)) return null;
  const T = POSITION_RULES.teach, d = difficulty(p, pos);
  const coach = state.userTeam?.coachingStaff?.benchCoach;
  const q = coach && !coach.vacant ? (coach.quality || 60) : 50;
  const age = computeAge(p.dob, baseballYear(state));
  const odds = Math.max(0.15, Math.min(0.95, T.odds[d] + (q - 60) / 200 + (age <= 25 ? 0.05 : age >= 32 ? -0.1 : 0)));
  const fam = familiarity(p, pos), cap = POSITION_RULES.famCap[d];
  return {
    p, pos, difficulty: d, days: T.days[d], odds, oddsWord: odds >= 0.8 ? 'good' : odds >= 0.6 ? 'fair' : odds >= 0.45 ? 'modest' : 'slim',
    fam, cap, maxed: fam >= cap - 1e-9, starts: startsAt(p, pos), age,
    busy: activeTeaching(state), coachVacant: !coach || coach.vacant,
  };
}

/** startTeaching(draft, { playerId, pos, odds }, atMs) — the days of reps on the clock. Returns events. */
export function startTeaching(draft, { playerId, pos, odds }, atMs) {
  if (activeTeaching(draft)) return [];
  const p = draft.players?.[playerId];
  if (!p || !teachablePositions(p).includes(pos)) return [];
  const d = difficulty(p, pos), days = POSITION_RULES.teach.days[d];
  const id = `teach:${playerId}:${pos}:${atMs}`;
  (draft.teaching ||= []).push({
    id, playerId, pos, status: 'active', startAt: atMs, days, odds, gained: 0,
    steps: Array.from({ length: days }, (_, i) => ({ atMs: atMs + (i + 1) * DAYMS, done: false, took: null })),
  });
  return [{ type: 'TEACH_STARTED', playerId, pos, days }];
}

/** Is a day of teaching due by `atMs`? (cheap — every clock step) */
export function teachingDue(state, atMs) {
  const t = activeTeaching(state);
  return !!t && t.steps.some(s => !s.done && s.atMs <= atMs);
}

/**
 * teachSteps(draft, atMs) — each day of reps due: takes or doesn't (its own dice); the last one closes
 * the work. A player who leaves the club, gets hurt, or becomes eligible there (games) ends it early.
 * @returns {Object[]} events — TEACH_DONE { playerId, pos, gained, days, took, reason }
 */
export function teachSteps(draft, atMs) {
  const t = activeTeaching(draft);
  if (!t) return [];
  const p = draft.players?.[t.playerId];
  const out = [];
  const end = (reason) => {
    t.status = 'done'; t.endAt = atMs;
    out.push({ type: 'TEACH_DONE', playerId: t.playerId, pos: t.pos, gained: Math.round(t.gained * 1000) / 1000,
               took: t.steps.filter(s => s.took).length, days: t.steps.filter(s => s.done).length, reason, atMs });
  };
  if (!p || p.teamId !== 'user' || eligibleAt(p).includes(t.pos)) { end(!p || p.teamId !== 'user' ? 'gone' : 'eligible'); return out; }
  for (const [i, s] of t.steps.entries()) {
    if (s.done || s.atMs > atMs) continue;
    s.done = true;
    if (p.isInjured) { s.took = false; continue; }   // (hurt: no reps that day)
    s.took = withDice(dice(diceSeed(draft), 'teach', t.id, i), () => eventRand() < t.odds);
    if (s.took) t.gained += addFamiliarity(p, t.pos, 1);
  }
  if (t.steps.every(s => s.done)) end('done');
  return out;
}

// ─────────────────────────────────────────────────────────────
// r167 §122.35 PHASE 5 — THE PITCHING COACH STRETCHES A RELIEVER OUT (SIM GAMES)
// ─────────────────────────────────────────────────────────────
//   state.simGames = [{ id, playerId, status, steps: [{ atMs, done }] }]
// One pitcher at a time. A sim game every few days until he's at a starter's length (stretched out
// 3); each adds a step and some workload, and he can't relieve that day or the next. The SP
// designation still takes three regular-season starts.

export const activeSimGames = (state) => (state.simGames || []).find(t => t.status === 'active') || null;

/** The pitching coach's read on stretching one pitcher out. */
export function stretchRead(state, playerId) {
  const p = state.players?.[playerId];
  if (!workable(state, p) || !isP(p)) return null;
  const st = stretchOf(p), need = Math.max(0, 3 - st);
  return { p, stretch: st, need, days: need * POSITION_RULES.pitch.simEveryDays, starter: pitchRoles(p).includes('SP'),
           stamina: p.subRatings?.stamina ?? 50, busy: activeSimGames(state) };
}

/** startSimGames(draft, { playerId }, atMs) — the sim games on the clock. */
export function startSimGames(draft, { playerId }, atMs) {
  if (activeSimGames(draft)) return [];
  const read = stretchRead(draft, playerId);
  if (!read || !read.need) return [];
  const every = POSITION_RULES.pitch.simEveryDays * DAYMS;
  (draft.simGames ||= []).push({
    id: `sim:${playerId}:${atMs}`, playerId, status: 'active', startAt: atMs,
    steps: Array.from({ length: read.need }, (_, i) => ({ atMs: atMs + DAYMS + i * every, done: false })),
  });
  return [{ type: 'SIM_STARTED', playerId, games: read.need }];
}

export function simGamesDue(state, atMs) {
  const t = activeSimGames(state);
  return !!t && t.steps.some(s => !s.done && s.atMs <= atMs);
}

/**
 * simGameSteps(draft, atMs) — each sim game due: a step longer, a starter-like workload, and out of
 * the bullpen that day and the next. A hurt pitcher skips it. Ends with SIM_DONE.
 */
export function simGameSteps(draft, atMs) {
  const t = activeSimGames(draft);
  if (!t) return [];
  const p = draft.players?.[t.playerId];
  const out = [];
  const end = (reason) => { t.status = 'done'; t.endAt = atMs; out.push({ type: 'SIM_DONE', playerId: t.playerId, stretch: p ? stretchOf(p) : 0, reason, atMs }); };
  if (!p || p.teamId !== 'user') { end('gone'); return out; }
  for (const s of t.steps) {
    if (s.done || s.atMs > atMs) continue;
    s.done = true;
    if (p.isInjured) continue;
    addStretch(p, 1);
    p.load = Math.round((armLoad(p, s.atMs) + POSITION_RULES.pitch.simBF * 0.3) * 10) / 10;   // (the arm's workload, like a short start)
    p.loadAt = s.atMs;
    if (!p.unavailable) setUnavailable(draft, p.id, { reason: 'sim game', untilMs: s.atMs + 1.5 * DAYMS }, s.atMs);
  }
  if (t.steps.every(s => s.done) || stretchOf(p) >= 3) end('done');
  return out;
}
