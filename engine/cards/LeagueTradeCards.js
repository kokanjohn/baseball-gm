/**
 * engine/cards/LeagueTradeCards.js
 * CardEngine, league trades that touch us (§90), the winter meetings (§112.5), "nobody fits" (§99).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PHASE, TRADE, ADVANCE_SCOUT, LEAGUE_TRADES, CARD_MONEY_BASE_TARGET_K } from '../../data/constants.js';
import { tradeWindow, wouldStart, clubMode, isRental } from '../TradeEngine.js';
import { formatK } from '../CardTokens.js';
import * as Offseason from '../OffseasonEngine.js';
import * as Finance from '../FinanceEngine.js';
import { baseballYear, computeAge } from '../PlayerFactory.js';
import * as Negotiation from '../Negotiation.js';
import * as LeagueTrades from '../LeagueTrades.js';
import { buildActivityFeedEntry, pruneActivityFeed } from '../SeasonEngine.js';
import { eventRand } from '../Dice.js';
import { primaryPos, coversRole, posLabel } from '../Positions.js';
import { _cardsWithKey, _deliverAt, _rosterCard } from './Delivery.js';
import { _deliverNotice } from './RosterCards.js';
import { withdrawTalkCards } from './TradeOffers.js';
import { _salaryCallOffer } from './WeatherCards.js';

// ─────────────────────────────────────────────────────────────
// LEAGUE TRADES THAT TOUCH US (§90 Phase 4c)
// ─────────────────────────────────────────────────────────────
//
// A trade between two other clubs reaches us through the League wire and the
// Recent strip. An inbox card comes only when it touches us, and always with
// a decision (§85 J): someone beat us to a player we were talking about (the
// next-best option), a player we traded away was flipped (bring them back
// once they can be moved), a division rival got better (advance scouting), a
// club just sold (call them), a club now has a surplus (make an offer).

const _IDEA_GAP_MS = 3 * 86_400_000;
     // at most one "opportunity" card (sold / surplus) every few days

/** One player's short reference: name (POS, OVR n). */
export const _ref = (p) => `${p.name} (${posLabel(p)}, OVR ${p.ovr})`;

/** r195 the player a Pro Scouting offer is about, introduced once with everything (Impact too): the deal line won't name them again. */
export const _dealRef = (st, p) => Negotiation.playerRef(st, p, { impact: true });


/** Same role: a pitcher of the same kind, or a hitter who can play the spot. */
export function _sameRole(p, target) {
  if (!p || !target) return false;
  if (['SP', 'RP'].includes(target.pos)) return p.pos === target.pos;
  return !['SP', 'RP'].includes(p.pos) && coversRole(p, target);   // r163 Positions
}


/**
 * An offer Pro Scouting put together, as a decision: send it as our offer
 * (their GM's answer comes on the clock), adjust it in the composer first,
 * or pass.
 */
export function _deliverIdea(st, { key, teamId, deal, subject, preview, lead, after = '', atMs, sender = 'Scouting', extra = {} }) {
  const team = (st.leagueTeams || []).find(t => t.id === teamId);
  if (!team || !deal) return null;
  const offer = LeagueTrades.userOffer(deal);
  // r195 §122.72 the player the opening line introduced (theirs, with _dealRef) isn't named again.
  const known = new Set([...Negotiation.namedIn(st, offer, lead)].filter(id => (offer.incomingIds || []).includes(id)));
  const what = Negotiation.dealSentence(st, offer, team.name, 'Our package', { impact: true, known });
  return _deliverAt(_rosterCard(st, {
    cardId: 'lt_offer', tag: 'TRADE', sender, avatar: '📞', type: 'normal',
    subject, preview,
    body: `${lead} ${what} ${after ? `${after} ` : ''}`
        + `We can make the offer as it stands — ${team.name} answers on their own clock — adjust it first, or pass.`,
    yesLabel: 'Make the Offer', noLabel: 'Pass',
    autoResolve: 'roster', expiresAtMs: atMs + 2 * 86_400_000,
    _rosterKey: key, _ideaTeamId: teamId, _ideaOffer: offer,
    _reviseOffer: { teamId, offer, round: null },
    _raw: { onYes: 'lt_offer_send', onNo: 'lt_pass', onAuto: 'lt_pass' },
    ...extra,
  }), atMs);
}


/** Our next series against a club this season: when its last game is. */
function _nextSeriesEnd(st, teamId, atMs) {
  const games = (st.schedule || []).filter(g => g.opponentId === teamId && !g._committed && !g.isSpring && !g.isPlayoff
    && (g.gameTime || 0) > atMs).sort((a, b) => a.gameTime - b.gameTime);
  if (!games.length) return null;
  const first = games[0];
  const series = first.seriesId ? games.filter(g => g.seriesId === first.seriesId) : [first];
  return { firstAt: first.gameTime, endAt: series[series.length - 1].gameTime, games: series.length };
}


export function _leagueTradeCards(tx, atMs) {
  const st = StateManager.get();
  const club = (id) => (st.leagueTeams || []).find(t => t.id === id);
  const A = club(tx.teamId), B = club(tx.fromTeamId);
  if (!A || !B) return 0;
  const P = (id) => st.players[id];
  const aGot = (tx.offer?.incomingIds || []).map(P).filter(Boolean);   // B → A
  const bGot = (tx.offer?.outgoingIds || []).map(P).filter(Boolean);   // A → B
  const year = baseballYear(st);
  const desk = st.tradeDesk || {};

  // 1. Someone beat us to a player we were talking about.
  for (const [seller, left, to] of [[B, aGot, A], [A, bGot, B]]) {
    const talk = Negotiation.talkWith(st, seller.id);
    if (!talk || !['waiting', 'countered', 'agreed'].includes(talk.status)) continue;
    const want = [...(talk.offer?.incomingIds || []), ...(talk.counter?.incomingIds || [])];
    const gone = left.find(p => want.includes(p.id));
    if (!gone) continue;
    withdrawTalkCards(seller.id);
    Negotiation.callOff(seller.id, atMs);
    const next = LeagueTrades.bestOption(StateManager.get(), (p) => _sameRole(p, gone), atMs, { excludeIds: new Set([gone.id]) });
    const lead = `${seller.name} traded ${_ref(gone)} to ${to.name} before our talks could finish — those talks are closed.`;
    if (next) {
      const nt = club(next.teamId), np = P(next.playerId);
      return _deliverIdea(StateManager.get(), {
        key: `lt:beaten:${tx.id}`, teamId: next.teamId, deal: next.deal, atMs: atMs + 2 * 3600_000,
        subject: `${to.name} beat us to ${gone.name}`,
        preview: `The next-best option: ${_ref(np)} of ${nt.name}.`,
        lead: `${lead} The next-best option we see is ${_dealRef(StateManager.get(), np)} of ${nt.name}.`,
        extra: { _beatenTalkId: talk.id },
      }) ? 1 : 0;
    }
    return _deliverWatchCard(`lt:beaten:${tx.id}`, {
      cardId: 'lt_beaten',
      subject: `${to.name} beat us to ${gone.name}`,
      preview: 'Nobody else fits the spot right now.',
      body: `${lead} We looked for the next-best option and nobody else fits the spot right now.`,
      spec: { type: 'role', pos: gone.pos, nativePos: posLabel(gone), primary: primaryPos(gone), excludeId: gone.id },
      what: `someone to fill ${gone.name}'s role`,
      atMs: atMs + 2 * 3600_000, extra: { _beatenTalkId: talk.id },
    }) ? 1 : 0;
  }

  // 2. A player we traded away was flipped: bring them back once they can be moved.
  const flipped = [...aGot, ...bGot].find(p => p._previouslyWithOrg && wouldStart(p, st, 'user'));
  if (flipped) {
    const now = aGot.includes(flipped) ? A : B, from = now === A ? B : A;
    const when = atMs + TRADE.noFlipMs + 3 * 3600_000;
    const deal = LeagueTrades.scoutPackage(st, now.id, flipped.id, when);
    if (deal) return _deliverIdea(st, {
      key: `lt:flipped:${tx.id}`, teamId: now.id, deal, atMs: when,
      subject: `${flipped.name} can be moved again`,
      preview: `${from.name} sent our former player to ${now.name}; a reunion is possible.`,
      lead: `${from.name} traded ${_dealRef(st, flipped)}, who played for us, to ${now.name}. A newly acquired player can't be moved for a few days; that window has passed, and there's a starting job here.`,
    }) ? 1 : 0;
  }

  // 3. A division rival got better: advance scouting for our next series.
  const rival = [A, B].find(t => t.divisionId && t.divisionId === (st.userTeam.divisionId || 'A')
    && tx.why?.need && t.id === tx.teamId);
  if (rival) {
    const series = _nextSeriesEnd(st, rival.id, atMs);
    const star = aGot.sort((x, y) => (y.ovr || 0) - (x.ovr || 0))[0];
    if (series && star && !_cardsWithKey(st, `lt:rival:${rival.id}:${series.firstAt}`).length
        && atMs - (desk.lastRivalMs || -Infinity) >= LEAGUE_TRADES.rivalCardGapMs
        && (star.ovr || 0) >= LeagueTrades.leagueNorms(st).h + 3
        && (st.phase === PHASE.REGULAR_SEASON || st.phase === PHASE.TRADE_DEADLINE || st.phase === PHASE.ALL_STAR_BREAK)) {
      const scale = Math.max(0.5, Math.min(1.6, (st.userTeam.finances?.payrollTarget || CARD_MONEY_BASE_TARGET_K) / CARD_MONEY_BASE_TARGET_K));
      const cost = Math.max(10, Math.round(ADVANCE_SCOUT.costK * scale / 5) * 5);
      StateManager.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), lastRivalMs: atMs }; });
      return _deliverAt(_rosterCard(st, {
        cardId: 'lt_scout', tag: 'SCOUTING', sender: 'Scouting', avatar: '🔎', type: 'normal',
        subject: `${rival.name} got better`,
        preview: `${rival.name} added ${_ref(star)} from ${B.name}. We see them next in ${Math.max(1, Math.round((series.firstAt - atMs) / 86_400_000))} days.`,
        body: `${rival.name}, in our division, traded for ${_ref(star)} from ${B.name}. `
            + `We play them next in a ${series.games}-game series. An advance scout can follow them until then (${formatK(cost)}): `
            + `our hitters would know what's coming and our pitchers how to work their lineup, for that series.`,
        yesLabel: `Send an Advance Scout (${formatK(cost)})`, noLabel: 'Not This Time',
        autoResolve: 'roster', expiresAtMs: Math.min(series.firstAt, atMs + 2 * 86_400_000),
        _rosterKey: `lt:rival:${rival.id}:${series.firstAt}`,   // one report offer per series
        _ltTeamId: rival.id, _ltCoversMs: series.endAt + 6 * 3600_000, _ltCostK: cost,
        _raw: { onYes: 'lt_scout', onNo: 'lt_pass', onAuto: 'lt_pass' },
      }), atMs + 3 * 3600_000) ? 1 : 0;
    }
  }

  // Opportunities: at most one every few days.
  if (atMs - (desk.lastIdeaMs || -Infinity) < _IDEA_GAP_MS) return 0;
  const markIdea = () => StateManager.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), lastIdeaMs: atMs }; });

  // 4. A club just sold: call them about the veterans still there.
  if (clubMode(st, B.id) === 'seller' && aGot.some(p => computeAge(p.dob, year) >= 30 || isRental(p, st))) {
    const vet = (p) => computeAge(p.dob, year) >= 29 || isRental(p, st);
    const opt = LeagueTrades.bestOption(st, vet, atMs, { excludeTeams: new Set((st.leagueTeams || []).filter(t => t.id !== B.id).map(t => t.id)) });
    if (opt) {
      const p = P(opt.playerId);
      if (_deliverIdea(st, {
        key: `lt:sold:${tx.id}`, teamId: B.id, deal: opt.deal, atMs: atMs + 3 * 3600_000,
        subject: `${B.name} are selling`,
        preview: `They just moved ${aGot[0].name}. ${_ref(p)} is still there.`,
        lead: `${B.name} just traded ${aGot.map(_ref).join(' and ')} to ${A.name} for younger pieces — they're selling. ${_dealRef(st, p)} is still there and would start for us.`,
      })) { markIdea(); return 1; }
    }
  }

  // 5. A club now has a surplus: the starter it just replaced.
  const was = tx.why?.need?.incumbentId && P(tx.why.need.incumbentId);
  if (was && !bGot.includes(was) && (A.rosterIds || []).includes(was.id) && wouldStart(was, st, 'user')) {
    const deal = LeagueTrades.scoutPackage(st, A.id, was.id, atMs);
    if (deal && _deliverIdea(st, {
      key: `lt:surplus:${tx.id}`, teamId: A.id, deal, atMs: atMs + 3 * 3600_000,
      subject: `${A.name} have a player to spare`,
      preview: `${aGot[0].name} takes over for ${was.name}, who would start for us.`,
      lead: `${A.name} traded for ${aGot.map(_ref).join(' and ')}, which leaves ${_dealRef(st, was)} without a regular spot there, and with a starting one waiting here.`,
    })) { markIdea(); return 1; }
  }
  return 0;
}


/**
 * §90 Pro Scouting works the phones for one of our needs: the best player on
 * another club who fills it and would start for us, with the package their
 * GM should take — an offer to make, adjust or pass on, a few hours later.
 */
function _workThePhones({ key, spec, what, atMs, sender = 'Scouting', subjectNone }) {
  const st = StateManager.get();
  const at = atMs + Math.round((3 + eventRand() * 4) * 3600_000);
  const opt = LeagueTrades.bestOption(st, _fitsFor(spec, st), at, { excludeIds: new Set(spec.excludeId ? [spec.excludeId] : []) });
  if (!opt) {
    return _deliverWatchCard(`${key}:none`, {
      cardId: 'lt_none', sender,
      subject: subjectNone || 'Nothing out there right now',
      preview: `We worked the phones for ${what}; nothing fits.`,
      body: `We worked the phones for ${what}. Nobody available would be an upgrade at a price their club would take and our owner would carry.`,
      spec, what: what.replace(/ before the deadline$/, ''), atMs: at,
    });
  }
  const t = (st.leagueTeams || []).find(x => x.id === opt.teamId), p = st.players[opt.playerId];
  return _deliverIdea(st, {
    key, teamId: opt.teamId, deal: opt.deal, atMs: at, sender,
    subject: `${what[0].toUpperCase()}${what.slice(1)}: ${p.name}`,
    preview: `${_ref(p)} of ${t.name} is the best fit we found.`,
    lead: `We worked the phones for ${what}. The best fit is ${_dealRef(st, p)} of ${t.name}${isRental(p, st) ? ', in the last year of the contract' : ''}.`,
  });
}


// ── §112.5 The winter meetings: Pro Scouting's targets for the winter's priority ──

const _needKey = (n) => (n?.kind === 'slot' ? `slot:${n.slot}` : n?.kind);


/**
 * Where the winter's priority stands now (free agency may already have filled
 * it): the spot as the roster has it today. Returns { need (today's), filled }.
 */
export function priorityNow(st, pri) {
  if (!pri) return null;
  const now = LeagueTrades.clubNeeds(st, 'user', LeagueTrades.leagueNorms(st), { all: true }).find(n => _needKey(n) === _needKey(pri));
  if (!now) return { need: pri, filled: true };
  return { need: { ...pri, incumbentId: now.incumbentId, ovr: now.ovr }, filled: (now.ovr || 0) >= (pri.ovr || 0) + LEAGUE_TRADES.upgradeMin };
}


/**
 * deliverMeetingsTargets(atMs) — §112.5 day 6: Pro Scouting's best two trade
 * targets for the winter's priority (the other need, when free agency already
 * filled it), each an offer to make, adjust or pass on, with the best free
 * agent who'd fill the same spot for comparison. Nothing fits: a watch card.
 */
export function deliverMeetingsTargets(atMs) {
  const st = StateManager.get();
  const R = st.offseason?.review;
  if (!R) return 0;
  const pri = st.offseason.priority || R.needs?.[0];
  const order = [pri, ...(R.needs || []).filter(n => _needKey(n) !== _needKey(pri))].filter(Boolean);
  let target = null, filledFirst = null;
  for (const n of order) {
    const now = priorityNow(st, n);
    if (now && !now.filled) { target = now.need; break; }
    if (!filledFirst) filledFirst = n;
  }
  if (!target) {
    StateManager.mutate(s => {
      s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('trade', s.userTeam.abbr,
        `Winter meetings: the holes the scouts were asked to fill are filled. Nothing to chase.`, atMs)]);
    });
    return 0;
  }
  const words = target.short || 'the roster';
  const inc = st.players[target.incumbentId];
  const fits = (p) => LeagueTrades.fillsNeed(p, target) && (p.ovr || 0) >= (target.ovr || 0) + LEAGUE_TRADES.upgradeMin;
  // The free-agent alternative, for comparison.
  const fa = Offseason.freeAgents(st, 'user').filter(fits).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  const faAsk = fa ? (fa._ask || Offseason.marketTerms(st, fa)).salary : 0;
  const faLine = fa ? `On the free-agent market, the best fit is ${_ref(fa)}, asking ${formatK(faAsk)} a year: no players out, but money on the books`
                      + `${Finance.canAddSalary(st, faAsk) ? '.' : ', more than ownership would approve right now.'}`
                    : 'Nobody on the free-agent market fills it.';
  const why = filledFirst && _needKey(filledFirst) !== _needKey(target)
    ? `Free agency took care of ${filledFirst.short}, so we went to work on ${words}.`
    : `${_needKey(target) === _needKey(st.offseason.priority) ? 'Your priority this winter' : 'The biggest hole'} is ${words}${inc ? `, where ${_ref(inc)} is the best we have` : ''}.`;
  const used = new Set(), deliveredIds = [];
  let n = 0;
  for (let i = 0; i < 2; i++) {
    const cur = StateManager.get();
    const at = atMs + (40 + i * 75 + Math.floor(eventRand() * 30)) * 60_000;
    const opt = LeagueTrades.bestOption(cur, fits, at, { excludeTeams: used });
    if (!opt) break;
    used.add(opt.teamId);
    const t = (cur.leagueTeams || []).find(x => x.id === opt.teamId), p = cur.players[opt.playerId];
    const c = _deliverIdea(cur, {
      key: `os:meet:${cur.seasonNum}:${i}`, teamId: opt.teamId, deal: opt.deal, atMs: at, sender: 'Scouting',
      subject: `Winter meetings: ${p.name} for ${words}`,
      preview: `${_ref(p)} of ${t.name}${i ? ', the second option' : ' is the best fit we found'}.`,
      lead: `${why} We talked to every club here. ${i ? 'The second-best option' : 'The best fit'}: ${_dealRef(cur, p)} of ${t.name}${isRental(p, cur) ? ', in the last year of the contract' : ''}.`,
      after: faLine, extra: { _meetings: true },
    });
    if (c) { n++; deliveredIds.push(p.id); }
  }
  if (!n) {
    return _deliverWatchCard(`os:meet:${st.seasonNum}:none`, {
      subject: `Winter meetings: nothing for ${words}`,
      preview: `We talked to every club about ${words}; nobody fits at a price that works.`,
      body: `${why} We talked to every club here. Nobody who'd start for us is available at a price their club would take and our owner would carry. ${faLine}`,
      spec: { type: 'need', need: { kind: target.kind, slot: target.slot || null, incumbentId: target.incumbentId, ovr: target.ovr }, minOvr: (target.ovr || 0) + LEAGUE_TRADES.upgradeMin },
      what: words, atMs: atMs + 60 * 60_000, extra: { _meetings: true },
    }) ? 1 : 0;
  }
  return n;
}


// ── §99 "nobody fits right now": keep watching, or drop it ──────────────

const WATCH_DAYS = 14;


/** What a search is for, kept as data (it waits in state between days). */
function _fitsFor(spec, st) {
  if (!spec) return () => false;
  if (spec.type === 'need') return (p) => LeagueTrades.fillsNeed(p, spec.need) && (p.ovr || 0) >= (spec.minOvr || 0);
  if (spec.type === 'rp')   return (p) => p.pos === 'RP' && wouldStart(p, st, 'user');
  // (r163 the role as it stood: its primary position — an older search reads its label)
  if (spec.type === 'role') return (p) => p.id !== spec.excludeId && _sameRole(p, { pos: spec.pos, nativePos: spec.nativePos, ...(spec.primary ? { positions: { primary: spec.primary, elig: [spec.primary], roles: [spec.primary] } } : {}) });
  return () => false;
}


/**
 * A search that came up empty, as a decision: Pro Scouting keeps watching
 * (checks at every day's trade desk for two weeks and calls with the first
 * fit), or we drop it. Unanswered, it's dropped.
 */
export function _deliverWatchCard(key, { subject, preview, body, spec, what, atMs, cardId = 'lt_none', sender = 'Scouting', extra = {} }) {
  const st = StateManager.get();
  if (_cardsWithKey(st, key).length) return null;
  return _deliverAt(_rosterCard(st, {
    cardId, tag: 'TRADE', sender, avatar: '📞', type: 'normal',
    subject, preview,
    body: `${body} We can keep watching — checking every day for the next two weeks and calling as soon as someone fits — or drop it.`,
    yesLabel: 'Keep Watching', noLabel: 'Drop It',
    autoResolve: 'roster', expiresAtMs: atMs + 2 * 86_400_000,
    _rosterKey: key, _watch: { spec, what },
    _raw: { onYes: 'lt_watch', onNo: 'lt_pass', onAuto: 'lt_pass' },
    _autoLabel: 'No answer — dropped',
    ...extra,
  }), atMs);
}


/**
 * runWatches(atMs) — §99 at each day's trade desk, every search Pro Scouting
 * is keeping an eye on: the first fit becomes an offer card and ends the
 * watch; two weeks without one (or the window closing) ends it with a line
 * in Recent.
 */
export function runWatches(atMs) {
  const st = StateManager.get();
  const watches = st.tradeDesk?.watches || [];
  if (!watches.length) return 0;
  const keep = [], ended = [];
  let found = 0;
  for (const w of watches) {
    const cur = StateManager.get();
    if (w.untilMs <= atMs || !tradeWindow(cur).open) { ended.push(w); continue; }
    let hit = false;
    if (w.spec?.type === 'club') {
      const team = (cur.leagueTeams || []).find(t => t.id === w.spec.teamId);
      hit = !!team && _salaryCallOffer(cur, team, atMs, { intro: `${team.name} called back: their owner still wants payroll gone, and now there's a deal that works for both sides.` });
    } else {
      const opt = LeagueTrades.bestOption(cur, _fitsFor(w.spec, cur), atMs, { excludeIds: new Set(w.spec?.excludeId ? [w.spec.excludeId] : []) });
      if (opt) {
        const t = (cur.leagueTeams || []).find(x => x.id === opt.teamId), p = cur.players[opt.playerId];
        hit = !!_deliverIdea(cur, {
          key: `${w.key}:found`, teamId: opt.teamId, deal: opt.deal, atMs: atMs + Math.round((1 + eventRand() * 3) * 3600_000), sender: w.sender || 'Scouting',
          subject: `Found: ${p.name}`,
          preview: `${_ref(p)} of ${t.name} — the fit we've been watching for.`,
          lead: `We've been watching for ${w.what}. ${_dealRef(cur, p)} of ${t.name} now fits${isRental(p, cur) ? ', in the last year of the contract' : ''}.`,
        });
      }
    }
    if (hit) found++; else keep.push(w);
  }
  StateManager.mutate(s => {
    s.tradeDesk = { ...(s.tradeDesk || {}), watches: keep };
    if (ended.length) s.activityFeed = pruneActivityFeed([...(s.activityFeed || []),
      ...ended.map(w => buildActivityFeedEntry('milestone', s.userTeam.abbr, `The scouts stopped watching for ${w.what} — nobody fit`, atMs))]);
  });
  return found;
}


/**
 * deliverDeadlineIdea(atMs) — §90 (replaces the dl3/dl4 cards): as the
 * deadline nears, Pro Scouting's best target for our biggest need, once a
 * season, when we're not selling.
 */
export function deliverDeadlineIdea(atMs) {
  const st = StateManager.get();
  const key = `lt:deadline:${st.seasonNum || 1}`;
  if (_cardsWithKey(st, key).length || _cardsWithKey(st, `${key}:none`).length) return null;
  if (clubMode(st, 'user') === 'seller') return null;
  const need = LeagueTrades.clubNeeds(st, 'user')[0];
  if (!need) return null;
  const what = need.kind === 'sp' ? 'a starting pitcher before the deadline'
    : need.kind === 'rp' ? 'a reliever before the deadline'
    : `a ${need.slot === 'DH' ? 'designated hitter' : need.slot} before the deadline`;
  return _workThePhones({ key, what, atMs, spec: { type: 'need', need: { kind: need.kind, slot: need.slot || null }, minOvr: need.ovr + 3 } });
}


export function _applyLeagueTradeAction(action, instance, atMs) {
  if (action === 'lt_pass') return;
  if (action === 'lt_find_rp') {
    _workThePhones({ key: `lt:rp:${instance.instanceId}`, what: 'a reliever', atMs, spec: { type: 'rp' } });
    return;
  }
  if (action === 'lt_watch') {
    // §99 Pro Scouting keeps watching: checked at each day's trade desk.
    const w = instance._watch;
    if (!w) return;
    StateManager.mutate(s => {
      s.tradeDesk = { ...(s.tradeDesk || {}) };
      s.tradeDesk.watches = [...(s.tradeDesk.watches || []).filter(x => x.key !== instance._rosterKey),
        { key: instance._rosterKey, spec: w.spec, what: w.what, sender: instance.sender, startedAtMs: atMs, untilMs: atMs + WATCH_DAYS * 86_400_000 }];
    });
    return;
  }
  if (action === 'lt_offer_send') {
    const res = Negotiation.proposeTrade(instance._ideaTeamId, instance._ideaOffer, atMs, { round: instance._ideaRound ?? null });
    if (!res.ok) {
      _deliverNotice(`lt:unsent:${instance.instanceId}`, {
        cardId: 'lt_unsent', tag: 'TRADE', sender: 'Scouting', avatar: '📞',
        subject: 'The offer couldn\'t go out',
        preview: `It couldn't be sent: ${res.reason}.`,
        body: `We went to make the offer, but it couldn't be sent: ${res.reason}.`,
      }, atMs);
    }
    return;
  }
  if (action === 'lt_scout') {
    const cost = instance._ltCostK || 0;
    if (!Finance.canSpend(StateManager.get(), cost)) {
      _deliverNotice(`lt:noscout:${instance.instanceId}`, {
        cardId: 'lt_noscout', tag: 'SCOUTING', sender: 'Scouting', avatar: '🔎',
        subject: 'No advance scout this time', preview: 'Club funds can\'t cover the trip.',
        body: 'Club funds can\'t cover the advance scout\'s trip right now.',
      }, atMs);
      return;
    }
    StateManager.mutate(s => {
      Finance.post(s.userTeam.finances, -cost, 'cards', `Advance scouting — ${(s.leagueTeams || []).find(t => t.id === instance._ltTeamId)?.name || 'a rival'}`, atMs);
      s.userTeam.advanceReports = { ...(s.userTeam.advanceReports || {}),
        [instance._ltTeamId]: { coversThroughMs: instance._ltCoversMs, boughtAtMs: atMs } };
    });
  }
}
