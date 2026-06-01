/**
 * engine/CardEngine.js
 * Card selection, token resolution, delivery, expiry, and effect application.
 *
 * Rules:
 *   - This module imports StateManager — it is the second module (after GameEngine)
 *     that writes to state. All other engines are pure functions.
 *   - checkAndDeliver() is called by GameEngine after every game commit.
 *   - resolve() applies card effects and queues follow-ups.
 *   - Token resolver enforces pitcher handedness: all pitcher name tokens
 *     automatically append "(R)" or "(L)". Card authors never include it manually.
 *   - No card computes its own situation — context is always passed from GameEngine.
 *
 * Section references: Section 10 (card system), Section 11 (injury two-act),
 *   Section 9.6 (counter-offer), Section 22.5 (gmRelationship effects)
 */

import * as StateManager from '../store/StateManager.js';

import {
  PERSONAL_LEAVE_POOL,
  MANAGER_CONTRACT_POOL,
  COACHING_CONTRACT_POOL,
  DECISIONS_POOL,
  FOLLOWUP_POOL,
  PREGAME_POOL,
  INGAME_POOL,
  BETWEEN_GAMES_POOL,
  COMPOSE_RESPONSE_POOL,
} from '../data/cards-pool.js';

import {
  PHASE,
  PLAYER_GROUP,
  PITCHER_HAND_DISPLAY,
  CARD_COST_XS,
  CARD_COST_SM,
  CARD_COST_CAPPED,
  CARD_COST_LG,
  CARD_COST_EXT,
  ARCHETYPE_CARD_WEIGHTS,
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  GM_RELATIONSHIP_DEFAULT,
} from '../data/constants.js';

import { injurePlayer } from './InjuryEngine.js';
import { activateFromIL, placeOnWaivers, sendToFarm } from './RosterEngine.js';
import { evaluateTrade, executeTrade, recordDeclinedOffer } from './TradeEngine.js';
import { setFlag, selectCardVariant } from './NarrativeEngine.js';

// ─────────────────────────────────────────────────────────────
// CARD POOLS — keyed by pool name for lookup
// ─────────────────────────────────────────────────────────────

const ALL_POOLS = {
  DECISIONS_POOL,
  PREGAME_POOL,
  INGAME_POOL,
  BETWEEN_GAMES_POOL,
  FOLLOWUP_POOL,
  PERSONAL_LEAVE_POOL,
  MANAGER_CONTRACT_POOL,
  COACHING_CONTRACT_POOL,
};

// Per-phase active pools
const PHASE_POOLS = Object.freeze({
  [PHASE.SPRING_TRAINING]:       ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL'],
  [PHASE.REGULAR_SEASON]:        ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL', 'BETWEEN_GAMES_POOL'],
  [PHASE.ALL_STAR_BREAK]:        ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL'],
  [PHASE.TRADE_DEADLINE]:        ['DECISIONS_POOL', 'PREGAME_POOL'],
  [PHASE.WILD_CARD]:             ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.FIRST_ROUND]:           ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.DIVISION_SERIES]:       ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.WORLD_SERIES]:          ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.SEASON_SUMMARY]:        ['DECISIONS_POOL'],
  [PHASE.OFFSEASON]:             ['DECISIONS_POOL', 'MANAGER_CONTRACT_POOL', 'COACHING_CONTRACT_POOL'],
});

// Max cards delivered per game check (prevents inbox flooding)
const MAX_CARDS_PER_CHECK = 3;
const MAX_INBOX_SIZE       = 12;

// ─────────────────────────────────────────────────────────────
// MAIN DELIVERY LOOP
// ─────────────────────────────────────────────────────────────

/**
 * checkAndDeliver(context)
 * Main loop — called by GameEngine after each game commit.
 * Selects eligible cards, resolves tokens, delivers to inbox.
 *
 * Also processes:
 *   - Expired cards (auto-resolve with penalty)
 *   - IL return queue (generates Act 2 decision cards)
 *   - Injury events from InjuryEngine
 *   - Trade proposal events from TradeEngine
 *   - Weather transition events from WeatherEngine
 *
 * @param {Object} context — from GameEngine.buildCardContext()
 * @returns {void}
 */
export function checkAndDeliver(context) {
  const state = StateManager.get();

  // 1. Expire old cards first
  _expireCards(state, context);

  // 2. Process IL return queue
  _processILReturnQueue(state, context);

  // 3. Check inbox capacity
  const currentInbox = (state.inbox || []).filter(c => !c.resolved);
  if (currentInbox.length >= MAX_INBOX_SIZE) return;

  const slotsAvailable = Math.min(
    MAX_CARDS_PER_CHECK,
    MAX_INBOX_SIZE - currentInbox.length
  );

  // 4. Select eligible cards from active pools
  const phase     = state.phase;
  const poolNames = PHASE_POOLS[phase] || ['DECISIONS_POOL'];
  const delivered = [];

  for (const poolName of poolNames) {
    if (delivered.length >= slotsAvailable) break;

    const pool      = ALL_POOLS[poolName] || [];
    const eligible  = _filterEligible(pool, context, state);
    const selected  = _selectCards(eligible, context, state, slotsAvailable - delivered.length);

    for (const cardDef of selected) {
      const instance = _createInstance(cardDef, context, state);
      if (instance) {
        delivered.push(instance);
      }
    }
  }

  if (delivered.length === 0) return;

  // 5. Deliver to inbox
  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), ...delivered];
    _sortInbox(s.inbox);
  });

  // 6. Schedule notifications for urgent cards
  _scheduleNotifications(delivered, context);
}

// ─────────────────────────────────────────────────────────────
// CARD RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * resolve(instanceId, choice)
 * Applies the effects of a card decision and queues any follow-ups.
 *
 * @param {String} instanceId
 * @param {String} choice  — 'yes' | 'no'
 * @returns {void}
 */
export function resolve(instanceId, choice) {
  const state    = StateManager.get();
  const instance = (state.inbox || []).find(c => c.instanceId === instanceId);
  if (!instance) throw new Error(`CardEngine.resolve: instance '${instanceId}' not found`);
  if (instance.resolved) return;

  const effects = choice === 'yes' ? (instance.yesEffect || {}) : (instance.noEffect || {});

  StateManager.mutate(s => {
    // Mark resolved
    const card = s.inbox.find(c => c.instanceId === instanceId);
    if (card) {
      card.resolved    = true;
      card.resolvedAt  = s.currentGameIndex || 0;
      card.choice      = choice;
    }

    // Apply soft metric effects
    _applySoftEffects(s, effects, choice, instance);

    // Apply budget cost (yes decisions only)
    if (choice === 'yes' && instance._budgetCost) {
      const cost = _resolveBudgetCost(instance._budgetCost, s);
      s.userTeam.finances.operatingSpent =
        (s.userTeam.finances.operatingSpent || 0) + cost;
    }

    // Apply player relationship effects
    if (instance._playerRelationshipEffect) {
      _applyPlayerRelationshipEffect(s, instance._playerRelationshipEffect, choice);
    }

    // Narrative flag instrumentation (Section 34.6 — LOCKED)
    // Centralized here — no scattered setFlag calls across other files.
    // Cards that generate flags declare flagKey (on 'no') and/or flagKeyYes (on 'yes').
    const flagKey = choice === 'yes'
      ? (instance._raw?.flagKeyYes || null)
      : (instance._raw?.flagKey    || null);

    if (flagKey) {
      s.narrativeFlags = setFlag(s, {
        key:     flagKey,
        subject: instance._raw?.flagSubject
                   ? _resolveSubject(instance._raw.flagSubject, instance)
                   : null,
        gameIdx: s.currentGameIndex || 0,
        season:  s.seasonNum        || 1,
        choice,
        context: instance._raw?.flagContext || null,
      });
    }

    // Queue follow-up card if specified
    const followupType = choice === 'yes'
      ? (instance._raw?.onYes)
      : (instance._raw?.onNo);

    if (followupType) {
      s.followupQueue = [...(s.followupQueue || []), {
        type:    followupType,
        atGame:  (s.currentGameIndex || 0) + 1,
        payload: {
          instanceId,
          choice,
          playerId:    instance._targetPlayerId || null,
          act2Variance: instance._act2Variance || null,
        },
      }];
    }
  });

  // Handle roster actions
  _applyRosterAction(instance, choice, StateManager.get());
}

/**
 * expire(instanceId)
 * Auto-resolves a card with its auto-resolve path and penalty.
 *
 * @param {String} instanceId
 * @returns {void}
 */
export function expire(instanceId) {
  const state    = StateManager.get();
  const instance = (state.inbox || []).find(c => c.instanceId === instanceId);
  if (!instance || instance.resolved) return;

  const autoPath = instance.autoResolve || 'no';
  if (autoPath === 'skip') {
    // Silently dismiss
    StateManager.mutate(s => {
      const card = s.inbox.find(c => c.instanceId === instanceId);
      if (card) { card.resolved = true; card.choice = 'skip'; }
    });
    return;
  }

  // Apply auto-resolve tax
  const tax = instance.autoResolveTax || {};
  StateManager.mutate(s => {
    const card = s.inbox.find(c => c.instanceId === instanceId);
    if (card) {
      card.resolved  = true;
      card.choice    = 'auto';
      card.resolvedAt = s.currentGameIndex || 0;
    }
    _applySoftEffects(s, tax, 'auto', instance);
  });
}

// ─────────────────────────────────────────────────────────────
// IL RETURN DECISION CARDS
// ─────────────────────────────────────────────────────────────

/**
 * _processILReturnQueue(state, context)
 * Generates IL return decision cards for players in ilReturnQueue.
 * Presents GM with: activate, send to farm (spring only), or waive.
 */
function _processILReturnQueue(state, context) {
  const queue = state.ilReturnQueue || [];
  if (queue.length === 0) return;

  const isSpring = state.phase === PHASE.SPRING_TRAINING;

  for (const playerId of queue) {
    const player = state.players[playerId];
    if (!player) continue;

    // Check if already has an IL return card in inbox
    const alreadyHasCard = (state.inbox || []).some(
      c => !c.resolved && c._targetPlayerId === playerId && c.tag === 'IL_RETURN'
    );
    if (alreadyHasCard) continue;

    const isPitcher  = ['SP', 'RP'].includes(player.pos);
    const handSuffix = isPitcher
      ? ` ${PITCHER_HAND_DISPLAY[player.hand] || '(R)'}`
      : '';
    const playerRef  = `${player.name}${handSuffix} (${player.pos})`;

    // Find best callup candidate for the yes label
    const callupCandidate = _findCallupCandidate(player, state);
    const callupName      = callupCandidate
      ? state.players[callupCandidate]?.name || 'Farm callup'
      : 'Farm callup';

    const noLabels = isSpring
      ? ['Activate', 'Send to Farm', 'Place on Waivers']
      : ['Activate', 'Place on Waivers'];

    const instance = {
      instanceId:       _uuid(),
      cardId:           'il_return',
      deliveredAt:      state.currentGameIndex || 0,
      expiresAt:        (state.currentGameIndex || 0) + 3,
      expiresAtMs:      null,
      resolved:         false,
      resolvedAt:       null,
      choice:           null,
      type:             'urgent',
      tag:              'IL_RETURN',
      sender:           'Team Physician',
      subject:          `${player.name} cleared to return`,
      preview:          `${playerRef} has been cleared — roster decision needed.`,
      body:             `${playerRef} has completed their recovery and been cleared for game action. ${callupName} has been covering the spot. Do you want to activate ${player.name}, or make a different move?`,
      yesLabel:         `Activate ${player.name}`,
      noLabel:          isSpring ? 'Send to Farm' : 'Place on Waivers',
      yesEffect:        { morale: 1 },
      noEffect:         { morale: -1 },
      autoResolve:      'yes',
      autoResolveTax:   null,
      _playerRelationshipEffect: null,
      _budgetCost:      null,
      _targetPlayerId:  playerId,
      _callupCandidate: callupCandidate,
      _isSpring:        isSpring,
      _raw:             { onYes: 'il_return_activate', onNo: isSpring ? 'il_return_farm' : 'il_return_waive' },
    };

    StateManager.mutate(s => {
      s.inbox = [...(s.inbox || []), instance];
    });
  }
}

// ─────────────────────────────────────────────────────────────
// INJURY TWO-ACT CARD GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * deliverInjuryAct1(event, context)
 * Generates the Act 1 INGAME injury card from an InjuryEngine event.
 * Called by GameEngine when an in-game injury event fires.
 *
 * @param {Object} event   — { playerId, severity, injuryType, ilReturnGame }
 * @param {Object} context — from GameEngine.buildCardContext()
 */
export function deliverInjuryAct1(event, context) {
  const state    = StateManager.get();
  const player   = state.players[event.playerId];
  if (!player) return;

  const isPitcher  = ['SP', 'RP'].includes(player.pos);
  const handSuffix = isPitcher ? ` ${PITCHER_HAND_DISPLAY[player.hand] || '(R)'}` : '';
  const playerRef  = `${player.name}${handSuffix}`;
  const inningStr  = `${context.currentInning || 'an early'}`;

  const instance = {
    instanceId:      _uuid(),
    cardId:          'injury_act1',
    deliveredAt:     state.currentGameIndex || 0,
    expiresAt:       (state.currentGameIndex || 0) + 1,
    expiresAtMs:     null,
    resolved:        false,
    resolvedAt:      null,
    choice:          null,
    type:            'urgent',
    tag:             'INJURY',
    sender:          'Head Trainer',
    subject:         `${player.name} down — leaving the game, evaluation pending`,
    preview:         `${playerRef} left the field in the ${inningStr} inning. Evaluation in progress.`,
    body:            `${playerRef} left the field in the ${inningStr} inning and is being evaluated in the clubhouse. No diagnosis yet. ${state.userTeam.coachingStaff?.manager?.name || 'The manager'} wants to know how to handle the lineup for the rest of the game.`,
    yesLabel:        'Cover the slot — adjust the lineup now',
    noLabel:         'Hold — wait to see if they can return',
    yesEffect:       { morale: -1 },
    noEffect:        { morale: -2 },
    autoResolve:     'yes',
    autoResolveTax:  { morale: -1 },
    _playerRelationshipEffect: null,
    _budgetCost:     null,
    _targetPlayerId: event.playerId,
    _act2Variance:   player._act2Variance || 'confirmed',
    _raw:            { onYes: 'injury_act2', onNo: 'injury_act2' },
  };

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), instance];
    _sortInbox(s.inbox);
  });
}

/**
 * deliverInjuryAct2(playerId, act2Variance, context)
 * Generates the Act 2 post-game injury card with full diagnosis.
 * Called by GameEngine's followup queue processor.
 *
 * @param {String} playerId
 * @param {String} act2Variance — 'better'|'confirmed'|'worse'
 */
export function deliverInjuryAct2(playerId, act2Variance) {
  const state  = StateManager.get();
  const player = state.players[playerId];
  if (!player) return;

  const report     = player.injuryReport;
  const isPitcher  = ['SP', 'RP'].includes(player.pos);
  const handSuffix = isPitcher ? ` ${PITCHER_HAND_DISPLAY[player.hand] || '(R)'}` : '';
  const playerRef  = `${player.name}${handSuffix}`;

  // Act 2 variance affects the diagnosis framing
  const varianceNote = act2Variance === 'better'
    ? 'Good news — it\'s less serious than initially feared.'
    : act2Variance === 'worse'
    ? 'The scans showed more than expected. The timeline is longer.'
    : '';

  const ilDays         = report?.ilDays || 10;
  const callupCandidate = _findCallupCandidate(player, state);
  const callupName     = callupCandidate
    ? state.players[callupCandidate]?.name || 'a farm player'
    : 'a farm player';

  const instance = {
    instanceId:      _uuid(),
    cardId:          'injury_act2',
    deliveredAt:     state.currentGameIndex || 0,
    expiresAt:       (state.currentGameIndex || 0) + 3,
    expiresAtMs:     null,
    resolved:        false,
    resolvedAt:      null,
    choice:          null,
    type:            'urgent',
    tag:             'INJURY',
    sender:          'Team Physician',
    subject:         `${player.name} — diagnosis confirmed`,
    preview:         `MRI results back. ${varianceNote || report?.generalText || 'See full report.'}`,
    body:            `MRI results are in. ${report?.detailedText || report?.generalText || 'See team physician for details.'} ${varianceNote} The physician recommends ${ilDays} days minimum. You can place on the IL now and call up ${callupName}, or manage day-to-day and preserve roster flexibility.`,
    yesLabel:        `Place on IL — call up ${callupName}`,
    noLabel:         'Day-to-day — manage the roster manually',
    yesEffect:       { morale: 1 },
    noEffect:        { morale: -1 },
    autoResolve:     'yes',
    autoResolveTax:  { morale: -2 },
    _playerRelationshipEffect: null,
    _budgetCost:     null,
    _targetPlayerId: playerId,
    _callupCandidate: callupCandidate,
    _raw:            { onYes: 'il_placement', onNo: 'day_to_day' },
  };

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), instance];
    _sortInbox(s.inbox);

    // ── Franchise history: serious injury (IL > 14 days — Section 35.2) ───
    if (ilDays > 14) {
      const injuryDesc = report?.detailedText || report?.generalText || 'injury';
      s.history = [...(s.history || []), {
        id:       _uuid(),
        type:     'injury',
        season:   s.seasonNum || 1,
        gameIdx:  s.currentGameIndex || 0,
        headline: `${player.name} — ${ilDays}-day IL stint`,
        detail:   `${player.name} (${player.pos}) placed on IL. ${injuryDesc} Estimated return: ${ilDays} days.`,
        playerId: playerId,
        icon:     '🩹',
        userNote: '',
      }];
    }
  });
}
// ─────────────────────────────────────────────────────────────

/**
 * deliverTradeOffer(offer, evaluation, proposingTeamId)
 * Delivers a CPU trade proposal as an inbox card.
 * Card text dynamically built from the evaluated offer.
 *
 * @param {Object} offer
 * @param {Object} evaluation  — from TradeEngine.evaluateTrade()
 * @param {String} proposingTeamId
 */
export function deliverTradeOffer(offer, evaluation, proposingTeamId) {
  const state    = StateManager.get();
  const team     = (state.leagueTeams || []).find(t => t.id === proposingTeamId);
  const teamName = team?.name || 'Another team';

  const incoming = evaluation.incomingPlayers[0];
  const outgoing = evaluation.outgoingPlayers[0];
  if (!incoming || !outgoing) return;

  const isPitcherIn  = ['SP','RP'].includes(incoming.pos);
  const handIn       = isPitcherIn ? ` ${PITCHER_HAND_DISPLAY[incoming.hand] || '(R)'}` : '';
  const isPitcherOut = ['SP','RP'].includes(outgoing.pos);
  const handOut      = isPitcherOut ? ` ${PITCHER_HAND_DISPLAY[outgoing.hand] || '(R)'}` : '';

  const inRef  = `${incoming.name}${handIn} (${incoming.pos}, OVR ${incoming.ovr})`;
  const outRef = `${outgoing.name}${handOut} (${outgoing.pos}, OVR ${outgoing.ovr})`;

  const fairnessNote = evaluation.fairnessRating >= 1
    ? `Our scouting grades this as ${evaluation.fairnessLabel.toLowerCase()} for us.`
    : evaluation.fairnessRating <= -1
    ? `Worth noting: our scouting grades this as ${evaluation.fairnessLabel.toLowerCase()}.`
    : 'Our scouting grades this as a fair exchange.';

  const payrollNote = evaluation.overCap
    ? ' This would push payroll over the cap.'
    : evaluation.payrollDelta > 500
    ? ` Adds $${Math.round(evaluation.payrollDelta)}K to payroll.`
    : evaluation.payrollDelta < -500
    ? ` Saves $${Math.abs(Math.round(evaluation.payrollDelta))}K in payroll.`
    : '';

  const instance = {
    instanceId:      _uuid(),
    cardId:          `trade_${proposingTeamId}`,
    deliveredAt:     state.currentGameIndex || 0,
    expiresAt:       (state.currentGameIndex || 0) + 3,
    expiresAtMs:     null,
    resolved:        false,
    resolvedAt:      null,
    choice:          null,
    type:            'normal',
    tag:             'TRADE',
    sender:          teamName,
    subject:         `Trade offer from ${teamName}`,
    preview:         `${teamName} is offering ${incoming.name} for ${outgoing.name}.`,
    body:            `${teamName} has proposed a trade: you send ${outRef} and receive ${inRef}. ${fairnessNote}${payrollNote}`,
    yesLabel:        'Accept the Trade',
    noLabel:         'Decline',
    yesEffect:       {},
    noEffect:        {},
    autoResolve:     'no',
    autoResolveTax:  null,
    _playerRelationshipEffect: null,
    _budgetCost:     null,
    _tradeOffer:     offer,
    _tradeEval:      evaluation,
    _proposingTeamId: proposingTeamId,
    _raw:            { onYes: 'trade_execute', onNo: 'trade_decline' },
  };

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), instance];
    _sortInbox(s.inbox);
  });
}

// ─────────────────────────────────────────────────────────────
// COMPOSE CARD DELIVERY (Phase 15 — Section 8.12)
// ─────────────────────────────────────────────────────────────

/**
 * deliverCardById(cardId)
 * Debug tool — delivers any card from any pool directly to the inbox by ID.
 * Used by DebugScreen. Searches all pools in order.
 * Falls back gracefully if card ID is not found.
 *
 * @param {String} cardId
 */
export function deliverCardById(cardId) {
  if (!cardId) return;

  // Search all pools for the card definition
  const allPools = [
    DECISIONS_POOL,
    FOLLOWUP_POOL,
    PREGAME_POOL,
    INGAME_POOL,
    BETWEEN_GAMES_POOL,
  ];

  let cardDef = null;
  for (const pool of allPools) {
    const found = pool.find(entry => {
      // Decisions pool entries may be wrapped in { type, card }
      const def = entry?.card || entry;
      return def?.id === cardId;
    });
    if (found) {
      cardDef = found?.card || found;
      break;
    }
  }

  if (!cardDef) {
    console.warn(`[CardEngine.deliverCardById] Card '${cardId}' not found in any pool.`);
    return;
  }

  const state   = StateManager.get();
  const context = {};
  const body    = resolveTokens(selectCardVariant(cardDef, state), context, state);
  const subject = resolveTokens(cardDef.subject || '', context, state);

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), {
      instanceId:  _uuid(),
      cardId:      cardDef.id,
      type:        cardDef.type    || 'normal',
      tag:         cardDef.tag     || 'DEBUG',
      sender:      resolveTokens(cardDef.sender || 'Debug', context, state),
      avatar:      cardDef.avatar  || '🔍',
      subject,
      preview:     cardDef.preview || subject,
      body,
      _resolved:   false,
      deliveredAt: Date.now(),
      gameIdx:     s.currentGameIndex || 0,
      yesLabel:    cardDef.yesLabel || 'Accept',
      noLabel:     cardDef.noLabel  || 'Decline',
      yesEffect:   cardDef.yesEffect || {},
      noEffect:    cardDef.noEffect  || {},
      autoResolve: cardDef.autoResolve,
      _raw:        cardDef,
      _debugInjected: true,
    }];
    _sortInbox(s.inbox);
  });
}

/**
 * deliverComposeCard(topicId, channelId)
 * Delivers a compose response card to the inbox.
 * Looks up the card definition from COMPOSE_RESPONSE_POOL by topicId.
 * Runs selectCardVariant() for region-aware and narrative-aware responses.
 * Falls back to a generic acknowledgement card if the topic isn't in the pool.
 *
 * @param {String} topicId    — e.g. 'gk_field', 'mgr_morale'
 * @param {String} channelId  — e.g. 'groundskeeper', 'manager'
 */
export function deliverComposeCard(topicId, channelId) {
  const state   = StateManager.get();
  const cardDef = COMPOSE_RESPONSE_POOL[topicId];

  if (!cardDef) {
    // Fallback — generic acknowledgement for topics not yet in the pool
    StateManager.mutate(s => {
      s.inbox = [...(s.inbox || []), {
        instanceId:   _uuid(),
        cardId:       `compose_${topicId}`,
        type:         'normal',
        tag:          'OPERATIONS',
        sender:       'Staff',
        avatar:       '📋',
        subject:      'Message received',
        preview:      'Your message has been noted.',
        body:         'Your message was received. The staff will follow up if there\'s anything that needs your attention.',
        isCompose:    true,
        autoResolved: true,
        _resolved:    false,
        deliveredAt:  Date.now(),
        gameIdx:      state.currentGameIndex || 0,
        yesLabel:     'Noted',
      }];
    });
    return;
  }

  const context  = _buildContextForCompose(state, channelId);
  // Select region-aware / narrative-aware variant before token resolution
  const chosenBody = _selectComposeVariant(cardDef, state);
  const body       = resolveTokens(chosenBody,           context, state);
  const subject    = resolveTokens(cardDef.subject || '', context, state);

  const instance = {
    instanceId:   _uuid(),
    cardId:       cardDef.id,
    type:         cardDef.type   || 'normal',
    tag:          cardDef.tag    || 'OPERATIONS',
    sender:       resolveTokens(cardDef.sender  || 'Staff', context, state),
    avatar:       cardDef.avatar || '📋',
    subject,
    preview:      subject,
    body,
    isCompose:    true,
    autoResolved: true,
    _resolved:    false,
    deliveredAt:  Date.now(),
    gameIdx:      state.currentGameIndex || 0,
    yesLabel:     cardDef.yesLabel || 'Noted',
    yesEffect:    cardDef.yesEffect || {},
    _raw:         cardDef,
  };

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), instance];
    _sortInbox(s.inbox);
  });
}

/**
 * _selectComposeVariant(cardDef, state)
 * Selects the appropriate variant body for a compose response card.
 * Respects _groundskeeperFlavor on variants to serve region-specific content.
 * Falls back to NarrativeEngine.selectCardVariant for narrative conditions.
 *
 * @param {Object} cardDef
 * @param {Object} state
 * @returns {String} body text
 */
function _selectComposeVariant(cardDef, state) {
  if (!cardDef.variants || cardDef.variants.length === 0) {
    return cardDef.body || '';
  }

  const region = state.settings?.region || 'north';

  // Region-flavored variants take precedence when the flavor matches
  for (const variant of cardDef.variants) {
    if (variant._groundskeeperFlavor && variant._groundskeeperFlavor === region) {
      return variant.body || cardDef.body || '';
    }
  }

  // Fall through to standard narrative variant selection
  return selectCardVariant(cardDef, state);
}

/**
 * _buildContextForCompose(state, channelId)
 * Builds a minimal card context for compose response token resolution.
 * Reuses the standard buildCardContext where available.
 *
 * @param {Object} state
 * @param {String} channelId
 * @returns {Object} context
 */
function _buildContextForCompose(state, channelId) {
  try {
    // Lazy import to avoid circular dependency with GameEngine
    const ctx = typeof buildCardContext === 'function'
      ? buildCardContext()
      : {};
    return { ...ctx, composeChannel: channelId };
  } catch {
    return { composeChannel: channelId };
  }
}

/**
 * getInbox()
 * Returns pending (unresolved) inbox cards sorted by priority.
 * urgent → normal → good, then by deliveredAt descending.
 *
 * @returns {Object[]} cards
 */
export function getInbox() {
  const state = StateManager.get();
  return (state.inbox || [])
    .filter(c => !c.resolved)
    .sort(_sortComparator);
}

/**
 * getHistory(limit?)
 * Returns recently resolved cards, newest first.
 *
 * @param {Number} [limit]
 * @returns {Object[]}
 */
export function getHistory(limit = 20) {
  const state = StateManager.get();
  return (state.inbox || [])
    .filter(c => c.resolved)
    .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// FOLLOWUP QUEUE PROCESSING
// ─────────────────────────────────────────────────────────────

/**
 * processFollowupQueue()
 * Called by GameEngine at each game commit.
 * Fires any followup cards whose atGame has been reached.
 */
export function processFollowupQueue() {
  const state    = StateManager.get();
  const gameIdx  = state.currentGameIndex || 0;
  const queue    = state.followupQueue || [];
  const toFire   = queue.filter(f => f.atGame <= gameIdx);
  if (toFire.length === 0) return;

  StateManager.mutate(s => {
    s.followupQueue = queue.filter(f => f.atGame > gameIdx);
  });

  for (const followup of toFire) {
    _fireFollowup(followup);
  }
}

// ─────────────────────────────────────────────────────────────
// TOKEN RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * resolveTokens(text, context, state)
 * Replaces all {token} placeholders in card text with real values.
 * PITCHER HANDEDNESS RULE: all pitcher name tokens automatically append (R)/(L).
 *
 * @param {String} text
 * @param {Object} context
 * @param {Object} state
 * @returns {String} resolved text
 */
export function resolveTokens(text, context, state) {
  if (!text) return '';

  const userTeam  = state.userTeam;
  const staff     = userTeam.coachingStaff || {};

  // Build token map
  const tokens = {
    // Staff names
    manager_name:        staff.manager?.name        || 'The Manager',
    pitching_coach_name: staff.pitchingCoach?.name  || 'Pitching Coach',
    hitting_coach_name:  staff.hittingCoach?.name   || 'Hitting Coach',
    bench_coach_name:    staff.benchCoach?.name     || 'Bench Coach',
    bullpen_coach_name:  staff.bullpenCoach?.name   || 'Bullpen Coach',
    physician_name:      'Team Physician',
    cfo_name:            'The CFO',

    // Schedule context
    next_opponent:       context.nextGame?.opponent    || 'the next opponent',
    road_trip_length:    String(context.consecutiveRoadGames || 3),

    // Budget cost tokens (resolve to display strings)
    misc_cost_xs:        _formatCostToken(CARD_COST_XS),
    misc_cost_sm:        _formatCostToken(CARD_COST_SM),
    misc_cost_capped:    _formatCostToken(CARD_COST_CAPPED),
    misc_cost_lg:        _formatCostToken(CARD_COST_LG),
    ext_cost:            _formatCostToken(CARD_COST_EXT),
    grounds_crew_cost:   _formatCostToken(CARD_COST_SM),
    nri_cost:            _formatCostToken(CARD_COST_XS),

    // Streak context
    streak_context_clause: _streakClause(userTeam.streak || 0),
  };

  // Pitcher name tokens — handedness automatically appended
  const activeSP = _pickActivePitcher(state, 'SP');
  const activeBP = _pickActivePitcher(state, 'RP');
  const farmPitcher = _pickFarmPitcher(state);

  if (activeSP) {
    const hand = PITCHER_HAND_DISPLAY[activeSP.hand] || '(R)';
    tokens['active_sp_name'] = `${activeSP.name} ${hand}`;
    tokens['active_sp_pos']  = activeSP.pos;
  }
  if (activeBP) {
    const hand = PITCHER_HAND_DISPLAY[activeBP.hand] || '(R)';
    tokens['active_bp_name'] = `${activeBP.name} ${hand}`;
  }
  if (farmPitcher) {
    const hand = PITCHER_HAND_DISPLAY[farmPitcher.hand] || '(R)';
    tokens['farm_pitcher_name'] = `${farmPitcher.name} ${hand}`;
    tokens['farm_pitcher_pos']  = farmPitcher.pos;
  }

  // Hitter name tokens — no handedness
  const activeHitter = _pickActiveHitter(state);
  const farmHitter   = _pickFarmHitter(state);
  const activeCatcher = _pickActivePlayerByPos(state, 'C');

  if (activeHitter) {
    tokens['active_hitter_name'] = activeHitter.name;
    tokens['active_hitter_pos']  = activeHitter.pos;
    tokens['act_hi']             = activeHitter.name;
  }
  if (farmHitter) {
    tokens['farm_hitter_name'] = farmHitter.name;
    tokens['farm_hitter_pos']  = farmHitter.nativePos || farmHitter.pos;
  }
  if (activeCatcher) {
    tokens['active_catcher_name'] = activeCatcher.name;
  }

  // Trait notes
  if (activeHitter?.trait) {
    tokens['active_hitter_trait_note'] = _traitNote(activeHitter.trait);
  }
  if (activeSP?.trait) {
    tokens['active_sp_trait_note'] = _traitNote(activeSP.trait);
  }

  // Replace all tokens
  return text.replace(/\{([a-z_]+)\}/g, (match, key) => {
    return tokens[key] !== undefined ? tokens[key] : match;
  });
}

// ─────────────────────────────────────────────────────────────
// ELIGIBILITY FILTERING
// ─────────────────────────────────────────────────────────────

function _filterEligible(pool, context, state) {
  const gameIdx   = state.currentGameIndex || 0;
  const phase     = state.phase;
  const isSpring  = phase === PHASE.SPRING_TRAINING;
  const isRegular = phase === PHASE.REGULAR_SEASON;
  const regIdx    = context.regularSeasonIndex || 0;

  // Build set of already-delivered card IDs this season
  const deliveredIds = new Set(
    (state.inbox || [])
      .filter(c => !c._expiredSeason || c._expiredSeason === state.seasonNum)
      .map(c => c.cardId)
  );

  return pool.filter(card => {
    // Phase gates
    if (card._requiresSpring  && !isSpring)  return false;
    if (card._requiresRegular && !isRegular) return false;
    if (card._requiresDeadlineWindow &&
        !(regIdx >= TRADE_DEADLINE_OPEN && regIdx <= TRADE_DEADLINE_CLOSE)) return false;

    // Game index gates
    if (card._minGames    !== undefined && gameIdx < card._minGames)    return false;
    if (card._maxSpringGame !== undefined && context.springGameIndex !== undefined
        && context.springGameIndex > card._maxSpringGame) return false;

    // Location gates
    if (card._requiresHome && !context.nextGame?.isHome) return false;
    if (card._requiresRoad && context.nextGame?.isHome)  return false;

    // Series / schedule context gates
    if (card._requiresTravelDay      && !context.isTravelDay)       return false;
    if (card._requiresHomeStandOpener && !context.isHomeStandOpener) return false;
    if (card._requiresHomeStandCloser && !context.isHomeStandCloser) return false;
    if (card._requiresRoadTripOpener  && !context.isRoadTripOpener)  return false;
    if (card._requiresDivisionOpponent && !context.isDivisionOpponent) return false;
    if (card._minConsecutiveRoadGames &&
        (context.consecutiveRoadGames || 0) < card._minConsecutiveRoadGames) return false;

    // Streak gates
    if (card._minStreak !== undefined) {
      const streak = state.userTeam?.streak || 0;
      if (Math.abs(streak) < Math.abs(card._minStreak)) return false;
      if (card._minStreak > 0 && streak < 0) return false;
      if (card._minStreak < 0 && streak > 0) return false;
    }

    // Once-per-season deduplication
    if (card._oncePerSeason && deliveredIds.has(card.id)) return false;

    // Roster coverage gates
    if (card._requiresBenchSP && !_hasBenchSP(state)) return false;
    if (card._requiresTargetCoverage && !_hasPositionCoverage(state)) return false;

    // Prestige tier gate
    if (card._maxTier !== undefined && (state.prestigeTier || 1) > card._maxTier) return false;

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// CARD SELECTION (weighted random)
// ─────────────────────────────────────────────────────────────

function _selectCards(eligible, context, state, maxCount) {
  if (eligible.length === 0) return [];

  const archetypeId = state.archetype;
  const weights     = ARCHETYPE_CARD_WEIGHTS[archetypeId] || {};

  // Score each card
  const scored = eligible.map(card => {
    let weight = card._weight || 1.0;

    // Apply archetype card weight modifier
    const tag = (card.tag || '').toLowerCase();
    if (tag === 'development' && weights.development) weight *= weights.development;
    else if (tag === 'trade'  && weights.trade)       weight *= weights.trade;
    else if (tag === 'culture' && weights.culture)    weight *= weights.culture;

    // Streak-based urgency boost
    const streak = state.userTeam?.streak || 0;
    if (Math.abs(streak) >= 5 && card.tag === 'CULTURE') weight *= 1.3;

    return { card, weight };
  });

  // Weighted random selection without replacement
  const selected = [];
  const pool     = [...scored];

  for (let i = 0; i < Math.min(maxCount, pool.length); i++) {
    const total  = pool.reduce((s, item) => s + item.weight, 0);
    let r        = Math.random() * total;
    let idx      = 0;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) { idx = j; break; }
    }
    selected.push(pool[idx].card);
    pool.splice(idx, 1);
  }

  return selected;
}

// ─────────────────────────────────────────────────────────────
// CARD INSTANCE CREATION
// ─────────────────────────────────────────────────────────────

function _createInstance(cardDef, context, state) {
  const gameIdx   = state.currentGameIndex || 0;
  const ttl       = cardDef._ttl ?? 3;
  const expiresAt = ttl > 0 ? gameIdx + ttl : null;

  const subject = resolveTokens(cardDef.subject || '', context, state);
  const preview = resolveTokens(cardDef.preview || '', context, state);
  // Select variant body first (Section 34 — LOCKED), then resolve tokens in it.
  // selectCardVariant() returns the default body if no variant condition matches.
  const chosenBody = selectCardVariant(cardDef, state);
  const body       = resolveTokens(chosenBody, context, state);

  // Resolve budget cost to a $K number
  const budgetCostK = cardDef._budgetCost
    ? _resolveBudgetCostK(cardDef._budgetCost)
    : null;

  return {
    instanceId:       _uuid(),
    cardId:           cardDef.id,
    deliveredAt:      gameIdx,
    expiresAt,
    expiresAtMs:      null,
    resolved:         false,
    resolvedAt:       null,
    choice:           null,
    type:             cardDef.type       || 'normal',
    tag:              cardDef.tag        || 'GENERAL',
    sender:           resolveTokens(cardDef.sender || '', context, state),
    avatar:           cardDef.avatar     || '📋',
    subject,
    preview,
    body,
    yesLabel:         cardDef.yesLabel   || 'Yes',
    noLabel:          cardDef.noLabel    || 'No',
    yesEffect:        cardDef.yesEffect  || {},
    noEffect:         cardDef.noEffect   || {},
    autoResolve:      cardDef.autoResolve   || null,
    autoResolveTax:   cardDef.autoResolveTax || null,
    _playerRelationshipEffect: cardDef._playerRelationshipEffect || null,
    _budgetCost:      budgetCostK,
    _expiredSeason:   state.seasonNum,
    _raw:             cardDef,
  };
}

// ─────────────────────────────────────────────────────────────
// EFFECT APPLICATION
// ─────────────────────────────────────────────────────────────

function _applySoftEffects(state, effects, choice, instance) {
  if (!effects) return;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  if (effects.morale     !== undefined) state.userTeam.morale           = clamp((state.userTeam.morale     || 50) + effects.morale,     0, 100);
  if (effects.atmo       !== undefined) state.userTeam.atmosphere       = clamp((state.userTeam.atmosphere || 50) + effects.atmo,       0, 100);
  if (effects.atmosphere !== undefined) state.userTeam.atmosphere       = clamp((state.userTeam.atmosphere || 50) + effects.atmosphere, 0, 100);
  if (effects.ownerTrust !== undefined) state.userTeam.ownerTrust       = clamp((state.userTeam.ownerTrust || 60) + effects.ownerTrust, 0, 100);
  if (effects.manConf    !== undefined) state.userTeam.managerConfidence = clamp((state.userTeam.managerConfidence || 60) + effects.manConf, 0, 100);

  // OVR effect — applies a temporary modifier to a random active player
  if (effects.ovr !== undefined && effects.ovr !== 0) {
    const rosterIds = state.userTeam.rosterIds || [];
    if (rosterIds.length > 0) {
      const targetId = rosterIds[Math.floor(Math.random() * rosterIds.length)];
      const player   = state.players[targetId];
      if (player) {
        // Apply as a small permanent sub-rating nudge (±1 per 2 OVR effect)
        const nudge = Math.round(effects.ovr / 2);
        const sr    = player.subRatings;
        if (sr) {
          const isPitcher  = sr.stuff !== null && sr.stuff !== undefined;
          const primaryKey = isPitcher ? 'control' : 'contact';
          if (sr[primaryKey] !== null && sr[primaryKey] !== undefined) {
            sr[primaryKey] = Math.max(40, Math.min(99, sr[primaryKey] + nudge));
            // Recompute OVR is done outside mutate by GameEngine
          }
        }
      }
    }
  }
}

function _applyPlayerRelationshipEffect(state, effect, choice) {
  if (!effect || !effect.playerId) return;
  const amount   = choice === 'yes' ? (effect.yesAmount || 0) : (effect.noAmount || 0);
  if (amount === 0) return;
  const player   = state.players[effect.playerId];
  if (player) {
    player.gmRelationship = Math.max(0, Math.min(100, (player.gmRelationship || 50) + amount));
  }
}

function _applyRosterAction(instance, choice, state) {
  const action = choice === 'yes'
    ? instance._raw?.onYes
    : instance._raw?.onNo;

  if (!action) return;

  switch (action) {
    case 'il_return_activate': {
      const playerId = instance._targetPlayerId;
      if (!playerId) break;
      const player   = state.players[playerId];
      if (!player) break;
      const isPitcher = ['SP','RP'].includes(player.pos);
      const targetGroup = isPitcher ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS;
      const mutations = activateFromIL(state, playerId, targetGroup);
      StateManager.mutate(s => {
        Object.assign(s.players[playerId] || {}, mutations.players?.[playerId] || {});
        s.ilReturnQueue = (s.ilReturnQueue || []).filter(id => id !== playerId);
      });
      break;
    }

    case 'il_return_waive': {
      const playerId = instance._targetPlayerId;
      if (!playerId) break;
      const mutations = placeOnWaivers(state, playerId);
      StateManager.mutate(s => {
        if (mutations.players?.[playerId]) Object.assign(s.players[playerId], mutations.players[playerId]);
        s.waiverPool   = mutations.waiverPool || s.waiverPool;
        s.ilReturnQueue = (s.ilReturnQueue || []).filter(id => id !== playerId);
        if (mutations.userTeam) Object.assign(s.userTeam, mutations.userTeam);
      });
      break;
    }

    case 'il_return_farm': {
      const playerId = instance._targetPlayerId;
      if (!playerId) break;
      const mutations = sendToFarm(state, playerId, 'user');
      StateManager.mutate(s => {
        if (mutations.players?.[playerId]) Object.assign(s.players[playerId], mutations.players[playerId]);
        if (mutations.userTeam) Object.assign(s.userTeam, mutations.userTeam);
        s.ilReturnQueue = (s.ilReturnQueue || []).filter(id => id !== playerId);
      });
      break;
    }

    case 'trade_execute': {
      const offer     = instance._tradeOffer;
      const proposer  = instance._proposingTeamId;
      if (!offer || !proposer) break;
      const mutations = executeTrade(offer, state);
      StateManager.mutate(s => {
        if (mutations.players) {
          for (const [id, upd] of Object.entries(mutations.players)) {
            if (s.players[id]) Object.assign(s.players[id], upd);
          }
        }
        if (mutations._pendingAcquisitions) s._pendingAcquisitions = mutations._pendingAcquisitions;
        if (mutations.leagueTeams)          s.leagueTeams = mutations.leagueTeams;
        if (mutations.userTeam)             Object.assign(s.userTeam, mutations.userTeam);
      });
      break;
    }

    case 'trade_decline': {
      const proposer = instance._proposingTeamId;
      if (!proposer) break;
      const mutations = recordDeclinedOffer(proposer, state);
      StateManager.mutate(s => {
        s._tradeDeclinedAt = mutations._tradeDeclinedAt;
      });
      break;
    }

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// CARD EXPIRY
// ─────────────────────────────────────────────────────────────

function _expireCards(state, context) {
  const gameIdx  = state.currentGameIndex || 0;
  const now      = Date.now();
  const toExpire = (state.inbox || []).filter(c => {
    if (c.resolved) return false;
    if (c.expiresAt   !== null && c.expiresAt   <= gameIdx) return true;
    if (c.expiresAtMs !== null && c.expiresAtMs <= now)     return true;
    return false;
  });

  for (const card of toExpire) {
    expire(card.instanceId);
  }
}

// ─────────────────────────────────────────────────────────────
// INBOX SORTING
// ─────────────────────────────────────────────────────────────

const TYPE_PRIORITY = { urgent: 0, normal: 1, good: 2 };

function _sortComparator(a, b) {
  const pa = TYPE_PRIORITY[a.type] ?? 1;
  const pb = TYPE_PRIORITY[b.type] ?? 1;
  if (pa !== pb) return pa - pb;
  return (b.deliveredAt || 0) - (a.deliveredAt || 0);
}

function _sortInbox(inbox) {
  inbox.sort(_sortComparator);
}

// ─────────────────────────────────────────────────────────────
// NOTIFICATION SCHEDULING
// ─────────────────────────────────────────────────────────────

function _scheduleNotifications(cards, context) {
  // NotificationEngine (Phase 14) will handle actual push scheduling.
  // CardEngine just marks urgent weather cards with real-world expiry.
  for (const card of cards) {
    if (card.type === 'urgent' && card.tag === 'WEATHER' && card.expiresAtMs) {
      // NotificationEngine.scheduleWeatherAlert(card) — wired in Phase 14
    }
  }
}

// ─────────────────────────────────────────────────────────────
// FOLLOWUP FIRING
// ─────────────────────────────────────────────────────────────

function _fireFollowup(followup) {
  const state = StateManager.get();

  switch (followup.type) {
    case 'injury_act2': {
      const { playerId, act2Variance } = followup.payload || {};
      if (playerId && state.players[playerId]?.isInjured) {
        deliverInjuryAct2(playerId, act2Variance || 'confirmed');
      }
      break;
    }
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// ROSTER HELPERS
// ─────────────────────────────────────────────────────────────

function _pickActivePitcher(state, role) {
  const rosterIds = state.userTeam?.rosterIds || [];
  const pitchers  = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended && p.pos === role
              && [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN,
                  PLAYER_GROUP.PITCHER_BENCH].includes(p.group));
  return pitchers[Math.floor(Math.random() * pitchers.length)] || null;
}

function _pickActiveHitter(state) {
  const rosterIds = state.userTeam?.rosterIds || [];
  const hitters   = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && !p.isSuspended
              && [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group));
  return hitters[Math.floor(Math.random() * hitters.length)] || null;
}

function _pickActivePlayerByPos(state, pos) {
  const rosterIds = state.userTeam?.rosterIds || [];
  const players   = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && (p.nativePos || p.pos) === pos);
  return players[0] || null;
}

function _pickFarmPitcher(state) {
  const farmIds = state.userTeam?.farmIds || [];
  const pitchers = farmIds
    .map(id => state.players[id])
    .filter(p => p && ['SP','RP'].includes(p.pos));
  return pitchers[Math.floor(Math.random() * pitchers.length)] || null;
}

function _pickFarmHitter(state) {
  const farmIds = state.userTeam?.farmIds || [];
  const hitters = farmIds
    .map(id => state.players[id])
    .filter(p => p && !['SP','RP'].includes(p.pos));
  return hitters[Math.floor(Math.random() * hitters.length)] || null;
}

function _findCallupCandidate(injuredPlayer, state) {
  const farmIds = state.userTeam?.farmIds || [];
  const isPitcher = ['SP','RP'].includes(injuredPlayer.pos);
  const candidates = farmIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && (isPitcher ? ['SP','RP'].includes(p.pos) : !['SP','RP'].includes(p.pos)))
    .sort((a, b) => b.ovr - a.ovr);
  return candidates[0]?.id || null;
}

function _hasBenchSP(state) {
  return (state.userTeam?.rosterIds || []).some(id => {
    const p = state.players[id];
    return p && p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'SP' && !p.isInjured;
  });
}

function _hasPositionCoverage(state) {
  return (state.userTeam?.rosterIds || []).some(id => {
    const p = state.players[id];
    return p && [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group) && !p.isInjured;
  });
}

// ─────────────────────────────────────────────────────────────
// NARRATIVE FLAG HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _resolveSubject(flagSubjectTemplate, instance)
 * Resolves a flagSubject template string to an actual ID.
 * Currently supports '{playerId}' — expands to the instance's target player ID.
 * Returns null if the template doesn't resolve to a known value.
 *
 * @param {String} template  — e.g. '{playerId}' or a literal ID string
 * @param {Object} instance  — card instance
 * @returns {String|null}
 */
function _resolveSubject(template, instance) {
  if (!template) return null;
  if (template === '{playerId}') return instance._targetPlayerId || null;
  // Literal subject ID (already resolved at delivery time)
  return template;
}

// ─────────────────────────────────────────────────────────────
// BUDGET COST HELPERS
// ─────────────────────────────────────────────────────────────

function _resolveBudgetCostK(costToken) {
  const ranges = {
    misc_cost_xs:   CARD_COST_XS,
    misc_cost_sm:   CARD_COST_SM,
    misc_cost_capped: CARD_COST_CAPPED,
    misc_cost_lg:   CARD_COST_LG,
    ext_cost:       CARD_COST_EXT,
    grounds_crew_cost: CARD_COST_SM,
    nri_cost:       CARD_COST_XS,
  };
  const range = ranges[costToken];
  if (!range) return 0;
  return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
}

function _resolveBudgetCost(costTokenOrNumber, state) {
  if (typeof costTokenOrNumber === 'number') return costTokenOrNumber;
  return _resolveBudgetCostK(costTokenOrNumber);
}

function _formatCostToken(range) {
  const amount = range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  return amount >= 1000
    ? `$${(amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1)}M`
    : `$${amount}K`;
}

// ─────────────────────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────────────────────

function _streakClause(streak) {
  if (streak >= 5)  return ` — riding a ${streak}-game win streak`;
  if (streak >= 3)  return ` — off a ${streak}-game win streak`;
  if (streak <= -5) return ` — in the middle of a ${Math.abs(streak)}-game losing skid`;
  if (streak <= -3) return ` — after dropping ${Math.abs(streak)} straight`;
  return '';
}

function _traitNote(trait) {
  const notes = {
    veteran:          ' The veteran has seen this before.',
    youngGun:         ' Young player — this kind of clarity matters early.',
    clubhouseLeader:  ' As a clubhouse leader, the message carries weight.',
    volatile:         ' Worth noting: this player can be unpredictable.',
    consistent:       ' Reliable player — should handle it professionally.',
  };
  return notes[trait] || '';
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _uuid() {
  return crypto.randomUUID();
}
