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
import { isAvailable } from './PlayerFactory.js';

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

// IL placement, day-to-day, and the return-to-eligibility moment all run on
// the real-clock injury timeline (§65): InjuryEngine builds the updates and
// TransactionEngine.applyDue() moves them along the roster clock. When a USER
// player becomes eligible he is flagged _pendingILReturn and queued in
// ilReturnQueue for the GM's decision card — never auto-activated.

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
export function placeOnWaivers(state, playerId, { atMs = Date.now(), reason = null } = {}) {
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
        waiverStartTime:  atMs,
        _pendingILReturn: false,
        teamId:           null,
        // Section 20.2: unclaimed after 72h → outrighted to this team's farm
        // (a farm-overflow displacement goes to free agency instead).
        _waivedBy:        teamId || null,
        _waiveReason:     reason,
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
  // Pitchers join the staff, hitters the bench — never a pitcher in a
  // hitter group (that made a claimed pitcher eligible to DH).
  const group = defaultActiveGroup(state.players[playerId]);

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
 * Player clears waivers unclaimed (Section 20.2 step 7 — LOCKED): he is
 * outrighted to the farm of the team that placed him (composition caps and
 * displacement apply). A farm-overflow displacement — or a player whose team
 * no longer exists — goes to free agency instead.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function clearWaivers(state, playerId) {
  _assertPlayerExists(state, playerId);
  const player = state.players[playerId];
  const owner  = player._waivedBy;
  const reset  = { onWaivers: false, waiverStartTime: null, _waivedBy: null, _waiveReason: null };
  const pool   = (state.waiverPool || []).filter(id => id !== playerId);
  const ownerExists = owner === 'user' || (state.leagueTeams || []).some(t => t.id === owner);

  if (owner && ownerExists && player._waiveReason !== 'displaced') {
    const farm = sendToFarm({ ...state, waiverPool: pool }, playerId, owner);
    return {
      ...farm,
      players:    { ...(farm.players || {}), [playerId]: { ...reset, ...(farm.players?.[playerId] || {}) } },
      waiverPool: farm.waiverPool || pool,
    };
  }

  return {
    players: {
      [playerId]: { ...reset, group: 'freeAgent', tier: 'farm', teamId: null },
    },
    waiverPool:    pool,
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
      const waiversMutation = placeOnWaivers(state, displaced, { reason: 'displaced' });
      const farmMutation    = _buildSendToFarmMutation(state, playerId, teamId, farmIds.filter(id => id !== displaced));
      return _mergeMutations(waiversMutation, farmMutation);
    }
  }

  return _buildSendToFarmMutation(state, playerId, teamId, farmIds);
}

/**
 * defaultActiveGroup(player)
 * Where a player lands on the active roster when he reports (trade, call-up,
 * IL activation). Starters reach the rotation through reconcileRoster, which
 * tops a short rotation up from PITCHER_BENCH — so an arriving SP never
 * creates a six-man rotation.
 */
export function defaultActiveGroup(player) {
  if (player?.pos === 'SP') return PLAYER_GROUP.PITCHER_BENCH;
  if (player?.pos === 'RP') return PLAYER_GROUP.BULLPEN;
  return PLAYER_GROUP.BENCH_HITTERS;
}

/**
 * pendingArrivals(state, teamId)
 * Players already on their way to this team (traded or called up, reporting
 * the next calendar day). They hold their roster spot: every count of the
 * active roster adds them, so nobody calls up a second body for the same spot.
 */
export function pendingArrivals(state, teamId) {
  return (state.transactions || []).filter(t =>
    t.status === 'pending' && t.kind === 'arrival' && t.teamId === teamId);
}

/**
 * nextCalendarDay(ms)
 * Local midnight after `ms` — when every arrival reports (§65).
 */
export function nextCalendarDay(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * makeArrival({ player, teamId, fromTeamId, reason, atMs, by })
 * Builds the ledger record + player patch for a player heading to `teamId`.
 * The caller removes him from his old roster/farm list. Pure.
 * @returns {{ tx: Object, patch: Object }}
 */
export function makeArrival({ player, teamId, fromTeamId = null, reason, atMs, by = null }) {
  return {
    tx: {
      id:          `tx-${player.id}-${atMs}-${reason}`,
      kind:        'arrival',
      teamId,
      playerId:    player.id,
      fromTeamId,
      toGroup:     defaultActiveGroup(player),
      reason,                       // 'trade' | 'callup'
      by,                           // 'gm' | 'manager' | 'cpu'
      createdAt:   atMs,
      effectiveAt: nextCalendarDay(atMs),
      status:      'pending',
    },
    patch: {
      group:  PLAYER_GROUP.IN_TRANSIT,
      teamId,
      tier:   'active',
      _farmArc: null,
      _farmArcStart: null,
    },
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
    .filter(p => p && isAvailable(p)
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

// ─────────────────────────────────────────────────────────────
// ROSTER RECONCILIATION (the single post-mutation invariant)
// ─────────────────────────────────────────────────────────────

/**
 * reconcileRoster(state, teamId, options)
 *
 * The one invariant that must hold after ANY roster mutation (injury, IL
 * placement/activation, trade departure/arrival, waiver, call-up, or a
 * lineup/rotation edit). Pure: reads `state`, works on local copies, returns a
 * mutation object in the same shape the rest of RosterEngine returns.
 *
 * Guarantees, for the given team:
 *   1. lineupSlots is exactly the 9 canonical slots in order; every occupant is
 *      a healthy, rostered BENCH_HITTERS hitter.
 *   2. Manager domain (always automatic, every team): a vacant slot is filled
 *      by the best ELIGIBLE healthy bench hitter; if nobody on the bench can
 *      play the position, the manager puts the best remaining bench hitter
 *      there out of position (`emergency: true`) — a real team always fields
 *      nine. The open position is reported as a need.
 *   3. rotation.order = the rostered, healthy STARTING_PITCHERS; a short
 *      rotation is topped up from healthy PITCHER_BENCH starters.
 *   4. Active-count invariant (GM domain, regular season and playoffs):
 *      active (non-IL) players + players already on their way (pending
 *      'arrival' transactions) == ACTIVE_TOTAL.
 *        CPU (autoManage): its GM calls up from the farm at once — through
 *          the transaction ledger, so the call-up reports the next calendar
 *          day like everyone else's (needs options.atMs) — and waives the
 *          lowest-OVR droppable surplus.
 *        USER: never auto-moves. Reports `pendingCallups` / `pendingSurplus`;
 *          TransactionEngine runs the decision deadline (§65).
 *      Spring: no cap enforcement.
 *   5. No id appears in both rosterIds and farmIds.
 *
 * @param {Object}  state
 * @param {String}  [teamId='user']
 * @param {Object}  [options]
 * @param {Boolean} [options.autoManage=false] — CPU teams pass true
 * @param {Number}  [options.atMs]             — roster-clock time for CPU call-ups
 * @returns {Object} mutation: { players, userTeam|leagueTeams, waiverPool?,
 *                    transactions?, pendingCallups?, pendingSurplus?, surplusCount? }
 */
export function reconcileRoster(state, teamId = 'user', options = {}) {
  const autoManage = !!options.autoManage;
  const isUserTeam = !teamId || teamId === 'user';
  const team = isUserTeam
    ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};
  const tid = isUserTeam ? 'user' : teamId;

  const players   = state.players || {};
  const inSpring  = state.phase === PHASE.SPRING_TRAINING;
  const activeCap = ROSTER_LIMITS.ACTIVE_TOTAL;
  const atMs      = Number.isFinite(options.atMs) ? options.atMs : null;

  // ── Working copies (never mutate state) ───────────────────────────────
  let rosterIds = [...(team.rosterIds || [])];
  let farmIds   = [...(team.farmIds   || [])];
  const patch   = {};                 // playerId -> partial player update
  const waived  = [];                 // playerIds moved to waivers this pass
  const newTx   = [];                 // CPU call-ups created this pass
  const inbound = pendingArrivals(state, tid);

  const groupOf = (id) => (patch[id] && patch[id].group !== undefined)
    ? patch[id].group
    : players[id]?.group;
  const isHealthy = (id) => {
    const p = players[id];
    return !!p && isAvailable(p);
  };
  const setPatch = (id, upd) => { patch[id] = { ...(patch[id] || {}), ...upd }; };
  const isP = (p) => ['SP', 'RP'].includes(p?.pos);

  // ── Normalize lineupSlots to the 9 canonical slots in fixed order ─────
  const existing = team.lineupSlots || [];
  const canonical = existing.length === LINEUP_SLOTS.length
    && existing.every((e, i) => e && e.slot === LINEUP_SLOTS[i]);

  let slots = LINEUP_SLOTS.map((label, i) => ({
    slot: label,
    playerId: canonical ? (existing[i].playerId || null) : null,
  }));

  if (!canonical) {
    const survivors = existing
      .map(e => e && e.playerId)
      .filter(id => id && rosterIds.includes(id) && isHealthy(id)
                 && groupOf(id) === PLAYER_GROUP.BENCH_HITTERS);
    _seatByEligibility(slots, survivors, players);
  }

  // ── Vacate invalid occupants (injured/departed/wrong-group/dup/ineligible).
  // An emergency (out-of-position) occupant is always re-evaluated, so a real
  // option takes the slot the moment one is on the bench.
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

  // ── Fill vacant slots (manager domain) ─────────────────────────────────
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
    const benchPick = benchPool().find(p => eligibleSlotsFor(p).includes(slot.slot));
    if (benchPick) slot.playerId = benchPick.id;
  }
  // Nobody eligible: the manager plays someone out of position.
  const openPositions = [];
  for (const slot of slots) {
    if (slot.playerId) continue;
    openPositions.push(slot.slot);
    const anyPick = benchPool()[0];
    if (anyPick) { slot.playerId = anyPick.id; slot.emergency = true; }
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
  for (const id of rosterIds) {
    if (validSP(id) && !inOrder.has(id)) { order.push(id); inOrder.add(id); }
  }
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
  const rotationShort = Math.max(0, REQUIRED_SP_COUNT - order.length);
  const currentIndex = order.length ? (oldRotation.currentIndex || 0) % order.length : 0;

  // ── Active-count invariant (GM domain; not in spring) ─────────────────
  let pendingSurplus = null;
  let pendingCallups = null;
  let surplusCount   = 0;

  if (!inSpring) {
    let count = _nonILCount(rosterIds, groupOf) + inbound.length;

    if (autoManage) {
      // CPU GM: call up to the cap — position need first (open lineup
      // positions, a short rotation), then by roster balance, best OVR.
      const sideCounts = _sideCounts(rosterIds, groupOf, players, inbound);
      const wants = [...openPositions.map(pos => ({ side: 'hitter', pos })),
                     ...Array.from({ length: rotationShort }, () => ({ side: 'pitcher', pos: 'SP' }))];
      while (count < activeCap) {
        const want = wants.shift() || {
          side: sideCounts.hitter < HITTER_TARGET ? 'hitter'
              : sideCounts.pitcher < PITCHER_TARGET ? 'pitcher'
              : (sideCounts.hitter <= sideCounts.pitcher ? 'hitter' : 'pitcher'),
          pos: null,
        };
        const pool = farmIds.map(id => players[id])
          .filter(p => p && isHealthy(p.id) && (want.side === 'pitcher') === isP(p));
        const fit  = (p) => !want.pos ? 0
          : want.side === 'pitcher' ? (p.pos === want.pos ? 1 : 0)
          : (eligibleSlotsFor(p).includes(want.pos) ? 1 : 0);
        const pick = pool.sort((a, b) => fit(b) - fit(a) || (b.ovr || 0) - (a.ovr || 0))[0]
          || farmIds.map(id => players[id]).filter(p => p && isHealthy(p.id))
               .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
        if (!pick) break;
        farmIds = farmIds.filter(id => id !== pick.id);
        if (atMs !== null) {
          const { tx, patch: tp } = makeArrival({ player: pick, teamId: tid, fromTeamId: tid,
                                                  reason: 'callup', atMs, by: 'cpu' });
          newTx.push(tx);
          setPatch(pick.id, tp);
        } else {
          // No clock (league build / offseason): the roster is set directly.
          rosterIds.push(pick.id);
          setPatch(pick.id, { group: defaultActiveGroup(pick), tier: 'active', teamId: tid,
                              _farmArc: null, _farmArcStart: null });
        }
        sideCounts[isP(pick) ? 'pitcher' : 'hitter']++;
        count++;
      }
      if (count > activeCap) {
        surplusCount = count - activeCap;
        const droppable = _droppable(rosterIds, order, slots, groupOf, isHealthy, players);
        for (let i = 0; i < surplusCount && i < droppable.length; i++) {
          const id = droppable[i];
          rosterIds = rosterIds.filter(x => x !== id);
          waived.push(id);
          setPatch(id, {
            group: 'waivers', tier: 'waivers', onWaivers: true,
            waiverStartTime: atMs ?? Date.now(), _pendingILReturn: false, teamId: null,
            _waivedBy: tid, _waiveReason: null,
          });
        }
      }
    } else {
      const shortBy = Math.max(0, activeCap - count);
      if (openPositions.length || shortBy > 0) {
        pendingCallups = { slots: openPositions, count: shortBy };
      }
      if (count > activeCap) {
        surplusCount = count - activeCap;
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
    mutation.leagueTeams = (state.leagueTeams || []).map(t =>
      t.id === teamId ? { ...t, ...teamPatch } : t);
  }
  if (waived.length) mutation.waiverPool = [...(state.waiverPool || []), ...waived];
  if (newTx.length)  mutation.transactions = [...(state.transactions || []), ...newTx];
  if (pendingCallups) mutation.pendingCallups = pendingCallups;
  if (pendingSurplus && pendingSurplus.length) {
    mutation.pendingSurplus = pendingSurplus;
    mutation.surplusCount   = surplusCount;
  }
  return mutation;
}

// Active-roster composition targets (Section 20 — LOCKED): 14 hitters
// (9 starters + 5 bench) and 14 pitchers (5 SP + 5 RP + 4 bench).
export const HITTER_TARGET  = ROSTER_LIMITS.STARTING_HITTERS + ROSTER_LIMITS.BENCH_HITTERS;
export const PITCHER_TARGET = ROSTER_LIMITS.STARTING_PITCHERS + ROSTER_LIMITS.BULLPEN + ROSTER_LIMITS.PITCHER_BENCH;

/** Hitters / pitchers on the active roster plus those already on the way. */
function _sideCounts(rosterIds, groupOf, players, inbound) {
  const c = { hitter: 0, pitcher: 0 };
  for (const id of rosterIds) {
    if (groupOf(id) === PLAYER_GROUP.IL) continue;
    c[['SP', 'RP'].includes(players[id]?.pos) ? 'pitcher' : 'hitter']++;
  }
  for (const t of inbound) c[['SP', 'RP'].includes(players[t.playerId]?.pos) ? 'pitcher' : 'hitter']++;
  return c;
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
    // Never write `undefined` over a real collection.
    if (value === undefined) continue;
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
  const players    = state.players;
  // Injured players stay on the IL (and on rosterIds); only the active
  // roster is cut to 28.
  const ilIds      = (state.userTeam.rosterIds || []).filter(id => players[id]?.group === PLAYER_GROUP.IL);
  const rosterIds  = (state.userTeam.rosterIds || []).filter(id => players[id]?.group !== PLAYER_GROUP.IL);
  // A player already on his way (traded / called up in spring) holds one of
  // the 28 Opening Day spots (§65).
  const cap        = ROSTER_LIMITS.ACTIVE_TOTAL - pendingArrivals(state, 'user').length;

  // Build keeper list from flags
  let keepers = rosterIds.filter(id => players[id]?._isKeeper);

  // Auto-fill if under 28 — balanced like a real Opening Day roster
  // (14 position players incl. every position + a backup catcher, 14 arms).
  if (keepers.length < cap) {
    keepers = _openingDayFill(keepers, rosterIds, cap, players, pendingArrivals(state, 'user'));
  }

  // Hard cap at 28 (less anyone already on his way)
  keepers = keepers.slice(0, cap);

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
      rosterIds: [...keepers, ...ilIds],
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
  const allIds = (state.userTeam.rosterIds || []).filter(id => state.players[id]?.group !== PLAYER_GROUP.IL);
  const cap    = ROSTER_LIMITS.ACTIVE_TOTAL - pendingArrivals(state, 'user').length;
  const keep   = new Set(_openingDayFill([], allIds, cap, state.players, pendingArrivals(state, 'user')));

  // Tag the balanced 28 as keepers in a temp state copy for applySpringCuts
  const tempMutations = { players: {} };
  for (const id of allIds) tempMutations.players[id] = { _isKeeper: keep.has(id) };

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

/**
 * _openingDayFill(keepers, pool, cap, players, inbound)
 * Completes an Opening Day roster the way a club builds one: every lineup
 * position covered plus a backup catcher, then the best players on each side
 * up to the 14 / 14 composition, then best available. Pure.
 */
function _openingDayFill(keepers, pool, cap, players, inbound = []) {
  const keep = [...keepers];
  const has  = new Set(keep);
  const isP  = (id) => ['SP', 'RP'].includes(players[id]?.pos);
  const side = { hitter: 0, pitcher: 0 };
  for (const id of keep) side[isP(id) ? 'pitcher' : 'hitter']++;
  for (const t of inbound) side[isP(t.playerId) ? 'pitcher' : 'hitter']++;
  const byOvr = pool.filter(id => players[id]).sort((a, b) => (players[b].ovr || 0) - (players[a].ovr || 0));
  const add = (id) => { if (!id || has.has(id) || keep.length >= cap) return; keep.push(id); has.add(id); side[isP(id) ? 'pitcher' : 'hitter']++; };

  // 1. Every lineup position, best eligible first; a second catcher.
  for (const slot of ['C', 'SS', '2B', '3B', '1B', 'OF', 'OF', 'OF']) {
    const covered = keep.filter(id => !isP(id) && eligibleSlotsFor(players[id]).includes(slot)).length;
    const needHere = slot === 'OF' ? 3 : 1;
    if (covered >= needHere) continue;
    add(byOvr.find(id => !has.has(id) && !isP(id) && eligibleSlotsFor(players[id]).includes(slot)));
  }
  if (keep.filter(id => (players[id]?.nativePos || players[id]?.pos) === 'C').length < 2) {
    add(byOvr.find(id => !has.has(id) && (players[id].nativePos || players[id].pos) === 'C'));
  }
  // 2. Five starters plus the two spot starters on the pitcher bench
  //    (Section 20 composition: PITCHER_BENCH = 2 SP + 2 RP).
  while (keep.filter(id => players[id]?.pos === 'SP').length < ROSTER_LIMITS.STARTING_PITCHERS + 2) {
    const sp = byOvr.find(id => !has.has(id) && players[id].pos === 'SP');
    if (!sp || keep.length >= cap) break;
    add(sp);
  }
  // 3. Each side to its target, best first; then best available.
  for (const want of ['hitter', 'pitcher']) {
    const target = want === 'hitter' ? HITTER_TARGET : PITCHER_TARGET;
    for (const id of byOvr) {
      if (side[want] >= target || keep.length >= cap) break;
      if (!has.has(id) && (want === 'pitcher') === isP(id)) add(id);
    }
  }
  for (const id of byOvr) add(id);
  return keep.slice(0, cap);
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


