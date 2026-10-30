/**
 * engine/GameEngine.js
 * The orchestrator. Owns the game loop, phase transitions, milestone checks,
 * and the offseason sequence. Every other engine is a pure function library;
 * GameEngine is the one module that calls them in the right order and tells
 * StateManager to apply the results.
 *
 * Responsibilities:
 *   - startNewGame(config)         — bootstraps a full game state from scratch
 *   - tick()                       — advances live game one play per GAME_TICK_MS
 *   - commitGame(gameIndex)        — finalizes a completed game end-to-end
 *   - getNextGame()                — returns the game the UI should be showing
 *   - checkMilestone()             — evaluates whether a milestone screen should fire
 *   - advancePhase()               — executes phase transitions
 *   - advanceClock()               — runs the league calendar: CPU games,
 *                                    roster moves, playoffs and the offseason (§70)
 *
 * Rules:
 *   - The only module that imports StateManager.
 *   - All other engines receive state as a parameter and return mutations.
 *   - GameEngine applies those mutations via StateManager.mutate().
 *   - GameEngine does NOT generate cards. CardEngine (Phase 9) does that.
 *     GameEngine assembles the context object CardEngine needs.
 *   - The weather's effect on the schedule is applied here (§102.3): every
 *     game's plan (GameWeather), postponements, suspensions and resumptions.
 */

import * as StateManager from '../store/StateManager.js';

import {
  buildFullLeague,
  LEAGUE_TEAMS,
} from './LeagueFactory.js';

import {
  generateLeagueCalendar,
  getNextPhase,
  buildActivityFeedEntry,
  pruneActivityFeed,
  _isoDate,
  _makeGameObject,
} from './SeasonEngine.js';

import {
  processCPURosterDecisions,
  computeFullStandings,
} from './LeagueEngine.js';

import {
  checkDepth,
  autoResolveSpringCuts,
  applySpringCuts,
  toggleKeeperTag,
  computePayroll,
  reconcileRoster,
  applyRosterMutation,
  defaultActiveGroup,
  pendingArrivals,
  teamRating, recordRating,
} from './RosterEngine.js';

import { rosterClock, applyDue, hasDue, callUp, cpuSalaryMove, clubBusyUntil } from './TransactionEngine.js';
import {
  seedDivision, buildBracket, prepareRound, recordGame, roundComplete, roundSeries,
  roundForPhase, nextRound, seriesGames, ROUND_PHASE, ROUND_LABEL,
} from './PlayoffEngine.js';
import { rollGameInjuries, beginInjury, clearInjuryUpdate } from './InjuryEngine.js';

import { computeOVR, computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import { STAFF_NAMES } from '../data/player-names.js';
import {
  generatePlays,
  accumulateStats,
  computeWinProbability,
  leagueNorms,
  resumeTimeline,
  rotationStarter,
} from './SimEngine.js';
import * as CardEngine from './CardEngine.js';
import { computeAllIMP, appendGameLog } from './IMPEngine.js';
import { computeSeasonPrestige, checkTurningPointEligibility, applyTurningPoint } from './PrestigeEngine.js';
import * as AllStar from './AllStarEngine.js';
import { recordOutings, starterRested, bullpenRoles } from './PitchingEngine.js';
import { chanceOfPrecip } from './WeatherForecast.js';
import { cityOf } from './WeatherMap.js';
import * as Finance from './FinanceEngine.js';
import { formatK } from './CardTokens.js';
import * as Offseason from './OffseasonEngine.js';
import * as FreeAgency from './FreeAgency.js';
import * as LeagueTrades from './LeagueTrades.js';
import { regularIndex } from './TradeEngine.js';
import * as Development from './DevelopmentEngine.js';
import { newWeatherSeed, calendarAnchor, offseasonAnchor, addCalendarEntry, springStartIso, weatherContext } from './WeatherClimate.js';
import { gameWeatherPlan, gameConditions, gameRecord, resumptionPlan, PLAN_OUTCOME } from './GameWeather.js';
import { findMakeupSlot, seriesShift, gameTeams } from './WeatherSchedule.js';

import {
  PHASE,
  GAME_STATUS,
  GAME_TICK_MS,
  GAME_DURATION_FALLBACK_MS,
  GAME_TIMES_BY_DOW,
  MILESTONE_SCREENS,
  OFFSEASON_CARD_HOUR,
  OFFSEASON_FA_CARD_HOUR,
  PLAYOFF_WILD_CARD_GAMES,
  PLAYOFF_FIRST_ROUND_BEST_OF,
  PLAYOFF_DIVISION_SERIES_BEST_OF,
  PLAYOFF_WORLD_SERIES_BEST_OF,
  REGULAR_SEASON_GAME_COUNT,
  SPRING_TRAINING_GAME_COUNT,
  ALL_STAR_BREAK_AFTER_GAME,
  ALLSTAR_SELECTION_AFTER_GAME,
  ALLSTAR_POST_GLOW_GAMES,
  ALLSTAR_GAME_BREAK_DAY,
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  STRETCH_RUN_FINAL_GAMES,
  ROSTER_LIMITS,
  PLAYER_GROUP,
  LINEUP_SLOTS,
  PRESTIGE_POINTS_PER_WIN,
  PRESTIGE_POINTS_WINNING_SEASON,
  PRESTIGE_WINNING_WIN_THRESHOLD,
  PRESTIGE_POINTS_PLAYOFF_APPEARANCE,
  PRESTIGE_POINTS_PER_PLAYOFF_ROUND_WON,
  PRESTIGE_POINTS_CHAMPIONSHIP,
  PRESTIGE_TIER_THRESHOLDS,
  WIN_TARGET_ADJ_MISS_10_PLUS,
  WIN_TARGET_ADJ_MISS_5_TO_9,
  WIN_TARGET_ADJ_MISS_1_TO_4,
  WIN_TARGET_ADJ_MET,
  WIN_TARGET_ADJ_EXCEED_3_TO_7,
  WIN_TARGET_ADJ_EXCEED_8_PLUS,
  WIN_TARGET_MET_WITHIN,
  AGE_DEVELOPMENT_WINDOWS,
  SUB_RATING_MIN,
  SUB_RATING_MAX,
  ACTIVITY_FEED_RETENTION_HOURS,
  NEW_TEAM_SEED_CARDS,
  ADVANCE_SCOUT,
  LEAGUE_TRADES,
  GAME_WEATHER,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// DEV LIVE-SPEED (Developer Menu only)
// ─────────────────────────────────────────────────────────────
// Compresses the wall-clock game clock so a live game plays out faster for
// testing. Play timestamps span a real 3-hour window from game.gameTime; tick()
// scales the elapsed time since gameTime by this factor, so the whole game plays
// in (3 hours / _liveTimeScale). Defaults to 1 (bit-identical to real time) and
// is only ever raised by the Developer Menu — the harness and shipping players
// never touch it, so their behavior is unchanged.
let _liveTimeScale = 1;

/** DEV ONLY — set the live-speed multiplier (>= 1). Called by App.setDevTimeScale. */
export function setLiveTimeScale(n) {
  _liveTimeScale = Math.max(1, Number(n) || 1);
}

/** DEV ONLY — current live-speed multiplier. */
export function getLiveTimeScale() {
  return _liveTimeScale;
}


// ─────────────────────────────────────────────────────────────
// GAME INITIALIZATION
// ─────────────────────────────────────────────────────────────

/**
 * startNewGame(config)
 * Bootstraps a complete game state for a new save slot.
 * Creates the slot in StateManager, generates the full league,
 * builds the schedule, and saves.
 *
 * config: { archetypeId, gmName, city, nickname, abbr, icon, bannerColor }
 *
 * @param {Object} config
 * @returns {Promise<String>} slotId
 */
// ─────────────────────────────────────────────────────────────
// SPRING TRAINING INVITEES
// ─────────────────────────────────────────────────────────────

/**
 * _addSpringInvitees(s)
 * Moves the top farm players into the spring roster as invitees.
 * Called at startNewGame (season 1) and at advancePhase(SPRING_TRAINING)
 * for subsequent seasons.
 *
 * Selection is position-scarcity aware:
 *   - For each position slot (C, 1B, 2B, 3B, SS, OF×3, DH, SP, RP),
 *     count how many current active+bench roster players cover it.
 *   - Rank farm players by (scarcity of their position DESC, OVR DESC).
 *   - Pick top 5 hitters and top 5 pitchers from the result.
 *
 * Mutates `s` directly (called inside StateManager.mutate).
 */
function _addSpringInvitees(s) {
  const players  = s.players;
  const farmIds  = s.userTeam.farmIds || [];
  if (!farmIds.length) return;

  // Build coverage map: how many current roster players cover each slot
  const rosterIds  = s.userTeam.rosterIds || [];
  const coverage   = {
    C:0, '1B':0, '2B':0, '3B':0, SS:0,
    OF:0, OF2:0, OF3:0, DH:0, SP:0, RP:0,
  };

  // Eligible slots per player (mirrors _eligibleSlots in TeamScreen)
  const _slots = (p) => {
    const nat = p.nativePos || p.pos;
    if (nat === 'C')      return ['C','DH'];
    if (nat === '1B')     return ['1B','DH'];
    if (nat === '2B')     return ['2B','DH'];
    if (nat === '3B')     return ['3B','DH'];
    if (nat === 'SS')     return ['SS','DH'];
    if (nat === 'OF')     return ['OF','DH'];
    if (nat === 'DH/OF')  return ['OF','DH'];
    if (nat === '2B/SS')  return ['2B','SS','DH'];
    if (nat === '1B/3B')  return ['1B','3B','DH'];
    if (nat === 'SS/OF')  return ['SS','OF','DH'];
    if (nat === '1B/OF')  return ['1B','OF','DH'];
    if (nat && nat.includes('/')) return [...new Set([...nat.split('/'),'DH'])];
    return [nat, 'DH'];
  };

  // Count coverage for each slot (treat OF as 3 separate slots)
  let ofCount = 0;
  for (const id of rosterIds) {
    const p = players[id];
    if (!p || ['SP','RP'].includes(p.pos)) continue;
    const slots = _slots(p);
    for (const slot of slots) {
      if (slot === 'OF') {
        ofCount++;
      } else if (coverage[slot] !== undefined) {
        coverage[slot]++;
      }
    }
  }
  // Distribute OF count across the 3 OF slots
  coverage['OF']  = Math.min(ofCount, 1);
  coverage['OF2'] = Math.min(Math.max(ofCount - 1, 0), 1);
  coverage['OF3'] = Math.min(Math.max(ofCount - 2, 0), 1);

  // Count SP/RP coverage from roster
  for (const id of rosterIds) {
    const p = players[id];
    if (!p) continue;
    if (p.pos === 'SP') coverage['SP']++;
    if (p.pos === 'RP') coverage['RP']++;
  }

  // Score a farm player by the scarcity of their position(s)
  // Lower coverage = higher scarcity = higher priority
  const scarcityScore = (p) => {
    const slots = _slots(p);
    // Use the minimum coverage among their eligible slots as their scarcity
    const minCov = Math.min(...slots.map(s => {
      if (s === 'OF') return (coverage['OF'] + coverage['OF2'] + coverage['OF3']) / 3;
      return coverage[s] ?? 99;
    }));
    return -minCov; // higher score = more scarce
  };

  const farmPlayers = farmIds.map(id => players[id]).filter(Boolean);

  // Split into hitters and pitchers
  const farmHitters = farmPlayers
    .filter(p => !['SP','RP'].includes(p.pos))
    .sort((a, b) => {
      const sd = scarcityScore(b) - scarcityScore(a);
      return sd !== 0 ? sd : b.ovr - a.ovr;
    });

  const farmPitchers = farmPlayers
    .filter(p => ['SP','RP'].includes(p.pos))
    .sort((a, b) => {
      const sd = scarcityScore(b) - scarcityScore(a);
      return sd !== 0 ? sd : b.ovr - a.ovr;
    });

  const inviteeHitters  = farmHitters.slice(0, ROSTER_LIMITS.SPRING_INVITEE_HITTERS);
  const inviteePitchers = farmPitchers.slice(0, ROSTER_LIMITS.SPRING_INVITEE_PITCHERS);
  const allInvitees     = [...inviteeHitters, ...inviteePitchers];

  if (!allInvitees.length) return;

  // Move invitees from farmIds → rosterIds, set flags and active group
  const inviteeIds = allInvitees.map(p => p.id);
  s.userTeam.farmIds   = farmIds.filter(id => !inviteeIds.includes(id));
  s.userTeam.rosterIds = [...rosterIds, ...inviteeIds];

  for (const p of allInvitees) {
    const isPitcher = ['SP','RP'].includes(p.pos);
    players[p.id] = {
      ...p,
      group:            isPitcher ? PLAYER_GROUP.PITCHER_BENCH : PLAYER_GROUP.BENCH_HITTERS,
      _isSpringInvitee: true,
      _isKeeper:        false,
    };
  }

  // Default: tag all existing regular roster players as keepers
  for (const id of rosterIds) {
    if (players[id] && !players[id]._isSpringInvitee) {
      players[id] = { ...players[id], _isKeeper: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// LINEUP SLOT MIGRATION
// ─────────────────────────────────────────────────────────────

/**
 * migrateLineupSlots(state)
 * One-time migration: if a team (user or CPU) is missing lineupSlots,
 * builds them from players with group === STARTING_HITTERS, then
 * changes those players' group to BENCH_HITTERS.
 *
 * Safe to call on every app load — no-ops if lineupSlots already exists.
 * Called from StateManager on load, or can be called from GameEngine.
 *
 * @param {Object} state — full app state, mutated in place
 */
export function migrateLineupSlots(state) {
  if (!state) return;

  const _migrate = (team) => {
    if (!team) return;
    // Already migrated
    if (team.lineupSlots && team.lineupSlots.length === 9) return;

    const players   = state.players || {};
    const rosterIds = team.rosterIds || [];

    // Find current STARTING_HITTERS players in position order
    const starters = rosterIds
      .map(id => players[id])
      .filter(p => p && p.group === PLAYER_GROUP.STARTING_HITTERS);

    // Build lineupSlots
    const slots     = LINEUP_SLOTS.map(slot => ({ slot, playerId: null }));
    const used      = new Set();

    for (let i = 0; i < slots.length; i++) {
      const label = slots[i].slot;
      const match = starters.find(p =>
        !used.has(p.id) && (
          p.pos === label ||
          (p.pos?.includes('/') && p.pos.split('/').includes(label))
        )
      );
      if (match) { slots[i].playerId = match.id; used.add(match.id); }
    }

    // Overflow
    for (const p of starters) {
      if (used.has(p.id)) continue;
      const empty = slots.find(s => !s.playerId);
      if (empty) { empty.playerId = p.id; used.add(p.id); }
    }

    team.lineupSlots = slots;

    // Change group from STARTING_HITTERS → BENCH_HITTERS for migrated players
    for (const id of used) {
      if (players[id]) players[id].group = PLAYER_GROUP.BENCH_HITTERS;
    }
  };

  _migrate(state.userTeam);
  for (const team of state.leagueTeams || []) {
    _migrate(team);
  }
}

export async function startNewGame(config) {
  const slotId = await StateManager.createSlot({
    archetype:   config.archetypeId,
    gmName:      config.gmName,
    city:        config.city,
    nickname:    config.nickname,
    abbr:        config.abbr,
    icon:        config.icon,
    bannerColor: config.bannerColor,
  });

  // Build the full league — all 10 teams, all rosters, farm systems
  const state    = StateManager.get();
  const uuidFn   = () => crypto.randomUUID();
  // The league's year (§70): fixed now, advanced one per season.
  const baseYear = new Date().getFullYear();
  const league   = buildFullLeague({
    archetypeId: config.archetypeId,
    seasonNum:   1,
    seasonYear:  baseYear,
    uuidFn,
    userTeam:    state.userTeam,
    region:      config.region || 'north',
    leagueOffsetOverride: config.leagueOffsetOverride ?? null,   // harness calibration only
  });

  // Generate schedules
  // Anchor the first spring training game to the next upcoming 1:05 PM:
  //   - If it's currently before 1:05 PM today, schedule for today at 1:05 PM.
  //   - If it's after 1:05 PM today, schedule for tomorrow at 1:05 PM.
  // This gives the user a game as soon as possible — hours away, not a full day.
  const now          = new Date();
  const todayAt105   = new Date();
  todayAt105.setHours(13, 5, 0, 0); // 1:05 PM local time

  const scheduleAnchor = new Date();
  scheduleAnchor.setHours(0, 0, 0, 0); // midnight of the target day
  if (now >= todayAt105) {
    // Past 1:05 PM — move to tomorrow
    scheduleAnchor.setDate(scheduleAnchor.getDate() + 1);
  }
  // If before 1:05 PM — scheduleAnchor is already today's midnight,
  // _parseGameTime will set the time to 1:05 PM on today.

  // One calendar for the whole league (§67) — the user is one of ten teams.
  const { schedule, leagueSchedule } = generateLeagueCalendar(1, league.leagueTeams, scheduleAnchor, { year: baseYear });

  // Apply everything to state in one batch
  StateManager.mutate(s => {
    // Players registry
    Object.assign(s.players, league.players);

    // User team
    s.userTeam.rosterIds   = league.rosterIds;
    s.userTeam.farmIds     = league.farmIds;
    s.userTeam.lineupSlots = league.lineupSlots;
    s.leagueTalentOffset   = league.leagueOffset ?? 0;   // §69 — league talent level
    s.baseYear             = baseYear;                   // §70 — the league's year for season 1
    s.userTeam.finances.payroll = league.payroll;

    // Populate SP rotation order from the generated roster, sorted by OVR so the
    // rotation opens with the ace (order[0] starts game 1; currentIndex advances
    // +1 per game). The Team screen shows this same order, so what you see as the
    // top of the rotation is what the sim actually starts.
    const spIds = league.rosterIds
      .filter(id => {
        const p = s.players[id];
        return p && p.group === PLAYER_GROUP.STARTING_PITCHERS;
      })
      .sort((a, b) => (s.players[b].ovr || 0) - (s.players[a].ovr || 0));
    s.userTeam.rotation = {
      order:        spIds,
      currentIndex: 0,
    };

    // League teams
    s.leagueTeams = league.leagueTeams;

    // §78: everyone on a club's active roster now is on a major-league deal
    // (paid wherever he is); the farm and the spring invitees are not.
    for (const t of [s.userTeam, ...s.leagueTeams]) {
      for (const id of t.rosterIds || []) if (s.players[id]) s.players[id].contractMLB = true;
    }

    // Add spring training invitees
    _addSpringInvitees(s);

    // Generate coaching staff names from the staff name pool.
    // Names are drawn sequentially without replacement for this franchise.
    // Contracts are set from schema defaults (already in state from schema.js).
    const staffPool = [...STAFF_NAMES].sort(() => Math.random() - 0.5);
    let staffIdx = 0;
    const pickStaffName = () => staffPool[staffIdx++] || 'Coach';

    s.userTeam.coachingStaff = {
      manager: {
        ...s.userTeam.coachingStaff?.manager,
        name:              pickStaffName(),
        salary:            225,
        contractExpiry:    s.seasonNum + 2,
        relationship:      50,
        managerConfidence: 60,
      },
      pitchingCoach: {
        ...s.userTeam.coachingStaff?.pitchingCoach,
        name:           pickStaffName(),
        salary:         125,
        contractExpiry: s.seasonNum + 2,
        relationship:   50,
      },
      hittingCoach: {
        ...s.userTeam.coachingStaff?.hittingCoach,
        name:           pickStaffName(),
        salary:         125,
        contractExpiry: s.seasonNum + 2,
        relationship:   50,
      },
      benchCoach: {
        ...s.userTeam.coachingStaff?.benchCoach,
        name:           pickStaffName(),
        salary:         75,
        contractExpiry: s.seasonNum + 2,
        relationship:   50,
      },
      bullpenCoach: {
        ...s.userTeam.coachingStaff?.bullpenCoach,
        name:           pickStaffName(),
        salary:         75,
        contractExpiry: s.seasonNum + 2,
        relationship:   50,
      },
    };

    // Owner — named so ownership cards read "{owner_name} wants…" (§60).
    s.userTeam.ownerName = pickStaffName();

    // Schedule
    s.schedule       = schedule;
    s.leagueSchedule = leagueSchedule;
    s.allStar        = AllStar.createAllStarState(s, baseYear);   // §75

    // §100 The franchise's weather: its seed, the save's clock, and where real
    // time falls on the baseball calendar.
    s.weatherSeed     = newWeatherSeed([config.city, config.nickname, config.region, Date.now()]);
    s.weatherTzMin    = -new Date().getTimezoneOffset();
    s.weatherCalendar = [];
    addCalendarEntry(s, calendarAnchor(schedule, 1, s.weatherTzMin));

    // §78 Club Funds: the market (ballpark, local revenue, ticket yield) and the
    // opening funds, from the archetype — now that the staff's salaries exist.
    Finance.initFinances(s.userTeam, {
      payrollTarget:   s.userTeam.finances.payrollTarget,
      atmosphere:      s.userTeam.atmosphere,
      startFundsShare: Finance.startFundsShareFor(config.archetypeId),
      winPct:          (s.userTeam._ownerWinTarget || 66) / REGULAR_SEASON_GAME_COUNT,
    });
    s.userTeam.finances.payroll = Finance.payrollOf(s, 'user');
    recordRating(s, Date.now());   // §95 the rating the day the GM takes over
    // §78.5 every CPU club keeps books of its own.
    for (const t of s.leagueTeams || []) Finance.initClubBooks(s, t.id);

    // Geographic region — set from setup config, persists for lifetime of franchise
    if (config.region)        s.settings.region        = config.region;
    if (config.primaryColor)  s.settings.primaryColor  = config.primaryColor;
    if (config.secondaryColor) s.settings.secondaryColor = config.secondaryColor;

    // Phase
    s.phase = PHASE.SPRING_TRAINING;

    // Initial standings
    s.standings = computeFullStandings(s);
  });

  // ── Seed the new-franchise inbox (§60) ────────────────────────────────────
  // Real card instances via the normal delivery builder (proper expiry, budget
  // cost, token context) — not the debug injector. Seeds never push-notify.
  try {
    const ctx = buildCardContext();
    CardEngine.deliverSeedCards(NEW_TEAM_SEED_CARDS, ctx);
    // One real, engine-generated trade proposal (actual players from both rosters).
    CardEngine.deliverSeedTradeOffer(ctx);
    // §86 the Recent list starts the day the club does.
    StateManager.mutate(s => {
      const at = Date.now();
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('milestone', s.userTeam.abbr, `${s.userTeam.gmName || 'A new GM'} takes over the ${s.userTeam.city} ${s.userTeam.nickname}`.trim(), at),
        buildActivityFeedEntry('milestone', s.userTeam.abbr, `Spring training opens — Season ${s.seasonNum || 1}`, at + 1)]);
    });
    // §80: the day the GM takes over is a moment of its own; then the first
    // game day's inbox is planned now — there is no game before it to plan it.
    CardEngine.deliverMomentCard('takeover', ctx, null, 'soon');
    planCardsForNextGame();
  } catch (err) {
    console.warn('[GameEngine.startNewGame] Card seeding failed:', err.message);
  }

  // Persist immediately (after seeding) so the caller's App.init reload sees the
  // seeded inbox. StateManager.load also flushes pending saves, but the new team
  // should never depend on a debounce to exist on disk.
  await StateManager.save();

  return slotId;
}

// ─────────────────────────────────────────────────────────────
// GAME LOOP — TICK
// ─────────────────────────────────────────────────────────────

/**
 * tick()
 * Called on a real-world interval (GAME_TICK_MS). Advances the live game
 * one play forward if conditions allow.
 *
 * Respects:
 *   - game.status — pauses on DELAYED, SUSPENDED, POSTPONED
 *   - the weather (§102.3): a start held up and then called off; a suspended
 *     game's turn to pick up; a suspension when its last play is revealed
 *     (delays inside a game are already on its plays' clock)
 *   - game.plays — null until SimEngine populates them (Phase 6)
 *
 * Returns the updated game object if a play was revealed, null otherwise.
 *
 * @returns {Object|null} updated game object
 */
export function tick() {
  // The roster clock runs first (§65): every trade, arrival, IL clearance and
  // roster deadline due before this moment — and never past the first pitch
  // of a game not yet played — so the game below starts with the roster it
  // really has.
  advanceClock(Date.now());
  // §80: a game day nobody planned yet (a save from before r74) gets its inbox.
  planCardsForNextGame();

  const state = StateManager.get();
  const game  = getNextGame();

  if (!game) return null;

  // §102.3 the weather's say about our game. (The league clock holds at our
  // first pitch, so what happens at or after it is decided here.)
  {
    const now = Date.now();
    const ref = { user: true, i: game.index };
    // A start the weather is holding up — then calls off.
    if (_WX_OPEN.has(game.status) && game.wx?.outcome === PLAN_OUTCOME.POSTPONED && !game.wx.resumption) {
      if (now >= game.wx.decidedAt) { _postponeGame(ref, game.wx.decidedAt); return null; }
      if (now >= game.gameTime && game.status !== GAME_STATUS.DELAYED) {
        StateManager.mutate(s => { const g = s.schedule[game.index]; if (g) g.status = GAME_STATUS.DELAYED; });
      }
      return null;
    }
    // A suspended game's turn to pick up.
    if (game.status === GAME_STATUS.SUSPENDED && now >= game.gameTime) {
      _resumeGame(ref, game.gameTime);
      return StateManager.get().schedule[game.index]?.status === GAME_STATUS.LIVE ? tick() : null;
    }
  }

  // Paused states — do not advance
  if ([GAME_STATUS.DELAYED, GAME_STATUS.SUSPENDED, GAME_STATUS.POSTPONED].includes(game.status)) {
    return null;
  }

  // Check if it's time to activate a scheduled game
  if (game.status === GAME_STATUS.SCHEDULED || game.status === GAME_STATUS.PRE_GAME_WATCH) {
    const now = Date.now();
    if (game.gameTime && now >= game.gameTime) {
      if (_wxHoldForClubs({ user: true, i: game.index }, game.gameTime)) return null;   // §102.3 game two waits for game one
      _activateGame(game);
      // Re-read game from state — _activateGame just mutated it
      // Without this, game.plays is still null on the local variable
      // and the first play would be skipped until next tick
      const freshGame = StateManager.get()?.schedule?.[game.index];
      if (!freshGame?.plays?.length) return null;
      // Fall through with fresh game reference
      return tick(); // recurse once to reveal first play with fresh state
    } else {
      return null;
    }
  }

  // No plays generated yet (shouldn't happen after _activateGame, but guard anyway)
  if (!game.plays || game.plays.length === 0) return null;

  const now          = Date.now();
  const nextPlayIdx  = game.livePlayIndex || 0;
  const nextPlay     = game.plays[nextPlayIdx];

  if (!nextPlay) {
    // All plays exhausted — game is over, pending commit
    return null;
  }

  // Reveal ALL plays whose (scaled) timestamp has passed — not just one. The
  // scaled clock compresses the 3-hour schedule by _liveTimeScale (dev speed);
  // at scale 1 this equals real time. Revealing every due play in a single tick
  // keeps the live view from lagging one play per interval at high speed (the
  // cause of the inning-batching). At scale 1 the caller's clock only advances to
  // the next play, so exactly one play reveals per call — identical to before,
  // and the harness is unaffected.
  const base      = game.gameTime || 0;
  const scaledNow = base + (now - base) * _liveTimeScale;

  let idx = game.livePlayIndex || 0;
  const startIdx = idx;
  let last = null;
  while (idx < game.plays.length) {
    const p = game.plays[idx];
    if (scaledNow < (p._timestamp || 0)) break;
    last = p;
    idx++;
  }
  if (idx === startIdx) return null; // nothing newly due

  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    g.livePlayIndex = idx;

    // Live score from the most recent revealed play carrying cumulative score.
    for (let i = idx - 1; i >= startIdx; i--) {
      const p = game.plays[i];
      if (p.cumOurScore !== undefined && p.cumOurScore !== null) {
        g.ourScore   = p.cumOurScore;
        g.theirScore = p.cumTheirScore;
        break;
      }
    }

    // Mark complete once the last play is revealed — unless the weather
    // suspended it (§102.3): then it waits for another day.
    if (idx >= game.plays.length && game.plays[game.plays.length - 1]?.type !== 'game_suspended') {
      g.status = GAME_STATUS.FINAL;
    }
  });
  if (idx >= game.plays.length && game.plays[game.plays.length - 1]?.type === 'game_suspended') {
    _suspendGame({ user: true, i: game.index }, game.plays[game.plays.length - 1]._timestamp);
  }

  return last;
}

// ─────────────────────────────────────────────────────────────
// GAME ACTIVATION — called by tick() at first pitch time
// ─────────────────────────────────────────────────────────────

/**
 * _activateGame(game)
 * Called the first time tick() fires after game.gameTime has passed.
 * Generates the full play array via SimEngine and sets status to LIVE.
 *
 * Opponent lookup: game.opponent is the team name string (e.g. "New York Empire").
 * We find the matching leagueTeam object so SimEngine has its rosterIds.
 *
 * @param {Object} game — game object from state.schedule
 */
function _activateGame(game) {
  const state       = StateManager.get();
  const now         = Date.now();
  const MAX_LIVE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

  // If the game time was more than 4 hours ago the user wasn't watching.
  // Silently simulate the result and commit without a live view.
  if (now > (game.gameTime || 0) + MAX_LIVE_WINDOW_MS) {
    _silentlyCommitGame(game);
    return;
  }

  const userTeam    = state.userTeam;
  const players     = state.players;

  // Find the opponent's league team object by name
  const opponentTeam = state.leagueTeams.find(t => t.name === game.opponent) || null;

  // Compute win probability for context (used by SimEngine for variance tuning)
  const healthyRosterIds = (userTeam.rosterIds || []).filter(id => {
    const p = players[id];
    return p && isAvailable(p);
  });

  const winProb = computeWinProbability(
    healthyRosterIds,
    opponentTeam,
    players,
    {
      morale:     userTeam.morale     || 50,
      atmosphere: userTeam.atmosphere || 50,
      game,
      phase:      state.phase,
      region:     state.settings?.region,
    }
  );

  const isSpring = game.isSpring || state.phase === PHASE.SPRING_TRAINING;
  const wx = _wxAtFirstPitch(state, game, true);   // §102.3

  const { plays, boxScore, liveLineups, resumePlays, weather } = generatePlays(
    wx ? { ...game, ...wx.record } : game,
    userTeam,
    opponentTeam,
    players,
    { phase: state.phase, isSpring, winProb, scout: _scoutFor(state, game, opponentTeam, isSpring),
      norms: leagueNorms([userTeam, ...(state.leagueTeams || [])], players), weather: wx?.sim || null }
  );

  // Write plays to state and transition to LIVE
  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    g.plays         = plays;
    g.livePlayIndex = 0;
    g.status        = GAME_STATUS.LIVE;
    if (wx) { Object.assign(g, wx.record); g.wx = wx.plan; g.wxResult = weather; }
    if (resumePlays) g.resumePlays = resumePlays;
    // Pre-computed full-game box (promoted to g.boxScore at commit) + seed lineups.
    g._precomputedBoxScore = boxScore;
    g.liveLineups          = liveLineups;
    // §78: the crowd is in the seats at first pitch (the gate is banked at the final).
    if (g.isHome && !isSpring && !g.attendance) {
      const crowd = Finance.crowdFor(s, 'user', { atMs: g.gameTime || Date.now(), playoff: !!g.isPlayoff });
      if (crowd) { g.attendance = crowd.attendance; g.gateK = crowd.gateK; g.sellout = crowd.sellout; }
    }
  });
}

// ─────────────────────────────────────────────────────────────
// SILENT COMMIT — missed game (played >4 hours ago)
// ─────────────────────────────────────────────────────────────

/**
 * _silentlyCommitGame(game)
 * Called when a game's window has passed without the user watching.
 * Generates plays, extracts the result, writes final fields, and
 * marks the game as committed — all without showing a live view.
 *
 * @param {Object} game
 */
function _silentlyCommitGame(game) {
  const state        = StateManager.get();
  const userTeam     = state.userTeam;
  const players      = state.players;
  const opponentTeam = state.leagueTeams.find(t => t.name === game.opponent) || null;

  const healthyIds = (userTeam.rosterIds || []).filter(id => {
    const p = players[id];
    return p && isAvailable(p);
  });

  const winProb = computeWinProbability(
    healthyIds, opponentTeam, players,
    { morale: userTeam.morale || 50, atmosphere: userTeam.atmosphere || 50,
      game, phase: state.phase, region: state.settings?.region }
  );

  const isSpring = game.isSpring || state.phase === PHASE.SPRING_TRAINING;
  const wx = _wxAtFirstPitch(state, game, true);   // §102.3
  const { plays, boxScore, liveLineups, resumePlays, weather } = generatePlays(
    wx ? { ...game, ...wx.record } : game, userTeam, opponentTeam, players,
    { phase: state.phase, isSpring, winProb, scout: _scoutFor(state, game, opponentTeam, isSpring),
      norms: leagueNorms([userTeam, ...(state.leagueTeams || [])], players), weather: wx?.sim || null }
  );

  // Suspended by the weather: it stands where it stopped, to be finished another day.
  if (resumePlays) {
    const sp = plays[plays.length - 1];
    StateManager.mutate(s => {
      const g = s.schedule[game.index];
      if (!g) return;
      Object.assign(g, wx.record);
      g.wx = wx.plan; g.wxResult = weather;
      g.plays = plays; g.resumePlays = resumePlays; g.livePlayIndex = plays.length;
      g.ourScore = sp?.cumOurScore ?? 0; g.theirScore = sp?.cumTheirScore ?? 0;
      g.status = GAME_STATUS.LIVE;
      g._precomputedBoxScore = boxScore;
      g.liveLineups = liveLineups;
    });
    _suspendGame({ user: true, i: game.index }, sp?._timestamp ?? Date.now());
    return;
  }

  // Extract final score from last play
  const lastPlay   = plays[plays.length - 1];
  const ourScore   = lastPlay?.cumOurScore   ?? 0;
  const theirScore = lastPlay?.cumTheirScore ?? 0;
  const outcome    = ourScore > theirScore ? 'win' : ourScore < theirScore ? 'loss' : 'tie';

  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    if (wx) { Object.assign(g, wx.record); g.wx = wx.plan; g.wxResult = weather; }
    g.plays              = plays;
    g.livePlayIndex      = plays.length; // all plays "revealed" — no live view
    g.ourScore           = ourScore;
    g.theirScore         = theirScore;
    g.status             = GAME_STATUS.FINAL;
    g._committed         = true;
    g._silentlyCommitted = true;
    g.result             = outcome;
    g.score              = { us: ourScore, them: theirScore };
    g._precomputedBoxScore = boxScore;
    g.liveLineups          = liveLineups;
  });

  // Commit asynchronously — fire and forget from tick context
  commitGame(game.index).catch(err => {
    console.error('[GameEngine._silentlyCommitGame] commit failed:', err);
  });
}

/**
 * commitGame(gameIndex)
 * Finalizes a completed game. Strict execution order:
 *
 *  1. Guard — game must be FINAL or POSTPONED
 *  2. Record update — wins/losses/streak
 *  3. Stat accumulation — player stats from box score (Phase 6+)
 *  4. Drain pending trades
 *  5. CPU day processing — simulate CPU games, update standings
 *  6. CPU roster decisions
 *  7. Waiver processing
 *  8. IL return checks
 *  9. Depth check — auto-resolve CRITICAL gaps
 * 10. Payroll recalculation
 * 11. Metric history snapshot
 * 12. Phase transition check
 * 13. Milestone check
 * 14. Save
 *
 * @param {Number} gameIndex  — index in state.schedule
 * @returns {Promise<Object>} { phaseChanged, newPhase, milestone }
 */
export async function commitGame(gameIndex) {
  const state = StateManager.get();
  const game  = state.schedule[gameIndex];

  if (!game) throw new Error(`GameEngine.commitGame: no game at index ${gameIndex}`);

  const result = { phaseChanged: false, newPhase: null, milestone: null };

  // Guard — only commit FINAL or POSTPONED games
  // Return silently rather than throwing — startTick catches errors but a throw
  // would stop the tick loop from retrying on the next cycle.
  if (![GAME_STATUS.FINAL, GAME_STATUS.POSTPONED, GAME_STATUS.MAKEUP].includes(game.status)) {
    console.warn(`GameEngine.commitGame: game ${gameIndex} not in committable state (${game.status}) — skipping`);
    return result;
  }

  // Guard — don't double-commit (silentlyCommitGame already wrote _committed)
  // Still run CPU/standings/card processing even for silent commits.
  const alreadyCommitted = game._committed && game.result && game.score;

  // The moment this game ended on the real clock (§65). For a game the GM
  // watched it is ~now; for one simulated while the app was closed it is in
  // the past, so everything it triggers is dated when it really happened.
  const endMs = Math.min(Date.now(), _gameEndMs(game));

  StateManager.mutate(s => {
    const g = s.schedule[gameIndex];

    // ── Step 0: Promote the precomputed box to the committed box ──
    // Single source of truth (SimEngine.accumulateBox). Kept after commit;
    // plays are stripped in Phase 2 once all readers use g.boxScore.
    if (g._precomputedBoxScore) g.boxScore = g._precomputedBoxScore;
    if (g.status !== GAME_STATUS.POSTPONED) g.endedAt = endMs;   // §102.3 (as the league's games keep it)

    // ── Step 1: Write final game result fields ─────────────
    // Skip if already written by _silentlyCommitGame.
    if (g.status === GAME_STATUS.POSTPONED) {
      // §102.3 a spring game the weather cancelled: closed, never played.
      g._committed = true;
      g.result     = 'postponed';
      g.score      = null;
    } else if (!alreadyCommitted) {
      const finalOurScore   = g.ourScore   ?? 0;
      const finalTheirScore = g.theirScore ?? 0;

      g._committed = true;
      g.result     = finalOurScore > finalTheirScore ? 'win'
                   : finalOurScore < finalTheirScore ? 'loss'
                   : 'tie';
      g.score      = { us: finalOurScore, them: finalTheirScore };
    }
    const wasPlayed = g.status !== GAME_STATUS.POSTPONED;

    // ── Step 1b: Win/loss record (user + opponent) ─────────
    // Gated on _recordApplied (not alreadyCommitted) so it runs exactly once for
    // BOTH watched and silently-committed games. Silent commits set _committed
    // before commitGame runs, which previously skipped this block entirely —
    // leaving both the user's and the opponent's records short a game.
    if (!g._recordApplied && (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.MAKEUP)) {
      const us = g.ourScore ?? 0, them = g.theirScore ?? 0;
      const outcome = us > them ? 'win' : us < them ? 'loss' : 'tie'; // ties only in spring

      // Spring results go to the separate spring record (Spring Training
      // Rules — LOCKED); playoff results to the postseason record and the
      // series. Only regular-season games count in the standings.
      const kind = g.isPlayoff ? 'playoff' : g.isSpring ? 'spring' : 'regular';
      _creditResult(s.userTeam, outcome, kind);

      // The opponent's record gets the mirror result — this game IS their
      // game for the date (one league calendar, §67).
      const oppRecordTeam = s.leagueTeams.find(t => t.name === g.opponent) || null;
      if (oppRecordTeam) {
        _creditResult(oppRecordTeam, outcome === 'win' ? 'loss' : outcome === 'loss' ? 'win' : 'tie', kind);
      }
      if (g.isPlayoff && s.playoffBracket) {
        _pendingSeriesResults.push({ seriesId: g.seriesId, gameId: `u-${g.index}`,
          homeId: g.isHome ? 'user' : g.opponentId, awayId: g.isHome ? g.opponentId : 'user',
          homeScore: g.isHome ? us : them, awayScore: g.isHome ? them : us, atMs: endMs });
      }

      g._recordApplied = true;
      // §86 our result goes on the Recent list (spring included).
      if (outcome !== 'tie' || g.isSpring) {
        const ua = s.userTeam.abbr, oa = oppRecordTeam?.abbr || String(g.opponent || 'OPP').slice(0, 3).toUpperCase();
        const tag = g.isPlayoff ? 'Playoffs: ' : g.isSpring ? 'Spring: ' : '';
        const line = us === them ? `${tag}${ua} and ${oa} tie ${us}–${them}`
          : us > them ? `${tag}${ua} def. ${oa} ${us}–${them}` : `${tag}${oa} def. ${ua} ${them}–${us}`;
        s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('result', ua, line, endMs)]);
      }
    }

    // ── Step 1b: the gate (§78) — a home game's crowd pays (not in spring).
    if (!g.isSpring && !g._gateApplied && g.status !== GAME_STATUS.POSTPONED) {
      g._gateApplied = true;
      if (g.isHome) {
        const crowd = g.attendance ? { attendance: g.attendance, gateK: g.gateK, sellout: !!g.sellout } : null;
        const gate = Finance.homeGate(s, 'user', { atMs: _gameEndMs(g), playoff: !!g.isPlayoff, crowd });
        if (gate) { g.attendance = gate.attendance; g.gateK = gate.gateK; g.sellout = gate.sellout; }
      } else {
        // §78.5 on the road, the home club's crowd pays the home club.
        const host = (s.leagueTeams || []).find(t => t.name === g.opponent);
        if (host?.finances) Finance.homeGate(s, host.id, { atMs: _gameEndMs(g), playoff: !!g.isPlayoff });
      }
    }

    // ── Step 1c: Stat accumulation from plays ──────────────
    // Gated on its own flag (like _recordApplied): a silently committed game
    // arrives here with _committed already set and must still credit stats.
    if (!g._statsApplied && g.plays && g.plays.length > 0) {
      g._statsApplied = true;
      const opponentTeam = s.leagueTeams.find(t => t.name === g.opponent) || null;
      const statKey = g.isPlayoff ? 'postseasonStats' : g.isSpring ? 'springStats' : 'stats';
      const statMutations = accumulateStats(
        g.plays, s.userTeam, opponentTeam, s.players, statKey
      );

      // Apply merged stat lines to each player.
      // accumulateStats already merged current + delta — assign directly.
      for (const [playerId, mutation] of Object.entries(statMutations.players || {})) {
        if (!s.players[playerId]) continue;
        s.players[playerId][statKey] = mutation[statKey];
      }
      // §76: each pitcher's outing goes on his arm's record (rest for the next games).
      recordOutings(s, g.plays, _playsEndMs(g));

      // IMP game log — append this game's stat delta (not lifetime totals)
      // to each player's rolling log for hot/cold calculation.
      // We need just the per-game delta, so collect it before merging above.
      const perGameDeltas = {}; // { [playerId]: { [stat]: delta } }
      for (const play of g.plays) {
        if (!play._statDeltas || play._reverted || play.type === 'pinch_hit') continue;
        for (const [playerId, statList] of Object.entries(play._statDeltas)) {
          if (!perGameDeltas[playerId]) perGameDeltas[playerId] = {};
          for (const { stat, delta } of statList) {
            perGameDeltas[playerId][stat] = (perGameDeltas[playerId][stat] || 0) + delta;
          }
        }
      }
      for (const [playerId, gameStats] of Object.entries(perGameDeltas)) {
        const player = s.players[playerId];
        if (!player) continue;
        const logResult = appendGameLog(player, gameIndex, g.date || '', gameStats);
        s.players[playerId]._impGameLog = logResult._impGameLog;
      }
    }

    // ── Step 2: Advance game index ─────────────────────────
    s.currentGameIndex = gameIndex + 1;

    // ── Step 2b: Advance SP rotation ──────────────────────
    // Rotate to next SP so each game uses the correct starter in order.
    // (A rained-out game was never played: nobody's turn passes, nobody's absence counts down.)
    // (§102.5 a bullpen game the GM chose keeps the rotation on schedule.)
    if (wasPlayed && !g.keepRotation && s.userTeam.rotation?.order?.length > 0) {
      s.userTeam.rotation.currentIndex =
        (s.userTeam.rotation.currentIndex + 1) % s.userTeam.rotation.order.length;
    }
    // The opponent's rotation turns over too (it used to stand still, so the
    // user always faced the same starter).
    if (wasPlayed) _advanceRotation(s.leagueTeams.find(t => t.name === g.opponent));
    // §71: players away (rest, illness, training, benched) and playing-hurt
    // conditions count down one game; whoever is back gets his spot back.
    if (wasPlayed) Development.countGame(s, 'user');
    const oppTeam = s.leagueTeams.find(t => t.name === g.opponent);
    if (oppTeam && wasPlayed) Development.countGame(s, oppTeam.id);

    // (Trades, arrivals and IL clearances are no longer tied to a commit —
    //  they run on the real-time roster clock: advanceClock(), §65.)

    // ── Step 5: Reconcile roster invariants ────────────────
    // After trades/IL returns, restore lineup + rotation integrity: pull any
    // injured/departed player out of a lineup slot or the rotation and backfill
    // from the active roster (bench → slot, pitcher-bench → rotation). Call-ups
    // and waivers are GM decisions, so for the user reconcile only REPORTS the
    // need (pendingCallups/pendingSurplus) — it does not auto-move farm players.
    // (CPU teams are reconciled with autoManage inside processCPURosterDecisions.)
    const reconcileMut = reconcileRoster(s, 'user');
    applyRosterMutation(s, reconcileMut);

    // ── Step 6: Payroll recalculation ──────────────────────
    s.userTeam.finances.payroll = computePayroll(s);

    // ── Step 6b: IMP game log — append this game's stats ───
    // Append stat increments for each player who appeared in this game
    // (play._statDeltas handles this via accumulateStats — log appended here)
    // IMPEngine.appendGameLog called per player by accumulateStats caller
    // Full IMP recompute happens below after all mutations are applied.    // ── Step 7: the rating's history (§95) ────────────────
    recordRating(s, Date.now());

    // ── Step 8: Strip per-game play data (§8.1) ────────────
    // All play-dependent processing is done; game.boxScore holds the
    // self-contained committed box. Drop the heavy fields so state does
    // not grow across the season.
    const gCommitted = s.schedule[gameIndex];
    if (gCommitted && gCommitted.boxScore) {
      delete gCommitted.plays;
      delete gCommitted._precomputedBoxScore;
      delete gCommitted.liveLineups;
    }
  });

  // ── CPU processing (outside main mutate for clarity) ────
  const dateStr = game.date;

  // (CPU games are real games on the league clock — advanceClock, §67.)
  const cpuRosterMutations = processCPURosterDecisions(StateManager.get(), dateStr, endMs);
  StateManager.mutate(s => _applyMutations(s, cpuRosterMutations));

  // (Waivers run on the roster clock: 72-hour claim window, §65 / §20.2.)

  // ── Update standings ──────────────────────────────────────
  StateManager.mutate(s => {
    s.standings = computeFullStandings(s);
  });


  // ── Recompute IMP scores for all active players ────────────
  const impMutations = computeAllIMP(StateManager.get(), gameIndex);
  StateManager.mutate(s => {
    s.impScores = impMutations.impScores;
  });

  // ── Phase transition check ────────────────────────────────
  const state2      = StateManager.get();
  // getNextPhase takes the RAW schedule index and derives the regular-relative
  // index internally. (Previously the caller pre-subtracted the spring count and
  // getNextPhase subtracted again — a double-subtraction that fired spring→regular
  // ~10 games late and never reached the playoffs.)
  // All teams always qualify — userInPlayoffs always true (Section 26)
  const currentPhase = state2.phase;
  let newPhase = null;

  // Spring → season, All-Star break, trade deadline follow the user's game
  // count. The end of the regular season and every playoff round are LEAGUE
  // events (all teams' games), driven by the clock in _seasonProgress (§68).
  newPhase = getNextPhase(currentPhase, gameIndex, state2.standings, true);

  if (newPhase) {
    await advancePhase(newPhase);
    result.phaseChanged = true;
    result.newPhase     = newPhase;
  }

  // ── Injuries (all ten teams) + the roster clock up to the final out (§65) ──
  // The players who took the field today risk injury; then every roster move
  // due by the end of this game happens, and the inbox is brought in line.
  // Runs AFTER the phase transition so Opening Day rosters are reconciled
  // under the 28-man rule on the day they become legal rosters.
  let injuryEvents = [];
  if (game.status !== GAME_STATUS.POSTPONED) {
    const st  = StateManager.get();
    const inj = rollGameInjuries(st, _appearances(st, gameIndex), endMs);
    if (Object.keys(inj.players).length) {
      StateManager.mutate(s => {
        for (const [id, upd] of Object.entries(inj.players)) Object.assign(s.players[id], upd);
      });
    }
    injuryEvents = inj.events.map(e => ({ ...e, atMs: endMs }));
  }
  advanceClock(endMs, { events: injuryEvents, reconcileAll: true });

  // ── All-Star Game (§75): host, rosters, the host's week ────
  if (game.status !== GAME_STATUS.POSTPONED) _allStarProgress(StateManager.get().schedule[gameIndex], endMs);

  // ── Milestone check ───────────────────────────────────────
  const milestone = checkMilestone();
  if (milestone) result.milestone = milestone;

  // ── CardEngine — process followups, then deliver new cards ────
  // processFollowupQueue fires any queued follow-up cards whose atGame was reached.
  // checkAndDeliver selects and delivers new cards based on current context.
  CardEngine.processFollowupQueue();
  planCardsForNextGame();

  // (Rainouts are made up when they're called — §102.3 _postponeGame.)

  await StateManager.save();
  return result;
}

// ─────────────────────────────────────────────────────────────
// NEXT GAME
// ─────────────────────────────────────────────────────────────

/**
 * getNextGame()
 * Returns the next game the UI should be showing.
 * Priority: LIVE > SUSPENDED > PRE_GAME_WATCH > SCHEDULED
 *
 * @returns {Object|null} game object
 */
/**
 * planCardsForNextGame()
 * §80: plans the inbox for the next game day exactly once — its pre-game,
 * in-game and between-games cards (CardEngine.checkAndDeliver). Called at the
 * final of the game before, at team creation, and on every tick (a no-op once
 * that game is planned), so no game day — the very first included — goes by
 * with an empty inbox.
 */
export function planCardsForNextGame() {
  const state = StateManager.get();
  if (!state?.schedule?.length || state.offseason) return;
  const g = getNextGame();
  if (!g || g._committed) return;
  const key = `${state.seasonNum ?? 1}|${g.index ?? ''}|${g.date ?? ''}`;
  if (state.cardPlanKey === key) return;
  StateManager.mutate(s => { s.cardPlanKey = key; });
  const ctx = buildCardContext();
  CardEngine.checkAndDeliver(ctx);

  // §80 First moments: the season's first spring game (and, after the first
  // season, the day camp opens) and Opening Day each bring a card of their own.
  const played = (pred) => (state.schedule || []).some(x => x._committed && pred(x));
  if (g.isSpring && !played(x => x.isSpring)) {
    if ((state.seasonNum || 1) > 1) CardEngine.deliverMomentCard('camp_open', ctx, g, 'soon');
    CardEngine.deliverMomentCard('spring_opener', ctx, g, 'pregame');
  } else if (!g.isSpring && !g.isPlayoff && !played(x => !x.isSpring && !x.isPlayoff)) {
    CardEngine.deliverMomentCard('opening_day', ctx, g, 'pregame');
  }
}

export function getNextGame() {
  const state = StateManager.get();
  if (!state.schedule || state.schedule.length === 0) return null;

  const idx   = state.currentGameIndex || 0;
  const game  = state.schedule[idx];
  if (!game) return null;

  // Return the game at currentGameIndex unless it's already final
  if (game.status === GAME_STATUS.FINAL || game.status === GAME_STATUS.MAKEUP) {
    // Look for the next non-final game
    for (let i = idx; i < state.schedule.length; i++) {
      if (![GAME_STATUS.FINAL, GAME_STATUS.MAKEUP].includes(state.schedule[i].status)) {
        return state.schedule[i];
      }
    }
    return null;
  }

  return game;
}

// ─────────────────────────────────────────────────────────────
// PHASE TRANSITION
// ─────────────────────────────────────────────────────────────

/**
 * advancePhase(newPhase)
 * Executes all side effects of a phase transition.
 *
 * @param {String} newPhase
 * @returns {Promise<void>}
 */
export async function advancePhase(newPhase) {
  _applyPhase(newPhase);
  await StateManager.save();
}

/**
 * _applyPhase(newPhase)
 * The side effects of entering a phase — synchronous, so the league clock
 * (advanceClock) can move the season forward in time order (§68). Phase
 * milestones with no game trigger are queued for the App to show.
 */
function _applyPhase(newPhase) {
  const state = StateManager.get();
  const fromPhase = state.phase;

  StateManager.mutate(s => {
    s.phase = newPhase;
  });

  switch (newPhase) {
    case PHASE.SPRING_TRAINING:
      // Add spring invitees from farm — fires each season (not just season 1)
      StateManager.mutate(s => {
        _addSpringInvitees(s);
      });
      break;

    case PHASE.REGULAR_SEASON: {
      // Opening Day only (§65): the regular season is re-entered after the
      // trade deadline and must not re-run spring cuts. Cuts count the ACTIVE
      // roster — players on the IL keep their 40-man spot, not a 28-man one.
      // applySpringCuts reads _isKeeper flags directly; autoResolveSpringCuts
      // handles the case where none are tagged.
      if (fromPhase !== PHASE.SPRING_TRAINING) break;
      const preState = StateManager.get();
      const activeIds = preState.userTeam.rosterIds.filter(id => preState.players[id]?.group !== PLAYER_GROUP.IL);
      if (activeIds.length + pendingArrivals(preState, 'user').length > ROSTER_LIMITS.ACTIVE_TOTAL) {
        const anyTagged = preState.userTeam.rosterIds.some(
          id => preState.players[id]?._isKeeper
        );
        const cutMutations = anyTagged
          ? applySpringCuts(preState)
          : autoResolveSpringCuts(preState);
        StateManager.mutate(s => _applyMutations(s, cutMutations));
      }
      break;
    }

    case PHASE.ALL_STAR_BREAK:
      // Activity feed entry
      StateManager.mutate(s => {
        s.activityFeed = pruneActivityFeed([
          ...s.activityFeed,
          buildActivityFeedEntry('milestone', s.userTeam.abbr, 'All-Star Break begins'),
        ]);
      });
      break;

    case PHASE.OFFSEASON:
      // The offseason's work runs on the clock (§70, _runOffseasonStep).
      break;

    case PHASE.SEASON_SUMMARY: {
      // Compute prestige for the completed season
      const state3 = StateManager.get();
      const bracket = state3.playoffBracket;
      const wonChampionship = bracket?.champion?.id === 'user';
      const playoffRoundsWon = _countPlayoffRoundsWon(state3);
      const winTarget = state3.userTeam._ownerWinTarget || 75;
      const wins      = state3.userTeam.wins || 0;
      const winTargetMet = Math.abs(wins - winTarget) <= (WIN_TARGET_MET_WITHIN || 5);
      const winTargetExceededBy = Math.max(0, wins - winTarget);

      const { mutations: prestigeMutations, events: prestigeEvents } =
        computeSeasonPrestige(state3, {
          wins,
          losses:              state3.userTeam.losses || 0,
          playoffRoundsWon,
          wonChampionship,
          hostedAllStar:       !!state3.userTeam._hostedAllStarThisSeason,
          turningPointAchieved: false,
          winTargetMet,
          winTargetExceededBy,
        });

      StateManager.mutate(s => {
        s.prestigeScore   = prestigeMutations.prestigeScore;
        s.prestigeTier    = prestigeMutations.prestigeTier;
        s.prestigeHistory = prestigeMutations.prestigeHistory;
        if (prestigeMutations.franchiseLegendFired) s.franchiseLegendFired = true;
        if (prestigeMutations.userTeam?._ownerWinTarget) {
          s.userTeam._ownerWinTarget = prestigeMutations.userTeam._ownerWinTarget;
        }
        s.userTeam._hostedAllStarThisSeason = false;
        s.activityFeed = pruneActivityFeed([
          ...s.activityFeed,
          buildActivityFeedEntry('milestone', s.userTeam.abbr, 'Season complete'),
        ]);

        // ── Franchise history: season final record ─────────────────────────
        const losses    = s.userTeam.losses || 0;
        const aboveBelow = wins > losses
          ? `${wins - losses} games above .500`
          : wins < losses
            ? `${losses - wins} games below .500`
            : 'exactly .500';
        s.history = [...(s.history || []), {
          id:       crypto.randomUUID(),
          type:     'record',
          season:   s.seasonNum || 1,
          gameIdx:  s.currentGameIndex || 0,
          headline: `Season ${s.seasonNum || 1} final: ${wins}–${losses}`,
          detail:   `Finished ${wins}–${losses} (${aboveBelow}). Win target was ${winTarget} wins.`,
          playerId: null,
          icon:     '📊',
          userNote: '',
        }];

        // ── Franchise history: championship ────────────────────────────────
        if (wonChampionship) {
          s.history = [...s.history, {
            id:       crypto.randomUUID(),
            type:     'championship',
            season:   s.seasonNum || 1,
            gameIdx:  s.currentGameIndex || 0,
            headline: `World Series Champions — Season ${s.seasonNum || 1}`,
            detail:   `The ${s.userTeam.city} ${s.userTeam.nickname} won the World Series in Season ${s.seasonNum || 1} with a ${wins}–${losses} record.`,
            playerId: null,
            icon:     '🏆',
            userNote: '',
          }];
        }
      });

      // Check Franchise Turning Point
      if (checkTurningPointEligibility(StateManager.get())) {
        const tpMutations = applyTurningPoint(StateManager.get());
        StateManager.mutate(s => { s.turningPointFired = tpMutations.turningPointFired; });
      }

      // Queue prestige advancement and Franchise Legend cards
      prestigeEvents.forEach(event => {
        if (event.type === 'PRESTIGE_TIER_ADVANCED' || event.type === 'FRANCHISE_LEGEND') {
          StateManager.mutate(s => {
            s.followupQueue = [...(s.followupQueue || []), {
              type:    event.type,
              atGame:  s.currentGameIndex || 0,
              payload: event,
            }];

            // ── Franchise history: prestige tier advancement ───────────────
            if (event.type === 'PRESTIGE_TIER_ADVANCED') {
              s.history = [...(s.history || []), {
                id:       crypto.randomUUID(),
                type:     'prestige',
                season:   s.seasonNum || 1,
                gameIdx:  s.currentGameIndex || 0,
                headline: `Reached ${event.toName} — Tier ${event.toTier}`,
                detail:   `Franchise advanced from ${event.fromName} (Tier ${event.fromTier}) to ${event.toName} (Tier ${event.toTier}) after Season ${s.seasonNum || 1}.`,
                playerId: null,
                icon:     '⭐',
                userNote: '',
              }];
            }

            // ── Franchise history: Franchise Legend ───────────────────────
            if (event.type === 'FRANCHISE_LEGEND') {
              s.history = [...(s.history || []), {
                id:       crypto.randomUUID(),
                type:     'milestone',
                season:   s.seasonNum || 1,
                gameIdx:  s.currentGameIndex || 0,
                headline: 'Franchise Legend achieved',
                detail:   `The franchise reached Dynasty status and won the championship in Season ${s.seasonNum || 1}. A legacy complete.`,
                playerId: null,
                icon:     '🌟',
                userNote: '',
              }];
            }
          });
        }
      });
      break;
    }

    default:
      break;
  }

  _queuePhaseMilestones(newPhase);
}

// ─────────────────────────────────────────────────────────────
// MILESTONE CHECK
// ─────────────────────────────────────────────────────────────

/**
 * checkMilestone()
 * Evaluates whether a milestone screen should fire at the current
 * phase and game index. Returns the milestone definition if it should
 * fire and hasn't been seen, null otherwise.
 *
 * @returns {Object|null} milestone definition from MILESTONE_SCREENS
 */
/**
 * _checkSeriesMilestone(state)
 * Returns a SERIES_WON / SERIES_LOST / SERIES_SPLIT milestone when the most
 * recently committed game is the FINAL game of a multi-game series, with the
 * outcome derived from the user's record across that series. Otherwise null.
 * Fires once per series (guarded by _seriesMilestoneFired on the last game).
 */
function _checkSeriesMilestone(state) {
  const schedule = state.schedule || [];
  const idx = (state.currentGameIndex || 0) - 1; // the game that just committed
  const g   = schedule[idx];
  if (!g || !g._committed || g._seriesMilestoneFired) return null;

  const opp = g.opponent;
  if (!opp) return null;

  // Last game of the series? (next scheduled game is a different opponent, or
  // the schedule ends / crosses the spring↔regular boundary).
  const next = schedule[idx + 1];
  if (next && next.opponent === opp && !!next.isSpring === !!g.isSpring) return null;

  // Walk back over the consecutive same-opponent block to tally the series.
  let wins = 0, losses = 0, count = 0;
  for (let j = idx; j >= 0; j--) {
    const gj = schedule[j];
    if (!gj || !gj._committed || gj.opponent !== opp || !!gj.isSpring !== !!g.isSpring) break;
    count++;
    if (gj.result === 'win')  wins++;
    else if (gj.result === 'loss') losses++;
  }
  if (count < 2) return null; // a single game isn't a series

  const id = wins > losses ? 'SERIES_WON'
           : wins < losses ? 'SERIES_LOST'
           : 'SERIES_SPLIT';

  // Fire once for this series.
  StateManager.mutate(s => {
    const sg = s.schedule[idx];
    if (sg) sg._seriesMilestoneFired = true;
  });

  const base = MILESTONE_SCREENS[id];
  return {
    ...base,
    subtitle: `${wins}–${losses} vs ${opp}. ${base.subtitle}`,
  };
}

export function checkMilestone() {
  // Milestones queued by league events (playoff rounds, series results,
  // season over, champions — §68) come first, one per call.
  if ((StateManager.get().milestoneQueue || []).length) {
    let m = null;
    StateManager.mutate(s => { m = s.milestoneQueue.shift(); });
    return m;
  }
  const state       = StateManager.get();
  const phase       = state.phase;
  const gameIndex   = (state.currentGameIndex || 0) - SPRING_TRAINING_GAME_COUNT;
  const seasonNum   = state.seasonNum;
  // Seen per season: Opening Day, the deadline etc. happen every year.
  const seenSet     = new Set((state.seenMilestones || []).filter(k => k.endsWith(`@${seasonNum}`)).map(k => k.split('@')[0]));

  // Series-result screens fire at the end of each series (recurring — NOT
  // seen-gated), with the correct Won/Lost/Split outcome. Handled before the
  // generic loop, which skips them (isSeries).
  const seriesMilestone = _checkSeriesMilestone(state);
  if (seriesMilestone) return seriesMilestone;

  for (const milestone of Object.values(MILESTONE_SCREENS)) {
    if (milestone.isSeries) continue; // series screens handled above, not seen-gated
    // A milestone with neither a phase nor a game trigger has no defined "when",
    // so it must be fired explicitly by game logic — never by this generic scan.
    // (Previously these fired on game 1: SERIES_WON, then SEASON_OVER, etc.)
    // Only game-index milestones are polled here. Phase milestones without a
    // game trigger are queued once, when the phase is entered
    // (_queuePhaseMilestones, §68) — polling them re-fired them on every load.
    if (milestone.triggerGame === null || milestone.triggerGame === undefined) continue;
    if (seenSet.has(milestone.id)) continue;
    if (milestone.triggerPhase && milestone.triggerPhase !== phase) continue;
    if (milestone.triggerGame !== null && milestone.triggerGame !== undefined
        && milestone.triggerGame !== gameIndex) continue;
    if (milestone.minSeason && seasonNum < milestone.minSeason) continue;
    if (milestone.requiresHosting && !state.userTeam?._hostedAllStar) continue;

    // Milestone fires — mark as seen
    StateManager.mutate(s => {
      if (!s.seenMilestones.includes(`${milestone.id}@${seasonNum}`)) {
        s.seenMilestones.push(`${milestone.id}@${seasonNum}`);
      }
    });

    // Resolve template strings
    const resolved = { ...milestone };
    if (resolved.title?.includes('{N}')) {
      resolved.title = resolved.title.replace('{N}', String(seasonNum));
    }

    return resolved;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// CARD CONTEXT ASSEMBLY
// ─────────────────────────────────────────────────────────────

/**
 * buildCardContext()
 * Assembles the situational context object CardEngine needs to
 * select which cards fire and resolve their tokens.
 *
 * CardEngine (Phase 9) calls this before checkAndDeliver().
 * GameEngine does not generate cards — it just provides the context.
 *
 * @returns {Object} context
 */
export function buildCardContext() {
  const state    = StateManager.get();
  const userTeam = state.userTeam;
  const game     = getNextGame();

  const regularIdx = Math.max(0, (state.currentGameIndex || 0) - SPRING_TRAINING_GAME_COUNT);

  // ── Series / schedule context ─────────────────────────────────────────────
  const schedule      = state.schedule || [];
  const currentIdx    = state.currentGameIndex || 0;
  const nextGame      = getNextGame();
  const prevGame      = schedule[currentIdx - 1] || null;

  // Series position — count consecutive games vs same opponent/home/away
  let seriesPosition = 1;
  let seriesLength   = 1;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const g = schedule[i];
    if (!g || g.opponent !== nextGame?.opponent || g.isHome !== nextGame?.isHome) break;
    seriesPosition++;
  }
  for (let i = currentIdx + 1; i < schedule.length; i++) {
    const g = schedule[i];
    if (!g || g.opponent !== nextGame?.opponent || g.isHome !== nextGame?.isHome) break;
    seriesLength++;
  }
  seriesLength += seriesPosition - 1;

  // Home stand / road trip tracking
  let consecutiveHomeGames = 0;
  let consecutiveRoadGames = 0;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const g = schedule[i];
    if (!g || g.isSpring) break;
    if (nextGame?.isHome && g.isHome) consecutiveHomeGames++;
    else if (!nextGame?.isHome && !g.isHome) consecutiveRoadGames++;
    else break;
  }
  const isHomeStandOpener = consecutiveHomeGames === 0 && nextGame?.isHome && !nextGame?.isSpring;
  const isHomeStandCloser = nextGame?.isHome && !nextGame?.isSpring &&
    schedule[currentIdx + 1] && !schedule[currentIdx + 1].isHome;
  const isRoadTripOpener  = consecutiveRoadGames === 0 && !nextGame?.isHome && !nextGame?.isSpring;
  const isRoadTripCloser  = !nextGame?.isHome && !nextGame?.isSpring &&
    schedule[currentIdx + 1] && schedule[currentIdx + 1].isHome;

  // Travel day — gap in schedule with no game
  const isTravelDay = !!prevGame && !!nextGame && prevGame.opponent !== nextGame.opponent &&
    prevGame.isHome !== nextGame.isHome;

  const daysUntilNextGame = nextGame
    ? Math.max(0, Math.round((nextGame.gameTime - Date.now()) / 86_400_000))
    : 0;
  const daysSinceLastGame = prevGame
    ? Math.max(0, Math.round((Date.now() - prevGame.gameTime) / 86_400_000))
    : 0;

  // Division opponent check
  const divisionTeamIds = (state.leagueTeams || [])
    .filter(t => t.divisionId === state.userTeam?.divisionId)
    .map(t => t.name);
  const isDivisionOpponent = divisionTeamIds.includes(nextGame?.opponent);

  // Standings context
  const standings    = state.standings || {};
  const divStandings = state.userTeam?.divisionId === 'B' ? standings.divB : standings.divA;
  const userSeed     = (divStandings || []).find(t => t.id === 'user')?.seed || 3;
  const gamesBack    = (divStandings || []).find(t => t.id === 'user')?.gb || '-';
  const playoffPosition = userSeed === 1 ? 'leading'
    : userSeed <= 3 ? 'wildcard' : 'out';

  const daysUntilDeadline = regularIdx < TRADE_DEADLINE_OPEN
    ? TRADE_DEADLINE_OPEN - regularIdx
    : null;

  return {
    // Phase & timing
    phase:              state.phase,
    seasonNum:          state.seasonNum,
    gameIndex:          state.currentGameIndex || 0,
    regularSeasonIndex: regularIdx,
    isSpringTraining:   state.phase === PHASE.SPRING_TRAINING,
    isTradeDeadline:    regularIdx >= TRADE_DEADLINE_OPEN && regularIdx <= TRADE_DEADLINE_CLOSE,
    isStretchRun:       regularIdx >= (REGULAR_SEASON_GAME_COUNT - STRETCH_RUN_FINAL_GAMES),
    isOffseason:        state.phase === PHASE.OFFSEASON,

    // Series context
    seriesPosition,
    seriesLength,
    isDivisionOpponent,
    upcomingOpponent:   nextGame?.opponent || null,

    // Home stand / road trip
    isHomeStandOpener,
    isHomeStandCloser,
    isRoadTripOpener,
    isRoadTripCloser,
    consecutiveHomeGames,
    consecutiveRoadGames,
    isTravelDay,

    // Between-games timing
    daysUntilNextGame,
    daysSinceLastGame,

    // Recent performance
    streak:             state.userTeam?.streak || 0,
    lastGameResult:     prevGame?.result || null,

    // Season context
    gamesBack,
    playoffPosition,
    userSeed,
    daysUntilDeadline,

    // Team soft metrics
    morale:             userTeam.morale,
    atmosphere:         userTeam.atmosphere,
    ownerTrust:         userTeam.ownerTrust,
    managerConfidence:  userTeam.managerConfidence,
    groundskeeperRel:   userTeam.groundskeeperRelationship,

    // Finances
    payroll:            userTeam.finances.payroll,
    payrollTarget:      Finance.seasonTarget(userTeam.finances),
    funds:              userTeam.finances.funds,                        // §78 Club Funds
    payrollHeadroom:    Finance.seasonTarget(userTeam.finances) - (userTeam.finances.payroll || 0),
    ownerStage:         userTeam.finances.owner?.stage || 'content',

    // Record
    wins:               userTeam.wins,
    losses:             userTeam.losses,
    winTarget:          userTeam._ownerWinTarget || 75,
    gamesAboveTarget:   userTeam.wins - (userTeam._ownerWinTarget || 75),

    // Roster
    rosterIds:          userTeam.rosterIds,
    farmIds:            userTeam.farmIds || [],
    depthIssues:        checkDepth(state),
    ilReturnQueue:      state.ilReturnQueue || [],

    // Upcoming game
    nextGame:           game,
    nextGameDate:       game?.date || null,
    nextGameOpponent:   game?.opponent || null,
    nextGameIsHome:     game?.isHome  || false,

    // Standings
    standings:          state.standings || {},

    // Prestige
    prestigeScore:      state.prestigeScore || 0,
    prestigeTier:       state.prestigeTier  || 1,

    // League
    leagueTeams:        state.leagueTeams,
    gmRelationships:    userTeam.gmRelationships || {},
    waiverPool:         state.waiverPool || [],

    // Inbox
    inboxCount:         (state.inbox || []).length,
    pendingFollowups:   (state.followupQueue || []).filter(f => f.atGame <= (state.currentGameIndex || 0)),

    // Full state reference (read-only — CardEngine must not mutate directly)
    _state: state,
  };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _applyMutations(state, mutations)
 * Merges a mutations object returned by a pure engine function
 * into the live state object inside a mutate() call.
 */
function _applyMutations(state, mutations) {
  if (!mutations) return;

  for (const [key, value] of Object.entries(mutations)) {
    if (key === 'players' && value && typeof value === 'object') {
      // Merge player updates rather than replace the whole registry
      for (const [playerId, updates] of Object.entries(value)) {
        if (state.players[playerId]) {
          Object.assign(state.players[playerId], updates);
        } else {
          state.players[playerId] = updates;
        }
      }
    } else if (key === 'userTeam' && value && typeof value === 'object') {
      Object.assign(state.userTeam, value);
      // Handle nested objects
      if (value.finances) Object.assign(state.userTeam.finances, value.finances);
    } else {
      state[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// RESULTS + CPU GAMES ON THE LEAGUE CLOCK (§67)
// ─────────────────────────────────────────────────────────────

/**
 * Credit a W/L/T to a team. kind: 'regular' (standings), 'spring' (separate
 * spring record), 'playoff' (postseason record).
 */
function _creditResult(team, outcome, kind) {
  if (!team) return;
  if (kind === 'playoff') {
    if (outcome === 'win') team.postseasonWins   = (team.postseasonWins   || 0) + 1;
    else                   team.postseasonLosses = (team.postseasonLosses || 0) + 1;
    return;
  }
  if (kind === 'spring') {
    if (outcome === 'win')       team.springWins   = (team.springWins   || 0) + 1;
    else if (outcome === 'loss') team.springLosses = (team.springLosses || 0) + 1;
    else                         team.springTies   = (team.springTies   || 0) + 1;
    return;
  }
  if (outcome === 'win') {
    team.wins   = (team.wins || 0) + 1;
    team.streak = Math.max(0, team.streak || 0) + 1;
  } else if (outcome === 'loss') {
    team.losses = (team.losses || 0) + 1;
    team.streak = Math.min(0, team.streak || 0) - 1;
  } else {
    team.ties = (team.ties || 0) + 1;
  }
}

function _advanceRotation(team) {
  const r = team?.rotation;
  if (r?.order?.length) r.currentIndex = ((r.currentIndex || 0) + 1) % r.order.length;
}

/** The moment a game with generated plays ends (its last play). */
function _playsEndMs(game) {
  const last = game?.plays?.[game.plays.length - 1];
  return last && Number.isFinite(last._timestamp)
    ? last._timestamp
    : (game.gameTime || 0) + GAME_DURATION_FALLBACK_MS;
}

// ─────────────────────────────────────────────────────────────
// WEATHER ON THE SCHEDULE (§102.3) — every game's weather plan, and
// what the schedule does when the weather stops a game
// ─────────────────────────────────────────────────────────────

const _WX_PLAN_AHEAD_MS = GAME_WEATHER.PLAN_AHEAD_MIN * 60_000;
const _WX_OPEN = new Set([GAME_STATUS.SCHEDULED, GAME_STATUS.PRE_GAME_WATCH, GAME_STATUS.DELAYED]);

/** A game ref: ours by schedule position, the league's by id. → { g, isUser, date, i } */
function _wxResolve(s, ref) {
  if (ref.user) return { g: s.schedule[ref.i], isUser: true, i: ref.i };
  for (const [date, games] of Object.entries(s.leagueSchedule?.dayMap || {})) {
    const i = games.findIndex(x => x.id === ref.id);
    if (i >= 0) return { g: games[i], isUser: false, date, i };
  }
  return { g: null };
}
const _wxRefOf = (g, isUser) => (isUser ? { user: true, i: g.index } : { user: false, id: g.id });

/** Where a game is played and when, for its weather (the All-Star Game: the host's park). */
function _wxVenueGame(state, g, isUser) {
  if (g.isAllStar) return { gameTime: g.gameTime, homeId: state.allStar?.season?.hostId || 'user' };
  return { gameTime: g.gameTime, ...gameTeams(g, isUser) };
}

/**
 * _ensureWeatherPlans(clockMs)
 * Every game starting within PLAN_AHEAD of the clock gets its weather plan
 * (GameWeather.gameWeatherPlan) — ours and the league's, the same way. A
 * suspended game due to pick up gets the plan for its resumption. A plan is
 * worked out again only if the game moved.
 */
function _ensureWeatherPlans(clockMs) {
  const st = StateManager.get();
  if (!st?.schedule) return;
  const horizon = clockMs + _WX_PLAN_AHEAD_MS;
  const todo = [];
  const consider = (g, isUser) => {
    if (!Number.isFinite(g.gameTime) || g.gameTime > horizon || g._committed || g.played || g.cancelled) return;
    const susp = g.status === GAME_STATUS.SUSPENDED;
    if (!susp && !_WX_OPEN.has(g.status)) return;
    const vg = _wxVenueGame(st, g, isUser);
    const venueId = vg.venueId ?? vg.homeId;
    if (g.wx && g.wx.gameTime === g.gameTime && g.wx.venueId === venueId && !!g.wx.resumption === susp) return;
    todo.push({ ref: _wxRefOf(g, isUser), vg, susp, g });
  };
  st.schedule.forEach(g => consider(g, true));
  for (const games of Object.values(st.leagueSchedule?.dayMap || {})) for (const g of games) consider(g, false);
  if (!todo.length) return;
  const ctx = weatherContext(st);
  const plans = todo.map(t => {
    if (!t.susp) return gameWeatherPlan(ctx, t.vg);
    const rest = t.g.resumePlays || [];
    const r = resumptionPlan(ctx, t.vg, t.g.gameTime, rest.length ? rest[rest.length - 1]._resumeMin ?? 0 : 0);
    return { ...r.plan, resumption: true, resumeOk: r.ok };
  });
  StateManager.mutate(s => {
    todo.forEach((t, k) => { const { g } = _wxResolve(s, t.ref); if (g) g.wx = plans[k]; });
  });
}

/**
 * _wxUserCards(clockMs) — §102.5 the manager reads the forecast three hours
 * before each of our games (the same forecast the GM sees then). If rain is
 * likely during the game, he asks about the starter: the man in turn as
 * planned, or hold him a day and start the next man who's rested.
 */
function _wxUserCards(clockMs) {
  const st = StateManager.get();
  const sched = st.schedule || [];
  const lead = GAME_WEATHER.START_CARD_LEAD_MIN * 60_000;
  for (let i = st.currentGameIndex || 0; i < sched.length; i++) {
    const g = sched[i];
    if (!Number.isFinite(g.gameTime) || g.gameTime - lead > clockMs) break;
    if (g._committed || g.isSpring || g.cancelled || g.wxStartAsked === g.gameTime || g.status !== GAME_STATUS.SCHEDULED || g.plays?.length) continue;
    const at = g.gameTime - lead;
    StateManager.mutate(s => { const x = s.schedule[i]; if (x) x.wxStartAsked = x.gameTime; });
    if (clockMs > g.gameTime - 30 * 60_000) continue;                                       // too late to ask
    if (g.wx?.outcome === PLAN_OUTCOME.POSTPONED && g.wx.decidedAt <= at) continue;          // called off before anyone asks
    const ctx = weatherContext(st);
    const venueId = gameTeams(g, true).venueId;
    const park = ctx.map.parks[venueId] || ctx.map.parks.user;
    const ch = chanceOfPrecip(ctx, at, park.x, park.y, g.gameTime, g.gameTime + 3 * 3_600_000);
    if (!(ch.chance >= GAME_WEATHER.START_CARD_CHANCE)) continue;
    const starterId = rotationStarter(st.userTeam, st.players, g.gameTime);
    const order = st.userTeam.rotation?.order || [];
    const k = order.indexOf(starterId);
    if (k < 0) continue;
    let altId = null;
    for (let j = 1; j < order.length; j++) {
      const id = order[(k + j) % order.length], p = st.players[id];
      if (p && isAvailable(p) && starterRested(p, g.gameTime)) { altId = id; break; }
    }
    if (!altId) continue;
    CardEngine.deliverRainStartCard({ key: `wx:start:${st.seasonNum || 1}:${g.gameTime}`, gameTime: g.gameTime, starterId, altId,
                                      chance: ch.chance, kind: ch.kind, city: cityOf(ctx.map, venueId, st.userTeam.city) }, at);
  }
}

/** §102.5 a makeup made our day a doubleheader: who starts game two? */
function _wxDoubleheaderCard(date, makeupOf, atMs) {
  const st = StateManager.get();
  const games = (st.schedule || []).filter(g => g.date === date && !g.cancelled).sort((a, b) => a.gameTime - b.gameTime);
  if (games.length !== 2 || games.some(g => g._committed || g.status === GAME_STATUS.SUSPENDED || g.plays?.length || g.isSpring)) return;
  const g2 = games[1];
  const before = (st.schedule || []).filter(g => !g._committed && g.gameTime < g2.gameTime).length;
  const order = st.userTeam.rotation?.order || [];
  const nextId = order.length ? order[((st.userTeam.rotation.currentIndex || 0) + before) % order.length] : null;
  const longId = bullpenRoles(st.userTeam, st.players).long[0] || null;
  if (!longId) return;
  CardEngine.deliverDoubleheaderCard({ key: `wx:dh:${st.seasonNum || 1}:${date}`, date, firstPitch: games[0].gameTime,
                                       nextId, longId, opp: g2.opponent || '', makeupOf: _wxDay(makeupOf) }, atMs);
}

/** Our games the weather acts on now (a plan's postponement; a suspended game's turn). */
function _userWeatherEvents(state, clockMs) {
  const out = [];
  (state.schedule || []).forEach((g, i) => {
    if (g._committed || !g.wx) return;
    if (_WX_OPEN.has(g.status) && g.wx.outcome === PLAN_OUTCOME.POSTPONED && g.wx.decidedAt <= clockMs) {
      out.push({ kind: 'ppd', ref: { user: true, i }, at: g.wx.decidedAt });
    }
  });
  return out;
}

/** Our schedule in playing order after a game moved: unplayed games by first pitch, indexes and regular-season numbers renewed. */
function _wxSortSchedule(s) {
  const split = Math.min(s.currentGameIndex || 0, s.schedule.length);
  const head = s.schedule.slice(0, split);
  const tail = s.schedule.slice(split).map((g, k) => ({ g, k })).sort((a, b) => (a.g.gameTime - b.g.gameTime) || (a.k - b.k)).map(x => x.g);
  s.schedule = [...head, ...tail];
  let ri = 0;
  s.schedule.forEach((g, i) => {
    g.index = i;
    if (g.isSpring || g.isPlayoff) return;
    if (!g._committed) {
      g.regularSeasonIndex = ri;
      g.isDeadlineWindow = ri >= TRADE_DEADLINE_OPEN && ri <= TRADE_DEADLINE_CLOSE;
      g.isStretchRun = ri >= REGULAR_SEASON_GAME_COUNT - STRETCH_RUN_FINAL_GAMES;
    }
    ri++;
  });
}

/** Move one game (ours or the league's) to a new date and first pitch. Its plan is worked out again. */
function _wxMove(s, g, isUser, { date, gameTime, venueId }) {
  const home = gameTeams(g, isUser).homeId;
  if (!isUser && g.date !== date) {
    const list = s.leagueSchedule.dayMap[g.date] || [];
    const i = list.indexOf(g);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete s.leagueSchedule.dayMap[g.date];
    (s.leagueSchedule.dayMap[date] = s.leagueSchedule.dayMap[date] || []).push(g);
  }
  g.date = date;
  g.gameTime = gameTime;
  if (venueId && venueId !== home) g.venueId = venueId; else delete g.venueId;
  g.wx = null;
}

const _wxReasonWord = (r) => (r === 'lightning' ? 'storms' : r === 'snow' ? 'snow' : r === 'wet field' ? 'a wet field' : 'rain');
function _wxTeamAbbr(s, id) { return id === 'user' ? s.userTeam.abbr : (s.leagueTeams.find(t => t.id === id)?.abbr || id); }
function _wxMatchup(s, g, isUser) { const t = gameTeams(g, isUser); return `${_wxTeamAbbr(s, t.awayId)} at ${_wxTeamAbbr(s, t.homeId)}`; }
const _wxDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

/**
 * _postponeGame(ref, atMs) — the weather called a game off before it started
 * (its plan's decision, at the moment it was made). Spring: cancelled. Regular
 * season: made up (WeatherSchedule.findMakeupSlot). Playoffs and the All-Star
 * Game: back a day, with the rest of the series.
 */
function _postponeGame(ref, atMs) {
  const st = StateManager.get();
  const { g, isUser } = _wxResolve(st, ref);
  if (!g || !g.wx) return;
  const plan = g.wx;
  const entry = { date: g.date, gameTime: g.gameTime, decidedAt: plan.decidedAt, reason: plan.reason, calledBy: plan.calledBy };
  const why = _wxReasonWord(plan.reason);
  let dhFor = null;
  if (g.isSpring) {
    StateManager.mutate(s => {
      const x = _wxResolve(s, ref).g;
      x.postponements = [...(x.postponements || []), entry];
      x.status = GAME_STATUS.POSTPONED;
      x.cancelled = true;
      x.wx = { ...plan };
      if (!isUser) x.played = true;   // spring rainouts aren't made up
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('weather', isUser ? s.userTeam.abbr : _wxTeamAbbr(s, x.homeId),
        `Spring: ${_wxMatchup(s, x, isUser)} rained out (${why}) — not made up`, atMs)]);
    });
    return;
  }
  const moves = g.isPlayoff || g.isAllStar ? seriesShift(st, g, isUser).map(m => ({ ...m, venueId: null })) : null;
  const slot = moves ? null : findMakeupSlot(st, g, isUser, atMs);
  // §102.5 a question about this game's start is moot now (and any doubleheader that date is undone).
  if (isUser) { CardEngine.withdrawWeatherCards(`wx:start:${st.seasonNum || 1}:${g.gameTime}`); CardEngine.withdrawWeatherCards(`wx:dh:${st.seasonNum || 1}:${g.date}`); }
  StateManager.mutate(s => {
    const x = _wxResolve(s, ref).g;
    x.postponements = [...(x.postponements || []), entry];
    x.status = GAME_STATUS.SCHEDULED;
    x.isMakeup = true;
    if (moves) {
      for (const m of moves) _wxMove(s, m.g, m.isUser, { date: m.date, gameTime: m.gameTime, venueId: m.g.venueId });
    } else if (slot) {
      if (slot.moveOther) _wxMove(s, slot.moveOther.g, slot.moveOther.isUser, { date: slot.date, gameTime: slot.moveOther.gameTime, venueId: slot.moveOther.g.venueId });
      _wxMove(s, x, isUser, slot);
      x.makeup = { how: slot.how };
    } else {
      // (No date at all — can't happen inside a season; the game is cancelled rather than lost.)
      x.status = GAME_STATUS.POSTPONED; x.cancelled = true; if (!isUser) x.played = true;
    }
    const when = x.cancelled ? 'cancelled' : `${x.isAllStar ? 'moved to' : 'makeup'} ${_wxDay(x.date)}${slot?.how?.endsWith('dh') ? ' (doubleheader)' : ''}`;
    if (isUser && slot?.how?.endsWith('dh')) dhFor = x.date;
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('weather', isUser ? s.userTeam.abbr : _wxTeamAbbr(s, gameTeams(x, isUser).homeId),
      `${x.isPlayoff ? 'Playoffs: ' : ''}${x.isAllStar ? 'The All-Star Game' : _wxMatchup(s, x, isUser)} postponed (${why}) — ${when}`, atMs)]);
    _wxSortSchedule(s);
  });
  if (dhFor) _wxDoubleheaderCard(dhFor, entry.date, atMs);
}

/**
 * _suspendGame(ref, atMs) — the weather stopped a game before it could be
 * finished (SimEngine's ruling: suspended). It stays as it stands and picks
 * up on another day — found like a makeup (playoffs: the next day) — at
 * exactly the inning, outs and runners where it stopped.
 */
function _suspendGame(ref, atMs) {
  const st = StateManager.get();
  const { g, isUser } = _wxResolve(st, ref);
  if (!g) return;
  const moves = g.isPlayoff ? seriesShift(st, g, isUser) : null;
  const slot = moves ? null : findMakeupSlot(st, g, isUser, atMs);
  const sp = g.plays?.[g.plays.length - 1];
  StateManager.mutate(s => {
    const x = _wxResolve(s, ref).g;
    x.status = GAME_STATUS.SUSPENDED;
    x.suspension = { date: x.date, gameTime: x.gameTime, atMs, ...(sp?._suspended || {}),
                     cumOurScore: sp?.cumOurScore ?? 0, cumTheirScore: sp?.cumTheirScore ?? 0, text: sp?.description || 'Suspended' };
    if (moves) for (const m of moves) _wxMove(s, m.g, m.isUser, { date: m.date, gameTime: m.gameTime, venueId: m.g.venueId });
    else if (slot) {
      if (slot.moveOther) _wxMove(s, slot.moveOther.g, slot.moveOther.isUser, { date: slot.date, gameTime: slot.moveOther.gameTime, venueId: slot.moveOther.g.venueId });
      _wxMove(s, x, isUser, slot);
    }
    x.resumeAt = x.gameTime;
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('weather', isUser ? s.userTeam.abbr : _wxTeamAbbr(s, gameTeams(x, isUser).homeId),
      `${x.isPlayoff ? 'Playoffs: ' : ''}${_wxMatchup(s, x, isUser)} suspended (${_wxReasonWord(sp?._suspended?.reason)}) — resumes ${_wxDay(x.date)}`, atMs)]);
    _wxSortSchedule(s);
  });
}

/**
 * _resumeGame(ref, atMs) — a suspended game's turn. Its resumption has its
 * own weather: if that rains it out (or would stop it again), it waits for
 * another day; otherwise the rest of the game goes on the clock
 * (SimEngine.resumeTimeline) and it's live again.
 */
function _resumeGame(ref, atMs) {
  _ensureWeatherPlans(atMs);
  const st = StateManager.get();
  const { g, isUser } = _wxResolve(st, ref);
  if (!g || g.status !== GAME_STATUS.SUSPENDED) return;
  const plan = g.wx;
  if (!plan || !plan.resumeOk) {
    const moves = g.isPlayoff ? seriesShift(st, g, isUser) : null;
    const slot = moves ? null : findMakeupSlot(st, g, isUser, atMs);
    StateManager.mutate(s => {
      const x = _wxResolve(s, ref).g;
      x.postponements = [...(x.postponements || []), { date: x.date, gameTime: x.gameTime, decidedAt: atMs, reason: plan?.reason || 'rain', calledBy: plan?.calledBy || 'forecast', resumption: true }];
      if (moves) for (const m of moves) _wxMove(s, m.g, m.isUser, { date: m.date, gameTime: m.gameTime, venueId: m.g.venueId });
      else if (slot) {
        if (slot.moveOther) _wxMove(s, slot.moveOther.g, slot.moveOther.isUser, { date: slot.date, gameTime: slot.moveOther.gameTime, venueId: slot.moveOther.g.venueId });
        _wxMove(s, x, isUser, slot);
      }
      x.resumeAt = x.gameTime;
      _wxSortSchedule(s);
    });
    return;
  }
  const sp = g.plays[g.plays.length - 1];
  const more = resumeTimeline(g.resumePlays || [], plan, sp);
  StateManager.mutate(s => {
    const x = _wxResolve(s, ref).g;
    const base = x.plays.length;
    x.plays = [...x.plays, ...more.map((p, k) => ({ ...p, playIndex: base + k }))];
    delete x.resumePlays;
    x.status = GAME_STATUS.LIVE;
    x.resumedAt = plan.startAt;
  });
}

/**
 * _wxHoldForClubs(ref, atMs) — a doubleheader's second game waits for the
 * first (§102.3): if either club is still playing at first pitch — a long
 * delay in the opener — this game's first pitch moves to DH_BREAK_MIN after
 * that game ends (its weather plan is worked out again). → true if it waits.
 */
function _wxHoldForClubs(ref, atMs) {
  const st = StateManager.get();
  const { g, isUser } = _wxResolve(st, ref);
  if (!g) return false;
  const t = gameTeams(g, isUser);
  const end = Math.max(clubBusyUntil(st, t.homeId, atMs), clubBusyUntil(st, t.awayId, atMs));
  if (!end) return false;
  StateManager.mutate(s => {
    const x = _wxResolve(s, ref).g;
    x.gameTime = end + GAME_WEATHER.DH_BREAK_MIN * 60_000;
    x.wx = null;
    if (isUser) _wxSortSchedule(s);
  });
  return true;
}

/**
 * _wxAtFirstPitch(state, g, isUser) — the weather a game is played in:
 * its plan, the park report through it, and the record kept on the game
 * (the weather at first pitch, the field after any rain before it).
 * → { sim: { plan, conditions }, record } — null for a game without a plan.
 */
function _wxAtFirstPitch(state, g, isUser) {
  const ctx = weatherContext(state);
  const vg = _wxVenueGame(state, g, isUser);
  const plan = g.wx && g.wx.gameTime === g.gameTime && !g.wx.resumption ? g.wx : gameWeatherPlan(ctx, vg);
  if (plan.outcome === PLAN_OUTCOME.POSTPONED) return null;
  const conditions = gameConditions(ctx, plan);
  return { plan, sim: { plan, conditions }, record: gameRecord(ctx, plan, conditions) };
}

/**
 * _leagueGameEvents(state, clockMs)
 * CPU games due on the clock: first pitch reached (simulate with the rosters
 * of that moment) or final out reached (commit). Sorted by time.
 */
function _leagueGameEvents(state, clockMs) {
  const out = [];
  for (const [date, games] of Object.entries(state.leagueSchedule?.dayMap || {})) {
    games.forEach((cg, i) => {
      if (cg.played) return;
      const ref = { user: false, id: cg.id };
      // §102.3 the weather: a postponement at the moment it's decided; a start
      // that waits on the weather; a suspension at the moment play stops; a
      // suspended game's turn.
      const ppd = cg.wx?.outcome === PLAN_OUTCOME.POSTPONED && !cg.wx.resumption;
      if (_WX_OPEN.has(cg.status) && ppd && cg.wx.decidedAt <= clockMs) {
        out.push({ kind: 'ppd', ref, at: cg.wx.decidedAt });
      } else if (cg.status === GAME_STATUS.SCHEDULED && Number.isFinite(cg.gameTime) && cg.gameTime <= clockMs) {
        out.push({ kind: ppd ? 'wait' : 'start', date, i, ref, at: cg.gameTime });
      } else if (cg.status === GAME_STATUS.LIVE && _playsEndMs(cg) <= clockMs) {
        const suspended = cg.plays?.[cg.plays.length - 1]?.type === 'game_suspended';
        out.push({ kind: suspended ? 'suspend' : 'final', date, i, ref, at: _playsEndMs(cg) });
      } else if (cg.status === GAME_STATUS.SUSPENDED && Number.isFinite(cg.gameTime) && cg.gameTime <= clockMs) {
        out.push({ kind: 'resume', ref, at: cg.gameTime });
      }
    });
  }
  return out.sort((a, b) => a.at - b.at || (a.kind === 'final' ? -1 : 1));
}

/**
 * _startLeagueGame(date, i)
 * First pitch of a CPU game: the full SimEngine pipeline (same as the user's
 * game) with both clubs' rosters as they are right now. Plays reveal on the
 * real clock for anyone watching (§28.4).
 */
function _startLeagueGame(date, i) {
  const state = StateManager.get();
  const cg    = state.leagueSchedule.dayMap[date][i];
  if (cg.isAllStar) return _startAllStarGame(date, i);
  const home  = state.leagueTeams.find(t => t.id === cg.homeId);
  const away  = state.leagueTeams.find(t => t.id === cg.awayId);
  if (!home || !away) {
    StateManager.mutate(s => { const g = s.leagueSchedule.dayMap[date][i]; g.status = GAME_STATUS.FINAL; g.played = true; g._void = true; });
    return;
  }
  const wx = _wxAtFirstPitch(state, cg, false);   // §102.3 the same weather as everyone's
  const sim = generatePlays(
    { ...cg, isHome: true, weather: null, fieldCondition: null, ...(wx?.record || {}) },
    home, away, state.players,
    { phase: state.phase, isSpring: !!cg.isSpring,
      norms: leagueNorms([state.userTeam, ...state.leagueTeams], state.players), weather: wx?.sim || null }
  );
  StateManager.mutate(s => {
    const g = s.leagueSchedule.dayMap[date][i];
    g.plays                = sim.plays;
    g._precomputedBoxScore = sim.boxScore;
    g.liveLineups          = sim.liveLineups;
    g.status               = GAME_STATUS.LIVE;
    if (wx) { Object.assign(g, wx.record); g.wx = wx.plan; g.wxResult = sim.weather; }
    if (sim.resumePlays) g.resumePlays = sim.resumePlays;
  });
}

/**
 * _finishLeagueGame(date, i)
 * Final out of a CPU game: result, standings, player stats + hot/cold log,
 * both rotations turn over, injuries for the players who actually played,
 * play data stripped (box score kept).
 * @returns {Object[]} injury events
 */
function _finishLeagueGame(date, i) {
  const st0 = StateManager.get();
  const cg0 = st0.leagueSchedule.dayMap[date][i];
  if (cg0.isAllStar) return _finishAllStarGame(date, i);
  const endMs = _playsEndMs(cg0);
  const last  = cg0.plays[cg0.plays.length - 1];
  const homeScore = last?.cumOurScore ?? 0, awayScore = last?.cumTheirScore ?? 0;
  const statKey = cg0.isPlayoff ? 'postseasonStats' : cg0.isSpring ? 'springStats' : 'stats';
  const stats = accumulateStats(cg0.plays, null, null, st0.players, statKey);
  const perGame = {};
  for (const play of cg0.plays) {
    if (!play._statDeltas || play._reverted || play.type === 'pinch_hit') continue;
    for (const [pid, list] of Object.entries(play._statDeltas)) {
      perGame[pid] = perGame[pid] || {};
      for (const { stat, delta } of list) perGame[pid][stat] = (perGame[pid][stat] || 0) + delta;
    }
  }

  StateManager.mutate(s => {
    const g    = s.leagueSchedule.dayMap[date][i];
    const home = s.leagueTeams.find(t => t.id === g.homeId);
    const away = s.leagueTeams.find(t => t.id === g.awayId);
    const outcome = homeScore > awayScore ? 'win' : homeScore < awayScore ? 'loss' : 'tie';
    const kind = g.isPlayoff ? 'playoff' : g.isSpring ? 'spring' : 'regular';
    _creditResult(home, outcome, kind);
    _creditResult(away, outcome === 'win' ? 'loss' : outcome === 'loss' ? 'win' : 'tie', kind);
    if (g.isPlayoff) {
      _pendingSeriesResults.push({ seriesId: g.seriesId, gameId: g.id, homeId: g.homeId, awayId: g.awayId,
                                   homeScore, awayScore, atMs: endMs });
    }
    _advanceRotation(home);
    _advanceRotation(away);
    // §78.5 the home club's gate (not in spring).
    if (!g.isSpring && home?.finances) {
      const gate = Finance.homeGate(s, home.id, { atMs: endMs, playoff: !!g.isPlayoff });
      if (gate) { g.attendance = gate.attendance; g.gateK = gate.gateK; g.sellout = gate.sellout; }
    }
    if (home) Development.countGame(s, home.id);
    if (away) Development.countGame(s, away.id);
    for (const [pid, m] of Object.entries(stats.players || {})) if (s.players[pid]) s.players[pid][statKey] = m[statKey];
    recordOutings(s, g.plays, endMs);   // §76: the arms' record
    for (const [pid, d] of Object.entries(perGame)) {
      if (s.players[pid]) s.players[pid]._impGameLog = appendGameLog(s.players[pid], s.currentGameIndex || 0, date, d)._impGameLog;
    }
    g.homeScore = homeScore;
    g.awayScore = awayScore;
    g.played    = true;
    g.status    = GAME_STATUS.FINAL;
    g.endedAt   = endMs;
    g.boxScore  = g._precomputedBoxScore;
    delete g.plays;
    delete g._precomputedBoxScore;
    delete g.resumePlays;
    if (home && away) {
      const [w, l, ws, ls] = homeScore > awayScore ? [home, away, homeScore, awayScore] : [away, home, awayScore, homeScore];
      const tag = g.isPlayoff ? 'Playoffs: ' : g.isSpring ? 'Spring: ' : '';
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('result', w.abbr, homeScore === awayScore
          ? `${tag}${home.abbr} and ${away.abbr} tie ${homeScore}–${awayScore}`
          : `${tag}${w.abbr} def. ${l.abbr} ${ws}–${ls}`, endMs)]);
    }
    s.standings = computeFullStandings(s);
  });

  // Injuries: the players who took the field.
  const st  = StateManager.get();
  const g   = st.leagueSchedule.dayMap[date][i];
  const box = g.boxScore;
  if (!box) return [];
  const side = (teamId, b) => ({ teamId, hitterIds: b.hitters.map(h => h.id),
                                 starterId: b.pitchers[0]?.id || null,
                                 relieverIds: b.pitchers.slice(1).map(p => p.id) });
  const inj = rollGameInjuries(st, [side(g.homeId, box.home), side(g.awayId, box.away)], endMs);
  if (Object.keys(inj.players).length) {
    StateManager.mutate(s => {
      for (const [id, upd] of Object.entries(inj.players)) Object.assign(s.players[id], upd);
      // The CPU GMs react at once (IL / call-up through the ledger).
      for (const teamId of new Set(inj.events.map(e => e.teamId))) {
        applyRosterMutation(s, reconcileRoster(s, teamId, { autoManage: true, atMs: endMs }));
      }
    });
  }
  return inj.events.map(e => ({ ...e, atMs: endMs }));
}

// ─────────────────────────────────────────────────────────────
// CLUB FUNDS ON THE CLOCK (§78)
// ─────────────────────────────────────────────────────────────

/**
 * _payday(i, atMs) — the 1st / 15th (and once after the last game): salaries
 * and staff are paid, the media and local installments come in, and the
 * owner looks at the books. A worse mood (or an order) reaches the inbox.
 */
function _payday(i, atMs) {
  let res = null, review = null, amountK = 0, playerId = null;
  StateManager.mutate(s => {
    res = Finance.payday(s, i, atMs, 'user');
    if (!res) return;
    s.userTeam.finances.payroll = Finance.payrollOf(s, 'user');
    review = Finance.ownerReview(s, atMs);
    const sign = res.total >= 0 ? '+' : '−';
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
      buildActivityFeedEntry('payday', s.userTeam.abbr,
        `Payday: ${formatK(res.paid.payroll)} in salaries${res.paid.staff ? `, ${formatK(res.paid.staff)} staff` : ''}`
        + `${res.paid.dead ? `, ${formatK(res.paid.dead)} dead money` : ''} · `
        + `${formatK(res.received.media + res.received.local)} media & sponsors (${sign}${formatK(Math.abs(res.total))})`, atMs)]);
    // The owner orders cuts: name the contract to move, due the next payday.
    if (review.stage === 'cuts' && !s.userTeam.finances.owner.order) {
      amountK = Finance.cutOrderAmount(s);
      const p = amountK > 0 ? Finance.contractToMove(s, amountK) : null;
      const cal = s.userTeam.finances.cal;
      const dueAt = cal?.paydays?.[cal.paid] ?? atMs + 14 * 86_400_000;
      if (p) {
        playerId = p.id;
        s.userTeam.finances.owner.order = { amountK, fromPayroll: Finance.payrollOf(s, 'user'), dueAt, playerId };
      }
    }
  });
  if (!res) return [];
  const rank = (st) => FinanceStages.indexOf(st);
  if (review.orderResult) CardEngine.deliverOwnerOrderResult(review.orderResult, atMs + _rng(30, 90) * 60_000);
  if (review.stage === 'cuts' && playerId) {
    CardEngine.deliverOwnerCutOrder(playerId, amountK, atMs + _rng(30, 120) * 60_000);
  } else if (rank(review.stage) > rank(review.prev) && review.stage !== 'content') {
    CardEngine.deliverOwnerFinanceCard(review.stage, review.strain, atMs + _rng(30, 120) * 60_000);
  }
  return [{ type: 'PAYDAY', atMs, ...res }];
}
const FinanceStages = Finance.STAGES;

/**
 * _cpuPayday(teamId, i, atMs) — §78.5 a CPU club's payday: salaries and staff
 * paid, media and local money in, and its owner looks at the books. An owner
 * who orders cuts gets them before the trade deadline: the club moves a
 * contract to the club with the most room (a salary dump). After the
 * deadline he can only wait for the winter.
 */
function _cpuPayday(teamId, i, atMs) {
  let move = null;
  StateManager.mutate(s => {
    const res = Finance.payday(s, i, atMs, teamId);
    if (!res) return;
    const t = s.leagueTeams.find(x => x.id === teamId);
    t.finances.payroll = Finance.payrollOf(s, teamId);
    const review = Finance.ownerReview(s, atMs, teamId);
    const regPlayed = (s.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff).length;
    if (review.stage === 'cuts' && regPlayed <= TRADE_DEADLINE_CLOSE) {
      move = cpuSalaryMove(s, teamId, atMs);
      if (move) {
        const name = s.players[move.playerId]?.name || 'A player';
        const to = s.leagueTeams.find(x => x.id === move.toId);
        const line = `${t.name} send ${name} (${formatK(move.salaryK)}) to ${to?.name || move.toId} — a salary move`;
        s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('trade', t.abbr, line, atMs)]);
        _wireAdd(s, [{ atMs, kind: 'trade', teamIds: [t.id, move.toId], text: line }]);
      }
    }
  });
  return move ? [{ type: 'CPU_SALARY_MOVE', ...move, atMs }] : [];
}

// ─────────────────────────────────────────────────────────────
// THE ALL-STAR GAME (§75)
// ─────────────────────────────────────────────────────────────

/**
 * _allStarProgress(game, endMs)
 * After each of the user's regular-season games: the home crowd feeds the
 * hosting score; the league names the host (games 45–55); the host may lobby
 * for a bubble player; the rosters are named (after game 58) — and the host's
 * All-Star week is put on the calendar; after the break, the glow.
 */
function _allStarProgress(game, endMs) {
  if (!game || game.isSpring || game.isPlayoff || game.regularSeasonIndex == null) return;
  if (!StateManager.get().allStar) {
    StateManager.mutate(s => { s.allStar = AllStar.createAllStarState(s, s.baseYear || baseballYear(s)); });
  }
  const entry = AllStar.gameEntry(StateManager.get());
  if (!entry) return;   // a calendar from before §75 (a fresh team adds the game)
  const played = game.regularSeasonIndex + 1;

  StateManager.mutate(s => {
    const season = AllStar.seasonOf(s);
    if (game.isHome) {
      AllStar.accrueHomeGame(s);
      // Post-break glow for the host: the buzz fills the park.
      if (season.hostId === 'user' && played > ALL_STAR_BREAK_AFTER_GAME
          && played <= ALL_STAR_BREAK_AFTER_GAME + ALLSTAR_POST_GLOW_GAMES) {
        s.userTeam.atmosphere = Math.min(100, (s.userTeam.atmosphere ?? 50) + 1);
      }
    }
  });

  let season = StateManager.get().allStar.season;

  // 1. The league names the host.
  if (!season.hostId && played >= season.announceAfterGame) {
    let named = null;
    StateManager.mutate(s => { named = AllStar.nameHost(s, endMs); });
    const st = StateManager.get();
    const host = named.hostId === 'user' ? st.userTeam : st.leagueTeams.find(t => t.id === named.hostId);
    StateManager.mutate(s => {
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('milestone', host?.abbr || 'LG', `${host?.name || 'A club'} will host the All-Star Game`)]);
      if (named.hostId === 'user') {
        // A post-break trade target who fell for the place during the week.
        AllStar.seasonOf(s).glowTradeAfterGame = ALL_STAR_BREAK_AFTER_GAME + 1 + Math.floor(Math.random() * 10);
      }
    });
    CardEngine.deliverAllStarHostCard(named, endMs + _rng(10, 40) * 60_000);
    season = StateManager.get().allStar.season;
  }

  // 2. The host's GM can lobby for a player on the bubble before rosters are set.
  if (season.hostId === 'user' && !season.influence && !season.squads
      && played >= ALLSTAR_SELECTION_AFTER_GAME - 3) {
    const pid = AllStar.bubblePlayer(StateManager.get());
    StateManager.mutate(s => { AllStar.seasonOf(s).influence = { playerId: pid, choice: null }; });
    if (pid) CardEngine.deliverAllStarLobbyCard(pid, endMs + _rng(20, 90) * 60_000, endMs + 2 * 86_400_000);
    season = StateManager.get().allStar.season;
  }

  // 3. The rosters.
  if (!season.squads && played >= ALLSTAR_SELECTION_AFTER_GAME) {
    CardEngine.withdrawAllStarLobbyCard();
    let mine = [];
    StateManager.mutate(s => {
      mine = AllStar.selectSquads(s, endMs);
      s.userTeam.morale = Math.min(100, (s.userTeam.morale ?? 50) + Math.min(4, mine.length));
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('milestone', s.userTeam.abbr, `All-Star rosters announced — ${mine.length} ${s.userTeam.abbr} All-Star${mine.length === 1 ? '' : 's'}`)]);
    });
    CardEngine.deliverAllStarSelectionCard(mine, endMs + _rng(30, 120) * 60_000);
    // All-Star week in our ballpark: the day before the game.
    const st = StateManager.get();
    if (st.allStar.season.hostId === 'user') {
      const day = new Date(entry.game.gameTime); day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - Math.max(1, ALLSTAR_GAME_BREAK_DAY - 1));
      CardEngine.scheduleAllStarWeekCards(day.getTime(), entry.game.gameTime);
    }
    season = StateManager.get().allStar.season;
  }

  // 4. After the break, the host's trade suitor.
  if (season.glowTradeAfterGame && !season.glowTradeSent && played >= season.glowTradeAfterGame) {
    StateManager.mutate(s => { AllStar.seasonOf(s).glowTradeSent = true; });
    CardEngine.deliverAllStarTradeOffer(buildCardContext());
  }
}

/** First pitch of the All-Star Game: replacements named, then a live game. */
function _startAllStarGame(date, i) {
  let repl = [];
  StateManager.mutate(s => { repl = AllStar.prepareForGame(s); });
  const state = StateManager.get();
  const cg    = state.leagueSchedule.dayMap[date][i];
  const home  = AllStar.clubFor(state, cg.homeId);
  const away  = AllStar.clubFor(state, cg.awayId);
  const wx = _wxAtFirstPitch(state, cg, false);   // §102.3 the host park's weather
  const sim = generatePlays(
    { ...cg, isHome: true, weather: null, fieldCondition: null, ...(wx?.record || {}) },
    home, away, state.players,
    { phase: state.phase, isSpring: false, exhibition: true,
      norms: leagueNorms([state.userTeam, ...state.leagueTeams], state.players), weather: wx?.sim || null }
  );
  StateManager.mutate(s => {
    const g = s.leagueSchedule.dayMap[date][i];
    if (wx) { Object.assign(g, wx.record); g.wx = wx.plan; g.wxResult = sim.weather; }
    g.plays                = sim.plays;
    g._precomputedBoxScore = sim.boxScore;
    g.liveLineups          = sim.liveLineups;
    g.status               = GAME_STATUS.LIVE;
    for (const r of repl) {
      const out = s.players[r.outId], inn = s.players[r.inId];
      if (out && inn) s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('allstar', AllStar.clubFor(s, r.squadId)?.abbr || r.squadId, `All-Star replacement: ${inn.name} for ${out.name}`)]);
    }
  });
}

/** Final out of the All-Star Game: the result and the MVP. An exhibition —
 *  no standings, stats, rotations or injuries. */
function _finishAllStarGame(date, i) {
  const st0 = StateManager.get();
  const cg0 = st0.leagueSchedule.dayMap[date][i];
  const endMs = _playsEndMs(cg0);
  const last  = cg0.plays[cg0.plays.length - 1];
  let res = null;
  StateManager.mutate(s => {
    const g = s.leagueSchedule.dayMap[date][i];
    g.homeScore = last?.cumOurScore ?? 0;
    g.awayScore = last?.cumTheirScore ?? 0;
    g.played    = true;
    g.status    = GAME_STATUS.FINAL;
    g.endedAt   = endMs;
    g.boxScore  = g._precomputedBoxScore;
    delete g.plays;
    delete g._precomputedBoxScore;
    res = AllStar.recordResult(s, g);
    const name = (id) => AllStar.clubFor(s, id)?.name || id;
    const [w, l, ws, ls] = g.homeScore > g.awayScore ? [g.homeId, g.awayId, g.homeScore, g.awayScore]
                                                     : [g.awayId, g.homeId, g.awayScore, g.homeScore];
    const mvp = res.mvpId && s.players[res.mvpId];
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
      buildActivityFeedEntry('result', w, `All-Star Game: ${name(w)} def. ${name(l)} ${ws}–${ls}${mvp ? ` · MVP ${mvp.name}` : ''}`)]);
    if (mvp && mvp.teamId === 'user') s.userTeam.morale = Math.min(100, (s.userTeam.morale ?? 50) + 2);
  });
  const mvp = res?.mvpId && StateManager.get().players[res.mvpId];
  if (mvp && mvp.teamId === 'user') CardEngine.deliverAllStarMvpCard(mvp.id, endMs + _rng(5, 20) * 60_000);
  return [];
}

// ─────────────────────────────────────────────────────────────
// SEASON PROGRESS — end of season + playoffs on the league clock (§68)
// ─────────────────────────────────────────────────────────────

// Playoff finals waiting to be applied to the bracket (filled inside commit /
// CPU-finish mutations, drained by _seasonProgress in time order).
const _pendingSeriesResults = [];

const REGULAR_PHASES = new Set([PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE]);

function _regularSeasonDone(state) {
  const userDone = (state.schedule || []).filter(g => !g.isSpring && !g.isPlayoff).every(g => g._committed);
  if (!userDone) return false;
  for (const games of Object.values(state.leagueSchedule?.dayMap || {})) {
    for (const g of games) if (!g.isSpring && !g.isPlayoff && !g.played) return false;
  }
  return true;
}

/**
 * _seasonProgress(atMs)
 * Moves the league's season forward when its games say so — not when the
 * user's game index does. Applies playoff finals to the bracket (cancelling a
 * clinched series' remaining games), builds the bracket when the last
 * regular-season game in the league is final, starts each round when the
 * previous one is complete, and closes the season after the World Series.
 * @returns {Object[]} events ({ type: 'PHASE', to } …)
 */
function _seasonProgress(atMs) {
  const events = [];

  // 1. Playoff results → bracket.
  while (_pendingSeriesResults.length) {
    const r = _pendingSeriesResults.shift();
    let res = null;
    StateManager.mutate(s => { if (s.playoffBracket) res = recordGame(s.playoffBracket, r.seriesId, r); });
    if (res?.clinched) {
      _cancelSeriesGames(r.seriesId);
      _queueSeriesMilestone(res);
      events.push({ type: 'SERIES_FINAL', seriesId: r.seriesId, winnerId: res.winnerId, loserId: res.loserId });
    }
  }

  // 2. End of the regular season → bracket → Wild Card.
  let st = StateManager.get();
  if (REGULAR_PHASES.has(st.phase) && _regularSeasonDone(st)) {
    const standings = computeFullStandings(st);
    const results = _regularSeasonResults(st);
    const bracket = buildBracket(seedDivision(standings.divA, results), seedDivision(standings.divB, results));
    StateManager.mutate(s => { s.standings = standings; s.playoffBracket = bracket; });
    _applyPhase(PHASE.PLAYOFF_BRACKET_BUILD);
    events.push({ type: 'PHASE', to: PHASE.PLAYOFF_BRACKET_BUILD });
    _startRound('WILD_CARD', atMs);
    events.push({ type: 'PHASE', to: PHASE.WILD_CARD });
    return events;
  }

  // 3. A round finished → the next one, or the season is over.
  const round = roundForPhase(st.phase);
  if (round && st.playoffBracket && roundComplete(st.playoffBracket, round)) {
    const nr = nextRound(round);
    if (nr) {
      _startRound(nr, atMs);
      events.push({ type: 'PHASE', to: ROUND_PHASE[nr] });
    } else {
      _applyPhase(PHASE.SEASON_SUMMARY);
      events.push({ type: 'PHASE', to: PHASE.SEASON_SUMMARY });
      // The offseason calendar starts the midnight after the last out (§70).
      StateManager.mutate(s => { s.offseason = Offseason.createOffseason(atMs, s.seasonNum || 1); });
    }
  }
  return events;
}

/** Every regular-season final in the league (for head-to-head tiebreaks). */
function _regularSeasonResults(state) {
  const out = [];
  for (const g of state.schedule || []) {
    if (g.isSpring || g.isPlayoff || !g._committed || !g.score) continue;
    const [hs, as] = g.isHome ? [g.score.us, g.score.them] : [g.score.them, g.score.us];
    out.push({ homeId: g.isHome ? 'user' : g.opponentId, awayId: g.isHome ? g.opponentId : 'user', homeScore: hs, awayScore: as });
  }
  for (const games of Object.values(state.leagueSchedule?.dayMap || {})) {
    for (const g of games) if (!g.isSpring && !g.isPlayoff && !g.isAllStar && g.played) out.push(g);
  }
  return out;
}

/**
 * _startRound(round, atMs)
 * Places last round's winners and schedules every series of `round` on the
 * real calendar: one off day, then a game a day (World Series: travel days
 * after games 2 and 5), evening first pitch. The user's games join
 * state.schedule (the live pipeline); the rest join the league day map.
 */
function _startRound(round, atMs) {
  StateManager.mutate(s => { prepareRound(s.playoffBracket, round); });
  const st = StateManager.get();
  const first = new Date(atMs); first.setHours(0, 0, 0, 0); first.setDate(first.getDate() + 2);
  const nameOf = (id) => (st.leagueTeams.find(t => t.id === id)?.name || id);

  StateManager.mutate(s => {
    for (const series of roundSeries(s.playoffBracket, round)) {
      if (!series.teamA || !series.teamB) continue;
      let dayOffset = 0;
      for (const g of seriesGames(series)) {
        const real = new Date(first); real.setDate(real.getDate() + dayOffset);
        const times = GAME_TIMES_BY_DOW[['SUN','MON','TUE','WED','THU','FRI','SAT'][real.getDay()]] || ['7:05 PM'];
        const gameTime = _timeOn(real, times[times.length - 1]);
        const date = _displayDateFor(s, real.getTime());
        const common = { isPlayoff: true, playoffRound: round, seriesId: series.id,
                         seriesGame: g.gameNo, seriesLength: series.bestOf };
        if (g.homeId === 'user' || g.awayId === 'user') {
          const isHome = g.homeId === 'user';
          const oppId  = isHome ? g.awayId : g.homeId;
          const game = _makeGameObject({ index: s.schedule.length, opponent: nameOf(oppId), isHome,
            date, gameTime, isSpring: false, phase: ROUND_PHASE[round] });
          Object.assign(game, common, { opponentId: oppId });
          s.schedule.push(game);
        } else {
          (s.leagueSchedule.dayMap[date] = s.leagueSchedule.dayMap[date] || []).push({
            id: `po-${s.seasonNum || 1}-${series.id}-${g.gameNo}`, homeId: g.homeId, awayId: g.awayId,
            date, gameTime, isSpring: false, ...common,
            status: GAME_STATUS.SCHEDULED, played: false, homeScore: null, awayScore: null,
          });
        }
        dayOffset += 1 + (round === 'WORLD_SERIES' && (g.gameNo === 2 || g.gameNo === 5) ? 1 : 0);
      }
    }
  });
  _applyPhase(ROUND_PHASE[round]);
}

/** Remove a clinched series' games that will never be played. */
function _cancelSeriesGames(seriesId) {
  StateManager.mutate(s => {
    const before = s.schedule.length;
    s.schedule = s.schedule.filter(g => !(g.seriesId === seriesId && g.isPlayoff && !g._committed
                                         && g.status === GAME_STATUS.SCHEDULED));
    if (s.schedule.length !== before) s.schedule.forEach((g, i) => { g.index = i; });
    for (const [d, games] of Object.entries(s.leagueSchedule.dayMap)) {
      const kept = games.filter(g => !(g.seriesId === seriesId && g.isPlayoff && !g.played
                                       && g.status === GAME_STATUS.SCHEDULED));
      if (kept.length !== games.length) {
        if (kept.length) s.leagueSchedule.dayMap[d] = kept; else delete s.leagueSchedule.dayMap[d];
      }
    }
  });
}

function _timeOn(day, timeStr) {
  const [hm, mer] = timeStr.split(' ');
  let [h, m] = hm.split(':').map(Number);
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  const d = new Date(day); d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** The baseball-calendar date shown for a real day (one offset for the season). */
function _displayDateFor(state, realMs) {
  const base = state.schedule[0];
  const baseReal = new Date(base.gameTime); baseReal.setHours(0, 0, 0, 0);
  const real = new Date(realMs); real.setHours(0, 0, 0, 0);
  const days = Math.round((real - baseReal) / 86_400_000);
  const [y, mo, d] = base.date.split('-').map(Number);
  return _isoDate(new Date(y, mo - 1, d + days));
}

/** Queue phase milestones (no game trigger) — playoff rounds only while the user is in them. */
function _queuePhaseMilestones(phase) {
  const st = StateManager.get();
  const round = roundForPhase(phase);
  if (round) {
    const inRound = roundSeries(st.playoffBracket, round)
      .some(sr => sr.teamA?.id === 'user' || sr.teamB?.id === 'user');
    if (!inRound) return;
  }
  const season = st.seasonNum || 1;
  for (const m of Object.values(MILESTONE_SCREENS)) {
    if (m.triggerPhase !== phase || (m.triggerGame !== null && m.triggerGame !== undefined)) continue;
    if (m.requiresHosting && !st.userTeam?._hostedAllStar) continue;
    if (m.minSeason && season < m.minSeason) continue;
    const key = `${m.id}@${season}`;
    if ((st.seenMilestones || []).includes(key)) continue;
    StateManager.mutate(s => {
      s.seenMilestones = [...(s.seenMilestones || []), key];
      s.milestoneQueue = [...(s.milestoneQueue || []), { ...m }];
    });
  }
}

/** The user's series ended: Series Won / Champions / Season Over. */
function _queueSeriesMilestone(res) {
  const sr = res.series;
  if (!sr || (sr.teamA?.id !== 'user' && sr.teamB?.id !== 'user')) return;
  const won = res.winnerId === 'user';
  const opp = won ? (sr.teamA.id === 'user' ? sr.teamB : sr.teamA) : (sr.teamA.id === 'user' ? sr.teamB : sr.teamA);
  const label = ROUND_LABEL[sr.round];
  const record = sr.teamA.id === 'user' ? `${sr.winsA}–${sr.winsB}` : `${sr.winsB}–${sr.winsA}`;
  const id = won ? (sr.round === 'WORLD_SERIES' ? 'CHAMPIONS' : 'SERIES_WON') : 'SEASON_OVER';
  const base = MILESTONE_SCREENS[id];
  if (!base) return;
  const subtitle = won
    ? (sr.round === 'WORLD_SERIES' ? `World Series won ${record} over the ${opp?.name}. ${base.subtitle}`
                                   : `${label} won ${record} over the ${opp?.name}. ${base.subtitle}`)
    : `Eliminated ${record} by the ${opp?.name} in the ${label}. ${base.subtitle}`;
  StateManager.mutate(s => { s.milestoneQueue = [...(s.milestoneQueue || []), { ...base, subtitle }]; });
}

// ─────────────────────────────────────────────────────────────
// ROSTER CLOCK (§65)
// ─────────────────────────────────────────────────────────────

/**
 * advanceClock(nowMs = Date.now(), { events, reconcileAll })
 * Moves the league's roster clock forward to min(nowMs, first pitch of the
 * next unplayed game) and makes everything due by then happen, in order:
 *   1. roster cards past their deadline auto-resolve (at their deadline);
 *   2. TransactionEngine.applyDue — trades, arrivals, IL clearances,
 *      day-to-day returns, the GM's vacancy deadline / manager call-up;
 *   3. the inbox is synced to the roster (new cards, withdrawn ghosts).
 * Cheap and write-free when nothing is due (called every app tick).
 *
 * @param {Number} [nowMs]
 * @param {Object} [opts]
 * @param {Object[]} [opts.events]       extra events for the card sync (injuries)
 * @param {Boolean}  [opts.reconcileAll] reconcile every team (commit)
 * @returns {{ changed: Boolean, events: Object[], clockMs: Number }}
 */
export function advanceClock(nowMs = Date.now(), opts = {}) {
  const state = StateManager.get();
  if (!state?.userTeam) return { changed: false, events: [], clockMs: nowMs };
  const clockMs = rosterClock(state, nowMs);

  // League games and roster moves interleave in real-time order: before each
  // CPU first pitch / final out, everything due by that moment happens first.
  const events = [...(opts.events || [])];
  let changed = false;
  // §78: every club's books (a save from before r76 opens the CPU clubs'),
  // and this season's pay calendar (built once per season from the schedule).
  const season = state.seasonNum || 1;
  const clubIds = ['user', ...(state.leagueTeams || []).map(t => t.id)];
  if ((state.leagueTeams || []).some(t => !t.finances)
      || [state.userTeam, ...(state.leagueTeams || [])].some(t => t.finances?.cal?.seasonNum !== season)) {
    StateManager.mutate(s => {
      for (const t of s.leagueTeams || []) if (!t.finances) Finance.initClubBooks(s, t.id);
      for (const id of clubIds) Finance.ensureSeason(s, id);
    });
  }
  // §90 the league's trade desk: one moment a day when CPU clubs make deals.
  if (!state.tradeDesk?.nextAtMs) StateManager.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), nextAtMs: LeagueTrades.nextDeskAt(clockMs) }; });
  for (let guard = 0; guard < 12000; guard++) {
    _ensureWeatherPlans(clockMs);   // §102.3 every game's weather, a few hours ahead
    _wxUserCards(clockMs);          // §102.5 the manager's question when rain threatens our game
    const st   = StateManager.get();
    const game = [..._leagueGameEvents(st, clockMs), ..._userWeatherEvents(st, clockMs)].sort((a, b) => a.at - b.at)[0];
    const os   = Offseason.dueSteps(st, clockMs)[0];
    const fin  = clubIds.flatMap(id => Finance.dueSteps(st, clockMs, id)).sort((a, b) => a.at - b.at)[0];
    const desk = st.tradeDesk?.nextAtMs <= clockMs ? { kind: 'desk', at: st.tradeDesk.nextAtMs } : null;
    const cands = [game, os && { kind: 'offseason', ...os }, fin && { ...fin, kind: `fin:${fin.kind}` }, desk].filter(Boolean);
    const next = cands.sort((a, b) => a.at - b.at)[0] || null;
    if (!next) break;
    const step = _rosterStep(next.at, {});
    events.push(...step.events);
    if (next.kind === 'start') { if (!_wxHoldForClubs(next.ref, next.at)) _startLeagueGame(next.date, next.i); }
    else if (next.kind === 'final') events.push(..._finishLeagueGame(next.date, next.i));
    else if (next.kind === 'ppd') _postponeGame(next.ref, next.at);
    else if (next.kind === 'wait') StateManager.mutate(s => { const x = _wxResolve(s, next.ref).g; if (x) x.status = GAME_STATUS.DELAYED; });
    else if (next.kind === 'suspend') _suspendGame(next.ref, next.at);
    else if (next.kind === 'resume') _resumeGame(next.ref, next.at);
    else if (next.kind === 'fin:accrue') StateManager.mutate(s => { Finance.accrueDay(s, next.day, next.teamId); });
    else if (next.kind === 'fin:payday') events.push(...(next.teamId === 'user' ? _payday(next.i, next.at) : _cpuPayday(next.teamId, next.i, next.at)));
    else if (next.kind === 'desk') events.push(..._runTradeDesk(next.at));
    else events.push(..._runOffseasonStep(next.step, next.at));
    events.push(..._seasonProgress(next.at));
    changed = true;
  }
  events.push(..._seasonProgress(clockMs));
  const step = _rosterStep(clockMs, { reconcileAll: !!opts.reconcileAll, events });
  // §95 any move, injury, development or offseason step that changed the
  // club's rating is a point on its history.
  if (teamRating(StateManager.get(), 'user') !== (StateManager.get().ratingHistory || []).slice(-1)[0]?.r
      || (StateManager.get().ratingHistory || []).slice(-1)[0]?.s !== (StateManager.get().seasonNum || 1)) {
    StateManager.mutate(s => { recordRating(s, clockMs); });
  }
  return { changed: changed || step.changed || events.some(e => e.type === 'PHASE'),
           events: [...events, ...step.events], clockMs };
}

// ─────────────────────────────────────────────────────────────
// THE OFFSEASON ON THE CLOCK (§70)
// ─────────────────────────────────────────────────────────────

/**
 * _runOffseasonStep(step, atMs)
 * One step of the six-day offseason (OffseasonEngine has the work; this runs
 * it at its moment, delivers the GM's cards and records the league's moves).
 * Steps run once each, in order — catch-up after the app was closed replays
 * them at their own times.
 */
function _runOffseasonStep(step, atMs) {
  const events = [];
  let st = StateManager.get();
  const os = st.offseason;
  if (!os) return events;
  const done = () => StateManager.mutate(s => { if (s.offseason) s.offseason.done = [...(s.offseason.done || []), step]; });
  const cardAt = (n, hour) => Offseason._atHour(Offseason.dayStart(os, n), hour);
  const springAt = os.springAt;

  if (step === 'day1') {
    _applyPhase(PHASE.OFFSEASON);
    events.push({ type: 'PHASE', to: PHASE.OFFSEASON });
    let ev = [];
    StateManager.mutate(s => {
      ev = Offseason.beginOffseason(s, atMs);
      // §100 the offseason on the weather calendar: the climate blends from
      // where the season ended to the next spring's first day.
      addCalendarEntry(s, offseasonAnchor(os.dayStarts[0], springAt, springStartIso(baseballYear(s) + 1), s.seasonNum || 1));
    });
    _feedLeagueMoves(ev);
    const offer = Offseason.ownershipOffer(StateManager.get());
    CardEngine.deliverOwnershipCard(offer, cardAt(1, OFFSEASON_CARD_HOUR), springAt);
    for (const e of ev.filter(e => e.type === 'RETIRED' && e.teamId === 'user')) {
      CardEngine.deliverRetirementNotice(e.playerId, e.age, cardAt(1, OFFSEASON_CARD_HOUR));
    }
    done();
    return events;
  }

  if (step === 'day2') {
    let ev = [];
    StateManager.mutate(s => { ev = Offseason.contractDay(s, atMs); });
    _feedLeagueMoves(ev);
    for (const { player } of Offseason.userExpiring(StateManager.get())) {
      CardEngine.deliverResignCard(player.id, cardAt(2, OFFSEASON_CARD_HOUR), springAt);
    }
    _cpuFreeAgencyRound(atMs);
    CardEngine.deliverFreeAgentCards(cardAt(2, OFFSEASON_FA_CARD_HOUR), springAt);
    done();
    return events;
  }

  if (step === 'day3') {
    if (Offseason.managerContractIsUp(StateManager.get())) {
      CardEngine.deliverManagerContractCard(cardAt(3, OFFSEASON_CARD_HOUR), springAt);
    }
    _cpuFreeAgencyRound(atMs);
    done();
    return events;
  }

  if (step === 'day4' || step === 'day5' || step === 'day6') {
    _cpuFreeAgencyRound(atMs);
    if (step === 'day4') CardEngine.deliverFreeAgentCards(cardAt(4, OFFSEASON_FA_CARD_HOUR), springAt);
    if (step === 'day5') CardEngine.deliverGateReminder(cardAt(5, OFFSEASON_CARD_HOUR), springAt);
    done();
    return events;
  }

  if (step === 'spring') {
    // Required decisions still open were auto-resolved by the roster step at
    // this same moment (their deadline is spring). Now the new season.
    let ev = [];
    StateManager.mutate(s => {
      ev = Offseason.openNewSeason(s, atMs);
      for (const t of s.leagueTeams || []) applyRosterMutation(s, reconcileRoster(s, t.id, { autoManage: true }));
      applyRosterMutation(s, reconcileRoster(s, 'user'));
      const { schedule, leagueSchedule } = generateLeagueCalendar(s.seasonNum, s.leagueTeams, new Date(springAt),
        { year: baseballYear(s), userDivisionId: s.userTeam.divisionId || 'A' });
      s.schedule       = schedule;
      s.leagueSchedule = leagueSchedule;
      addCalendarEntry(s, calendarAnchor(schedule, s.seasonNum, s.weatherTzMin));   // §100
      s.userTeam.finances.payroll = computePayroll(s);
    });
    _feedLeagueMoves(ev);
    _applyPhase(PHASE.SPRING_TRAINING);
    events.push({ type: 'PHASE', to: PHASE.SPRING_TRAINING });
    StateManager.mutate(s => {
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
        buildActivityFeedEntry('milestone', s.userTeam.abbr, `Spring training opens — Season ${s.seasonNum}`, atMs)]);
    });
    return events;
  }
  return events;
}

/** One CPU free-agency round, recorded in the activity feed. */
function _cpuFreeAgencyRound(atMs) {
  let ev = [];
  StateManager.mutate(s => { ev = Offseason.cpuFreeAgencyRound(s, atMs); });
  _feedLeagueMoves(ev);
}

/** League moves worth a line in the activity feed. */
function _feedLeagueMoves(events) {
  const st = StateManager.get();
  const level = st.leagueTalentOffset || 0;
  const abbrOf = (id) => id === 'user' ? st.userTeam.abbr : (st.leagueTeams.find(t => t.id === id)?.abbr || '');
  const lines = [];
  for (const e of events || []) {
    const p = st.players[e.playerId];
    if (!p) continue;
    const notable = (p.ovr || 0) - level >= 58 || e.teamId === 'user' || e.fromTeamId === 'user';
    const who = `${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr})`;
    const at = e.atMs;
    if (e.type === 'FA_SIGNED') lines.push([abbrOf(e.teamId), `${abbrOf(e.teamId)} sign free agent ${who}`, at]);
    else if (e.type === 'RETIRED' && notable) lines.push([abbrOf(e.teamId), `${who} retires`, at]);
    else if (e.type === 'DEPARTED' && e.reason === 'abroad' && notable) lines.push([abbrOf(e.fromTeamId), `${who} signs with a club in another league`, at]);
    else if (e.type === 'FREE_AGENT' && notable) lines.push([abbrOf(e.fromTeamId), `${who} becomes a free agent`, at]);
  }
  // §90 the League wire keeps every signing, and the notable departures.
  const wire = [];
  for (const e of events || []) {
    const p = st.players[e.playerId];
    if (!p) continue;
    const who = `${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr})`;
    const nm = (id) => _clubName(st, id);
    if (e.type === 'FA_SIGNED') wire.push({ atMs: e.atMs, kind: 'signing', teamIds: [e.teamId], text: `${nm(e.teamId)} sign free agent ${who}` });
    else if (e.type === 'FREE_AGENT' && e.fromTeamId) wire.push({ atMs: e.atMs, kind: 'release', teamIds: [e.fromTeamId], text: `${who} leaves ${nm(e.fromTeamId)} as a free agent` });
    else if (e.type === 'RETIRED') wire.push({ atMs: e.atMs, kind: 'retire', teamIds: [e.teamId].filter(Boolean), text: `${who} retires${e.teamId ? ` (${nm(e.teamId)})` : ''}` });
  }
  if (wire.length) StateManager.mutate(s => _wireAdd(s, wire));
  if (!lines.length) return;
  StateManager.mutate(s => {
    s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
      ...lines.map(([abbr, text, at]) => buildActivityFeedEntry('signing', abbr, text, at))]);
  });
}

// ─────────────────────────────────────────────────────────────
// THE TRADE DESK AND THE LEAGUE WIRE (§90 Phase 4c)
// ─────────────────────────────────────────────────────────────

const _clubName = (st, id) => id === 'user'
  ? (st.userTeam.name || [st.userTeam.city, st.userTeam.nickname].filter(Boolean).join(' ') || 'Our club')
  : ((st.leagueTeams || []).find(t => t.id === id)?.name || id);
const _clubAbbr = (st, id) => id === 'user' ? st.userTeam.abbr : ((st.leagueTeams || []).find(t => t.id === id)?.abbr || id);

/**
 * _runTradeDesk(atMs) — the day's moment for CPU clubs to deal: every trade a
 * club with a need can make with a club that has the player (LeagueTrades),
 * carried out at once through the ledger. A club that wants one of OUR
 * players calls instead (§91): its opening offer reaches the inbox, and it
 * waits for our answer. The next desk is tomorrow.
 */
function _runTradeDesk(atMs) {
  const found = LeagueTrades.findLeagueTrades(StateManager.get(), atMs);
  const deals = found.filter(d => !d.call);
  for (const d of found.filter(x => x.call)) CardEngine.deliverTradeCall(d, atMs);
  CardEngine.runWatches(atMs);   // §99 searches Pro Scouting is keeping an eye on
  StateManager.mutate(s => {
    const last = { ...(s.tradeDesk?.lastTradeMs || {}) };
    for (const d of deals) {
      // (A club in the middle of a game finishes it first — the ledger holds
      // the deal until the final out: TransactionEngine._executeTrade.)
      s.transactions = [...(s.transactions || []), LeagueTrades.leagueTradeTx(d, atMs)];
      last[d.a] = atMs; last[d.b] = atMs;
    }
    s.tradeDesk = { ...(s.tradeDesk || {}), nextAtMs: LeagueTrades.nextDeskAt(atMs), lastTradeMs: last };
  });
  // §90 as the deadline nears, Pro Scouting's best target for our biggest need.
  const g = regularIndex(StateManager.get());
  if (StateManager.get().phase !== PHASE.SPRING_TRAINING && g >= TRADE_DEADLINE_OPEN - 6 && g <= TRADE_DEADLINE_CLOSE - 1) CardEngine.deliverDeadlineIdea(atMs);
  return deals.length ? _rosterStep(atMs).events : [];
}

/** A trade in a line: who got whom, for whom, and the money. */
function _tradeLine(st, tx, { short = false } = {}) {
  const P = (id) => st.players[id];
  const ref = (id) => { const p = P(id); return p ? (short ? p.name : `${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr})`) : 'a player'; };
  const list = (ids) => {
    const xs = (ids || []).map(ref);
    return xs.length <= 1 ? (xs[0] || 'nothing') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  };
  const a = tx.teamId || 'user', b = tx.fromTeamId;
  const nm = short ? (id) => _clubAbbr(st, id) : (id) => _clubName(st, id);
  const got = tx.offer?.incomingIds || [], sent = tx.offer?.outgoingIds || [];
  let line = got.length
    ? `${nm(a)} acquire ${list(got)} from ${nm(b)}${sent.length ? ` for ${list(sent)}` : ''}`
    : `${nm(b)} acquire ${list(sent)} from ${nm(a)}`;
  if (short) return line;
  const cash = tx.offer?.cashK || 0;
  if (cash > 0) line += `, with ${formatK(cash)} from ${nm(b)}`;
  if (cash < 0) line += `, with ${formatK(-cash)} from ${nm(a)}`;
  for (const [id, pct] of Object.entries(tx.offer?.retain || {})) {
    const payer = got.includes(id) ? b : a;
    line += `; ${nm(payer)} keep paying ${Math.round(pct * 100)}% of ${P(id) ? `${P(id).name}'s` : 'a'} salary this season`;
  }
  return line;
}

/** Add entries to the League wire (this season and last, newest kept). */
function _wireAdd(draft, entries) {
  const season = draft.seasonNum || 1;
  const add = entries.map((e, i) => ({ id: `w-${e.atMs}-${(draft.leagueWire || []).length + i}`, season, ...e }));
  draft.leagueWire = [...(draft.leagueWire || []), ...add]
    .filter(e => e.season >= season - 1)
    .slice(-LEAGUE_TRADES.wireKeep);
}

/** §90 the roster clock's moves on the wire, and CPU trades in Recent. */
function _recordMoves(events) {
  const trades = (events || []).filter(e => e.type === 'TRADE_EXECUTED');
  const claims = (events || []).filter(e => e.type === 'WAIVER_CLAIMED');
  if (!trades.length && !claims.length) return;
  const st = StateManager.get();
  const wire = [], feed = [];
  for (const e of trades) {
    const tx = e.tx;
    wire.push({ atMs: e.atMs, kind: 'trade', teamIds: [tx.teamId || 'user', tx.fromTeamId], text: _tradeLine(st, tx) });
    feed.push(buildActivityFeedEntry('trade', _clubAbbr(st, tx.teamId || 'user'), _tradeLine(st, tx, { short: true }), e.atMs));
  }
  for (const e of claims) {
    const p = st.players[e.playerId];
    if (!p) continue;
    wire.push({ atMs: e.atMs, kind: 'claim', teamIds: [e.teamId],
      text: `${_clubName(st, e.teamId)} claim ${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr}) off waivers` });
  }
  StateManager.mutate(s => {
    _wireAdd(s, wire);
    if (feed.length) s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), ...feed]);
  });
}

/**
 * §90 an advance scouting report on tonight's opponent (bought from a card
 * when a rival got better) covers our games against them through the series
 * it was made for: our hitters see a little more, theirs a little less.
 */
function _scoutFor(state, game, opp, isSpring) {
  const r = opp && state.userTeam?.advanceReports?.[opp.id];
  if (!r || isSpring || !((game.gameTime || 0) <= r.coversThroughMs)) return null;
  return { bat: ADVANCE_SCOUT.batHit, pitch: ADVANCE_SCOUT.pitchHit };
}

/** One roster-clock step at `atMs`: deadlines, ledger, card sync. */
function _rosterStep(atMs, { reconcileAll = false, events: extra = [] } = {}) {
  const expired = CardEngine.expireDueRosterCards(atMs);
  let applied = { changed: false, events: [] };
  if (expired || reconcileAll || extra.length || hasDue(StateManager.get(), atMs)) {
    StateManager.mutate(s => {
      applied = applyDue(s, atMs, { reconcileAll });
      if (applied.changed || reconcileAll) s.userTeam.finances.payroll = computePayroll(s);
    });
  }
  // §71: development increments due on the clock.
  if (Development.developmentDue(StateManager.get(), atMs)) {
    let dev = [];
    StateManager.mutate(s => { dev = Development.applyDevelopment(s, atMs); });
    applied = { changed: true, events: [...applied.events, ...dev] };
  }
  _recordMoves(applied.events);
  const cards = CardEngine.syncRosterCards([...extra, ...applied.events], atMs);
  return {
    changed: expired > 0 || applied.changed || cards.delivered > 0 || cards.withdrawn > 0,
    events:  applied.events,
  };
}

/**
 * gmCallUp(playerId, nowMs)
 * The GM calls a farm player up (Team screen dashed spot or farm row). Same
 * ledger path as an inbox call-up: he reports the next calendar day, and the
 * roster clock withdraws whatever inbox card was asking for that spot.
 * @returns {{ ok: Boolean, error?: String, tx?: Object }}
 */
export function gmCallUp(playerId, nowMs = Date.now()) {
  let res = { ok: false, error: 'No team loaded.' };
  if (!StateManager.get()?.userTeam) return res;
  StateManager.mutate(s => { res = callUp(s, playerId, 'user', nowMs, 'gm'); });
  if (res.ok) {
    const rec = reconcileRoster(StateManager.get(), 'user');
    StateManager.mutate(s => applyRosterMutation(s, rec));
    advanceClock(nowMs);
  }
  return res;
}

/**
 * gmSignFreeAgent(playerId, dropId, nowMs) — §96 the GM signs a free agent
 * from the League screen. If his side of the 28 is full, `dropId` (the GM's
 * choice) goes down first. With games on he reports the next day.
 * Returns { ok, reason }.
 */
export function gmSignFreeAgent(playerId, dropId = null, nowMs = Date.now()) {
  const st = StateManager.get();
  if (!st?.userTeam) return { ok: false, reason: 'no team loaded' };
  const why = FreeAgency.signBlocker(st, playerId, dropId);
  if (why) return { ok: false, reason: why };
  StateManager.mutate(s => {
    FreeAgency.sign(s, playerId, nowMs, dropId);
    applyRosterMutation(s, reconcileRoster(s, 'user'));
    s.userTeam.finances.payroll = computePayroll(s);
    const p = s.players[playerId];
    _wireAdd(s, [{ atMs: nowMs, kind: 'signing', teamIds: ['user'],
      text: `${_clubName(s, 'user')} sign free agent ${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr})` }]);
  });
  advanceClock(nowMs);
  return { ok: true };
}

/**
 * gmClaimOffWaivers(playerId, dropId, nowMs) — §96 the GM puts in a waiver
 * claim. It is decided when the 72-hour window closes, in claiming order; if
 * it's ours and his side is full then, `dropId` goes down. Returns { ok, reason }.
 */
export function gmClaimOffWaivers(playerId, dropId = null, nowMs = Date.now()) {
  const st = StateManager.get();
  if (!st?.userTeam) return { ok: false, reason: 'no team loaded' };
  const why = FreeAgency.claimBlocker(st, playerId, dropId, nowMs);
  if (why) return { ok: false, reason: why };
  StateManager.mutate(s => { FreeAgency.claim(s, playerId, dropId); });
  return { ok: true };
}

/** §96 the GM takes back a waiver claim before the window closes. */
export function gmWithdrawClaim(playerId) {
  StateManager.mutate(s => { FreeAgency.withdrawClaim(s, playerId); });
  return { ok: true };
}

/**
 * debugInjure(playerId, nowMs) — DEV ONLY (Developer Menu).
 * Injures a user player through the real path: 'evaluating' now, Act 1 in
 * the inbox right away, then the normal two-act flow and roster clock.
 */
export function debugInjure(playerId, nowMs = Date.now()) {
  const st = StateManager.get();
  const p  = st?.players?.[playerId];
  if (!p || p.injury || p.teamId !== 'user') return false;
  StateManager.mutate(s => Object.assign(s.players[playerId], beginInjury(p, nowMs)));
  const rec = reconcileRoster(StateManager.get(), 'user');
  StateManager.mutate(s => applyRosterMutation(s, rec));
  // Event dated 20 minutes back so Act 1 (5–20 min after the injury) is due now.
  CardEngine.syncRosterCards([{ type: 'INJURY', teamId: 'user', playerId, atMs: nowMs - 20 * 60_000 }], nowMs);
  return true;
}

/** When a game ended on the real clock: its last play, else first pitch + 3h. */
function _gameEndMs(game) {
  const last = game?.plays?.[game.plays.length - 1];
  if (last && Number.isFinite(last._timestamp)) return last._timestamp;
  return (game?.gameTime || Date.now()) + GAME_DURATION_FALLBACK_MS;
}

/**
 * _appearances(state, gameIndex)
 * Who took the field on this game day, per team — the injury exposure.
 * User + opponent from the committed box score (actual appearances); the
 * other CPU teams playing that date from their active lineup, today's
 * starter and a few relievers (their games have no box score).
 */
function _appearances(state, gameIndex) {
  const g   = state.schedule[gameIndex];
  const out = [];
  const opp = (state.leagueTeams || []).find(t => t.name === g?.opponent) || null;
  const box = g?.boxScore;
  const fromBox = (teamId, side) => side && out.push({
    teamId,
    hitterIds:   (side.hitters  || []).map(h => h.id),
    starterId:   side.pitchers?.[0]?.id || null,
    relieverIds: (side.pitchers || []).slice(1).map(p => p.id),
  });
  if (box) {
    fromBox('user', box.userIsHome ? box.home : box.away);
    if (opp) fromBox(opp.id, box.userIsHome ? box.away : box.home);
  }
  // Other CPU clubs' injuries come from their own games (_finishLeagueGame).
  return out;
}

function _userQualifiedForPlayoffs(state) {
  // All 5 teams per division qualify (Section 26 — LOCKED).
  // 4th and 5th seeds play the Wild Card single-elimination game.
  // This function always returns true — kept for structural consistency
  // and to allow future changes without touching callsites.
  return true;
}

/**
 * _getUserPlayoffSeed(state)
 * Returns the user team's seed (1-5) within their division.
 * Used to determine Wild Card eligibility and bracket placement.
 */
function _getUserPlayoffSeed(state) {
  const standings = state.standings;
  if (!standings) return 3; // safe fallback
  const divUser = state.userTeam.divisionId === 'B' ? standings.divB : standings.divA;
  const entry   = (divUser || []).find(t => t.id === 'user');
  return entry?.seed || 3;
}

function _countPlayoffRoundsWon(state) {
  const b = state.playoffBracket;
  if (!b) return 0;
  return ['WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES']
    .flatMap(r => roundSeries(b, r))
    .filter(sr => sr.status === 'final'
      && (sr.winner === 'A' ? sr.teamA : sr.teamB)?.id === 'user').length;
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// ─────────────────────────────────────────────────────────────
// PLAYOFF HELPERS
// ─────────────────────────────────────────────────────────────

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
