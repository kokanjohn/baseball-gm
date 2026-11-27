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
import { enroll, leave, namesInUse } from './People.js';   // r281 §122.160, r284 namesInUse
import { withHistory } from './MessageHistory.js';   // r292 §122.174 answered messages that dropped off

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
 * A CPU club's GM's last name. r212 §122.90 a club keeps its GM (`team.gm`, set at the first turnover) until it
 * makes a change; before that, the name is the same every time it's asked (from the save's seed), a front-office
 * name, different for every club, never one of our staff's.
 */
export function cpuGmName(state, teamId) {
  const t = (state.leagueTeams || []).find(x => x.id === teamId);
  if (t?.gm?.name) return t.gm.name;
  // (r283 §122.162 nor the owner's, nor a club's manager's: one name, one person)
  const staff = new Set([...namesInUse(state), ...Object.values(state.userTeam?.coachingStaff || {}).map(c => c?.name), state.userTeam?.ownerName,
    ...(state.leagueTeams || []).map(x => x.manager?.name), ...(state.managerPool || []).map(m => m?.name)].filter(Boolean));
  const r = dice(diceSeed(state), 'cpu-gms');
  const pool = STAFF_NAMES.filter(n => !staff.has(n));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ids = (state.leagueTeams || []).map(x => x.id).sort();
  const k = ids.indexOf(teamId);
  return pool[(k < 0 ? 0 : k) % pool.length];
}

// ── r212 §122.90 GMs come and go: every spring, a club or two has a new one ──

export const GM_TURNOVER = Object.freeze({
  second: 0.4,        // the odds a second club makes a change the same winter
  welcomeBonus: 8,    // our standing with a new GM when we reach out first (from Compose → Other GMs)
  carry: 0.5,         // how much of our standing with the old GM the new one inherits (the rest back to even)
});

/**
 * The winter's GM changes (on the draft, at the turn of the season): every club's GM is fixed by name first; then
 * one club (two, sometimes) brings in a new GM, a losing club more likely than a winning one. The new GM starts
 * from part of our standing with the old one. Returns [{ teamId, name, prev }].
 */
export function gmTurnover(draft, rand, { records = {}, rapportDefault = 50 } = {}) {
  const teams = draft.leagueTeams || [];
  for (const t of teams) {
    if (!t.gm?.name) t.gm = { name: cpuGmName(draft, t.id), since: 1 };
    if (!t.gm.id) enroll(draft, t.gm, { role: 'gm', clubId: t.id, season: t.gm.since ?? 1 });   // r281 §122.160
  }
  const n = 1 + (rand() < GM_TURNOVER.second ? 1 : 0);
  // (records: last season's, taken before the new season zeroes them)
  const losses = (t) => { const r = records[t.id] || t; const w = r.wins || 0, l = r.losses || 0; return w + l ? l / (w + l) : 0.5; };
  const pool = teams.map(t => ({ t, w: 0.25 + losses(t) }));
  const used = new Set([...namesInUse(draft), ...teams.map(t => t.gm.name), ...Object.values(draft.userTeam?.coachingStaff || {}).map(c => c?.name).filter(Boolean)]);
  const out = [];
  for (let k = 0; k < n && pool.length; k++) {
    const tot = pool.reduce((m, x) => m + x.w, 0);
    let x = rand() * tot, i = 0;
    while (i < pool.length - 1 && x >= pool[i].w) { x -= pool[i].w; i++; }
    const { t } = pool.splice(i, 1)[0];
    const names = STAFF_NAMES.filter(nm => !used.has(nm));
    const name = names[Math.floor(rand() * names.length)] || t.gm.name;
    used.add(name);
    out.push({ teamId: t.id, name, prev: t.gm.name });
    if (t.gm.id) leave(draft, t.gm.id, (draft.seasonNum || 1) - 1);   // r281 §122.160 the one before stays in the record
    t.gm = { name, since: draft.seasonNum, prev: t.gm.name, prevId: t.gm.id || null };
    enroll(draft, t.gm, { role: 'gm', clubId: t.id, season: draft.seasonNum });
    const rels = draft.userTeam.gmRelationships || {};
    if (rels[t.id] != null) draft.userTeam.gmRelationships = { ...rels, [t.id]: Math.round(rapportDefault + (rels[t.id] - rapportDefault) * GM_TURNOVER.carry) };
  }
  return out;
}

/** Clubs whose GM is new this season (after the first). */
export function newGms(state) {
  const n = state.seasonNum || 1;
  return n > 1 ? (state.leagueTeams || []).filter(t => t.gm?.since === n) : [];
}

/** Clubs we've made a trade with (either way), ever. */
export function tradedWith(state) {
  const out = new Set();
  for (const tx of state.transactions || []) {
    if (tx?.reason !== 'trade') continue;
    if (tx.teamId === 'user' && tx.fromTeamId) out.add(tx.fromTeamId);
    if (tx.fromTeamId === 'user' && tx.teamId) out.add(tx.teamId);
  }
  return out;
}

/** Whether we've already reached out to (or answered) a club's GM this season. */
export function greetedThisSeason(state, teamId) {
  const n = state.seasonNum || 1;
  const sent = [...(state.scheduledCards || []), ...withHistory(state)]   // r292 §122.174 with the history
    .some(c => c.isCompose && c._composeTopic === 'gm_welcome' && c._composeArg?.key === teamId && (c._composeArg?.season ?? n) === n);
  const answered = withHistory(state).some(c => c._gmTeamId === teamId && c._gmSeason === n && c.resolved);   // r292 §122.174 with the history
  return sent || answered;
}

/** The new GMs we could still welcome (Compose → Other GMs). */
export function gmsToWelcome(state) {
  return newGms(state).filter(t => !greetedThisSeason(state, t.id))
    .map(t => ({ key: t.id, teamId: t.id, label: `${t.gm.name}, ${t.name}`, gm: t.gm.name, club: t.name }));
}
