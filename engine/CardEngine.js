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
  CARD_DAY,
  SPRING_TRAINING_GAME_COUNT,
  TRADE,
  ADVANCE_SCOUT,
  LEAGUE_TRADES,
  GAME_REMINDER,
  CARD_MONEY_BASE_TARGET_K,
  GAME_WEATHER,
} from '../data/constants.js';

import {
  confirmDiagnosis, placeOnILUpdate, dayToDayUpdate, dayToDayAllowed,
  clearInjuryUpdate, ilMinDays,
} from './InjuryEngine.js';
import {
  activateFromIL, placeOnWaivers, sendToFarm, reconcileRoster, applyRosterMutation,
  defaultActiveGroup, nextCalendarDay, computePayroll,
} from './RosterEngine.js';
import { evaluateTrade, queueTrade, generateCPUCashSale, tradeWindow, tradeBlockers, startCooldown, busyWithUs, evaluateForUser, evaluateForClub, clubBar } from './TradeEngine.js';
import {
  getRosterNeeds, rankCallupCandidates, callUp, decisionDeadlineAfter, rosterIsFull, sideOf,
} from './TransactionEngine.js';
import { setFlag, selectCardVariant } from './NarrativeEngine.js';
import { buildTokenMap, applyTokens, hasUnresolvedTokens, formatK, bullpenRecentERA, playerTokenValues, intlTypeOf } from './CardTokens.js';
import * as Offseason from './OffseasonEngine.js';
import * as Development from './DevelopmentEngine.js';
import { CARD_ACTIONS, cardFeasible } from './CardActions.js';
import * as AllStar from './AllStarEngine.js';
import * as Finance from './FinanceEngine.js';
import { addToMarket, signingTerms } from './MarketEngine.js';
import { baseballYear, computeAge, isAvailable } from './PlayerFactory.js';
import { planDeliveryTimes, pushTimeFor } from './CardScheduler.js';
import { MOMENT_CARDS } from '../data/cards-moments.js';
import { MONEY_BETWEEN, MONEY_PREGAME } from '../data/cards-money.js';
import * as Negotiation from './Negotiation.js';
import { rapportOf, rapportGrade, adjustRapport, wouldStart, clubMode, isRental, playsSlot } from './TradeEngine.js';
import * as LeagueTrades from './LeagueTrades.js';
import { buildActivityFeedEntry, pruneActivityFeed } from './SeasonEngine.js';
const TradeRapportBump = (s, teamId) => adjustRapport(s, teamId, 1);
import { computeOVR } from './PlayerFactory.js';
import { starterRested } from './PitchingEngine.js';

// ─────────────────────────────────────────────────────────────
// CARD POOLS — keyed by pool name for lookup
// ─────────────────────────────────────────────────────────────

const ALL_POOLS = {
  // §83 the Club Funds families join the moments they belong to.
  DECISIONS_POOL: [...DECISIONS_POOL, ...MONEY_BETWEEN],
  PREGAME_POOL:   [...PREGAME_POOL, ...MONEY_PREGAME],
  INGAME_POOL,
  BETWEEN_GAMES_POOL,
  FOLLOWUP_POOL,
  PERSONAL_LEAVE_POOL,
  MANAGER_CONTRACT_POOL,
  COACHING_CONTRACT_POOL,
};

// Per-phase active pools
const PHASE_POOLS = Object.freeze({
  // §80: spring game days have their own pre-game and in-game moments
  // (media at the first spring game, a visiting bus, a TV crew in the tunnel).
  [PHASE.SPRING_TRAINING]:       ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
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

const MAX_INBOX_SIZE       = 12;

// §80 Game-day moments: each pool belongs to a moment of the day, and every
// moment draws from its own pools (they used to share three slots in a fixed
// order, so the general pool always filled them and the game-day pools never
// got a turn).
const POOL_MOMENT = Object.freeze({
  DECISIONS_POOL: 'between', BETWEEN_GAMES_POOL: 'between',
  PREGAME_POOL: 'pregame', INGAME_POOL: 'ingame', PERSONAL_LEAVE_POOL: 'leave',
});

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

  // 3b. A selling club's cash sale (§85 A): at most one per game day. (Clubs'
  //     calls about our players come from the daily trade desk, §91.)
  const tradeDelivered = _maybeDeliverCashSale(state, context) ? 1 : 0;
  let room = MAX_INBOX_SIZE - currentInbox.length - tradeDelivered;
  if (room <= 0) return;

  // 4. The game day's moments (§80): how many cards each one gets today.
  const poolNames = PHASE_POOLS[state.phase] || ['DECISIONS_POOL'];
  const byMoment  = {};
  for (const name of poolNames) (byMoment[POOL_MOMENT[name] || 'between'] ||= []).push(name);
  const want = {
    pregame: Math.random() < CARD_DAY.pregameChance ? 1 : 0,
    ingame:  Math.random() < CARD_DAY.ingameChance  ? 1 : 0,
    between: CARD_DAY.betweenMin + (Math.random() < CARD_DAY.betweenExtraChance ? 1 : 0),
    leave:   Math.random() < CARD_DAY.leaveChance   ? 1 : 0,
  };
  const delivered = [];
  const taken = new Set();
  const takenFamilies = new Set();   // §94 one version of a family a season — across today's moments too
  for (const moment of ['pregame', 'ingame', 'between', 'leave']) {
    const pools = byMoment[moment];
    let n = Math.min(want[moment], room - delivered.length);
    if (!pools || n <= 0) continue;
    const eligible = [];
    for (const poolName of pools) {
      for (const card of _filterEligible(ALL_POOLS[poolName] || [], context, state)) {
        if (!taken.has(card.id) && !(card._family && takenFamilies.has(card._family))) eligible.push({ ...card, _fromPool: poolName });
      }
    }
    for (const cardDef of _selectCards(eligible, context, state, n)) {
      taken.add(cardDef.id);
      if (cardDef._family) takenFamilies.add(cardDef._family);
      const { _fromPool, ...def } = cardDef;
      const instance = _createInstance(def, context, state);
      if (instance) delivered.push({ ...instance, _pool: _fromPool, _moment: moment });
    }
  }

  if (delivered.length === 0) return;

  // 5. Schedule for real-world delivery (§61): pre-game cards before first
  // pitch, in-game cards while the game is played, the rest between games.
  // releaseDueCards() moves each into the inbox when its time comes; the same
  // schedule is synced to the push worker so it arrives with the app closed.
  _scheduleCards(delivered, state, context.nextGame || null);
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
      card.resolvedAtMs = Date.now();   // §95 when the decision was made (Completed tab)
    }

    // Apply soft metric effects
    _applySoftEffects(s, effects, choice, instance);
    // §75: ballpark decisions shape the league's impression (hosting score).
    if (instance._raw?._hosting && s.allStar) AllStar.accrueCard(s, instance._raw._hosting, choice);

    // Apply budget cost / revenue — the exact amounts the card text showed.
    _applyChoiceMoney(s, instance, choice);

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
      if (card) { card.resolved = true; card.choice = 'skip'; card.resolvedAtMs = atMs; }
    });
    return;
  }

  // §78.8 an unanswered card does what its default choice does — the effects
  // and the money of that choice (a deal signed by default pays; an expense
  // absorbed by default is charged) — plus the tax for leaving it.
  const tax = instance.autoResolveTax || {};
  const def = autoPath === 'yes' ? 'yes' : 'no';
  StateManager.mutate(s => {
    const card = s.inbox.find(c => c.instanceId === instanceId);
    if (card) {
      card.resolved  = true;
      card.choice    = 'auto';
      card.autoChoice = def;
      card.resolvedAt = s.currentGameIndex || 0;
      card.resolvedAtMs = atMs;
    }
    _applySoftEffects(s, def === 'yes' ? instance.yesEffect : instance.noEffect, def, instance);
    _applyChoiceMoney(s, instance, def);
    _applySoftEffects(s, tax, 'auto', instance);
  });
  // §74: an unanswered card that resolves to "no" does what "no" does (e.g.
  // a player on personal leave still goes, for the minimum).
  const onNo = instance._raw?.onNo;
  if (autoPath === 'no' && onNo && (CARD_ACTIONS[onNo] || onNo.startsWith('as_'))) {
    _applyRosterAction(instance, 'no', StateManager.get(), { atMs });   // registry and All-Star actions alike
  }
}

/** A decision's money — the exact amounts the card showed — into / out of Club Funds (§78). */
function _applyChoiceMoney(s, instance, choice) {
  const costK = choice === 'yes' ? _resolveBudgetCost(instance._budgetCost)
              : choice === 'no'  ? _resolveBudgetCost(instance._budgetCostNo)
              : 0;
  if (costK) Finance.post(s.userTeam.finances, -costK, 'cards', instance.subject || 'Front-office decision', Date.now());
  if (choice === 'yes' && instance._revenueK) {
    Finance.post(s.userTeam.finances, instance._revenueK, 'cards', instance.subject || 'Deal', Date.now());
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
    preview:  `${player.name}${_hand(player)} came out of today's game with a possible ${label}.`,
    body:     `${player.name}${_hand(player)} (${player.pos}) came out of today's game with what looks like a ${label}. ${player.name} is unavailable until we know more. An MRI now returns results in an hour or two, so any roster move can be made before midnight and the replacement reports tomorrow. Or we wait for the team physician's exam in the morning, which costs nothing, but a call-up made tomorrow won't report until the day after.`,
    yesLabel: `MRI Now (${'$'}${INJURY_MRI_COST_K}K)`,
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
    ? `${player.name} is out for the rest of the season.`
    : `On the ${ilMinDays(player)}-day IL (backdated to the injury), ${player.name} is eligible to return ${_day(eligibleAt)}.`;
  const dtdLine = dtd
    ? ` Or we manage it day-to-day: the roster spot stays put and ${player.name} should be available in about ${inj.days} days, but we play a player short until then.`
    : '';
  const bestLine = best
    ? ` Best fit on the farm: ${best.name}${_hand(best)} (${best.nativePos || best.pos}, OVR ${best.ovr}), who would report tomorrow.`
    : ' There is no healthy fit on the farm right now.';
  const dlLine = deadline
    ? ` We need a decision by ${_clock(deadline)} (${_day(deadline)}) or ${_managerName(state)} will make the call.`
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
    noLabel:  dtd ? 'Day-to-day — keep the roster spot' : `Place on IL — I'll pick the call-up`,
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
    body:     `${ref} has completed the recovery and is cleared for game action.`
            + (drop ? ` The active roster is full, so activating ${player.name} means a corresponding move: ${drop.name} (${drop.nativePos || drop.pos}, OVR ${drop.ovr}) is the player who'd be ${isSpring ? 'optioned to the farm' : 'placed on waivers'}.`
                    : ' There is room on the active roster.')
            + (deadline ? ` If we haven't decided by ${_clock(deadline)} (${_day(deadline)}), ${_managerName(state)} will make the activation.` : ''),
    yesLabel: drop ? `Activate ${player.name} — ${isSpring ? 'option' : 'waive'} ${drop.name}` : `Activate ${player.name}`,
    noLabel:  isSpring ? `Send ${player.name} to the farm` : `Place ${player.name} on waivers`,
    type:     'urgent',
    expiresAtMs: deadline,
    _raw: { onYes: 'il_return_activate', onNo: isSpring ? 'il_return_farm' : 'il_return_waive', onAuto: 'il_return_activate' },
    _autoLabel: `No decision — ${_managerName(state)} made the activation`,
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
            + (best ? ` The best fit on the farm is ${best.name}${_hand(best)} (${best.nativePos || best.pos}, OVR ${best.ovr}), who would report tomorrow.` : ' Nobody on the farm fits — look at the waiver wire or make a trade.')
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
          ? `Nobody made a move on the open roster spot before the deadline, so I called up ${names.join(' and ')}. ${names.length > 1 ? 'Both report' : 'The call-up reports'} tomorrow. Ownership noticed (Owner Trust ${ev.penalty?.ownerTrust ?? -2}, Atmosphere ${ev.penalty?.atmosphere ?? -1}).`
          : `Nobody made a move on the open roster spot before the deadline, and there's no one on the farm who can fill it. We'll play short until something changes. Ownership noticed.`,
      }, ev.atMs)) delivered++;
    } else if (ev.type === 'FARM_SIGNING' && ev.teamId === 'user') {
      const st = StateManager.get();
      const p  = st.players[ev.playerId];
      if (p && _deliverNotice(`farmsign:${ev.playerId}:${ev.atMs}`, {
        sender:  'Farm Director',
        subject: `Signed ${p.name} to a minor-league deal`,
        preview: `${p.name}${_hand(p)} (${p.nativePos || p.pos}, OVR ${p.ovr}) joins the farm system.`,
        body:    `Our farm system was getting thin, so I signed ${p.name}${_hand(p)} (${p.nativePos || p.pos}, OVR ${p.ovr}) to a minor-league deal — available as a call-up whenever we need one.`,
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
        preview: won ? `${_who(p)} is ours — reporting tomorrow.` : `${winner || 'Another club'} was ahead of us in the claiming order.`,
        body: won ? `Our claim on ${_who(p)} came through. ${p.name} reports tomorrow.`
                  : `${winner || 'Another club'} had priority in the claiming order (worse record) and claimed ${_who(p)}.`,
      }, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'WAIVER_CLEARED' && ev.userClaimed) {
      // (cannot happen: a user claim always makes the user a claimant)
    } else if (ev.type === 'DEV_DONE' && ev.teamId === 'user') {
      if (_deliverDevelopmentReport(ev, ev.atMs ?? atMs)) delivered++;
    } else if (ev.type === 'TRADE_EXECUTED' && ev.tx?.league) {
      delivered += _leagueTradeCards(ev.tx, ev.atMs ?? atMs);
    } else if (ev.type === 'TRADE_VOIDED' && !ev.tx?.league) {
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

  // §89: an answer to our offer, decided when we sent it, that can no longer
  // be carried out (a player in it got hurt or moved, the window closed) is
  // replaced by their call that the deal is off — at the time the answer
  // would have reached us.
  state = StateManager.get();
  for (const c of [...(state.inbox || []).filter(x => !x.resolved), ...(state.scheduledCards || [])]) {
    if (!['talk_accepted', 'talk_counter'].includes(c.cardId) || !c._talkTeamId) continue;
    const talk = Negotiation.talkWith(state, c._talkTeamId);
    if (!talk || talk.id !== c._talkId || talk.round !== c._talkRound) continue;
    const offer = c.cardId === 'talk_counter' ? talk.counter : talk.offer;
    const reason = offer && tradeBlockers(offer, state, atMs, c._talkTeamId);
    if (!reason) continue;
    const name = (state.leagueTeams || []).find(t => t.id === c._talkTeamId)?.name || 'They';
    const when = Math.max(atMs, c.deliverAtMs || 0);
    _withdraw(x => x.instanceId === c.instanceId);
    Negotiation.callOff(c._talkTeamId, atMs);
    if (_deliverNotice(`talk:off:${talk.id}:${talk.round}`, {
      cardId: 'trade_off', tag: 'TRADE', sender: `${name} front office`, avatar: '📞',
      subject: `The deal with ${name} is off`,
      preview: `Things changed before it could be done: ${reason}.`,
      body: `${name} called: ${c.cardId === 'talk_counter' ? 'they had a counter ready' : 'they were ready to do the deal'}, but things changed before it could be done — ${reason}. The talks are closed for now; we can start over with a new offer.`,
    }, when)) delivered++;
    state = StateManager.get();
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
    if (c._tradeOffer)               return !_tradeStillValid(state, c, atMs);
    // §90 a package Pro Scouting put together that can no longer be offered
    // (a player in it moved or got hurt, the window closed, the club cooled off).
    if (c._ideaOffer && c._ideaTeamId) return !!(tradeBlockers(c._ideaOffer, state, Math.max(atMs, c.deliverAtMs || 0), c._ideaTeamId)
                                                  || Negotiation.ourSideBlocker(state, c._ideaOffer));
    return false;
  });

  return { delivered, withdrawn };
}

/** §91 the offer can still be made: the window, every player where the deal needs him (roster or farm), healthy, settled. */
function _tradeStillValid(state, card, atMs = Date.now()) {
  const team = (state.leagueTeams || []).find(t => t.id === card._proposingTeamId);
  return !!team && !tradeBlockers(card._tradeOffer || {}, state, Math.max(atMs, card.deliverAtMs || 0), card._proposingTeamId);
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
    // Roster cards, pre-game cards (§74 — their question is moot at first pitch), and the
    // weather's questions (§104.2 — answered by first pitch or not at all; on the game clock,
    // not the wall clock, so an unanswered one never outlives its game).
    .filter(c => (c.autoResolve === 'roster' || c._pool === 'PREGAME_POOL' || c._pool === 'INGAME_POOL' || c.tag === 'WEATHER')
                 && Number.isFinite(c.expiresAtMs) && c.expiresAtMs <= atMs)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  for (const c of due) expire(c.instanceId, c.expiresAtMs);
  return due.length;
}

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// A CPU CLUB'S OFFER TO US (§91)
// ─────────────────────────────────────────────────────────────
//
// Every offer a CPU club makes us is a decision with three ways out: take it,
// turn it down (the club cools off), or counter from the composer, which
// starts a talk at round 2 (their offer was round 1). The club opens in its
// own favor — a little under our player's value when it wants him, a little
// over its own when it offers one — and Pro Scouting says, in words, whether
// there's room. Kinds:
//   call  — the trade desk: a club with a need wants one of our players
//   sell  — a club offers us one of its players (the seed, the All-Star
//           suitor, a club cutting payroll returning our call)
//   sale  — a selling club's player for cash (§85 A)

const _NOUN  = { C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', OF: 'outfielder', DH: 'designated hitter' };
const _SPOT  = { C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'the outfield', DH: 'the DH spot' };
const _an    = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
const _pick  = (xs) => xs[Math.floor(Math.random() * xs.length)];
const _poss  = (name) => (/s$/.test(name) ? `${name}'` : `${name}'s`);
const _and   = (xs) => xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** A club's need in words: { a: 'a shortstop', role: 'play shortstop for them every day', hole: 'shortstop has been a weak spot' }. */
function _needWords(need, whose = 'them') {
  if (!need) return { a: 'help', role: `help ${whose} right away`, hole: 'the lineup has a hole' };
  if (need.kind === 'sp') return { a: 'a starting pitcher', role: `take a turn in ${whose === 'us' ? 'our' : 'their'} rotation`, hole: 'the back of the rotation has been a weak spot' };
  if (need.kind === 'rp') return { a: 'a late-inning reliever', role: `pitch the late innings for ${whose}`, hole: 'the bullpen has been leaking late in games' };
  const n = _NOUN[need.slot] || 'regular';
  return need.slot === 'DH'
    ? { a: 'a designated hitter', role: `be ${whose === 'us' ? 'our' : 'their'} designated hitter`, hole: 'the DH spot has been a weak spot' }
    : { a: _an(n), role: `play ${_SPOT[need.slot] || n} for ${whose} every day`, hole: `${_SPOT[need.slot] || 'one spot in the lineup'} has been a weak spot` };
}

/** The opening line, by kind, varied so the same situation doesn't read the same way twice. */
function _offerIntro(kind, { team, ours, theirs, need, seed }) {
  const w = _needWords(need, kind === 'call' ? 'them' : 'us');
  if (kind === 'call') return _pick(seed ? [
    `Welcome to the job. ${team} were the first to call: they need ${w.a} and want ${ours}.`,
    `The phone was ringing before the nameplate went up. ${team} want ${ours} to ${w.role}.`,
    `${team} wasted no time testing the new front office: they're after ${ours}.`,
  ] : [
    `${team} called about ${ours}. They need ${w.a} and see ${ours} as the answer.`,
    `${team} have been shopping for ${w.a}, and ${ours} is the name they keep coming back to.`,
    `${_poss(team)} front office reached out: they want ${ours} to ${w.role}.`,
    `Word from ${team}: ${w.hole} for them, and they'd like ${ours} to fill it.`,
  ]);
  if (kind === 'sell') return _pick(seed ? [
    `Welcome to the job. ${team} called with an offer: ${theirs}, who would ${need ? w.role : 'start for us'}.`,
    `The phone was ringing before the nameplate went up — ${team} want to move ${theirs}, and they think we're the fit.`,
    `${team} are testing the new front office with an offer for ${theirs}.`,
  ] : [
    `${team} called: ${theirs} is available, and they think ${theirs} would start for us.`,
    need ? `${team} know we could use ${w.a} and are offering ${theirs}.` : `${team} are shopping ${theirs} and think we're a fit.`,
    `${_poss(team)} GM is shopping ${theirs} and called us first.`,
  ]);
  return '';
}

/** Pro Scouting's read, in words (never a meter). */
function _offerRead(st, kind, offer, room) {
  const net = evaluateForUser(offer, st).net;
  const good = net >= 15;
  if (kind === 'call') return room
    ? 'Pro Scouting reads it as an opening bid — they should go higher if we push back.'
    : good     ? 'Pro Scouting thinks this is close to the most they will pay, and it is a good deal for us.'
    : net >= 0 ? 'Pro Scouting thinks this is close to the most they will pay, and it is fair value for us.'
               : 'Pro Scouting thinks this is about the most they will pay — a little short of what we would want.';
  if (kind === 'sell') return room
    ? 'They are asking a bit more than they would take — Pro Scouting thinks there is room to bring the price down.'
    : good     ? 'Pro Scouting thinks that is a good price for us.'
    : net >= 0 ? 'Pro Scouting thinks that is a fair price.'
               : 'Pro Scouting thinks that is about the least they will take, and it is a little steep for us.';
  return good ? 'Pro Scouting thinks that is a good price for us.' : net >= 0 ? 'Pro Scouting thinks the price is fair.' : 'Pro Scouting thinks the price is a little high.';
}

/** Can the offer be made right now, with both owners able to carry it? */
function _offerCanGo(st, offer, teamId, atMs) {
  return !tradeBlockers(offer, st, atMs, teamId) && !Negotiation.ourSideBlocker(st, offer) && _tradeSalaryOk(st, offer, teamId);
}

/**
 * deliverTradeCall(deal, atMs, { seed }) — §91 the trade desk's call: a club
 * with a need wants one of our players (deal.a = the club, deal.b = 'user'),
 * and its opening offer reaches us within the next hour or so.
 */
export function deliverTradeCall(deal, atMs, { seed = false } = {}) {
  const st = StateManager.get();
  const offer = LeagueTrades.userOffer(deal);
  if (!_offerCanGo(st, offer, deal.a, atMs)) return null;
  return deliverTradeOffer(offer, deal.a, {
    kind: 'call', room: !!deal.room, need: deal.why?.need || null, seed, openBy: deal.openBy || 0,
    atMs: seed ? null : atMs + (10 + Math.random() * 80) * 60_000,
  });
}

/**
 * deliverTradeOffer(offer, proposingTeamId, opts)
 * A CPU club's offer as an inbox card (offer in our terms: incomingIds = we
 * receive, cashK + = they pay us).
 *   opts: { kind: 'call'|'sell'|'sale', room, need, intro (a line of its own,
 *           replacing the varied one), subject, seed, atMs (exact delivery),
 *           openBy (how far under our value a caller opened) }
 */
export function deliverTradeOffer(offer, proposingTeamId, { kind = 'sell', room = false, need = null, intro = null, subject = null, seed = false, atMs = null, openBy = 0 } = {}) {
  const state    = StateManager.get();
  const team     = (state.leagueTeams || []).find(t => t.id === proposingTeamId);
  const teamName = team?.name || 'Another team';
  const evaluation = evaluateTrade(offer, state);

  const ins  = evaluation.incomingPlayers || [];
  const outs = evaluation.outgoingPlayers || [];
  const incoming = ins[0];
  if (!incoming && !outs.length) return null;
  // §85 up to three a side, plus cash and salary kept by the sending club.
  const ref  = (p) => `${p.name}${['SP','RP'].includes(p.pos) ? ` ${PITCHER_HAND_DISPLAY[p.hand] || '(R)'}` : ''} (${p.pos}, OVR ${p.ovr})`;
  const list = (ps) => ps.length <= 1 ? ps.map(ref).join('') : `${ps.slice(0, -1).map(ref).join(', ')} and ${ref(ps[ps.length - 1])}`;
  const inRef = list(ins), outRef = list(outs);
  const cashK = offer.cashK || 0;
  const cashNote = cashK > 0 ? ` They'll send ${formatK(cashK)} to complete it.`
                 : cashK < 0 ? ` We'd send ${formatK(-cashK)}.` : '';
  const keepNote = Object.entries(offer.retain || {}).map(([id, pct]) => {
    const p = [...ins, ...outs].find(x => x.id === id);
    if (!p) return '';
    return ins.includes(p) ? ` They'll keep paying ${Math.round(pct * 100)}% of ${p.name}'s salary this season.`
                           : ` We'd keep paying ${Math.round(pct * 100)}% of ${p.name}'s salary this season.`;
  }).join('');

  // Payroll against the owner's target: only what this deal changes.
  const payrollNote = evaluation.overTarget && evaluation.payrollDelta > 100
    ? (evaluation.newPayroll - evaluation.payrollDelta > (Finance.seasonTarget(state.userTeam.finances) || 22000)
        ? ` It adds ${formatK(evaluation.payrollDelta)} to a payroll already over ownership's target.`
        : " This would push payroll over ownership's target.")
    : evaluation.payrollDelta > 500
    ? ` It adds ${formatK(evaluation.payrollDelta)} to the payroll.`
    : evaluation.payrollDelta < -500
    ? ` It takes ${formatK(-evaluation.payrollDelta)} off the payroll.`
    : '';

  // The player the offer is about: ours they want, or theirs they offer.
  const target = kind === 'call' ? outs[0] : incoming;
  const lead = intro || _offerIntro(kind, { team: teamName, ours: target?.name, theirs: target?.name, need, seed });
  const read = _offerRead(state, kind, offer, room);
  const deal = kind === 'sale'
    ? `${teamName} need to move salary and will sell ${inRef} to us outright.`
    : `The deal: we send ${outRef} and get ${inRef}.`;
  const when = atMs ?? Date.now();

  const instance = _rosterCard(state, {
    cardId:          `trade_${proposingTeamId}`,
    type:            'normal',
    tag:             'TRADE',
    sender:          `${teamName} front office`,
    avatar:          '📞',
    subject:         subject || (kind === 'call' ? `${teamName} want ${target?.name}`
                              : kind === 'sale' ? `${teamName} will sell ${incoming.name}`
                              : `${teamName} are offering ${target?.name}`),
    preview:         kind === 'sale' ? `${incoming.name} for ${formatK(-cashK)}.`
                                     : `${_and(ins.map(p => p.name))} for ${_and(outs.map(p => p.name))}.`,
    body:            `${lead ? lead + ' ' : ''}${deal}${cashNote}${keepNote} ${read}${payrollNote} We can take it, turn it down, or counter.`,
    yesLabel:        'Accept the Trade',
    noLabel:         'Decline',
    autoResolve:     'roster',
    expiresAtMs:     seed ? when + 3 * 86_400_000 : (atMs != null ? atMs + 2 * 86_400_000 : null),
    _expiresAfterMs: atMs == null && !seed ? 2 * 86_400_000 : null,
    _tradeOffer:     offer,
    _tradeKind:      kind,
    // How the offer stood for each side when it was made (the harness reads it).
    _opening:        { ourNet: Math.round(evaluateForUser(offer, state).net), theirNet: Math.round(evaluateForClub(offer, state, proposingTeamId).net), bar: clubBar(state, proposingTeamId), openBy },
    // A frozen summary of the offer as proposed — never live player objects
    // (those keep changing; the card must describe the deal it offered).
    _tradeEval:      _evalSnapshot(evaluation),
    _proposingTeamId: proposingTeamId,
    _rosterKey:      `trade:${proposingTeamId}:${when}`,
    // Counter from the composer: their offer was the talk's first round.
    _reviseOffer:    { teamId: proposingTeamId, offer, round: 2 },
    _reviseLabel:    'Counter',
    _raw:            { onYes: 'trade_execute', onNo: 'trade_decline', onAuto: 'trade_decline' },
    ...(seed ? { _seed: true } : {}),
  });

  if (seed) {
    // New-franchise seed: visible immediately, never pushed.
    StateManager.mutate(s => {
      s.inbox = [...(s.inbox || []), { ...instance, arrivedAtMs: when }];
      _sortInbox(s.inbox);
    });
    return instance;
  }
  if (atMs != null) return _deliverAt(instance, atMs);
  _scheduleCards([instance], state);
  return instance;
}

function _evalSnapshot(ev) {
  const slim = (p) => ({ id: p.id, name: p.name, pos: p.pos, ovr: p.ovr, hand: p.hand || null,
                         teamId: p.teamId, _previouslyWithOrg: !!p._previouslyWithOrg });
  return {
    fairnessRating:  ev.fairnessRating,
    fairnessLabel:   ev.fairnessLabel,
    payrollDelta:    ev.payrollDelta,
    overTarget:      !!ev.overTarget,
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
function _scheduleCards(instances, state, game = null) {
  if (!instances?.length) return;
  const nowMs = Date.now();
  // §74/§80: pre-game cards arrive in the hours before THIS game's first
  // pitch, in-game cards while it is being played; a moment that has already
  // passed (planned late, e.g. the app was closed) is dropped, not delivered
  // out of place. Everything else arrives between games.
  const T = Number.isFinite(game?.gameTime) ? game.gameTime : _nextGameTime(state, nowMs);
  const lead = 10 * 60_000;
  const timed = [], loose = [];
  for (const c of instances) {
    if (c._moment === 'soon') {
      // A milestone happening now (the GM takes over, camp opens): within the hour.
      timed.push({ ...c, deliverAtMs: nowMs + lead + Math.random() * 30 * 60_000 });
    } else if (c._moment === 'pregame' || (!c._moment && c._pool === 'PREGAME_POOL')) {
      if (!Number.isFinite(T) || T - nowMs < lead + 15 * 60_000) continue;
      timed.push({ ...c, deliverAtMs: Math.max(nowMs + lead, T - (45 + Math.random() * 105) * 60_000), expiresAtMs: T });
    } else if (c._moment === 'ingame' || (!c._moment && c._pool === 'INGAME_POOL')) {
      if (!Number.isFinite(T)) continue;
      const at = Math.max(nowMs + lead, T + (20 + Math.random() * 100) * 60_000);
      if (at > T + CARD_DAY.ingameLastMs) continue;          // the game is over by then
      timed.push({ ...c, deliverAtMs: at, expiresAtMs: T + CARD_DAY.ingameExpireMs });
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
    windowEndMs: Number.isFinite(T) && T - nowMs >= 45 * 60_000 ? T : _nextGameTime(state, nowMs),
    quietStart:  state.push?.quietStart,
    quietEnd:    state.push?.quietEnd,
  });
  // planDeliveryTimes returns ascending times; shuffle the pairing so card
  // order in the pool doesn't dictate arrival order.
  const order = instances.map(c => ({ c, r: Math.random() })).sort((a, b) => a.r - b.r);
  const scheduled = order.map(({ c }, i) => ({ ...c, deliverAtMs: times[i],
    ...(c._expiresAfterMs ? { expiresAtMs: times[i] + c._expiresAfterMs } : {}) }));
  StateManager.mutate(s => {
    s.scheduledCards = [...(s.scheduledCards || []), ...scheduled]
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  });
}

// ─────────────────────────────────────────────────────────────
// THE CLUB'S SITUATION (§83) — what a card's `_when` reads
// ─────────────────────────────────────────────────────────────

const POSTSEASON = new Set([PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);

/**
 * cardSituation(state, context) — the club right now, in the words cards use:
 *   archetype, season ('first'|'returning'), last ('winning'|'losing'),
 *   pace ('winning'|'middling'|'losing', after 20 games), race ('in'|'out'),
 *   lossGap, funds ('flush'|'steady'|'tight'), red (projected to finish in
 *   the red), owner (stage), crowd ('packed'|'steady'|'soft', last 5 home
 *   gates), sellouts (of the last 5), postseason, cpuTrouble (a CPU club
 *   whose owner is cutting).
 */
export function cardSituation(state, context = {}) {
  const u = state.userTeam || {};
  const fin = u.finances;
  const n = (u.wins || 0) + (u.losses || 0);
  const pct = n ? u.wins / n : 0.5;
  const last = (state.seasonHistory || [])[(state.seasonHistory || []).length - 1];
  const target = Finance.seasonTarget(fin) || 1;
  const homes = (state.schedule || []).filter(g => g._committed && g.isHome && !g.isSpring && g.attendance).slice(-5);
  const cap = fin?.market?.capacity || 1;
  const fill = homes.length ? homes.reduce((a, g) => a + g.attendance, 0) / homes.length / cap : null;
  const gb = parseFloat(context.gamesBack);
  const regIdx = context.regularSeasonIndex || 0;
  return {
    archetype: state.archetype,
    season:    (state.seasonNum || 1) > 1 ? 'returning' : 'first',
    last:      last ? ((last.wins || 0) > (last.losses || 0) ? 'winning' : 'losing') : null,
    pace:      n < 20 ? null : pct >= 0.55 ? 'winning' : pct <= 0.45 ? 'losing' : 'middling',
    race:      regIdx < 60 ? null : (context.gamesBack === '-' || (Number.isFinite(gb) && gb <= 4)) ? 'in' : 'out',
    lossGap:   (u.losses || 0) - (u.wins || 0),
    funds:     !fin ? null : fin.funds >= target * 0.25 ? 'flush' : fin.funds < target * 0.10 ? 'tight' : 'steady',
    red:       !!fin && Finance.projection(state, 'user') < 0,
    owner:     fin?.owner?.stage || 'content',
    crowd:     fill == null ? null : fill >= 0.95 ? 'packed' : fill <= 0.62 ? 'soft' : 'steady',
    sellouts:  homes.filter(g => g.sellout).length,
    postseason: POSTSEASON.has(state.phase),
    cpuTrouble: (state.leagueTeams || []).some(t => ['concerned', 'cuts'].includes(t.finances?.owner?.stage)),
  };
}

/** Does the situation meet a card's `_when`? Every listed key must hold. */
export function fitsSituation(w, sit) {
  const is = (want, have) => want == null || (Array.isArray(want) ? want.includes(have) : want === have);
  if (!is(w.archetypes, sit.archetype)) return false;
  for (const k of ['season', 'last', 'pace', 'race', 'funds', 'owner', 'crowd']) if (!is(w[k], sit[k])) return false;
  if (w.red != null && w.red !== sit.red) return false;
  if (w.postseason != null && w.postseason !== sit.postseason) return false;
  if (w.cpuTrouble != null && w.cpuTrouble !== sit.cpuTrouble) return false;
  if (w.minSellouts != null && sit.sellouts < w.minSellouts) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// FIRST MOMENTS (§80)
// ─────────────────────────────────────────────────────────────

const SEEN_MOMENTS_KEY = 'bgm_seenMoments';

/** Versions this device has shown, oldest first (across every team and season). */
function _seenMoments() {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_MOMENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function _rememberMoment(id) {
  try {
    const list = _seenMoments().filter(x => x !== id);
    list.push(id);
    globalThis.localStorage?.setItem(SEEN_MOMENTS_KEY, JSON.stringify(list.slice(-200)));
  } catch { /* private window / no storage: the save's own memory still applies */ }
}

/** The club's situation, as the `_when` conditions read it. */
function _momentSituation(state) {
  const fin  = state.userTeam?.finances;
  const last = (state.seasonHistory || [])[(state.seasonHistory || []).length - 1];
  const target = fin?.payrollTarget || 0;
  return {
    archetype: state.archetype,
    season:    (state.seasonNum || 1) > 1 ? 'returning' : 'first',
    last:      last ? ((last.wins || 0) > (last.losses || 0) ? 'winning' : 'losing') : null,
    funds:     !fin || !target ? null
             : fin.funds >= target * 0.25 ? 'flush'
             : fin.funds < target * 0.10 ? 'tight' : null,
  };
}

function _fitsMoment(card, sit) {
  const w = card._when;
  if (!w) return true;
  if (w.archetypes && !w.archetypes.includes(sit.archetype)) return false;
  if (w.season && w.season !== sit.season) return false;
  if (w.last && w.last !== sit.last) return false;
  if (w.funds && w.funds !== sit.funds) return false;
  return true;
}

/**
 * deliverMomentCard(moment, context, game, timing)
 * §80: one card for a club milestone — 'takeover', 'camp_open',
 * 'spring_opener', 'opening_day' — once per season. The version fits the
 * club's situation; among those, one never shown on this device (or this save)
 * is preferred, else the one shown longest ago, so a new team or a new season
 * doesn't open on the same message. `timing` is the moment of delivery:
 * 'soon' (within the hour) or 'pregame' (before `game`'s first pitch).
 * @returns {Boolean} whether a card was scheduled
 */
export function deliverMomentCard(moment, context, game = null, timing = 'soon') {
  const state = StateManager.get();
  const doneKey = `${state.seasonNum || 1}|${moment}`;
  if (state.momentsDone?.[doneKey]) return false;
  const sit = _momentSituation(state);
  const versions = (MOMENT_CARDS[moment] || []).filter(c => _fitsMoment(c, sit));
  if (!versions.length) return false;
  const seen = _seenMoments();
  const inSave = new Set(Object.values(state.momentsDone || {}).map(d => d.cardId));
  const fresh = versions.filter(c => !seen.includes(c.id) && !inSave.has(c.id));
  // Situation-specific versions are the more telling ones: weight them up.
  const weightOf = (c) => (c._when ? 2 : 1);
  let pick;
  if (fresh.length) {
    const total = fresh.reduce((a, c) => a + weightOf(c), 0);
    let r = Math.random() * total;
    pick = fresh.find(c => (r -= weightOf(c)) <= 0) || fresh[fresh.length - 1];
  } else {
    pick = [...versions].sort((a, b) => seen.indexOf(a.id) - seen.indexOf(b.id))[0];
  }
  const { _when, ...def } = pick;
  const instance = _createInstance({ ...def, autoResolve: def.autoResolve || 'skip' }, context, state);
  if (!instance) return false;
  _scheduleCards([{ ...instance, _moment: timing, _firstMoment: moment }], state, game);
  const scheduled = (StateManager.get().scheduledCards || []).some(c => c.instanceId === instance.instanceId);
  if (!scheduled) return false;    // the moment had already passed (planned too late)
  StateManager.mutate(s => {
    s.momentsDone = { ...(s.momentsDone || {}), [doneKey]: { cardId: pick.id, atMs: Date.now() } };
  });
  _rememberMoment(pick.id);
  return true;
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
  const cards = (state?.scheduledCards || [])
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
  return [...cards, ...gameReminders(state, nowMs)].sort((a, b) => a.deliverAt - b.deliverAt);
}

/**
 * gameReminders(state, nowMs) — §99 a push 30 minutes before each of our next
 * first pitches (spring, season and postseason alike), so the GM can catch up
 * on the inbox before the game. A push only, never an inbox card; none inside
 * quiet hours (moved later it would land after first pitch); off in Settings.
 */
export function gameReminders(state, nowMs = Date.now()) {
  if (state?.push?.gameReminder === false || !state?.userTeam) return [];
  const qs = state.push?.quietStart, qe = state.push?.quietEnd;
  const out = [];
  for (const g of (state.schedule || []).slice(state.currentGameIndex || 0)) {
    if (out.length >= GAME_REMINDER.ahead) break;
    if (!g || g._committed || !Number.isFinite(g.gameTime)) continue;
    const at = g.gameTime - GAME_REMINDER.leadMs;
    if (at <= nowMs - 60 * 1000 || pushTimeFor(at, qs, qe) !== at) continue;
    const opp = g.opponent || g.opp || 'today\'s opponent';
    out.push({
      id:        `game-reminder-${g.gameTime}`,
      deliverAt: at,
      title:     'First pitch in 30 minutes',
      body:      `${g.isHome ? 'vs' : '@'} ${opp} — a good time to catch up on the inbox before the game.`,
      tag:       `game-reminder-${g.gameTime}`,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// COMPOSE CARD DELIVERY (Phase 15 — Section 8.12)
// ─────────────────────────────────────────────────────────────

/**
 * _tradeWindowOpen(state, context)
 * Trades are allowed in spring, and in the regular season up to the deadline.
 */
function _tradeWindowOpen(state, context) {
  return tradeWindow(state).open;   // §85 H: spring, in season to the deadline, the offseason
}

/**
 * _maybeDeliverCashSale(state, context)
 * §85 A: a club that has to sell sometimes offers a fringe player for cash.
 * Clubs already dealing with us (talks open, an offer waiting on our answer,
 * cooling off) are skipped. TradeEngine owns the roll and the price.
 * @returns {Boolean} true if an offer was delivered
 */
function _maybeDeliverCashSale(state, context) {
  if (!_tradeWindowOpen(state, context)) return false;
  const now = Date.now();
  const teams = (state.leagueTeams || [])
    .filter(t => !busyWithUs(state, t.id, now))
    .map(t => ({ t, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map(x => x.t);
  for (const team of teams) {
    const sale = generateCPUCashSale(team.id, state, { atMs: now });
    if (sale && _tradeSalaryOk(state, sale.offer, team.id) && !tradeBlockers(sale.offer, state, now, team.id)) {
      deliverTradeOffer(sale.offer, team.id, { kind: 'sale' });
      return true;
    }
  }
  return false;
}

/**
 * The salary a trade adds to what the club pays (§78): the incoming players'
 * salaries less the outgoing players the club is paying now (a prospect on a
 * minor-league deal frees nothing).
 */
function _tradeSalaryDelta(state, offer) {
  const ret = offer.retain || {};                // §85 a share the sending club keeps paying
  const inK  = (offer.incomingIds || []).reduce((a, id) => a + (state.players[id]?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  const outK = (offer.outgoingIds || []).filter(id => Finance.isPaid(state.players[id]))
    .reduce((a, id) => a + (state.players[id]?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  return { inK: Math.round(inK), outK: Math.round(outK) };
}
/** Both owners can carry the deal: ours (§78), and the CPU club's (§78.5) when named. */
const _tradeSalaryOk = (state, offer, cpuId = null) => {
  const d = _tradeSalaryDelta(state, offer);
  if (!Finance.canAddSalary(state, d.inK, d.outK)) return false;
  if ((offer.cashK || 0) < 0 && !Finance.canSpend(state, -offer.cashK)) return false;   // §85 cash we send
  if (!cpuId) return true;
  const ret = offer.retain || {};
  const toCpu = (offer.outgoingIds || []).reduce((a, id) => a + (state.players[id]?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  return Finance.canAddSalary(state, toCpu, d.inK, cpuId) && ((offer.cashK || 0) <= 0 || Finance.canSpend(state, offer.cashK, cpuId));
};

/**
 * deliverSeedTradeOffer(context)
 * New-franchise seed (§60, §91): one real offer, visible at once and never
 * pushed — whichever situation the new league actually has, picked at
 * random: a club that wants one of our players (its opening bid), or a club
 * offering one of its players who would start for us (its asking price).
 * The wording varies too, so no two new clubs open the same way.
 * @returns {Boolean}
 */
export function deliverSeedTradeOffer(context) {
  const st = StateManager.get();
  const atMs = Date.now();
  if (!tradeWindow(st).open) return false;
  const shuffle = (xs) => xs.map(x => ({ x, r: Math.random() })).sort((a, b) => a.r - b.r).map(o => o.x);
  const tryCall = () => {
    for (const t of shuffle(st.leagueTeams || [])) {
      for (const need of LeagueTrades.clubNeeds(st, t.id).slice(0, 2)) {
        const fits = [...(st.userTeam.rosterIds || []), ...(st.userTeam.farmIds || [])].map(id => st.players[id])
          .filter(p => LeagueTrades.movable(p, atMs, st) && LeagueTrades.fillsNeed(p, need) && (p.ovr || 0) >= need.ovr + LEAGUE_TRADES.upgradeMin)
          .sort((x, y) => (y.ovr || 0) - (x.ovr || 0)).slice(0, 3);
        for (const p of shuffle(fits)) {
          const c = LeagueTrades.callOffer(st, t.id, p.id, atMs, { need });
          if (c && _offerCanGo(st, LeagueTrades.userOffer(c.deal), t.id, atMs)) {
            return deliverTradeCall({ ...c.deal, room: c.room, why: { need } }, atMs, { seed: true });
          }
        }
      }
    }
    return null;
  };
  const trySell = () => {
    const ourNeed = LeagueTrades.clubNeeds(st, 'user')[0] || null;
    const cands = [];
    for (const t of st.leagueTeams || []) {
      for (const id of [...(t.rosterIds || []), ...(t.farmIds || [])]) {
        const p = st.players[id];
        if (!LeagueTrades.movable(p, atMs, st) || !wouldStart(p, st, 'user')) continue;
        if (ourNeed && !LeagueTrades.fillsNeed(p, ourNeed)) continue;
        cands.push({ t, p });
      }
    }
    for (const { t, p } of shuffle(cands.sort((x, y) => (y.p.ovr || 0) - (x.p.ovr || 0)).slice(0, 8))) {
      const a = LeagueTrades.askingOffer(st, t.id, p.id, atMs);
      if (!a) continue;
      const offer = LeagueTrades.userOffer(a.deal);
      if (!_offerCanGo(st, offer, t.id, atMs)) continue;
      return deliverTradeOffer(offer, t.id, { kind: 'sell', room: a.room, seed: true, need: ourNeed });
    }
    return null;
  };
  const order = Math.random() < 0.5 ? [tryCall, trySell] : [trySell, tryCall];
  return !!(order[0]() || order[1]());
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

  const arrivedAtMs = Date.now();
  StateManager.mutate(s => {
    s.inbox = [...(s.inbox || []), ...instances.map(c => ({ ...c, arrivedAtMs }))];
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
    s.inbox = [...(s.inbox || []), { ...instance, _debugInjected: true, arrivedAtMs: Date.now() }];
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
        arrivedAtMs:  Date.now(),
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
    s.inbox = [...(s.inbox || []), { ...instance, arrivedAtMs: Date.now() }];
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
    // newest decision first (§95: by the moment it was made; older saves by game)
    .sort((a, b) => ((b.resolvedAtMs || 0) - (a.resolvedAtMs || 0)) || ((b.resolvedAt || 0) - (a.resolvedAt || 0)))
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

  // Never two copies of one card at once: not while it waits in the inbox
  // unanswered or is scheduled to arrive (§80).
  const pendingIds = new Set([
    ...(state.inbox || []).filter(c => !c.resolved).map(c => c.cardId),
    ...(state.scheduledCards || []).map(c => c.cardId),
  ]);

  const sit = cardSituation(state, context);
  const familiesThisSeason = new Set(
    [...(state.inbox || []), ...(state.scheduledCards || [])]
      .filter(c => c._family && (c._season ?? state.seasonNum) === state.seasonNum)
      .map(c => c._family));

  return pool.filter(card => {
    // Retired content (kept in the pool for reference, never delivered)
    if (card._retired) return false;
    if (pendingIds.has(card.id)) return false;

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

    // §83 the club's situation: a card (or one version of a card family) is
    // only sent when it is true — the record, the race, the books, the owner,
    // the crowds, the league around us.
    if (card._requiresDivClose && !(sit.race === 'in')) return false;
    if (card._requiresLossGap && (sit.lossGap < card._requiresLossGap)) return false;
    if (card._when && !fitsSituation(card._when, sit)) return false;
    // One version of a family a season: the family is the card.
    if (card._family && familiesThisSeason.has(card._family)) return false;

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
    const pick = pool[idx].card;
    selected.push(pick);
    pool.splice(idx, 1);
    // §94 one version of a family: the others of its family leave this draw.
    if (pick._family) for (let j = pool.length - 1; j >= 0; j--) if (pool[j].card._family === pick._family) pool.splice(j, 1);
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
    _family:          cardDef._family || null,       // §83 one version of a family a season
    _aboutTeamId:     cardDef._aboutTroubledTeam ? (values._troubledTeamId || null) : null,
    _season:          state.seasonNum || 1,
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
  // Manager confidence: cards were written with both spellings (§78.8 audit —
  // `managerConf` was silently ignored).
  const mc = effects.manConf ?? effects.managerConf;
  if (mc !== undefined) state.userTeam.managerConfidence = clamp((state.userTeam.managerConfidence || 60) + mc, 0, 100);
  // Money (§78): `funds` in $K; the older `budget` effect was written in $M and
  // never applied — both now move Club Funds.
  const fundsK = (effects.funds ?? 0) + (effects.budget !== undefined ? effects.budget * 1000 : 0);
  if (fundsK && state.userTeam.finances) {
    Finance.post(state.userTeam.finances, fundsK, 'cards', instance?.subject || 'Front-office decision', Date.now());
  }
  // §78.8 decisions that move the economy itself, not just a payment:
  //   target — the owner loosens / tightens this season's payroll target (share)
  //   gate   — a ticket promotion { price, fill, homeGames }
  //   local  — sponsor / rights income won or lost from here on (share)
  const fin = state.userTeam.finances;
  if (fin) {
    if (effects.target) Finance.adjustSeasonTarget(fin, effects.target);
    if (effects.gate)   Finance.startPromo(fin, effects.gate);
    if (effects.local)  Finance.adjustLocalIncome(fin, effects.local);
  }

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
        + `We can make the case publicly — it might be the push that\'s needed, and ${p.name} will know we went to bat — or stay out of it and let the vote speak.`,
    yesLabel: 'Make the case', noLabel: 'Stay out of it',
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
        + `${selections.length > 1 ? 'Every one of them earned it' : 'Earned, not given'} — the clubhouse is proud. `
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
    body: `${_who(p)} was named MVP of the All-Star Game${r ? ` (${r.homeScore}–${r.awayScore} final)` : ''}. The clubhouse gave ${p.name} a standing ovation on the way in.`,
    expiresAtMs: atMs + 2 * 24 * 3600_000,
  }, atMs);
}

/**
 * A player who spent All-Star week in our ballpark wants in (§17.3, §91): an
 * All-Star from another club who would start for us, offered by that club at
 * its asking price. Nothing comes if no such deal can be made.
 */
export function deliverAllStarTradeOffer(context) {
  const st = StateManager.get();
  const atMs = Date.now();
  if (!tradeWindow(st).open) return false;
  const season = st.seasonNum || 1;
  const cands = [];
  for (const t of st.leagueTeams || []) {
    if (busyWithUs(st, t.id, atMs)) continue;
    for (const id of [...(t.rosterIds || []), ...(t.farmIds || [])]) {
      const p = st.players[id];
      if ((p?.allStarSeasons || []).includes(season) && LeagueTrades.movable(p, atMs, st) && wouldStart(p, st, 'user')) cands.push({ t, p });
    }
  }
  for (const { t, p } of cands.sort((x, y) => (y.p.ovr || 0) - (x.p.ovr || 0)).slice(0, 6)) {
    const a = LeagueTrades.askingOffer(st, t.id, p.id, atMs);
    if (!a) continue;
    const offer = LeagueTrades.userOffer(a.deal);
    if (!_offerCanGo(st, offer, t.id, atMs)) continue;
    return !!deliverTradeOffer(offer, t.id, {
      kind: 'sell', room: a.room, subject: `${p.name} wants a move here`,
      intro: _pick([
        `${p.name} spent All-Star week in our ballpark and has let ${t.name} know a move here would be welcome. ${t.name} are willing to listen.`,
        `After a week in our ballpark at the All-Star Game, ${p.name} asked ${t.name} about a move here — and they called us.`,
      ]),
      atMs: atMs + (30 + Math.random() * 150) * 60_000,
    });
  }
  return false;
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
// THE OWNER AND THE BOOKS (§78)
// ─────────────────────────────────────────────────────────────

// How each archetype's owner talks, by stage. {name} = the owner; lines are
// picked at random so the same stage doesn't read the same twice.
const OWNER_VOICE = {
  ember: {
    watching:  ["I've been looking at the payroll. This franchise can't spend like the old days — not yet.",
                "Every dollar matters here. I'm watching where they go."],
    concerned: ["We're spending money we don't have. That's how this club got cold in the first place.",
                "I won't run this franchise into the red again. Get it under control."],
  },
  contender: {
    watching:  ["The payroll's running hot. If we're going to spend, I want to see it in the standings.",
                "I'm keeping an eye on the money. Win and I'll stop asking."],
    concerned: ["We're paying like a contender and not playing like one. That has to change.",
                "The money's going out faster than the wins are coming in. Fix it."],
  },
  empire: {
    watching:  ["Spend what it takes — but I expect a parade for it.",
                "Money isn't the problem. Losing with this payroll would be."],
    concerned: ["The most expensive roster in the league, and look at the standings. Unacceptable.",
                "I don't mind the bill. I mind paying it for this."],
  },
  gambler: {
    watching:  ["Interesting bets you're making with my money. Let's see how they land.",
                "I like a big swing. I don't like a big miss."],
    concerned: ["I'm done being patient with these numbers. Tighten it up.",
                "The house always wins — and right now we're not the house."],
  },
  lab: {
    watching:  ["I ran our cost per win. It's drifting the wrong way.",
                "Process over results — but the process includes the budget."],
    concerned: ["We're paying more per win than almost anyone. That's not an efficient model.",
                "The spreadsheet doesn't lie. We're overpaying for what we're getting."],
  },
  institution: {
    watching:  ["This club has always paid its bills. I'd like to keep it that way.",
                "Steady, responsible spending — that's how we've always done things here."],
    concerned: ["We don't carry debt in this organization. We never have.",
                "Running in the red is not who we are. I expect that corrected."],
  },
};
const _voice = (state, stage) => {
  const lines = (OWNER_VOICE[state.archetype] || OWNER_VOICE.contender)[stage] || [];
  return lines[Math.floor(Math.random() * lines.length)] || '';
};

/** What's worrying the owner, in words (payroll over target, red ink, cost per win). */
// ─────────────────────────────────────────────────────────────
// WEATHER DECISIONS (§102.5) — who pitches when the weather gets a say
// ─────────────────────────────────────────────────────────────

const _wxPct = (n) => `${n}%`;

/**
 * Rain or storms likely during tonight's game (the GM's own forecast, read
 * three hours before first pitch): start the scheduled starter as planned, or
 * hold that pitcher a day and start the next one in the rotation. A delay of ARM_COOL_MIN or more ends the
 * night of whoever is on the mound — a start cut short spends a turn.
 * Yes: the two swap places in the rotation (the one held pitches next time).
 */
export function deliverRainStartCard(info, atMs) {
  const state = StateManager.get();
  const sp = state.players[info.starterId], alt = state.players[info.altId];
  if (!sp || !alt) return null;
  const what = info.kind === 'storms' ? 'storms' : info.kind === 'snow' ? 'snow' : 'rain';
  const at = info.city ? ` in ${info.city}` : '';
  return _deliverAt(_rosterCard(state, {
    cardId: 'wx_rain_start', tag: 'WEATHER', sender: _managerName(state), avatar: '🌧', type: 'urgent',
    _rosterKey: info.key, _wxGameTime: info.gameTime,
    subject: `${what[0].toUpperCase()}${what.slice(1)} likely tonight — start ${sp.name}?`,
    preview: `${_wxPct(info.chance)} chance of ${what} during the game${at}. Hold ${sp.name} a day and start ${alt.name}?`,
    body: `The forecast for tonight${at} gives a ${_wxPct(info.chance)} chance of ${what} during the game (first pitch ${_clock(info.gameTime)}). `
        + `If play stops for ${GAME_WEATHER.ARM_COOL_MIN} minutes or more, the pitcher on the mound doesn't go back out — a start cut short is a turn of the rotation spent. `
        + `We can hold ${_who(sp)} a day and give the ball to ${_who(alt)} tonight; ${sp.name} would start the next game, on an extra day's rest. `
        + `Or start ${sp.name} as planned and take our chances with the weather.`,
    yesLabel: `Hold ${sp.name}, start ${alt.name}`, noLabel: `Start ${sp.name}`,
    autoResolve: 'no', expiresAtMs: info.gameTime - 30 * 60_000,
    _raw: { onYes: 'wx_hold_starter', onNo: null, starterId: info.starterId, altId: info.altId },
  }), atMs);
}

/**
 * A doubleheader is on our schedule (a makeup): two starts in one day. Game
 * two goes to the next starter in the rotation (everyone's turn comes a day
 * early), or it's a bullpen game — the long reliever opens, the bullpen covers
 * the rest, and the rotation stays on schedule.
 */
export function deliverDoubleheaderCard(info, atMs) {
  const state = StateManager.get();
  const lr = state.players[info.longId], nx = state.players[info.nextId];
  if (!lr) return null;
  const day = info.dayLabel;   // the baseball calendar's date, as the schedule shows it
  return _deliverAt(_rosterCard(state, {
    cardId: 'wx_doubleheader', tag: 'WEATHER', sender: _managerName(state), avatar: '⚾', type: 'normal',
    _rosterKey: info.key, _wxDate: info.date,
    subject: `Doubleheader ${day} — who starts game two?`,
    preview: `${info.makeupOf ? `The makeup of ${info.makeupOf} makes it two games ${day}. ` : `Two games ${day}. `}${nx ? `${nx.name} in turn, or a bullpen game?` : 'The next starter, or a bullpen game?'}`,
    body: `${info.makeupOf ? `The rainout of ${info.makeupOf} is being made up ${day}` : `We play two ${day}`} against the ${info.opp} — two starts in one day. `
        + `Game two can go to the next starter in the rotation${nx ? `, ${_who(nx)}` : ''}: every starter's turn comes a day sooner after that. `
        + `Or we make it a bullpen game: ${_who(lr)}, our long reliever, opens and the bullpen covers the rest — the rotation stays on schedule, and the relievers carry the load for a day.`,
    yesLabel: `Bullpen game — ${lr.name} opens`, noLabel: nx ? `${nx.name} starts game two` : 'Next starter goes',
    autoResolve: 'no', expiresAtMs: info.firstPitch - 60 * 60_000,
    _raw: { onYes: 'wx_bullpen_game', onNo: null, longId: info.longId },
  }), atMs);
}

/** Withdraw unresolved weather cards whose key starts with `prefix` (the game moved or was called off). */
export function withdrawWeatherCards(prefix) {
  return _withdraw(c => c.tag === 'WEATHER' && String(c._rosterKey || '').startsWith(prefix));
}

/** The weather decisions (inside _applyRosterAction). */
function _applyWeatherAction(action, instance, atMs) {
  const raw = instance._raw || {};
  if (action === 'wx_hold_starter') {
    // Still tonight's game, not started, both men able: they swap places in the rotation.
    const st = StateManager.get();
    const g = st.schedule?.[st.currentGameIndex || 0];
    const rot = st.userTeam.rotation;
    if (!g || g._committed || g.gameTime !== instance._wxGameTime || (g.plays && g.plays.length) || !rot?.order?.length) return;
    const a = rot.order.indexOf(raw.starterId), b = rot.order.indexOf(raw.altId);
    const alt = st.players[raw.altId];
    if (a < 0 || b < 0 || !alt || !isAvailable(alt) || !starterRested(alt, g.gameTime)) return;
    // Tonight's spot goes to the alternate, the next to the one held; everyone else keeps their order.
    StateManager.mutate(s => {
      const r = s.userTeam.rotation, n = r.order.length, c = r.currentIndex % n;
      const before = [raw.starterId, raw.altId].filter(id => r.order.indexOf(id) < c).length;
      const o = r.order.filter(id => id !== raw.starterId && id !== raw.altId);
      const pos = Math.max(0, c - before);
      o.splice(pos, 0, raw.altId, raw.starterId);
      r.order = o;
      r.currentIndex = pos;
    });
    return;
  }
  if (action === 'wx_bullpen_game') {
    // Game two of that day's doubleheader, if it's still a doubleheader and game two hasn't started.
    const st = StateManager.get();
    const games = (st.schedule || []).filter(g => g.date === instance._wxDate && !g.cancelled).sort((x, y) => x.gameTime - y.gameTime);
    const g2 = games[1];
    const lr = st.players[raw.longId];
    if (games.length < 2 || !g2 || g2._committed || (g2.plays && g2.plays.length) || !lr || !isAvailable(lr) || lr.teamId !== 'user') return;
    StateManager.mutate(s => {
      const x = s.schedule[g2.index];
      if (x) { x.userStarterId = raw.longId; x.keepRotation = true; }
    });
  }
}

function _strainWords(strain) {
  const parts = [];
  if (strain.over > 0.5) parts.push(`payroll is ${formatK(strain.payroll)}, ${Math.round(strain.over)}% over the ${formatK(strain.target)} target`);
  if (strain.projected < 0) parts.push(`at this rate we finish the season ${formatK(-strain.projected)} in the red`);
  if (strain.cpw) parts.push(`we're paying more per win than the league`);
  return parts.length ? parts.join(', and ') : 'the books are tighter than ownership likes';
}

/** The owner's mood worsened (watching / concerned) — a note in his voice. */
export function deliverOwnerFinanceCard(stage, strain, atMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  const concerned = stage === 'concerned';
  return _deliverNotice(`owner:${stage}:${state.seasonNum}:${atMs}`, {
    cardId: `owner_${stage}`, tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: concerned ? 'urgent' : 'normal',
    subject: concerned ? `${owner} is concerned about the money` : `${owner} is watching the payroll`,
    preview: _voice(state, stage),
    body: `"${_voice(state, stage)}" — ${_strainWords(strain)}. `
        + (concerned
          ? `Until the books improve, ownership won't approve adding salary. If it doesn't turn around by the next payday or two, expect an order to cut payroll.`
          : `Nothing's being asked of us yet. Winning is the best argument we have.`),
    yesLabel: 'Understood', expiresAtMs: atMs + 3 * 86_400_000,
  }, atMs);
}

/**
 * The owner orders cuts: move a contract (named) by the next payday. Yes —
 * the front office finds a taker (a salary dump: the player for nothing back
 * but the savings); no — the owner remembers.
 */
export function deliverOwnerCutOrder(playerId, amountK, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  const order = state.userTeam.finances?.owner?.order;
  if (!p || !order) return null;
  const owner = state.userTeam.ownerName || 'Ownership';
  const due = new Date(order.dueAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  return _deliverAt(_rosterCard(state, {
    cardId: 'owner_cut_order', tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: 'urgent',
    _rosterKey: `owner:order:${state.seasonNum}:${order.dueAt}`, _targetPlayerId: playerId,
    subject: `${owner} wants ${formatK(amountK)} off the payroll`,
    preview: `"${_voice(state, 'concerned')}" Due by ${due}.`,
    body: `"${_voice(state, 'concerned')}" Ownership wants ${formatK(amountK)} a year off the payroll by the payday on ${due}. `
        + `The obvious contract is ${_who(p)}, at ${formatK(p.contractSalary)} a year. We can find a club to take the contract — it's a salary dump, nothing much comes back but the savings — `
        + `or tell ownership we're keeping ${p.name} and take the hit with them. Missing the deadline costs their trust and shrinks next season's payroll target.`,
    yesLabel: `Move ${p.name}`, noLabel: `Keep ${p.name}`,
    autoResolve: 'no', expiresAtMs: order.dueAt,
    _raw: { onYes: 'fin_dump_yes', onNo: 'fin_dump_no', onAuto: 'fin_dump_no' },
  }), atMs);
}

/** The cut order came due — met or missed. */
export function deliverOwnerOrderResult(result, atMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  return _deliverNotice(`owner:orderResult:${state.seasonNum}:${result.dueAt}`, {
    cardId: result.met ? 'owner_order_met' : 'owner_order_missed', tag: 'OWNERSHIP', sender: owner, avatar: '💼',
    type: result.met ? 'good' : 'urgent',
    subject: result.met ? 'Ownership noticed the payroll cut' : 'Ownership: the payroll wasn\'t cut',
    preview: result.met ? `${formatK(result.cutK)} off the payroll. Trust restored a little.` : `Asked for ${formatK(result.amountK)}. It didn't happen.`,
    body: result.met
      ? `Payroll came down ${formatK(result.cutK)}, as asked. Ownership appreciates it — and remembers who delivered.`
      : `Ownership asked for ${formatK(result.amountK)} off the payroll and got ${formatK(Math.max(0, result.cutK))}. Their trust took a real hit, and next season's payroll target will be smaller for it.`,
    yesLabel: 'Understood', expiresAtMs: atMs + 3 * 86_400_000,
  }, atMs);
}

/** The cut-order decision (inside _applyRosterAction). */
function _applyFinanceAction(action, instance, atMs) {
  if (action === 'fin_call_club') { _callClubAboutSalary(instance, atMs); return; }
  if (action !== 'fin_dump_yes') return;   // keeping the contract: the order stands, the owner decides at the deadline
  const st = StateManager.get();
  const pid = instance._targetPlayerId;
  const p = st.players[pid];
  if (!p || p.teamId !== 'user' || !(st.userTeam.rosterIds || []).includes(pid)) return;
  // The taker (§78.5): the club whose owner has the most payroll room for him.
  const taker = [...(st.leagueTeams || [])]
    .map(t => ({ t, room: Finance.payrollRoom(st, t.id) }))
    .filter(x => x.room >= (p.contractSalary || 0))
    .sort((a, b) => b.room - a.room)[0]?.t;
  if (!taker) {
    _deliverNotice(`owner:noTaker:${instance.instanceId}`, {
      cardId: 'owner_no_taker', tag: 'OWNERSHIP', sender: st.userTeam.ownerName || 'Ownership', avatar: '📞', type: 'normal',
      subject: `No club can take ${p.name}'s contract`,
      preview: `We called around — nobody has ${formatK(p.contractSalary || 0)} of room right now.`,
      body: `We called every club about ${p.name} (${formatK(p.contractSalary || 0)} a year). Nobody's owner has the payroll room for that contract right now. `
          + `The order stands; the payroll will have to come down another way.`,
      yesLabel: 'Understood', expiresAtMs: atMs + 2 * 86_400_000,
    }, atMs);
    return;
  }
  StateManager.mutate(s => {
    s.transactions = [...(s.transactions || []), queueTrade({ incomingIds: [], outgoingIds: [pid] }, taker.id, atMs)];
  });
}

/**
 * §83 we call a club whose owner is cutting payroll: if it has a deal we and
 * both owners can live with, its offer comes in; if not, word comes back.
 */
function _callClubAboutSalary(instance, atMs) {
  const st = StateManager.get();
  const team = (st.leagueTeams || []).find(t => t.id === instance._aboutTeamId);
  if (_salaryCallOffer(st, team, atMs)) return;
  _deliverWatchCard(`fin:called:${instance.instanceId}`, {
    subject: `${team?.name || 'The club'} — nothing that fits`,
    preview: 'We made the call. Nothing on their roster works for both sides right now.',
    body: `We talked to ${team?.name || 'them'} about their payroll. Nothing they are willing to move fits what we need and what our owner will carry right now.`,
    spec: { type: 'club', teamId: team?.id || null }, what: `a deal with ${team?.name || 'them'}`,
    atMs: atMs + 3 * 3600_000, cardId: 'fin_called_back',
  });
}

/**
 * §91 a club cutting payroll offers the biggest salary it can move that
 * would start for us, in a deal that takes money off its books. True when an
 * offer went out.
 */
function _salaryCallOffer(st, team, atMs, { intro = null } = {}) {
  const cands = !team || !tradeWindow(st).open ? [] : (team.rosterIds || []).map(id => st.players[id])
    .filter(p => LeagueTrades.movable(p, atMs, st) && Finance.isPaid(p) && wouldStart(p, st, 'user'))
    .sort((a, b) => (b.contractSalary || 0) - (a.contractSalary || 0)).slice(0, 5);
  for (const p of cands) {
    const a = LeagueTrades.askingOffer(st, team.id, p.id, atMs, { premium: false, shedK: Math.round((p.contractSalary || 0) * 0.5) });
    if (!a) continue;
    const offer = LeagueTrades.userOffer(a.deal);
    if (!_offerCanGo(st, offer, team.id, atMs)) continue;
    deliverTradeOffer(offer, team.id, {
      kind: 'sell', room: a.room, subject: `${team.name}: ${p.name} is available`,
      intro: intro || `${team.name} called back about the conversation we started: ${p.name} is available, and they need the payroll room.`,
      atMs: atMs + (2 + Math.random() * 3) * 3600_000,
    });
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// TRADE TALKS (§85 Phase 4b) — the other GM's answer, and our decision
// ─────────────────────────────────────────────────────────────

const _TALK_REASON = {
  value:    'it isn\'t enough for them',
  lowball:  'they didn\'t think it was a serious offer',
  fizzled:  'the two sides couldn\'t meet after a few rounds',
  nothing:  'nothing we could add would get it done right now',
};

/**
 * deliverTalkReply(teamId, response, atMs) — the other club's answer to our
 * offer, as a card with a real decision (§85 F).
 */
/** §85 our revised offer replaces the talk's open cards with that club. */
export function withdrawTalkCards(teamId) {
  // §91 their own offer to us too: our counter answers it.
  return _withdraw(c => c._talkTeamId === teamId || c._ideaTeamId === teamId || (c._tradeOffer && c._proposingTeamId === teamId));
}

export function deliverTalkReply(teamId, r, atMs) {
  const state = StateManager.get();
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  const talk = Negotiation.talkWith(state, teamId);
  if (!team || !talk) return null;
  const name = team.name;
  const grade = rapportGrade(rapportOf(state, teamId));
  const key = `talk:${teamId}:${talk.id}:${r.decision}:${talk.round}`;
  const base = { tag: 'TRADE', sender: `${name} front office`, avatar: '📞', _talkTeamId: teamId, _talkId: talk.id, _talkRound: talk.round, _rosterKey: key };
  if (r.decision === 'accept') {
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_accepted', type: 'good',
      subject: `${name} accepted our offer`,
      preview: `They'll do it: ${Negotiation.describeOffer(state, talk.offer, name)}.`,
      body: `${name} called back: they'll do the deal — ${Negotiation.describeOffer(state, talk.offer, name)}. `
          + `It's ours to finalize. Backing out now would cost us with their front office (rapport: ${grade}).`,
      yesLabel: 'Finalize the Deal', noLabel: 'Back Out',
      autoResolve: 'roster', expiresAtMs: atMs + 24 * 3600_000,
      _raw: { onYes: 'talk_finalize', onNo: 'talk_backout', onAuto: 'talk_finalize' } }), atMs);
  }
  if (r.decision === 'counter') {
    const counter = r.counter || talk.counter;
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_counter', type: 'normal',
      subject: `${name} came back with a counter`,
      preview: `Their counter: ${Negotiation.describeOffer(state, counter, name)}.`,
      body: `${name} won't do it as offered, but they're interested. Their counter: ${Negotiation.describeOffer(state, counter, name)}. `
          + `We can take it, walk away, or send a revised offer.`,
      yesLabel: 'Take Their Counter', noLabel: 'Walk Away',
      autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
      _reviseOffer: { teamId, offer: counter, round: (talk.round || 1) + 1 },
      _raw: { onYes: 'talk_take_counter', onNo: 'talk_walk', onAuto: 'talk_walk' } }), atMs);
  }
  const why = _TALK_REASON[r.reason] || r.reason || _TALK_REASON.value;
  if (r.reason === 'fizzled' || r.reason === 'nothing') {
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_fizzled', type: 'normal',
      subject: `Talks with ${name} have run their course`,
      preview: `No deal — ${why}.`,
      body: `No deal with ${name}: ${why}. We can tell them to keep us in mind if things change — it keeps the relationship warm — or simply move on.`,
      yesLabel: 'Keep the Door Open', noLabel: 'Move On',
      autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
      _raw: { onYes: 'talk_keep_open', onNo: 'talk_move_on', onAuto: 'talk_move_on' } }), atMs);
  }
  return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_passed', type: 'normal',
    subject: `${name} passed on our offer`,
    preview: `They said no — ${why}.`,
    body: `${name} passed: ${why}. We can ask what it would take to get something done, or move on.`
        + (r.reason === 'lowball' ? ' They weren\'t pleased with the offer.' : ''),
    yesLabel: 'Ask What It Would Take', noLabel: 'Move On',
    autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
    _raw: { onYes: 'talk_ask', onNo: 'talk_move_on', onAuto: 'talk_move_on' } }), atMs);
}

function _applyTalkAction(action, instance, atMs) {
  const teamId = instance._talkTeamId;
  if (!teamId) return;
  // A card only speaks for the round of talks it was written in (a revised
  // offer since then has moved the talk on).
  const talk = Negotiation.talkWith(StateManager.get(), teamId);
  if (!talk || talk.id !== instance._talkId || talk.round !== instance._talkRound) return;
  Negotiation.settle(teamId);   // their answer has reached us
  const map = { talk_finalize: 'finalize', talk_backout: 'backout', talk_take_counter: 'take_counter',
                talk_walk: 'walk', talk_ask: 'ask', talk_move_on: 'move_on' };
  if (action === 'talk_keep_open') {
    StateManager.mutate(s => { TradeRapportBump(s, teamId); });
    Negotiation.act(teamId, 'move_on', atMs);
    return;
  }
  const res = Negotiation.act(teamId, map[action], atMs);
  if (res && res.ok === false && res.reason) {
    _deliverNotice(`talk:off:${instance.instanceId}`, {
      cardId: 'trade_off', tag: 'TRADE', sender: 'Pro Scouting', avatar: '📞', type: 'normal',
      subject: 'The deal can\'t go through',
      preview: `The deal is off: ${res.reason}.`,
      body: `We went to finalize it, but the deal is off: ${res.reason}.`,
      yesLabel: 'Understood', expiresAtMs: atMs + 2 * 86_400_000,
    }, atMs);
  }
}

// ─────────────────────────────────────────────────────────────
// LEAGUE TRADES THAT TOUCH US (§90 Phase 4c)
// ─────────────────────────────────────────────────────────────
//
// A trade between two other clubs reaches us through the League wire and the
// Recent strip. An inbox card comes only when it touches us, and always with
// a decision (§85 J): someone beat us to a player we were talking about (the
// next-best option), a player we traded away was flipped (bring them back
// once they can be moved), a division rival got better (advance scouting), a
// club just sold (call them), a club now has a surplus (make an offer).

const _IDEA_GAP_MS = 3 * 86_400_000;     // at most one "opportunity" card (sold / surplus) every few days

/** One player's short reference: name (POS, OVR n). */
const _ref = (p) => `${p.name} (${p.nativePos || p.pos}, OVR ${p.ovr})`;

/** Same role: a pitcher of the same kind, or a hitter who can play the spot. */
function _sameRole(p, target) {
  if (!p || !target) return false;
  if (['SP', 'RP'].includes(target.pos)) return p.pos === target.pos;
  return !['SP', 'RP'].includes(p.pos) && playsSlot(p, target.nativePos || target.pos);
}

/**
 * An offer Pro Scouting put together, as a decision: send it as our offer
 * (their GM's answer comes on the clock), adjust it in the composer first,
 * or pass.
 */
function _deliverIdea(st, { key, teamId, deal, subject, preview, lead, atMs, sender = 'Pro Scouting', extra = {} }) {
  const team = (st.leagueTeams || []).find(t => t.id === teamId);
  if (!team || !deal) return null;
  const offer = LeagueTrades.userOffer(deal);
  const what = Negotiation.describeOffer(st, offer, team.name);
  return _deliverAt(_rosterCard(st, {
    cardId: 'lt_offer', tag: 'TRADE', sender, avatar: '📞', type: 'normal',
    subject, preview,
    body: `${lead} Pro Scouting's package: ${what}. `
        + `We can make the offer as it stands — ${team.name} answers on their own clock — adjust it first, or pass.`,
    yesLabel: 'Make the Offer', noLabel: 'Pass',
    autoResolve: 'roster', expiresAtMs: atMs + 2 * 86_400_000,
    _rosterKey: key, _ideaTeamId: teamId, _ideaOffer: offer,
    _reviseOffer: { teamId, offer, round: null },
    _raw: { onYes: 'lt_offer_send', onNo: 'lt_pass', onAuto: 'lt_pass' },
    ...extra,
  }), atMs);
}

/** Our next series against a club this season: when its last game is. */
function _nextSeriesEnd(st, teamId, atMs) {
  const games = (st.schedule || []).filter(g => g.opponentId === teamId && !g._committed && !g.isSpring && !g.isPlayoff
    && (g.gameTime || 0) > atMs).sort((a, b) => a.gameTime - b.gameTime);
  if (!games.length) return null;
  const first = games[0];
  const series = first.seriesId ? games.filter(g => g.seriesId === first.seriesId) : [first];
  return { firstAt: first.gameTime, endAt: series[series.length - 1].gameTime, games: series.length };
}

function _leagueTradeCards(tx, atMs) {
  const st = StateManager.get();
  const club = (id) => (st.leagueTeams || []).find(t => t.id === id);
  const A = club(tx.teamId), B = club(tx.fromTeamId);
  if (!A || !B) return 0;
  const P = (id) => st.players[id];
  const aGot = (tx.offer?.incomingIds || []).map(P).filter(Boolean);   // B → A
  const bGot = (tx.offer?.outgoingIds || []).map(P).filter(Boolean);   // A → B
  const year = baseballYear(st);
  const desk = st.tradeDesk || {};

  // 1. Someone beat us to a player we were talking about.
  for (const [seller, left, to] of [[B, aGot, A], [A, bGot, B]]) {
    const talk = Negotiation.talkWith(st, seller.id);
    if (!talk || !['waiting', 'countered', 'agreed'].includes(talk.status)) continue;
    const want = [...(talk.offer?.incomingIds || []), ...(talk.counter?.incomingIds || [])];
    const gone = left.find(p => want.includes(p.id));
    if (!gone) continue;
    withdrawTalkCards(seller.id);
    Negotiation.callOff(seller.id, atMs);
    const next = LeagueTrades.bestOption(StateManager.get(), (p) => _sameRole(p, gone), atMs, { excludeIds: new Set([gone.id]) });
    const lead = `${seller.name} traded ${_ref(gone)} to ${to.name} before our talks could finish — those talks are closed.`;
    if (next) {
      const nt = club(next.teamId), np = P(next.playerId);
      return _deliverIdea(StateManager.get(), {
        key: `lt:beaten:${tx.id}`, teamId: next.teamId, deal: next.deal, atMs: atMs + 2 * 3600_000,
        subject: `${to.name} beat us to ${gone.name}`,
        preview: `The next-best option: ${_ref(np)} of ${nt.name}.`,
        lead: `${lead} The next-best option we see is ${_ref(np)} of ${nt.name}.`,
        extra: { _beatenTalkId: talk.id },
      }) ? 1 : 0;
    }
    return _deliverWatchCard(`lt:beaten:${tx.id}`, {
      cardId: 'lt_beaten',
      subject: `${to.name} beat us to ${gone.name}`,
      preview: 'Nobody else fits the spot right now.',
      body: `${lead} We looked for the next-best option and nobody else fits the spot right now.`,
      spec: { type: 'role', pos: gone.pos, nativePos: gone.nativePos || gone.pos, excludeId: gone.id },
      what: `someone to fill ${gone.name}'s role`,
      atMs: atMs + 2 * 3600_000, extra: { _beatenTalkId: talk.id },
    }) ? 1 : 0;
  }

  // 2. A player we traded away was flipped: bring them back once they can be moved.
  const flipped = [...aGot, ...bGot].find(p => p._previouslyWithOrg && wouldStart(p, st, 'user'));
  if (flipped) {
    const now = aGot.includes(flipped) ? A : B, from = now === A ? B : A;
    const when = atMs + TRADE.noFlipMs + 3 * 3600_000;
    const deal = LeagueTrades.scoutPackage(st, now.id, flipped.id, when);
    if (deal) return _deliverIdea(st, {
      key: `lt:flipped:${tx.id}`, teamId: now.id, deal, atMs: when,
      subject: `${flipped.name} can be moved again`,
      preview: `${from.name} sent our former player to ${now.name}; a reunion is possible.`,
      lead: `${from.name} traded ${_ref(flipped)}, who played for us, to ${now.name}. A newly acquired player can't be moved for a few days; that window has passed, and ${flipped.name} would start for us.`,
    }) ? 1 : 0;
  }

  // 3. A division rival got better: advance scouting for our next series.
  const rival = [A, B].find(t => t.divisionId && t.divisionId === (st.userTeam.divisionId || 'A')
    && tx.why?.need && t.id === tx.teamId);
  if (rival) {
    const series = _nextSeriesEnd(st, rival.id, atMs);
    const star = aGot.sort((x, y) => (y.ovr || 0) - (x.ovr || 0))[0];
    if (series && star && !_cardsWithKey(st, `lt:rival:${rival.id}:${series.firstAt}`).length
        && atMs - (desk.lastRivalMs || -Infinity) >= LEAGUE_TRADES.rivalCardGapMs
        && (star.ovr || 0) >= LeagueTrades.leagueNorms(st).h + 3
        && (st.phase === PHASE.REGULAR_SEASON || st.phase === PHASE.TRADE_DEADLINE || st.phase === PHASE.ALL_STAR_BREAK)) {
      const scale = Math.max(0.5, Math.min(1.6, (st.userTeam.finances?.payrollTarget || CARD_MONEY_BASE_TARGET_K) / CARD_MONEY_BASE_TARGET_K));
      const cost = Math.max(10, Math.round(ADVANCE_SCOUT.costK * scale / 5) * 5);
      StateManager.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), lastRivalMs: atMs }; });
      return _deliverAt(_rosterCard(st, {
        cardId: 'lt_scout', tag: 'SCOUTING', sender: 'Pro Scouting', avatar: '🔎', type: 'normal',
        subject: `${rival.name} got better`,
        preview: `${rival.name} added ${_ref(star)} from ${B.name}. We see them next in ${Math.max(1, Math.round((series.firstAt - atMs) / 86_400_000))} days.`,
        body: `${rival.name}, in our division, traded for ${_ref(star)} from ${B.name}. `
            + `We play them next in a ${series.games}-game series. An advance scout can follow them until then (${formatK(cost)}): `
            + `our hitters would know what's coming and our pitchers how to work their lineup, for that series.`,
        yesLabel: `Send an Advance Scout (${formatK(cost)})`, noLabel: 'Not This Time',
        autoResolve: 'roster', expiresAtMs: Math.min(series.firstAt, atMs + 2 * 86_400_000),
        _rosterKey: `lt:rival:${rival.id}:${series.firstAt}`,   // one report offer per series
        _ltTeamId: rival.id, _ltCoversMs: series.endAt + 6 * 3600_000, _ltCostK: cost,
        _raw: { onYes: 'lt_scout', onNo: 'lt_pass', onAuto: 'lt_pass' },
      }), atMs + 3 * 3600_000) ? 1 : 0;
    }
  }

  // Opportunities: at most one every few days.
  if (atMs - (desk.lastIdeaMs || -Infinity) < _IDEA_GAP_MS) return 0;
  const markIdea = () => StateManager.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), lastIdeaMs: atMs }; });

  // 4. A club just sold: call them about the veterans still there.
  if (clubMode(st, B.id) === 'seller' && aGot.some(p => computeAge(p.dob, year) >= 30 || isRental(p, st))) {
    const vet = (p) => computeAge(p.dob, year) >= 29 || isRental(p, st);
    const opt = LeagueTrades.bestOption(st, vet, atMs, { excludeTeams: new Set((st.leagueTeams || []).filter(t => t.id !== B.id).map(t => t.id)) });
    if (opt) {
      const p = P(opt.playerId);
      if (_deliverIdea(st, {
        key: `lt:sold:${tx.id}`, teamId: B.id, deal: opt.deal, atMs: atMs + 3 * 3600_000,
        subject: `${B.name} are selling`,
        preview: `They just moved ${aGot[0].name}. ${_ref(p)} is still there.`,
        lead: `${B.name} just traded ${aGot.map(_ref).join(' and ')} to ${A.name} for younger pieces — they're selling. ${_ref(p)} is still there and would start for us.`,
      })) { markIdea(); return 1; }
    }
  }

  // 5. A club now has a surplus: the starter it just replaced.
  const was = tx.why?.need?.incumbentId && P(tx.why.need.incumbentId);
  if (was && !bGot.includes(was) && (A.rosterIds || []).includes(was.id) && wouldStart(was, st, 'user')) {
    const deal = LeagueTrades.scoutPackage(st, A.id, was.id, atMs);
    if (deal && _deliverIdea(st, {
      key: `lt:surplus:${tx.id}`, teamId: A.id, deal, atMs: atMs + 3 * 3600_000,
      subject: `${A.name} have a player to spare`,
      preview: `${aGot[0].name} takes over for ${was.name}, who would start for us.`,
      lead: `${A.name} traded for ${aGot.map(_ref).join(' and ')}, which leaves ${_ref(was)} without a regular spot there. ${was.name} would start for us.`,
    })) { markIdea(); return 1; }
  }
  return 0;
}

/**
 * §90 Pro Scouting works the phones for one of our needs: the best player on
 * another club who fills it and would start for us, with the package their
 * GM should take — an offer to make, adjust or pass on, a few hours later.
 */
function _workThePhones({ key, spec, what, atMs, sender = 'Pro Scouting', subjectNone }) {
  const st = StateManager.get();
  const at = atMs + Math.round((3 + Math.random() * 4) * 3600_000);
  const opt = LeagueTrades.bestOption(st, _fitsFor(spec, st), at, { excludeIds: new Set(spec.excludeId ? [spec.excludeId] : []) });
  if (!opt) {
    return _deliverWatchCard(`${key}:none`, {
      cardId: 'lt_none', sender,
      subject: subjectNone || 'Nothing out there right now',
      preview: `We worked the phones for ${what}; nothing fits.`,
      body: `We worked the phones for ${what}. Nobody available would be an upgrade at a price their club would take and our owner would carry.`,
      spec, what: what.replace(/ before the deadline$/, ''), atMs: at,
    });
  }
  const t = (st.leagueTeams || []).find(x => x.id === opt.teamId), p = st.players[opt.playerId];
  return _deliverIdea(st, {
    key, teamId: opt.teamId, deal: opt.deal, atMs: at, sender,
    subject: `${what[0].toUpperCase()}${what.slice(1)}: ${p.name}`,
    preview: `${_ref(p)} of ${t.name} is the best fit we found.`,
    lead: `We worked the phones for ${what}. The best fit is ${_ref(p)} of ${t.name}${isRental(p, st) ? ', in the last year of the contract' : ''}.`,
  });
}

// ── §99 "nobody fits right now": keep watching, or drop it ──────────────

const WATCH_DAYS = 14;

/** What a search is for, kept as data (it waits in state between days). */
function _fitsFor(spec, st) {
  if (!spec) return () => false;
  if (spec.type === 'need') return (p) => LeagueTrades.fillsNeed(p, spec.need) && (p.ovr || 0) >= (spec.minOvr || 0);
  if (spec.type === 'rp')   return (p) => p.pos === 'RP' && wouldStart(p, st, 'user');
  if (spec.type === 'role') return (p) => p.id !== spec.excludeId && _sameRole(p, { pos: spec.pos, nativePos: spec.nativePos });
  return () => false;
}

/**
 * A search that came up empty, as a decision: Pro Scouting keeps watching
 * (checks at every day's trade desk for two weeks and calls with the first
 * fit), or we drop it. Unanswered, it's dropped.
 */
function _deliverWatchCard(key, { subject, preview, body, spec, what, atMs, cardId = 'lt_none', sender = 'Pro Scouting', extra = {} }) {
  const st = StateManager.get();
  if (_cardsWithKey(st, key).length) return null;
  return _deliverAt(_rosterCard(st, {
    cardId, tag: 'TRADE', sender, avatar: '📞', type: 'normal',
    subject, preview,
    body: `${body} Pro Scouting can keep watching — checking every day for the next two weeks and calling as soon as someone fits — or we can drop it.`,
    yesLabel: 'Keep Watching', noLabel: 'Drop It',
    autoResolve: 'roster', expiresAtMs: atMs + 2 * 86_400_000,
    _rosterKey: key, _watch: { spec, what },
    _raw: { onYes: 'lt_watch', onNo: 'lt_pass', onAuto: 'lt_pass' },
    _autoLabel: 'No answer — dropped',
    ...extra,
  }), atMs);
}

/**
 * runWatches(atMs) — §99 at each day's trade desk, every search Pro Scouting
 * is keeping an eye on: the first fit becomes an offer card and ends the
 * watch; two weeks without one (or the window closing) ends it with a line
 * in Recent.
 */
export function runWatches(atMs) {
  const st = StateManager.get();
  const watches = st.tradeDesk?.watches || [];
  if (!watches.length) return 0;
  const keep = [], ended = [];
  let found = 0;
  for (const w of watches) {
    const cur = StateManager.get();
    if (w.untilMs <= atMs || !tradeWindow(cur).open) { ended.push(w); continue; }
    let hit = false;
    if (w.spec?.type === 'club') {
      const team = (cur.leagueTeams || []).find(t => t.id === w.spec.teamId);
      hit = !!team && _salaryCallOffer(cur, team, atMs, { intro: `${team.name} called back: their owner still wants payroll gone, and now there's a deal that works for both sides.` });
    } else {
      const opt = LeagueTrades.bestOption(cur, _fitsFor(w.spec, cur), atMs, { excludeIds: new Set(w.spec?.excludeId ? [w.spec.excludeId] : []) });
      if (opt) {
        const t = (cur.leagueTeams || []).find(x => x.id === opt.teamId), p = cur.players[opt.playerId];
        hit = !!_deliverIdea(cur, {
          key: `${w.key}:found`, teamId: opt.teamId, deal: opt.deal, atMs: atMs + Math.round((1 + Math.random() * 3) * 3600_000), sender: w.sender || 'Pro Scouting',
          subject: `Found: ${p.name}`,
          preview: `${_ref(p)} of ${t.name} — the fit we've been watching for.`,
          lead: `We've been watching for ${w.what}. ${_ref(p)} of ${t.name} now fits${isRental(p, cur) ? ', in the last year of the contract' : ''}.`,
        });
      }
    }
    if (hit) found++; else keep.push(w);
  }
  StateManager.mutate(s => {
    s.tradeDesk = { ...(s.tradeDesk || {}), watches: keep };
    if (ended.length) s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
      ...ended.map(w => buildActivityFeedEntry('milestone', s.userTeam.abbr, `Pro Scouting stopped watching for ${w.what} — nobody fit`, atMs))]);
  });
  return found;
}

/**
 * deliverDeadlineIdea(atMs) — §90 (replaces the dl3/dl4 cards): as the
 * deadline nears, Pro Scouting's best target for our biggest need, once a
 * season, when we're not selling.
 */
export function deliverDeadlineIdea(atMs) {
  const st = StateManager.get();
  const key = `lt:deadline:${st.seasonNum || 1}`;
  if (_cardsWithKey(st, key).length || _cardsWithKey(st, `${key}:none`).length) return null;
  if (clubMode(st, 'user') === 'seller') return null;
  const need = LeagueTrades.clubNeeds(st, 'user')[0];
  if (!need) return null;
  const what = need.kind === 'sp' ? 'a starting pitcher before the deadline'
    : need.kind === 'rp' ? 'a reliever before the deadline'
    : `a ${need.slot === 'DH' ? 'designated hitter' : need.slot} before the deadline`;
  return _workThePhones({ key, what, atMs, spec: { type: 'need', need: { kind: need.kind, slot: need.slot || null }, minOvr: need.ovr + 3 } });
}

function _applyLeagueTradeAction(action, instance, atMs) {
  if (action === 'lt_pass') return;
  if (action === 'lt_find_rp') {
    _workThePhones({ key: `lt:rp:${instance.instanceId}`, what: 'a reliever', atMs, spec: { type: 'rp' } });
    return;
  }
  if (action === 'lt_watch') {
    // §99 Pro Scouting keeps watching: checked at each day's trade desk.
    const w = instance._watch;
    if (!w) return;
    StateManager.mutate(s => {
      s.tradeDesk = { ...(s.tradeDesk || {}) };
      s.tradeDesk.watches = [...(s.tradeDesk.watches || []).filter(x => x.key !== instance._rosterKey),
        { key: instance._rosterKey, spec: w.spec, what: w.what, sender: instance.sender, startedAtMs: atMs, untilMs: atMs + WATCH_DAYS * 86_400_000 }];
    });
    return;
  }
  if (action === 'lt_offer_send') {
    const res = Negotiation.proposeTrade(instance._ideaTeamId, instance._ideaOffer, atMs);
    if (!res.ok) {
      _deliverNotice(`lt:unsent:${instance.instanceId}`, {
        cardId: 'lt_unsent', tag: 'TRADE', sender: 'Pro Scouting', avatar: '📞',
        subject: 'The offer couldn\'t go out',
        preview: `It couldn't be sent: ${res.reason}.`,
        body: `We went to make the offer, but it couldn't be sent: ${res.reason}.`,
      }, atMs);
    }
    return;
  }
  if (action === 'lt_scout') {
    const cost = instance._ltCostK || 0;
    if (!Finance.canSpend(StateManager.get(), cost)) {
      _deliverNotice(`lt:noscout:${instance.instanceId}`, {
        cardId: 'lt_noscout', tag: 'SCOUTING', sender: 'Pro Scouting', avatar: '🔎',
        subject: 'No advance scout this time', preview: 'Club funds can\'t cover the trip.',
        body: 'Club funds can\'t cover the advance scout\'s trip right now.',
      }, atMs);
      return;
    }
    StateManager.mutate(s => {
      Finance.post(s.userTeam.finances, -cost, 'cards', `Advance scouting — ${(s.leagueTeams || []).find(t => t.id === instance._ltTeamId)?.name || 'a rival'}`, atMs);
      s.userTeam.advanceReports = { ...(s.userTeam.advanceReports || {}),
        [instance._ltTeamId]: { coversThroughMs: instance._ltCoversMs, boughtAtMs: atMs } };
    });
  }
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

/**
 * Ownership's season review (§78): the record against the target, the books
 * (the season's profit or loss, funds carried into next year, any shortfall
 * the owner covered, any cut orders missed) — and next season's payroll target.
 */
export function deliverOwnershipCard(offer, atMs, expiresAtMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  const last  = (state.seasonHistory || [])[state.seasonHistory.length - 1] || {};
  const books = (state.userTeam.finances?.history || []).slice(-1)[0] || null;
  const dir   = offer.pct > 0.005 ? 'raise' : offer.pct < -0.005 ? 'trim' : 'hold';
  const net   = books ? books.net : 0;
  const booksLine = books
    ? `The books: ${net >= 0 ? `a profit of ${formatK(net)}` : `a loss of ${formatK(-net)}`} on the season`
      + `${books.covered ? `, and ownership covered a ${formatK(books.covered)} shortfall to bring funds back to zero` : ''}. `
      + `Club funds going into next season: ${formatK(offer.funds)}. `
    : '';
  const penaltyLine = offer.penaltyPct > 0
    ? `Ownership hasn't forgotten the payroll cuts it asked for and didn't get — that's reflected below. ` : '';
  const card = _rosterCard(state, {
    cardId: 'os_ownership', tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: 'urgent',
    _rosterKey: `os:ownership:${state.seasonNum}`, _osGate: 'ownership', _offer: offer,
    subject: "Season review — next year's payroll",
    preview: `${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses}`
           + `${books ? `, ${net >= 0 ? '+' : '−'}${formatK(Math.abs(net))} on the books` : ''}. Ownership wants to ${dir} the payroll target.`,
    body: `We finished ${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses} against a target of ${last.winTarget ?? '—'} wins`
        + `${last.postseason?.result && last.postseason.result !== 'Did not qualify' ? ` (${last.postseason.result.toLowerCase()})` : ''}. `
        + booksLine + penaltyLine
        + `For next season ownership is setting a payroll target of ${formatK(offer.payrollTarget)} (was ${formatK(offer.prevPayrollTarget)}). `
        + `Next season's win target: ${offer.winTarget}. You can accept, or push for 4% more at a cost to ownership's trust. `
        + `If there's no answer by the time spring training opens, ownership decides — and it will be tighter.`,
    yesLabel: 'Accept the target', noLabel: 'Push for more',
    expiresAtMs,
    _raw: { onYes: 'os_owner_accept', onNo: 'os_owner_push', onAuto: 'os_owner_auto' },
    _autoLabel: 'No answer — ownership set a tighter target',
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
  const target = Finance.seasonTarget(state.userTeam.finances);
  const delta = terms.salary - (p.contractSalary || 0);
  const card = _rosterCard(state, {
    cardId: 'os_resign', tag: 'CONTRACT', sender: `${p.name}'s agent`, avatar: '✍️', type: 'normal',
    _rosterKey: `os:resign:${playerId}:${state.seasonNum}`, _osGate: 'contracts', _targetPlayerId: playerId,
    subject: `${p.name}'s contract is up`,
    preview: `Asking ${formatK(terms.salary)} a year for ${_years(terms.years)}.`,
    body: `${_who(p)}, ${age} next season, becomes a free agent unless we re-sign. The ask is ${formatK(terms.salary)} a year for ${_years(terms.years)}`
        + ` (up from ${formatK(p.contractSalary || 0)}). That ${delta >= 0 ? 'adds' : 'saves'} ${formatK(Math.abs(delta))} — payroll is ${formatK(payroll)} against ownership's ${formatK(target)} target. `
        + `If we let ${p.name} walk, every club gets a shot on the free-agent market. No answer by the time spring training opens means the same thing.`,
    yesLabel: `Re-sign (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: `Let ${p.name} walk`,
    expiresAtMs,
    _raw: { onYes: 'os_resign', onNo: 'os_walk', onAuto: 'os_walk_auto' },
    _autoLabel: `No answer — ${p.name} walked`,
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
    preview: 'The manager\'s contract is up. Extend, or open a search?',
    body: `${m.name || 'The manager'}'s contract is up after a ${last.wins ?? '—'}–${last.losses ?? '—'} season. `
        + `A ${_years(MANAGER_EXTENSION_YEARS_UI)} extension keeps the clubhouse steady (salary up 5%). Opening a search brings in a new voice — and some uncertainty. `
        + `With no decision by the time spring training opens, ${m.name || 'the manager'} stays on a one-year deal — knowing we didn't choose to extend.`,
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
    // §78: only free agents ownership would pay for (a displaced major-league
    // contract is still paid in the farm — no credit for him).
    const outK = room && !room.contractMLB ? (room.contractSalary || 0) : 0;
    if (!Finance.canAddSalary(state, terms.salary, outK)) continue;
    const age = computeAge(p.dob, baseballYear(state) + 1);
    const from = (state.leagueTeams || []).find(x => x.id === p._faFrom)?.name || (p._faFrom === 'user' ? 'us' : null);
    const card = _rosterCard(state, {
      cardId: 'os_free_agent', tag: 'FREE_AGENT', sender: 'Pro Scouting', avatar: '🔎', type: 'good',
      _rosterKey: `os:fa:${p.id}:${state.seasonNum}`, _targetPlayerId: p.id,
      subject: `Free agent: ${p.name}`,
      preview: `${p.nativePos || p.pos}, OVR ${p.ovr}, ${age} — ${t.reason}.`,
      body: `${_who(p)}, ${age} next season${from ? `, formerly with ${from}` : ''}, is on the market — ${t.reason}. `
          + `The ask is ${formatK(terms.salary)} a year for ${_years(terms.years)}. `
          + (room ? `Our 28 is full, so ${room.name} (OVR ${room.ovr}) would go to the farm to make room. ` : '')
          + `Other clubs are looking too — if ${p.name} signs elsewhere this offer disappears.`,
      yesLabel: `Sign (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Pass',
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
    body: `${_who(p)} told us it's time to retire, at ${age}, after ${p.careerStats?.seasons || 1} season${(p.careerStats?.seasons || 1) === 1 ? '' : 's'}. The roster spot is open.`,
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
        + `A ${formatK(terms.bonus)} bonus gets the deal done, with a spot in our farm system.`,
    yesLabel: `Sign (${formatK(terms.bonus)})`, noLabel: 'Pass',
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
    body: `${verdict} with ${_who(p)}. The work is done for now — OVR ${p.ovr}.`,
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
  'talk_finalize', 'talk_backout', 'talk_take_counter', 'talk_walk', 'talk_ask', 'talk_move_on', 'talk_keep_open',
  // §90 league trades that touch us
  'lt_offer_send', 'lt_pass', 'lt_scout', 'lt_find_rp', 'lt_watch',
  'fin_call_club',
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
  // §78 the owner's cut orders
  'fin_dump_yes', 'fin_dump_no',
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
  if (action.startsWith('fin_')) { _applyFinanceAction(action, instance, atMs); return; }
  if (action.startsWith('talk_')) { _applyTalkAction(action, instance, atMs); return; }
  if (action.startsWith('lt_')) { _applyLeagueTradeAction(action, instance, atMs); return; }
  if (action.startsWith('wx_')) { _applyWeatherAction(action, instance, atMs); return; }
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
      // §85 the deal must still be makeable (the window, a player just
      // acquired, someone hurt or moved since it was offered).
      const blocked = tradeBlockers(offer, state, atMs, proposer);
      if (blocked) {
        _deliverNotice(`trade:off:${instance.instanceId}`, {
          cardId: 'trade_off', tag: 'TRADE', sender: 'Pro Scouting', avatar: '📞', type: 'normal',
          subject: 'The trade can\'t go through',
          preview: `The deal is off: ${blocked}.`,
          body: `We went to finalize it, but the deal is off: ${blocked}.`,
          yesLabel: 'Understood', expiresAtMs: atMs + 2 * 86_400_000,
        }, atMs);
        break;
      }
      // §78: ownership approves added salary — its patience may have run out
      // since the offer arrived.
      if (!_tradeSalaryOk(state, offer)) {
        const d = _tradeSalaryDelta(state, offer);
        _deliverNotice(`owner:tradeBlocked:${instance.instanceId}`, {
          cardId: 'owner_trade_blocked', tag: 'OWNERSHIP', sender: state.userTeam.ownerName || 'Ownership', avatar: '💼', type: 'urgent',
          subject: 'Ownership blocked the trade',
          preview: `It adds ${formatK(d.inK - d.outK)} in salary — more than ownership will approve right now.`,
          body: `The deal would have added ${formatK(d.inK - d.outK)} a year to the payroll. With the books where they are, ownership won't approve it. `
              + `Clear some salary first, or find a deal that pays for itself.`,
          yesLabel: 'Understood', expiresAtMs: atMs + 2 * 86_400_000,
        }, atMs);
        break;
      }
      // One ledger record; it executes on the roster clock (§65).
      StateManager.mutate(s => {
        s.transactions = [...(s.transactions || []), queueTrade(offer, proposer, atMs)];
      });
      break;
    }

    case 'trade_decline': {
      const proposer = instance._proposingTeamId;
      if (!proposer) break;
      // §85 that club cools off for a couple of days (real time).
      StateManager.mutate(s => { startCooldown(s, proposer, atMs); });
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
