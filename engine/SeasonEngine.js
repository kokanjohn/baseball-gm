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
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  STRETCH_RUN_FINAL_GAMES,
  LEAGUE_TEAMS_PER_DIVISION,
  ACTIVITY_FEED_RETENTION_HOURS,
} from '../data/constants.js';

import { LEAGUE_TEAMS } from './LeagueFactory.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

// Series lengths — user schedule is generated as series blocks
const SERIES_LENGTHS = [2, 3, 3, 4]; // weighted toward 3-game series
const SERIES_WEIGHTS = [0.15, 0.55, 0.20, 0.10]; // cumulative

// Spring training: starts ~March 21, 10 games over ~13 days with off days.
// Last spring game lands ~March 30-31, leaving 1 day before April 1 Opening Day.
const SPRING_START_MONTH = 2;  // March (0-indexed = 2)
const SPRING_START_DAY   = 14; // March 14 anchor, rolled to nearest Monday (~Mar 14-16)
// 10 games + 3 off days = 13 calendar days → ends ~Mar 26-28, before April 1

// ─────────────────────────────────────────────────────────────
// USER SCHEDULE GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * generateUserSchedule(seasonNum, leagueTeams, startDateOverride?)
 * Generates the full user team schedule for one season:
 *   - 10 spring training games (mid-March, with off days, ends ~Mar 30)
 *   - 132 regular season games (April 1 start)
 *
 * Returns an array of GameObjects sorted chronologically.
 * All timestamps are real-world Unix ms.
 *
 * startDateOverride: optional Date object. When provided (e.g. from startNewGame),
 * the schedule anchors to this date rather than the canonical calendar date for
 * seasonNum. This ensures a newly created team's first game is always in the future
 * regardless of what time of year the user starts playing.
 *
 * @param {Number}   seasonNum
 * @param {Object[]} leagueTeams  — LEAGUE_TEAMS array from state
 * @param {Date}     [startDateOverride]  — optional anchor date for first spring game
 * @returns {Object[]} schedule
 */
export function generateUserSchedule(seasonNum, leagueTeams, startDateOverride) {
  const year        = _seasonYear(seasonNum);

  // Real-world clock anchor — used for gameTime (when the game actually fires)
  // Display date anchor — used for game.date (the fictional baseball calendar shown to user)
  //
  // These are deliberately separate:
  //   gameTime: anchored to today/tomorrow so games fire at real clock times
  //   game.date: anchored to the canonical baseball calendar (spring ~Mar 22)
  //              so the schedule always shows realistic baseball dates
  //
  // This means a user who creates a team in June sees "Mar 22" as Game 1's date
  // but the game still fires at today 1:05 PM. The fictional date is cosmetic only.

  let realStart;
  if (startDateOverride) {
    realStart = new Date(startDateOverride);
  } else {
    realStart = _getSpringStartDate(year);
  }

  // Fictional display dates always start at the canonical baseball spring anchor
  const canonicalSpringStart  = _getSpringStartDate(year);
  const canonicalSeasonStart  = _getSeasonStartDate(year);

  // Real-world season start: same gap after real spring start
  // 10 spring games with off days = ~16 calendar days, then 1-2 travel days = 18
  const SPRING_TO_SEASON_GAP_DAYS = 18;
  const realSeasonStart = startDateOverride
    ? _addDays(realStart, SPRING_TO_SEASON_GAP_DAYS)
    : _getSeasonStartDate(year);

  const schedule = [];

  // Spring training (SPRING_TRAINING_GAME_COUNT games)
  const springGames = _generateSpringGames(
    realStart, canonicalSpringStart, leagueTeams, year
  );

  // Gate: the generated spring count and the constant must never disagree.
  // They previously drifted (constant 20, generator 10), which corrupted the
  // regular-season index math (phase transitions, IL return timing).
  if (springGames.length !== SPRING_TRAINING_GAME_COUNT) {
    throw new Error(
      `SeasonEngine: generated ${springGames.length} spring games but ` +
      `SPRING_TRAINING_GAME_COUNT is ${SPRING_TRAINING_GAME_COUNT} — these must match.`
    );
  }
  schedule.push(...springGames);

  // Regular season (132 games)
  const regularGames = _generateRegularSeasonGames(
    realSeasonStart, canonicalSeasonStart, leagueTeams, year
  );
  schedule.push(...regularGames);

  schedule.forEach((g, i) => { g.index = i; });

  return schedule;
}

// ─────────────────────────────────────────────────────────────
// SPRING TRAINING SCHEDULE
// ─────────────────────────────────────────────────────────────

function _generateSpringGames(realStartDate, displayStartDate, leagueTeams, year) {
  const games       = [];
  const teams       = leagueTeams.map(t => t.name);
  let realDate      = new Date(realStartDate);
  let displayDate   = new Date(displayStartDate);
  let gameNum       = 0;
  let dayOffset     = 0; // total days advanced (including off days)

  // 10 games over ~16 days (Mar 15 → ~Mar 30), leaving ~2 days before Apr 1.
  // Off-day pattern: game-game-off-game-game-off-game-game-off-game-game
  // This gives every 3rd day off — realistic spring training schedule.
  const OFF_DAYS = new Set([2, 5, 8]); // 0-based day offsets that are rest days

  while (gameNum < SPRING_TRAINING_GAME_COUNT) { // spring training games (single source: constants)
    // Skip off days
    if (OFF_DAYS.has(dayOffset)) {
      realDate    = _addDays(realDate, 1);
      displayDate = _addDays(displayDate, 1);
      dayOffset++;
      continue;
    }

    const dow    = DOW_NAMES[realDate.getDay()];
    const isHome = Math.random() < 0.50;
    const opponent = teams[gameNum % teams.length];

    // First spring game always at 1:05 PM, rest use DOW-based times
    const timeOptions = gameNum === 0
      ? [SPRING_TRAINING_FIRST_GAME_TIME]
      : (GAME_TIMES_BY_DOW[dow] || ['1:05 PM']);
    const timeStr  = timeOptions[Math.floor(Math.random() * timeOptions.length)];
    const gameTime = _parseGameTime(timeStr, realDate);

    games.push(_makeGameObject({
      index:    gameNum,
      opponent,
      isHome,
      date:     _isoDate(displayDate),
      gameTime,
      isSpring: true,
      phase:    PHASE.SPRING_TRAINING,
    }));

    gameNum++;
    realDate    = _addDays(realDate, 1);
    displayDate = _addDays(displayDate, 1);
    dayOffset++;
  }

  return games;
}

// ─────────────────────────────────────────────────────────────
// REGULAR SEASON SCHEDULE
// ─────────────────────────────────────────────────────────────

function _generateRegularSeasonGames(realStartDate, displayStartDate, leagueTeams, year) {
  const games        = [];
  const teams        = leagueTeams.map(t => t.name);
  let realDate       = new Date(realStartDate);
  let displayDate    = new Date(displayStartDate);
  let gameIndex      = 0;

  const seriesBlocks = _buildSeriesBlocks(teams, REGULAR_SEASON_GAME_COUNT);

  for (const series of seriesBlocks) {
    if (gameIndex >= REGULAR_SEASON_GAME_COUNT) break;

    const seriesLen = Math.min(series.length, REGULAR_SEASON_GAME_COUNT - gameIndex);

    for (let i = 0; i < seriesLen; i++) {
      const dow      = DOW_NAMES[realDate.getDay()];
      const times    = GAME_TIMES_BY_DOW[dow] || ['7:05 PM'];
      const timeStr  = times[Math.floor(Math.random() * times.length)];
      const gameTime = _parseGameTime(timeStr, realDate);

      const isDeadlineWindow = gameIndex >= TRADE_DEADLINE_OPEN
                            && gameIndex <= TRADE_DEADLINE_CLOSE;
      const isStretchRun     = gameIndex >= (REGULAR_SEASON_GAME_COUNT - STRETCH_RUN_FINAL_GAMES);

      games.push(_makeGameObject({
        index:              SPRING_TRAINING_GAME_COUNT + gameIndex,
        opponent:           series.opponent,
        isHome:             series.isHome,
        date:               _isoDate(displayDate),  // fictional baseball date
        gameTime,                                   // real-world clock time
        isSpring:           false,
        phase:              PHASE.REGULAR_SEASON,
        regularSeasonIndex: gameIndex,
        isDeadlineWindow,
        isStretchRun,
      }));

      gameIndex++;
      realDate    = _addDays(realDate, 1);
      displayDate = _addDays(displayDate, 1);

      // Travel day between series
      if (i === seriesLen - 1 && gameIndex < REGULAR_SEASON_GAME_COUNT) {
        const nextSeries = seriesBlocks[seriesBlocks.indexOf(series) + 1];
        if (nextSeries && nextSeries.isHome !== series.isHome) {
          realDate    = _addDays(realDate, 1);
          displayDate = _addDays(displayDate, 1);
        }
      }
    }

    // Insert All-Star Break after game 66
    if (gameIndex === ALL_STAR_BREAK_AFTER_GAME) {
      realDate    = _addDays(realDate, 4);
      displayDate = _addDays(displayDate, 4);
    }
  }

  return games;
}

// ─────────────────────────────────────────────────────────────
// SERIES BLOCK BUILDER
// ─────────────────────────────────────────────────────────────

/**
 * _buildSeriesBlocks(teams, totalGames)
 * Returns an array of { opponent, isHome, length } objects that sum to totalGames.
 * Each team is visited home and away roughly equally.
 */
function _buildSeriesBlocks(teams, totalGames) {
  const blocks  = [];
  let remaining = totalGames;

  // Each team plays home and away series
  const matchups = [];
  for (const team of teams) {
    matchups.push({ opponent: team, isHome: true });
    matchups.push({ opponent: team, isHome: false });
  }

  // Shuffle for variety
  _shuffle(matchups);

  // Add extra matchups to reach game count
  let m = 0;
  while (remaining > 0) {
    const matchup = matchups[m % matchups.length];
    const length  = Math.min(_pickSeriesLength(), remaining);
    blocks.push({ ...matchup, length });
    remaining -= length;
    m++;
  }

  return blocks;
}

function _pickSeriesLength() {
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < SERIES_WEIGHTS.length; i++) {
    cum += SERIES_WEIGHTS[i];
    if (r < cum) return SERIES_LENGTHS[i];
  }
  return 3;
}

// ─────────────────────────────────────────────────────────────
// CPU SCHEDULE GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * generateCPUSchedules(seasonNum, leagueTeams)
 * Generates game results for all CPU-vs-CPU matchups.
 * Returns a dayMap: { [dateStr]: CPUGameResult[] }
 *
 * CPU games are stored as results only — no full game objects.
 * Played immediately on game day by LeagueEngine.
 *
 * @param {Number}   seasonNum
 * @param {Object[]} leagueTeams
 * @returns {Object} dayMap
 */
export function generateCPUSchedules(seasonNum, leagueTeams) {
  const year       = _seasonYear(seasonNum);
  const dayMap     = {};
  const teams      = leagueTeams.map(t => ({ id: t.id, name: t.name }));
  const pairs      = _generateRoundRobinPairs(teams);

  // ── Spring training CPU games ─────────────────────────────
  // Same 10-game schedule as the user, staggered 1 day so they
  // don't all fall on the exact same days. Uses display dates
  // anchored to canonical spring start.
  const springStart = _getSpringStartDate(year);
  const OFF_DAYS    = new Set([2, 5, 8]);
  let springDate    = new Date(springStart);
  let springGameNum = 0;
  let springDayOff  = 0;

  // CPU spring matches the user's spring length — single source: constants.
  while (springGameNum < SPRING_TRAINING_GAME_COUNT) {
    if (!OFF_DAYS.has(springDayOff)) {
      const dateStr     = _isoDate(springDate);
      const todayPairs  = _pairsForDay(pairs, springGameNum, teams.length);
      dayMap[dateStr]   = todayPairs.map(([home, away]) => ({
        homeId:    home.id,
        awayId:    away.id,
        date:      dateStr,
        gameNum:   springGameNum,
        isSpring:  true,
        played:    false,
        homeScore: null,
        awayScore: null,
      }));
      springGameNum++;
    }
    springDate = _addDays(springDate, 1);
    springDayOff++;
  }

  // ── Regular season CPU games ──────────────────────────────
  const startDate = _getSeasonStartDate(year);
  let date        = new Date(startDate);

  for (let gameNum = 0; gameNum < REGULAR_SEASON_GAME_COUNT; gameNum++) {
    if (gameNum === ALL_STAR_BREAK_AFTER_GAME) {
      date = _addDays(date, 4);
    }

    const dateStr     = _isoDate(date);
    const todayPairs  = _pairsForDay(pairs, gameNum, teams.length);

    dayMap[dateStr] = todayPairs.map(([home, away]) => ({
      homeId:    home.id,
      awayId:    away.id,
      date:      dateStr,
      gameNum,
      played:    false,
      homeScore: null,
      awayScore: null,
    }));

    date = _addDays(date, 1);
  }

  return { dayMap };
}

function _generateRoundRobinPairs(teams) {
  const pairs = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      pairs.push([teams[i], teams[j]]);
    }
  }
  return pairs;
}

function _pairsForDay(allPairs, gameNum, teamCount) {
  // Simple rotation: pick pairs such that each team plays once per day
  // (not every team plays every day — some get off days)
  const startIdx = (gameNum * 3) % allPairs.length;
  const count    = Math.min(3, Math.floor(teamCount / 2));
  const result   = [];
  const used     = new Set();

  for (let i = 0; i < allPairs.length && result.length < count; i++) {
    const pair = allPairs[(startIdx + i) % allPairs.length];
    const [a, b] = pair;
    if (!used.has(a.id) && !used.has(b.id)) {
      result.push(pair);
      used.add(a.id);
      used.add(b.id);
    }
  }

  return result;
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

/**
 * buildPlayoffBracket(standings)
 * Builds the initial playoff bracket from final regular season standings.
 * Returns a bracket object used by GameEngine to generate playoff series.
 *
 * Format: 6 teams — 2 division leaders + 1 wildcard per league (simplified)
 * Wild card: best record among non-leaders (1-game)
 * Division series: best-of-5
 * Championship: best-of-7
 * World Series: best-of-7
 *
 * @param {Object} standings  — from computeFullStandings()
 * @returns {Object} bracket
 */
/**
 * buildPlayoffBracket(standings)
 * Builds the division-contained playoff bracket (Section 26 — LOCKED).
 *
 * Structure per division:
 *   Wild Card (1 game):   4th vs 5th
 *   First Round (best 3): 1st vs WC winner, 2nd vs 3rd
 *   Division Series (best 5): first round winners
 * World Series (best 7): Division A champion vs Division B champion
 *
 * Seeding tiebreaker: head-to-head record (applied before bracket build).
 * World Series home field: team with better regular season record (#1 overall seed).
 *
 * @param {Object} standings  — from computeFullStandings()
 * @returns {Object} bracket
 */
export function buildPlayoffBracket(standings) {
  const { divA, divB } = standings;

  const _makeSeries = (home, away, bestOf) => ({
    home,
    away,
    bestOf,
    winsNeeded: Math.ceil(bestOf / 2),
    wins: {
      [home?.id]: 0,
      [away?.id]: 0,
    },
    games:    [],     // game objects added as series is played
    complete: false,
    winner:   null,
  });

  const _divBracket = (div) => ({
    WILD_CARD: {
      // 4th seed hosts (higher seed always hosts)
      series: [ _makeSeries(div[3], div[4], 1) ],
    },
    FIRST_ROUND: {
      // Filled after Wild Card resolves
      // 1st vs WC winner, 2nd vs 3rd
      // 1st seed hosts vs WC winner; 2nd seed hosts vs 3rd
      series: [
        _makeSeries(div[0], null, 3),  // home: 1st seed, away: WC winner (filled after WC)
        _makeSeries(div[1], div[2], 3), // home: 2nd seed, away: 3rd seed
      ],
    },
    DIVISION_SERIES: {
      series: [], // filled after First Round resolves
    },
  });

  return {
    divA: _divBracket(divA),
    divB: _divBracket(divB),
    WORLD_SERIES: {
      series: [], // filled after both Division Series resolve
      // home field: overallOne.divisionId determines which division hosts
    },
    overallOneDivision: standings.overallOne?.divisionId || 'A',
    champion: null,
  };
}

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
      // Playoffs begin once the final regular-season game has been committed.
      if (reg + 1 >= REGULAR_SEASON_GAME_COUNT)        return PHASE.PLAYOFF_BRACKET_BUILD;
      return null;

    case PHASE.ALL_STAR_BREAK:
      return PHASE.REGULAR_SEASON;

    case PHASE.TRADE_DEADLINE:
      if (reg > TRADE_DEADLINE_CLOSE) return PHASE.REGULAR_SEASON;
      return null;

    case PHASE.PLAYOFF_BRACKET_BUILD:
      // All 5 teams per division qualify — user is always in playoffs
      return PHASE.WILD_CARD;

    case PHASE.WILD_CARD:
      return PHASE.FIRST_ROUND;

    case PHASE.FIRST_ROUND:
      return PHASE.DIVISION_SERIES;

    case PHASE.DIVISION_SERIES:
      return PHASE.WORLD_SERIES;

    case PHASE.WORLD_SERIES:
      return PHASE.SEASON_SUMMARY;

    case PHASE.SEASON_SUMMARY:
      return PHASE.OFFSEASON;

    case PHASE.OFFSEASON:
      return PHASE.SPRING_TRAINING;

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MAKEUP GAME SCHEDULING
// ─────────────────────────────────────────────────────────────

/**
 * scheduleMakeupGame(schedule, postponedGameIndex)
 * Finds the next available travel day within 10 games and inserts a makeup.
 * If no travel day exists, returns a doubleheader flag on the next home game.
 *
 * @param {Object[]} schedule
 * @param {Number}   postponedGameIndex
 * @returns {Object} { makeupIndex: Number, isDoubleheader: Boolean, insertAfterIndex: Number }
 */
export function scheduleMakeupGame(schedule, postponedGameIndex) {
  const postponed = schedule[postponedGameIndex];
  if (!postponed) return null;

  const searchEnd = Math.min(postponedGameIndex + 10, schedule.length);

  // Look for a gap (travel day) — a day where no game is scheduled
  for (let i = postponedGameIndex + 1; i < searchEnd; i++) {
    const prev = schedule[i - 1];
    const curr = schedule[i];
    if (prev && curr) {
      const prevDate = new Date(prev.date);
      const currDate = new Date(curr.date);
      const dayDiff  = Math.round((currDate - prevDate) / MS_PER_DAY);
      if (dayDiff >= 2) {
        // Travel day found — insert makeup here
        return {
          makeupIndex:      i,
          isDoubleheader:   false,
          insertAfterIndex: i - 1,
          makeupDate:       _addDaysStr(prev.date, 1),
        };
      }
    }
  }

  // No travel day — flag as doubleheader on next home game after postponement
  for (let i = postponedGameIndex + 1; i < searchEnd; i++) {
    if (schedule[i] && schedule[i].isHome) {
      return {
        makeupIndex:      i,
        isDoubleheader:   true,
        insertAfterIndex: i,
        makeupDate:       schedule[i].date,
      };
    }
  }

  return null;
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
export function buildActivityFeedEntry(type, teamAbbr, text) {
  return {
    type,
    teamAbbr,
    text,
    timestamp: Date.now(),
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

    weather: {
      label:      'Clear',
      icon:       '☀️',
      scoringMod: 1.0,
    },

    fieldCondition: {
      infieldSoftness: 0.0,
      moundFirmness:   1.0,
      trackCondition:  1.0,
      temperature:     72,
    },

    status:        GAME_STATUS.SCHEDULED,
    plays:         null,
    livePlayIndex: 0,
    result:        null,
    ourScore:      null,
    theirScore:    null,
    boxScore:      null,
    recap:         null,

    // Weather delay / suspension timestamp offset
    // Set by WeatherEngine when a delay clears or a suspended game resumes.
    // tick() adds this value to play._timestamp comparisons so plays reveal
    // at the correct cadence from the resume moment rather than all firing instantly.
    _tickOffset: 0,

    // Suspension resume state
    resumeFromInning: null,
    resumeScore:      null,
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

function _addDaysStr(dateStr, days) {
  return _isoDate(_addDays(new Date(dateStr), days));
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
