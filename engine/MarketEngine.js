/**
 * engine/MarketEngine.js
 * The players a card offers from outside the organization (§73) — always real.
 *
 *   A free agent (the pool), a player on the waiver wire, a CPU club's player
 *   in a trade, a veteran non-roster invitee, an international or independent-
 *   league prospect: a card that names one names a real player object, and
 *   saying yes moves THAT player through the same roster machinery as any
 *   other move.
 *
 *   When the market has nobody who fits (e.g. no veteran shortstop in the free-
 *   agent pool), a card may bring a new player into the world — generated at
 *   the league's talent level, returned from the token pass as a *candidate*,
 *   and added to the free-agent pool only if the card is actually delivered.
 *
 * Pure: never imports StateManager.
 */

import { diceId } from './Dice.js';
import { PLAYER_GROUP, ROSTER_LIMITS, PHASE, MARKET_KINDS, FA_ASK } from '../data/constants.js';
import { clockNow } from './Clock.js';
import { createPlayer, computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import { marketTerms, applyContract, activeCount, displacementFor, hasRoomFor } from './OffseasonEngine.js';
import { defaultActiveGroup, eligibleSlotsFor, makeArrival } from './RosterEngine.js';
import { rosterIsFull, sideOf, dropPlayer } from './TransactionEngine.js';
import { newPlayerName } from './Names.js';
import { writeHistoryForKind } from './LeagueHistory.js';
import { leagueNorms } from './SimEngine.js';

const isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const HITTER_POS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', '2B/SS', '1B/3B'];

/** Market profiles: who a card is looking for. */
export { MARKET_KINDS };   // §122 lives in data/constants.js (the league build reads it too)

/**
 * marketCandidate(state, { kind, side, pos }, exclude)
 * The best real free agent who fits, else a newly generated one (not yet in
 * state — the caller adds it with addToMarket() if the card is delivered).
 * @returns {{ player, generated: Boolean }|null}
 */
export function marketCandidate(state, { kind = 'depth', side = 'hitter', pos = null, minOvr = 0, rand } = {}, exclude = new Set()) {
  const level = state.leagueTalentOffset || 0;
  const prof = MARKET_KINDS[kind] || MARKET_KINDS.depth;
  const year = baseballYear(state);
  const fits = (p) => p && p.group === PLAYER_GROUP.FREE_AGENT && !exclude.has(p.id)
    && isPitcher(p) === (side === 'pitcher')
    && (!pos || (side === 'pitcher' ? p.pos === pos : eligibleSlotsFor(p).includes(pos)))
    && computeAge(p.dob, year) >= prof.ageMin - 1 && computeAge(p.dob, year) <= prof.ageMax + 2
    && (p.ovr || 0) - level >= prof.ovrMin - 3 && (p.ovr || 0) >= minOvr;
  const pool = (state.freeAgentPool || []).map(id => state.players[id]).filter(fits)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  if (pool.length) return { player: pool[0], generated: false };
  const player = generateMarketPlayer(state, { kind, side, pos, minOvr, rand });
  return player ? { player, generated: true } : null;
}

/** A new player at the league's level (not added to state). */
export function generateMarketPlayer(state, { kind = 'depth', side = 'hitter', pos = null, minOvr = 0, rand } = {}) {
  if (typeof rand !== 'function') throw new Error('MarketEngine.generateMarketPlayer: rand is required');
  const level = state.leagueTalentOffset || 0;
  const prof = MARKET_KINDS[kind] || MARKET_KINDS.depth;
  const name = newPlayerName(state.players, rand);   // §82
  if (!name) return null;
  const position = side === 'pitcher' ? (pos === 'SP' || pos === 'RP' ? pos : (rand() < 0.5 ? 'SP' : 'RP'))
    : (pos && pos !== 'DH' ? pos : HITTER_POS[Math.floor(rand() * HITTER_POS.length)]);
  const p = createPlayer({
    id: diceId(rand), name, pos: position,
    group: PLAYER_GROUP.FREE_AGENT,
    hand: side === 'pitcher' ? (rand() < 0.28 ? 'L' : 'R') : null,
    targetOvr: Math.max(minOvr, level + prof.ovrMin + Math.floor(rand() * (prof.ovrMax - prof.ovrMin + 1))),
    rand,
    ageMin: prof.ageMin, ageMax: prof.ageMax,
    seasonNum: state.seasonNum || 1, seasonYear: baseballYear(state),
    contractLengthOverride: 1, teamId: null, leagueLevel: level,
  });
  Object.assign(p, { tier: 'freeAgent', _faFrom: null, _faReason: kind, _marketKind: kind });
  // §122.9 his past in the league (or why he has none).
  writeHistoryForKind(p, { year: baseballYear(state), seasonNum: state.seasonNum || 1, level,
                           norms: leagueNorms([state.userTeam, ...(state.leagueTeams || [])], state.players || {}), rand });
  return p;
}

/** Put a generated candidate into the world (free-agent pool). */
export function addToMarket(draft, player, atMs) {
  if (!player || draft.players[player.id]) return;
  draft.players[player.id] = { ...player, _faSince: atMs };
  draft.freeAgentPool = [...(draft.freeAgentPool || []), player.id];
}

/**
 * What he signs for (§122): a one-year deal at a price that fits his
 * situation — his market value (rating, age, role: OffseasonEngine.marketTerms),
 * less the longer he's gone unsigned (FA_ASK: a few percent a day, to a floor),
 * never below the league minimum. Paid only for the days he's on the roster
 * (salaries accrue by the day — a late-season pickup costs the rest of the season).
 * A young find from scouting (prospect, international, independent league)
 * signs for the minimum over three years, with a signing bonus.
 */
export function signingTerms(state, player) {
  const kind = player._marketKind || 'depth';
  if (kind === 'prospect' || kind === 'intl' || kind === 'indie') {
    const level = state.leagueTalentOffset || 0;
    const bonus = Math.max(25, Math.round(((player.ovr || 45) - level - 30) * 6 / 5) * 5);
    return { salary: FA_ASK.minK, years: 3, bonus };
  }
  const t = marketTerms(state, player);
  const days = Number.isFinite(player._faSince) ? Math.max(0, (clockNow() - player._faSince) / 86_400_000) : 0;
  const share = Math.max(FA_ASK.floorShare, FA_ASK.inSeasonShare - FA_ASK.dropPerDay * Math.floor(days));
  return { salary: Math.max(FA_ASK.minK, Math.round(t.salary * share / 5) * 5), years: 1, bonus: 0 };
}

/**
 * signToClub(draft, playerId, teamId, atMs, { displaceId, terms, startAt, by })
 * A club signs a free agent (§122 the one way any club adds one — the GM, the
 * manager at a deadline, a CPU club). With no room on his side, `displaceId`
 * (or the club's weakest reserve on that side) is dropped first: waivers in
 * season, free agency between seasons. With games on the calendar he reports
 * the next day.
 */
export function signToClub(draft, playerId, teamId, atMs, { displaceId = null, terms = null, startAt = null, by = null } = {}) {
  const p = draft.players[playerId];
  let t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  if (!p || !t || p.group !== PLAYER_GROUP.FREE_AGENT) return [];
  const events = [];
  const pull = () => { draft.freeAgentPool = (draft.freeAgentPool || []).filter(id => id !== playerId); };
  const k = terms || signingTerms(draft, p);
  // No room on his side (the 28 full, or his side's share of it — §76) —
  // make room first, from his side.
  const full = draft.phase === PHASE.OFFSEASON || draft.phase === PHASE.SEASON_SUMMARY
    ? !hasRoomFor(draft, teamId, p)
    : rosterIsFull(draft, teamId, sideOf(p));
  if (full) {
    const out = (displaceId && draft.players[displaceId]) || displacementFor(draft, teamId, p);
    if (out) events.push(dropPlayer(draft, out.id, teamId, atMs, { reason: 'corresponding move' }));
  }
  // (the mutation may replace the club's object — work on the current one)
  t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  for (const s of t.lineupSlots || []) if (s.playerId && !(t.rosterIds || []).includes(s.playerId)) s.playerId = null;
  if (t.rotation?.order) t.rotation.order = t.rotation.order.filter(id => (t.rosterIds || []).includes(id));
  pull();
  if (_gamesOn(draft)) {
    // §89 with games being played he reports like anyone joining a club — the
    // next day — and (signed to start) takes the spot he was signed for then.
    const { tx, patch } = makeArrival({ player: p, teamId, fromTeamId: null, reason: 'signing', atMs, by: by || (teamId === 'user' ? 'gm' : 'cpu') });
    if (startAt) tx.startAt = startAt;
    draft.transactions = [...(draft.transactions || []), tx];
    Object.assign(p, patch, { _faFrom: null, _faSince: null });
  } else {
    t.rosterIds = [...(t.rosterIds || []), playerId];
    Object.assign(p, { teamId, group: defaultActiveGroup(p), tier: 'active', _faFrom: null, _faSince: null });
  }
  applyContract(draft, playerId, k, { startNow: _inSeason(draft) });
  events.push({ type: 'SIGNED', playerId, teamId, atMs });
  return events;
}

// ─────────────────────────────────────────────────────────────
// TRADES — a CPU club's player for one of our prospects (§73; §9.1: no cash)
// ─────────────────────────────────────────────────────────────

/**
 * rentalTarget(state, side, minOvr)
 * A real upgrade a CPU club would move: healthy, on the active roster, of a
 * club out of the race first, at least `minOvr`.
 */
export function rentalTarget(state, side, minOvr = 0, exclude = new Set()) {
  const teams = [...(state.leagueTeams || [])]
    .sort((a, b) => ((a.wins || 0) - (a.losses || 0)) - ((b.wins || 0) - (b.losses || 0)));
  for (const t of teams) {
    const cand = (t.rosterIds || []).map(id => state.players[id])
      .filter(p => p && isAvailable(p) && isPitcher(p) === (side === 'pitcher') && !exclude.has(p.id)
        && (p.ovr || 0) >= minOvr && p.group !== PLAYER_GROUP.IL)
      .sort((a, b) => (a.ovr || 0) - (b.ovr || 0));
    // The cheapest player that's an upgrade — a club out of it sells its depth.
    if (cand.length) return { player: cand[0], team: t };
  }
  return null;
}

/** One of our prospects of about `value` OVR to send back. */
export function prospectToSend(state, targetOvr) {
  // §122 one of our young reserves (no farm): 25 or younger, not a starter.
  const u = state.userTeam, year = baseballYear(state);
  const starters = new Set([...(u.lineupSlots || []).map(x => x.playerId), ...(u.rotation?.order || [])]);
  return (u.rosterIds || []).map(id => state.players[id])
    .filter(p => p && isAvailable(p) && !starters.has(p.id) && p.group !== PLAYER_GROUP.IL && computeAge(p.dob, year) <= 25)
    .sort((a, b) => Math.abs((a.ovr || 0) - targetOvr) - Math.abs((b.ovr || 0) - targetOvr))[0] || null;
}

/** Games are being played (spring, the season, October). */
function _gamesOn(draft) {
  // §96 every phase with games on the calendar (the break and the deadline
  // are the season too; PHASE has no POSTSEASON value — the rounds are named).
  return [PHASE.SPRING_TRAINING, PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE,
          PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES].includes(draft.phase);
}

/** During a season (not between seasons) a new deal covers the current season. */
function _inSeason(draft) {
  return ![PHASE.OFFSEASON, PHASE.SEASON_SUMMARY].includes(draft.phase);
}


