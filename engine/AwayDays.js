/**
 * engine/AwayDays.js
 * r217 §122.96 Off days and road trips (message plan, release 4): the schedule facts their messages read.
 *
 *   offDayWindow(state, nowMs, nextGameMs)  the first whole day with no game of ours before the next one:
 *                                           { startMs, endMs } (its working hours), or null
 *   hometownOf(state, p)                    the league city a player grew up near (a club's id), or null —
 *                                           the same answer every time it's asked (from the save's seed)
 *   hometownPlayer(state, opponentId)       one of our active players who grew up near this opponent's city (r282 the club's id)
 *   parkQuirk(state, opponent)              how the opponent's ballpark plays (the same every visit)
 *   homeMorning(state, atMs, rand)          the morning of our first home game after a moment (a "how it
 *                                           went" message from the ballpark when we're back), or null
 *   PARK_EVENT_IDS                          the ballpark's bookings while we're away (one per road trip)
 *
 * Pure: never imports StateManager.
 */

import { dice, diceSeed } from './Dice.js';
import { PLAYER_GROUP } from '../data/constants.js';

const HOUR = 3_600_000;

/** The ballpark's bookings while we're on the road (CardEngine allows one per road trip). */
export const PARK_EVENT_IDS = Object.freeze(['rv1', 'rv2', 'rv3', 'rv4', 'rv6', 'rv7', 'rv8', 'rv9', 'rv10', 'rv11']);

const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextDay = (ms) => { const d = new Date(ms); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); };
const at = (day, h, m = 0) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); };

/**
 * The first whole day between now and our next game with no game of ours on it (a postponed game's old date
 * counts as a day off; a makeup game's date doesn't). Its messages come between 9am and 7pm — from now, if the
 * day has begun. null: no such day, or too little of it left.
 */
export function offDayWindow(state, nowMs, nextGameMs) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextGameMs)) return null;
  const games = (state?.schedule || []).filter(g => !g.cancelled && Number.isFinite(g.gameTime)).map(g => g.gameTime);
  const last = dayStart(nextGameMs);
  for (let d = dayStart(nowMs); d < last; d = nextDay(d)) {
    const end = nextDay(d);
    if (games.some(t => t >= d && t < end)) continue;
    const startMs = Math.max(at(d, 9), nowMs + 10 * 60_000), endMs = at(d, 19);
    if (endMs - startMs >= 2 * HOUR) return { startMs, endMs };
  }
  return null;
}

const _cities = (state) => [...(state?.leagueTeams || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** About one player in five grew up near one of the league's other cities. */
export function hometownOf(state, p) {
  if (!p?.id) return null;
  const teams = _cities(state);
  if (!teams.length) return null;
  const r = dice(diceSeed(state), 'hometown', p.id);
  if (r() >= 0.2) return null;
  return teams[Math.floor(r() * teams.length)].id;
}

/** One of our active players who grew up near the city we're visiting (the best known first). */
export function hometownPlayer(state, opponentId) {
  const team = (state?.leagueTeams || []).find(t => t.id === opponentId);
  if (!team) return null;
  const active = new Set([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN]);
  return (state.userTeam?.rosterIds || []).map(id => state.players?.[id])
    .filter(p => p && active.has(p.group) && hometownOf(state, p) === team.id)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

const QUIRKS = Object.freeze([
  'small — the ball carries to right, and the short porch there turns fly balls into home runs',
  'big — the gaps are deep, and the outfield takes away the long ball',
  'fast — the infield is hard and quick, and ground balls get through',
  'slow — the grass is kept long, and ground balls die in the infield',
  'odd — the wall in left is tall and close, and balls off it play like singles',
  'high — the air is thin, and breaking balls flatten out',
]);
/** How a club's ballpark plays — the same every time we visit. */
export function parkQuirk(state, opponent) {
  const r = dice(diceSeed(state), 'park-quirk', String(opponent || ''));
  return QUIRKS[Math.floor(r() * QUIRKS.length)];
}

/**
 * The morning of our first home game after `atMs` (10:00–11:30, before its first pitch): when we're back, the
 * ballpark tells us how a booking went. null: no home game left on the schedule.
 */
export function homeMorning(state, atMs, rand = Math.random) {
  const g = (state?.schedule || []).filter(x => !x.cancelled && x.isHome && Number.isFinite(x.gameTime) && x.gameTime > atMs + 2 * HOUR)
    .sort((a, b) => a.gameTime - b.gameTime)[0];
  if (!g) return null;
  const t = at(dayStart(g.gameTime), 10) + Math.floor(rand() * 90) * 60_000;
  return Math.max(atMs + 30 * 60_000, Math.min(t, g.gameTime - 2 * HOUR));
}
