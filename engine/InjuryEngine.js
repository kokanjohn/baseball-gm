/**
 * engine/InjuryEngine.js
 * League-wide injury probability, processing, and injury report generation.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - Runs on ALL 10 teams — same probability model, same constants, no hidden invincibility.
 *   - CPU injuries are silent (no inbox card) but update player registry and affect OVR.
 *   - User team injuries fire an event object that CardEngine uses to generate the two-act card.
 *   - Does NOT call RosterEngine directly — returns mutations for caller to apply.
 *
 * Section references: Section 21 (injury system), Section 11 (two-act model)
 */

import {
  INJURY_PROB_HITTER_PER_GAME,
  INJURY_PROB_SP_PER_START,
  INJURY_PROB_RP_PER_APP,
  INJURY_AGE_MOD_32_34,
  INJURY_AGE_MOD_35_PLUS,
  INJURY_FATIGUE_MOD,
  INJURY_SEVERITY_MINOR_PROB,
  INJURY_SEVERITY_MODERATE_PROB,
  INJURY_SEVERITY_SIGNIFICANT_PROB,
  INJURY_SEVERITY_SEASON_PROB,
  INJURY_IL_DAYS_MINOR,
  INJURY_IL_DAYS_MODERATE,
  INJURY_IL_DAYS_SIGNIFICANT,
  INJURY_IL_DAYS_SEASON,
  INJURY_SR_PENALTY_MINOR,
  INJURY_SR_PENALTY_MODERATE,
  INJURY_SR_PENALTY_SIGNIFICANT,
  INJURY_SR_PENALTY_SEASON,
  INJURY_TYPES,
  INJURY_REPORT_TIER_SILENT,
  INJURY_REPORT_TIER_VAGUE,
  INJURY_REPORT_TIER_GENERAL,
  INJURY_REPORT_STALE_DAYS,
  PLAYER_GROUP,
  RETIREMENT_AGE_HARD,
  RETIREMENT_AGE_SOFT,
  RETIREMENT_OVR_SOFT,
  RETIREMENT_OVR_FARM,
  FARM_ARC_MOTIVATION_PROB_BASE,
  FARM_ARC_DECLINE_PROB_BASE,
  FARM_ARC_STABLE_PROB_BASE,
  FARM_ARC_YOUNG_GUN_MOTIVATION_BONUS,
  FARM_ARC_YOUNG_GUN_DECLINE_PENALTY,
  FARM_ARC_VOLATILE_DECLINE_BONUS,
  FARM_ARC_AGE_DECLINE_BONUS_PER_YEAR,
  FARM_ARC_DECLINE_RELEASE_REQUEST_DAYS,
  FARM_ARC_MOTIVATION_DRIFT_MIN,
  FARM_ARC_MOTIVATION_DRIFT_MAX,
  FARM_ARC_DECLINE_DRIFT_MIN,
  FARM_ARC_DECLINE_DRIFT_MAX,
} from '../data/constants.js';

import { computeAge, computeOVR } from './PlayerFactory.js';

const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────
// DAILY INJURY CHECK — runs for all 10 teams
// ─────────────────────────────────────────────────────────────

/**
 * runDailyInjuryCheck(state, gameIndex)
 * Evaluates injury probability for every active roster player on all 10 teams.
 * Returns mutations and a list of injury events for user team players.
 *
 * User team injuries: { type: 'USER_INJURY', playerId, severity, injuryType }
 *   → CardEngine generates the two-act card from this event
 *
 * CPU team injuries: applied silently — player registry updated, no event generated
 *
 * @param {Object} state
 * @param {Number} gameIndex   — current game index (for IL return date calculation)
 * @returns {Object} { mutations: { players: {}, leagueTeams: [] }, events: [] }
 */
export function runDailyInjuryCheck(state, gameIndex) {
  const playerMutations = {};
  const events          = [];

  // Check user team
  const userEvents = _checkTeamInjuries(
    state.userTeam.rosterIds,
    state.players,
    gameIndex,
    true,    // isUserTeam
    playerMutations
  );
  events.push(...userEvents);

  // Check CPU teams (silent)
  for (const team of (state.leagueTeams || [])) {
    _checkTeamInjuries(
      team.rosterIds,
      state.players,
      gameIndex,
      false,   // isUserTeam
      playerMutations
    );
  }

  return {
    mutations: { players: playerMutations },
    events,
  };
}

// ─────────────────────────────────────────────────────────────
// PLAYER INJURY
// ─────────────────────────────────────────────────────────────

/**
 * injurePlayer(player, gameIndex, severityOverride?)
 * Determines IL duration, sub-rating penalty, and generates injury report.
 * Returns a partial player update object (mutations to apply).
 *
 * Called directly for in-game injuries (two-act model Act 1 resolution).
 * Also called by runDailyInjuryCheck for daily probability hits.
 *
 * @param {Object} player           — full player object
 * @param {Number} gameIndex        — current game index
 * @param {String} severityOverride — 'minor'|'moderate'|'significant'|'season' (optional)
 * @returns {Object} player mutation
 */
export function injurePlayer(player, gameIndex, severityOverride = null) {
  const severity   = severityOverride || _rollSeverity();
  const injuryType = _pickInjuryType(player);
  const ilDays     = _rollILDays(severity);
  const penalty    = _penaltyForSeverity(severity);
  const report     = _generateInjuryReport(player, injuryType, severity, ilDays);

  // Store uncertainty for Act 2 (sometimes better, sometimes worse than Act 1)
  const act2Variance = _rollAct2Variance(severity);

  return {
    isInjured:      true,
    tier:           'active',   // stays on active roster tier (on IL, not farm)
    group:          PLAYER_GROUP.IL,
    ilReturnGame:   gameIndex + ilDays,
    injuryPenalty:  {
      subRating: injuryType.affectedSR,
      amount:    penalty,
    },
    injuryReport:   report,
    _injuryType:    injuryType.id,
    _injurySeverity: severity,
    _act2Variance:  act2Variance,   // revealed at Act 2 card time
    _pendingILReturn: false,
  };
}

// ─────────────────────────────────────────────────────────────
// IL RETURN PROCESSING
// ─────────────────────────────────────────────────────────────

/**
 * processILReturns(state, gameIndex)
 * Checks all injured players across all teams for return eligibility.
 * For user team: flags _pendingILReturn, adds to ilReturnQueue (CardEngine handles decision).
 * For CPU teams: auto-activates returning players.
 *
 * Returns mutations.
 *
 * @param {Object} state
 * @param {Number} gameIndex
 * @returns {Object} mutations
 */
export function processILReturns(state, gameIndex) {
  const playerMutations = {};
  const ilReturnQueue   = [...(state.ilReturnQueue || [])];

  for (const [playerId, player] of Object.entries(state.players)) {
    if (!player.isInjured || player.ilReturnGame === null) continue;
    if (player.ilReturnGame > gameIndex) continue;

    const isUserPlayer = state.userTeam.rosterIds.includes(playerId);

    if (isUserPlayer) {
      // Flag for GM decision — CardEngine generates the IL return card
      if (!ilReturnQueue.includes(playerId)) {
        ilReturnQueue.push(playerId);
      }
      playerMutations[playerId] = {
        isInjured:        false,
        ilReturnGame:     null,
        _pendingILReturn: true,
      };
    } else {
      // CPU auto-activate — clear injury, restore to bullpen/bench
      const isPitcher = ['SP','RP'].includes(player.pos);
      playerMutations[playerId] = {
        isInjured:        false,
        ilReturnGame:     null,
        injuryPenalty:    null,
        _pendingILReturn: false,
        group:  isPitcher ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS,
      };
    }
  }

  return {
    mutations: { players: playerMutations, ilReturnQueue },
  };
}

// ─────────────────────────────────────────────────────────────
// INJURY REPORT
// ─────────────────────────────────────────────────────────────

/**
 * getInjuryReport(player, requestingTeamId, gmRelationship, now?)
 * Returns filtered injury report text based on GM relationship score.
 * Section 21.3 — relationship gates information quality.
 *
 * @param {Object} player
 * @param {String} requestingTeamId  — 'user' or a CPU team ID
 * @param {Number} gmRelationship    — 0-100
 * @param {Number} now               — Unix ms (defaults to Date.now())
 * @returns {Object} { text, isStale, staleDays }
 */
export function getInjuryReport(player, requestingTeamId, gmRelationship = 50, now = Date.now()) {
  // User always gets full detail for their own players
  if (requestingTeamId === 'user' && player.teamId === 'user') {
    return {
      text:     player.injuryReport?.detailedText || 'No report available.',
      isStale:  false,
      staleDays: 0,
    };
  }

  if (!player.injuryReport) {
    return { text: 'No injury information available.', isStale: false, staleDays: 0 };
  }

  const staleDays = Math.floor((now - (player.injuryReport.generatedAt || now)) / MS_PER_DAY);
  const isStale   = staleDays > INJURY_REPORT_STALE_DAYS;
  const staleNote = isStale ? ` (Report from ${staleDays} days ago — status may have changed)` : '';

  let text;
  if (gmRelationship < INJURY_REPORT_TIER_SILENT) {
    text = 'The organization is not commenting on player availability.';
  } else if (gmRelationship < INJURY_REPORT_TIER_VAGUE) {
    text = player.injuryReport.vagueText + staleNote;
  } else if (gmRelationship < INJURY_REPORT_TIER_GENERAL) {
    text = player.injuryReport.generalText + staleNote;
  } else {
    text = player.injuryReport.detailedText + staleNote;
  }

  return { text, isStale, staleDays };
}

// ─────────────────────────────────────────────────────────────
// RETIREMENT PROCESSING
// ─────────────────────────────────────────────────────────────

/**
 * processRetirements(state)
 * Evaluates all players for retirement eligibility at season end.
 * Silent for CPU players; generates a retirement event for user team players.
 * Returns mutations and retirement events.
 *
 * Hard rule: age >= RETIREMENT_AGE_HARD always retires.
 * Soft rule: age >= RETIREMENT_AGE_SOFT AND ovr < RETIREMENT_OVR_SOFT may retire.
 * Farm rule: ovr < RETIREMENT_OVR_FARM AND on farm for 2+ seasons may retire.
 *
 * @param {Object} state
 * @returns {Object} { mutations: { players: {} }, events: [] }
 */
export function processRetirements(state) {
  const playerMutations = {};
  const events          = [];

  for (const [playerId, player] of Object.entries(state.players)) {
    if (!player || player.tier === 'retired') continue;

    const age = computeAge(player.dob);
    let retires = false;

    // Hard retirement — age threshold
    if (age >= RETIREMENT_AGE_HARD) {
      retires = true;
    }

    // Soft retirement — age + OVR threshold
    if (!retires && age >= RETIREMENT_AGE_SOFT && player.ovr < RETIREMENT_OVR_SOFT) {
      // 60% chance of retiring at soft threshold
      retires = Math.random() < 0.60;
    }

    // Farm retirement — low OVR + extended farm time
    if (!retires && player.tier === 'farm' && player.ovr < RETIREMENT_OVR_FARM) {
      retires = Math.random() < 0.25;
    }

    if (!retires) continue;

    const isUserPlayer = state.userTeam.rosterIds.includes(playerId)
                      || (state.userTeam.farmIds || []).includes(playerId);

    playerMutations[playerId] = {
      tier:   'retired',
      teamId: null,
      group:  'retired',
    };

    if (isUserPlayer) {
      events.push({ type: 'USER_PLAYER_RETIRED', playerId, player: { ...player } });
    }
  }

  return {
    mutations: { players: playerMutations },
    events,
  };
}

// ─────────────────────────────────────────────────────────────
// FARM ARC ASSIGNMENT
// ─────────────────────────────────────────────────────────────

/**
 * assignFarmArc(player, now?)
 * Assigns a farm story arc to a player being sent down.
 * Called by RosterEngine (via GameEngine) when sendToFarm() is executed.
 * Returns a partial player update.
 *
 * @param {Object} player
 * @param {Number} now    — Unix ms
 * @returns {Object} player mutation
 */
export function assignFarmArc(player, now = Date.now()) {
  const age = computeAge(player.dob);

  let motivationProb = FARM_ARC_MOTIVATION_PROB_BASE;
  let declineProb    = FARM_ARC_DECLINE_PROB_BASE;

  // Trait modifiers
  if (player.trait === 'youngGun') {
    motivationProb += FARM_ARC_YOUNG_GUN_MOTIVATION_BONUS;
    declineProb    += FARM_ARC_YOUNG_GUN_DECLINE_PENALTY;
  }
  if (player.trait === 'volatile') {
    declineProb += FARM_ARC_VOLATILE_DECLINE_BONUS;
  }

  // Age modifier — older players more likely to decline
  if (age > 28) {
    declineProb += (age - 28) * FARM_ARC_AGE_DECLINE_BONUS_PER_YEAR;
  }

  // Normalize
  const total   = motivationProb + declineProb + FARM_ARC_STABLE_PROB_BASE;
  const r       = Math.random() * total;
  const arc     = r < motivationProb ? 'motivation'
    : r < motivationProb + declineProb ? 'decline'
    : 'stable';

  return {
    _farmArc:         arc,
    _farmArcStart:    now,
    _farmArcOvrDelta: 0,
  };
}

/**
 * processFarmArcs(state, now?)
 * Applies farm arc OVR drift for all players currently on farm systems.
 * Called once per season transition (offseason processing).
 * Returns mutations and any decline release request events.
 *
 * @param {Object} state
 * @param {Number} now
 * @returns {Object} { mutations, events }
 */
export function processFarmArcs(state, now = Date.now()) {
  const playerMutations = {};
  const events          = [];
  const allFarmIds      = [
    ...(state.userTeam.farmIds || []),
    ...(state.leagueTeams || []).flatMap(t => t.farmIds || []),
  ];

  for (const playerId of allFarmIds) {
    const player = state.players[playerId];
    if (!player || !player._farmArc || player._farmArc === 'stable') continue;

    let delta = 0;

    if (player._farmArc === 'motivation') {
      delta = _rollFloat(FARM_ARC_MOTIVATION_DRIFT_MIN, FARM_ARC_MOTIVATION_DRIFT_MAX);
    } else if (player._farmArc === 'decline') {
      delta = -_rollFloat(FARM_ARC_DECLINE_DRIFT_MIN, FARM_ARC_DECLINE_DRIFT_MAX);

      // Check for decline release request
      const arcDays = (now - (player._farmArcStart || now)) / MS_PER_DAY;
      if (arcDays >= FARM_ARC_DECLINE_RELEASE_REQUEST_DAYS) {
        const isUserFarm = (state.userTeam.farmIds || []).includes(playerId);
        if (isUserFarm) {
          events.push({ type: 'FARM_DECLINE_RELEASE_REQUEST', playerId });
        }
      }
    }

    if (delta === 0) continue;

    // Apply drift to sub-ratings
    const sr         = { ...(player.subRatings || {}) };
    const isPitcher  = sr.stuff !== null && sr.stuff !== undefined;
    const activeKeys = isPitcher ? ['stuff', 'control', 'stamina'] : ['contact', 'power', 'speed'];

    for (const key of activeKeys) {
      if (sr[key] !== null && sr[key] !== undefined) {
        sr[key] = Math.max(40, Math.min(99, Math.round(sr[key] + delta)));
      }
    }

    const newOvr         = computeOVR(sr);
    const cumulativeDelta = (player._farmArcOvrDelta || 0) + delta;

    playerMutations[playerId] = {
      subRatings:        sr,
      ovr:               newOvr,
      _farmArcOvrDelta:  cumulativeDelta,
    };
  }

  return {
    mutations: { players: playerMutations },
    events,
  };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _checkTeamInjuries(rosterIds, players, gameIndex, isUserTeam, playerMutationsOut) {
  const events = [];

  for (const playerId of rosterIds) {
    const player = players[playerId];
    if (!player) continue;
    if (player.isInjured || player.isSuspended || player.onPersonalLeave) continue;
    if (player.group === PLAYER_GROUP.IL || player.group === PLAYER_GROUP.PRACTICE_SQUAD) continue;

    const prob = _injuryProbability(player);
    if (Math.random() >= prob) continue;

    // Injury occurred
    const mutation = injurePlayer(player, gameIndex);
    playerMutationsOut[playerId] = mutation;

    if (isUserTeam) {
      events.push({
        type:        'USER_INJURY',
        playerId,
        severity:    mutation._injurySeverity,
        injuryType:  mutation._injuryType,
        ilReturnGame: mutation.ilReturnGame,
      });
    }
  }

  return events;
}

function _injuryProbability(player) {
  const age      = computeAge(player.dob);
  const isPitcher = ['SP','RP'].includes(player.pos);

  let base = isPitcher
    ? (player.group === PLAYER_GROUP.STARTING_PITCHERS ? INJURY_PROB_SP_PER_START : INJURY_PROB_RP_PER_APP)
    : INJURY_PROB_HITTER_PER_GAME;

  // Age modifier
  if (age >= 35) base += INJURY_AGE_MOD_35_PLUS;
  else if (age >= 32) base += INJURY_AGE_MOD_32_34;

  // Fatigue modifier (SP only)
  if (player._simFatigued) base += INJURY_FATIGUE_MOD;

  return Math.min(base, 0.10); // hard cap at 10% per game
}

function _rollSeverity() {
  const r = Math.random();
  if (r < INJURY_SEVERITY_MINOR_PROB)                                     return 'minor';
  if (r < INJURY_SEVERITY_MINOR_PROB + INJURY_SEVERITY_MODERATE_PROB)    return 'moderate';
  if (r < INJURY_SEVERITY_MINOR_PROB + INJURY_SEVERITY_MODERATE_PROB
        + INJURY_SEVERITY_SIGNIFICANT_PROB)                               return 'significant';
  return 'season';
}

function _pickInjuryType(player) {
  const isPitcher = ['SP','RP'].includes(player.pos);
  const isRP      = player.pos === 'RP';
  const group     = isRP ? 'reliever' : isPitcher ? 'pitcher' : 'hitter';

  const eligible = INJURY_TYPES.filter(t =>
    t.group === group || (group === 'reliever' && t.group === 'pitcher')
  );
  return eligible[Math.floor(Math.random() * eligible.length)] || INJURY_TYPES[0];
}

function _rollILDays(severity) {
  const ranges = {
    minor:       INJURY_IL_DAYS_MINOR,
    moderate:    INJURY_IL_DAYS_MODERATE,
    significant: INJURY_IL_DAYS_SIGNIFICANT,
    season:      INJURY_IL_DAYS_SEASON,
  };
  const [min, max] = ranges[severity] || INJURY_IL_DAYS_MINOR;
  if (min === max) return min; // season-ending
  return _rng(min, max);
}

function _penaltyForSeverity(severity) {
  const penalties = {
    minor:       INJURY_SR_PENALTY_MINOR,
    moderate:    INJURY_SR_PENALTY_MODERATE,
    significant: INJURY_SR_PENALTY_SIGNIFICANT,
    season:      INJURY_SR_PENALTY_SEASON,
  };
  return penalties[severity] || INJURY_SR_PENALTY_MINOR;
}

function _rollAct2Variance(severity) {
  // Sometimes better (sprain not a tear), sometimes worse (stress fracture found)
  const r = Math.random();
  if (r < 0.25) return 'better';     // 25%: better than Act 1 feared
  if (r < 0.55) return 'confirmed';  // 30%: exactly as feared
  return 'worse';                    // 45%: worse than Act 1 feared
}

function _generateInjuryReport(player, injuryType, severity, ilDays) {
  const now         = Date.now();
  const playerName  = player.name || 'Player';
  const label       = injuryType.label || 'injury';
  const weeksMin    = Math.ceil(ilDays / 7);
  const weeksMax    = weeksMin + (severity === 'minor' ? 1 : severity === 'moderate' ? 2 : 3);

  return {
    generatedAt:  now,
    vagueText:    `${playerName} — upper body injury. Day-to-day.`,
    generalText:  `${playerName} — ${label.toLowerCase()}. Estimated ${weeksMin}–${weeksMax} weeks.`,
    detailedText: `Grade ${_severityGrade(severity)} ${label.toLowerCase()}. Targeting return in ${ilDays} days. ${_prognosisText(severity)}`,
    severity,
    injuryTypeId: injuryType.id,
    ilDays,
  };
}

function _severityGrade(severity) {
  return { minor: '1', moderate: '2', significant: '3', season: '4' }[severity] || '1';
}

function _prognosisText(severity) {
  return {
    minor:       'No structural concern.',
    moderate:    'Conservative timeline recommended.',
    significant: 'Full evaluation underway. Surgery not anticipated.',
    season:      'Season-ending. Surgical consultation scheduled.',
  }[severity] || '';
}

function _rollFloat(min, max) {
  return min + Math.random() * (max - min);
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
