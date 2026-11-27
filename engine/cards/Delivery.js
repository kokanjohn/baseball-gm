/**
 * engine/cards/Delivery.js
 * CardEngine, delivery: the main loop, timed delivery, the follow-up queue, notification scheduling, _deliverAt.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { offDayWindow } from '../AwayDays.js';
import { PHASE, PITCHER_HAND_DISPLAY, CARD_DAY, COMPOSE_OVERLAP, STAFF_QUIET, MORNING, STORY_PACE, AWAY_DAY, REGULAR_SEASON_GAME_COUNT } from '../../data/constants.js';
import * as When from '../When.js';
import { planDeliveryTimes } from '../CardScheduler.js';
import { clockNow } from '../Clock.js';
import { dice, diceId, diceSeed, eventRand } from '../Dice.js';
import { _filterEligible, _logDealt, _repeatRule, cardDebug } from './CardLog.js';
import { _maybeDeliverCashSale } from './Compose.js';
import { _uuid } from './Helpers.js';
import { ALL_POOLS, MAX_INBOX_SIZE, PHASE_POOLS, POOL_MOMENT } from './Pools.js';
import { _expireCards } from './Resolution.js';
import { _createInstance, _selectCards } from './Selection.js';

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
    pregame: eventRand() < CARD_DAY.pregameChance ? 1 : 0,
    ingame:  eventRand() < CARD_DAY.ingameChance  ? 1 : 0,
    between: CARD_DAY.betweenMin + (eventRand() < CARD_DAY.betweenExtraChance ? 1 : 0),
    leave:   eventRand() < CARD_DAY.leaveChance   ? 1 : 0,
    // r217 §122.96 a day with no game before the next one brings its own messages; a road game day, one more.
    offday:  0,
    road:    0,
  };
  const nextT = Number.isFinite(context.nextGame?.gameTime) ? context.nextGame.gameTime : null;
  const offDay = byMoment.offday ? offDayWindow(state, clockNow(), nextT) : null;
  if (offDay) want.offday = (eventRand() < AWAY_DAY.offday ? 1 : 0) + (eventRand() < AWAY_DAY.offdayExtra ? 1 : 0);
  if (byMoment.road && context.nextGame && !context.nextGame.isHome && !context.nextGame.isSpring && !context.nextGame.isPlayoff) {
    want.road = eventRand() < AWAY_DAY.road ? 1 : 0;
  }
  const delivered = [];
  const taken = new Set();
  // r214 §122.93 the once-a-season stories, paced over the regular season (so the last weeks aren't bare).
  const pace = _storyPace(state, context);
  const takenFamilies = new Set();   // §94 one version of a family a season — across today's moments too
  const takenStories = new Set();    // §122.60 and one card of a story (`_story`) a day: its log isn't written until it's scheduled
  for (const moment of ['pregame', 'ingame', 'between', 'leave', 'road', 'offday']) {
    const pools = byMoment[moment];
    let n = Math.min(want[moment], room - delivered.length);
    if (!pools || (n <= 0 && !cardDebug.onEligible)) continue;
    const eligible = [];
    for (const poolName of pools) {
      for (const card of _filterEligible(ALL_POOLS[poolName] || [], context, state, poolName)) {
        if (!taken.has(card.id) && !(card._family && takenFamilies.has(card._family)) && !(card._story && takenStories.has(card._story))) eligible.push({ ...card, _fromPool: poolName });
      }
    }
    if (cardDebug.onEligible) cardDebug.onEligible(moment, eligible.map(c => c.id));
    if (n <= 0) continue;
    // §122.57 the draw in weighted order: a card that can't be made right now (no free agent fits, nobody to spare) gives
    // its place to the next one, so the moment still gets its card.
    let made = 0;
    for (const cardDef of _selectCards(eligible, context, state, eligible.length)) {
      if (made >= n) break;
      if (taken.has(cardDef.id) || (cardDef._family && takenFamilies.has(cardDef._family)) || (cardDef._story && takenStories.has(cardDef._story))) continue;
      const story = pace && moment === 'between' && pace.isStory(cardDef);
      if (story && pace.credit < 1) continue;   // (its day comes later in the season)
      taken.add(cardDef.id);
      if (cardDef._family) takenFamilies.add(cardDef._family);
      if (cardDef._story) takenStories.add(cardDef._story);
      const { _fromPool, ...def } = cardDef;
      const instance = _createInstance(def, context, state);
      if (instance) { delivered.push({ ...instance, _pool: _fromPool, _moment: moment, ...(moment === 'offday' ? { _offDay: offDay } : {}) }); made++; if (story) pace.credit -= 1; }
      else if (cardDebug.onDropped) cardDebug.onDropped(def.id);
    }
  }
  if (pace) StateManager.mutate(s => { s.storyPace = { season: state.seasonNum || 1, credit: pace.credit }; });

  if (delivered.length === 0) return;

  // 5. Schedule for real-world delivery (§61): pre-game cards before first
  // pitch, in-game cards while the game is played, the rest between games.
  // releaseDueCards() moves each into the inbox when its time comes; the same
  // schedule is synced to the push worker so it arrives with the app closed.
  _scheduleCards(delivered, state, context.nextGame || null);
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

export const _hand = (p) => (['SP', 'RP'].includes(p?.pos) ? ` ${PITCHER_HAND_DISPLAY[p.hand] || '(R)'}` : '');

export const _clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// r149 relative to the moment the card lands, never a calendar date: "tomorrow", "Saturday", "in 9 days".
export const _day   = (ms, fromMs) => When.untilDay(ms, fromMs);

export const _randBetween = (lo, hi) => lo + Math.floor(eventRand() * (hi - lo + 1));


export function _rosterCard(state, fields) {
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
export function _cardsWithKey(state, key) {
  return [...(state.inbox || []), ...(state.scheduledCards || [])].filter(c => c._rosterKey === key);
}


/** Park a roster card for delivery at `atMs` (push-synced like every card). */
export function _deliverAt(instance, atMs) {
  const state = StateManager.get();
  const same = _cardsWithKey(state, instance._rosterKey);
  if (same.some(c => !c.resolved)) return null;
  // r238 §122.117 the GM already asked for this in Compose
  const topic = COMPOSE_OVERLAP.cards[instance.cardId];
  if (topic && askedInCompose(state, topic, atMs)) return null;
  // r139 §121 a roster card's id comes from what it is about (its key, and
  // how many came before it), so the look-ahead and the real clock agree.
  const instanceId = instance._rosterKey ? diceId(dice(diceSeed(state), 'roster-card', instance._rosterKey, same.length)) : instance.instanceId;
  const card = { ...instance, instanceId, deliverAtMs: _morningIfItCanWait(state, instance, atMs) };
  StateManager.mutate(s => {
    s.scheduledCards = [...(s.scheduledCards || []), card].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    _logDealt(s, card);   // §122.57 (a follow-up, a pool card delivered by hand)
  });
  return card;   // (the card as parked — with the id it will have in the inbox)
}


/**
 * r214 §122.93 The between-games pool, paced over the regular season: each game day adds a credit of (what the pool
 * still has to give this season — a story once, a card that comes back up to its limit — ÷ the regular-season games
 * left, × `STORY_PACE.share` for the cards whose moment never comes); a card is drawn only on a whole credit. So the
 * pool lasts to the last game rather than running dry in August. Returns { credit, isStory } or null (spring, the
 * postseason, the offseason: not paced).
 */
function _storyPace(state, context) {
  if (![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK].includes(state.phase)) return null;
  const season = state.seasonNum || 1;
  const log = state.cardLog || {};
  const left = Math.max(1, REGULAR_SEASON_GAME_COUNT - (context.regularSeasonIndex || 0));
  let supply = 0;
  for (const n of (PHASE_POOLS[state.phase] || []).filter(x => (POOL_MOMENT[x] || 'between') === 'between')) {
    for (const c of ALL_POOLS[n] || []) {
      if (!c || c._retired || c._requiresSpring || c._intlFollowupOnly) continue;
      const rule = _repeatRule(c, n);
      supply += Math.max(0, (rule.once ? 1 : (rule.max || 1)) - (log[c.id]?.n?.[season] || 0));
    }
  }
  const prev = state.storyPace?.season === season ? state.storyPace.credit : 1;
  return { credit: Math.min(STORY_PACE.cap, prev + STORY_PACE.share * supply / left), isStory: () => true };
}


/**
 * r214 §122.93 A message the staff write in the night (after a night game, mostly) that can wait comes in the morning
 * instead, between 8 and 9:30 (the staff's working day starts then), if its answer isn't due before 10. Only the
 * staff's own looks after a game (`MORNING.cards`: the rest question, roster advice, a lineup nudge): never an
 * emergency, an injury, the weather, a trade, a reply, or anything answering what the GM just did (an open spot).
 * Deterministic (the card's own dice), so the look-ahead foresees it exactly.
 */
function _morningIfItCanWait(state, card, atMs) {
  const h = new Date(atMs).getHours();
  if (h >= 8 && h < 22) return atMs;
  if (!MORNING.cards.includes(card.cardId) || card._urgent) return atMs;   // the staff's own looks only
  const wake = new Date(atMs); if (h >= 22) wake.setDate(wake.getDate() + 1); wake.setHours(8, 0, 0, 0);
  const at = wake.getTime() + Math.floor(dice(diceSeed(state), 'morning', card._rosterKey || card.cardId || '', atMs)() * MORNING.spreadMs);
  if (Number.isFinite(card.expiresAtMs) && card.expiresAtMs < at + MORNING.dueAfterMs) return atMs;
  return at;
}


/** For the checks: park a card the way the roster clock does (r214). */
export const _testDeliverAt = (card, atMs) => _deliverAt(card, atMs);


/** Remove unresolved cards matching `pred` from the inbox and the schedule. */
/**
 * r238 §122.117 whether the GM asked this Compose question: a reply still on its way, or one that came in the last
 * COMPOSE_OVERLAP.days.
 */
export function askedInCompose(state, topicId, atMs = clockNow()) {
  if ((state.scheduledCards || []).some(c => c.isCompose && c._composeTopic === topicId)) return true;
  return (state.inbox || []).some(c => c.isCompose && c._composeTopic === topicId
    && atMs - (c._sentAtMs ?? c.deliverAtMs ?? 0) < COMPOSE_OVERLAP.days * 86_400_000);
}


export function _withdraw(pred) {
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
export function _scheduleCards(instances, state, game = null) {
  if (!instances?.length) return;
  const nowMs = clockNow();
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
      timed.push({ ...c, deliverAtMs: nowMs + lead + eventRand() * 30 * 60_000 });
    } else if (c._raw?._isPreGame30 && c._moment === 'pregame') {
      // §122.57 the half hour before first pitch: 12–30 minutes out, answered by first pitch.
      if (!Number.isFinite(T) || T - nowMs < lead + 15 * 60_000) continue;
      timed.push({ ...c, _gameTime: T, deliverAtMs: Math.max(nowMs + lead, T - (12 + eventRand() * 18) * 60_000), expiresAtMs: T });
    } else if (c._moment === 'pregame' || (!c._moment && c._pool === 'PREGAME_POOL')) {
      if (!Number.isFinite(T) || T - nowMs < lead + 15 * 60_000) continue;
      timed.push({ ...c, _gameTime: T, deliverAtMs: Math.max(nowMs + lead, T - (45 + eventRand() * 105) * 60_000), expiresAtMs: T });
    } else if (c._moment === 'offday' && c._offDay) {
      // r217 §122.96 the off day's messages: during that day's working hours.
      const { startMs } = c._offDay;
      let { endMs } = c._offDay;
      // r254 §122.133 a message with a time of day in it (a tee time at one, a pickup at noon) arrives by
      // `_offDayBy` (local hour); past that, the day has gone on without it.
      const by = c._raw?._offDayBy;
      if (Number.isFinite(by)) { const d = new Date(startMs); d.setHours(by, 0, 0, 0); endMs = Math.min(endMs, d.getTime()); }
      if (endMs <= startMs) continue;
      const at = startMs + Math.floor(eventRand() * Math.max(0, endMs - startMs));
      const { _offDay, ...card } = c;
      const ttl = c._expiresAfterMs || c._raw?._expiresAfterMs;
      timed.push({ ...card, deliverAtMs: at, ...(ttl ? { expiresAtMs: at + ttl } : {}) });
    } else if (c._moment === 'ingame' || (!c._moment && c._pool === 'INGAME_POOL')) {
      if (!Number.isFinite(T)) continue;
      const at = Math.max(nowMs + lead, T + (20 + eventRand() * 100) * 60_000);
      if (at > T + CARD_DAY.ingameLastMs) continue;          // the game is over by then
      // (§122.57 _gameTime: retimed to the game as played — a held start, a delay — or withdrawn if it's called off)
      timed.push({ ...c, _gameTime: T, _ingameAt: at - T, deliverAtMs: at, expiresAtMs: T + CARD_DAY.ingameExpireMs });
    } else loose.push(c);
  }
  if (timed.length) {
    StateManager.mutate(s => {
      s.scheduledCards = [...(s.scheduledCards || []), ...timed].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
      for (const c of timed) _logDealt(s, c);
    });
  }
  instances = loose;
  if (!instances.length) return;
  const times = planDeliveryTimes(instances.length, {
    nowMs,
    windowEndMs: Number.isFinite(T) && T - nowMs >= 45 * 60_000 ? T : _nextGameTime(state, nowMs),
    ...STAFF_QUIET,   // r213 §122.91 the staff's working day
  });
  // planDeliveryTimes returns ascending times; shuffle the pairing so card
  // order in the pool doesn't dictate arrival order.
  const order = instances.map(c => ({ c, r: eventRand() })).sort((a, b) => a.r - b.r);
  const scheduled = order.map(({ c }, i) => ({ ...c, deliverAtMs: times[i],
    ...(c._expiresAfterMs ? { expiresAtMs: times[i] + c._expiresAfterMs } : {}) }));
  StateManager.mutate(s => {
    s.scheduledCards = [...(s.scheduledCards || []), ...scheduled]
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    for (const c of scheduled) _logDealt(s, c);
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
