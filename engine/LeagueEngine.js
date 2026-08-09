/**
 * engine/LeagueEngine.js
 * CPU team behavior — game simulation, roster decisions, waiver activity, standings.
 *
 * Rules:
 *   - Pure functions. Caller (GameEngine) applies mutations via StateManager.
 *   - CPU teams use simplified sim logic — the full SimEngine is for user games.
 *   - Activity feed entries are generated here and returned as mutations.
 *   - Does NOT generate inbox cards. Does NOT touch user team directly.
 */

import {
  SIM_BASE_WIN_PROB,
  SIM_OVR_DIFF_WEIGHT,
  SIM_HITTER_OVR_WEIGHT,
  SIM_SP_OVR_WEIGHT,
  SIM_BP_OVR_WEIGHT,
  PLAYER_GROUP,
  ROSTER_LIMITS,
  ACTIVITY_FEED_RETENTION_HOURS,
} from '../data/constants.js';

import {
  buildActivityFeedEntry,
  pruneActivityFeed,
  computeFullStandings as _computeStandingsBase,
} from './SeasonEngine.js';

import {
  placeOnWaivers,
  callUpFromFarm,
  checkDepth,
  autoResolveDepth,
  reconcileRoster,
} from './RosterEngine.js';

import { computeOVR } from './PlayerFactory.js';

// ─────────────────────────────────────────────────────────────
// CPU GAME SIMULATION
// ─────────────────────────────────────────────────────────────

/**
 * simulateCPUGame(homeTeam, awayTeam, players)
 * Simulates a single CPU-vs-CPU game.
 * Returns { homeScore, awayScore, homeWon }.
 *
 * Uses simplified OVR-based win probability — not the full SimEngine.
 *
 * @param {Object}  homeTeam  — league team object
 * @param {Object}  awayTeam
 * @param {Object}  players   — state.players registry
 * @returns {Object}
 */
export function simulateCPUGame(homeTeam, awayTeam, players) {
  const homeOvr  = _teamOvr(homeTeam, players);
  const awayOvr  = _teamOvr(awayTeam, players);
  const ovrDiff  = homeOvr - awayOvr;

  // Home field advantage built into base prob
  const homeWinProb = _clamp(
    SIM_BASE_WIN_PROB + 0.04 + (ovrDiff * SIM_OVR_DIFF_WEIGHT),
    0.20,
    0.80
  );

  const homeWon   = Math.random() < homeWinProb;
  const homeScore = homeWon ? _rng(2, 9) : _rng(0, 5);
  const awayScore = homeWon ? _rng(0, homeScore - 1) : _rng(homeScore + 1, homeScore + 7);

  return {
    homeScore: Math.max(0, homeScore),
    awayScore: Math.max(0, awayScore),
    homeWon,
  };
}

/**
 * processCPUDay(state, dateStr)
 * Processes all CPU games scheduled for a given date.
 * Returns mutations: updated leagueTeams records + activity feed entries.
 *
 * @param {Object} state
 * @param {String} dateStr   — 'YYYY-MM-DD'
 * @returns {Object} mutations
 */
export function processCPUDay(state, dateStr) {
  const dayGames = state.leagueSchedule?.dayMap?.[dateStr] || [];
  if (dayGames.length === 0) return {};

  const leagueTeams   = state.leagueTeams.map(t => ({ ...t })); // working copy
  const newFeedEntries = [];
  const updatedDayMap  = { ...state.leagueSchedule.dayMap };
  const updatedGames   = [...dayGames];

  for (let i = 0; i < updatedGames.length; i++) {
    const game = { ...updatedGames[i] };
    if (game.played) continue;

    const homeTeam = leagueTeams.find(t => t.id === game.homeId);
    const awayTeam = leagueTeams.find(t => t.id === game.awayId);
    if (!homeTeam || !awayTeam) continue;

    const result = simulateCPUGame(homeTeam, awayTeam, state.players);

    // Update records
    if (result.homeWon) {
      homeTeam.wins++;
      homeTeam.streak = Math.max(0, homeTeam.streak) + 1;
      awayTeam.losses++;
      awayTeam.streak = Math.min(0, awayTeam.streak) - 1;
    } else {
      awayTeam.wins++;
      awayTeam.streak = Math.max(0, awayTeam.streak) + 1;
      homeTeam.losses++;
      homeTeam.streak = Math.min(0, homeTeam.streak) - 1;
    }

    game.homeScore = result.homeScore;
    game.awayScore = result.awayScore;
    game.played    = true;
    updatedGames[i] = game;

    // Activity feed entry
    const winner = result.homeWon ? homeTeam : awayTeam;
    const loser  = result.homeWon ? awayTeam : homeTeam;
    newFeedEntries.push(buildActivityFeedEntry(
      'result',
      winner.abbr,
      `${winner.abbr} def. ${loser.abbr} ${result.homeWon ? result.homeScore : result.awayScore}–${result.homeWon ? result.awayScore : result.homeScore}`
    ));
  }

  updatedDayMap[dateStr] = updatedGames;

  // Prune old feed entries
  const prunedFeed = pruneActivityFeed([
    ...(state.activityFeed || []),
    ...newFeedEntries,
  ]);

  return {
    leagueTeams: leagueTeams,
    leagueSchedule: {
      ...state.leagueSchedule,
      dayMap: updatedDayMap,
    },
    activityFeed: prunedFeed,
  };
}

// ─────────────────────────────────────────────────────────────
// CPU ROSTER DECISIONS
// ─────────────────────────────────────────────────────────────

/**
 * processCPURosterDecisions(state, dateStr)
 * Evaluates roster decisions for all CPU teams:
 *   - Auto-resolve critical depth gaps (call up from farm)
 *   - Place excess roster players on waivers if overfull
 *   - Return players from IL when return game is reached
 *
 * Returns mutations to apply.
 *
 * @param {Object} state
 * @param {String} dateStr
 * @returns {Object} mutations
 */
export function processCPURosterDecisions(state, dateStr) {
  const mutations = {
    players:    {},
    leagueTeams: [...state.leagueTeams],
    waiverPool: [...(state.waiverPool || [])],
    activityFeed: [...(state.activityFeed || [])],
  };

  for (const team of state.leagueTeams) {
    // IL returns — check each IL player
    const ilPlayers = team.rosterIds
      .map(id => state.players[id])
      .filter(p => p && p.isInjured && p.ilReturnGame !== null
               && p.ilReturnGame <= (state.currentGameIndex || 0));

    for (const player of ilPlayers) {
      // CPU teams auto-activate returning IL players (no decision card for CPU)
      const isPitcher = ['SP', 'RP'].includes(player.pos);
      const targetGroup = isPitcher ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS;
      mutations.players[player.id] = {
        isInjured:        false,
        ilReturnGame:     null,
        _pendingILReturn: false,
        group:            targetGroup,
        injuryPenalty:    null,
      };
    }

    // Depth check — auto-resolve CRITICAL gaps (emergency callups).
    const depthIssues = checkDepth(state, team.id);
    const criticalIssues = depthIssues.filter(i => i.type === 'CRITICAL');
    if (criticalIssues.length > 0) {
      const depthFix = autoResolveDepth(state, team.id);
      Object.assign(mutations.players, depthFix.players || {});
      if (depthFix.leagueTeams) mutations.leagueTeams = depthFix.leagueTeams;

      if (criticalIssues.length > 0) {
        mutations.activityFeed.push(buildActivityFeedEntry(
          'roster',
          team.abbr,
          `${team.abbr} called up a player to address a roster gap`
        ));
      }
    }

    // Reconcile: restore lineup + rotation integrity and hold the active roster
    // at a legal 28 (CPU auto-manages — farm call-ups + waiving surplus). Runs on
    // a patched view so it sees this team's IL-return / depth changes above and
    // every earlier team's changes in this pass.
    const patchedPlayers = { ...state.players };
    for (const [id, upd] of Object.entries(mutations.players)) {
      patchedPlayers[id] = { ...patchedPlayers[id], ...upd };
    }
    const patched = {
      ...state,
      players:     patchedPlayers,
      leagueTeams: mutations.leagueTeams,
      waiverPool:  mutations.waiverPool,
    };
    const rec = reconcileRoster(patched, team.id, { autoManage: true });
    if (rec.players)     Object.assign(mutations.players, rec.players);
    if (rec.leagueTeams) mutations.leagueTeams = rec.leagueTeams;
    if (rec.waiverPool)  mutations.waiverPool  = rec.waiverPool;
  }

  mutations.activityFeed = pruneActivityFeed(mutations.activityFeed);
  return mutations;
}

// ─────────────────────────────────────────────────────────────
// WAIVER PROCESSING
// ─────────────────────────────────────────────────────────────

/**
 * processWaiverClaims(state)
 * Evaluates pending waiver claims in priority order (inverse standings).
 * CPU teams claim players who fill a need at a position they're thin at.
 *
 * Returns mutations.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processWaiverClaims(state) {
  const waiverPool = state.waiverPool || [];
  if (waiverPool.length === 0) return {};

  const standings = _computeStandingsBase(state.leagueTeams, {
    name:       state.userTeam?.city + ' ' + state.userTeam?.nickname,
    abbr:       state.userTeam?.abbr,
    divisionId: 'A',
    wins:       state.userTeam?.wins   || 0,
    losses:     state.userTeam?.losses || 0,
  });

  // Priority order: worst record first (inverse standings)
  const claimPriority = [...standings.all].reverse();

  const mutations  = { players: {}, leagueTeams: [...state.leagueTeams], waiverPool: [...waiverPool], activityFeed: [...(state.activityFeed || [])] };
  const claimed    = new Set();

  for (const teamEntry of claimPriority) {
    if (teamEntry.id === 'user') continue; // user claims handled by CardEngine

    const team = state.leagueTeams.find(t => t.id === teamEntry.id);
    if (!team) continue;

    for (const playerId of waiverPool) {
      if (claimed.has(playerId)) continue;

      const player = state.players[playerId];
      if (!player) continue;

      // CPU claims if they have a need at this position
      if (_cpuTeamNeedsPlayer(team, player, state.players)) {
        // Claim the player
        claimed.add(playerId);
        mutations.waiverPool = mutations.waiverPool.filter(id => id !== playerId);

        const teamIdx = mutations.leagueTeams.findIndex(t => t.id === team.id);
        if (teamIdx >= 0) {
          mutations.leagueTeams[teamIdx] = {
            ...mutations.leagueTeams[teamIdx],
            rosterIds: [...mutations.leagueTeams[teamIdx].rosterIds, playerId],
          };
        }

        mutations.players[playerId] = {
          onWaivers: false,
          teamId:    team.id,
          group:     _isPitcher(player) ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS,
        };

        mutations.activityFeed.push(buildActivityFeedEntry(
          'waiver',
          team.abbr,
          `${team.abbr} claimed ${player.name} off waivers`
        ));

        break; // each team claims at most one player per waiver run
      }
    }
  }

  mutations.activityFeed = pruneActivityFeed(mutations.activityFeed);
  return mutations;
}

// ─────────────────────────────────────────────────────────────
// STANDINGS UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * computeFullStandings(state)
 * Convenience wrapper — pulls user team info from state and calls computeFullStandings.
 *
 * @param {Object} state
 * @returns {Object} standings
 */
export function computeFullStandings(state) {
  return _computeStandingsBase(state.leagueTeams, {
    name:       `${state.userTeam.city} ${state.userTeam.nickname}`,
    abbr:       state.userTeam.abbr,
    divisionId: 'A',
    wins:       state.userTeam.wins   || 0,
    losses:     state.userTeam.losses || 0,
  });
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED
// ─────────────────────────────────────────────────────────────

/**
 * getActivityFeed(state, since?)
 * Returns feed entries newer than `since` (Unix ms).
 * If since is omitted, returns all retained entries.
 *
 * @param {Object}  state
 * @param {Number}  [since]
 * @returns {Object[]}
 */
export function getActivityFeed(state, since) {
  const feed = state.activityFeed || [];
  if (!since) return feed;
  return feed.filter(e => e.timestamp > since);
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _teamOvr(team, players) {
  const roster = (team.rosterIds || []).map(id => players[id]).filter(Boolean);

  const hitters  = roster.filter(p => [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group) && !p.isInjured && !p.isSuspended);
  const starters = roster.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS && !p.isInjured && !p.isSuspended);
  const bullpen  = roster.filter(p => p.group === PLAYER_GROUP.BULLPEN && !p.isInjured && !p.isSuspended);

  const avgOvr = arr => arr.length === 0 ? 55 : arr.reduce((s, p) => s + (p.ovr || 55), 0) / arr.length;

  return (avgOvr(hitters)  * SIM_HITTER_OVR_WEIGHT)
       + (avgOvr(starters) * SIM_SP_OVR_WEIGHT)
       + (avgOvr(bullpen)  * SIM_BP_OVR_WEIGHT);
}

function _cpuTeamNeedsPlayer(team, player, players) {
  const rosterPlayers = (team.rosterIds || []).map(id => players[id]).filter(Boolean);
  const isPitcherNeeded = _isPitcher(player);

  if (isPitcherNeeded) {
    const activePitchers = rosterPlayers.filter(p =>
      _isPitcher(p) && !p.isInjured && !p.isSuspended
    ).length;
    return activePitchers < (ROSTER_LIMITS.STARTING_PITCHERS + ROSTER_LIMITS.BULLPEN - 2);
  }

  const activeHitters = rosterPlayers.filter(p =>
    !_isPitcher(p) && !p.isInjured && !p.isSuspended
  ).length;
  return activeHitters < (ROSTER_LIMITS.STARTING_HITTERS + ROSTER_LIMITS.BENCH_HITTERS - 2);
}

function _isPitcher(player) {
  return [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PRACTICE_SQUAD].includes(player.group)
      || ['SP', 'RP'].includes(player.pos);
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
