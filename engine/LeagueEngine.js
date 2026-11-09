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

import { computeOVR, isAvailable } from './PlayerFactory.js';
import { canAddSalary } from './FinanceEngine.js';
import { cpuView } from './Diamonds.js';
import { eventRand } from './Dice.js';

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
export function cpuWaiverClaimant(state, playerId, atMs = null) {
  const player = state.players[playerId];
  if (!player) return null;
  const standings = _computeStandingsBase(state.leagueTeams, {
    name:       state.userTeam?.city + ' ' + state.userTeam?.nickname,
    abbr:       state.userTeam?.abbr,
    divisionId: 'A',
    wins:       state.userTeam?.wins   || 0,
    losses:     state.userTeam?.losses || 0,
  });
  const order = [...standings.all];
  const contender = new Set(order.slice(0, Math.ceil(order.length / 2)).map(e => e.id));
  for (const entry of [...order].reverse()) {
    if (entry.id === player._waivedBy) continue;
    // The user claims only by putting a claim in (§73); clubs claim in
    // reverse order of the standings — worst record first.
    if (entry.id === 'user') { if (player._userClaim) return 'user'; continue; }
    const team = state.leagueTeams.find(t => t.id === entry.id);
    // §78.5 a claim takes on his contract: only a club whose owner can carry it.
    if (team && _isUpgradeFor(team, player, state.players, atMs)
        && canAddSalary(state, player.contractSalary || 0, 0, team.id)
        && _worthTheWait(state, player, contender.has(team.id), atMs)) return team.id;
  }
  return null;
}

/**
 * §122 An injured player on waivers is worth claiming when waiting suits the
 * club: anyone claims him if he'll be back with a month of the regular season
 * still to play; a club out of the race also claims him when his deal runs
 * past this season (it can wait for next year). A short injury (a week or
 * less) doesn't count.
 */
function _worthTheWait(state, player, isContender, atMs) {
  const inj = player.injury;
  if (!inj || !player.isInjured) return true;
  const now = Number.isFinite(atMs) ? atMs : (player.waiverStartTime || 0);
  const back = inj.status === 'il' ? inj.eligibleAt : inj.returnAt;
  const outDays = Number.isFinite(back) ? (back - now) / 86_400_000 : (inj.days || 0);
  if (outDays <= 7) return true;
  const lastGame = (state.schedule || []).filter(g => !g.isSpring && !g.isPlayoff && Number.isFinite(g.gameTime)).pop()?.gameTime;
  const leftAfter = Number.isFinite(lastGame) ? (lastGame - (now + outDays * 86_400_000)) / 86_400_000 : 0;
  if (leftAfter >= 30) return true;
  return !isContender && (player.contractExpiry || 0) > (state.seasonNum || 1) + 1;
}

/**
 * weakestPeer(team, player, players) — §122 the club's weakest healthy active
 * player in his role: the same position for a hitter, starter or reliever for
 * a pitcher. null when the club has nobody there (a hole).
 */
export function weakestPeer(team, player, players) {
  const isP = ['SP', 'RP'].includes(player.pos);
  const peers = (team.rosterIds || []).map(id => players[id]).filter(p =>
    p && p.id !== player.id && p.group !== PLAYER_GROUP.IL && !p.isInjured
    && (isP ? p.pos === player.pos
            : !['SP', 'RP'].includes(p.pos) && (p.nativePos || p.pos) === (player.nativePos || player.pos)));
  return peers.sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
}

/** Would this player be a real upgrade over the weakest active player he'd replace? */
function _isUpgradeFor(team, player, players, atMs = null) {
  const isP = ['SP', 'RP'].includes(player.pos);
  const weakest = weakestPeer(team, player, players);
  if (!weakest) return !isP || player.pos === 'SP';   // a hole at his position
  const seen = Number.isFinite(atMs) ? cpuView(player, atMs) : (player.ovr || 0);   // §122.9
  return seen >= (weakest.ovr || 0) + WAIVER_CLAIM_MIN_UPGRADE;
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

  const hitters  = roster.filter(p => [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group) && isAvailable(p));
  const starters = roster.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS && isAvailable(p));
  const bullpen  = roster.filter(p => p.group === PLAYER_GROUP.BULLPEN && isAvailable(p));

  const avgOvr = arr => arr.length === 0 ? 55 : arr.reduce((s, p) => s + (p.ovr || 55), 0) / arr.length;

  return (avgOvr(hitters)  * SIM_HITTER_OVR_WEIGHT)
       + (avgOvr(starters) * SIM_SP_OVR_WEIGHT)
       + (avgOvr(bullpen)  * SIM_BP_OVR_WEIGHT);
}

function _rng(lo, hi) {
  return lo + Math.floor(eventRand() * (hi - lo + 1));
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
