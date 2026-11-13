/**
 * engine/OffseasonEngine.js
 * The offseason on the league calendar (§70; structure §23, sequence §13.2).
 *
 *   World Series final ─ SEASON_SUMMARY
 *   day 1 00:00  OFFSEASON: record locked, stats archived, every player ages a
 *                year and develops/declines, retirements; the season review
 *                (SeasonReview); ownership's evaluation; the winter's priority
 *   day 2        the staff: the manager's contract; each coach's evaluation
 *                (CoachEngine — renew or let go a coach whose deal is up;
 *                keep or fire one whose side of the game struggled)
 *   day 3        hiring: two candidates for every empty chair (a coach let
 *                go later gets candidates a few hours after)
 *   day 4 10:00  contracts: CPU clubs re-sign or let go; farm deals renewed;
 *                the user's re-sign cards
 *   day 5        free agency opens (CPU clubs sign to fill needs; FA cards)
 *   day 6–7      the winter meetings (§112 E); free agency
 *   day 8        free agency, second wave of cards
 *   day 9        the front office (§112 D); reminder for required decisions
 *   day 10       spring eve
 *   day 11 00:00 required decisions auto-resolve conservatively; unsigned free
 *                agents leave the league; amateur prospects join every farm;
 *                season N+1 begins with spring training
 *
 * Pure: never imports StateManager. Every function takes the draft state the
 * caller is mutating (inside StateManager.mutate) and returns events / data.
 * GameEngine runs the steps on the clock; CardEngine delivers and resolves the
 * GM's cards through the apply* functions here.
 */

import { dice, diceId, diceSeed, eventRand, inEvent } from './Dice.js';
import {
  PLAYER_GROUP,
  ROSTER_LIMITS,
  SALARY_BY_OVR,
  SUB_RATING_MIN,
  SUB_RATING_MAX,
  AGE_DEVELOPMENT_WINDOWS,
  AGE_CURVES,
  FA_CLASS_INTL_AGE,
  DIAMOND,
  RETIREMENT_AGE_HARD,
  RETIREMENT_AGE_SOFT,
  RETIREMENT_OVR_SOFT,
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
  FA_POOL_MAX,
  FA_TRIM_SCOUTED_KEEP_MS,
  PROSPECT_AGE_MIN,
  PROSPECT_AGE_MAX,
  PROSPECT_OVR_MIN,
  PROSPECT_OVR_MAX,
  OWNERSHIP_OFFER,
  CONTRACT_AUTO_WALK_MORALE,
  MANAGER_EXTENSION_YEARS,
  MANAGER_AUTO_CONFIDENCE,
  FA_UPGRADE_MIN,
  DEV_REPS,
} from '../data/constants.js';

import { computeAge, computeOVR, createPlayer, baseballYear, _freshStats } from './PlayerFactory.js';
import { originForKind } from './LeagueHistory.js';
import { giveUntestedGap, seedUpside, markAvailable, cpuView } from './Diamonds.js';
import { clearInjuryUpdate } from './InjuryEngine.js';
import {
  defaultActiveGroup,
  eligibleSlotsFor,
  pendingArrivals,
  computePayroll,
  HITTER_TARGET,
  PITCHER_TARGET,
} from './RosterEngine.js';
import { STAFF_NAMES, PLAYER_SURNAMES } from '../data/player-names.js';
import { uniqueName, namesInUse, surnameOf } from './Names.js';
import * as AllStar from './AllStarEngine.js';
import * as Finance from './FinanceEngine.js';
import * as Coach from './CoachEngine.js';
import { trainingWinterBonus } from './FrontOffice.js';
import { fillsNeed } from './LeagueTrades.js';
import { clockNow } from './Clock.js';
import { fillShortRosters } from './TransactionEngine.js';
import { primaryPos, posLabel, seasonTurn } from './Positions.js';   // r163 §122.35

export const OFFSEASON_STEPS = Object.freeze([...Array.from({ length: OFFSEASON_DAYS }, (_, i) => `day${i + 1}`), 'spring']);

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
    dayStarts: dayStarts.slice(0, OFFSEASON_DAYS),   // [day1 … day10] midnights
    springAt:  dayStarts[OFFSEASON_DAYS],            // day 11 midnight
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

/** Midnight that starts offseason day `n` (1–10), or spring (11). */
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

/** The offseason day (1–10) at `nowMs`, or 0 before day 1 / outside the offseason. */
export function offseasonDay(state, nowMs = clockNow()) {
  const os = state?.offseason;
  if (!os) return 0;
  let day = 0;
  os.dayStarts.forEach((t, i) => { if (nowMs >= t) day = i + 1; });
  return day;
}

export const DAY_FOCUS = Object.freeze({
  0:  { label: 'Season Complete',    sub: 'The offseason opens at midnight.' },
  1:  { label: 'Season Review',      sub: 'The record is in the books. Ownership weighs in; the winter\'s priority is set.' },
  2:  { label: 'The Staff',          sub: 'The manager\'s future, and how each coach\'s side of the game went.' },
  3:  { label: 'Hiring',             sub: 'Candidates for any opening on the staff.' },
  4:  { label: 'Contract Decisions', sub: 'Expiring deals: re-sign or let them walk.' },
  5:  { label: 'Free Agency Opens',  sub: 'The market opens. Clubs start filling holes.' },
  6:  { label: 'Winter Meetings',    sub: 'Every club in one hotel: trade talk, and Pro Scouting\'s targets for your priority.' },
  7:  { label: 'Winter Meetings',    sub: 'The last day of the meetings. The phones keep ringing.' },
  8:  { label: 'Free Agency',        sub: 'A second wave. The best names are going fast.' },
  9:  { label: 'Front Office',       sub: 'Next season\'s plans. Anything required still open is decided for you after tomorrow.' },
  10: { label: 'Spring Eve',         sub: 'Spring training opens at midnight.' },
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

/** Remove a player from every list his club keeps (roster, lineup, rotation, queues). */
function _detach(draft, playerId) {
  for (const t of _allTeams(draft)) {
    if (!t) continue;
    t.rosterIds = (t.rosterIds || []).filter(id => id !== playerId);
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

/**
 * hasRoomFor(draft, teamId, player) — an open active spot on the player's
 * side (§76: a spot belongs to its side — 14 hitters, 14 pitchers of the 28).
 */
export function hasRoomFor(draft, teamId, player) {
  if (activeCount(draft, teamId) >= ROSTER_LIMITS.ACTIVE_TOTAL) return false;
  const c = _sideCounts(draft, teamId);
  return isPitcher(player) ? c.pitcher < PITCHER_TARGET : c.hitter < HITTER_TARGET;
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
/** r147 how much more an agent who was turned down asks of us (×). */
export const AGENT_GRUDGE_MARKUP = 1.1;

export function marketTerms(draft, player) {
  const age = computeAge(player.dob, baseballYear(draft) + 1);
  const rel = (player.ovr || 50) - (draft.leagueTalentOffset || 0);
  const ageFactor = age >= 34 ? 0.7 : age >= 32 ? 0.85 : 1;
  // r147 an agent who was turned down (a bonus refused) asks us for more at the next negotiation.
  const grudge = player._agentGrudge && player.teamId === 'user' ? AGENT_GRUDGE_MARKUP : 1;
  const salary = Math.max(20, Math.round(_salaryFor(player.ovr || 50) * ageFactor * grudge / 5) * 5);
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
  delete p._agentGrudge;   // r147 a new deal settles it
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
    lineupSlot: null,
  });
  markAvailable(p, atMs, dice(diceSeed(draft), 'available', playerId, atMs), draft.leagueTalentOffset || 0);   // §122.9
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
 * `displaceId` (same side, not a starter) is let go (§122: between seasons,
 * straight to free agency).
 */
export function signFreeAgent(draft, playerId, teamId, atMs, { displaceId = null } = {}) {
  const p = draft.players[playerId];
  const t = _team(draft, teamId);
  if (!p || !t || p.group !== PLAYER_GROUP.FREE_AGENT) return null;
  const events = [];
  if (displaceId && !hasRoomFor(draft, teamId, p)) {   // no spot on his side (§76)
    const d = draft.players[displaceId];
    if (d && (t.rosterIds || []).includes(displaceId)) {
      events.push(releaseToFreeAgency(draft, displaceId, atMs, { reason: 'released' }));
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
  if (!t || hasRoomFor(draft, teamId, player)) return null;
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
  if (draft.allStar) AllStar.closeSeason(draft);   // §75: the season's hosting impression + record
  if (draft.userTeam?.finances) Finance.seasonEndReview(draft, atMs, 'user');   // §78: the books close; funds carry over
  // §78.5 every CPU club's books close too; its owner sets next year's target.
  for (const t of draft.leagueTeams || []) {
    if (!t.finances) continue;
    Finance.seasonEndReview(draft, atMs, t.id);
    Finance.cpuNextTarget(draft, t.id);
  }
  _lockSeason(draft, atMs);
  const reps = _playingTime(draft);   // r162 §122.34 (before the season's lines are archived)
  _archiveStats(draft);
  const nextYear = baseballYear(draft) + 1;
  for (const p of Object.values(draft.players || {})) {
    if (!p || p.group === PLAYER_GROUP.RETIRED || p.group === PLAYER_GROUP.DEPARTED) continue;
    _develop(p, nextYear, draft.seasonNum || 1, p.teamId === 'user' ? draft.userTeam?.coachingStaff : null,
             p.teamId === 'user' ? trainingWinterBonus(draft.userTeam) : 0, reps[p.id]);
  }
  // r164 §122.35 the season turn for positions: kept with enough starts there, lost without; the
  // primary is where he started most. Ours become the Bench Coach's notice.
  const posTurn = [];
  for (const p of Object.values(draft.players || {})) {
    if (!p || p.group === PLAYER_GROUP.RETIRED || p.group === PLAYER_GROUP.DEPARTED) continue;
    const ch = seasonTurn(p);
    if (ch && p.teamId === 'user') posTurn.push({ playerId: p.id, ...ch });
  }
  draft.ilReturnQueue = [];
  draft.impScores = {};
  draft.userTeam._ownerWinTarget = nextWinTarget(draft);
  const out = _retirements(draft, atMs, nextYear);
  if (posTurn.length) out.push({ type: 'POSITIONS_TURN', teamId: 'user', changes: posTurn, atMs });
  return out;
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
 * _develop(player, nextYear, seasonNum, staff, facility)
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
const CURVES = AGE_CURVES;
/**
 * r162 §122.34 how much each player played this season, as a share of the club's games (a hitter's
 * games played — for a starter, nearly all starts) — for a young player's winter.
 */
function _playingTime(draft) {
  const clubGames = {};
  for (const t of [draft.userTeam, ...(draft.leagueTeams || [])]) {
    if (!t) continue;
    clubGames[t === draft.userTeam ? 'user' : t.id] = (t.wins || 0) + (t.losses || 0) + (t.ties || 0);
  }
  const out = {};
  for (const p of Object.values(draft.players || {})) {
    const n = clubGames[p?.teamId];
    if (!n) continue;
    out[p.id] = (p.stats?.g || 0) / n;   // (a starter's games are nearly all starts)
  }
  return out;
}

/** r162 one player's winter (exported for the checks). */
export function developForWinter(p, nextYear, seasonNum, staff = null, facility = 0, played = null) { return _develop(p, nextYear, seasonNum, staff, facility, played); }

function _develop(p, nextYear, seasonNum, staff = null, facility = 0, played = null) {
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
      if (staff) change += Coach.winterBonus(staff, p, key, age);   // §112.2 our coaches' winter work
      change += facility;                                          // §112.4 the training center
      // r162 §122.34 a young player grows in games: a regular more, one who sat less.
      if (idx === 0 && played != null) {
        const role = p.pos === 'SP' ? 'SP' : p.pos === 'RP' ? 'RP' : 'hitter';
        if (played >= DEV_REPS.regular[role]) change += DEV_REPS.regularBonus;
        else if (played < DEV_REPS.sat[role]) change -= DEV_REPS.satPenalty;
      }
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
  for (const p of Object.values(draft.players || {})) {
    if (!p || p.group === PLAYER_GROUP.RETIRED || p.group === PLAYER_GROUP.DEPARTED) continue;
    const age = computeAge(p.dob, nextYear);
    const rel = (p.ovr || 50) - level;
    let retire = age >= RETIREMENT_AGE_HARD;
    if (!retire && age >= RETIREMENT_AGE_SOFT && rel < RETIREMENT_OVR_SOFT) retire = eventRand() < 0.6;
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
        detail: `${p.name} (${posLabel(p)}) retired at ${age} after ${p.careerStats?.seasons || 1} season${(p.careerStats?.seasons || 1) === 1 ? '' : 's'} (peak OVR ${p.careerStats?.peakOvr || p.ovr}).`,
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
  for (const t of draft.leagueTeams || []) {
    for (const id of [...(t.rosterIds || [])]) {
      const p = draft.players[id];
      if (!p || !contractIsUp(p, season)) continue;
      const rel = (p.ovr || 50) - level;
      const age = computeAge(p.dob, nextYear);
      let pr = CPU_RESIGN_ODDS.find(o => rel >= o.minRel).p;
      if (age >= 34) pr *= CPU_RESIGN_AGE_34_MULT;
      // §78.5 his owner has to be able to carry the new deal (his old one comes off).
      const terms = marketTerms(draft, p);
      if (eventRand() < pr && Finance.canAddSalary(draft, terms.salary, p.contractSalary || 0, t.id)) {
        applyContract(draft, id, terms);
        events.push({ type: 'RESIGNED', playerId: id, teamId: t.id, atMs });
        continue;
      }
      const abroad = eventRand() < (age >= 31 ? WALK_ABROAD_PROB_31_PLUS : WALK_ABROAD_PROB_UNDER_31);
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
// §112.3 CONTRACT DAY, FOR THE GM — what each decision rests on;
// extensions for the young core; releases of the overpaid
// ─────────────────────────────────────────────────────────────

const _OFS = new Set(['LF', 'CF', 'RF', 'OF']);
const _samePos = (a, b) => (isPitcher(a) ? a.pos === b.pos : (a.pos === b.pos || (_OFS.has(a.pos) && _OFS.has(b.pos))));
const _f3 = (x) => x.toFixed(3).replace(/^0/, '');

/** His line for the season just finished (archived on day 1), in words. */
export function seasonLineWords(p, season) {
  const s = (p?.seasonLog || []).filter(x => x.season === season && x.stats).pop()?.stats;
  if (!s || !(s.g > 0)) return null;
  if (isPitcher(p)) {
    if (!(s.ip >= 5)) return null;   // too little to say anything
    const era = 9 * (s.er || 0) / s.ip;
    return `${era.toFixed(2)} ERA in ${Math.round(s.ip)} innings${s.gs ? ` (${s.gs} starts)` : ''}${s.sv ? `, ${s.sv} saves` : ''}`;
  }
  if (!(s.ab >= 15)) return null;
  const pa = s.ab + (s.bb || 0) + (s.hbp || 0);
  const obp = pa ? ((s.h || 0) + (s.bb || 0) + (s.hbp || 0)) / pa : 0;
  return `${_f3((s.h || 0) / s.ab)}/${_f3(obp)}/${_f3((s.tb || 0) / s.ab)}, ${s.hr || 0} HR in ${s.g} game${s.g === 1 ? '' : 's'}`;
}

/**
 * His role on our club, in words: how he was used last season (the club's
 * lineups and staff are rebuilt over the winter, so his slot today says less).
 */
export function roleWords(draft, p) {
  const season = draft.seasonNum || 1;
  const s = (p.seasonLog || []).filter(x => x.season === season && x.teamId === 'user').pop()?.stats || {};
  const u = draft.userTeam;
  if (isPitcher(p)) {
    if ((s.gs || 0) >= 10) return 'a starter in our rotation';
    if ((s.g || 0) >= 15) return (s.sv || 0) >= 10 ? 'our closer' : 'a reliever';
  } else {
    const pp = primaryPos(p);   // r163 Positions
    if ((s.ab || 0) >= 300) return `an everyday ${pp === 'DH' ? 'designated hitter' : pp}`;
    if ((s.ab || 0) >= 120) return `a part-time ${pp === 'DH' ? 'designated hitter' : pp}`;
  }
  if ((s.g || 0) > 0) return isPitcher(p) ? 'a spare arm' : 'a bench player';
  return isPitcher(p) ? 'an arm we barely used' : 'a bench player who barely played';
}

/**
 * What a contract decision about `p` rests on: his season, his role, his age
 * next year, who on our club would take his place, and who's on the market
 * at his position now (contract day has just sent the league's unsigned there).
 */
export function contractContext(draft, p) {
  const season = draft.seasonNum || 1;
  const u = draft.userTeam;
  const mine = (u.rosterIds || []).map(id => draft.players[id])
    .filter(x => x && x.id !== p.id && _samePos(x, p) && !OFF_ROSTER.has(x.group));
  const internal = mine.sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
  const market = freeAgents(draft).filter(x => _samePos(x, p) && (x.ovr || 0) >= (p.ovr || 0) - 2)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  const R = draft.offseason?.review;
  return {
    line: seasonLineWords(p, season),
    role: roleWords(draft, p),
    age: computeAge(p.dob, baseballYear(draft) + 1),
    internal: internal ? { id: internal.id, name: internal.name, ovr: internal.ovr } : null,
    market: market.slice(0, 3).map(x => ({ id: x.id, name: x.name, ovr: x.ovr, ask: (x._ask || marketTerms(draft, x)).salary })),
    marketN: market.length,
    star: !!R?.stars?.some(x => x.id === p.id),
    letdown: !!R?.letdowns?.some(x => x.id === p.id),
    core: !!R?.core?.includes(p.id),
  };
}

/**
 * Young core players worth locking up before they get expensive: 27 or
 * younger next season, under contract next season (not expiring — those get a
 * re-sign card), clearly better than the club's median. The terms buy out his
 * next years at a discount on today's market (security for him), and look
 * ahead to what he'd cost if he keeps growing.
 */
export function extensionCandidates(draft, max = 2) {
  const season = draft.seasonNum || 1;
  const u = draft.userTeam;
  const year = baseballYear(draft) + 1;
  const ids = (u.rosterIds || []).filter(id => draft.players[id]);
  const ovrs = ids.map(id => draft.players[id].ovr || 0).sort((a, b) => a - b);
  const median = ovrs[Math.floor(ovrs.length / 2)] || 60;
  return ids.map(id => draft.players[id])
    .filter(p => !contractIsUp(p, season) && !p.pendingContract && !p._extendedSeason
      && computeAge(p.dob, year) <= 27 && (p.ovr || 0) >= median + 4)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).slice(0, max)
    .map(p => {
      const age = computeAge(p.dob, year);
      const now = marketTerms(draft, p).salary;
      const future = Math.round(_salaryFor((p.ovr || 50) + (age <= 24 ? 6 : 4)) / 5) * 5;
      const years = age <= 24 ? 5 : 4;
      const salary = Math.max(p.contractSalary || 0, Math.round(now * 0.92 / 5) * 5);
      return { player: p, terms: { salary, years }, future, left: yearsLeft(p, season) - 2 };   // seasons after next
    });
}

/** Extend him: the new deal replaces his current one from next season. */
export function applyExtension(draft, playerId, terms) {
  const p = draft.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  applyContract(draft, playerId, terms);
  p._extendedSeason = draft.seasonNum || 1;
  p.gmRelationship = Math.min(100, (p.gmRelationship ?? 50) + 8);
  return { type: 'EXTENDED', playerId, teamId: 'user', terms };
}

/**
 * Overpaid players under contract next season: paid at least 1.35× (and
 * $200K) more than the market would pay him now, after a poor season or the
 * winter's decline. Releasing him opens the spot; the money is still owed
 * (dead money, season by season — minus what a new club pays him).
 */
export function releaseCandidates(draft, max = 2) {
  const season = draft.seasonNum || 1;
  const u = draft.userTeam;
  return (u.rosterIds || []).map(id => draft.players[id])
    .filter(p => p && !contractIsUp(p, season) && !p.pendingContract && (p.contractSalary || 0) > 0)
    .map(p => {
      const market = marketTerms(draft, p).salary;
      const seasonsLeft = yearsLeft(p, season) - 1;
      const owed = (p.contractSalary || 0) * seasonsLeft;
      const line = (p.seasonLog || []).filter(x => x.season === season).pop()?.stats || {};
      const pa = (line.ab || 0) + (line.bb || 0) + (line.hbp || 0);
      const ops = pa && line.ab ? ((line.h || 0) + (line.bb || 0) + (line.hbp || 0)) / pa + (line.tb || 0) / line.ab : null;
      const era = line.ip > 0 ? 9 * (line.er || 0) / line.ip : null;
      const poor = isPitcher(p) ? (era != null && line.ip >= 30 && era > 5.0) : (ops != null && line.ab >= 120 && ops < 0.650);
      const slipped = (p._ovrChange || 0) <= -2;
      return { player: p, market, seasonsLeft, owed, poor, slipped, over: (p.contractSalary || 0) - market };
    })
    .filter(x => x.seasonsLeft >= 1 && (x.poor || x.slipped) && x.player.contractSalary >= 1.35 * x.market && x.over >= 200)
    .sort((a, b) => b.over - a.over).slice(0, max);
}

/** Release him: §122 his deal ends and he's a free agent — nothing more is owed. */
export function applyRelease(draft, playerId, atMs) {
  const p = draft.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  return releaseToFreeAgency(draft, playerId, atMs, { reason: 'released' });
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
  // §112.6 a club well short of a full roster signs more than one a day: what
  // it's missing, spread over the free-agency days left (days 5–10).
  const day = offseasonDay(draft, atMs) || 5;
  const roundsLeft = Math.max(1, OFFSEASON_DAYS - Math.max(5, day) + 1);
  for (const t of order) {
    const short = ROSTER_LIMITS.ACTIVE_TOTAL - activeCount(draft, t.id);
    const signings = short > 0 ? Math.min(4, Math.ceil(short / roundsLeft)) : 1;
    for (let k = 0; k < signings; k++) {
      const ev = _cpuSignOne(draft, t, atMs);
      if (!ev.length) break;
      events.push(...ev);
    }
  }
  return events;
}

/** One free-agent signing for a CPU club: its biggest need, or an upgrade when it's full. */
function _cpuSignOne(draft, t, atMs) {
  const events = [];
  {
    // §78.5 only the free agents this club's owner can pay for.
    const pool = freeAgents(draft).filter(fa =>
      Finance.canAddSalary(draft, (fa._ask || marketTerms(draft, fa)).salary, 0, t.id));
    if (activeCount(draft, t.id) >= ROSTER_LIMITS.ACTIVE_TOTAL) {
      // A full club still upgrades: the best free agent who beats its weakest
      // same-side reserve by FA_UPGRADE_MIN sends that man to the farm.
      // §122.9 a CPU club sees a free agent's rating — his worth, once word has got around.
      const seen = (p) => cpuView(p, atMs);
      for (const fa of [...pool].sort((a, b) => seen(b) - seen(a))) {
        const out = displacementFor(draft, t.id, fa);
        if (out && seen(fa) >= (out.ovr || 0) + FA_UPGRADE_MIN) {
          events.push(...(signFreeAgent(draft, fa.id, t.id, atMs, { displaceId: out.id }) || []));
          break;
        }
      }
      return events;
    }
    const need = teamNeed(draft, t.id);
    if (!need) return events;
    const byOvr = (a, b) => cpuView(b, atMs) - cpuView(a, atMs);
    const best = pool.filter(p => _fits(p, need)).sort(byOvr)[0]
      || pool.filter(p => _fits(p, { side: need.side, pos: null })).sort(byOvr)[0];
    if (!best) return events;
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
  // §112 the winter's priority first: the free agents who fill it, then the rest.
  const pri = draft.offseason?.priority || null;
  const hits = (p) => (pri ? fillsNeed(p, pri) : false);
  for (const p of freeAgents(draft).sort((a, b) => (hits(b) - hits(a)) || ((b.ovr || 0) - (a.ovr || 0)))) {
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
      out.push({ player: p, replaces: target, reason: `an upgrade on ${target.name} (OVR ${target.ovr})${hits(p) ? ' — and the winter\'s priority' : ''}` });
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
  // §78: the books count too — the season's profit or loss, and any cut
  // order the owner gave that wasn't met.
  const books = Finance.booksOfferAdjustment(draft);
  pct += books.books - books.penalty;
  const payTarget = u.finances?.payrollTarget || 8000;
  return {
    pct, booksPct: books.books, penaltyPct: books.penalty, net: books.net,
    payrollTarget:     Math.round(payTarget * (1 + pct) / 10) * 10,
    prevPayrollTarget: payTarget,
    funds:             u.finances?.funds || 0,
    winTarget:         u._ownerWinTarget,
  };
}

/** mode: 'accept' | 'push' | 'auto' */
export function applyOwnership(draft, offer, mode) {
  const u = draft.userTeam;
  const mult = mode === 'push' ? 1 + OWNERSHIP_OFFER.pushExtra : mode === 'auto' ? 1 + OWNERSHIP_OFFER.autoCut : 1;
  const target = Math.round(offer.payrollTarget * mult / 10) * 10;
  u.finances.payrollTarget = target;
  u.finances.payrollTargetHistory = [...(u.finances.payrollTargetHistory || []), { seasonNum: (draft.seasonNum || 1) + 1, payrollTarget: target }];
  if (u.finances.owner) u.finances.owner.targetPenalty = 0;   // the missed orders were counted in this offer
  const trust = mode === 'push' ? OWNERSHIP_OFFER.pushTrust : mode === 'auto' ? OWNERSHIP_OFFER.autoTrust : 0;
  if (trust) u.ownerTrust = Math.max(0, Math.min(100, (u.ownerTrust || 50) + trust));
  return { payrollTarget: target, trust };
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

// ─────────────────────────────────────────────────────────────
// §112.2 THE COACHES — renew, let go, fire, hire
// ─────────────────────────────────────────────────────────────

/** Coaches whose deals are up after this season. */
export function coachesUp(draft) {
  const next = (draft.seasonNum || 1) + 1;
  return Coach.COACH_ROLES.filter(r => Coach.coachContractIsUp(draft.userTeam?.coachingStaff?.[r], next));
}

/** Empty chairs on the staff. */
export function coachVacancies(draft) {
  return Coach.COACH_ROLES.filter(r => draft.userTeam?.coachingStaff?.[r]?.vacant);
}

/** mode: 'renew' (at `salary`, two years) | 'letgo' | 'fire' (the rest of the deal is paid now). */
export function applyCoachDecision(draft, role, mode, { salary = null, atMs = 0 } = {}) {
  const u = draft.userTeam;
  const staff = u?.coachingStaff;
  const c = staff?.[role];
  if (!c || c.vacant) return null;
  const next = (draft.seasonNum || 1) + 1;
  if (mode === 'renew') {
    Coach.renewCoach(staff, role, salary ?? c.salary, next);
    return { name: c.name, salary: c.salary };
  }
  const name = c.name;
  const owed = mode === 'fire' ? Coach.buyoutOwed(c, next) : 0;
  if (owed) Finance.post(u.finances, -owed, 'staff', `Buyout — ${name}, ${Coach.ROLE_INFO[role].title}`, atMs);
  Coach.vacate(staff, role);
  if (mode === 'fire') u.morale = Math.max(0, (u.morale || 50) - 1);
  return { name, owed };
}

export function applyCoachHire(draft, role, cand) {
  const staff = draft.userTeam?.coachingStaff;
  if (!staff || !cand) return null;
  return Coach.hire(staff, role, cand, (draft.seasonNum || 1) + 1);
}

/**
 * Spring opens: any coach whose deal ran out without a decision stays two
 * more years; an empty chair nobody filled gets a league-typical coach.
 * (The cards resolve these first; this only catches what they couldn't.)
 */
function _settleStaff(draft) {
  const staff = draft.userTeam?.coachingStaff;
  if (!staff) return;
  const start = (draft.seasonNum || 1) + 1;   // the season about to open
  for (const role of Coach.COACH_ROLES) {
    const c = staff[role];
    if (!c) continue;
    if (c.vacant) {
      const taken = new Set(Object.values(staff).map(x => x?.name).filter(Boolean).concat(draft.userTeam.ownerName));
      const [cand] = Coach.candidates(draft, role, null, { taken });
      Coach.hire(staff, role, { ...cand, quality: 55, salary: Coach.salaryFor(role, 55) }, start);
    } else if ((c.contractExpiry ?? 99) <= start) {
      c.contractExpiry = start + 2;
    }
  }
}

/**
 * hardGates(state)
 * §23.2: spring cannot begin with these open — they auto-resolve at spring.
 * Read from the GM's unresolved offseason cards (`_osGate`).
 * @returns {{ ownership: Boolean, contracts: Boolean, manager: Boolean, staff: Boolean, open: String[] }}  true = cleared
 * (staff: §112.2 an empty coaching chair still to fill)
 */
export function hardGates(state) {
  const cards = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])];
  const open = (g) => cards.some(c => c._osGate === g);
  const gates = { ownership: !open('ownership'), contracts: !open('contracts'), manager: !open('manager'), staff: !open('staff') };
  return { ...gates, open: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k) };
}

// ─────────────────────────────────────────────────────────────
// SPRING — THE NEW SEASON
// ─────────────────────────────────────────────────────────────

/**
 * openNewSeason(draft, atMs)
 * Spring (the day after the last), after required decisions have auto-resolved:
 * §122 unsigned free agents stay on the market (the pool trimmed to its size,
 * the least promising going home), coaches are kept on, every club opens with
 * 28 (a club short signs free agents), payroll is recomputed and every record
 * starts over in season N+1.
 * (The calendar and the phase change belong to GameEngine.)
 */
export function openNewSeason(draft, atMs) {
  const events = [];
  events.push(..._trimFreeAgentPool(draft, atMs));
  _settleStaff(draft);
  // §113 a new season, a new lineup: nobody is owed last year's spot.
  for (const p of Object.values(draft.players || {})) if (p?._lostSlot) p._lostSlot = null;

  // Anyone who joined a club after contract day (a waiver claim) with his
  // deal up signs on for a year at market — the club brought him in; nobody
  // opens a season without a contract.
  for (const t of _allTeams(draft)) {
    for (const id of [...(t?.rosterIds || [])]) {
      const p = draft.players[id];
      if (p && contractIsUp(p, draft.seasonNum || 1)) {
        applyContract(draft, id, { ...marketTerms(draft, p), years: 1 });
        events.push({ type: 'RESIGNED', playerId: id, teamId: t.id || 'user', atMs, late: true });
      }
    }
  }

  // §122 every CPU club opens the season with 28: one short signs free agents
  // (deals that start with the new season). Our open spots are the GM's —
  // the open-spot card and its deadline, in spring like any time.
  events.push(...fillShortRosters(draft, atMs));

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
  u.finances.payroll = computePayroll(draft);   // (the books closed at the season's end — §78)
  draft.currentGameIndex = 0;
  draft.standings      = null;
  draft.playoffBracket = null;
  draft.offseason      = null;
  for (const p of Object.values(draft.players || {})) {
    if (!p) continue;
    p._ovrChange = undefined;
  }
  return events.filter(Boolean);
}

/**
 * newFreeAgentClass(draft, atMs)
 * §122 New players enter the league once a year, on a named offseason day
 * (the day free agency opens): this year's class — young players out of the
 * amateur ranks and from abroad — joins the free agents, where any club can
 * sign them. About as many as the ten clubs' farms used to sign.
 * @returns {Object[]} events (one FA_CLASS summary event)
 */
export function newFreeAgentClass(draft, atMs) {
  const level = draft.leagueTalentOffset || 0;
  const season = draft.seasonNum || 1;
  const rand0 = dice(diceSeed(draft), 'fa-class', season);
  const clubs = _allTeams(draft).length;
  const n = clubs * PROSPECTS_PER_TEAM_MIN + Math.floor(rand0() * (clubs * (PROSPECTS_PER_TEAM_MAX - PROSPECTS_PER_TEAM_MIN) + 1));
  const used = namesInUse(draft.players);
  const HITTER_POS = ['C', 'SS', '2B', '3B', '1B', 'OF', 'OF', 'OF'];
  const ids = [];
  for (let i = 0; i < n; i++) {
    const rand = dice(diceSeed(draft), 'fa-class', season, i);   // §118
    const pitcher = rand() < 0.45;
    const pos = pitcher ? (rand() < 0.5 ? 'SP' : 'RP') : HITTER_POS[Math.floor(rand() * HITTER_POS.length)];
    const name = _newName(used, rand);   // §82 (added to `used`)
    // §122.9 a rookie, or (three in ten) a player from abroad: older, new to the league.
    const kind = rand() < 0.3 ? 'intl' : 'prospect';
    const p = createPlayer({
      id: diceId(rand), name, pos, group: PLAYER_GROUP.FREE_AGENT,
      hand: pitcher ? (rand() < 0.28 ? 'L' : 'R') : null,
      targetOvr: level + PROSPECT_OVR_MIN + Math.floor(rand() * (PROSPECT_OVR_MAX - PROSPECT_OVR_MIN + 1)),
      rand,
      ageMin: kind === 'intl' ? FA_CLASS_INTL_AGE.min : PROSPECT_AGE_MIN,
      ageMax: kind === 'intl' ? FA_CLASS_INTL_AGE.max : PROSPECT_AGE_MAX,
      seasonNum: season + 1, seasonYear: baseballYear(draft) + 1,
      contractLengthOverride: 1, teamId: null, leagueLevel: level,
    });
    Object.assign(p, { tier: 'freeAgent', _faFrom: null, _faSince: atMs, _faReason: 'class',
                       _marketKind: kind, _classOf: season + 1, origin: originForKind(kind) });
    giveUntestedGap(p, rand);   // §122.9 new to the league: his ratings are an estimate
    draft.players[p.id] = p;
    ids.push(p.id);
  }
  // §122.9 a few of the class are much better than the scouts think.
  const seedRand = dice(diceSeed(draft), 'fa-class-diamonds', season);
  seedUpside(Object.fromEntries(ids.map(id => [id, draft.players[id]])), level, seedRand, DIAMOND.classUpside);
  for (const id of ids) markAvailable(draft.players[id], atMs, seedRand, level);
  draft.freeAgentPool = [...(draft.freeAgentPool || []), ...ids];
  return [{ type: 'FA_CLASS', playerIds: ids, season: season + 1, atMs }];
}

/**
 * _trimFreeAgentPool(draft, atMs) — §122 the market keeps to its size
 * (FA_POOL_MAX): past it, the free agents with the least future — lowest
 * OVR for their age, as the league sees it (cpuView) — go home. This year's
 * class stays, and so do diamonds word hasn't got around about yet and anyone
 * the scouts reported to the GM in the last FA_TRIM_SCOUTED_KEEP_MS.
 */
export function _trimFreeAgentPool(draft, atMs) {
  const events = [];
  const level = draft.leagueTalentOffset || 0;
  const nextYear = baseballYear(draft) + 1;
  // Ranked by what the league sees (§122.10): a diamond word has got around about counts at his worth.
  const future = (x) => cpuView(x, atMs) - level - computeAge(x.dob, nextYear);
  // Kept regardless: a diamond word hasn't got around about yet (the GM can still find him), and
  // anyone the scouts named to the GM lately (a report shouldn't point at a player who went home).
  const reported = new Set((draft.composeLog || [])
    .filter(r => atMs - r.atMs < FA_TRIM_SCOUTED_KEEP_MS)
    .flatMap(r => [...(r.memo?.playerIds || []), r.memo?.playerId].filter(Boolean)));
  const keep = (x) => (Number.isFinite(x._buzzAt) && x._buzzAt > atMs) || reported.has(x.id)
    || (Number.isFinite(x._scoutedAt) && atMs - x._scoutedAt < FA_TRIM_SCOUTED_KEEP_MS) || (Number.isFinite(x._tipAt) && atMs - x._tipAt < FA_TRIM_SCOUTED_KEEP_MS);
  const pool = freeAgents(draft).filter(p => p._classOf !== (draft.seasonNum || 1) + 1 && !keep(p)).sort((a, b) => future(a) - future(b));
  const over = freeAgents(draft).length - FA_POOL_MAX;
  for (let i = 0; i < over && i < pool.length; i++) events.push(departLeague(draft, pool[i].id, atMs, 'unsigned'));
  return events;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/** §82 a new player's name: a last name nobody in `used` wears, else an initialed one. */
function _newName(used, rand) {
  const taken = new Set([...used].map(surnameOf));
  const free = PLAYER_SURNAMES.filter(s => !taken.has(s));
  const pool = free.length ? free : PLAYER_SURNAMES;
  return uniqueName(pool[Math.floor(rand() * pool.length)], used, rand);
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(eventRand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _rng(lo, hi) {
  return lo + Math.floor(eventRand() * (hi - lo + 1));
}

function _uuid() {
  // r139 §121 inside a world event, from its stream (the look-ahead and the real run make the same id).
  return inEvent() ? diceId(eventRand) : crypto.randomUUID();
}

export { OFF_ROSTER };
