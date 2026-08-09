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
  LINEUP_SLOTS,
  PHASE,
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
// LINEUP-SLOT ELIGIBILITY (single source of truth)
// ─────────────────────────────────────────────────────────────

/**
 * eligibleSlotsFor(player)
 * Returns the set of lineupSlots labels this player may fill, based on
 * nativePos. This is the authoritative eligibility map used by both
 * reconcileRoster (lineup backfill) and TeamScreen (swap UI) so the two
 * can never drift. Every non-DH position can also fill the DH slot.
 *
 * @param {Object} player
 * @returns {String[]} slot labels (subset of LINEUP_SLOTS)
 */
export function eligibleSlotsFor(player) {
  const nat = (player && (player.nativePos || player.pos)) || '';
  switch (nat) {
    case 'C':     return ['C', 'DH'];
    case '1B':    return ['1B', 'DH'];
    case '2B':    return ['2B', 'DH'];
    case '3B':    return ['3B', 'DH'];
    case 'SS':    return ['SS', 'DH'];
    case 'OF':    return ['OF', 'DH'];
    case 'DH':    return ['DH'];            // pure DH — only DH slot
    case 'DH/OF': return ['OF', 'DH'];
    case '2B/SS': return ['2B', 'SS', 'DH'];
    case '1B/3B': return ['1B', '3B', 'DH'];
    case 'SS/OF': return ['SS', 'OF', 'DH'];
    case '1B/OF': return ['1B', 'OF', 'DH'];
    default:
      if (nat.includes('/')) {
        return [...new Set([...nat.split('/'), 'DH'])];
      }
      return nat ? [nat, 'DH'] : ['DH'];
  }
}

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

  // Every player who is healthy, rostered, and available to play.
  // Injured players carry group IL and are therefore excluded here — this is
  // the fix for the injured-incumbent bug (an injured starter must NOT count
  // as coverage, otherwise a CRITICAL gap is masked and auto-backfill never fires).
  const activePlayers = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended && !p._pendingDeparture
                  && p.group !== PLAYER_GROUP.IL
                  && p.group !== PLAYER_GROUP.PRACTICE_SQUAD);

  const issues = [];

  // Coverage per required hitter position = the number of healthy, active
  // hitters (starters AND bench all carry BENCH_HITTERS under the lineupSlots
  // model) whose nativePos can play that position. A clean body-count — no
  // "+1 if any lineup slot matches" collapse, no double counting.
  const healthyHitters = activePlayers.filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS);

  for (const pos of REQUIRED_STARTER_POSITIONS) {
    const compatible = POSITION_COVERAGE[pos] || [pos];
    const available  = healthyHitters.filter(p =>
      compatible.includes(p.nativePos || p.pos)
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
// ROSTER RECONCILIATION (the single post-mutation invariant)
// ─────────────────────────────────────────────────────────────

/**
 * reconcileRoster(state, teamId, options)
 *
 * The one invariant that must hold after ANY roster mutation (injury, IL
 * return/activation, trade, waiver, call-up, or a lineup/rotation edit). It is
 * pure: it reads `state`, works on local copies, and returns a mutation object
 * in the same shape the rest of RosterEngine returns. The caller applies it.
 *
 * Guarantees, for the given team:
 *   1. lineupSlots is exactly the 9 canonical slots in order; every non-null
 *      occupant is a healthy, rostered BENCH_HITTERS hitter eligible for that slot.
 *   2. Vacant slots are backfilled from eligible healthy bench hitters (manager
 *      domain — always automatic). If bench can't cover, the slot stays vacant
 *      and the need is reported (user) or filled from farm (CPU, autoManage).
 *   3. rotation.order = the rostered, healthy STARTING_PITCHERS (de-duped, no
 *      injured/departed ids); a short rotation is topped up from PITCHER_BENCH
 *      (manager domain — always automatic), then from farm (CPU only).
 *   4. Active-count invariant is GM domain: for CPU (autoManage) reconcile calls
 *      up from farm to reach ACTIVE_TOTAL and waives the lowest-OVR droppable
 *      surplus back down to it. For the USER, reconcile does NOT auto-call-up or
 *      auto-waive — it reports `pendingCallups` (open positions + how many bodies
 *      short of the cap) and `pendingSurplus` (drop candidates) so the card/UI
 *      layer can let the GM choose. (The window timer, "didn't act" penalty, and
 *      suboptimal auto-fallback call-up are the IL card flow — a later batch.)
 *      Spring: no cap enforcement.
 *   5. No id appears in both rosterIds and farmIds.
 *
 * The split follows the plan's manager-vs-GM ownership: lineup and rotation are
 * manager-owned (auto-arranged from the active roster for all teams); call-ups
 * and waivers are GM-owned (auto for CPU, gated for the user).
 *
 * @param {Object}  state
 * @param {String}  [teamId='user']
 * @param {Object}  [options]
 * @param {Boolean} [options.autoManage=false] — CPU teams pass true (full auto)
 * @returns {Object} mutation object: { players, userTeam|leagueTeams, waiverPool?,
 *                    pendingCallups?, pendingSurplus?, surplusCount? }
 */
export function reconcileRoster(state, teamId = 'user', options = {}) {
  const autoManage = !!options.autoManage;
  const isUserTeam = !teamId || teamId === 'user';
  const team = isUserTeam
    ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};

  const players   = state.players || {};
  const inSpring  = state.phase === PHASE.SPRING_TRAINING;
  const activeCap = ROSTER_LIMITS.ACTIVE_TOTAL;

  // ── Working copies (never mutate state) ───────────────────────────────
  let rosterIds = [...(team.rosterIds || [])];
  let farmIds   = [...(team.farmIds   || [])];
  const patch   = {};                 // playerId -> partial player update
  const waived  = [];                 // playerIds moved to waivers this pass

  // Effective (post-patch) group / availability helpers.
  const groupOf = (id) => (patch[id] && patch[id].group !== undefined)
    ? patch[id].group
    : players[id]?.group;
  const isHealthy = (id) => {
    const p = players[id];
    return !!p && !p.isInjured && !p.isSuspended && !p.onPersonalLeave && !p._pendingDeparture;
  };
  const setPatch = (id, upd) => { patch[id] = { ...(patch[id] || {}), ...upd }; };

  // ── Normalize lineupSlots to the 9 canonical slots in fixed order ─────
  // Carry over existing occupants slot-for-slot when the array is already the
  // canonical shape; otherwise re-seat surviving occupants by eligibility.
  const existing = team.lineupSlots || [];
  const canonical = existing.length === LINEUP_SLOTS.length
    && existing.every((e, i) => e && e.slot === LINEUP_SLOTS[i]);

  let slots = LINEUP_SLOTS.map((label, i) => ({
    slot: label,
    playerId: canonical ? (existing[i].playerId || null) : null,
  }));

  if (!canonical) {
    // Re-seat any valid occupants from the old (possibly malformed) array.
    const survivors = existing
      .map(e => e && e.playerId)
      .filter(id => id && rosterIds.includes(id) && isHealthy(id)
                 && groupOf(id) === PLAYER_GROUP.BENCH_HITTERS);
    _seatByEligibility(slots, survivors, players);
  }

  // ── Vacate invalid occupants (injured/departed/wrong-group/dup/ineligible) ──
  const seen = new Set();
  for (const s of slots) {
    const id = s.playerId;
    if (!id) continue;
    const ok = rosterIds.includes(id)
      && isHealthy(id)
      && groupOf(id) === PLAYER_GROUP.BENCH_HITTERS
      && !seen.has(id)
      && eligibleSlotsFor(players[id]).includes(s.slot);
    if (ok) { seen.add(id); } else { s.playerId = null; }
  }

  // ── Fill vacant slots: bench first, then a farm call-up ───────────────
  const seatedIds = () => new Set(slots.map(s => s.playerId).filter(Boolean));
  const benchPool = () => rosterIds
    .filter(id => isHealthy(id)
              && groupOf(id) === PLAYER_GROUP.BENCH_HITTERS
              && !seatedIds().has(id))
    .map(id => players[id])
    .filter(Boolean)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));

  for (const slot of slots) {
    if (slot.playerId) continue;

    // Manager domain: seat the best eligible healthy bench hitter (already active).
    const benchPick = benchPool().find(p => eligibleSlotsFor(p).includes(slot.slot));
    if (benchPick) { slot.playerId = benchPick.id; continue; }

    // GM domain: no bench cover. CPU calls up the best eligible farm hitter to
    // keep fielding a full lineup; the user's need is reported (pendingCallups).
    if (autoManage) {
      const farmPick = farmIds
        .map(id => players[id])
        .filter(p => p && isHealthy(p.id)
                  && !['SP', 'RP'].includes(p.pos)
                  && eligibleSlotsFor(p).includes(slot.slot))
        .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
      if (farmPick) {
        farmIds = farmIds.filter(id => id !== farmPick.id);
        rosterIds.push(farmPick.id);
        setPatch(farmPick.id, {
          group: PLAYER_GROUP.BENCH_HITTERS, tier: 'active', teamId,
          _farmArc: null, _farmArcStart: null,
        });
        slot.playerId = farmPick.id;
      }
    }
    // If still unfilled, leave vacant — reported for the user, rare for CPU.
  }

  // ── Rebuild rotation.order from healthy, rostered STARTING_PITCHERS ────
  const oldRotation = team.rotation || { order: [], currentIndex: 0 };
  const validSP = (id) => rosterIds.includes(id) && isHealthy(id)
    && groupOf(id) === PLAYER_GROUP.STARTING_PITCHERS;

  let order = [];
  const inOrder = new Set();
  for (const id of (oldRotation.order || [])) {
    if (validSP(id) && !inOrder.has(id)) { order.push(id); inOrder.add(id); }
  }
  // Append any healthy rostered SP not already in the order (e.g. after a swap).
  for (const id of rosterIds) {
    if (validSP(id) && !inOrder.has(id)) { order.push(id); inOrder.add(id); }
  }
  // Manager domain: a short rotation is topped up from healthy PITCHER_BENCH
  // starters already on the active roster (non-destructive — no size change).
  while (order.length < REQUIRED_SP_COUNT) {
    const pbSP = rosterIds
      .map(id => players[id])
      .filter(p => p && isHealthy(p.id) && p.pos === 'SP'
                && groupOf(p.id) === PLAYER_GROUP.PITCHER_BENCH
                && !inOrder.has(p.id))
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    if (!pbSP) break;
    setPatch(pbSP.id, { group: PLAYER_GROUP.STARTING_PITCHERS });
    order.push(pbSP.id);
    inOrder.add(pbSP.id);
  }
  // GM domain (CPU only): still short → call up the best farm SP.
  while (autoManage && order.length < REQUIRED_SP_COUNT) {
    const farmSP = farmIds
      .map(id => players[id])
      .filter(p => p && isHealthy(p.id) && p.pos === 'SP')
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    if (!farmSP) break;
    farmIds = farmIds.filter(id => id !== farmSP.id);
    rosterIds.push(farmSP.id);
    setPatch(farmSP.id, {
      group: PLAYER_GROUP.STARTING_PITCHERS, tier: 'active', teamId,
      _farmArc: null, _farmArcStart: null,
    });
    order.push(farmSP.id);
    inOrder.add(farmSP.id);
  }
  const currentIndex = order.length ? (oldRotation.currentIndex || 0) % order.length : 0;

  // ── Active-count invariant (GM domain; regular season only) ───────────
  let pendingSurplus = null;
  let pendingCallups = null;
  let surplusCount   = 0;

  if (!inSpring) {
    let nonIL = _nonILCount(rosterIds, groupOf);

    if (autoManage) {
      // CPU: top up from farm to reach the cap (best available body).
      while (nonIL < activeCap) {
        const filler = farmIds
          .map(id => players[id])
          .filter(p => p && isHealthy(p.id))
          .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
        if (!filler) break;
        farmIds = farmIds.filter(id => id !== filler.id);
        rosterIds.push(filler.id);
        const isP = ['SP', 'RP'].includes(filler.pos);
        setPatch(filler.id, {
          group: isP ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS,
          tier: 'active', teamId, _farmArc: null, _farmArcStart: null,
        });
        nonIL++;
      }
      // CPU: waive the lowest-OVR droppable surplus back down to the cap.
      if (nonIL > activeCap) {
        surplusCount = nonIL - activeCap;
        const droppable = _droppable(rosterIds, order, slots, groupOf, isHealthy, players);
        for (let i = 0; i < surplusCount && i < droppable.length; i++) {
          const id = droppable[i];
          rosterIds = rosterIds.filter(x => x !== id);
          waived.push(id);
          setPatch(id, {
            group: 'waivers', tier: 'waivers', onWaivers: true,
            waiverStartTime: Date.now(), _pendingILReturn: false,
            _pendingDeparture: false, teamId: null,
          });
        }
      }
    } else {
      // USER: don't auto-call-up or auto-waive. Report the needs so the card/UI
      // layer can let the GM choose (and a later batch can time-box + penalize).
      const vacant = slots.filter(s => !s.playerId).map(s => s.slot);
      const shortBy = Math.max(0, activeCap - nonIL);
      if (vacant.length || shortBy > 0) {
        pendingCallups = { slots: vacant, count: shortBy };
      }
      if (nonIL > activeCap) {
        surplusCount = nonIL - activeCap;
        pendingSurplus = _droppable(rosterIds, order, slots, groupOf, isHealthy, players);
      }
    }
  }

  // ── Assemble the mutation object ──────────────────────────────────────
  const teamPatch = {
    rosterIds,
    farmIds,
    lineupSlots: slots,
    rotation: { order, currentIndex },
  };

  const mutation = { players: patch };
  if (isUserTeam) {
    mutation.userTeam = teamPatch;
  } else {
    const updatedTeams = (state.leagueTeams || []).map(t =>
      t.id === teamId ? { ...t, ...teamPatch } : t
    );
    mutation.leagueTeams = updatedTeams;
  }
  if (waived.length) {
    mutation.waiverPool = [...(state.waiverPool || []), ...waived];
  }
  if (pendingCallups) {
    mutation.pendingCallups = pendingCallups;
  }
  if (pendingSurplus && pendingSurplus.length) {
    mutation.pendingSurplus = pendingSurplus;
    mutation.surplusCount   = surplusCount;
  }
  return mutation;
}

/**
 * applyRosterMutation(state, mutation)
 * Applies a mutation object (from reconcileRoster or any RosterEngine function)
 * onto a live state object, in place. Mirrors GameEngine._applyMutations so the
 * non-GameEngine callers (CardEngine, TeamScreen) share one merge implementation
 * instead of hand-rolling Object.assign each time. Pure w.r.t. StateManager
 * (takes state as input; the caller runs it inside its own mutate()).
 *
 * Ignores the advisory keys pendingSurplus/surplusCount — those are read by the
 * caller before applying, not written into state.
 *
 * @param {Object} state
 * @param {Object} mutation
 */
export function applyRosterMutation(state, mutation) {
  if (!mutation) return;
  for (const [key, value] of Object.entries(mutation)) {
    if (key === 'pendingSurplus' || key === 'surplusCount' || key === 'pendingCallups') continue;
    if (key === 'players' && value && typeof value === 'object') {
      for (const [id, upd] of Object.entries(value)) {
        if (state.players[id]) Object.assign(state.players[id], upd);
        else state.players[id] = { ...upd };
      }
    } else if (key === 'userTeam' && value && typeof value === 'object') {
      Object.assign(state.userTeam, value);
      if (value.finances) Object.assign(state.userTeam.finances, value.finances);
    } else {
      state[key] = value;
    }
  }
}

// ── reconcile internals ──────────────────────────────────────────────

/** Count rostered players not currently on the IL (matches harness activeCount). */
function _nonILCount(rosterIds, groupOf) {
  let n = 0;
  for (const id of rosterIds) if (groupOf(id) !== PLAYER_GROUP.IL) n++;
  return n;
}

/**
 * Droppable surplus candidates: healthy, non-IL players who are NOT seated in
 * the lineup and NOT in the rotation — i.e. bench hitters and surplus pitchers —
 * lowest OVR first. Locked starters are never offered as drop candidates.
 */
function _droppable(rosterIds, order, slots, groupOf, isHealthy, players) {
  const locked = new Set([
    ...slots.map(s => s.playerId).filter(Boolean),
    ...order,
  ]);
  return rosterIds
    .filter(id => groupOf(id) !== PLAYER_GROUP.IL && isHealthy(id) && !locked.has(id))
    .map(id => players[id])
    .filter(Boolean)
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))
    .map(p => p.id);
}

/** Seat a list of player ids into the canonical slot array by eligibility. */
function _seatByEligibility(slots, ids, players) {
  const used = new Set();
  // Pass 1: exact/eligible seat, scarcer positions first (C before DH).
  for (const s of slots) {
    if (s.playerId) continue;
    const pick = ids.find(id => !used.has(id) && players[id]
      && eligibleSlotsFor(players[id]).includes(s.slot));
    if (pick) { s.playerId = pick; used.add(pick); }
  }
  // Pass 2: drop any leftovers into remaining empty slots.
  for (const s of slots) {
    if (s.playerId) continue;
    const pick = ids.find(id => !used.has(id));
    if (pick) { s.playerId = pick; used.add(pick); }
  }
}

// ─────────────────────────────────────────────────────────────
// SPRING TRAINING CUTS
// ─────────────────────────────────────────────────────────────

/**
 * toggleKeeperTag(state, playerId)
 * Flips _isKeeper on a player during spring training.
 * Enforces the 28-keeper cap — returns an error string if at cap and
 * the player is currently not a keeper (can't add more).
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations  — or { error: String } if cap hit
 */
export function toggleKeeperTag(state, playerId) {
  const player = state.players[playerId];
  if (!player) return { error: 'Player not found' };

  const isCurrentlyKeeper = !!player._isKeeper;

  // Enforce 28-keeper cap when trying to ADD a keeper
  if (!isCurrentlyKeeper) {
    const currentKeeperCount = state.userTeam.rosterIds
      .filter(id => state.players[id]?._isKeeper)
      .length;
    if (currentKeeperCount >= ROSTER_LIMITS.ACTIVE_TOTAL) {
      return { error: 'Untag another player first — you already have 28 keepers.' };
    }
  }

  return {
    players: {
      [playerId]: { _isKeeper: !isCurrentlyKeeper },
    },
  };
}

/**
 * applySpringCuts(state)
 * Processes the Opening Day roster cut (38→28) using keeper flags.
 * Players with _isKeeper: true form the 28-man Opening Day roster.
 * - Spring invitees not kept → return to farm
 * - Regular roster players not kept → waived
 * If fewer than 28 are tagged, auto-fills from untagged regular
 * players by OVR descending until reaching 28.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function applySpringCuts(state) {
  const rosterIds  = state.userTeam.rosterIds || [];
  const players    = state.players;

  // Build keeper list from flags
  let keepers = rosterIds.filter(id => players[id]?._isKeeper);

  // Auto-fill if under 28
  if (keepers.length < ROSTER_LIMITS.ACTIVE_TOTAL) {
    const nonKeepers = rosterIds
      .filter(id => !players[id]?._isKeeper)
      .sort((a, b) => (players[b]?.ovr || 0) - (players[a]?.ovr || 0));
    const needed = ROSTER_LIMITS.ACTIVE_TOTAL - keepers.length;
    keepers = [...keepers, ...nonKeepers.slice(0, needed)];
  }

  // Hard cap at 28
  keepers = keepers.slice(0, ROSTER_LIMITS.ACTIVE_TOTAL);

  const keepSet   = new Set(keepers);
  const toRelease = rosterIds.filter(id => !keepSet.has(id));

  const mutations  = { players: {} };
  let newFarmIds   = [...(state.userTeam.farmIds || [])];

  for (const playerId of toRelease) {
    const player = state.players[playerId];
    if (!player) continue;

    if (player._isSpringInvitee) {
      // Invitees always return to farm
      if (newFarmIds.length < ROSTER_LIMITS.FARM_TOTAL) {
        newFarmIds.push(playerId);
        mutations.players[playerId] = {
          group:             PLAYER_GROUP.PRACTICE_SQUAD,
          teamId:            'user',
          _isSpringInvitee:  false,
          _isKeeper:         false,
        };
      } else {
        const wMut = placeOnWaivers(state, playerId);
        Object.assign(mutations.players, wMut.players || {});
        if (wMut.waiverPool) mutations.waiverPool = wMut.waiverPool;
      }
    } else {
      // Regular roster player the GM chose not to keep → waived
      const wMut = placeOnWaivers(state, playerId);
      Object.assign(mutations.players, wMut.players || {});
      if (wMut.waiverPool) mutations.waiverPool = wMut.waiverPool;
    }
  }

  // Clear spring flags on all kept players
  for (const playerId of keepers) {
    mutations.players[playerId] = {
      ...(mutations.players[playerId] || {}),
      _isSpringInvitee: false,
      _isKeeper:        false,
    };
  }

  return {
    ...mutations,
    userTeam: {
      rosterIds: keepers,
      farmIds:   newFarmIds,
    },
  };
}

/**
 * autoResolveSpringCuts(state)
 * Called when the spring cut deadline expires without GM action.
 * Tags the 28 highest-rated players as keepers, then applies cuts.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function autoResolveSpringCuts(state) {
  const allIds = state.userTeam.rosterIds || [];
  const sorted = allIds
    .map(id => state.players[id])
    .filter(Boolean)
    .sort((a, b) => b.ovr - a.ovr)
    .map(p => p.id);

  // Tag top 28 as keepers in a temp state copy for applySpringCuts
  const tempMutations = { players: {} };
  sorted.forEach((id, i) => {
    tempMutations.players[id] = { _isKeeper: i < ROSTER_LIMITS.ACTIVE_TOTAL };
  });

  // Build a patched state to pass to applySpringCuts
  const patchedState = {
    ...state,
    players: { ...state.players },
  };
  for (const [id, patch] of Object.entries(tempMutations.players)) {
    patchedState.players[id] = { ...patchedState.players[id], ...patch };
  }

  return applySpringCuts(patchedState);
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
    PLAYER_GROUP.BENCH_HITTERS,    // all active hitters (formerly STARTING_HITTERS too)
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


