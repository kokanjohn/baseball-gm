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
export const FCM_SENDER_ID    = '157200420537';

// ─────────────────────────────────────────────────────────────
// SCHEMA VERSION
// ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────
// SEASON SCHEDULE ANCHORS
// ─────────────────────────────────────────────────────────────

export const SPRING_TRAINING_GAME_COUNT      = 10;  // matches the schedule generator; off-day pattern [2,5,8] is tuned for 10
export const REGULAR_SEASON_GAME_COUNT       = 132;
// Canonical (display) spring start: March 14 on the baseball calendar.
export const SPRING_START_MONTH = 2;   // March (0-indexed)
export const SPRING_START_DAY   = 14;
export const ALL_STAR_BREAK_AFTER_GAME       = 66;
export const TRADE_DEADLINE_OPEN             = 88;  // game index (0-based) deadline window opens
export const TRADE_DEADLINE_CLOSE            = 92;  // game index (0-based) deadline window closes
export const ALLSTAR_ANNOUNCE_GAME_MIN       = 45;  // earliest game the ASG announcement can fire
export const ALLSTAR_ANNOUNCE_GAME_MAX       = 55;  // latest game the ASG announcement can fire
export const STRETCH_RUN_FINAL_GAMES         = 5;   // "final N games" milestone trigger

// New-franchise inbox seed (§60). Delivered by GameEngine.startNewGame through
// CardEngine.deliverSeedCards — real instances, no push notification.
//   sp1/sp2       — spring ballpark-prep and clubhouse openers
//   sp_hint1/3    — league facility-standards + fan-experience benchmarking: the
//                   first "the league is watching" signals toward All-Star hosting
// plus ONE real trade proposal from TradeEngine (CardEngine.deliverSeedTradeOffer).
export const NEW_TEAM_SEED_CARDS = Object.freeze(['sp2', 'sp_hint1', 'sp_hint3']);   // (r233 §122.112 not 'sp1', the field prep: a winter decision now)

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
  PITCHER_BENCH:    'pb',   // 2 SP bench + 2 RP bench (not on active rotation)
  IL:               'il',
  // Between teams: traded or called up, reporting the next calendar day (§65).
  // On no roster or farm list; player.teamId is the DESTINATION and exactly
  // one pending 'arrival' transaction in state.transactions carries him.
  IN_TRANSIT:       'transit',
  // Off every roster (§70): unsigned, retired, or gone to another league.
  FREE_AGENT:       'freeAgent',
  RETIRED:          'retired',
  DEPARTED:         'departed',
});

// ─────────────────────────────────────────────────────────────
// ROSTER SIZE LIMITS
// ─────────────────────────────────────────────────────────────

// Regular season active roster: 28 players (LOCKED)
//   Hitters (14): 9 starters + 5 bench
//   Pitchers (14): 5 SP rotation + 5 RP bullpen + 2 SP bench + 2 RP bench
// Spring training roster: 38 players (28 active + 10 invitees: 5 hitters + 5 pitchers)
// Cuts before Opening Day: 10 (invitees return to farm, or waived if not optionable)
// Fixed 9-slot batting lineup — always in this order.
// Each slot is a label string. OF appears 3 times (no LF/CF/RF distinction).
// Used by LeagueFactory to build lineupSlots, by TeamScreen for display,
// and by RosterEngine for vacancy management.
export const LINEUP_SLOTS = Object.freeze(
  ['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', 'DH']
);

export const ROSTER_LIMITS = Object.freeze({
  STARTING_HITTERS:  9,
  BENCH_HITTERS:     5,
  STARTING_PITCHERS: 5,
  BULLPEN:           5,
  PITCHER_BENCH:     4,   // 2 SP bench + 2 RP bench
  ACTIVE_TOTAL:     28,   // §122 in spring too (no camp invitees), and no farm behind it
});

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

// r205 §122.83 Defense — a fourth hitter rating. OVR blends the bat (contact/power/speed, above) with
// the glove by the player's primary position: a catcher's or shortstop's glove is a third of the player,
// a first baseman's a sliver, a DH's nothing.
export const OVR_DEF_WEIGHT = Object.freeze({ C: 0.30, SS: 0.30, '2B': 0.22, '3B': 0.18, OF: 0.15, '1B': 0.06, DH: 0 });
// A new player's glove: around the target OVR, by position (shortstops and catchers field; DHs don't),
// ± `spread`, pulled a little toward the player's speed where range matters.
export const DEF_GEN = Object.freeze({
  bias: Object.freeze({ C: 3, SS: 5, '2B': 3, '3B': 1, OF: 0, '1B': -6, DH: -12 }),
  spread: 10, speedPull: Object.freeze({ SS: 0.25, '2B': 0.2, OF: 0.25, '3B': 0.1 }),
  // r207 §122.85 where the glove stands against the bat by age (the curves above, summed): a young regular's
  // is ahead of the bat, a veteran's behind. [age at most, shift]
  ageShift: Object.freeze([[22, 0], [26, 2], [30, 0], [33, -3], [99, -6]]),
});

// r205 §122.83 Defense on the field (SimEngine): each ball in play goes to a fielder. The fielder's glove
// against the league's at that position (d = (glove − average there) / scale, at most ±dMax; out of position: glove −
// oopDrop × exposure) decides: hits taken away (a good glove: `range.single`/`double` × d of the hits
// to it) or let through (a poor one: `range.out` × −d of the outs) — even across the league; errors
// on the outs to it (`err`, × (1 − errPerD × d) within errMin–errMax, × (1 + oopErr × exposure) for a
// fielder out of position, × the bench coach's for our club); double plays (± dp × the middle
// infield's d); outfield arms (throw-outs ± arm × d); a catcher's throw on a steal (− catcherSb × d).
// `gem`: the share of the hits taken away (and let through) the play-by-play calls out.
export const DEFENSE_SIM = Object.freeze({
  scale: 20, dMax: 1.5, oopDrop: 25,
  range: Object.freeze({ single: 0.09, double: 0.06, out: 0.04 }),
  err: Object.freeze({ groundout: 0.05, flyout: 0.011 }), errPerD: 0.25, errMin: 0.6, errMax: 1.6, oopErr: 2.5,
  dp: 0.12, arm: 0.15, catcherSb: 0.05, gem: 0.55,
  // Where the ball goes: a grounder, a fly, a single (`groundSingle` of them through the infield), a double.
  grounder: Object.freeze({ SS: 0.30, '2B': 0.26, '3B': 0.22, '1B': 0.14, P: 0.08 }),
  fly: Object.freeze({ OF: 0.72, SS: 0.08, '2B': 0.07, '3B': 0.07, '1B': 0.03, C: 0.03 }),
  groundSingle: 0.5,
  infieldSingle: Object.freeze({ SS: 0.3, '2B': 0.3, '3B': 0.2, '1B': 0.2 }),
  double: Object.freeze({ OF: 0.85, '3B': 0.08, '1B': 0.07 }),
});

// r206 §122.84 Defense in Impact: the fielder's runs — a hit taken away `hitRuns`, one let through the
// same, an error over the position's usual rate (errors a plate appearance, `eRate`) `errRuns` — a
// rate per 600 PA, worth `k` × the position's OVR weight in Impact a run (so a glove is worth in Impact
// about what it's worth in OVR: Impact runs 0.223 a rating point).
export const DEF_IMP = Object.freeze({
  hitRuns: 0.8, errRuns: 0.6, k: 0.25, shrinkPA: 200,   // (a glove's sample takes longer to mean something: × pa / (pa + shrinkPA))
  eRate: Object.freeze({ C: 0.001, '1B': 0.017, '2B': 0.029, '3B': 0.021, SS: 0.034, OF: 0.005, DH: 0 }),
});

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

// Plate-appearance model (§60 — supersedes the §7.2 divisor formulas).
// §7.2's resolution order and rating→outcome mapping are unchanged (control →
// walks, stuff vs contact → strikeouts and hits, power → HR/XBH share, speed →
// infield hits); only the coefficients are re-centred. The §7.2 divisors assumed a
// higher rating scale: at the generator's real league average (~55) the hit term
// `contact/400 − stuff/300` is ≤ 0, so most at-bats could not produce a hit
// (measured: 0.68 runs and 2.1 hits per team per game; 18/142 games hit the
// extra-innings cap). Each rate is now a league-average baseline at rating 55,
// moved linearly by the rating gap and clamped. Targets ≈ modern MLB per PA:
// BB 8.5%, K 22.5%, H 22.5%, HR ≈ 3% → ~4.5 runs / team / game.
export const SIM_RATING_AVG                 = 55;    // league-average sub-rating (generator mean)
export const SIM_PA_WALK_BASE               = 0.080; // walk rate at average control
export const SIM_PA_WALK_PER_PT             = 0.0025;// per point of control BELOW average
export const SIM_PA_WALK_MIN                = 0.025;
export const SIM_PA_WALK_MAX                = 0.170;
export const SIM_PA_K_BASE                  = 0.226; // K rate, average contact vs average stuff
export const SIM_PA_K_PER_CONTACT_PT        = 0.0040;// per point of contact BELOW average
export const SIM_PA_K_PER_STUFF_PT          = 0.0040;// per point of stuff ABOVE average
export const SIM_PA_K_MIN                   = 0.080;
export const SIM_PA_K_MAX                   = 0.380;
export const SIM_PA_HIT_BASE                = 0.212; // hit rate (non-infield), average vs average
export const SIM_PA_HIT_PER_CONTACT_PT      = 0.0035;// per point of contact above average
export const SIM_PA_HIT_PER_STUFF_PT        = 0.0030;// per point of stuff above average (reduces)
export const SIM_PA_HIT_MIN                 = 0.110;
export const SIM_PA_HIT_MAX                 = 0.340;
export const SIM_PA_INFIELD_HIT_PER_SPEED_PT = 0.0006;// per point of speed above average
export const SIM_HIT_HR_SHARE_BASE          = 0.128; // share of hits that are HR at average power
export const SIM_HIT_HR_SHARE_PER_PT        = 0.0050;
export const SIM_HIT_HR_SHARE_MIN           = 0.030;
export const SIM_HIT_HR_SHARE_MAX           = 0.300;
export const SIM_HIT_XBH_SHARE_BASE         = 0.195; // share of hits that are doubles at average power
export const SIM_HIT_XBH_SHARE_PER_PT       = 0.0030;
export const SIM_HIT_XBH_SHARE_MIN          = 0.090;
export const SIM_HIT_XBH_SHARE_MAX          = 0.320;
export const SIM_HIT_TRIPLE_SHARE           = 0.012; // share of hits that are triples (speed-scaled)
export const SIM_H_SPEED_SB_THRESHOLD       = 65;    // speed above this → SB attempt eligible
export const SIM_H_SPEED_STRETCH_THRESHOLD  = 70;    // speed above this → stretch single to 3rd
export const SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD = 60; // speed above this → score from 1st on double
export const SIM_H_SPEED_TAG_THRESHOLD      = 75;    // speed above this → tag from 3rd on flyout

// Runner advancement — throw-out probabilities
export const SIM_THROWOUT_PLATE_BASE        = 0.28;  // base prob of being thrown out at plate
export const SIM_THROWOUT_EXTRA_BASE        = 0.22;  // base prob thrown out taking extra base

// r228 §122.107 runners on a groundout (the batter out at first, fewer than two outs): a runner on third who isn't
// forced scores by where it was fielded (the right side easiest, the third baseman and the pitcher hardest) and
// speed; a runner on second with first open takes third mostly on a grounder to the right side. The batting club's
// running game moves both (STRATEGY.run[…].tagSend). Otherwise they hold.
export const GROUND_ADV = Object.freeze({
  home:  Object.freeze({ '1B': 0.62, '2B': 0.62, SS: 0.45, '3B': 0.22, P: 0.18 }), homePerSpeed: 0.006,
  third: Object.freeze({ '1B': 0.80, '2B': 0.80, SS: 0.26, '3B': 0.06, P: 0.12 }), thirdPerSpeed: 0.006,
});
// r228 wild pitches: before a batter, with anyone on base, this often (× 1 + perControl × (50 − the pitcher's control),
// at least ×minMult); every runner moves up a base (a run is earned). MLB: about 0.3 a team-game.
export const WILD_PITCH = Object.freeze({ perPA: 0.021, perControl: 0.02, minMult: 0.4 });
// r228 intentional walks, when the game calls for it (no manager's decision): the batter clearly better than the one on
// deck — late and close (the 7th on, within two runs) at `late`, any other time with two outs at `early`. MLB: about one
// every six team-games. r229: allowed in any base state, weighted (first open with a runner in scoring position the
// usual case).
export const IBB = Object.freeze({ late: 0.45, early: 0.13, lateInning: 7, closeRuns: 2, gap: 4,
  // r229 §122.108 the other base states (× the chance, and a bigger gap to the batter on deck)
  firstTaken: 0.06, gapFirstTaken: 8, empty: 0.015, gapEmpty: 10, loaded: 0.002, gapLoaded: 12 });

// r227 §122.106 tag-ups on a caught fly, fewer than two outs (none on the inning's third out; none on an infield pop).
// By how deep it was caught (feet, r226's spot), the runner's speed (± per point from 50), the batting club's running
// game, and the outfielder's arm. Calibrated to MLB: runners on third sent on about 78% of catchable outfield flies,
// safe on about 97% of sends (Baseball Prospectus); runners on second tag to third mostly on flies to center and
// right (LF ≈12%, CF ≈47%, RF ≈55% on a fly with nobody out); first to second only on the deepest.
//   [dist, value] points, interpolated.
export const TAG_UP = Object.freeze({
  home: Object.freeze({
    send: [[215, 0.02], [240, 0.22], [265, 0.62], [290, 0.90], [315, 0.98], [340, 1.0]],
    safe: [[215, 0.70], [240, 0.80], [265, 0.90], [290, 0.965], [315, 0.99], [340, 0.995]],
    sendPerSpeed: 0.006, safePerSpeed: 0.0012,
  }),
  third: Object.freeze({
    field: Object.freeze({ LF: 0.14, CF: 0.42, RF: 0.53 }),   // at a fly of `atDist`
    atDist: 300, perFoot: 0.008, sendPerSpeed: 0.006, out: 0.05, outPerSpeed: 0.0008,
  }),
  second: Object.freeze({ fromFence: 35, send: 0.30, sendPerSpeed: 0.008, out: 0.06, outPerSpeed: 0.0008 }),
  // (the running game: STRATEGY.run[…].tagSend / tagOut)
});
export const SIM_SPEED_THROWOUT_DIVISOR     = 800;   // speed reduces throwout prob by speed/this

// Stolen base mechanics
export const SIM_SB_BASE_SUCCESS            = 0.68;  // base SB success rate
export const SIM_SB_SPEED_BONUS_DIVISOR     = 500;   // speed/this added to success rate
export const SIM_SB_ATTEMPT_PROB            = 0.12;  // prob per at-bat that a fast runner attempts

// Fielder's choice — groundout converts to FC
export const SIM_FC_PROB                    = 0.30;  // prob groundout with runner on 1st becomes FC

// Double play probability (runner on 1st, < 2 outs)
export const SIM_DP_PROB                    = 0.40;  // prob of DP on groundout with runner on 1st

// Errors — some groundouts become errors (batter reaches)
export const SIM_ERROR_PROB                 = 0.06;  // prob a groundout is an error instead

// Sac bunt — low-power batter with runners on and < 2 outs
export const SIM_SAC_BUNT_POWER_MAX         = 45;    // batter power at or below this → eligible
export const SIM_SAC_BUNT_INNING_MIN        = 6;     // inning 6+ only (late game)
export const SIM_SAC_BUNT_PROB              = 0.18;  // prob eligible batter attempts sac bunt

// Pitcher sub-rating thresholds (rates live in the SIM_PA_* block above)
export const SIM_P_CONTROL_HBP_THRESHOLD    = 50;    // HBP rate elevated below this control value
export const SIM_P_STAMINA_INNINGS_DIVISOR  = 20;    // max IP = SIM_SP_INNINGS_BASE + floor(stamina/this)
export const SIM_P_FATIGUE_MULTIPLIER       = 1.8;   // fatigueThreshold = stamina × this (batters faced)

// Pitcher fatigue effects
export const SIM_P_FATIGUE_HIT_QUALITY_BONUS = 0.10; // +10% hit rate when fatigued (multiplier)
export const SIM_P_FATIGUE_K_PENALTY        = 0.15;  // −15% K rate when fatigued
export const SIM_P_FATIGUE_WALK_BONUS       = 0.10;  // +10% walk rate when fatigued (multiplier)

// ── Pitcher workload, rest and bullpen roles (§76, PitchingEngine) ──
// In a game: a pitcher tires (§7.4 modifiers apply) once he has faced more
// batters than his stamina carries; the manager replaces him when his side
// next takes the field.
export const PITCH_SP_TIRE_BASE_BF          = 9;     // starter tires after 9 + stamina/5 batters (≈ the 3rd time through: 19–26)
export const PITCH_SP_TIRE_PER_STAMINA      = 0.2;
export const PITCH_RP_TIRE_BASE_BF          = 4;     // reliever: 4 + stamina/12 batters (≈ an inning and a half)
export const PITCH_RP_TIRE_PER_STAMINA      = 1 / 12;
export const PITCH_HOOK_EXTRA_BF            = 6;     // past tiring by this many, he's done regardless of innings
export const PITCH_SHELLED_RUNS             = 5;     // a starter who has allowed this many by the 6th is pulled
export const PITCH_SHELLED_EARLY_RUNS       = 4;     // ... or this many by the 3rd
export const PITCH_LONG_INNINGS             = Object.freeze({ min: 2, max: 3 });  // a long man's stint
// r154 Spring training: a starter builds up — two innings in the first spring
// games, four by the last — and is never stretched past that; the bullpen
// covers the rest as usual.
export const SPRING_SP_INNINGS              = Object.freeze({ first: 2, last: 4 });
// Between games (calendar days since an outing; same-day = 0).
export const PITCH_SP_REST_DAYS             = 4;     // a starter needs 4 days' rest
export const PITCH_RP_LONG_OUTING_BF        = 10;    // ≈ 2+ innings: not available the next day
export const PITCH_RP_HEAVY_OUTING_BF       = 18;    // ≈ 4+ innings: not available for two days
export const PITCH_RP_START_BF              = 25;    // a start's worth: not available for three days
export const PITCH_RP_MAX_STRAIGHT_DAYS     = 2;     // never a third day in a row
export const PITCH_RP_TIRED_ONSET_SHARE     = 0.5;   // a reliever still tired from recent days tires twice as fast
export const PITCH_ARM_HISTORY_DAYS         = 6;     // outings kept on the arm's record

// Extra innings: the regular season plays until a winner. This guard only stops
// a pathological loop; with a realistic run environment the chance of reaching
// it is astronomically small. Runs are never added outside the plays.
export const SIM_MAX_INNINGS_GUARD          = 99;

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
export const CARD_COST_EXT     = { min: 200, max:  500 };
// §78.8 card amounts above are for a contender-sized market (this payroll
// target, $K); each club's are scaled to its own (×0.5–1.6).
export const CARD_MONEY_BASE_TARGET_K = 22000;

// §85 (Phase 4) cash in trades is ON: a one-time sweetener either way, or a
// share of a player's salary the sending club keeps paying this season.
export const TRADE_CASH_ENABLED = true;

// §85 the trade rules and the CPU's judgment.
export const TRADE = Object.freeze({
  maxPerSide:      3,                    // players a side (prospects included)
  cooldownMs:      2 * 86_400_000,       // after a declined or fizzled negotiation, before that club talks again
  noFlipMs:        5 * 86_400_000,       // a player just acquired can't be traded again for this long
  maxRounds:       3,                    // counteroffers before talks fizzle
  cashPerValueK:   15,                   // $K of cash ≈ one point of trade value (a strapped club values it more)
  maxRetainPct:    0.5,                  // the most of a salary a sending club will keep paying
  // The bar a CPU club sets by rapport (net value it needs from the deal).
  bar:             { strong: -8, good: -3, neutral: 0, cool: 6, strained: 12 },
  counterBand:     30,                   // within this much of the bar, the club counters instead of declining
  rapport:         { completed: 2, lowball: -2, fizzled: -1, counterAccepted: 1 },
});

// §90 Phase 4c — trades between CPU clubs, made when a club has a need and
// another club has the player and wants what it can give.
export const LEAGUE_TRADES = Object.freeze({
  // The chance, each day, that a club with a need works the phones.
  dailyChance:  { season: 0.03, deadline: 0.20, spring: 0.02, offseason: 0.08, meetings: 0.30 },   // §112.5 the winter meetings (offseason days 6–7)
  meetings:     { maxPerDesk: 3, calls: 2 },   // §112.5 at the meetings: more deals a desk, more calls to us
  maxPerDay:    2,
  clubRestMs:   14 * 86_400_000,   // a club that just traded waits this long before another
  reTradeMs:    120 * 86_400_000,  // a player a CPU club traded for isn't moved on again this soon
  rivalCardGapMs: 7 * 86_400_000,  // at most one "a rival got better" card a week
  needGap:      5,                 // an incumbent this far below the league's norm at his spot is a need
  upgradeMin:   4,                 // a target must beat the incumbent by this much
  buyerSlack:   { buyer: 8, neutral: 3, seller: 0 },   // value a club will overpay to fill a need
  maxPool:      10,                // the pieces a club considers giving (best few, for combinations)
  // §91 a club that calls us opens in its own favor: a little under our value
  // when it wants our player, a little over its own when it offers one of its.
  openUnder:    0.08,              // as a share of the player's value
  openUnderMin: 4,
  callMargin:   4,                 // it calls us when our player is about as good a fit (OVR) as the best elsewhere
  maxCallsPerDay: 1,
  wireKeep:     500,               // league-wire entries kept (this season and last)
});

// §99 the game reminder: a push this long before each of our first pitches,
// for the next few games (re-synced as the schedule moves).
export const GAME_REMINDER = Object.freeze({ leadMs: 30 * 60_000, ahead: 3 });

// §90 an advance scouting report on a rival (a decision card when it gets better).
export const ADVANCE_SCOUT = Object.freeze({
  batHit:    1.03,                 // our hitters' hit rate against them
  pitchHit:  0.975,                // their hitters' against us
  costK:     25,                   // at a typical market; scaled like card money (CARD_MONEY_BASE_TARGET_K)
});

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

// §102.2 How the weather plays (SimEngine): inside every plate appearance, an
// inning at a time, from the park report (GameWeather.gameConditions).
//   home runs: warm air and wind blowing out carry the ball; cold air and wind blowing in knock it down
//   hits:      a little more in warm air / wind out, a little less while it rains
//   walks:     a wet ball is hard to grip; so is a cold one
export const SIM_WEATHER_ENV = Object.freeze({
  BASE_TEMP_F:      72,
  BASE_WIND_OUT:    5,       // mph blowing out on a typical night: no effect
  HR_PER_DEG:       0.007,   // +0.7% home runs per °F
  HR_PER_MPH_OUT:   0.018,   // +1.8% per mph blowing out (−1.8% per mph in)
  HR_MIN: 0.6, HR_MAX: 1.5,
  HIT_PER_DEG:      0.0012,
  HIT_PER_MPH_OUT:  0.0015,
  HIT_PER_MMH_RAIN: 0.004,
  HIT_MIN: 0.93, HIT_MAX: 1.07,
  RAIN_MIN_MMH:     0.5,     // below this it's not wetting the ball
  WALK_PER_MMH:     0.025,
  WALK_RAIN_MAX:    0.2,
  COLD_F:           45,
  WALK_COLD:        0.04,
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

// §102 (step 4a) How weather plays out at a ballpark (engine/GameWeather.js).
// Read off the same weather the radar and the park reports show.
export const GAME_WEATHER = Object.freeze({
  STEP_MIN:            5,     // the venue is checked every 5 minutes
  PLAY_MIN:            180,   // nine innings of playing time: SimEngine paces each half-inning at 10 minutes
  HALF_MIN:            10,
  PLAN_MAX_MIN:        270,   // a plan covers up to 13½ innings of play (the game uses as much as it lasts)
  OFFICIAL_PLAY_MIN:   100,   // ≈ 5 innings of playing time (the sim decides by the actual innings)
  ARM_COOL_MIN:        45,    // a pitcher doesn't go back out after a delay this long
  STOP_RATE_MMH:       7.5,   // rain this hard (≈ 0.3 in/hr) brings the tarp out at once
  SOAK_RATE_MMH:       2.5,   // steady rain this hard…
  SOAK_MIN:            20,    // …for this long does too
  SNOW_DBZ:            18,    // snow or sleet this heavy stops play
  LIGHTNING_CLEAR_MIN: 30,    // play waits until 30 minutes after the last lightning within 10 miles
  DRY_RATE_MMH:        1.0,   // no more than a sprinkle…
  DRY_MIN:             15,    // …for 15 minutes before the tarp comes off
  PREP_MIN:            15,    // then the grounds crew needs 15 minutes…
  PREP_PER_MM:         1.0,   // …plus a minute a millimetre that fell during the delay
  PREP_MAX_MIN:        40,
  CURFEW_LOCAL_H:      1,     // play doesn't start or resume after 1 AM local
  CREW_CHECK_MIN:      30,    // during a delay, every 30 minutes the crew reads the forecast and may call it
  PREGAME_CALLS_MIN:   Object.freeze([180, 90]),   // the club reads the forecast this long before first pitch, and postpones
                                                   // when the forecast shows no game (by the same rules as the day itself) and
                                                   // the chance the GM sees is at least its patience's callChance (§122.51)
  // §122.51 the field is covered before the game: the tarp goes on for rain this hard (Light Rain and up) lasting
  // TARP_ON_MIN (at once for a downpour or snow), from PREGAME_TARP_MIN before first pitch. First pitch waits for the
  // tarp to come off (the delay rules: a sprinkle for DRY_MIN, 30 minutes past lightning) and the crew's work after it.
  // Starting is a higher bar than going on: once under way, play continues until STOP / SOAK above.
  PREGAME_TARP_MIN:    180,
  TARP_ON_RATE_MMH:    1.0,
  TARP_ON_MIN:         10,
  // §122.51 the crew looks at the radar before pulling the tarp: it comes off only when the forecast run of the hour
  // (the radar's next frames) shows this long clear — before the game, no rain at the tarp's bar or lightning; in a
  // game, nothing that would stop play again. A lull with more rain right behind it keeps the tarp on.
  CREW_WINDOW_MIN:     45,
  // §122.51 how long a club waits, by how hard the game is to make up (GameEngine sets game.wxPatience):
  //   startWait — no first pitch within this long of the scheduled time → postponed;
  //   delayMax  — a delay this long once under way → called;
  //   callLate  — a forecast (ahead, or the crew's checks during a held start) showing first pitch this late or
  //               later is as good as no game: the club calls it rather than keep everyone waiting;
  //   callChance — the forecast chance (3 h, 90 min before) a club needs to call it off ahead.
  PATIENCE: Object.freeze({
    spring: Object.freeze({ startWait: 60,  delayMax: 60,  callLate: 45,  callChance: Object.freeze([50, 40]) }),   // nothing at stake, no makeup
    easy:   Object.freeze({ startWait: 150, delayMax: 150, callLate: 90,  callChance: Object.freeze([70, 60]) }),   // a doubleheader later this series
    normal: Object.freeze({ startWait: 180, delayMax: 150, callLate: 120, callChance: Object.freeze([70, 60]) }),
    hard:   Object.freeze({ startWait: 210, delayMax: 150, callLate: 165, callChance: Object.freeze([80, 70]) }),   // no good makeup date
    post:   Object.freeze({ startWait: 210, delayMax: 180, callLate: 165, callChance: Object.freeze([80, 70]) }),   // the league decides (postseason)
  }),
  // §122.51 the crew isn't perfect: getting the tarp off and the field ready runs long now and then (more water than
  // expected, the tarp snagging). Seeded per delay; drainage and field prep (r170) make it less likely. The forecast,
  // and so the crew's estimate, doesn't know it's coming.
  TROUBLE: Object.freeze({ chance: 0.12, minMin: 10, maxMin: 30, drainageCut: 0.25, prepCut: 0.5 }),
  TROUBLE_SEEN_MIN:    10,    // …found out this long after the tarp comes off (the crew's estimate moves then)
  // §122.51 (phase 3) the GM's say: extra hands save this share of the crew's trouble; batting practice runs from
  // BP_FROM_MIN to BP_TO_MIN before first pitch (on the field, rain on the open field is BP_OPEN_MM_WORK × the work).
  EXTRA_HANDS_CUT:     0.5,
  BP_FROM_MIN:         180,
  BP_TO_MIN:           90,
  BP_OPEN_MM_WORK:     2,
  SOGGY_IN:            1.5,   // this much rain in the 6 hours before first pitch → field work first
  SOGGY_WORK_MIN:      30,
  WASHOUT_IN:          3.0,   // this much → the field is unplayable: postponed
  SNOW_COVER_MM:       4,     // this much snow (melted) in the 12 hours before → postponed
  // §102.3 (4c) the schedule
  PLAN_AHEAD_MIN:      240,   // a game's plan is worked out this long before first pitch (the club's first look is at 3 hours)
  MAKEUP_OFFDAY_DAYS:  14,    // a common off day this soon is used for a makeup…
  // …otherwise a doubleheader, one ticket for both games (§122.51): before a night game the makeup is game one,
  // DH_NIGHT_LEAD_MIN earlier; before a day game the makeup takes its time and that game follows DH_GAP_MIN later.
  // Game two never starts sooner than DH_BREAK_MIN after game one ends (GameEngine._wxHoldForClubs).
  DH_NIGHT_FROM_H:     17,
  DH_NIGHT_LEAD_MIN:   210,
  DH_GAP_MIN:          210,
  SLOT_MIN_LEAD_MIN:   120,   // a makeup or resumption is never set sooner than this
  DH_BREAK_MIN:        30,    // a doubleheader's second game starts no sooner than this after the first ends
  // §102.5 the weather's decisions for the GM
  START_CARD_LEAD_MIN: 180,   // three hours before first pitch, the manager reads the forecast…
  START_CARD_CHANCE:   60,    // …and asks about the starter if rain is this likely during the game
});

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
export const PRESTIGE_POINTS_ALLSTAR_HOST             =  40;  // alias — PrestigeEngine uses this name
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

// The host's share, as a share of the club's payroll target (§78: §17.3's
// "$10–15M" was written before money moved — in this league's economy, a
// $22M-payroll club, that was 60% of payroll. A host's take is a few percent).
export const ALLSTAR_HOSTING_REVENUE_SHARE_MIN   = 0.05;
export const ALLSTAR_HOSTING_REVENUE_SHARE_MAX   = 0.08;
export const ALLSTAR_HOSTING_ATMOS_BUMP          = 15;
export const ALLSTAR_HOSTING_OWNER_TRUST_BUMP    = 10;
export const ALLSTAR_HOSTING_GM_REL_BUMP         =  5;  // with all league teams

// ── The All-Star Game itself (§75) ─────────────────────────────
// Every season: Division A's stars vs Division B's, on day ALLSTAR_GAME_BREAK_DAY
// of the break, in the host's ballpark (the host's division bats last).
export const ALL_STAR_BREAK_DAYS           = 4;
export const ALLSTAR_GAME_BREAK_DAY        = 2;          // 1-based day of the break
export const ALLSTAR_GAME_TIME             = '8:00 PM';
export const ALLSTAR_SELECTION_AFTER_GAME  = 58;         // rosters named after the user's 58th regular game
export const ALLSTAR_SQUAD_IDS             = Object.freeze({ A: 'ASA', B: 'ASB' });
// Per squad: one starter at each lineup slot (fan vote), reserves, a staff.
export const ALLSTAR_SQUAD_SIZE            = Object.freeze({ HITTERS: 13, SP: 6, RP: 5 });
export const ALLSTAR_MAX_PER_CLUB          = 6;          // beyond the elected starters
export const ALLSTAR_MIN_PA                = 60;         // below this, OVR (reputation) carries the vote
export const ALLSTAR_MIN_IP                = 20;
export const ALLSTAR_STARTER_INNINGS       = 2;          // everyone else pitches one
export const ALLSTAR_SUBS_FROM_INNING      = 5;          // the reserves come in from here
export const ALLSTAR_INFLUENCE_BOOST       = 0.08;       // host GM lobbying for a bubble player (vote score ×)

// ── Hosting score: the league's impression of the ballpark (§75) ──
// Never shown as a number. Grows from home games played in a lively park,
// facility decisions on cards (`_hosting: { yes, no }`), and a full season of
// high atmosphere; a fraction carries into the next season (the league's
// memory fades), so a bid is built by SUSTAINED effort.
export const HOSTING_PTS_PER_ATMO_POINT    = 0.1;        // per home game, per atmosphere point above the floor
export const HOSTING_ATMO_FLOOR            = 55;
export const HOSTING_SEASON_ATMO_TARGET    = 70;         // avg home atmosphere for the season bonus
export const HOSTING_SEASON_ATMO_BONUS     = 100;
export const HOSTING_SCORE_CARRYOVER       = 0.85;
export const ALLSTAR_HOSTING_MIN_ATMOSPHERE = 65;
export const ALLSTAR_POST_GLOW_GAMES       = 20;         // home-crowd lift after hosting

// ─────────────────────────────────────────────────────────────
// ARCHETYPE PARAMETERS (Section 16.6) — all $M
// ─────────────────────────────────────────────────────────────

// All monetary values in $K (thousands).
// Display formatter: formatMoney(amountK) in ui/formatters.js handles $K vs $M display.
// League talent around the user's archetype (§69). A CPU club's base OVR is
//   CPU_STR_CENTER×100 + (str − CPU_STR_CENTER)×100×CPU_STR_SPREAD + offset
// `str` keeps each club's place in the pecking order; the spread keeps the
// league's best and worst clubs inside a realistic band (~.350–.640); the
// offset sets how good the league is around the user, so typical season-1
// records land near the owner's win target (ember 68, contender 88, empire 95,
// gambler 72–88, lab 78, institution 82 — of 132). Calibrated with full
// simulated seasons (≈2.75 user wins per point of strength gap; one offset
// point ≈ 0.85 points of CPU lineup/rotation strength).
export const CPU_STR_CENTER  = 0.52;
export const CPU_STR_SPREAD  = 0.5;
export const LEAGUE_TALENT_OFFSET_BY_ARCHETYPE = Object.freeze({
  ember: 8, contender: 11, empire: 17, gambler: 14, lab: 11, institution: 16,
});

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

export const SAVE_SLOT_LIMIT_FREE    = 99;  // TODO Phase 18 — lower to 1 when monetization ships
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
  // Series-result screens fire at the END of a multi-game series via custom
  // logic in checkMilestone (_checkSeriesMilestone), NOT the generic
  // phase/game trigger. isSeries flags them so the generic loop skips them.
  SERIES_WON: {
    id:           'SERIES_WON',
    title:        'Series Won',
    subtitle:     'Took the series. On to the next.',
    palette:      'triumph',
    icon:         '✅',
    isSeries:     true,
    triggerPhase: null,
    triggerGame:   null,
  },
  SERIES_LOST: {
    id:           'SERIES_LOST',
    title:        'Series Lost',
    subtitle:     'Dropped this one. Bounce back.',
    palette:      'respectful',
    icon:         '📉',
    isSeries:     true,
    triggerPhase: null,
    triggerGame:   null,
  },
  SERIES_SPLIT: {
    id:           'SERIES_SPLIT',
    title:        'Series Split',
    subtitle:     'Even this time. Take the next one.',
    palette:      'neutral',
    icon:         '➗',
    isSeries:     true,
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
// §4.1 the yearly change per sub-rating by window (GROWTH…STEEP), in the
// order [contact|control, power|stuff, speed|stamina]. Used going forward at
// each winter (OffseasonEngine) and backward for the league's past (§122.9).
export const AGE_CURVES = Object.freeze([
  Object.freeze([1.5, 0.5, -0.5, -1.5, -3.0]),
  Object.freeze([1.0, 0.5, -1.0, -2.0, -3.5]),
  Object.freeze([0.5, 0.0, -1.5, -2.5, -4.0]),
]);

// r207 §122.85 the glove's yearly change by window (GROWTH…STEEP): it grows faster than the bat young,
// holds at 25–27 and fades sooner and faster in the 30s (range goes first). Our bench coach's winter work
// adds to it (CoachEngine.winterBonus 'defense': quality, +0.5 with the defense specialty).
export const DEF_AGE_CURVE = Object.freeze([2.0, 0.0, -2.0, -3.0, -4.5]);

// r213 §122.91 the staff's working day (local): messages are planned inside it. There are no quiet hours on
// the phone any more (its own settings silence it); a game's news comes with the game, an emergency any hour.
export const STAFF_HOURS = Object.freeze({ start: '08:00', end: '22:00' });
export const STAFF_QUIET = Object.freeze({ quietStart: STAFF_HOURS.end, quietEnd: STAFF_HOURS.start });

// r214 §122.93 a message written in the night that can wait comes in the morning: spread over this long from 8am, and
// only if its answer isn't due within `dueAfterMs` of that.
// Only the staff's own looks (after a game): a message answering something the GM just did (benching a player at
// midnight opens a spot) comes at once.
export const MORNING = Object.freeze({ spreadMs: 90 * 60_000, dueAfterMs: 2 * 3_600_000,
  cards: Object.freeze(['rest_ask', 'roster_advice', 'lineup_return']) });

// r214 §122.93 the between-games pool, paced over the regular season: each day adds (what the pool still has to give ×
// share ÷ the games left); a card is drawn only on a whole credit. `cap`: credit never piles past it.
export const STORY_PACE = Object.freeze({ cap: 2.5, share: 0.75 });

// r217 §122.96 off days and road trips: on the first whole day with no game before the next one, a message this often
// (and a second this often); on a road game day, one more this often.
export const AWAY_DAY = Object.freeze({ offday: 0.8, offdayExtra: 0.2, road: 0.55 });

// r218 §122.97 the winter, a day at a time: a day with this many decisions already is busy (nothing more); a quiet day
// gets a message this often, a news one this share of the time.
export const WINTER_STORY = Object.freeze({ busy: 2, chance: 0.9, newsShare: 0.35 });

// r221 §122.100 story arcs: at most this many running; after one of our games, a new one starts this often (when a
// situation fits); a step comes the next day, 11:00–12:30. The veteran's last question this many games from the end;
// a prospect this young with this much more in them than the rating; the shuttles and the street cleanup (shares of
// the payroll); a coach this good is asked about, and gets the job this often; a losing streak this long starts a feud,
// which flares again this often if left alone.
export const ARC = Object.freeze({
  maxActive: 2, startChance: 0.06, veteranGamesLeft: 12, veteranLastStart: 80, prospectAge: 24, prospectUpside: 3,
  shuttleShare: 0.004, meetShare: 0.002, coachQuality: 65, coachGetsJob: 0.5, feudStreak: 4, feudFlares: 0.5,
});

// r220 §122.99 callbacks: after one of our games, this often a callback is looked for (for the next afternoon, 1–4pm);
// a booking that comes back offers this share of what it paid last time; the same kind about the same player waits this long.
export const CALLBACK = Object.freeze({ chance: 0.25, backShare: 1.2, samePlayerDays: 60 });

// r219 §122.98 the GM's profile: each season before last counts `fade` as much as the one after it; a dimension is
// (its leans) ÷ (base + perDecision × the decisions counted), so it moves after a few weeks of answers. What it changes:
// how often a kind of ask comes (weight: ×(1 + this × the dimension)); a delegating GM (handsOn at or under
// `delegateAt`) is told what the default will be; our own players' asks (× 1 − loyalAsk × loyal); the month the
// small asks are held back (×freezeWeight).
export const PROFILE = Object.freeze({
  fade: 0.6, base: 6, perDecision: 0.2, handsOnLean: 0.2,
  weight: Object.freeze({ spender: 0.6, communityFocused: 0.5, aggressive: 0.4, processDriven: 0.4 }),
  delegateAt: -0.35, loyalAsk: 0.05, freezeWeight: 0.3, freezeDays: 30,
});

// r218 §122.97 messages from what's happening (Situations): none before this many regular-season games; a first-year
// player (this age or younger) hitting this well over these games (at-bats at least), or pitching this well over
// these outings (innings at least); this many on the IL with one this week (and the gap before it comes again); a
// regular this cold over these games (at-bats at least; the gap for that player, and between any two); the closest club in the division, this many games
// apart; money as a share of the payroll (the scoreboard moment, the specialist, the rivalry weekend).
export const SITUATIONS = Object.freeze({
  minGames: 15, rookieAge: 25, rookieGames: 15, rookieAb: 40, rookieAvg: 0.33, rookieStarts: 4, rookieIp: 18, rookieEra: 2.5,
  ilRun: 3, ilRecentDays: 4, ilGapDays: 30, slumpGames: 10, slumpAb: 30, slumpAvg: 0.125, slumpGapDays: 40, slumpTeamGapDays: 12, rivalGap: 3,
  markShare: 0.002, specialistShare: 0.006, rivalShare: 0.003,
});

// r216 §122.95 the stretch run and October as a story: each stretch step with this many regular-season games left;
// money as a share of the payroll (at least minK): the ticket bump, the owner's bonus pool, a playoff gate, the parade.
export const STRETCH_STORY = Object.freeze({
  gamesLeft: Object.freeze({ race: 25, tickets: 18, toll: 12, lastweek: 6, lastday: 1 }),
  minK: 40, ticketShare: 0.012, bonusShare: 0.01, playoffShare: 0.02, paradeShare: 0.015, celebrateK: 30,
});

// r215 §122.94 the trade deadline as a story: each step this many of our regular-season games before the deadline
// game (TRADE_DEADLINE_CLOSE); "final" is deadline day, "after" the morning after. aheadK: the scouts' extra time
// ("get ahead of it"); the owner's payroll room for a buyer: this share of the payroll (at least roomMinK).
export const DEADLINE_STORY = Object.freeze({
  gamesOut: Object.freeze({ owner: 14, market: 10, player: 7, manager: 5, shortlist: 4, rival: 3, money: 2 }),
  aheadK: 20, roomShare: 0.05, roomMinK: 250, sellCalls: 2,
});

// r213 §122.91 after-hours emergencies: how many a season, when in the night (minutes from the midnight before
// a game of ours), how long before that game at the least, and when an answer is due (hours after, and before
// first pitch).
export const EMERGENCY = Object.freeze({
  perSeason: [2, 4], nightFromMin: -30, nightToMin: 270, minLeadH: 8, answerH: 7, beforeGameH: 2, minGapGames: 12,
});

// ─────────────────────────────────────────────────────────────
// PLAYER RETIREMENT THRESHOLDS (Section 20.7 — LOCKED)
// ─────────────────────────────────────────────────────────────

export const RETIREMENT_AGE_HARD  = 38;  // retires regardless of OVR
export const RETIREMENT_AGE_SOFT  = 35;  // retires if OVR also below RETIREMENT_OVR_SOFT
export const RETIREMENT_OVR_SOFT  = 55;  // OVR threshold for age-35+ retirement
export const RETIREMENT_SOFT_ODDS = 0.6; // the share of those who decide to retire

// r222 §122.101 the plan to retire, settled once a season (engine/Retirement.js). A player planning to retire tells
// their club between these regular-season games (ours: the manager's word; one who joins us after it: known on
// arrival); the word goes out only within `lateGames` of it. The veteran arc's "one more year": the player says yes
// at `base`, ± `rel` × how they feel about the GM (−1…+1), `old` at 38 or older next season, `poor` after a poor season.
export const RETIRE_PLAN = Object.freeze({
  tellGames: [10, 50], lateGames: 3,
  oneMore: { base: 0.5, rel: 0.2, old: -0.15, poor: -0.10 },
  // r223 the scouts asked about another club's player or a free agent (35+ next season): right this often, by the
  // director (40 → 90 quality), the same answer all season
  scout: { worst: 0.70, best: 0.90 }, askAge: 35,
});

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

// Base injury probability per game/appearance.
// Rebalanced r60 (user decision, §66): MLB IL stints split roughly evenly
// between pitchers and position players. Per team-game: 9 hitters × 0.0055
// ≈ 0.050; 1 SP × 0.020 + ~3 RP × 0.010 ≈ 0.050 — same total as before
// (≈0.10), pitchers ~50% instead of ~30%.
export const INJURY_PROB_HITTER_PER_GAME   = 0.0055; // 0.55% per game
// r63: with balanced leagues (§69) starters go deeper and the share drifted to
// ~43% across seeds; SP/RP nudged back toward an even split.
export const INJURY_PROB_SP_PER_START      = 0.023;  // 2.3% per start
export const INJURY_PROB_RP_PER_APP        = 0.0095;  // 0.95% per appearance (r61: real CPU box scores add relief outings)

// Age modifiers (additive)
// §118 injuries happen during the game, on a play. The per-game chances above
// are spread over a typical game's exposure — a hitter's plate appearances, a
// pitcher's batters faced — so the season rate is what it was when they were
// rolled after the final out. (Tuned against tools/harness/measure-injury-rate.mjs.)
export const INJURY_EXPOSURE = Object.freeze({ hitterPA: 4.21, starterBF: 23.0, relieverBF: 5.17 });   // measured: the sim's averages per appearance
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

// ── Real-clock injury timeline (§65) ─────────────────────────
// Injury lengths are REAL days measured from the moment of injury (one game
// per real day). The IL has a minimum stay, like MLB's 10-day (position
// players) and 15-day (pitchers) lists; an IL stint is backdated to the
// injury, so a 6-day hamstring still costs a hitter 10 days on the IL.
export const IL_MIN_DAYS_HITTER            = 10;
export const IL_MIN_DAYS_PITCHER           = 15;
// "Season-ending" is stored as a long real-day stint so every timeline stays
// numeric; the offseason clears all injuries anyway.
export const INJURY_SEASON_ENDING_DAYS     = 200;
// Day-to-day is only offered when the confirmed timeline is this short —
// beyond it the physician will not sign off on keeping him active.
export const INJURY_DTD_MAX_DAYS           = 10;
// Act 2 diagnosis can revise the timeline (Act 1 is the on-field read).
export const INJURY_ACT2_BETTER_MULT       = 0.6;
export const INJURY_ACT2_WORSE_MULT        = 1.4;
// Act 1 choice: MRI tonight (diagnosis in 60–120 min, so a move made before
// midnight reports tomorrow) vs. wait for the morning exam (diagnosis 9:00–10:30).
export const INJURY_MRI_COST_K             = 15;      // $15K, charged to operating budget
export const INJURY_MRI_RESULT_MIN_MS      = 60 * 60_000;
export const INJURY_MRI_RESULT_MAX_MS      = 120 * 60_000;
export const INJURY_MORNING_EXAM_HOUR      = 9;       // local, + up to 90 min

// ── Roster transactions on a real clock (§65) ────────────────
// Every arrival — traded player, farm call-up — reports the next calendar
// day (local midnight after the move). Roster decisions on open spots are
// due this long before the next first pitch; after that the field manager
// makes the call-up himself (by position and seniority, not best rating)
// and the front office takes a small hit for not acting.
export const ROSTER_DECISION_LEAD_MS       = 60 * 60_000;   // 1 hour before first pitch
// §122 an open spot's deadline is the night before the next game day when there's time
// (a signing then reports for that game), else an hour before first pitch.
export const VACANCY_MIN_WINDOW_MS        = 3 * 3600_000;
// §122 the winter call: our open spots get a deadline the night before camp opens,
// asked this many days ahead (a signing reports when camp opens).
export const WINTER_ROSTER_CALL_DAYS      = 3;
export const MANAGER_FILL_PENALTY          = Object.freeze({ ownerTrust: -2, atmosphere: -1 });
// Fallback length of a game when its plays are not available (3 hours).
export const GAME_DURATION_FALLBACK_MS     = 3 * 60 * 60_000;
// Waiver wire (Section 20.2 — LOCKED): 72-hour real-world claim window. A
// claimed player reports to his new club the next calendar day; an unclaimed
// player is outrighted to the placing team's farm (farm-overflow displacements
// go to free agency instead).
export const WAIVER_CLAIM_WINDOW_MS        = 72 * 60 * 60_000;
// A CPU club claims only a real upgrade: at least this many OVR points over
// the weakest active player he would replace.
export const WAIVER_CLAIM_MIN_UPGRADE      = 3;
// Completed transactions kept for the Team screen's recent list.
export const TRANSACTION_HISTORY_KEEP      = 60;

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
export const IMP_H_SB_WEIGHT           = 0.1;   // per net steal over 600 PA (a rate: §122.9)
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

// §122.9 one scale for hitters and pitchers (measured over a full season:
// regulars' raw hitter sd 1.2, pitchers' 8.7), so a regular runs about −3 to +6
// and "elite" (6+) is a handful of players a season.
export const IMP_H_SCALE               = 1.6;
export const IMP_P_SCALE               = 0.26;
// A small sample counts for less: IMP × n / (n + this), n in PA or IP.
export const IMP_SHRINK_PA             = 40;
export const IMP_SHRINK_IP             = 10;

// Display thresholds
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
export const IMP_MIN_BF_7    = 15;   // minimum batters faced in 7-day window (pitchers)
export const IMP_CS_COST     = 1.5;  // caught stealing penalty multiplier in SB net formula
export const IMP_MIN_PA_15   = 20;
export const IMP_MIN_PA_30   = 40;
export const IMP_MIN_PA_SEASON = 80;
export const IMP_MIN_IP_7    = 2.0;   // §122.9 lower: small samples are shrunk (IMP_SHRINK_IP)
export const IMP_MIN_IP_15   = 4.0;
export const IMP_MIN_IP_30   = 8.0;
export const IMP_MIN_IP_SEASON = 15.0;

// ─────────────────────────────────────────────────────────────
// FRANCHISE TURNING POINT
// ─────────────────────────────────────────────────────────────

// Eligible archetypes check against ARCHETYPE[id].turningPointEligible
// Fired once per franchise lifetime; enforced via state.turningPointFired: Boolean

// ─────────────────────────────────────────────────────────────
// OFFSEASON ON THE LEAGUE CALENDAR (§70)
// ─────────────────────────────────────────────────────────────
// §112 Ten calendar days, starting the midnight after the World Series ends;
// spring training opens the midnight after day 10. Every step happens at a
// fixed local hour of its day (catch-up runs them in order at their times).
export const OFFSEASON_DAYS = 10;
export const OFFSEASON_STEP_HOURS = Object.freeze({
  day1: 0,     // the season review: record locked, stats archived, players age & develop, retirements
  day2: 10,    // the staff: the manager's contract (coaches' evaluations — §112 B)
  day3: 10,    // hiring (§112 B)
  day4: 10,    // contracts: CPU decisions, farm renewals; our re-sign cards
  day5: 10,    // free agency opens
  day6: 10,    // the winter meetings (§112 E); free agency
  day7: 10,    // the winter meetings; free agency
  day8: 10,    // free agency, second round
  day9: 10,    // the front office (§112 D); reminder for required decisions
  day10: 10,   // spring eve: the last free-agency round
  spring: 0,   // (day 11) required decisions auto-resolve; spring training opens
});
export const OFFSEASON_CARD_HOUR     = 9;    // ownership / contract / manager cards arrive
export const OFFSEASON_FA_CARD_HOUR  = 12;   // free-agent cards arrive (days 5 and 8)
export const OFFSEASON_REVIEW_HOUR   = 11;   // §112 the manager's season review and the winter's priority (day 1)
export const FA_CARD_TTL_DAYS        = 3;    // §23.2 soft gate: auto-decline after 3 days
export const FA_CARDS_PER_ROUND      = 3;

// §80 The game day's inbox: how many cards each moment of a game day brings.
// Planned once per game (at the final of the one before, at team creation, or
// on the first tick that finds the next game unplanned).
// §78.5 A minimum-salary move ($K, a 50–54 player) is always allowed, however
// tight the books: any club can fill a hole with depth at the league minimum.
export const FIN_MIN_MOVE_K = 150;

// §78.5 CPU clubs' books.
export const FIN_CPU = Object.freeze({
  staffShare:     0.03,   // coaching staff budget, as a share of the opening payroll
  targetHeadroom: 0.08,   // the owner's target sits this far over the opening payroll
  targetFloorShare: 0.70, // no owner budgets below this share of the league's median payroll
  inSeasonLift:   0.05,   // call-ups and IL replacements: what a club really carries over its opening payroll
});

export const CARD_DAY = Object.freeze({
  betweenMin:         1,      // cards between games (decisions, the front office)
  betweenExtraChance: 0.5,    //   + a second one this often
  pregameChance:      0.55,   // a card in the hours before first pitch
  ingameChance:       0.40,   // a card while the game is being played
  leaveChance:        0.05,   // a player's personal leave (regular season)
  ingameLastMs:       150 * 60_000,   // no in-game card after the 7th-inning stretch or so
  ingameExpireMs:     210 * 60_000,   // in-game cards lapse when the game is over
});
// §105 Compose: how long each person takes to write back, in minutes [soonest, latest]
// (most replies land early in the window). Field staff work the game: they answer after it.
export const COMPOSE_REPLY = Object.freeze({
  windows: Object.freeze({
    groundskeeper:   [15, 90],
    pitching_coach:  [25, 150],
    hitting_coach:   [25, 150],
    manager:         [30, 180],
    bench_coach:     [30, 180],
    facilities:      [45, 300],
    media_relations: [45, 300],
    ticket_office:   [60, 360],
    community:       [90, 480],
    scouting:        [90, 600],
  }),
  defaultWindow: Object.freeze([30, 240]),
  gameWorkers: Object.freeze(['manager', 'pitching_coach', 'hitting_coach', 'bench_coach', 'groundskeeper']),
  gameLengthMs: 3 * 60 * 60_000,   // a game not yet over is busy until about this long after first pitch
  // r150 a question about something with a deadline (a trade on the table) is answered this far ahead of it…
  beforeDeadlineMs: 2 * 60 * 60_000,
  // …and, inside a short deadline, no sooner than this (or halfway there).
  soonestMs: 15 * 60_000,
});
export const FA_UPGRADE_MIN          = 3;    // OVR over the man he'd replace

// CPU re-sign odds by OVR relative to the league level (§69), then age.
export const CPU_RESIGN_ODDS = Object.freeze([
  { minRel: 65, p: 0.75 },
  { minRel: 58, p: 0.60 },
  { minRel: 50, p: 0.40 },
  { minRel: -99, p: 0.20 },
]);
export const CPU_RESIGN_AGE_34_MULT  = 0.6;
// A player nobody re-signs may take an offer from another league instead of
// testing this league's market (user decision, §70).
export const WALK_ABROAD_PROB_31_PLUS  = 0.35;
export const WALK_ABROAD_PROB_UNDER_31 = 0.15;

// Amateur signings: every club adds young prospects to its farm each spring.
export const PROSPECTS_PER_TEAM_MIN = 2;
export const PROSPECTS_PER_TEAM_MAX = 3;
export const PROSPECT_AGE_MIN       = 19;
export const PROSPECT_AGE_MAX       = 21;
export const PROSPECT_OVR_MIN       = 36;    // + league level
export const PROSPECT_OVR_MAX       = 47;

// Ownership evaluation (§23 hard gate): next season's payroll cap and
// operating budget move with the season against the win target.
export const OWNERSHIP_OFFER = Object.freeze({
  perWin:     0.005,   // ±0.5% per win above / below target
  maxSwing:   0.08,
  champion:   0.05,
  perRound:   0.01,    // per playoff round won
  pushExtra:  0.04,    // "push for more": +4% on the offer …
  pushTrust:  -5,      // … at an owner-trust cost
  autoCut:    -0.03,   // unanswered by spring: ownership decides, 3% tighter
  autoTrust:  -3,
});
export const CONTRACT_AUTO_WALK_MORALE = -1;  // per player let go by default

// ─────────────────────────────────────────────────────────────
// CLUB FUNDS — the money model (§78)
// One account per club. All amounts in $K.
// ─────────────────────────────────────────────────────────────
// Economy: a club that meets its owner's expectations (its starting payroll
// level, its starting atmosphere, a win-target pace) runs near break-even —
// income ≈ FIN_BREAK_EVEN_MARGIN × expected spending. Market differences show
// in local revenue and gates; winning and a livelier park earn more.
export const FIN_MEDIA_SHARE_K        = 3000;   // league media share, equal for every club, per season
export const FIN_BREAK_EVEN_MARGIN    = 1.0;
export const FIN_CARDS_ALLOWANCE      = 0.06;   // expected discretionary spending, share of payroll
export const FIN_LOCAL_SHARE          = 0.45;   // of non-media income: local media & sponsors (the rest is gate)
export const FIN_LOCAL_PER_TIER       = 0.05;   // local income grows with prestige tier
export const FIN_PAYDAYS              = Object.freeze([1, 15]);   // days of the month, regular season
export const FIN_PAYDAY_HOUR          = 10;
export const FIN_PLAYOFF_GATE_MULT    = 1.5;    // the club's share (the players' pool and the league take the rest)
export const FIN_START_FUNDS_SHARE    = 0.15;   // default opening funds, share of the payroll target
// Ballparks and crowds.
export const FIN_CAPACITY_BASE        = 26000;  // + per $1M of starting payroll level
export const FIN_CAPACITY_PER_M       = 450;
// §110 Weather and the gate. Announced attendance is tickets sold: the advance sale (season tickets,
// tickets bought days ahead) barely moves; the walk-up (bought that day) follows the forecast fans see on
// game day, the weather at the gate, and the temperature. A sellout's extra demand absorbs it.
export const FIN_WEATHER = Object.freeze({
  walkShare: 0.24,                       // of a typical crowd, tickets bought on game day
  forecastLeadH: 4,                      // the forecast fans see when they decide (hours before first pitch)
  chanceFrom: 20, chanceTo: 90, chanceCut: 0.55,   // walk-up lost as the chance of rain runs 20% → 90%
  wetCut: 0.45,                          // more walk-up lost when it's raining at the gate (or the start is held)
  temp: [[32, 0.30], [40, 0.45], [48, 0.68], [55, 0.88], [62, 1], [86, 1], [92, 0.9], [100, 0.72]],   // walk-up by °F at first pitch
  walkFloor: 0.15,
  advChanceCut: 0.06, advColdF: 45, advColdCut: 0.04,   // the advance sale: a little, for a wet or cold forecast
  playoffScale: 0.5,                     // a playoff crowd minds the weather half as much
});

// §112.4 how the crowd answers the ticket price: +10% on price → −6% of the
// demand (a sold-out park's extra demand absorbs it first).
export const FIN_PRICE_ELASTICITY = 0.6;
export const FIN_ATTENDANCE = Object.freeze({
  base: 0.44, perAtmo: 0.0045,                 // fill from atmosphere (40 → 62%, 68 → 75%, 95 → 87%)
  formWeight: 0.6, formMin: 0.85, formMax: 1.15, formAfterGames: 10,   // the club's form vs .500
  weekend: 1.08, weekday: 0.95, noise: 0.05, min: 0.25, playoffLift: 0.15,
});

// The owner (§78.4). patienceBase: how much financial strain he tolerates
// before saying anything; redWeight: how much red ink counts against you;
// startFunds: opening funds as a share of the payroll target.
export const OWNER_PROFILE = Object.freeze({
  // cushionUse: how much of the money the club itself is projected to have
  // he'll let cover payroll over the target ("you've earned it — spend it").
  ember:       { patienceBase: 55, redWeight: 2.0, startFunds: 0.10, cushionUse: 0.3 },
  contender:   { patienceBase: 50, redWeight: 1.2, startFunds: 0.15, cushionUse: 0.6 },
  empire:      { patienceBase: 45, redWeight: 0.8, startFunds: 0.20, cushionUse: 1.0 },
  gambler:     { patienceBase: 50, redWeight: 1.0, startFunds: [0.05, 0.25], moodStep: 8, moodMax: 20, cushionUse: 0.8 },
  lab:         { patienceBase: 60, redWeight: 1.2, startFunds: 0.12, costPerWin: true, cushionUse: 0.5 },
  institution: { patienceBase: 50, redWeight: 1.8, startFunds: 0.18, cushionUse: 0.4 },
});
export const OWNER_PATIENCE = Object.freeze({
  pacePerWin: 1.5, paceMax: 30, paceAfterGames: 15,   // projected wins above/below target
  trustWeight: 0.5, trustPivot: 60,
  allowanceFrom: 35, allowancePerPt: 0.6, allowanceMax: 25,   // strain (%) he lets pass silently
  costPerWinOver: 1.2, costPerWinStrain: 5,                   // the Lab: payroll per win vs league
});
// Strain beyond his allowance → stage (points of strain over the allowance).
export const OWNER_STAGE = Object.freeze({ watching: 0, concerned: 8, cuts: 18 });
export const OWNER_TRUST_FX = Object.freeze({
  concernedPerPayday: -2, cutsPerPayday: -3, orderMet: 3, orderMissed: -10,
  redInkPerPct: -0.5, redInkMax: -15,          // season-end red ink the owner covers
});
export const OWNER_ORDER_TARGET_PENALTY = 0.05;  // next season's payroll target, per missed order
export const FIN_TOLERANCE_MAX        = 0.15;    // most he'll let payroll run over target when happy
export const FIN_OVERDRAFT_SHARE      = 0.5;     // of that tolerance, as red ink he'll allow for a bonus
export const FIN_BOOKS_OFFER = Object.freeze({ perMargin: 0.5, max: 0.05 });  // season's profit margin → next target
export const MANAGER_EXTENSION_YEARS   = 2;
export const MANAGER_AUTO_CONFIDENCE   = -5;

// Market players by kind: ages, and OVR relative to the league level (MarketEngine; §122 the opening free-agent pool).
export const MARKET_KINDS = Object.freeze({
  veteran:  { ageMin: 30, ageMax: 35, ovrMin: 52, ovrMax: 62 },   // OVR relative to the league level
  depth:    { ageMin: 26, ageMax: 32, ovrMin: 47, ovrMax: 56 },
  prospect: { ageMin: 18, ageMax: 22, ovrMin: 38, ovrMax: 48 },
  intl:     { ageMin: 17, ageMax: 21, ovrMin: 36, ovrMax: 50 },
  indie:    { ageMin: 22, ageMax: 27, ovrMin: 42, ovrMax: 52 },
});

// §122 Free agency without a farm.
export const FA_ASK = Object.freeze({
  inSeasonShare: 0.8,     // an in-season one-year deal: this share of his market salary…
  dropPerDay:    0.03,    // …less this much for each day he's gone unsigned…
  floorShare:    0.5,     // …never below this share of it…
  minK:          50,      // …nor the league minimum ($K).
});
// r200 §122.77 a contract's price counts how the player played, not only the rating. Impact runs
// with OVR across the league (a season sim, r200: hitters and starters alike, ≈ 0.223 Impact per
// OVR point above the league level, corr ~0.73): the season's Impact, read back as an OVR, pulls
// the price's OVR toward it — by `weight` with a full season behind it, less on a part season.
// r204 §122.82 free agents the scouting director watches for us: at most `max` at once, for `days`; a club
// moving to sign one gives us `warnMs` (half a day) to sign first.
export const FA_WATCH = Object.freeze({ max: 3, days: 30, warnMs: 12 * 3600_000 });

// r201 §122.78 an agent asks to redo a deal after a breakout (at the All-Star break and at season's end):
// the player plays at least `minShift` OVR better than the rating and the market price is at least
// `minRaise`× (and `minRaiseK` more than) the salary. The deal runs the market's length past the current
// one (at most `maxYears`). A counter meets `moneyShare` of the raise, or cuts
// `fewerYears` seasons; the agent takes it at `odds` ± the player's view of the GM. Put off twice, the
// player plays out the deal and leaves.
export const AGENT_ASK = Object.freeze({
  minShift: 3, minRaise: 1.25, minRaiseK: 200, moneyShare: 0.6, fewerYears: 2, maxYears: 6,
  odds: Object.freeze({ money: 0.45, years: 0.55 }), relSwing: 0.5, oddsMin: 0.15, oddsMax: 0.85,
  relHit: 6, replyMinutes: Object.freeze([40, 180]), ttlDays: 3, waitHours: 2,
});

export const MARKET_PERF = Object.freeze({
  impAt0:   -11.9,   // Impact expected at OVR = the league level (leagueTalentOffset)…
  impPer:   0.223,   // …and per OVR point above it
  weight:   Object.freeze({ hitter: 0.5, SP: 0.5, RP: 0.3 }),   // a full season moves the price's OVR this share of the way to what it played like (relievers' lines are noisier, corr ~0.5)
  maxShift: 8,       // never more than this many OVR points either way
  prevWeight: 0.6,   // last season fills in for what this one hasn't shown yet, at this weight
  full: Object.freeze({ hitter: 500, SP: 150, RP: 55 }),   // a full season: plate appearances / innings
});
export const FA_CPU_UPGRADE_MARGIN = 5;   // a CPU club signs a free agent this many OVR better than its weakest at the role
export const FA_CPU_LOOK_HOUR      = 10;  // when each CPU club looks at the free agents, every day (local hour)
export const FA_POOL_MAX          = 260; // the free-agent market's size at the new season (the least promising go home past it)
export const FA_TRIM_SCOUTED_KEEP_MS = 60 * 86_400_000; // §122.14 a player the scouts reported this long ago or less isn't sent home by the trim


// ─────────────────────────────────────────────────────────────
// §122.9 THE LEAGUE'S PAST — prior seasons for every player at league creation
// (engine/LeagueHistory.js). Ratings are relative to the league level (rel).
// The run/RBI/steal/earned-run rates were fit to a full simulated season.
// ─────────────────────────────────────────────────────────────
export const HISTORY = Object.freeze({
  firstAge:     20,      // nobody played in the league younger
  walkMod:      1.1,     // the game walks a little more than the bare model (tired arms, nerves): measured
  // Was he in the league that year? A logistic on his rating then (rel).
  inLeagueMid:  { hitter: 37, SP: 41, RP: 39 },
  inLeagueSlope: 0.35,
  minorsStopAge: 25,     // a year out of the league before this age: he hadn't arrived yet
  // Playing time by rel: [rel at least, low, high] — PA for hitters, IP for pitchers.
  playing: Object.freeze({
    hitter: [[47, 480, 610], [41, 220, 460], [35, 60, 240], [-99, 12, 80]],
    SP:     [[50, 130, 185], [44, 70, 140], [-99, 15, 70]],
    RP:     [[48, 50, 68],   [42, 30, 58],  [-99, 8, 35]],
  }),
  injuredShare: 0.10,    // a season cut short (playing time × 0.25–0.7)
  gamesPerPA:   0.234,
  sfPerPA:      0.0032,
  // Runs beyond his home runs: per time on base (less HR), by speed above the league's.
  runBase: 0.277, runPerSpeed: 0.00269,
  rbiBase: 0.425, rbiPerPower: 0.00429,   // RBI beyond HR, per non-HR hit
  sbBase:  0.036, sbPerSpeed:  0.00309,   // per time on first
  csBase:  0.0071, csPerSpeed: 0.00064,
  // Earned runs: (H−HR), (BB+HBP), HR, IP.
  er: Object.freeze([0.472, 0.292, 1.338, -0.202]),
  ipPerStart: 5.8,
  maxGames: 132,
});
// §122.9 the offseason class's players from abroad: older than the rookies.
export const FA_CLASS_INTL_AGE = Object.freeze({ min: 22, max: 29 });
// §122.9 players with no league record: who they are.
export const PLAYER_ORIGIN = Object.freeze({
  LEAGUE:      'league',        // has played in the league
  ROOKIE:      'rookie',        // first season in the league
  OVERSEAS:    'overseas',      // played professionally abroad
  INDEPENDENT: 'independent',   // independent ball
});

// §122.9 untested players and diamonds in the rough (engine/Diamonds.js).
export const DIAMOND = Object.freeze({
  // An untested player's shown ratings are scouts' estimates: true = shown + gap,
  // gap ~ N(0, sigma) per sub-rating, by where he comes from.
  sigma:      Object.freeze({ rookie: 4, overseas: 5, independent: 4 }),
  gapMax:     12,
  revealN:    300,     // PA (hitters) or batters faced (pitchers): the gap shrinks e-fold per this many
  trainExposure: 60,   // a development plan shows the coaches what he has (counts as this much playing)
  edge:       5,       // worth this far above his shown OVR…
  minWorthRel: 47,     // …and worth a lineup or bullpen spot (above the league level): a diamond
  buzzDays:   Object.freeze([10, 30]),   // days after he's available until CPU clubs hear
  // Seeded: unproven upside (true well above shown), and proven role fits
  // (a slow bat, a short reliever: the rating counts speed/stamina the role barely uses).
  opening:    Object.freeze({ upside: 4, role: 2 }),
  classUpside: 3,
  upsideTrueRel: Object.freeze([48, 54]),   // unproven upside: what he really is (above the league level)…
  upsideShownMin: 38,                         // …taken from the untested shown at least this (gaps stay believable)
  gapMaxSeeded: 16,
  roleShownRel: 45,    // a role fit's shown OVR, above the league level: under the CPU clubs' radar
});

// ─────────────────────────────────────────────────────────────
// r159 §122.31 WEAR AND PLAYER WORK
// ─────────────────────────────────────────────────────────────

/**
 * Wear (hitters, every club alike): each start adds 1 (a catcher 1.5). A game
 * off clears it (a day off, whoever made the call); each off day beyond the
 * first takes off `offDay`. At `tired` a hitter's contact and power dip (`dip`,
 * plus 1 for every `dipStep` past it, up to `dipMax`) and the player is likelier
 * to get hurt (the pitchers' fatigue modifier).
 *   levels   — wear in words, on the Team screen and the player card (from):
 *              fresh, fine, tiring, tired, worn.
 *   cpuRest  — a CPU manager sits the most worn-down regular a game (one a game).
 *   Our lineup is the GM's: our manager never sits anyone on his own — the
 *   staff writes instead (REST_WATCH), and only when that message went
 *   unanswered and the player is `worn` does the manager sit the player.
 * r160 §122.32
 */
export const WEAR = Object.freeze({
  catcher: 1.5, offDay: 2, tired: 12, dip: 2, dipStep: 4, dipMax: 5, cpuRest: 20, worn: 18,
  levels: Object.freeze([['fresh', 0, 'Fresh'], ['fine', 5, 'Fine'], ['tiring', 9, 'Tiring'], ['tired', 12, 'Tired'], ['worn', 18, 'Worn down']]),
  meterMax: 24,
  // r161 §122.33 by age: what a start adds (hitters) and what an outing adds (pitchers) —
  // young legs and arms carry more, veterans wear faster. [up to this age, multiplier]
  age: Object.freeze([[25, 0.85], [30, 1], [34, 1.2], [Infinity, 1.4]]),
});

/**
 * r161 §122.33 a pitcher's workload (every club alike), on the same scale and
 * levels as a hitter's wear: an outing adds to it (a start by the batters faced,
 * a relief outing a little plus the batters, more on back-to-back days), times
 * WEAR.age; it comes off a day at a time (`perDay`, divided by WEAR.age — older
 * arms come back slower). At WEAR.tired stuff and control dip like a hitter's
 * bat and the arm is likelier to get hurt. Separate from today's arm
 * (PitchingEngine.armStatus: pitched yesterday, needs four days after a start).
 *   cpuRest — a CPU manager rests the most worn arm at this (one a game): a
 *             starter skips a turn, a reliever gets `relieverDays` down.
 */
export const ARM_LOAD = Object.freeze({
  perStartBF: 0.3, reliefBase: 1.0, reliefPerBF: 0.25, backToBack: 1, perDay: 1.2,
  cpuRest: 20, relieverDays: 2,
});

/**
 * r160 §122.32 the staff's rest messages (our club): when a regular wears down,
 * one of the staff writes — the manager or the pitching coach about a catcher,
 * the hitting coach about a tired bat, the team physician about one worn down.
 * Never a pile-up: one open at a time, `gapMs` between any two, the same player
 * not again for `samePlayerMs` (unless now worn down), never the day the staff
 * already asked about a lineup spot.
 *   catcherAt — a catcher's wear when the staff first speaks up (six straight).
 *   hitterAt  — anyone else's (tiring: the manager; once tired, the hitting coach).
 *   pitcherAt — a starter's (about the next start) or a reliever's workload (the pitching coach).
 */
export const REST_WATCH = Object.freeze({
  catcherAt: 9, hitterAt: 10, pitcherAt: 10, gapMs: 3 * 86_400_000, samePlayerMs: 7 * 86_400_000,
  leadMs: 90 * 60_000,   // the message lands at least this long before first pitch
});

export const PLAYER_WORK = Object.freeze({
  coach: {
    tweaksGain: 0.8, focusedGain: 2.0, focusedDays: 2, focusedDaysLow: 3, lowSkill: 45,
    focusedBelow: 55, focusedGap: 12, focusedCap: 70,
    // r160 a focused day's cost by the player's OVR: $5K at `fromOvr` or below, $10K
    // around OVR 72, up to $20K only for the very best (OVR `topOvr`).
    dayK: { min: 5, mid: 10, max: 20, fromOvr: 50, midOvr: 72, topOvr: 88 },
  },
  // r160 the program's whole cost by OVR: $25K at `fromOvr`, about $50K around 70,
  // $75K around 80, never more than `maxK`; a longer stay (older players) a little more.
  program: { gain: 3.6, days: 5, daysLow: 7, minK: 25, midK: 50, highK: 75, maxK: 95, fromOvr: 50, midOvr: 70, highOvr: 80 },
  room: [[85, 0.25], [75, 0.55], [65, 0.8]],   // skill at or above → share of the gain left
  offerDays: 3,                                // a reply's offer stands this long (time to pick the day)
});

/**
 * r162 §122.34 the staff's roster suggestions (our club). A better bat on the
 * bench than the starter at a position (the hitting coach); a better arm on the
 * pitcher bench than one in the rotation or the pen (the pitching coach); a young
 * bench player who'd grow with regular playing time (Scouting/Dev). Each is a
 * decision: make the change, or "I have a plan" — quiet for that pairing until
 * something changes (the gap widens by `quietGrow`, someone involved is hurt or
 * moved, or `quietMs` passes). Unanswered (it expires after `expireMs`), the same
 * pairing may come back after `samePairMs`. One open at a time, `gapMs` apart,
 * never within half a day of a rest message.
 *   startIssues — a new club starts with this many to find (min, max).
 */
export const ROSTER_ADVICE = Object.freeze({
  hitterGap: 4, armGap: 4, prospectAge: 24, prospectGap: 6,
  gapMs: 2 * 86_400_000, samePairMs: 7 * 86_400_000, quietMs: 30 * 86_400_000, quietGrow: 4,
  expireMs: 2 * 86_400_000, startIssues: [2, 4],
  // r167 §122.35 the pitching coach on roles: stretch a reliever with a starter's stamina, at least as
  // good as the weakest starter; move a starter who can't go deep (ip per start) but has the stuff
  stretchStamina: 60, toPenStarts: 6, toPenIpPerStart: 5, toPenStuff: 65,
});

/**
 * r162 §122.34 playing time and a young player's winter (age 24 and under, the
 * growth window): a regular (share of the club's games — a hitter's games, a
 * starter's starts, a reliever's appearances) grows `regularBonus` more on each
 * rating; one who barely played grows `satPenalty` less.
 */
/**
 * r168 §122.35 phase 6 — the league's position changes: in season, a club somewhere moves a player
 * every `cpuGapDays` (a few a week); a free agent works out at a new spot every `faGapDays`. Lower-rated
 * players are a line in Recent; one rated `notableOvr`+, or who'd start for us there, is a Pro
 * Scouting message (at most one every `msgGapMs`; "start for us" = `fitGap`+ better than who'd sit).
 */
export const LEAGUE_POSITIONS = Object.freeze({
  cpuGapDays: [1.5, 3], faGapDays: [7, 14], hardShare: 0.25, pitcherShare: 0.25,
  notableOvr: 75, msgGapMs: 7 * 86_400_000, faFloorOvr: 50, fitGap: 4,
});

/**
 * r169 how the GM wants the club to play (engine/Strategy.js), set through Compose.
 *   run   the steal attempt rate ×; how much faster (+) / slower (−) than the usual speed threshold
 *         a runner must be to go; the success rate ± (picking the best counts, or running into bad ones)
 *   hook  the starter's innings wanted (±) and batters before tiring (±)
 */
export const STRATEGY = Object.freeze({
  // (r227 tagSend/tagOut: tag-ups on a caught fly — TAG_UP)
  run: Object.freeze({ less: { attempt: 0.45, speedShift: 8, success: 0.04, tagSend: -0.12, tagOut: 0.8 }, normal: { attempt: 1, speedShift: 0, success: 0, tagSend: 0, tagOut: 1 }, more: { attempt: 1.7, speedShift: -8, success: -0.07, tagSend: 0.10, tagOut: 1.3 } }),
  hook: Object.freeze({ quick: { innings: -1, bf: -3 }, normal: { innings: 0, bf: 0 }, long: { innings: 1, bf: 3 } }),
});

/**
 * r169 the Ticket Office's promotions for the next homestand (Compose → Ticket Office): the price
 * change (−0.2 = 20% off), the lift in seats filled, the home games it runs, its cost per game ($K),
 * and what it does for the ballpark's atmosphere.
 */
export const PROMOTIONS = Object.freeze({
  discount: { label: 'Discount Tickets', price: -0.2, fill: 0.12, games: 6, costPerGameK: 0, atmo: 1 },
  giveaway: { label: 'Giveaway Nights', price: 0, fill: 0.08, games: 4, costPerGameK: 12, atmo: 2 },
  family:   { label: 'Family Packs', price: -0.1, fill: 0.15, games: 3, costPerGameK: 4, atmo: 3 },
});

/**
 * r170 the field at our ballpark (GameWeather.fieldParams): what drainage and a game's prep change.
 *   drainage (levels 0–3, a ballpark upgrade): per level the field takes more steady rain before the
 *     tarp (soak minutes), more rain before first pitch before it's too wet to start on time (soggy)
 *     or washed out, the crew's work after a delay is shorter, and the infield softens less.
 *   prep (one home game, the groundskeeper's extra crew and full tarp setup): a wet field is ready
 *     sooner, the crew's work after a delay is shorter, the infield softens less. Costs by the forecast.
 *   The offer comes `leadH` before first pitch when the forecast shows `minChance`% or more (or the
 *   park already took `wetIn` of rain), and must be answered by `closeH` before (the plan is made at 4).
 */
/**
 * §122.51 (phase 2) A game's weather story (engine/GameWeatherStory.js): what the grounds crew knows,
 * moment by moment, and when it would tell anyone.
 *   outlookHour / outlookJitterMin — the morning look on game day (local), no later than outlookLeadMin
 *     before first pitch; then hourly until crewFromMin out, when the crew watches every crewEveryMin.
 *   watchBeforeMin / watchAfterMin — the window the morning look reads (rain at the tarp's bar, lightning).
 *   chanceStep — an hourly look reports a change of chance this big (or a change in what it means for the start).
 *   estLeadMin — the start's estimate is given from this long before first pitch; estStepMin — a revision is this
 *     big or more; delayedMin — a start this late counts as delayed.
 *   headsUpMin — under way, how far ahead the crew warns of rain that will stop play; lateWatchMin — near the
 *     end, how far past it the crew looks (extra innings, a long game).
 */
export const WEATHER_STORY = Object.freeze({
  outlookHour: 9, outlookJitterMin: 60, outlookLeadMin: 240,
  watchBeforeMin: 180, watchAfterMin: 240,
  crewFromMin: 120, crewEveryMin: 15,
  chanceStep: 25,
  estLeadMin: 90, estStepMin: 10, delayedMin: 5,
  headsUpMin: 20, lateWatchMin: 60,
  gapGainMin: 15,   // (phase 3) a held start: going ahead in light rain would start it this much sooner
});

export const FIELD_CARE = Object.freeze({
  drainage: Object.freeze({ soakPerLevel: 6, soggyPerLevel: 0.4, washoutPerLevel: 0.6, prepPerMmCut: 0.2, softPerLevel: 0.35, max: 3,
                            dryRatePerLevel: 0.5, dryMinPerLevel: 3,
                            costK: Object.freeze([150, 250, 400]), workDays: 6, winterWet: 6 }),
  prep: Object.freeze({ soggy: 0.3, soggyWork: 15, prepMin: 8, prepPerMm: 0.5, prepMax: 25, soft: 0.6, dryMinCut: 7,
                        costMinK: 8, costMaxK: 20, minChance: 40, wetIn: 0.75, leadH: 30, closeH: 5 }),
});

export const DEV_REPS = Object.freeze({
  regular: Object.freeze({ hitter: 0.5, SP: 0.15, RP: 0.3 }),
  sat:     Object.freeze({ hitter: 0.15, SP: 0.05, RP: 0.1 }),
  regularBonus: 0.75, satPenalty: 0.5,
});

/**
 * r164 §122.35 phase 2 — positions earned in games.
 *   gainStarts — regular-season starts at a position to become eligible there.
 *   keepStarts / keepShare / keepMin — at the season turn a position is kept with
 *     keepStarts starts there, or keepShare of the player's starts (at least keepMin).
 *   Familiarity (a share of the extra error risk out of position taken away, phase 3):
 *     each spring, postseason or out-of-position regular-season start (and, phase 4,
 *     a day of teaching) adds famStep; it never passes famCap. Moving down the
 *     defensive spectrum (and to 1B) is 'easy', up it 'hard', behind the plate 'C'.
 *   famCarry — what's left at the season turn of familiarity built that season (else 0).
 *   notes — the Bench Coach's two late-season notes, by our regular-season games left.
 */
export const POSITION_RULES = Object.freeze({
  gainStarts: 10, keepStarts: 20, keepShare: 0.25, keepMin: 5,
  spectrum: Object.freeze({ SS: 5, '2B': 4, '3B': 3, C: 3, OF: 2, '1B': 1, DH: 0 }),
  famCap: Object.freeze({ easy: 0.75, hard: 0.5, C: 0.35 }),
  famStep: Object.freeze({ easy: 0.15, hard: 0.08, C: 0.06 }),
  famCarry: 0.5,
  notes: Object.freeze({ first: Object.freeze({ min: 20, base: 25, max: 30 }), second: Object.freeze({ min: 8, base: 10, max: 12 }) }),
  // r165 phase 3 — the cost of a fielder out of position, scaled by what familiarity hasn't taken away
  // (1 − familiarity): each one adds `errorPer` to the ground-ball error chance; a non-catcher behind
  // the plate draws `sbAttempt` more steal attempts, `sbSuccess` more successful ones, and allows a
  // passed ball on `passedBall` of the moments with a runner on.
  oop: Object.freeze({ errorPer: 0.5, sbAttempt: 0.6, sbSuccess: 0.08, passedBall: 0.015 }),
  // r166 phase 4 — the Bench Coach teaching a position (free, in practice already on the schedule, one
  // player at a time): `days` of extra reps by difficulty; each day takes (adds one famStep) with
  // `odds`, better with a good coach (quality − 60) / 200, a young player +0.05, one 32+ −0.1.
  teach: Object.freeze({ days: Object.freeze({ easy: 4, hard: 7, C: 9 }), odds: Object.freeze({ easy: 0.85, hard: 0.6, C: 0.45 }) }),
  // r167 phase 5 — pitchers' designations. RP: `gainRelief` regular-season relief outings (kept with
  // `keepRelief` last season); SP: `gainStarts` regular-season starts (kept with `keepStarts`).
  // A starter in relief without RP: his next start waits `pushNoRP` days after it (`pushRP` with
  // RP), and the outing's workload is ×`extraLoad`. The short-stint boost by age [upTo, stuff,
  // control]. Stretched out 0–3: a start, a long outing (`longBF`+ batters), a spring outing or a sim
  // game each add one; a starter's length at 3. Losing SP: a natural starter keeps `keepHead`.
  pitch: Object.freeze({
    gainRelief: 5, keepRelief: 8, gainStarts: 3, keepStarts: 5,
    pushNoRP: 2, pushRP: 1, extraLoad: 1.5, longBF: 12, keepHead: 2,
    boost: Object.freeze([[25, 4, -3], [30, 3, -2], [34, 2, -1], [Infinity, 1, 0]]),
    simEveryDays: 3, simBF: 15,
  }),
});
