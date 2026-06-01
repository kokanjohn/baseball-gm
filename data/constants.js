/**
 * data/constants.js
 * All mechanical values, enums, and configuration constants.
 * No logic. No state references. Importable anywhere.
 *
 * Source of truth for: wiki documentation, tuning, difficulty (via archetypes).
 * Every numeric value in engine code that isn't derived from state must come from here.
 */

// ─────────────────────────────────────────────────────────────
// PUSH / NOTIFICATION INFRASTRUCTURE (confirmed, do not change without updating Cloudflare)
// ─────────────────────────────────────────────────────────────

export const PUSH_WORKER_URL  = 'https://baseball-gm-push.baseball-gm.workers.dev';
export const VAPID_PUBLIC_KEY = 'BPdBTqb92Gueg4-arpvFMQjD0rqcIABMYcIV7VAUbwepbsffrN-1YR8XfsjaYpZVX6qZ2Dvn30sp4H0_xNJzQCE';
export const FCM_SENDER_ID    = '157200420537';

// ─────────────────────────────────────────────────────────────
// SCHEMA VERSION
// ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────
// SEASON SCHEDULE ANCHORS
// ─────────────────────────────────────────────────────────────

export const SPRING_TRAINING_GAME_COUNT      = 20;
export const REGULAR_SEASON_GAME_COUNT       = 132;
export const ALL_STAR_BREAK_AFTER_GAME       = 66;
export const TRADE_DEADLINE_OPEN             = 88;  // game index (0-based) deadline window opens
export const TRADE_DEADLINE_CLOSE            = 92;  // game index (0-based) deadline window closes
export const ALLSTAR_ANNOUNCE_GAME_MIN       = 45;  // earliest game the ASG announcement can fire
export const ALLSTAR_ANNOUNCE_GAME_MAX       = 55;  // latest game the ASG announcement can fire
export const STRETCH_RUN_FINAL_GAMES         = 5;   // "final N games" milestone trigger

// ─────────────────────────────────────────────────────────────
// SEASON PHASES (state machine values — Section 5)
// ─────────────────────────────────────────────────────────────

export const PHASE = Object.freeze({
  SETUP:                 'SETUP',
  SPRING_TRAINING:       'SPRING_TRAINING',
  REGULAR_SEASON:        'REGULAR_SEASON',
  ALL_STAR_BREAK:        'ALL_STAR_BREAK',
  TRADE_DEADLINE:        'TRADE_DEADLINE',
  PLAYOFF_BRACKET_BUILD: 'PLAYOFF_BRACKET_BUILD',
  WILD_CARD:             'WILD_CARD',      // 1 game: 4th vs 5th in each division
  FIRST_ROUND:           'FIRST_ROUND',   // best of 3: 1st vs WC winner, 2nd vs 3rd
  DIVISION_SERIES:       'DIVISION_SERIES', // best of 5: first round winners
  WORLD_SERIES:          'WORLD_SERIES',  // best of 7: division champions
  SEASON_SUMMARY:        'SEASON_SUMMARY',
  OFFSEASON:             'OFFSEASON',
});

// ─────────────────────────────────────────────────────────────
// LIVE GAME TICK (Section 8.4 — LOCKED)
// App.js owns the one setInterval for the entire app lifecycle.
// 5 seconds between ticks — balances responsiveness with battery.
export const TICK_INTERVAL_MS = 5000;

// ─────────────────────────────────────────────────────────────
// GAME STATUS
// ─────────────────────────────────────────────────────────────

export const GAME_STATUS = Object.freeze({
  SCHEDULED:      'scheduled',
  PRE_GAME_WATCH: 'pre_game_watch',
  DELAYED:        'delayed',
  LIVE:           'live',
  SUSPENDED:      'suspended',
  POSTPONED:      'postponed',
  RESUMED:        'resumed',
  FINAL:          'final',
  MAKEUP:         'makeup',
});

// ─────────────────────────────────────────────────────────────
// GAME TIMES BY DAY OF WEEK (Section 28.3)
// ─────────────────────────────────────────────────────────────

export const GAME_TIMES_BY_DOW = Object.freeze({
  MON: ['7:05 PM'],
  TUE: ['7:05 PM'],
  WED: ['1:05 PM', '7:05 PM'],
  THU: ['1:05 PM', '7:05 PM'],
  FRI: ['7:05 PM'],
  SAT: ['1:05 PM', '4:05 PM', '7:05 PM'],
  SUN: ['1:05 PM', '4:05 PM'],
});

export const SPRING_TRAINING_FIRST_GAME_TIME = '1:05 PM';

// ─────────────────────────────────────────────────────────────
// PLAYER GROUPS (roster tier identifiers)
// ─────────────────────────────────────────────────────────────

export const PLAYER_GROUP = Object.freeze({
  STARTING_HITTERS: 'sh',
  BENCH_HITTERS:    'bh',
  STARTING_PITCHERS:'sp',
  BULLPEN:          'bp',
  PRACTICE_SQUAD:   'pp',   // farm/minors
  PITCHER_BENCH:    'pb',   // 2 SP bench + 2 RP bench (not on active rotation)
  IL:               'il',
});

// ─────────────────────────────────────────────────────────────
// ROSTER SIZE LIMITS
// ─────────────────────────────────────────────────────────────

// Regular season active roster: 28 players (LOCKED)
//   Hitters (14): 9 starters + 5 bench
//   Pitchers (14): 5 SP rotation + 5 RP bullpen + 2 SP bench + 2 RP bench
// Spring training roster: 38 players (28 active + 10 invitees: 5 hitters + 5 pitchers)
// Cuts before Opening Day: 10 (invitees return to farm, or waived if not optionable)
export const ROSTER_LIMITS = Object.freeze({
  STARTING_HITTERS:  9,
  BENCH_HITTERS:     5,
  STARTING_PITCHERS: 5,
  BULLPEN:           5,
  PITCHER_BENCH:     4,   // 2 SP bench + 2 RP bench
  ACTIVE_TOTAL:     28,
  SPRING_INVITEES:  10,   // 5 hitters + 5 pitchers invited to spring camp
  SPRING_TOTAL:     38,   // 28 active + 10 invitees

  // Farm composition caps (Section 20.3 — LOCKED)
  // Separate hitter/pitcher limits, not a single total
  FARM_HITTER_MAX:  12,
  FARM_PITCHER_MAX:  8,
  FARM_TOTAL:       20,   // FARM_HITTER_MAX + FARM_PITCHER_MAX
});

// Farm position minimums — overflow displacement must preserve these (Section 20.3)
export const FARM_HITTER_MIN_POSITIONS = Object.freeze(['C', 'CI', 'MI', 'OF']); // min 1 each
export const FARM_PITCHER_MIN_SP = 2;
export const FARM_PITCHER_MIN_RP = 2;

// ─────────────────────────────────────────────────────────────
// PLAYER TRAITS
// ─────────────────────────────────────────────────────────────

export const PLAYER_TRAIT = Object.freeze({
  VETERAN:          'veteran',
  YOUNG_GUN:        'youngGun',
  CLUBHOUSE_LEADER: 'clubhouseLeader',
  VOLATILE:         'volatile',
  CONSISTENT:       'consistent',
});

// ─────────────────────────────────────────────────────────────
// SUB-RATING GENERATION
// ─────────────────────────────────────────────────────────────

export const SUB_RATING_MIN            = 40;
export const SUB_RATING_MAX            = 99;
export const SUB_RATING_SPREAD         = 12;   // ±N from target OVR per sub-rating
export const SUB_RATING_STRENGTH_BIAS  =  8;   // added to the "strength" sub-rating
export const SUB_RATING_WEAKNESS_BIAS  = -8;   // added to the "weakness" sub-rating

// OVR weights — hitters
export const OVR_H_CONTACT_WEIGHT = 0.40;
export const OVR_H_POWER_WEIGHT   = 0.35;
export const OVR_H_SPEED_WEIGHT   = 0.25;

// OVR weights — pitchers
export const OVR_P_STUFF_WEIGHT   = 0.40;
export const OVR_P_CONTROL_WEIGHT = 0.35;
export const OVR_P_STAMINA_WEIGHT = 0.25;

// ─────────────────────────────────────────────────────────────
// PITCHER HANDEDNESS DISPLAY RULE (LOCKED — Section 10.2)
// Any time a pitcher is referenced by name in card text, their
// handedness is automatically appended by the CardEngine token resolver.
// Format: "(R)" or "(L)" — short form for mobile space efficiency.
// Example: {active_sp_name} → "Marcus Johnson (R)"
// Applies to all pitcher name tokens: active_sp_name, active_bp_name,
//   farm_pitcher_name, and any future pitcher-specific name tokens.
// Card authors never manually include handedness — the resolver enforces it.
// ─────────────────────────────────────────────────────────────

export const PITCHER_HAND_DISPLAY = Object.freeze({ R: '(R)', L: '(L)' });

// ─────────────────────────────────────────────────────────────
// PLAYER HANDS
// ─────────────────────────────────────────────────────────────

export const HAND = Object.freeze({ RIGHT: 'R', LEFT: 'L' });

// ─────────────────────────────────────────────────────────────
// CONTRACT DEFAULTS
// ─────────────────────────────────────────────────────────────

export const CONTRACT_MIN_YEARS  = 1;
export const CONTRACT_MAX_YEARS  = 4;
export const GM_RELATIONSHIP_DEFAULT          = 50;
export const GM_RELATIONSHIP_REACQUIRED_START = 45;  // re-acquired players start slightly lower

// ─────────────────────────────────────────────────────────────
// SIM ENGINE — AT-BAT RESOLUTION (Section 7.2 — LOCKED)
// ─────────────────────────────────────────────────────────────

// Hitter sub-rating → outcome formulas (all divide by these denominators)
export const SIM_H_CONTACT_HIT_DIVISOR      = 400;   // hit prob = contact / this
export const SIM_H_CONTACT_K_DIVISOR        = 300;   // K rate = (100-contact) / this
export const SIM_H_POWER_HR_DIVISOR         = 1800;  // HR prob = power / this
export const SIM_H_POWER_XBH_DIVISOR        = 600;   // XBH rate = power / this
export const SIM_H_SPEED_SB_THRESHOLD       = 65;    // speed above this → SB attempt eligible
export const SIM_H_SPEED_INFIELD_DIVISOR    = 2000;  // infield hit bonus = speed / this
export const SIM_H_SPEED_STRETCH_THRESHOLD  = 70;    // speed above this → stretch single to 3rd
export const SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD = 60; // speed above this → score from 1st on double
export const SIM_H_SPEED_TAG_THRESHOLD      = 75;    // speed above this → tag from 3rd on flyout

// Pitcher sub-rating → outcome formulas
export const SIM_P_STUFF_K_BONUS_DIVISOR    = 200;   // K bonus = (stuff-50) / this
export const SIM_P_STUFF_HIT_QUALITY_DIVISOR = 300;  // hit quality penalty = stuff / this
export const SIM_P_CONTROL_WALK_BASELINE    = 80;    // walk prob = (this - control) / 400
export const SIM_P_CONTROL_WALK_DIVISOR     = 400;
export const SIM_P_CONTROL_HBP_THRESHOLD    = 50;    // HBP rate elevated below this control value
export const SIM_P_STAMINA_INNINGS_DIVISOR  = 20;    // max IP = SIM_SP_INNINGS_BASE + floor(stamina/this)
export const SIM_P_FATIGUE_MULTIPLIER       = 1.8;   // fatigueThreshold = stamina × this (batters faced)

// Pitcher fatigue effects
export const SIM_P_FATIGUE_HIT_QUALITY_BONUS = 0.10; // +10% hit quality when fatigued
export const SIM_P_FATIGUE_K_PENALTY        = 0.15;  // −15% K rate when fatigued
export const SIM_P_FATIGUE_WALK_BONUS       = 0.10;  // +10% walk rate when fatigued

// gmRelationship variance multiplier (Section 22.5)
export const SIM_GM_REL_LOW_VARIANCE        = 0.15;  // ±15% variance below 30 gmRel
export const SIM_GM_REL_HIGH_CONSISTENCY    = 0.15;  // −15% variance above 80 gmRel
export const SIM_GM_REL_LOW_THRESHOLD       = 30;
export const SIM_GM_REL_HIGH_THRESHOLD      = 80;

// ─────────────────────────────────────────────────────────────
// SIM ENGINE — WIN PROBABILITY
// ─────────────────────────────────────────────────────────────

export const SIM_BASE_WIN_PROB            = 0.30;
export const SIM_OVR_DIFF_WEIGHT          = 0.010;  // per rating point differential
export const SIM_HITTER_OVR_WEIGHT        = 0.50;
export const SIM_SP_OVR_WEIGHT            = 0.30;
export const SIM_BP_OVR_WEIGHT            = 0.20;

// SP innings per outing formula: 4 + floor(pitchQuality(rating) × 2) + variance
export const SIM_SP_INNINGS_BASE          = 4;
export const SIM_SP_INNINGS_QUALITY_SCALE = 2;

// Live game tick
export const GAME_TICK_MS                 = 5000;   // 5 seconds per tick

// ─────────────────────────────────────────────────────────────
// PLAYOFF SIM ADJUSTMENTS (Section 26.4)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// PLAYOFF BRACKET STRUCTURE (Section 26 — LOCKED)
// ─────────────────────────────────────────────────────────────

// All 5 teams per division qualify. Bracket is division-contained until World Series.
// Seeding within each division: 1st through 5th by regular season record.
// Tiebreaker: head-to-head record (wiki-documented).
// #1 overall seed (best record in league) gets World Series home field.

export const PLAYOFF_WILD_CARD_GAMES        = 1;  // single elimination game (4th vs 5th)
export const PLAYOFF_FIRST_ROUND_BEST_OF    = 3;  // best of 3 (1st vs WC winner, 2nd vs 3rd)
export const PLAYOFF_DIVISION_SERIES_BEST_OF = 5; // best of 5 (first round winners)
export const PLAYOFF_WORLD_SERIES_BEST_OF   = 7;  // best of 7 (division champions)

export const PLAYOFF_HOME_FIELD_BONUS      = 0.035;
export const PLAYOFF_ACE_FREQUENCY         = 1.4;
export const PLAYOFF_VARIANCE_MULTIPLIER   = 1.2;

// Playoff roster expansion
export const PLAYOFF_ROSTER_EXPANSION_ROUND1          = 3;
export const PLAYOFF_ROSTER_EXPANSION_BETWEEN_ROUNDS  = 1;

// ─────────────────────────────────────────────────────────────
// TRADE ENGINE — CASH DIRECTION (Section 1.3, 6.4)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// FINANCIAL SCALE (LOCKED — all monetary values stored in $K)
// ─────────────────────────────────────────────────────────────
// Display via formatMoney(amountK) in ui/formatters.js:
//   < 1000K  → "$XXK"   (e.g. $350K)
//   >= 1000K → "$X.XM"  (e.g. $1.2M, $12M, $85M)
// ─────────────────────────────────────────────────────────────

// Salary ranges by OVR tier (in $K) [min, max]
export const SALARY_BY_OVR = Object.freeze({
  tier1: { ovrMin: 40, ovrMax: 49, salMin:    20, salMax:    80 },
  tier2: { ovrMin: 50, ovrMax: 54, salMin:    80, salMax:   150 },
  tier3: { ovrMin: 55, ovrMax: 59, salMin:   150, salMax:   300 },
  tier4: { ovrMin: 60, ovrMax: 64, salMin:   300, salMax:   600 },
  tier5: { ovrMin: 65, ovrMax: 69, salMin:   600, salMax:  1200 },
  tier6: { ovrMin: 70, ovrMax: 74, salMin:  1200, salMax:  2500 },
  tier7: { ovrMin: 75, ovrMax: 79, salMin:  2500, salMax:  5000 },
  tier8: { ovrMin: 80, ovrMax: 84, salMin:  5000, salMax: 10000 },
  tier9: { ovrMin: 85, ovrMax: 89, salMin: 10000, salMax: 18000 },
  tier10:{ ovrMin: 90, ovrMax: 99, salMin: 18000, salMax: 30000 },
});

// Card cost token ranges (in $K)
export const CARD_COST_XS      = { min:  10, max:   25 };  // broken pipe, minor supply
export const CARD_COST_SM      = { min:  25, max:   75 };  // specialist, consultant
export const CARD_COST_CAPPED  = { min:  50, max:  150 };  // community event, field work
export const CARD_COST_LG      = { min: 150, max:  400 };  // stadium renovation section
export const CARD_COST_EXT     = { min: 200, max:  500 };  // contract extension fee

// Trade cash — no cash in trades (Option C — locked)
// Trade fairness communicated via fairness rating, not cash exchange
export const TRADE_CASH_ENABLED = false;

// ─────────────────────────────────────────────────────────────
// SIM ENGINE — WEATHER WIN PROBABILITY ADJUSTMENTS (Section 7.1 — LOCKED)
// ─────────────────────────────────────────────────────────────

export const SIM_WEATHER_ADJ = Object.freeze({
  Clear:    0.00,
  Overcast: -0.01,
  Hot:      +0.02,
  Cold:     -0.02,
  Rain:     -0.03,
  Storm:    -0.05,
});

// Home field advantage (added to win prob for home games)
export const SIM_HOME_FIELD_BONUS = 0.04;

// Win prob clamp bounds — no team ever guaranteed to win or lose
export const SIM_WIN_PROB_MIN = 0.20;
export const SIM_WIN_PROB_MAX = 0.80;

// ─────────────────────────────────────────────────────────────
// WEATHER — BUFFER & THRESHOLDS
// ─────────────────────────────────────────────────────────────

export const WEATHER_BUFFER_HOURS_FREE    = 48;
export const WEATHER_BUFFER_HOURS_PREMIUM = 168;  // 7 days
export const WEATHER_BUFFER_REFRESH_AHEAD = 2;    // refresh when leading edge is within N hours

// Weather card expiry windows (real-world minutes)
export const WEATHER_CARD_EXPIRY_WATCH_MIN        = 30;
export const WEATHER_CARD_EXPIRY_DELAY_MIN         = 45;
export const WEATHER_CARD_EXPIRY_DELAY_EXT_MIN     = 20;
export const WEATHER_CARD_EXPIRY_POSTPONED_HOURS   = 24;

// Pre-game watch window (minutes before first pitch)
export const WEATHER_WATCH_WINDOW_HIGH_REL_MIN = 90;  // groundskeeperRelationship >= 70
export const WEATHER_WATCH_WINDOW_DEFAULT_MIN  = 60;

// Groundskeeper relationship thresholds
export const GROUNDSKEEPER_REL_HIGH    = 70;
export const GROUNDSKEEPER_REL_LOW     = 30;

// Weather auto-resolve penalties
export const WEATHER_IGNORE_WATCH_MORALE_PENALTY   = -1;
export const WEATHER_IGNORE_WATCH_ATMOS_PENALTY    = -1;
export const WEATHER_IGNORE_DELAY_MORALE_PENALTY   = -1;

// Weather postponement probability thresholds (Section 8.8 — LOCKED)
// Applied at first-pitch evaluation, 2 hours before game time.
// All values are named constants — no magic numbers in WeatherEngine logic.
export const WEATHER_PRECIP_LIGHT_MAX        = 0.29;  // intensity < 0.30 → play through
export const WEATHER_PRECIP_MODERATE_MIN     = 0.30;
export const WEATHER_PRECIP_MODERATE_MAX     = 0.59;
export const WEATHER_PRECIP_HEAVY_MIN        = 0.60;
export const WEATHER_PRECIP_HEAVY_MAX        = 0.89;
export const WEATHER_PRECIP_SEVERE_MIN       = 0.90;

export const WEATHER_DELAY_PROB_MODERATE     = 0.40;  // 40% delay chance
export const WEATHER_POSTPONE_PROB_MODERATE  = 0.10;  // 10% postpone chance
export const WEATHER_DELAY_PROB_HEAVY        = 0.80;
export const WEATHER_POSTPONE_PROB_HEAVY     = 0.35;
export const WEATHER_DELAY_PROB_SEVERE       = 0.15;  // brief window may open
export const WEATHER_POSTPONE_PROB_SEVERE    = 0.80;

// Temperature override thresholds
export const WEATHER_TEMP_AUTO_POSTPONE_F    = 35;    // below this + precip → postpone
export const WEATHER_TEMP_COLD_PRECIP_F      = 45;    // 35–45 + precip → +20% postpone prob
export const WEATHER_TEMP_COLD_POSTPONE_BONUS = 0.20;
export const WEATHER_TEMP_HEAT_F             = 95;    // above this → heat mode, no postpone

// Mid-game suspension threshold
export const WEATHER_SUSPEND_INTENSITY       = 0.80;  // intensity at or above this during live game
export const WEATHER_OFFICIAL_INNINGS        = 5;     // innings completed → game is official

// ─────────────────────────────────────────────────────────────
// GEOGRAPHIC REGIONS (Section 8.13 — Phase 13.5 — LOCKED)
// ─────────────────────────────────────────────────────────────
//
// Region is selected during setup (Step 2) and stored in state.settings.region.
// It is an abstract geographic concept — four options with flavor descriptions
// implying real geography without naming specific cities.
//
// What region affects:
//   - Weather postponement probability (multiplicative modifier on base prob)
//   - Weather buffer condition weights (season patterns differ by region)
//   - Travel fatigue modifier (applied to win probability on road trips)
//   - Groundskeeper card pool filter (region-appropriate maintenance issues)
//
// What region does NOT affect:
//   - Archetype, roster structure, finances, playoff format, or card mechanics.
//   - Region is atmosphere and modifier, not difficulty.

export const REGIONS = Object.freeze({
  north: {
    id:          'north',
    label:       'North',
    tagline:     'Cold springs, hard falls, loyal fans.',
    description: 'Frost risk in April and September. Dense geography means shorter road trips but brutal late-season weather. Experienced groundskeepers and better drainage keep games on the field.',
    // Weather: postponement probability multiplied by this factor
    postponeModifier:        0.75,
    // Weather: afternoon thunderstorm bonus (fraction added to delay probability)
    afternoonThunderstormBonus: 0.0,
    // Weather: +N°F offset from base temp generation (colder climate)
    tempOffset:              -12,
    // Travel: win probability penalty per consecutive road game beyond threshold
    travelFatiguePerGame:    0.002,
    travelFatigueThreshold:  4,    // fatigue begins after this many consecutive road games
    // Weather buffer: elevated cold/overcast weight in spring/fall
    coldSeasonWeightBonus:   0.20,
    // Groundskeeper card pool flavor tag (used to filter regional cards)
    groundskeeperFlavor:     'north',
  },
  south: {
    id:          'south',
    label:       'South',
    tagline:     'Heat, humidity, and afternoon storms.',
    description: 'Warm all season — no early or late cold risk. Afternoon thunderstorm pattern keeps the grounds crew busy. Heat impacts pitcher stamina late in the season.',
    postponeModifier:        1.00,  // baseline — no multiplier, but afternoon delay bonus applies
    afternoonThunderstormBonus: 0.15,
    tempOffset:              +10,
    travelFatiguePerGame:    0.002,
    travelFatigueThreshold:  4,
    coldSeasonWeightBonus:   0.0,
    groundskeeperFlavor:     'south',
  },
  east: {
    id:          'east',
    label:       'East',
    tagline:     'Coastal weather, consistent rain, dense schedule.',
    description: 'Highest rain frequency of any region. Coastal fog and persistent marine layer keep conditions unpredictable. The densest travel schedule in the game.',
    postponeModifier:        1.10,
    afternoonThunderstormBonus: 0.0,
    tempOffset:              0,
    travelFatiguePerGame:    0.0015,  // shorter hops — less fatigue
    travelFatigueThreshold:  4,
    coldSeasonWeightBonus:   0.0,
    groundskeeperFlavor:     'east',
  },
  west: {
    id:          'west',
    label:       'West',
    tagline:     'Dry air, wind, and the longest road trips.',
    description: 'Driest region — lowest postponement risk. Altitude at some venues carries the ball slightly further. Long road trips to the other coast are the real challenge.',
    postponeModifier:        0.65,
    afternoonThunderstormBonus: 0.0,
    tempOffset:              +3,
    travelFatiguePerGame:    0.003,   // longer road trips = more fatigue
    travelFatigueThreshold:  3,       // fatigue sets in earlier
    coldSeasonWeightBonus:   0.0,
    // Altitude scoring modifier — slight bonus to offense (ball carries)
    altitudeScoringBonus:    0.01,    // added to win probability when user is home
    groundskeeperFlavor:     'west',
  },
});

export const REGION_DEFAULT = 'north';

// ─────────────────────────────────────────────────────────────
// CARD SYSTEM — EXPIRY & TIMING
// ─────────────────────────────────────────────────────────────

export const CARD_EXPIRY_DEFAULT_GAMES   = 3;   // games until standard card expires
export const CARD_EXPIRY_URGENT_GAMES    = 1;   // urgent cards expire faster

// ─────────────────────────────────────────────────────────────
// SOFT METRICS — DEFAULTS & RANGES
// ─────────────────────────────────────────────────────────────

export const SOFT_METRIC_MIN         =   0;
export const SOFT_METRIC_MAX         = 100;
export const MORALE_DEFAULT          =  50;
export const ATMOSPHERE_DEFAULT      =  50;
export const OWNER_TRUST_DEFAULT     =  60;
export const MANAGER_CONF_DEFAULT    =  60;
export const FACILITIES_REL_DEFAULT  =  50;
export const TICKET_OFFICE_REL_DEFAULT = 50;

// ─────────────────────────────────────────────────────────────
// PRESTIGE TIER SYSTEM (Section 18)
// ─────────────────────────────────────────────────────────────

// Cumulative score thresholds for tier advancement [Tier0→1 baseline, 1→2, 2→3, 3→4, 4→5]
export const PRESTIGE_TIER_THRESHOLDS = Object.freeze([0, 150, 400, 800, 1400]);
// Index 0 = unused, index 1-5 = tier names
export const PRESTIGE_TIER_NAMES = Object.freeze([
  '',                       // 0 — unused
  'Cellar Dweller',         // 1
  'Fringe Contender',       // 2
  'Established Franchise',  // 3
  'Perennial Contender',    // 4
  'Dynasty',                // 5
]);

// Win target adjustment on tier advancement (Section 18.3)
export const PRESTIGE_TIER_WIN_TARGET_BUMP = Object.freeze({
  2: 5, 3: 7, 4: 8, 5: 10,
});

// Prestige score inputs
export const PRESTIGE_POINTS_PER_WIN                  =   1;
export const PRESTIGE_POINTS_WINNING_SEASON           =  15;   // bonus for > PRESTIGE_WINNING_WIN_THRESHOLD wins
export const PRESTIGE_WINNING_WIN_THRESHOLD           =  66;   // wins needed to count as a winning season
export const PRESTIGE_POINTS_PLAYOFF_APPEARANCE       =  25;
export const PRESTIGE_POINTS_PER_PLAYOFF_ROUND_WON    =  20;
export const PRESTIGE_POINTS_CHAMPIONSHIP             = 100;
export const PRESTIGE_POINTS_ALLSTAR_HOSTED           =  40;
export const PRESTIGE_POINTS_TURNING_POINT            =  30;
export const PRESTIGE_POINTS_WIN_TARGET_MET           =  10;
export const PRESTIGE_POINTS_WIN_TARGET_EXCEEDED      =  20;   // bonus for exceeding by 10+
export const PRESTIGE_WIN_TARGET_EXCEEDED_BY          =  10;   // wins above target needed for bonus

// Tier advancement one-time win target bumps (Section 25.2)
export const PRESTIGE_WIN_TARGET_BUMP_TIER_1_2 =  5;
export const PRESTIGE_WIN_TARGET_BUMP_TIER_2_3 =  7;
export const PRESTIGE_WIN_TARGET_BUMP_TIER_3_4 =  8;
export const PRESTIGE_WIN_TARGET_BUMP_TIER_4_5 = 10;

// ─────────────────────────────────────────────────────────────
// OWNERSHIP WIN TARGET ESCALATION (Section 25)
// ─────────────────────────────────────────────────────────────

// Annual adjustments based on last season's performance vs target
export const WIN_TARGET_ADJ_MISS_10_PLUS   = -3;
export const WIN_TARGET_ADJ_MISS_5_TO_9    = -2;
export const WIN_TARGET_ADJ_MISS_1_TO_4    = -1;
export const WIN_TARGET_ADJ_MET            =  1;
export const WIN_TARGET_ADJ_EXCEED_3_TO_7  =  3;
export const WIN_TARGET_ADJ_EXCEED_8_PLUS  =  5;
export const WIN_TARGET_MET_WITHIN         =  2;  // "within N wins" counts as met

// Archetype win target floors and ceilings
export const WIN_TARGET_FLOOR = Object.freeze({
  ember:       60,
  contender:   75,
  empire:      85,
  gambler:     65,
  lab:         65,
  institution: 72,
});

export const WIN_TARGET_CEILING = Object.freeze({
  ember:       88,
  contender:   95,
  empire:      98,
  gambler:     92,
  lab:         90,
  institution: 92,
});

// ─────────────────────────────────────────────────────────────
// ALL-STAR GAME HOSTING (Section 17)
// ─────────────────────────────────────────────────────────────

export const ALLSTAR_HOSTING_THRESHOLD_BASE   =  850;
export const ALLSTAR_HOSTING_THRESHOLD_SECOND = 1400;
export const ALLSTAR_HOSTING_THRESHOLD_THIRD  = 2200;  // dynasty-level

export const ALLSTAR_HOSTING_MIN_SEASONS_BETWEEN = 3;  // second hosting: min 3 seasons since last
export const ALLSTAR_HOSTING_MIN_SEASONS_THIRD   = 4;  // third hosting: min 4 seasons since last

export const ALLSTAR_HOSTING_REVENUE_BONUS_MIN   = 10000;  // $10M (in $K)
export const ALLSTAR_HOSTING_REVENUE_BONUS_MAX   = 15000;  // $15M (in $K)
export const ALLSTAR_HOSTING_ATMOS_BUMP          = 15;
export const ALLSTAR_HOSTING_OWNER_TRUST_BUMP    = 10;
export const ALLSTAR_HOSTING_GM_REL_BUMP         =  5;  // with all league teams

// ─────────────────────────────────────────────────────────────
// ARCHETYPE PARAMETERS (Section 16.6) — all $M
// ─────────────────────────────────────────────────────────────

// All monetary values in $K (thousands).
// Display formatter: formatMoney(amountK) in ui/formatters.js handles $K vs $M display.
export const ARCHETYPE = Object.freeze({
  ember: {
    id: 'ember',
    payrollCap:       8000,   // $8M
    operatingBudget:   500,   // $500K
    ownerTrustStart:  65,
    winTargetSeason1: 68,
    moraleStart:      52,
    atmosphereStart:  40,
    managerConfStart: 60,
    starterOvrMin:    52,
    starterOvrMax:    72,
    outcomeVariance:  'high',
    turningPointEligible: true,
  },
  contender: {
    id: 'contender',
    payrollCap:       22000,  // $22M
    operatingBudget:  1500,   // $1.5M
    ownerTrustStart:  60,
    winTargetSeason1: 88,
    moraleStart:      65,
    atmosphereStart:  68,
    managerConfStart: 65,
    starterOvrMin:    62,
    starterOvrMax:    80,
    outcomeVariance:  'medium',
    turningPointEligible: false,
  },
  empire: {
    id: 'empire',
    payrollCap:       35000,  // $35M
    operatingBudget:  2500,   // $2.5M
    ownerTrustStart:  55,
    winTargetSeason1: 95,
    moraleStart:      78,
    atmosphereStart:  82,
    managerConfStart: 70,
    starterOvrMin:    72,
    starterOvrMax:    90,
    outcomeVariance:  'low',
    turningPointEligible: false,
  },
  gambler: {
    id: 'gambler',
    payrollCap:       16000,  // $16M
    operatingBudget:  1250,   // $1.25M
    ownerTrustStart:  50,
    winTargetSeason1: null,    // randomized 72–88 at season start
    winTargetMin:     72,
    winTargetMax:     88,
    moraleStartMin:   45,
    moraleStartMax:   70,
    atmosphereStart:  55,
    managerConfStart: 55,
    starterOvrMin:    55,
    starterOvrMax:    88,
    outcomeVariance:  'very_high',
    turningPointEligible: false,
  },
  lab: {
    id: 'lab',
    payrollCap:       12000,  // $12M
    operatingBudget:    750,  // $750K
    ownerTrustStart:   70,
    winTargetSeason1:  78,
    moraleStart:       58,
    atmosphereStart:   45,
    managerConfStart:  62,
    starterOvrMin:     58,
    starterOvrMax:     76,
    outcomeVariance:   'medium',
    turningPointEligible: true,
  },
  institution: {
    id: 'institution',
    payrollCap:       18000,  // $18M
    operatingBudget:  1000,   // $1M
    ownerTrustStart:   60,
    winTargetSeason1:  82,
    moraleStart:       72,
    atmosphereStart:   75,
    managerConfStart:  68,
    starterOvrMin:     65,
    starterOvrMax:     82,
    outcomeVariance:   'low_medium',
    turningPointEligible: false,
  },
});

// ─────────────────────────────────────────────────────────────
// ARCHETYPE CARD WEIGHT MODIFIERS (Section 16.5)
// Values are multipliers: 1.0 = baseline, 1.4 = +40%, 0.6 = −40%
// ─────────────────────────────────────────────────────────────

export const ARCHETYPE_CARD_WEIGHTS = Object.freeze({
  ember:       { development: 1.4, scouting: 1.3, trade: 1.0, ownerPressure: 0.7, culture: 1.2 },
  contender:   { development: 1.0, scouting: 1.0, trade: 1.2, ownerPressure: 1.2, culture: 1.0 },
  empire:      { development: 0.8, scouting: 1.0, trade: 1.3, ownerPressure: 1.5, culture: 1.0 },
  gambler:     { development: 1.0, scouting: 1.1, trade: 1.4, ownerPressure: null, culture: 1.3 }, // ownerPressure = erratic
  lab:         { development: 1.6, scouting: 1.5, trade: 1.0, ownerPressure: 0.8, culture: 0.8 },
  institution: { development: 0.9, scouting: 1.0, trade: 0.8, ownerPressure: 1.0, culture: 1.3 },
});

// ─────────────────────────────────────────────────────────────
// ARCHETYPE GM RELATIONSHIP ADJUSTMENTS AT GAME START (Section 16.6)
// Applied on top of the universal default of 50
// ─────────────────────────────────────────────────────────────

export const ARCHETYPE_GM_REL_ADJUSTMENTS = Object.freeze({
  ember:       [],
  contender:   [{ amount: +15, count: 1 }, { amount: -10, count: 1 }],
  empire:      [{ amount: +20, count: 2 }],
  gambler:     [{ amount: +25, count: 1 }, { amount: -20, count: 2 }],
  lab:         [{ amount: -10, count: 3 }],
  institution: [{ amount: +15, count: 2 }, { amount: -15, count: 2 }],
});

// ─────────────────────────────────────────────────────────────
// LEAGUE STRUCTURE
// ─────────────────────────────────────────────────────────────

export const LEAGUE_TEAM_COUNT         = 10;
export const LEAGUE_DIVISION_COUNT     =  2;   // 'A' and 'B'
export const LEAGUE_TEAMS_PER_DIVISION =  5;
export const LEAGUE_TEAM_STR_MIN       = 0.45;
export const LEAGUE_TEAM_STR_MAX       = 0.57;

// Activity feed
export const ACTIVITY_FEED_RETENTION_HOURS = 72;

// Watchlist limits
export const WATCHLIST_LIMIT_FREE    =  5;
export const WATCHLIST_LIMIT_PREMIUM = 50;

// ─────────────────────────────────────────────────────────────
// SAVE SLOT LIMITS
// ─────────────────────────────────────────────────────────────

export const SAVE_SLOT_LIMIT_FREE    = 1;
export const SAVE_SLOT_LIMIT_PREMIUM = 6;

// ─────────────────────────────────────────────────────────────
// NOTIFICATION — QUIET HOURS & PREGAME
// ─────────────────────────────────────────────────────────────

export const NOTIFICATION_PREGAME_REMINDER_MIN = 30;   // minutes before first pitch
export const NOTIFICATION_QUIET_START_DEFAULT  = '22:00';
export const NOTIFICATION_QUIET_END_DEFAULT    = '08:00';

// ─────────────────────────────────────────────────────────────
// MILESTONE SCREENS (Section 27)
// ─────────────────────────────────────────────────────────────

export const MILESTONE_SCREENS = Object.freeze({
  SPRING_TRAINING: {
    id:           'SPRING_TRAINING',
    title:        'Spring Training',
    subtitle:     'The work starts here.',
    palette:      'warm',
    icon:         '⛺',
    triggerPhase: 'SPRING_TRAINING',
    triggerGame:   0,
  },
  OPENING_DAY: {
    id:           'OPENING_DAY',
    title:        'Opening Day',
    subtitle:     'The season begins.',
    palette:      'warm',
    icon:         '⚾',
    triggerPhase: 'REGULAR_SEASON',
    triggerGame:   0,
  },
  MIDSUMMER: {
    id:           'MIDSUMMER',
    title:        'Midsummer',
    subtitle:     'Halfway there.',
    palette:      'calm',
    icon:         '☀️',
    triggerPhase: 'ALL_STAR_BREAK',
    triggerGame:   null,
  },
  ALL_STAR_WEEK: {
    id:           'ALL_STAR_WEEK',
    title:        'All-Star Week',
    subtitle:     'The league comes to you.',
    palette:      'prestige',
    icon:         '🌟',
    triggerPhase: 'ALL_STAR_BREAK',
    triggerGame:   null,
    requiresHosting: true,
  },
  TRADE_DEADLINE: {
    id:           'TRADE_DEADLINE',
    title:        'The Deadline',
    subtitle:     'Make your move.',
    palette:      'urgent',
    icon:         '⏱',
    triggerPhase: 'TRADE_DEADLINE',
    triggerGame:   TRADE_DEADLINE_OPEN,
  },
  DEADLINE_PASSED: {
    id:           'DEADLINE_PASSED',
    title:        'Deadline Passed',
    subtitle:     'The window is closed.',
    palette:      'neutral',
    icon:         '🔒',
    triggerPhase: 'REGULAR_SEASON',
    triggerGame:   TRADE_DEADLINE_CLOSE + 1,
  },
  STRETCH_RUN: {
    id:           'STRETCH_RUN',
    title:        'The Stretch Run',
    subtitle:     'Every game matters now.',
    palette:      'stakes',
    icon:         '📅',
    triggerPhase: 'REGULAR_SEASON',
    triggerGame:   REGULAR_SEASON_GAME_COUNT - STRETCH_RUN_FINAL_GAMES,
  },
  POSTSEASON_BOUND: {
    id:           'POSTSEASON_BOUND',
    title:        'Postseason Bound',
    subtitle:     'You earned it.',
    palette:      'triumph',
    icon:         '🏟️',
    triggerPhase: 'PLAYOFF_BRACKET_BUILD',
    triggerGame:   null,
  },
  WILD_CARD: {
    id:           'WILD_CARD',
    title:        'Wild Card',
    subtitle:     'Win or go home.',
    palette:      'cinematic',
    icon:         '🃏',
    triggerPhase: 'WILD_CARD',
    triggerGame:   null,
  },
  FIRST_ROUND: {
    id:           'FIRST_ROUND',
    title:        'First Round',
    subtitle:     'The real test starts now.',
    palette:      'cinematic',
    icon:         '🎯',
    triggerPhase: 'FIRST_ROUND',
    triggerGame:   null,
  },
  DIVISION_SERIES: {
    id:           'DIVISION_SERIES',
    title:        'Division Series',
    subtitle:     'One series from the World Series.',
    palette:      'elevated',
    icon:         '🏆',
    triggerPhase: 'DIVISION_SERIES',
    triggerGame:   null,
  },
  WORLD_SERIES: {
    id:           'WORLD_SERIES',
    title:        'The World Series',
    subtitle:     "This is what it's all for.",
    palette:      'maximum',
    icon:         '🥇',
    triggerPhase: 'WORLD_SERIES',
    triggerGame:   null,
  },
  SERIES_WON: {
    id:           'SERIES_WON',
    title:        'Series Won',
    subtitle:     'On to the next.',
    palette:      'triumph',
    icon:         '✅',
    triggerPhase: null,
    triggerGame:   null,
  },
  SEASON_OVER: {
    id:           'SEASON_OVER',
    title:        'Season Over',
    subtitle:     'A season to build on.',
    palette:      'respectful',
    icon:         '📖',
    triggerPhase: null,
    triggerGame:   null,
  },
  CHAMPIONS: {
    id:           'CHAMPIONS',
    title:        'Champions',
    subtitle:     'You did it.',
    palette:      'ceremony',
    icon:         '🏆',
    triggerPhase: null,
    triggerGame:   null,
  },
  OFFSEASON: {
    id:           'OFFSEASON',
    title:        'The Offseason',
    subtitle:     'The work begins again.',
    palette:      'calm',
    icon:         '❄️',
    triggerPhase: 'OFFSEASON',
    triggerGame:   null,
  },
  NEW_SEASON: {
    id:           'NEW_SEASON',
    title:        'Year {N}',                // resolved at trigger time
    subtitle:     'A new chapter.',
    palette:      'continuity',
    icon:         '📆',
    triggerPhase: 'SPRING_TRAINING',
    triggerGame:   0,
    minSeason:     2,                        // only fires season 2+
  },
  FRANCHISE_TURNING_POINT: {
    id:           'FRANCHISE_TURNING_POINT',
    title:        'A New Era',
    subtitle:     'Everything changes now.',
    palette:      'pivotal',
    icon:         '🔄',
    triggerPhase: null,
    triggerGame:   null,
  },
  FRANCHISE_LEGEND: {
    id:           'FRANCHISE_LEGEND',
    title:        'A Legacy Complete',
    subtitle:     'Your name is in the record books.',
    palette:      'legend',
    icon:         '⭐',
    triggerPhase: 'SEASON_SUMMARY',
    triggerGame:   null,
  },
});

// ─────────────────────────────────────────────────────────────
// TEAM COLOR PALETTE (Section 1.14 — LOCKED)
// Stored as palette ID strings, not raw hex.
// Each entry has dark/light variants for automatic theme adjustment.
// applyTeamColors() in ui/formatters.js reads these and sets CSS variables.
// ─────────────────────────────────────────────────────────────

export const COLOR_PALETTE = Object.freeze([
  { id: 'gold',     dark: '#F5D253', light: '#9A6A00', name: 'Gold'     },
  { id: 'blue',     dark: '#3B82F6', light: '#1D4ED8', name: 'Blue'     },
  { id: 'green',    dark: '#22C55E', light: '#15803D', name: 'Green'    },
  { id: 'red',      dark: '#EF4444', light: '#B91C1C', name: 'Red'      },
  { id: 'orange',   dark: '#F97316', light: '#C2410C', name: 'Orange'   },
  { id: 'pink',     dark: '#EC4899', light: '#BE185D', name: 'Pink'     },
  { id: 'purple',   dark: '#A855F7', light: '#7E22CE', name: 'Purple'   },
  { id: 'cyan',     dark: '#06B6D4', light: '#0E7490', name: 'Cyan'     },
  { id: 'lime',     dark: '#84CC16', light: '#4D7C0F', name: 'Lime'     },
  { id: 'rose',     dark: '#FB7185', light: '#BE123C', name: 'Rose'     },
  { id: 'amber',    dark: '#FBBF24', light: '#B45309', name: 'Amber'    },
  { id: 'indigo',   dark: '#818CF8', light: '#4338CA', name: 'Indigo'   },
  { id: 'teal',     dark: '#2DD4BF', light: '#0F766E', name: 'Teal'     },
  { id: 'white',    dark: '#E8ECF4', light: '#374151', name: 'Silver'   },
]);

// Defaults applied at game creation
export const COLOR_PRIMARY_DEFAULT   = 'gold';
export const COLOR_SECONDARY_DEFAULT = 'green';

// ─────────────────────────────────────────────────────────────
// AGE / DEVELOPMENT RANGES (Section 4.1)
// ─────────────────────────────────────────────────────────────

export const AGE_DEVELOPMENT_WINDOWS = Object.freeze({
  GROWTH:  { min: 21, max: 24 },
  PEAK:    { min: 25, max: 27 },
  PRIME:   { min: 28, max: 30 },
  DECLINE: { min: 31, max: 33 },
  STEEP:   { min: 34, max: 99 },
});

// ─────────────────────────────────────────────────────────────
// PLAYER RETIREMENT THRESHOLDS (Section 20.7 — LOCKED)
// ─────────────────────────────────────────────────────────────

export const RETIREMENT_AGE_HARD  = 38;  // retires regardless of OVR
export const RETIREMENT_AGE_SOFT  = 35;  // retires if OVR also below RETIREMENT_OVR_SOFT
export const RETIREMENT_OVR_SOFT  = 55;  // OVR threshold for age-35+ retirement
export const RETIREMENT_OVR_FARM  = 50;  // OVR threshold for farm decline-arc retirement

// ─────────────────────────────────────────────────────────────
// FARM STORY ARC CONSTANTS (Section 20.4 — LOCKED)
// ─────────────────────────────────────────────────────────────

export const FARM_ARC_MOTIVATION_PROB_BASE  = 0.45;  // 45% baseline chance
export const FARM_ARC_DECLINE_PROB_BASE     = 0.25;  // 25% baseline chance
export const FARM_ARC_STABLE_PROB_BASE      = 0.30;  // 30% baseline chance

// Sub-rating drift per month on farm (applied at each season transition)
export const FARM_ARC_MOTIVATION_DRIFT_MIN  = 0.5;
export const FARM_ARC_MOTIVATION_DRIFT_MAX  = 1.5;
export const FARM_ARC_MOTIVATION_DRIFT_CAP  = 3;    // max total before callup
export const FARM_ARC_DECLINE_DRIFT_MIN     = 0.5;
export const FARM_ARC_DECLINE_DRIFT_MAX     = 1.5;
export const FARM_ARC_DECLINE_DRIFT_CAP     = 4;    // max total decline

// Trait modifiers to arc probabilities
export const FARM_ARC_YOUNG_GUN_MOTIVATION_BONUS   =  0.20;
export const FARM_ARC_YOUNG_GUN_DECLINE_PENALTY    = -0.10;
export const FARM_ARC_VOLATILE_DECLINE_BONUS       =  0.25;
export const FARM_ARC_AGE_DECLINE_BONUS_PER_YEAR   =  0.10; // per year above 28

// Extended decline risk: if on decline arc > 60 real days, request-release card fires
export const FARM_ARC_DECLINE_RELEASE_REQUEST_DAYS = 60;

// ─────────────────────────────────────────────────────────────
// MAKEUP GAME SCHEDULING
// ─────────────────────────────────────────────────────────────

export const MAKEUP_SEARCH_WINDOW_GAMES = 10;  // look N games ahead for a travel day

// ─────────────────────────────────────────────────────────────
// ALL-STAR GAME — LEAGUE MINIMUM ACTIVE GAMES PER DAY
// ─────────────────────────────────────────────────────────────

export const SCHEDULE_MIN_TEAMS_PLAYING_PER_DAY = 4;

// ─────────────────────────────────────────────────────────────
// INJURY ENGINE — PROBABILITY TABLES (Section 21 — LOCKED)
// ─────────────────────────────────────────────────────────────

// Base injury probability per game/appearance
export const INJURY_PROB_HITTER_PER_GAME   = 0.008;  // 0.8% per game
export const INJURY_PROB_SP_PER_START      = 0.012;  // 1.2% per start
export const INJURY_PROB_RP_PER_APP        = 0.006;  // 0.6% per appearance

// Age modifiers (additive)
export const INJURY_AGE_MOD_32_34          = 0.003;  // +0.3% age 32-34
export const INJURY_AGE_MOD_35_PLUS        = 0.008;  // +0.8% age 35+

// Fatigue modifier (SP only — when _simFatigued flag is set)
export const INJURY_FATIGUE_MOD            = 0.004;  // +0.4%

// Severity tier probabilities (must sum to 1.0)
export const INJURY_SEVERITY_MINOR_PROB    = 0.55;   // Grade 1
export const INJURY_SEVERITY_MODERATE_PROB = 0.30;   // Grade 2
export const INJURY_SEVERITY_SIGNIFICANT_PROB = 0.12; // Grade 3
export const INJURY_SEVERITY_SEASON_PROB   = 0.03;   // Season-ending

// IL duration ranges (days) [min, max]
export const INJURY_IL_DAYS_MINOR          = [7,  14];
export const INJURY_IL_DAYS_MODERATE       = [15, 30];
export const INJURY_IL_DAYS_SIGNIFICANT    = [31, 60];
export const INJURY_IL_DAYS_SEASON         = [999, 999]; // rest of season

// Sub-rating penalty per severity
export const INJURY_SR_PENALTY_MINOR       = 3;
export const INJURY_SR_PENALTY_MODERATE    = 6;
export const INJURY_SR_PENALTY_SIGNIFICANT = 10;
export const INJURY_SR_PENALTY_SEASON      = 15;

// Injury type → sub-rating mapping (LOCKED)
// Each entry: { type, affectedSR, positionGroup }
export const INJURY_TYPES = Object.freeze([
  // Hitter injuries
  { id: 'hamstring',         label: 'Hamstring Strain',       affectedSR: 'speed',   group: 'hitter' },
  { id: 'oblique',           label: 'Oblique Strain',         affectedSR: 'contact', group: 'hitter' },
  { id: 'wrist',             label: 'Wrist Inflammation',     affectedSR: 'power',   group: 'hitter' },
  // Pitcher injuries
  { id: 'elbow',             label: 'Elbow Inflammation',     affectedSR: 'stuff',   group: 'pitcher' },
  { id: 'shoulder',          label: 'Shoulder Tightness',     affectedSR: 'control', group: 'pitcher' },
  { id: 'back',              label: 'Back Tightness',         affectedSR: 'stamina', group: 'pitcher' },
  { id: 'forearm',           label: 'Forearm Tightness',      affectedSR: 'stuff',   group: 'reliever' },
]);

// Injury report text tiers (gmRelationship gates) — used by getInjuryReport()
export const INJURY_REPORT_TIER_SILENT   = 40;  // below this: no comment
export const INJURY_REPORT_TIER_VAGUE    = 60;  // 40-60: vague
export const INJURY_REPORT_TIER_GENERAL  = 80;  // 61-80: general diagnosis
// above 80: full detail

// Stale report threshold
export const INJURY_REPORT_STALE_DAYS   = 5;

// ─────────────────────────────────────────────────────────────
// IMPACT RATING (IMP) — Section 30 — LOCKED
// All values wiki-documented and tunable via constants only.
// ─────────────────────────────────────────────────────────────

// Rolling window sizes (days)
export const IMP_WINDOW_7   = 7;
export const IMP_WINDOW_15  = 15;
export const IMP_WINDOW_30  = 30;
// IMP_SEASON uses all games in state.players[id].stats (no window cap)

// Hitter formula weights
export const IMP_H_OPS_WEIGHT          = 8.0;
export const IMP_H_HR_WEIGHT           = 0.8;
export const IMP_H_RBI_WEIGHT          = 0.4;
export const IMP_H_SB_WEIGHT           = 0.3;
export const IMP_H_DISCIPLINE_WEIGHT   = 3.0;
export const IMP_H_STRIKEOUT_PENALTY   = 2.5;
export const IMP_H_BABIP_ADJ_TRIGGER   = 0.040;  // BABIP excess above career avg that triggers correction
export const IMP_H_BABIP_ADJ_WEIGHT    = 1.5;

// Pitcher formula weights
export const IMP_P_ERA_WEIGHT          = 3.5;
export const IMP_P_WHIP_WEIGHT         = 4.0;
export const IMP_P_K9_WEIGHT           = 1.2;
export const IMP_P_WALK_PENALTY        = 1.8;
export const IMP_P_HR_PENALTY          = 2.0;
export const IMP_P_QS_BONUS            = 0.5;   // SP only
export const IMP_P_SAVE_BONUS          = 0.8;   // closers only
export const IMP_P_HOLD_BONUS          = 0.4;   // setup relievers only
export const IMP_P_IP_LOG_SCALE        = 0.015; // log(IP) × this = durability bonus

// Display thresholds
export const IMP_HOT_THRESHOLD         =  2.5;  // IMP-7 above this = 🔥
export const IMP_COLD_THRESHOLD        = -2.0;  // IMP-7 below this = ❄️
export const IMP_ELITE_THRESHOLD       =  6.0;  // MVP-caliber
export const IMP_BELOW_REPLACEMENT     = -1.5;  // roster decision needed

// Position average baselines — used for delta normalization
// These are starting estimates; recalibrated post-testing if needed
export const IMP_POS_AVG_OPS = Object.freeze({
  C:    0.690, '1B': 0.770, '2B': 0.710, '3B': 0.740,
  SS:   0.700, OF:   0.750, DH:   0.780,
  '1B/3B': 0.755, '2B/SS': 0.705, 'DH/OF': 0.765,
});
export const IMP_POS_AVG_HR_RATE  = Object.freeze({
  C: 0.025, '1B': 0.045, '2B': 0.020, '3B': 0.035,
  SS: 0.018, OF: 0.038, DH: 0.050,
  '1B/3B': 0.040, '2B/SS': 0.019, 'DH/OF': 0.044,
});
export const IMP_LEAGUE_AVG_ERA   = 4.20;  // league-average ERA for delta calc
export const IMP_LEAGUE_AVG_WHIP  = 1.30;
export const IMP_LEAGUE_AVG_K9    = 8.50;
export const IMP_LEAGUE_AVG_BB9   = 3.20;
export const IMP_LEAGUE_AVG_HR9   = 1.30;
export const IMP_LEAGUE_AVG_OPS   = 0.730;
export const IMP_LEAGUE_AVG_BB_PCT = 0.085;
export const IMP_LEAGUE_AVG_K_PCT  = 0.220;

// Minimum plate appearances / innings pitched to produce a valid IMP
// Below these thresholds IMP is null (not enough sample)
export const IMP_MIN_PA_7    = 10;   // minimum PA in 7-day window
export const IMP_MIN_PA_15   = 20;
export const IMP_MIN_PA_30   = 40;
export const IMP_MIN_PA_SEASON = 80;
export const IMP_MIN_IP_7    = 3.0;
export const IMP_MIN_IP_15   = 6.0;
export const IMP_MIN_IP_30   = 12.0;
export const IMP_MIN_IP_SEASON = 20.0;

// ─────────────────────────────────────────────────────────────
// FRANCHISE TURNING POINT
// ─────────────────────────────────────────────────────────────

// Eligible archetypes check against ARCHETYPE[id].turningPointEligible
// Fired once per franchise lifetime; enforced via state.turningPointFired: Boolean
