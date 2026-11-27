/**
 * engine/cards/OffseasonCards.js
 * CardEngine, offseason cards (§70).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import * as StateManager from '../../store/StateManager.js';
import { PHASE, AGENT_ASK, POSITION_RULES, PLAYER_GROUP, FA_CARD_TTL_DAYS, FA_CARDS_PER_ROUND, OFFSEASON_CARD_HOUR, LEAGUE_POSITIONS } from '../../data/constants.js';
import * as When from '../When.js';
import { reconcileRoster, applyRosterMutation, computePayroll } from '../RosterEngine.js';
import { tradeWindow } from '../TradeEngine.js';
import { formatK } from '../CardTokens.js';
import * as Offseason from '../OffseasonEngine.js';
import * as Coach from '../CoachEngine.js';
import * as Managers from '../ManagerEngine.js';
import * as FrontOffice from '../FrontOffice.js';
import * as Finance from '../FinanceEngine.js';
import { baseballYear, computeAge } from '../PlayerFactory.js';
import { reviewWords } from '../SeasonReview.js';
import * as LeagueTrades from '../LeagueTrades.js';
import * as LeaguePos from '../LeaguePositions.js';
import * as FreeAgency from '../FreeAgency.js';
import { buildActivityFeedEntry, pruneActivityFeed } from '../SeasonEngine.js';
import { clockNow } from '../Clock.js';
import { dice, diceSeed, eventRand, withDice } from '../Dice.js';
import { primaryPos, posLabel, eligibleAt, keepNeed, startsAt } from '../Positions.js';
import { _cardsWithKey, _day, _deliverAt, _hand, _rosterCard } from './Delivery.js';
import { _dealRef, _deliverIdea, _deliverWatchCard, _ref, _sameRole } from './LeagueTradeCards.js';
import { _deliverNotice, _managerName, _ourNews } from './RosterCards.js';

// ─────────────────────────────────────────────────────────────
// OFFSEASON CARDS (§70)
// ─────────────────────────────────────────────────────────────
//
// The offseason's decisions are roster cards on the clock: delivered at a
// real hour of their day, withdrawn when their situation is gone (a free
// agent signs elsewhere), and auto-resolved conservatively at their deadline.
// Hard gates (§23.2 — ownership, expiring contracts, manager) carry `_osGate`
// and are due when spring training opens; free-agent cards are soft (3 days).

export const _who = (p) => `${p.name}${_hand(p)} (${posLabel(p)}, OVR ${p.ovr})`;

const _years = (n) => `${n} year${n === 1 ? '' : 's'}`;


/**
 * Ownership's season review (§78): the record against the target, the books
 * (the season's profit or loss, funds carried into next year, any shortfall
 * the owner covered, any cut orders missed) — and next season's payroll target.
 */
export function deliverOwnershipCard(offer, atMs, expiresAtMs) {
  const state = StateManager.get();
  const owner = state.userTeam.ownerName || 'Ownership';
  const last  = (state.seasonHistory || [])[state.seasonHistory.length - 1] || {};
  const books = (state.userTeam.finances?.history || []).slice(-1)[0] || null;
  const dir   = offer.pct > 0.005 ? 'raise' : offer.pct < -0.005 ? 'trim' : 'hold';
  const net   = books ? books.net : 0;
  const booksLine = books
    ? `The books: ${net >= 0 ? `a profit of ${formatK(net)}` : `a loss of ${formatK(-net)}`} on the season`
      + `${books.covered ? `, and I covered a ${formatK(books.covered)} shortfall to bring funds back to zero` : ''}. `
      + `Club funds going into next season: ${formatK(offer.funds)}. `
    : '';
  const penaltyLine = offer.penaltyPct > 0
    ? `I haven't forgotten the payroll cuts I asked for and didn't get — that's reflected below. ` : '';
  const card = _rosterCard(state, {
    cardId: 'os_ownership', tag: 'OWNERSHIP', sender: owner, avatar: '💼', type: 'urgent',
    _rosterKey: `os:ownership:${state.seasonNum}`, _osGate: 'ownership', _offer: offer,
    subject: "Season review — next year's payroll",
    preview: `${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses}`
           + `${books ? `, ${net >= 0 ? '+' : '−'}${formatK(Math.abs(net))} on the books` : ''}. I want to ${dir} the payroll target.`,
    body: _ownerOpening(state)
        + `We finished ${last.wins ?? state.userTeam.wins}–${last.losses ?? state.userTeam.losses} against a target of ${last.winTarget ?? '—'} wins`
        + `${last.postseason?.result && last.postseason.result !== 'Did not qualify' ? ` (${last.postseason.result.toLowerCase()})` : ''}. `
        + booksLine + penaltyLine
        + `For next season I'm setting a payroll target of ${formatK(offer.payrollTarget)} (was ${formatK(offer.prevPayrollTarget)}). `
        + `Next season's win target: ${offer.winTarget}. You can accept, or push for 4% more — it will cost you some of my trust. `
        + `If I don't have an answer by the time spring training opens, I'll decide — and it will be tighter.`,
    yesLabel: 'Accept the target', noLabel: 'Push for more',
    expiresAtMs,
    _raw: { onYes: 'os_owner_accept', onNo: 'os_owner_push', onAuto: 'os_owner_auto' },
    _autoLabel: 'No answer — ownership set a tighter target',
  });
  return _deliverAt(card, atMs);
}


/** §112 How the owner opens the review: the year the club had, in the owner's words. */
function _ownerOpening(state) {
  const R = state.offseason?.review;
  if (!R) return '';
  const vs = R.vsTarget ?? 0;
  const lines = {
    champion: ['A championship. I don\'t think either of us will forget this one. ', 'Champions. The city hasn\'t stopped celebrating, and neither have I. '],
    pennant:  ['We were one series from a title. That\'s a season to be proud of — and it leaves me hungry. ', 'A pennant. Not the ending we wanted, but this club is close. '],
    playoffs: vs >= 0 ? ['We were a playoff club this year, and we earned it. ', 'October baseball, and the fans felt it. '] : ['We made the playoffs, which matters — but I expected more from this group. '],
    near:     ['A .500 club and a quick exit in October. Middle of the pack isn\'t where I want us. ', 'We were in it, and then we were out early. That stings. '],
    missed:   vs >= 0 ? ['A losing record, but the club did what we asked of it this year. '] : ['This wasn\'t the season we planned for. ', 'We fell short of where this club should be. '],
    disaster: ['I won\'t dress it up: this was a hard year, for the club and for the fans. ', 'A season like this one can\'t happen again. '],
  }[R.outcome] || [''];
  return lines[(R.w + R.l) % lines.length];
}


/**
 * §112 The manager's look back at the season, and the winter's priority: the club's two biggest holes,
 * from the review — the GM picks the one free agency (and the winter meetings) go after first.
 */
export function deliverPriorityCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const R = state.offseason?.review;
  if (!R || !R.needs?.length) return null;
  const W = reviewWords(state, R);
  const [a, b] = R.needs;
  const mgr = _managerName(state);
  const sentences = [
    `${Cap(W.how)}.`,
    W.worked.length ? `What worked: ${_listWords(W.worked)}.` : '',
    W.didnt.length ? `What didn't: ${_listWords(W.didnt)}.` : '',
    W.stars.length ? `${W.stars.length > 1 ? 'The players who carried us' : 'The player who carried us'}: ${_listWords(W.stars)}.` : '',
    W.letdown ? `The one I expected more from: ${W.letdown}.` : '',
    `Going into the winter, the biggest hole${b ? 's are' : ' is'} ${b ? `${a.long} and ${b.long}` : a.long}. Tell me which one we go after first, and the scouts will build the free-agent list around it.`,
  ].filter(Boolean);
  const card = _rosterCard(state, {
    cardId: 'os_priority', tag: 'COACHING', sender: mgr, avatar: '📋', type: 'normal',
    _rosterKey: `os:priority:${state.seasonNum}`,
    subject: R.outcome === 'champion' ? 'Looking back on a title — and the winter\'s priority' : 'Looking back — and the winter\'s priority',
    preview: `${Cap(W.how)}. The winter's biggest hole${b ? 's' : ''}: ${b ? `${a.short} and ${b.short}` : a.short}.`,
    body: sentences.join(' '),
    yesLabel: `Priority: ${a.short}`, noLabel: b ? `Priority: ${b.short}` : 'No single priority',
    expiresAtMs,
    _raw: { onYes: 'os_priority_a', onNo: 'os_priority_b', onAuto: 'os_priority_a' },
    _autoLabel: `No answer — ${mgr} went after ${a.short} first`,
  });
  return _deliverAt(card, atMs);
}

const Cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);

const _listWords = (xs) => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);


/** §112.3 What a contract decision rests on, in sentences (his season, role, standing, who replaces him, the market). */
function _contractSentences(state, p, X) {
  const pos = primaryPos(p);
  const out = [];
  if (X.line) out.push(`Last season: ${X.line}, as ${X.role}.`);
  else out.push(`${p.name} was ${X.role}.`);
  if (X.star) out.push(`${p.name} was one of the players who carried us.`);
  else if (X.letdown) out.push(`${p.name} was one of the disappointments of the year.`);
  else if (X.core) out.push(`${p.name} is part of our young core.`);
  out.push(X.internal
    ? `Without ${p.name}, the job goes to ${X.internal.name} (OVR ${X.internal.ovr}).`
    : `Without ${p.name}, we have nobody else at ${pos}.`);
  out.push(X.marketN
    ? `On the market now at ${pos}: ${_listWords(X.market.map(m => `${m.name} (OVR ${m.ovr}, asking ${formatK(m.ask)})`))}.`
    : `Nobody comparable is on the market at ${pos} right now.`);
  return out.join(' ');
}


/** A user player whose deal is up: re-sign at the asking terms, or let the player walk. */
export function deliverResignCard(playerId, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p || p.teamId !== 'user') return null;
  const terms = p._ask || Offseason.marketTerms(state, p);
  const X = Offseason.contractContext(state, p);
  const payroll = state.userTeam.finances?.payroll || 0;
  const target = Finance.seasonTarget(state.userTeam.finances);
  const delta = terms.salary - (p.contractSalary || 0);
  // r200 §122.77 the price counts how the player played; say so when it moved it a lot
  const perf = Offseason.performanceShift(state, p).shift;
  const why = perf >= 3 ? `; the agent is pricing in the season ${p.name} just had`
    : perf <= -3 ? `; a down season has taken some air out of it` : '';
  const card = _rosterCard(state, {
    cardId: 'os_resign', tag: 'CONTRACT', sender: `${p.name}'s agent`, avatar: '✍️', type: X.star || X.core ? 'urgent' : 'normal',
    _rosterKey: `os:resign:${playerId}:${state.seasonNum}`, _osGate: 'contracts', _targetPlayerId: playerId,
    subject: `${p.name}'s contract is up`,
    preview: `${X.line ? `${X.line}. ` : ''}Asking ${formatK(terms.salary)} a year for ${_years(terms.years)}.`,
    body: `${_who(p)}, ${X.age} next season, becomes a free agent unless we re-sign. `
        + _contractSentences(state, p, X) + ' '
        + `The ask is ${formatK(terms.salary)} a year for ${_years(terms.years)} (${terms.salary > (p.contractSalary || 0) ? 'up' : terms.salary < (p.contractSalary || 0) ? 'down' : 'the same as'} ${terms.salary === (p.contractSalary || 0) ? 'now' : `from ${formatK(p.contractSalary || 0)}`})${why}${p._agentGrudge ? `, and the agent hasn't forgotten ${p._agentGrudge === 'extension' ? 'the new deal we put off' : 'the bonus we turned down'}: about 10% more than the market` : ''}. `
        + `That ${delta >= 0 ? 'adds' : 'saves'} ${formatK(Math.abs(delta))}; payroll is ${formatK(payroll)} against ownership's ${formatK(target)} target. `
        + `If we let ${p.name} walk, every club gets a shot on the free-agent market. No answer by the time spring training opens means the same thing.`,
    yesLabel: `Re-sign (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: `Let ${p.name} walk`,
    expiresAtMs,
    _raw: { onYes: 'os_resign', onNo: 'os_walk', onAuto: 'os_walk_auto' },
    _autoLabel: `No answer — ${p.name} walked`,
  });
  return _deliverAt(card, atMs);
}


/** §112.3 A young core player: lock up the next years now, at a discount on today's market. */
export function deliverExtensionCard(cand, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[cand.player.id];
  if (!p || p.teamId !== 'user') return null;
  const { terms, future, left } = cand;
  const delta = terms.salary - (p.contractSalary || 0);
  if (delta > 0 && !Finance.canAddSalary(state, delta)) return null;
  const X = Offseason.contractContext(state, p);
  const through = (p.contractExpiry || state.seasonNum + 2) - 1;
  const card = _rosterCard(state, {
    cardId: 'os_extension', tag: 'CONTRACT', sender: 'Front Office', avatar: '🔒', type: 'good',
    _rosterKey: `os:extend:${p.id}:${state.seasonNum}`, _targetPlayerId: p.id, _extTerms: terms,
    subject: `Extend ${p.name}?`,
    preview: `${_years(terms.years)} at ${formatK(terms.salary)} a year, before ${p.name} gets expensive.`,
    body: `${_who(p)}, ${X.age} next season, is signed through season ${through} at ${formatK(p.contractSalary || 0)} a year${left > 0 ? ` (${_years(left)} after next season)` : ''}. `
        + `${X.line ? `Last season: ${X.line}. ` : ''}`
        + `${p.name}'s agent is open to an extension now: ${_years(terms.years)} at ${formatK(terms.salary)} a year, starting next season, replacing the current deal. `
        + `If ${p.name} keeps growing, the next deal could cost about ${formatK(future)} a year. `
        + `${delta > 0 ? `It adds ${formatK(delta)} to next season's payroll.` : 'It costs nothing more next season.'} `
        + `The offer stands until free agency opens.`,
    yesLabel: `Extend (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Not now',
    expiresAtMs,
    _raw: { onYes: 'os_extend', onNo: 'os_extend_pass', onAuto: 'os_extend_pass' },
    _autoLabel: 'No answer — not now',
  });
  return _deliverAt(card, atMs);
}


/**
 * r201 §122.78 deliverAgentAsk(cand, atMs, moment) — after a breakout (the All-Star break, or the
 * season's end), the agent asks to redo the deal now: the market price, starting next season and
 * replacing the current deal. Extend at the ask, counter (less money, or fewer years), or not now.
 */
export function deliverAgentAsk(cand, atMs, moment = 'break') {
  const state = StateManager.get();
  const p = state.players[cand.player.id];
  if (!p || p.teamId !== 'user') return null;
  const { terms, counters } = cand;
  const season = state.seasonNum || 1;
  const cur = p.contractSalary || 0;
  const through = (p.contractExpiry || season + 2) - 1;
  const line = Offseason.lineWords(p, p.stats);
  const again = (p._agentAsk?.declined || 0) >= 1;
  const choices = [
    { key: 'ask', label: `Extend (${_years(terms.years)}, ${formatK(terms.salary)})`, sub: `From next season: ${formatK(terms.salary - cur)} a year more` },
    { key: 'money', label: `Counter: ${formatK(counters.money.salary)} a year`, sub: _years(counters.money.years) },
    ...(counters.years ? [{ key: 'years', label: `Counter: ${_years(counters.years.years)}`, sub: `At ${formatK(counters.years.salary)}` }] : []),
  ];
  const card = _rosterCard(state, {
    cardId: 'agent_ask', tag: 'CONTRACT', sender: `${p.name}'s agent`, avatar: '✍️', type: 'urgent',
    _rosterKey: `agent:ask:${p.id}:${season}`, _targetPlayerId: p.id, _agentTerms: terms, _agentCounters: counters,
    subject: `${p.name} — a new deal`,
    preview: `My client has outplayed the contract, and I'd like to fix that now.`,
    body: `${_who(p)} has outplayed the contract${moment === 'break' ? ' in the first half' : ' this season'}${line ? `: ${line}` : ''}. `
        + `The current deal runs through season ${through} at ${formatK(cur)} a year, well short of what that's worth. `
        + `I'd like a new one in place now: ${_years(terms.years)} at ${formatK(terms.salary)} a year, starting next season and replacing it. `
        + (again ? `This is the second time I've asked. Put it off again and my client plays out the deal and tests free agency. `
                 : `Put it off, and it won't be forgotten, by my client or by me at the next negotiation. `)
        + `I need an answer ${_day(atMs + AGENT_ASK.ttlDays * 86_400_000, atMs)}.`,
    _choices: choices, _noRec: true,   // (the agent's message: no front-office pick)
    yesLabel: choices[0].label, noLabel: 'Not now',
    autoResolve: 'no', expiresAtMs: atMs + AGENT_ASK.ttlDays * 86_400_000,
    _raw: { onYes: 'os_agent_yes', onNo: 'os_agent_no', onAuto: 'os_agent_no' },
    _autoLabel: 'No answer — not now',
  });
  const out = _deliverAt(card, atMs);
  if (out) StateManager.mutate(s => { const q = s.players[p.id]; if (q) q._agentAsk = { ...(q._agentAsk || {}), season }; });
  return out;
}


/** r201 §122.78 the agent turned the counter down: the ask stands, for a day. */
function _deliverAgentHold(p, terms, kind, atMs) {
  const state = StateManager.get();
  const season = state.seasonNum || 1;
  const card = _rosterCard(state, {
    cardId: 'agent_hold', tag: 'CONTRACT', sender: `${p.name}'s agent`, avatar: '✍️', type: 'urgent',
    _rosterKey: `agent:hold:${p.id}:${season}`, _targetPlayerId: p.id, _agentTerms: terms,
    subject: `Re: ${p.name} — a new deal`,
    preview: kind === 'money' ? `The money isn't there. The ask stands.` : `My client wants the years. The ask stands.`,
    body: `${kind === 'money' ? `We're not taking less money; my client has earned the raise.` : `My client wants the security of the full term, and we're not moving on it.`} `
        + `The ask stands: ${_years(terms.years)} at ${formatK(terms.salary)} a year, starting next season. Yes or no ${_day(atMs + 86_400_000, atMs)}.`,
    yesLabel: `Extend (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Not now',
    autoResolve: 'no', expiresAtMs: atMs + 86_400_000,
    _raw: { onYes: 'os_agent_yes', onNo: 'os_agent_no', onAuto: 'os_agent_no' },
    _autoLabel: 'No answer — not now',
  });
  return _deliverAt(card, atMs);
}


/** §112.3 An overpaid player under contract: keep, or release (the money is still owed). */
export function deliverReleaseCard(cand, atMs, expiresAtMs) {
  const state = StateManager.get();
  const p = state.players[cand.player.id];
  if (!p || p.teamId !== 'user') return null;
  const X = Offseason.contractContext(state, p);
  const through = (p.contractExpiry || state.seasonNum + 2) - 1;
  const why = [X.line ? `Last season: ${X.line}.` : `Last season, ${p.name} was ${X.role}.`,
    (p._ovrChange || 0) <= -2 ? `${p.name} lost ${-p._ovrChange} points of OVR over the winter.` : null].filter(Boolean);
  const card = _rosterCard(state, {
    cardId: 'os_release', tag: 'CONTRACT', sender: 'Front Office', avatar: '✂️', type: 'normal',
    _rosterKey: `os:release:${p.id}:${state.seasonNum}`, _targetPlayerId: p.id,
    subject: `${p.name}'s contract: keep, or release?`,
    preview: `${formatK(p.contractSalary || 0)} a year through season ${through}; the market says ${formatK(cand.market)}.`,
    body: `${_who(p)}, ${X.age} next season, is owed ${formatK(p.contractSalary || 0)} a year through season ${through}, ${formatK(cand.owed)} in all. `
        + `${why.join(' ')} `
        + `Today the market would pay ${p.name} about ${formatK(cand.market)} a year. `
        + `Releasing opens the roster spot, but the money is still owed and still counts against the payroll, less whatever another club pays if ${p.name} signs elsewhere. `
        + (X.internal ? `${X.internal.name} (OVR ${X.internal.ovr}) would take over. ` : '')
        + `With no answer by the time free agency opens, ${p.name} stays.`,
    yesLabel: `Keep ${p.name}`, noLabel: `Release (${formatK(cand.owed)} owed)`,
    expiresAtMs,
    _raw: { onYes: 'os_release_keep', onNo: 'os_release', onAuto: 'os_release_keep' },
    _autoLabel: `No answer — ${p.name} stays`,
  });
  return _deliverAt(card, atMs);
}


/** The manager's contract is up. */
export function deliverManagerContractCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const m = state.userTeam.coachingStaff?.manager || {};
  const last = (state.seasonHistory || [])[state.seasonHistory.length - 1] || {};
  const card = _rosterCard(state, {
    cardId: 'os_manager', tag: 'MANAGER_CONTRACT', sender: 'Front Office', avatar: '📋', type: 'urgent',   // r158 a memo about the manager's contract: the front office's
    _rosterKey: `os:manager:${state.seasonNum}`, _osGate: 'manager',
    subject: `${m.name || 'The manager'} — contract decision`,
    preview: 'The manager\'s contract is up. Extend, or open a search?',
    body: `${m.name || 'The manager'}'s contract is up after a ${last.wins ?? '—'}–${last.losses ?? '—'} season. `
        + `${_managerRead({ ...m, background: '' }).replace(/^[^:]+: /, `${m.name || 'The manager'} is `)} `
        + `A ${MANAGER_EXTENSION_YEARS_UI}-year extension keeps the clubhouse steady (salary up 5%). A search brings in a new voice: two candidates to choose from. `
        + `With no decision by the time spring training opens, ${m.name || 'the manager'} stays on a one-year deal — knowing we didn't choose to extend.`,
    yesLabel: `Extend ${_years(MANAGER_EXTENSION_YEARS_UI)}`, noLabel: 'Open a search',
    expiresAtMs,
    _raw: { onYes: 'os_mgr_extend', onNo: 'os_mgr_replace', onAuto: 'os_mgr_auto' },
    _autoLabel: 'No decision — one-year renewal',
  });
  return _deliverAt(card, atMs);
}

const MANAGER_EXTENSION_YEARS_UI = 2;


/** "Grattan, let go by the Tideland Anchors after a 60–102 season: a solid manager (rated 64) who goes to the bullpen early." */
function _managerRead(x) {
  const w = Managers.qualityWord(x.quality);
  return `${x.name}${x.background ? `, ${x.background}` : ''}: ${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w} manager (rated ${x.quality}) who ${Managers.styleWords(x)}.`;
}


/** §122.64 The search: two candidates for manager; the one we pass on stays on the market. Due by spring. */
export function deliverManagerHireCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const m = state.userTeam.coachingStaff?.manager || {};
  if (!m.searching) return null;
  const [A, B] = Managers.candidates(state, { taken: new Set([m.name]) });
  const card = _rosterCard(state, {
    cardId: 'os_mgr_hire', tag: 'MANAGER_CONTRACT', sender: 'Front Office', avatar: '🤝', type: 'normal',
    _rosterKey: `os:mgrhire:${state.seasonNum}`, _mgrCands: [A, B], _osGate: 'manager',
    subject: 'Hiring: manager',
    preview: `${A.name} (rated ${A.quality}, ${Managers.styleLabel(A).toLowerCase()}) or ${B.name} (rated ${B.quality}, ${Managers.styleLabel(B).toLowerCase()}).`,
    body: `The search to replace ${m.name || 'our manager'} has two candidates. `
        + `${_managerRead(A)} The ask: ${formatK(A.salary)} a year for two years. `
        + `${_managerRead(B)} The ask: ${formatK(B.salary)} a year for two years. `
        + `The club starts on the new manager's style. With no decision by the time spring training opens, we hire ${B.name}.`,
    yesLabel: `Hire ${A.name} (${formatK(A.salary)})`, noLabel: `Hire ${B.name} (${formatK(B.salary)})`,
    expiresAtMs,
    _raw: { onYes: 'os_mgr_hire_a', onNo: 'os_mgr_hire_b', onAuto: 'os_mgr_hire_b' },
    _autoLabel: `No decision — ${B.name} hired`,
  });
  return _deliverAt(card, atMs);
}


// §112.2 THE COACHES — the day-2 evaluation and the hiring market.
const _UNIT = { pitchingCoach: 'the pitching staff', hittingCoach: 'the lineup', benchCoach: 'the bases and the late-game work',
                scoutingDirector: 'the scouts' };


/** "a solid coach (rated 64), a command teacher: fewer walks" */
function _coachRead(role, c) {
  const q = Coach.qualityOf(c);
  const w = Coach.qualityWord(q);
  return `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w} ${Coach.personWord(role)} (rated ${q}), ${Coach.specialtyWords(role, c.specialty)}`;
}


/**
 * The manager's evaluation of one coach. `kind`: 'up' (the deal is up:
 * renew or let go) | 'poor' (under contract, the side of the game struggled:
 * keep or fire, paying out the deal).
 */
export function deliverCoachReviewCard(role, kind, atMs, expiresAtMs) {
  const state = StateManager.get();
  const c = state.userTeam.coachingStaff?.[role];
  if (!c || c.vacant) return null;
  const U = state.offseason?.review?.units;
  const ev = Coach.evaluate(role, U);
  const info = Coach.ROLE_INFO[role];
  const next = (state.seasonNum || 1) + 1;
  const mgr = info.scout ? 'Front Office' : _managerName(state);   // §122.15 the front office reviews its own director
  const how = ev.facts.length
    ? { good: `It was a good year for ${_UNIT[role]}: ${_listWords(ev.facts)}.`,
        fair: `${Cap(_UNIT[role])} landed in the middle of the league: ${_listWords(ev.facts)}.`,
        poor: `${Cap(_UNIT[role])} struggled: ${_listWords(ev.facts)}.` }[ev.verdict]
    : '';
  const read = `My read on ${c.name}: ${_coachRead(role, c)}.`;
  if (kind === 'up') {
    const ask = Coach.renewalAsk(role, c, ev.verdict);
    const card = _rosterCard(state, {
      cardId: 'os_coach_review', tag: 'COACHING', sender: mgr, avatar: '📋', type: ev.verdict === 'poor' ? 'urgent' : 'normal',
      _rosterKey: `os:coach:${role}:${state.seasonNum}`, _coachRole: role, _coachAsk: ask,
      subject: `${c.name}, ${info.title}: contract up`,
      preview: `${Cap({ good: 'a good year', fair: 'a middle-of-the-pack year', poor: 'a hard year' }[ev.verdict])} for ${_UNIT[role]}. Staying costs ${formatK(ask)} a year.`,
      body: `${c.name}'s deal as ${info.title} is up. ${how} ${read} `
          + `Staying on means two more years at ${formatK(ask)} a year (${formatK(c.salary || 0)} now). `
          + `If we let ${c.name} go, I'll bring you candidates for the job. With no answer by the time free agency opens, ${c.name} stays on.`,
      yesLabel: `Renew (2 years, ${formatK(ask)})`, noLabel: `Let ${c.name} go`,
      expiresAtMs,
      _raw: { onYes: 'os_coach_renew', onNo: 'os_coach_letgo', onAuto: 'os_coach_renew' },
      _autoLabel: `No answer — ${c.name} stays on`,
    });
    return _deliverAt(card, atMs);
  }
  const owed = Coach.buyoutOwed(c, next);
  const through = (c.contractExpiry || next) - 1;
  const card = _rosterCard(state, {
    cardId: 'os_coach_review', tag: 'COACHING', sender: mgr, avatar: '📋', type: 'urgent',
    _rosterKey: `os:coach:${role}:${state.seasonNum}`, _coachRole: role,
    subject: `${c.name}, ${info.title}: a hard look`,
    preview: `${Cap(_UNIT[role])} struggled. Keep ${c.name}, or make a change (${formatK(owed)} still owed)?`,
    body: `${how} ${read} ${c.name} is signed through season ${through}. `
        + `A change now means paying out the rest of the deal, ${formatK(owed)} from club funds, and bringing in someone new. `
        + `With no answer by the time free agency opens, ${c.name} stays.`,
    yesLabel: `Keep ${c.name}`, noLabel: `Make a change (${formatK(owed)})`,
    expiresAtMs,
    _raw: { onYes: 'os_coach_keep', onNo: 'os_coach_fire', onAuto: 'os_coach_keep' },
    _autoLabel: `No answer — ${c.name} stays`,
  });
  return _deliverAt(card, atMs);
}


/** Two candidates for an empty chair: the first fits what the unit needs; due by spring. */
export function deliverCoachHireCard(role, atMs, expiresAtMs) {
  const state = StateManager.get();
  const staff = state.userTeam.coachingStaff || {};
  if (!staff[role]?.vacant) return null;
  const U = state.offseason?.review?.units || null;
  const info = Coach.ROLE_INFO[role];
  const taken = new Set([...Object.values(staff).map(x => x?.name), state.userTeam.ownerName, ...Managers.managerNames(state),
    ...[...(state.inbox || []), ...(state.scheduledCards || [])].flatMap(c => (c._coachCands || []).map(x => x.name))].filter(Boolean));
  const [A, B] = Coach.candidates(state, role, U, { taken });
  const need = Coach.neededSpecialty(role, U, state);
  const who = (x) => `${x.name} ${x.background}: ${_coachRead(role, x)}. The ask: ${formatK(x.salary)} a year for two years.`;
  const prev = staff[role].prev;
  const card = _rosterCard(state, {
    cardId: 'os_coach_hire', tag: 'COACHING', sender: 'Front Office', avatar: '🤝', type: 'normal',
    _rosterKey: `os:hire:${role}:${state.seasonNum}`, _coachRole: role, _coachCands: [A, B], _osGate: 'staff',
    subject: `Hiring: ${info.title}`,
    preview: `${A.name} (rated ${A.quality}, ${Coach.specialtyShort(A.specialty)}) or ${B.name} (rated ${B.quality}, ${Coach.specialtyShort(B.specialty)}).`,
    body: `The ${info.title} job is open${prev ? ` with ${prev} gone` : ''}. What it needs most, from last season: ${Coach.needReason(role, need, U)}. `
        + `Two candidates. ${who(A)} ${who(B)} `
        + `With no decision by the time spring training opens, ${info.scout ? 'the front office' : _managerName(state)} picks ${B.name}.`,
    yesLabel: `Hire ${A.name} (${formatK(A.salary)})`, noLabel: `Hire ${B.name} (${formatK(B.salary)})`,
    expiresAtMs,
    _raw: { onYes: 'os_hire_a', onNo: 'os_hire_b', onAuto: 'os_hire_b' },
    _autoLabel: `No decision — ${B.name} hired`,
  });
  return _deliverAt(card, atMs);
}


/** After a coach is let go: the candidates arrive (day 3 at the earliest, a few hours after otherwise). */
function _hireCardAfter(role, atMs) {
  const st = StateManager.get();
  const os = st.offseason;
  if (!os) return null;
  const day3 = Offseason._atHour(Offseason.dayStart(os, 3), OFFSEASON_CARD_HOUR + 1);
  const at = Math.max(day3, atMs + (2 + eventRand() * 3) * 3600_000);
  return deliverCoachHireCard(role, Math.min(at, os.springAt - 6 * 3600_000), os.springAt);
}


/** Free agents worth a look (soft: auto-declined after 3 days). */
export function deliverFreeAgentCards(atMs, springAt) {
  const state = StateManager.get();
  const offered = new Set([...(state.inbox || []), ...(state.scheduledCards || [])]
    .filter(c => (c._rosterKey || '').startsWith('os:fa:')).map(c => c._targetPlayerId));
  let n = 0;
  for (const t of Offseason.userFreeAgentTargets(state, FA_CARDS_PER_ROUND, offered)) {
    const p = t.player;
    const terms = p._ask || Offseason.marketTerms(state, p);
    const room = Offseason.displacementFor(state, 'user', p);
    // §78: only free agents ownership would pay for.
    const outK = room ? (room.contractSalary || 0) : 0;   // §122 a dropped player costs nothing from then on
    if (!Finance.canAddSalary(state, terms.salary, outK)) continue;
    const age = computeAge(p.dob, baseballYear(state) + 1);
    const from = (state.leagueTeams || []).find(x => x.id === p._faFrom)?.name || (p._faFrom === 'user' ? 'us' : null);
    const card = _rosterCard(state, {
      cardId: 'os_free_agent', tag: 'FREE_AGENT', sender: 'Scouting', avatar: '🔎', type: 'good',
      _rosterKey: `os:fa:${p.id}:${state.seasonNum}`, _targetPlayerId: p.id,
      subject: `Free agent: ${p.name}`,
      preview: `${posLabel(p)}, OVR ${p.ovr}, ${age} — ${t.reason}.`,
      body: `${_who(p)}, ${age} next season${from ? `, formerly with ${from}` : ''}, is on the market — ${t.reason}. `
          + `The ask is ${formatK(terms.salary)} a year for ${_years(terms.years)}. `
          + (room ? `Our 28 is full, so ${room.name} (OVR ${room.ovr}) would be let go to make room (nothing owed after that). ` : '')
          + `Other clubs are looking too — if ${p.name} signs elsewhere this offer disappears.`,
      yesLabel: `Sign (${_years(terms.years)}, ${formatK(terms.salary)})`, noLabel: 'Pass',
      expiresAtMs: Math.min(atMs + FA_CARD_TTL_DAYS * 86_400_000, springAt),
      _raw: { onYes: 'os_fa_sign', onNo: 'os_fa_pass', onAuto: 'os_fa_pass' },
      _autoLabel: 'No answer — passed',
    });
    if (_deliverAt(card, atMs)) n++;
  }
  return n;
}


// §112.4 THE FRONT OFFICE'S WINTER — tickets, a season-ticket campaign, the ballpark, the fans.
const _pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;

const _signedK = (k) => `${k >= 0 ? '+' : '−'}${formatK(Math.abs(k))}`;


/** Next season's ticket prices: the Ticket Office's proposal against holding them. */
export function deliverTicketCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const o = FrontOffice.ticketOffer(state);
  const G = state.offseason?.review?.gate || {};
  const raise = o.pct > 0;
  const level = o.price !== 1 ? ` Prices are ${_pct(o.price - 1)} ${o.price > 1 ? 'above' : 'below'} where they were when you took over.` : '';
  const card = _rosterCard(state, {
    cardId: 'fo_tickets', tag: 'BUSINESS', sender: 'Ticket Office', avatar: '🎟️', type: 'normal',
    _rosterKey: `fo:tickets:${state.seasonNum}`, _foOffer: o,
    subject: `Next season's ticket prices: ${raise ? 'a raise' : 'a cut'}?`,
    preview: `We recommend ${raise ? 'raising' : 'cutting'} prices ${_pct(o.pct)}: ${o.why}.`,
    body: `${G.games ? `Last season we drew ${G.avg.toLocaleString()} a game to a ${G.capacity.toLocaleString()}-seat park (${Math.round((G.fill || 0) * 100)}% full), with ${G.sellouts} sellout${G.sellouts === 1 ? '' : 's'} and ${formatK(G.gateK)} at the gate.` : 'We have no home crowds to go on yet.'}${level} `
        + `We recommend ${raise ? 'raising' : 'cutting'} prices ${_pct(o.pct)}: ${o.why}. `
        + `At last season's crowds, that's about ${_signedK(o.gateDeltaK)} at the gate over the season`
        + `${o.fansPerGame ? `, with ${Math.abs(o.fansPerGame).toLocaleString()} ${o.fansPerGame < 0 ? 'fewer' : 'more'} fans a game` : ' and the park as full as it was'}. `
        + (o.atmo < 0 ? 'Fans will grumble about a raise after the year we had. ' : o.atmo > 0 ? 'Fans will notice the cut, and appreciate it. ' : '')
        + `With no decision before spring training, prices stay where they are.`,
    yesLabel: `${raise ? 'Raise' : 'Cut'} prices ${_pct(o.pct)}`, noLabel: 'Hold prices',
    expiresAtMs,
    _raw: { onYes: 'fo_tix_change', onNo: 'fo_tix_hold', onAuto: 'fo_tix_hold' },
    _autoLabel: 'No decision — prices held',
  });
  return _deliverAt(card, atMs);
}


/** A season-ticket drive for next season. */
export function deliverCampaignCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const o = FrontOffice.campaignOffer(state);
  const R = state.offseason?.review || {};
  if (!o.fill || !Finance.canSpend(state, o.cost)) return null;
  const pitch = { champion: 'Champions sell themselves. The campaign writes itself: the trophy, the parade, the same club coming back.',
    pennant: 'A pennant is an easy pitch: this club was one series from a title.', playoffs: 'October baseball is the pitch: come back for more of it.',
    near: 'A .500 year and an early exit. The pitch is the club that comes back hungrier.', missed: 'The pitch is the winter\'s changes and a fresh start.',
    disaster: 'It will be a hard sell after this year. The pitch has to be what changes.' }[R.outcome] || 'The pitch is next season.';
  const card = _rosterCard(state, {
    cardId: 'fo_campaign', tag: 'BUSINESS', sender: 'Ticket Office', avatar: '📣', type: 'normal',
    _rosterKey: `fo:campaign:${state.seasonNum}`, _foOffer: o,
    subject: 'A season-ticket campaign for next season?',
    preview: `${formatK(o.cost)} for about ${o.seats.toLocaleString()} more fans a game, worth about ${formatK(o.worthK)} at the gate.`,
    body: `${pitch} A winter campaign (ads, a holder event, early-renewal perks) costs ${formatK(o.cost)} from club funds now. `
        + `We'd expect it to build a base of about ${o.seats.toLocaleString()} more fans a game next season, about ${formatK(o.worthK)} at the gate at next season's prices${o.worthK < o.cost ? ', less than it costs, though the crowd helps the atmosphere' : ''}. `
        + `Club funds: ${formatK(state.userTeam.finances?.funds || 0)}.`,
    yesLabel: `Run the campaign (${formatK(o.cost)})`, noLabel: 'Skip it',
    expiresAtMs,
    _raw: { onYes: 'fo_camp_run', onNo: 'fo_camp_skip', onAuto: 'fo_camp_skip' },
    _autoLabel: 'No decision — no campaign',
  });
  return _deliverAt(card, atMs);
}


/**
 * §122.60 syncWinterOffers(atMs) — a winter offer that spends club funds (the season-ticket campaign, a ballpark or
 * facility upgrade) stays only while the funds cover it. When another decision spent them first (or the money ran
 * short another way), the offer is withdrawn and Recent says so: accepting it could only have done nothing.
 * (The fan event stays: its "no" is a decision with its own cost to the fans.)
 */
const _WINTER_SPEND = Object.freeze({ fo_campaign: (o) => 'The season-ticket campaign', fo_facility: (o) => `The ${o.kind === 'concourse' ? 'concourse' : o.kind === 'field' ? 'drainage' : 'training center'} upgrade` });

export function syncWinterOffers(atMs = clockNow()) {
  const st = StateManager.get();
  const gone = (st.inbox || []).filter(c => !c.resolved && _WINTER_SPEND[c.cardId] && c._foOffer && !Finance.canSpend(st, c._foOffer.cost));
  if (!gone.length) return 0;
  const ids = new Set(gone.map(c => c.instanceId));
  StateManager.mutate(s => { s.inbox = (s.inbox || []).filter(c => !ids.has(c.instanceId)); });
  for (const c of gone) _ourNews(`${_WINTER_SPEND[c.cardId](c._foOffer)} is off the table this winter: club funds no longer cover ${formatK(c._foOffer.cost)}`, atMs);
  return gone.length;
}


/** One ballpark or facility upgrade, where the club needs it most. */
export function deliverFacilityCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const o = FrontOffice.facilityOffer(state);
  if (!o || !Finance.canSpend(state, o.cost)) return null;
  const what = o.kind === 'concourse'
    ? { name: 'the ballpark concourse', does: 'wider concourses, better food and shade: a park people want to spend an afternoon in. It lifts the atmosphere now and fills about 1.5% more of the seats every game from here on' }
    : o.kind === 'field'   // r170
    ? { name: 'the field\'s drainage', does: 'new drainage under the field: it takes more rain before we stop or call a game, the crew gets us back on the field faster after a delay, and the infield stays firmer. Fewer postponements means fewer makeup doubleheaders, and less of the gate lost to the weather' }
    : { name: 'the training center', does: 'a new pitching lab and hitting cages: our players get more out of their work. Development plans gain about 5% more, and every player grows a little more each winter' };
  const card = _rosterCard(state, {
    cardId: 'fo_facility', tag: 'BUSINESS', sender: o.kind === 'field' ? 'Head Groundskeeper' : 'Facilities & Ops', avatar: o.kind === 'field' ? '🌱' : '🏗️', type: 'normal',
    _rosterKey: `fo:facility:${state.seasonNum}`, _foOffer: o,
    subject: `Upgrade ${what.name}?`,
    preview: `${formatK(o.cost)}: ${o.why}.`,
    body: `Our proposal for the winter: ${what.name}${o.level > 1 ? ` (phase ${o.level} of 3)` : ''}. ${Cap(what.does)}. `
        + `Why now: ${o.why}. It costs ${formatK(o.cost)} from club funds (${formatK(state.userTeam.finances?.funds || 0)} today), and the work is done by spring training.`,
    yesLabel: `Build it (${formatK(o.cost)})`, noLabel: 'Not this winter',
    expiresAtMs,
    _raw: { onYes: 'fo_fac_build', onNo: 'fo_fac_skip', onAuto: 'fo_fac_skip' },
    _autoLabel: 'No decision — not this winter',
  });
  return _deliverAt(card, atMs);
}


/** How the club meets its fans after the year it had. */
export function deliverFanEventCard(atMs, expiresAtMs) {
  const state = StateManager.get();
  const o = FrontOffice.eventOffer(state);
  const R = state.offseason?.review || {};
  const rec = `${R.w ?? 0}–${R.l ?? 0}`;
  const T = {
    parade: { subject: 'The championship parade', yes: `Throw the parade (${formatK(o.cost)})`, no: 'A ring ceremony on Opening Day',
      body: `The city wants a parade. Downtown, the trophy, the players on the floats, a rally at the park: ${formatK(o.cost)} for the city's costs and ours. Sponsors want in on it, and it's a day the fans will remember. The alternative is a ring ceremony on Opening Day.` },
    appreciation: { subject: 'A fan appreciation weekend', yes: `Hold it (${formatK(o.cost)})`, no: 'Skip it',
      body: `A ${rec} season and a playoff run: the fans came with us. A winter appreciation weekend (players signing, the park open for photos on the field, a holiday market) costs ${formatK(o.cost)}. It keeps the season's energy going into next year.` },
    caravan: { subject: 'A winter caravan', yes: `Send the caravan (${formatK(o.cost)})`, no: 'Skip it this year',
      body: `After a ${rec} season, a winter caravan (a few players and coaches visiting towns across the region, schools, hospitals) keeps the club in front of fans who drifted. It costs ${formatK(o.cost)}. Skipping it costs a little goodwill.` },
    outreach: { subject: 'Reaching out to the fans after a hard year', yes: `Reach out (${formatK(o.cost)})`, no: 'Let the winter pass',
      body: `${rec}. The fans are frustrated, and they're saying so. Community Affairs proposes a letter to every season-ticket holder about what's changing, open forums with the front office, and an early-renewal discount: ${formatK(o.cost)}. Saying nothing this winter will cost us more goodwill.` },
  }[o.kind];
  const card = _rosterCard(state, {
    cardId: 'fo_event', tag: 'FANS', sender: 'Community Affairs', avatar: o.kind === 'parade' ? '🏆' : '🤝', type: o.kind === 'parade' ? 'good' : 'normal',
    _rosterKey: `fo:event:${state.seasonNum}`, _foOffer: o,
    subject: T.subject,
    preview: T.body.split('. ')[0] + '.',
    body: T.body + ` Club funds: ${formatK(state.userTeam.finances?.funds || 0)}.`,
    yesLabel: T.yes, noLabel: T.no,
    expiresAtMs,
    _raw: { onYes: 'fo_event_yes', onNo: 'fo_event_no', onAuto: 'fo_event_no' },
    _autoLabel: `No decision — ${T.no.toLowerCase()}`,
  });
  return _deliverAt(card, atMs);
}


/** Day 5: one reminder listing required decisions still open. */
export function deliverGateReminder(atMs, springAt) {
  const state = StateManager.get();
  const gates = Offseason.hardGates(state);
  if (!gates.open.length) return null;
  const names = { ownership: 'the budget offer from ownership', contracts: 'expiring contracts', manager: 'the manager\'s contract', staff: 'an open coaching job' };
  return _deliverNotice(`os:reminder:${state.seasonNum}`, {
    sender: 'Front Office', type: 'urgent', avatar: '⏰',
    subject: 'Decisions due before spring training',
    preview: `Still open: ${gates.open.map(g => names[g]).join(', ')}.`,
    body: `Spring training opens at midnight tomorrow. Still open: ${gates.open.map(g => names[g]).join(', ')}. Anything without an answer by then is decided for us — conservatively.`,
    expiresAtMs: springAt,
  }, atMs);
}


/** A user player retires (r222 §122.101 with what they walked away from, when the deal had years left). */
export function deliverRetirementNotice(playerId, age, atMs, owedYears = 0, owedK = 0) {
  const state = StateManager.get();
  const p = state.players[playerId];
  if (!p) return null;
  const money = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(1).replace(/\.0$/, '')}M` : `$${Math.round(k)}K`);
  const left = owedYears > 0 ? ` They walked away from ${owedYears === 1 ? 'a year' : `${owedYears} years`} and ${money(owedK)} left on the deal.` : '';
  return _deliverNotice(`os:retire:${playerId}`, {
    sender: _managerName(state), avatar: '🎩', type: 'normal',
    subject: `${p.name} is retiring`,
    preview: `${_who(p)} has decided to hang them up at ${age}.`,
    body: `${_who(p)} told us it's time to retire, at ${age}, after ${p.careerStats?.seasons || 1} season${(p.careerStats?.seasons || 1) === 1 ? '' : 's'}.${left} The roster spot is open.`,
  }, atMs);
}


/**
 * r166 §122.35 the Bench Coach's position work is over: how it went, in the coach's words (a
 * consequence the GM should know — the player is steadier there, or isn't).
 */
export function _deliverTeachReport(ev, atMs) {
  const st = StateManager.get(), p = st.players[ev.playerId];
  if (!p || ev.reason === 'gone') return null;
  const at = { C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', OF: 'the outfield' }[ev.pos] || ev.pos;
  const n = startsAt(p, ev.pos);
  const how = ev.reason === 'eligible' ? `${p.name} made ${ev.pos} official in games before we finished, so we stopped there.`
    : ev.gained <= 0 ? `We put in ${ev.days} days at ${at} with ${p.name} and it didn't take. Some players just don't settle in at a new spot.`
    : ev.took >= ev.days ? `${p.name} took to ${at}: every day of reps stuck. ${p.name} is steadier there now.`
    : `${p.name} took to some of it: ${ev.took} of ${ev.days} days stuck. Steadier at ${at} than before, not finished.`;
  return _deliverNotice(`teach:done:${ev.playerId}:${ev.pos}:${ev.atMs}`, {
    cardId: 'teach_report', sender: _benchCoach(st), avatar: '🧢', tag: 'DEVELOPMENT', _playerIds: [p.id], _targetPlayerId: p.id,
    subject: ev.gained > 0 ? `${p.name} at ${ev.pos}` : `${p.name} at ${ev.pos}: it didn't take`,
    preview: ev.gained > 0 ? `The position work is done: steadier at ${at}.` : 'The position work is done.',
    body: `${how}${ev.reason === 'eligible' ? '' : `\n\n${n ? `${n} of ten starts at ${ev.pos} so far.` : `Ten starts at ${ev.pos} makes it official.`}`}`,
  }, atMs);
}


/**
 * r168 §122.35 phase 6 — positions around the league. A player who'd start for us at the new spot
 * (or cover one nobody on our bench plays) is a Pro Scouting message: a club's player as a trade
 * idea (`_deliverIdea`), a free agent as a signing. At most one every LEAGUE_POSITIONS.msgGapMs;
 * everything else is a line in Recent.
 */
export function leaguePositionNews(events, atMs) {
  let delivered = 0;
  for (const ev of events || []) {
    if (ev.type !== 'LEAGUE_POS') continue;
    const st = StateManager.get(), p = st.players[ev.playerId];
    if (!p) continue;
    const fit = LeaguePos.fitsUs(st, p, ev.pos);
    const room = atMs - (st.leaguePos?.lastMsgAt ?? -Infinity) >= LEAGUE_POSITIONS.msgGapMs;
    const sent = fit && room && withDice(dice(diceSeed(st), 'leaguepos-msg', ev.playerId, ev.atMs), () =>
      (ev.kind === 'fa' ? _faPosCard(st, p, ev, fit) : _clubPosCard(st, p, ev, fit)));
    if (sent) {
      delivered++;
      StateManager.mutate(s => { s.leaguePos = { ...(s.leaguePos || {}), lastMsgAt: atMs }; });
    } else if (ev.text) {
      StateManager.mutate(s => { s.activityFeed = pruneActivityFeed([...(s.activityFeed || []), buildActivityFeedEntry('position', ev.teamId ? _abbrOf(s, ev.teamId) : 'FA', ev.text, Math.min(ev.atMs ?? atMs, clockNow()))]); });
    }
  }
  return delivered;
}


const _abbrOf = (st, id) => (st.leagueTeams || []).find(t => t.id === id)?.abbr || id;

const _posWord = (pos) => ({ C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', OF: 'the outfield', SP: 'the rotation', RP: 'the bullpen' }[pos] || pos);


/** Why it matters to us, as the end of a sentence about the player ("…and would start over Cahill (75) there."). */
function _fitClause(st, p, pos, fit) {
  const over = fit.over ? st.players[fit.over] : null;
  if (fit.thin) return `nobody on our bench plays ${pos}`;
  if (pos === 'SP') return over ? `would take ${over.name}'s turn in our rotation (${over.ovr})` : 'would fill our open turn in the rotation';
  if (pos === 'RP') return `would be an upgrade on ${over?.name || 'the back of our bullpen'}${over ? ` (${over.ovr})` : ''}`;
  return `would start over ${over?.name || 'our starter'}${over ? ` (${over.ovr})` : ''} there`;
}


/** r195 the same, as a noun phrase after the player's one mention ("…working in relief as well: an upgrade on Cahill (54)."). */
function _fitNoun(st, pos, fit, sending = []) {
  const over = fit.over ? st.players[fit.over] : null;
  // (r200: when the player we'd upgrade on is in the package, the price names that player — once)
  if (over && sending.includes(over.id)) {
    return pos === 'SP' ? 'a starter for the rotation turn of the arm they\'d take back'
      : pos === 'RP' ? 'an upgrade on the reliever they\'d take back'
      : 'an upgrade on the starter they\'d take back there';
  }
  if (pos === 'SP') return over ? `a starter for ${over.name}'s turn in our rotation (${over.ovr})` : 'a starter for our open turn in the rotation';
  if (pos === 'RP') return over ? `an upgrade on ${over.name} (${over.ovr})` : 'an upgrade on the back of our bullpen';
  return over ? `an upgrade on ${over.name} (${over.ovr}) there` : 'an upgrade on our starter there';
}


function _clubPosCard(st, p, ev, fit) {
  if (!tradeWindow(st).open) return false;
  const team = (st.leagueTeams || []).find(t => t.id === ev.teamId);
  const deal = team && LeagueTrades.scoutPackage(st, team.id, p.id, ev.atMs ?? atMsNow());
  if (!deal) return false;
  const what = ev.pos === 'SP' ? 'stretching out to start' : ev.pos === 'RP' ? 'working in relief' : `playing ${ev.pos}`;
  return !!_deliverIdea(st, {
    key: `lp:${p.id}:${ev.pos}`, teamId: team.id, deal, atMs: (ev.atMs ?? atMsNow()) + 2 * 3600_000,
    subject: `${p.name} is ${what} now`,
    preview: `${team.name} have ${p.name} at ${_posWord(ev.pos)} too.`,
    lead: `${team.name} have ${_dealRef(st, p)} ${what} as well${fit.thin ? `, and ${_fitClause(st, p, ev.pos, fit)}` : `: ${_fitNoun(st, ev.pos, fit, deal.bGets || [])}`}.`,
  });
}


function _faPosCard(st, p, ev, fit) {
  const room = FreeAgency.roomFor(st, p);
  const drop = room.needsDrop ? (room.candidates.find(c => !c.starter && c.player.id !== fit.over) || null)?.player : null;
  if (room.needsDrop && !drop) return false;
  if (FreeAgency.signBlocker(st, p.id, drop?.id || null)) return false;
  const t = FreeAgency.termsFor(st, p);
  const at = (ev.atMs ?? atMsNow()) + 2 * 3600_000;
  const where = ev.pos === 'SP' ? 'as a starter' : ev.pos === 'RP' ? 'in relief' : `at ${ev.pos}`;
  return !!_deliverAt(_rosterCard(st, {
    cardId: 'fa_pos', tag: 'SCOUTING', sender: 'Scouting', avatar: '🔎', type: 'normal',
    _targetPlayerId: p.id, _playerIds: drop ? [drop.id] : [], _dropId: drop?.id || null,
    subject: `${p.name} is working out ${where}`,
    preview: `A free agent who fits: ${_ref(p)}.`,
    body: `${_ref(p)}, a free agent, has been working out ${where}${fit.thin ? `, and ${_fitClause(st, p, ev.pos, fit)}` : ` and ${_fitClause(st, p, ev.pos, fit)}`}. `
        + `The terms: ${formatK(t.salary || 0)}${t.years > 1 ? ` a year for ${t.years} years` : ' for the year'}`
        + `${drop ? `; ${drop.name} would go to make room` : ''}.`,
    yesLabel: `Sign ${p.name}`, noLabel: 'Pass',
    autoResolve: 'roster', expiresAtMs: at + 2 * 86_400_000,
    _rosterKey: `lp:fa:${p.id}:${ev.pos}`,
    _raw: { onYes: 'fa_pos_sign', onNo: null, onAuto: null },
  }), at);
}

const atMsNow = () => clockNow();


/**
 * §122.66 Another club won a waiver claim of ours. The next-best fit for the same role, ours to take
 * now: another player on waivers (put in a claim), else a free agent (sign), each within a few
 * points of the one we lost; else Pro Scouting keeps watching the trade market (while it's open).
 * Nothing at all: false (the plain notice).
 */
export function _claimLostCard(st, lost, winner, atMs) {
  const lead = `${winner || 'Another club'} had priority in the claiming order (worse record) and claimed ${_who(lost)}.`;
  const key = `claim:${lost.id}:${atMs}`;
  if (_cardsWithKey(st, key).length) return true;
  const near = (x) => x && x.id !== lost.id && x.teamId !== 'user' && _sameRole(x, lost) && (x.ovr || 0) >= (lost.ovr || 0) - 5;
  const dropFor = (x) => {
    const room = FreeAgency.roomFor(st, x);
    return room.needsDrop ? (room.candidates.find(c => !c.starter)?.player || null) : undefined;
  };
  const base = (x, drop) => ({ tag: 'ROSTER', sender: 'Player Dev.', avatar: '📋', type: 'normal',
    _targetPlayerId: x.id, _playerIds: [lost.id, ...(drop ? [drop.id] : [])], _dropId: drop?.id || null,
    subject: `Claim lost: ${lost.name}`, autoResolve: 'roster', _rosterKey: key, _autoLabel: 'No answer — passed' });
  // Another player on waivers.
  const wav = (st.waiverPool || []).map(id => st.players[id])
    .filter(x => near(x) && x._waivedBy !== 'user' && !x._userClaim).sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  for (const x of wav) {
    const drop = dropFor(x);
    if (drop === null || FreeAgency.claimBlocker(st, x.id, drop?.id || null, atMs)) continue;
    const ends = FreeAgency.waiverEndsAt(x);
    return !!_deliverAt(_rosterCard(st, { ...base(x, drop), cardId: 'claim_lost',
      preview: `The next-best fit on waivers: ${_ref(x)}.`,
      body: `${lead} The next-best fit on waivers is ${_ref(x)}, ${formatK(x.contractSalary || 0)}; the claim window closes ${When.untilDay(ends, atMs)}.`
          + `${drop ? ` If it's ours, ${drop.name} goes to make room.` : ''}`,
      yesLabel: `Claim ${x.name}`, noLabel: 'Pass', expiresAtMs: Math.min(ends, atMs + 2 * 86_400_000),
      _raw: { onYes: 'claim_next', onNo: null, onAuto: null },
    }), atMs);
  }
  // A free agent.
  const fas = FreeAgency.freeAgentList(st).filter(near).sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).slice(0, 12);
  for (const x of fas) {
    const drop = dropFor(x);
    if (drop === null || FreeAgency.signBlocker(st, x.id, drop?.id || null)) continue;
    const t = FreeAgency.termsFor(st, x);
    return !!_deliverAt(_rosterCard(st, { ...base(x, drop), cardId: 'claim_lost',
      preview: `The next-best fit is a free agent: ${_ref(x)}.`,
      body: `${lead} The next-best fit is a free agent, ${_ref(x)}: ${formatK(t.salary || 0)}${t.years > 1 ? ` a year for ${t.years} years` : ' for the year'}.`
          + `${drop ? ` ${drop.name} would go to make room.` : ''}`,
      yesLabel: `Sign ${x.name}`, noLabel: 'Pass', expiresAtMs: atMs + 2 * 86_400_000,
      _raw: { onYes: 'fa_pos_sign', onNo: null, onAuto: null },
    }), atMs);
  }
  // Nobody now: the trade market, watched.
  if (!tradeWindow(st).open) return false;
  return !!_deliverWatchCard(key, {
    cardId: 'claim_lost', sender: 'Scouting',
    subject: `Claim lost: ${lost.name}`,
    preview: 'Nobody on waivers or in free agency fits the spot right now.',
    body: `${lead} Nobody on waivers or in free agency fits the spot right now.`,
    spec: { type: 'role', pos: lost.pos, nativePos: posLabel(lost), primary: primaryPos(lost), excludeId: lost.id },
    what: `someone to fill ${lost.name}'s role`, atMs,
  });
}


/** r167 §122.35 the pitching coach's sim games are over: how far the pitcher got. */
export function _deliverSimReport(ev, atMs) {
  const st = StateManager.get(), p = st.players[ev.playerId];
  if (!p || ev.reason === 'gone') return null;
  const pc = st.userTeam?.coachingStaff?.pitchingCoach;
  const sender = pc?.name && !pc.vacant ? pc.name : 'Pitching Coach';
  const ready = ev.stretch >= 3;
  return _deliverNotice(`sim:done:${ev.playerId}:${ev.atMs}`, {
    cardId: 'sim_report', sender, avatar: '⚾', tag: 'DEVELOPMENT', _playerIds: [p.id], _targetPlayerId: p.id,
    subject: ready ? `${p.name} is stretched out` : `${p.name}'s sim games`,
    preview: ready ? 'Ready to start.' : `Stretched out ${ev.stretch} of 3.`,
    body: ready ? `${p.name} got through the sim games and has a starter's length now. ${(st.userTeam?.rotation?.order || []).includes(p.id) ? `${p.name} can go deep the next time through the rotation` : `Put ${p.name} in the rotation when you're ready`}; three starts makes it official.`
                : `${p.name} missed some of the sim games and is only part of the way there: a start would run short.`,
  }, atMs);
}


/** r164 §122.35 the Bench Coach (by name when the chair is filled). */
export function _benchCoach(st) {
  const b = st.userTeam?.coachingStaff?.benchCoach;
  return b?.name && !b.vacant ? b.name : 'Bench Coach';
}


/**
 * r164 §122.35 the season turn for positions: who lost which position, and whose primary moved.
 * A consequence the GM should know before planning next season (a notice).
 */
export function deliverPositionsTurnNotice(changes, atMs) {
  const st = StateManager.get();
  const lines = [], ids = [];
  for (const c of changes || []) {
    const p = st.players[c.playerId];
    if (!p) continue;
    ids.push(p.id);
    const last = p.positions?.lastStarts || {};
    for (const x of c.lost || []) lines.push(`${p.name} loses ${x}: ${last[x] || 0} start${(last[x] || 0) === 1 ? '' : 's'} there this season.`);
    if (c.from !== c.to) { const w = POS_WORDS[c.to] || c.to; lines.push(`${p.name} is ${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w} first now (${last[c.to] || 0} starts there).`); }
  }
  if (!lines.length) return null;
  const lost = (changes || []).reduce((n, c) => n + (c.lost || []).length, 0);
  return _deliverNotice(`pos:turn:${st.seasonNum || 1}`, {
    sender: _benchCoach(st), avatar: '🧢', tag: 'ROSTER', _playerIds: ids,
    subject: lost ? 'Where everyone plays next season' : 'A new primary position',
    preview: lost ? `${lost} position${lost === 1 ? '' : 's'} came off the list with the season's starts.` : lines[0],
    body: `The season's starts are in, and the position list follows them.\n\n${lines.join('\n')}\n\nAnyone who lost a spot can earn it back with ten starts there next season.`,
  }, atMs);
}

const POS_WORDS = { C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', OF: 'outfielder', DH: 'designated hitter' };


/**
 * r164 §122.35 the Bench Coach's two late-season notes: who's within reach of a new position, and
 * which positions are at risk at the season turn (the higher-rated first), around 25 and 10 of our
 * regular-season games left — earlier when someone needs a lot of starts, later when all are close.
 * Not sent when nothing is in reach or at risk.
 */
export function _positionNotes(atMs) {
  const st = StateManager.get(), u = st.userTeam;
  if (![PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE, PHASE.ALL_STAR_BREAK].includes(st.phase)) return 0;
  const cur = st.schedule?.[st.currentGameIndex];
  if (cur && !cur._committed && Number.isFinite(cur.gameTime) && cur.gameTime <= atMs && !cur.cancelled) return 0;   // (between games)
  const left = (st.schedule || []).filter(g => !g._committed && !g.cancelled && !g.isSpring && !g.isPlayoff).length;
  const N = st.posNotes?.season === (st.seasonNum || 1) ? st.posNotes : { season: st.seasonNum || 1 };
  if (N.second || left > POSITION_RULES.notes.first.max) return 0;
  const reach = [], risk = [];
  for (const id of u.rosterIds || []) {
    const p = st.players[id];
    if (!p || ['SP', 'RP'].includes(p.pos) || p.teamId !== 'user') continue;
    const s = p.positions || {};
    for (const [x, n] of Object.entries(s.starts || {})) {
      if (x === 'DH' || eligibleAt(p).includes(x)) continue;
      reach.push({ p, x, n, need: POSITION_RULES.gainStarts - n });
    }
    for (const x of eligibleAt(p)) {
      if (x === primaryPos(p)) continue;
      const need = keepNeed(p, x);
      if (need > 0) risk.push({ p, x, n: startsAt(p, x), need });
    }
  }
  const doable = [...reach, ...risk].filter(i => i.need <= left);
  if (!doable.length && !(N.first && risk.length)) return 0;
  const maxNeed = Math.max(0, ...doable.map(i => i.need));
  const W = POSITION_RULES.notes;
  const which = !N.first && left > W.second.max ? 'first' : 'second';
  const at = which === 'first' ? Math.min(W.first.max, Math.max(W.first.min, maxNeed + W.first.base - 10))
                               : Math.min(W.second.max, Math.max(W.second.min, maxNeed + W.second.base - 5));
  if (left > at) return 0;
  const byOvr = (a, b) => (b.p.ovr || 0) - (a.p.ovr || 0);
  const lines = [];
  for (const i of reach.filter(i => i.need <= left).sort(byOvr).slice(0, 4)) lines.push(`${i.p.name} has ${i.n} start${i.n === 1 ? '' : 's'} at ${i.x}; ${i.need} more makes it official.`);
  for (const i of risk.filter(i => i.need <= left).sort(byOvr).slice(0, 4)) lines.push(`${i.p.name} has ${i.n} start${i.n === 1 ? '' : 's'} at ${i.x} and needs ${i.need} more to keep it.`);
  if (which === 'second') for (const i of risk.filter(i => i.need > left).sort(byOvr).slice(0, 3)) lines.push(`${i.p.name} can't get to enough starts at ${i.x} now; that one comes off the list at the turn.`);
  if (!lines.length) return 0;
  const ids = [...new Set([...reach, ...risk].map(i => i.p.id))];
  StateManager.mutate(s => { s.posNotes = { ...N, [which]: true }; });
  const card = _deliverNotice(`pos:notes:${st.seasonNum || 1}:${which}`, {
    sender: _benchCoach(st), avatar: '🧢', tag: 'ROSTER', _playerIds: ids,
    subject: which === 'first' ? 'Positions down the stretch' : 'Last call on positions',
    preview: `${left} games left: ${lines.length} position call${lines.length === 1 ? '' : 's'} to make.`,
    body: `${which === 'first' ? `With ${left} games left, a few position calls to make before the season's out.` : `${left} games to go. Here's where the positions stand.`}\n\n${lines.join('\n')}\n\nYour call on who plays where.`,
    expiresAtMs: atMs + 3 * 86_400_000,
  }, Math.max(atMs, (u._lastGameAt ?? atMs) + 4 * 3600_000));
  return card ? 1 : 0;
}


/** Offseason card decisions (inside _applyRosterAction). */
export function _applyOffseasonAction(action, instance, atMs) {
  const id = instance._targetPlayerId;
  switch (action) {
    case 'os_priority_a':   StateManager.mutate(s => { if (s.offseason) s.offseason.priority = s.offseason.review?.needs?.[0] || null; }); return true;
    case 'os_priority_b':   StateManager.mutate(s => { if (s.offseason) s.offseason.priority = s.offseason.review?.needs?.[1] || null; }); return true;
    case 'os_owner_accept': StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'accept')); return true;
    case 'os_owner_push':   StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'push'));   return true;
    case 'os_owner_auto':   StateManager.mutate(s => Offseason.applyOwnership(s, instance._offer, 'auto'));   return true;
    case 'os_resign':       StateManager.mutate(s => Offseason.applyResign(s, id)); return true;
    case 'os_walk':         StateManager.mutate(s => Offseason.applyLetWalk(s, id, atMs)); return true;
    case 'os_walk_auto':    StateManager.mutate(s => Offseason.applyLetWalk(s, id, atMs, { auto: true })); return true;
    case 'os_mgr_extend':   StateManager.mutate(s => Offseason.applyManagerDecision(s, 'extend'));  return true;
    case 'os_mgr_replace': {
      StateManager.mutate(s => Offseason.applyManagerDecision(s, 'replace'));
      // §122.64 the candidates, a few hours later (before spring).
      const os = StateManager.get().offseason;
      if (os) deliverManagerHireCard(Math.min(atMs + (2 + eventRand() * 3) * 3600_000, os.springAt - 6 * 3600_000), os.springAt);
      return true;
    }
    case 'os_mgr_hire_a':
    case 'os_mgr_hire_b': {
      const cand = (instance._mgrCands || [])[action === 'os_mgr_hire_a' ? 0 : 1];
      StateManager.mutate(s => { if (cand && s.userTeam.coachingStaff?.manager?.searching) Offseason.applyManagerHire(s, cand); });
      return true;
    }
    case 'os_mgr_auto':     StateManager.mutate(s => Offseason.applyManagerDecision(s, 'auto'));    return true;
    // §112.2 the coaches
    case 'os_coach_renew':  StateManager.mutate(s => Offseason.applyCoachDecision(s, instance._coachRole, 'renew', { salary: instance._coachAsk })); return true;
    case 'os_coach_keep':   return true;
    case 'os_coach_letgo':
    case 'os_coach_fire': {
      StateManager.mutate(s => Offseason.applyCoachDecision(s, instance._coachRole, action === 'os_coach_fire' ? 'fire' : 'letgo', { atMs }));
      _hireCardAfter(instance._coachRole, atMs);
      return true;
    }
    case 'os_hire_a':
    case 'os_hire_b': {
      const cand = (instance._coachCands || [])[action === 'os_hire_a' ? 0 : 1];
      StateManager.mutate(s => { if (s.userTeam.coachingStaff?.[instance._coachRole]?.vacant) Offseason.applyCoachHire(s, instance._coachRole, cand); });
      return true;
    }
    case 'os_fa_sign': {
      StateManager.mutate(s => {
        const p = s.players[id];
        if (!p || p.group !== PLAYER_GROUP.FREE_AGENT) return;
        const room = Offseason.displacementFor(s, 'user', p);
        Offseason.signFreeAgent(s, id, 'user', atMs, { displaceId: room?.id || null });
        applyRosterMutation(s, reconcileRoster(s, 'user'));
        s.userTeam.finances.payroll = computePayroll(s);
      });
      return true;
    }
    case 'os_fa_pass': return true;
    // §112.4 the front office
    case 'fo_tix_change': StateManager.mutate(s => FrontOffice.applyTicketPrice(s, instance._foOffer)); return true;
    case 'fo_camp_run': {
      // §122.60 (withdrawn as soon as the funds can't cover it — syncWinterOffers; this is the last guard)
      if (!Finance.canSpend(StateManager.get(), instance._foOffer.cost)) { _ourNews(`The season-ticket campaign waits: club funds no longer cover ${formatK(instance._foOffer.cost)}`, atMs); return true; }
      StateManager.mutate(s => FrontOffice.applyCampaign(s, instance._foOffer, atMs));
      return true;
    }
    case 'fo_fac_build': {
      // §122.57 club funds no longer cover it (another winter decision spent them first): it waits, and Recent says so.
      if (!Finance.canSpend(StateManager.get(), instance._foOffer.cost)) { _ourNews(`The ${instance._foOffer.kind} upgrade waits: club funds no longer cover ${formatK(instance._foOffer.cost)}`, atMs); return true; }
      StateManager.mutate(s => FrontOffice.applyFacility(s, instance._foOffer, atMs));
      return true;
    }
    case 'fo_event_yes':  StateManager.mutate(s => FrontOffice.applyEvent(s, instance._foOffer, true, atMs)); return true;
    case 'fo_event_no':   StateManager.mutate(s => FrontOffice.applyEvent(s, instance._foOffer, false, atMs)); return true;
    case 'fo_tix_hold': case 'fo_camp_skip': case 'fo_fac_skip': return true;
    // §112.3 extensions and releases
    case 'os_extend':       StateManager.mutate(s => { Offseason.applyExtension(s, id, instance._extTerms); s.userTeam.finances.payroll = computePayroll(s); }); return true;
    case 'os_extend_pass':  return true;
    // r201 §122.78 the agent's ask after a breakout
    case 'os_agent_yes': {
      const p = StateManager.get().players[id];
      if (!p || p.teamId !== 'user') return true;
      const pick = instance._pick || 'ask';
      if (pick === 'ask') {
        StateManager.mutate(s => Offseason.answerAgentAsk(s, id, 'yes', instance._agentTerms));
        _ourNews(`${p.name} signed a new deal: ${_years(instance._agentTerms.years)} at ${formatK(instance._agentTerms.salary)} a year from next season`, atMs);
        return true;
      }
      const terms = instance._agentCounters?.[pick];
      if (!terms) return true;
      const st = StateManager.get();
      const takes = dice(diceSeed(st), 'agent-counter', id, st.seasonNum || 1, pick)() < Offseason.counterOdds(p, pick);
      const [lo, hi] = AGENT_ASK.replyMinutes;
      const replyAt = atMs + (lo + Math.floor(dice(diceSeed(st), 'agent-reply', id, st.seasonNum || 1)() * (hi - lo))) * 60_000;
      if (takes) {
        StateManager.mutate(s => Offseason.answerAgentAsk(s, id, 'yes', terms));
        _ourNews(`${p.name}'s agent took our counter: ${_years(terms.years)} at ${formatK(terms.salary)} a year from next season`, replyAt);
      } else {
        _deliverAgentHold(p, instance._agentTerms, pick, replyAt);
      }
      return true;
    }
    case 'os_agent_no': {
      let r = null;
      StateManager.mutate(s => { r = Offseason.answerAgentAsk(s, id, 'no'); });
      const p = StateManager.get().players[id];
      if (r?.walks && p) _ourNews(`${p.name} will play out the deal and test free agency`, atMs);
      return true;
    }
    case 'os_release_keep': return true;
    case 'os_release': {
      StateManager.mutate(s => {
        Offseason.applyRelease(s, id, atMs);
        applyRosterMutation(s, reconcileRoster(s, 'user'));
        s.userTeam.finances.payroll = computePayroll(s);
      });
      return true;
    }
    default: return false;
  }
}
