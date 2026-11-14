/**
 * engine/PitchingEngine.js
 * How a manager runs a pitching staff (§76) — PURE: takes state (or an
 * in-place draft) and returns results; never imports StateManager.
 *
 *   - bullpenRoles(team, players): the bullpen's depth chart — a closer, two
 *     setup men, middle relievers, and long men (spare starters first).
 *   - recordOutings(draft, plays, endMs): after a game, each pitcher's outing
 *     (batters faced, outs, start or relief) goes on his arm's record.
 *   - armStatus(player, atMs): rested ('fresh'), usable but not recovered
 *     ('tired'), or not available today ('down') — no third day in a row, no
 *     day after a long outing; stamina speeds recovery.
 *   - starterRested(player, atMs): four days' rest since his last start.
 *   - tireAfterBF(player, isStarter, carriedTired): in a game, the batters he
 *     can face before he tires (§7.4 modifiers apply past it).
 *   - chooseReliever(...): who the manager brings in, by the situation.
 *
 *   - armLoad(player, atMs): r161 §122.33 the workload that builds over weeks
 *     (player.load as of player.loadAt, coming off a day at a time).
 *
 * player.arm = [{ at, day, bf, outs, start }]   // outings in the last few days
 *   at  — when the game ended;  day — the local calendar day it was played
 *   (rest is counted in calendar days: "pitched yesterday" is about dates, not hours).
 */

import { penRolesOf } from './Strategy.js';   // r169
import {
  PLAYER_GROUP,
  PITCH_SP_TIRE_BASE_BF, PITCH_SP_TIRE_PER_STAMINA, PITCH_RP_TIRE_BASE_BF, PITCH_RP_TIRE_PER_STAMINA,
  PITCH_SP_REST_DAYS, PITCH_RP_LONG_OUTING_BF, PITCH_RP_HEAVY_OUTING_BF, PITCH_RP_START_BF,
  PITCH_RP_MAX_STRAIGHT_DAYS, PITCH_RP_TIRED_ONSET_SHARE, PITCH_ARM_HISTORY_DAYS, PITCH_LONG_INNINGS,
  SPRING_SP_INNINGS, SPRING_TRAINING_GAME_COUNT, WEAR, ARM_LOAD,
} from '../data/constants.js';
import { isAvailable, computeAge, baseballYear } from './PlayerFactory.js';
import { recordOuting, reliefLoadMult, reliefPushDays, stretchOf } from './Positions.js';
import { playingRating } from './Diamonds.js';

const DAY = 86_400_000;
export const ROLE = Object.freeze({ STARTER: 'starter', CLOSER: 'closer', SETUP: 'setup', MIDDLE: 'middle', LONG: 'long' });
export const ROLE_ABBR = Object.freeze({ starter: 'SP', closer: 'CL', setup: 'SU', middle: 'MR', long: 'LR' });

/** The local calendar day of a moment, as a day number. */
export const dayOf = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
/** Calendar days between two moments (yesterday = 1; a doubleheader = 0). */
export const daysBetween = (fromMs, toMs) => dayOf(toMs) - dayOf(fromMs);
/** Days since an outing, by the day it was played. */
const daysSince = (o, atMs) => dayOf(atMs) - (o.day ?? dayOf(o.at));

const stamina = (p) => playingRating(p, 'stamina') ?? 60;   // §122.9 how long he lasts is the truth

// ─────────────────────────────────────────────────────────────
// ROLES
// ─────────────────────────────────────────────────────────────

/** What makes a late-inning arm: swing-and-miss stuff first, then control, then the whole package. */
export function reliefValue(p) {
  const sr = p?.subRatings || {}, ovr = p?.ovr ?? 50;
  return 0.45 * (sr.stuff ?? ovr) + 0.25 * (sr.control ?? ovr) + 0.30 * ovr;
}

/**
 * bullpenRoles(team, players)
 * The club's relief corps (bullpen + pitcher bench, healthy) as the manager
 * would line it up. Long men: the spare starters (most stamina first); without
 * any, the highest-stamina arm of the lesser half. Of the rest, by relief value:
 * the closer, two setup men, then the middle relievers — §114 the bullpen
 * group's arms first, the pitcher bench's relievers after them.
 */
export function bullpenRoles(team, players) {
  const pool = (team?.rosterIds || []).map(id => players[id])
    .filter(p => p && isAvailable(p) && (p.group === PLAYER_GROUP.BULLPEN || p.group === PLAYER_GROUP.PITCHER_BENCH));
  // (r167 §122.35 a starter the GM put in the bullpen is a reliever like the rest; the spare starters
  //  on the pitcher bench are the long men)
  let long = pool.filter(p => p.pos === 'SP' && p.group !== PLAYER_GROUP.BULLPEN).sort((a, b) => stamina(b) - stamina(a));
  // §114 the bullpen (the BULLPEN group, five arms) holds the roles; relievers
  // on the pitcher bench are reserves — after the middle men, used when the
  // pen is spent — as bench hitters are behind the nine.
  const byValue = (a, b) => reliefValue(b) - reliefValue(a);
  const relievers = pool.filter(p => p.pos !== 'SP' || p.group === PLAYER_GROUP.BULLPEN);
  let rest = [...relievers.filter(p => p.group === PLAYER_GROUP.BULLPEN).sort(byValue),
              ...relievers.filter(p => p.group !== PLAYER_GROUP.BULLPEN).sort(byValue)];
  if (!long.length && rest.length > 4) {
    const lesser = rest.slice(Math.ceil(rest.length / 2)).sort((a, b) => stamina(b) - stamina(a));
    long = [lesser[0]];
    rest = rest.filter(p => p !== lesser[0]);
  }
  // A thin staff: the long men pitch where they're needed.
  if (!rest.length) { rest = long; long = []; }
  // r169 the GM's roles (Strategy.penRolesOf): the closer and setup men named, if they're here to pitch;
  // everyone else by value behind them.
  const mine = penRolesOf(team);
  const named = [mine.closer, ...mine.setup].filter(Boolean);
  if (named.length) {
    const here = (id) => pool.find(p => p.id === id);
    const front = named.map(here).filter(Boolean);
    if (front.length) {
      long = long.filter(p => !front.includes(p));
      rest = rest.filter(p => !front.includes(p));
      const closerP = mine.closer ? here(mine.closer) : null;
      rest = closerP ? [closerP, ...front.filter(p => p !== closerP), ...rest]
                     : [rest[0], ...front, ...rest.slice(1)].filter(Boolean);   // (the manager's closer, then the named setup men)
    }
  }
  const ids = (xs) => xs.map(p => p.id);
  const closer = rest[0]?.id || null;
  const setup  = ids(rest.slice(1, 3));
  const middle = ids(rest.slice(3));
  const roleOf = {};
  if (closer) roleOf[closer] = ROLE.CLOSER;
  for (const id of setup)  roleOf[id] = ROLE.SETUP;
  for (const id of middle) roleOf[id] = ROLE.MIDDLE;
  for (const id of ids(long)) roleOf[id] = ROLE.LONG;
  return { closer, setup, middle, long: ids(long), roleOf };
}

// ─────────────────────────────────────────────────────────────
// THE ARM'S RECORD
// ─────────────────────────────────────────────────────────────

/** Each pitcher's outing in a game: batters faced, outs, and whether he started. */
export function outingsFrom(plays) {
  const out = {};
  const firstBy = {};
  for (const play of plays || []) {
    const id = play.pitcherId;
    if (!id || !play.batterId || !play._statDeltas?.[id]) continue;   // a plate appearance against him
    const o = out[id] || (out[id] = { bf: 0, outs: 0, start: false });
    o.bf += 1;
    for (const d of play._statDeltas[id]) if (d.stat === 'ip') o.outs += Math.round((d.delta || 0) * 3);
    if ((play.half === 'TOP' || play.half === 'BOT') && !firstBy[play.half]) { firstBy[play.half] = id; o.start = true; }
  }
  // Caught-stealing outs carry the pitcher but no batter.
  for (const play of plays || []) {
    if (play.type !== 'caught_stealing' || !out[play.pitcherId]) continue;
    for (const d of play._statDeltas?.[play.pitcherId] || []) if (d.stat === 'ip') out[play.pitcherId].outs += Math.round((d.delta || 0) * 3);
  }
  return out;
}

/** recordOutings(draft, plays, endMs) — after the final out: the game goes on each arm's record. */
export function recordOutings(draft, plays, endMs, kind = 'regular') {
  const events = [];   // r167 §122.35 designations earned (ROLE_GAINED)
  const startMs = (plays || []).find(p => p.type === 'game_start')?._timestamp ?? endMs;
  const day = dayOf(startMs);
  const year = baseballYear(draft);
  for (const [id, o] of Object.entries(outingsFrom(plays))) {
    const p = draft.players[id];
    if (!p) continue;
    // r161 §122.33 the workload: what's left of it now, plus this outing (times the arm's age).
    const yesterday = (p.arm || []).some(x => x.day === day - 1);
    const mult = ageWearMult(computeAge(p.dob, year));
    // (r167 a starter without RP takes a relief outing harder)
    const add = o.start ? o.bf * ARM_LOAD.perStartBF
                        : (ARM_LOAD.reliefBase + o.bf * ARM_LOAD.reliefPerBF + (yesterday ? ARM_LOAD.backToBack : 0)) * reliefLoadMult(p);
    if (p.loadAt !== endMs) {
      p.load = Math.round((armLoad(p, endMs) + add * mult) * 10) / 10;
      p.loadAt = endMs;
      p.loadMult = mult;
    }
    if (!(p.arm || []).some(x => x.at === endMs)) {
      const gained = recordOuting(p, { start: o.start, bf: o.bf, kind });   // r167 toward SP / RP; stretched out
      if (gained) events.push({ type: 'ROLE_GAINED', playerId: id, teamId: p.teamId, role: gained, atMs: endMs });
    }
    p.arm = [...(p.arm || []).filter(x => endMs - x.at < PITCH_ARM_HISTORY_DAYS * DAY && x.at !== endMs),
             { at: endMs, day, bf: o.bf, outs: o.outs, start: o.start }];
  }
  return events;
}

/** r161 §122.33 what a start (hitters) or an outing (pitchers) adds, by age (WEAR.age). */
export function ageWearMult(age) {
  return (WEAR.age.find(([upTo]) => (age ?? 28) <= upTo) || [0, 1])[1];
}

/**
 * armLoad(player, atMs) — r161 §122.33 a pitcher's workload now: what the last
 * outing left, less `perDay` for each day since (an older arm comes back slower:
 * divided by half its age multiplier's lean, as of that outing — 35+ ÷1.2, 25 and under ÷0.93).
 */
export function armLoad(player, atMs) {
  const load = player?.load || 0;
  if (!load || !player.loadAt || !Number.isFinite(atMs) || atMs <= player.loadAt) return load;
  const days = (atMs - player.loadAt) / DAY;
  // (age counts half as much on the way back as on the way in: 35+ comes back a fifth slower)
  const back = 1 + ((player.loadMult || 1) - 1) / 2;
  return Math.max(0, load - days * ARM_LOAD.perDay / back);
}

/**
 * armStatus(player, atMs)
 * How his arm is today. A high-stamina arm recovers faster (the outing
 * thresholds scale with stamina).
 * @returns {{ status: 'fresh'|'tired'|'down', lastDays: Number|null }}
 */
export function armStatus(player, atMs) {
  const outs = (player?.arm || []).filter(o => o.at <= atMs).map(o => ({ d: daysSince(o, atMs), bf: o.bf }));
  if (!outs.length) return { status: 'fresh', lastDays: null };
  const k = 0.7 + stamina(player) / 150;                 // stamina 45 → 1.0, 75 → 1.2
  const on = (d) => outs.some(o => o.d === d);
  const lastDays = Math.min(...outs.map(o => o.d));
  let straight = 0;
  for (let d = 1; d <= PITCH_RP_MAX_STRAIGHT_DAYS; d++) if (on(d)) straight++; else break;
  const down = on(0)                                                      // already pitched today
    || straight >= PITCH_RP_MAX_STRAIGHT_DAYS                              // a third day in a row
    || outs.some(o => o.d <= 1 && o.bf >= PITCH_RP_LONG_OUTING_BF * k)
    || outs.some(o => o.d <= 2 && o.bf >= PITCH_RP_HEAVY_OUTING_BF * k)
    || outs.some(o => o.d <= 3 && o.bf >= PITCH_RP_START_BF * k);
  if (down) return { status: 'down', lastDays };
  const tired = on(1)
    || outs.filter(o => o.d <= 3).length >= 3
    || outs.some(o => o.d <= 2 && o.bf >= PITCH_RP_LONG_OUTING_BF * k);
  return { status: tired ? 'tired' : 'fresh', lastDays };
}

/** A starter is ready on his fifth day: four days' rest since his last start. */
export function starterRested(player, atMs) {
  const outs = (player?.arm || []).filter(o => o.at <= atMs);
  // r167 §122.35 a starter's relief outing pushes his next start (two days; one with RP)
  const push = reliefPushDays(player);
  if (push && outs.some(o => !o.start && o.bf < PITCH_RP_LONG_OUTING_BF && daysSince(o, atMs) <= push)) return false;
  const starts = outs.filter(o => o.start || o.bf >= PITCH_RP_LONG_OUTING_BF);
  if (!starts.length) return true;
  return Math.min(...starts.map(o => daysSince(o, atMs))) > PITCH_SP_REST_DAYS;
}

/** Batters he can face in a game before he tires; a reliever still tired from recent days tires sooner. */
export function tireAfterBF(player, isStarter, carriedTired = false) {
  const s = stamina(player);
  const rp = PITCH_RP_TIRE_BASE_BF + s * PITCH_RP_TIRE_PER_STAMINA;
  // r167 §122.35 a starter's length takes being stretched out: 0 lasts like a reliever, 3 like a starter
  const bf = isStarter ? rp + (PITCH_SP_TIRE_BASE_BF + s * PITCH_SP_TIRE_PER_STAMINA - rp) * Math.min(3, stretchOf(player)) / 3 : rp;
  return Math.max(2, Math.round(bf * (carriedTired ? PITCH_RP_TIRED_ONSET_SHARE : 1)));
}

/**
 * r154 A starter's innings in a spring game: two in the first ones, building
 * to four by the last (`springNum` = the club's spring game, 0-based; spring
 * games lead the schedule, so it is the game's index).
 */
export function springStarterInnings(springNum) {
  const n = Math.max(1, SPRING_TRAINING_GAME_COUNT - 1);
  const k = Math.min(n, Math.max(0, Number.isFinite(springNum) ? springNum : 0));
  return Math.round(SPRING_SP_INNINGS.first + (SPRING_SP_INNINGS.last - SPRING_SP_INNINGS.first) * k / n);
}

/** Innings the manager wants from a reliever in this role. */
export function reliefInnings(role, rand) {
  if (role === ROLE.LONG) return PITCH_LONG_INNINGS.min + Math.floor(rand() * (PITCH_LONG_INNINGS.max - PITCH_LONG_INNINGS.min + 1));
  return 1;
}

// ─────────────────────────────────────────────────────────────
// THE MANAGER'S CALL
// ─────────────────────────────────────────────────────────────

/**
 * chooseReliever({ roles, players, used, atMs, inning, lead })
 * Who comes in, by the situation (`lead` = the pitching side's lead):
 *   - 9th or later, a save (up 1–3) or a tie: the closer, then the setup men;
 *   - 8th, close (up 0–3): the setup men;  7th, close: the second setup man;
 *   - a blowout (5+ either way) or an early hook (5th or before): a long man;
 *   - behind late, or anything else: the middle relievers.
 * In the late innings of a close game the manager goes down his roles and takes
 * the first arm who can pitch today — his closer pitches on back-to-back days,
 * never a third. Elsewhere a rested arm first, a tired one only when no rested
 * arm fits. An arm who can't go today only if there's nobody else; never
 * someone already used.
 * @returns {{ id, role, status, carriedTired, wanted } | null}
 */
export function chooseReliever({ roles, players, used, atMs, inning, lead }) {
  if (!roles) return null;
  const { closer, setup, middle, long } = roles;
  const close = lead >= 0 && lead <= 3;
  const highLeverage = close && inning >= 8;
  // Low-leverage innings are shared out: within a role, the arm who has rested longest goes first.
  const daysOff = (id) => (players[id] ? armStatus(players[id], atMs).lastDays ?? 99 : -1);
  const share = (ids) => [...ids].sort((a, b) => daysOff(b) - daysOff(a));
  let order;
  if (inning >= 9 && close)                order = [closer, ...setup, ...middle];
  else if (inning === 8 && close)          order = [...setup, ...middle];
  else if (inning === 7 && close)          order = [setup[1], ...middle, setup[0]];
  else if (Math.abs(lead) >= 5)            order = [...share(long), ...share(middle)];
  else if (inning <= 5)                    order = [...share(long), ...share(middle)];
  else                                     order = [...share(middle), ...share(long), ...[...setup].reverse()];
  const all = [closer, ...setup, ...middle, ...long].filter(Boolean);
  const candidates = [...order, ...all].filter((id, i, xs) => id && xs.indexOf(id) === i && !used.has(id) && players[id]);
  const arm = Object.fromEntries(candidates.map(id => [id, armStatus(players[id], atMs)]));
  const status = (id) => arm[id].status;
  // Everyone needs rest: the one who has had the most of it.
  const mostRested = [...candidates].sort((a, b) => (arm[b].lastDays ?? 99) - (arm[a].lastDays ?? 99))[0];
  const pick = (highLeverage ? candidates.find(id => status(id) !== 'down') : null)
            || candidates.find(id => status(id) === 'fresh')
            || candidates.find(id => status(id) === 'tired')
            || mostRested;
  if (!pick) return null;
  return { id: pick, role: roles.roleOf[pick] || ROLE.MIDDLE, status: status(pick), carriedTired: status(pick) !== 'fresh',
           // The manager's choice as he'd want it (a rested arm, or his late-inning man on a second day).
           wanted: status(pick) === 'fresh' || (highLeverage && status(pick) === 'tired') };
}
