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
 * player.arm = [{ at, day, bf, outs, start }]   // outings in the last few days
 *   at  — when the game ended;  day — the local calendar day it was played
 *   (rest is counted in calendar days: "pitched yesterday" is about dates, not hours).
 */

import {
  PLAYER_GROUP,
  PITCH_SP_TIRE_BASE_BF, PITCH_SP_TIRE_PER_STAMINA, PITCH_RP_TIRE_BASE_BF, PITCH_RP_TIRE_PER_STAMINA,
  PITCH_SP_REST_DAYS, PITCH_RP_LONG_OUTING_BF, PITCH_RP_HEAVY_OUTING_BF, PITCH_RP_START_BF,
  PITCH_RP_MAX_STRAIGHT_DAYS, PITCH_RP_TIRED_ONSET_SHARE, PITCH_ARM_HISTORY_DAYS, PITCH_LONG_INNINGS,
} from '../data/constants.js';
import { isAvailable } from './PlayerFactory.js';

const DAY = 86_400_000;
export const ROLE = Object.freeze({ STARTER: 'starter', CLOSER: 'closer', SETUP: 'setup', MIDDLE: 'middle', LONG: 'long' });
export const ROLE_ABBR = Object.freeze({ starter: 'SP', closer: 'CL', setup: 'SU', middle: 'MR', long: 'LR' });

/** The local calendar day of a moment, as a day number. */
export const dayOf = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
/** Calendar days between two moments (yesterday = 1; a doubleheader = 0). */
export const daysBetween = (fromMs, toMs) => dayOf(toMs) - dayOf(fromMs);
/** Days since an outing, by the day it was played. */
const daysSince = (o, atMs) => dayOf(atMs) - (o.day ?? dayOf(o.at));

const stamina = (p) => p?.subRatings?.stamina ?? 60;

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
 * the closer, two setup men, then the middle relievers.
 */
export function bullpenRoles(team, players) {
  const pool = (team?.rosterIds || []).map(id => players[id])
    .filter(p => p && isAvailable(p) && (p.group === PLAYER_GROUP.BULLPEN || p.group === PLAYER_GROUP.PITCHER_BENCH));
  let long = pool.filter(p => p.pos === 'SP').sort((a, b) => stamina(b) - stamina(a));
  let rest = pool.filter(p => p.pos !== 'SP').sort((a, b) => reliefValue(b) - reliefValue(a));
  if (!long.length && rest.length > 4) {
    const lesser = rest.slice(Math.ceil(rest.length / 2)).sort((a, b) => stamina(b) - stamina(a));
    long = [lesser[0]];
    rest = rest.filter(p => p !== lesser[0]);
  }
  // A thin staff: the long men pitch where they're needed.
  if (!rest.length) { rest = long; long = []; }
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
export function recordOutings(draft, plays, endMs) {
  const startMs = (plays || []).find(p => p.type === 'game_start')?._timestamp ?? endMs;
  const day = dayOf(startMs);
  for (const [id, o] of Object.entries(outingsFrom(plays))) {
    const p = draft.players[id];
    if (!p) continue;
    p.arm = [...(p.arm || []).filter(x => endMs - x.at < PITCH_ARM_HISTORY_DAYS * DAY && x.at !== endMs),
             { at: endMs, day, bf: o.bf, outs: o.outs, start: o.start }];
  }
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
  const starts = (player?.arm || []).filter(o => o.at <= atMs && (o.start || o.bf >= PITCH_RP_LONG_OUTING_BF));
  if (!starts.length) return true;
  return Math.min(...starts.map(o => daysSince(o, atMs))) > PITCH_SP_REST_DAYS;
}

/** Batters he can face in a game before he tires; a reliever still tired from recent days tires sooner. */
export function tireAfterBF(player, isStarter, carriedTired = false) {
  const s = stamina(player);
  const bf = isStarter ? PITCH_SP_TIRE_BASE_BF + s * PITCH_SP_TIRE_PER_STAMINA
                       : PITCH_RP_TIRE_BASE_BF + s * PITCH_RP_TIRE_PER_STAMINA;
  return Math.max(2, Math.round(bf * (carriedTired ? PITCH_RP_TIRED_ONSET_SHARE : 1)));
}

/** Innings the manager wants from a reliever in this role. */
export function reliefInnings(role, rand = Math.random) {
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
