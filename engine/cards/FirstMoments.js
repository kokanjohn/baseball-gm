/**
 * engine/cards/FirstMoments.js
 * CardEngine, first moments (§80): the device, released cards, release hooks.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { GAME_REMINDER, MESSAGE_HISTORY } from '../../data/constants.js';
import { writeComposeReply } from '../ComposeReplies.js';
import { MOMENT_CARDS } from '../../data/cards-moments.js';
import { senderLabel, viewOf, peopleIn } from '../Senders.js';
import * as Negotiation from '../Negotiation.js';
import { clockNow } from '../Clock.js';
import { gamePushes, alertOn, reminderMoot, PUSH_ALERTS } from '../GamePushes.js';
import { followUpAt, followUpText } from '../FollowUps.js';
import { eventRand } from '../Dice.js';
import { rainHolds } from '../FieldCare.js';
import { _scheduleCards } from './Delivery.js';
import { _afterLanding, _landPromises, _writePromise } from './Promises.js';
import { list } from './ScoutingTips.js';
import { _createInstance } from './Selection.js';
import { toInbox, VIA } from './Entry.js';   // r291 §122.172
import { trimDue, trimAnswered } from '../MessageHistory.js';   // r292 §122.174
import { staffHandles, staffWillHandle } from '../MessageTiers.js';   // r296 §122.180
import { expire } from './Promises.js';

// ─────────────────────────────────────────────────────────────
// FIRST MOMENTS (§80)
// ─────────────────────────────────────────────────────────────

const SEEN_MOMENTS_KEY = 'bgm_seenMoments';


let _deviceSeen = null;
   // r139 handed in where there's no localStorage (the look-ahead's worker)
/** r139 §121 this device's memory of moment cards shown, for a context without localStorage. */
export function setSeenMoments(list) { _deviceSeen = Array.isArray(list) ? [...list] : null; }

/** This device's memory, to hand to the look-ahead's worker. */
export function seenMoments() { return _seenMoments(); }


/** Versions this device has shown, oldest first (across every team and season). */
function _seenMoments() {
  if (_deviceSeen) return [..._deviceSeen];
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_MOMENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function _rememberMoment(id) {
  if (StateManager.isSpeculating()) return;   // r139 a look-ahead only imagines it
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
  // r256 §122.135 a version that says it rained ("the infield is soft") only when it did, at our park, by the
  // earliest the message can arrive (a pregame message: 150 minutes before first pitch).
  const by = game && timing === 'pregame' ? game.gameTime - 150 * 60_000 : clockNow();
  const versions = (MOMENT_CARDS[moment] || []).filter(c => _fitsMoment(c, sit)
    && (!c._needsRain || ((!c._needsRain.home || !!game?.isHome) && rainHolds(state, c._needsRain, by))));
  if (!versions.length) return false;
  const seen = _seenMoments();
  const inSave = new Set(Object.values(state.momentsDone || {}).map(d => d.cardId));
  const fresh = versions.filter(c => !seen.includes(c.id) && !inSave.has(c.id));
  // Situation-specific versions are the more telling ones: weight them up.
  const weightOf = (c) => (c._when ? 2 : 1);
  let pick;
  if (fresh.length) {
    const total = fresh.reduce((a, c) => a + weightOf(c), 0);
    let r = eventRand() * total;
    pick = fresh.find(c => (r -= weightOf(c)) <= 0) || fresh[fresh.length - 1];
  } else {
    pick = [...versions].sort((a, b) => seen.indexOf(a.id) - seen.indexOf(b.id))[0];
  }
  const { _when, ...def } = pick;
  const instance = _createInstance({ ...def, autoResolve: def.autoResolve || 'skip' }, context, state);
  if (!instance) return false;
  // r268 §122.147 the takeover's message is one of the club's opening messages (the GM just made the club, at
  // whatever hour): a seed like the first day's — there in minutes, never pushed, not held to the staff's day.
  _scheduleCards([{ ...instance, _moment: timing, _firstMoment: moment, ...(moment === 'takeover' ? { _seed: true } : {}) }], state, game);
  const scheduled = (StateManager.get().scheduledCards || []).some(c => c.instanceId === instance.instanceId);
  if (!scheduled) return false;    // the moment had already passed (planned too late)
  StateManager.mutate(s => {
    s.momentsDone = { ...(s.momentsDone || {}), [doneKey]: { cardId: pick.id, atMs: clockNow() } };
  });
  _rememberMoment(pick.id);
  return true;
}


/**
 * releaseDueCards(nowMs = clockNow())
 * Moves every scheduled card whose time has come into the inbox.
 * Called on every app tick (and by the harness after every tick) — and r139
 * by the clock itself before each event and at a commit, so cards arrive in
 * time order with the world's events however the clock is stepped (§121).
 * @returns {Object[]} the cards released (empty array if none)
 */
export function releaseDueCards(nowMs = clockNow()) {
  // r292 §122.174 the newest answered messages kept; older ones leave notes (MessageHistory)
  if (trimDue(StateManager.get(), MESSAGE_HISTORY)) StateManager.mutate(s => trimAnswered(s, MESSAGE_HISTORY));
  const out = _releaseDue(nowMs);
  if (out.length && !StateManager.isSpeculating()) _released.push(...out.filter(c => !staffHandles(c)));   // (r296 not the staff's)
  _staffAnswer();   // r296 §122.180 Important only: what the staff took, answered
  const fu = _followUps(nowMs);   // r279 §122.158 (announced like a new message; not counted as one)
  if (fu.length && !StateManager.isSpeculating()) _released.push(...fu.map(c => ({ ...c, subject: `Following up: ${c.subject}` })));
  return out;
}


/**
 * r279 §122.158 the follow-ups due: the sender writes again in the same message (`_followUp: { atMs, text }`),
 * which comes back to the top of the inbox unread. One a message (FollowUps.followUpAt). The first time a club
 * runs this, it only marks where new messages begin (`_followUpsFrom`): messages already waiting get none.
 * @returns {Object[]} the messages followed up on
 */
function _followUps(nowMs) {
  const state = StateManager.get();
  if (!state?.inbox) return [];
  if (!Number.isFinite(state._followUpsFrom)) { StateManager.mutate(s => { s._followUpsFrom = nowMs; }); return []; }
  const due = state.inbox.map(c => ({ c, at: followUpAt(c, state) })).filter(x => x.at !== null && x.at <= nowMs);
  if (!due.length) return [];
  StateManager.mutate(s => {
    for (const { c, at } of due) {
      const card = s.inbox.find(x => x.instanceId === c.instanceId);
      if (!card || card.resolved || card._followUp) continue;
      card._followUp = { atMs: at, text: followUpText(card, s, at) };
      card._readAt = null;
    }
  });
  const after = StateManager.get();
  return due.map(({ c }) => after.inbox.find(x => x.instanceId === c.instanceId)).filter(c => c?._followUp);
}


const _released = [];

/** r296 §122.180 the optional messages the staff took in Important only (marked at Entry): answered as at their deadline. */
function _staffAnswer() {
  const mine = (StateManager.get().inbox || []).filter(c => staffHandles(c) && !c.resolved);
  for (const c of mine) expire(c.instanceId, c.arrivedAtMs ?? clockNow(), { staff: true });
}
   // r139 released since the app last looked (never by a look-ahead)
/** r139 the cards released since the last call — by the app's tick or inside the clock — for the app to announce. */
export function takeReleased() { return _released.splice(0, _released.length); }


function _releaseDue(nowMs) {
  const state = StateManager.get();
  let due = (state?.scheduledCards || []).filter(c => c.deliverAtMs <= nowMs);
  if (!due.length) return [];
  // r238 §122.117 the crew's message about a game the GM already has a decision on (asked in Compose): not sent.
  const fieldAsked = new Set((state.inbox || []).filter(c => Number.isFinite(c._fieldGameTime)).map(c => c._fieldGameTime));
  const moot = due.filter(c => c.cardId === 'field_prep' && fieldAsked.has(c._fieldGameTime));
  if (moot.length) {
    const gone = new Set(moot.map(c => c.instanceId));
    StateManager.mutate(s => { s.scheduledCards = (s.scheduledCards || []).filter(c => !gone.has(c.instanceId)); });
    due = due.filter(c => !gone.has(c.instanceId));
    if (!due.length) return [];
  }
  const ids = new Set(due.map(c => c.instanceId));
  // §106 a staff reply is written now, as of the moment it was sent back.
  const log = [];
  // r147 a promise lands: written now, from the world as it is (or nothing to say).
  const landed = [];
  due = due.map(c => {
    if (!c._promiseRec) return c;
    const w = _writePromise(state, c);
    landed.push({ ...w, atMs: c.deliverAtMs });
    return w.card;
  }).filter(Boolean);
  due = due.map(c => {
    if (!c._composeWrite) return c;
    const reply = writeComposeReply(state, { topicId: c._composeTopic, channelId: c._composeChannel, atMs: c.deliverAtMs,
                                             subject: c._composeLabel ? `Re: ${c._composeLabel}` : null, arg: c._composeArg || null });
    if (!reply) return { ...c, _composeWrite: false };
    log.push({ topicId: c._composeTopic, channelId: c._composeChannel, atMs: c.deliverAtMs, memo: reply.memo });
    // r146 the players the reply names (its report), so each name opens the player's card.
    const named = reply.named || [];
    const out = { ...c, _composeWrite: false, sender: reply.sender, subject: reply.subject, preview: reply.preview, body: reply.body,
                  ...(named.length ? { _playerIds: [...new Set(named)] } : {}) };
    // §122.9 a reply that offers something (a development plan) is a decision.
    const d = reply.decision;
    // r169 a decision about how the club plays (no one player): the reply's choices, one tap each.
    if (d?.team) {
      Object.assign(out, {
        yesLabel: d.choices?.[0]?.label || d.yesLabel || 'Yes', noLabel: d.noLabel || null, autoResolve: 'no',
        expiresAtMs: d.expiresAtMs ?? c.deliverAtMs + (d.expiresInMs || 2 * 86_400_000),
        _choices: d.choices || null, ...(d.recommend === false ? { _noRec: true } : {}),
        _raw: { ...(c._raw || {}), onYes: d.onYes, onNo: null, ...(d.promo ? { _promo: d.promo } : {}) },
        ...(d.card || {}),   // r170 what the decision acts on (the game a crew is for, its price)
        ...(d.yesMsg ? { yesMsg: d.yesMsg } : {}), ...(d.noMsg ? { noMsg: d.noMsg } : {}),
      });
    }
    if (d && !d.team && state.players[d.playerId]?.teamId === 'user') {
      Object.assign(out, {
        yesLabel: d.yesLabel, noLabel: d.noLabel, _targetPlayerId: d.playerId, autoResolve: 'no',
        expiresAtMs: c.deliverAtMs + (d.expiresInMs || 2 * 86_400_000),
        _raw: { ...(c._raw || {}), onYes: d.onYes, onNo: null, _trainGain: d.trainGain, _trainGames: d.trainGames,
                // r159 §122.31 work the GM asked for: who does it, on what, for how long
                ...(d.work ? { _workSkill: d.work.skill, _workOwner: d.work.owner, _workDays: d.work.days, _workGain: d.work.gain,
                               _workSource: d.work.source } : {}),
                // r166 §122.35 teaching a position: which, and the odds a day of reps takes
                ...(d.teach ? { _teachPos: d.teach.pos, _teachOdds: d.teach.odds } : {}),
                ...(d.penRole ? { _penRole: d.penRole } : {}) },   // r169 a bullpen role
        ...(d.costK ? { _budgetCost: d.costK } : {}),
        ...(d.yesMsg ? { yesMsg: d.yesMsg } : {}), ...(d.noMsg ? { noMsg: d.noMsg } : {}),
      });
    }
    // r150 the director's counter is a decision: send it as the next round of the talks, adjust it
    // first in the composer, or not now. It stands only while the deal it's about is on the table.
    // r202 §122.79 the deal the reply is about, as it's on the table: the card's deal table (with the
    // counter, a switch between the two).
    if (reply.sheet) Object.assign(out, { _dealOffer: reply.sheet });
    // r204 §122.82 the free-agent report: sign any of them, or watch one, from the message; it stays open
    // (Done closes it, and it closes itself when nothing's left to decide or these looks come back).
    if (reply.faReport?.ids?.length) {
      Object.assign(out, {
        _faRows: reply.faReport.ids, _faBuzz: reply.faReport.buzz || [], yesLabel: 'Done', noLabel: null, autoResolve: 'roster',
        expiresAtMs: reply.faReport.closeAtMs, _autoLabel: null,
        _raw: { ...(c._raw || {}), onYes: 'fa_report_close', onNo: null, onAuto: 'fa_report_close' },
      });
    }
    // r202 a deal they've agreed to: the reply is the decision too — make it official, or walk away
    // (the same as their yes; whichever is answered first, the other goes away).
    const ag = reply.agreed;
    const agTalk = ag ? Negotiation.talkWith(state, ag.teamId) : null;
    if (ag && agTalk?.status === 'agreed') {
      Object.assign(out, {
        tag: 'TRADE', yesLabel: 'Make It Official', noLabel: 'Walk Away', autoResolve: 'roster',   // (no answer: as their yes — it goes through)
        expiresAtMs: ag.expiresAtMs ?? c.deliverAtMs + 24 * 3600_000,
        _talkTeamId: ag.teamId, _talkId: agTalk.id, _talkRound: agTalk.round, _adviceDeal: ag.dealKey,
        yesMsg: 'Deal done.', noMsg: 'We walked away.',
        _raw: { ...(c._raw || {}), onYes: 'talk_finalize', onNo: 'talk_backout', onAuto: 'talk_finalize' },
      });
    }
    const t = reply.trade;
    if (t) {
      Object.assign(out, {
        tag: 'TRADE', yesLabel: t.yesLabel || 'Counter with This', noLabel: 'Not Now', autoResolve: 'no',
        expiresAtMs: t.expiresAtMs ?? c.deliverAtMs + 2 * 86_400_000,
        _ideaTeamId: t.teamId, _ideaOffer: t.offer, _ideaRound: t.round, ...(t.dealKey ? { _adviceDeal: t.dealKey } : {}),
        ...(reply.sheet ? { _adviceOffer: reply.sheet.offer } : {}),   // r202 the deal as offered, beside our counter
        _reviseOffer: { teamId: t.teamId, offer: t.offer, round: t.round }, _reviseLabel: 'Adjust It First',
        yesMsg: t.yesMsg || 'Counter sent. Their answer comes on their clock.', noMsg: t.dealKey ? 'Holding off on a counter.' : 'Holding off.',
        _raw: { ...(c._raw || {}), onYes: 'lt_offer_send', onNo: 'lt_pass', onAuto: 'lt_pass' },
      });
    }
    return out;
  });
  StateManager.mutate(s => {
    s.scheduledCards = (s.scheduledCards || []).filter(c => !ids.has(c.instanceId));
    toInbox(s, due, c => c.deliverAtMs, VIA.RELEASE);   // r291 §122.172
    if (log.length) s.composeLog = [...(s.composeLog || []), ...log].slice(-COMPOSE_LOG_MAX);
    // §122.15 the players the scouts named to the GM (kept on the player: the log is short).
    for (const e of log) for (const id of e.memo?.playerIds || []) if (s.players[id]) s.players[id]._scoutedAt = e.atMs;
    for (const l of landed) _landPromises(s, [l], l.atMs);   // r147 what a promise brings, as it lands
  });
  for (const l of landed) _afterLanding([l], l.atMs);
  for (const fn of _releaseHooks) fn(StateManager.get(), due);
  return due;
}

const COMPOSE_LOG_MAX = 80;

const _releaseHooks = [];

/** r146 the harness watches each message as it lands (the world as it is then). Never used by the app. */
export function onRelease(fn) { _releaseHooks.push(fn); }


/**
 * getPushSchedule(state, nowMs = clockNow(), ahead = null, foreseen = null)
 * Everything the push worker should send this device, shaped for its
 * /register endpoint: the messages, the 30-minute game reminders, and — r138
 * §120 — our next game as it will happen (`ahead`, LookAhead.lookAhead's
 * result: delays, a postponement, our injuries, the final). Each kind is on
 * unless the GM turned it off in Settings.
 *
 * The messages: r139 §121 with `foreseen` (LookAhead.lookAheadMessages — every
 * message that will reach Messages through its horizon, if the app stays
 * closed), those are the ones pushed up to the horizon: the trade desk's
 * offers, the trainer's and physician's reports, IL returns, open spots, the
 * offseason's decisions — not only the cards already planned. (A planned card
 * the world would withdraw first isn't pushed.) Beyond the horizon, the cards
 * already planned. Without it, the planned cards (seed cards never).
 */
/** §122.58 which of Settings' alerts a message falls under: the weather's word (ours at home, the traveling party's on
 *  the road) is Weather, a game postponed or stopped for good is Called Off; everything else is Messages. */
function _pushKind(c) {
  if (!c?._wxCrew) return PUSH_ALERTS.messages;
  return c._wxCalledOff ? PUSH_ALERTS.calledOff : PUSH_ALERTS.weather;
}


export function getPushSchedule(state, nowMs = clockNow(), ahead = null, foreseen = null) {
  const horizon = foreseen && Number.isFinite(foreseen.untilMs) ? foreseen.untilMs : -Infinity;
  // r236 §122.115 a message already in Messages needs no alert: the foresight is kept for hours, and a message it
  // saw coming stayed on the worker's list (kept a minute past due for the cron) after it had arrived in the app.
  const arrived = new Set((state?.inbox || []).map(c => c.instanceId));
  // (r283 §122.162 a message not here yet, as it will read: today's names)
  const live = (c) => viewOf({ ...c, _people: c._people || peopleIn(c, state) }, state);
  const planned = (state?.scheduledCards || [])
    .filter(c => !c._seed && c.deliverAtMs > horizon && !staffWillHandle(state, c))   // (r296 §122.180 not one the staff will take)
    .map(c => { const v = live(c); return { instanceId: c.instanceId, sender: senderLabel(v, state), subject: v.subject, at: c.deliverAtMs, expiresAtMs: c.expiresAtMs, urgent: !!c._urgent, kind: _pushKind(c) }; });
  const coming = (foreseen?.messages || []).filter(m => !m._staffHandle)
    .map(m => { const v = live(m); return { instanceId: m.instanceId, sender: senderLabel(v, state), subject: v.subject, at: m.arrivedAtMs, expiresAtMs: m.expiresAtMs, urgent: !!m._urgent, kind: _pushKind(m) }; });
  const cards = [...coming, ...planned].filter(c => !arrived.has(c.instanceId) && alertOn(state, c.kind))
    // r213 §122.91 each alert sounds when its message arrives: no quiet hours (the phone's own settings
    // silence it). Planned messages already keep to the staff's working day.
    .map(c => ({ c, at: c.at }))
    // An alert that would sound after the card's deadline is pointless.
    .filter(({ c, at }) => at > nowMs - 60 * 1000 && !(Number.isFinite(c.expiresAtMs) && at >= c.expiresAtMs))
    .map(({ c, at }) => ({
      id:        c.instanceId,
      deliverAt: at,
      title:     c.sender  || 'The Front Office',
      body:      c.subject || 'New message in your inbox',
      tag:       c.instanceId,
      kind:      c.kind,
    }));
  // r279 §122.158 the follow-ups still to come on messages waiting in Messages (the same message's alert tag)
  const followUps = alertOn(state, PUSH_ALERTS.messages) ? (state?.inbox || [])
    .map(c => ({ c, at: followUpAt(c, state) }))
    .filter(({ at }) => at !== null && at > nowMs - 60 * 1000)
    .map(({ c, at }) => ({ id: `fu:${c.instanceId}`, deliverAt: at, title: senderLabel(c, state) || 'The Front Office',
                           body: `Following up: ${viewOf(c, state).subject || 'a message in your inbox'}`, tag: c.instanceId, kind: PUSH_ALERTS.messages })) : [];
  return [...cards, ...followUps, ...gameReminders(state, nowMs, ahead), ...gamePushes(state, ahead, nowMs)]
    .sort((a, b) => a.deliverAt - b.deliverAt);
}


/**
 * gameReminders(state, nowMs, ahead) — §99 a push 30 minutes before each of our next
 * first pitches (spring, season and postseason alike), so the GM can catch up
 * on the inbox before the game. A push only, never an inbox card; off in Settings.
 * r138 none for a game the look-ahead knows is already called off by then.
 */
export function gameReminders(state, nowMs = clockNow(), ahead = null) {
  if (state?.push?.gameReminder === false || !state?.userTeam) return [];
  const out = [];
  for (const g of (state.schedule || []).slice(state.currentGameIndex || 0)) {
    if (out.length >= GAME_REMINDER.ahead) break;
    if (!g || g._committed || !Number.isFinite(g.gameTime)) continue;
    const at = g.gameTime - GAME_REMINDER.leadMs;
    if (at <= nowMs - 60 * 1000) continue;
    if (reminderMoot(ahead, g.gameTime, at)) continue;
    const opp = g.opponent || g.opp || 'today\'s opponent';
    out.push({
      id:        `game-reminder-${g.gameTime}`,
      deliverAt: at,
      title:     'First pitch in 30 minutes',
      body:      `${g.isHome ? 'vs' : '@'} ${opp} — a good time to catch up on the inbox before the game.`,
      tag:       `game-reminder-${g.gameTime}`,
      kind:      'reminder',
    });
  }
  return out;
}
