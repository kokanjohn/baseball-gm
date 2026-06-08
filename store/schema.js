/**
 * store/schema.js
 * Canonical state shape definition and migration versioning.
 *
 * Two exports:
 *   createGameState(config)  — returns a fresh, valid game state object
 *   migrate(state)           — upgrades a loaded state to current schema version
 *
 * Rules:
 *   - No logic beyond default values and migration transforms.
 *   - No imports from engines or UI modules.
 *   - Every field the rest of the codebase reads must be present here with a
 *     sensible default so nothing needs to guard against undefined.
 */

import {
  SCHEMA_VERSION,
  PHASE,
  NOTIFICATION_QUIET_START_DEFAULT,
  NOTIFICATION_QUIET_END_DEFAULT,
  GM_RELATIONSHIP_DEFAULT,
  SOFT_METRIC_MIN,
  SOFT_METRIC_MAX,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// FRESH STATE FACTORY
// ─────────────────────────────────────────────────────────────

/**
 * createGameState(config)
 *
 * Returns a complete, valid game state object for a new save slot.
 * config shape:
 *   {
 *     archetype:  String,   // required — archetype id
 *     gmName:     String,   // required — GM display name
 *     city:       String,   // required — team city
 *     nickname:   String,   // required — team nickname
 *     abbr:       String,   // required — 2–3 letter abbreviation
 *     icon:       String,   // required — emoji
 *     bannerColor:String,   // required — hex color
 *   }
 *
 * Engines (Phase 2+) will populate players, schedule, leagueTeams, etc.
 * after calling createGameState. This factory only guarantees structural
 * validity — every key exists with the right type.
 */
export function createGameState(config = {}) {
  const now = Date.now();

  return {
    // ── Schema versioning ──────────────────────────────────
    _version: SCHEMA_VERSION,
    _savedAt:  now,

    // ── Season ────────────────────────────────────────────
    seasonNum: 1,
    phase:     PHASE.SETUP,

    // ── Archetype (immutable after creation) ──────────────
    archetype: config.archetype || '',

    // ── Prestige & franchise history ──────────────────────
    prestigeScore:          0,
    prestigeTier:           1,
    prestigeHistory:        [],   // [{ seasonNum, tier, score }]
    turningPointFired:      false,
    franchiseLegendFired:   false,
    allStarHostingScore:    0,
    allStarHostedCount:     0,
    allStarLastHostedSeason: null,
    seenMilestones:         [],   // milestone IDs — serialized as Array (not Set)
    seasonHistory:          [],   // season summary objects added each offseason
    metricHistory:          [],   // { gameIndex, ovr, wins, losses } per game

    // ── Impact Rating (IMP) scores — cached per player ────
    // { [playerId]: { imp7, imp15, imp30, impS, updatedAtGame } }
    // Null = insufficient sample. Recomputed by IMPEngine each game.
    impScores:              {},

    // ── Win target tracking ────────────────────────────────
    ownerWinTarget:         68,   // set properly by archetype at game creation

    // ── Player registry ────────────────────────────────────
    // { [playerId: String]: PlayerObject }
    // Single source of truth for every player in this slot.
    // Full shape defined in engine/PlayerFactory.js createPlayer().
    // Key fields for cross-engine reference:
    //   id: String, name: String, pos: String, nativePos: String,
    //   group: PLAYER_GROUP value, hand: 'R'|'L',
    //   dob: String (YYYY-MM-DD), ovr: Number,
    //   tier: 'active'|'waivers'|'farm'|'retired',
    //   subRatings: { contact, power, speed, stuff, control, stamina },
    //   injuryPenalty: { subRating: String, amount: Number } | null,
    //   gmRelationship: Number (0-100),
    //   contractSalary: Number ($K), contractYears: Number, contractExpiry: Number,
    //   isInjured: Boolean, isSuspended: Boolean, onWaivers: Boolean,
    //   waiverStartTime: Number|null, _farmArc: String|null,
    //   _isSpringInvitee: Boolean,  // true while on spring roster; cleared after Opening Day
    //   _isKeeper: Boolean,         // GM-tagged during spring; determines Opening Day roster
    //   _pendingILReturn: Boolean, ilReturnGame: Number|null,
    //   trait: String, _act2Variance: String|null,
    //   stats: Object, springStats: Object, careerStats: Object,
    //   injuryReport: Object|null, teamId: String|null
    players: {},

    // ── Waiver pool (data model present from Phase 1) ──────
    waiverPool: [],      // array of playerIds currently on waivers
    ilReturnQueue: [],   // playerIds flagged _pendingILReturn — awaiting GM decision card (Phase 9)

    // ── Free agent pool ────────────────────────────────────
    freeAgentPool: [], // array of playerIds

    // ── User team ──────────────────────────────────────────
    userTeam: createUserTeamObject(config),

    // ── League teams ───────────────────────────────────────
    // LeagueTeamObject[] — populated by LeagueEngine in Phase 4
    leagueTeams: [],

    // ── Schedule ───────────────────────────────────────────
    // GameObject[] — user team's full season schedule.
    // The game object IS the live game state — no separate state.liveGame (Section 8.7).
    //
    // Live tracking fields on each game object (updated as game progresses):
    //   livePlayIndex: Number   — index of next play to reveal (0 = nothing shown)
    //   ourScore:      Number   — current user team score
    //   theirScore:    Number   — current opponent score
    //   currentInning: Number   — 1-based
    //   currentHalf:   'TOP'|'BOT'
    //   outs:          Number   — 0, 1, or 2
    //   bases:         { first, second, third } — playerId or null
    //   status:        GAME_STATUS — single source of truth for all systems
    //   _tickOffset:   Number   — ms offset for delay handling
    //   _committed:    Boolean  — true after GameEngine.commitGame()
    schedule:       [],   // GameObject[] — user team's games
    leagueSchedule: {     // CPU game results keyed by date string
      dayMap: {},         // { [dateStr: 'YYYY-MM-DD']: GameResult[] }
    },
    currentGameIndex: 0,  // index into schedule[]

    // ── Weather buffer ─────────────────────────────────────
    weatherBuffer: {
      generatedAt:  0,
      hourlyFrames: [],
    },

    // ── Inbox ──────────────────────────────────────────────
    // CardInstance shape (Section 10 — LOCKED):
    // {
    //   instanceId:   String,       // UUID — unique per delivery
    //   cardId:       String,       // matches card definition id (e.g. 'sp1', 'i1')
    //   deliveredAt:  Number,       // gameIndex when delivered
    //   expiresAt:    Number|null,  // gameIndex when it expires (null = no expiry)
    //   expiresAtMs:  Number|null,  // real-world Unix ms expiry (weather cards only)
    //   resolved:     Boolean,      // true once GM has responded
    //   resolvedAt:   Number|null,  // gameIndex when resolved
    //   choice:       String|null,  // 'yes'|'no'|'auto'
    //   type:         String,       // 'urgent'|'normal'|'good'
    //   tag:          String,       // 'INJURY'|'ROSTER'|'TRADE'|etc.
    //   sender:       String,       // resolved sender name
    //   subject:      String,       // resolved subject text
    //   preview:      String,       // resolved preview text
    //   body:         String,       // resolved body text
    //   yesLabel:     String,
    //   noLabel:      String,
    //   yesEffect:    Object,       // { morale, atmo, ovr, ... }
    //   noEffect:     Object,
    //   autoResolve:  String|null,  // 'yes'|'no'|'skip'
    //   autoResolveTax: Object|null,
    //   _playerRelationshipEffect: Object|null, // { playerId, amount }
    //   _budgetCost:  Number|null,  // $K deducted on yes
    //   _raw:         Object,       // original card definition (for followup chaining)
    // }
    inbox: [],   // CardInstance[]

    // ── Follow-up queue ────────────────────────────────────
    // Cards scheduled to fire at a future game index
    followupQueue: [],   // [{ type, atGame, payload }]

    // ── Narrative flags (Phase 13.6 — Section 34 — LOCKED) ────────────────
    // Append-only log of significant GM decisions and outcomes.
    // Never modified after appending — only new entries are added.
    // Read by NarrativeEngine to derive GM profile and select card variants.
    //
    // Each entry shape:
    // {
    //   key:     String,   // e.g. 'extension_declined', 'player_rushed_back'
    //   subject: String,   // playerId, staffId, or null for org-level flags
    //   gameIdx: Number,   // schedule index when it happened
    //   season:  Number,   // which season
    //   choice:  String,   // 'yes'|'no'|'auto'|null
    //   context: Object,   // optional flag-specific metadata { amount, role, reason }
    // }
    narrativeFlags: [],

    // ── Franchise history (Phase 13.8 — Section 35 — LOCKED) ──────────────
    // Append-only log of significant franchise events, organized by season.
    // Never modified after appending — only new entries are added.
    // Read by HistoryScreen to render the franchise story.
    //
    // Each entry shape:
    // {
    //   id:       String,   // UUID — unique per entry
    //   type:     String,   // 'trade'|'injury'|'retirement'|'coaching'|'playoff'|
    //                       //  'milestone'|'prestige'|'record'|'championship'
    //   season:   Number,   // seasonNum when it happened
    //   gameIdx:  Number,   // schedule index when it happened
    //   headline: String,   // short display label e.g. "Rodriguez traded to Boston"
    //   detail:   String,   // fuller description shown on expand
    //   playerId: String|null, // optional — links to player data
    //   icon:     String,   // emoji for entry type
    //   userNote: String,   // optional user-added note (saved on edit)
    // }
    history: [],

    // ── Activity feed ──────────────────────────────────────
    activityFeed: [],   // [{ type, text, timestamp, teamAbbr }]

    // ── Standings (recomputed after each game, cached in state) ───
    standings: null,    // { divA, divB, wildcard, all } — null until first game commits

    // ── Playoff bracket ────────────────────────────────────────────
    playoffBracket: null,  // built at PLAYOFF_BRACKET_BUILD phase

    // ── Offseason flow ──────────────────────────────────────────────
    // _offseasonGate: null | 'AWAITING_RESIGN_DECISIONS' | 'AWAITING_OWNERSHIP_CARD'
    // offseasonDay: 0 (not in offseason) | 1-6 (active offseason day)
    // offseasonStartedAt: Unix ms timestamp when OFFSEASON phase began
    // offseasonHardGatesCleared: true when all hard gates resolved (spring can begin)
    _offseasonGate: null,
    offseasonDay: 0,
    offseasonStartedAt: null,
    offseasonHardGatesCleared: false,

    // ── Waiver priority (Section 20.2) ─────────────────────────────
    // Array of teamIds in priority order (index 0 = highest priority)
    // Reset at season start by inverse standings; cycles on each claim
    waiverPriority: [],

    // ── Compose cooldowns ────────────────────────────────
    // { [composeTopicId]: gameIndex } — prevents repeated compose use
    composeCooldowns: {},

    // ── Pending transactions ───────────────────────────────
    _pendingAcquisitions: [],   // incoming players held until game commit

    // ── Trade cooldowns ────────────────────────────────────
    // { [teamId]: gameIndex } — 15-game cooldown after declined offer
    _tradeDeclinedAt: {},

    // ── Notifications (per-slot) ───────────────────────────
    push: {
      enabled:    false,
      quietStart: NOTIFICATION_QUIET_START_DEFAULT,
      quietEnd:   NOTIFICATION_QUIET_END_DEFAULT,
    },

    // ── Settings (per-slot) ────────────────────────────────
    settings: {
      theme:           'dark',    // 'dark'|'light'|'auto'
      // Team colors — COLOR_PALETTE id strings (e.g. 'gold', 'blue')
      // Both independent — any combination allowed including matching
      primaryColor:    'gold',    // → --accent, --accent-bar, --chip-accent-bg, --accent-txt
      secondaryColor:  'green',   // → --accent2, --accent2-txt
      // Geographic region — set during Setup Step 2 (Phase 13.5)
      // Affects weather behavior, travel fatigue, facilities cards, groundskeeper cards.
      // 'north'|'south'|'east'|'west' — matches REGIONS keys in constants.js
      region:          'north',
      soundEnabled:    true,
      soundVolume:     0.7,
      hapticEnabled:   true,
      hapticIntensity: 'medium',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// USER TEAM FACTORY
// ─────────────────────────────────────────────────────────────

/**
 * createUserTeamObject(config)
 * Returns the userTeam sub-object with all fields initialized to safe defaults.
 * Archetype-specific values (payrollCap, morale, etc.) are applied
 * by GameEngine during game creation — not here.
 */
export function createUserTeamObject(config = {}) {
  return {
    id: 'user',

    // Identity
    city:        config.city        || '',
    nickname:    config.nickname    || '',
    abbr:        config.abbr        || '',
    icon:        config.icon        || '⚾',
    bannerColor: config.bannerColor || '#1a3a5c',
    gmName:      config.gmName      || '',

    // Roster — player IDs only; looked up in state.players
    rosterIds: [],
    farmIds:   [],   // farm system player IDs

    // Division (always 'A' for user team — stored explicitly to avoid hardcoding in standings logic)
    divisionId: 'A',

    // Record
    wins:   0,
    losses: 0,
    streak: 0,   // positive = win streak, negative = loss streak

    // Spring training record (separate from regular season)
    springWins:   0,
    springLosses: 0,

    // Soft metrics (0–100)
    morale:           50,
    atmosphere:       50,
    ownerTrust:       60,
    managerConfidence:60,

    // Department relationships (0–100)
    groundskeeperRelationship:  50,
    facilitiesRelationship:     50,
    ticketOfficeRelationship:   50,

    // GM relationships with other teams — { [teamId]: Number (0–100) }
    gmRelationships: {},

    // Finances
    finances: {
      // All financial values in $K — set by archetype at game creation
      payroll:           0,
      payrollCap:        8000,    // $8K default (Ember floor) — overwritten by archetype
      payrollCapHistory: [],
      operatingBudget:    500,    // $500K default (Ember floor) — overwritten by archetype
      operatingSpent:    0,
      revenue:           0,
      revenueHistory:    [],
    },

    // Hosting score (feeds All-Star bid)
    hostingScore: 0,

    // Coaching staff
    coachingStaff: {
      // Coaching staff salaries in $K
      manager: {
        name:            '',
        salary:          225,   // $225K
        contractExpiry:  2,
        relationship:    50,
        background:      '',
        managerConfidence: 60,
      },
      pitchingCoach: {
        name:           '',
        salary:         125,   // $125K
        contractExpiry: 2,
        relationship:   50,
      },
      hittingCoach: {
        name:           '',
        salary:         125,   // $125K
        contractExpiry: 2,
        relationship:   50,
      },
      bullpenCoach: {
        name:           '',
        salary:         75,    // $75K
        contractExpiry: 2,
        relationship:   50,
      },
      benchCoach: {
        name:           '',
        salary:         75,    // $75K
        contractExpiry: 2,
        relationship:   50,
      },
    },

    // Pending transactions
    _pendingAcquisitions: [],

    // Watchlist — playerIds the user is watching
    watchlist: [],

    // SP rotation (Section 7.3 — manager-owned, not a GM decision)
    // order: SP playerIds in rotation order (manager sets, events mutate)
    // currentIndex: which slot starts the next game (0-based, wraps at order.length)
    rotation: {
      order:        [],   // populated by GameEngine at season/roster setup
      currentIndex: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// SAVE SLOT ENVELOPE
// ─────────────────────────────────────────────────────────────

/**
 * createSlotEnvelope(slotId, state)
 * Wraps a game state in the save slot envelope that IndexedDB stores.
 */
export function createSlotEnvelope(slotId, state) {
  return {
    slotId,
    teamName:   `${state.userTeam.city} ${state.userTeam.nickname}`.trim(),
    archetype:  state.archetype,
    seasonNum:  state.seasonNum,
    lastPlayed: Date.now(),
    state,
  };
}

// ─────────────────────────────────────────────────────────────
// MIGRATION
// ─────────────────────────────────────────────────────────────

/**
 * migrate(state)
 *
 * Accepts a loaded state object (any version) and returns a state
 * object that matches the current schema. Runs transforms in order.
 *
 * Rules:
 *   - Every migration step is additive or transformative — never destructive.
 *   - Missing fields are filled with safe defaults.
 *   - After migration, state._version === SCHEMA_VERSION.
 *
 * To add a migration: append a new entry to MIGRATIONS.
 */
export function migrate(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('migrate: received non-object state');
  }

  for (const { from, to, transform } of MIGRATIONS) {
    if (state._version === from) {
      state = transform(state);
      state._version = to;
    }
  }

  // Final pass: fill any fields missing from the current schema
  // (handles saves created before a new field was added without a migration)
  state = _fillDefaults(state);

  return state;
}

/**
 * needsMigration(state)
 * Returns true if the state is not at the current schema version.
 */
export function needsMigration(state) {
  return !state || state._version !== SCHEMA_VERSION;
}

// ── Migration table ────────────────────────────────────────────
// Each entry: { from: String, to: String, transform: Function }
// transform receives a state object and returns the updated object.

const MIGRATIONS = [
  // Example — uncomment and fill when the first schema change is made:
  // {
  //   from: '1.0.0',
  //   to:   '1.1.0',
  //   transform(state) {
  //     // e.g. add a new field that didn't exist in 1.0.0
  //     if (state.userTeam && state.userTeam.hostingScore === undefined) {
  //       state.userTeam.hostingScore = 0;
  //     }
  //     return state;
  //   },
  // },
];

// ── Default-fill pass ──────────────────────────────────────────
// Ensures every top-level key exists after migration.
// Does NOT overwrite existing values.
function _fillDefaults(state) {
  const defaults = createGameState();

  for (const key of Object.keys(defaults)) {
    if (state[key] === undefined) {
      state[key] = defaults[key];
    }
  }

  // Deep fill nested objects that must always be complete
  if (state.userTeam) {
    const teamDefaults = createUserTeamObject();
    for (const key of Object.keys(teamDefaults)) {
      if (state.userTeam[key] === undefined) {
        state.userTeam[key] = teamDefaults[key];
      }
    }
    if (state.userTeam.rotation === undefined) {
      state.userTeam.rotation = { order: [], currentIndex: 0 };
    }
    if (state.userTeam.finances) {
      const finDefaults = createUserTeamObject().finances;
      for (const key of Object.keys(finDefaults)) {
        if (state.userTeam.finances[key] === undefined) {
          state.userTeam.finances[key] = finDefaults[key];
        }
      }
    }
  }

  // Fill new top-level fields
  const newTopLevel = {
    standings: null, playoffBracket: null, _offseasonGate: null, waiverPriority: [],
  };
  for (const key of Object.keys(newTopLevel)) {
    if (state[key] === undefined) state[key] = newTopLevel[key];
  }

  if (state.push) {
    if (state.push.quietStart === undefined) state.push.quietStart = NOTIFICATION_QUIET_START_DEFAULT;
    if (state.push.quietEnd   === undefined) state.push.quietEnd   = NOTIFICATION_QUIET_END_DEFAULT;
    if (state.push.enabled    === undefined) state.push.enabled    = false;
  }

  if (state.settings) {
    const sDefaults = createGameState().settings;
    for (const key of Object.keys(sDefaults)) {
      if (state.settings[key] === undefined) state.settings[key] = sDefaults[key];
    }
  }

  return state;
}
