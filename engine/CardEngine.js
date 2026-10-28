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
  ARCHETYPE_CARD_WEIGHTS,
  TRADE_DEADLINE_OPEN,
  TRADE_DEADLINE_CLOSE,
  GM_RELATIONSHIP_DEFAULT,
  INJURY_MRI_COST_K,
  INJURY_MRI_RESULT_MIN_MS,
  INJURY_MRI_RESULT_MAX_MS,
  INJURY_MORNING_EXAM_HOUR,
  FA_CARD_TTL_DAYS,
  FA_CARDS_PER_ROUND,
} from '../data/constants.js';

import {
  confirmDiagnosis, placeOnILUpdate, dayToDayUpdate, dayToDayAllowed,
  clearInjuryUpdate, ilMinDays,
} from './InjuryEngine.js';
import {
  activateFromIL, placeOnWaivers, sendToFarm, reconcileRoster, applyRosterMutation,
  defaultActiveGroup, nextCalendarDay, computePayroll,
} from './RosterEngine.js';
import { evaluateTrade, queueTrade, recordDeclinedOffer, generateCPUTradeOffer } from './TradeEngine.js';
import {
  getRosterNeeds, rankCallupCandidates, callUp, decisionDeadlineAfter, rosterIsFull, sideOf,
} from './TransactionEngine.js';
import { setFlag, selectCardVariant } from './NarrativeEngine.js';
import { buildTokenMap, applyTokens, hasUnresolvedTokens, formatK, bullpenRecentERA, playerTokenValues, intlTypeOf } from './CardTokens.js';
import * as Offseason from './OffseasonEngine.js';
import * as Development from './DevelopmentEngine.js';
import { CARD_ACTIONS, cardFeasible } from './CardActions.js';
import * as AllStar from './AllStarEngine.js';
import { addToMarket, signingTerms } from './MarketEngine.js';
import { baseballYear, computeAge, isAvailable } from './PlayerFactory.js';
import { planDeliveryTimes, pushTimeFor } from './CardScheduler.js';
import { computeOVR } from './PlayerFactory.js';

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
  // §74 (D2): life happens — bereavement, paternity, family emergencies.
  [PHASE.REGULAR_SEASON]:        ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL', 'BETWEEN_GAMES_POOL', 'PERSONAL_LEAVE_POOL'],
  [PHASE.ALL_STAR_BREAK]:        ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL'],
  [PHASE.TRADE_DEADLINE]:        ['DECISIONS_POOL', 'PREGAME_POOL'],
  [PHASE.WILD_CARD]:             ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.FIRST_ROUND]:           ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.DIVISION_SERIES]:       ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.WORLD_SERIES]:          ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.SEASON_SUMMARY]:        ['DECISIONS_POOL'],
  // §70: the manager's contract is a data-driven card (only when it is up);
  // coaches are kept on. The generic contract pools no longer fire here.
  [PHASE.OFFSEASON]:             ['DECISIONS_POOL'],
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

  // (IL return, injury and open-roster-spot cards run on the roster clock —
  //  syncRosterCards(), called by GameEngine.advanceClock — not per game.)

  // 3. Check inbox capacity
  // Capacity counts cards already scheduled to arrive, not just the inbox.
  const currentInbox = [
    ...(state.inbox || []).filter(c => !c.resolved),
    ...(state.scheduledCards || []),
  ];
  if (currentInbox.length >= MAX_INBOX_SIZE) return;

  // 3b. Real CPU trade proposals (TradeEngine). At most one per check; it
  // occupies one of this check's delivery slots. Replaces the retired v1 pool
  // trade cards (t1–t9), whose actions were never wired to real trades.
  const tradeDelivered = _maybeDeliverCPUTradeOffer(state, context) ? 1 : 0;

  const slotsAvailable = Math.min(
    MAX_CARDS_PER_CHECK,
    MAX_INBOX_SIZE - currentInbox.length
  ) - tradeDelivered;
  if (slotsAvailable <= 0) return;

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
        delivered.push({ ...instance, _pool: poolName });
      }
    }
  }

  if (delivered.length === 0) return;

  // 5. Schedule for real-world delivery between now and the next game (§61).
  // releaseDueCards() moves each into the inbox when its time comes; the same
  // schedule is synced to the push worker so it arrives with the app closed.
  _scheduleCards(delivered, state);
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

  // §74: whether the decision can still happen is judged on the world the GM
  // tapped in — before this card's own cost is charged below. (A card's
  // feasibility already counts its own price; re-judging after the charge
  // would count it twice.)
  const actionId = choice === 'yes' ? instance._raw?.onYes : choice === 'no' ? instance._raw?.onNo : null;
  const actionOk = CARD_ACTIONS[actionId] ? CARD_ACTIONS[actionId].feasible(state, { ...instance, choice }) : null;

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
    // §75: ballpark decisions shape the league's impression (hosting score).
    if (instance._raw?._hosting && s.allStar) AllStar.accrueCard(s, instance._raw._hosting, choice);

    // Apply budget cost / revenue — the exact amounts the card text showed.
    const costK = choice === 'yes' ? _resolveBudgetCost(instance._budgetCost)
                : choice === 'no'  ? _resolveBudgetCost(instance._budgetCostNo)
                : 0;
    if (costK) {
      s.userTeam.finances.operatingSpent = (s.userTeam.finances.operatingSpent || 0) + costK;
    }
    if (choice === 'yes' && instance._revenueK) {
      s.userTeam.finances.revenue = (s.userTeam.finances.revenue || 0) + instance._revenueK;
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

    if (followupType && !HANDLED_CARD_ACTIONS.has(followupType)) {
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
  _applyRosterAction(instance, choice, StateManager.get(), { atMs: Date.now(), feasible: actionOk });
  _maybeChainFollowup(instance, choice, Date.now());
}

/**
 * _maybeChainFollowup(instance, choice, atMs)
 * §74: a card with `_followup: { on, chance, delayMin, delayMax, subtype? }`
 * sets its FOLLOWUP_POOL card in motion when the GM's choice matches — about
 * the same players, a few days later (delays were written in games; the
 * league plays about one a day).
 */
function _maybeChainFollowup(instance, choice, atMs) {
  const f = instance._raw?._followup;
  if (!f || (f.on && f.on !== choice) || Math.random() >= (f.chance ?? 1)) return;
  const options = FOLLOWUP_POOL.filter(e => e?.type === instance.cardId && e.card && !e.card._retired);
  if (!options.length) return;
  const pick = options[Math.floor(Math.random() * options.length)].card;
  const days = (f.delayMin ?? 2) + Math.random() * Math.max(0, (f.delayMax ?? f.delayMin ?? 4) - (f.delayMin ?? 2));
  const preset = Object.fromEntries(Object.entries(instance._tokenPlayers || {}).filter(([, id]) => id));
  _deliverFollowupDef(pick.id, preset, atMs + days * 86_400_000);
}

/**
 * expire(instanceId, atMs = Date.now())
 * Auto-resolves a card with its auto-resolve path and penalty. A roster card
 * (autoResolve 'roster', §65) runs its `_raw.onAuto` roster action at `atMs`
 * — the roster-clock moment of the deadline, which during catch-up is in the
 * past. A card that expires before it was ever released is moved into the
 * inbox first, so the Completed tab shows what happened.
 *
 * @param {String} instanceId
 * @param {Number} [atMs]
 */
export function expire(instanceId, atMs = Date.now()) {
  let state    = StateManager.get();
  let instance = (state.inbox || []).find(c => c.instanceId === instanceId);
  if (!instance) {
    const sched = (state.scheduledCards || []).find(c => c.instanceId === instanceId);
    if (!sched) return;
    StateManager.mutate(s => {
      s.scheduledCards = (s.scheduledCards || []).filter(c => c.instanceId !== instanceId);
      s.inbox = [...(s.inbox || []), { ...sched, arrivedAtMs: Math.min(sched.deliverAtMs, atMs) }];
    });
    state    = StateManager.get();
    instance = state.inbox.find(c => c.instanceId === instanceId);
  }
  if (!instance || instance.resolved) return;

  if (instance.autoResolve === 'roster') {
    StateManager.mutate(s => {
      const card = s.inbox.find(c => c.instanceId === instanceId);
      if (card) {
        card.resolved     = true;
        card.choice       = 'auto';
        card.resolvedAt   = s.currentGameIndex || 0;
        card.resolvedAtMs = atMs;
      }
    });
    _applyRosterAction(instance, 'auto', StateManager.get(), { atMs, auto: true });
    return;
  }

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
  // §74: an unanswered card that resolves to "no" does what "no" does (e.g.
  // a player on personal leave still goes, for the minimum).
  const onNo = instance._raw?.onNo;
  if (autoPath === 'no' && onNo && (CARD_ACTIONS[onNo] || onNo.startsWith('as_'))) {
    _applyRosterAction(instance, 'no', StateManager.get(), { atMs });   // registry and All-Star actions alike
  }
}

// ─────────────────────────────────────────────────────────────
// ROSTER CARDS ON THE ROSTER CLOCK (§65)
// ─────────────────────────────────────────────────────────────
//
// Injury (Act 1 exam choice → Act 2 diagnosis), IL return, open roster spot,
// and roster notices. Every one of them:
//   - is delivered at a real moment (scheduledCards → push), not "next game";
//   - carries `_rosterKey` — the exact roster situation it is about;
//   - is WITHDRAWN (removed, never left as a ghost) by syncRosterCards() the
//     moment that situation no longer exists, however it was resolved
//     (inbox, Team screen, the manager, a trade…);
//   - expires at a real deadline (expiresAtMs) into its `_raw.onAuto` action.

const _hand = (p) => (['SP', 'RP'].includes(p?.pos) ? ` ${PITCHER_HAND_DISPLAY[p.hand] || '(R)'}` : '');
const _clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const _day   = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const _randBetween = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function _rosterCard(state, fields) {
  return {
    instanceId:     _uuid(),
    deliveredAt:    state.currentGameIndex || 0,
    expiresAt:      null,
    expiresAtMs:    null,
    resolved:       false,
    resolvedAt:     null,
    choice:         null,
    type:           'urgent',
    yesEffect:      {},
    noEffect:       {},
    autoResolve:    'roster',
    autoResolveTax: null,
    _playerRelationshipEffect: null,
    _budgetCost:    null,
    _expiredSeason: state.seasonNum,
    ...fields,
  };
}

/** Every card (inbox, resolved or not, and scheduled) with this roster key. */
function _cardsWithKey(state, key) {
  return [...(state.inbox || []), ...(state.scheduledCards || [])].filter(c => c._rosterKey === key);
}

/** Park a roster card for delivery at `atMs` (push-synced like every card). */
function _deliverAt(instance, atMs) {
  const state = StateManager.get();
  if (_cardsWithKey(state, instance._rosterKey).some(c => !c.resolved)) return null;
  StateManager.mutate(s => {
    s.scheduledCards = [...(s.scheduledCards || []), { ...instance, deliverAtMs: atMs }]
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  });
  return instance;
}

/** Remove unresolved cards matching `pred` from the inbox and the schedule. */
function _withdraw(pred) {
  const state = StateManager.get();
  const hit = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])].filter(pred);
  if (!hit.length) return 0;
  const ids = new Set(hit.map(c => c.instanceId));
  StateManager.mutate(s => {
    s.inbox          = (s.inbox || []).filter(c => c.resolved || !ids.has(c.instanceId));
    s.scheduledCards = (s.scheduledCards || []).filter(c => !ids.has(c.instanceId));
  });
  return hit.length;
}

function _managerName(state) {
  return state.userTeam.coachingStaff?.manager?.name || 'The manager';
}

function _needFor(player) {
  if (!player) return { side: 'hitter', pos: null };
  if (['SP', 'RP'].includes(player.pos)) return { side: 'pitcher', pos: player.pos };
  return { side: 'hitter', pos: player.nativePos || player.pos };
}

/**
 * deliverInjuryAct1(playerId, atMs)
 * Act 1 — the trainer's report right after the game: exam tonight or wait?
 * An MRI tonight ($) returns a diagnosis in 1–2 hours, so a roster move made
 * before midnight reports tomorrow. Waiting means the morning exam — free,
 * but the replacement can't report until the day after.
 */
export function deliverInjuryAct1(playerId, atMs = Date.now()) {
  const state  = StateManager.get();
  const player = state.players[playerId];
  if (!player || player.injury?.status !== 'evaluating') return null;
  const label  = (player.injury.label || 'injury').toLowerCase();
  const card = _rosterCard(state, {
    cardId:   'injury_act1',
    tag:      'INJURY',
    sender:   'Head Trainer',
    _rosterKey: `injury:${playerId}:act1`,
    _targetPlayerId: playerId,
    subject:  `${player.name} hurt — evaluation needed`,
    preview:  `${player.name}${_hand(player)} came out of tonight's game with a possible ${label}.`,
    body:     `${player.name}${_hand(player)} (${player.pos}) came out of tonight's game with what looks like a ${label}. He's unavailable until we know more. We can send him for an MRI tonight — results in an hour or two, so any roster move can be made before midnight and the replacement reports tomorrow. Or we wait for the team physician's exam in the morning, which costs nothing, but a call-up made tomorrow won't report until the day after.`,
    yesLabel: `MRI tonight (${'$'}${INJURY_MRI_COST_K}K)`,
    noLabel:  'Wait for the morning exam',
    _budgetCost: INJURY_MRI_COST_K,
    // Answer by midnight (at least an hour) or the doctor waits for morning.
    expiresAtMs: Math.max(nextCalendarDay(atMs), atMs + 60 * 60_000),
    _raw: { onYes: 'injury_mri_now', onNo: 'injury_mri_wait', onAuto: 'injury_mri_wait' },
    _autoLabel: 'No answer — morning exam',
  });
  return _deliverAt(card, atMs);
}

/**
 * deliverInjuryAct2(playerId, atMs)
 * Act 2 — the diagnosis. The exam revises the Act 1 read (better / as feared
 * / worse). Place on the IL and call up the best fit, or — for a short
 * timeline — manage him day-to-day and keep the roster spot. Due before the
 * next roster deadline; if nobody answers, he goes on the IL and the
 * manager makes the call-up.
 */
export function deliverInjuryAct2(playerId, atMs = Date.now()) {
  let state = StateManager.get();
  const p0  = state.players[playerId];
  if (!p0 || p0.injury?.status !== 'evaluating') return null;

  // Lock in the diagnosis now (the Team screen still says "being evaluated").
  const dx = confirmDiagnosis(p0, atMs);
  if (dx.injury) StateManager.mutate(s => Object.assign(s.players[playerId], dx));
  state = StateManager.get();
  const player = state.players[playerId];
  const inj    = player.injury;
  const report = player.injuryReport;
  const v      = player._act2Variance;
  const varianceNote = v === 'better' ? 'Good news — it is less serious than it looked on the field.'
                     : v === 'worse'  ? 'The scans showed more than we hoped. The timeline is longer.'
                     : 'The scans confirm what we saw on the field.';
  const seasonEnding = inj.severity === 'season';
  const ilDays     = Math.max(inj.days, ilMinDays(player));
  const eligibleAt = inj.injuredAt + ilDays * 86_400_000;
  const best       = rankCallupCandidates(state, 'user', _needFor(player))[0] || null;
  const dtd        = dayToDayAllowed(player);
  const deadline   = decisionDeadlineAfter(state, atMs);

  const ilLine = seasonEnding
    ? 'He is out for the rest of the season.'
    : `On the ${ilMinDays(player)}-day IL (backdated to the injury) he's eligible to return ${_day(eligibleAt)}.`;
  const dtdLine = dtd
    ? ` Or we manage it day-to-day: he keeps his roster spot and should be available in about ${inj.days} days, but we play a man short until then.`
    : '';
  const bestLine = best
    ? ` Best fit on the farm: ${best.name}${_hand(best)} (${best.nativePos || best.pos}, OVR ${best.ovr}) — he'd report tomorrow.`
    : ' There is no healthy fit on the farm right now.';
  const dlLine = deadline
    ? ` We need a decision by ${_clock(deadline)} (${_day(deadline)}) or ${_managerName(state)} will make the move himself.`
    : '';

  const card = _rosterCard(state, {
    cardId:   'injury_act2',
    tag:      'INJURY',
    sender:   'Team Physician',
    _rosterKey: `injury:${playerId}:act2`,
    _targetPlayerId:  playerId,
    _callupCandidate: best?.id || null,
    subject:  seasonEnding
      ? `${player.name} — ${(inj.label || 'injury').toLowerCase()}, out for the season`
      : `${player.name} — ${(inj.label || 'injury').toLowerCase()}, about ${inj.days} days`,
    preview:  `${varianceNote} ${seasonEnding ? 'Season-ending.' : `About ${inj.days} days.`}`,
    body:     `${report?.detailedText || ''} ${varianceNote} ${ilLine}${dtdLine}${bestLine}${dlLine}`.replace(/\s+/g, ' ').trim(),
    yesLabel: best ? `Place on IL — call up ${best.name}` : 'Place on IL',
    noLabel:  dtd ? 'Day-to-day — keep his roster spot' : `Place on IL — I'll pick the call-up`,
    expiresAtMs: deadline,
    _raw: {
      onYes:  best ? 'il_placement' : 'il_placement_only',
      onNo:   dtd ? 'day_to_day' : 'il_placement_only',
      onAuto: 'injury_auto',
    },
    _autoLabel: `No decision — placed on IL, ${_managerName(state)} made the call-up`,
  });

  const delivered = _deliverAt(card, atMs);
  if (delivered && (seasonEnding || ilDays > 14)) {
    StateManager.mutate(s => {
      s.history = [...(s.history || []), {
        id:       _uuid(),
        type:     'injury',
        season:   s.seasonNum || 1,
        gameIdx:  s.currentGameIndex || 0,
        headline: seasonEnding ? `${player.name} — season-ending injury` : `${player.name} — ${ilDays}-day IL stint`,
        detail:   `${player.name} (${player.pos}). ${report?.detailedText || ''}`,
        playerId,
        icon:     '🩹',
        userNote: '',
      }];
    });
  }
  return delivered;
}

/** When Act 2 arrives, given when Act 1 was answered and how. */
function _act2Time(state, decidedAtMs, mriNow) {
  if (mriNow) return decidedAtMs + _randBetween(INJURY_MRI_RESULT_MIN_MS, INJURY_MRI_RESULT_MAX_MS);
  const d = new Date(decidedAtMs);
  if (d.getHours() >= INJURY_MORNING_EXAM_HOUR) d.setDate(d.getDate() + 1);
  d.setHours(INJURY_MORNING_EXAM_HOUR, 0, 0, 0);
  let t = d.getTime() + _randBetween(0, 90) * 60_000;
  // Always in hand at least 30 minutes before the roster deadline.
  const dl = decisionDeadlineAfter(state, decidedAtMs);
  if (dl && t > dl - 30 * 60_000) t = Math.max(decidedAtMs + 15 * 60_000, dl - 30 * 60_000);
  return t;
}

/** IL return decision — delivered the moment the player is cleared. */
function _deliverILReturnCard(playerId, atMs) {
  const state  = StateManager.get();
  const player = state.players[playerId];
  if (!player || !(state.ilReturnQueue || []).includes(playerId)) return null;
  const isSpring = state.phase === PHASE.SPRING_TRAINING;
  const full     = rosterIsFull(state, 'user', sideOf(player));   // his side's spots (§76)
  const drop     = full ? _dropCandidate(state, playerId) : null;
  const deadline = decisionDeadlineAfter(state, atMs);
  const ref      = `${player.name}${_hand(player)} (${player.pos})`;

  const card = _rosterCard(state, {
    cardId:   'il_return',
    tag:      'IL_RETURN',
    sender:   'Team Physician',
    _rosterKey: `ilreturn:${playerId}`,
    _targetPlayerId: playerId,
    _dropId:  drop?.id || null,
    subject:  `${player.name} cleared to return`,
    preview:  `${ref} has been cleared — roster decision needed.`,
    body:     `${ref} has completed his recovery and is cleared for game action.`
            + (drop ? ` The active roster is full, so activating him means a corresponding move: ${drop.name} (${drop.nativePos || drop.pos}, OVR ${drop.ovr}) is the player who'd be ${isSpring ? 'optioned to the farm' : 'placed on waivers'}.`
                    : ' There is room on the active roster for him.')
            + (deadline ? ` If we haven't decided by ${_clock(deadline)} (${_day(deadline)}), ${_managerName(state)} will activate him.` : ''),
    yesLabel: drop ? `Activate ${player.name} — ${isSpring ? 'option' : 'waive'} ${drop.name}` : `Activate ${player.name}`,
    noLabel:  isSpring ? `Send ${player.name} to the farm` : `Place ${player.name} on waivers`,
    type:     'urgent',
    expiresAtMs: deadline,
    _raw: { onYes: 'il_return_activate', onNo: isSpring ? 'il_return_farm' : 'il_return_waive', onAuto: 'il_return_activate' },
    _autoLabel: `No decision — ${_managerName(state)} activated him`,
  });
  return _deliverAt(card, atMs);
}

/** The lowest-value droppable active player (never a lineup starter or rotation arm). */
function _dropCandidate(state, exceptId) {
  const t = state.userTeam;
  const returning = state.players[exceptId];
  const samSide = (p) => ['SP', 'RP'].includes(p.pos) === ['SP', 'RP'].includes(returning?.pos);
  const locked = new Set([...(t.lineupSlots || []).map(s => s.playerId).filter(Boolean), ...(t.rotation?.order || [])]);
  const pool = (t.rosterIds || []).map(id => state.players[id]).filter(p =>
    p && p.id !== exceptId && p.group !== PLAYER_GROUP.IL && !p.isInjured && !locked.has(p.id));
  // Same side of the roster first (a returning pitcher replaces a pitcher).
  return pool.sort((a, b) => (samSide(b) - samSide(a)) || ((a.ovr || 0) - (b.ovr || 0)))[0] || null;
}

/** Open roster spot — one card per open spot, tied to the current deadline. */
function _deliverNeedCard(state, need, index, needs, atMs) {
  const deadline = needs.deadlineAt;
  const best     = rankCallupCandidates(state, 'user', need)[0] || null;
  const what     = need.pos ? (need.side === 'pitcher' ? (need.pos === 'SP' ? 'a starting pitcher' : 'a reliever') : `a ${need.pos}`)
                            : (need.side === 'pitcher' ? 'a pitcher' : 'a position player');
  const card = _rosterCard(state, {
    cardId:   'roster_need',
    tag:      'ROSTER',
    sender:   _managerName(state),
    type:     'urgent',
    _rosterKey: `need:${deadline}:${index}`,
    _rosterKind: 'need',
    _callupCandidate: best?.id || null,
    _need:    need,
    subject:  needs.short > 1 ? `${needs.short} open roster spots` : 'Open roster spot',
    preview:  `We're ${needs.short} short of 28 — I need ${what}.`,
    body:     `We're carrying ${28 - needs.short} active players. I need ${what}.`
            + (best ? ` The best fit on the farm is ${best.name}${_hand(best)} (${best.nativePos || best.pos}, OVR ${best.ovr}); he'd report tomorrow.` : ' Nobody on the farm fits — look at the waiver wire or make a trade.')
            + ` You can also pick someone else from the dashed spot on the Team screen.`
            + (deadline ? ` If nothing's done by ${_clock(deadline)} (${_day(deadline)}), I'll call someone up myself.` : ''),
    yesLabel: best ? `Call up ${best.name}` : 'Understood',
    noLabel:  best ? `I'll choose on the Team screen` : null,
    expiresAtMs: deadline,
    _raw: { onYes: best ? 'need_callup' : 'need_defer', onNo: 'need_defer', onAuto: 'need_auto' },
    _autoLabel: `No decision — ${_managerName(state)} made the call-up`,
  });
  return _deliverAt(card, atMs);
}

/** One-button notice (manager's call-up, voided trade). */
function _deliverNotice(key, fields, atMs) {
  const state = StateManager.get();
  if (_cardsWithKey(state, key).length) return null;
  const card = _rosterCard(state, {
    tag: 'ROSTER', type: 'normal', noLabel: null, yesLabel: 'Understood',
    autoResolve: 'skip', expiresAtMs: atMs + 24 * 3600_000,
    _rosterKey: key, _raw: {},
    ...fields,
  });
  return _deliverAt(card, atMs);
}

/**
 * syncRosterCards(events, atMs)
 * Brings the inbox in line with the roster, after every roster-clock step.
 *   - delivers cards for new situations (injuries, clearances, open spots,
 *     the manager's moves, voided trades);
 *   - withdraws every unresolved card whose situation is gone (§65 — no
 *     ghost messages, whichever screen the GM acted on).
 * @returns {{ delivered: Number, withdrawn: Number }}
 */
export function syncRosterCards(events = [], atMs = Date.now()) {
  let delivered = 0;
  for (const ev of events) {
    if (ev.type === 'INJURY' && ev.teamId === 'user') {
      if (deliverInjuryAct1(ev.playerId, (ev.atMs ?? atMs) + _randBetween(5, 20) * 60_000)) delivered++;
    } else if (ev.type === 'MANAGER_FILL') {
      const st = StateManager.get();
      const names = (ev.playerIds || []).map(id => st.players[id]?.name).filter(Boolean);
      if (_deliverNotice(`managerfill:${ev.atMs}`, {
        sender:  _managerName(st),
        subject: names.length ? `I called up ${names.join(' and ')}` : 'We are playing short',
        preview: 'No move was made before the deadline, so I made it.',
        body:    names.length
          ? `Nobody made a move on the open roster spot before the deadline, so I called up ${names.join(' and ')}. ${names.length > 1 ? 'They report' : 'He reports'} tomorrow. Ownership noticed (Owner Trust ${ev.penalty?.ownerTrust ?? -2}, Atmosphere ${ev.penalty?.atmosphere ?? -1}).`
          : `Nobody made a move on the open roster spot before the deadline, and there's no one on the farm who can fill it. We'll play short until something changes. Ownership noticed.`,
      }, ev.atMs)) delivered++;
    } else if (ev.type === 'FARM_SIGNING' && ev.teamId === 'user') {
      const st = StateManager.get();
      const p  = st.players[ev.playerId];
      if (p && _deliverNotice(`farmsign:${ev.playerId}:${ev.atMs}`, {
        sender:  'Farm Director',
        subject: `Signed ${p.name} to a minor-league deal`,
        preview: `${p.name}${_hand(p)} (${p.nativePos || p.pos}, OVR ${p.ovr}) joins the farm system.`,
        body:    `Our farm system was getting thin, so I signed ${p.name}${_hand(p)} (${p.nativePos || p.pos}, OVR ${p.ovr}) to a minor-league deal. He's available as a call-up if we need him.`,
      }, ev.atMs)) delivered++;
    } else if (ev.type === 'WAIVER_CLAIMED' && ev.userClaimed) {
      // §73: how our waiver claim came out.
      const st = StateManager.get();
      const p = st.players[ev.playerId];
      const won = ev.teamId === 'user';
      const winner = won ? null : (st.leagueTeams || []).find(t => t.id === ev.teamId)?.name;
      if (p && _deliverNotice(`claim:${ev.playerId}:${ev.atMs}`, {
        sender: 'Player Dev.', avatar: '📋', type: won ? 'good' : 'normal',
        subject: won ? `Claim awarded: ${p.name}` : `Claim lost: ${p.name}`,
        preview: won ? `${_who(p)} is ours — he reports tomorrow.` : `${winner || 'Another club'} was ahead of us in the claiming order.`,
        body: won ? `Our claim on ${_who(p)} came through. He reports tomorrow.`
                  : `${winner || 'Another club'} had priority in the claiming order (worse record) and claimed ${_who(p)}.`,
      }, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'WAIVER_CLEARED' && ev.userClaimed) {
      // (cannot happen: a user claim always makes the user a claimant)
    } else if (ev.type === 'DEV_DONE' && ev.teamId === 'user') {
      if (_deliverDevelopmentReport(ev, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'TRADE_VOIDED') {
      const st = StateManager.get();
      const team = (st.leagueTeams || []).find(t => t.id === ev.tx?.fromTeamId);
      if (_deliverNotice(`tradevoid:${ev.tx?.id}`, {
        sender:  team?.name || 'League Office',
        subject: 'Trade called off',
        preview: `The deal with ${team?.name || 'the other club'} did not go through.`,
        body:    `The trade with ${team?.name || 'the other club'} was voided before it could be finalized: ${ev.reason}. Nobody changes teams.`,
      }, ev.tx?.effectiveAt ?? atMs)) delivered++;
    }
  }

  let state = StateManager.get();

  // IL clearances → decision cards (at the moment of clearance).
  for (const id of state.ilReturnQueue || []) {
    const at = state.players[id]?.injury?.eligibleAt;
    if (_deliverILReturnCard(id, Number.isFinite(at) ? Math.min(at, atMs) : atMs)) delivered++;
  }

  // Open roster spots → one card per spot, keyed to the current deadline.
  state = StateManager.get();
  const needs = getRosterNeeds(state, 'user');
  const liveNeedKeys = new Set();
  if (needs.applies && needs.short > 0 && needs.deadlineAt) {
    needs.needs.forEach((need, i) => {
      const key = `need:${needs.deadlineAt}:${i}`;
      liveNeedKeys.add(key);
      if (!_cardsWithKey(state, key).length && _deliverNeedCard(state, need, i, needs, atMs)) delivered++;
      state = StateManager.get();
    });
  }

  // Withdraw cards whose situation no longer exists.
  state = StateManager.get();
  const players = state.players;
  const queue   = new Set(state.ilReturnQueue || []);
  const withdrawn = _withdraw(c => {
    const key = c._rosterKey || '';
    if (key.startsWith('injury:')) {
      const p = players[c._targetPlayerId];
      return !p || !(state.userTeam.rosterIds || []).includes(p.id) || p.injury?.status !== 'evaluating';
    }
    if (key.startsWith('ilreturn:')) return !queue.has(c._targetPlayerId);
    if (c._rosterKind === 'need')    return !liveNeedKeys.has(key);
    // §70: a free agent who signed elsewhere (or left); a re-sign card for a
    // player no longer ours (retired, traded).
    if (key.startsWith('os:fa:'))     return players[c._targetPlayerId]?.group !== PLAYER_GROUP.FREE_AGENT;
    if (key.startsWith('os:resign:')) return players[c._targetPlayerId]?.teamId !== 'user';
    // §71: a card about one of our players that can no longer apply (he left,
    // got hurt, or is already away) is withdrawn rather than left as a ghost.
    if ((!key || key.startsWith('followup:') || key.startsWith('indie:')) && CARD_ACTIONS[c._raw?.onYes]) return !cardFeasible(state, c);
    if (c._tradeOffer)               return !_tradeStillValid(state, c);
    return false;
  });

  return { delivered, withdrawn };
}

function _tradeStillValid(state, card) {
  const o    = card._tradeOffer || {};
  const team = (state.leagueTeams || []).find(t => t.id === card._proposingTeamId);
  const ok   = (id, list) => list.includes(id) && !state.players[id]?.isInjured;
  return !!team
    && (o.outgoingIds || []).every(id => ok(id, state.userTeam.rosterIds || []))
    && (o.incomingIds || []).every(id => ok(id, team.rosterIds || []));
}

/**
 * expireDueRosterCards(atMs)
 * Expires every unresolved roster card (inbox or not yet released) whose
 * deadline is at or before `atMs`, oldest deadline first, each at its own
 * deadline moment.
 * @returns {Number} count expired
 */
export function expireDueRosterCards(atMs) {
  const state = StateManager.get();
  const due = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])]
    // Roster cards, and pre-game cards (§74 — their question is moot at first pitch).
    .filter(c => (c.autoResolve === 'roster' || c._pool === 'PREGAME_POOL') && Number.isFinite(c.expiresAtMs) && c.expiresAtMs <= atMs)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  for (const c of due) expire(c.instanceId, c.expiresAtMs);
  return due.length;
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
export function deliverTradeOffer(offer, evaluation, proposingTeamId, { seed = false, intro = null } = {}) {
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
    body:            `${intro ? intro(incoming, teamName) + ' ' : ''}${teamName} has proposed a trade: you send ${outRef} and receive ${inRef}. ${fairnessNote}${payrollNote}`,
    yesLabel:        'Accept the Trade',
    noLabel:         'Decline',
    yesEffect:       {},
    noEffect:        {},
    autoResolve:     'no',
    autoResolveTax:  null,
    _playerRelationshipEffect: null,
    _budgetCost:     null,
    _tradeOffer:     offer,
    // A frozen summary of the offer as proposed — never live player objects
    // (those keep changing; the card must describe the deal it offered).
    _tradeEval:      _evalSnapshot(evaluation),
    _proposingTeamId: proposingTeamId,
    _expiredSeason:  state.seasonNum,
    _raw:            { onYes: 'trade_execute', onNo: 'trade_decline' },
    ...(seed ? { _seed: true } : {}),
  };

  if (seed) {
    // New-franchise seed: visible immediately, never pushed.
    StateManager.mutate(s => {
      s.inbox = [...(s.inbox || []), instance];
      _sortInbox(s.inbox);
    });
  } else {
    _scheduleCards([instance], state);
  }
}

function _evalSnapshot(ev) {
  const slim = (p) => ({ id: p.id, name: p.name, pos: p.pos, ovr: p.ovr, hand: p.hand || null,
                         teamId: p.teamId, _previouslyWithOrg: !!p._previouslyWithOrg });
  return {
    fairnessRating:  ev.fairnessRating,
    fairnessLabel:   ev.fairnessLabel,
    payrollDelta:    ev.payrollDelta,
    overCap:         !!ev.overCap,
    incomingPlayers: (ev.incomingPlayers || []).map(slim),
    outgoingPlayers: (ev.outgoingPlayers || []).map(slim),
  };
}

// ─────────────────────────────────────────────────────────────
// TIMED DELIVERY (§61)
// ─────────────────────────────────────────────────────────────

/**
 * _nextGameTime(state, nowMs)
 * First pitch of the next game that has not been played yet, or null.
 */
function _nextGameTime(state, nowMs) {
  const sched = state.schedule || [];
  for (let i = state.currentGameIndex || 0; i < sched.length; i++) {
    const g = sched[i];
    if (!g || g._committed) continue;
    if (Number.isFinite(g.gameTime) && g.gameTime > nowMs) return g.gameTime;
  }
  return null;
}

/**
 * _scheduleCards(instances, state)
 * Gives each card its own random delivery time (waking hours, before the next
 * first pitch) and parks it in state.scheduledCards.
 */
function _scheduleCards(instances, state) {
  if (!instances?.length) return;
  const nowMs = Date.now();
  // §74 (D3): pre-game cards arrive in the hours before first pitch; in-game
  // cards while the game is being played. Everything else between games.
  const next = _nextGameTime(state, nowMs);
  const lead = 10 * 60_000;
  const timed = [], loose = [];
  for (const c of instances) {
    if (Number.isFinite(next) && c._pool === 'PREGAME_POOL') {
      timed.push({ ...c, deliverAtMs: Math.max(nowMs + lead, next - (45 + Math.random() * 105) * 60_000), expiresAtMs: next });
    } else if (Number.isFinite(next) && c._pool === 'INGAME_POOL') {
      timed.push({ ...c, deliverAtMs: Math.max(nowMs + lead, next + (20 + Math.random() * 100) * 60_000) });
    } else loose.push(c);
  }
  if (timed.length) {
    StateManager.mutate(s => {
      s.scheduledCards = [...(s.scheduledCards || []), ...timed].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    });
  }
  instances = loose;
  if (!instances.length) return;
  const times = planDeliveryTimes(instances.length, {
    nowMs,
    windowEndMs: _nextGameTime(state, nowMs),
    quietStart:  state.push?.quietStart,
    quietEnd:    state.push?.quietEnd,
  });
  // planDeliveryTimes returns ascending times; shuffle the pairing so card
  // order in the pool doesn't dictate arrival order.
  const order = instances.map(c => ({ c, r: Math.random() })).sort((a, b) => a.r - b.r);
  const scheduled = order.map(({ c }, i) => ({ ...c, deliverAtMs: times[i] }));
  StateManager.mutate(s => {
    s.scheduledCards = [...(s.scheduledCards || []), ...scheduled]
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  });
}

/**
 * releaseDueCards(nowMs = Date.now())
 * Moves every scheduled card whose time has come into the inbox.
 * Called on every app tick (and by the harness after every tick).
 * @returns {Object[]} the cards released (empty array if none)
 */
export function releaseDueCards(nowMs = Date.now()) {
  const state = StateManager.get();
  const due = (state?.scheduledCards || []).filter(c => c.deliverAtMs <= nowMs);
  if (!due.length) return [];
  const ids = new Set(due.map(c => c.instanceId));
  StateManager.mutate(s => {
    s.scheduledCards = (s.scheduledCards || []).filter(c => !ids.has(c.instanceId));
    s.inbox = [...(s.inbox || []), ...due.map(c => ({ ...c, arrivedAtMs: c.deliverAtMs }))];
    _sortInbox(s.inbox);
  });
  return due;
}

/**
 * getPushSchedule(state, nowMs = Date.now())
 * The scheduled cards, shaped for the push worker's /register endpoint.
 * Seed cards are never included.
 */
export function getPushSchedule(state, nowMs = Date.now()) {
  const qs = state?.push?.quietStart, qe = state?.push?.quietEnd;
  return (state?.scheduledCards || [])
    .filter(c => !c._seed)
    // Pool cards are already planned outside quiet hours; real-time roster
    // cards reach the inbox when they happen and only the alert waits (§65).
    .map(c => ({ c, at: pushTimeFor(c.deliverAtMs, qs, qe) }))
    // An alert that would sound after the card's deadline is pointless.
    .filter(({ c, at }) => at > nowMs - 60 * 1000 && !(Number.isFinite(c.expiresAtMs) && at >= c.expiresAtMs))
    .map(({ c, at }) => ({
      id:        c.instanceId,
      deliverAt: at,
      title:     c.sender  || 'The Front Office',
      body:      c.subject || 'New message in your inbox',
      tag:       c.instanceId,
    }));
}

// ─────────────────────────────────────────────────────────────
// COMPOSE CARD DELIVERY (Phase 15 — Section 8.12)
// ─────────────────────────────────────────────────────────────

/**
 * _tradeWindowOpen(state, context)
 * Trades are allowed in spring, and in the regular season up to the deadline.
 */
function _tradeWindowOpen(state, context) {
  const phase = state.phase;
  if (phase === PHASE.SPRING_TRAINING) return true;
  if (phase !== PHASE.REGULAR_SEASON && phase !== PHASE.TRADE_DEADLINE) return false;
  return (context.regularSeasonIndex || 0) <= TRADE_DEADLINE_CLOSE;
}

/**
 * _maybeDeliverCPUTradeOffer(state, context, { force, seed })
 * Asks CPU teams (in random order) whether they want to propose a trade; the
 * first real offer is delivered. Teams with an unresolved offer already in the
 * inbox are skipped. TradeEngine owns the probability roll and offer quality;
 * `force` skips only the roll (seed offer).
 * @returns {Boolean} true if an offer was delivered
 */
function _maybeDeliverCPUTradeOffer(state, context, { force = false, seed = false, intro = null } = {}) {
  if (!force && !_tradeWindowOpen(state, context)) return false;

  const pendingFrom = new Set(
    [...(state.inbox || []), ...(state.scheduledCards || [])]
      .filter(c => !c.resolved && c._proposingTeamId)
      .map(c => c._proposingTeamId));

  const teams = (state.leagueTeams || [])
    .filter(t => !pendingFrom.has(t.id))
    .map(t => ({ t, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map(x => x.t);

  for (const team of teams) {
    const result = generateCPUTradeOffer(team.id, state, {
      regularSeasonIndex: context.regularSeasonIndex || 0,
      phase: state.phase,
      force,
    });
    if (result) {
      deliverTradeOffer(result.offer, result.evaluation, team.id, { seed, intro });
      return true;
    }
  }
  return false;
}

/**
 * deliverSeedTradeOffer(context)
 * New-franchise seed: one real, engine-generated trade proposal (no push).
 * @returns {Boolean}
 */
export function deliverSeedTradeOffer(context) {
  return _maybeDeliverCPUTradeOffer(StateManager.get(), context || {}, { force: true, seed: true });
}

/**
 * deliverSeedCards(cardIds, context)
 * Delivers the new-franchise welcome set to the inbox.
 *
 * Unlike deliverCardById (a debug injector that builds a partial instance with
 * an empty token context), seeds go through the SAME _createInstance path as
 * normal delivery: real token context, real expiry (game-index TTL), resolved
 * budget cost, the canonical `resolved` flag. Eligibility gates are bypassed on
 * purpose — the seed set is a hand-picked opening slate, not a pool draw.
 *
 * Seeds are flagged `_seed: true` and never scheduled for a push notification:
 * the GM is looking at the app when they create the team.
 *
 * @param {String[]} cardIds
 * @param {Object}   context — from GameEngine.buildCardContext()
 * @returns {Number} count delivered
 */
export function deliverSeedCards(cardIds, context) {
  const state = StateManager.get();
  const instances = [];

  for (const cardId of cardIds || []) {
    let cardDef = null;
    for (const pool of Object.values(ALL_POOLS)) {
      const found = pool.find(entry => (entry?.card || entry)?.id === cardId);
      if (found) { cardDef = found.card || found; break; }
    }
    if (!cardDef) {
      console.warn(`[CardEngine.deliverSeedCards] Card '${cardId}' not found in any pool.`);
      continue;
    }
    const instance = _createInstance(cardDef, context || {}, state);
    if (instance) instances.push({ ...instance, _seed: true });
  }

  if (instances.length === 0) return 0;

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), ...instances];
    _sortInbox(s.inbox);
  });
  return instances.length;
}

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

  // Same instance builder as normal delivery (real tokens, expiry, costs),
  // just bypassing eligibility gates. Tagged so it is identifiable as injected.
  const state    = StateManager.get();
  const instance = _createInstance(cardDef, {}, state);
  if (!instance) return;

  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), { ...instance, _debugInjected: true }];
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
  const { values } = buildTokenMap(cardDef, context, state);
  const body       = applyTokens(chosenBody,           values);
  const subject    = applyTokens(cardDef.subject || '', values);

  const instance = {
    instanceId:   _uuid(),
    cardId:       cardDef.id,
    type:         cardDef.type   || 'normal',
    tag:          cardDef.tag    || 'OPERATIONS',
    sender:       applyTokens(cardDef.sender  || 'Staff', values),
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
    .filter(c => c.resolved && !c._cleared)
    .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
    .slice(0, limit);
}

/**
 * clearHistory(instanceIds | 'all')
 * Removes completed cards from the Completed tab (§63). Cleared cards stay in
 * state for the rest of the season — once-per-season dedup reads them — and
 * cleared cards from earlier seasons are dropped entirely to keep saves small.
 * @returns {String[]} the instanceIds cleared (for undo)
 */
export function clearHistory(instanceIds) {
  const state  = StateManager.get();
  const season = state.seasonNum || 1;
  const all    = instanceIds === 'all';
  const ids    = new Set(all ? [] : (instanceIds || []));
  const cleared = (state.inbox || [])
    .filter(c => c.resolved && !c._cleared && (all || ids.has(c.instanceId)))
    .map(c => c.instanceId);
  if (!cleared.length) return [];
  const clearedSet = new Set(cleared);
  StateManager.mutate(s => {
    s.inbox = (s.inbox || [])
      .map(c => (clearedSet.has(c.instanceId) ? { ...c, _cleared: true } : c))
      .filter(c => !(c._cleared && (c._expiredSeason ?? season) < season));
  });
  return cleared;
}

/** Undo for clearHistory — puts the given cards back on the Completed tab. */
export function restoreHistory(instanceIds) {
  const ids = new Set(instanceIds || []);
  if (!ids.size) return;
  StateManager.mutate(s => {
    s.inbox = (s.inbox || []).map(c => (ids.has(c.instanceId) ? { ...c, _cleared: false } : c));
  });
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
 * Single-string convenience wrapper over CardTokens. Builds a fresh token map,
 * so it must NOT be used field-by-field for one card — build one map with
 * buildTokenMap() and applyTokens() each field (see _createInstance).
 *
 * @param {String} text
 * @param {Object} context
 * @param {Object} state
 * @returns {String} resolved text
 */
export function resolveTokens(text, context, state) {
  if (!text) return '';
  return applyTokens(text, buildTokenMap(null, context || {}, state).values);
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
    [...(state.inbox || []), ...(state.scheduledCards || [])]
      .filter(c => !c._expiredSeason || c._expiredSeason === state.seasonNum)
      .map(c => c.cardId)
  );

  return pool.filter(card => {
    // Retired content (kept in the pool for reference, never delivered)
    if (card._retired) return false;

    // Never promise a roster action the engine cannot perform
    if (!_cardActionsHandled(card)) return false;

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
    // §73: follow-up cards are only ever delivered about the player they follow.
    if (card._intlFollowupOnly) return false;
    // §74: with the scouting budget cut (or the staff on a media tour) the leads dry up.
    if (card.tag === 'SCOUTING' && (state.userTeam?.scoutingQuietUntil || 0) > Date.now()) return false;
    // §73: "the bullpen ERA is catastrophic" only when it is.
    if (card._requiresBullpenERA && bullpenRecentERA(state) < card._requiresBullpenERA) return false;
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

  // ONE token map for every field of this card (§60): same player, same
  // sponsor, same dollar amounts in subject, body, labels and outcome messages.
  const { values, amountsK, players: tokenPlayers, counts, newPlayers, offer, missingPlayer } = buildTokenMap(cardDef, context, state);
  if (missingPlayer && !context?._preset) return null;   // §73: no real player to offer — nothing to send
  // Preset players (§73): a follow-up card about a player already named.
  if (context?._preset) {
    for (const [role, id] of Object.entries(context._preset)) {
      if (role.startsWith('_')) continue;
      const pl = state.players[id];
      if (!pl) continue;
      Object.assign(values, playerTokenValues(state, role, pl));
      if (['active_sp', 'active_bp', 'active_pitcher', 'farm_pitcher'].includes(role)) values[`${role}_name`] = `${pl.name}${_hand(pl)}`;
      values[`${role}_name_tr`] = values[`${role}_name`];
      values[`${role}_pos_tr`]  = values[`${role}_pos`];
      tokenPlayers[role] = id;
      if (pl._intlCountry) values.intl_country = pl._intlCountry;
      if (role === 'intl_player') values.intl_player_type = intlTypeOf(pl);
      const terms = signingTerms(state, pl);
      amountsK.sign_cost = terms.bonus || terms.salary; values.sign_cost = formatK(amountsK.sign_cost);
    }
  }
  const t = (text) => applyTokens(text || '', values);
  const target = _cardTarget(cardDef, tokenPlayers);

  // Select variant body first (Section 34 — LOCKED), then resolve tokens in it.
  // selectCardVariant() returns the default body if no variant condition matches.
  const text = {
    subject:  t(cardDef.subject),
    preview:  t(cardDef.preview),
    body:     t(selectCardVariant(cardDef, state)),
    sender:   t(cardDef.sender),
    yesLabel: t(cardDef.yesLabel || 'Yes'),
    noLabel:  t(cardDef.noLabel  || 'No'),
    yesMsg:   t(cardDef.yesMsg),
    noMsg:    t(cardDef.noMsg),
    expireMsg: t(cardDef._expireMsg),
  };

  // Delivery guard: a card that would show a raw {token} is never delivered.
  const unresolved = Object.entries(text).filter(([, v]) => hasUnresolvedTokens(v));
  if (unresolved.length) {
    console.warn(`[CardEngine] '${cardDef.id}' not delivered — unresolved tokens in`,
                 unresolved.map(([k, v]) => `${k}: ${v.match(/\{[a-z0-9_]+\}/gi).join(' ')}`).join('; '));
    return null;
  }

  // Money — the SAME draw the text shows. _budgetCost may be a token (charged on
  // yes), a { yes, no } object, or a number; _rawBudgetCostNo is a flat no-cost.
  const costOf = (tok) => (typeof tok === 'number' ? tok : (amountsK[tok] ?? 0));
  const bc = cardDef._budgetCost;
  const budgetCostK   = bc == null ? null
                      : (typeof bc === 'object' ? (bc.yes != null ? costOf(bc.yes) : null) : costOf(bc));
  const budgetCostNoK = (bc && typeof bc === 'object' && bc.no != null) ? costOf(bc.no)
                      : (typeof cardDef._rawBudgetCostNo === 'number' ? cardDef._rawBudgetCostNo : null);
  const revenueK      = cardDef._revenueToken ? (amountsK[cardDef._revenueToken] ?? null) : null;

  const instance = {
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
    sender:           text.sender,
    avatar:           cardDef.avatar     || '📋',
    subject:          text.subject,
    preview:          text.preview,
    body:             text.body,
    yesLabel:         text.yesLabel,
    noLabel:          text.noLabel,
    yesMsg:           text.yesMsg || null,
    noMsg:            text.noMsg  || null,
    expireMsg:        text.expireMsg || null,
    yesEffect:        cardDef.yesEffect  || {},
    noEffect:         cardDef.noEffect   || {},
    autoResolve:      cardDef.autoResolve   || null,
    autoResolveTax:   cardDef.autoResolveTax || null,
    _playerRelationshipEffect: cardDef._playerRelationshipEffect || null,
    _budgetCost:      budgetCostK,
    _budgetCostNo:    budgetCostNoK,
    _revenueK:        revenueK,
    _expiredSeason:   state.seasonNum,
    _targetPlayerId:  target.playerId,
    _targetRole:      target.role,
    // §71: the number of games the card's text promises (e.g. a suspension).
    _actionGames:     cardDef._gamesToken ? (counts?.[cardDef._gamesToken] ?? null) : null,
    _tokenPlayers:    tokenPlayers || {},
    _offer:           offer || null,
    _amountsK:        amountsK,
    _intlCountry:     values.intl_country || null,
    _raw:             cardDef,
  };
  // §71–73: a card whose action can't happen (nobody to cover, wrong player,
  // no room, no real player to offer) is never delivered — before any new
  // player it would introduce is put into the world.
  const probe = StateManager.get();
  const world = (newPlayers || []).length
    ? { ...probe, players: { ...probe.players, ...Object.fromEntries(newPlayers.map(p => [p.id, p])) },
        freeAgentPool: [...(probe.freeAgentPool || []), ...newPlayers.map(p => p.id)] }
    : probe;
  if (!cardFeasible(world, instance)) return null;
  if ((newPlayers || []).length) StateManager.mutate(s => { for (const p of newPlayers) addToMarket(s, p, Date.now()); });
  return instance;
}

/**
 * _cardTarget(cardDef, tokenPlayers)
 * The player a pool card is about (§71): the first player-role token its text
 * names. Its action, its OVR effect and its withdrawal all follow that man.
 */
const _ROLE_TOKEN = /\{(active_sp|active_bp|active_pitcher|active_hitter|active_catcher|farm_pitcher|farm_hitter|leader_player|act_hi|pl_player|active_farm)_(?:name|pos)?(?:_tr)?\}|\{(act_hi)\}/;
function _cardTarget(cardDef, tokenPlayers = {}) {
  const text = [cardDef.subject, cardDef.preview, cardDef.body].filter(Boolean).join(' ');
  const m = text.match(_ROLE_TOKEN);
  if (!m) return { role: null, playerId: null };
  let role = m[1] || m[2];
  if (role === 'act_hi') role = 'active_hitter';
  const id = role === 'active_farm' ? (tokenPlayers.farm_hitter || tokenPlayers.farm_pitcher) : tokenPlayers[role];
  return { role, playerId: id || null };
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

  // OVR effect (§71) — on the player the card is about (else one of ours):
  // a gain is a development plan that lands over time; a loss is a temporary
  // dip in condition (playing hurt / out of sorts) for a few games.
  if (effects.ovr !== undefined && effects.ovr !== 0) {
    const rosterIds = state.userTeam.rosterIds || [];
    const targetId = (instance?._targetPlayerId && rosterIds.includes(instance._targetPlayerId))
      ? instance._targetPlayerId
      : rosterIds[Math.floor(Math.random() * rosterIds.length)];
    if (targetId) {
      const atMs = Date.now();
      if (effects.ovr > 0) Development.startPlan(state, targetId, { gain: effects.ovr, source: instance?.cardId || 'card' }, atMs);
      else Development.setCondition(state, targetId, { amount: Math.abs(effects.ovr) * 2, games: 2 + Math.floor(Math.random() * 4), reason: instance?.cardId || 'card' });
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

// ─────────────────────────────────────────────────────────────
// ALL-STAR GAME CARDS (§75)
// ─────────────────────────────────────────────────────────────

const _cityOf = (state, teamId) => (teamId === 'user'
  ? (state.userTeam.city || state.userTeam.name)
  : (state.leagueTeams.find(t => t.id === teamId)?.name || '').split(' ').slice(0, -1).join(' ') || 'their ballpark');
const _list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * deliverAllStarHostCard({ hostId, status }, atMs)
 * The league names the host. Ours: the Commissioner's Office, with what it
 * brings (§17.3). Someone else's: the League Office's note — and, in words
 * rather than a number (§17.1), where our ballpark stood.
 */
export function deliverAllStarHostCard({ hostId, status }, atMs) {
  const state = StateManager.get();
  const season = state.allStar?.season;
  const key = `allstar:host:${state.seasonNum}`;
  if (hostId === 'user') {
    const n = state.allStar.hostedCount || 1;
    return _deliverNotice(key, {
      cardId: 'as_host', tag: 'OWNERSHIP', type: 'good', avatar: '🌟', _prominent: true,
      sender: "Commissioner's Office",
      subject: n === 1 ? "We're hosting the All-Star Game" : `The All-Star Game is coming back to ${_cityOf(state, 'user')}`,
      preview: `The league has awarded this year's All-Star Game to ${_cityOf(state, 'user')}.`,
      body: `The Commissioner's Office has awarded this season's All-Star Game to ${_cityOf(state, 'user')}. `
          + (n === 1 ? 'The league has watched what this organization has built in the ballpark and in the stands, and it wants the game here. '
                     : 'It is a rare thing for a club to host twice; the league says the ballpark and the crowds made the decision easy. ')
          + `The host's share — ${formatK(season?.hostBonusK || 0)} — is already in our revenue, the city is buzzing, and ownership has never been happier. `
          + `Every club's GM will be in our building during the break. All-Star week is ours to run.`,
      yesLabel: "Let's get to work", expiresAtMs: atMs + 3 * 24 * 3600_000,
    }, atMs);
  }
  const city = _cityOf(state, hostId);
  const why = [];
  if (status?.reasons?.includes('recently')) why.push('the league rarely returns to a city so soon after a game');
  if (status?.reasons?.includes('prestige')) why.push('the league wants a host with a winning reputation — that has to be earned on the field');
  if (status?.reasons?.includes('atmosphere')) why.push('the league office cited the crowds — our atmosphere is not where a host\'s needs to be');
  if (status?.reasons?.includes('ballpark')) {
    const p = status.progress;
    why.push(p >= 0.85 ? 'our ballpark was a finalist — the facilities are nearly where the league wants them'
           : p >= 0.5  ? 'our ballpark was in the conversation, but the facilities still lag the league\'s best'
           :             'our ballpark is not on the league\'s list yet — facilities and fan experience are what move it');
  }
  return _deliverNotice(key, {
    cardId: 'as_host_other', tag: 'OWNERSHIP', type: 'normal', avatar: '🏟️', sender: 'League Office',
    subject: `All-Star Game awarded to ${city}`,
    preview: `This year's All-Star Game will be played in ${city}.`,
    body: `The league has awarded this season's All-Star Game to ${city}. `
        + (why.length ? `From the league office: ${why.join('; ')}.` : ''),
    expiresAtMs: atMs + 2 * 24 * 3600_000,
  }, atMs);
}

/**
 * deliverAllStarLobbyCard(playerId, atMs, expiresAtMs)
 * The host's GM has the league's ear before the rosters are set: make the
 * public case for one of ours who is on the bubble, or stay out of it.
 */
export function deliverAllStarLobbyCard(playerId, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  return _deliverAt(_rosterCard(state, {
    cardId: 'as_lobby', tag: 'MEDIA', type: 'normal', avatar: '🎙️', sender: 'Media Relations',
    _rosterKey: `allstar:lobby:${state.seasonNum}`, _targetPlayerId: playerId,
    subject: `${p.name} is on the All-Star bubble`,
    preview: `Rosters are set in a few days. As the host, we have a platform — use it?`,
    body: `${_who(p)} is right on the edge of making the All-Star team. Rosters are announced in a few days, and as the host club the league and the press are listening to us this week. `
        + `We can make his case publicly — it might be the push he needs, and he'll know we went to bat for him — or stay out of it and let the vote speak.`,
    yesLabel: 'Make his case', noLabel: 'Stay out of it',
    yesEffect: { morale: 1 }, noEffect: {},
    autoResolve: 'no', expiresAtMs,
    _raw: { onYes: 'as_lobby_yes', onNo: 'as_lobby_no', onAuto: 'as_lobby_no' },
  }), atMs);
}

/** The manager names our All-Stars (one card for the club). */
export function deliverAllStarSelectionCard(selections, atMs) {
  const state = StateManager.get();
  if (!selections.length) return null;
  const desc = (x) => {
    const p = state.players[x.id];
    return `${p?.name} (${x.role === 'starter' ? `starting at ${x.slot === 'OF' ? 'outfield' : x.slot}` : x.role === 'pitcher' ? p?.pos : 'reserve'})`;
  };
  const host = state.allStar?.season?.hostId;
  return _deliverNotice(`allstar:selected:${state.seasonNum}`, {
    cardId: 'as_selected', tag: 'ROSTER', type: 'good', avatar: '⭐', sender: _managerName(state),
    subject: selections.length === 1 ? `${state.players[selections[0].id]?.name} is an All-Star`
                                     : `${selections.length} of ours are All-Stars`,
    preview: `The All-Star rosters are out.`,
    body: `The All-Star rosters are out, and we're sending ${_list(selections.map(desc))}. `
        + `${selections.length > 1 ? 'They earned it' : 'He earned it'} — the clubhouse is proud. `
        + `The game is the second night of the break${host === 'user' ? ', in our ballpark' : host ? ` in ${_cityOf(state, host)}` : ''}.`,
    expiresAtMs: atMs + 2 * 24 * 3600_000,
  }, atMs);
}

/** All-Star week in our ballpark — three decisions while the league is in town. */
export function scheduleAllStarWeekCards(dayStartMs, firstPitchMs) {
  const state = StateManager.get();
  const K = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) / 5) * 5;
  const sponsorK = K(500, 900), clinicK = K(120, 220);
  const cards = [
    { h: 9, key: 'sponsor', fields: {
      cardId: 'as_week_sponsor', tag: 'MARKETING', avatar: '💼', sender: 'Corporate Partnerships',
      subject: 'All-Star FanFest — title sponsor on the table',
      preview: `A regional bank wants its name on FanFest. ${formatK(sponsorK)}.`,
      body: `A regional bank wants to be the title sponsor of All-Star FanFest: ${formatK(sponsorK)}, with their branding across the concourse and the plaza all week. `
          + 'The money is real. Fans and the league will notice the ballpark looking like a bank lobby.',
      yesLabel: 'Sign the sponsor', noLabel: 'Keep FanFest ours',
      yesEffect: { atmosphere: -3 }, noEffect: { atmosphere: 2 }, _revenueK: sponsorK } },
    { h: 11, key: 'clinic', fields: {
      cardId: 'as_week_clinic', tag: 'MARKETING', avatar: '🧢', sender: 'Community Relations',
      subject: 'All-Stars want to run a youth clinic',
      preview: `A clinic with the All-Stars for local kids — ${formatK(clinicK)} to put on.`,
      body: `Several All-Stars have offered to run a clinic for local youth leagues on the field before the game. Putting it on costs ${formatK(clinicK)} (staff, gear, buses). `
          + 'It is the kind of morning the city remembers.',
      yesLabel: 'Put it on', noLabel: 'Not this year',
      yesEffect: { atmosphere: 4, ownerTrust: 1 }, noEffect: { atmosphere: -1 }, _budgetCost: clinicK } },
    { h: 15, key: 'media', fields: {
      cardId: 'as_week_media', tag: 'MEDIA', avatar: '📺', sender: 'Media Relations',
      subject: 'National media want the run of our clubhouse',
      preview: 'Open access all week — great exposure, and a distraction.',
      body: 'The national networks want open access to our clubhouse and players for All-Star week features. '
          + 'It would put the franchise in front of the whole country — and put cameras in our players\' faces for four days.',
      yesLabel: 'Open the doors', noLabel: 'Keep it to the usual',
      yesEffect: { atmosphere: 3, morale: -3 }, noEffect: { morale: 1, atmosphere: -1 } } },
  ];
  let n = 0;
  for (const c of cards) {
    const at = dayStartMs + c.h * 3600_000;
    if (_deliverAt(_rosterCard(state, {
      type: 'normal', autoResolve: 'no', expiresAtMs: firstPitchMs,
      _rosterKey: `allstar:week:${c.key}:${state.seasonNum}`, _raw: {},
      ...c.fields,
    }), at)) n++;
  }
  return n;
}

/** The game's MVP is one of ours. */
export function deliverAllStarMvpCard(playerId, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  const r = state.allStar?.season?.result;
  return _deliverNotice(`allstar:mvp:${state.seasonNum}`, {
    cardId: 'as_mvp', tag: 'ROSTER', type: 'good', avatar: '🏆', sender: _managerName(state),
    subject: `${p.name} is the All-Star Game MVP`,
    preview: `${p.name} took home the MVP trophy.`,
    body: `${_who(p)} was named MVP of the All-Star Game${r ? ` (${r.homeScore}–${r.awayScore} final)` : ''}. The guys gave him a standing ovation when he walked in.`,
    expiresAtMs: atMs + 2 * 24 * 3600_000,
  }, atMs);
}

/** A player who spent All-Star week in our ballpark wants in (§17.3). */
export function deliverAllStarTradeOffer(context) {
  return _maybeDeliverCPUTradeOffer(StateManager.get(), context || {}, {
    force: true,
    intro: (incoming) => `${incoming.name} spent All-Star week in our ballpark and has let his club know he would welcome a move here.`,
  });
}

/** Withdraw the lobbying card once the rosters are set. */
export function withdrawAllStarLobbyCard() {
  const st = StateManager.get();
  return _withdraw(c => c._rosterKey === `allstar:lobby:${st.seasonNum}`);
}

/** All-Star card decisions (inside _applyRosterAction). */
function _applyAllStarAction(action, instance) {
  StateManager.mutate(s => {
    const season = s.allStar?.season;
    if (!season?.influence) return;
    season.influence.choice = action === 'as_lobby_yes' ? 'yes' : 'no';
  });
}

// ─────────────────────────────────────────────────────────────
// OFFSEASON CARDS (§70)
// ─────────────────────────────────────────────────────────────
//
// The offseason's decisions are roster cards on the clock: delivered at a
// real hour of their day, withdrawn when their situation is gone (a free
// agent signs elsewhere), and auto-resolved conservatively at their deadline.
// Hard gates (§23.2 — ownership, expiring contracts, manager) carry `_osGate`
// and are due when spring training opens; free-agent cards are soft (3 days).

const _who = (p) => `${p.name}${_hand(p)} (${p.nativePos || p.pos}, OVR ${p.ovr})`;
const _years = (n) => `${n} year${n === 1 ? '' : 's'}`;

/** Ownership evaluation — next season's payroll cap and operating budget. */
export function deliverOwnershipCard(offer, atMs, expiresAtMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  const last  = (state.seasonHistory || [])[state.seasonHistory.length - 1] || {};
  const dir   = offer.pct > 0.005 ? 'raise' : offer.pct < -0.005 ? 'trim' : 'hold';
  const card = _rosterCard(state, {
    cardId: 'os_ownership', tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: 'urgent',
    _rosterKey: `os:ownership:${state.seasonNum}`, _osGate: 'ownership', _offer: offer,
    subject: 'Season review — next year\'s budget',
    preview: `${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses}. Ownership wants to ${dir} the budget.`,
    body: `We finished ${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses} against a target of ${last.winTarget ?? '—'} wins`
        + `${last.postseason?.result && last.postseason.result !== 'Did not qualify' ? ` (${last.postseason.result.toLowerCase()})` : ''}. `
        + `For next season ownership is offering a payroll cap of ${formatK(offer.payrollCap)} (was ${formatK(offer.prevPayrollCap)}) `
        + `and an operating budget of ${formatK(offer.operatingBudget)} (was ${formatK(offer.prevOperatingBudget)}). `
        + `Next season's win target: ${offer.winTarget}. You can accept, or push for 4% more at a cost to ownership's trust. `
        + `If there's no answer by the time spring training opens, ownership decides — and it will be tighter.`,
    yesLabel: 'Accept the offer', noLabel: 'Push for more',
    expiresAtMs,
    _raw: { onYes: 'os_owner_accept', onNo: 'os_owner_push', onAuto: 'os_owner_auto' },
    _autoLabel: 'No answer — ownership set a tighter budget',
  });
  return _deliverAt(card, atMs);
}

/** A user player whose deal is up: re-sign at his asking terms, or let him walk. */
export function deliverResignCard(playerId, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  const terms = p._ask || Offseason.marketTerms(state, p);
  const age = computeAge(p.dob, baseballYear(state) + 1);
  const payroll = state.userTeam.finances?.payroll || 0;
  const cap = state.userTeam.finances?.payrollCap || 0;
  const delta = terms.salary - (p.contractSalary || 0);
  const card = _rosterCard(state, {
    cardId: 'os_resign', tag: 'CONTRACT', sender: `${p.name}'s agent`, avatar: '✍️', type: 'normal',
    _rosterKey: `os:resign:${playerId}:${state.seasonNum}`, _osGate: 'contracts', _targetPlayerId: playerId,
    subject: `${p.name}'s contract is up`,
    preview: `Asking ${formatK(terms.salary)} a year for ${_years(terms.years)}.`,
    body: `${_who(p)}, ${age} next season, is a free agent unless we re-sign him. He's asking ${formatK(terms.salary)} a year for ${_years(terms.years)}`
        + ` (he made ${formatK(p.contractSalary || 0)}). That ${delta >= 0 ? 'adds' : 'saves'} ${formatK(Math.abs(delta))} — payroll is ${formatK(payroll)} against a ${formatK(cap)} cap. `
        + `If we let him walk he goes to the free-agent market, where any club can sign him. No answer by the time spring training opens means he walks.`,
    yesLabel: `Re-sign (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Let him walk',
    expiresAtMs,
    _raw: { onYes: 'os_resign', onNo: 'os_walk', onAuto: 'os_walk_auto' },
    _autoLabel: 'No answer — he walked',
  });
  return _deliverAt(card, atMs);
}

/** The manager's contract is up. */
export function deliverManagerContractCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const m = state.userTeam.coachingStaff?.manager || {};
  const last = (state.seasonHistory || [])[state.seasonHistory.length - 1] || {};
  const card = _rosterCard(state, {
    cardId: 'os_manager', tag: 'MANAGER_CONTRACT', sender: m.name || 'The manager', avatar: '📋', type: 'urgent',
    _rosterKey: `os:manager:${state.seasonNum}`, _osGate: 'manager',
    subject: `${m.name || 'The manager'} — contract decision`,
    preview: 'His contract is up. Extend him, or open a search?',
    body: `${m.name || 'The manager'}'s contract is up after a ${last.wins ?? '—'}–${last.losses ?? '—'} season. `
        + `A ${_years(MANAGER_EXTENSION_YEARS_UI)} extension keeps the clubhouse steady (salary up 5%). Opening a search brings in a new voice — and some uncertainty. `
        + `With no decision by the time spring training opens, he stays on a one-year deal and knows he wasn't our first choice.`,
    yesLabel: `Extend ${_years(MANAGER_EXTENSION_YEARS_UI)}`, noLabel: 'Open a search',
    expiresAtMs,
    _raw: { onYes: 'os_mgr_extend', onNo: 'os_mgr_replace', onAuto: 'os_mgr_auto' },
    _autoLabel: 'No decision — one-year renewal',
  });
  return _deliverAt(card, atMs);
}
const MANAGER_EXTENSION_YEARS_UI = 2;

/** Free agents worth a look (soft: auto-declined after 3 days). */
export function deliverFreeAgentCards(atMs, springAt) {
  const state = StateManager.get();
  const offered = new Set([...(state.inbox || []), ...(state.scheduledCards || [])]
    .filter(c => (c._rosterKey || '').startsWith('os:fa:')).map(c => c._targetPlayerId));
  let n = 0;
  for (const t of Offseason.userFreeAgentTargets(state, FA_CARDS_PER_ROUND, offered)) {
    const p = t.player;
    const terms = p._ask || Offseason.marketTerms(state, p);
    const room = Offseason.displacementFor(state, 'user', p);
    const age = computeAge(p.dob, baseballYear(state) + 1);
    const from = (state.leagueTeams || []).find(x => x.id === p._faFrom)?.name || (p._faFrom === 'user' ? 'us' : null);
    const card = _rosterCard(state, {
      cardId: 'os_free_agent', tag: 'FREE_AGENT', sender: 'Pro Scouting', avatar: '🔎', type: 'good',
      _rosterKey: `os:fa:${p.id}:${state.seasonNum}`, _targetPlayerId: p.id,
      subject: `Free agent: ${p.name}`,
      preview: `${p.nativePos || p.pos}, OVR ${p.ovr}, ${age} — ${t.reason}.`,
      body: `${_who(p)}, ${age} next season${from ? `, formerly with ${from}` : ''}, is on the market — ${t.reason}. `
          + `He's asking ${formatK(terms.salary)} a year for ${_years(terms.years)}. `
          + (room ? `Our 28 is full, so ${room.name} (OVR ${room.ovr}) would go to the farm to make room. ` : '')
          + `Other clubs are looking too — if he signs elsewhere this offer disappears.`,
      yesLabel: `Sign him (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Pass',
      expiresAtMs: Math.min(atMs + FA_CARD_TTL_DAYS * 86_400_000, springAt),
      _raw: { onYes: 'os_fa_sign', onNo: 'os_fa_pass', onAuto: 'os_fa_pass' },
      _autoLabel: 'No answer — passed',
    });
    if (_deliverAt(card, atMs)) n++;
  }
  return n;
}

/** Day 5: one reminder listing required decisions still open. */
export function deliverGateReminder(atMs, springAt) {
  const state = StateManager.get();
  const gates = Offseason.hardGates(state);
  if (!gates.open.length) return null;
  const names = { ownership: 'the budget offer from ownership', contracts: 'expiring contracts', manager: 'the manager\'s contract' };
  return _deliverNotice(`os:reminder:${state.seasonNum}`, {
    sender: 'Front Office', type: 'urgent', avatar: '⏰',
    subject: 'Decisions due before spring training',
    preview: `Still open: ${gates.open.map(g => names[g]).join(', ')}.`,
    body: `Spring training opens at midnight tomorrow. Still open: ${gates.open.map(g => names[g]).join(', ')}. Anything without an answer by then is decided for us — conservatively.`,
    expiresAtMs: springAt,
  }, atMs);
}

/** A user player retires. */
export function deliverRetirementNotice(playerId, age, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  return _deliverNotice(`os:retire:${playerId}`, {
    sender: _managerName(state), avatar: '🎩', type: 'normal',
    subject: `${p.name} is retiring`,
    preview: `${_who(p)} has decided to hang them up at ${age}.`,
    body: `${_who(p)} told us he's retiring at ${age}, after ${p.careerStats?.seasons || 1} season${(p.careerStats?.seasons || 1) === 1 ? '' : 's'}. His spot on the roster is open.`,
  }, atMs);
}

/** Offseason card decisions (inside _applyRosterAction). */
function _applyOffseasonAction(action, instance, atMs) {
  const id = instance._targetPlayerId;
  switch (action) {
    case 'os_owner_accept': StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'accept')); return true;
    case 'os_owner_push':   StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'push'));   return true;
    case 'os_owner_auto':   StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'auto'));   return true;
    case 'os_resign':       StateManager.mutate(s => Offseason.applyResign(s, id)); return true;
    case 'os_walk':         StateManager.mutate(s => Offseason.applyLetWalk(s, id, atMs)); return true;
    case 'os_walk_auto':    StateManager.mutate(s => Offseason.applyLetWalk(s, id, atMs, { auto: true })); return true;
    case 'os_mgr_extend':   StateManager.mutate(s => Offseason.applyManagerDecision(s, 'extend'));  return true;
    case 'os_mgr_replace':  StateManager.mutate(s => Offseason.applyManagerDecision(s, 'replace')); return true;
    case 'os_mgr_auto':     StateManager.mutate(s => Offseason.applyManagerDecision(s, 'auto'));    return true;
    case 'os_fa_sign': {
      StateManager.mutate(s => {
        const p = s.players[id];
        if (!p || p.group !== PLAYER_GROUP.FREE_AGENT) return;
        const room = Offseason.displacementFor(s, 'user', p);
        Offseason.signFreeAgent(s, id, 'user', atMs, { displaceId: room?.id || null });
        applyRosterMutation(s, reconcileRoster(s, 'user'));
        s.userTeam.finances.payroll = computePayroll(s);
      });
      return true;
    }
    case 'os_fa_pass': return true;
    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────
// PLAYER CARDS — rest, illness, benching, training (§71)
// ─────────────────────────────────────────────────────────────
// The card acts on the player its text names (_targetPlayerId). Time away is
// counted in the club's games; training starts a development plan whose
// outcome varies (DevelopmentEngine).

/** Carry out a registered card action (CardActions), then fix the lineup. */
function _applyCardAction(action, instance, atMs, feasible = null) {
  const handler = CARD_ACTIONS[action];
  if (!handler) return;
  const st = StateManager.get();
  // Things changed since the card arrived (someone got hurt, the spot is gone):
  // it can't happen any more.
  if (!(feasible ?? handler.feasible(st, instance))) return;
  let events = [];
  StateManager.mutate(s => {
    events = handler.apply(s, instance, atMs) || [];
    applyRosterMutation(s, reconcileRoster(s, 'user'));
    s.userTeam.finances.payroll = computePayroll(s);
  });
  // Follow-ups the action set in motion (§73: a workout's result, a scouting
  // trip's leads, an independent-league report) — real cards at real times.
  for (const ev of events) {
    if (ev?.type === 'SCHEDULE_CARD') _deliverFollowupDef(ev.defId, ev.preset || {}, ev.atMs);
    if (ev?.type === 'SCHEDULE_INDIE') _deliverIndieReport(ev.playerId, ev.atMs);
  }
}

/** A pool card about players already named (follow-ups), parked for `atMs`. */
function _deliverFollowupDef(defId, preset, atMs) {
  let def = null;
  for (const pool of [...Object.values(ALL_POOLS), FOLLOWUP_POOL]) {
    const f = pool.find(e => (e?.card || e)?.id === defId);
    if (f) { def = f.card || f; break; }
  }
  if (!def || def._retired || !_cardActionsHandled(def)) return null;
  const inst = _createInstance(def, { _preset: preset, _country: preset._country }, StateManager.get());
  if (!inst) return null;
  // Keyed to the players it's about; a lead about nobody yet (a scouting
  // trip's) is its own card.
  const who = Object.entries(preset).filter(([k]) => !k.startsWith('_')).map(([, v]) => v);
  inst._rosterKey = `followup:${defId}:${who.length ? who.join(',') : inst.instanceId}`;
  return _deliverAt(inst, atMs);
}

/** The scout's independent-league report: sign him to the farm, or pass. */
function _deliverIndieReport(playerId, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p || p.group !== PLAYER_GROUP.FREE_AGENT) return null;
  const terms = signingTerms(state, p);
  const age = computeAge(p.dob, baseballYear(state));
  const card = _rosterCard(state, {
    cardId: 'indie_report', tag: 'SCOUTING', sender: 'Amateur Scouting', avatar: '🔭', type: 'good',
    _rosterKey: `indie:${playerId}`, _targetPlayerId: playerId, _tokenPlayers: { indie_player: playerId },
    subject: `Scouting report: ${p.name}`,
    preview: `${_who(p)}, ${age} — ${p._indieLeague || 'independent ball'}.`,
    body: `Our scout saw ${_who(p)}, ${age}, in the ${p._indieLeague || 'independent leagues'}. `
        + `He'd sign for a ${formatK(terms.bonus)} bonus and report to our farm system.`,
    yesLabel: `Sign him (${formatK(terms.bonus)})`, noLabel: 'Pass',
    expiresAtMs: atMs + 3 * 86_400_000,
    _raw: { onYes: 'indie_sign', onNo: 'indie_pass', onAuto: 'indie_pass' },
    _autoLabel: 'No answer — passed',
  });
  return _deliverAt(card, atMs);
}

/** A development plan finished: the coach reports how it went. */
function _deliverDevelopmentReport(ev, atMs) {
  const st = StateManager.get();
  const p  = st.players[ev.playerId];
  if (!p || ev.teamId !== 'user') return null;
  const coach = st.userTeam.coachingStaff?.[['SP', 'RP'].includes(p.pos) ? 'pitchingCoach' : 'hittingCoach']?.name || 'Player Development';
  const r = ev.realized, plan = ev.planned;
  const verdict = ev.profile === 'flop' || r < plan * 0.4 ? 'It didn\'t take the way we hoped'
    : r >= plan * 1.15 ? 'It went better than we hoped'
    : ev.profile === 'quick' ? 'It clicked right away'
    : ev.profile === 'slow' ? 'It took a while, but it came'
    : 'Steady progress, about what we expected';
  return _deliverNotice(`dev:${ev.planId}`, {
    sender: coach, avatar: '🏋️', tag: 'TRAINING', type: r >= plan * 0.8 ? 'good' : 'normal',
    subject: `${p.name} — development update`,
    preview: `${verdict}. Now OVR ${p.ovr}.`,
    body: `${verdict} with ${_who(p)}. The work is done for now — he's at OVR ${p.ovr}.`,
  }, atMs);
}

/**
 * Card actions (onYes / onNo) that have a real handler — in _applyRosterAction
 * or _fireFollowup. A pool card that declares any other action is NEVER
 * delivered (_filterEligible): it would promise a roster move ("sign him",
 * "call him up", "bench him") that the engine cannot perform. Add the action
 * name here in the same change that adds its handler (§60).
 */
export const HANDLED_CARD_ACTIONS = Object.freeze(new Set([
  'il_return_activate',
  'il_return_waive',
  'il_return_farm',
  'trade_execute',
  'trade_decline',
  // §65 roster clock
  'injury_mri_now',
  'injury_mri_wait',
  'il_placement',
  'il_placement_only',
  'day_to_day',
  'injury_auto',
  'need_callup',
  'need_defer',
  'need_auto',
  // §71–72 card actions (CardActions registry)
  ...Object.keys(CARD_ACTIONS),
  // §70 offseason
  'os_owner_accept', 'os_owner_push', 'os_owner_auto',
  'os_resign', 'os_walk', 'os_walk_auto',
  'os_mgr_extend', 'os_mgr_replace', 'os_mgr_auto',
  'os_fa_sign', 'os_fa_pass',
  // §75 All-Star Game
  'as_lobby_yes', 'as_lobby_no',
]));

function _cardActionsHandled(card) {
  return [card.onYes, card.onNo].every(a => !a || HANDLED_CARD_ACTIONS.has(a));
}

/**
 * _applyRosterAction(instance, choice, state, { atMs, auto })
 * Carries out a roster card's decision. `choice` is 'yes' | 'no' | 'auto'
 * (deadline). `atMs` is the moment of the decision — real time for a GM tap,
 * the deadline for an auto-resolve — and dates every transaction it creates.
 */
function _applyRosterAction(instance, choice, state, { atMs = Date.now(), feasible = null } = {}) {
  const raw    = instance._raw || {};
  const action = choice === 'yes' ? raw.onYes : choice === 'no' ? raw.onNo : choice === 'auto' ? raw.onAuto : null;
  if (!action) return;
  if (action.startsWith('os_')) { _applyOffseasonAction(action, instance, atMs); return; }
  if (action.startsWith('as_')) { _applyAllStarAction(action, instance, atMs); return; }
  if (CARD_ACTIONS[action]) { _applyCardAction(action, { ...instance, choice }, atMs, feasible); return; }

  const playerId = instance._targetPlayerId || null;
  const reconcileUser = () => {
    const rec = reconcileRoster(StateManager.get(), 'user');
    StateManager.mutate(s => applyRosterMutation(s, rec));
  };
  const placeOnIL = () => StateManager.mutate(s => {
    const p = s.players[playerId];
    if (p && p.injury?.status === 'evaluating') Object.assign(p, placeOnILUpdate(p));
  });
  const callUpBest = (preferredId, need) => {
    const st = StateManager.get();
    const ranked = rankCallupCandidates(st, 'user', need);
    const pick = ranked.find(p => p.id === preferredId) || ranked[0];
    if (!pick) return null;
    let res = null;
    StateManager.mutate(s => { res = callUp(s, pick.id, 'user', atMs, 'gm'); });
    return res?.ok ? pick.id : null;
  };

  switch (action) {
    // ── Injury Act 1 ────────────────────────────────────────────
    case 'injury_mri_now':
    case 'injury_mri_wait': {
      const st = StateManager.get();
      if (st.players[playerId]?.injury?.status !== 'evaluating') break;
      deliverInjuryAct2(playerId, _act2Time(st, atMs, action === 'injury_mri_now'));
      break;
    }

    // ── Injury Act 2 ────────────────────────────────────────────
    case 'il_placement': {
      const need = _needFor(StateManager.get().players[playerId]);
      placeOnIL();
      reconcileUser();
      callUpBest(instance._callupCandidate, need);
      reconcileUser();
      break;
    }
    case 'il_placement_only':
      placeOnIL();
      reconcileUser();
      break;
    case 'injury_auto':
      // Nobody answered by the deadline: he goes on the IL and the open spot's
      // deadline is the one that just passed — the roster clock has the
      // manager fill it (with the "didn't act" penalty) in this same step.
      placeOnIL();
      reconcileUser();
      StateManager.mutate(s => { s.userTeam.vacancyDeadlineAt = atMs; });
      break;
    case 'day_to_day':
      StateManager.mutate(s => {
        const p = s.players[playerId];
        if (p && p.injury?.status === 'evaluating') Object.assign(p, dayToDayUpdate(p));
      });
      reconcileUser();
      break;

    // ── Open roster spot ────────────────────────────────────────
    case 'need_callup':
      callUpBest(instance._callupCandidate, instance._need);
      reconcileUser();
      break;
    case 'need_defer':
    case 'need_auto':
      break;   // the roster clock owns the deadline

    // ── IL return ───────────────────────────────────────────────
    case 'il_return_activate': {
      const st = StateManager.get();
      const player = st.players[playerId];
      if (!player || !(st.ilReturnQueue || []).includes(playerId)) break;
      // A full active roster needs a corresponding move (Section 9.7: waivers
      // in season, the farm in spring).
      const isSpring = st.phase === PHASE.SPRING_TRAINING;
      if (rosterIsFull(st, 'user', sideOf(player))) {
        const planned = st.players[instance._dropId];
        const drop = planned && planned.teamId === 'user' && planned.group !== PLAYER_GROUP.IL
          && (st.userTeam.rosterIds || []).includes(planned.id) ? planned : _dropCandidate(st, playerId);
        if (drop) {
          const mut = isSpring ? sendToFarm(st, drop.id, 'user') : placeOnWaivers(st, drop.id);
          StateManager.mutate(s => applyRosterMutation(s, mut));
        }
      }
      const act = activateFromIL(StateManager.get(), playerId, defaultActiveGroup(player));
      StateManager.mutate(s => {
        applyRosterMutation(s, act);
        Object.assign(s.players[playerId], clearInjuryUpdate());
      });
      reconcileUser();
      break;
    }

    case 'il_return_waive': {
      if (!playerId) break;
      const mutations = placeOnWaivers(state, playerId);
      StateManager.mutate(s => {
        applyRosterMutation(s, mutations);
        Object.assign(s.players[playerId], clearInjuryUpdate());
      });
      reconcileUser();
      break;
    }

    case 'il_return_farm': {
      if (!playerId) break;
      const mutations = sendToFarm(state, playerId, 'user');
      StateManager.mutate(s => {
        applyRosterMutation(s, mutations);
        Object.assign(s.players[playerId], clearInjuryUpdate());
        s.ilReturnQueue = (s.ilReturnQueue || []).filter(id => id !== playerId);
      });
      reconcileUser();
      break;
    }

    // ── Trades ──────────────────────────────────────────────────
    case 'trade_execute': {
      const offer    = instance._tradeOffer;
      const proposer = instance._proposingTeamId;
      if (!offer || !proposer) break;
      // One ledger record; it executes on the roster clock (§65).
      StateManager.mutate(s => {
        s.transactions = [...(s.transactions || []), queueTrade(offer, proposer, atMs)];
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
    if (c.autoResolve === 'roster') return false;   // roster clock (§65)
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


// ─────────────────────────────────────────────────────────────
// FOLLOWUP FIRING
// ─────────────────────────────────────────────────────────────

function _fireFollowup(followup) {
  const state = StateManager.get();

  switch (followup.type) {
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// ROSTER HELPERS
// ─────────────────────────────────────────────────────────────






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


function _resolveBudgetCost(costK) {
  // Amounts are resolved to $K at delivery (_createInstance), from the same
  // draw the card text shows. Anything else is treated as no cost.
  return typeof costK === 'number' && Number.isFinite(costK) ? costK : 0;
}


// ─────────────────────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _uuid() {
  return crypto.randomUUID();
}
