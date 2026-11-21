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
 * Removals (§122 — there is no farm):
 *   - A club drops a player through placeOnWaivers(); unclaimed after the
 *     window, he's a free agent (clearWaivers).
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
  ROSTER_DECISION_LEAD_MS,
  LINEUP_PLAN,
  POSITION_RULES,
} from '../data/constants.js';
import { isAvailable } from './PlayerFactory.js';
import { reliefValue } from './PitchingEngine.js';
import { payrollOf } from './FinanceEngine.js';
import { clockNow } from './Clock.js';
import { eligibleSlots, canPlay, startsAt, familiarity, pitchRoles, stretchOf, valueAt } from './Positions.js';   // r163 §122.35, r206 §122.84

// ─────────────────────────────────────────────────────────────
// POSITIONS: who can play where is engine/Positions.js (r163 §122.35)
// ─────────────────────────────────────────────────────────────

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
  return eligibleSlots(player);   // r163 §122.35 Positions: the one answer (an old label reads the same as before)
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
 * Removes player from his team's rosterIds,
 * adds to state.waiverPool, sets player.onWaivers = true.
 *
 * Valid for:
 *   - IL return decisions where GM chooses not to activate
 *   - Any mid-season cut outside spring training
 *   - Declined contract re-signs
 *   - Any player the GM no longer wants
 *
 * §122 his salary leaves the club's payroll at once (he's off its roster).
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {Object} mutations
 */
export function placeOnWaivers(state, playerId, { atMs = clockNow(), reason = null } = {}) {
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
        // §122 unclaimed after the window → a free agent.
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
 * Player clears waivers unclaimed: §122 he's a free agent — on the market,
 * from the club that let him go (there's no farm to outright him to).
 *
 * @param {Object} state
 * @param {String} playerId
 * @param {Number} [atMs]  when he cleared (stamps a free agent's _faSince)
 * @returns {Object} mutations
 */
export function clearWaivers(state, playerId, atMs = null) {
  _assertPlayerExists(state, playerId);
  const player = state.players[playerId];
  const owner  = player._waivedBy;
  const reset  = { onWaivers: false, waiverStartTime: null, _waivedBy: null, _waiveReason: null };
  const pool   = (state.waiverPool || []).filter(id => id !== playerId);
  return {
    players: {
      // A free agent like any other: on the market, from the club that let him go.
      [playerId]: { ...reset, group: 'freeAgent', tier: 'freeAgent', teamId: null,
                    _faFrom: owner || null, _faSince: atMs ?? player.waiverStartTime ?? null, _faReason: 'waivers' },
    },
    waiverPool:    pool,
    freeAgentPool: [...(state.freeAgentPool || []), playerId],
  };
}

// ─────────────────────────────────────────────────────────────
// FARM SYSTEM
// ─────────────────────────────────────────────────────────────

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
 * reserveGroup(player) — §114 where a player back from the IL waits: the
 * bench for a hitter, the pitcher bench for any pitcher. Nobody walks back
 * into the lineup, the rotation or the bullpen; the GM puts them there (the
 * staff asks — CardEngine), or the manager does when a spot is open.
 */
export function reserveGroup(player) {
  return ['SP', 'RP'].includes(player?.pos) ? PLAYER_GROUP.PITCHER_BENCH : PLAYER_GROUP.BENCH_HITTERS;
}

/**
 * pendingArrivals(state, teamId)
 * Players already on their way to this team's active roster (traded, signed
 * or claimed — reporting the next calendar day). They hold their roster spot:
 * every count of the active roster adds them, so nobody signs a second body
 * for the same spot.
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
 * The caller removes him from his old roster (or the pool he came from). Pure.
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
      // r153 everyone who reports to us lands on the bench (the pitcher bench
      // for any pitcher): the GM moves them in, or the manager fills an open
      // spot at the roster deadline (managerFillsNow). CPU clubs as before.
      toGroup:     teamId === 'user' ? reserveGroup(player) : defaultActiveGroup(player),
      reason,                       // 'trade' | 'signing' | 'waiver'
      by,                           // 'gm' | 'manager' | 'cpu'
      createdAt:   atMs,
      effectiveAt: nextCalendarDay(atMs),
      status:      'pending',
    },
    patch: {
      group:  PLAYER_GROUP.IN_TRANSIT,
      teamId,
      tier:   'active',
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
                  && p.group !== PLAYER_GROUP.IL);

  const issues = [];

  // Coverage per required hitter position = the number of healthy, active
  // hitters (starters AND bench all carry BENCH_HITTERS under the lineupSlots
  // model) whose nativePos can play that position. A clean body-count — no
  // "+1 if any lineup slot matches" collapse, no double counting.
  const healthyHitters = activePlayers.filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS);

  for (const pos of REQUIRED_STARTER_POSITIONS) {
    // (r163 §122.35 who can play there: Positions, the same answer as the lineup's — a pure DH no
    //  longer counts as 1B cover, and every hitter covers DH, as the DH slot takes anyone)
    const available  = healthyHitters.filter(p => canPlay(p, pos)).length;

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
 *      rotation is topped up from healthy PITCHER_BENCH starters, then (r221)
 *      from relievers who can start (pitchRoles has SP).
 *   4. Active-count invariant (GM domain, regular season and playoffs):
 *      active (non-IL) players + players already on their way (pending
 *      'arrival' transactions) == ACTIVE_TOTAL.
 *        CPU (autoManage): waives the lowest-OVR droppable surplus; a short
 *          roster is reported (`shortBy`, `openPositions`) and its GM signs
 *          free agents for it (§122, TransactionEngine — a signing applies a
 *          contract, so it isn't done here).
 *        USER: never auto-moves. Reports `pendingCallups` (the open spots)
 *          / `pendingSurplus`; TransactionEngine runs the decision deadline (§65).
 *      §122 spring too: there is no 38-man camp.
 *
 * @param {Object}  state
 * @param {String}  [teamId='user']
 * @param {Object}  [options]
 * @param {Boolean} [options.autoManage=false] — CPU teams pass true
 * @param {Number}  [options.atMs]             — roster-clock time (waivers)
 * @returns {Object} mutation: { players, userTeam|leagueTeams, waiverPool?,
 *                    transactions?, pendingCallups?, pendingSurplus?, surplusCount? }
 */
export function reconcileRoster(state, teamId = 'user', options = {}) {
  const autoManage = !!options.autoManage;
  const isUserTeam = !teamId || teamId === 'user';
  // r153 our open spots wait for the GM: a vacant lineup slot, rotation turn
  // or bullpen spot is filled by the manager only from the roster deadline
  // (an hour before first pitch) of the next game, or when `fill` is asked.
  const hold = isUserTeam && !options.fill
    && !managerFillsNow(state, Number.isFinite(options.atMs) ? options.atMs : clockNow());
  const team = isUserTeam
    ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return {};
  const tid = isUserTeam ? 'user' : teamId;

  const players   = state.players || {};
  const activeCap = ROSTER_LIMITS.ACTIVE_TOTAL;
  const atMs      = Number.isFinite(options.atMs) ? options.atMs : null;

  // ── Working copies (never mutate state) ───────────────────────────────
  let rosterIds = [...(team.rosterIds || [])];
  const patch   = {};                 // playerId -> partial player update
  const waived  = [];                 // playerIds moved to waivers this pass
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
    ...(canonical && existing[i].emergency ? { emergency: true } : {}),   // r153 kept while held
    ...(canonical && existing[i].oop ? { oop: true } : {}),               // r165 the GM's own out-of-position choice
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
  // §113 our starter who leaves the lineup hurt remembers the spot
  // (`_lostSlot`), so the staff can ask about putting him back when he's
  // healthy; it's forgotten once he's back in the lineup.
  const hurt = (id) => rosterIds.includes(id) && (players[id]?.isInjured || groupOf(id) === PLAYER_GROUP.IL);
  const seen = new Set();
  for (const s of slots) {
    const id = s.playerId;
    if (!id) continue;
    const ok = rosterIds.includes(id)
      && isHealthy(id)
      && groupOf(id) === PLAYER_GROUP.BENCH_HITTERS
      && !seen.has(id)
      && (eligibleSlotsFor(players[id]).includes(s.slot) || (hold && s.emergency)   // r153 held: the manager's out-of-position fill stays until the deadline
          || (isUserTeam && s.oop));   // r165 §122.35 the GM put him there out of position, on purpose: it stays
    if (ok) { seen.add(id); } else {
      if (isUserTeam && hurt(id) && !players[id]?._lostSlot) setPatch(id, { _lostSlot: { kind: 'lineup', slot: s.slot, atMs: options.atMs ?? null } });
      s.playerId = null;
      delete s.emergency;
      delete s.oop;
    }
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

  // (r206 §122.84 the best at that spot: the bat and the glove as the position weighs them)
  const bestAt = (pool, slotName) => pool.filter(p => eligibleSlotsFor(p).includes(slotName))
    .sort((a, b) => valueAt(b, slotName) - valueAt(a, slotName) || (b.ovr || 0) - (a.ovr || 0))[0];
  for (const slot of slots) {
    if (slot.playerId || hold) continue;
    const benchPick = bestAt(benchPool(), slot.slot);
    if (benchPick) { slot.playerId = benchPick.id; delete slot.emergency; }
  }
  // A CPU manager plays his best nine (§76): a clearly better healthy bat on
  // the bench — a waiver claim, a call-up, a player back from the IL — takes
  // the job; the man he replaces goes to the bench. (The user's lineup is the
  // GM's call.) The margin keeps a near-tie from churning the lineup daily.
  if (!isUserTeam) {
    for (const slot of slots) {
      if (!slot.playerId || slot.emergency) continue;
      const cur = players[slot.playerId];
      const best = bestAt(benchPool(), slot.slot);
      const better = best && valueAt(best, slot.slot) >= valueAt(cur, slot.slot) + CPU_LINEUP_UPGRADE_MARGIN ? best : null;
      if (better) slot.playerId = better.id;
    }
  }
  // Nobody eligible: the manager plays someone out of position.
  const openPositions = [];
  for (const slot of slots) {
    if (slot.playerId) continue;
    if (hold) { if (!benchPool().some(p => eligibleSlotsFor(p).includes(slot.slot))) openPositions.push(slot.slot); continue; }
    openPositions.push(slot.slot);
    const anyPick = [...benchPool()].sort((a, b) => valueAt(b, slot.slot) - valueAt(a, slot.slot))[0];   // (r206 who'd do least harm there)
    if (anyPick) { slot.playerId = anyPick.id; slot.emergency = true; }
  }
  // r196 §122.73 still a hole and nobody on the bench: a player sitting a game for rest plays after all
  // (rest is the club's choice; nine on the field isn't). In position first, then anywhere.
  if (!hold && slots.some(sl => !sl.playerId)) {
    const resting = () => rosterIds.map(id => players[id])
      .filter(p => p && p.unavailable?.reason === 'rest' && !(patch[p.id] && 'unavailable' in patch[p.id]) && !p.isInjured && !p.isSuspended && !p.onPersonalLeave
                && groupOf(p.id) === PLAYER_GROUP.BENCH_HITTERS && !seatedIds().has(p.id))
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
    for (const slot of slots) {
      if (slot.playerId) continue;
      const pick = resting().find(p => eligibleSlotsFor(p).includes(slot.slot)) || resting()[0];
      if (!pick) break;
      slot.playerId = pick.id;
      if (!eligibleSlotsFor(pick).includes(slot.slot)) slot.emergency = true;
      setPatch(pick.id, { unavailable: null });
    }
  }
  // The flag marks an out-of-position occupant only: cleared once the slot is empty or played in position.
  for (const slot of slots) if (slot.emergency && (!slot.playerId || eligibleSlotsFor(players[slot.playerId]).includes(slot.slot))) delete slot.emergency;
  // (r165 and the GM's mark, once the player is eligible there — ten starts — or the slot is empty)
  for (const slot of slots) if (slot.oop && (!slot.playerId || eligibleSlotsFor(players[slot.playerId]).includes(slot.slot))) delete slot.oop;

  // ── Rebuild rotation.order from healthy, rostered STARTING_PITCHERS ────
  const oldRotation = team.rotation || { order: [], currentIndex: 0 };
  const validSP = (id) => rosterIds.includes(id) && isHealthy(id)
    && groupOf(id) === PLAYER_GROUP.STARTING_PITCHERS;

  let order = [];
  const inOrder = new Set();
  for (const id of (oldRotation.order || [])) {
    if (validSP(id) && !inOrder.has(id)) { order.push(id); inOrder.add(id); }
    else if (isUserTeam && hurt(id) && !players[id]?._lostSlot) setPatch(id, { _lostSlot: { kind: 'rotation', atMs: options.atMs ?? null } });   // §113
  }
  // §112.6 five turns, no more: the rotation keeps its own order first; a new
  // starter (a signing, a trade, an extension) joins only a turn that's open,
  // best first, and any extra starter waits on the pitcher bench.
  const extraSP = rosterIds.filter(id => validSP(id) && !inOrder.has(id))
    .sort((a, b) => (players[b]?.ovr || 0) - (players[a]?.ovr || 0));
  for (const id of order.splice(REQUIRED_SP_COUNT)) { inOrder.delete(id); extraSP.push(id); }
  for (const id of extraSP) {
    if (order.length < REQUIRED_SP_COUNT) { order.push(id); inOrder.add(id); }
    else setPatch(id, { group: PLAYER_GROUP.PITCHER_BENCH });
  }
  while (!hold && order.length < REQUIRED_SP_COUNT) {
    const pbSP = rosterIds
      .map(id => players[id])
      .filter(p => p && isHealthy(p.id) && pitchRoles(p).includes('SP')   // r167 a starter by designation
                && groupOf(p.id) === PLAYER_GROUP.PITCHER_BENCH
                && !inOrder.has(p.id))
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    // r221 no starter on the pitcher bench: a reliever who can start (a swingman) takes the turn — a manager fields
    // five before leaving a turn open; the pen's spot is then filled like any other (or is open).
    const penSP = pbSP ? null : rosterIds
      .map(id => players[id])
      .filter(p => p && isHealthy(p.id) && pitchRoles(p).includes('SP') && groupOf(p.id) === PLAYER_GROUP.BULLPEN && !inOrder.has(p.id))
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    const pick = pbSP || penSP;
    if (!pick) break;
    setPatch(pick.id, { group: PLAYER_GROUP.STARTING_PITCHERS });
    order.push(pick.id);
    inOrder.add(pick.id);
  }
  // A CPU manager starts the best five (§104.2), as it plays the best nine: a
  // clearly better healthy starter on the pitcher bench — an ace back from
  // the IL (who returns to the bench), a call-up, a claim — takes the weakest
  // rotation turn, in that turn's place; the pitcher replaced goes to the bench.
  // Without this the spot starter who covered an injury kept the job for good.
  if (!isUserTeam) {
    for (;;) {
      const benchSP = rosterIds
        .map(id => players[id])
        .filter(p => p && p.pos === 'SP' && isHealthy(p.id)
                  && groupOf(p.id) === PLAYER_GROUP.PITCHER_BENCH && !inOrder.has(p.id))
        .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
      if (!benchSP || !order.length) break;
      const weakIdx = order.reduce((w, id, i) =>
        (players[id]?.ovr || 0) < (players[order[w]]?.ovr || 0) ? i : w, 0);
      const weakId = order[weakIdx];
      if ((benchSP.ovr || 0) < (players[weakId]?.ovr || 0) + CPU_ROTATION_UPGRADE_MARGIN) break;
      setPatch(weakId, { group: PLAYER_GROUP.PITCHER_BENCH });
      setPatch(benchSP.id, { group: PLAYER_GROUP.STARTING_PITCHERS });
      order[weakIdx] = benchSP.id;
      inOrder.delete(weakId);
      inOrder.add(benchSP.id);
    }
  }
  const rotationShort = Math.max(0, REQUIRED_SP_COUNT - order.length);
  // r174 the turn follows the pitcher who's next, not the number: with someone ahead of that pitcher
  // gone (hurt in the start just made, traded, sent down), the same index would skip a turn. The next
  // pitcher still in the order (in the old order's turn) is up; anyone new at the end waits a lap.
  const oldOrder = oldRotation.order || [];
  let currentIndex = order.length ? (oldRotation.currentIndex || 0) % order.length : 0;
  if (oldOrder.length && order.length) {
    const from = (oldRotation.currentIndex || 0) % oldOrder.length;
    for (let k = 0; k < oldOrder.length; k++) {
      const at = order.indexOf(oldOrder[(from + k) % oldOrder.length]);
      if (at >= 0) { currentIndex = at; break; }
    }
  }

  // ── §114 The bullpen: five arms, kept like the lineup ─────────────────
  // The BULLPEN group is the club's relief corps (the closer, the setup men,
  // the middle relievers — PitchingEngine.bullpenRoles); the pitcher bench
  // holds the reserves. A pen arm who gets hurt leaves the pen (ours
  // remembers it, `_lostSlot`); an open spot is filled by the best healthy
  // reliever on the pitcher bench (manager domain, every club — as a vacant
  // lineup slot is); a pen over five sends its weakest to the bench. A CPU
  // manager also keeps its best five (a clearly better bench reliever takes
  // the weakest spot), as it plays its best nine.
  const PEN = ROSTER_LIMITS.BULLPEN;
  const penIds = () => rosterIds.filter(id => groupOf(id) === PLAYER_GROUP.BULLPEN);
  for (const id of penIds()) {
    if (isHealthy(id)) continue;
    if (groupOf(id) === PLAYER_GROUP.IL) continue;
    if (isUserTeam && hurt(id) && !players[id]?._lostSlot) setPatch(id, { _lostSlot: { kind: 'bullpen', atMs: options.atMs ?? null } });
    setPatch(id, { group: PLAYER_GROUP.PITCHER_BENCH });
  }
  const benchRP = () => rosterIds.map(id => players[id])
    .filter(p => p && p.pos === 'RP' && isHealthy(p.id) && groupOf(p.id) === PLAYER_GROUP.PITCHER_BENCH)
    .sort((a, b) => reliefValue(b) - reliefValue(a));
  for (let pen = penIds().filter(isHealthy); !hold && pen.length < PEN; pen = penIds().filter(isHealthy)) {
    const up = benchRP()[0];
    if (!up) break;
    setPatch(up.id, { group: PLAYER_GROUP.BULLPEN });
  }
  {
    const pen = penIds().filter(isHealthy).map(id => players[id]).sort((a, b) => reliefValue(a) - reliefValue(b));
    while (pen.length > PEN) setPatch(pen.shift().id, { group: PLAYER_GROUP.PITCHER_BENCH });
  }
  if (!isUserTeam) {
    for (let guard = 0; guard < PEN; guard++) {
      const up = benchRP()[0];
      const weak = penIds().filter(isHealthy).map(id => players[id]).sort((a, b) => reliefValue(a) - reliefValue(b))[0];
      if (!up || !weak || reliefValue(up) < reliefValue(weak) + CPU_ROTATION_UPGRADE_MARGIN) break;
      setPatch(weak.id, { group: PLAYER_GROUP.PITCHER_BENCH });
      setPatch(up.id, { group: PLAYER_GROUP.BULLPEN });
    }
  }

  // ── Active-count invariant (GM domain; not in spring) ─────────────────
  let pendingSurplus = null;
  let pendingCallups = null;
  let surplusCount   = 0;

  let cpuShort = null;
  {
    let count = _nonILCount(rosterIds, groupOf) + inbound.length;

    if (autoManage) {
      // CPU GM: a short roster is filled from the free agents (§122) — by
      // TransactionEngine, which signs them; reported here as the need.
      if (count < activeCap || openPositions.length || rotationShort) {
        cpuShort = { count: Math.max(0, activeCap - count), positions: [...openPositions], rotationShort };
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
            waiverStartTime: atMs ?? clockNow(), _pendingILReturn: false, teamId: null,
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

  // §113 back in the lineup or the rotation (or no longer ours): the lost
  // spot is forgotten.
  if (isUserTeam) {
    const working = new Set([...slots.map(sl => sl.playerId).filter(Boolean), ...order, ...penIds()]);
    for (const id of new Set([...(team.rosterIds || []), ...rosterIds])) {
      if (players[id]?._lostSlot && (working.has(id) || !rosterIds.includes(id))) setPatch(id, { _lostSlot: null });
    }
  }

  // ── Assemble the mutation object ──────────────────────────────────────
  const teamPatch = {
    rosterIds,
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
  if (pendingCallups) mutation.pendingCallups = pendingCallups;
  if (cpuShort) mutation.cpuShort = cpuShort;
  if (pendingSurplus && pendingSurplus.length) {
    mutation.pendingSurplus = pendingSurplus;
    mutation.surplusCount   = surplusCount;
  }
  return mutation;
}

// Active-roster composition targets (Section 20 — LOCKED): 14 hitters
// (9 starters + 5 bench) and 14 pitchers (5 SP + 5 RP + 4 bench).
// A CPU manager benches a starter for a bat at least this much better (OVR).
const CPU_LINEUP_UPGRADE_MARGIN = 3;
// …and swaps a rotation turn for a starter at least this much better.
const CPU_ROTATION_UPGRADE_MARGIN = 3;
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
// ─────────────────────────────────────────────────────────────
// r153 OUR OPEN SPOTS WAIT FOR THE GM; THE TEAM SCREEN'S MOVES
// ─────────────────────────────────────────────────────────────

/** Our next game not yet committed (the one the roster deadline belongs to). */
function _nextOpenGame(state) {
  const sched = state?.schedule || [];
  for (let i = state?.currentGameIndex || 0; i < sched.length; i++) {
    const g = sched[i];
    // r239 §122.118 a game under way already has its lineups (liveLineups, taken at first pitch): a move now is
    // for the game after it, so that's the one whose deadline counts.
    if (g && !g._committed && !g.liveLineups && Number.isFinite(g.gameTime)) return g;
  }
  return null;
}

/** r239 §122.118 the game our open spots are for: the next one whose lineup isn't set yet (null with none ahead). */
export function nextLineupGame(state) { return _nextOpenGame(state); }

// ─────────────────────────────────────────────────────────────
// r240 §122.119 LINEUPS SET AHEAD (hitters only)
//   The next game's lineup is userTeam.lineupSlots (as ever: everything that reads or changes "the lineup"
//   still does). A later game the GM set on its own carries it on the schedule entry (`lineupPlan`, the nine
//   slots), so it moves with the game; a game without one takes the lineup of the game before it. At first
//   pitch the next game takes lineupSlots, and the game after it becomes the next one: its own lineup, if
//   it has one, becomes lineupSlots (promoteLineup).
// ─────────────────────────────────────────────────────────────

const _copySlots = (slots) => (slots || []).map(sl => ({ ...sl }));
const _startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * lineupGames(state, days, atMs) — our games whose lineups can be set now, in playing order: the next game,
 * then each after it that starts before the end of the `days`th day counting today. (A doubleheader is two.)
 */
export function lineupGames(state, days = LINEUP_PLAN.days, atMs = clockNow()) {
  const next = _nextOpenGame(state);
  if (!next) return [];
  const until = _startOfDay(atMs) + Math.max(1, days) * 86_400_000;
  const sched = state.schedule || [];
  const out = [next];
  for (let i = sched.indexOf(next) + 1; i < sched.length; i++) {
    const g = sched[i];
    if (!g || g._committed || g.liveLineups || !Number.isFinite(g.gameTime)) continue;
    if (g.gameTime >= until) break;
    out.push(g);
  }
  return out;
}

/**
 * lineupFor(state, game) — the lineup a game will start with as things stand: the next game's is
 * lineupSlots; a later one's is its own, else the one before it carried forward. A copy (null for a game
 * that already has its lineup, or isn't ahead of us).
 */
export function lineupFor(state, game) {
  const next = _nextOpenGame(state);
  if (!next || !game) return null;
  const sched = state.schedule || [];
  const from = sched.indexOf(next), to = sched.indexOf(game);
  if (from < 0 || to < from) return null;
  let cur = state.userTeam?.lineupSlots || [];
  for (let i = from + 1; i <= to; i++) {
    const g = sched[i];
    if (!g || g._committed || g.liveLineups) continue;
    if (g.lineupPlan) cur = g.lineupPlan;
  }
  return _copySlots(cur);
}

/** Whether the GM set this game's lineup on its own (the next game's is always lineupSlots: false). */
export function hasOwnLineup(state, game) {
  return !!game?.lineupPlan && game !== _nextOpenGame(state);
}

/**
 * setLineupFor(draft, game, slots) — the GM sets a game's lineup: the next game's is lineupSlots; a later
 * game's becomes its own (`lineupPlan`). Pass null to clear a later game's own lineup (it takes the one
 * before it again). Returns false for a game whose lineup can't be set.
 */
export function setLineupFor(draft, game, slots) {
  const next = _nextOpenGame(draft);
  if (!next || !game || game._committed || game.liveLineups) return false;
  if (game === next) {
    if (!slots) return false;
    draft.userTeam.lineupSlots = _copySlots(slots);
    return true;
  }
  // r241 a spot the GM leaves open in a later game's lineup is the GM's choice (`gmOpen`): no message about it
  if (slots) game.lineupPlan = _copySlots(slots).map(sl => (sl.playerId ? (delete sl.gmOpen, sl) : { ...sl, gmOpen: true }));
  else delete game.lineupPlan;
  return true;
}

/**
 * r241 §122.120 availableFor(state, p, game) — whether one of our hitters can play in that game, as things
 * stand: on our roster and not traded away (a deal that goes through after tonight's final), not on the IL,
 * back from a day-to-day by first pitch, past a suspension (_suspendedUntilGame, a schedule index) and any
 * games away (unavailable: a count of our games, or a date), not on personal leave or still being looked at.
 */
export function availableFor(state, p, game) {
  const u = state.userTeam;
  if (!p || !game || p.teamId !== 'user' || !(u?.rosterIds || []).includes(p.id) || p.group === PLAYER_GROUP.IL) return false;
  if (game !== _nextOpenGame(state) && tradedAway(state, p.id)) return false;
  if (p.onPersonalLeave) return false;
  if (p.isInjured || p.injury) {
    const inj = p.injury;
    if (!(inj?.status === 'dtd' && Number.isFinite(inj.returnAt) && inj.returnAt <= game.gameTime)) return false;
  }
  if (p.isSuspended && !(Number.isFinite(p._suspendedUntilGame) && (game.index ?? -1) >= p._suspendedUntilGame)) return false;
  const un = p.unavailable;
  if (un) {
    if (Number.isFinite(un.untilMs) && un.untilMs > game.gameTime) return false;
    if (Number.isFinite(un.gamesLeft) && un.gamesLeft > 0) {
      const sched = state.schedule || [], from = sched.indexOf(_nextOpenGame(state)), to = sched.indexOf(game);
      let k = 0;
      for (let i = from; i >= 0 && i < to; i++) if (sched[i] && !sched[i]._committed && Number.isFinite(sched[i].gameTime)) k++;
      if (k < un.gamesLeft) return false;
    }
  }
  return true;
}

/**
 * r241 §122.120 sweepLineupPlans(draft) — a roster change reaches the lineups set ahead: in each later game's
 * own lineup, a player who can't play in that game leaves the slot open (only that slot, only that game;
 * a game carrying it forward follows). Returns what it opened: [{ gameTime, slot, playerId }].
 */
export function sweepLineupPlans(draft) {
  const next = _nextOpenGame(draft);
  const out = [];
  if (!next) return out;
  for (const g of draft.schedule || []) {
    if (!g.lineupPlan) continue;
    if (g._committed || g.liveLineups) { delete g.lineupPlan; continue; }
    if (g === next) continue;   // (promoteLineup's)
    g.lineupPlan.forEach(sl => {
      if (sl.playerId && !availableFor(draft, draft.players?.[sl.playerId], g)) {
        out.push({ gameTime: g.gameTime, slot: sl.slot, playerId: sl.playerId });
        sl.playerId = null; delete sl.gmOpen; delete sl.emergency; delete sl.oop;
      }
    });
  }
  return out;
}

/**
 * r241 §122.120 laterOpenSpots(state) — open spots in the lineups set ahead: each later game whose lineup
 * comes from a game the GM set (its own, or carried from one), with a slot open that the GM didn't leave
 * open. (A game carrying the next game's lineup is the next game's business: the deadline fills it.)
 * → [{ gameTime, slot }] in playing order.
 */
export function laterOpenSpots(state) {
  const next = _nextOpenGame(state);
  if (!next) return [];
  const sched = state.schedule || [];
  const out = [];
  let src = null;
  for (let i = sched.indexOf(next) + 1; i < sched.length; i++) {
    const g = sched[i];
    if (!g || g._committed || g.liveLineups || !Number.isFinite(g.gameTime)) continue;
    if (g.lineupPlan) src = g.lineupPlan;
    if (!src) continue;
    for (const sl of src) if (!sl.playerId && !sl.gmOpen) out.push({ gameTime: g.gameTime, slot: sl.slot });
  }
  return out;
}

/**
 * r241 §122.120 fillLineupsAhead(draft) — the manager fills the open spots in the lineups set ahead now (the
 * GM said so): each with the best bat on the bench who can play there and in that game. A spot nobody fits
 * stays open for that game's deadline. Returns the moves: [{ gameTime, slot, playerId }].
 */
export function fillLineupsAhead(draft) {
  const next = _nextOpenGame(draft);
  const players = draft.players || {}, u = draft.userTeam;
  const out = [];
  if (!next) return out;
  const bats = (u.rosterIds || []).map(id => players[id]).filter(p => p && !['SP', 'RP'].includes(p.pos));
  for (const g of draft.schedule || []) {
    if (!g.lineupPlan || g === next || g._committed || g.liveLineups) continue;
    const inIt = new Set(g.lineupPlan.map(sl => sl.playerId).filter(Boolean));
    for (const sl of g.lineupPlan) {
      if (sl.playerId || sl.gmOpen) continue;
      const pick = bats.filter(p => !inIt.has(p.id) && availableFor(draft, p, g) && (sl.slot === 'DH' || eligibleSlotsFor(p).includes(sl.slot)))
        .sort((a, b) => b.ovr - a.ovr)[0];
      if (!pick) continue;
      sl.playerId = pick.id; inIt.add(pick.id);
      out.push({ gameTime: g.gameTime, slot: sl.slot, playerId: pick.id });
    }
  }
  return out;
}

/**
 * promoteLineup(draft) — when a game takes its lineup (first pitch): the game after it is the next one now;
 * its own lineup, if it set one, becomes lineupSlots. A player there who can't play now (gone, hurt,
 * suspended, traded) leaves the slot open: the roster rules take it from there. Lineups left on games
 * already played or under way go.
 */
export function promoteLineup(draft) {
  for (const g of draft.schedule || []) if (g.lineupPlan && (g._committed || g.liveLineups)) delete g.lineupPlan;
  const next = _nextOpenGame(draft);
  if (!next?.lineupPlan) return false;
  const u = draft.userTeam, players = draft.players || {};
  const seen = new Set();
  u.lineupSlots = next.lineupPlan.map(sl => {
    const p = players[sl.playerId];
    const ok = p && availableFor(draft, p, next) && isAvailable(p) && !seen.has(p.id);
    if (ok) seen.add(p.id);
    const { gmOpen, ...rest } = sl;   // (the next game's spots: the deadline's rules now)
    return ok ? rest : { slot: sl.slot, playerId: null };
  });
  delete next.lineupPlan;
  return true;
}

/**
 * managerFillsNow(state, atMs) — r153 the manager fills our open spots (a
 * lineup slot, a rotation turn, a bullpen spot) only from the next game's
 * roster deadline (ROSTER_DECISION_LEAD_MS before first pitch) until it is
 * played. Before that an open spot waits for the GM. No game ahead: it waits.
 */
export function managerFillsNow(state, atMs) {
  const at = managerFillAt(state);
  return Number.isFinite(at) && atMs >= at;
}

/**
 * When the manager will fill our open spots: the next game's roster deadline (null with no game ahead).
 * r239 §122.118 a spot the GM opens after the deadline (fillHeldFor, set by the GM's own move) is the GM's
 * choice: it stays open until first pitch, when the game needs nine (before, the manager filled it at once,
 * often with the player just moved out).
 */
export function managerFillAt(state) {
  const g = _nextOpenGame(state);
  if (!g) return null;
  return state.userTeam?.fillHeldFor === g.gameTime ? g.gameTime : g.gameTime - ROSTER_DECISION_LEAD_MS;
}

/**
 * openSpots(state) — r153 our open spots that someone on our roster could
 * fill now: lineup slots (with an eligible healthy bat on the bench, or any
 * bat when nobody fits — the manager would play one out of position), an
 * out-of-position fill an eligible bench bat could take, rotation turns (a
 * healthy starter on the pitcher bench, or a reliever who can start) and bullpen spots (a healthy
 * reliever on the pitcher bench).
 * @returns {{ lineup: Object[], rotation: Number, bullpen: Number, any: Boolean }}
 */
export function openSpots(state) {
  const u = state.userTeam, players = state.players || {};
  const ids = (u?.rosterIds || []);
  const slots = u?.lineupSlots || [];
  const seated = new Set(slots.map(sl => sl.playerId).filter(Boolean));
  const bench = ids.map(id => players[id]).filter(p => p && isAvailable(p) && p.group === PLAYER_GROUP.BENCH_HITTERS && !seated.has(p.id));
  const lineup = [];
  slots.forEach((sl, i) => {
    const fits = bench.filter(p => eligibleSlotsFor(p).includes(sl.slot));
    if (!sl.playerId && bench.length) lineup.push({ index: i, slot: sl.slot, fits: fits.length > 0 });
    else if (sl.playerId && sl.emergency && fits.length) lineup.push({ index: i, slot: sl.slot, fits: true, emergency: true });
  });
  const inGroup = (g, pos) => ids.map(id => players[id]).filter(p => p && isAvailable(p) && p.group === g && (!pos || p.pos === pos));
  const order = (u?.rotation?.order || []).filter(id => players[id] && isAvailable(players[id]));
  // (r221 a turn someone could take: a starter on the pitcher bench, or a reliever who can start — as the manager fills it)
  const canStart = ids.map(id => players[id]).filter(p => p && isAvailable(p) && pitchRoles(p).includes('SP') && !order.includes(p.id)
    && [PLAYER_GROUP.PITCHER_BENCH, PLAYER_GROUP.BULLPEN].includes(p.group));
  const rotation = Math.min(Math.max(0, REQUIRED_SP_COUNT - order.length), canStart.length);
  const bullpen = Math.min(Math.max(0, ROSTER_LIMITS.BULLPEN - inGroup(PLAYER_GROUP.BULLPEN).length), inGroup(PLAYER_GROUP.PITCHER_BENCH, 'RP').length);
  return { lineup, rotation, bullpen, any: lineup.length > 0 || rotation > 0 || bullpen > 0 };
}

/** Lineup slots nobody on our bench can play (empty or held out of position): a signing's position hint. */
export function uncoveredSlots(state, team) {
  const players = state.players || {};
  const slots = team?.lineupSlots || [];
  const seated = new Set(slots.map(sl => sl.playerId).filter(Boolean));
  const bench = (team?.rosterIds || []).map(id => players[id])
    .filter(p => p && isAvailable(p) && p.group === PLAYER_GROUP.BENCH_HITTERS && !seated.has(p.id));
  return slots.filter(sl => (!sl.playerId || sl.emergency) && !bench.some(p => eligibleSlotsFor(p).includes(sl.slot))).map(sl => sl.slot);
}

/** The roster clock's probe: it is the manager's time and an open spot can be filled. */
export function managerFillDue(state, atMs) {
  return managerFillsNow(state, atMs) && openSpots(state).any;
}

/** A player in our trade that goes through after tonight's final out (§90): still ours, already traded. */
export function tradedAway(state, playerId) {
  return (state.transactions || []).some(t => t.status === 'pending' && t.kind === 'trade' && (t.teamId || 'user') === 'user'
    && (t.offer?.outgoingIds || []).includes(playerId));
}

/**
 * moveOptions(state, playerId) — r153 where one of our players can go from the
 * Team screen's MOVE. Each option: { key, label, detail }. Empty when the
 * player can't move (hurt, suspended, not on our active roster, traded).
 *   A bat: each lineup slot they can play (whoever is there swaps into their
 *     old slot when they can play it, else goes to the bench); from the
 *     lineup, the bench — with a bench bat who can take the slot, or open.
 *   A starter: each rotation turn (that starter to the pitcher bench), or an
 *     open turn; from the rotation, the pitcher bench — with a starter there
 *     taking the turn, or open. A reliever likewise with the bullpen.
 * An open spot waits for the GM until the roster deadline (managerFillsNow).
 */
export function moveOptions(state, playerId) {
  const u = state.userTeam, players = state.players || {};
  const me = players[playerId];
  if (!me || !(u.rosterIds || []).includes(playerId) || !isAvailable(me) || me.group === PLAYER_GROUP.IL || tradedAway(state, playerId)) return [];
  const ids = u.rosterIds || [];
  const ok = (p) => p && isAvailable(p) && !tradedAway(state, p.id);
  const ovr = (p) => `OVR ${p.ovr}`;
  const out = [];
  if (!['SP', 'RP'].includes(me.pos)) {
    if (me.group !== PLAYER_GROUP.BENCH_HITTERS) return [];
    const slots = u.lineupSlots || [];
    const at = slots.findIndex(sl => sl.playerId === playerId);
    const mine = eligibleSlotsFor(me);
    slots.forEach((sl, j) => {
      if (j === at || !mine.includes(sl.slot)) return;
      const occ = sl.playerId ? players[sl.playerId] : null;
      if (occ && !ok(occ)) return;
      const detail = !occ ? 'Open'
        : at >= 0 && eligibleSlotsFor(occ).includes(slots[at].slot) ? `${occ.name} (${ovr(occ)}) moves to ${slots[at].slot}`
        : `${occ.name} (${ovr(occ)}) to the bench`;
      out.push({ key: `slot:${j}`, label: sl.slot, detail });
    });
    // r165 §122.35 out of position: every fielding slot he isn't eligible at (the GM's choice — it stays),
    // with how familiar he is there; listed after the eligible ones.
    slots.forEach((sl, j) => {
      if (j === at || sl.slot === 'DH' || mine.includes(sl.slot)) return;
      const occ = sl.playerId ? players[sl.playerId] : null;
      if (occ && !ok(occ)) return;
      const n = startsAt(me, sl.slot), fam = familiarity(me, sl.slot) > 0;
      const how = `${fam ? 'practiced' : 'unfamiliar'}${n ? `, ${n} of ${POSITION_RULES.gainStarts}` : ''}`;
      const detail = !occ ? `Open — ${how}`
        : at >= 0 && eligibleSlotsFor(occ).includes(slots[at].slot) ? `${how}; ${occ.name} (${ovr(occ)}) moves to ${slots[at].slot}`
        : `${how}; ${occ.name} (${ovr(occ)}) to the bench`;
      out.push({ key: `oop:${j}`, label: sl.slot, detail, oop: true });
    });
    if (at >= 0) {
      const seated = new Set(slots.map(sl => sl.playerId).filter(Boolean));
      ids.map(id => players[id]).filter(p => ok(p) && p.group === PLAYER_GROUP.BENCH_HITTERS && !seated.has(p.id)
        && eligibleSlotsFor(p).includes(slots[at].slot)).sort((a, b) => b.ovr - a.ovr)
        .forEach(p => out.push({ key: `in:${p.id}`, label: 'Bench', detail: `${p.name} (${ovr(p)}) takes ${slots[at].slot}` }));
      out.push({ key: 'bench', label: 'Bench', detail: `Leave ${slots[at].slot} open` });
    }
    return out;
  }
  // r167 §122.35 a pitcher can go to the rotation or the bullpen either way: the role he doesn't hold
  // is out of role (`oop`), listed after the rest.
  const roles = pitchRoles(me);
  const order = u.rotation?.order || [];
  const inRot = order.includes(playerId), inPen = me.group === PLAYER_GROUP.BULLPEN;
  if (!inRot && !inPen && me.group !== PLAYER_GROUP.PITCHER_BENCH) return [];
  const tag = (role) => (roles.includes(role) ? {} : { oop: true });
  const how = (role) => (roles.includes(role) ? '' : role === 'SP' ? `${stretchWords(me)}; ` : 'a starter in relief; ');
  if (!inRot) {
    order.forEach((id, k) => {
      const occ = players[id];
      if (ok(occ)) out.push({ key: `turn:${k}`, label: 'Rotation', detail: `${how('SP')}${occ.name} (${ovr(occ)}) to the pitcher bench`, ...tag('SP') });
    });
    if (order.length < REQUIRED_SP_COUNT) out.push({ key: 'turn:new', label: 'Rotation', detail: `${how('SP')}Open`.replace('; Open', ' — open'), ...tag('SP') });
  }
  if (!inPen) {
    const pen = ids.map(id => players[id]).filter(p => p && p.group === PLAYER_GROUP.BULLPEN);
    pen.filter(ok).sort((a, b) => reliefValue(b) - reliefValue(a))
      .forEach(p => out.push({ key: `pen:${p.id}`, label: 'Bullpen', detail: `${how('RP')}${p.name} (${ovr(p)}) to the pitcher bench`, ...tag('RP') }));
    if (pen.length < ROSTER_LIMITS.BULLPEN) out.push({ key: 'pen:new', label: 'Bullpen', detail: `${how('RP')}Open`.replace('; Open', ' — open'), ...tag('RP') });
  }
  if (inRot || inPen) {
    const label = inRot ? 'their spot in the rotation' : 'their bullpen spot';
    const want = inRot ? 'SP' : 'RP';
    ids.map(id => players[id]).filter(p => ok(p) && p.group === PLAYER_GROUP.PITCHER_BENCH && pitchRoles(p).includes(want))
      .sort((a, b) => b.ovr - a.ovr)
      .forEach(p => out.push({ key: `in:${p.id}`, label: 'Pitcher bench', detail: `${p.name} (${ovr(p)}) takes ${label}` }));
    out.push({ key: 'bench', label: 'Pitcher bench', detail: inRot ? `Leave ${label} open` : 'Leave a spot in the bullpen open' });
  }
  // the roles he holds first
  return [...out.filter(o => !o.oop), ...out.filter(o => o.oop)];
}

/** r167 a reliever's length, in words, for MOVE. */
function stretchWords(p) {
  const n = stretchOf(p);
  return n >= 3 ? 'stretched out' : n === 0 ? 'not stretched out: a short start' : `stretched out ${n} of 3`;
}

/**
 * applyMove(draft, playerId, key) — r153 carries out one of moveOptions on a
 * draft (the caller reconciles after, at the move's moment). Returns false
 * when the option no longer exists.
 */
export function applyMove(draft, playerId, key) {
  if (!moveOptions(draft, playerId).some(o => o.key === key)) return false;
  const u = draft.userTeam, players = draft.players;
  const me = players[playerId];
  const [kind, arg] = key.split(':');
  if (!['SP', 'RP'].includes(me.pos)) {
    const slots = u.lineupSlots;
    const at = slots.findIndex(sl => sl.playerId === playerId);
    const seat = (i, id) => { slots[i].playerId = id; delete slots[i].emergency; delete slots[i].oop; };
    if (kind === 'slot' || kind === 'oop') {
      const j = Number(arg), occId = slots[j].playerId;
      seat(j, playerId);
      if (kind === 'oop') slots[j].oop = true;   // r165 the GM's out-of-position choice: it stays
      if (at >= 0) seat(at, occId && eligibleSlotsFor(players[occId]).includes(slots[at].slot) ? occId : null);
    } else if (kind === 'in') seat(at, arg);
    else if (kind === 'bench') seat(at, null);
    return true;
  }
  const rot = u.rotation || (u.rotation = { order: [], currentIndex: 0 });
  const order = rot.order || (rot.order = []);
  const toBench = (id) => { if (players[id]) players[id].group = PLAYER_GROUP.PITCHER_BENCH; };
  // The rotation keeps its place: the next starter up stays the next starter.
  const nextId = order.length ? order[(rot.currentIndex || 0) % order.length] : null;
  const reindex = () => { const n = order.indexOf(nextId); rot.currentIndex = n >= 0 ? n : (order.length ? (rot.currentIndex || 0) % order.length : 0); };
  const leaveRotation = () => { const k = order.indexOf(playerId); if (k >= 0) order.splice(k, 1); };
  // r167 §122.35 by where he's going, whatever his role
  if (kind === 'turn') {
    leaveRotation();
    me.group = PLAYER_GROUP.STARTING_PITCHERS;
    if (arg === 'new') order.push(playerId);
    else {
      const k = Number(arg), occ = order[k];
      toBench(occ);
      order[k] = playerId;
      if (occ === nextId) { rot.currentIndex = k; return true; }
    }
    reindex();
    return true;
  }
  if (kind === 'pen') {
    leaveRotation();
    if (arg !== 'new') toBench(arg);
    me.group = PLAYER_GROUP.BULLPEN;
    reindex();
    return true;
  }
  if (kind === 'in') {
    const k = order.indexOf(playerId);
    if (k >= 0) {
      players[arg].group = PLAYER_GROUP.STARTING_PITCHERS; toBench(playerId);
      order[k] = arg;
      if (playerId === nextId) { rot.currentIndex = k; return true; }
      reindex();
    } else { players[arg].group = PLAYER_GROUP.BULLPEN; toBench(playerId); }
    return true;
  }
  if (kind === 'bench') { leaveRotation(); toBench(playerId); reindex(); }
  return true;
}

/**
 * settleRoster(draft, teamId, options) — §112.6 reconcile until the roster
 * stops changing (at most three passes), applying each pass to the draft.
 * Without a clock, reconcileRoster calls players up directly — after it has
 * already set the lineup and rotation from the roster it started with — so a
 * club rebuilt between seasons needs a second pass to put them to work.
 */
export function settleRoster(draft, teamId = 'user', options = {}) {
  const team = () => (teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === teamId));
  const sig = () => { const t = team(); return JSON.stringify([t?.rosterIds, (t?.lineupSlots || []).map(sl => sl.playerId), t?.rotation?.order]); };
  for (let pass = 0; pass < 3; pass++) {
    const before = sig();
    applyRosterMutation(draft, reconcileRoster(draft, teamId, options));
    if (sig() === before) break;
  }
  return team();
}

export function applyRosterMutation(state, mutation) {
  if (!mutation) return;
  for (const [key, value] of Object.entries(mutation)) {
    if (key === 'pendingSurplus' || key === 'surplusCount' || key === 'pendingCallups' || key === 'cpuShort') continue;
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
  // §76: a club over 28 sheds from the side that's over its share (14 hitters,
  // 14 pitchers) — a bat arriving in a trade costs a bat, not a reliever.
  const isP = (p) => ['SP', 'RP'].includes(p?.pos);
  const active = rosterIds.filter(id => groupOf(id) !== PLAYER_GROUP.IL).map(id => players[id]).filter(Boolean);
  const over = {
    hitter:  active.filter(p => !isP(p)).length - HITTER_TARGET,
    pitcher: active.filter(p =>  isP(p)).length - PITCHER_TARGET,
  };
  const overSide = (p) => (over[isP(p) ? 'pitcher' : 'hitter'] > 0 ? 1 : 0);
  return rosterIds
    .filter(id => groupOf(id) !== PLAYER_GROUP.IL && isHealthy(id) && !locked.has(id))
    .map(id => players[id])
    .filter(Boolean)
    .sort((a, b) => overSide(b) - overSide(a) || (a.ovr || 0) - (b.ovr || 0))
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

// ─────────────────────────────────────────────────────────────
// PAYROLL COMPUTATION
// ─────────────────────────────────────────────────────────────

/**
 * computePayroll(state)
 * The user's annual payroll (§78: FinanceEngine.payrollOf).
 * Called whenever a roster change affects salaries.
 * Returns the payroll value — caller applies via StateManager.
 *
 * @param {Object} state
 * @returns {Number} payroll in $K (same unit as contractSalary)
 */
export function computePayroll(state) {
  // §122 everyone on the roster, active or IL (FinanceEngine.payrollOf is the one definition).
  return payrollOf(state, 'user');
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

function _removeFromTeamRoster(state, playerId, teamId) {
  if (!teamId || teamId === 'user') {
    return {
      userTeam: {
        rosterIds: state.userTeam.rosterIds.filter(id => id !== playerId),
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

function _mergeMutations(a, b) {
  return {
    ...a,
    ...b,
    players: { ...(a.players || {}), ...(b.players || {}) },
  };
}




// ─────────────────────────────────────────────────────────────
// §95 THE CLUB'S RATING, AND ITS HISTORY
// ─────────────────────────────────────────────────────────────

/**
 * teamRating(state, teamId) — the Rating on the dashboard: the average OVR of
 * the club's healthy active roster (injured players and the IL left out).
 * The one definition; the dashboard, cards and the history all read it.
 */
export function teamRating(state, teamId = 'user') {
  const team = teamId === 'user' ? state?.userTeam : (state?.leagueTeams || []).find(t => t.id === teamId);
  const active = (team?.rosterIds || []).map(id => state.players?.[id])
    .filter(p => p && !p.isInjured && p.group !== PLAYER_GROUP.IL);
  if (!active.length) return 0;
  return Math.round(active.reduce((a, p) => a + (p.ovr || 0), 0) / active.length);
}

/**
 * recordRating(draft, atMs) — add a point to `ratingHistory` ({ t, r, s }:
 * the moment, the rating, the season) when the rating has changed, or a new
 * season has started. Kept for the life of the franchise. Mutates draft.
 */
export function recordRating(draft, atMs) {
  const r = teamRating(draft, 'user');
  if (!r) return;
  const s = draft.seasonNum || 1;
  const h = draft.ratingHistory || (draft.ratingHistory = []);
  const last = h[h.length - 1];
  if (last && last.r === r && last.s === s) return;
  if (last && atMs < last.t) atMs = last.t;   // never out of order
  h.push({ t: atMs, r, s });
}
