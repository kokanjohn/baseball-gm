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

  // The user's opponent on this date is playing the USER (a live game), not a
  // CPU game. Exclude any CPU-slate game involving that team so no team is
  // booked for two games on the same day. The user's result credits that team's
  // record in GameEngine.commitGame (Step 1b), so its standings stay correct.
  const userGame    = (state.schedule || []).find(g => g.date === dateStr);
  const userOppName = userGame?.opponent || null;
  const userOppTeam = userOppName
    ? (state.leagueTeams || []).find(t => t.name === userOppName)
    : null;
  const userOppId   = userOppTeam?.id || null;

  const leagueTeams    = state.leagueTeams.map(t => ({ ...t })); // working copy
  const newFeedEntries = [];
  const updatedDayMap  = { ...state.leagueSchedule.dayMap };
  const updatedGames   = [];

  for (let i = 0; i < dayGames.length; i++) {
    const game = { ...dayGames[i] };

    // Drop the slate game that would double-book the user's opponent.
    if (userOppId && (game.homeId === userOppId || game.awayId === userOppId)) {
      continue;
    }
    if (game.played) { updatedGames.push(game); continue; }

    const homeTeam = leagueTeams.find(t => t.id === game.homeId);
    const awayTeam = leagueTeams.find(t => t.id === game.awayId);
    if (!homeTeam || !awayTeam) { updatedGames.push(game); continue; }

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
    updatedGames.push(game);

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
