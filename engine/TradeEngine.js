/**
 * engine/TradeEngine.js
 * Trade value, how clubs judge a deal, the CPU's cash sale, execution, and fairness evaluation.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - §85 Cash is part of trades: a one-time sweetener either way (`cashK`,
 *     + = the other club pays us) and a share of a player's salary the
 *     sending club keeps paying this season (`retain: { playerId: share }`).
 *   - A CPU club judges a deal from where it stands (§85 I): its needs and
 *     depth, buying or selling, its books, age, contract and rating — and
 *     sets its bar by its GM's rapport with ours.
 *   - Every club judges a deal through valueToClub / evaluateForClub (§90),
 *     ours included (evaluateForUser); evaluateTrade() is the user-side
 *     summary the offer cards and the scout's read quote.
 *   - Accepting a trade queues ONE ledger transaction (queueTrade); the roster
 *     moves happen on the real-clock transaction ledger (TransactionEngine, §65).
 *   - CPU clubs' calls about our players come from the daily trade desk
 *     (LeagueTrades, §91), not from a roll here.
 *
 * Section references: Section 9 (trade system), Section 22 (GM relationship)
 */

import {
  PLAYER_GROUP,
  PHASE,
  TRADE_DEADLINE_CLOSE,
  GM_RELATIONSHIP_DEFAULT,
  SALARY_BY_OVR,
  TRADE,
} from '../data/constants.js';

import { computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import * as Finance from './FinanceEngine.js';

// ─────────────────────────────────────────────────────────────
// TRADE VALUE CALCULATION
// ─────────────────────────────────────────────────────────────

/**
 * evaluateTrade(offer, state)
 * Evaluates a trade proposal from all angles.
 * Returns a TradeEvaluation object used by CardEngine for display.
 *
 * offer shape:
 * {
 *   incomingIds:  String[],   // playerIds user would receive
 *   outgoingIds:  String[],   // playerIds user would send
 *   proposingTeamId: String,  // CPU team proposing (or 'user' for user-initiated)
 * }
 *
 * @param {Object} offer
 * @param {Object} state
 * @returns {Object} TradeEvaluation
 */
export function evaluateTrade(offer, state) {
  const { incomingIds = [], outgoingIds = [], proposingTeamId } = offer;

  const incomingPlayers = incomingIds.map(id => state.players[id]).filter(Boolean);
  const outgoingPlayers = outgoingIds.map(id => state.players[id]).filter(Boolean);

  const incomingValue  = incomingPlayers.reduce((sum, p) => sum + _playerValue(p, state), 0);
  const outgoingValue  = outgoingPlayers.reduce((sum, p) => sum + _playerValue(p, state), 0);
  // §85 money is value too: cash they send (or we send), salary they keep
  // paying on players we get (or we keep paying on players we send).
  const ret = offer.retain || {}, rem = remainingShare(state);
  const theyKeepK = incomingPlayers.reduce((a, p) => a + (p.contractSalary || 0) * (ret[p.id] || 0) * rem, 0);
  const weKeepK   = outgoingPlayers.reduce((a, p) => a + (p.contractSalary || 0) * (ret[p.id] || 0) * rem, 0);
  const moneyValue = cashValue((offer.cashK || 0) + theyKeepK - weKeepK, state, 'user');
  const valueDiff      = incomingValue - outgoingValue + moneyValue;

  const fairnessRating = _fairnessRating(valueDiff);
  const fairnessLabel  = _fairnessLabel(fairnessRating);

  // Depth impact — does this trade leave the user thin at a position?
  const depthImpact    = _assessDepthImpact(outgoingPlayers, incomingPlayers, state);

  // Payroll impact (all in $K) — what we would pay, net of salary the other
  // club keeps paying (§85) and of shares we keep on players we send.
  const payrollDelta   = _payrollDelta(incomingPlayers, outgoingPlayers, offer.retain || {});
  const newPayroll     = Finance.payrollOf(state, 'user') + payrollDelta;
  // §78: the owner's (soft) payroll target, not a cap.
  const payrollTarget  = Finance.seasonTarget(state.userTeam.finances) || 22000;
  const overTarget     = newPayroll > payrollTarget;

  // GM relationship with proposing team
  const gmRel = proposingTeamId && proposingTeamId !== 'user'
    ? (state.userTeam.gmRelationships?.[proposingTeamId] ?? GM_RELATIONSHIP_DEFAULT)
    : GM_RELATIONSHIP_DEFAULT;

  return {
    incomingValue,
    outgoingValue,
    valueDiff,
    fairnessRating,   // -3 (highway robbery) to +3 (great deal)
    fairnessLabel,    // 'Highway Robbery'|'Unfavorable'|'Slight Disadvantage'|'Fair'|'Slight Advantage'|'Favorable'|'Great Deal'
    depthImpact,      // 'CRITICAL'|'WARNING'|'NEUTRAL'|'IMPROVEMENT'
    payrollDelta,     // $K — positive = more payroll
    newPayroll,       // $K
    overTarget,
    gmRel,
    incomingPlayers,
    outgoingPlayers,
  };
}

// ─────────────────────────────────────────────────────────────
// PLAYER VALUE MODEL
// ─────────────────────────────────────────────────────────────

/**
 * _playerValue(player, state)
 * Calculates a single composite value score for a player.
 * Higher = more valuable. Used for trade fairness comparison only —
 * not displayed to the user (they see OVR, salary, contract years).
 *
 * Inputs:
 *   - OVR (primary driver)
 *   - Contract years remaining (more years = more value for good players)
 *   - Salary efficiency (lower salary vs OVR = more value)
 *   - Age (younger = more value, all else equal)
 *   - Rental value (final-year player = rental premium for contenders)
 *
 * @param {Object} player
 * @param {Object} state
 * @returns {Number} value score
 */
function _playerValue(player, state) {
  if (!player) return 0;

  const ovr          = player.ovr || 55;
  const age          = computeAge(player.dob, baseballYear(state));
  const yearsLeft    = yearsAfterThis(player, state);   // §94 seasons covered after this one
  const salary       = player.contractSalary || 0;

  // Base OVR value — §90 measured above replacement level (the player any
  // club can pick up for nothing), so a star is worth several regulars and a
  // fringe player little.
  const ovrScore = _ovrScore(ovr, state);

  // Age modifier — peak value at 25-28, declining before and after
  const ageScore = age <= 23 ? 1.15         // young prospect premium
    : age <= 28 ? 1.0                        // peak
    : age <= 32 ? 1.0 - (age - 28) * 0.04   // slight decline
    : 1.0 - (age - 28) * 0.08;              // steeper decline

  // Contract years modifier — more years = more value (up to a point). §90 a
  // player in his final year still plays the rest of this one: a rental is
  // worth less than control, not a fraction of the player.
  const contractScore = yearsLeft === 0 ? 0.80   // final year / expired
    : yearsLeft === 1 ? 0.90                     // one more year after this
    : yearsLeft === 2 ? 1.0                      // standard
    : 1.0 + (yearsLeft - 2) * 0.05;             // small bonus for longer deals

  // Salary efficiency — below-market salary is a real asset
  const marketSalary = _marketSalary(ovr);
  const salEfficiency = salary === 0 ? 1.0
    : marketSalary / Math.max(salary, 1);
  const salScore = Math.max(0.85, Math.min(1.15, salEfficiency));   // §90 money is weighed apart (books, cash)

  // Injury penalty — injured players worth less
  const injuryMod = player.isInjured ? 0.70 : 1.0;

  // §90 a player is worth what he gives this season plus what he gives
  // after it: age and contract shape the future part, not the present one.
  return ovrScore * (0.45 + 0.55 * ageScore * contractScore) * salScore * injuryMod;
}

/** §90 value above replacement level for a rating (the league's level sets replacement). */
function _ovrScore(ovr, state) {
  const R = 44 + (state?.leagueTalentOffset || 0);
  return 6 * Math.pow(Math.max(1, (ovr || 0) - R), 1.25);
}

/**
 * Several lesser pieces are worth less than their sum (roster spots, and
 * quality over quantity): the best counts fully, the next 60%, the rest 40%.
 */
function _packageValue(values) {
  const w = [1, 0.6, 0.4];
  return [...values].sort((a, b) => b - a).reduce((a, v, i) => a + v * (w[i] ?? 0.4), 0);
}

/**
 * _marketSalary(ovr)
 * Returns the midpoint of the salary range for an OVR value (in $K).
 */
function _marketSalary(ovr) {
  for (const tier of Object.values(SALARY_BY_OVR)) {
    if (ovr >= tier.ovrMin && ovr <= tier.ovrMax) {
      return (tier.salMin + tier.salMax) / 2;
    }
  }
  return 50; // fallback
}

// ─────────────────────────────────────────────────────────────
// FAIRNESS RATING
// ─────────────────────────────────────────────────────────────

function _fairnessRating(valueDiff) {
  // -3 to +3 scale
  if (valueDiff >  60) return  3;   // Great Deal
  if (valueDiff >  25) return  2;   // Favorable
  if (valueDiff >   8) return  1;   // Slight Advantage
  if (valueDiff >= -8) return  0;   // Fair
  if (valueDiff > -25) return -1;   // Slight Disadvantage
  if (valueDiff > -60) return -2;   // Unfavorable
  return -3;                        // Highway Robbery
}

function _fairnessLabel(rating) {
  const labels = {
    3:  'Great Deal',
    2:  'Favorable',
    1:  'Slight Advantage',
    0:  'Fair Exchange',
    '-1': 'Slight Disadvantage',
    '-2': 'Unfavorable',
    '-3': 'Highway Robbery',
  };
  return labels[String(rating)] || 'Fair Exchange';
}

// ─────────────────────────────────────────────────────────────
// DEPTH IMPACT ASSESSMENT
// ─────────────────────────────────────────────────────────────

function _assessDepthImpact(outgoing, incoming, state) {
  if (!outgoing.length) return 'NEUTRAL';

  // Check if outgoing player is irreplaceable at their position
  const userRoster = state.userTeam.rosterIds
    .map(id => state.players[id])
    .filter(p => p && isAvailable(p));

  for (const player of outgoing) {
    const pos      = player.nativePos || player.pos;
    const isPitcher = ['SP', 'RP'].includes(player.pos);

    const compatible = userRoster.filter(p => {
      if (p.id === player.id) return false;
      if (isPitcher) return ['SP','RP'].includes(p.pos);
      // Simplified position compatibility
      return (p.nativePos || p.pos) === pos
          || (pos === 'DH' && ['1B','OF'].includes(p.nativePos || p.pos));
    });

    if (compatible.length === 0) return 'CRITICAL';
    if (compatible.length === 1) return 'WARNING';
  }

  // Would an incoming player start for us — better than the weakest player
  // in the lineup at a position he plays, or in the rotation? (§85: the
  // lineup slots are the source of truth, not the old STARTING_HITTERS group.)
  if (incoming.some(p => wouldStart(p, state, 'user'))) return 'IMPROVEMENT';

  return 'NEUTRAL';
}

// ─────────────────────────────────────────────────────────────
// PAYROLL IMPACT
// ─────────────────────────────────────────────────────────────

function _payrollDelta(incoming, outgoing, retain = {}) {
  const inSalary  = incoming.reduce((s, p) => s + (p.contractSalary || 0) * (1 - (retain[p.id] || 0)), 0);
  const outSalary = outgoing.reduce((s, p) => s + (p.contractSalary || 0) * (1 - (retain[p.id] || 0)), 0);
  return Math.round(inSalary - outSalary);
}

// ─────────────────────────────────────────────────────────────
// CPU OFFERS TO US
// ─────────────────────────────────────────────────────────────
//
// §91 a CPU club's call about one of our players comes from the daily trade
// desk (LeagueTrades.findLeagueTrades), built by the same package logic and
// judged the same way as every other trade. The one CPU offer still made
// here is the selling club's cash sale (§85 A).

/**
 * generateCPUCashSale(teamId, state, context) — §85 A: a selling (or cutting)
 * club offers a fringe player who would start for us, for cash, nothing back.
 */
export function generateCPUCashSale(teamId, state, context = {}) {
  const team = _club(state, teamId);
  if (!team || clubMode(state, teamId) !== 'seller') return null;
  if (!context.force && Math.random() > 0.04) return null;
  const now = context.atMs || Date.now();
  const pool = (team.rosterIds || []).map(id => state.players[id])
    .filter(p => p && isAvailable(p) && !p.isInjured && !contractRunOut(p, state) && !_isKey(p, state, teamId)
              && !(p._acquiredAtMs && now - p._acquiredAtMs < TRADE.noFlipMs) && wouldStart(p, state, 'user'));
  const p = pool.sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  if (!p) return null;
  const price = Math.max(50, Math.round((valueToClub(p, state, teamId, false) / Math.max(0.01, cashValue(1, state, teamId))) / 25) * 25);
  const offer = { incomingIds: [p.id], outgoingIds: [], proposingTeamId: teamId, cashK: -price, retain: {}, isRental: _isRentalPlayer(p, state) };
  if (!Finance.canSpend(state, price, 'user') || !Finance.canAddSalary(state, p.contractSalary || 0, 0, 'user')) return null;
  return { offer, evaluation: evaluateTrade(offer, state) };
}

// ─────────────────────────────────────────────────────────────
// TRADE EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * queueTrade(offer, proposingTeamId, atMs)
 * Accepting a trade records ONE 'trade' transaction (§65). It executes when
 * the roster clock reaches `atMs` — immediately between games, or right after
 * the final out if a game is in progress (the clock never moves mid-game).
 * TransactionEngine.applyDue() then moves every player in the deal off his
 * roster and puts him IN_TRANSIT, reporting to his new team the next
 * calendar day. Pure.
 *
 * @param {Object} offer  — { incomingIds, outgoingIds, proposingTeamId }
 * @param {String} proposingTeamId
 * @param {Number} atMs   — the real moment the GM accepted
 * @returns {Object} transaction record
 */
export function queueTrade(offer, proposingTeamId, atMs) {
  return {
    id:          `tx-trade-${proposingTeamId}-${atMs}`,
    kind:        'trade',
    teamId:      'user',
    fromTeamId:  proposingTeamId,
    offer: {
      incomingIds: [...(offer.incomingIds || [])],
      outgoingIds: [...(offer.outgoingIds || [])],
      cashK:       offer.cashK || 0,             // §85 + = they pay us (once, at the trade)
      retain:      { ...(offer.retain || {}) },  // §85 salary share the sending club keeps paying this season
    },
    createdAt:   atMs,
    effectiveAt: atMs,
    status:      'pending',
  };
}

/**
 * tradePlayerPatches(state, tx)
 * The player-level effects of an executed trade (relationship reset for the
 * new arrivals). Used by TransactionEngine when the trade executes. Pure.
 */
export function tradePlayerPatches(state, tx) {
  const patches = {};
  for (const id of tx.offer.incomingIds) {
    const p = state.players[id];
    if (!p) continue;
    // GM relationship starts slightly lower for newly acquired players (Section 22.3)
    patches[id] = {
      gmRelationship: p._previouslyWithOrg
        ? Math.min(100, (p.gmRelationship || GM_RELATIONSHIP_DEFAULT) + 5)
        : 45,
    };
  }
  for (const id of tx.offer.outgoingIds) {
    if (state.players[id]) patches[id] = { _previouslyWithOrg: true };
  }
  return patches;
}

// ─────────────────────────────────────────────────────────────
// RENTAL TRADE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _isRentalPlayer(player, state)
 * Returns true if this player is in their final contract year.
 * Rental players have modified value — high for contenders, lower for rebuilders.
 */
function _isRentalPlayer(player, state) {
  return yearsAfterThis(player, state) === 0;
}

/**
 * §94 the seasons a contract still covers after this one. `contractExpiry` is
 * the first season NOT covered (§70: a one-year deal for season S expires at
 * S+1), so a player in the last year of a deal has 0. (Before r89 the trade
 * engine read expiry === S as the final year — one year off, so final-year
 * players were valued as if they had a year left.)
 */
export function yearsAfterThis(player, state) {
  const s = state.seasonNum || 1;
  return Math.max(0, (player?.contractExpiry ?? s + 1) - s - 1);
}

/**
 * §94 in the offseason, a player whose deal has run out and who hasn't
 * re-signed is headed for free agency: no club can trade him.
 */
export function contractRunOut(player, state) {
  return state.phase === PHASE.OFFSEASON && yearsAfterThis(player, state) === 0 && !player?.pendingContract;
}

// ─────────────────────────────────────────────────────────────
// §85 PHASE 4 — HOW CLUBS JUDGE A DEAL
// ─────────────────────────────────────────────────────────────

const POSTSEASON = new Set([PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);
const _club = (state, id) => (id === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === id) || null);
const _isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const _plays = (p, slot) => slot === 'DH' ? !_isPitcher(p)
  : [p.nativePos, ...(String(p.pos || '').split('/'))].includes(slot);

/** Our committed regular-season games (the season's position against the deadline). */
export function regularIndex(state) {
  return (state.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff).length;
}

/**
 * tradeWindow(state) — §85 H: trades are open in spring, in season until the
 * deadline, and in the offseason; closed from the deadline through October.
 */
export function tradeWindow(state) {
  const ph = state.phase;
  if (ph === PHASE.OFFSEASON || ph === PHASE.SPRING_TRAINING) return { open: true };
  if (ph === PHASE.SEASON_SUMMARY || POSTSEASON.has(ph)) return { open: false, reason: 'the trade window is closed until the offseason' };
  if (regularIndex(state) > TRADE_DEADLINE_CLOSE) return { open: false, reason: 'the trade deadline has passed' };
  return { open: true };
}

// ── GM rapport (the per-club relationship, shown as a grade) ──────────────

export function rapportOf(state, teamId) {
  return state.userTeam?.gmRelationships?.[teamId] ?? GM_RELATIONSHIP_DEFAULT;
}
/** The grade the GM sees: Strong / Good / Neutral / Cool / Strained. */
export function rapportGrade(score) {
  return score >= 75 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Neutral' : score >= 25 ? 'Cool' : 'Strained';
}
export function adjustRapport(draft, teamId, delta) {
  if (!delta || teamId === 'user') return;
  const rels = { ...(draft.userTeam.gmRelationships || {}) };
  rels[teamId] = Math.max(0, Math.min(100, (rels[teamId] ?? GM_RELATIONSHIP_DEFAULT) + delta));
  draft.userTeam.gmRelationships = rels;
}

// ── Cooling off (real time) ────────────────────────────────────────────────

export function cooldownUntil(state, teamId) {
  return state.tradeTalks?.[teamId]?.cooldownUntilMs || 0;
}
export function startCooldown(draft, teamId, atMs) {
  draft.tradeTalks = { ...(draft.tradeTalks || {}), [teamId]: { ...(draft.tradeTalks?.[teamId] || {}), cooldownUntilMs: atMs + TRADE.cooldownMs } };
}

// ── Talking with a club (§88, §91) ──────────────────────────────────────────

/** The open talk with a club, if any (Negotiation runs it). */
export function talkWith(state, teamId) {
  return state.tradeTalks?.[teamId]?.talk || null;
}

/**
 * Are we in talks with this club right now — waiting to hear back, or
 * holding an answer we haven't acted on?
 */
export function talkIsOpen(state, teamId, nowMs = Date.now()) {
  const t = talkWith(state, teamId);
  if (!t) return false;
  if ((t.replyAtMs || 0) > nowMs) return true;                    // their answer hasn't reached us yet
  return ['countered', 'agreed'].includes(t.status);
}

/** An offer of theirs we haven't answered yet (in the inbox or on its way). */
export function offerAwaitingUs(state, teamId) {
  return [...(state.inbox || []), ...(state.scheduledCards || [])]
    .some(c => !c.resolved && c._proposingTeamId === teamId && c._tradeOffer);
}

/**
 * §91 is this club already dealing with us — talks open, an offer of theirs
 * waiting on our answer, or cooling off after a no? Then it doesn't call.
 */
export function busyWithUs(state, teamId, atMs) {
  return talkIsOpen(state, teamId, atMs) || offerAwaitingUs(state, teamId) || cooldownUntil(state, teamId) > atMs;
}

// ── Where a club stands ────────────────────────────────────────────────────

/** 'buyer' | 'seller' | 'neutral': the record (and the owner, if he is cutting). */
export function clubMode(state, teamId) {
  const t = _club(state, teamId);
  if (!t) return 'neutral';
  if (['cuts', 'concerned'].includes(t.finances?.owner?.stage)) return 'seller';
  const n = (t.wins || 0) + (t.losses || 0);
  if (n < 15) return 'neutral';
  const pct = t.wins / n;
  return pct >= 0.54 ? 'buyer' : pct <= 0.46 ? 'seller' : 'neutral';
}

function _lineupOf(state, t) {
  return (t.lineupSlots || []).map(sl => ({ slot: sl.slot, p: state.players[sl.playerId] })).filter(x => x.p);
}
function _rotationOf(state, t) {
  return (t.rotation?.order || []).map(id => state.players[id]).filter(Boolean);
}
function _bullpenOf(state, t) {
  return (t.rosterIds || []).map(id => state.players[id])
    .filter(p => p && [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group) && p.pos === 'RP');
}

/** Would this player start for the club — over its weakest at a spot he fills? */
export function wouldStart(p, state, teamId) {
  const t = _club(state, teamId);
  if (!t || !p) return false;
  if (p.pos === 'SP') {
    const rot = _rotationOf(state, t).filter(x => x.id !== p.id);
    return rot.length < 5 || (p.ovr || 0) > Math.min(...rot.map(x => x.ovr || 0));
  }
  if (p.pos === 'RP') {
    const pen = _bullpenOf(state, t).filter(x => x.id !== p.id).map(x => x.ovr || 0).sort((a, b) => b - a);
    return pen.length < 4 || (p.ovr || 0) > pen[3];
  }
  return _lineupOf(state, t).some(x => x.p.id !== p.id && _plays(p, x.slot) && (p.ovr || 0) > (x.p.ovr || 0));
}

/** Does the player hold a key spot for his club now (lineup, rotation, top of the pen)? */
function _isKey(p, state, teamId) {
  const t = _club(state, teamId);
  if (!t) return false;
  if ((t.lineupSlots || []).some(sl => sl.playerId === p.id)) return true;
  if ((t.rotation?.order || []).includes(p.id)) return true;
  const pen = _bullpenOf(state, t).sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).slice(0, 3);
  return pen.some(x => x.id === p.id);
}

/**
 * valueToClub(p, state, teamId, receiving) — what a player is worth to this
 * club, from where it stands: the base value (rating, age, contract, salary,
 * health), weighed by whether it is buying or selling, and by whether he
 * would play for it (receiving) or is a piece it can spare (giving).
 */
export function valueToClub(p, state, teamId, receiving) {
  let v = _playerValue(p, state);
  const mode = clubMode(state, teamId);
  const age = computeAge(p.dob, baseballYear(state));
  const rental = _isRentalPlayer(p, state);
  if (receiving) {
    if (mode === 'buyer')  v *= (1 + Math.max(-0.1, Math.min(0.2, ((p.ovr || 55) - 60) * 0.01))) * (rental ? 1.1 : 1);
    if (mode === 'seller') v *= (age <= 25 ? 1.2 : age >= 31 ? 0.8 : 1) * (rental ? 0.7 : 1);
    v *= wouldStart(p, state, teamId) ? 1.2 : (age <= 24 ? 0.95 : 0.8);
  } else {
    const key = _isKey(p, state, teamId);
    v *= key ? 1.1 : 0.85;
    if (mode === 'seller' && (rental || age >= 31)) v *= 0.85;   // a seller is glad to move veterans
    // §90 sending a regular away leaves a hole: what the club loses on the
    // field, from him to the best it has to fill the spot (a seller minds less).
    if (key) v += _holeCost(p, state, teamId) * (mode === 'seller' ? 0.3 : mode === 'buyer' ? 0.8 : 0.6);
  }
  return v;
}

/** The drop, in value, from a regular to the club's best replacement at his spot. */
function _holeCost(p, state, teamId) {
  const t = _club(state, teamId);
  if (!t) return 0;
  const score = (ovr) => _ovrScore(ovr, state);
  const org = [...(t.rosterIds || []), ...(t.farmIds || [])].map(id => state.players[id])
    .filter(x => x && x.id !== p.id && !x.isInjured);
  let fits;
  if (p.pos === 'SP') {
    const rot = new Set(t.rotation?.order || []);
    fits = org.filter(x => (x.pos === 'SP' || x.pos === 'RP') && !rot.has(x.id));
  } else if (p.pos === 'RP') {
    fits = org.filter(x => x.pos === 'RP' && !_isKey(x, state, teamId));
  } else {
    const slot = (t.lineupSlots || []).find(sl => sl.playerId === p.id)?.slot || p.nativePos || p.pos;
    const starters = new Set((t.lineupSlots || []).map(sl => sl.playerId));
    fits = org.filter(x => !_isPitcher(x) && !starters.has(x.id) && _plays(x, slot));
  }
  const repl = Math.max(0, ...fits.map(x => x.ovr || 0)) || (p.ovr || 0) - 15;
  return Math.max(0, score(p.ovr) - score(repl));
}

/** What $K is worth in trade value to this club (a strapped club values cash more). */
export function cashValue(k, state, teamId) {
  const t = _club(state, teamId);
  const stage = t?.finances?.owner?.stage;
  const tgt = Finance.seasonTarget(t?.finances) || 1;
  const funds = t?.finances?.funds ?? 0;
  const mult = ['cuts', 'concerned'].includes(stage) || funds < tgt * 0.1 ? 1.3 : funds > tgt * 0.25 ? 0.8 : 1;
  return (k / TRADE.cashPerValueK) * mult;
}

/** The share of this season's salary still to be paid (for salary kept on a traded player). */
export function remainingShare(state) {
  const cal = state.userTeam?.finances?.cal;
  if (!cal || cal.seasonNum !== (state.seasonNum || 1)) return 0;
  return Math.max(0, Math.min(1, (cal.endDay - cal.accruedThrough) / cal.days));
}

/**
 * evaluateForClub(offer, state, teamId) — the deal from the CPU club's side.
 * It receives offer.outgoingIds (ours) and gives offer.incomingIds (its own).
 * Returns { get, give, net, payrollIn, payrollOut, booksOk, cashOk }.
 */
export function evaluateForClub(offer, state, teamId) {
  const P = (id) => state.players[id];
  const ret = offer.retain || {};
  const recv = (offer.outgoingIds || []).map(P).filter(Boolean);
  const send = (offer.incomingIds || []).map(P).filter(Boolean);
  const get  = _packageValue(recv.map(p => valueToClub(p, state, teamId, true)));
  const give = _packageValue(send.map(p => valueToClub(p, state, teamId, false)));
  const rem = remainingShare(state);
  // Money: cash it pays (+cashK) or gets, salary it keeps paying on players it
  // sends (ret on its players) or that we keep paying on ours.
  const keepsK  = send.reduce((a, p) => a + (p.contractSalary || 0) * (ret[p.id] || 0) * rem, 0);
  const sparedK = recv.reduce((a, p) => a + (p.contractSalary || 0) * (ret[p.id] || 0) * rem, 0);
  const cashK = offer.cashK || 0;
  const money = cashValue(-cashK - keepsK + sparedK, state, teamId);
  // §90 payroll is what the club pays: a minor-league deal on the farm isn't
  // on it, either way (a farm player traded joins the other club's farm).
  const paid = (p) => Finance.isPaid(p) ? (p.contractSalary || 0) * (1 - (ret[p.id] || 0)) : 0;
  const payrollIn  = recv.reduce((a, p) => a + paid(p), 0);
  const payrollOut = send.reduce((a, p) => a + paid(p), 0);
  return {
    get, give, net: get - give + money,
    payrollIn, payrollOut,
    booksOk: Finance.canAddSalary(state, payrollIn, payrollOut, teamId),
    cashOk:  cashK <= 0 || Finance.canSpend(state, cashK, teamId),
  };
}

/**
 * evaluateForUser(offer, state) — §91 the deal as we would judge it, by the
 * same rules a CPU club uses (offer in our terms: incomingIds = we receive,
 * cashK + = they pay us).
 */
export function evaluateForUser(offer, state) {
  return evaluateForClub({
    incomingIds: offer.outgoingIds || [], outgoingIds: offer.incomingIds || [],
    cashK: -(offer.cashK || 0), retain: offer.retain || {},
  }, state, 'user');
}

/** The bar this club sets (net value it needs), by its GM's rapport with ours. */
export function clubBar(state, teamId) {
  const g = rapportGrade(rapportOf(state, teamId)).toLowerCase();
  return TRADE.bar[g] ?? 0;
}

/**
 * tradeBlockers(offer, state, atMs, teamId) — why this deal can't be made
 * right now (null when it can): the window, cooling off, the size of the
 * deal, players who aren't where the deal needs them, a player acquired too
 * recently to move (§85 I).
 */
export function tradeBlockers(offer, state, atMs, teamId) {
  const w = tradeWindow(state);
  if (!w.open) return w.reason;
  if (cooldownUntil(state, teamId) > atMs) return `${_club(state, teamId)?.name || 'They'} aren't taking calls from us for a couple of days`;
  const ins = offer.incomingIds || [], outs = offer.outgoingIds || [];
  if (ins.length > TRADE.maxPerSide || outs.length > TRADE.maxPerSide) return `a deal can have at most ${TRADE.maxPerSide} players a side`;
  if (!ins.length && !outs.length) return 'there is nothing in the deal';
  const cpu = _club(state, teamId), user = state.userTeam;
  const on = (t, id) => (t?.rosterIds || []).includes(id) || (t?.farmIds || []).includes(id);
  for (const id of outs) if (!on(user, id)) return `${state.players[id]?.name || 'A player'} isn't ours to trade`;
  for (const id of ins) if (!on(cpu, id)) return `${state.players[id]?.name || 'A player'} isn't theirs to trade`;
  for (const id of [...ins, ...outs]) {
    const p = state.players[id];
    if (!p) return 'a player in the deal no longer exists';
    if (p.group === PLAYER_GROUP.IN_TRANSIT) return `${p.name} is in transit`;
    if (p.isInjured || p.group === PLAYER_GROUP.IL) return `${p.name} is hurt — no club takes an injured player`;
    if (p._acquiredAtMs && atMs - p._acquiredAtMs < TRADE.noFlipMs) return `${p.name} was acquired too recently to be moved`;
    if (contractRunOut(p, state)) return `${p.name}'s contract is up — headed for free agency, not a trade`;
  }
  for (const [id, pct] of Object.entries(offer.retain || {})) {
    if (!(pct > 0 && pct <= TRADE.maxRetainPct)) return 'a club keeps paying at most half of a salary';
    if (!ins.includes(id) && !outs.includes(id)) return 'salary can only be kept on a player in the deal';
  }
  return null;
}

/**
 * cpuRespond(offer, state, teamId, { round, atMs }) — the club's answer:
 *   { decision: 'accept' | 'counter' | 'decline', reason, counter?, eval }
 * A deal at or above its bar is accepted. Close enough, it counters (asking
 * for cash or another piece, or keeping salary) until TRADE.maxRounds, when
 * talks fizzle. Far off, it declines — a lowball if very far.
 */
export function cpuRespond(offer, state, teamId, { round = 1, atMs = Date.now() } = {}) {
  const blocked = tradeBlockers(offer, state, atMs, teamId);
  if (blocked) return { decision: 'decline', reason: blocked };
  const ev = evaluateForClub(offer, state, teamId);
  const bar = clubBar(state, teamId);
  const gap = bar - ev.net;
  if (ev.net >= bar && ev.booksOk && ev.cashOk) return { decision: 'accept', eval: ev };
  if (round >= TRADE.maxRounds) return { decision: 'decline', reason: 'fizzled', eval: ev };
  if (gap <= TRADE.counterBand || !ev.booksOk) {
    const counter = buildCounter(offer, state, teamId, Math.max(0, gap), ev);
    if (counter) return { decision: 'counter', counter, eval: ev };
  }
  return { decision: 'decline', reason: gap > TRADE.counterBand * 2 ? 'lowball' : 'value', eval: ev };
}

/**
 * buildCounter(offer, state, teamId, gap, ev) — the club's counter: if its
 * books can't carry the deal, we keep paying part of a salary we send; then
 * the smallest addition that closes the value gap — cash from us (small
 * gaps, if our owner can spend it), one more of our players (a prospect or a
 * bench piece it would use), or one of its own players taken back out.
 */
export function buildCounter(offer, state, teamId, gap, ev = evaluateForClub(offer, state, teamId)) {
  const next = { ...offer, incomingIds: [...(offer.incomingIds || [])], outgoingIds: [...(offer.outgoingIds || [])], retain: { ...(offer.retain || {}) }, cashK: offer.cashK || 0 };
  // Books first: we keep paying part of the biggest salary we send.
  if (!ev.booksOk) {
    const over = ev.payrollIn - ev.payrollOut - Math.max(0, Finance.payrollRoom(state, teamId));
    const big = next.outgoingIds.map(id => state.players[id]).filter(Boolean).sort((a, b) => (b.contractSalary || 0) - (a.contractSalary || 0))[0];
    if (!big || !(big.contractSalary > 0)) return null;
    const pct = Math.min(TRADE.maxRetainPct, Math.ceil((over / big.contractSalary) * 20) / 20);
    if (pct <= 0 || over > big.contractSalary * TRADE.maxRetainPct) return null;
    next.retain[big.id] = pct;
    const after = evaluateForClub(next, state, teamId);
    return after.booksOk ? (after.net >= clubBar(state, teamId) ? next : buildCounter(next, state, teamId, clubBar(state, teamId) - after.net, after)) : null;
  }
  const options = [];
  // Cash from us, for a small gap our owner can fund.
  const cashNeed = Math.ceil((gap / cashValue(1, state, teamId)) / 25) * 25;
  if (gap <= 20 && Finance.canSpend(state, cashNeed, 'user')) options.push({ kind: 'cash', over: 0, apply: (o) => { o.cashK -= cashNeed; } });
  // One more of ours (prospects and bench pieces it would value).
  if (next.outgoingIds.length < TRADE.maxPerSide) {
    const u = state.userTeam;
    const pool = [...(u.farmIds || []), ...(u.rosterIds || [])].map(id => state.players[id])
      .filter(p => p && !next.outgoingIds.includes(p.id) && !_isKey(p, state, 'user') && !p.isInjured && p.group !== PLAYER_GROUP.IN_TRANSIT && !contractRunOut(p, state)
                && !(p._acquiredAtMs && Date.now() - p._acquiredAtMs < TRADE.noFlipMs));
    for (const p of pool) {
      const add = valueToClub(p, state, teamId, true);
      if (add >= gap) options.push({ kind: 'player', over: add - gap, id: p.id, apply: (o) => { o.outgoingIds.push(p.id); } });
    }
  }
  // One of theirs taken back out (only when more than one comes to us).
  if (next.incomingIds.length > 1) {
    for (const id of next.incomingIds) {
      const p = state.players[id];
      const back = valueToClub(p, state, teamId, false);
      if (back >= gap) options.push({ kind: 'remove', over: back - gap, id, apply: (o) => { o.incomingIds = o.incomingIds.filter(x => x !== id); delete o.retain[id]; } });
    }
  }
  if (!options.length) return null;
  const pick = options.sort((a, b) => (a.kind === 'cash' ? -1 : 0) - (b.kind === 'cash' ? -1 : 0) || a.over - b.over)[0];
  pick.apply(next);
  return next;
}


/**
 * scoutRead(offer, state, teamId, ourBlocker) — §85 G: the GM runs a deal by
 * Pro Scouting before sending it. Words, never a number: how close it is,
 * whether our players would play there, whether the club is buying or
 * selling, both owners' books, and the relationship.
 */
export function scoutRead(offer, state, teamId, ourBlocker = null) {
  const lines = [];
  const club = _club(state, teamId);
  const ev = evaluateForClub(offer, state, teamId);
  const gap = clubBar(state, teamId) - ev.net;
  lines.push(gap <= -25 ? 'They would jump at this — we may be giving more than we need to.'
           : gap <= 0   ? 'This should get it done.'
           : gap <= 15  ? 'Close. They will likely want a little more — some cash, or a prospect.'
           : gap <= 30  ? 'They will want noticeably more before this gets done.'
           : gap <= 60  ? 'This is well short of what they will want.'
           : 'This won\'t get a serious conversation — they would take it as a lowball.');
  const mode = clubMode(state, teamId);
  if (mode === 'buyer')  lines.push(`${club?.name || 'They'} are buying — they want help now, and a proven player matters more than a prospect.`);
  if (mode === 'seller') lines.push(`${club?.name || 'They'} are selling — they would rather have young players than veterans, and cash goes a long way with them.`);
  for (const id of offer.outgoingIds || []) {
    const p = state.players[id];
    if (!p) continue;
    if (wouldStart(p, state, teamId)) lines.push(`${p.name} would play every day for them.`);
    else if ((state.userTeam.farmIds || []).includes(id)) lines.push(`${p.name} would be a prospect in their system, not a big-leaguer yet.`);
    else lines.push(`${p.name} wouldn't crack their lineup — they won't pay much for depth.`);
  }
  if (!ev.booksOk) lines.push('Their owner won\'t take on that much salary. We would have to keep paying part of it, or take salary back.');
  if (!ev.cashOk)  lines.push('They can\'t send that much cash right now.');
  if (ourBlocker)  lines.push(`On our side: ${ourBlocker}.`);
  const ours = evaluateTrade(offer, state);
  if (ours.fairnessRating <= -2) lines.push('From where we sit, we would be giving up more than we get.');
  else if (ours.fairnessRating >= 2) lines.push('From where we sit, this looks like a win for us.');
  lines.push(`Our relationship with their front office: ${rapportGrade(rapportOf(state, teamId))}.`);
  return lines;
}

// §90 shared with LeagueTrades (CPU-to-CPU deals and the scout's packages).
export { _isKey as isKeyPiece, _plays as playsSlot, _isRentalPlayer as isRental, _packageValue as packageValue };
