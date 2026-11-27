/**
 * engine/cards/Compose.js
 * CardEngine, compose card delivery (Phase 15, §8.12).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PERSONAL_LEAVE_POOL, DECISIONS_POOL, FOLLOWUP_POOL, PREGAME_POOL, PREGAME30_POOL, INGAME_POOL, BETWEEN_GAMES_POOL, COMPOSE_RESPONSE_POOL } from '../../data/cards-pool.js';
import { OFFDAY_POOL, ROAD_POOL, AWAY_FOLLOWUPS } from '../../data/cards-away.js';
import { WINTER_POOL } from '../../data/cards-winter.js';
import { PROFILE_POOL } from '../../data/cards-profile.js';
import * as Winter from '../WinterStory.js';
import * as Situations from '../Situations.js';
import * as Retirement from '../Retirement.js';
import * as Callbacks from '../Callbacks.js';
import * as Arcs from '../Arcs.js';
import { PHASE, PLAYER_GROUP, LEAGUE_TRADES, COMPOSE_REPLY, COMPOSE_OVERLAP, STAFF_QUIET, CALLBACK, ARC, RETIRE_PLAN } from '../../data/constants.js';
import { generateCPUCashSale, tradeWindow, tradeBlockers, busyWithUs, adjustRapport, wouldStart, clubMode } from '../TradeEngine.js';
import { selectCardVariant } from '../NarrativeEngine.js';
import { buildTokenMap, applyTokens } from '../CardTokens.js';
import { cardFeasible } from '../CardActions.js';
import * as Finance from '../FinanceEngine.js';
import { baseballYear, computeAge, isAvailable } from '../PlayerFactory.js';
import { replyTime } from '../CardScheduler.js';
import { MOMENT_CARDS } from '../../data/cards-moments.js';
import { FIRST_DAY_CORE, FIRST_DAY_SECONDARY, GM_HELLOS, NEW_GM_HELLOS, LATER_HELLOS } from '../../data/cards-first-day.js';
import { pickEmergency, answerBy } from '../Emergencies.js';
import { storyMoments, buildStep, buildAfter } from '../DeadlineStory.js';
import * as Stretch from '../StretchStory.js';
import { dealsOnTable } from '../TradeAdvice.js';
import { FIRST_DAY, CORE_SLOTS, firstDayTimes, gmHelloTimes, cpuGmName, newGms, tradedWith, GM_TURNOVER } from '../FirstDay.js';
import { MONEY_BETWEEN, MONEY_PREGAME } from '../../data/cards-money.js';
import * as LeagueTrades from '../LeagueTrades.js';
import { clockNow } from '../Clock.js';
import { dice, diceId, diceSeed, eventRand } from '../Dice.js';
import { _logDealt } from './CardLog.js';
import { _deliverAt, _rosterCard, _withdraw } from './Delivery.js';
import { releaseDueCards } from './FirstMoments.js';
import { _uuid } from './Helpers.js';
import { _sortComparator } from './Inbox.js';
import { ALL_POOLS } from './Pools.js';
import { _managerName } from './RosterCards.js';
import { _createInstance } from './Selection.js';
import { _offerCanGo, deliverTradeCall, deliverTradeOffer } from './TradeOffers.js';
import { toInbox, toSchedule, VIA } from './Entry.js';   // r291 §122.172
import { withHistory, toHistory } from '../MessageHistory.js';   // r292 §122.174 answered messages that dropped off

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
export function _maybeDeliverCashSale(state, context) {
  if (!_tradeWindowOpen(state, context)) return false;
  const now = clockNow();
  const teams = (state.leagueTeams || [])
    .filter(t => !busyWithUs(state, t.id, now))
    .map(t => ({ t, r: eventRand() }))
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
export function _tradeSalaryDelta(state, offer) {
  const ret = offer.retain || {};                // §85 a share the sending club keeps paying
  const inK  = (offer.incomingIds || []).reduce((a, id) => a + (state.players[id]?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  const outK = (offer.outgoingIds || []).filter(id => Finance.isPaid(state.players[id]))
    .reduce((a, id) => a + (state.players[id]?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  return { inK: Math.round(inK), outK: Math.round(outK) };
}

/** Both owners can carry the deal: ours (§78), and the CPU club's (§78.5) when named. */
export const _tradeSalaryOk = (state, offer, cpuId = null) => {
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
  const atMs = clockNow();
  if (!tradeWindow(st).open) return false;
  const shuffle = (xs) => xs.map(x => ({ x, r: eventRand() })).sort((a, b) => a.r - b.r).map(o => o.x);
  const tryCall = () => {
    for (const t of shuffle(st.leagueTeams || [])) {
      for (const need of LeagueTrades.clubNeeds(st, t.id).slice(0, 2)) {
        const fits = (st.userTeam.rosterIds || []).map(id => st.players[id])
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
      for (const id of t.rosterIds || []) {
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
  const order = eventRand() < 0.5 ? [tryCall, trySell] : [trySell, tryCall];
  return !!(order[0]() || order[1]());
}


/**
 * r211 §122.89 A new team's first day: the first-day messages between now and the first pitch (the core,
 * then more with more time, at random uneven staff-hours times) and three other clubs' GMs over the first
 * spring (one the first day, with enough time). Parked on the schedule like any message, so they push.
 * Versions are picked at random; a card that can't be written (no player for its tokens) is skipped.
 * Returns the cards parked.
 */
export function scheduleFirstDay(context) {
  const st = StateManager.get();
  const now = clockNow();
  const first = (st.schedule || [])[0];
  if (!first?.gameTime) return [];
  const r = dice(diceSeed(st), 'first-day');
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const quiet = STAFF_QUIET;   // r213 §122.91
  const plan = firstDayTimes(now, first.gameTime, quiet, r);
  // Which cards: one version per core slot (in order of importance), then the secondary, shuffled.
  const core = CORE_SLOTS.slice(0, plan.core).map(slot => pick(FIRST_DAY_CORE[slot]));
  const second = [...FIRST_DAY_SECONDARY].map(c => ({ c, k: r() })).sort((a, b) => a.k - b.k).map(o => o.c);
  // Other GMs: three clubs (not one already on the phone with us).
  const busy = new Set((st.inbox || []).map(c => c.sender || ''));
  const clubs = (st.leagueTeams || []).filter(t => ![...busy].some(s => s.includes(t.name)))
    .map(t => ({ t, k: r() })).sort((a, b) => a.k - b.k).map(o => o.t).slice(0, FIRST_DAY.gmHellos);
  const hellos = [...GM_HELLOS].map(c => ({ c, k: r() })).sort((a, b) => a.k - b.k).map(o => o.c);
  const hello = (t, def) => _gmHelloDef(st, t, def);
  const gmFirstDay = clubs.length && plan.hours >= FIRST_DAY.gmHelloFirstDayHours && plan.secondary > 0;
  const fill = [];
  if (gmFirstDay) fill.push(hello(clubs[0], hellos[0]));
  fill.push(...second);
  // Into the times: the core at their spread places, the rest in between.
  const slots = new Map(plan.coreAt.map((ix, i) => [ix, core[i]]));
  const parked = [];
  let f = 0;
  plan.times.forEach((at, ix) => {
    const def = slots.get(ix) || fill[f++];
    if (!def) return;
    const inst = _createInstance(def, context || {}, StateManager.get());
    if (!inst) return;
    // r233 §122.112 a message about the first game is due before its first pitch (not in two games)
    if (def._beforeFirstGame) { inst.expiresAt = null; inst.expiresAtMs = first.gameTime - 10 * 60_000; }
    const extra = def._gmTeamId ? { _gmTeamId: def._gmTeamId, _gmSeason: st.seasonNum || 1 } : {};
    const card = _deliverAt({ ...inst, ...extra, _firstDay: true, _rosterKey: `firstday:${def.id}:${def._gmTeamId || ''}` }, at);
    if (card) parked.push(card);
  });
  // The other GMs, through the rest of the spring.
  const rest = clubs.slice(gmFirstDay ? 1 : 0);
  gmHelloTimes(now, rest.length, quiet, r).forEach((at, i) => {
    const def = hello(rest[i], hellos[(gmFirstDay ? 1 : 0) + i]);
    const inst = _createInstance(def, context || {}, StateManager.get());
    if (!inst) return;
    const card = _deliverAt({ ...inst, _gmTeamId: def._gmTeamId, _gmSeason: st.seasonNum || 1, _firstDay: true, _rosterKey: `firstday:${def.id}:${def._gmTeamId}` }, at);
    if (card) parked.push(card);
  });
  return parked;
}


/**
 * r213 §122.91 An emergency in the night, at its moment: which one (from the club as it stands), written now,
 * delivered now, due by morning (and before first pitch). If it goes unanswered, the staff handle it — and
 * whether that goes well or badly is settled now (its own dice), so the look-ahead foresees it exactly.
 * Returns the card, or null (nothing fits, or it can't be written).
 */
export function deliverEmergency(atMs, context = {}) {
  const st = StateManager.get();
  const r = dice(diceSeed(st), 'emergency', st.seasonNum || 1, atMs);
  const def = pickEmergency(st, atMs, r);
  if (!def) return null;
  const bad = def._staffBad && r() < def._staffBad.p;
  const inst = _createInstance({ ...def, _expireMsg: bad ? def._staffBad.msg : def._staffGood }, context || {}, st);
  if (!inst) return null;
  const card = { ...inst, type: 'urgent', _urgent: true, _emergency: true, _emergencyBad: bad ? def._staffBad.effect : null,
                 expiresAtMs: answerBy(st, atMs), _rosterKey: `emergency:${st.seasonNum || 1}:${atMs}:${def.id}` };
  StateManager.mutate(s => {
    s.emergencies = { ...(s.emergencies || {}), used: [...new Set([...(s.emergencies?.used || []), def.id])],
                      situations: [...new Set([...(s.emergencies?.situations || []), def._situation])] };
  });
  const parked = _deliverAt(card, atMs);
  releaseDueCards(atMs);
  return parked;
}


/**
 * r215 §122.94 The deadline story, one step at its moment (DeadlineStory): marks the step done, writes it from the
 * club as it stands and what the GM has decided, and delivers it. Selling and ahead of the market: a buyer calls
 * for one of our veterans instead of a shortlist. A step whose moment is long past (a save from before r215) is
 * marked done and skipped. Returns the cards delivered.
 */
export function deliverDeadlineStep(atMs, context = {}) {
  const st = StateManager.get();
  const season = st.seasonNum || 1;
  const m = storyMoments(st).find(x => x.atMs === atMs && !(st.deadline?.season === season && st.deadline.done?.[x.key]));
  if (!m) return [];
  StateManager.mutate(s => {
    if (s.deadline?.season !== season) s.deadline = { season, stance: null, done: {} };
    s.deadline.done = { ...(s.deadline.done || {}), [m.key]: true };
  });
  if (clockNow() - atMs > 36 * 3_600_000) return [];
  const now = StateManager.get();
  const ctx = { ...context, dealsOnTable: m.key === 'final' ? dealsOnTable(now, atMs) : [] };
  const out = [];
  if (m.key === 'shortlist' && now.deadline?.stance === 'sell' && now.deadline?.ahead) {
    // A buyer calls for one of our veterans (the best whose deal is up, else our oldest regular).
    const u = now.userTeam;
    const regs = [...(u.lineupSlots || []).map(x => x.playerId), ...(u.rotation?.order || [])].map(id => now.players[id]).filter(p => p && isAvailable(p));
    const year = baseballYear(now);
    const vets = regs.sort((a, b) => computeAge(b.dob, year) - computeAge(a.dob, year)).slice(0, 3);
    const buyers = (now.leagueTeams || []).filter(t => clubMode(now, t.id) === 'buyer');
    for (const p of vets) {
      let sent = false;
      for (const b of buyers) {
        const call = LeagueTrades.callOffer(now, b.id, p.id, atMs);
        if (call && deliverTradeCall({ ...call.deal, room: call.room }, atMs)) { sent = true; break; }
      }
      if (sent) break;
    }
    return out;
  }
  const specs = m.key === 'after' ? buildAfter(now, ctx, atMs) : [buildStep(m.key, now, ctx, atMs)].filter(Boolean);
  specs.forEach((spec, i) => {
    const card = _rosterCard(StateManager.get(), { ...spec, _deadlineSeason: season });
    const at = atMs + i * (20 + Math.floor(dice(diceSeed(now), 'deadline-after', season, i)() * 50)) * 60_000;
    const parked = _deliverAt(card, at);
    if (parked) out.push(parked);
  });
  releaseDueCards(atMs);
  return out;
}


/**
 * r216 §122.95 The stretch run and October, one step at its moment (StretchStory): marked done, written from the
 * race (or the series) as it stands, delivered (a step with two messages, the second a little later). A step long
 * past is skipped. Returns the cards delivered.
 */
export function deliverStretchStep(atMs, context = {}) {
  const st = StateManager.get();
  const season = st.seasonNum || 1;
  const m = Stretch.storyMoments(st).find(x => x.atMs === atMs && !(st.stretch?.season === season && st.stretch.done?.[x.key]));
  if (!m) return [];
  StateManager.mutate(s => {
    if (s.stretch?.season !== season) s.stretch = { season, done: {} };
    s.stretch.done = { ...(s.stretch.done || {}), [m.key]: true };
  });
  if (clockNow() - atMs > 36 * 3_600_000) return [];
  const built = Stretch.buildStep(m, StateManager.get(), context, atMs);
  const specs = (Array.isArray(built) ? built : [built]).filter(Boolean);
  const out = [];
  specs.forEach((spec, i) => {
    const at = atMs + i * (15 + Math.floor(dice(diceSeed(st), 'stretch-gap', season, m.key, i)() * 45)) * 60_000;
    const parked = _deliverAt(_rosterCard(StateManager.get(), spec), at);
    if (parked) out.push(parked);
  });
  releaseDueCards(atMs);
  return out;
}


/**
 * r218 §122.97 The winter's day (WinterStory): a quiet day's message, at its midday moment. A moment long past (the
 * app closed for days) is marked done and skipped. A decision waits three days for an answer. Returns the cards parked.
 */
export function deliverWinterStep(atMs, context = {}) {
  const st = StateManager.get();
  const season = st.seasonNum || 1;
  const m = Winter.winterDays(st, atMs).find(x => x.atMs === atMs && !(st.winter?.season === season && st.winter.done?.[x.key]));
  if (!m) return [];
  const late = clockNow() - atMs > 36 * 3_600_000;
  const def = late ? null : Winter.pickCard(st, atMs, WINTER_POOL);
  StateManager.mutate(s => {
    if (s.winter?.season !== season) s.winter = { season, done: {}, used: {} };
    s.winter.done = { ...(s.winter.done || {}), [m.key]: true };
    if (def) s.winter.used = { ...(s.winter.used || {}), [def.id]: (s.winter.used?.[def.id] || 0) + 1 };
    if (def?._needsSeries) s.winter.lastLine = Winter.seriesLine(st);
  });
  if (!def) return [];
  const champ = st.playoffBracket?.champion?.name || '';
  const line = Winter.seriesLine(st) || '';
  const fill = (v) => (typeof v === 'string' ? v.replaceAll('{champion_name}', champ).replaceAll('{series_line}', line) : v);
  const inst = _createInstance(Object.fromEntries(Object.entries(def).map(([k, v]) => [k, fill(v)])), context, StateManager.get());
  if (!inst) return [];
  const card = _deliverAt({ ...inst, _winterCard: true, _rosterKey: `winter:${season}:${m.key}`, expiresAtMs: atMs + (def._toastOnly ? 1 : 3) * 86_400_000 }, atMs);
  releaseDueCards(atMs);
  return card ? [card] : [];
}


/**
 * r218 §122.97 After one of our regular-season games (`atMs`, its final): the situation most worth a word (Situations),
 * the next morning (9:30–11:00) — at most one a day, never one that can't happen (a day off nobody can cover).
 * Returns the card parked, or null.
 */
export function deliverSituation(atMs, context = {}) {
  const st = StateManager.get();
  if (![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK].includes(st.phase)) return null;
  const morning = new Date(atMs - 4 * 3_600_000); morning.setDate(morning.getDate() + 1); morning.setHours(9, 30, 0, 0);
  const at = morning.getTime() + Math.floor(dice(diceSeed(st), 'situation', atMs)() * 90) * 60_000;
  const dayKey = new Date(at).toDateString();
  if ([...(st.inbox || []), ...(st.scheduledCards || [])].some(c => c._situation && new Date(c.deliverAtMs ?? c.arrivedAtMs).toDateString() === dayKey)) return null;
  for (const sit of Situations.findSituations(st, at)) {
    const spec = Situations.buildCard(sit, st, at);
    if (!spec || (Number.isFinite(spec.expiresAtMs) && spec.expiresAtMs - at < 2 * 3_600_000)) continue;
    const inst = _rosterCard(st, spec);
    if (!cardFeasible(st, inst)) continue;
    const card = _deliverAt(inst, at);
    if (!card) continue;
    StateManager.mutate(s => { s.situations = { ...(s.situations || {}), done: { ...(s.situations?.done || {}), [sit.key]: at, ...Object.fromEntries((sit.also || []).map(k => [k, at])) } }; });
    return card;
  }
  return null;
}


/**
 * r222 §122.101 After one of our regular-season games (`atMs`, its final): every player's plan for the season settled
 * (a player who joined the league since), and a player of ours planning to retire tells the manager at their tell game —
 * the manager's word the next morning (10:00–11:30). One who came to us after telling their old club is simply known
 * (no word). Returns the cards parked.
 */
export function deliverRetirePlans(atMs, context = {}) {
  if (Object.values(StateManager.get().players || {}).some(p => p && p.retireIntent?.season !== (StateManager.get().seasonNum || 1)
    && p.group !== PLAYER_GROUP.RETIRED && p.group !== PLAYER_GROUP.DEPARTED)) StateManager.mutate(s => { Retirement.settlePlans(s); });
  const st = StateManager.get();
  if (![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK].includes(st.phase)) return [];
  const season = st.seasonNum || 1, played = Retirement.gamesPlayed(st);
  const due = (st.userTeam?.rosterIds || []).map(id => st.players[id])
    .filter(p => p && p.teamId === 'user' && p.retireIntent?.season === season && p.retireIntent.retiring && !p.retireIntent.told && played >= p.retireIntent.tell);
  if (!due.length) return [];
  const day = new Date(atMs - 4 * 3_600_000); day.setDate(day.getDate() + 1); day.setHours(10, 0, 0, 0);
  const r = dice(diceSeed(st), 'retire-word', atMs);
  const cards = [];
  for (const p of due) {
    if (played - p.retireIntent.tell <= RETIRE_PLAN.lateGames) {
      const at = day.getTime() + Math.floor(r() * 90) * 60_000;
      const left = Math.max(0, (p.contractExpiry ?? season + 1) - season - 1);
      const deal = left === 1 ? ' They\'ll walk away from the last year of the deal.' : left > 1 ? ` They'll walk away from the last ${left} years of the deal.` : '';
      const inst = _rosterCard(st, { type: 'normal', sender: _managerName(st), avatar: '📋', tag: 'ROSTER', _targetPlayerId: p.id,
        cardId: 'retire_plan', _rosterKey: `retire:${p.id}:${season}`, expiresAtMs: at + 36 * 3_600_000,
        subject: `${p.name} plans to retire`, preview: `${p.name} came to see me after the game…`,
        body: `${p.name} came to see me after the game: this will be their last season. The decision is made, and they wanted the club to hear it first.${deal}`,
        yesLabel: 'Got It', noLabel: null, autoResolve: 'yes', _news: true, yesEffect: {}, _raw: {} });
      const card = _deliverAt(inst, at);
      if (card) cards.push(card);
    }
    StateManager.mutate(s => { const q = s.players[p.id]; if (q?.retireIntent) q.retireIntent = { ...q.retireIntent, told: true }; });
  }
  return cards;
}


/**
 * r220 §122.99 After one of our games (`atMs`, its final), now and then: a callback to a decision the GM made
 * (Callbacks), the next afternoon (1–4pm) — at most one a day. Returns the card parked, or null.
 */
export function deliverCallback(atMs, context = {}) {
  const st = StateManager.get();
  const r = dice(diceSeed(st), 'callback', atMs);
  if (r() >= CALLBACK.chance) return null;
  const day = new Date(atMs - 4 * 3_600_000); day.setDate(day.getDate() + 1); day.setHours(13, 0, 0, 0);
  const at = day.getTime() + Math.floor(r() * 180) * 60_000;
  const dayKey = new Date(at).toDateString();
  if ([...(st.inbox || []), ...(st.scheduledCards || [])].some(c => c._callback && new Date(c.deliverAtMs ?? c.arrivedAtMs).toDateString() === dayKey)) return null;
  const pick = Callbacks.pickCallback(st, at, r);
  if (!pick) return null;
  const key = Callbacks.useKey(pick.cb, pick.e);
  const spec = pick.cb.build(st, pick.e, pick.ctx, at);
  const inst = _rosterCard(st, { type: 'normal', ...spec, cardId: `cb_${pick.cb.key}`, _callback: pick.cb.key, _rosterKey: `cb:${key}`,
    expiresAtMs: at + 24 * 3_600_000, _raw: spec._raw || {} });
  if (!cardFeasible(st, inst)) return null;
  const card = _deliverAt(inst, at);
  if (!card) return null;
  StateManager.mutate(s => { s.callbacks = { used: { ...(s.callbacks?.used || {}), [key]: at, ...(pick.e.p ? { [Callbacks.playerKey(pick.cb, pick.e)]: at } : {}) } }; });
  return card;
}


/**
 * r221 §122.100 The story arcs, after one of our regular-season games (`atMs`, its final): the next step of an arc
 * that's running (its previous answer in, its time come, its people still here), or — with fewer than ARC.maxActive
 * running — now and then a new one (Arcs.pickArc). One step a day, the next day 11:00–12:30. Returns the cards parked.
 */
export function advanceArcs(atMs, context = {}) {
  let st = StateManager.get();
  if (![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK].includes(st.phase)) return [];
  const season = st.seasonNum || 1;
  const r = dice(diceSeed(st), 'arcs', atMs);
  const day = new Date(atMs - 4 * 3_600_000); day.setDate(day.getDate() + 1); day.setHours(11, 0, 0, 0);
  const at = day.getTime() + Math.floor(r() * 90) * 60_000;
  const DAYMS = 86_400_000;
  const setArcs = (fn) => StateManager.mutate(s => { s.arcs = s.arcs || { active: [], done: {} }; fn(s.arcs, s); });
  // (a season's arcs end with it)
  if ((st.arcs?.active || []).some(a => a.s !== season)) setArcs(A => { A.active = A.active.filter(a => a.s === season); });
  if ([...(st.inbox || []), ...(st.scheduledCards || [])].some(c => c._arc && new Date(c.deliverAtMs ?? c.arrivedAtMs).toDateString() === new Date(at).toDateString())) return [];

  const deliver = (arc, spec) => {
    const stNow = StateManager.get();
    const make = (sp) => _rosterCard(stNow, { type: 'normal', expiresAtMs: at + (sp._news ? 36 : 48) * 3_600_000, ...sp,
      cardId: `arc_${arc.key}`, _arc: arc.key, _rosterKey: `arc:${arc.id}:${arc.step}`, _raw: sp._raw || {}, _fallback: undefined });
    let used = spec, inst = make(spec);
    if (!cardFeasible(stNow, inst)) {
      if (!spec._fallback) return null;
      used = spec._fallback; inst = make(used);
      if (!cardFeasible(stNow, inst)) return null;
    }
    const card = _deliverAt(inst, at);
    if (!card) return null;
    const def = Arcs.ARCS.find(d => d.key === arc.key);
    const next = def.steps[arc.step + 1];
    const gap = next?.after ? next.after[0] + r() * (next.after[1] - next.after[0]) : 0;
    setArcs((A, s) => {
      const a = A.active.find(x => x.id === arc.id);
      if (a) { a.at = { ...a.at, [arc.step]: at }; a.step = arc.step + 1; a.nextAt = at + gap * DAYMS; a.lastAt = at; a.maxAt = next?.after ? at + (next.within ?? next.after[1]) * DAYMS : null; }
      // what the step itself set in motion: a coach who took the job leaves after the season (a veteran with no year
      // left retires on their plan — r222 §122.101)
      if (used._arcCoachLeaves) { const c = s.userTeam.coachingStaff?.[arc.who.role]; if (c) c._leaving = { season: s.seasonNum || 1, clubId: arc.who.club }; }
    });
    return card;
  };

  // 1. A running arc's next step.
  for (const stored of [...(StateManager.get().arcs?.active || [])]) {
    st = StateManager.get();
    let arc = { ...stored, picks: { ...(stored.picks || {}) }, who: { ...stored.who } };   // (a copy: the save changes only in a mutate)
    const def = Arcs.ARCS.find(d => d.key === arc.key);
    const finish = () => setArcs(A => { A.active = A.active.filter(x => x.id !== arc.id); });
    if (!def || !def.alive(st, arc)) { finish(); continue; }
    const last = arc.step - 1;
    if (last >= 0 && arc.picks?.[last] == null) {
      const c = [...withHistory(st), ...(st.scheduledCards || [])].find(x => x._rosterKey === `arc:${arc.id}:${last}`);   // r292 §122.174 with the history
      if (c && !c.resolved) continue;   // (still waiting for an answer)
      const pick = !c ? 'no' : !c.noLabel ? 'yes' : c.choice === 'auto' ? (c.autoChoice || 'no') : c.choice === 'skip' ? 'none' : c.choice;
      setArcs(A => { const a = A.active.find(x => x.id === arc.id); if (a) a.picks = { ...(a.picks || {}), [last]: pick }; });
      arc = { ...arc, picks: { ...arc.picks, [last]: pick } };
    }
    if (arc.step >= def.steps.length) { finish(); continue; }
    if (at < arc.nextAt) continue;
    const step = def.steps[arc.step];
    if (step.when && !step.when(st, arc)) { if (arc.maxAt != null && at > arc.maxAt) finish(); continue; }
    const spec = step.build(st, arc, r);
    if (!spec) { finish(); continue; }
    const card = deliver(arc, spec);
    if (card) return [card];
    finish();
  }

  // 2. A new arc.
  st = StateManager.get();
  if ((st.arcs?.active || []).length >= ARC.maxActive || r() >= ARC.startChance) return [];
  const pick = Arcs.pickArc(st, at, r);
  if (!pick) return [];
  const arc = { id: diceId(r), key: pick.def.key, s: season, who: pick.who, step: 0, picks: {}, at: {}, nextAt: at, startedAt: at };
  setArcs(A => { A.active.push(arc); A.done = { ...(A.done || {}), [pick.def.doneKey(st, pick.who)]: at }; });
  const spec = pick.def.steps[0].build(StateManager.get(), arc, r);
  const card = spec && deliver(arc, spec);
  if (!card) setArcs(A => { A.active = A.active.filter(x => x.id !== arc.id); });
  return card ? [card] : [];
}


/** A GM's hello, written for one club: its GM's name and the club's, the answer moving our standing with them. */
function _gmHelloDef(st, t, def) {
  const gm = cpuGmName(st, t.id);
  const fill = (v) => (typeof v === 'string' ? v.replaceAll('{gm}', gm).replaceAll('{club}', t.name) : v);
  const d = Object.fromEntries(Object.entries(def).map(([k, v]) => [k, fill(v)]));
  return { ...d, onYes: 'gm_rapport_yes', onNo: 'gm_rapport_no', _gmTeamId: t.id };
}


/**
 * r212 §122.90 Every spring after the first (at spring's opening): each club with a new GM — the GM reaches out
 * (unless we welcome them first: Compose → Other GMs, which takes the hello back) — and one club we've never
 * traded with. Staff hours, spring days 1–10. Returns the cards parked.
 */
export function scheduleSpringGms(atMs = clockNow(), context = {}) {
  const st = StateManager.get();
  const season = st.seasonNum || 1;
  if (season < 2) return [];
  const r = dice(diceSeed(st), 'spring-gms', season);
  const quiet = STAFF_QUIET;   // r213 §122.91
  const fresh = newGms(st);
  const traded = tradedWith(st);
  const strangers = (st.leagueTeams || []).filter(t => !traded.has(t.id) && !fresh.some(f => f.id === t.id));
  const later = strangers.length ? [strangers[Math.floor(r() * strangers.length)]] : [];
  const shuffle = (xs) => xs.map(c => ({ c, k: r() })).sort((a, b) => a.k - b.k).map(o => o.c);
  const nh = shuffle([...NEW_GM_HELLOS]), lh = shuffle([...LATER_HELLOS]);
  const who = [...fresh.map((t, i) => ({ t, def: nh[i % nh.length], kind: 'new' })), ...later.map((t, i) => ({ t, def: lh[i % lh.length], kind: 'later' }))];
  const times = gmHelloTimes(atMs, who.length, quiet, r);
  const parked = [];
  who.forEach(({ t, def, kind }, i) => {
    const d = _gmHelloDef(st, t, def);
    const inst = _createInstance(d, context || {}, StateManager.get());
    if (!inst || !Number.isFinite(times[i])) return;
    const card = _deliverAt({ ...inst, _gmTeamId: t.id, _gmSeason: season, _gmKind: kind, _rosterKey: `gmhello:${season}:${t.id}` }, times[i]);
    if (card) parked.push(card);
  });
  return parked;
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

  const arrivedAtMs = clockNow();
  StateManager.mutate(s => {
    toInbox(s, instances, () => arrivedAtMs, VIA.SEED);   // r291 §122.172
    for (const c of instances) _logDealt(s, { ...c, deliverAtMs: arrivedAtMs });   // §122.60 the opening slate counts too (sp1 came again)
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
export function deliverCardById(cardId, context = {}) {
  if (!cardId) return;

  // Search all pools for the card definition
  const allPools = [
    DECISIONS_POOL,
    FOLLOWUP_POOL,
    PREGAME_POOL,
    PREGAME30_POOL,
    INGAME_POOL,
    BETWEEN_GAMES_POOL,
    PERSONAL_LEAVE_POOL,                          // §122.60 (a player's leave)
    MONEY_BETWEEN, MONEY_PREGAME,                 // r147 the money cards
    ...Object.values(MOMENT_CARDS),               // and the moments, too
    OFFDAY_POOL, ROAD_POOL, AWAY_FOLLOWUPS,       // r217 §122.96 off days and the road
    WINTER_POOL,                                  // r218 §122.97 the winter
    PROFILE_POOL,                                 // r219 §122.98 the GM's reputation
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
  const instance = _createInstance(cardDef, context || {}, state);
  if (!instance) return;

  StateManager.mutate(s => {
    toInbox(s, [{ ...instance, _debugInjected: true }], () => clockNow(), VIA.DEBUG);   // r291 §122.172
  });
  return instance;
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
export function deliverComposeCard(topicId, channelId, { topicLabel = '', nowMs = clockNow(), arg = null } = {}) {
  // r212 §122.90 welcoming a new GM first: it goes further than answering their hello, which is taken back.
  if (topicId === 'gm_welcome' && arg?.key) {
    const season = StateManager.get().seasonNum || 1;
    arg = { ...arg, season };
    StateManager.mutate(s => { adjustRapport(s, arg.key, GM_TURNOVER.welcomeBonus); });
    _withdraw(c => c._rosterKey === `gmhello:${season}:${arg.key}`);
  }
  // r238 §122.117 a message offering what the GM just asked for is moot: on its way, or unanswered in Messages.
  _withdraw(c => !c.isCompose && COMPOSE_OVERLAP.cards[c.cardId] === topicId);
  const state   = StateManager.get();
  const cardDef = COMPOSE_RESPONSE_POOL[topicId];

  // §105 the reply comes back later, not at once: when this person would write back.
  const [minMin, maxMin] = COMPOSE_REPLY.windows[channelId] || COMPOSE_REPLY.defaultWindow;
  let deliverAtMs = replyTime({
    nowMs, minMin, maxMin,
    ...STAFF_QUIET,   // r213 §122.91
    busy: COMPOSE_REPLY.gameWorkers.includes(channelId) ? _userGameWindows(state, nowMs) : [],
  });
  // r150 a question about something with a deadline (a trade on the table) is answered before it.
  if (Number.isFinite(arg?.expiresAtMs)) deliverAtMs = Math.min(deliverAtMs, _answerBy(nowMs, arg.expiresAtMs));
  // §106 written when it comes back (releaseDueCards), from the club as it stands then; until then the
  // card carries only what the GM's phone needs (who, "Re: …") and the pool's text as a fallback.
  const pending = { isCompose: true, _composeTopic: topicId, _composeChannel: channelId, _composeWrite: true,
                    _composeLabel: topicLabel, _sentAtMs: nowMs, deliverAtMs, deliveredAt: deliverAtMs,
                    ...(arg ? { _composeArg: arg } : {}) };

  let instance;
  if (!cardDef) {
    // Fallback — generic acknowledgement for topics not yet in the pool
    instance = {
      instanceId:   _uuid(),
      cardId:       `compose_${topicId}`,
      type:         'normal',
      tag:          'OPERATIONS',
      sender:       'Staff',
      avatar:       '📋',
      subject:      'Message received',
      preview:      'Your message has been noted.',
      body:         'Your message was received. The staff will follow up if there\'s anything that needs your attention.',
      autoResolved: true,
      _resolved:    false,
      gameIdx:      state.currentGameIndex || 0,
      yesLabel:     'Noted',
      ...pending,
    };
  } else {
    const context  = _buildContextForCompose(state, channelId);
    // Select region-aware / narrative-aware variant before token resolution
    const chosenBody = _selectComposeVariant(cardDef, state);
    const { values } = buildTokenMap(cardDef, context, state);
    const body       = applyTokens(chosenBody,           values);
    const subject    = applyTokens(cardDef.subject || '', values);
    instance = {
      instanceId:   _uuid(),
      cardId:       cardDef.id,
      type:         cardDef.type   || 'normal',
      tag:          cardDef.tag    || 'OPERATIONS',
      sender:       applyTokens(cardDef.sender  || 'Staff', values),
      avatar:       cardDef.avatar || '📋',
      subject,
      preview:      subject,
      body,
      autoResolved: true,
      _resolved:    false,
      gameIdx:      state.currentGameIndex || 0,
      yesLabel:     cardDef.yesLabel || 'Noted',
      yesEffect:    cardDef.yesEffect || {},
      _raw:         cardDef,
      ...pending,
    };
  }

  if (topicLabel) { instance.subject = `Re: ${topicLabel}`; instance.preview = instance.subject; }
  // Waits with the other scheduled cards; releaseDueCards() puts it in the inbox (and the push worker alerts) on time.
  StateManager.mutate(s => {
    toSchedule(s, [instance], VIA.COMPOSE);   // r291 §122.172
  });
  return instance;
}


/**
 * r150 when a reply about something with a deadline must land: COMPOSE_REPLY.beforeDeadlineMs
 * ahead of it, and never sooner than COMPOSE_REPLY.soonestMs after sending — inside a short
 * deadline, halfway there.
 */
function _answerBy(nowMs, deadlineMs) {
  const by = deadlineMs - COMPOSE_REPLY.beforeDeadlineMs;
  if (by >= nowMs + COMPOSE_REPLY.soonestMs) return by;
  return nowMs + Math.max(60_000, Math.min(COMPOSE_REPLY.soonestMs, Math.floor((deadlineMs - nowMs) / 2)));
}


/** Messages the GM sent that haven't been answered yet (§105), oldest first. */
export function pendingComposeReplies(state = StateManager.get()) {
  return (state?.scheduledCards || []).filter(c => c.isCompose).sort((a, b) => (a._sentAtMs || 0) - (b._sentAtMs || 0));
}


/** Our games that keep field staff busy from now on: [first pitch, about when it ends]. */
function _userGameWindows(state, nowMs) {
  const out = [];
  for (const g of state.schedule || []) {
    if (g._committed || !Number.isFinite(g.gameTime)) continue;
    const lastPlay = (g.plays || []).reduce((m, p) => Math.max(m, p._timestamp || 0), 0);
    const end = lastPlay || g.gameTime + COMPOSE_REPLY.gameLengthMs;
    if (end <= nowMs) continue;
    if (g.gameTime > nowMs + 2 * 86_400_000) break;
    out.push([g.gameTime, end]);
  }
  return out;
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
/**
 * r267 §122.146 the Messages badges (the nav bar's and the Inbox tab's), from one place: unread messages, and the
 * ones still waiting on an answer (read or not). → { unread, todo, badge: { n, tone: 'unread' | 'waiting' } | null }
 * Unread wins (red); with none unread, what still needs an answer (muted).
 */
export function inboxCounts() {
  const inbox = getInbox();
  const unread = inbox.filter(c => !c._readAt).length, todo = inbox.length;
  return { unread, todo, badge: unread ? { n: unread, tone: 'unread' } : todo ? { n: todo, tone: 'waiting' } : null };
}


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
/**
 * markRead(instanceId) — §115 the GM opened the message (Messages screen):
 * it reads as read from now on (the list's bold sender and unread dot).
 */
export function markRead(instanceId, atMs = clockNow()) {
  const card = (StateManager.get().inbox || []).find(c => c.instanceId === instanceId);
  if (!card || card._readAt) return false;
  StateManager.mutate(s => {
    const c = (s.inbox || []).find(x => x.instanceId === instanceId);
    if (c && !c._readAt) c._readAt = atMs;
  });
  return true;
}


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
      .map(c => (clearedSet.has(c.instanceId) ? { ...c, _cleared: true } : c));
    // r292 §122.174 cleared ones from earlier seasons go, leaving notes (MessageHistory), as the trim's do
    toHistory(s, s.inbox.filter(c => c._cleared && !c._keep && (c._expiredSeason ?? season) < season));
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
