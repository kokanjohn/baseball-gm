/**
 * engine/TradeAdvice.js — r150: the staff weigh in on a trade on the table.
 *
 * A deal on the table is one waiting on our answer: a club's offer to us, a
 * club's counter to our offer, or a club's yes to our offer (dealsOnTable).
 * The GM can ask about one from the compose screen:
 *   - the Manager: what the deal does to the club on the field today — who
 *     takes each spot we'd give up, where each player coming in would play,
 *     and (from the pitching and hitting coaches) the arm or the bat coming in
 *     (fieldRead; the words are ComposeReplies' mgr_trade);
 *   - the Scouting Director: is there a better deal here — a specific counter
 *     that the club should still take, read through the director's eye: the
 *     better the director, the closer the read of how much room the club has,
 *     and a weak one sometimes asks for too much (suggestCounter; the words
 *     and the payroll paragraph are ComposeReplies' sc_trade). The reply is a
 *     decision: send the counter as the next round of the talks, or not.
 *
 * Every rule here is the one the clubs and the talks already use (TradeEngine's
 * evaluateForClub / clubBar / cpuRespond), so the director's read is a read of
 * what the club will really do — with the director's error on top.
 *
 * Pure: never imports StateManager.
 */

import { PLAYER_GROUP, PLAYER_ORIGIN, TRADE } from '../data/constants.js';
import {
  evaluateForClub, evaluateForUser, clubBar, tradeBlockers, ourSideBlocker, talkWith,
  playsSlot, isKeyPiece, contractRunOut, cashValue, wouldStart,
} from './TradeEngine.js';
import { bullpenRoles, ROLE } from './PitchingEngine.js';
import { scoutEye } from './CoachEngine.js';
import * as Finance from './FinanceEngine.js';
import { computeAge, baseballYear } from './PlayerFactory.js';

/** A player this young the director would ask for as a prospect (not a regular for us yet). */
export const PROSPECT_AGE = 24;

const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const healthy = (p) => !!p && !p.isInjured && p.group !== PLAYER_GROUP.IN_TRANSIT;
const best = (xs) => xs.reduce((a, b) => (!a || (b.ovr || 0) > (a.ovr || 0) ? b : a), null);
const worst = (xs) => xs.reduce((a, b) => (!a || (b.ovr || 0) < (a.ovr || 0) ? b : a), null);

// ─────────────────────────────────────────────────────────────
// THE DEALS ON THE TABLE
// ─────────────────────────────────────────────────────────────

/**
 * dealsOnTable(state, atMs) — the deals waiting on our answer, soonest
 * deadline first: { key, kind: 'offer'|'counter'|'agreed', teamId, team,
 * offer (our terms: incomingIds = we get, cashK + = they pay us), round (the
 * round a counter from us would be), label, expiresAtMs, instanceId }.
 */
export function dealsOnTable(state, atMs) {
  const name = (id) => (state.leagueTeams || []).find(t => t.id === id)?.name || 'They';
  const out = [];
  for (const c of state.inbox || []) {
    if (c.resolved || (c.arrivedAtMs ?? c.deliverAtMs ?? 0) > atMs) continue;
    if (c.expiresAtMs && c.expiresAtMs <= atMs) continue;
    if (c._tradeOffer && c._proposingTeamId) {
      out.push({ key: `offer:${c.instanceId}`, kind: 'offer', teamId: c._proposingTeamId, team: name(c._proposingTeamId),
                 offer: c._tradeOffer, round: 2, label: c.subject, expiresAtMs: c.expiresAtMs ?? null, instanceId: c.instanceId });
      continue;
    }
    if ((c.cardId === 'talk_counter' || c.cardId === 'talk_accepted') && c._talkTeamId) {
      const talk = talkWith(state, c._talkTeamId);
      if (!talk || talk.id !== c._talkId || talk.round !== c._talkRound) continue;
      const counter = c.cardId === 'talk_counter';
      if (counter ? (talk.status !== 'countered' || !talk.counter) : talk.status !== 'agreed') continue;
      out.push({ key: `${counter ? 'counter' : 'agreed'}:${talk.id}:${talk.round}`, kind: counter ? 'counter' : 'agreed',
                 teamId: c._talkTeamId, team: name(c._talkTeamId), offer: counter ? talk.counter : talk.offer,
                 round: (talk.round || 1) + 1, label: c.subject, expiresAtMs: c.expiresAtMs ?? null, instanceId: c.instanceId });
    }
  }
  return out.sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity));
}

/** The deal with this key, if it is still on the table. */
export function dealByKey(state, key, atMs) {
  return dealsOnTable(state, atMs).find(d => d.key === key) || null;
}

/** Which deals each staff topic takes: the director only where a counter is still possible. */
export function dealsFor(topicId, state, atMs) {
  const ds = dealsOnTable(state, atMs);
  return topicId === 'sc_trade' ? ds.filter(d => d.kind !== 'agreed') : ds;
}

// ─────────────────────────────────────────────────────────────
// THE MANAGER: THE CLUB ON THE FIELD, BEFORE AND AFTER
// ─────────────────────────────────────────────────────────────

/**
 * fieldRead(state, deal) — the deal on the field, today:
 *   leaving:  [{ p, role: 'lineup'|'rotation'|'closer'|'setup'|'pen'|'bench'|'hurt', slot?, next? }]
 *             (next: who takes the spot — a player of ours, or one coming in)
 *   arriving: [{ p, role: 'lineup'|'rotation'|'closer'|'setup'|'depth'|'hurt', slot?, over?, fills? }]
 *             (over: the player they'd take the spot from; fills: the spot of a player leaving)
 *   delta:    OVR points better (+) or worse (−) across the regulars, summed
 */
export function fieldRead(state, deal) {
  const P = (id) => state.players[id];
  const u = state.userTeam;
  const outs = (deal.offer.outgoingIds || []).map(P).filter(Boolean);
  const ins  = (deal.offer.incomingIds || []).map(P).filter(Boolean);
  const outIds = new Set(outs.map(p => p.id));
  const pool = [...(u.rosterIds || []).map(P).filter(p => p && !outIds.has(p.id)), ...ins].filter(healthy);
  const lineup = (u.lineupSlots || []).map(s => ({ slot: s.slot, p: P(s.playerId) })).filter(x => x.p);
  const rot = (u.rotation?.order || []).map(P).filter(Boolean);
  const roles = bullpenRoles(u, state.players);
  const taken = new Set([...lineup.map(x => x.p.id), ...rot.map(p => p.id)].filter(id => !outIds.has(id)));
  const take = (q) => { if (q) taken.add(q.id); return q; };
  const pen = pool.filter(q => q.pos === 'RP' && !taken.has(q.id));

  let delta = 0;
  const leaving = outs.map(p => {
    const ls = lineup.find(x => x.p.id === p.id);
    if (ls) {
      const next = take(best(pool.filter(q => !isP(q) && !taken.has(q.id) && playsSlot(q, ls.slot))));
      delta += (next?.ovr ?? (p.ovr || 0) - 15) - (p.ovr || 0);
      return { p, role: 'lineup', slot: ls.slot, next };
    }
    if (rot.some(x => x.id === p.id)) {
      const next = take(best(pool.filter(q => q.pos === 'SP' && !taken.has(q.id))) || best(pool.filter(q => q.pos === 'RP' && !taken.has(q.id))));
      delta += (next?.ovr ?? (p.ovr || 0) - 15) - (p.ovr || 0);
      return { p, role: 'rotation', next };
    }
    const r = roles.roleOf?.[p.id];
    if (r === ROLE.CLOSER || r === ROLE.SETUP) {
      const next = best(pen.filter(q => q.id !== p.id && roles.roleOf?.[q.id] !== ROLE.CLOSER));
      delta += 0.5 * ((next?.ovr ?? (p.ovr || 0) - 10) - (p.ovr || 0));
      return { p, role: r === ROLE.CLOSER ? 'closer' : 'setup', next };
    }
    if (p.isInjured) return { p, role: 'hurt' };
    return { p, role: p.pos === 'RP' || (p.pos === 'SP' && r) ? 'pen' : 'bench' };
  });

  const arriving = ins.map(q => {
    const fills = leaving.find(l => l.next?.id === q.id);
    if (fills) { delta += 0; return { p: q, role: fills.role, slot: fills.slot, fills }; }
    if (!healthy(q)) return { p: q, role: 'hurt' };
    if (q.pos === 'SP') {
      const w = worst(rot.filter(x => !outIds.has(x.id)));
      if (w && (q.ovr || 0) > (w.ovr || 0)) { delta += (q.ovr || 0) - (w.ovr || 0); return { p: q, role: 'rotation', over: w }; }
      return { p: q, role: 'depth' };
    }
    if (q.pos === 'RP') {
      const closer = P(roles.closer);
      const setup = (roles.setup || []).map(P).filter(Boolean);
      if (closer && !outIds.has(closer.id) && (q.ovr || 0) > (closer.ovr || 0)) { delta += 0.5 * ((q.ovr || 0) - (closer.ovr || 0)); return { p: q, role: 'closer', over: closer }; }
      const w = worst(setup.filter(x => !outIds.has(x.id)));
      if (w && (q.ovr || 0) > (w.ovr || 0)) { delta += 0.5 * ((q.ovr || 0) - (w.ovr || 0)); return { p: q, role: 'setup', over: w }; }
      return { p: q, role: 'depth' };
    }
    const spots = lineup.filter(x => !outIds.has(x.p.id) && playsSlot(q, x.slot) && (q.ovr || 0) > (x.p.ovr || 0));
    const w = spots.reduce((a, b) => (!a || (b.p.ovr || 0) < (a.p.ovr || 0) ? b : a), null);
    if (w) { delta += (q.ovr || 0) - (w.p.ovr || 0); return { p: q, role: 'lineup', slot: w.slot, over: w.p }; }
    return { p: q, role: 'depth' };
  });

  return { leaving, arriving, delta: Math.round(delta) };
}

// ─────────────────────────────────────────────────────────────
// THE DIRECTOR: IS THERE A BETTER DEAL HERE?
// ─────────────────────────────────────────────────────────────

/** How far off the director's read of a club's room can be (trade value, 1 sd): ~13 at 40, ~6 at 70, ~4 at 90 (a pro scout). */
export function readError(staff) {
  return 8 / scoutEye(staff, { origin: PLAYER_ORIGIN.LEAGUE });
}
/** The room the director wants left for the club in a counter (trade value): a good director is right about it most of the time, a weak one often isn't. */
export const COUNTER_MARGIN = 5;
/** A counter has to be worth this much more to us to bother asking. */
export const COUNTER_MIN_GAIN = 3;

const gauss = (r) => { let a = 0, b = 0; while (a === 0) a = r(); while (b === 0) b = r(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };
const clone = (o) => ({ ...o, incomingIds: [...(o.incomingIds || [])], outgoingIds: [...(o.outgoingIds || [])], retain: { ...(o.retain || {}) }, cashK: o.cashK || 0 });

/** Could this deal be sent as it stands — both sides able to carry it? */
function _canGo(state, offer, teamId, atMs) {
  if (tradeBlockers(offer, state, atMs, teamId) || ourSideBlocker(state, offer)) return false;
  const ev = evaluateForClub(offer, state, teamId);
  return ev.booksOk && ev.cashOk;
}

/**
 * suggestCounter(state, deal, rand, atMs) — the director's counter:
 *   { ourNet, slack, seen, sd, lastRound, noRounds, counter, change, after }
 *   ourNet  how the deal as it stands is for us (trade value, our rules)
 *   slack   how much room the club really has over its bar (the truth)
 *   seen    the director's read of that room (slack + the director's error)
 *   counter the offer the director would send (our terms) or null, with
 *   change  what it changes: { kind: 'cash', k } | { kind: 'drop', id } |
 *           { kind: 'add', id } | { kind: 'swap', id, for } — and
 *   after   { slack, seen, gain }: the club's room after it (the truth and the
 *           read) and what it adds for us.
 * One error per read (the director misjudges the club, not each idea), so the
 * read and the counter agree.
 */
export function suggestCounter(state, deal, rand, atMs) {
  const { teamId, offer } = deal;
  const staff = state.userTeam?.coachingStaff;
  const bar = clubBar(state, teamId);
  const sd = readError(staff);
  const err = gauss(rand) * sd;
  const ourNet = evaluateForUser(offer, state).net;
  const slack = evaluateForClub(offer, state, teamId).net - bar;
  const seen = slack + err;
  const base = { ourNet, slack, seen, sd, lastRound: deal.round >= TRADE.maxRounds, noRounds: deal.round > TRADE.maxRounds, counter: null, change: null, after: null };
  if (base.noRounds || seen < COUNTER_MARGIN + 1) return base;

  const P = (id) => state.players[id];
  const club = (state.leagueTeams || []).find(t => t.id === teamId);
  const cands = [];
  // 1. Money: more from them, or less from us.
  const per = cashValue(1, state, teamId);
  const k = Math.floor(((seen - COUNTER_MARGIN) / per) / 25) * 25;
  if (k >= 25) {
    const o = clone(offer); o.cashK += k;
    const theyPay = Math.max(0, o.cashK) - Math.max(0, offer.cashK || 0);
    if (!theyPay || Finance.canSpend(state, theyPay, teamId)) cands.push({ o, change: { kind: 'cash', k } });
  }
  // 2. One of ours taken off (when we send more than one).
  if ((offer.outgoingIds || []).length > 1) {
    for (const id of offer.outgoingIds) {
      const o = clone(offer); o.outgoingIds = o.outgoingIds.filter(x => x !== id); delete o.retain[id];
      cands.push({ o, change: { kind: 'drop', id } });
    }
  }
  // 3. One more of theirs: a player they can spare who would help us.
  const theirs = (club?.rosterIds || []).map(P).filter(p => p && healthy(p) && !(offer.incomingIds || []).includes(p.id)
    && !contractRunOut(p, state) && !(p._acquiredAtMs && atMs - p._acquiredAtMs < TRADE.noFlipMs));
  if ((offer.incomingIds || []).length < TRADE.maxPerSide) {
    for (const p of theirs) {
      if (isKeyPiece(p, state, teamId)) continue;
      // (a regular for us, or a young player: a prospect)
      if (!wouldStart(p, state, 'user') && computeAge(p.dob, baseballYear(state)) > PROSPECT_AGE) continue;
      const o = clone(offer); o.incomingIds.push(p.id);
      cands.push({ o, change: { kind: 'add', id: p.id } });
    }
  }
  // 4. A better player of theirs in place of one they offer (same job).
  for (const id of offer.incomingIds || []) {
    const q = P(id);
    if (!q) continue;
    for (const p of theirs) {
      if ((p.ovr || 0) <= (q.ovr || 0)) continue;
      const same = isP(q) ? p.pos === q.pos : !isP(p) && playsSlot(p, q.nativePos || q.pos);
      if (!same) continue;
      const o = clone(offer); o.incomingIds = o.incomingIds.map(x => (x === id ? p.id : x)); delete o.retain[id];
      cands.push({ o, change: { kind: 'swap', id: p.id, for: id } });
    }
  }

  let pick = null;
  for (const c of cands) {
    if (!_canGo(state, c.o, teamId, atMs)) continue;
    const s1 = evaluateForClub(c.o, state, teamId).net - bar;
    if (s1 + err < COUNTER_MARGIN) continue;   // the director thinks they won't take it
    const gain = evaluateForUser(c.o, state).net - ourNet;
    if (gain < COUNTER_MIN_GAIN) continue;
    // Prefer the bigger gain; on a near tie, the simpler ask (money, then one player).
    const score = gain - (c.change.kind === 'cash' ? 0 : 1);
    if (!pick || score > pick.score) pick = { ...c, slack1: s1, gain, score };
  }
  if (!pick) return base;
  return { ...base, counter: pick.o, change: pick.change, after: { slack: pick.slack1, seen: pick.slack1 + err, gain: pick.gain } };
}
