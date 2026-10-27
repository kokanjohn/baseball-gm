/**
 * engine/OffseasonEngine.js
 * The offseason on the league calendar (§70; structure §23, sequence §13.2).
 *
 *   World Series final ─ SEASON_SUMMARY
 *   day 1 00:00  OFFSEASON: record locked, stats archived, every player ages a
 *                year and develops/declines, retirements; ownership evaluation
 *   day 2 10:00  contracts: CPU clubs re-sign or let go; farm deals renewed;
 *                the user's re-sign cards; free agency opens
 *   day 3 10:00  manager contract (if it is up); free agency
 *   day 4–6      free agency (CPU clubs sign to fill needs; FA cards for the GM)
 *   day 5        reminder for any required decision still open
 *   day 7 00:00  required decisions auto-resolve conservatively; unsigned free
 *                agents leave the league; amateur prospects join every farm;
 *                season N+1 begins with spring training
 *
 * Pure: never imports StateManager. Every function takes the draft state the
 * caller is mutating (inside StateManager.mutate) and returns events / data.
 * GameEngine runs the steps on the clock; CardEngine delivers and resolves the
 * GM's cards through the apply* functions here.
 */

import {
  PLAYER_GROUP,
  ROSTER_LIMITS,
  SALARY_BY_OVR,
  SUB_RATING_MIN,
  SUB_RATING_MAX,
  AGE_DEVELOPMENT_WINDOWS,
  RETIREMENT_AGE_HARD,
  RETIREMENT_AGE_SOFT,
  RETIREMENT_OVR_SOFT,
  RETIREMENT_OVR_FARM,
  WIN_TARGET_MET_WITHIN,
  WIN_TARGET_ADJ_EXCEED_8_PLUS,
  WIN_TARGET_ADJ_EXCEED_3_TO_7,
  WIN_TARGET_ADJ_MET,
  WIN_TARGET_ADJ_MISS_1_TO_4,
  WIN_TARGET_ADJ_MISS_5_TO_9,
  WIN_TARGET_ADJ_MISS_10_PLUS,
  OFFSEASON_DAYS,
  OFFSEASON_STEP_HOURS,
  CPU_RESIGN_ODDS,
  CPU_RESIGN_AGE_34_MULT,
  WALK_ABROAD_PROB_31_PLUS,
  WALK_ABROAD_PROB_UNDER_31,
  PROSPECTS_PER_TEAM_MIN,
  PROSPECTS_PER_TEAM_MAX,
  PROSPECT_AGE_MIN,
  PROSPECT_AGE_MAX,
  PROSPECT_OVR_MIN,
  PROSPECT_OVR_MAX,
  OWNERSHIP_OFFER,
  CONTRACT_AUTO_WALK_MORALE,
  MANAGER_EXTENSION_YEARS,
  MANAGER_AUTO_CONFIDENCE,
  FA_UPGRADE_MIN,
} from '../data/constants.js';

import { computeAge, computeOVR, createPlayer, baseballYear, _freshStats } from './PlayerFactory.js';
import { clearInjuryUpdate } from './InjuryEngine.js';
import {
  defaultActiveGroup,
  eligibleSlotsFor,
  pendingArrivals,
  computePayroll,
  HITTER_TARGET,
  PITCHER_TARGET,
} from './RosterEngine.js';
import { PLAYER_NAME_POOL, STAFF_NAMES } from '../data/player-names.js';

export const OFFSEASON_STEPS = Object.freeze(['day1', 'day2', 'day3', 'day4', 'day5', 'day6', 'spring']);

const isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const OFF_ROSTER = new Set([PLAYER_GROUP.FREE_AGENT, PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED, 'waivers']);

// ─────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────

/**
 * createOffseason(endMs, seasonNum)
 * The offseason's calendar, from the moment the season ended.
 * Day boundaries are local midnights (DST-safe: built with setDate).
 * @returns {{ seasonNum, endedAt, dayStarts: Number[], springAt, done: String[] }}
 */
export function createOffseason(endMs, seasonNum) {
  const d = new Date(endMs);
  d.setHours(0, 0, 0, 0);
  const dayStarts = [];
  for (let i = 1; i <= OFFSEASON_DAYS + 1; i++) {
    const day = new Date(d);
    day.setDate(d.getDate() + i);
    dayStarts.push(day.getTime());
  }
  return {
    seasonNum,
    endedAt:   endMs,
    dayStarts: dayStarts.slice(0, OFFSEASON_DAYS),   // [day1 … day6] midnights
    springAt:  dayStarts[OFFSEASON_DAYS],            // day 7 midnight
    done:      [],
  };
}

/** Real time a step runs at. */
export function stepTime(os, step) {
  if (step === 'spring') return os.springAt + OFFSEASON_STEP_HOURS.spring * 3600_000;
  const n = Number(step.slice(3));
  return _atHour(os.dayStarts[n - 1], OFFSEASON_STEP_HOURS[step]);
}

/** A local hour on the day that starts at `dayStartMs`. */
export function _atHour(dayStartMs, hour) {
  const d = new Date(dayStartMs);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Midnight that starts offseason day `n` (1–6), or spring (7). */
export function dayStart(os, n) {
  return n > OFFSEASON_DAYS ? os.springAt : os.dayStarts[n - 1];
}

/** Steps due by `atMs`, in order, with their times. */
export function dueSteps(state, atMs) {
  const os = state?.offseason;
  if (!os) return [];
  return OFFSEASON_STEPS
    .filter(s => !(os.done || []).includes(s))
    .map(s => ({ step: s, at: stepTime(os, s) }))
    .filter(x => x.at <= atMs);
}

/** The offseason day (1–6) at `nowMs`, or 0 before day 1 / outside the offseason. */
export function offseasonDay(state, nowMs = Date.now()) {
  const os = state?.offseason;
  if (!os) return 0;
  let day = 0;
  os.dayStarts.forEach((t, i) => { if (nowMs >= t) day = i + 1; });
  return day;
}

export const DAY_FOCUS = Object.freeze({
  0: { label: 'Season Complete',      sub: 'The offseason opens at midnight.' },
  1: { label: 'Season Review',        sub: 'The record is in the books. Ownership weighs in.' },
  2: { label: 'Contract Decisions',   sub: 'Expiring deals: re-sign or let them walk. Free agency opens.' },
  3: { label: 'Staff & Free Agency',  sub: 'The manager\'s future, and the market keeps moving.' },
  4: { label: 'Free Agency',          sub: 'Clubs are filling holes. New names on the market.' },
  5: { label: 'Final Decisions',      sub: 'Anything required still open is decided for you at midnight tomorrow.' },
  6: { label: 'Spring Eve',           sub: 'Spring training opens at midnight.' },
});

// ─────────────────────────────────────────────────────────────
// TEAMS / ROSTER HELPERS
// ─────────────────────────────────────────────────────────────

function _team(draft, teamId) {
  return teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === teamId) || null;
}

function _allTeams(draft) {
  return [draft.userTeam, ...(draft.leagueTeams || [])];
}

/** Remove a player from every list his club keeps (roster, farm, lineup, rotation, queues). */
function _detach(draft, playerId) {
  for (const t of _allTeams(draft)) {
    if (!t) continue;
    t.rosterIds = (t.rosterIds || []).filter(id => id !== playerId);
    t.farmIds   = (t.farmIds   || []).filter(id => id !== playerId);
    for (const s of t.lineupSlots || []) if (s.playerId === playerId) { s.playerId = null; delete s.emergency; }
    if (t.rotation?.order) t.rotation.order = t.rotation.order.filter(id => id !== playerId);
  }
  draft.waiverPool    = (draft.waiverPool    || []).filter(id => id !== playerId);
  draft.ilReturnQueue = (draft.ilReturnQueue || []).filter(id => id !== playerId);
  draft.freeAgentPool = (draft.freeAgentPool || []).filter(id => id !== playerId);
  for (const tx of draft.transactions || []) {
    if (tx.status === 'pending' && tx.playerId === playerId) { tx.status = 'cancelled'; tx.note = 'player left the club'; }
  }
}

/** Active (non-IL) players plus players on their way — the 28-man count. */
export function activeCount(draft, teamId) {
  const t = _team(draft, teamId);
  const n = (t?.rosterIds || []).filter(id => draft.players[id]?.group !== PLAYER_GROUP.IL).length;
  return n + pendingArrivals(draft, teamId).length;
}

function _sideCounts(draft, teamId) {
  const t = _team(draft, teamId);
  const c = { hitter: 0, pitcher: 0 };
  for (const id of t?.rosterIds || []) {
    const p = draft.players[id];
    if (!p || p.group === PLAYER_GROUP.IL) continue;
    c[isPitcher(p) ? 'pitcher' : 'hitter']++;
  }
  for (const tx of pendingArrivals(draft, teamId)) c[isPitcher(draft.players[tx.playerId]) ? 'pitcher' : 'hitter']++;
  return c;
}

/** What a club most needs: an open lineup spot, a starter, or roster balance. */
export function teamNeed(draft, teamId) {
  const t = _team(draft, teamId);
  if (!t) return null;
  const open = (t.lineupSlots || []).find(s => !s.playerId);
  if (open) return { side: 'hitter', pos: open.slot };
  const sp = (t.rosterIds || []).filter(id => draft.players[id]?.group === PLAYER_GROUP.STARTING_PITCHERS).length;
  if (sp < ROSTER_LIMITS.STARTING_PITCHERS) return { side: 'pitcher', pos: 'SP' };
  const c = _sideCounts(draft, teamId);
  if (c.hitter < HITTER_TARGET)  return { side: 'hitter',  pos: null };
  if (c.pitcher < PITCHER_TARGET) return { side: 'pitcher', pos: c.pitcher < ROSTER_LIMITS.STARTING_PITCHERS + ROSTER_LIMITS.BULLPEN ? 'RP' : null };
  return null;
}

function _fits(p, need) {
  if (!need || isPitcher(p) !== (need.side === 'pitcher')) return false;
  if (!need.pos) return true;
  return need.side === 'pitcher' ? p.pos === need.pos || need.pos === 'RP' : eligibleSlotsFor(p).includes(need.pos);
}

// ─────────────────────────────────────────────────────────────
// CONTRACTS
// ─────────────────────────────────────────────────────────────

/** Seasons left on a deal during season `seasonNum` (1 = this is the final season). */
export function yearsLeft(player, seasonNum) {
  return (player?.contractExpiry ?? seasonNum + 1) - seasonNum;
}

/** Is this player's deal up at the end of season `seasonNum`? */
export function contractIsUp(player, seasonNum) {
  return yearsLeft(player, seasonNum) <= 1;
}

function _salaryFor(ovr) {
  for (const tier of Object.values(SALARY_BY_OVR)) {
    if (ovr >= tier.ovrMin && ovr <= tier.ovrMax) {
      return tier.salMin + (tier.salMax - tier.salMin) * (ovr - tier.ovrMin) / Math.max(1, tier.ovrMax - tier.ovrMin);
    }
  }
  return ovr < 40 ? 20 : 30000;
}

/**
 * marketTerms(draft, player)
 * What the player asks for on the open market for next season: salary on the
 * league-wide OVR scale, discounted with age; length by age and standing.
 * @returns {{ salary: Number ($K), years: Number }}
 */
export function marketTerms(draft, player) {
  const age = computeAge(player.dob, baseballYear(draft) + 1);
  const rel = (player.ovr || 50) - (draft.leagueTalentOffset || 0);
  const ageFactor = age >= 34 ? 0.7 : age >= 32 ? 0.85 : 1;
  const salary = Math.max(20, Math.round(_salaryFor(player.ovr || 50) * ageFactor / 5) * 5);
  const years = age >= 34 ? 1
    : age >= 31 ? (rel >= 60 ? 2 : 1)
    : age >= 28 ? (rel >= 60 ? 3 : 2)
    : (rel >= 62 ? 4 : rel >= 54 ? 3 : 2);
  return { salary, years };
}

/**
 * Sign `playerId` to `terms`: starting next season (offseason deals), or —
 * `startNow` — covering the current season too (in-season signings).
 */
export function applyContract(draft, playerId, terms, { startNow = false } = {}) {
  const p = draft.players[playerId];
  if (!p) return;
  const start = (draft.seasonNum || 1) + (startNow ? 0 : 1);
  Object.assign(p, {
    contractSalary:        terms.salary,
    contractYears:         terms.years,
    contractExpiry:        start + terms.years,
    contractExtended:      false,
    contractExpired:       false,
    _contractExpiringNext: false,
    _ask:                  null,
  });
}

/** The player leaves his club for the free-agent market. */
export function releaseToFreeAgency(draft, playerId, atMs, { reason = 'contract' } = {}) {
  const p = draft.players[playerId];
  if (!p) return null;
  const from = p.teamId;
  _detach(draft, playerId);
  Object.assign(p, {
    teamId: null, group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent',
    _faFrom: from || p._waivedBy || null, _faSince: atMs, _faReason: reason,
    _ask: p._ask || marketTerms(draft, p),
    _isKeeper: false, _isSpringInvitee: false, lineupSlot: null,
  });
  draft.freeAgentPool = [...(draft.freeAgentPool || []), playerId];
  return { type: 'FREE_AGENT', playerId, fromTeamId: from, atMs };
}

/** The player takes an offer from another league (or is simply gone). */
export function departLeague(draft, playerId, atMs, reason = 'abroad') {
  const p = draft.players[playerId];
  if (!p) return null;
  const from = p.teamId || p._faFrom || null;
  _detach(draft, playerId);
  Object.assign(p, { teamId: null, group: PLAYER_GROUP.DEPARTED, tier: 'departed',
                     _departedAt: atMs, _departReason: reason });
  return { type: 'DEPARTED', playerId, fromTeamId: from, reason, atMs };
}

/**
 * signFreeAgent(draft, playerId, teamId, atMs, { displaceId })
 * A club signs a free agent at his asking terms. If the club's 28 is full,
 * `displaceId` (same side, not a starter) is optioned to the farm — or, with
 * the farm full, released to the market.
 */
export function signFreeAgent(draft, playerId, teamId, atMs, { displaceId = null } = {}) {
  const p = draft.players[playerId];
  const t = _team(draft, teamId);
  if (!p || !t || p.group !== PLAYER_GROUP.FREE_AGENT) return null;
  const events = [];
  if (displaceId && activeCount(draft, teamId) >= ROSTER_LIMITS.ACTIVE_TOTAL) {
    const d = draft.players[displaceId];
    if (d && (t.rosterIds || []).includes(displaceId)) {
      const sideMax = isPitcher(d) ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX;
      const sideOnFarm = (t.farmIds || []).filter(id => isPitcher(draft.players[id]) === isPitcher(d)).length;
      if (sideOnFarm < sideMax) {
        _detach(draft, displaceId);
        t.farmIds = [...(t.farmIds || []), displaceId];
        Object.assign(d, { group: PLAYER_GROUP.PRACTICE_SQUAD, tier: 'farm', teamId });
        events.push({ type: 'OPTIONED', playerId: displaceId, teamId, atMs });
      } else {
        events.push(releaseToFreeAgency(draft, displaceId, atMs, { reason: 'released' }));
      }
    }
  }
  const terms = p._ask || marketTerms(draft, p);
  draft.freeAgentPool = (draft.freeAgentPool || []).filter(id => id !== playerId);
  t.rosterIds = [...(t.rosterIds || []), playerId];
  Object.assign(p, {
    teamId, group: defaultActiveGroup(p), tier: 'active',
    _faFrom: null, _faSince: null, _faReason: null,
  });
  applyContract(draft, playerId, terms);
  events.push({ type: 'FA_SIGNED', playerId, teamId, terms, atMs });
  return events;
}

/** The weakest same-side non-starter a club would move to make room for `player`. */
export function displacementFor(draft, teamId, player) {
  const t = _team(draft, teamId);
  if (!t || activeCount(draft, teamId) < ROSTER_LIMITS.ACTIVE_TOTAL) return null;
  const starters = new Set([...(t.lineupSlots || []).map(s => s.playerId), ...(t.rotation?.order || [])]);
  return (t.rosterIds || []).map(id => draft.players[id])
    .filter(p => p && isPitcher(p) === isPitcher(player) && !starters.has(p.id) && p.group !== PLAYER_GROUP.IL)
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
}

// ─────────────────────────────────────────────────────────────
// DAY 1 — LOCK, ARCHIVE, AGE & DEVELOP, RETIRE
// ─────────────────────────────────────────────────────────────

/**
 * beginOffseason(draft, atMs)
 * Steps 1–5 of §13.2 for every player in the league. Returns events
 * (RETIRED for every retirement; the user's become notices + history).
 */
export function beginOffseason(draft, atMs) {
  _lockSeason(draft, atMs);
  _archiveStats(draft);
  const nextYear = baseballYear(draft) + 1;
  for (const p of Object.values(draft.players || {})) {
    if (!p || p.group === PLAYER_GROUP.RETIRED || p.group === PLAYER_GROUP.DEPARTED) continue;
    _develop(p, nextYear, draft.seasonNum || 1);
  }
  draft.ilReturnQueue = [];
  draft.impScores = {};
  draft.userTeam._ownerWinTarget = nextWinTarget(draft);
  return _retirements(draft, atMs, nextYear);
}

function _lockSeason(draft, atMs) {
  const u = draft.userTeam;
  const b = draft.playoffBracket;
  const series = b ? ['WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES']
    .flatMap(r => r === 'WORLD_SERIES' ? b.WORLD_SERIES.series : [...b.divA[r].series, ...b.divB[r].series]) : [];
  const userSeries = series.filter(s => s.teamA?.id === 'user' || s.teamB?.id === 'user');
  const lost = userSeries.find(s => s.status === 'final' && (s.winner === 'A' ? s.teamB : s.teamA)?.id === 'user');
  const label = { WILD_CARD: 'Wild Card', FIRST_ROUND: 'First Round', DIVISION_SERIES: 'Division Series', WORLD_SERIES: 'World Series' };
  const result = b?.champion?.id === 'user' ? 'Champions'
    : lost ? `Lost in the ${label[lost.round]}`
    : userSeries.length ? 'Playoffs' : 'Did not qualify';
  const standings = [u, ...(draft.leagueTeams || [])]
    .map(t => ({ id: t.id, name: t.id === 'user' ? `${u.city} ${u.nickname}`.trim() : t.name, abbr: t.abbr,
                 divisionId: t.divisionId, wins: t.wins || 0, losses: t.losses || 0 }))
    .sort((x, y) => (y.wins - y.losses) - (x.wins - x.losses));
  draft.seasonHistory = [...(draft.seasonHistory || []), {
    seasonNum:  draft.seasonNum || 1,
    year:       baseballYear(draft),
    wins:       u.wins || 0,
    losses:     u.losses || 0,
    winTarget:  u._ownerWinTarget || null,
    postseason: { wins: u.postseasonWins || 0, losses: u.postseasonLosses || 0, result },
    champion:   b?.champion ? { id: b.champion.id, name: b.champion.name } : null,
    standings,
    lockedAt:   atMs,
  }];
}

function _archiveStats(draft) {
  const season = draft.seasonNum || 1;
  const year   = baseballYear(draft);
  for (const p of Object.values(draft.players || {})) {
    if (!p) continue;
    const pit = isPitcher(p);
    const st  = p.stats || {};
    const ps  = p.postseasonStats || {};
    const career = { ...(p.careerStats || {}) };
    for (const [k, v] of Object.entries(st)) if (typeof v === 'number') career[k] = (career[k] || 0) + v;
    if ((st.g || 0) > 0) career.seasons = (career.seasons || 0) + 1;
    if ((p.ovr || 0) > (career.peakOvr || 0)) { career.peakOvr = p.ovr; career.peakSeason = season; }
    const post = { ...(p.careerPostseasonStats || {}) };
    for (const [k, v] of Object.entries(ps)) if (typeof v === 'number') post[k] = (post[k] || 0) + v;
    p.careerStats = career;
    p.careerPostseasonStats = post;
    if ((st.g || 0) > 0 || (ps.g || 0) > 0) {
      p.seasonLog = [...(p.seasonLog || []), {
        season, year, teamId: p.teamId || null, ovr: p.ovr,
        stats: { ...st }, postseason: (ps.g || 0) > 0 ? { ...ps } : null,
      }];
    }
    p.stats           = _freshStats(pit);
    p.springStats     = _freshStats(pit);
    p.postseasonStats = _freshStats(pit);
    p._impGameLog     = [];
  }
}

/**
 * _develop(player, nextYear, seasonNum)
 * Section 4.1 (LOCKED) age curves on each active sub-rating, by the player's
 * baseball age in the coming season, with trait modifiers and variance; OVR
 * recomputed. Injuries heal over the winter.
 *
 *                Growth  Peak   Prime  Decline  Steep
 *                (21-24) (25-27)(28-30)(31-33)  (34+)
 * contact/control: +1.5   +0.5  -0.5   -1.5    -3.0
 * power/stuff:     +1.0   +0.5  -1.0   -2.0    -3.5
 * speed/stamina:   +0.5   +0.0  -1.5   -2.5    -4.0
 */
const CURVES = [
  [1.5, 0.5, -0.5, -1.5, -3.0],
  [1.0, 0.5, -1.0, -2.0, -3.5],
  [0.5, 0.0, -1.5, -2.5, -4.0],
];
function _develop(p, nextYear, seasonNum) {
  const sr = p.subRatings;
  if (sr) {
    const age = computeAge(p.dob, nextYear);
    const keys = isPitcher(p) ? ['control', 'stuff', 'stamina'] : ['contact', 'power', 'speed'];
    const idx = age <= AGE_DEVELOPMENT_WINDOWS.GROWTH.max  ? 0
              : age <= AGE_DEVELOPMENT_WINDOWS.PEAK.max    ? 1
              : age <= AGE_DEVELOPMENT_WINDOWS.PRIME.max   ? 2
              : age <= AGE_DEVELOPMENT_WINDOWS.DECLINE.max ? 3 : 4;
    const before = p.ovr;
    keys.forEach((key, i) => {
      if (sr[key] === null || sr[key] === undefined) return;
      let change = CURVES[i][idx];
      let variance = _rng(-2, 2);
      if (p.trait === 'youngGun' && age < 28) change += 1;
      else if (p.trait === 'veteran' && age >= 30 && i === 0 && change < 0) change *= 0.5;
      if (p.trait === 'consistent') variance = _rng(-1, 1);
      if (p.trait === 'volatile')   variance = _rng(-4, 4);
      const delta = Math.max(-5, Math.min(4, Math.round(change + variance)));
      sr[key] = Math.max(SUB_RATING_MIN, Math.min(SUB_RATING_MAX, sr[key] + delta));
    });
    p.ovr = computeOVR(sr);
    p._ovrChange = (p.ovr || 0) - (before || 0);
    if (p.careerStats && p.ovr > (p.careerStats.peakOvr || 0)) {
      p.careerStats.peakOvr = p.ovr; p.careerStats.peakSeason = seasonNum + 1;
    }
  }
  if (p.injury || p.isInjured || p.group === PLAYER_GROUP.IL) {
    Object.assign(p, clearInjuryUpdate());
    if (p.group === PLAYER_GROUP.IL) p.group = defaultActiveGroup(p);
  }
  p.injuryPenalty = null;
}

function _retirements(draft, atMs, nextYear) {
  const events = [];
  const level  = draft.leagueTalentOffset || 0;
  const farmOf = new Set(_allTeams(draft).flatMap(t => t?.farmIds || []));
  for (const p of Object.values(draft.players || {})) {
    if (!p || p.group === PLAYER_GROUP.RETIRED || p.group === PLAYER_GROUP.DEPARTED) continue;
    const age = computeAge(p.dob, nextYear);
    const rel = (p.ovr || 50) - level;
    let retire = age >= RETIREMENT_AGE_HARD;
    if (!retire && age >= RETIREMENT_AGE_SOFT && rel < RETIREMENT_OVR_SOFT) retire = Math.random() < 0.6;
    if (!retire && farmOf.has(p.id) && age >= 28 && rel < RETIREMENT_OVR_FARM) retire = Math.random() < 0.25;
    if (!retire) continue;
    const teamId = p.teamId || null;
    _detach(draft, p.id);
    Object.assign(p, { teamId: null, group: PLAYER_GROUP.RETIRED, tier: 'retired',
                       retiredSeason: draft.seasonNum || 1, _retiredFrom: teamId });
    events.push({ type: 'RETIRED', playerId: p.id, teamId, age, atMs });
    if (teamId === 'user') {
      draft.history = [...(draft.history || []), {
        id: _uuid(), type: 'retirement', season: draft.seasonNum || 1, gameIdx: draft.currentGameIndex || 0,
        headline: `${p.name} retires`,
        detail: `${p.name} (${p.nativePos || p.pos}) retired at ${age} after ${p.careerStats?.seasons || 1} season${(p.careerStats?.seasons || 1) === 1 ? '' : 's'} (peak OVR ${p.careerStats?.peakOvr || p.ovr}).`,
        playerId: p.id, icon: '🎩', userNote: '',
      }];
    }
  }
  return events;
}

/** Section 25 win-target escalation from the season just played. */
export function nextWinTarget(draft) {
  const target = draft.userTeam._ownerWinTarget || 75;
  const diff   = (draft.userTeam.wins || 0) - target;
  const adj = diff >= 8 ? WIN_TARGET_ADJ_EXCEED_8_PLUS
    : diff >= 3 ? WIN_TARGET_ADJ_EXCEED_3_TO_7
    : diff >= -WIN_TARGET_MET_WITHIN ? WIN_TARGET_ADJ_MET
    : diff >= -4 ? WIN_TARGET_ADJ_MISS_1_TO_4
    : diff >= -9 ? WIN_TARGET_ADJ_MISS_5_TO_9
    : WIN_TARGET_ADJ_MISS_10_PLUS;
  return target + adj;
}

// ─────────────────────────────────────────────────────────────
// DAY 2 — CONTRACTS
// ─────────────────────────────────────────────────────────────

/** The user's active players whose deals are up, with their asking terms. */
export function userExpiring(draft) {
  const season = draft.seasonNum || 1;
  // A player extended during the season (§72) or told he can walk is decided.
  return (draft.userTeam.rosterIds || [])
    .map(id => draft.players[id])
    .filter(p => p && contractIsUp(p, season) && !p.pendingContract && !p._willWalk)
    .map(p => ({ player: p, terms: p._ask || marketTerms(draft, p) }));
}

/**
 * contractDay(draft, atMs)
 * CPU clubs decide on every expiring active player (re-sign / market /
 * another league); every club's farm deals roll over (minor-league reserve);
 * the user's expiring players get their asking terms (cards follow).
 */
export function contractDay(draft, atMs) {
  const events = [];
  const season = draft.seasonNum || 1;
  const level  = draft.leagueTalentOffset || 0;
  const nextYear = baseballYear(draft) + 1;

  // A player on waivers whose deal is up is simply a free agent now — no
  // club claims an expired contract, and none is outrighted with one.
  for (const id of [...(draft.waiverPool || [])]) {
    const p = draft.players[id];
    if (!p || !contractIsUp(p, season)) continue;
    events.push(releaseToFreeAgency(draft, id, atMs));
    Object.assign(p, { onWaivers: false, waiverStartTime: null, _waivedBy: null, _waiveReason: null });
  }
  for (const t of _allTeams(draft)) {
    for (const id of t?.farmIds || []) {
      const p = draft.players[id];
      if (p && contractIsUp(p, season)) applyContract(draft, id, { salary: p.contractSalary || 50, years: 1 + (Math.random() < 0.5 ? 1 : 0) });
    }
  }
  for (const t of draft.leagueTeams || []) {
    for (const id of [...(t.rosterIds || [])]) {
      const p = draft.players[id];
      if (!p || !contractIsUp(p, season)) continue;
      const rel = (p.ovr || 50) - level;
      const age = computeAge(p.dob, nextYear);
      let pr = CPU_RESIGN_ODDS.find(o => rel >= o.minRel).p;
      if (age >= 34) pr *= CPU_RESIGN_AGE_34_MULT;
      if (Math.random() < pr) {
        applyContract(draft, id, marketTerms(draft, p));
        events.push({ type: 'RESIGNED', playerId: id, teamId: t.id, atMs });
        continue;
      }
      const abroad = Math.random() < (age >= 31 ? WALK_ABROAD_PROB_31_PLUS : WALK_ABROAD_PROB_UNDER_31);
      events.push(abroad ? departLeague(draft, id, atMs, 'abroad') : releaseToFreeAgency(draft, id, atMs));
    }
  }
  // In-season decisions (§72): an extension starts now; a player we let go walks.
  for (const id of [...(draft.userTeam.rosterIds || [])]) {
    const p = draft.players[id];
    if (!p) continue;
    if (p.pendingContract && contractIsUp(p, season)) {
      applyContract(draft, id, p.pendingContract);
      p.pendingContract = null;
      events.push({ type: 'RESIGNED', playerId: id, teamId: 'user', atMs });
    } else if (p._willWalk && contractIsUp(p, season)) {
      p._willWalk = false;
      events.push(releaseToFreeAgency(draft, id, atMs));
    }
  }
  for (const { player, terms } of userExpiring(draft)) player._ask = terms;
  // Anyone else carrying an in-season decision (traded away since) starts clean.
  for (const p of Object.values(draft.players || {})) {
    if (p && (p.pendingContract || p._willWalk) && p.teamId !== 'user') { p.pendingContract = null; p._willWalk = false; }
  }
  return events.filter(Boolean);
}

/** The user re-signs his player at the asking terms. */
export function applyResign(draft, playerId) {
  const p = draft.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  applyContract(draft, playerId, p._ask || marketTerms(draft, p));
  return { type: 'RESIGNED', playerId, teamId: 'user' };
}

/** The user lets his player walk (a GM choice, or by default at spring). */
export function applyLetWalk(draft, playerId, atMs, { auto = false } = {}) {
  const p = draft.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  if (auto) draft.userTeam.morale = Math.max(0, (draft.userTeam.morale || 50) + CONTRACT_AUTO_WALK_MORALE);
  return releaseToFreeAgency(draft, playerId, atMs);
}

// ─────────────────────────────────────────────────────────────
// FREE AGENCY
// ─────────────────────────────────────────────────────────────

export function freeAgents(draft) {
  return (draft.freeAgentPool || []).map(id => draft.players[id]).filter(p => p && p.group === PLAYER_GROUP.FREE_AGENT);
}

/**
 * cpuFreeAgencyRound(draft, atMs)
 * Every CPU club with room signs at most one free agent who fits its biggest
 * need and beats what its farm offers there. Clubs act in random order.
 */
export function cpuFreeAgencyRound(draft, atMs) {
  const events = [];
  const order = _shuffle([...(draft.leagueTeams || [])]);
  for (const t of order) {
    if (activeCount(draft, t.id) >= ROSTER_LIMITS.ACTIVE_TOTAL) {
      // A full club still upgrades: the best free agent who beats its weakest
      // same-side reserve by FA_UPGRADE_MIN sends that man to the farm.
      for (const fa of freeAgents(draft).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))) {
        const out = displacementFor(draft, t.id, fa);
        if (out && (fa.ovr || 0) >= (out.ovr || 0) + FA_UPGRADE_MIN) {
          events.push(...(signFreeAgent(draft, fa.id, t.id, atMs, { displaceId: out.id }) || []));
          break;
        }
      }
      continue;
    }
    const need = teamNeed(draft, t.id);
    if (!need) continue;
    const byOvr = (a, b) => (b.ovr || 0) - (a.ovr || 0);
    const best = freeAgents(draft).filter(p => _fits(p, need)).sort(byOvr)[0]
      || freeAgents(draft).filter(p => _fits(p, { side: need.side, pos: null })).sort(byOvr)[0];
    if (!best) continue;
    const farmBest = (t.farmIds || []).map(id => draft.players[id])
      .filter(p => p && !p.isInjured && _fits(p, need))
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    if (farmBest && (farmBest.ovr || 0) >= (best.ovr || 0)) continue;
    events.push(...(signFreeAgent(draft, best.id, t.id, atMs) || []));
  }
  return events;
}

/**
 * userFreeAgentTargets(draft, max, excludeIds)
 * Free agents worth the GM's attention: someone who fills an open spot, or
 * a clear upgrade (≥ FA_UPGRADE_MIN OVR) over the man he would replace.
 * @returns {{ player, replaces: Object|null, reason: String }[]}
 */
export function userFreeAgentTargets(draft, max, excludeIds = new Set()) {
  const out = [];
  const u = draft.userTeam;
  const need = teamNeed(draft, 'user');
  const full = activeCount(draft, 'user') >= ROSTER_LIMITS.ACTIVE_TOTAL;
  const starterAt = (slot) => (u.lineupSlots || []).filter(s => s.slot === slot && s.playerId)
    .map(s => draft.players[s.playerId]).filter(Boolean).sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
  for (const p of freeAgents(draft).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))) {
    if (out.length >= max) break;
    if (excludeIds.has(p.id)) continue;
    if (!full && need && _fits(p, need)) {
      out.push({ player: p, replaces: null, reason: need.pos ? `fills our open ${need.pos} spot` : `fills an open ${need.side === 'pitcher' ? 'pitching' : 'bench'} spot` });
      continue;
    }
    let target = null;
    if (isPitcher(p)) {
      const group = p.pos === 'SP' ? PLAYER_GROUP.STARTING_PITCHERS : PLAYER_GROUP.BULLPEN;
      target = (u.rosterIds || []).map(id => draft.players[id]).filter(x => x && x.group === group)
        .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
    } else {
      target = eligibleSlotsFor(p).filter(s => s !== 'DH').map(starterAt).filter(Boolean)
        .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
    }
    if (target && (p.ovr || 0) >= (target.ovr || 0) + FA_UPGRADE_MIN) {
      out.push({ player: p, replaces: target, reason: `an upgrade on ${target.name} (OVR ${target.ovr})` });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// OWNERSHIP & MANAGER (hard gates)
// ─────────────────────────────────────────────────────────────

/** Next season's financial offer from ownership. */
export function ownershipOffer(draft) {
  const u = draft.userTeam;
  const last = (draft.seasonHistory || [])[draft.seasonHistory.length - 1] || {};
  const target = last.winTarget || u._ownerWinTarget || 75;
  const perf = (last.wins ?? u.wins ?? 0) - target;
  const roundsWon = ({ 'Champions': 4, 'Lost in the World Series': 3, 'Lost in the Division Series': 2, 'Lost in the First Round': 1 })[last.postseason?.result] || 0;
  let pct = Math.max(-OWNERSHIP_OFFER.maxSwing, Math.min(OWNERSHIP_OFFER.maxSwing, perf * OWNERSHIP_OFFER.perWin));
  if (last.champion?.id === 'user') pct += OWNERSHIP_OFFER.champion;
  pct += roundsWon * OWNERSHIP_OFFER.perRound;
  const cap = u.finances?.payrollCap || 8000;
  const ob  = u.finances?.operatingBudget || 500;
  return {
    pct,
    payrollCap:      Math.round(cap * (1 + pct) / 10) * 10,
    operatingBudget: Math.round(ob * (1 + pct) / 5) * 5,
    prevPayrollCap:  cap,
    prevOperatingBudget: ob,
    winTarget:       u._ownerWinTarget,
  };
}

/** mode: 'accept' | 'push' | 'auto' */
export function applyOwnership(draft, offer, mode) {
  const u = draft.userTeam;
  const mult = mode === 'push' ? 1 + OWNERSHIP_OFFER.pushExtra : mode === 'auto' ? 1 + OWNERSHIP_OFFER.autoCut : 1;
  const cap = Math.round(offer.payrollCap * mult / 10) * 10;
  const ob  = Math.round(offer.operatingBudget * mult / 5) * 5;
  u.finances.payrollCap = cap;
  u.finances.operatingBudget = ob;
  u.finances.payrollCapHistory = [...(u.finances.payrollCapHistory || []), { seasonNum: (draft.seasonNum || 1) + 1, payrollCap: cap }];
  const trust = mode === 'push' ? OWNERSHIP_OFFER.pushTrust : mode === 'auto' ? OWNERSHIP_OFFER.autoTrust : 0;
  if (trust) u.ownerTrust = Math.max(0, Math.min(100, (u.ownerTrust || 50) + trust));
  return { payrollCap: cap, operatingBudget: ob, trust };
}

export function managerContractIsUp(draft) {
  const m = draft.userTeam?.coachingStaff?.manager;
  return !!m && (m.contractExpiry ?? 99) <= (draft.seasonNum || 1) + 1;
}

/** mode: 'extend' | 'replace' | 'auto' */
export function applyManagerDecision(draft, mode) {
  const u = draft.userTeam;
  const m = u.coachingStaff.manager;
  const start = (draft.seasonNum || 1) + 1;
  if (mode === 'extend') {
    m.contractExpiry = start + MANAGER_EXTENSION_YEARS;
    m.salary = Math.round((m.salary || 225) * 1.05 / 5) * 5;
    u.managerConfidence = Math.min(100, (u.managerConfidence || 60) + 5);
    return { name: m.name };
  }
  if (mode === 'replace') {
    const taken = new Set(Object.values(u.coachingStaff).map(s => s?.name).concat(u.ownerName));
    const name = _shuffle(STAFF_NAMES.filter(n => !taken.has(n)))[0] || 'New Manager';
    const prev = m.name;
    Object.assign(m, { name, contractExpiry: start + MANAGER_EXTENSION_YEARS, relationship: 50, managerConfidence: 55 });
    u.managerConfidence = 55;
    u.morale = Math.max(0, (u.morale || 50) - 3);
    return { name, prev };
  }
  m.contractExpiry = start + 1;
  u.managerConfidence = Math.max(0, (u.managerConfidence || 60) + MANAGER_AUTO_CONFIDENCE);
  return { name: m.name };
}

/** Coaches whose deals are up are kept on (soft gate, §23.2): two more years. */
function _renewCoaches(draft) {
  const start = (draft.seasonNum || 1) + 1;
  for (const [role, c] of Object.entries(draft.userTeam?.coachingStaff || {})) {
    if (role === 'manager' || !c) continue;
    if ((c.contractExpiry ?? 99) <= start) c.contractExpiry = start + 2;
  }
}

/**
 * hardGates(state)
 * §23.2: spring cannot begin with these open — they auto-resolve at spring.
 * Read from the GM's unresolved offseason cards (`_osGate`).
 * @returns {{ ownership: Boolean, contracts: Boolean, manager: Boolean, open: String[] }}  true = cleared
 */
export function hardGates(state) {
  const cards = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])];
  const open = (g) => cards.some(c => c._osGate === g);
  const gates = { ownership: !open('ownership'), contracts: !open('contracts'), manager: !open('manager') };
  return { ...gates, open: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k) };
}

// ─────────────────────────────────────────────────────────────
// SPRING — THE NEW SEASON
// ─────────────────────────────────────────────────────────────

/**
 * openNewSeason(draft, atMs)
 * Day 7, after required decisions have auto-resolved: unsigned free agents
 * leave the league, coaches are kept on, amateur prospects join every farm,
 * payroll is recomputed and every record starts over in season N+1.
 * (The calendar and the phase change belong to GameEngine.)
 */
export function openNewSeason(draft, atMs) {
  const events = [];
  for (const p of freeAgents(draft)) events.push(departLeague(draft, p.id, atMs, 'unsigned'));
  _renewCoaches(draft);
  for (const t of _allTeams(draft)) events.push(..._signProspects(draft, t, atMs));

  // Anyone who joined a club after contract day (a waiver claim, a late
  // outright) with his deal up signs on for a year at market — the club
  // brought him in; nobody opens a season without a contract.
  for (const t of _allTeams(draft)) {
    for (const id of [...(t?.rosterIds || []), ...(t?.farmIds || [])]) {
      const p = draft.players[id];
      if (p && contractIsUp(p, draft.seasonNum || 1)) {
        applyContract(draft, id, { ...marketTerms(draft, p), years: 1 });
        events.push({ type: 'RESIGNED', playerId: id, teamId: t.id || 'user', atMs, late: true });
      }
    }
  }

  draft.seasonNum = (draft.seasonNum || 1) + 1;
  for (const t of _allTeams(draft)) {
    Object.assign(t, { wins: 0, losses: 0, ties: 0, streak: 0,
                       springWins: 0, springLosses: 0, springTies: 0,
                       postseasonWins: 0, postseasonLosses: 0 });
    if (t.rotation) t.rotation.currentIndex = 0;
  }
  const u = draft.userTeam;
  u.vacancyDeadlineAt = null;
  u._hostedAllStarThisSeason = false;
  u.finances.payroll = computePayroll(draft);
  u.finances.operatingSpent = 0;
  u.finances.revenueHistory = [...(u.finances.revenueHistory || []), { seasonNum: draft.seasonNum - 1, revenue: u.finances.revenue || 0 }];
  u.finances.revenue = 0;
  draft.currentGameIndex = 0;
  draft.standings      = null;
  draft.playoffBracket = null;
  draft.metricHistory  = [];
  draft.offseason      = null;
  for (const p of Object.values(draft.players || {})) {
    if (!p) continue;
    p._isKeeper = false;
    p._isSpringInvitee = false;
    p._ovrChange = undefined;
  }
  return events.filter(Boolean);
}

function _signProspects(draft, team, atMs) {
  const events = [];
  const level = draft.leagueTalentOffset || 0;
  const n = PROSPECTS_PER_TEAM_MIN + Math.floor(Math.random() * (PROSPECTS_PER_TEAM_MAX - PROSPECTS_PER_TEAM_MIN + 1));
  const used = new Set(Object.values(draft.players).map(p => p?.name));
  const HITTER_POS = ['C', 'SS', '2B', '3B', '1B', 'OF', 'OF', 'OF'];
  for (let i = 0; i < n; i++) {
    const farm = (team.farmIds || []).map(id => draft.players[id]).filter(Boolean);
    const hitters = farm.filter(p => !isPitcher(p)).length;
    const pitchers = farm.length - hitters;
    const wantPitcher = pitchers / ROSTER_LIMITS.FARM_PITCHER_MAX < hitters / ROSTER_LIMITS.FARM_HITTER_MAX;
    const pos = wantPitcher ? (Math.random() < 0.5 ? 'SP' : 'RP') : HITTER_POS[Math.floor(Math.random() * HITTER_POS.length)];
    const name = _newName(used);
    if (!name) break;
    used.add(name);
    const p = createPlayer({
      id: _uuid(), name, pos, group: PLAYER_GROUP.PRACTICE_SQUAD,
      hand: wantPitcher ? (Math.random() < 0.28 ? 'L' : 'R') : null,
      targetOvr: level + PROSPECT_OVR_MIN + Math.floor(Math.random() * (PROSPECT_OVR_MAX - PROSPECT_OVR_MIN + 1)),
      ageMin: PROSPECT_AGE_MIN, ageMax: PROSPECT_AGE_MAX,
      seasonNum: (draft.seasonNum || 1) + 1, seasonYear: baseballYear(draft) + 1,
      contractLengthOverride: 4, teamId: team.id, leagueLevel: level,
    });
    p.tier = 'farm';
    p._amateurSigning = (draft.seasonNum || 1) + 1;
    draft.players[p.id] = p;
    team.farmIds = [...(team.farmIds || []), p.id];
    events.push({ type: 'PROSPECT_SIGNED', playerId: p.id, teamId: team.id, atMs });
  }
  events.push(..._enforceFarmCaps(draft, team, atMs));
  return events.filter(Boolean);
}

/**
 * Farm composition caps (§20.3), per side: while a side is over its cap the
 * player with the least future — lowest OVR for his age — is released (he
 * leaves the league). New amateur signings are never the ones let go.
 */
function _enforceFarmCaps(draft, team, atMs) {
  const events = [];
  const level = draft.leagueTalentOffset || 0;
  const nextYear = baseballYear(draft) + 1;
  const future = (x) => (x.ovr || 0) - level - computeAge(x.dob, nextYear);
  for (const pitchers of [false, true]) {
    const cap = pitchers ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX;
    for (let guard = 0; guard < 40; guard++) {
      const side = (team.farmIds || []).map(id => draft.players[id]).filter(x => x && isPitcher(x) === pitchers);
      if (side.length <= cap) break;
      const cut = side.filter(x => x._amateurSigning !== (draft.seasonNum || 1) + 1).sort((a, b) => future(a) - future(b))[0]
        || side.sort((a, b) => future(a) - future(b))[0];
      events.push(departLeague(draft, cut.id, atMs, 'released'));
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _newName(used) {
  const first = () => PLAYER_NAME_POOL[Math.floor(Math.random() * PLAYER_NAME_POOL.length)].split(' ')[0];
  const last  = () => PLAYER_NAME_POOL[Math.floor(Math.random() * PLAYER_NAME_POOL.length)].split(' ').slice(-1)[0];
  for (let i = 0; i < 300; i++) {
    const n = `${first()} ${last()}`;
    if (!used.has(n)) return n;
  }
  return null;
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _uuid() {
  return crypto.randomUUID();
}

export { OFF_ROSTER };
