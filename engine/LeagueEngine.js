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
  WAIVER_CLAIM_MIN_UPGRADE,
} from '../data/constants.js';

import {
  buildActivityFeedEntry,
  pruneActivityFeed,
  computeFullStandings as _computeStandingsBase,
} from './SeasonEngine.js';

import {
  placeOnWaivers,
  reconcileRoster,
} from './RosterEngine.js';

import { computeOVR } from './PlayerFactory.js';

// ─────────────────────────────────────────────────────────────
// CPU GAME SIMULATION
// ─────────────────────────────────────────────────────────────

/**
 * processCPURosterDecisions(state, dateStr, atMs)
 * Every CPU GM's end-of-day roster pass: restore lineup + rotation integrity
 * and hold the active roster at a legal 28 (players already on their way
 * count). Call-ups go through the transaction ledger and report the next
 * calendar day; IL clearances and day-to-day returns run on the roster
 * clock (TransactionEngine.applyDue, §65) — the same rules as the user.
 *
 * @param {Object} state
 * @param {String} dateStr
 * @param {Number} atMs   — roster-clock time of the end of the game day
 * @returns {Object} mutations
 */
export function processCPURosterDecisions(state, dateStr, atMs) {
  let leagueTeams  = [...state.leagueTeams];
  let waiverPool   = [...(state.waiverPool || [])];
  let transactions = [...(state.transactions || [])];
  const players    = {};

  for (const team of state.leagueTeams) {
    const patchedPlayers = { ...state.players };
    for (const [id, upd] of Object.entries(players)) {
      patchedPlayers[id] = { ...patchedPlayers[id], ...upd };
    }
    const patched = { ...state, players: patchedPlayers, leagueTeams, waiverPool, transactions };
    const rec = reconcileRoster(patched, team.id, { autoManage: true, atMs });
    for (const [id, upd] of Object.entries(rec.players || {})) players[id] = { ...(players[id] || {}), ...upd };
    if (rec.leagueTeams)  leagueTeams  = rec.leagueTeams;
    if (rec.waiverPool)   waiverPool   = rec.waiverPool;
    if (rec.transactions) transactions = rec.transactions;
  }

  return { players, leagueTeams, waiverPool, transactions };
}

// ─────────────────────────────────────────────────────────────
// WAIVER PROCESSING
// ─────────────────────────────────────────────────────────────

/**
 * cpuWaiverClaimant(state, playerId)
 * Section 20.2 (LOCKED): CPU clubs claim only what they need — a real upgrade
 * over the weakest active player at his position — and the highest-priority
 * club (worst record first) wins. The placing team cannot reclaim him.
 * Returns the claiming team id, or null if he goes unclaimed. Pure.
 *
 * @param {Object} state
 * @param {String} playerId
 * @returns {String|null}
 */
export function cpuWaiverClaimant(state, playerId) {
  const player = state.players[playerId];
  if (!player) return null;
  const standings = _computeStandingsBase(state.leagueTeams, {
    name:       state.userTeam?.city + ' ' + state.userTeam?.nickname,
    abbr:       state.userTeam?.abbr,
    divisionId: 'A',
    wins:       state.userTeam?.wins   || 0,
    losses:     state.userTeam?.losses || 0,
  });
  for (const entry of [...standings.all].reverse()) {
    if (entry.id === 'user' || entry.id === player._waivedBy) continue;
    const team = state.leagueTeams.find(t => t.id === entry.id);
    if (team && _isUpgradeFor(team, player, state.players)) return team.id;
  }
  return null;
}

/** Would this player be a real upgrade over the weakest active player he'd replace? */
function _isUpgradeFor(team, player, players) {
  const isP = ['SP', 'RP'].includes(player.pos);
  const peers = (team.rosterIds || []).map(id => players[id]).filter(p =>
    p && p.group !== PLAYER_GROUP.IL && !p.isInjured
    && (isP ? p.pos === player.pos
            : !['SP', 'RP'].includes(p.pos) && (p.nativePos || p.pos) === (player.nativePos || player.pos)));
  if (!peers.length) return !isP || player.pos === 'SP';   // a hole at his position
  const weakest = Math.min(...peers.map(p => p.ovr || 0));
  return (player.ovr || 0) >= weakest + WAIVER_CLAIM_MIN_UPGRADE;
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

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
