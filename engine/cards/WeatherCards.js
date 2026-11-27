/**
 * engine/cards/WeatherCards.js
 * CardEngine, weather decisions (§102.5).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { GAME_WEATHER, FIELD_CARE } from '../../data/constants.js';
import * as When from '../When.js';
import { reconcileRoster, applyRosterMutation } from '../RosterEngine.js';
import { queueTrade, tradeWindow, wouldStart } from '../TradeEngine.js';
import { dropPlayer } from '../TransactionEngine.js';
import { formatK } from '../CardTokens.js';
import * as Development from '../DevelopmentEngine.js';
import * as Finance from '../FinanceEngine.js';
import { isAvailable } from '../PlayerFactory.js';
import * as LeagueTrades from '../LeagueTrades.js';
import { starterRested } from '../PitchingEngine.js';
import { dice, diceSeed, eventRand, withDice } from '../Dice.js';
import { _list } from './AllStarCards.js';
import { _unlogDealt } from './CardLog.js';
import { _cardsWithKey, _clock, _deliverAt, _rosterCard, _withdraw } from './Delivery.js';
import { _deliverWatchCard } from './LeagueTradeCards.js';
import { _who } from './OffseasonCards.js';
import { _voice } from './OwnerCards.js';
import { ALL_POOLS } from './Pools.js';
import { expire } from './Promises.js';
import { _deliverNotice, _managerName } from './RosterCards.js';
import { _offerCanGo, deliverTradeOffer } from './TradeOffers.js';

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
        + `If play stops for ${GAME_WEATHER.ARM_COOL_MIN} minutes or more, the pitcher on the mound doesn't go back out — a start cut short still counts as that pitcher's start. `
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


/**
 * r170 the groundskeeper reads the forecast for one of our home games (FIELD_CARE.prep.leadH ahead):
 * the extra crew and the full tarp setup for that game, at a price by the forecast — answered before
 * the game's weather is settled. It won't stop a storm; if the rain misses us, the money is spent.
 */
export function deliverFieldPrepCard(info, atMs) {
  const state = StateManager.get();
  const what = info.kind === 'storms' ? 'storms' : info.kind === 'snow' ? 'snow' : 'rain';
  const wet = info.wetIn >= FIELD_CARE.prep.wetIn;
  const inches = (x) => `${(Math.round(x * 10) / 10).toFixed(1)} inch${Math.round(x * 10) === 10 ? '' : 'es'}`;
  return _deliverAt(_rosterCard(state, {
    cardId: 'field_prep', tag: 'WEATHER', sender: 'Head Groundskeeper', avatar: '🌱', type: 'normal',
    _rosterKey: `wx:field:${state.seasonNum || 1}:${info.gameTime}`, _fieldGameTime: info.gameTime, _fieldCostK: info.costK,
    subject: `${info.chance >= FIELD_CARE.prep.minChance ? `${what[0].toUpperCase()}${what.slice(1)} in the forecast` : 'A wet field'} for the ${info.opp} game: the extra crew?`,
    preview: `${_wxPct(info.chance)} chance of ${what}${wet ? `, and the field is already wet` : ''}. The extra crew and the full tarp setup: ${formatK(info.costK)}.`,
    body: `The forecast for the game against the ${info.opp} (first pitch ${_clock(info.gameTime)}) gives a ${_wxPct(info.chance)} chance of ${what}`
        + `${wet ? `, and we've already taken ${inches(info.wetIn)} of rain in the last day` : ''}. `
        + `For ${formatK(info.costK)} I can bring in the extra crew and set up the full tarp. If it rains before the game, the field is ready sooner. If play stops, we're back on the field faster. The infield stays firmer either way. `
        + `It won't stop lightning or a downpour, and if the rain misses us, the money is spent.`
        + `${info.drainage ? ` The drainage we put in already helps; this is on top of it.` : ''} `
        + `I need an answer ${FIELD_CARE.prep.closeH} hours before first pitch.`,
    yesLabel: `Bring In the Crew (${formatK(info.costK)})`, noLabel: "We'll Manage",
    autoResolve: 'no', expiresAtMs: info.gameTime - FIELD_CARE.prep.closeH * 3_600_000,
    yesMsg: 'The extra crew is booked.', noMsg: 'The regular crew it is.',
    _raw: { onYes: 'field_prep', onNo: null },
  }), atMs);
}


/**
 * r170 the groundskeeper's pitch for new drainage (mid-season, after a wet stretch at home): the work
 * is done while we're on the road and counts from the day it's finished.
 */
export function deliverDrainageCard(info, atMs) {
  const state = StateManager.get();
  const days = FIELD_CARE.drainage.workDays;
  const onRoad = info.startAt <= atMs;
  return _deliverAt(_rosterCard(state, {
    cardId: 'field_drainage', tag: 'WEATHER', sender: 'Head Groundskeeper', avatar: '🌱', type: 'normal',
    _rosterKey: `wx:drainage:${state.seasonNum || 1}:${info.level}`, _drainage: { level: info.level, startAt: info.startAt, readyAt: info.readyAt, costK: info.costK },
    subject: 'New drainage for the field?',
    preview: `${info.wet} home games postponed or delayed lately. ${formatK(info.costK)}, done while we're on the road.`,
    body: `We've had ${info.wet} home games postponed, delayed or started late for the weather in the last six weeks. `
        + `New drainage${info.level > 1 ? ` (phase ${info.level} of ${FIELD_CARE.drainage.max})` : ''} would let the field take more rain before we have to stop or call a game, get us back on the field faster after a delay, and keep the infield firmer. Every home game from then on. `
        + `It costs ${formatK(info.costK)} from club funds (${formatK(state.userTeam.finances?.funds || 0)} today). `
        + `The work takes ${days} days, and we'd do it ${onRoad ? 'now, while we\'re on the road'
            : info.startAt - atMs <= 3 * 86_400_000 ? 'on the next road trip, starting the day after this homestand'
            : `on the long road trip coming up in about ${Math.round((info.startAt - atMs) / 86_400_000)} days`}; it's ready before we're home again.`,
    yesLabel: `Put In the Drainage (${formatK(info.costK)})`, noLabel: 'Not Now',
    autoResolve: 'no', expiresAtMs: Math.max(atMs + 86_400_000, Math.min(atMs + 3 * 86_400_000, info.startAt)),
    yesMsg: 'The drainage work is on the schedule.', noMsg: "Understood. We'll make do.",
    _raw: { onYes: 'field_drainage', onNo: null },
  }), atMs);
}


/**
 * §122.51 (phase 3) A message from the grounds crew about one of our home games' weather (WeatherMessages):
 * news that needs no answer — "Understood". Each moment once (its key). Near game time it gets past quiet
 * hours (`urgent`). It stays until the day after the game.
 */
export function deliverCrewMessage(info, atMs) {
  const state = StateManager.get();
  if (_cardsWithKey(state, info.key).length) return null;
  return _deliverAt(_rosterCard(state, {
    tag: 'WEATHER', sender: info.sender || 'Head Groundskeeper', avatar: '🌧', type: info.urgent ? 'urgent' : 'normal',
    _rosterKey: info.key, _wxGameTime: info.gameTime, _wxCrew: true, ...(info.urgent ? { _urgent: true } : {}), ...(info.calledOff ? { _wxCalledOff: true } : {}),
    subject: info.subject, preview: info.preview || info.body, body: info.body,
    yesLabel: 'Understood', noLabel: null, autoResolve: 'skip', expiresAtMs: info.expiresAtMs ?? info.gameTime + 18 * 3_600_000,
    _raw: {},
  }), atMs);
}


/**
 * §122.51 (phase 3b) A weather decision at one of our home games, on a clock: batting practice ('bp'),
 * calling the game off ('calloff'), the crowd during a long delay ('comps'), extra hands when the field
 * runs long ('hands'), going ahead in light rain ('rain'). It stands in for that moment's message
 * (WeatherMessages.decisionWords). Unanswered by its deadline, the club does the default and it costs
 * a little more (and counts toward the owner's patience with our weather calls).
 *   info: { key, kind, gameTime, subject, body, yesLabel, noLabel, expiresAtMs, sender?, urgent?, chance?, costK? }
 */
export function deliverWeatherDecision(info, atMs) {
  const state = StateManager.get();
  if (_cardsWithKey(state, info.key).length) return null;
  return _deliverAt(_rosterCard(state, {
    tag: 'WEATHER', sender: info.kind === 'antics' ? _managerName(state) : info.sender || 'Head Groundskeeper', avatar: '🌧', type: info.urgent ? 'urgent' : 'normal',
    _rosterKey: info.key, _wxGameTime: info.gameTime, _wxDecision: info.kind, ...(info.urgent ? { _urgent: true } : {}),
    _wxChance: info.chance ?? null, _wxCostK: info.costK ?? null,
    subject: info.subject, preview: info.preview || info.body, body: info.body,
    yesLabel: info.yesLabel, noLabel: info.noLabel, autoResolve: 'roster', expiresAtMs: info.expiresAtMs,
    yesMsg: info.yesMsg || null, noMsg: info.noMsg || null,
    ...(info.choices ? { _choices: info.choices, _noRec: true } : {}), ...(info.playerId ? { _wxPlayer: info.playerId } : {}),
    _wxRevenueK: info.revenueK ?? null,
    _raw: { onYes: `wx_${info.kind}_yes`, onNo: `wx_${info.kind}_no`, onAuto: `wx_${info.kind}_auto` },
  }), atMs);
}


const _WX_DECISION = /^wx_(bp|calloff|comps|hands|rain|sth|raincheck|booth|antics)_(yes|no|auto)$/;

const WX_CALLS = Object.freeze({ windowDays: 30, poorCount: 3, ownerTrust: -3, autoAtmo: -1, compsAtmo: 1, noCompsAtmo: -1, cagesMorale: -1,
  // §122.56 the crowd during a delay
  sthYesAtmo: 1, sthNoAtmo: -2, raincheckYesAtmo: 2, raincheckNoAtmo: -3, boothAtmo: 1, boothMorale: -1,
  anticsAtmo: 2, anticsMorale: 1, anticsNoMorale: -1, anticsHurtChance: 0.1 });


/**
 * A home weather decision taken (or left to its deadline). What it sets on the game, the game's weather
 * reads at its next look (`wxReplan`: GameEngine plans it again — and, in a held start, plays it again).
 */
function _applyWeatherDecision(kind, choice, instance, atMs) {
  const st = StateManager.get();
  const gt = instance._wxGameTime;
  const i = (st.schedule || []).findIndex(g => g.gameTime === gt && g.isHome && !g._committed && !g.cancelled);
  const auto = choice === 'auto', yes = choice === 'yes';
  let poor = auto && kind !== 'bp';
  StateManager.mutate(s => {
    const g = i >= 0 ? s.schedule[i] : null;
    const u = s.userTeam;
    const atmo = (n) => { u.atmosphere = Math.max(0, Math.min(100, (u.atmosphere ?? 50) + n)); };
    const pay = (k, label) => { if (k && u.finances) Finance.post(u.finances, -k, 'facilities', label, atMs); };
    if (kind === 'bp' && g) { g.wxBp = yes ? 'cages' : 'field'; g.wxReplan = true; if (yes) u.morale = Math.max(0, (u.morale ?? 50) + WX_CALLS.cagesMorale); }
    if (kind === 'calloff' && g) {
      if (yes) { g.wxGmCallAt = atMs; g.wxReplan = true; poor = (instance._wxChance ?? 100) < 50; }
      else g.wxWaited = { atMs, chance: instance._wxChance ?? null, auto };
    }
    // §122.56 the crowd during a delay: free food and drink, the stands open and selling, or closed (the default).
    if (kind === 'comps') {
      const pick = yes ? (instance._pick || 'free') : 'close';
      if (pick === 'free') { pay(instance._wxCostK, 'Food and drink for the crowd'); atmo(WX_CALLS.compsAtmo); }
      else if (pick === 'sell') { if (instance._wxRevenueK && u.finances) Finance.post(u.finances, instance._wxRevenueK, 'gate', 'Concessions through the delay', atMs); }
      else atmo(WX_CALLS.noCompsAtmo);
    }
    if (kind === 'sth') { if (yes) { pay(instance._wxCostK, 'A season-ticket holder\'s credit'); atmo(WX_CALLS.sthYesAtmo); } else atmo(WX_CALLS.sthNoAtmo); }
    if (kind === 'raincheck') { if (yes) { pay(instance._wxCostK, 'Rain checks'); atmo(WX_CALLS.raincheckYesAtmo); } else atmo(WX_CALLS.raincheckNoAtmo); }
    if (kind === 'booth' && yes) {
      if (instance._wxRevenueK && u.finances) Finance.post(u.finances, instance._wxRevenueK, 'cards', 'A sponsored segment in the TV booth', atMs);
      atmo(WX_CALLS.boothAtmo); u.morale = Math.max(0, (u.morale ?? 50) + WX_CALLS.boothMorale);
    }
    if (kind === 'antics') {
      if (yes) {
        atmo(WX_CALLS.anticsAtmo); u.morale = Math.min(100, (u.morale ?? 50) + WX_CALLS.anticsMorale);
        // (a small chance somebody tweaks something out there: out of sorts for a few games)
        const r = dice(diceSeed(s), 'wx-antics', instance.instanceId)();
        const regulars = (u.lineupSlots || []).map(x => x?.playerId).filter(id => id && s.players[id]);
        if (r < WX_CALLS.anticsHurtChance && regulars.length) Development.setCondition(s, regulars[Math.floor(r / WX_CALLS.anticsHurtChance * regulars.length)], { amount: 2, games: 3, reason: 'delay' });
      } else u.morale = Math.max(0, (u.morale ?? 50) + WX_CALLS.anticsNoMorale);
    }
    if (kind === 'hands' && g && yes) { pay(instance._wxCostK, 'Extra grounds crew'); g.wxExtraHands = true; g.wxSayAt = atMs; g.wxReplan = true; }
    if (kind === 'rain' && g && yes) { g.wxStartInRain = true; g.wxSayAt = atMs; g.wxReplan = true; }
    if (auto && kind !== 'bp') atmo(WX_CALLS.autoAtmo);
  });
  _noteWeatherCall({ kind, choice, poor }, atMs);
}


/**
 * §122.51 noteWeatherCall({ kind, choice, poor }, atMs) — a weather call at home, for the owner's patience:
 * three poor ones in a month (left unanswered, calling off a game the forecast gave a fair chance, waiting out
 * one it gave none and losing it late) and the owner says so, and trusts the GM a little less.
 */
export function noteWeatherCall(call, atMs) { _noteWeatherCall(call, atMs); }

function _noteWeatherCall(call, atMs) {
  StateManager.mutate(s => { s.userTeam.wxCalls = [...(s.userTeam.wxCalls || []), { atMs, ...call }].slice(-40); });
  const st = StateManager.get();
  const poor = (st.userTeam.wxCalls || []).filter(c => c.poor && !c.counted && c.atMs > atMs - WX_CALLS.windowDays * 86_400_000);
  if (poor.length < WX_CALLS.poorCount) return;
  const what = { calloff: (c) => (c.choice === 'yes' ? 'calling off a game the forecast gave a fair chance' : 'waiting out a forecast that showed no game, then losing it late'),
                 comps: () => 'leaving the crowd waiting with nothing', hands: () => 'leaving the crew short when the field ran long', rain: () => 'leaving a held start without an answer',
                 sth: () => 'leaving an upset season-ticket holder waiting', raincheck: () => 'leaving the crowd without an answer on rain checks',
                 booth: () => 'leaving the broadcast without an answer', antics: () => 'leaving the manager without an answer' };
  const words = [...new Set(poor.map(c => (c.choice === 'auto' ? 'leaving the grounds crew without an answer' : (what[c.kind] || (() => 'a weather call'))(c))))];
  const owner = st.userTeam.ownerName || 'Ownership';
  StateManager.mutate(s => {
    for (const c of s.userTeam.wxCalls || []) if (c.poor && !c.counted && c.atMs > atMs - WX_CALLS.windowDays * 86_400_000) c.counted = true;
    s.userTeam.ownerTrust = Math.max(0, Math.min(100, (s.userTeam.ownerTrust ?? 60) + WX_CALLS.ownerTrust));
  });
  _deliverNotice(`wx:owner:${st.seasonNum || 1}:${Math.round(atMs / 60_000)}`, {
    tag: 'OWNER', sender: owner, avatar: '💼',
    subject: 'Our weather calls',
    body: `${poor.length} weather calls at home this month have gone against us: ${_list(words)}. That's money and goodwill we didn't need to lose. I expect better judgment. (Owner Trust ${WX_CALLS.ownerTrust}.)`,
  }, atMs);
}


/**
 * §122.51 (phase 3b) expireGameWeatherDecisions(gameTime, nowMs) — the league clock holds at our first pitch, so a
 * decision during our game (a held start, a delay) reaches its deadline on the game's own clock: by now.
 */
export function expireGameWeatherDecisions(gameTime, nowMs) {
  const st = StateManager.get();
  const due = [...(st.inbox || []).filter(c => !c.resolved), ...(st.scheduledCards || [])]
    .filter(c => c._wxDecision && c._wxGameTime === gameTime && Number.isFinite(c.expiresAtMs) && c.expiresAtMs <= nowMs)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  const seed = diceSeed(st);
  for (const c of due) withDice(dice(seed, 'expire', c.instanceId, c.expiresAtMs), () => expire(c.instanceId, c.expiresAtMs));
  return due.length;
}


/** §122.56 withdraw a game's cards that don't belong in a weather hold ("drag the infield?"; §122.57 the anthem, a
 *  ceremony on the field, a sponsor on the field) — still to come, or arrived and unanswered. */
export function withdrawNoWeatherHold(gameTime) {
  const hold = (c) => c._noWeatherHold || c._raw?._noWeatherHold || c.cardId === 'ig_grounds_crew';
  const ofGame = (c) => c._gameTime === gameTime || (c._gameTime == null && c.deliverAtMs >= gameTime - 60_000 && c.deliverAtMs <= gameTime + 8 * 3_600_000);
  return _withdrawDayCards(c => hold(c) && ofGame(c));
}


/** §122.57 our game called off: its game-day cards (before first pitch, during the game) are withdrawn — still to come,
 *  or arrived and unanswered — and never counted as dealt. */
export function withdrawGameDayCards(gameTime) {
  return _withdrawDayCards(c => c._gameTime === gameTime && ['pregame', 'ingame'].includes(c._moment));
}


function _withdrawDayCards(pred) {
  const st = StateManager.get();
  const hit = [...(st.inbox || []).filter(c => !c.resolved), ...(st.scheduledCards || [])].filter(pred);
  if (!hit.length) return 0;
  const ids = new Set(hit.map(c => c.instanceId));
  const seen = new Set((st.inbox || []).filter(c => ids.has(c.instanceId)).map(c => c.instanceId));
  StateManager.mutate(s => {
    s.inbox          = (s.inbox || []).filter(c => c.resolved || !ids.has(c.instanceId));
    s.scheduledCards = (s.scheduledCards || []).filter(c => !ids.has(c.instanceId));
    // §122.71 a card the GM already had in Messages still counts toward how often it comes (its gap, its limit):
    // only one that never arrived is taken off the log. (A pregame card seen, then withdrawn with the rainout, came
    // straight back two days later.)
    for (const c of hit) if (!seen.has(c.instanceId)) _unlogDealt(s, c);
  });
  return hit.length;
}


/**
 * §122.57 retimeGameCards(gameTime, { startAt, endT, delays }) — our game's in-game cards, moved onto the game as it
 * is played: the same time into the game (after a held start), pushed past each delay, and withdrawn when the game is
 * over by then. (Planned the day before against the scheduled first pitch; the weather settles it at first pitch.)
 */
export function retimeGameCards(gameTime, { startAt = null, endT = null, delays = [] } = {}) {
  const st = StateManager.get();
  const cards = (st.scheduledCards || []).filter(c => c._gameTime === gameTime && c._moment === 'ingame');
  if (!cards.length || !Number.isFinite(startAt)) return 0;
  const stops = (delays || []).filter(d => Number.isFinite(d.startT) && Number.isFinite(d.endT) && d.startT >= startAt).sort((a, b) => a.startT - b.startT);
  const end = Number.isFinite(endT) ? endT : startAt + 3 * 3_600_000;
  const moved = new Map(), gone = [];
  for (const c of cards) {
    let at = startAt + (c._ingameAt ?? (c.deliverAtMs - gameTime));
    for (const d of stops) if (d.startT <= at) at += d.endT - d.startT;
    if (at > end - 15 * 60_000) gone.push(c);
    else moved.set(c.instanceId, { deliverAtMs: at, expiresAtMs: Math.max(at + 30 * 60_000, end + 30 * 60_000) });
  }
  StateManager.mutate(s => {
    s.scheduledCards = (s.scheduledCards || []).filter(c => !gone.some(g => g.instanceId === c.instanceId))
      .map(c => moved.has(c.instanceId) ? { ...c, ...moved.get(c.instanceId) } : c)
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    for (const c of gone) _unlogDealt(s, c);
  });
  return moved.size + gone.length;
}


/** §122.57 the season-ticket stories (a like question from the crowd during a delay isn't asked the same day). */
export const STH_CARD_IDS = Object.freeze(Object.values(ALL_POOLS).flat().map(e => e?.card || e).filter(d => d?._sth && !d._retired).map(d => d.id));


/** §122.51 withdraw weather cards still parked (not yet arrived) whose key starts with `prefix`, due after `afterMs` (a decision redid the game's weather). */
export function withdrawScheduledWeather(prefix, afterMs) {
  const st = StateManager.get();
  const ids = new Set((st.scheduledCards || []).filter(c => c.tag === 'WEATHER' && String(c._rosterKey || '').startsWith(prefix) && c.deliverAtMs > afterMs).map(c => c.instanceId));
  if (!ids.size) return 0;
  StateManager.mutate(s => { s.scheduledCards = (s.scheduledCards || []).filter(c => !ids.has(c.instanceId)); });
  return ids.size;
}


/** Withdraw unresolved weather cards whose key starts with `prefix` (the game moved or was called off). */
export function withdrawWeatherCards(prefix) {
  return _withdraw(c => c.tag === 'WEATHER' && String(c._rosterKey || '').startsWith(prefix));
}


/** The weather decisions (inside _applyRosterAction). */
export function _applyWeatherAction(action, instance, atMs) {
  const raw = instance._raw || {};
  const dm = action.match(_WX_DECISION);
  if (dm) { _applyWeatherDecision(dm[1], dm[2], instance, atMs); return; }
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
  return parts.length ? parts.join(', and ') : 'the books are tighter than I like';   // (the owner's own words)
}


/** The owner's mood worsened (watching / concerned) — a note in his voice. */
export function deliverOwnerFinanceCard(stage, strain, atMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  const concerned = stage === 'concerned';
  const line = _voice(state, stage);
  const strainText = _strainWords(strain);
  return _deliverNotice(`owner:${stage}:${state.seasonNum}:${atMs}`, {
    cardId: `owner_${stage}`, tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: concerned ? 'urgent' : 'normal',
    subject: concerned ? "I'm concerned about the money" : "I'm watching the payroll",
    preview: line,
    body: `${line} Right now ${strainText}. `
        + (concerned
          ? `Until the books improve, I won't approve adding salary. If it doesn't turn around by the next payday or two, expect me to order a payroll cut.`
          : `I'm not asking anything of you yet. Winning is the best argument you have.`),
    yesLabel: 'Understood', expiresAtMs: atMs + 3 * 86_400_000,
  }, atMs);
}


/**
 * The owner orders cuts: move a contract (named) by the next payday. §122 two
 * ways to meet it — the front office finds a taker (a salary dump: the player
 * for nothing back but the savings), or we release the player (waivers: the
 * salary is off the payroll at once). No — the owner remembers.
 */
export function deliverOwnerCutOrder(playerId, amountK, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  const order = state.userTeam.finances?.owner?.order;
  if (!p || !order) return null;
  const owner = state.userTeam.ownerName || 'Ownership';
  const due = When.untilDay(order.dueAt, atMs);   // r149 relative
  const line = _voice(state, 'concerned');
  return _deliverAt(_rosterCard(state, {
    cardId: 'owner_cut_order', tag: 'OWNERSHIP', sender: 'Front Office', relay: owner, avatar: '💼', type: 'urgent',
    _rosterKey: `owner:order:${state.seasonNum}:${order.dueAt}`, _targetPlayerId: playerId,
    subject: `${owner} wants ${formatK(amountK)} off the payroll`,
    preview: `${owner} sent word: "${line}" Due ${due.startsWith('in ') ? due : `by ${due}`}.`,
    body: `${owner} sent word this morning: "${line}" Ownership wants ${formatK(amountK)} a year off the payroll by the payday ${due === 'today' || due === 'tomorrow' || due.startsWith('in ') ? due : `on ${due}`}. `
        + `The obvious contract is ${_who(p)}, at ${formatK(p.contractSalary)} a year. We can find a club to take it — it's a salary dump, nothing much comes back but the savings — `
        + `or release the player: waivers, and the salary comes off the payroll at once. Or tell ownership we're keeping that contract and take the hit with them. Missing the deadline costs their trust and shrinks next season's payroll target.`,
    _choices: [
      { key: 'dump', label: `Move ${p.name} to another club`, sub: 'A salary dump: the contract goes, nothing much comes back' },
      { key: 'release', label: `Release ${p.name}`, sub: `Waivers: ${formatK(p.contractSalary)} a year off at once; any club can claim` },
    ],
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
    subject: result.met ? 'Thank you for the payroll cut' : "The payroll wasn't cut",
    preview: result.met ? `${formatK(result.cutK)} off the payroll, as I asked…` : `I asked for ${formatK(result.amountK)} off the payroll. It didn't happen…`,
    body: result.met
      ? `Payroll came down ${formatK(result.cutK)}, as I asked. I appreciate it — and I remember who delivered.`
      : `I asked for ${formatK(result.amountK)} off the payroll and got ${formatK(Math.max(0, result.cutK))}. You've lost a good deal of my trust, and next season's payroll target will be smaller for it.`,
    yesLabel: 'Understood', expiresAtMs: atMs + 3 * 86_400_000,
  }, atMs);
}


/** The cut-order decision (inside _applyRosterAction). */
export function _applyFinanceAction(action, instance, atMs) {
  if (action === 'fin_call_club') { _callClubAboutSalary(instance, atMs); return; }
  if (action !== 'fin_dump_yes' && action !== 'fin_release') return;   // keeping the contract: the order stands, the owner decides at the deadline
  const st = StateManager.get();
  const pid = instance._targetPlayerId;
  const p = st.players[pid];
  if (!p || p.teamId !== 'user' || !(st.userTeam.rosterIds || []).includes(pid)) return;
  if (action === 'fin_release' || instance._pick === 'release') {   // §122 waivers: the salary is off at once
    StateManager.mutate(s => { dropPlayer(s, pid, 'user', atMs, { reason: 'payroll' }); });
    const rec = reconcileRoster(StateManager.get(), 'user');
    StateManager.mutate(s => applyRosterMutation(s, rec));
    return;
  }
  // The taker (§78.5): the club whose owner has the most payroll room for him.
  const taker = [...(st.leagueTeams || [])]
    .map(t => ({ t, room: Finance.payrollRoom(st, t.id) }))
    .filter(x => x.room >= (p.contractSalary || 0))
    .sort((a, b) => b.room - a.room)[0]?.t;
  if (!taker) {
    // §122 no taker: releasing is still on the table.
    const key = `owner:noTaker:${instance.instanceId}`;
    if (!_cardsWithKey(st, key).length) _deliverAt(_rosterCard(st, {
      cardId: 'owner_no_taker', tag: 'OWNERSHIP', sender: 'Scouting', avatar: '📞', type: 'urgent',
      _rosterKey: key, _targetPlayerId: pid,
      subject: `No club can take ${p.name}'s contract`,
      preview: `We called around — nobody has ${formatK(p.contractSalary || 0)} of room right now. Release ${p.name}?`,
      body: `We called every club about ${p.name} (${formatK(p.contractSalary || 0)} a year). Nobody's owner has the payroll room for that contract right now. `
          + `We can still release the player: waivers, and the salary comes off the payroll at once (any club can put in a claim over the next 72 hours). Or keep the contract, and the payroll has to come down another way.`,
      yesLabel: `Release ${p.name}`, noLabel: `Keep ${p.name}`,
      autoResolve: 'no', expiresAtMs: st.userTeam.finances?.owner?.order?.dueAt || atMs + 2 * 86_400_000,
      _raw: { onYes: 'fin_release', onNo: 'fin_dump_no', onAuto: 'fin_dump_no' },
    }), atMs);
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
export function _salaryCallOffer(st, team, atMs, { intro = null } = {}) {
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
      intro: intro || ((who) => `${team.name} called back about the conversation we started: ${who} is available, and they need the payroll room.`),
      atMs: atMs + (2 + eventRand() * 3) * 3600_000,
    });
    return true;
  }
  return false;
}
