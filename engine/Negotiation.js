/**
 * engine/Negotiation.js
 * §85 Phase 4b — trade talks the GM starts.
 *
 * One open conversation per club (`state.tradeTalks[teamId].talk`). The GM
 * sends an offer; the other GM decides then, and the answer is scheduled to
 * reach us on the real clock — sometimes within a couple of hours, sometimes
 * after more than a day — as an ordinary inbox card, so it can arrive as a
 * push notification with the app closed (§89). It is one of three cards,
 * each a real decision:
 *   - accepted  → finalize the deal, or back out (it costs rapport);
 *   - countered → take their counter, or walk away (or revise our offer from
 *                 the composer, which keeps the same talk going);
 *   - passed    → ask what it would take (they come back with a counter if
 *                 one exists), or move on.
 * Talks that can't meet fizzle after TRADE.maxRounds and the club cools off.
 * Rapport moves with the talks: a lowball cools it, an accepted counter and a
 * completed deal warm it, fizzled talks and backing out cool it.
 */

import * as StateManager from '../store/StateManager.js';
import { TRADE } from '../data/constants.js';
import * as Finance from './FinanceEngine.js';
import {
  cpuRespond, buildCounter, evaluateForClub, tradeBlockers, queueTrade,
  adjustRapport, startCooldown, clubBar,
} from './TradeEngine.js';
import { deliverTalkReply, withdrawTalkCards } from './CardEngine.js';
import { formatK } from './CardTokens.js';

const H = 3_600_000;

/** How long the other GM takes to answer: mostly within the day, sometimes longer. */
function _replyDelayMs() {
  return Math.round((2 + Math.pow(Math.random(), 1.6) * 34) * H);
}

/** The open talk with a club, if any. */
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

/**
 * ourSideOk(state, offer) — can our owner carry the deal (salary we'd add,
 * cash we'd send)? Returns null or the reason.
 */
export function ourSideBlocker(state, offer) {
  const P = (id) => state.players[id];
  const ret = offer.retain || {};
  const inK  = (offer.incomingIds || []).filter(id => Finance.isPaid(P(id)))
    .reduce((a, id) => a + (P(id)?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  const outK = (offer.outgoingIds || []).filter(id => Finance.isPaid(P(id)))
    .reduce((a, id) => a + (P(id)?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  if (!Finance.canAddSalary(state, inK, outK)) return 'ownership won\'t approve the added payroll';
  if ((offer.cashK || 0) < 0 && !Finance.canSpend(state, -offer.cashK)) return 'club funds can\'t cover the cash';
  return null;
}

/**
 * proposeTrade(teamId, offer, atMs, { round }) — send an offer. Returns
 * { ok, reason, replyAtMs }. One talk per club; a revised offer continues it.
 */
export function proposeTrade(teamId, offer, atMs = Date.now(), { round = null } = {}) {
  const state = StateManager.get();
  const clean = {
    incomingIds: [...new Set(offer.incomingIds || [])],
    outgoingIds: [...new Set(offer.outgoingIds || [])],
    cashK: Math.round(offer.cashK || 0),
    retain: Object.fromEntries(Object.entries(offer.retain || {}).filter(([, v]) => v > 0)),
    proposingTeamId: teamId,
  };
  const blocked = tradeBlockers(clean, state, atMs, teamId) || ourSideBlocker(state, clean);
  if (blocked) return { ok: false, reason: blocked };
  const open = talkWith(state, teamId);
  if (open && (open.replyAtMs || 0) > atMs) return { ok: false, reason: 'we are still waiting to hear back from them' };
  const nextRound = round ?? (open && ['countered', 'agreed'].includes(open.status) ? (open.round || 1) + 1 : 1);
  if (nextRound > TRADE.maxRounds) return { ok: false, reason: 'these talks have run their course' };
  const replyAtMs = atMs + _replyDelayMs();
  withdrawTalkCards(teamId);   // a revised offer replaces the open counter
  StateManager.mutate(s => {
    s.tradeTalks = { ...(s.tradeTalks || {}) };
    s.tradeTalks[teamId] = { ...(s.tradeTalks[teamId] || {}),
      talk: { id: `talk-${teamId}-${atMs}`, round: nextRound, offer: clean, sentAtMs: atMs, replyAtMs, status: 'waiting' } };
  });
  // The other GM looks at the offer now; the answer reaches us later, like
  // any message — scheduled, so it can arrive as a push with the app closed.
  _decide(teamId, atMs, replyAtMs);
  return { ok: true, replyAtMs };
}

/** The other GM's decision on the offer (made at `atMs`, delivered at `deliverAtMs`). */
function _decide(teamId, atMs, deliverAtMs) {
  const state = StateManager.get();
  const talk = talkWith(state, teamId);
  if (!talk) return null;
  const r = cpuRespond(talk.offer, state, teamId, { round: talk.round, atMs });
  StateManager.mutate(s => {
    const t = s.tradeTalks[teamId].talk;
    t.status = r.decision === 'accept' ? 'agreed' : r.decision === 'counter' ? 'countered' : 'closed';
    t.answer = { decision: r.decision, reason: r.reason || null, atMs };
    if (r.counter) t.counter = r.counter;
    // How the offer landed with them shows once their answer reaches us
    // (settle), not while we're still waiting to hear.
    const rapport = r.reason === 'lowball' ? TRADE.rapport.lowball : r.reason === 'fizzled' ? TRADE.rapport.fizzled : 0;
    t.pending = (rapport || r.reason === 'fizzled') ? { rapport, coolFromMs: r.reason === 'fizzled' ? deliverAtMs : null } : null;
  });
  deliverTalkReply(teamId, r, deliverAtMs);
  return r;
}

/**
 * settle(teamId) — their answer has reached us: whatever the offer did to the
 * relationship (a lowball, talks that fizzled) takes effect, once.
 */
export function settle(teamId) {
  const talk = talkWith(StateManager.get(), teamId);
  if (!talk?.pending) return;
  StateManager.mutate(s => {
    const t = s.tradeTalks[teamId].talk;
    const p = t.pending;
    if (p.rapport) adjustRapport(s, teamId, p.rapport);
    if (p.coolFromMs) startCooldown(s, teamId, p.coolFromMs);
    t.pending = null;
  });
}

/**
 * callOff(teamId, reason, atMs) — something changed before the deal could be
 * done (a player in it got hurt or moved, the window closed): the talk ends.
 */
export function callOff(teamId, atMs) {
  settle(teamId);
  StateManager.mutate(s => {
    const t = s.tradeTalks?.[teamId]?.talk;
    if (t) s.tradeTalks[teamId].talk = { ...t, status: 'closed', calledOffAtMs: atMs };
  });
}

/**
 * act(teamId, action, atMs) — the GM's decision on a reply card.
 *   'finalize'    — the deal they accepted (or their counter) goes through
 *   'backout'     — we back out of a deal they accepted
 *   'take_counter'— we take their counter
 *   'walk'        — we walk away from a counter
 *   'ask'         — after a pass: what would it take?
 *   'move_on'     — after a pass
 */
export function act(teamId, action, atMs = Date.now()) {
  const state = StateManager.get();
  const talk = talkWith(state, teamId);
  if (!talk) return { ok: false };
  const finish = (offer, rapport) => {
    const blocked = tradeBlockers(offer, state, atMs, teamId) || ourSideBlocker(state, offer);
    if (blocked) return { ok: false, reason: blocked };
    StateManager.mutate(s => {
      s.transactions = [...(s.transactions || []), queueTrade(offer, teamId, atMs)];
      if (rapport) adjustRapport(s, teamId, rapport);
      s.tradeTalks[teamId].talk = { ...s.tradeTalks[teamId].talk, status: 'done' };
    });
    return { ok: true };
  };
  const close = (rapport, cool) => StateManager.mutate(s => {
    if (rapport) adjustRapport(s, teamId, rapport);
    if (cool) startCooldown(s, teamId, atMs);
    s.tradeTalks[teamId].talk = { ...s.tradeTalks[teamId].talk, status: 'closed' };
  });
  switch (action) {
    case 'finalize':     return finish(talk.offer, 0);
    case 'take_counter': return talk.counter ? finish(talk.counter, TRADE.rapport.counterAccepted) : { ok: false };
    case 'backout':      close(-3, true); return { ok: true };
    case 'walk':         close(0, talk.round >= TRADE.maxRounds); return { ok: true };
    case 'move_on':      close(0, false); return { ok: true };
    case 'ask': {
      // What would it take? Their counter, if one exists within reach.
      const ev = evaluateForClub(talk.offer, state, teamId);
      const counter = talk.round < TRADE.maxRounds ? buildCounter(talk.offer, state, teamId, Math.max(0, clubBar(state, teamId) - ev.net), ev) : null;
      const replyAtMs = atMs + Math.round(_replyDelayMs() / 3);
      if (!counter) {
        close(0, false);
        // Their answer to "what would it take?" is the talk's next exchange.
        StateManager.mutate(s => { const t = s.tradeTalks[teamId].talk; t.replyAtMs = replyAtMs; t.round = Math.min(TRADE.maxRounds, (t.round || 1) + 1); });
        deliverTalkReply(teamId, { decision: 'decline', reason: 'nothing' }, replyAtMs);
        return { ok: true };
      }
      StateManager.mutate(s => {
        s.tradeTalks[teamId].talk = { ...s.tradeTalks[teamId].talk, status: 'countered', counter, round: (talk.round || 1) + 1, replyAtMs };
      });
      deliverTalkReply(teamId, { decision: 'counter', counter }, replyAtMs);
      return { ok: true };
    }
    default: return { ok: false };
  }
}

/** A short summary of what an offer contains (for card text). */
export function describeOffer(state, offer, teamName) {
  const P = (id) => state.players[id];
  const ref = (p) => `${p.name} (${p.pos}, OVR ${p.ovr})`;
  const list = (ids) => {
    const ps = (ids || []).map(P).filter(Boolean).map(ref);
    return ps.length <= 1 ? (ps[0] || 'no players') : `${ps.slice(0, -1).join(', ')} and ${ps[ps.length - 1]}`;
  };
  let text = `we send ${list(offer.outgoingIds)} and receive ${list(offer.incomingIds)}`;
  const c = offer.cashK || 0;
  if (c > 0) text += `, with ${formatK(c)} coming to us`;
  if (c < 0) text += `, with ${formatK(-c)} going to ${teamName}`;
  for (const [id, pct] of Object.entries(offer.retain || {})) {
    const p = P(id);
    if (!p) continue;
    const payer = (offer.incomingIds || []).includes(id) ? teamName : 'we';
    text += `; ${payer} keep paying ${Math.round(pct * 100)}% of ${p.name}'s salary this season`;
  }
  return text;
}
