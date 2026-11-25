/**
 * engine/ManagerEngine.js
 * §122.64 Managers with a rating and a style — every club's, ours and the CPU clubs'.
 *
 *   manager = { name, quality (40–90; 60 league-typical), style, salary, ... }
 *     ours:    userTeam.coachingStaff.manager (with the contract, relationship)
 *     a CPU's: team.manager
 *
 *   The rating is the manager's game: in the late innings of a close game
 *   (the 7th on, within two runs) a club's hitters and pitchers get rating
 *   points by their manager (matchups, the pinch hitter, the moment to go to
 *   the bullpen). Calibrated (check-managers.mjs): about ±2 wins a season
 *   against a league-typical manager.
 *
 *   The style is how the manager wants to play one part of the game (the
 *   running game or the hook). A CPU club plays its manager's style. A new
 *   manager of ours starts the club on the style; the GM can overrule it
 *   (Strategy), and then the manager's late-game edge is cut in half and the
 *   relationship wears down a little with every game played that way.
 *
 *   The winter: a CPU club after a losing season may let its manager go
 *   (beginOffseason → cpuWinter). Those managers are on the market; when our
 *   manager's contract is up and the GM opens a search, the best of them can
 *   be one of the two candidates (candidates).
 *
 * Pure: never imports StateManager. Randomness comes from the `rand` passed in.
 */

import { STAFF_NAMES } from '../data/player-names.js';
import { eventRand } from './Dice.js';
import { qualityOf, qualityWord, rollQuality } from './CoachEngine.js';
import { strategyOf, RUN_STYLES, HOOK_STYLES } from './Strategy.js';
import { enroll, leave, toMarket, samePerson } from './People.js';   // r281 §122.160

export { qualityWord };

/** Each style: the part of the game it's about, and the setting the manager wants. */
export const MANAGER_STYLES = Object.freeze({
  runner:    { part: 'run',  setting: 'more',  label: 'Runner',             words: 'likes to run' },
  station:   { part: 'run',  setting: 'less',  label: 'Station to station', words: 'holds the runners' },
  quickHook: { part: 'hook', setting: 'quick', label: 'Quick hook',         words: 'goes to the bullpen early' },
  starters:  { part: 'hook', setting: 'long',  label: 'Rides the starters', words: 'lets the starters work deep' },
});
const STYLE_KEYS = Object.keys(MANAGER_STYLES);
const SETTING_LABEL = { run: RUN_STYLES, hook: HOOK_STYLES };

/** Rating points in a late, close game for a 90 manager (a 40 is −2/3 of it). */
export const MGR_LATE_PTS = 2;
export const MGR_OVERRULED = 0.5;          // the edge left when the GM plays against the style
export const MGR_FRICTION = 0.5;           // relationship lost per game played against the style
const MGR_FRICTION_FLOOR = 15;
const MGR_BASE_SALARY = 225;               // $K a year (a league-typical manager earns about this)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

/** The club's manager (ours in the coaching staff, a CPU club's on the team), or null. */
export const managerOf = (team) => team?.coachingStaff?.manager || team?.manager || null;

export const styleOf = (m) => MANAGER_STYLES[m?.style] || null;
export const styleLabel = (m) => styleOf(m)?.label || '';
export const styleWords = (m) => styleOf(m)?.words || '';
/** "Run More" / "Quick Hook": the strategy setting the style wants. */
export const styleSettingLabel = (m) => { const s = styleOf(m); return s ? SETTING_LABEL[s.part][s.setting].label : ''; };

/** What a manager of this quality earns ($K a year). */
export function salaryFor(q) {
  return Math.round(MGR_BASE_SALARY * (0.7 + 0.6 * clamp((q - 40) / 50, 0, 1)) / 5) * 5;
}

/** A new manager: quality around `mean`, a style. */
export function rollManager(rand = eventRand, mean = 58, style = null) {
  const quality = rollQuality(rand, mean, 12);
  return { quality, style: MANAGER_STYLES[style] ? style : _pick(STYLE_KEYS, rand), salary: salaryFor(quality) };
}

/** Give a manager without a rating one (a save from before §122.64). */
export function ensureManager(m, rand = eventRand) {
  if (!m) return m;
  if (!Number.isFinite(m.quality)) m.quality = rollQuality(rand, 58, 12);
  if (!MANAGER_STYLES[m.style]) m.style = _pick(STYLE_KEYS, rand);
  return m;
}

/** The club plays the manager's style (a new manager's first day; a CPU club always). */
export function applyStyle(team, m = managerOf(team)) {
  const s = styleOf(m);
  if (!team || !s) return false;
  team.strategy = { ...strategyOf(team), [s.part]: s.setting };
  return true;
}

/** The GM has the club playing against the manager's style. */
export function overruled(team, m = managerOf(team)) {
  const s = styleOf(m);
  return !!s && strategyOf(team)[s.part] !== s.setting;
}

/**
 * Rating points the club's hitters and pitchers get in a late, close game:
 * +2 (90) … 0 (60) … −1.3 (40), halved while the GM overrules the style.
 * A club without a manager (an All-Star squad) gets none.
 */
export function lateClosePoints(team) {
  const m = managerOf(team);
  if (!m) return 0;
  const pts = (qualityOf(m) - 60) / 30 * MGR_LATE_PTS;
  return overruled(team, m) ? pts * MGR_OVERRULED : pts;
}

/** After a regular-season game of ours: playing against the manager's style wears on the relationship. */
export function afterGame(team) {
  const m = team?.coachingStaff?.manager;
  if (!m || !overruled(team, m)) return false;
  m.relationship = Math.max(MGR_FRICTION_FLOOR, (m.relationship ?? 50) - MGR_FRICTION);
  return true;
}

/** Every manager's name in the league (ours and the CPU clubs'), and the market's. */
export function managerNames(state) {
  return new Set([
    state?.userTeam?.coachingStaff?.manager?.name,
    ...(state?.leagueTeams || []).map(t => t.manager?.name),
    ...(state?.managerPool || []).map(m => m.name),
  ].filter(Boolean));
}

/** Names nobody in the league is using (staff, owner, managers, the market). */
function _freeNames(state, taken = new Set()) {
  const used = new Set([...taken, ...managerNames(state), state?.userTeam?.ownerName,
    ...Object.values(state?.userTeam?.coachingStaff || {}).map(c => c?.name)].filter(Boolean));
  return STAFF_NAMES.filter(n => !used.has(n));
}

/**
 * Every CPU club gets a manager (a new league), each club playing its manager's style. The styles
 * are dealt from a shuffled deck, so the league has about as many quick hooks as long leashes and
 * as many runners as clubs that hold them (the league's innings and steals stay where they were).
 */
export function staffLeague(state, rand = eventRand, taken = new Set()) {
  const free = _freeNames(state, taken);
  let deck = [];
  for (const t of state.leagueTeams || []) {
    if (t.manager?.name) { ensureManager(t.manager, rand); applyStyle(t); enroll(state, t.manager, { role: 'manager', clubId: t.id, season: t.manager.hiredSeason ?? state.seasonNum ?? 1 }); continue; }
    if (!deck.length) deck = [...STYLE_KEYS].sort(() => rand() - 0.5);
    const name = free.splice(Math.floor(rand() * free.length) % Math.max(1, free.length), 1)[0] || `${t.abbr} Manager`;
    t.manager = { name, ...rollManager(rand, 58, deck.pop()), hiredSeason: state.seasonNum || 1 };
    enroll(state, t.manager, { role: 'manager', clubId: t.id, season: state.seasonNum || 1 });   // r281 §122.160
    applyStyle(t);
  }
}

// ─────────────────────────────────────────────────────────────
// THE WINTER
// ─────────────────────────────────────────────────────────────

const MARKET_SEASONS = 2;          // a manager stays on the market for two winters
const MARKET_MAX = 8;

/**
 * cpuWinter(draft, atMs, rand) — the CPU clubs' managers after the season
 * (before the records are archived). A losing season can cost a manager the
 * job (under .420: 60%; under .470: 25%); a rare one leaves on their own (4%).
 * The club hires from the market (a manager let go before) or someone new,
 * and plays the new manager's style. Returns MANAGER_CHANGE events.
 */
export function cpuWinter(draft, atMs, rand = eventRand) {
  const season = draft.seasonNum || 1;
  const pool = (draft.managerPool || []).filter(m => season - (m.season || season) < MARKET_SEASONS);
  const events = [];
  for (const t of draft.leagueTeams || []) {
    const m = t.manager;
    if (!m?.name) continue;
    const gp = (t.wins || 0) + (t.losses || 0);
    const pct = gp ? (t.wins || 0) / gp : 0.5;
    const p = pct < 0.42 ? 0.6 : pct < 0.47 ? 0.25 : 0.04;
    if (rand() >= p) continue;
    const fired = pct < 0.47;
    const gone = { id: m.id, name: m.name, quality: m.quality, style: m.style, club: t.name, clubId: t.id, wins: t.wins || 0, losses: t.losses || 0, season, fired };
    if (m.id) toMarket(draft, m.id, season);   // r281 §122.160 the same person, on the market
    // The new one: the best of the market some of the time, else someone new.
    let next;
    const best = pool.filter(x => x.clubId !== t.id).sort((a, b) => b.quality - a.quality)[0];
    if (best && rand() < 0.4) {
      pool.splice(pool.indexOf(best), 1);
      next = { id: best.id, name: best.name, quality: best.quality, style: best.style, salary: salaryFor(best.quality) };
    } else {
      const free = _freeNames({ ...draft, managerPool: pool }, new Set([gone.name]));
      next = { name: _pick(free, rand) || `${t.abbr} Manager`, ...rollManager(rand) };
    }
    pool.push(gone);
    t.manager = { ...next, hiredSeason: season + 1 };
    enroll(draft, t.manager, { role: 'manager', clubId: t.id, season: season + 1 });   // r281 §122.160 (an id if new)
    applyStyle(t);
    events.push({ type: 'MANAGER_CHANGE', teamId: t.id, out: gone.name, in: next.name, fired, record: `${gone.wins}–${gone.losses}`, atMs });
  }
  draft.managerPool = pool.sort((a, b) => b.season - a.season || b.quality - a.quality).slice(0, MARKET_MAX);
  return events;
}

const BACKGROUNDS = [
  'a bench coach in the league for six seasons',
  'a longtime manager in the minors',
  'a former catcher who managed in winter ball',
  'a third-base coach ready for a first job',
  'a former infielder who ran a college program',
];

/**
 * candidates(state, opts) — two managers for our search. The first is the
 * best on the market (let go by a CPU club) when there is one, otherwise a
 * strong outside hire, and asks more; the second is cheaper, with another style.
 */
export function candidates(state, { rand = eventRand, taken = new Set() } = {}) {
  const ours = state.userTeam?.coachingStaff?.manager;
  // (r221 never one who shares a name with someone on our staff)
  const staffNames = new Set(Object.values(state.userTeam?.coachingStaff || {}).map(c => c?.name).filter(Boolean));
  const market = (state.managerPool || []).filter(m => !samePerson(m, ours) && !taken.has(m.name) && !staffNames.has(m.name)).sort((a, b) => b.quality - a.quality);
  const bg = [...BACKGROUNDS];
  const bgOf = () => bg.splice(Math.floor(rand() * bg.length) % bg.length, 1)[0] || '';
  const free = _freeNames(state, new Set([...taken, ...market.map(m => m.name)]));
  const nameOf = () => free.splice(Math.floor(rand() * free.length) % Math.max(1, free.length), 1)[0] || 'New Manager';
  let A;
  if (market.length) {
    const m = market[0];
    A = { id: m.id, name: m.name, quality: m.quality, style: m.style, salary: Math.round(salaryFor(m.quality) * 1.05 / 5) * 5,
          background: `let go by the ${m.club} after a ${m.wins}–${m.losses} season`, fromClub: m.clubId };
  } else {
    const r = rollManager(rand, 68);
    A = { name: nameOf(), ...r, salary: Math.round(r.salary * 1.1 / 5) * 5, background: bgOf() };
  }
  const r = rollManager(rand, 58, _pick(STYLE_KEYS.filter(k => k !== A.style), rand));
  const B = { name: nameOf(), ...r, salary: Math.round(r.salary * 0.95 / 5) * 5, background: bgOf() };
  return [A, B];
}

/** Hire a candidate as our manager on a two-year deal; the club starts on the new manager's style. */
export function hire(draft, cand, nextSeason) {
  const u = draft.userTeam;
  const prev = u.coachingStaff.manager || {};
  u.coachingStaff.manager = {
    ...(cand.id ? { id: cand.id } : {}), name: cand.name, quality: cand.quality, style: cand.style, salary: cand.salary, background: cand.background || '',
    contractExpiry: nextSeason + 2, relationship: 50, managerConfidence: 55, hiredSeason: nextSeason,
  };
  // r281 §122.160 the same person off the market; the one before leaves our record
  draft.managerPool = (draft.managerPool || []).filter(m => !samePerson(m, cand));
  if (prev.id) leave(draft, prev.id, nextSeason - 1);
  enroll(draft, u.coachingStaff.manager, { role: 'manager', clubId: 'user', season: nextSeason });
  applyStyle(u);
  return { name: cand.name, prev: prev.name, id: u.coachingStaff.manager.id, prevId: prev.id || null };
}
