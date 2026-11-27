/**
 * engine/cards/Selection.js
 * CardEngine, tokens, eligibility, weighted selection, card instances.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import * as GMP from '../GMProfile.js';
import { ARCHETYPE_CARD_WEIGHTS, PROFILE } from '../../data/constants.js';
import { selectCardVariant } from '../NarrativeEngine.js';
import { buildTokenMap, applyTokens, hasUnresolvedTokens, formatK, playerTokenValues, intlTypeOf } from '../CardTokens.js';
import { cardFeasible } from '../CardActions.js';
import { addToMarket, signingTerms } from '../MarketEngine.js';
import { clockNow } from '../Clock.js';
import { eventRand } from '../Dice.js';
import { _hand } from './Delivery.js';
import { _uuid } from './Helpers.js';
import { _addDropChoices } from './PlayerCards.js';
import { compose as composeParts } from '../MessageParts.js';   // r294 §122.177

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
// CARD SELECTION (weighted random)
// ─────────────────────────────────────────────────────────────

/** §122.56 how much more often season-ticket holders complain, per poor weather call at home in the last two weeks (up to three). */
const STH_BOOST = Object.freeze({ perPoorCall: 1.0, windowDays: 14, max: 3 });

/** §122.56 poor weather calls at home in the last two weeks (CardEngine.noteWeatherCall's record), up to three. */
export function recentPoorCalls(state, atMs = clockNow()) {
  return Math.min(STH_BOOST.max, (state.userTeam?.wxCalls || []).filter(c => c.poor && c.atMs > atMs - STH_BOOST.windowDays * 86_400_000 && c.atMs <= atMs).length);
}


const TIMELY_WEIGHT = 3;

const _TIMELY_KEYS = ['_requiresSpring', '_beforeDeadline', '_when', '_requiresBelowFifty', '_requiresLoseStreak', '_minStreak',
  '_requiresDivClose', '_requiresLossGap', '_requiresTravelDay', '_requiresHomeStandOpener', '_requiresHomeStandCloser',
  '_requiresRoadTripOpener', '_requiresAway', '_requiresSponsor', '_maxSpringGame', '_requiresDeadlineWindow'];

function _timely(card) {
  if (_TIMELY_KEYS.some(k => card[k] != null && card[k] !== false)) return true;
  return card._maxGames != null && card._maxGames - (card._minGames || 0) <= 20;
}


/** r219 §122.98 Does the profile lean as far as the card needs ({ dim: { min } | { max } })? */
export function _profileFits(need, prof) {
  return Object.entries(need).every(([k, r]) => (r.min == null || (prof[k] ?? 0) >= r.min) && (r.max == null || (prof[k] ?? 0) <= r.max));
}


/**
 * r219 §122.98 How the GM's profile weighs a pool card: an ask with a price (spender; and a month of holding back the
 * small asks, `spendFreezeUntil`), a community ask (communityFocused), a trade or a signing (aggressive), a player's
 * development (processDriven).
 */
const _DEV_ACTIONS = new Set(['train_hitter', 'train_pitcher_sp', 'train_pitcher_bp', 'offday_session', 'coach_work', 'who_work', 'dev_program', 'teach_position', 'sim_games']);

export const profileWeightForChecks = (card, state) => _profileWeight(card, GMP.profile(state), state);

function _profileWeight(card, prof, state) {
  const W = PROFILE.weight;
  let m = 1;
  if (card._budgetCost != null && !card._revenueToken) {
    m *= 1 + W.spender * prof.spender;
    if ((state.userTeam?.spendFreezeUntil || 0) > clockNow()) m *= PROFILE.freezeWeight;
  }
  if ((card.yesEffect?.atmo || 0) >= 2 && card.tag === 'MARKETING' && !card._revenueToken) m *= 1 + W.communityFocused * prof.communityFocused;
  if (card.tag === 'TRADE' || card.tag === 'SIGNING') m *= 1 + W.aggressive * prof.aggressive;
  if (card.tag === 'TRAINING' || _DEV_ACTIONS.has(card.onYes)) m *= 1 + W.processDriven * prof.processDriven;
  return Math.max(0.2, m);
}


export function _selectCards(eligible, context, state, maxCount) {
  if (eligible.length === 0) return [];

  const archetypeId = state.archetype;
  const weights     = ARCHETYPE_CARD_WEIGHTS[archetypeId] || {};
  const prof        = GMP.profile(state);   // r219 §122.98

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

    // §122.57 a card whose moment is narrow (spring, the run-up to the deadline, a losing streak, the club's situation,
    // a travel day) is the one to send while it's true: the everyday cards wait.
    if (_timely(card)) weight *= TIMELY_WEIGHT;

    // §122.56 season-ticket holders complain regardless, and more after poor weather calls at home.
    if (card._sth) weight *= 1 + STH_BOOST.perPoorCall * recentPoorCalls(state);

    // r219 §122.98 what the club has come to expect of this GM: more of the asks they say yes to, fewer of the rest.
    weight *= _profileWeight(card, prof, state);

    return { card, weight };
  });

  // Weighted random selection without replacement
  const selected = [];
  const pool     = [...scored];

  for (let i = 0; i < Math.min(maxCount, pool.length); i++) {
    const total  = pool.reduce((s, item) => s + item.weight, 0);
    let r        = eventRand() * total;
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

export function _createInstance(cardDef, context, state) {
  // r294 §122.177 a message in parts is put together first (MessageParts); any other comes back as it is
  cardDef = composeParts(cardDef, state, clockNow());
  if (!cardDef) return null;
  const gameIdx   = state.currentGameIndex || 0;
  const ttl       = cardDef._ttl ?? 3;
  const expiresAt = ttl > 0 ? gameIdx + ttl : null;

  // ONE token map for every field of this card (§60): same player, same
  // sponsor, same dollar amounts in subject, body, labels and outcome messages.
  const { values, amountsK, players: tokenPlayers, group, counts, newPlayers, offer, missingPlayer } = buildTokenMap(cardDef, context, state);
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
  // r297 §122.183 a situation's own facts (around the game: the opponent's hot bat, a player's last week…)
  if (context?._facts) { Object.assign(values, context._facts.values || {}); Object.assign(amountsK, context._facts.amountsK || {}); }
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

  // §122.57 a notice with nothing to decide (both answers the same) reads like the other notices: one "Understood".
  const notice = !!cardDef._toastOnly || (!!cardDef.yesLabel && cardDef.yesLabel === cardDef.noLabel);
  if (notice) { text.yesLabel = 'Understood'; text.noLabel = null; }

  // r219 §122.98 a GM who lets the staff decide is told what they'll do: the default, in the sender's voice.
  if (!notice && cardDef.noLabel && ['yes', 'no'].includes(cardDef.autoResolve)) {
    const prof = GMP.profile(state);
    if (prof.handsOn <= PROFILE.delegateAt && prof._n >= 20) {
      const label = cardDef.autoResolve === 'yes' ? text.yesLabel : text.noLabel;
      const person = /^\{\w+_name\}/.test(cardDef.sender || '') || /\(.+\)$/.test(cardDef.sender || '') || cardDef.sender === '{owner_name}';
      if (label && !cardDef.relay) text.body = `${text.body} If ${person ? 'I don\'t' : 'we don\'t'} hear back, ${person ? 'I\'ll' : 'we\'ll'} go with “${label}.”`;
    }
  }

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
    relay:            cardDef.relay ? t(cardDef.relay) : null,   // r158 whose words the sender passes on (§122.30)
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
    ...(cardDef._aboutOtherGm && values._otherGmTeamId ? { _gmTeamId: values._otherGmTeamId } : {}),   // r217 §122.96 another club's GM
    _season:          state.seasonNum || 1,
    autoResolve:      notice ? 'yes' : (cardDef.autoResolve || null),
    autoResolveTax:   notice ? null : (cardDef.autoResolveTax || null),
    _playerRelationshipEffect: cardDef._playerRelationshipEffect || null,
    _budgetCost:      budgetCostK,
    _budgetCostNo:    budgetCostNoK,
    _revenueK:        revenueK,
    _expiredSeason:   state.seasonNum,
    _targetPlayerId:  target.playerId,
    _targetRole:      target.role,
    _groupPlayerIds:  group || [],   // r270 §122.149 the players a `_group` card names
    // §71: the number of games the card's text promises (e.g. a suspension).
    _actionGames:     cardDef._gamesToken ? (counts?.[cardDef._gamesToken] ?? null) : null,
    _tokenPlayers:    tokenPlayers || {},
    _offer:           offer || null,
    _amountsK:        amountsK,
    _intlCountry:     values.intl_country || null,
    _raw:             cardDef,
    ...(cardDef._parts ? { _from: cardDef._from, _parts: cardDef._parts, ...(cardDef._partsRound ? { _partsRound: cardDef._partsRound } : {}), ...(cardDef._partsRelaxed ? { _partsRelaxed: cardDef._partsRelaxed } : {}) } : {}),   // r294 §122.177 whose history, the versions used
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
  // §122 a scouting find exists only for this card: sign him, or he's gone (_scoutFindsGone).
  if ((newPlayers || []).length) StateManager.mutate(s => { for (const p of newPlayers) addToMarket(s, { ...p, _scoutFind: true }, clockNow()); });
  _addDropChoices(StateManager.get(), instance);
  return instance;
}


/**
 * _cardTarget(cardDef, tokenPlayers)
 * The player a pool card is about (§71): the first player-role token its text
 * names. Its action, its OVR effect and its withdrawal all follow that man.
 */
export const _ROLE_TOKEN = /\{(active_sp|active_bp|active_pitcher|active_hitter|active_catcher|farm_pitcher|farm_hitter|leader_player|act_hi|pl_player|active_farm)_(?:name|pos|who)?(?:_tr)?\}|\{(act_hi|bg12_player)\}/;

function _cardTarget(cardDef, tokenPlayers = {}) {
  const text = [cardDef.subject, cardDef.preview, cardDef.body].filter(Boolean).join(' ');
  const m = text.match(_ROLE_TOKEN);
  if (!m) return { role: null, playerId: null };
  let role = m[1] || m[2];
  if (role === 'act_hi') role = 'active_hitter';
  const id = role === 'active_farm' ? (tokenPlayers.farm_hitter || tokenPlayers.farm_pitcher) : tokenPlayers[role];
  return { role, playerId: id || null };
}
