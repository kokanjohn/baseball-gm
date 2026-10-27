/**
 * engine/InjuryEngine.js
 * League-wide injury probability, processing, and injury report generation.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - Runs on ALL 10 teams — same probability model, same constants, no hidden invincibility.
 *   - Time is REAL time (§65): injuries carry injuredAt / returnAt / eligibleAt
 *     in ms. TransactionEngine.applyDue() moves them along the roster clock.
 *   - CPU injuries are silent (no inbox card); the CPU GM decides IL vs day-to-day at once.
 *   - User team injuries start as 'evaluating' and CardEngine runs the two-act card.
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
  INJURY_SEASON_ENDING_DAYS,
  INJURY_DTD_MAX_DAYS,
  INJURY_ACT2_BETTER_MULT,
  INJURY_ACT2_WORSE_MULT,
  IL_MIN_DAYS_HITTER,
  IL_MIN_DAYS_PITCHER,
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
// GAME INJURIES — every team, real clock (§65)
// ─────────────────────────────────────────────────────────────

/**
 * rollGameInjuries(state, appearances, nowMs)
 * Rolls injuries for the players who actually took the field in a game day.
 * Same probability model for all ten teams — no hidden invincibility.
 *
 *   USER players  → status 'evaluating' (still on the active roster, not
 *                   available to play). CardEngine runs the two-act flow:
 *                   Act 1 (exam choice) → Act 2 (diagnosis: IL or day-to-day).
 *   CPU players   → diagnosed at once; the CPU GM picks IL or day-to-day.
 *
 * @param {Object}   state
 * @param {Object[]} appearances — [{ teamId, hitterIds, starterId, relieverIds }]
 * @param {Number}   nowMs       — the moment of injury (end of the game)
 * @returns {{ players: Object, events: Object[] }}
 *          events: [{ type: 'INJURY', teamId, playerId }]
 */
export function rollGameInjuries(state, appearances, nowMs) {
  const players = {};
  const events  = [];

  for (const app of appearances || []) {
    const roles = [
      ...(app.hitterIds   || []).map(id => [id, 'hitter']),
      ...(app.starterId ? [[app.starterId, 'starter']] : []),
      ...(app.relieverIds || []).map(id => [id, 'reliever']),
    ];
    const seen = new Set();
    for (const [playerId, role] of roles) {
      if (seen.has(playerId)) continue;
      seen.add(playerId);
      const player = state.players[playerId];
      if (!player || player.isInjured || player.injury) continue;
      if (player.group === PLAYER_GROUP.IL) continue;
      if (Math.random() >= _injuryProbability(player, role)) continue;

      const begun = beginInjury(player, nowMs);
      players[playerId] = app.teamId === 'user'
        ? begun
        : { ...begun, ..._cpuDisposition({ ...player, ...begun }) };
      events.push({ type: 'INJURY', teamId: app.teamId, playerId });
    }
  }
  return { players, events };
}

/**
 * beginInjury(player, nowMs, severityOverride?)
 * The moment a player gets hurt: unavailable at once, still occupying his
 * active-roster spot until the GM decides (status 'evaluating').
 * @returns {Object} partial player update
 */
export function beginInjury(player, nowMs, severityOverride = null) {
  const severity   = severityOverride || _rollSeverity();
  const injuryType = _pickInjuryType(player);
  const days       = _rollILDays(severity);
  return {
    isInjured:      true,
    isResting:      false,
    injuryPenalty:  { subRating: injuryType.affectedSR, amount: _penaltyForSeverity(severity) },
    injuryReport:   _generateInjuryReport(player, injuryType, severity, days, nowMs),
    _act2Variance:  _rollAct2Variance(severity),
    _pendingILReturn: false,
    injury: {
      status:     'evaluating',
      typeId:     injuryType.id,
      label:      injuryType.label || 'Injury',
      severity,
      days,
      injuredAt:  nowMs,
      returnAt:   null,
      eligibleAt: null,
      diagnosed:  false,
    },
  };
}

/**
 * confirmDiagnosis(player, nowMs)
 * Act 2: the exam revises the on-field read (better / confirmed / worse).
 * Idempotent — a diagnosed injury is returned unchanged.
 * @returns {Object} partial player update ({ injury, injuryReport })
 */
export function confirmDiagnosis(player, nowMs) {
  const inj = player.injury;
  if (!inj || inj.diagnosed) return {};
  const v    = player._act2Variance || 'confirmed';
  const mult = v === 'better' ? INJURY_ACT2_BETTER_MULT : v === 'worse' ? INJURY_ACT2_WORSE_MULT : 1;
  const days = inj.severity === 'season' ? inj.days : Math.max(2, Math.round(inj.days * mult));
  const type = INJURY_TYPES.find(t => t.id === inj.typeId) || { label: inj.label };
  return {
    injury:       { ...inj, days, diagnosed: true },
    injuryReport: _generateInjuryReport(player, type, inj.severity, days, nowMs ?? inj.injuredAt),
  };
}

/** Minimum IL stay for this player (10-day hitters, 15-day pitchers). */
export function ilMinDays(player) {
  return ['SP', 'RP'].includes(player?.pos) ? IL_MIN_DAYS_PITCHER : IL_MIN_DAYS_HITTER;
}

/** True when the physician will allow day-to-day management. */
export function dayToDayAllowed(player) {
  const inj = player?.injury;
  return !!inj && inj.severity !== 'season' && inj.days <= INJURY_DTD_MAX_DAYS;
}

/**
 * placeOnILUpdate(player)
 * IL placement, backdated to the injury. Eligible to return after
 * max(timeline, IL minimum) real days.
 */
export function placeOnILUpdate(player) {
  const inj  = player.injury || {};
  const days = Math.max(inj.days || 0, ilMinDays(player));
  return {
    group:  PLAYER_GROUP.IL,
    isInjured: true,
    injury: { ...inj, status: 'il', diagnosed: true, eligibleAt: (inj.injuredAt || 0) + days * MS_PER_DAY, returnAt: null },
  };
}

/** Day-to-day: stays on the active roster, unavailable until returnAt. */
export function dayToDayUpdate(player) {
  const inj = player.injury || {};
  return {
    isInjured: true,
    injury: { ...inj, status: 'dtd', diagnosed: true, returnAt: (inj.injuredAt || 0) + (inj.days || 0) * MS_PER_DAY, eligibleAt: null },
  };
}

/** Fully healed and available (day-to-day return, or IL activation). */
export function clearInjuryUpdate() {
  return { isInjured: false, injury: null, injuryPenalty: null, _pendingILReturn: false, _act2Variance: null };
}

// CPU GMs decide at once: short timelines are managed day-to-day, the rest
// go on the IL. (Their call-ups go through the same transaction clock.)
function _cpuDisposition(player) {
  const dx = { ...player, ...confirmDiagnosis(player, player.injury.injuredAt) };
  const half = Math.floor(INJURY_DTD_MAX_DAYS / 2);
  const choice = dx.injury.days <= half ? dayToDayUpdate(dx) : placeOnILUpdate(dx);
  return { injuryReport: dx.injuryReport, ...choice };
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

function _injuryProbability(player, role) {
  const age = computeAge(player.dob);

  let base = role === 'starter'  ? INJURY_PROB_SP_PER_START
           : role === 'reliever' ? INJURY_PROB_RP_PER_APP
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
  INJURY_SEASON_ENDING_DAYS,
  INJURY_DTD_MAX_DAYS,
  INJURY_ACT2_BETTER_MULT,
  INJURY_ACT2_WORSE_MULT,
  IL_MIN_DAYS_HITTER,
  IL_MIN_DAYS_PITCHER,
  };
  if (severity === 'season') return INJURY_SEASON_ENDING_DAYS;
  const [min, max] = ranges[severity] || INJURY_IL_DAYS_MINOR;
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

function _generateInjuryReport(player, injuryType, severity, ilDays, now) {
  const playerName  = player.name || 'Player';
  const label       = injuryType.label || 'injury';
  const weeksMin    = Math.ceil(ilDays / 7);
  const weeksMax    = weeksMin + (severity === 'minor' ? 1 : severity === 'moderate' ? 2 : 3);

  return {
    generatedAt:  now,
    vagueText:    `${playerName} — upper body injury. Day-to-day.`,
    generalText:  `${playerName} — ${label.toLowerCase()}. Estimated ${weeksMin}–${weeksMax} weeks.`,
    detailedText: severity === 'season'
      ? `Grade ${_severityGrade(severity)} ${label.toLowerCase()}. ${_prognosisText(severity)}`
      : `Grade ${_severityGrade(severity)} ${label.toLowerCase()}. Targeting return in ${ilDays} days. ${_prognosisText(severity)}`,
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
