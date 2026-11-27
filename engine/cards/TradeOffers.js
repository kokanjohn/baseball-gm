/**
 * engine/cards/TradeOffers.js
 * CardEngine, a CPU club's offer to us (§91) and trade talks (§85).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { evaluateTrade, tradeBlockers, evaluateForUser, evaluateForClub, clubBar, rapportOf, rapportGrade, adjustRapport } from '../TradeEngine.js';
import { formatK } from '../CardTokens.js';
import * as Finance from '../FinanceEngine.js';
import * as Negotiation from '../Negotiation.js';
import * as LeagueTrades from '../LeagueTrades.js';
import { clockNow } from '../Clock.js';
import { eventRand } from '../Dice.js';
import { _tradeSalaryOk } from './Compose.js';
import { _deliverAt, _rosterCard, _scheduleCards, _withdraw } from './Delivery.js';
import { _deliverNotice } from './RosterCards.js';
import { toInbox, VIA } from './Entry.js';   // r291 §122.172

const TradeRapportBump = (s, teamId) => adjustRapport(s, teamId, 1);


// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// A CPU CLUB'S OFFER TO US (§91)
// ─────────────────────────────────────────────────────────────
//
// Every offer a CPU club makes us is a decision with three ways out: take it,
// turn it down (the club cools off), or counter from the composer, which
// starts a talk at round 2 (their offer was round 1). The club opens in its
// own favor — a little under our player's value when it wants him, a little
// over its own when it offers one — and Pro Scouting says, in words, whether
// there's room. Kinds:
//   call  — the trade desk: a club with a need wants one of our players
//   sell  — a club offers us one of its players (the seed, the All-Star
//           suitor, a club cutting payroll returning our call)
//   sale  — a selling club's player for cash (§85 A)

const _NOUN  = { C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', OF: 'outfielder', DH: 'designated hitter' };

const _SPOT  = { C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'the outfield', DH: 'the DH spot' };

const _an    = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

export const _pick  = (xs) => xs[Math.floor(eventRand() * xs.length)];

const _poss  = (name) => (/s$/.test(name) ? `${name}'` : `${name}'s`);

const _and   = (xs) => xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;


/** A club's need in words: { a: 'a shortstop', role: 'play shortstop for them every day', hole: 'shortstop has been a weak spot' }. */
function _needWords(need, whose = 'them') {
  if (!need) return { a: 'help', role: `help ${whose} right away`, hole: 'the lineup has a hole' };
  if (need.kind === 'sp') return { a: 'a starting pitcher', role: `start in ${whose === 'us' ? 'our' : 'their'} rotation`, hole: 'the back of the rotation has been a weak spot' };
  if (need.kind === 'rp') return { a: 'a late-inning reliever', role: `pitch the late innings for ${whose}`, hole: 'the bullpen has been leaking late in games' };
  const n = _NOUN[need.slot] || 'regular';
  return need.slot === 'DH'
    ? { a: 'a designated hitter', role: `be ${whose === 'us' ? 'our' : 'their'} designated hitter`, hole: 'the DH spot has been a weak spot' }
    : { a: _an(n), role: `play ${_SPOT[need.slot] || n} for ${whose} every day`, hole: `${_SPOT[need.slot] || 'one spot in the lineup'} has been a weak spot` };
}


/**
 * The opening line, by kind, varied so the same situation doesn't read the same way twice.
 * `ours` / `theirs` is the player's full reference (r195: the one place the message names them).
 */
function _offerIntro(kind, { team, ours, theirs, need, seed }) {
  const w = _needWords(need, kind === 'call' ? 'them' : 'us');
  if (kind === 'call') return _pick(seed ? [
    `Welcome to the job. ${team} were the first to call: they need ${w.a} and want ${ours}.`,
    `The phone was ringing before the nameplate went up. ${team} want ${ours} to ${w.role}.`,
    `${team} wasted no time testing the new front office: they're after ${ours}.`,
  ] : [
    `${team} called about ${ours}. They need ${w.a} and see a fit.`,
    `${team} have been shopping for ${w.a}, and ${ours} is the name they keep coming back to.`,
    `${_poss(team)} front office reached out: they want ${ours} to ${w.role}.`,
    `Word from ${team}: ${w.hole} for them, and they'd like ${ours} to fill it.`,
  ]);
  if (kind === 'sell') return _pick(seed ? [
    `Welcome to the job. ${team} called with an offer: ${theirs}, who would ${need ? w.role : 'start for us'}.`,
    `The phone was ringing before the nameplate went up — ${team} want to move ${theirs}, and they think we're the fit.`,
    `${team} are testing the new front office with an offer for ${theirs}.`,
  ] : [
    `${team} called: ${theirs} is available, and they think we'd have a starting job waiting.`,
    need ? `${team} know we could use ${w.a} and are offering ${theirs}.` : `${team} are shopping ${theirs} and think we're a fit.`,
    `${_poss(team)} GM is shopping ${theirs} and called us first.`,
  ]);
  return '';
}


/**
 * r157 Who an offer comes from. Most reach us through Pro Scouting, who tells
 * us about the call and what they make of it (the read, Impact, the payroll).
 * Some come straight from the other club's front office, in their own voice:
 * what they want and what they'll give, and nothing of our analysis. A line
 * written for the moment (a club calling back about a conversation we started)
 * is always Pro Scouting's. Chosen from the offer itself, so it never shifts.
 */
const _DIRECT_SHARE = 0.4;

function _offerVoiceDirect(key) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 1000) / 1000 < _DIRECT_SHARE;
}

const _pickBy = (xs, key) => { let h = 7; for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return xs[h % xs.length]; };


/**
 * The other club's front office, writing to us: the ask, the deal, no analysis.
 * r195 each player named once: the one they ask about (or offer) in the opening
 * line, the rest in the deal line, everything about a player in its parenthetical.
 */
function _directOffer({ kind, need, seed, key, ins, outs, cashK, retain, refOf }) {
  const pct = (id) => Math.round((retain?.[id] || 0) * 100);
  const keep = (p) => (!retain?.[p.id] ? '' : ins.includes(p) ? `we'll keep paying ${pct(p.id)}% of the salary this season`
    : `you'd keep paying ${pct(p.id)}% of the salary this season`);
  const ref = (p) => refOf(p, keep(p));
  const and = (xs) => _and(xs.map(ref));
  const target = kind === 'call' ? outs[0] : ins[0];
  const who = target ? ref(target) : '';
  const w = _needWords(need, 'us');                     // their need, in their words ("our rotation")
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const lead = kind === 'call' ? _pickBy(seed ? [
      `Welcome to the league. We'll get right to it: we need ${w.a}, and we want ${who}.`,
      `Congratulations on the new job. We've had our eye on ${who} for a while, and we need ${w.a}.`,
    ] : [
      `We're looking for ${w.a}, and ${who} is the one we want.`,
      `We'd like ${who} to ${w.role}.`,
      need ? `${cap(w.hole)} for us, and we think ${who} fixes it.` : `We've been talking about ${who} for a while now.`,
    ], key)
    : kind === 'sale' ? `We need to move salary, so ${who} is available.`
    : _pickBy(seed ? [
      `Welcome to the league. ${who} is available, and we think you're a fit.`,
    ] : [
      `${who} is available, and we think you'd have a starting job waiting.`,
      need ? `We hear you could use ${w.a}. ${who} is available.` : `We're moving ${who}, and you were the first club we thought of.`,
    ], key);
  // The rest of the deal: the side the opening line didn't name.
  const restOut = outs.filter(p => p !== target), restIn = ins.filter(p => p !== target);
  let deal;
  if (kind === 'sale') deal = `The price is ${formatK(-cashK)}.${restIn.length ? ` ${and(restIn)} would come too.` : ''}`;
  else if (kind === 'call') deal = `${restOut.length ? `We'd also want ${and(restOut)}. ` : ''}`
    + (restIn.length ? `In return, we'd send ${and(restIn)}.` : cashK > 0 ? `In return, we'd send ${formatK(cashK)}.` : '')
    + (restIn.length && cashK > 0 ? ` We'll add ${formatK(cashK)} to make it work.` : cashK < 0 ? ` We'd need ${formatK(-cashK)} from you as well.` : '');
  else deal = `${restIn.length ? `${and(restIn)} would come too. ` : ''}`
    + (restOut.length ? `For that, we'd want ${and(restOut)}.` : cashK < 0 ? `For that, we'd want ${formatK(-cashK)}.` : '')
    + (restOut.length && cashK < 0 ? ` We'd need ${formatK(-cashK)} from you as well.` : cashK > 0 ? ` We'll add ${formatK(cashK)} to make it work.` : '');
  const close = _pickBy(['Let us know.', 'Let us know what you think.', 'We\'d like to get this done soon.', 'Call us if you want to talk it over.'], key + ':close');
  const subject = kind === 'call' ? `Interested in ${target?.name}` : `${target?.name} is available`;
  return { body: `${lead} ${deal.trim()} ${close}`.replace(/\s+/g, ' '), subject };
}


/** Pro Scouting's read, in words (never a meter). */
function _offerRead(st, kind, offer, room) {
  const net = evaluateForUser(offer, st).net;
  const good = net >= 15;
  if (kind === 'call') return room
    ? 'Our read: it\'s an opening bid, and they should go higher if we push back.'
    : good     ? 'Our read: this is close to the most they will pay, and it\'s a good deal for us.'
    : net >= 0 ? 'Our read: this is close to the most they will pay, and it\'s fair value for us.'
               : 'Our read: this is about the most they will pay, a little short of what we would want.';
  if (kind === 'sell') return room
    ? 'Our read: they\'re asking a bit more than they would take, so there\'s room to bring the price down.'
    : good     ? 'Our read: that\'s a good price for us.'
    : net >= 0 ? 'Our read: that\'s a fair price.'
               : 'Our read: that\'s about the least they will take, and it\'s a little steep for us.';
  return good ? 'Our read: that\'s a good price for us.' : net >= 0 ? 'Our read: the price is fair.' : 'Our read: the price is a little high.';
}


/** Can the offer be made right now, with both owners able to carry it? */
export function _offerCanGo(st, offer, teamId, atMs) {
  return !tradeBlockers(offer, st, atMs, teamId) && !Negotiation.ourSideBlocker(st, offer) && _tradeSalaryOk(st, offer, teamId);
}


/**
 * deliverTradeCall(deal, atMs, { seed }) — §91 the trade desk's call: a club
 * with a need wants one of our players (deal.a = the club, deal.b = 'user'),
 * and its opening offer reaches us within the next hour or so.
 */
export function deliverTradeCall(deal, atMs, { seed = false } = {}) {
  const st = StateManager.get();
  const offer = LeagueTrades.userOffer(deal);
  if (!_offerCanGo(st, offer, deal.a, atMs)) return null;
  return deliverTradeOffer(offer, deal.a, {
    kind: 'call', room: !!deal.room, need: deal.why?.need || null, seed, openBy: deal.openBy || 0,
    atMs: seed ? null : atMs + (10 + eventRand() * 80) * 60_000,
  });
}


/**
 * deliverTradeOffer(offer, proposingTeamId, opts)
 * A CPU club's offer as an inbox card (offer in our terms: incomingIds = we
 * receive, cashK + = they pay us).
 *   opts: { kind: 'call'|'sell'|'sale', room, need, intro (a line of its own,
 *           replacing the varied one; a function of the player's reference
 *           when it names the player), subject, seed, atMs (exact delivery),
 *           openBy (how far under our value a caller opened) }
 */
export function deliverTradeOffer(offer, proposingTeamId, { kind = 'sell', room = false, need = null, intro = null, subject = null, seed = false, atMs = null, openBy = 0 } = {}) {
  const state    = StateManager.get();
  const team     = (state.leagueTeams || []).find(t => t.id === proposingTeamId);
  const teamName = team?.name || 'Another team';
  const evaluation = evaluateTrade(offer, state);

  const ins  = evaluation.incomingPlayers || [];
  const outs = evaluation.outgoingPlayers || [];
  const incoming = ins[0];
  if (!incoming && !outs.length) return null;
  // §85 up to three a side, plus cash and salary kept by the sending club.
  // r195 §122.72 each player named once: the one the offer is about in the opening line (with
  // everything about them), the rest in the deal line, which leaves out whoever the opening named.
  const cashK = offer.cashK || 0;
  const refOf = (p, keep, impact) => Negotiation.playerRef(state, p, { hand: true, impact, keep });
  const keepUs = (p) => (!offer.retain?.[p.id] ? '' : ins.includes(p)
    ? `${teamName} keep paying ${Math.round(offer.retain[p.id] * 100)}% of the salary this season`
    : `we'd keep paying ${Math.round(offer.retain[p.id] * 100)}% of the salary this season`);

  // Payroll against the owner's target: only what this deal changes.
  const payrollNote = evaluation.overTarget && evaluation.payrollDelta > 100
    ? (evaluation.newPayroll - evaluation.payrollDelta > (Finance.seasonTarget(state.userTeam.finances) || 22000)
        ? ` It adds ${formatK(evaluation.payrollDelta)} to a payroll already over ownership's target.`
        : " This would push payroll over ownership's target.")
    : evaluation.payrollDelta > 500
    ? ` It adds ${formatK(evaluation.payrollDelta)} to the payroll.`
    : evaluation.payrollDelta < -500
    ? ` It takes ${formatK(-evaluation.payrollDelta)} off the payroll.`
    : '';

  // The player the offer is about: ours they want, or theirs they offer.
  const target = kind === 'call' ? outs[0] : incoming;
  const when0 = atMs ?? clockNow();
  const direct = !intro && _offerVoiceDirect(`${proposingTeamId}:${when0}:${kind}`);
  const own = direct ? _directOffer({ kind, need, seed, key: `${proposingTeamId}:${when0}`, ins, outs, cashK, retain: offer.retain,
                                      refOf: (p, keep) => refOf(p, keep, false) }) : null;
  const who = target ? refOf(target, keepUs(target), true) : '';
  const lead = typeof intro === 'function' ? intro(who) : intro || (kind === 'sale' ? '' : _offerIntro(kind, { team: teamName, ours: who, theirs: who, need, seed }));
  const read = _offerRead(state, kind, offer, room);
  const opts = { impact: true, hand: true, known: new Set([...Negotiation.namedIn(state, offer, lead)].filter(id => id === target?.id)) };
  const deal = kind === 'sale'
    ? `${teamName} need to move salary and will sell ${_and(ins.map(p => refOf(p, keepUs(p), true)))} to us outright, for ${formatK(-cashK)}.`
    : Negotiation.dealSentence(state, offer, teamName, 'The deal', opts);
  const when = atMs ?? clockNow();

  const instance = _rosterCard(state, {
    cardId:          `trade_${proposingTeamId}`,
    type:            'normal',
    tag:             'TRADE',
    sender:          direct ? `${teamName} front office` : 'Scouting',
    avatar:          '📞',
    _voice:          direct ? 'club' : 'scouting',
    subject:         subject || own?.subject || (kind === 'call' ? `${teamName} want ${target?.name}`
                              : kind === 'sale' ? `${teamName} will sell ${incoming.name}`
                              : `${teamName} are offering ${target?.name}`),
    preview:         kind === 'sale' ? `${incoming.name} for ${formatK(-cashK)}.`
                                     : `${_and(ins.map(p => p.name))} for ${_and(outs.map(p => p.name))}.`,
    body:            own ? own.body
                         : `${lead ? lead + ' ' : ''}${deal} ${read}${payrollNote} We can take it, turn it down, or counter.`,
    yesLabel:        'Accept the Trade',
    noLabel:         'Decline',
    autoResolve:     'roster',
    expiresAtMs:     seed ? when + 3 * 86_400_000 : (atMs != null ? atMs + 2 * 86_400_000 : null),
    _expiresAfterMs: atMs == null && !seed ? 2 * 86_400_000 : null,
    _tradeOffer:     offer,
    _tradeKind:      kind,
    // How the offer stood for each side when it was made (the harness reads it).
    _opening:        { ourNet: Math.round(evaluateForUser(offer, state).net), theirNet: Math.round(evaluateForClub(offer, state, proposingTeamId).net), bar: clubBar(state, proposingTeamId), openBy },
    // A frozen summary of the offer as proposed — never live player objects
    // (those keep changing; the card must describe the deal it offered).
    _tradeEval:      _evalSnapshot(evaluation),
    _proposingTeamId: proposingTeamId,
    _rosterKey:      `trade:${proposingTeamId}:${when}`,
    // Counter from the composer: their offer was the talk's first round.
    _reviseOffer:    { teamId: proposingTeamId, offer, round: 2 },
    _reviseLabel:    'Counter',
    _raw:            { onYes: 'trade_execute', onNo: 'trade_decline', onAuto: 'trade_decline' },
    ...(seed ? { _seed: true } : {}),
  });

  if (seed) {
    // New-franchise seed: visible immediately, never pushed.
    StateManager.mutate(s => {
      toInbox(s, [instance], () => when, VIA.TRADE_SEED);   // r291 §122.172
    });
    return instance;
  }
  if (atMs != null) return _deliverAt(instance, atMs);
  _scheduleCards([instance], state);
  return instance;
}


function _evalSnapshot(ev) {
  const slim = (p) => ({ id: p.id, name: p.name, pos: p.pos, ovr: p.ovr, hand: p.hand || null,
                         teamId: p.teamId, _previouslyWithOrg: !!p._previouslyWithOrg });
  return {
    fairnessRating:  ev.fairnessRating,
    fairnessLabel:   ev.fairnessLabel,
    payrollDelta:    ev.payrollDelta,
    overTarget:      !!ev.overTarget,
    incomingPlayers: (ev.incomingPlayers || []).map(slim),
    outgoingPlayers: (ev.outgoingPlayers || []).map(slim),
  };
}


// ─────────────────────────────────────────────────────────────
// TRADE TALKS (§85 Phase 4b) — the other GM's answer, and our decision
// ─────────────────────────────────────────────────────────────

const _TALK_REASON = {
  value:    'it isn\'t enough for them',
  lowball:  'they didn\'t think it was a serious offer',
  fizzled:  'the two sides couldn\'t meet after a few rounds',
  nothing:  'nothing we could add would get it done right now',
};


/**
 * deliverTalkReply(teamId, response, atMs) — the other club's answer to our
 * offer, as a card with a real decision (§85 F).
 */
/** §85 our revised offer replaces the talk's open cards with that club. */
export function withdrawTalkCards(teamId) {
  // §91 their own offer to us too: our counter answers it.
  return _withdraw(c => c._talkTeamId === teamId || c._ideaTeamId === teamId || (c._tradeOffer && c._proposingTeamId === teamId));
}


export function deliverTalkReply(teamId, r, atMs) {
  const state = StateManager.get();
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  const talk = Negotiation.talkWith(state, teamId);
  if (!team || !talk) return null;
  const name = team.name;
  const grade = rapportGrade(rapportOf(state, teamId));
  const key = `talk:${teamId}:${talk.id}:${r.decision}:${talk.round}`;
  const base = { tag: 'TRADE', sender: 'Scouting', avatar: '📞', _talkTeamId: teamId, _talkId: talk.id, _talkRound: talk.round, _rosterKey: key };
  if (r.decision === 'accept') {
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_accepted', type: 'good', _dealOffer: { teamId, offer: talk.offer },   // r198 the deal table
      subject: `${name} accepted our offer`,
      preview: `They'll do it: ${Negotiation.describeOffer(state, talk.offer, name)}.`,
      body: `${name} called back: they'll do the deal — ${Negotiation.describeOffer(state, talk.offer, name)}. `
          + `It's ours to finalize. Backing out now would cost us with their front office (rapport: ${grade}).`,
      yesLabel: 'Finalize the Deal', noLabel: 'Back Out',
      autoResolve: 'roster', expiresAtMs: atMs + 24 * 3600_000,
      _raw: { onYes: 'talk_finalize', onNo: 'talk_backout', onAuto: 'talk_finalize' } }), atMs);
  }
  if (r.decision === 'counter') {
    const counter = r.counter || talk.counter;
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_counter', type: 'normal',
      subject: `${name} came back with a counter`,
      preview: `Their counter: ${Negotiation.describeOffer(state, counter, name)}.`,
      body: `${name} won't do it as offered, but they're interested. Their counter: ${Negotiation.describeOffer(state, counter, name)}. `
          + `We can take it, walk away, or send a revised offer.`,
      yesLabel: 'Take Their Counter', noLabel: 'Walk Away',
      autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
      _reviseOffer: { teamId, offer: counter, round: (talk.round || 1) + 1 },
      _raw: { onYes: 'talk_take_counter', onNo: 'talk_walk', onAuto: 'talk_walk' } }), atMs);
  }
  const why = _TALK_REASON[r.reason] || r.reason || _TALK_REASON.value;
  if (r.reason === 'fizzled' || r.reason === 'nothing') {
    return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_fizzled', type: 'normal',
      subject: `Talks with ${name} have run their course`,
      preview: `No deal — ${why}.`,
      body: `No deal with ${name}: ${why}. We can tell them to keep us in mind if things change — it keeps the relationship warm — or simply move on.`,
      yesLabel: 'Keep the Door Open', noLabel: 'Move On',
      autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
      _raw: { onYes: 'talk_keep_open', onNo: 'talk_move_on', onAuto: 'talk_move_on' } }), atMs);
  }
  return _deliverAt(_rosterCard(state, { ...base, cardId: 'talk_passed', type: 'normal',
    subject: `${name} passed on our offer`,
    preview: `They said no — ${why}.`,
    body: `${name} passed: ${why}. We can ask what it would take to get something done, or move on.`
        + (r.reason === 'lowball' ? ' They weren\'t pleased with the offer.' : ''),
    yesLabel: 'Ask What It Would Take', noLabel: 'Move On',
    autoResolve: 'roster', expiresAtMs: atMs + 36 * 3600_000,
    _raw: { onYes: 'talk_ask', onNo: 'talk_move_on', onAuto: 'talk_move_on' } }), atMs);
}


export function _applyTalkAction(action, instance, atMs) {
  const teamId = instance._talkTeamId;
  if (!teamId) return;
  // A card only speaks for the round of talks it was written in (a revised
  // offer since then has moved the talk on).
  const talk = Negotiation.talkWith(StateManager.get(), teamId);
  if (!talk || talk.id !== instance._talkId || talk.round !== instance._talkRound) return;
  Negotiation.settle(teamId);   // their answer has reached us
  // r202 §122.79 the same answer on another card (their yes, and the director's reply about it): one decision.
  _withdraw(c => c.instanceId !== instance.instanceId && c._talkTeamId === teamId && c._talkId === instance._talkId && c._talkRound === instance._talkRound);
  const map = { talk_finalize: 'finalize', talk_backout: 'backout', talk_take_counter: 'take_counter',
                talk_walk: 'walk', talk_ask: 'ask', talk_move_on: 'move_on' };
  if (action === 'talk_keep_open') {
    StateManager.mutate(s => { TradeRapportBump(s, teamId); });
    Negotiation.act(teamId, 'move_on', atMs);
    return;
  }
  const res = Negotiation.act(teamId, map[action], atMs);
  if (res && res.ok === false && res.reason) {
    _deliverNotice(`talk:off:${instance.instanceId}`, {
      cardId: 'trade_off', tag: 'TRADE', sender: 'Scouting', avatar: '📞', type: 'normal',
      subject: 'The deal can\'t go through',
      preview: `The deal is off: ${res.reason}.`,
      body: `We went to finalize it, but the deal is off: ${res.reason}.`,
      yesLabel: 'Understood', expiresAtMs: atMs + 2 * 86_400_000,
    }, atMs);
  }
}
