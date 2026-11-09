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
  INJURY_EXPOSURE,
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
} from '../data/constants.js';

import { computeAge, computeOVR, baseballYear } from './PlayerFactory.js';
import { dice, diceSeed, eventRand } from './Dice.js';
import { clockNow } from './Clock.js';

const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────
// GAME INJURIES — every team, real clock (§65)
// ─────────────────────────────────────────────────────────────

/**
 * injuriesFromPlays(state, plays, gameKey, { skip })
 * §118 Injuries happen during a game, on a play (SimEngine writes an `injury`
 * play with `_injury: { playerId }`): the player is hurt at that play's
 * moment. The same model for all ten teams — no hidden invincibility.
 *
 *   USER players  → status 'evaluating' (still on the active roster, not
 *                   available to play). CardEngine runs the two-act flow:
 *                   Act 1 (exam choice) → Act 2 (diagnosis: IL or day-to-day).
 *   CPU players   → diagnosed at once; the CPU GM picks IL or day-to-day.
 *
 * What the injury is (severity, type, days, how Act 2 turns out) comes from
 * the player's own stream for that game: dice(seed, 'injury', gameKey, id).
 *
 * @param {Object}   state
 * @param {Object[]} plays    — the game's plays (only `injury` plays count)
 * @param {String}   gameKey  — the game's identity (GameEngine._gameKey)
 * @param {Object}   [opts]   — { skip: Set of playerIds already applied }
 * @returns {{ players: Object, events: Object[] }}
 *          events: [{ type: 'INJURY', teamId, playerId, atMs }] — atMs: the play's moment
 */
export function injuriesFromPlays(state, plays, gameKey, { skip = new Set() } = {}) {
  if (!gameKey) throw new Error('InjuryEngine.injuriesFromPlays: gameKey is required (§118 seeded dice)');
  const seed    = diceSeed(state);
  const players = {};
  const events  = [];
  for (const play of plays || []) {
    const id = play._injury?.playerId;
    if (!id || skip.has(id) || players[id]) continue;
    const player = state.players[id];
    if (!player || player.isInjured || player.injury || player.group === PLAYER_GROUP.IL) continue;
    const atMs  = play._timestamp;
    const begun = beginInjury(player, atMs, null, dice(seed, 'injury', gameKey, id));
    begun.injury = { ...begun.injury, inning: play.inning ?? null };   // when in the game (the trainer's report says)
    players[id] = player.teamId === 'user' ? begun : { ...begun, ..._cpuDisposition({ ...player, ...begun }) };
    events.push({ type: 'INJURY', teamId: player.teamId, playerId: id, atMs });
  }
  return { players, events };
}

/**
 * injuryChancePerExposure(player, role, seasonYear, tired)
 * §118 The chance of getting hurt on one plate appearance (a hitter) or one
 * batter faced (a pitcher): the per-game chance spread over a typical game's
 * exposure (INJURY_EXPOSURE), so a full game carries what it always did.
 * @param {Object}  player
 * @param {String}  role — 'hitter' | 'starter' | 'reliever'
 * @param {Number}  seasonYear — for the player's age
 * @param {Boolean} [tired] — a pitcher past his stamina
 * @returns {Number}
 */
export function injuryChancePerExposure(player, role, seasonYear, tired = false) {
  const p = _injuryProbability(player, role, seasonYear, tired);
  const n = role === 'starter' ? INJURY_EXPOSURE.starterBF : role === 'reliever' ? INJURY_EXPOSURE.relieverBF : INJURY_EXPOSURE.hitterPA;
  return 1 - Math.pow(1 - p, 1 / n);
}

/**
 * beginInjury(player, nowMs, severityOverride?, rand)
 * The moment a player gets hurt: unavailable at once, still occupying his
 * active-roster spot until the GM decides (status 'evaluating').
 * @param {Function} rand — §118 the injury's Dice stream (severity, type, days, how Act 2 turns out)
 * @returns {Object} partial player update
 */
export function beginInjury(player, nowMs, severityOverride = null, rand) {
  if (typeof rand !== 'function') throw new Error('InjuryEngine.beginInjury: rand (a Dice stream) is required');
  const severity   = severityOverride || _rollSeverity(rand);
  const injuryType = _pickInjuryType(player, rand);
  const days       = _rollILDays(severity, rand);
  return {
    isInjured:      true,
    isResting:      false,
    injuryPenalty:  { subRating: injuryType.affectedSR, amount: _penaltyForSeverity(severity) },
    injuryReport:   _generateInjuryReport(player, injuryType, severity, days, nowMs),
    _act2Variance:  _rollAct2Variance(severity, rand),
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
    // §114 a bullpen arm's spot is the group itself: remember it on the way to
    // the IL (a lineup slot or a rotation turn is remembered by reconcileRoster).
    ...(player.group === PLAYER_GROUP.BULLPEN && player.teamId === 'user' && !player._lostSlot
      ? { _lostSlot: { kind: 'bullpen', atMs: inj.injuredAt ?? null } } : {}),
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
 * @param {Number} now               — Unix ms (defaults to clockNow())
 * @returns {Object} { text, isStale, staleDays }
 */
export function getInjuryReport(player, requestingTeamId, gmRelationship = 50, now = clockNow()) {
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

// ─────────────────────────────────────────────────────────────
// FARM ARC ASSIGNMENT
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _injuryProbability(player, role, seasonYear, tired = false) {
  const age = computeAge(player.dob, seasonYear);

  let base = role === 'starter'  ? INJURY_PROB_SP_PER_START
           : role === 'reliever' ? INJURY_PROB_RP_PER_APP
           : INJURY_PROB_HITTER_PER_GAME;

  // Age modifier
  if (age >= 35) base += INJURY_AGE_MOD_35_PLUS;
  else if (age >= 32) base += INJURY_AGE_MOD_32_34;

  // A pitcher working past his stamina
  if (tired) base += INJURY_FATIGUE_MOD;

  return Math.min(base, 0.10); // hard cap at 10% per game
}

function _rollSeverity(rand) {
  const r = rand();
  if (r < INJURY_SEVERITY_MINOR_PROB)                                     return 'minor';
  if (r < INJURY_SEVERITY_MINOR_PROB + INJURY_SEVERITY_MODERATE_PROB)    return 'moderate';
  if (r < INJURY_SEVERITY_MINOR_PROB + INJURY_SEVERITY_MODERATE_PROB
        + INJURY_SEVERITY_SIGNIFICANT_PROB)                               return 'significant';
  return 'season';
}

function _pickInjuryType(player, rand) {
  const isPitcher = ['SP','RP'].includes(player.pos);
  const isRP      = player.pos === 'RP';
  const group     = isRP ? 'reliever' : isPitcher ? 'pitcher' : 'hitter';

  const eligible = INJURY_TYPES.filter(t =>
    t.group === group || (group === 'reliever' && t.group === 'pitcher')
  );
  return eligible[Math.floor(rand() * eligible.length)] || INJURY_TYPES[0];
}

function _rollILDays(severity, rand) {
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
  return min + Math.floor(rand() * (max - min + 1));
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

function _rollAct2Variance(severity, rand) {
  // Sometimes better (sprain not a tear), sometimes worse (stress fracture found)
  const r = rand();
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

