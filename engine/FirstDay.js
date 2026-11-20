/**
 * engine/FirstDay.js
 * r211 §122.89 A new team's first day, planned: which first-day messages come and when, and the other clubs'
 * GMs who reach out through the first spring.
 *
 * Between taking over and the first pitch, the core messages (one per slot, as many as there's time for) are
 * spread through the staff's hours; with more time, secondary messages fill in, so something comes about
 * every couple of hours (up to FIRST_DAY.max in all). Times are drawn at random and uneven — sometimes two in
 * an hour, sometimes a long gap. Three other clubs' GMs reach out over the first spring: one may come the
 * first day (with enough time), the rest on later spring days.
 *
 * PURE: no StateManager. The caller passes the state, the times and a random source.
 */
import { awakeSegments } from './CardScheduler.js';
import { STAFF_NAMES } from '../data/player-names.js';
import { dice, diceSeed } from './Dice.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const FIRST_DAY = Object.freeze({
  leadMs: 4 * MIN,          // never sooner than this after the team is made
  tailMs: 20 * MIN,         // the last one comes at least this long before first pitch
  gapMs: 5 * MIN,           // and never two inside this
  coreFullHours: 3,         // all the core slots when there are at least this many staff hours
  everyHours: 1.75,         // with more time, about one message every this many staff hours
  max: 10,
  gmHellos: 3,              // other clubs' GMs over the first spring
  gmHelloFirstDayHours: 8,  // one of them comes the first day when there's at least this much time
  gmHelloDays: [1, 11],     // the rest: on these days after the takeover (from, to)
});

export const CORE_SLOTS = Object.freeze(['trainer', 'scouting', 'tickets', 'manager', 'equipment']);

/** The staff hours between two times (quiet hours left out), as segments [[a, b], …] and their total. */
function _staffTime(fromMs, toMs, quiet) {
  if (!(toMs > fromMs)) return { segs: [], ms: 0 };
  const segs = awakeSegments(fromMs, toMs, quiet?.quietStart || '22:00', quiet?.quietEnd || '08:00');
  return { segs, ms: segs.reduce((n, [a, b]) => n + (b - a), 0) };
}

/** `n` random times inside the segments, sorted, at least `gap` apart (fewer if they won't fit). */
function _timesIn(segs, n, rand, gap = FIRST_DAY.gapMs) {
  const total = segs.reduce((m, [a, b]) => m + (b - a), 0);
  if (!total || n <= 0) return [];
  const out = [];
  for (let k = 0; k < n * 6 && out.length < n; k++) {
    let x = rand() * total, t = null;
    for (const [a, b] of segs) { if (x < b - a) { t = a + x; break; } x -= b - a; }
    if (t != null && out.every(o => Math.abs(o - t) >= gap)) out.push(Math.round(t));
  }
  return out.sort((a, b) => a - b);
}

/**
 * How many first-day messages, and when. Returns { core, secondary, times } — `core` slots in order of
 * importance, `times` sorted; the core are spread across them (`coreAt`: their indexes into `times`).
 */
export function firstDayTimes(nowMs, firstPitchMs, quiet, rand) {
  const { segs, ms } = _staffTime(nowMs + FIRST_DAY.leadMs, firstPitchMs - FIRST_DAY.tailMs, quiet);
  const hours = ms / HOUR;
  if (hours < 0.25) return { core: 0, secondary: 0, times: [], coreAt: [], hours };
  const core = hours >= FIRST_DAY.coreFullHours ? CORE_SLOTS.length
             : Math.max(2, Math.min(CORE_SLOTS.length, Math.round(hours * 1.5)));
  const total = Math.min(FIRST_DAY.max, Math.max(core, Math.ceil(hours / FIRST_DAY.everyHours)));
  const times = _timesIn(segs, total, rand);
  const n = times.length;
  const c = Math.min(core, n);
  // The core, spread through: the first, then evenly across the rest.
  const coreAt = Array.from({ length: c }, (_, i) => Math.min(n - 1, Math.round((i * n) / c)));
  return { core: c, secondary: n - c, times, coreAt: [...new Set(coreAt)], hours };
}

/** Later spring days for the other GMs' hellos: one random staff-hours time each, on different days. */
export function gmHelloTimes(nowMs, count, quiet, rand) {
  const [from, to] = FIRST_DAY.gmHelloDays;
  const days = [];
  for (let k = 0; k < 40 && days.length < count; k++) {
    const d = from + Math.floor(rand() * (to - from + 1));
    if (!days.includes(d)) days.push(d);
  }
  return days.sort((a, b) => a - b).map(d => {
    const start = nowMs + d * DAY - 12 * HOUR, end = nowMs + d * DAY + 12 * HOUR;
    const t = _timesIn(_staffTime(start, end, quiet).segs, 1, rand)[0];
    return t ?? nowMs + d * DAY;
  });
}

/**
 * A CPU club's GM's last name: the same every time it's asked (from the save's seed), a front-office
 * name, different for every club, never one of our staff's.
 */
export function cpuGmName(state, teamId) {
  const staff = new Set(Object.values(state.userTeam?.coachingStaff || {}).map(c => c?.name).filter(Boolean));
  const r = dice(diceSeed(state), 'cpu-gms');
  const pool = STAFF_NAMES.filter(n => !staff.has(n));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ids = (state.leagueTeams || []).map(t => t.id).sort();
  const k = ids.indexOf(teamId);
  return pool[(k < 0 ? 0 : k) % pool.length];
}
