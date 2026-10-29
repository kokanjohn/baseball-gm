/**
 * engine/LeagueTrades.js
 * §90 Phase 4c — trades between CPU clubs, and the packages Pro Scouting
 * puts together for us. Pure: takes state, returns deals; GameEngine and
 * TransactionEngine carry them out.
 *
 * A trade happens when a situation arises for two clubs (§85 J), never at a
 * fixed rate: a club has a need — a starter well below the league's norm at
 * his spot, a weak end of the rotation or the pen — and another club has a
 * player who fills it and would take what the first club can spare. Each
 * day, a club with a need may work the phones (more often at the deadline).
 * Both clubs judge the deal the way they judge ours (TradeEngine.valueToClub:
 * buying or selling, who would start, age, contract, books); the buyer will
 * overpay a little to fill a need, the seller takes nothing less than fair.
 *
 * A deal is { a, b, aGets, bGets, cashAtoB, retain }: club `a` receives
 * `aGets` (from b) and sends `bGets`; `cashAtoB` is a one-time payment from a
 * to b (negative: b pays a); `retain` is the salary share the SENDING club
 * keeps paying this season, by player.
 */

import { PLAYER_GROUP, PHASE, TRADE, LEAGUE_TRADES, TRADE_DEADLINE_OPEN, TRADE_DEADLINE_CLOSE } from '../data/constants.js';
import {
  valueToClub, evaluateForClub, wouldStart, tradeWindow, regularIndex, clubMode, cashValue,
  remainingShare, clubBar, isKeyPiece, playsSlot, packageValue,
} from './TradeEngine.js';
import * as Finance from './FinanceEngine.js';
import { isAvailable } from './PlayerFactory.js';

const _club = (state, id) => (id === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === id) || null);
const _isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const _avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// ── Where a club is weak ────────────────────────────────────────────────────

function _pen(state, t) {
  return (t.rosterIds || []).map(id => state.players[id])
    .filter(p => p && p.pos === 'RP' && [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group))
    .sort((x, y) => (y.ovr || 0) - (x.ovr || 0));
}

/** The league's norms: a typical starter in the lineup, the rotation, the top of the pen. */
export function leagueNorms(state) {
  const clubs = [state.userTeam, ...(state.leagueTeams || [])].filter(Boolean);
  const P = (id) => state.players[id];
  const h = [], sp = [], rp = [];
  for (const t of clubs) {
    for (const sl of t.lineupSlots || []) if (P(sl.playerId)) h.push(P(sl.playerId).ovr || 0);
    for (const id of t.rotation?.order || []) if (P(id)) sp.push(P(id).ovr || 0);
    rp.push(..._pen(state, t).slice(0, 4).map(p => p.ovr || 0));
  }
  return { h: _avg(h), sp: _avg(sp), rp: _avg(rp) };
}

/**
 * clubNeeds(state, teamId, norms) — the spots where this club is well below
 * the league's norm, worst first: { kind: 'slot'|'sp'|'rp', slot, incumbentId, ovr, gap }.
 */
export function clubNeeds(state, teamId, norms = leagueNorms(state)) {
  const t = _club(state, teamId);
  if (!t) return [];
  const P = (id) => state.players[id];
  const out = [];
  for (const sl of t.lineupSlots || []) {
    const p = P(sl.playerId);
    const ovr = p ? p.ovr || 0 : 0;
    out.push({ kind: 'slot', slot: sl.slot, incumbentId: p?.id || null, ovr, gap: norms.h - ovr });
  }
  const rot = (t.rotation?.order || []).map(P).filter(Boolean);
  const worstSP = rot.sort((x, y) => (x.ovr || 0) - (y.ovr || 0))[0];
  if (worstSP) out.push({ kind: 'sp', incumbentId: worstSP.id, ovr: worstSP.ovr || 0, gap: norms.sp - (worstSP.ovr || 0) });
  const top = _pen(state, t).slice(0, 4);
  const weakRP = top[top.length - 1];
  if (weakRP) out.push({ kind: 'rp', incumbentId: weakRP.id, ovr: weakRP.ovr || 0, gap: (norms.rp - (weakRP.ovr || 0)) * 0.6 });
  // A spot the club can fill from within (a better player it isn't using, on
  // the bench or the farm) is a lineup decision, not a trade need.
  const starters = new Set([...(t.lineupSlots || []).map(sl => sl.playerId), ...(t.rotation?.order || []), ...top.map(p => p.id)]);
  const reserves = _org(t).map(P).filter(p => p && !starters.has(p.id) && !p.isInjured);
  for (const n of out) {
    const best = Math.max(0, ...reserves.filter(p => fillsNeed(p, n)).map(p => p.ovr || 0));
    if (best > n.ovr) { n.gap -= best - n.ovr; n.internal = best; }
  }
  return out.filter(n => n.gap >= LEAGUE_TRADES.needGap).sort((x, y) => y.gap - x.gap);
}

/** Does this player fill the need? */
export function fillsNeed(p, need) {
  if (!p) return false;
  if (need.kind === 'sp') return p.pos === 'SP';
  if (need.kind === 'rp') return p.pos === 'RP';
  return !_isPitcher(p) && playsSlot(p, need.slot);
}

// ── Who can be moved ────────────────────────────────────────────────────────

/** Can this player be traded right now (healthy, settled, not just acquired)? */
export function movable(p, atMs) {
  return !!p && isAvailable(p) && !p.isInjured
    && ![PLAYER_GROUP.IN_TRANSIT, PLAYER_GROUP.IL, PLAYER_GROUP.FREE_AGENT, PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED].includes(p.group)
    && !p.onWaivers
    && !(p._acquiredAtMs && atMs - p._acquiredAtMs < TRADE.noFlipMs);
}

/** The organization's players (active roster and farm). */
function _org(t) {
  return [...(t.rosterIds || []), ...(t.farmIds || [])];
}

/** A CPU club doesn't move on a player it just traded for (a month, §90). */
function _settled(p, atMs, cpu) {
  return !cpu || !(p._acquiredAtMs && atMs - p._acquiredAtMs < LEAGUE_TRADES.reTradeMs);
}

/** The pieces a club would part with: not a key piece now (the player being replaced may go). */
function _spare(state, teamId, atMs, { keep = new Set(), allow = new Set() } = {}) {
  const t = _club(state, teamId);
  return _org(t).map(id => state.players[id])
    .filter(p => movable(p, atMs) && _settled(p, atMs, teamId !== 'user') && !keep.has(p.id)
              && (allow.has(p.id) || !isKeyPiece(p, state, teamId)));
}

// ── A deal from each side ───────────────────────────────────────────────────

/** The deal as evaluateForClub sees it for club `x` (x gives incomingIds, receives outgoingIds; cashK + = x pays). */
export function viewFor(deal, x) {
  const xIsA = x === deal.a;
  return {
    incomingIds: xIsA ? deal.bGets : deal.aGets,
    outgoingIds: xIsA ? deal.aGets : deal.bGets,
    cashK:       xIsA ? (deal.cashAtoB || 0) : -(deal.cashAtoB || 0),
    retain:      deal.retain || {},
  };
}

/** The deal from our side (user = club a): the offer shape the composer and Negotiation use. */
export function userOffer(deal) {
  return { incomingIds: [...deal.aGets], outgoingIds: [...deal.bGets], cashK: -(deal.cashAtoB || 0), retain: { ...(deal.retain || {}) } };
}

/** The ledger record that carries a deal out (TransactionEngine executes it). */
export function leagueTradeTx(deal, atMs) {
  return {
    id:          `tx-ltrade-${deal.a}-${deal.b}-${atMs}`,
    kind:        'trade',
    league:      true,               // §90 between two CPU clubs
    teamId:      deal.a,
    fromTeamId:  deal.b,
    offer: {
      incomingIds: [...deal.aGets],  // b → a
      outgoingIds: [...deal.bGets],  // a → b
      cashK:       -(deal.cashAtoB || 0),
      retain:      { ...(deal.retain || {}) },
    },
    why:         deal.why || null,
    createdAt:   atMs,
    effectiveAt: atMs,
    status:      'pending',
  };
}

/**
 * buildPackage(state, buyerId, sellerId, targetIds, opts) — what the buyer
 * sends for the seller's player(s): the fewest, smallest pieces the seller
 * would take (its bar), from what the buyer can spare; cash for a small gap;
 * the seller keeping part of a salary the buyer's owner can't carry.
 *   opts: { atMs, sellerBar, buyerSlack (null: the buyer's view isn't checked — our scout), allow }
 * Returns a deal, or null when nothing works.
 */
export function buildPackage(state, buyerId, sellerId, targetIds, opts = {}) {
  const atMs = opts.atMs ?? Date.now();
  const sellerBar = opts.sellerBar ?? 0;
  const targets = targetIds.map(id => state.players[id]).filter(Boolean);
  if (!targets.length || targets.some(p => !movable(p, atMs))) return null;
  const give = packageValue(targets.map(p => valueToClub(p, state, sellerId, false)));
  const need = give + sellerBar;
  // What the buyer can spare, ranked by what it's worth to the seller.
  const pool = _spare(state, buyerId, atMs, { allow: new Set(opts.allow || []), keep: new Set(opts.keep || []) })
    .map(p => ({ p, v: valueToClub(p, state, sellerId, true) }))
    .filter(x => x.v > 0)
    .sort((x, y) => y.v - x.v)
    .slice(0, LEAGUE_TRADES.maxPool);
  // The smallest combination (1–3 pieces) that reaches the seller's price,
  // or comes within cash of it.
  const combos = [];
  const n = pool.length;
  for (let i = 0; i < n; i++) {
    combos.push([pool[i]]);
    for (let j = i + 1; j < n; j++) {
      combos.push([pool[i], pool[j]]);
      for (let k = j + 1; k < n; k++) combos.push([pool[i], pool[j], pool[k]]);
    }
  }
  const sum = (c) => packageValue(c.map(x => x.v));
  const cashGapK = (gap) => Math.ceil((gap / Math.max(0.01, cashValue(1, state, sellerId))) / 25) * 25;
  const ranked = combos
    .map(c => ({ c, total: sum(c) }))
    .filter(x => x.total >= need - 6)
    // Fewest pieces first, then the closest to the price (a little short, made
    // up in cash, counts a bit worse than a little over).
    .map(x => ({ ...x, miss: x.total >= need ? x.total - need : (need - x.total) * 1.5 }))
    .sort((x, y) => (x.c.length - y.c.length) || (x.miss - y.miss));
  for (const { c, total } of ranked.slice(0, 40)) {
    const deal = { a: buyerId, b: sellerId, aGets: targets.map(p => p.id), bGets: c.map(x => x.p.id), cashAtoB: 0, retain: {} };
    if (total < need) {
      const k = cashGapK(need - total);
      if (!Finance.canSpend(state, k, buyerId)) continue;
      deal.cashAtoB = k;
    }
    if (_settle(state, deal, { sellerBar, buyerSlack: opts.buyerSlack ?? null })) return deal;
  }
  return null;
}

/**
 * Both clubs can live with it: the seller clears its bar, the buyer's owner
 * carries the payroll (or the seller keeps part of a salary), and — for a CPU
 * buyer — the buyer isn't overpaying more than it would to fill a need.
 */
function _settle(state, deal, { sellerBar, buyerSlack }) {
  const evB = () => evaluateForClub(viewFor(deal, deal.b), state, deal.b);
  const evA = () => evaluateForClub(viewFor(deal, deal.a), state, deal.a);
  let a = evA();
  if (!a.booksOk) {
    // A seller (or a club cutting) keeps paying part of the biggest salary it sends.
    if (clubMode(state, deal.b) !== 'seller' || remainingShare(state) <= 0) return false;
    const big = deal.aGets.map(id => state.players[id]).sort((x, y) => (y.contractSalary || 0) - (x.contractSalary || 0))[0];
    const over = a.payrollIn - a.payrollOut - Math.max(0, Finance.payrollRoom(state, deal.a));
    const pct = big?.contractSalary ? Math.ceil((over / big.contractSalary) * 20) / 20 : 1;
    if (!(pct > 0 && pct <= TRADE.maxRetainPct)) return false;
    deal.retain = { ...deal.retain, [big.id]: pct };
    a = evA();
    if (!a.booksOk) return false;
  }
  const b = evB();
  if (!(b.net >= sellerBar && b.booksOk && b.cashOk)) return false;
  if (buyerSlack != null && !(a.net >= -buyerSlack && a.cashOk)) return false;
  return true;
}

// ── The day's trades ────────────────────────────────────────────────────────

/** How likely a club with a need is to work the phones today. */
function _dailyChance(state) {
  const ph = state.phase;
  const c = LEAGUE_TRADES.dailyChance;
  if (ph === PHASE.OFFSEASON) return c.offseason;
  if (ph === PHASE.SPRING_TRAINING) return c.spring;
  const g = regularIndex(state);
  return g >= TRADE_DEADLINE_OPEN - 3 && g <= TRADE_DEADLINE_CLOSE ? c.deadline : c.season;
}

/**
 * findLeagueTrades(state, atMs, rand) — the trades CPU clubs make today
 * (each club in at most one). Returns deals with `why`: { need, mode }.
 */
export function findLeagueTrades(state, atMs, rand = Math.random) {
  if (!tradeWindow(state).open) return [];
  const desk = state.tradeDesk || {};
  const clubs = (state.leagueTeams || []).filter(t => !(atMs - (desk.lastTradeMs?.[t.id] || -Infinity) < LEAGUE_TRADES.clubRestMs));
  const norms = leagueNorms(state);
  const chance = _dailyChance(state);
  const used = new Set();
  const deals = [];
  const order = [...clubs].sort(() => rand() - 0.5);
  for (const buyer of order) {
    if (deals.length >= LEAGUE_TRADES.maxPerDay) break;
    if (used.has(buyer.id)) continue;
    const needs = clubNeeds(state, buyer.id, norms);
    if (!needs.length || rand() > chance) continue;
    const need = needs[0];
    const slack = LEAGUE_TRADES.buyerSlack[clubMode(state, buyer.id)] ?? 0;
    let best = null;
    for (const seller of clubs) {
      if (seller.id === buyer.id || used.has(seller.id)) continue;
      const fits = _org(seller).map(id => state.players[id])
        .filter(p => movable(p, atMs) && _settled(p, atMs, true) && fillsNeed(p, need) && (p.ovr || 0) >= need.ovr + LEAGUE_TRADES.upgradeMin)
        .sort((x, y) => (y.ovr || 0) - (x.ovr || 0))
        .slice(0, 3);
      for (const p of fits) {
        const deal = buildPackage(state, buyer.id, seller.id, [p.id], {
          atMs, sellerBar: 0, buyerSlack: slack, allow: need.incumbentId ? [need.incumbentId] : [],
          // never the club's own answer at the spot
          keep: _org(buyer).filter(id => id !== need.incumbentId && fillsNeed(state.players[id], need) && (state.players[id]?.ovr || 0) > need.ovr),
        });
        if (!deal) continue;
        const gain = (p.ovr || 0) - need.ovr;
        if (!best || gain > best.gain) best = { deal, gain, p };
      }
    }
    if (!best) continue;
    best.deal.why = { need: { kind: need.kind, slot: need.slot || null, incumbentId: need.incumbentId }, buyerMode: clubMode(state, buyer.id), sellerMode: clubMode(state, best.deal.b) };
    deals.push(best.deal);
    used.add(best.deal.a); used.add(best.deal.b);
  }
  return deals;
}

/** When the trade desk next opens (one moment a day, late morning to evening). */
export function nextDeskAt(afterMs, rand = Math.random) {
  const d = new Date(afterMs);
  d.setHours(24, 0, 0, 0);                       // the next calendar day
  d.setHours(10 + Math.floor(rand() * 8), Math.floor(rand() * 60), 0, 0);
  return d.getTime();
}

// ── Pro Scouting's packages for us (the 4c inbox cards) ─────────────────────

/**
 * scoutPackage(state, sellerId, targetId, atMs) — a deal we could offer: the
 * smallest package of our spare pieces their GM should take (their bar is
 * set by our rapport), our owner able to carry it. Null when nothing works.
 */
export function scoutPackage(state, sellerId, targetId, atMs) {
  return buildPackage(state, 'user', sellerId, [targetId], { atMs, sellerBar: clubBar(state, sellerId), buyerSlack: null });
}

/**
 * bestOption(state, need, atMs, exclude) — the best player on any CPU club
 * who would fill a need of ours and start for us, with the package for him.
 * Returns { teamId, playerId, deal } or null.
 */
export function bestOption(state, fits, atMs, { excludeTeams = new Set(), excludeIds = new Set() } = {}) {
  const cands = [];
  for (const t of state.leagueTeams || []) {
    if (excludeTeams.has(t.id)) continue;
    for (const id of _org(t)) {
      const p = state.players[id];
      if (excludeIds.has(id) || !movable(p, atMs) || !fits(p) || !wouldStart(p, state, 'user')) continue;
      cands.push({ t, p });
    }
  }
  cands.sort((x, y) => (y.p.ovr || 0) - (x.p.ovr || 0));
  for (const { t, p } of cands.slice(0, 6)) {
    const deal = scoutPackage(state, t.id, p.id, atMs);
    if (deal) return { teamId: t.id, playerId: p.id, deal };
  }
  return null;
}
