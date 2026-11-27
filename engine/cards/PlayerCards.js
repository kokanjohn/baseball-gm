/**
 * engine/cards/PlayerCards.js
 * CardEngine, player cards: rest, illness, benching, training (§71).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { FOLLOWUP_POOL } from '../../data/cards-pool.js';
import { PLAYER_GROUP } from '../../data/constants.js';
import * as When from '../When.js';
import { reconcileRoster, applyRosterMutation, openSpots, computePayroll } from '../RosterEngine.js';
import { rosterIsFull, sideOf } from '../TransactionEngine.js';
import { formatK } from '../CardTokens.js';
import * as Offseason from '../OffseasonEngine.js';
import { CARD_ACTIONS, reserveChoices } from '../CardActions.js';
import { signingTerms } from '../MarketEngine.js';
import { baseballYear, computeAge } from '../PlayerFactory.js';
import * as FreeAgency from '../FreeAgency.js';
import * as FaWatch from '../FaWatch.js';
import { posLabel } from '../Positions.js';
import { deliverComposeCard } from './Compose.js';
import { _deliverAt, _rosterCard, _withdraw } from './Delivery.js';
import { _who } from './OffseasonCards.js';
import { ALL_POOLS } from './Pools.js';
import { resolve } from './Resolution.js';
import { _cardActionsHandled } from './ScoutingTips.js';
import { _createInstance } from './Selection.js';

// ─────────────────────────────────────────────────────────────
// PLAYER CARDS — rest, illness, benching, training (§71)
// ─────────────────────────────────────────────────────────────
// The card acts on the player its text names (_targetPlayerId). Time away is
// counted in the club's games; training starts a development plan whose
// outcome varies (DevelopmentEngine).

/** Carry out a registered card action (CardActions), then fix the lineup. */
export function _applyCardAction(action, instance, atMs, feasible = null) {
  const handler = CARD_ACTIONS[action];
  if (!handler) return;
  const st = StateManager.get();
  // Things changed since the card arrived (someone got hurt, the spot is gone):
  // it can't happen any more.
  if (!(feasible ?? handler.feasible(st, instance))) return;
  let events = [];
  // r233 §122.112 a spot this decision opens (a starter sent to a program, rested, benched) is filled now, the
  // manager's way, from who's on hand. Spots already open before it are still the GM's to fill (r153).
  const openBefore = openSpots(st).any;
  StateManager.mutate(s => {
    events = handler.apply(s, instance, atMs) || [];
    applyRosterMutation(s, reconcileRoster(s, 'user'));
    if (!openBefore && openSpots(s).any) applyRosterMutation(s, reconcileRoster(s, 'user', { fill: true, atMs }));
    s.userTeam.finances.payroll = computePayroll(s);
  });
  // Follow-ups the action set in motion (§73: a workout's result, a scouting
  // trip's leads, an independent-league report) — real cards at real times.
  for (const ev of events) {
    if (ev?.type === 'SCHEDULE_CARD') _deliverFollowupDef(ev.defId, ev.preset || {}, ev.atMs);
    if (ev?.type === 'SCHEDULE_INDIE') _deliverIndieReport(ev.playerId, ev.atMs);
    if (ev?.type === 'SCHEDULE_COMPOSE') deliverComposeCard(ev.topic, ev.channel, { topicLabel: ev.label, arg: ev.arg || null, nowMs: ev.atMs });   // r211 §122.89
  }
}


/** A pool card about players already named (follow-ups), parked for `atMs`. */
export function _deliverFollowupDef(defId, preset, atMs) {
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


/**
 * _scoutFindsGone(atMs) — §122 a player the scouts found (a card's new player)
 * never joins the free-agent pool: once no card or scheduled card still names
 * him and he hasn't signed, he signs elsewhere or goes home (he leaves the league).
 */
/**
 * r204 §122.82 the free agents we watch, and the reports that offer them:
 *   - watches over (signed anywhere, or 30 days) are dropped;
 *   - a club moving to sign a player we watch → the director's message, at the moment of the move, with
 *     half a day to sign first (no answer: the club signs) — withdrawn if the player signs before then;
 *   - a report with nothing left to decide (each player signed, gone, or watched) closes itself.
 */
export function _faWatchSweep(atMs) {
  let delivered = 0;
  let st = StateManager.get();
  if (Object.keys(st.faWatch || {}).some(id => st.players[id]?.group !== PLAYER_GROUP.FREE_AGENT || st.faWatch[id].untilMs <= atMs)) {
    StateManager.mutate(s => FaWatch.pruneWatches(s, atMs));
    st = StateManager.get();
  }
  const cards = [...(st.inbox || []), ...(st.scheduledCards || [])];
  for (const id of st.freeAgentPool || []) {
    const p = st.players[id], c = p?._watchClaim;
    if (!c || c.madeAtMs > atMs) continue;
    if (cards.some(x => x._rosterKey === `watch:${id}:${c.madeAtMs}`)) continue;
    if (_deliverWatchAlert(p, c)) delivered++;
  }
  _withdraw(x => x.cardId === 'watch_alert' && st.players[x._targetPlayerId]?.group !== PLAYER_GROUP.FREE_AGENT);
  for (const card of (StateManager.get().inbox || []).filter(x => x._faRows && !x.resolved)) {
    if (FaWatch.reportRows(StateManager.get(), card, atMs).every(r => r.status !== 'open')) {
      StateManager.mutate(s => { const x = s.inbox.find(y => y.instanceId === card.instanceId); if (x) x._summary = FaWatch.reportSummary(s, x, atMs); });
      resolve(card.instanceId, 'yes');
    }
  }
  return delivered;
}


/** r204 §122.82 a club is moving to sign a player we watch: sign first, or let the club have the player. */
function _deliverWatchAlert(p, claim) {
  const state = StateManager.get();
  const d = state.userTeam?.coachingStaff?.scoutingDirector;
  const club = (state.leagueTeams || []).find(t => t.id === claim.teamId)?.name || 'Another club';
  const t = FreeAgency.termsFor(state, p);
  const ask = `${formatK(t.salary || 0)} a year${t.bonus ? ` and a ${formatK(t.bonus)} bonus` : ''}`;
  const card = _rosterCard(state, {
    cardId: 'watch_alert', tag: 'SCOUTING', sender: d && !d.vacant ? `${d.name}, Scouting Director` : 'Scouting', avatar: '🔎', type: 'urgent',
    _rosterKey: `watch:${p.id}:${claim.madeAtMs}`, _targetPlayerId: p.id,
    subject: `${p.name} is drawing calls`,
    preview: `${club} is moving to sign ${p.name}. We have until ${When.untilFull(claim.atMs, claim.madeAtMs)} to sign first.`,
    body: `${club} is moving to sign ${_who(p)}, one of the free agents we've been watching. `
        + `The ask is still ${ask}. We have until ${When.untilFull(claim.atMs, claim.madeAtMs)} to sign first; let it go, and ${club} signs.`,
    yesLabel: `Sign ${p.name} (${formatK(t.salary || 0)})`, noLabel: 'Let Go',
    autoResolve: 'roster', expiresAtMs: claim.atMs,
    _raw: { onYes: 'watch_sign', onNo: 'watch_let_go', onAuto: 'watch_let_go' },
    _autoLabel: `No answer — ${club} signed`,
  });
  _addDropChoices(state, card);
  return _deliverAt(card, claim.madeAtMs);
}


export function _scoutFindsGone(atMs) {
  const st = StateManager.get();
  const finds = (st.freeAgentPool || []).filter(id => st.players[id]?._scoutFind);
  if (!finds.length) return;
  const named = new Set();
  for (const c of [...(st.inbox || []).filter(x => !x.resolved), ...(st.scheduledCards || [])]) {
    if (c._targetPlayerId) named.add(c._targetPlayerId);
    for (const id of Object.values(c._tokenPlayers || {})) if (id) named.add(id);
  }
  const gone = finds.filter(id => !named.has(id));
  if (gone.length) StateManager.mutate(s => { for (const id of gone) Offseason.departLeague(s, id, atMs, 'scouting pass'); });
}


/**
 * _addDropChoices(state, instance) — §122 a card that signs a free agent
 * (its target) when his side of our 28 is full: the sign sheet asks who goes
 * on waivers — our three lowest-rated reserves on that side, the lowest
 * recommended. (The card's action reads the pick: CardActions.dropFor.)
 */
export function _addDropChoices(state, instance) {
  if (!instance || instance._choices?.length) return;
  const id = instance._targetPlayerId;
  const p = id && state.players[id];
  // (the signings whose action reads the pick — CardActions.dropFor)
  const signs = /^(sign_acquire_pitcher|sign_prospect_pitcher|sign_intl_player|sign_intl_flyer|indie_sign|sp15_callup|scout_tip_sign|watch_sign)$/.test(instance._raw?.onYes || '');
  if (!p || p.group !== PLAYER_GROUP.FREE_AGENT || !signs) return;
  const side = sideOf(p);
  if (!rosterIsFull(state, 'user', side)) return;
  const res = reserveChoices(state, side);
  if (!res.length) return;
  const sign = instance.yesLabel || `Sign ${p.name}`;
  instance._choices = res.map(r => ({ key: r.id, label: `${sign} — waive ${r.name}`,
    sub: `${r.name} (${posLabel(r)}, OVR ${r.ovr}) goes on waivers: off the payroll at once` }));
}


/** The scout's independent-league report: sign him to our roster, or pass (he's gone). */
function _deliverIndieReport(playerId, atMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p || p.group !== PLAYER_GROUP.FREE_AGENT) return null;
  const terms = signingTerms(state, p);
  const age = computeAge(p.dob, baseballYear(state));
  const card = _rosterCard(state, {
    cardId: 'indie_report', tag: 'SCOUTING', sender: 'Scouting', avatar: '🔭', type: 'good',
    _rosterKey: `indie:${playerId}`, _targetPlayerId: playerId, _tokenPlayers: { indie_player: playerId },
    subject: `Scouting report: ${p.name}`,
    preview: `${_who(p)}, ${age} — ${p._indieLeague || 'independent ball'}.`,
    body: `Our scout saw ${_who(p)}, ${age}, in the ${p._indieLeague || 'independent leagues'}. `
        + `A ${formatK(terms.bonus)} bonus gets the deal done: ${p.name} joins our roster (the minimum salary, three years). `
        + `Pass, and ${p.name} signs somewhere else.`,
    yesLabel: `Sign (${formatK(terms.bonus)})`, noLabel: 'Pass',
    expiresAtMs: atMs + 3 * 86_400_000,
    _raw: { onYes: 'indie_sign', onNo: 'indie_pass', onAuto: 'indie_pass' },
    _autoLabel: 'No answer — passed',
  });
  _addDropChoices(state, card);
  return _deliverAt(card, atMs);
}
