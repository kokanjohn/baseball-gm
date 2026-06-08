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
 *   - runOffseason()               — executes the 12-step offseason sequence
 *
 * Rules:
 *   - The only module that imports StateManager.
 *   - All other engines receive state as a parameter and return mutations.
 *   - GameEngine applies those mutations via StateManager.mutate().
 *   - GameEngine does NOT generate cards. CardEngine (Phase 9) does that.
 *     GameEngine assembles the context object CardEngine needs.
 *   - Weather status transitions are evaluated here; WeatherEngine (Phase 7)
 *     owns the weather data generation.
 */

import * as StateManager from '../store/StateManager.js';

import {
  buildFullLeague,
  LEAGUE_TEAMS,
} from './LeagueFactory.js';

import {
  generateUserSchedule,
  generateCPUSchedules,
  getNextPhase,
  buildPlayoffBracket,
  scheduleMakeupGame,
  buildActivityFeedEntry,
  pruneActivityFeed,
  _isoDate,
} from './SeasonEngine.js';

import {
  processCPUDay,
  processCPURosterDecisions,
  processWaiverClaims,
  computeFullStandings,
} from './LeagueEngine.js';

import {
  drainPendingTrades,
  checkDepth,
  autoResolveDepth,
  autoResolveSpringCuts,
  applySpringCuts,
  toggleKeeperTag,
  computePayroll,
  returnFromIL,
} from './RosterEngine.js';

import { computeOVR, computeAge } from './PlayerFactory.js';
import { STAFF_NAMES } from '../data/player-names.js';
import {
  generatePlays,
  accumulateStats,
  computeWinProbability,
} from './SimEngine.js';
import * as CardEngine from './CardEngine.js';
import { computeAllIMP, appendGameLog } from './IMPEngine.js';
import { computeSeasonPrestige, checkTurningPointEligibility, applyTurningPoint, evaluateAllStarHostingEligibility } from './PrestigeEngine.js';
import {
  initOffseason,
  advanceOffseasonDay,
  checkHardGates,
  autoResolveHardGates,
  canBeginSpringTraining,
  processOffseasonStep1,
  processOffseasonSteps2to5,
  processOffseasonStep7,
  processOffseasonStep8,
  processOffseasonStep11to12,
  getOffseasonStatus,
  OFFSEASON_DAY_POOLS,
} from './OffseasonEngine.js';

import {
  PHASE,
  GAME_STATUS,
  GAME_TICK_MS,
  MILESTONE_SCREENS,
  PLAYOFF_WILD_CARD_GAMES,
  PLAYOFF_FIRST_ROUND_BEST_OF,
  PLAYOFF_DIVISION_SERIES_BEST_OF,
  PLAYOFF_WORLD_SERIES_BEST_OF,
  REGULAR_SEASON_GAME_COUNT,
  SPRING_TRAINING_GAME_COUNT,
  ALL_STAR_BREAK_AFTER_GAME,
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
} from '../data/constants.js';

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
  const league   = buildFullLeague({
    archetypeId: config.archetypeId,
    seasonNum:   1,
    uuidFn,
    userTeam:    state.userTeam,
    region:      config.region || 'north',
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

  const schedule        = generateUserSchedule(1, league.leagueTeams, scheduleAnchor);
  const leagueSchedule  = generateCPUSchedules(1, league.leagueTeams);

  // Apply everything to state in one batch
  StateManager.mutate(s => {
    // Players registry
    Object.assign(s.players, league.players);

    // User team
    s.userTeam.rosterIds   = league.rosterIds;
    s.userTeam.farmIds     = league.farmIds;
    s.userTeam.lineupSlots = league.lineupSlots;
    s.userTeam.finances.payroll = league.payroll;

    // Populate SP rotation order from the generated roster.
    // _getRotationSP uses this to pick the correct starter each game.
    // Without this, every game uses the highest-OVR SP and rotation never advances.
    const spIds = league.rosterIds.filter(id => {
      const p = s.players[id];
      return p && p.group === PLAYER_GROUP.STARTING_PITCHERS;
    });
    s.userTeam.rotation = {
      order:        spIds,
      currentIndex: 0,
    };

    // League teams
    s.leagueTeams = league.leagueTeams;

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

    // Schedule
    s.schedule       = schedule;
    s.leagueSchedule = leagueSchedule;

    // Geographic region — set from setup config, persists for lifetime of franchise
    if (config.region)        s.settings.region        = config.region;
    if (config.primaryColor)  s.settings.primaryColor  = config.primaryColor;
    if (config.secondaryColor) s.settings.secondaryColor = config.secondaryColor;

    // Phase
    s.phase = PHASE.SPRING_TRAINING;

    // Initial standings
    s.standings = computeFullStandings(s);
  });

  await StateManager.save();

  // ── Seed initial inbox cards (v1 parity — sp1, sp2, one trade card) ──────
  // Delivered after save so they're immediately visible on first dashboard load.
  try {
    const { deliverCardById } = await import('./CardEngine.js');
    // Spring training openers
    deliverCardById('sp1');
    deliverCardById('sp2');
    // Seed one random trade card so the GM has a real decision on day 1
    const tradeIds = ['t1','t2','t3','t4','t5'];
    const randomTrade = tradeIds[Math.floor(Math.random() * tradeIds.length)];
    deliverCardById(randomTrade);
  } catch (err) {
    console.warn('[GameEngine.startNewGame] Card seeding failed silently:', err.message);
  }

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
 *   - game._tickOffset — timestamp drift correction after weather delays
 *   - game.plays — null until SimEngine populates them (Phase 6)
 *
 * Returns the updated game object if a play was revealed, null otherwise.
 *
 * @returns {Object|null} updated game object
 */
export function tick() {
  const state = StateManager.get();
  const game  = getNextGame();

  if (!game) return null;

  // Paused states — do not advance
  if ([GAME_STATUS.DELAYED, GAME_STATUS.SUSPENDED, GAME_STATUS.POSTPONED].includes(game.status)) {
    return null;
  }

  // Check if it's time to activate a scheduled game
  if (game.status === GAME_STATUS.SCHEDULED || game.status === GAME_STATUS.PRE_GAME_WATCH) {
    const now = Date.now();
    if (game.gameTime && now >= game.gameTime) {
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
  const offset       = game._tickOffset || 0;
  const nextPlayIdx  = game.livePlayIndex || 0;
  const nextPlay     = game.plays[nextPlayIdx];

  if (!nextPlay) {
    // All plays exhausted — game is over, pending commit
    return null;
  }

  // Reveal play if its adjusted timestamp has passed
  const adjustedTimestamp = (nextPlay._timestamp || 0) + offset;
  if (now < adjustedTimestamp) return null;

  // Advance the play index
  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    g.livePlayIndex = nextPlayIdx + 1;

    // Update live score from play's cumulative score fields
    // (cumOurScore/cumTheirScore are set by SimEngine on every play)
    if (nextPlay.cumOurScore   !== undefined) g.ourScore   = nextPlay.cumOurScore;
    if (nextPlay.cumTheirScore !== undefined) g.theirScore = nextPlay.cumTheirScore;

    // Mark complete if last play
    if (nextPlayIdx + 1 >= game.plays.length) {
      g.status = GAME_STATUS.FINAL;
    }
  });

  return StateManager.get().schedule[game.index];
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
    return p && !p.isInjured && !p.isSuspended && !p.onPersonalLeave;
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

  const { plays, boxScore } = generatePlays(
    game,
    userTeam,
    opponentTeam,
    players,
    { phase: state.phase, isSpring, winProb }
  );

  // Write plays to state and transition to LIVE
  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    g.plays         = plays;
    g.livePlayIndex = 0;
    g.status        = GAME_STATUS.LIVE;
    // Store the pre-computed box score for reference after commit
    g._precomputedBoxScore = boxScore;
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
    return p && !p.isInjured && !p.isSuspended && !p.onPersonalLeave;
  });

  const winProb = computeWinProbability(
    healthyIds, opponentTeam, players,
    { morale: userTeam.morale || 50, atmosphere: userTeam.atmosphere || 50,
      game, phase: state.phase, region: state.settings?.region }
  );

  const isSpring = game.isSpring || state.phase === PHASE.SPRING_TRAINING;
  const { plays, boxScore } = generatePlays(
    game, userTeam, opponentTeam, players,
    { phase: state.phase, isSpring, winProb }
  );

  // Extract final score from last play
  const lastPlay   = plays[plays.length - 1];
  const ourScore   = lastPlay?.cumOurScore   ?? 0;
  const theirScore = lastPlay?.cumTheirScore ?? 0;
  const won        = ourScore > theirScore;

  StateManager.mutate(s => {
    const g = s.schedule[game.index];
    if (!g) return;
    g.plays              = plays;
    g.livePlayIndex      = plays.length; // all plays "revealed" — no live view
    g.ourScore           = ourScore;
    g.theirScore         = theirScore;
    g.status             = GAME_STATUS.FINAL;
    g._committed         = true;
    g._silentlyCommitted = true;
    g.result             = won ? 'win' : 'loss';
    g.score              = { us: ourScore, them: theirScore };
    g._precomputedBoxScore = boxScore;
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

  const result = { phaseChanged: false, newPhase: null, milestone: null };

  StateManager.mutate(s => {
    const g = s.schedule[gameIndex];

    // ── Step 1: Write final game result fields ─────────────
    // Skip if already written by _silentlyCommitGame.
    if (!alreadyCommitted) {
      const finalOurScore   = g.ourScore   ?? 0;
      const finalTheirScore = g.theirScore ?? 0;
      const won = finalOurScore > finalTheirScore;

      g._committed = true;
      g.result     = won ? 'win' : 'loss';
      g.score      = { us: finalOurScore, them: finalTheirScore };
    }

    // ── Step 1b: Win/loss record ───────────────────────────
    if (!alreadyCommitted && (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.MAKEUP)) {
      const won = (g.ourScore ?? 0) > (g.theirScore ?? 0);
      if (won) {
        s.userTeam.wins++;
        s.userTeam.streak = Math.max(0, s.userTeam.streak) + 1;
      } else {
        s.userTeam.losses++;
        s.userTeam.streak = Math.min(0, s.userTeam.streak) - 1;
      }
    }

    // ── Step 1c: Stat accumulation from plays ──────────────
    // Skip if already done by _silentlyCommitGame.
    if (!alreadyCommitted && g.plays && g.plays.length > 0) {
      const opponentTeam = s.leagueTeams.find(t => t.name === g.opponent) || null;
      const statMutations = accumulateStats(
        g.plays, s.userTeam, opponentTeam, s.players, g.isSpring || false
      );
      const statKey = g.isSpring ? 'springStats' : 'stats';

      // Apply merged stat lines to each player.
      // accumulateStats already merged current + delta — assign directly.
      for (const [playerId, mutation] of Object.entries(statMutations.players || {})) {
        if (!s.players[playerId]) continue;
        s.players[playerId][statKey] = mutation[statKey];
      }

      // IMP game log — append this game's stat delta (not lifetime totals)
      // to each player's rolling log for hot/cold calculation.
      // We need just the per-game delta, so collect it before merging above.
      const perGameDeltas = {}; // { [playerId]: { [stat]: delta } }
      for (const play of g.plays) {
        if (!play._statDeltas || play.type === 'pinch_hit') continue;
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
    if (s.userTeam.rotation?.order?.length > 0) {
      s.userTeam.rotation.currentIndex =
        (s.userTeam.rotation.currentIndex + 1) % s.userTeam.rotation.order.length;
    }

    // ── Step 3: Drain pending trades ──────────────────────
    // Record trade history entries BEFORE draining — pending data still in state.
    const pendingOut = (s.userTeam.rosterIds || [])
      .map(id => s.players[id])
      .filter(p => p && p._pendingDeparture);
    const pendingIn  = s._pendingAcquisitions || [];

    if (pendingOut.length > 0 || pendingIn.length > 0) {
      const outNames = pendingOut.map(p => p.name).join(', ') || '—';
      const inNames  = pendingIn.map(p => p.name).join(', ')  || '—';
      const headline = pendingIn.length === 1 && pendingOut.length === 1
        ? `${pendingIn[0].name} acquired, ${pendingOut[0].name} traded away`
        : `Trade: received ${inNames} — sent ${outNames}`;

      s.history = [...(s.history || []), {
        id:       crypto.randomUUID(),
        type:     'trade',
        season:   s.seasonNum || 1,
        gameIdx:  s.currentGameIndex || 0,
        headline,
        detail:   `Acquired: ${inNames}. Traded away: ${outNames}. Standing at time of trade: ${s.userTeam.wins || 0}–${s.userTeam.losses || 0}.`,
        playerId: pendingIn[0]?.id || null,
        icon:     '🔄',
        userNote: '',
      }];
    }

    const tradeMutations = drainPendingTrades(s);
    _applyMutations(s, tradeMutations);

    // ── Step 4: IL return checks ───────────────────────────
    const gameIdx = gameIndex - SPRING_TRAINING_GAME_COUNT; // regular season index
    for (const playerId of Object.keys(s.players)) {
      const p = s.players[playerId];
      if (p.isInjured && p.ilReturnGame !== null && p.ilReturnGame <= gameIdx) {
        const ilMutations = returnFromIL(s, playerId);
        _applyMutations(s, ilMutations);
      }
    }

    // ── Step 5: Depth check — auto-resolve CRITICAL ────────
    const depthMutations = autoResolveDepth(s);
    _applyMutations(s, depthMutations);

    // ── Step 6: Payroll recalculation ──────────────────────
    s.userTeam.finances.payroll = computePayroll(s);

    // ── Step 6b: IMP game log — append this game's stats ───
    // Append stat increments for each player who appeared in this game
    // (play._statDeltas handles this via accumulateStats — log appended here)
    // IMPEngine.appendGameLog called per player by accumulateStats caller
    // Full IMP recompute happens below after all mutations are applied.    // ── Step 7: Metric history snapshot ───────────────────
    const avgOvr = _computeRosterAvgOvr(s);
    s.metricHistory.push({
      gameIndex,
      ovr:    avgOvr,
      wins:   s.userTeam.wins,
      losses: s.userTeam.losses,
    });
  });

  // ── CPU processing (outside main mutate for clarity) ────
  const dateStr = game.date;

  const cpuDayMutations = processCPUDay(StateManager.get(), dateStr);
  StateManager.mutate(s => _applyMutations(s, cpuDayMutations));

  const cpuRosterMutations = processCPURosterDecisions(StateManager.get(), dateStr);
  StateManager.mutate(s => _applyMutations(s, cpuRosterMutations));

  const waiverMutations = processWaiverClaims(StateManager.get());
  StateManager.mutate(s => _applyMutations(s, waiverMutations));

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
  const regularIdx  = (gameIndex - SPRING_TRAINING_GAME_COUNT);
  // All teams always qualify — userInPlayoffs always true (Section 26)
  const currentPhase = state2.phase;
  let newPhase = null;

  // For playoff phases, only advance when the current round is fully resolved
  if (_isPlayoffPhase(currentPhase)) {
    if (_isPlayoffRoundComplete(state2)) {
      newPhase = getNextPhase(currentPhase, regularIdx, state2.standings, true);
    }
  } else {
    newPhase = getNextPhase(currentPhase, regularIdx, state2.standings, true);
  }

  if (newPhase) {
    await advancePhase(newPhase);
    result.phaseChanged = true;
    result.newPhase     = newPhase;
  }

  // ── Milestone check ───────────────────────────────────────
  const milestone = checkMilestone();
  if (milestone) result.milestone = milestone;

  // ── CardEngine — process followups, then deliver new cards ────
  // processFollowupQueue fires any queued follow-up cards whose atGame was reached.
  // checkAndDeliver selects and delivers new cards based on current context.
  CardEngine.processFollowupQueue();
  CardEngine.checkAndDeliver(buildCardContext());

  // ── Handle postponed game ─────────────────────────────────
  if (game.status === GAME_STATUS.POSTPONED) {
    const makeup = scheduleMakeupGame(StateManager.get().schedule, gameIndex);
    if (makeup) {
      StateManager.mutate(s => {
        const makeupGame = {
          ...s.schedule[gameIndex],
          status:   GAME_STATUS.MAKEUP,
          isMakeup: true,
          date:     makeup.makeupDate,
          index:    makeup.makeupIndex,
          _tickOffset: 0,
        };
        s.schedule.splice(makeup.insertAfterIndex + 1, 0, makeupGame);
        // Re-index
        s.schedule.forEach((g, i) => { g.index = i; });
      });
    }
  }

  await StateManager.save();
  return result;
}

// ─────────────────────────────────────────────────────────────
// WEATHER PAUSE / RESUME
// ─────────────────────────────────────────────────────────────

/**
 * applyWeatherDelay(gameIndex, delayMs)
 * Called by WeatherEngine when a delay clears.
 * Sets _tickOffset so plays resume at correct cadence from the resume moment.
 *
 * @param {Number} gameIndex
 * @param {Number} delayMs    — how long the delay lasted in milliseconds
 */
export function applyWeatherDelay(gameIndex, delayMs) {
  StateManager.mutate(s => {
    const g = s.schedule[gameIndex];
    if (!g) return;
    g._tickOffset  = (g._tickOffset || 0) + delayMs;
    g.status       = GAME_STATUS.LIVE;
  });
}

/**
 * suspendGame(gameIndex)
 * Suspends a game mid-play. Freezes livePlayIndex in place.
 * WeatherEngine calls this when conditions become unplayable.
 *
 * @param {Number} gameIndex
 */
export function suspendGame(gameIndex) {
  StateManager.mutate(s => {
    const g = s.schedule[gameIndex];
    if (!g) return;
    g.status           = GAME_STATUS.SUSPENDED;
    g.resumeFromInning = _currentInning(g);
    g.resumeScore      = { our: g.ourScore, their: g.theirScore };
  });
}

/**
 * resumeSuspendedGame(gameIndex, makeupTimestamp)
 * Resumes a suspended game from its frozen point.
 * Calculates the tick offset from the original game time to the makeup time.
 *
 * @param {Number} gameIndex
 * @param {Number} makeupTimestamp  — Unix ms of the makeup game start time
 */
export function resumeSuspendedGame(gameIndex, makeupTimestamp) {
  StateManager.mutate(s => {
    const g = s.schedule[gameIndex];
    if (!g) return;
    const originalTime = g.gameTime || makeupTimestamp;
    g._tickOffset      = makeupTimestamp - originalTime;
    g.status           = GAME_STATUS.RESUMED;
  });
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
  const state = StateManager.get();

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
      // Apply keeper-based spring cuts before Opening Day.
      // applySpringCuts reads _isKeeper flags directly.
      // autoResolveSpringCuts handles the case where < 28 are tagged.
      const preState = StateManager.get();
      if (preState.userTeam.rosterIds.length > ROSTER_LIMITS.ACTIVE_TOTAL) {
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

    case PHASE.PLAYOFF_BRACKET_BUILD: {
      const standings = computeFullStandings(StateManager.get());
      const bracket   = buildPlayoffBracket(standings);
      // Wire WC winner slot into First Round bracket after WC resolves
      // (done at FIRST_ROUND phase entry — bracket shell built here)
      StateManager.mutate(s => {
        s.playoffBracket = bracket;
        s.standings      = standings;
      });
      break;
    }

    case PHASE.FIRST_ROUND: {
      // Wire Wild Card winners into First Round bracket
      // GameEngine fills bracket.divA.FIRST_ROUND.series[0].away
      // and bracket.divB.FIRST_ROUND.series[0].away from WC results
      const state  = StateManager.get();
      const bracket = state.playoffBracket;
      if (bracket) {
        ['divA', 'divB'].forEach(div => {
          const wcWinner = bracket[div]?.WILD_CARD?.series?.[0]?.winner;
          if (wcWinner && bracket[div]?.FIRST_ROUND?.series?.[0]) {
            bracket[div].FIRST_ROUND.series[0].away = wcWinner;
            bracket[div].FIRST_ROUND.series[0].wins[wcWinner.id] = 0;
          }
        });
        StateManager.mutate(s => { s.playoffBracket = bracket; });
      }
      break;
    }

    case PHASE.OFFSEASON: {
      // Initialize offseason state
      const osInitMuts = initOffseason(StateManager.get());
      StateManager.mutate(s => {
        s.offseasonDay              = osInitMuts.offseasonDay;
        s.offseasonStartedAt        = osInitMuts.offseasonStartedAt;
        s.offseasonHardGatesCleared = osInitMuts.offseasonHardGatesCleared;
        s._offseasonGate            = osInitMuts._offseasonGate;
      });

      // Steps 1-5: Lock record, archive stats, age players, flag expiries
      const step1  = processOffseasonStep1(StateManager.get());
      const step25 = processOffseasonSteps2to5(StateManager.get());
      StateManager.mutate(s => {
        s.seasonHistory = step1.seasonHistory;
        if (step25.players) {
          for (const [id, upd] of Object.entries(step25.players)) {
            if (s.players[id]) Object.assign(s.players[id], upd);
          }
        }
      });

      // Step 7: CPU free agent processing — expired contracts released or re-signed
      const step7 = processOffseasonStep7(StateManager.get());
      StateManager.mutate(s => {
        if (step7.players) {
          for (const [id, upd] of Object.entries(step7.players)) {
            if (s.players[id]) Object.assign(s.players[id], upd);
          }
        }
        if (step7.leagueTeams) s.leagueTeams = step7.leagueTeams;
        if (step7.freeAgentPool) s.freeAgentPool = step7.freeAgentPool;
      });

      // Step 8: Payroll recalculation and financial reset for new season
      const step8 = processOffseasonStep8(StateManager.get());
      StateManager.mutate(s => {
        if (step8.userTeam?.finances) {
          Object.assign(s.userTeam.finances, step8.userTeam.finances);
        }
      });

      break;
    }

    case PHASE.DIVISION_SERIES: {
      // Wire Division Series winners into World Series bracket
      const state = StateManager.get();
      const bracket = state.playoffBracket;
      if (bracket) {
        const divAWinner = bracket.divA?.DIVISION_SERIES?.series?.find(s => s.winner)?.winner;
        const divBWinner = bracket.divB?.DIVISION_SERIES?.series?.find(s => s.winner)?.winner;
        if (divAWinner || divBWinner) {
          if (!bracket.WORLD_SERIES) bracket.WORLD_SERIES = { series: [{}] };
          if (!bracket.WORLD_SERIES.series[0]) bracket.WORLD_SERIES.series[0] = {};
          if (divAWinner) bracket.WORLD_SERIES.series[0].teamA = divAWinner;
          if (divBWinner) bracket.WORLD_SERIES.series[0].teamB = divBWinner;
          bracket.WORLD_SERIES.series[0].wins = {
            [divAWinner?.id || 'a']: 0,
            [divBWinner?.id || 'b']: 0,
          };
          StateManager.mutate(s => { s.playoffBracket = bracket; });
        }
      }
      break;
    }

    case PHASE.WORLD_SERIES: {
      // World Series bracket slot already populated by DIVISION_SERIES phase.
      // No additional wiring needed — bracket.WORLD_SERIES.series[0] is ready.
      break;
    }

    case PHASE.SEASON_SUMMARY: {
      // Compute prestige for the completed season
      const state3 = StateManager.get();
      const bracket = state3.playoffBracket;
      const wonChampionship = bracket?.champion?.id === 'user'
        || bracket?.WORLD_SERIES?.series?.[0]?.winner?.id === 'user';
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

  await StateManager.save();
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
export function checkMilestone() {
  const state       = StateManager.get();
  const phase       = state.phase;
  const gameIndex   = (state.currentGameIndex || 0) - SPRING_TRAINING_GAME_COUNT;
  const seasonNum   = state.seasonNum;
  const seenSet     = new Set(state.seenMilestones || []);

  for (const milestone of Object.values(MILESTONE_SCREENS)) {
    if (seenSet.has(milestone.id)) continue;
    if (milestone.triggerPhase && milestone.triggerPhase !== phase) continue;
    if (milestone.triggerGame !== null && milestone.triggerGame !== undefined
        && milestone.triggerGame !== gameIndex) continue;
    if (milestone.minSeason && seasonNum < milestone.minSeason) continue;
    if (milestone.requiresHosting && !state.userTeam?._hostedAllStar) continue;

    // Milestone fires — mark as seen
    StateManager.mutate(s => {
      if (!s.seenMilestones.includes(milestone.id)) {
        s.seenMilestones.push(milestone.id);
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
// OFFSEASON SEQUENCE (Section 13.2)
// ─────────────────────────────────────────────────────────────

/**
 * runOffseason()
 * Executes the 12-step offseason sequence in strict order.
 * Steps 6 and 9 are player-gated — they queue cards and pause here.
 * CardEngine (Phase 9) advances the offseason when those cards are resolved.
 *
 * Steps that run automatically:
 *   1  Lock the record
 *   2  Archive player stats
 *   3  Player aging (gates step 4)
 *   4  Sub-rating development and decline
 *   5  Contract expiry flagging
 *   7  League roster turnover (CPU)
 *   8  Payroll recalculation
 *   10 Coaching staff decisions
 *   11 Schedule generation
 *   12 Spring training setup
 *
 * Steps that queue cards and pause:
 *   6  User roster decisions (re-sign/release)
 *   9  Ownership evaluation card
 *
 * @returns {Promise<void>}
 */
export async function runOffseason() {
  // Offseason processing is now orchestrated through OffseasonEngine.
  // This function is retained as the entry point called by advancePhase(OFFSEASON).
  // The actual 12-step sequence runs across the 6 offseason days, gated
  // by hard gate resolution via CardEngine cards.
  //
  // Steps 1-5 run in advancePhase(OFFSEASON) immediately.
  // Steps 6+ are triggered as cards resolve via resumeOffseasonAfterResigns()
  // and resumeOffseasonAfterOwnership().
  //
  // This function is a no-op — the work happens in advancePhase above.
}

/**
 * resumeOffseasonAfterResigns()
 * Called by CardEngine (Phase 9) after all re-sign cards are resolved.
 * Executes offseason steps 7–12.
 *
 * @returns {Promise<void>}
 */
export async function resumeOffseasonAfterResigns() {
  // Step 7: CPU roster turnover
  const step7 = processOffseasonStep7(StateManager.get());
  StateManager.mutate(s => {
    if (step7.players) {
      for (const [id, upd] of Object.entries(step7.players)) {
        if (s.players[id]) Object.assign(s.players[id], upd);
        else s.players[id] = upd;
      }
    }
    if (step7.leagueTeams)  s.leagueTeams  = step7.leagueTeams;
    if (step7.freeAgentPool) s.freeAgentPool = step7.freeAgentPool;
  });

  // Step 8: Payroll recalculation
  const step8 = processOffseasonStep8(StateManager.get());
  StateManager.mutate(s => {
    if (step8.userTeam?.finances) Object.assign(s.userTeam.finances, step8.userTeam.finances);
  });

  // Step 9: Queue ownership evaluation card
  StateManager.mutate(s => {
    s._offseasonGate = 'AWAITING_OWNERSHIP_CARD';
    _updateWinTarget(s);
  });
}

/**
 * resumeOffseasonAfterOwnership()
 * Called by CardEngine after ownership evaluation card resolves.
 * Executes offseason steps 10–12.
 *
 * @returns {Promise<void>}
 */
export async function resumeOffseasonAfterOwnership() {
  // Steps 11-12: Season increment + schedule generation
  const step1112 = processOffseasonStep11to12(StateManager.get());
  StateManager.mutate(s => {
    s.seasonNum          = step1112.seasonNum;
    s.currentGameIndex   = step1112.currentGameIndex;
    s.offseasonDay       = step1112.offseasonDay;
    s.offseasonStartedAt = step1112.offseasonStartedAt;
    s.offseasonHardGatesCleared = step1112.offseasonHardGatesCleared;
    s._offseasonGate     = step1112._offseasonGate;
    if (step1112.userTeam) Object.assign(s.userTeam, step1112.userTeam);
  });

  // Generate schedules for new season
  StateManager.mutate(s => {
    const schedule       = generateUserSchedule(s.seasonNum, s.leagueTeams);
    const leagueSchedule = generateCPUSchedules(s.seasonNum, s.leagueTeams);
    s.schedule           = schedule;
    s.leagueSchedule     = leagueSchedule;
  });

  // Step 12: Advance to spring training
  await advancePhase(PHASE.SPRING_TRAINING);

  await StateManager.save();
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
    payrollCap:         userTeam.finances.payrollCap,
    operatingBudget:    userTeam.finances.operatingBudget,
    operatingSpent:     userTeam.finances.operatingSpent,
    payrollHeadroom:    userTeam.finances.payrollCap - userTeam.finances.payroll,

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

function _computeRosterAvgOvr(state) {
  const ids = state.userTeam.rosterIds || [];
  if (ids.length === 0) return 55;
  const sum = ids.reduce((s, id) => s + (state.players[id]?.ovr || 55), 0);
  return Math.round(sum / ids.length);
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

function _currentInning(game) {
  if (!game.plays || game.livePlayIndex === 0) return 1;
  const play = game.plays[game.livePlayIndex - 1];
  return play?.inning || 1;
}

/**
 * _applyAgeAndDevelopment(player, seasonNum)
 * Applies per-sub-rating development and decline curves based on age.
 * Section 4.1 — LOCKED curves:
 *
 *                Growth  Peak   Prime  Decline  Steep
 *                (21-24) (25-27)(28-30)(31-33)  (34+)
 * contact/control: +1.5   +0.5  -0.5   -1.5    -3.0  (most durable)
 * power/stuff:     +1.0   +0.5  -1.0   -2.0    -3.5  (peaks early)
 * speed/stamina:   +0.5   +0.0  -1.5   -2.5    -4.0  (fastest to decline)
 *
 * Mutates player in-place (called inside StateManager.mutate).
 */
function _applyAgeAndDevelopment(player, seasonNum) {
  const age = computeAge(player.dob);
  const sr  = player.subRatings;
  if (!sr) return;

  const isPitcher  = sr.stuff !== null;
  const activeKeys = isPitcher
    ? ['stuff', 'control', 'stamina']
    : ['contact', 'power', 'speed'];

  // Per-sub-rating base curves [growth, peak, prime, decline, steep]
  // Index: 0=contact/control, 1=power/stuff, 2=speed/stamina
  const CURVES = [
    [1.5,  0.5, -0.5, -1.5, -3.0],  // contact / control (most durable)
    [1.0,  0.5, -1.0, -2.0, -3.5],  // power / stuff
    [0.5,  0.0, -1.5, -2.5, -4.0],  // speed / stamina (fastest decline)
  ];

  const ageIdx = age <= AGE_DEVELOPMENT_WINDOWS.GROWTH.max  ? 0
               : age <= AGE_DEVELOPMENT_WINDOWS.PEAK.max    ? 1
               : age <= AGE_DEVELOPMENT_WINDOWS.PRIME.max   ? 2
               : age <= AGE_DEVELOPMENT_WINDOWS.DECLINE.max ? 3
               : 4;

  for (let i = 0; i < activeKeys.length; i++) {
    const key = activeKeys[i];
    if (sr[key] === null || sr[key] === undefined) continue;

    let baseChange = CURVES[i][ageIdx];

    // Random variance
    let variance = _rng(-2, 2);

    // Trait modifiers
    if (player.trait === 'youngGun' && age < 28) {
      baseChange += 1;
    } else if (player.trait === 'veteran' && age >= 30) {
      // Contact/control decline halved for veterans
      if (i === 0 && baseChange < 0) baseChange *= 0.5;
    }
    if (player.trait === 'consistent') variance = _rng(-1, 1);
    if (player.trait === 'volatile')   variance = _rng(-4, 4);

    const finalChange = _clamp(
      Math.round(baseChange + variance),
      -5, 4  // hard cap: max +4, max -5 per offseason
    );

    sr[key] = _clamp(sr[key] + finalChange, SUB_RATING_MIN, SUB_RATING_MAX);
  }

  // Clear injury penalty — new season, clean slate
  player.injuryPenalty = null;

  // Recompute OVR from updated sub-ratings
  player.ovr = computeOVR(sr);

  // Update career peak if applicable
  if (player.ovr > (player.careerStats?.peakOvr || 0)) {
    if (player.careerStats) {
      player.careerStats.peakOvr    = player.ovr;
      player.careerStats.peakSeason = seasonNum;
    }
  }
}

/**
 * _processCPUContractExpiry(state, team)
 * CPU teams auto-process expired contracts.
 * Released players enter state.freeAgentPool.
 */
function _processCPUContractExpiry(state, team) {
  const expiredIds = (team.rosterIds || []).filter(id => {
    const p = state.players[id];
    return p && p.contractExpired;
  });

  for (const id of expiredIds) {
    const player = state.players[id];
    if (!player) continue;

    // CPU re-signs if OVR is above threshold and team needs the player
    const shouldResign = player.ovr >= 60 && Math.random() < 0.65;
    if (shouldResign) {
      // New contract issued — reset extension flag (Section 9.4b)
      player.contractExpired      = false;
      player._contractExpiringNext = false;
      player.contractExtended     = false;
      player.contractYears        = _rng(1, 3);
      player.contractExpiry       = state.seasonNum + player.contractYears;
    } else {
      // Release to free agent pool
      player.contractExpired = false;
      player.teamId          = null;
      player.group           = 'freeAgent';
      team.rosterIds         = team.rosterIds.filter(rid => rid !== id);
      state.freeAgentPool    = [...(state.freeAgentPool || []), id];
    }
  }
}

/**
 * _updatePrestige(state)
 * Recalculates prestige score and tier based on season performance.
 * Mutates state in-place (called inside StateManager.mutate).
 */
function _updatePrestige(state) {
  let points = 0;

  // Per-win points
  points += state.userTeam.wins * PRESTIGE_POINTS_PER_WIN;

  // Winning season bonus
  if (state.userTeam.wins >= PRESTIGE_WINNING_WIN_THRESHOLD) {
    points += PRESTIGE_POINTS_WINNING_SEASON;
  }

  // Playoff appearance
  if (_userQualifiedForPlayoffs(state)) {
    points += PRESTIGE_POINTS_PLAYOFF_APPEARANCE;
  }

  state.prestigeScore = (state.prestigeScore || 0) + points;

  // Update tier
  let tier = 1;
  for (let i = PRESTIGE_TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (state.prestigeScore >= PRESTIGE_TIER_THRESHOLDS[i]) {
      tier = i + 1;
      break;
    }
  }
  state.prestigeTier = tier;

  state.prestigeHistory.push({
    seasonNum: state.seasonNum,
    tier,
    score:     state.prestigeScore,
    points,
  });
}

/**
 * _updateWinTarget(state)
 * Adjusts ownership win target based on last season's performance.
 */
function _updateWinTarget(state) {
  const target = state.userTeam._ownerWinTarget || 75;
  const wins   = state.userTeam.wins;
  const diff   = wins - target;
  let adj      = 0;

  if      (diff >= 8)                          adj = WIN_TARGET_ADJ_EXCEED_8_PLUS;
  else if (diff >= 3)                          adj = WIN_TARGET_ADJ_EXCEED_3_TO_7;
  else if (diff >= -WIN_TARGET_MET_WITHIN)     adj = WIN_TARGET_ADJ_MET;
  else if (diff >= -4)                         adj = WIN_TARGET_ADJ_MISS_1_TO_4;
  else if (diff >= -9)                         adj = WIN_TARGET_ADJ_MISS_5_TO_9;
  else                                         adj = WIN_TARGET_ADJ_MISS_10_PLUS;

  state.userTeam._ownerWinTarget = target + adj;
}

function _countPlayoffRoundsWon(state) {
  const bracket = state.playoffBracket;
  if (!bracket) return 0;
  let rounds = 0;
  const divs = ['divA', 'divB'];
  for (const div of divs) {
    const d = bracket[div];
    if (!d) continue;
    for (const round of ['WILD_CARD','FIRST_ROUND','DIVISION_SERIES']) {
      const series = d[round]?.series || [];
      for (const s of series) {
        if (s.winner?.id === 'user') rounds++;
      }
    }
  }
  const ws = bracket.WORLD_SERIES?.series?.[0];
  if (ws?.winner?.id === 'user') rounds++;
  return rounds;
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// ─────────────────────────────────────────────────────────────
// PLAYOFF HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _isPlayoffPhase(phase)
 * Returns true for phases that require series completion before advancing.
 */
function _isPlayoffPhase(phase) {
  return phase === PHASE.WILD_CARD
      || phase === PHASE.FIRST_ROUND
      || phase === PHASE.DIVISION_SERIES
      || phase === PHASE.WORLD_SERIES;
}

/**
 * _isPlayoffRoundComplete(state)
 * Returns true when every series in the current playoff round has a winner.
 *
 * Bracket shape (from SeasonEngine.buildPlayoffBracket):
 *   state.playoffBracket.divA[round].series[]
 *   state.playoffBracket.divB[round].series[]
 *   state.playoffBracket.WORLD_SERIES.series[]
 *
 * A series has a winner when series.winner is set (non-null).
 *
 * @param {Object} state
 * @returns {Boolean}
 */
function _isPlayoffRoundComplete(state) {
  const bracket = state.playoffBracket;
  if (!bracket) return false;

  const phase = state.phase;

  if (phase === PHASE.WORLD_SERIES) {
    const ws = bracket.WORLD_SERIES?.series || [];
    return ws.length > 0 && ws.every(s => s.winner != null);
  }

  // Map phase to bracket round key
  const roundKey = {
    [PHASE.WILD_CARD]:       'WILD_CARD',
    [PHASE.FIRST_ROUND]:     'FIRST_ROUND',
    [PHASE.DIVISION_SERIES]: 'DIVISION_SERIES',
  }[phase];

  if (!roundKey) return false;

  const divASeries = bracket.divA?.[roundKey]?.series || [];
  const divBSeries = bracket.divB?.[roundKey]?.series || [];
  const allSeries  = [...divASeries, ...divBSeries];

  return allSeries.length > 0 && allSeries.every(s => s.winner != null);
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
