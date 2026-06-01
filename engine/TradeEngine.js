/**
 * engine/TradeEngine.js
 * Trade value calculation, CPU trade proposal generation, execution, and fairness evaluation.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - No cash in trades (LOCKED — Section 9.1). Fairness communicated via rating signal.
 *   - evaluateTrade() is the single place trade value is assessed — used for both
 *     CPU-proposed trades and user-initiated trades. No special casing.
 *   - executeTrade() returns mutations using the markPendingDeparture / pendingAcquisitions
 *     pattern — actual roster swap happens at commitGame() via drainPendingTrades().
 *   - Trade deadline window (games 88–92) modulates CPU aggressiveness.
 *
 * Section references: Section 9 (trade system), Section 22 (GM relationship)
 */

import {
  PLAYER_GROUP,
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  GM_RELATIONSHIP_DEFAULT,
  SALARY_BY_OVR,
  TRADE_CASH_ENABLED,
} from '../data/constants.js';

import { computeAge } from './PlayerFactory.js';

// ─────────────────────────────────────────────────────────────
// TRADE VALUE CALCULATION
// ─────────────────────────────────────────────────────────────

/**
 * evaluateTrade(offer, state)
 * Evaluates a trade proposal from all angles.
 * Returns a TradeEvaluation object used by CardEngine for display
 * and by generateCPUTradeOffer() for proposal generation.
 *
 * offer shape:
 * {
 *   incomingIds:  String[],   // playerIds user would receive
 *   outgoingIds:  String[],   // playerIds user would send
 *   proposingTeamId: String,  // CPU team proposing (or 'user' for user-initiated)
 * }
 *
 * @param {Object} offer
 * @param {Object} state
 * @returns {Object} TradeEvaluation
 */
export function evaluateTrade(offer, state) {
  const { incomingIds = [], outgoingIds = [], proposingTeamId } = offer;

  // Cash in trades is permanently disabled — Section 9.1 (LOCKED)
  // If this constant is ever changed to true, this guard surfaces it immediately.
  if (TRADE_CASH_ENABLED) {
    throw new Error('TradeEngine.evaluateTrade: TRADE_CASH_ENABLED is true — cash in trades is retired (Section 9.1)');
  }

  const incomingPlayers = incomingIds.map(id => state.players[id]).filter(Boolean);
  const outgoingPlayers = outgoingIds.map(id => state.players[id]).filter(Boolean);

  const incomingValue  = incomingPlayers.reduce((sum, p) => sum + _playerValue(p, state), 0);
  const outgoingValue  = outgoingPlayers.reduce((sum, p) => sum + _playerValue(p, state), 0);
  const valueDiff      = incomingValue - outgoingValue;

  const fairnessRating = _fairnessRating(valueDiff);
  const fairnessLabel  = _fairnessLabel(fairnessRating);

  // Depth impact — does this trade leave the user thin at a position?
  const depthImpact    = _assessDepthImpact(outgoingPlayers, incomingPlayers, state);

  // Payroll impact (all in $K)
  const payrollDelta   = _payrollDelta(incomingPlayers, outgoingPlayers);
  const newPayroll     = (state.userTeam.finances.payroll || 0) + payrollDelta;
  const payrollCap     = state.userTeam.finances.payrollCap || 22000;
  const overCap        = newPayroll > payrollCap;

  // GM relationship with proposing team
  const gmRel = proposingTeamId && proposingTeamId !== 'user'
    ? (state.userTeam.gmRelationships?.[proposingTeamId] ?? GM_RELATIONSHIP_DEFAULT)
    : GM_RELATIONSHIP_DEFAULT;

  return {
    incomingValue,
    outgoingValue,
    valueDiff,
    fairnessRating,   // -3 (highway robbery) to +3 (great deal)
    fairnessLabel,    // 'Highway Robbery'|'Unfavorable'|'Slight Disadvantage'|'Fair'|'Slight Advantage'|'Favorable'|'Great Deal'
    depthImpact,      // 'CRITICAL'|'WARNING'|'NEUTRAL'|'IMPROVEMENT'
    payrollDelta,     // $K — positive = more payroll
    newPayroll,       // $K
    overCap,
    gmRel,
    incomingPlayers,
    outgoingPlayers,
  };
}

// ─────────────────────────────────────────────────────────────
// PLAYER VALUE MODEL
// ─────────────────────────────────────────────────────────────

/**
 * _playerValue(player, state)
 * Calculates a single composite value score for a player.
 * Higher = more valuable. Used for trade fairness comparison only —
 * not displayed to the user (they see OVR, salary, contract years).
 *
 * Inputs:
 *   - OVR (primary driver)
 *   - Contract years remaining (more years = more value for good players)
 *   - Salary efficiency (lower salary vs OVR = more value)
 *   - Age (younger = more value, all else equal)
 *   - Rental value (final-year player = rental premium for contenders)
 *
 * @param {Object} player
 * @param {Object} state
 * @returns {Number} value score
 */
function _playerValue(player, state) {
  if (!player) return 0;

  const ovr          = player.ovr || 55;
  const age          = computeAge(player.dob);
  const seasonNum    = state.seasonNum || 1;
  const yearsLeft    = Math.max(0, (player.contractExpiry || seasonNum + 1) - seasonNum);
  const salary       = player.contractSalary || 0;

  // Base OVR value — exponential so elite players are worth much more
  const ovrScore = Math.pow(ovr / 50, 2.5) * 100;

  // Age modifier — peak value at 25-28, declining before and after
  const ageScore = age <= 23 ? 1.15         // young prospect premium
    : age <= 28 ? 1.0                        // peak
    : age <= 32 ? 1.0 - (age - 28) * 0.04   // slight decline
    : 1.0 - (age - 28) * 0.08;              // steeper decline

  // Contract years modifier — more years = more value (up to a point)
  const contractScore = yearsLeft === 0 ? 0.60   // final year / expired
    : yearsLeft === 1 ? 0.85                     // rental value
    : yearsLeft === 2 ? 1.0                      // standard
    : 1.0 + (yearsLeft - 2) * 0.05;             // small bonus for longer deals

  // Salary efficiency — below-market salary is a real asset
  const marketSalary = _marketSalary(ovr);
  const salEfficiency = salary === 0 ? 1.0
    : marketSalary / Math.max(salary, 1);
  const salScore = Math.max(0.5, Math.min(1.5, salEfficiency));

  // Injury penalty — injured players worth less
  const injuryMod = player.isInjured ? 0.70 : 1.0;

  return ovrScore * ageScore * contractScore * salScore * injuryMod;
}

/**
 * _marketSalary(ovr)
 * Returns the midpoint of the salary range for an OVR value (in $K).
 */
function _marketSalary(ovr) {
  for (const tier of Object.values(SALARY_BY_OVR)) {
    if (ovr >= tier.ovrMin && ovr <= tier.ovrMax) {
      return (tier.salMin + tier.salMax) / 2;
    }
  }
  return 50; // fallback
}

// ─────────────────────────────────────────────────────────────
// FAIRNESS RATING
// ─────────────────────────────────────────────────────────────

function _fairnessRating(valueDiff) {
  // -3 to +3 scale
  if (valueDiff >  60) return  3;   // Great Deal
  if (valueDiff >  25) return  2;   // Favorable
  if (valueDiff >   8) return  1;   // Slight Advantage
  if (valueDiff >= -8) return  0;   // Fair
  if (valueDiff > -25) return -1;   // Slight Disadvantage
  if (valueDiff > -60) return -2;   // Unfavorable
  return -3;                        // Highway Robbery
}

function _fairnessLabel(rating) {
  const labels = {
    3:  'Great Deal',
    2:  'Favorable',
    1:  'Slight Advantage',
    0:  'Fair Exchange',
    '-1': 'Slight Disadvantage',
    '-2': 'Unfavorable',
    '-3': 'Highway Robbery',
  };
  return labels[String(rating)] || 'Fair Exchange';
}

// ─────────────────────────────────────────────────────────────
// DEPTH IMPACT ASSESSMENT
// ─────────────────────────────────────────────────────────────

function _assessDepthImpact(outgoing, incoming, state) {
  if (!outgoing.length) return 'NEUTRAL';

  // Check if outgoing player is irreplaceable at their position
  const userRoster = state.userTeam.rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended);

  for (const player of outgoing) {
    const pos      = player.nativePos || player.pos;
    const isPitcher = ['SP', 'RP'].includes(player.pos);

    const compatible = userRoster.filter(p => {
      if (p.id === player.id) return false;
      if (isPitcher) return ['SP','RP'].includes(p.pos);
      // Simplified position compatibility
      return (p.nativePos || p.pos) === pos
          || (pos === 'DH' && ['1B','OF'].includes(p.nativePos || p.pos));
    });

    if (compatible.length === 0) return 'CRITICAL';
    if (compatible.length === 1) return 'WARNING';
  }

  // Check if incoming players improve a thin position
  const incomingGroups = incoming.map(p => p.group);
  if (incomingGroups.includes(PLAYER_GROUP.STARTING_PITCHERS) ||
      incomingGroups.includes(PLAYER_GROUP.STARTING_HITTERS)) {
    return 'IMPROVEMENT';
  }

  return 'NEUTRAL';
}

// ─────────────────────────────────────────────────────────────
// PAYROLL IMPACT
// ─────────────────────────────────────────────────────────────

function _payrollDelta(incoming, outgoing) {
  const inSalary  = incoming.reduce((s, p) => s + (p.contractSalary || 0), 0);
  const outSalary = outgoing.reduce((s, p) => s + (p.contractSalary || 0), 0);
  return inSalary - outSalary;
}

// ─────────────────────────────────────────────────────────────
// CPU TRADE PROPOSAL GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * generateCPUTradeOffer(teamId, state, context)
 * Generates a CPU trade proposal for a given team.
 * Returns an offer object if the CPU wants to propose, null if not.
 *
 * CPU logic:
 *   - Identify the CPU team's biggest need (weakest position group)
 *   - Find a user player who addresses that need
 *   - Assemble a return offer using their tradeable assets
 *   - Apply GM relationship modifier to generosity
 *   - Apply trade deadline aggressiveness modifier
 *
 * @param {String} teamId
 * @param {Object} state
 * @param {Object} context  — { regularSeasonIndex, phase }
 * @returns {Object|null} offer
 */
export function generateCPUTradeOffer(teamId, state, context = {}) {
  const team    = (state.leagueTeams || []).find(t => t.id === teamId);
  if (!team) return null;

  const gmRel   = state.userTeam.gmRelationships?.[teamId] ?? GM_RELATIONSHIP_DEFAULT;

  // Teams with very low gmRelationship rarely initiate trades
  if (gmRel < 20 && Math.random() > 0.10) return null;

  // Base trade probability per game — low, so trades feel special
  const isDeadlineWindow = context.regularSeasonIndex >= TRADE_DEADLINE_OPEN
                        && context.regularSeasonIndex <= TRADE_DEADLINE_CLOSE;
  const baseProbability  = isDeadlineWindow ? 0.08 : 0.02;
  const relModifier      = (gmRel - 50) * 0.001; // ±0.05 at extremes

  if (Math.random() > baseProbability + relModifier) return null;

  // Find what the CPU team needs most
  const cpuNeed = _identifyCPUNeed(team, state);
  if (!cpuNeed) return null;

  // Find a user player who addresses that need
  const target = _findTradeTarget(cpuNeed, state);
  if (!target) return null;

  // Find what the CPU can offer
  const offering = _assembleCPUOffer(team, target, state, gmRel, isDeadlineWindow);
  if (!offering) return null;

  const offer = {
    incomingIds:     [target.id],
    outgoingIds:     [offering.id],
    proposingTeamId: teamId,
    isRental:        _isRentalPlayer(target, state),
  };

  // Evaluate the offer — if it's too unfair for the user, the CPU adjusts
  const evaluation = evaluateTrade(offer, state);

  // CPU teams don't propose highway robbery (would insult the GM)
  if (evaluation.fairnessRating < -2) return null;

  // Teams with high gmRelationship propose fairer deals
  if (gmRel >= 70 && evaluation.fairnessRating < -1) return null;

  return { offer, evaluation };
}

// ─────────────────────────────────────────────────────────────
// TRADE EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * executeTrade(offer, state)
 * Prepares a trade for game-day execution.
 * Does NOT immediately swap rosters — uses pending departure pattern.
 * GameEngine calls drainPendingTrades() at commitGame() to finalize.
 *
 * @param {Object} offer  — { incomingIds, outgoingIds, proposingTeamId }
 * @param {Object} state
 * @returns {Object} mutations
 */
export function executeTrade(offer, state) {
  const { incomingIds = [], outgoingIds = [], proposingTeamId } = offer;

  const playerMutations = {};

  // Mark outgoing players as pending departure
  for (const playerId of outgoingIds) {
    const player = state.players[playerId];
    if (!player) continue;
    playerMutations[playerId] = {
      _pendingDeparture: true,
    };
  }

  // Stage incoming players as pending acquisitions
  const pendingAcquisitions = [...(state._pendingAcquisitions || [])];
  for (const playerId of incomingIds) {
    const player = state.players[playerId];
    if (!player) continue;
    pendingAcquisitions.push({
      ...player,
      id:     playerId,
      teamId: 'user',
      // GM relationship starts slightly lower for newly acquired players (Section 22.3)
      gmRelationship: player._previouslyWithOrg
        ? Math.min(100, (player.gmRelationship || GM_RELATIONSHIP_DEFAULT) + 5)
        : 45,
      _previouslyWithOrg: player.teamId === 'user' || player._previouslyWithOrg,
      _pendingDeparture:  false,
    });
  }

  // Update the CPU team roster (remove incoming, add outgoing)
  const leagueTeams = state.leagueTeams ? [...state.leagueTeams] : [];
  const teamIdx     = leagueTeams.findIndex(t => t.id === proposingTeamId);

  if (teamIdx >= 0) {
    const team        = { ...leagueTeams[teamIdx] };
    const newRosterIds = team.rosterIds.filter(id => !incomingIds.includes(id));
    for (const playerId of outgoingIds) {
      newRosterIds.push(playerId);
    }
    team.rosterIds        = newRosterIds;
    leagueTeams[teamIdx]  = team;

    // Update player teamIds
    for (const playerId of incomingIds) {
      playerMutations[playerId] = {
        ...(playerMutations[playerId] || {}),
        teamId: 'user',
      };
    }
    for (const playerId of outgoingIds) {
      playerMutations[playerId] = {
        ...(playerMutations[playerId] || {}),
        teamId: proposingTeamId,
      };
    }
  }

  // gmRelationship boost for completed trade (Section 22.5)
  const newGmRels = { ...(state.userTeam.gmRelationships || {}) };
  if (proposingTeamId && proposingTeamId !== 'user') {
    newGmRels[proposingTeamId] = Math.min(100,
      (newGmRels[proposingTeamId] ?? GM_RELATIONSHIP_DEFAULT) + 1
    );
  }

  return {
    players:              playerMutations,
    _pendingAcquisitions: pendingAcquisitions,
    leagueTeams,
    userTeam: {
      gmRelationships: newGmRels,
    },
  };
}

/**
 * deferTrade(offer, state)
 * Same as executeTrade but marks the trade as game-day-deferred.
 * Used when a trade is accepted mid-game — roster swap happens at commit.
 * This is the normal path — same as executeTrade since it uses pending departures.
 */
export function deferTrade(offer, state) {
  return executeTrade(offer, state);
}

// ─────────────────────────────────────────────────────────────
// USER-INITIATED TRADE EVALUATION
// ─────────────────────────────────────────────────────────────

/**
 * evaluateCPUResponse(offer, state)
 * Simulates the CPU team's response to a user-initiated trade offer.
 * Returns { decision: 'accept'|'decline'|'counter', counterOffer? }
 *
 * @param {Object} offer
 * @param {Object} state
 * @returns {Object} response
 */
export function evaluateCPUResponse(offer, state) {
  const { proposingTeamId } = offer;
  const evaluation = evaluateTrade(offer, state);
  const gmRel      = state.userTeam.gmRelationships?.[proposingTeamId] ?? GM_RELATIONSHIP_DEFAULT;

  // Cooldown check — per-team 15-game cooldown after declined offer
  const lastDeclined = state._tradeDeclinedAt?.[proposingTeamId] || 0;
  if ((state.currentGameIndex || 0) - lastDeclined < 15) {
    return { decision: 'decline', reason: 'cooldown' };
  }

  // CPU accepts if the deal is fair or better for them (i.e., worse for user)
  // Adjusted by gmRelationship — friendly teams accept marginal deals
  const acceptThreshold = gmRel >= 70 ? -1   // friendly: accepts slight disadvantage
    : gmRel >= 50 ? 0                         // neutral: accepts fair deals
    : 1;                                      // cold: requires slight advantage

  if (evaluation.fairnessRating <= -acceptThreshold) {
    // Deal is good enough for CPU to accept
    return { decision: 'accept', evaluation };
  }

  // Consider countering (Phase 9 — return counter flag for now)
  if (evaluation.fairnessRating > acceptThreshold && evaluation.fairnessRating <= 2) {
    if (gmRel >= 40 && Math.random() < 0.60) {
      return { decision: 'counter', evaluation };
    }
  }

  return { decision: 'decline', evaluation, reason: 'value' };
}

// ─────────────────────────────────────────────────────────────
// RENTAL TRADE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _isRentalPlayer(player, state)
 * Returns true if this player is in their final contract year.
 * Rental players have modified value — high for contenders, lower for rebuilders.
 */
function _isRentalPlayer(player, state) {
  return player.contractExpiry === (state.seasonNum || 1);
}

// ─────────────────────────────────────────────────────────────
// CPU NEED IDENTIFICATION
// ─────────────────────────────────────────────────────────────

function _identifyCPUNeed(team, state) {
  const roster = (team.rosterIds || [])
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended);

  // Find weakest position group by average OVR
  const groups = {
    hitters:  roster.filter(p => [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group)),
    starters: roster.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS),
    bullpen:  roster.filter(p => [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group)),
  };

  const avgOvr = arr => arr.length ? arr.reduce((s, p) => s + p.ovr, 0) / arr.length : 0;

  const weakest = Object.entries(groups)
    .map(([key, arr]) => ({ key, avg: avgOvr(arr) }))
    .sort((a, b) => a.avg - b.avg)[0];

  return weakest?.key || 'hitters';
}

function _findTradeTarget(need, state) {
  const userRoster = state.userTeam.rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p._pendingDeparture);

  const isPitcher = need === 'starters' || need === 'bullpen';

  const eligible = userRoster.filter(p => {
    if (isPitcher) return ['SP','RP'].includes(p.pos);
    return ![PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group);
  });

  if (!eligible.length) return null;

  // Target a player in the top half of the user's roster but not the best player
  const sorted = eligible.sort((a, b) => b.ovr - a.ovr);
  const startIdx = Math.floor(sorted.length * 0.2); // avoid the top 20%
  const pool     = sorted.slice(startIdx, Math.floor(sorted.length * 0.8));

  return pool[Math.floor(Math.random() * pool.length)] || null;
}

function _assembleCPUOffer(team, target, state, gmRel, isDeadlineWindow) {
  const targetValue = _playerValue(target, state);
  const roster      = (team.rosterIds || [])
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended);

  // Find tradeable CPU players — bench/final-year players, or 15% chance of any
  const tradeable = roster.filter(p => {
    const isBench    = [PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group);
    const isFinalYr  = _isRentalPlayer(p, state);
    return isBench || isFinalYr || (isDeadlineWindow && Math.random() < 0.15);
  });

  if (!tradeable.length) return null;

  // Find best value match — aim for value close to target
  // gmRelationship > 70: CPU offers slightly above target value (generous)
  // gmRelationship < 30: CPU offers below target value (stingy)
  const valueMod = gmRel >= 70 ? 1.10 : gmRel <= 30 ? 0.80 : 1.0;
  const targetOfferValue = targetValue * valueMod;

  const scored = tradeable
    .map(p => ({ p, diff: Math.abs(_playerValue(p, state) - targetOfferValue) }))
    .sort((a, b) => a.diff - b.diff);

  return scored[0]?.p || null;
}

// ─────────────────────────────────────────────────────────────
// TRADE COOLDOWN MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * recordDeclinedOffer(teamId, state)
 * Returns mutations to record a declined trade offer (starts 15-game cooldown).
 *
 * @param {String} teamId
 * @param {Object} state
 * @returns {Object} mutations
 */
export function recordDeclinedOffer(teamId, state) {
  return {
    _tradeDeclinedAt: {
      ...(state._tradeDeclinedAt || {}),
      [teamId]: state.currentGameIndex || 0,
    },
  };
}
