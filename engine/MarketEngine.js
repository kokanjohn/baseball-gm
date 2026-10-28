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

import { PLAYER_GROUP, ROSTER_LIMITS, PHASE } from '../data/constants.js';
import { createPlayer, computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import { marketTerms, applyContract, activeCount, displacementFor, hasRoomFor } from './OffseasonEngine.js';
import { defaultActiveGroup, eligibleSlotsFor } from './RosterEngine.js';
import { rosterIsFull, sideOf } from './TransactionEngine.js';
import { newPlayerName } from './Names.js';

const isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const HITTER_POS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', '2B/SS', '1B/3B'];

/** Market profiles: who a card is looking for. */
export const MARKET_KINDS = Object.freeze({
  veteran:  { ageMin: 30, ageMax: 35, ovrMin: 52, ovrMax: 62 },   // OVR relative to the league level
  depth:    { ageMin: 26, ageMax: 32, ovrMin: 47, ovrMax: 56 },
  prospect: { ageMin: 18, ageMax: 22, ovrMin: 38, ovrMax: 48 },
  intl:     { ageMin: 17, ageMax: 21, ovrMin: 36, ovrMax: 50 },
  indie:    { ageMin: 22, ageMax: 27, ovrMin: 42, ovrMax: 52 },
});

/**
 * marketCandidate(state, { kind, side, pos }, exclude)
 * The best real free agent who fits, else a newly generated one (not yet in
 * state — the caller adds it with addToMarket() if the card is delivered).
 * @returns {{ player, generated: Boolean }|null}
 */
export function marketCandidate(state, { kind = 'depth', side = 'hitter', pos = null, minOvr = 0 } = {}, exclude = new Set()) {
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
  const player = generateMarketPlayer(state, { kind, side, pos, minOvr });
  return player ? { player, generated: true } : null;
}

/** A new player at the league's level (not added to state). */
export function generateMarketPlayer(state, { kind = 'depth', side = 'hitter', pos = null, minOvr = 0 } = {}) {
  const level = state.leagueTalentOffset || 0;
  const prof = MARKET_KINDS[kind] || MARKET_KINDS.depth;
  const name = _newName(state);
  if (!name) return null;
  const position = side === 'pitcher' ? (pos === 'SP' || pos === 'RP' ? pos : (Math.random() < 0.5 ? 'SP' : 'RP'))
    : (pos && pos !== 'DH' ? pos : HITTER_POS[Math.floor(Math.random() * HITTER_POS.length)]);
  const p = createPlayer({
    id: crypto.randomUUID(), name, pos: position,
    group: PLAYER_GROUP.FREE_AGENT,
    hand: side === 'pitcher' ? (Math.random() < 0.28 ? 'L' : 'R') : null,
    targetOvr: Math.max(minOvr, level + prof.ovrMin + Math.floor(Math.random() * (prof.ovrMax - prof.ovrMin + 1))),
    ageMin: prof.ageMin, ageMax: prof.ageMax,
    seasonNum: state.seasonNum || 1, seasonYear: baseballYear(state),
    contractLengthOverride: 1, teamId: null, leagueLevel: level,
  });
  Object.assign(p, { tier: 'freeAgent', _faFrom: null, _faReason: kind, _marketKind: kind });
  return p;
}

/** Put a generated candidate into the world (free-agent pool). */
export function addToMarket(draft, player, atMs) {
  if (!player || draft.players[player.id]) return;
  draft.players[player.id] = { ...player, _faSince: atMs };
  draft.freeAgentPool = [...(draft.freeAgentPool || []), player.id];
}

/** What he signs for: a one-year deal for a veteran; a bonus + 3 years for a prospect. */
export function signingTerms(state, player) {
  const kind = player._marketKind || 'depth';
  if (kind === 'prospect' || kind === 'intl' || kind === 'indie') {
    const level = state.leagueTalentOffset || 0;
    const bonus = Math.max(25, Math.round(((player.ovr || 45) - level - 30) * 6 / 5) * 5);
    return { salary: 50, years: 3, bonus, toFarm: true };
  }
  const t = marketTerms(state, player);
  return { salary: Math.max(50, Math.round(t.salary * 0.8 / 5) * 5), years: 1, bonus: 0, toFarm: false };
}

/**
 * signToClub(draft, playerId, teamId, atMs, { toFarm, displaceId, terms })
 * A club signs a market player. To the active roster (a full 28 options
 * `displaceId` to the farm, or releases him if the farm side is full), or to
 * the farm (farm caps: the farm's weakest prospect of that side is released).
 */
export function signToClub(draft, playerId, teamId, atMs, { toFarm = false, displaceId = null, terms = null } = {}) {
  const p = draft.players[playerId];
  const t = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(x => x.id === teamId);
  if (!p || !t || p.group !== PLAYER_GROUP.FREE_AGENT) return [];
  const events = [];
  const pull = () => { draft.freeAgentPool = (draft.freeAgentPool || []).filter(id => id !== playerId); };
  const k = terms || signingTerms(draft, p);
  if (toFarm) {
    pull();
    t.farmIds = [...(t.farmIds || []), playerId];
    Object.assign(p, { teamId, group: PLAYER_GROUP.PRACTICE_SQUAD, tier: 'farm', _faFrom: null, _faSince: null });
    applyContract(draft, playerId, k, { startNow: _inSeason(draft) });
    events.push({ type: 'SIGNED', playerId, teamId, toFarm: true, atMs });
    events.push(..._farmCap(draft, t, isPitcher(p), atMs, playerId));
    return events;
  }
  // No room on his side (the 28 or the 38-man camp full, or his side's share
  // of it — §76) — make room first, from his side.
  const full = draft.phase === PHASE.OFFSEASON || draft.phase === PHASE.SEASON_SUMMARY
    ? !hasRoomFor(draft, teamId, p)
    : rosterIsFull(draft, teamId, sideOf(p));
  if (full) {
    const out = (displaceId && draft.players[displaceId]) || displacementFor(draft, teamId, p);
    if (out) events.push(..._option(draft, t, out, atMs));
  }
  pull();
  t.rosterIds = [...(t.rosterIds || []), playerId];
  Object.assign(p, { teamId, group: defaultActiveGroup(p), tier: 'active', _faFrom: null, _faSince: null });
  applyContract(draft, playerId, k, { startNow: _inSeason(draft) });
  events.push({ type: 'SIGNED', playerId, teamId, toFarm: false, atMs });
  return events;
}

function _option(draft, t, out, atMs) {
  const side = (t.farmIds || []).filter(id => isPitcher(draft.players[id]) === isPitcher(out)).length;
  const cap = isPitcher(out) ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX;
  t.rosterIds = (t.rosterIds || []).filter(id => id !== out.id);
  for (const s of t.lineupSlots || []) if (s.playerId === out.id) s.playerId = null;
  if (t.rotation?.order) t.rotation.order = t.rotation.order.filter(id => id !== out.id);
  if (side < cap) {
    t.farmIds = [...(t.farmIds || []), out.id];
    Object.assign(out, { group: PLAYER_GROUP.PRACTICE_SQUAD, tier: 'farm' });
    return [{ type: 'OPTIONED', playerId: out.id, teamId: t.id || 'user', atMs }];
  }
  Object.assign(out, { group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent', teamId: null, _faFrom: t.id || 'user', _faSince: atMs });
  draft.freeAgentPool = [...(draft.freeAgentPool || []), out.id];
  return [{ type: 'RELEASED', playerId: out.id, teamId: t.id || 'user', atMs }];
}

function _farmCap(draft, t, pitchers, atMs, keepId) {
  const cap = pitchers ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX;
  const level = draft.leagueTalentOffset || 0;
  const year = baseballYear(draft);
  const side = (t.farmIds || []).map(id => draft.players[id]).filter(x => x && isPitcher(x) === pitchers);
  if (side.length <= cap) return [];
  const cut = side.filter(x => x.id !== keepId)
    .sort((a, b) => ((a.ovr || 0) - level - computeAge(a.dob, year)) - ((b.ovr || 0) - level - computeAge(b.dob, year)))[0];
  if (!cut) return [];
  t.farmIds = t.farmIds.filter(id => id !== cut.id);
  Object.assign(cut, { group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent', teamId: null, _faFrom: t.id || 'user', _faSince: atMs });
  draft.freeAgentPool = [...(draft.freeAgentPool || []), cut.id];
  return [{ type: 'RELEASED', playerId: cut.id, teamId: t.id || 'user', atMs }];
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
  return (state.userTeam.farmIds || []).map(id => state.players[id]).filter(p => p && isAvailable(p))
    .sort((a, b) => Math.abs((a.ovr || 0) - targetOvr) - Math.abs((b.ovr || 0) - targetOvr))[0] || null;
}

/** During a season (not between seasons) a new deal covers the current season. */
function _inSeason(draft) {
  return ![PHASE.OFFSEASON, PHASE.SEASON_SUMMARY].includes(draft.phase);
}

/** §82 */
function _newName(state) {
  return newPlayerName(state.players);
}
