/**
 * engine/PlayerFactory.js
 * Player creation, OVR computation, and sub-rating generation.
 *
 * Rules:
 *   - Pure functions only. No state reads or writes.
 *   - computeOVR() is the single place OVR is ever calculated.
 *     Engines that need OVR call this — they never compute it inline.
 *   - createPlayer() is the single entry point for all player creation.
 *     League rosters, user rosters, and farm systems all use this.
 */

import {
  SUB_RATING_MIN,
  SUB_RATING_MAX,
  SUB_RATING_SPREAD,
  SUB_RATING_STRENGTH_BIAS,
  SUB_RATING_WEAKNESS_BIAS,
  OVR_H_CONTACT_WEIGHT,
  OVR_H_POWER_WEIGHT,
  OVR_H_SPEED_WEIGHT,
  OVR_P_STUFF_WEIGHT,
  OVR_P_CONTROL_WEIGHT,
  OVR_P_STAMINA_WEIGHT,
  GM_RELATIONSHIP_DEFAULT,
  PLAYER_GROUP,
  SALARY_BY_OVR,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// OVR COMPUTATION — single source of truth
// ─────────────────────────────────────────────────────────────

/**
 * computeOVR(subRatings)
 * Derives OVR from sub-ratings. Always called after any sub-rating change.
 * Never set OVR directly — always go through this function.
 *
 * Accounts for active injury penalty if present on the player object.
 *
 * @param {Object} subRatings   — { contact, power, speed } or { stuff, control, stamina }
 * @param {Object|null} injuryPenalty — { subRating: String, amount: Number } or null
 * @returns {Number} OVR clamped to SUB_RATING_MIN–SUB_RATING_MAX
 */
export function computeOVR(subRatings, injuryPenalty = null) {
  // Apply injury penalty to a working copy
  const sr = { ...subRatings };
  if (injuryPenalty && injuryPenalty.subRating && injuryPenalty.amount) {
    const key = injuryPenalty.subRating;
    if (sr[key] !== null && sr[key] !== undefined) {
      sr[key] = Math.max(SUB_RATING_MIN, sr[key] - injuryPenalty.amount);
    }
  }

  const isPitcher = sr.stuff !== null && sr.stuff !== undefined;

  let raw;
  if (isPitcher) {
    raw = (sr.stuff   * OVR_P_STUFF_WEIGHT)
        + (sr.control * OVR_P_CONTROL_WEIGHT)
        + (sr.stamina * OVR_P_STAMINA_WEIGHT);
  } else {
    raw = (sr.contact * OVR_H_CONTACT_WEIGHT)
        + (sr.power   * OVR_H_POWER_WEIGHT)
        + (sr.speed   * OVR_H_SPEED_WEIGHT);
  }

  return clamp(Math.round(raw), SUB_RATING_MIN, SUB_RATING_MAX);
}

// ─────────────────────────────────────────────────────────────
// PLAYER CREATION
// ─────────────────────────────────────────────────────────────

/**
 * createPlayer(config)
 * Creates a complete PlayerObject. All fields populated — no undefined values.
 *
 * config shape:
 * {
 *   id:          String,    // UUID — caller supplies (use crypto.randomUUID())
 *   name:        String,    // Full name
 *   pos:         String,    // Starting position
 *   group:       String,    // PLAYER_GROUP constant
 *   hand:        String|null, // 'R'|'L' — pitchers only, null for hitters
 *   targetOvr:   Number,    // The OVR to generate sub-ratings around (40–99)
 *   ageMin:      Number,    // Minimum age for DOB generation
 *   ageMax:      Number,    // Maximum age for DOB generation
 *   seasonNum:   Number,    // Current season number (for contract expiry calc)
 *   contractLengthOverride?: Number, // Optional fixed contract length (1–4)
 *   teamId:      String|null,
 * }
 *
 * @param {Object} config
 * @returns {Object} Complete PlayerObject
 */
export function createPlayer(config) {
  const {
    id,
    name,
    pos,
    group,
    hand = null,
    targetOvr,
    ageMin,
    ageMax,
    seasonNum = 1,
    contractLengthOverride = null,
    teamId = null,
  } = config;

  const isPitcher = _isPitcherGroup(group);
  const dob       = _generateDob(ageMin, ageMax);
  const age       = computeAge(dob);
  const trait     = _generateTrait(age, targetOvr);

  // Generate sub-ratings around targetOvr
  const subRatings = _generateSubRatings(targetOvr, isPitcher);

  // OVR derived from sub-ratings — never set directly
  const ovr = computeOVR(subRatings);

  const contractLength = contractLengthOverride ?? _generateContractLength(ovr, group);
  const contractSalary = _generateSalary(ovr);

  const stats       = _freshStats(isPitcher);
  const springStats = _freshStats(isPitcher);
  const careerStats = _freshCareerStats(isPitcher, ovr, seasonNum);

  return {
    // Identity
    id,
    name,
    pos,
    nativePos:  pos,
    group,
    hand:       isPitcher ? (hand || 'R') : null,
    dob,

    // Ratings
    ovr,
    subRatings,
    injuryPenalty: null,

    // GM relationship
    gmRelationship:       GM_RELATIONSHIP_DEFAULT,
    _previouslyWithOrg:   false,

    // Contract
    contractSalary,
    contractYears:        contractLength,
    contractExpiry:       seasonNum + contractLength,
    contractExtended:     false,
    contractExpired:      false,          // set true when contractExpiry <= seasonNum
    _contractExpiringNext: false,         // set true when contractExpiry === seasonNum + 1

    // Trait
    trait,

    // Status flags
    isInjured:        false,
    isSuspended:      false,
    isResting:        false,
    isTraining:       false,
    onPersonalLeave:  false,
    onWaivers:        false,
    _pendingDeparture:false,

    // IL tracking
    ilReturnGame: null,

    // Stats
    stats,
    springStats,
    careerStats,

    // Per-game stat log for IMP rolling windows (Section 30.2)
    // Entries trimmed to last 30 days by IMPEngine after each game.
    // Each entry: { gameIndex: Number, date: String, stats: Object }
    _impGameLog: [],

    // Tier (Section 20.1) — 'active'|'waivers'|'farm'|'retired'
    // Source of truth for which system owns this player right now.
    // Distinct from group (which describes roster slot within a tier).
    tier: _initialTier(group),

    // Waiver tracking
    waiverStartTime: null,   // Unix ms — set when placed on waivers, cleared on claim/clear

    // Injury report (Section 21.3 — pre-generated at injury time, filtered by gmRelationship)
    injuryReport: null,   // { vagueText, detailedText, generatedAt } | null

    // Farm story arc (Section 20.4) — set at send-down, cleared at callup
    _farmArc:        null,   // 'motivation'|'decline'|'stable'|null
    _farmArcStart:   null,   // Unix ms — when arc began
    _farmArcOvrDelta: 0,     // cumulative OVR delta from arc (permanent on callup)

    // Ownership
    teamId,
  };
}

function _initialTier(group) {
  if (group === PLAYER_GROUP.PRACTICE_SQUAD) return 'farm';
  if (group === PLAYER_GROUP.IL)             return 'active'; // IL is still active tier
  // PITCHER_BENCH, STARTING_HITTERS, BENCH_HITTERS, STARTING_PITCHERS, BULLPEN = active
  return 'active';
}

// ─────────────────────────────────────────────────────────────
// SUB-RATING GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * _generateSubRatings(targetOvr, isPitcher)
 * Generates three sub-ratings around targetOvr with controlled variance.
 *
 * Algorithm:
 *   1. Each sub-rating starts at targetOvr + random(-SPREAD, +SPREAD)
 *   2. One sub-rating is designated the strength (+STRENGTH_BIAS)
 *   3. One sub-rating is designated the weakness (+WEAKNESS_BIAS, i.e. lower)
 *   4. All values clamped to [SUB_RATING_MIN, SUB_RATING_MAX]
 *   5. OVR computed from result must land close to targetOvr
 *      (the spread + bias values are tuned to keep drift within ~3 points)
 *
 * @param {Number} targetOvr
 * @param {Boolean} isPitcher
 * @returns {Object} subRatings
 */
function _generateSubRatings(targetOvr, isPitcher) {
  const keys = isPitcher
    ? ['stuff', 'control', 'stamina']
    : ['contact', 'power', 'speed'];

  // Pick distinct strength and weakness indices
  const strengthIdx = _rng(0, 2);
  let weaknessIdx;
  do { weaknessIdx = _rng(0, 2); } while (weaknessIdx === strengthIdx);

  const values = keys.map((_, i) => {
    let base = targetOvr + _rng(-SUB_RATING_SPREAD, SUB_RATING_SPREAD);
    if (i === strengthIdx) base += SUB_RATING_STRENGTH_BIAS;
    if (i === weaknessIdx) base += SUB_RATING_WEAKNESS_BIAS; // negative bias
    return clamp(Math.round(base), SUB_RATING_MIN, SUB_RATING_MAX);
  });

  // Build the sub-ratings object — inactive trio is null
  if (isPitcher) {
    return {
      stuff:   values[0],
      control: values[1],
      stamina: values[2],
      contact: null,
      power:   null,
      speed:   null,
    };
  } else {
    return {
      contact: values[0],
      power:   values[1],
      speed:   values[2],
      stuff:   null,
      control: null,
      stamina: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// STAT SHAPES
// ─────────────────────────────────────────────────────────────

export function _freshStats(isPitcher) {
  if (isPitcher) {
    return {
      g: 0, gs: 0, ip: 0, w: 0, l: 0,
      sv: 0, svo: 0, hld: 0, bs: 0, qs: 0,
      h_allowed: 0, hr_allowed: 0, er: 0,
      bb: 0, k: 0, hbp: 0,
    };
  }
  return {
    g: 0, ab: 0, h: 0, doubles: 0, hr: 0,
    rbi: 0, r: 0, bb: 0, k: 0,
    sb: 0, cs: 0, hbp: 0, tb: 0,
  };
}

function _freshCareerStats(isPitcher, ovr, seasonNum) {
  const base = _freshStats(isPitcher);
  return {
    ...base,
    seasons:    0,
    peakOvr:    ovr,
    peakSeason: seasonNum,
  };
}

// ─────────────────────────────────────────────────────────────
// TRAIT GENERATION
// ─────────────────────────────────────────────────────────────

function _generateTrait(age, ovr) {
  if (Math.random() > 0.40) return null;

  if (age >= 32) return 'veteran';
  if (age <= 23) return 'youngGun';

  const r = Math.random();
  if (ovr >= 70 && r < 0.25) return 'clubhouseLeader';
  if (r < 0.20) return 'volatile';
  if (age >= 26 && r < 0.50) return 'consistent';
  return null;
}

// ─────────────────────────────────────────────────────────────
// CONTRACT GENERATION
// ─────────────────────────────────────────────────────────────

function _generateContractLength(ovr, group) {
  const r = Math.random();
  if (group === PLAYER_GROUP.PRACTICE_SQUAD) {
    // Farm players always get short deals
    return r < 0.6 ? 1 : 2;
  }
  if (ovr >= 80) return r < 0.15 ? 1 : r < 0.55 ? 2 : r < 0.85 ? 3 : 4;
  if (ovr >= 65) return r < 0.28 ? 1 : r < 0.72 ? 2 : 3;
  return r < 0.50 ? 1 : r < 0.85 ? 2 : 3;
}

function _generateSalary(ovr) {
  // Returns salary in $K — display via formatMoney() in ui/formatters.js
  // Tiers defined in SALARY_BY_OVR constant
  for (const tier of Object.values(SALARY_BY_OVR)) {
    if (ovr >= tier.ovrMin && ovr <= tier.ovrMax) {
      return _rng(tier.salMin, tier.salMax);
    }
  }
  // Fallback for edge cases
  return _rng(20, 80);
}

// ─────────────────────────────────────────────────────────────
// DOB / AGE HELPERS
// ─────────────────────────────────────────────────────────────

function _generateDob(ageMin, ageMax) {
  const now        = new Date();
  const ageYears   = _rng(ageMin, ageMax);
  const birthYear  = now.getFullYear() - ageYears;
  const birthMonth = _rng(1, 12);
  const birthDay   = _rng(1, 28);
  return `${birthYear}-${String(birthMonth).padStart(2,'0')}-${String(birthDay).padStart(2,'0')}`;
}

export function computeAge(dob) {
  if (!dob) return 27;
  const birth = new Date(dob);
  const now   = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _isPitcherGroup(group) {
  return group === PLAYER_GROUP.STARTING_PITCHERS
      || group === PLAYER_GROUP.BULLPEN
      || group === PLAYER_GROUP.PRACTICE_SQUAD; // farm pitchers
}

/** Integer random inclusive [lo, hi] */
function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Expose for tests
export { _generateSubRatings, _generateContractLength, _generateSalary };
