/**
 * engine/NarrativeEngine.js
 * Organizational memory — reads narrativeFlags, derives GM profile,
 * and selects card body variants for delivery.
 *
 * This engine is the enrichment layer on the card system (Section 34).
 * It does NOT create new card types, new inbox tabs, or new interaction
 * patterns. It only changes which version of a card's body text the GM sees,
 * based on what they've done before.
 *
 * Rules:
 *   - Pure functions. No StateManager import. Receives state as a parameter.
 *   - setFlag() returns a new flags array — caller applies via StateManager.mutate().
 *   - selectCardVariant() is the ONLY place card body variants are selected.
 *     CardEngine calls this at delivery time, before token resolution.
 *   - Variant body text never references the flag system directly.
 *     Characters speak in their own voice — the world remembers, the system does not.
 *
 * Section references: Section 34 (Narrative Engine — LOCKED)
 */

// ─────────────────────────────────────────────────────────────
// FLAG QUERIES
// ─────────────────────────────────────────────────────────────

/**
 * getFlags(state, filter?)
 * Returns matching narrative flag entries from the append-only log,
 * sorted by gameIdx descending (most recent first).
 *
 * filter fields (all optional — omit to return all flags):
 *   key:         String   — exact match on flag key
 *   subject:     String   — exact match on subject (playerId, staffId, or null)
 *   season:      Number   — exact match on season number
 *   minGameIdx:  Number   — only flags at or after this game index
 *   maxGameIdx:  Number   — only flags at or before this game index
 *   choice:      String   — 'yes'|'no'|'auto'|null
 *
 * @param {Object}  state
 * @param {Object}  [filter]
 * @returns {Object[]} matching flag entries, most recent first
 */
export function getFlags(state, filter = {}) {
  const flags = state.narrativeFlags || [];
  if (flags.length === 0) return [];

  const {
    key,
    subject,
    season,
    minGameIdx,
    maxGameIdx,
    choice,
  } = filter;

  return flags
    .filter(f => {
      if (key        !== undefined && f.key        !== key)        return false;
      if (subject    !== undefined && f.subject    !== subject)    return false;
      if (season     !== undefined && f.season     !== season)     return false;
      if (choice     !== undefined && f.choice     !== choice)     return false;
      if (minGameIdx !== undefined && f.gameIdx     < minGameIdx)  return false;
      if (maxGameIdx !== undefined && f.gameIdx     > maxGameIdx)  return false;
      return true;
    })
    .sort((a, b) => b.gameIdx - a.gameIdx);
}

/**
 * setFlag(state, flagEntry)
 * Returns a new narrativeFlags array with the entry appended.
 * Pure — does not mutate state. Caller applies via StateManager.mutate().
 *
 * flagEntry shape:
 * {
 *   key:     String,          // e.g. 'extension_declined'
 *   subject: String|null,     // playerId, staffId, or null
 *   gameIdx: Number,          // state.currentGameIndex at time of flag
 *   season:  Number,          // state.seasonNum at time of flag
 *   choice:  String|null,     // 'yes'|'no'|'auto'|null
 *   context: Object|null,     // optional { amount, role, reason }
 * }
 *
 * @param {Object} state
 * @param {Object} flagEntry
 * @returns {Object[]} new narrativeFlags array
 */
export function setFlag(state, flagEntry) {
  const existing = state.narrativeFlags || [];
  return [
    ...existing,
    {
      key:     flagEntry.key     || '',
      subject: flagEntry.subject || null,
      gameIdx: flagEntry.gameIdx ?? (state.currentGameIndex || 0),
      season:  flagEntry.season  ?? (state.seasonNum        || 1),
      choice:  flagEntry.choice  || null,
      context: flagEntry.context || null,
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// GM PROFILE
// ─────────────────────────────────────────────────────────────

/**
 * getGMProfile(state)
 * Derives the GM's behavioral profile from their flag history.
 * Returns a dimension object — never stored directly in state.
 *
 * Each dimension is a value from -1.0 (fully one end) to +1.0 (fully other end).
 * Values near 0.0 mean insufficient signal or balanced behavior.
 *
 * Dimensions (Section 34.4 — LOCKED):
 *   spender:          -1.0 = conservationist  → +1.0 = spender
 *   loyal:            -1.0 = transactional    → +1.0 = loyal
 *   aggressive:       -1.0 = cautious         → +1.0 = aggressive
 *   communityFocused: -1.0 = business-focused → +1.0 = community-oriented
 *   handsOn:          -1.0 = delegating       → +1.0 = hands-on
 *   processDriven:    -1.0 = results-driven   → +1.0 = process-driven
 *
 * @param {Object} state
 * @returns {Object} GM profile dimensions
 */
export function getGMProfile(state) {
  const flags   = state.narrativeFlags || [];
  const seasons = state.seasonNum      || 1;

  return {
    spender:          _deriveSpender(flags, state),
    loyal:            _deriveLoyalty(flags),
    aggressive:       _deriveAggression(flags),
    communityFocused: _deriveCommunity(flags),
    handsOn:          _deriveHandsOn(flags),
    processDriven:    _deriveProcess(flags, state),
    // Metadata — used by selectCardVariant condition checks
    _seasons:         seasons,
    _totalFlags:      flags.length,
  };
}

// ─────────────────────────────────────────────────────────────
// CARD VARIANT SELECTION — single source of truth (Section 34)
// ─────────────────────────────────────────────────────────────

/**
 * selectCardVariant(card, state)
 * Returns the body string to use for this card delivery.
 *
 * Called by CardEngine at delivery time, BEFORE token resolution.
 * This is the only place card body variants are selected.
 *
 * If the card has no variants array, or no variant condition matches,
 * returns card.body (the default). This means all existing cards
 * continue to work unchanged — variants are purely additive.
 *
 * Variant condition shape (from cards-pool.js):
 * {
 *   condition: {
 *     flags?:     [{ key, subject? }],  // all listed flags must be present
 *     gmProfile?: { dimension: Boolean|Number, season?: { min?, max? } },
 *   },
 *   body: String,
 * }
 *
 * @param {Object} card   — card definition (from cards-pool.js)
 * @param {Object} state  — full game state
 * @returns {String} body text to use
 */
export function selectCardVariant(card, state) {
  if (!card.variants || card.variants.length === 0) return card.body || '';

  const profile = getGMProfile(state);
  const seasons = state.seasonNum || 1;

  for (const variant of card.variants) {
    if (_conditionMatches(variant.condition, state, profile, seasons)) {
      return variant.body || card.body || '';
    }
  }

  // No variant matched — use default body
  return card.body || '';
}

/**
 * getRelevantFlags(state, card)
 * Returns the flags most contextually relevant to this specific card.
 * Used by CardEngine to provide flag context for token resolution.
 *
 * Looks at: the card's flagKey, its _targetPlayerId, and any
 * subject references in its variants array.
 *
 * @param {Object} state
 * @param {Object} card   — card definition
 * @returns {Object[]} relevant flag entries, most recent first
 */
export function getRelevantFlags(state, card) {
  if (!state.narrativeFlags || state.narrativeFlags.length === 0) return [];

  const relevantKeys = new Set();
  const relevantSubjects = new Set();

  // The card's own flagKey (what it will set on resolution)
  if (card.flagKey)    relevantKeys.add(card.flagKey);
  if (card.flagKeyYes) relevantKeys.add(card.flagKeyYes);

  // Any flag keys referenced in variant conditions
  if (card.variants) {
    for (const v of card.variants) {
      if (v.condition?.flags) {
        for (const f of v.condition.flags) {
          if (f.key) relevantKeys.add(f.key);
        }
      }
    }
  }

  // The card's target player (for player-specific flag history)
  if (card._targetPlayerId) relevantSubjects.add(card._targetPlayerId);

  if (relevantKeys.size === 0 && relevantSubjects.size === 0) return [];

  return getFlags(state, {}).filter(f =>
    relevantKeys.has(f.key) ||
    (f.subject && relevantSubjects.has(f.subject))
  );
}

// ─────────────────────────────────────────────────────────────
// GM PROFILE DIMENSION DERIVATIONS (internal)
// ─────────────────────────────────────────────────────────────

/**
 * _deriveSpender(flags, state)
 * Positive = spender. Negative = conservationist.
 * Driven by: budget_aggressive vs budget_conservative flags,
 * and payroll vs cap ratio.
 */
function _deriveSpender(flags, state) {
  const aggressive    = _countKey(flags, 'budget_aggressive');
  const conservative  = _countKey(flags, 'budget_conservative');
  const facilityYes   = _countKey(flags, 'facility_upgrade_approved');
  const facilityNo    = _countKey(flags, 'facility_upgrade_deferred');

  const spendScore    = (aggressive + facilityYes) - (conservative + facilityNo);
  return _normalize(spendScore, 6);
}

/**
 * _deriveLoyalty(flags)
 * Positive = loyal. Negative = transactional.
 * Driven by: extension history, veteran releases, trade frequency.
 */
function _deriveLoyalty(flags) {
  const extended    = _countKey(flags, 'extension_accepted');
  const declined    = _countKey(flags, 'extension_declined');
  const vetReleased = _countKey(flags, 'veteran_released');
  const traded      = _countKey(flags, 'trade_accepted');

  const loyalScore  = extended - declined - vetReleased - (traded * 0.5);
  return _normalize(loyalScore, 8);
}

/**
 * _deriveAggression(flags)
 * Positive = aggressive. Negative = cautious.
 * Driven by: rushed IL returns, early call-ups, deadline trades.
 */
function _deriveAggression(flags) {
  const rushed    = _countKey(flags, 'player_rushed_back');
  const callups   = _countKey(flags, 'prospect_called_up');
  const heldBack  = _countKey(flags, 'player_held_back');
  const waivers   = _countKey(flags, 'waiver_claimed');

  const aggScore  = (rushed + callups + waivers) - (heldBack * 1.5);
  return _normalize(aggScore, 8);
}

/**
 * _deriveCommunity(flags)
 * Positive = community-oriented. Negative = business-focused.
 */
function _deriveCommunity(flags) {
  const approved  = _countKey(flags, 'community_event_approved')
                  + _countKey(flags, 'promotional_night_approved')
                  + _countKey(flags, 'fan_experience_invested');
  const declined  = _countKey(flags, 'community_event_declined')
                  + _countKey(flags, 'promotional_night_declined')
                  + _countKey(flags, 'fan_experience_deferred');

  return _normalize(approved - declined, 6);
}

/**
 * _deriveHandsOn(flags)
 * Positive = hands-on. Negative = delegating.
 * Driven by compose usage frequency relative to game count.
 */
function _deriveHandsOn(flags) {
  const composeUses = _countKey(flags, 'compose_used');
  // More than 1 compose use per 5 games = hands-on
  // Fewer than 1 per 15 games = delegating
  // Scale around a neutral midpoint of ~1 use per 10 games
  return _normalize(composeUses / 10 - 1, 3);
}

/**
 * _deriveProcess(flags, state)
 * Positive = process-driven. Negative = results-driven.
 * Correlates with archetype but diverges based on actual decisions.
 */
function _deriveProcess(flags, state) {
  const archetype = state.archetype || '';

  // Base signal from archetype
  const archetypeBase = {
    lab:         0.6,
    ember:       0.3,
    institution: 0.2,
    contender:   0.0,
    gambler:    -0.3,
    empire:     -0.5,
  }[archetype] ?? 0;

  // Divergence: facility upgrades and staff investments = process-driven
  const processActs  = _countKey(flags, 'maintenance_approved')
                     + _countKey(flags, 'staff_request_approved');
  const resultsActs  = _countKey(flags, 'ownership_trust_gained');

  const divergence   = _normalize(processActs - resultsActs, 4);

  // Blend archetype base with behavioral divergence (divergence weighted 40%)
  return _clamp(archetypeBase * 0.6 + divergence * 0.4, -1, 1);
}

// ─────────────────────────────────────────────────────────────
// VARIANT CONDITION MATCHING (internal)
// ─────────────────────────────────────────────────────────────

/**
 * _conditionMatches(condition, state, profile, seasons)
 * Returns true if all conditions in the condition object are satisfied.
 *
 * @param {Object} condition
 * @param {Object} state
 * @param {Object} profile    — from getGMProfile()
 * @param {Number} seasons
 * @returns {Boolean}
 */
function _conditionMatches(condition, state, profile, seasons) {
  if (!condition) return false;

  // ── Flag conditions ──
  // All listed flags must be present in the log
  if (condition.flags) {
    for (const requirement of condition.flags) {
      const matches = getFlags(state, {
        key:     requirement.key,
        subject: requirement.subject ?? undefined,
      });
      if (matches.length === 0) return false;
    }
  }

  // ── GM profile conditions ──
  if (condition.gmProfile) {
    for (const [dimension, required] of Object.entries(condition.gmProfile)) {
      if (dimension === 'season') continue; // handled below

      const value = profile[dimension];
      if (value === undefined) return false;

      if (typeof required === 'boolean') {
        // true = positive dimension, false = negative dimension
        if (required && value <= 0)  return false;
        if (!required && value >= 0) return false;
      } else if (typeof required === 'number') {
        // Number = minimum absolute value in that direction
        // Positive number = must be at least that positive
        // Negative number = must be at least that negative
        if (required > 0 && value < required)  return false;
        if (required < 0 && value > required)  return false;
      }
    }
  }

  // ── Season conditions ──
  if (condition.season) {
    if (condition.season.min !== undefined && seasons < condition.season.min) return false;
    if (condition.season.max !== undefined && seasons > condition.season.max) return false;
  }

  // ── gmProfile.season shorthand ──
  if (condition.gmProfile?.season) {
    const s = condition.gmProfile.season;
    if (s.min !== undefined && seasons < s.min) return false;
    if (s.max !== undefined && seasons > s.max) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES (internal)
// ─────────────────────────────────────────────────────────────

/** Count flags matching a specific key */
function _countKey(flags, key) {
  return flags.filter(f => f.key === key).length;
}

/**
 * _normalize(rawScore, scale)
 * Maps a raw integer score to a -1.0 → +1.0 range.
 * scale = the raw score value that maps to ±1.0 (anything beyond is clamped).
 */
function _normalize(rawScore, scale) {
  if (scale <= 0) return 0;
  return _clamp(rawScore / scale, -1, 1);
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
