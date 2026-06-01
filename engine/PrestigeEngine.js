/**
 * engine/PrestigeEngine.js
 * Prestige score accumulation, tier advancement, All-Star hosting eligibility,
 * and the Franchise Legend win condition.
 *
 * Prestige is earned permanently — score never decreases. Bad seasons affect
 * ownership patience and financial parameters (handled by GameEngine),
 * but not prestige.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - computeSeasonPrestige() is the single entry point called at SEASON_SUMMARY.
 *   - Tier advancement is detected here and returned as an event for CardEngine.
 *   - Franchise Legend trigger returns an event — UI and card generation elsewhere.
 *
 * Section references: Section 18 (prestige system), Section 19 (All-Star hosting),
 *   Section 18.5 (Franchise Legend win condition)
 */

import {
  PRESTIGE_POINTS_PER_WIN,
  PRESTIGE_POINTS_WINNING_SEASON,
  PRESTIGE_WINNING_WIN_THRESHOLD,
  PRESTIGE_POINTS_PLAYOFF_APPEARANCE,
  PRESTIGE_POINTS_PER_PLAYOFF_ROUND_WON,
  PRESTIGE_POINTS_CHAMPIONSHIP,
  PRESTIGE_POINTS_ALLSTAR_HOST,
  PRESTIGE_POINTS_TURNING_POINT,
  PRESTIGE_POINTS_WIN_TARGET_MET,
  PRESTIGE_POINTS_WIN_TARGET_EXCEEDED,
  PRESTIGE_TIER_THRESHOLDS,
  PRESTIGE_TIER_NAMES,
  PRESTIGE_TIER_WIN_TARGET_BUMP,
  ALLSTAR_HOSTING_REVENUE_BONUS_MIN,
  ALLSTAR_HOSTING_REVENUE_BONUS_MAX,
  WIN_TARGET_MET_WITHIN,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY — SEASON SUMMARY PRESTIGE CALCULATION
// ─────────────────────────────────────────────────────────────

/**
 * computeSeasonPrestige(state, seasonResult)
 * Calculates prestige points earned this season and returns:
 *   - Updated prestigeScore and prestigeTier
 *   - A tier advancement event (if tier changed)
 *   - A Franchise Legend trigger event (if conditions met)
 *   - A prestige history entry
 *
 * @param {Object} state
 * @param {Object} seasonResult  — { wins, losses, playoffRoundsWon, wonChampionship,
 *                                   hostedAllStar, turningPointAchieved, winTargetMet,
 *                                   winTargetExceededBy }
 * @returns {Object} { mutations, events }
 */
export function computeSeasonPrestige(state, seasonResult) {
  const {
    wins                 = state.userTeam.wins   || 0,
    losses               = state.userTeam.losses || 0,
    playoffRoundsWon     = 0,
    wonChampionship      = false,
    hostedAllStar        = false,
    turningPointAchieved = false,
    winTargetMet         = false,
    winTargetExceededBy  = 0,
  } = seasonResult;

  const previousScore = state.prestigeScore || 0;
  const previousTier  = state.prestigeTier  || 1;
  const seasonNum     = state.seasonNum;
  const breakdown     = [];

  // ── Points accumulation ─────────────────────────────────
  let points = 0;

  const winPoints = wins * PRESTIGE_POINTS_PER_WIN;
  points += winPoints;
  if (winPoints > 0) breakdown.push({ reason: `${wins} wins`, points: winPoints });

  if (wins >= PRESTIGE_WINNING_WIN_THRESHOLD) {
    points += PRESTIGE_POINTS_WINNING_SEASON;
    breakdown.push({ reason: 'Winning season bonus', points: PRESTIGE_POINTS_WINNING_SEASON });
  }

  const inPlayoffs = playoffRoundsWon > 0 || wonChampionship;
  if (inPlayoffs) {
    points += PRESTIGE_POINTS_PLAYOFF_APPEARANCE;
    breakdown.push({ reason: 'Playoff appearance', points: PRESTIGE_POINTS_PLAYOFF_APPEARANCE });
  }

  if (playoffRoundsWon > 0) {
    const roundPoints = playoffRoundsWon * PRESTIGE_POINTS_PER_PLAYOFF_ROUND_WON;
    points += roundPoints;
    breakdown.push({ reason: `${playoffRoundsWon} playoff round(s) won`, points: roundPoints });
  }

  if (wonChampionship) {
    points += PRESTIGE_POINTS_CHAMPIONSHIP;
    breakdown.push({ reason: 'Championship', points: PRESTIGE_POINTS_CHAMPIONSHIP });
  }

  if (hostedAllStar) {
    points += PRESTIGE_POINTS_ALLSTAR_HOST;
    breakdown.push({ reason: 'All-Star Game hosted', points: PRESTIGE_POINTS_ALLSTAR_HOST });
  }

  if (turningPointAchieved) {
    points += PRESTIGE_POINTS_TURNING_POINT;
    breakdown.push({ reason: 'Franchise Turning Point', points: PRESTIGE_POINTS_TURNING_POINT });
  }

  if (winTargetMet) {
    points += PRESTIGE_POINTS_WIN_TARGET_MET;
    breakdown.push({ reason: 'Win target met', points: PRESTIGE_POINTS_WIN_TARGET_MET });
  }

  if (winTargetExceededBy >= 10) {
    points += PRESTIGE_POINTS_WIN_TARGET_EXCEEDED;
    breakdown.push({ reason: 'Win target exceeded by 10+', points: PRESTIGE_POINTS_WIN_TARGET_EXCEEDED });
  }

  const newScore = previousScore + points;
  const newTier  = _computeTier(newScore);

  // ── History entry ────────────────────────────────────────
  const historyEntry = {
    seasonNum,
    points,
    totalScore: newScore,
    tier:       newTier,
    breakdown,
    wins,
    losses,
    wonChampionship,
  };

  // ── Events ──────────────────────────────────────────────
  const events = [];

  // Tier advancement
  if (newTier > previousTier) {
    events.push({
      type:       'PRESTIGE_TIER_ADVANCED',
      fromTier:   previousTier,
      toTier:     newTier,
      fromName:   PRESTIGE_TIER_NAMES[previousTier] || '',
      toName:     PRESTIGE_TIER_NAMES[newTier]      || '',
      seasonNum,
    });
  }

  // Franchise Legend win condition (Section 18.5)
  if (newTier === 5 && wonChampionship && !state.franchiseLegendFired) {
    events.push({
      type:      'FRANCHISE_LEGEND',
      seasonNum,
      finalScore: newScore,
      tierName:   PRESTIGE_TIER_NAMES[5],
    });
  }

  // ── Mutations ────────────────────────────────────────────
  const mutations = {
    prestigeScore:   newScore,
    prestigeTier:    newTier,
    prestigeHistory: [...(state.prestigeHistory || []), historyEntry],
    franchiseLegendFired: state.franchiseLegendFired || events.some(e => e.type === 'FRANCHISE_LEGEND'),
  };

  // Adjust win target upward on tier advancement (Section 18.3)
  if (newTier > previousTier) {
    const bump = PRESTIGE_TIER_WIN_TARGET_BUMP[newTier] || 0;
    if (bump > 0) {
      mutations.userTeam = {
        _ownerWinTarget: (state.userTeam._ownerWinTarget || 75) + bump,
      };
    }
  }

  return { mutations, events };
}

// ─────────────────────────────────────────────────────────────
// ALL-STAR HOSTING
// ─────────────────────────────────────────────────────────────

/**
 * evaluateAllStarHostingEligibility(state)
 * Checks whether the user team is eligible to host the All-Star Game
 * next season. Returns eligibility status and blocking reasons.
 *
 * Eligibility rules (Section 19.2):
 *   - Minimum Tier 2 for first hosting
 *   - Minimum Tier 3 for second hosting (3+ seasons since last)
 *   - Minimum Tier 5 for third hosting (4+ seasons since last)
 *   - atmosphere >= 65 required for any hosting bid
 *   - operatingBudget >= ALLSTAR_MIN_BUDGET for hosting costs
 *
 * @param {Object} state
 * @returns {Object} { eligible, reasons, tier, nextEligibleSeason }
 */
export function evaluateAllStarHostingEligibility(state) {
  const tier          = state.prestigeTier || 1;
  const hostedCount   = state.allStarHostedCount || 0;
  const lastHosted    = state.allStarLastHostedSeason || 0;
  const currentSeason = state.seasonNum;
  const atmosphere    = state.userTeam?.atmosphere || 50;
  const reasons       = [];

  // Tier requirement
  const tierRequired = hostedCount === 0 ? 2 : hostedCount === 1 ? 3 : 5;
  if (tier < tierRequired) {
    reasons.push(`Prestige Tier ${tierRequired} required (currently Tier ${tier})`);
  }

  // Cooldown
  const cooldownRequired = hostedCount === 0 ? 0 : hostedCount === 1 ? 3 : 4;
  const seasonsSinceLast = currentSeason - lastHosted;
  if (lastHosted > 0 && seasonsSinceLast < cooldownRequired) {
    const waitSeasons = cooldownRequired - seasonsSinceLast;
    reasons.push(`Must wait ${waitSeasons} more season(s) since last hosting`);
  }

  // Atmosphere
  if (atmosphere < 65) {
    reasons.push(`Stadium atmosphere must be 65+ (currently ${atmosphere})`);
  }

  const eligible = reasons.length === 0;

  return {
    eligible,
    reasons,
    tier,
    hostedCount,
    tierRequired,
    nextEligibleSeason: eligible ? currentSeason + 1 : null,
  };
}

/**
 * applyAllStarHostingRevenue(state)
 * Calculates and returns the revenue bonus from hosting the All-Star Game.
 * Scaled by atmosphere and prestige tier.
 *
 * @param {Object} state
 * @returns {Object} { revenueBonus, mutations }
 */
export function applyAllStarHostingRevenue(state) {
  const atmosphere = state.userTeam?.atmosphere || 50;
  const tier       = state.prestigeTier || 1;

  // Base range from constants, scaled by atmosphere (0.5–1.0 modifier)
  const atmosMod = 0.5 + (atmosphere / 200); // 0.50 at atmo=0, 1.0 at atmo=100
  const tierMod  = 0.8 + (tier * 0.04);      // 0.84 at Tier 1, 1.0 at Tier 5

  const base    = ALLSTAR_HOSTING_REVENUE_BONUS_MIN;
  const range   = ALLSTAR_HOSTING_REVENUE_BONUS_MAX - ALLSTAR_HOSTING_REVENUE_BONUS_MIN;
  const revenue = Math.round(base + range * atmosMod * tierMod);

  const mutations = {
    allStarHostedCount:     (state.allStarHostedCount || 0) + 1,
    allStarLastHostedSeason: state.seasonNum,
    allStarHostingScore:    (state.allStarHostingScore || 0) + revenue,
    userTeam: {
      finances: {
        revenue: (state.userTeam?.finances?.revenue || 0) + revenue,
      },
    },
  };

  return { revenueBonus: revenue, mutations };
}

// ─────────────────────────────────────────────────────────────
// FRANCHISE TURNING POINT
// ─────────────────────────────────────────────────────────────

/**
 * checkTurningPointEligibility(state)
 * Franchise Turning Point is a one-time event for Ember and Lab archetypes
 * that achieve something extraordinary — winning a championship or reaching
 * Tier 5 from a Tier 1 start. (Section 18.5)
 *
 * @param {Object} state
 * @returns {Boolean}
 */
export function checkTurningPointEligibility(state) {
  if (state.turningPointFired) return false;
  if (!['ember','lab'].includes(state.archetype)) return false;

  const tier            = state.prestigeTier || 1;
  const wonChampionship = state.seasonHistory?.some(h => h.wonChampionship);
  const startedAtTier1  = true; // ember and lab always start at Tier 1

  return startedAtTier1 && (tier >= 5 || wonChampionship);
}

/**
 * applyTurningPoint(state)
 * Marks the turning point as fired and returns mutations.
 * The actual card generation is handled by CardEngine.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function applyTurningPoint(state) {
  return {
    turningPointFired: true,
  };
}

// ─────────────────────────────────────────────────────────────
// PRESTIGE DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * getTierName(tier)
 * Returns the display name for a prestige tier.
 *
 * @param {Number} tier  — 1–5
 * @returns {String}
 */
export function getTierName(tier) {
  return PRESTIGE_TIER_NAMES[tier] || PRESTIGE_TIER_NAMES[1];
}

/**
 * getTierProgress(prestigeScore)
 * Returns progress within the current tier as a 0–1 fraction.
 * Used for progress bar display on the prestige screen.
 *
 * @param {Number} prestigeScore
 * @returns {Object} { tier, tierName, progress, currentThreshold, nextThreshold, pointsToNext }
 */
export function getTierProgress(prestigeScore) {
  const tier              = _computeTier(prestigeScore);
  const currentThreshold  = PRESTIGE_TIER_THRESHOLDS[tier - 1] || 0;
  const nextThreshold     = PRESTIGE_TIER_THRESHOLDS[tier]      || null;

  let progress      = 1.0;
  let pointsToNext  = 0;

  if (nextThreshold !== null) {
    const span    = nextThreshold - currentThreshold;
    const within  = prestigeScore - currentThreshold;
    progress      = span > 0 ? Math.min(1, within / span) : 1;
    pointsToNext  = Math.max(0, nextThreshold - prestigeScore);
  }

  return {
    tier,
    tierName:          PRESTIGE_TIER_NAMES[tier] || '',
    progress:          Math.round(progress * 100) / 100,
    currentThreshold,
    nextThreshold,
    pointsToNext,
    isMaxTier:         tier >= PRESTIGE_TIER_NAMES.length - 1,
  };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _computeTier(score) {
  let tier = 1;
  for (let i = PRESTIGE_TIER_THRESHOLDS.length - 1; i >= 1; i--) {
    if (score >= PRESTIGE_TIER_THRESHOLDS[i]) {
      tier = i + 1;
      break;
    }
  }
  return Math.min(tier, PRESTIGE_TIER_NAMES.length - 1);
}
