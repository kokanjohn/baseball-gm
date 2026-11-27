/**
 * engine/cards/CardLog.js
 * CardEngine, the card log (§122.57): how often each pool card was dealt, when, and the GM's last answer.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import { DECISIONS_POOL } from '../../data/cards-pool.js';
import { hometownPlayer, PARK_EVENT_IDS } from '../AwayDays.js';
import * as GMP from '../GMProfile.js';
import { PHASE, PLAYER_GROUP, TRADE_DEADLINE_OPEN, TRADE_DEADLINE_CLOSE } from '../../data/constants.js';
import { bullpenRecentERA } from '../CardTokens.js';
import { isAvailable } from '../PlayerFactory.js';
import { clockNow } from '../Clock.js';
import { sameOpponent } from '../Opponents.js';
import { rainHolds } from '../FieldCare.js';
import { _hasBenchSP, _hasPositionCoverage } from './Helpers.js';
import { ALL_POOLS } from './Pools.js';
import { _cardActionsHandled } from './ScoutingTips.js';
import { _ROLE_TOKEN, _profileFits } from './Selection.js';
import { cardSituation, fitsSituation } from './Situation.js';
import { withHistory } from '../MessageHistory.js';   // r292 §122.174 answered messages that dropped off

// ─────────────────────────────────────────────────────────────
// ELIGIBILITY FILTERING
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// §122.57 r182 THE CARD LOG — how often each pool card was dealt, when, and the GM's last answer
// ─────────────────────────────────────────────────────────────

/** For the checks: called with each moment's eligible card ids as the day is planned. */
export const cardDebug = { onEligible: null, onDropped: null };


/** How a card may come back (§122.57). `once`: once a season; else at most `max` a season, `gapDays` apart. */
const REPEAT = Object.freeze({
  ops:     Object.freeze({ gapDays: 14, max: 3 }),   // the game day's moments, travel and homestand days
  player:  Object.freeze({ gapDays: 21, max: 2 }),   // a card about one of our players (a different one each time)
  leave:   Object.freeze({ gapDays: 30, max: 2 }),   // a player's personal leave
  story:   30,                                        // days between two cards of one story (`_story`)
  seasons: 3,                                         // seasons of counts kept
});

const HITTER_GROUPS_CARD = Object.freeze([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS]);

const _REPEAT_POOL = Object.freeze({ PREGAME_POOL: 'ops', INGAME_POOL: 'ops', BETWEEN_GAMES_POOL: 'ops', PERSONAL_LEAVE_POOL: 'leave', OFFDAY_POOL: 'ops', ROAD_POOL: 'ops' });


/** Is this a pool card (its definition travels with it) — not a roster, weather or notice card? */
const _isPoolCard = (c) => !!c?.cardId && c._raw?.id === c.cardId;


function _logEntry(s, id) {
  const log = (s.cardLog ||= {});
  return (log[id] ||= { n: {}, lastMs: null, choice: null, choiceSeason: null });
}

/** A pool card was dealt (scheduled to arrive at `card.deliverAtMs`). */
export function _logDealt(s, card) {
  if (!_isPoolCard(card)) return;
  const season = card._season ?? s.seasonNum ?? 1;
  const at = card.deliverAtMs ?? clockNow();
  for (const id of [card.cardId, card._raw._story ? `story:${card._raw._story}` : null].filter(Boolean)) {
    const e = _logEntry(s, id);
    e.n[season] = (e.n[season] || 0) + 1;
    for (const k of Object.keys(e.n)) if (+k < season - REPEAT.seasons) delete e.n[k];
    e.lastMs = Math.max(e.lastMs ?? -Infinity, at);
  }
}

/** A pool card was withdrawn before it arrived (its game was called off): it never happened. */
export function _unlogDealt(s, card) {
  if (!_isPoolCard(card)) return;
  const season = card._season ?? s.seasonNum ?? 1;
  for (const id of [card.cardId, card._raw._story ? `story:${card._raw._story}` : null].filter(Boolean)) {
    const e = s.cardLog?.[id];
    if (e?.n?.[season]) e.n[season]--;
  }
}

/** The GM's answer (or what an unanswered card did: 'yes' / 'no' / 'skip'). */
export function _logChoice(s, card, choice) {
  if (!_isPoolCard(card)) return;
  const e = _logEntry(s, card.cardId);
  e.choice = choice; e.choiceSeason = card._season ?? s.seasonNum ?? 1;
}


/** The repeat rule for a card from `poolName` (§122.57). */
export function _repeatRule(card, poolName) {
  if (card._oncePerSeason) return { once: true };
  if (card._repeat) return card._repeat;
  if (card._requeueCooldown != null) return { requeue: true, gapDays: card._requeueCooldown, max: 2 };
  if (card._family) return { once: true };
  if (_REPEAT_POOL[poolName]) return REPEAT[_REPEAT_POOL[poolName]];
  if (card._rosterContract || card.onYes || card._restGames || card._trainGames || _ROLE_TOKEN.test([card.subject, card.body].join(' '))) return REPEAT.player;
  return { once: true };   // a story happens once a season
}


/** For the checks (§122.57): a pool card's repeat rule, by id ({ once } or { gapDays, max }); null if not a pool card. */
export function cardRepeatRule(cardId) {
  for (const [poolName, pool] of Object.entries(ALL_POOLS)) {
    const d = pool.map(e => e?.card || e).find(x => x?.id === cardId && !x._retired);
    if (d) return { pool: poolName, ...(_repeatRule(d, poolName)), story: d._story || null };
  }
  return null;
}


/** May this card be dealt again now? (`log`: state.cardLog) */
function _repeatOk(card, poolName, log, season, nowMs) {
  const DAY = 86_400_000;
  const e = log[card.id];
  const n = e?.n?.[season] || 0;
  if (card._doneAfterYes && e?.choice === 'yes') return false;   // settled for good (a captain named)
  if (card._seasonCooldown && e?.lastMs != null && Object.keys(e.n || {}).some(k => +k < season && +k > season - card._seasonCooldown - 1 && e.n[k] > 0)) return false;
  if (card._story) {
    const st = log[`story:${card._story}`];
    if (st?.lastMs != null && nowMs - st.lastMs < REPEAT.story * DAY) return false;
  }
  if (!n) return true;
  const rule = _repeatRule(card, poolName);
  if (rule.once) return false;
  // A card that comes back (`_requeueCooldown`): settled by a yes — or, `_requeueOnNo: false`, by a no.
  if (rule.requeue && e.choiceSeason === season && (card._requeueOnNo === false ? e.choice !== 'yes' : e.choice === 'yes')) return false;
  if (n >= rule.max) return false;
  return e.lastMs == null || nowMs - e.lastMs >= rule.gapDays * DAY;
}


/** Sponsorships (§122.57): a slot is ours this season once an offer for it was accepted; the presenting sponsor is ours unless it walked. */
function _hasSponsor(state, slot) {
  const season = state.seasonNum || 1;
  const log = state.cardLog || {};
  if (slot === 'presenting') { const e = log.sp_renew; return !(e && e.choiceSeason === season && e.choice !== 'yes'); }
  return SPONSOR_OFFERS.some(d => d._sponsorSlot === slot && log[d.id]?.choiceSeason === season && log[d.id]?.choice === 'yes');
}

const SPONSOR_OFFERS = Object.freeze([...DECISIONS_POOL].map(e => e?.card || e).filter(d => d?._sponsorSlot && !d._retired));


/** The schedule around the next game (§122.57): consecutive road games from it, and where this series and this road trip began. */
function _stretch(state, next) {
  const sched = state.schedule || [];
  const i = sched.indexOf(next);
  if (!next || i < 0) return { roadAhead: 0, seriesStartMs: null, tripStartMs: null, seriesOpener: false };
  let roadAhead = 0;
  for (let j = i; j < sched.length && !sched[j].isHome; j++) if (!sched[j].isSpring) roadAhead++;
  let a = i; while (a > 0 && sameOpponent(sched[a - 1], next) && !!sched[a - 1].isHome === !!next.isHome) a--;
  let b = i; while (!next.isHome && b > 0 && !sched[b - 1].isHome) b--;
  const t0 = (g) => Number.isFinite(g?.gameTime) ? g.gameTime - 2 * 86_400_000 : null;   // (a day or two before its first game)
  return { roadAhead, seriesOpener: a === i, seriesStartMs: t0(sched[a]), tripStartMs: next.isHome ? null : t0(sched[b]) };
}


export function _filterEligible(pool, context, state, poolName = null) {
  const gameIdx   = state.currentGameIndex || 0;
  const phase     = state.phase;
  const isSpring  = phase === PHASE.SPRING_TRAINING;
  const isRegular = phase === PHASE.REGULAR_SEASON;
  const regIdx    = context.regularSeasonIndex || 0;

  // Build set of already-delivered card IDs this season
  const deliveredIds = new Set(
    [...withHistory(state), ...(state.scheduledCards || [])]   // r292 §122.174 with the history
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
  // §122.57 r182 the gates every card's conditions name (several were never read), and how a card may come back.
  const season = state.seasonNum || 1;
  const log = state.cardLog || {};
  const nowMs = clockNow();
  const u = state.userTeam || {};
  const stretch = _stretch(state, context.nextGame);
  let prof = null;   // r219 (read once, when a card asks)
  const healthy = (u.rosterIds || []).map(id => state.players?.[id]).filter(p => p && isAvailable(p) && p.group !== PLAYER_GROUP.IL);
  const onIL = (u.rosterIds || []).filter(id => state.players?.[id]?.group === PLAYER_GROUP.IL).length;
  const startingIds = new Set((u.lineupSlots || []).map(x => x?.playerId).filter(Boolean));
  const dealtSince = (id, ms) => ms != null && (log[id]?.lastMs ?? -Infinity) >= ms;
  const familiesThisSeason = new Set(
    [...withHistory(state), ...(state.scheduledCards || [])]   // r292 §122.174 with the history
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
    if (card._maxGames    !== undefined && gameIdx > card._maxGames)    return false;
    if (card._minSpringGame !== undefined && (context.springGameIndex ?? 0) < card._minSpringGame) return false;
    // "The deadline is coming": a number of regular-season games before its window opens.
    if (card._beforeDeadline) {
      const left = TRADE_DEADLINE_OPEN - regIdx;
      if (!isRegular || left < card._beforeDeadline[0] || left > card._beforeDeadline[1]) return false;
    }
    if (card._maxSpringGame !== undefined && context.springGameIndex !== undefined
        && context.springGameIndex > card._maxSpringGame) return false;

    // Location gates
    if (card._requiresHome && !context.nextGame?.isHome) return false;
    if (card._requiresRoad && context.nextGame?.isHome)  return false;
    // We travel to a road series (a flight, a bus): the next game is away and opens its series.
    if (card._requiresAway && (!context.nextGame || context.nextGame.isHome || !stretch.seriesOpener)) return false;
    // The ballpark is ours to rent: at least this many road games from the next one.
    if (card._requiresRoadAhead && stretch.roadAhead < card._requiresRoadAhead) return false;
    if (card._oncePerSeries && dealtSince(card.id, stretch.seriesStartMs)) return false;
    // r217 §122.96 one booking of the ballpark a road trip; a player's hometown series needs a player from there.
    if (card._parkEvent && stretch.tripStartMs != null && PARK_EVENT_IDS.some(id => dealtSince(id, stretch.tripStartMs))) return false;
    // r219 §122.98 a card about what the club has come to expect of the GM: only when the profile leans that far.
    if (card._profile && !_profileFits(card._profile, prof ||= GMP.profile(state))) return false;
    if (card._requiresHometown && !(context.nextGame && !context.nextGame.isHome && hometownPlayer(state, context.nextGame.opponentId))) return false;
    if (card._oncePerRoadTrip && dealtSince(card.id, stretch.tripStartMs)) return false;

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
    // How often a card may come back (§122.57): stories once a season, the game day's moments now and then.
    if (!_repeatOk(card, poolName, log, season, nowMs)) return false;
    // The record and the clubhouse
    if (card._requiresBelowFifty && !((u.wins || 0) + (u.losses || 0) >= 10 && (u.wins || 0) < (u.losses || 0))) return false;
    if (card._requiresLoseStreak !== undefined && (u.streak || 0) > card._requiresLoseStreak) return false;
    if (card._requiresILDepth && onIL < card._requiresILDepth) return false;
    if (card._requiresLeaderTrait && !healthy.some(p => ['clubhouseLeader', 'veteran'].includes(p.trait))) return false;
    if (card._needsBenchVet && !healthy.some(p => HITTER_GROUPS_CARD.includes(p.group) && !startingIds.has(p.id) && ['veteran', 'consistent'].includes(p.trait))) return false;
    if (card._minTier !== undefined && (state.prestigeTier || 1) < card._minTier) return false;
    if (card._notWhilePending && card._notWhilePending.some(id => pendingIds.has(id))) return false;
    // Sponsorships: an offer for a slot we already sold this season isn't made; a card about our sponsor needs one.
    if (card._sponsorSlot && _hasSponsor(state, card._sponsorSlot)) return false;
    if (card._requiresSponsor && !_hasSponsor(state, card._requiresSponsor)) return false;

    // Roster coverage gates
    if (card._requiresBenchSP && !_hasBenchSP(state)) return false;
    // §73: follow-up cards are only ever delivered about the player they follow.
    if (card._intlFollowupOnly) return false;
    // §74: with the scouting budget cut (or the staff on a media tour) the leads dry up.
    if (card.tag === 'SCOUTING' && (state.userTeam?.scoutingQuietUntil || 0) > clockNow()) return false;
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
    // r256 §122.135 a message that says it rained at our park comes only when it did.
    if (card._needsRain && !rainHolds(state, card._needsRain, clockNow())) return false;
    // One version of a family a season: the family is the card.
    if (card._family && familiesThisSeason.has(card._family)) return false;

    return true;
  });
}
