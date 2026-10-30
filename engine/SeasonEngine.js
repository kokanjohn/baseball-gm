/**
 * engine/SeasonEngine.js
 * Schedule generation, standings calculation, and season phase transitions.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. Caller (GameEngine) applies results.
 *   - Every game object is complete at generation — no deferred fields.
 *   - Real-world timestamps assigned at game generation based on current date + offset.
 *   - All schedule anchors imported from constants — no magic numbers here.
 */

import {
  PHASE,
  GAME_STATUS,
  GAME_TIMES_BY_DOW,
  SPRING_TRAINING_FIRST_GAME_TIME,
  REGULAR_SEASON_GAME_COUNT,
  SPRING_TRAINING_GAME_COUNT,
  ALL_STAR_BREAK_AFTER_GAME,
  ALL_STAR_BREAK_DAYS,
  ALLSTAR_GAME_BREAK_DAY,
  ALLSTAR_GAME_TIME,
  ALLSTAR_SQUAD_IDS,
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  STRETCH_RUN_FINAL_GAMES,
  LEAGUE_TEAMS_PER_DIVISION,
  ACTIVITY_FEED_RETENTION_HOURS,
  SPRING_START_MONTH,
  SPRING_START_DAY,
} from '../data/constants.js';

import { LEAGUE_TEAMS } from './LeagueFactory.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;


// ─────────────────────────────────────────────────────────────
// ONE LEAGUE CALENDAR (§67)
// ─────────────────────────────────────────────────────────────

// Real-world gap from the first spring game to Opening Day (spring is 10
// games over 13 days, then a short break).
const SPRING_TO_SEASON_GAP_DAYS = 18;
const SPRING_OFF_DAYS           = new Set([2, 5, 8]);

/**
 * generateLeagueCalendar(seasonNum, leagueTeams, startDateOverride?, opts?)
 * The whole league's season on ONE calendar — the user is one of ten teams.
 *
 *   Spring:  10 games each, every team plays every spring day (off days 3, 6, 9).
 *   Season:  46 series rounds; every team plays in every round, so every team
 *            plays exactly REGULAR_SEASON_GAME_COUNT games. Division-weighted
 *            (user decision, §67): ~6 series (~17 games) vs each division
 *            rival, ~4 (~13) vs each club in the other division. Series are
 *            2–3 games; every other round is staggered so each team gets an
 *            off day and at least four teams play every day. The All-Star
 *            break falls exactly after game ALL_STAR_BREAK_AFTER_GAME.
 *   Times:   GAME_TIMES_BY_DOW for the real weekday; first spring day 1:05 PM.
 *
 * Real (gameTime) and display (game.date) calendars share one day offset, so
 * the user's games and the CPU slate always line up.
 *
 * @param {Number}   seasonNum
 * @param {Object[]} leagueTeams  — { id, name, divisionId }
 * @param {Date}     [startDateOverride] — real date of the first spring game
 * @param {Object}   [opts]       — { userDivisionId = 'A' }
 * @returns {{ schedule: Object[], leagueSchedule: { dayMap } }}
 */
export function generateLeagueCalendar(seasonNum, leagueTeams, startDateOverride, opts = {}) {
  // The league's year comes from the save (§70); the real clock only as a
  // fallback for callers that have no state.
  const year       = Number.isFinite(opts.year) ? opts.year : _seasonYear(seasonNum);
  const realStart  = startDateOverride ? new Date(startDateOverride) : _getSpringStartDate(year);
  const dispStart  = _getSpringStartDate(year);
  const userDiv    = opts.userDivisionId || 'A';
  const nameOf     = new Map(leagueTeams.map(t => [t.id, t.name]));
  const teams      = [{ id: 'user', divisionId: userDiv }, ...leagueTeams.map(t => ({ id: t.id, divisionId: t.divisionId }))];
  const ids        = teams.map(t => t.id);

  const byOffset = new Map();     // day offset → [{ homeId, awayId, isSpring, seriesId, seriesGame, seriesLength }]
  const put = (offset, g) => { if (!byOffset.has(offset)) byOffset.set(offset, []); byOffset.get(offset).push(g); };

  // ── Spring ───────────────────────────────────────────────────
  const springRounds = _circleRounds(ids);
  _shuffle(springRounds);
  let offset = 0, played = 0;
  while (played < SPRING_TRAINING_GAME_COUNT) {
    if (!SPRING_OFF_DAYS.has(offset)) {
      for (const [a, b] of springRounds[played % springRounds.length]) {
        const home = Math.random() < 0.5;
        put(offset, { homeId: home ? a : b, awayId: home ? b : a, isSpring: true,
                      seriesId: `st-${played}-${a}-${b}`, seriesGame: 1, seriesLength: 1 });
      }
      played++;
    }
    offset++;
  }

  // ── Regular season ───────────────────────────────────────────
  const rounds  = _regularSeasonRounds(teams);
  const lengths = _roundLengths(rounds.length);
  const homeNext = new Map();      // pair key → id of the team hosting their next series
  offset = SPRING_TO_SEASON_GAP_DAYS;
  let gamesSoFar = 0;
  let asgOffset = null;
  rounds.forEach((pairs, r) => {
    const len     = lengths[r];
    const stagger = r % 2 === 1;  // every other round: half the pairs start a day later
    pairs.forEach(([a, b], k) => {
      const key  = a < b ? `${a}|${b}` : `${b}|${a}`;
      let host   = homeNext.get(key) || (Math.random() < 0.5 ? a : b);
      homeNext.set(key, host === a ? b : a);
      const away = host === a ? b : a;
      const shift = stagger && k % 2 === 1 ? 1 : 0;
      const sid   = `s${seasonNum}-r${r}-${key}`;
      for (let gi = 0; gi < len; gi++) {
        put(offset + shift + gi, { homeId: host, awayId: away, isSpring: false,
                                   seriesId: sid, seriesGame: gi + 1, seriesLength: len });
      }
    });
    offset += len + (stagger ? 1 : 0);
    gamesSoFar += len;
    if (gamesSoFar === ALL_STAR_BREAK_AFTER_GAME) {
      asgOffset = offset + ALLSTAR_GAME_BREAK_DAY - 1;   // §75: the game, mid-break
      offset += ALL_STAR_BREAK_DAYS;
    }
  });

  // ── Materialize: user schedule + CPU day map ─────────────────
  const schedule = [];
  const dayMap   = {};
  let userRegular = 0;
  const offsets = [...byOffset.keys()].sort((x, y) => x - y);
  const firstSpringDay = offsets[0];
  for (const off of offsets) {
    const realDate = _addDays(realStart, off);
    const dateStr  = _isoDate(_addDays(dispStart, off));
    const dow      = DOW_NAMES[realDate.getDay()];
    for (const g of byOffset.get(off)) {
      const times    = off === firstSpringDay ? [SPRING_TRAINING_FIRST_GAME_TIME]
                     : (GAME_TIMES_BY_DOW[dow] || ['7:05 PM']);
      const gameTime = _parseGameTime(times[Math.floor(Math.random() * times.length)], realDate);
      const userSide = g.homeId === 'user' ? 'home' : g.awayId === 'user' ? 'away' : null;
      if (userSide) {
        const oppId = userSide === 'home' ? g.awayId : g.homeId;
        const ri    = g.isSpring ? null : userRegular++;
        const game  = _makeGameObject({
          index:              schedule.length,
          opponent:           nameOf.get(oppId),
          isHome:             userSide === 'home',
          date:               dateStr,
          gameTime,
          isSpring:           g.isSpring,
          phase:              g.isSpring ? PHASE.SPRING_TRAINING : PHASE.REGULAR_SEASON,
          regularSeasonIndex: ri,
          isDeadlineWindow:   ri !== null && ri >= TRADE_DEADLINE_OPEN && ri <= TRADE_DEADLINE_CLOSE,
          isStretchRun:       ri !== null && ri >= REGULAR_SEASON_GAME_COUNT - STRETCH_RUN_FINAL_GAMES,
        });
        Object.assign(game, { opponentId: oppId, seriesId: g.seriesId, seriesGame: g.seriesGame, seriesLength: g.seriesLength });
        schedule.push(game);
      } else {
        (dayMap[dateStr] = dayMap[dateStr] || []).push({
          id:        `cg-${seasonNum}-${off}-${g.homeId}-${g.awayId}`,
          homeId:    g.homeId,
          awayId:    g.awayId,
          date:      dateStr,
          gameTime,
          isSpring:  g.isSpring,
          seriesId:  g.seriesId,
          seriesGame: g.seriesGame,
          seriesLength: g.seriesLength,
          status:    GAME_STATUS.SCHEDULED,
          played:    false,
          homeScore: null,
          awayScore: null,
        });
      }
    }
  }

  // ── The All-Star Game (§75): on the league calendar like any game. Which
  // squad is home is set when the host is named (AllStarEngine.nameHost).
  if (asgOffset !== null) {
    const realDate = _addDays(realStart, asgOffset);
    const dateStr  = _isoDate(_addDays(dispStart, asgOffset));
    (dayMap[dateStr] = dayMap[dateStr] || []).push({
      id:        `asg-${seasonNum}`,
      isAllStar: true,
      homeId:    ALLSTAR_SQUAD_IDS.B,
      awayId:    ALLSTAR_SQUAD_IDS.A,
      date:      dateStr,
      gameTime:  _parseGameTime(ALLSTAR_GAME_TIME, realDate),
      isSpring:  false,
      status:    GAME_STATUS.SCHEDULED,
      played:    false,
      homeScore: null,
      awayScore: null,
    });
  }

  if (schedule.filter(g => g.isSpring).length !== SPRING_TRAINING_GAME_COUNT
      || schedule.filter(g => !g.isSpring).length !== REGULAR_SEASON_GAME_COUNT) {
    throw new Error('SeasonEngine.generateLeagueCalendar: game counts do not match the constants');
  }
  return { schedule, leagueSchedule: { dayMap } };
}

/** Circle-method 1-factorization: n−1 perfect matchings of an even list. */
function _circleRounds(ids) {
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());   // rotate all but the first
  }
  return rounds;
}

/**
 * Series rounds: every pairing 4× (four shuffled cycles of the 9 league-wide
 * matchings) + 10 division rounds (each division's round robin twice; the two
 * teams resting in their division meet each other). Shuffled, avoiding the same
 * series twice in a row.
 */
function _regularSeasonRounds(teams) {
  const ids = teams.map(t => t.id);
  const rounds = [];
  for (let c = 0; c < 4; c++) { const cyc = _circleRounds(ids); _shuffle(cyc); rounds.push(...cyc); }
  const divs = [...new Set(teams.map(t => t.divisionId))];
  const cycles = divs.map(d => _circleRoundsWithBye(teams.filter(t => t.divisionId === d).map(t => t.id)));
  // Two passes of each division's round robin. The teams resting in their
  // division meet each other, so the second pass re-orders the other
  // division's rounds until no resting pair repeats (spreads the extra
  // cross-division series evenly).
  const divRounds = cycles.map(c => [...c]);
  if (cycles.length === 2) {
    const used = new Set(cycles[0].map((r, i) => `${r.bye}|${cycles[1][i].bye}`));
    let second = [...cycles[1]];
    for (let t = 0; t < 200; t++) {
      _shuffle(second);
      if (cycles[0].every((r, i) => !used.has(`${r.bye}|${second[i].bye}`))) break;
    }
    divRounds[0].push(...cycles[0]);
    divRounds[1].push(...second);
  } else {
    cycles.forEach((c, i) => divRounds[i].push(...c));
  }
  for (let r = 0; r < divRounds[0].length; r++) {
    const pairs = [], byes = [];
    for (const dr of divRounds) { pairs.push(...dr[r].pairs); if (dr[r].bye) byes.push(dr[r].bye); }
    if (byes.length === 2) pairs.push([byes[0], byes[1]]);
    rounds.push(pairs);
  }
  _shuffle(rounds);
  const key = (p) => p.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`));
  for (let i = 1; i < rounds.length; i++) {
    const prev = new Set(key(rounds[i - 1]));
    if (!key(rounds[i]).some(k => prev.has(k))) continue;
    for (let j = i + 1; j < rounds.length; j++) {
      if (!key(rounds[j]).some(k => prev.has(k))) { [rounds[i], rounds[j]] = [rounds[j], rounds[i]]; break; }
    }
  }
  return rounds;
}

/** Round robin of an odd group: each round some pairs + the team with the bye. */
function _circleRoundsWithBye(members) {
  const list = [...members, null];
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = []; let bye = null;
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a === null) bye = b; else if (b === null) bye = a; else pairs.push([a, b]);
    }
    rounds.push({ pairs, bye });
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * Series lengths: two halves of equal rounds, each summing to exactly half the
 * season (so the All-Star break lands after game ALL_STAR_BREAK_AFTER_GAME),
 * mostly 3-game series with a few 2-game sets.
 */
function _roundLengths(count) {
  const half = count / 2;
  const target = REGULAR_SEASON_GAME_COUNT / 2;
  const make = () => {
    const twos = 3 * half - target;          // 3·threes + 2·twos = target
    const arr = [...Array(half - twos).fill(3), ...Array(twos).fill(2)];
    _shuffle(arr);
    return arr;
  };
  if (target !== ALL_STAR_BREAK_AFTER_GAME || !Number.isInteger(half)) {
    throw new Error('SeasonEngine: round layout assumes the All-Star break at mid-season');
  }
  return [...make(), ...make()];
}

// ─────────────────────────────────────────────────────────────
// STANDINGS
// ─────────────────────────────────────────────────────────────

/**
 * computeFullStandings(leagueTeams, userTeamRecord)
 * Recalculates standings for all 10 teams from current records.
 * Returns a standings object sorted by win percentage within each division.
 *
 * @param {Object[]} leagueTeams   — from state.leagueTeams
 * @param {Object}   userTeamRecord — { wins, losses, abbr, name, divisionId }
 * @returns {{ divA: StandingsEntry[], divB: StandingsEntry[], overall: StandingsEntry[] }}
 */
export function computeFullStandings(leagueTeams, userTeamRecord) {
  const allTeams = [
    ...leagueTeams.map(t => ({
      id:         t.id,
      name:       t.name,
      abbr:       t.abbr,
      divisionId: t.divisionId,
      wins:       t.wins,
      losses:     t.losses,
      ties:       t.ties || 0,
    })),
    {
      id:         'user',
      name:       userTeamRecord.name,
      abbr:       userTeamRecord.abbr,
      divisionId: userTeamRecord.divisionId || 'A',
      wins:       userTeamRecord.wins,
      losses:     userTeamRecord.losses,
      ties:       userTeamRecord.ties || 0,
    },
  ];

  // Sort by win pct, then raw wins (head-to-head tiebreaker applied at bracket build time)
  const _sort = teams => [...teams].sort((a, b) => {
    const wpA = _winPct(a);
    const wpB = _winPct(b);
    if (wpB !== wpA) return wpB - wpA;
    return b.wins - a.wins;
  });

  const _addGB = (sorted) => {
    const leader = sorted[0];
    return sorted.map((t, i) => ({
      ...t,
      seed:   i + 1,   // 1-based seed within division
      winPct: _winPct(t),
      gb: i === 0
        ? '-'
        : (((leader.wins - t.wins) + (t.losses - leader.losses)) / 2).toFixed(1),
    }));
  };

  // Each division sorted and seeded 1-5
  const divA = _addGB(_sort(allTeams.filter(t => t.divisionId === 'A')));
  const divB = _addGB(_sort(allTeams.filter(t => t.divisionId === 'B')));

  // Overall #1 seed: best record in league (World Series home field)
  // Overall #2 seed: best record in the other division
  const allSorted = _sort(allTeams);
  const overallOne = allSorted[0];
  const overallTwo = allSorted.find(t => t.divisionId !== overallOne.divisionId) || allSorted[1];

  return {
    divA,
    divB,
    overallOne,    // best record in league — World Series home field
    overallTwo,    // best record in other division
    all: allSorted,
  };
}

function _winPct(team) {
  const total = team.wins + team.losses;
  return total === 0 ? 0.500 : team.wins / total;
}

// ─────────────────────────────────────────────────────────────
// PLAYOFF BRACKET
// ─────────────────────────────────────────────────────────────

// (The playoff bracket lives in PlayoffEngine.js — §68.)

// ─────────────────────────────────────────────────────────────
// PHASE TRANSITION
// ─────────────────────────────────────────────────────────────

/**
 * getNextPhase(currentPhase, gameIndex, standings, userInPlayoffs)
 * Returns the next phase given the current state.
 * GameEngine calls this after each game commit.
 *
 * @param {String}  currentPhase
 * @param {Number}  scheduleIndex   — RAW schedule index of the just-committed game
 *                                     (spring occupies 0..SPRING_TRAINING_GAME_COUNT-1)
 * @param {Object}  standings       — from computeFullStandings()
 * @param {Boolean} userInPlayoffs  — whether user team qualified
 * @returns {String|null}  new phase, or null if no transition
 */
export function getNextPhase(currentPhase, scheduleIndex, standings, userInPlayoffs) {
  // Regular-season-relative index of the just-committed game. Negative during spring.
  // All the regular-season milestones below are expressed in this base; the spring
  // and playoff boundaries are expressed against the raw schedule index / counts.
  const reg = scheduleIndex - SPRING_TRAINING_GAME_COUNT;

  switch (currentPhase) {
    case PHASE.SETUP:
      return PHASE.SPRING_TRAINING;

    case PHASE.SPRING_TRAINING:
      // Spring ends once the next game to play is the first regular-season game.
      if (scheduleIndex + 1 >= SPRING_TRAINING_GAME_COUNT) return PHASE.REGULAR_SEASON;
      return null;

    case PHASE.REGULAR_SEASON:
      if (reg === ALL_STAR_BREAK_AFTER_GAME)          return PHASE.ALL_STAR_BREAK;
      if (reg === TRADE_DEADLINE_OPEN)                return PHASE.TRADE_DEADLINE;
      // The end of the regular season is a LEAGUE event (every club's last
      // game), handled on the clock by GameEngine._seasonProgress (§68).
      return null;

    case PHASE.ALL_STAR_BREAK:
      return PHASE.REGULAR_SEASON;

    case PHASE.TRADE_DEADLINE:
      if (reg > TRADE_DEADLINE_CLOSE) return PHASE.REGULAR_SEASON;
      return null;

    // Playoff rounds advance when every series in the round is decided —
    // GameEngine._seasonProgress, on the league clock (§68).
    case PHASE.PLAYOFF_BRACKET_BUILD:
    case PHASE.WILD_CARD:
    case PHASE.FIRST_ROUND:
    case PHASE.DIVISION_SERIES:
    case PHASE.WORLD_SERIES:
      return null;

    case PHASE.SEASON_SUMMARY:
      return PHASE.OFFSEASON;

    case PHASE.OFFSEASON:
      return PHASE.SPRING_TRAINING;

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED
// ─────────────────────────────────────────────────────────────

/**
 * buildActivityFeedEntry(type, teamAbbr, text)
 * Creates a standardized activity feed entry.
 *
 * @param {String} type     — 'win'|'loss'|'trade'|'injury'|'signing'|'callup'|'waiver'
 * @param {String} teamAbbr
 * @param {String} text
 * @returns {Object} feed entry
 */
export function buildActivityFeedEntry(type, teamAbbr, text, atMs = Date.now()) {
  return {
    type,
    teamAbbr,
    text,
    timestamp: atMs,   // when it happened on the league clock (catch-up passes the event time)
  };
}

/**
 * pruneActivityFeed(feed)
 * Removes entries older than ACTIVITY_FEED_RETENTION_HOURS.
 *
 * @param {Object[]} feed
 * @returns {Object[]} pruned feed
 */
export function pruneActivityFeed(feed) {
  const cutoff = Date.now() - (ACTIVITY_FEED_RETENTION_HOURS * MS_PER_HOUR);
  return feed.filter(e => e.timestamp >= cutoff);
}

// ─────────────────────────────────────────────────────────────
// GAME OBJECT FACTORY
// ─────────────────────────────────────────────────────────────

export function _makeGameObject(config) {
  return {
    index:              config.index,
    opponent:           config.opponent,
    isHome:             config.isHome,
    date:               config.date,
    gameTime:           config.gameTime,
    phase:              config.phase,
    isSpring:           config.isSpring || false,
    regularSeasonIndex: config.regularSeasonIndex ?? null,
    isDeadlineWindow:   config.isDeadlineWindow   || false,
    isStretchRun:       config.isStretchRun       || false,
    isMakeup:           config.isMakeup           || false,

    // §102.3 the weather at first pitch and the field after any rain before it —
    // set from the park report when the game starts (GameWeather.gameRecord).
    weather:        null,
    fieldCondition: null,

    status:        GAME_STATUS.SCHEDULED,
    plays:         null,
    livePlayIndex: 0,
    result:        null,
    ourScore:      null,
    theirScore:    null,
    boxScore:      null,
    recap:         null,

    resumePlays:      null,
  };
}

// ─────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────

function _seasonYear(seasonNum) {
  const currentYear = new Date().getFullYear();
  return currentYear + (seasonNum - 1);
}

function _getSpringStartDate(year) {
  // Spring training starts March 14 — runs ~14 days, ends by March 28.
  return new Date(year, SPRING_START_MONTH, SPRING_START_DAY);
}

function _getSeasonStartDate(year) {
  // Regular season always starts April 1.
  return new Date(year, 3, 1);
}

export function _isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function _addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function _parseGameTime(timeStr, date) {
  // "7:05 PM" → Unix ms timestamp on the given date
  const [timePart, meridiem] = timeStr.split(' ');
  const [hoursStr, minutesStr] = timePart.split(':');
  let hours   = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result.getTime();
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
