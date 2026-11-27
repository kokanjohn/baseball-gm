/**
 * engine/cards/ScoutingTips.js
 * CardEngine, the scouting director's tips (§122.15).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PHASE, PLAYER_GROUP, ROSTER_LIMITS } from '../../data/constants.js';
import { placeOnILUpdate, dayToDayUpdate, clearInjuryUpdate } from '../InjuryEngine.js';
import { activateFromIL, placeOnWaivers, reconcileRoster, applyRosterMutation, reserveGroup, fillLineupsAhead } from '../RosterEngine.js';
import { queueTrade, tradeBlockers, startCooldown } from '../TradeEngine.js';
import { getRosterNeeds, rankPickups, signPickup, rosterIsFull, sideOf, releasePickups, dropPlayer } from '../TransactionEngine.js';
import { formatK } from '../CardTokens.js';
import * as Offseason from '../OffseasonEngine.js';
import * as Coach from '../CoachEngine.js';
import { isDiamond, worthOf } from '../Diamonds.js';
import { adviceStamp, applyAdvice } from '../RosterAdvice.js';
import { CARD_ACTIONS } from '../CardActions.js';
import { signingTerms } from '../MarketEngine.js';
import { baseballYear, computeAge, isAvailable } from '../PlayerFactory.js';
import { clockNow } from '../Clock.js';
import { eventRand } from '../Dice.js';
import { _applyAllStarAction } from './AllStarCards.js';
import { _tradeSalaryDelta, _tradeSalaryOk } from './Compose.js';
import { _deliverAt, _rosterCard, _withdraw } from './Delivery.js';
import { _applyLeagueTradeAction } from './LeagueTradeCards.js';
import { _applyOffseasonAction, _who } from './OffseasonCards.js';
import { _addDropChoices, _applyCardAction } from './PlayerCards.js';
import { _act2Time, _deliverNotice, _managerName, _needFor, _ourNews, _restoreSpot, _sendDownChoices, _whoHasSpot, deliverInjuryAct2 } from './RosterCards.js';
import { _applyTalkAction } from './TradeOffers.js';
import { _applyFinanceAction, _applyWeatherAction } from './WeatherCards.js';

// ─────────────────────────────────────────────────────────────
// §122.15 THE SCOUTING DIRECTOR'S TIPS
// ─────────────────────────────────────────────────────────────

const TIP_PHASES = new Set([PHASE.SPRING_TRAINING, PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE]);

const TIP_GAP_MS = 3 * 86_400_000;
   // a few days between tips (one open at a time)

/**
 * directorTips(atMs) — once a day (with the CPU clubs' look at the market,
 * first): the director may hear about a diamond on the market before word gets
 * around. Each diamond gets one chance (Coach.tipChance: quality, specialty);
 * the tip arrives Coach.tipLeadDays later and only if that's still ahead of the
 * word. One tip open at a time. Tips on a player who has signed are withdrawn.
 */
export function directorTips(atMs) {
  const st = StateManager.get();
  const tipKeys = (c) => (c._rosterKey || '').startsWith('tip:');
  _withdraw(c => tipKeys(c) && st.players[c._targetPlayerId]?.group !== PLAYER_GROUP.FREE_AGENT);
  const staff = st.userTeam?.coachingStaff;
  const d = staff?.scoutingDirector;
  if (!d || d.vacant || !TIP_PHASES.has(st.phase)) return 0;
  const open = [...(st.inbox || []).filter(c => !c.resolved), ...(st.scheduledCards || [])].some(tipKeys);
  if (open || atMs - (st.userTeam._lastTipAt ?? -Infinity) < TIP_GAP_MS) return 0;
  const level = st.leagueTalentOffset || 0;
  const cands = (st.freeAgentPool || []).map(id => st.players[id])
    .filter(p => p && p.group === PLAYER_GROUP.FREE_AGENT && !Offseason.cutBy(p, 'user') && !p._tipRolled && Number.isFinite(p._buzzAt) && p._buzzAt > atMs && isDiamond(p, level))
    .sort((a, b) => worthOf(b) - worthOf(a) || String(a.id).localeCompare(String(b.id)));
  const rolled = [], late = [];
  let pick = null;
  const lead = Coach.tipLeadDays(staff) * 86_400_000;
  for (const p of cands) {
    rolled.push(p.id);
    if (atMs + lead > p._buzzAt - 86_400_000) { late.push(p.id); continue; }   // too late to beat the word (§122.71 marked so: no roll)
    if (eventRand() < Coach.tipChance(staff, p)) { pick = p; break; }
  }
  if (!rolled.length) return 0;
  StateManager.mutate(s => {
    for (const id of rolled) s.players[id]._tipRolled = late.includes(id) ? 'late' : true;
    if (pick) { s.players[pick.id]._tipAt = atMs + lead; s.userTeam._lastTipAt = atMs + lead; }
  });
  return pick && _deliverScoutTip(pick.id, atMs + lead) ? 1 : 0;
}


/** Why the director thinks this player is better than the rating (gender-neutral: name or "they"). */
function _tipRead(p) {
  const sr = p.subRatings || {};
  if (p._ratingGap) {
    const from = { rookie: 'A rookie, so the ratings are a projection', overseas: 'New to the league from overseas, so the ratings are an estimate',
                   independent: 'Out of independent ball, so the ratings are mostly an estimate' }[p.origin] || 'New to the league, so the ratings are an estimate';
    return `${from}, and I think the real player is better than it.`;
  }
  if (p.pos === 'RP' && (sr.stamina ?? 99) <= 48) {
    return `The rating counts stamina (${sr.stamina}), which an inning out of the bullpen barely uses. The stuff (${sr.stuff}) and control (${sr.control}) are the real thing.`;
  }
  if (!['SP', 'RP'].includes(p.pos) && (sr.speed ?? 99) <= 48) {
    return `The rating is dragged down by speed (${sr.speed}). The bat is the real thing: contact ${sr.contact}, power ${sr.power}.`;
  }
  return 'More useful than the number suggests.';
}


function _deliverScoutTip(playerId, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  const d = state.userTeam?.coachingStaff?.scoutingDirector;
  if (!p || !d || d.vacant || p.group !== PLAYER_GROUP.FREE_AGENT) return null;
  const terms = signingTerms(state, p);
  const age = computeAge(p.dob, baseballYear(state));
  const ask = `${formatK(terms.salary || 0)} a year${terms.bonus ? ` and a ${formatK(terms.bonus)} bonus` : ''}`;
  const card = _rosterCard(state, {
    cardId: 'scout_tip', tag: 'SCOUTING', sender: `${d.name}, Scouting Director`, avatar: '🔎', type: 'good',
    _rosterKey: `tip:${playerId}`, _targetPlayerId: playerId,
    subject: `Scouting tip: ${p.name}`,
    preview: `${_who(p)}, ${age}: better than the rating, and nobody else is onto it yet.`,
    body: `${_who(p)}, ${age}, is on the free-agent market. ${_tipRead(p)} `
        + `As far as I can tell, nobody else is onto this yet. The ask: ${ask}. `
        + `If we pass, ${p.name} stays on the market, but once word gets around other clubs will be after this one.`,
    yesLabel: `Sign ${p.name} (${formatK(terms.salary || 0)})`, noLabel: 'Pass',
    expiresAtMs: p._buzzAt,
    _raw: { onYes: 'scout_tip_sign', onNo: 'scout_tip_pass', onAuto: 'scout_tip_pass' },
    _autoLabel: 'No answer — passed',
  });
  _addDropChoices(state, card);
  return _deliverAt(card, atMs);
}


/** A development plan finished: the coach's verdict — r135 news, the Recent feed. */
export function _deliverDevelopmentReport(ev, atMs) {
  const st = StateManager.get();
  const p  = st.players[ev.playerId];
  if (!p || ev.teamId !== 'user') return null;
  const r = ev.realized, plan = ev.planned;
  const verdict = ev.profile === 'flop' || r < plan * 0.4 ? 'didn\'t take the way we hoped'
    : r >= plan * 1.15 ? 'went better than we hoped'
    : ev.profile === 'quick' ? 'clicked right away'
    : ev.profile === 'slow' ? 'took a while, but it came'
    : 'went about as expected';
  _ourNews(`${p.name}'s development plan ${verdict} — now OVR ${p.ovr}`, atMs);
  // r159 §122.31 work the GM asked for: whoever did it reports back, in their own words.
  if (ev.owner && ev.from && ev.to) return _deliverWorkReport(st, p, ev, atMs);
  return null;
}


function _deliverWorkReport(st, p, ev, atMs) {
  const staff = st.userTeam?.coachingStaff || {};
  const person = ev.owner === 'program' ? staff.scoutingDirector : staff[ev.owner];
  const role = ev.owner === 'program' ? 'Scouting Director' : ev.owner === 'hittingCoach' ? 'Hitting Coach'
             : ev.owner === 'benchCoach' ? 'Bench Coach' : 'Pitching Coach';
  const sender = person?.name && !person.vacant ? `${person.name}, ${role}` : role;
  const parts = ev.keys.map(k => `${k} from ${ev.from[k]} to ${ev.to[k]}`);
  const moved = ev.keys.some(k => ev.to[k] > ev.from[k]);
  const how = ev.profile === 'flop' || ev.realized < ev.planned * 0.4
    ? (moved ? `It didn't take the way I hoped: ${list(parts)}.` : `It didn't take. ${p.name}'s ${list(ev.keys)} didn't move.`)
    : ev.realized >= ev.planned * 1.15 ? `It went better than I hoped: ${list(parts)}.`
    : ev.profile === 'quick' ? `It clicked right away: ${list(parts)}.`
    : ev.profile === 'slow' ? `It took a while, but it came: ${list(parts)}.`
    : `It went about the way I expected: ${list(parts)}.`;
  const who = ev.owner === 'program' ? 'The program' : 'The work';
  return _deliverNotice(`work:${ev.planId}`, {
    cardId: 'work_report', tag: 'DEVELOPMENT', sender, avatar: '📈', type: moved ? 'good' : 'normal',
    subject: `${p.name}'s ${list(ev.keys)} — the results`, _playerIds: [p.id],
    preview: how,
    body: `${who} with ${p.name} on ${list(ev.keys)} is done. ${how} ${p.name} is OVR ${p.ovr} now.`,
  }, atMs);
}

export function list(xs) { return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`; }


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
  'lineup_restore', 'lineup_keep', 'lineup_auto', 'il_return_wait',
  'rest_auto',   // r160
  'advice_move', 'advice_quiet',   // r162
  'il_return_waive',
  'il_return_auto',
  'il_return_farm',
  'trade_execute',
  'trade_decline',
  // §65 roster clock
  'injury_mri_now',
  'injury_mri_wait',
  'injury_decide',
  'il_placement',
  'il_placement_only',
  'day_to_day',
  'injury_auto',
  'need_callup',
  'need_defer',
  'need_auto',
  'bats_fix',   // r196 §122.73
  'mfill_keep', 'mfill_sendback',
  'openspots_fill', 'openspots_defer', 'openspots_auto',   // r153
  // §71–72 card actions (CardActions registry)
  ...Object.keys(CARD_ACTIONS),
  // §70 offseason
  'os_owner_accept', 'os_owner_push', 'os_owner_auto',
  'os_priority_a', 'os_priority_b',
  'os_resign', 'os_walk', 'os_walk_auto',
  'os_mgr_extend', 'os_mgr_replace', 'os_mgr_auto', 'os_mgr_hire_a', 'os_mgr_hire_b',
  'os_coach_renew', 'os_coach_keep', 'os_coach_letgo', 'os_coach_fire', 'os_hire_a', 'os_hire_b',
  'os_fa_sign', 'os_fa_pass',
  'os_extend', 'os_extend_pass', 'os_release', 'os_release_keep',
  'os_agent_yes', 'os_agent_no',   // r201 §122.78
  'fo_tix_change', 'fo_tix_hold', 'fo_camp_run', 'fo_camp_skip', 'fo_fac_build', 'fo_fac_skip', 'fo_event_yes', 'fo_event_no',
  // §75 All-Star Game
  'as_lobby_yes', 'as_lobby_no',
  // §78 the owner's cut orders
  'fin_dump_yes', 'fin_dump_no', 'fin_release',
  // §102.5 / §122.51 the weather's decisions
  'wx_hold_starter', 'wx_bullpen_game',
  ...['bp', 'calloff', 'comps', 'hands', 'rain', 'sth', 'raincheck', 'booth', 'antics'].flatMap(k => [`wx_${k}_yes`, `wx_${k}_no`, `wx_${k}_auto`]),
]));


export function _cardActionsHandled(card) {
  return [card.onYes, card.onNo].every(a => !a || HANDLED_CARD_ACTIONS.has(a));
}


/**
 * _applyRosterAction(instance, choice, state, { atMs, auto })
 * Carries out a roster card's decision. `choice` is 'yes' | 'no' | 'auto'
 * (deadline). `atMs` is the moment of the decision — real time for a GM tap,
 * the deadline for an auto-resolve — and dates every transaction it creates.
 */
export function _applyRosterAction(instance, choice, state, { atMs = clockNow(), feasible = null } = {}) {
  const raw    = instance._raw || {};
  const action = choice === 'yes' ? raw.onYes : choice === 'no' ? raw.onNo : choice === 'auto' ? raw.onAuto : null;
  if (!action) return;
  if (action.startsWith('os_') || action.startsWith('fo_')) { _applyOffseasonAction(action, instance, atMs); return; }
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
  // §122 the open spot is filled from the free agents (the one the card named, else the best fit).
  const callUpBest = (preferredId, need) => {
    const st = StateManager.get();
    const ranked = rankPickups(st, 'user', need);
    const pick = ranked.find(p => p.id === preferredId) || ranked[0];
    if (!pick) return null;
    let res = null;
    StateManager.mutate(s => { res = signPickup(s, pick.id, 'user', atMs, 'gm'); });
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
    case 'injury_decide': {   // §122 the GM's pick: IL + a signing, IL alone, or cut
      const pick = instance._pick || instance._choices?.[0]?.key || 'il';   // (a plain yes: the recommended one)
      const st = StateManager.get();
      if (st.players[playerId]?.injury?.status !== 'evaluating' || st.players[playerId]?.teamId !== 'user') break;
      if (pick === 'cut') {
        StateManager.mutate(s => { dropPlayer(s, playerId, 'user', atMs, { reason: 'injured' }); });
        reconcileUser();
        break;
      }
      const need = _needFor(st.players[playerId]);
      placeOnIL();
      reconcileUser();
      if (pick.startsWith('il:')) { callUpBest(pick.slice(3), need); reconcileUser(); }
      break;
    }
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
      callUpBest(instance._pick || instance._choices?.[0]?.key || instance._callupCandidate, instance._need);
      reconcileUser();
      break;
    case 'need_defer':
    case 'need_auto':
      break;   // the roster clock owns the deadline

    // r196 §122.73 we can't field nine: the day-to-day bat out longest to the IL, a signing in the spot.
    case 'bats_fix': {
      const st = StateManager.get();
      const need = getRosterNeeds(st, 'user', atMs).bats?.[0];
      if (!need) break;   // (fixed meanwhile)
      StateManager.mutate(s => { const p = s.players[need.ilFirst]; if (p?.injury?.status === 'dtd') Object.assign(p, placeOnILUpdate(p)); });
      reconcileUser();
      callUpBest(instance._pick || instance._choices?.[0]?.key, { side: 'hitter', pos: null });
      reconcileUser();
      break;
    }

    // ── r243 §122.122 the next starter: the benched one back in line, or a bench starter into the open turn, next up ──
    case 'nextsp_fix': {
      const pick = instance._pick || instance._choices?.[0]?.key;
      const id = pick === 'back' ? instance._targetPlayerId : String(pick || '').replace(/^pick:/, '');
      StateManager.mutate(s => {
        const u = s.userTeam, p = s.players[id];
        const rot = u.rotation || (u.rotation = { order: [], currentIndex: 0 });
        const order = rot.order || (rot.order = []);
        if (!p || order.includes(id) || order.length >= ROSTER_LIMITS.STARTING_PITCHERS || !(u.rosterIds || []).includes(id)) return;
        p.group = PLAYER_GROUP.STARTING_PITCHERS;
        const at = order.length ? (rot.currentIndex || 0) % order.length : 0;
        order.splice(at, 0, id);   // in the turn that's up: next
        rot.currentIndex = at;
      });
      reconcileUser();
      break;
    }

    // ── r153 our open spots: the manager's fill now, or the GM sets it ──
    case 'openspots_fill': {
      const rec = reconcileRoster(StateManager.get(), 'user', { fill: true, atMs });
      StateManager.mutate(s => { applyRosterMutation(s, rec); fillLineupsAhead(s); });   // r241 §122.120 and the lineups set ahead
      break;
    }
    case 'openspots_defer':
    case 'openspots_auto':
      break;   // the roster clock fills at the deadline

    // ── r135 the manager's deadline call-ups ─────────────────────
    case 'mfill_keep':
      break;
    case 'mfill_sendback':
      // §122 let go before they report (free agents again); the vacancy clock opens
      // the spot again with a new deadline (always ahead of now) and the open-spot card.
      StateManager.mutate(s => { releasePickups(s, instance._fillIds || [], 'user', atMs); });
      reconcileUser();
      break;

    // ── IL return ───────────────────────────────────────────────
    case 'il_return_auto':   // §122 no answer by the deadline: the manager waives the recommended reserve
    case 'il_return_activate': {
      const st = StateManager.get();
      const player = st.players[playerId];
      if (!player || !(st.ilReturnQueue || []).includes(playerId)) break;
      // §114 a full roster: the player the GM picked goes on waivers (§122)
      // first, or nobody comes off the IL. (A pick that's no longer possible —
      // traded, hurt, moved — leaves the player on the IL; the card comes
      // back with today's choices.)
      if (rosterIsFull(st, 'user', sideOf(player))) {
        const ok = (id) => { const d = st.players[id]; return !!d && d.teamId === 'user' && d.group !== PLAYER_GROUP.IL && !d.isInjured
          && (st.userTeam.rosterIds || []).includes(id) && _sendDownChoices(st, player).some(c => c.key === id); };
        const pick = action === 'il_return_auto'
          ? _sendDownChoices(st, player)[0]?.key
          : instance._pick || (instance._choices?.length === 1 ? instance._choices[0].key : null);
        if (!pick || !ok(pick)) break;
        StateManager.mutate(s => { dropPlayer(s, pick, 'user', atMs, { reason: 'corresponding move' }); });
        if (rosterIsFull(StateManager.get(), 'user', sideOf(player))) break;   // (still no room: stays on the IL)
      }
      const act = activateFromIL(StateManager.get(), playerId, reserveGroup(player));
      StateManager.mutate(s => {
        applyRosterMutation(s, act);
        Object.assign(s.players[playerId], clearInjuryUpdate());
      });
      reconcileUser();
      break;
    }
    case 'il_return_wait':   // nobody could go down: ask again in half a day
      StateManager.mutate(s => { if (s.players[playerId]) s.players[playerId]._ilAskAfter = atMs + 12 * 3600_000; });
      break;

    // ── §113 back in the lineup ─────────────────────────────────
    case 'lineup_restore': {
      const st = StateManager.get();
      const p = st.players[playerId];
      if (!p || p.teamId !== 'user' || !isAvailable(p)) break;
      const spot = _whoHasSpot(st, p);
      if (!spot) break;
      StateManager.mutate(s => _restoreSpot(s, s.players[playerId], spot));
      reconcileUser();
      break;
    }
    case 'lineup_keep':
      StateManager.mutate(s => { if (s.players[playerId]) s.players[playerId]._lostSlot = null; });   // the GM decided: no more asking
      break;
    case 'lineup_auto':
      break;   // nothing changes; the manager asks once more after the game

    // ── r162 §122.34 the staff's roster suggestions ──
    case 'advice_move': {
      const a = instance._advice;
      if (!a) break;
      StateManager.mutate(s => { if (applyAdvice(s, a, atMs) && !['cover', 'stretch'].includes(a.kind)) applyRosterMutation(s, reconcileRoster(s, 'user', { atMs })); });
      break;
    }
    case 'advice_quiet': {   // "I have a plan": quiet for this pairing until something changes
      const a = instance._advice;
      if (!a) break;
      StateManager.mutate(s => { s.adviceQuiet = { ...(s.adviceQuiet || {}), [a.key]: { atMs, gap: a.gap, stamp: adviceStamp(s, a) } }; });
      break;
    }

    // ── r160 §122.32 a rest message nobody answered, about a player worn down: the manager sits them ──
    case 'rest_auto': {
      const st = StateManager.get();
      const act = instance._restArm ? 'arm_rest' : 'day_off';   // r161 an arm: skip the start / two days down
      if (!CARD_ACTIONS[act].feasible(st, instance)) break;
      _applyCardAction(act, { ...instance, choice: 'auto' }, atMs, true);
      const p = StateManager.get().players[playerId];
      if (p?.unavailable?.reason === 'rest') _ourNews(instance._restArm
        ? `${_managerName(st)} rested ${p.name}${instance._restArm === 'starter' ? ' for a turn' : ' for two days'}: a worn-down arm, and no answer on the rest`
        : `${_managerName(st)} sat ${p.name} for a game: worn down, and no answer on the rest`, atMs);
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

    case 'il_return_farm': {   // §122 no farm: letting him go means waivers (a card from before r140)
      if (!playerId) break;
      StateManager.mutate(s => {
        dropPlayer(s, playerId, 'user', atMs);
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
          cardId: 'trade_off', tag: 'TRADE', sender: 'Scouting', avatar: '📞', type: 'normal',
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
          subject: "I'm blocking the trade",
          preview: `It adds ${formatK(d.inK - d.outK)} in salary — more than I'll approve right now…`,
          body: `The deal would have added ${formatK(d.inK - d.outK)} a year to the payroll. With the books where they are, I won't approve it. `
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
