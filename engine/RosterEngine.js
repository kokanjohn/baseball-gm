/**
 * engine/RosterEngine.js
 * Single entry point for all roster mutations — user team and CPU teams.
 *
 * Rules (Section 3.2, 6.3):
 *   - Nothing else mutates rosters directly. Every roster change goes through here.
 *   - Pure functions: receive state, return mutations to apply. No direct state writes.
 *     Caller (GameEngine) applies results via StateManager.mutate().
 *   - Does NOT generate cards. Does NOT evaluate trade fairness. Does NOT touch SimEngine.
 *
 * Farm vs waivers rule (LOCKED — Section 9.7):
 *   - sendToFarm() is valid ONLY during spring training cuts (38→28) and
 *     position-aware farm overflow displacement.
 *   - ALL other removals go through placeOnWaivers().
 *   - IL return always flags _pendingILReturn and queues to ilReturnQueue —
 *     CardEngine (Phase 9) surfaces the decision card. Never auto-activates.
 *
 * Depth check types:
 *   - Type 1 (CRITICAL): a required starting position has zero healthy players
 *   - Type 2 (WARNING): a position has only one healthy player remaining
 */

import {
  PLAYER_GROUP,
  ROSTER_LIMITS,
  FARM_HITTER_MIN_POSITIONS,
  FARM_PITCHER_MIN_SP,
  FARM_PITCHER_MIN_RP,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// POSITION COMPATIBILITY MAP
// Which positions can cover for each native position.
// Used for depth checks and farm overflow displacement.
// ─────────────────────────────────────────────────────────────

const POSITION_COVERAGE = Object.freeze({
  'C':      ['C'],
  '1B':     ['1B', '1B/3B', 'DH'],
  '2B':     ['2B', '2B/SS'],
  '3B':     ['3B', '1B/3B'],
  'SS':     ['SS', '2B/SS'],
  'OF':     ['OF', 'DH/OF'],
  'DH':     ['DH', 'OF', 'DH/OF', '1B'],
  '2B/SS':  ['2B', 'SS', '2B/SS'],
  '1B/3B':  ['1B', '3B', '1B/3B'],
  'DH/OF':  ['DH', 'OF', 'DH/OF'],
  'SP':     ['SP'],
  'RP':     ['RP'],
});

// Positions that are "starters" for depth check purposes
const REQUIRED_STARTER_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'DH'];
const REQUIRED_SP_COUNT = ROSTER_LIMITS.STARTING_PITCHERS;
const REQUIRED_RP_COUNT = 2; // minimum relievers to function

// ─────────────────────────────────────────────────────────────
// PLACE PLAYER
// ─────────────────────────────────────────────────────────────

/**
 * placePlayer(state, playerId, group)
 * Moves a player to the specified group on their current team.
 * Does not validate roster size limits — caller is responsible for
 * ensuring a slot exists before calling this.
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {String} group  — PLAYER_GROUP constant
 * @returns {Object} mutations — { players: { [id]: partialPlayerUpdate } }
 */
export function placePlayer(state, playerId, group) {
  _assertPlayerExists(state, playerId);
  return {
    players: {
      [playerId]: { group },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// IL SYSTEM
// ─────────────────────────────────────────────────────────────

/**
 * injurePlayer(state, playerId, ilGames)
 * Moves a player to the IL, sets their return game index, clears active flags.
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {Number} ilGames      — number of games on IL
 * @returns {Object} mutations
 */
export function injurePlayer(state, playerId, ilGames) {
  _assertPlayerExists(state, playerId);
  const player = state.players[playerId];
  const returnGame = (state.currentGameIndex ?? 0) + ilGames;

  return {
    players: {
      [playerId]: {
        group:         PLAYER_GROUP.IL,
        isInjured:     true,
        isResting:     false,
        ilReturnGame:  returnGame,
        _pendingILReturn: false,
      },
    },
  };
}

/**
 * returnFromIL(state, playerId)
 * Flags a player as ready to return. NEVER auto-activates.
 * Adds to ilReturnQueue — CardEngine (Phase 9) will generate the decision card
 * presenting the GM with: activate, send to farm (spring only), or place on waivers.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function returnFromIL(state, playerId) {
  _assertPlayerExists(state, playerId);

  const alreadyQueued = (state.ilReturnQueue || []).includes(playerId);

  return {
    players: {
      [playerId]: {
        isInjured:        false,
        ilReturnGame:     null,
        _pendingILReturn: true,
      },
    },
    // Add to ilReturnQueue if not already there
    ilReturnQueue: alreadyQueued
      ? state.ilReturnQueue
      : [...(state.ilReturnQueue || []), playerId],
  };
}

/**
 * activateFromIL(state, playerId, targetGroup)
 * Called when the GM chooses to activate a returning IL player.
 * Removes from ilReturnQueue. Caller must ensure a roster slot exists.
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {String} targetGroup  — the group to place the player in
 * @returns {Object} mutations
 */
export function activateFromIL(state, playerId, targetGroup) {
  _assertPlayerExists(state, playerId);

  return {
    players: {
      [playerId]: {
        group:            targetGroup,
        _pendingILReturn: false,
        injuryPenalty:    null,
      },
    },
    ilReturnQueue: (state.ilReturnQueue || []).filter(id => id !== playerId),
  };
}

// ─────────────────────────────────────────────────────────────
// WAIVERS
// ─────────────────────────────────────────────────────────────

/**
 * placeOnWaivers(state, playerId)
 * The primary path for all mid-season player removals.
 * Removes player from their current team's rosterIds/farmIds,
 * adds to state.waiverPool, sets player.onWaivers = true.
 *
 * Valid for:
 *   - IL return decisions where GM chooses not to activate
 *   - Any mid-season cut outside spring training
 *   - Declined contract re-signs
 *   - Any player the GM no longer wants
 *
 * NOT valid for spring training cuts — use sendToFarm() for that.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function placeOnWaivers(state, playerId) {
  _assertPlayerExists(state, playerId);
  const player = state.players[playerId];
  const teamId = player.teamId;

  const updatedTeam = _removeFromTeamRoster(state, playerId, teamId);

  return {
    players: {
      [playerId]: {
        group:            'waivers',
        tier:             'waivers',
        onWaivers:        true,
        waiverStartTime:  Date.now(),
        _pendingILReturn: false,
        _pendingDeparture:false,
        teamId:           null,
      },
    },
    waiverPool: [...(state.waiverPool || []), playerId],
    ilReturnQueue: (state.ilReturnQueue || []).filter(id => id !== playerId),
    ...updatedTeam,
  };
}

/**
 * claimFromWaivers(state, playerId, claimingTeamId)
 * Assigns a waivered player to the claiming team.
 * Claiming team must immediately drop a player to maintain roster size
 * (enforced by caller — RosterEngine does not auto-drop).
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {String} claimingTeamId
 * @returns {Object} mutations
 */
export function claimFromWaivers(state, playerId, claimingTeamId) {
  _assertPlayerExists(state, playerId);

  const isUserTeam = claimingTeamId === 'user';
  const group = isUserTeam
    ? PLAYER_GROUP.BENCH_HITTERS  // CardEngine will prompt for exact slot
    : PLAYER_GROUP.BENCH_HITTERS; // CPU teams slot in Phase 10

  // Add to claiming team's rosterIds
  const teamMutation = isUserTeam
    ? { userTeam: { rosterIds: [...state.userTeam.rosterIds, playerId] } }
    : _addToLeagueTeamRoster(state, playerId, claimingTeamId);

  return {
    players: {
      [playerId]: {
        group,
        tier:             'active',
        onWaivers:        false,
        waiverStartTime:  null,
        teamId:           claimingTeamId,
        _previouslyWithOrg: claimingTeamId === 'user'
          ? state.players[playerId]._previouslyWithOrg
          : false,
      },
    },
    waiverPool: (state.waiverPool || []).filter(id => id !== playerId),
    ...teamMutation,
  };
}

/**
 * clearWaivers(state, playerId)
 * Player clears waivers unclaimed — moves to free agent pool.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function clearWaivers(state, playerId) {
  _assertPlayerExists(state, playerId);

  return {
    players: {
      [playerId]: {
        group:            'freeAgent',
        tier:             'farm',      // clears to farm when unclaimed (Section 20.1)
        onWaivers:        false,
        waiverStartTime:  null,
        teamId:           null,
      },
    },
    waiverPool:    (state.waiverPool || []).filter(id => id !== playerId),
    freeAgentPool: [...(state.freeAgentPool || []), playerId],
  };
}

// ─────────────────────────────────────────────────────────────
// FARM SYSTEM
// ─────────────────────────────────────────────────────────────

/**
 * sendToFarm(state, playerId, teamId)
 * ONLY valid during spring training cuts (38→28) and position-aware farm
 * overflow displacement. All other removals must use placeOnWaivers().
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {String} teamId
 * @returns {Object} mutations
 */
export function sendToFarm(state, playerId, teamId) {
  _assertPlayerExists(state, playerId);

  const isUserTeam = teamId === 'user';
  const farmIds = isUserTeam
    ? state.userTeam.farmIds || []
    : _getLeagueTeamFarmIds(state, teamId);

  const player = state.players[playerId];
  const isPitcher = player && ['SP','RP'].includes(player.pos);
  const farmPlayers = farmIds.map(id => state.players[id]).filter(Boolean);
  const currentHitters  = farmPlayers.filter(p => !['SP','RP'].includes(p.pos)).length;
  const currentPitchers = farmPlayers.filter(p =>  ['SP','RP'].includes(p.pos)).length;

  // Check composition cap for this player's group
  const atCap = isPitcher
    ? currentPitchers >= ROSTER_LIMITS.FARM_PITCHER_MAX
    : currentHitters  >= ROSTER_LIMITS.FARM_HITTER_MAX;

  if (atCap) {
    // Farm is full — displace the lowest-rated player at this position first
    const displaced = _findDisplacementCandidate(state, playerId, farmIds);
    if (displaced) {
      // Displaced player goes to waivers, not deeper farm
      const waiversMutation = placeOnWaivers(state, displaced);
      const farmMutation    = _buildSendToFarmMutation(state, playerId, teamId, farmIds.filter(id => id !== displaced));
      return _mergeMutations(waiversMutation, farmMutation);
    }
  }

  return _buildSendToFarmMutation(state, playerId, teamId, farmIds);
}

/**
 * callUpFromFarm(state, playerId, teamId)
 * Promotes a farm player to the active roster.
 * Caller must ensure a roster slot is available.
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {String} teamId
 * @returns {Object} mutations
 */
export function callUpFromFarm(state, playerId, teamId) {
  _assertPlayerExists(state, playerId);

  const isUserTeam = teamId === 'user';
  const player     = state.players[playerId];

  // Determine appropriate group for callup based on player type
  const isPitcher = ['SP', 'RP'].includes(player.pos);
  const targetGroup = isPitcher
    ? PLAYER_GROUP.BULLPEN
    : PLAYER_GROUP.BENCH_HITTERS;

  // Remove from farm
  const farmRemoval = isUserTeam
    ? { userTeam: { farmIds: (state.userTeam.farmIds || []).filter(id => id !== playerId) } }
    : _removeFromLeagueTeamFarm(state, playerId, teamId);

  // Add to active roster
  const rosterAdd = isUserTeam
    ? { userTeam: { rosterIds: [...state.userTeam.rosterIds, playerId] } }
    : _addToLeagueTeamRoster(state, playerId, teamId);

  return {
    players: {
      [playerId]: {
        group:   targetGroup,
        tier:    'active',
        teamId,
        _farmArc:        null,
        _farmArcStart:   null,
      },
    },
    ...farmRemoval,
    ...rosterAdd,
  };
}

// ─────────────────────────────────────────────────────────────
// SUSPENSION
// ─────────────────────────────────────────────────────────────

/**
 * suspendPlayer(state, playerId, games)
 * Suspends a player for N games. Player stays on roster but is unavailable.
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {Number} games
 * @returns {Object} mutations
 */
export function suspendPlayer(state, playerId, games) {
  _assertPlayerExists(state, playerId);
  const suspendedUntilGame = (state.currentGameIndex ?? 0) + games;

  return {
    players: {
      [playerId]: {
        isSuspended:          true,
        _suspendedUntilGame:  suspendedUntilGame,
      },
    },
  };
}

/**
 * clearSuspension(state, playerId)
 * Lifts a suspension when the game index reaches _suspendedUntilGame.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function clearSuspension(state, playerId) {
  _assertPlayerExists(state, playerId);

  return {
    players: {
      [playerId]: {
        isSuspended:         false,
        _suspendedUntilGame: null,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// TRADE DEFERRAL
// ─────────────────────────────────────────────────────────────

/**
 * markPendingDeparture(state, playerId)
 * Locks a player in place on game day until drainPendingTrades() runs at commit.
 * Player stays on roster visually but is marked as traded.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function markPendingDeparture(state, playerId) {
  _assertPlayerExists(state, playerId);

  return {
    players: {
      [playerId]: { _pendingDeparture: true },
    },
  };
}

/**
 * drainPendingTrades(state)
 * Called at game commit. Removes all _pendingDeparture players from the roster
 * and places any _pendingAcquisitions onto the active roster.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function drainPendingTrades(state) {
  const mutations = { players: {} };
  const newRosterIds = [...state.userTeam.rosterIds];

  // Remove pending departures
  for (const playerId of newRosterIds.slice()) {
    const player = state.players[playerId];
    if (player && player._pendingDeparture) {
      const idx = newRosterIds.indexOf(playerId);
      if (idx >= 0) newRosterIds.splice(idx, 1);
      mutations.players[playerId] = {
        _pendingDeparture: false,
        teamId: null,
        group:  'traded',
      };
    }
  }

  // Place pending acquisitions
  const acquisitions = state._pendingAcquisitions || [];
  for (const incoming of acquisitions) {
    newRosterIds.push(incoming.id);
    mutations.players[incoming.id] = {
      ...incoming,
      _pendingDeparture: false,
    };
  }

  return {
    ...mutations,
    userTeam: { rosterIds: newRosterIds },
    _pendingAcquisitions: [],
  };
}

// ─────────────────────────────────────────────────────────────
// DEPTH CHECKS
// ─────────────────────────────────────────────────────────────

/**
 * checkDepth(state, teamId?)
 * Returns an array of depth issues on the given team (user team if omitted).
 *
 * Each issue: { type: 'CRITICAL'|'WARNING', position: String, available: Number }
 *
 * Type 1 (CRITICAL): zero healthy players can cover a required position
 * Type 2 (WARNING):  only one healthy player can cover a required position
 *
 * @param {Object} state
 * @param {String} [teamId]  — omit for user team
 * @returns {Object[]} issues
 */
export function checkDepth(state, teamId) {
  const isUserTeam = !teamId || teamId === 'user';
  const rosterIds  = isUserTeam
    ? state.userTeam.rosterIds
    : _getLeagueTeamRosterIds(state, teamId);

  const activePlayers = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended && !p._pendingDeparture
                  && p.group !== PLAYER_GROUP.IL
                  && p.group !== PLAYER_GROUP.PRACTICE_SQUAD);

  const issues = [];

  // Check each required hitter position
  for (const pos of REQUIRED_STARTER_POSITIONS) {
    const compatible = POSITION_COVERAGE[pos] || [pos];
    const available  = activePlayers.filter(p =>
      compatible.includes(p.nativePos || p.pos) &&
      [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group)
    ).length;

    if (available === 0) issues.push({ type: 'CRITICAL', position: pos, available });
    else if (available === 1) issues.push({ type: 'WARNING', position: pos, available });
  }

  // Check SP count
  const activeSP = activePlayers.filter(p =>
    (p.group === PLAYER_GROUP.STARTING_PITCHERS) && p.pos === 'SP'
  ).length;
  if (activeSP < REQUIRED_SP_COUNT) {
    issues.push({
      type:      activeSP === 0 ? 'CRITICAL' : 'WARNING',
      position:  'SP',
      available: activeSP,
    });
  }

  // Check minimum RP availability
  const activeRP = activePlayers.filter(p =>
    [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group) && p.pos === 'RP'
  ).length;
  if (activeRP < REQUIRED_RP_COUNT) {
    issues.push({
      type:      activeRP === 0 ? 'CRITICAL' : 'WARNING',
      position:  'RP',
      available: activeRP,
    });
  }

  return issues;
}

/**
 * autoResolveDepth(state, teamId?)
 * Promotes farm players to fill CRITICAL depth gaps on the given team.
 * Only resolves Type 1 (CRITICAL) issues — Type 2 (WARNING) are left for the GM.
 * Returns mutations to apply.
 *
 * @param {Object} state
 * @param {String} [teamId]
 * @returns {Object} mutations
 */
export function autoResolveDepth(state, teamId) {
  const issues = checkDepth(state, teamId).filter(i => i.type === 'CRITICAL');
  if (issues.length === 0) return {};

  const isUserTeam = !teamId || teamId === 'user';
  const farmIds    = isUserTeam
    ? (state.userTeam.farmIds || [])
    : _getLeagueTeamFarmIds(state, teamId);

  const mutations = { players: {} };

  for (const issue of issues) {
    const compatible = POSITION_COVERAGE[issue.position] || [issue.position];
    const candidate  = farmIds
      .map(id => state.players[id])
      .filter(p => p && !p.isInjured && compatible.includes(p.nativePos || p.pos))
      .sort((a, b) => b.ovr - a.ovr)[0];

    if (candidate) {
      const callup = callUpFromFarm(state, candidate.id, teamId || 'user');
      Object.assign(mutations.players, callup.players || {});
      if (isUserTeam && callup.userTeam) {
        mutations.userTeam = { ...(mutations.userTeam || {}), ...callup.userTeam };
      }
    }
  }

  return mutations;
}

// ─────────────────────────────────────────────────────────────
// SPRING TRAINING CUTS
// ─────────────────────────────────────────────────────────────

/**
 * applySpringCuts(state, playerIdsToKeep)
 * Processes the Opening Day roster cut (38→28).
 * Players NOT in playerIdsToKeep who are invitees go to farm.
 * Called when the GM submits their Opening Day roster selection.
 *
 * @param {Object}   state
 * @param {String[]} playerIdsToKeep  — the 28 players the GM chose to keep
 * @returns {Object} mutations
 */
export function applySpringCuts(state, playerIdsToKeep) {
  const keepSet    = new Set(playerIdsToKeep);
  const allIds     = [...state.userTeam.rosterIds, ...(state.userTeam.farmIds || [])];
  const toRelease  = allIds.filter(id => !keepSet.has(id));

  const mutations = { players: {} };
  let newFarmIds  = [...(state.userTeam.farmIds || [])];

  for (const playerId of toRelease) {
    const player = state.players[playerId];
    if (!player) continue;

    // Spring invitees (were on farm before camp) go back to farm
    // Active roster players cut in spring also go to farm (spring-only exception)
    if (newFarmIds.length < ROSTER_LIMITS.FARM) {
      newFarmIds.push(playerId);
      mutations.players[playerId] = {
        group:  PLAYER_GROUP.PRACTICE_SQUAD,
        teamId: 'user',
      };
    } else {
      // Farm full — waive the cut
      const waiversMutation = placeOnWaivers(state, playerId);
      Object.assign(mutations.players, waiversMutation.players || {});
      if (waiversMutation.waiverPool) {
        mutations.waiverPool = waiversMutation.waiverPool;
      }
    }
  }

  return {
    ...mutations,
    userTeam: {
      rosterIds: playerIdsToKeep,
      farmIds:   newFarmIds,
    },
  };
}

/**
 * autoResolveSpringCuts(state)
 * Called when the spring cut deadline expires without GM action.
 * Keeps the 28 highest-rated players, sends the rest to farm (or waivers if farm full).
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function autoResolveSpringCuts(state) {
  const allIds = [...state.userTeam.rosterIds, ...(state.userTeam.farmIds || [])];
  const ranked = allIds
    .map(id => state.players[id])
    .filter(Boolean)
    .sort((a, b) => b.ovr - a.ovr);

  const toKeep = ranked.slice(0, ROSTER_LIMITS.ACTIVE_TOTAL).map(p => p.id);
  return applySpringCuts(state, toKeep);
}

// ─────────────────────────────────────────────────────────────
// PAYROLL COMPUTATION
// ─────────────────────────────────────────────────────────────

/**
 * computePayroll(state)
 * Recomputes user team payroll from active roster + IL players.
 * Called whenever a roster change affects salaries.
 * Returns the payroll value — caller applies via StateManager.
 *
 * @param {Object} state
 * @returns {Number} payroll in $K (same unit as contractSalary)
 */
export function computePayroll(state) {
  const countGroups = new Set([
    PLAYER_GROUP.STARTING_HITTERS,
    PLAYER_GROUP.BENCH_HITTERS,
    PLAYER_GROUP.STARTING_PITCHERS,
    PLAYER_GROUP.BULLPEN,
    PLAYER_GROUP.PITCHER_BENCH,
    PLAYER_GROUP.IL,
  ]);

  return state.userTeam.rosterIds.reduce((sum, id) => {
    const p = state.players[id];
    if (p && countGroups.has(p.group)) {
      return sum + (p.contractSalary || 0);
    }
    return sum;
  }, 0);
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _assertPlayerExists(state, playerId) {
  if (!state.players[playerId]) {
    throw new Error(`RosterEngine: player '${playerId}' not found in state.players`);
  }
}

function _getLeagueTeamRosterIds(state, teamId) {
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  return team ? (team.rosterIds || []) : [];
}

function _getLeagueTeamFarmIds(state, teamId) {
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  return team ? (team.farmIds || []) : [];
}

function _removeFromTeamRoster(state, playerId, teamId) {
  if (!teamId || teamId === 'user') {
    return {
      userTeam: {
        rosterIds: state.userTeam.rosterIds.filter(id => id !== playerId),
        farmIds:   (state.userTeam.farmIds || []).filter(id => id !== playerId),
      },
    };
  }
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};
  const idx = state.leagueTeams.indexOf(team);
  const updatedTeams = [...state.leagueTeams];
  updatedTeams[idx] = {
    ...team,
    rosterIds: team.rosterIds.filter(id => id !== playerId),
    farmIds:   (team.farmIds || []).filter(id => id !== playerId),
  };
  return { leagueTeams: updatedTeams };
}

function _addToLeagueTeamRoster(state, playerId, teamId) {
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};
  const idx = state.leagueTeams.indexOf(team);
  const updatedTeams = [...state.leagueTeams];
  updatedTeams[idx] = {
    ...team,
    rosterIds: [...team.rosterIds, playerId],
  };
  return { leagueTeams: updatedTeams };
}

function _removeFromLeagueTeamFarm(state, playerId, teamId) {
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};
  const idx = state.leagueTeams.indexOf(team);
  const updatedTeams = [...state.leagueTeams];
  updatedTeams[idx] = {
    ...team,
    farmIds: (team.farmIds || []).filter(id => id !== playerId),
  };
  return { leagueTeams: updatedTeams };
}

function _buildSendToFarmMutation(state, playerId, teamId, currentFarmIds) {
  const isUserTeam = teamId === 'user';
  const newFarmIds = [...currentFarmIds, playerId];

  const teamMutation = isUserTeam
    ? {
        userTeam: {
          rosterIds: state.userTeam.rosterIds.filter(id => id !== playerId),
          farmIds:   newFarmIds,
        },
      }
    : (() => {
        const team = (state.leagueTeams || []).find(t => t.id === teamId);
        if (!team) return {};
        const idx = state.leagueTeams.indexOf(team);
        const updatedTeams = [...state.leagueTeams];
        updatedTeams[idx] = {
          ...team,
          rosterIds: team.rosterIds.filter(id => id !== playerId),
          farmIds:   newFarmIds,
        };
        return { leagueTeams: updatedTeams };
      })();

  return {
    players: {
      [playerId]: {
        group:  PLAYER_GROUP.PRACTICE_SQUAD,
        tier:   'farm',
        teamId,
      },
    },
    ...teamMutation,
  };
}

/**
 * _findDisplacementCandidate(state, incomingPlayerId, farmIds)
 * Section 20.3 overflow displacement rule:
 *   1. Identify which position group is most overstocked relative to minimum coverage
 *   2. The lowest OVR player at that position is the displacement candidate
 *   3. If displacement would violate position minimums, skip and find next-lowest
 *      at a non-critical position
 *   4. Displaced player goes to waivers (caller handles this)
 */
function _findDisplacementCandidate(state, incomingPlayerId, farmIds) {
  const incoming = state.players[incomingPlayerId];
  if (!incoming) return null;

  const farmPlayers = farmIds.map(id => state.players[id]).filter(Boolean);
  const incomingIsPitcher = ['SP','RP'].includes(incoming.pos);

  // Build position counts
  const positionCounts = {};
  for (const p of farmPlayers) {
    const pos = p.nativePos || p.pos;
    positionCounts[pos] = (positionCounts[pos] || 0) + 1;
  }

  // Find candidates — sorted by OVR asc (lowest first)
  const candidates = farmPlayers
    .filter(p => {
      const isPitcher = ['SP','RP'].includes(p.pos);
      return isPitcher === incomingIsPitcher;
    })
    .sort((a, b) => a.ovr - b.ovr);

  for (const candidate of candidates) {
    const pos = candidate.nativePos || candidate.pos;

    // Check if removing this player would violate position minimums
    if (_wouldViolateMinimums(farmPlayers, candidate, positionCounts)) continue;

    return candidate.id;
  }

  // No valid candidate found — should not happen if farm is properly maintained
  return null;
}

function _wouldViolateMinimums(farmPlayers, candidate, positionCounts) {
  const pos = candidate.nativePos || candidate.pos;
  const isPitcher = ['SP','RP'].includes(candidate.pos);

  if (!isPitcher) {
    // Check hitter position minimums
    // CI = corner infield (1B, 3B, 1B/3B), MI = middle infield (2B, SS, 2B/SS)
    const CI_POSITIONS = ['1B','3B','1B/3B'];
    const MI_POSITIONS = ['2B','SS','2B/SS'];
    const OF_POSITIONS = ['OF','DH/OF'];
    const C_POSITIONS  = ['C'];

    const getGroupCount = (positions) =>
      farmPlayers.filter(p => p !== candidate && positions.includes(p.nativePos || p.pos)).length;

    if (C_POSITIONS.includes(pos)  && getGroupCount(C_POSITIONS)  < 1) return true;
    if (CI_POSITIONS.includes(pos) && getGroupCount(CI_POSITIONS) < 1) return true;
    if (MI_POSITIONS.includes(pos) && getGroupCount(MI_POSITIONS) < 1) return true;
    if (OF_POSITIONS.includes(pos) && getGroupCount(OF_POSITIONS) < 1) return true;
  } else {
    // Check pitcher minimums
    const remainingSP = farmPlayers.filter(p => p !== candidate && p.pos === 'SP').length;
    const remainingRP = farmPlayers.filter(p => p !== candidate && p.pos === 'RP').length;
    if (candidate.pos === 'SP' && remainingSP < FARM_PITCHER_MIN_SP) return true;
    if (candidate.pos === 'RP' && remainingRP < FARM_PITCHER_MIN_RP) return true;
  }

  return false;
}

function _mergeMutations(a, b) {
  return {
    ...a,
    ...b,
    players: { ...(a.players || {}), ...(b.players || {}) },
  };
}


