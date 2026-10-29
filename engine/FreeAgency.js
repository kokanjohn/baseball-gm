/**
 * engine/FreeAgency.js
 * §96 The players no club has: the waiver wire (72 hours, claimed in reverse
 * order of the standings) and the free agents. The League screen lists them;
 * the GM can put in a claim or sign one, and — when the incoming player's
 * side of the 28 is full — chooses who goes down to make room.
 *
 * Pure: takes state, returns answers or mutates a draft it is given.
 * GameEngine.gmSignFreeAgent / gmClaimOffWaivers carry the moves out.
 */

import { PLAYER_GROUP, PHASE, ROSTER_LIMITS, WAIVER_CLAIM_WINDOW_MS } from '../data/constants.js';
import * as Finance from './FinanceEngine.js';
import { signingTerms, signToClub } from './MarketEngine.js';
import { marketTerms, hasRoomFor, signFreeAgent } from './OffseasonEngine.js';
import { rosterIsFull, sideOf } from './TransactionEngine.js';

const isP = (p) => ['SP', 'RP'].includes(p?.pos);
const REGULAR = new Set([PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE]);
const POSTSEASON = new Set([PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);

/** Players on waivers right now, newest first. */
export function waiverList(state) {
  return (state.waiverPool || []).map(id => state.players[id])
    .filter(p => p && p.onWaivers)
    .sort((a, b) => (b.waiverStartTime || 0) - (a.waiverStartTime || 0));
}

/** Free agents on the market right now. */
export function freeAgentList(state) {
  return (state.freeAgentPool || []).map(id => state.players[id])
    .filter(p => p && p.group === PLAYER_GROUP.FREE_AGENT);
}

/** When a waiver claim window closes. */
export function waiverEndsAt(p) {
  return (p?.waiverStartTime || 0) + WAIVER_CLAIM_WINDOW_MS;
}

const offseason = (state) => state.phase === PHASE.OFFSEASON || state.phase === PHASE.SEASON_SUMMARY;

/**
 * The terms a free agent signs for with us: the market ask in the offseason
 * (§70), a short in-season deal otherwise (§73). Prospects sign to the farm
 * with a bonus.
 */
export function termsFor(state, p) {
  if (offseason(state)) return { ...(p._ask || marketTerms(state, p)), toFarm: false, bonus: 0 };
  return signingTerms(state, p);
}

/**
 * roomFor(state, p, { farm }) — does the player need someone to go down, and
 * who could? { needsDrop, candidates: [{ player, starter, outcome }] }.
 * Candidates are our active players on his side (pitcher for a pitcher,
 * hitter for a hitter — §76), healthy or not, weakest first. `outcome` says
 * what happens to each: { kind: 'farm' | 'released', waives? } — to the farm,
 * or (farm side full) what that costs.
 */
export function roomFor(state, p, { toFarm = false } = {}) {
  if (!p || toFarm) return { needsDrop: false, candidates: [] };
  const needsDrop = offseason(state) ? !hasRoomFor(state, 'user', p) : rosterIsFull(state, 'user', sideOf(p));
  const u = state.userTeam;
  const starters = new Set([...(u.lineupSlots || []).map(s => s.playerId), ...(u.rotation?.order || [])]);
  const farmSide = (u.farmIds || []).map(id => state.players[id]).filter(x => x && isP(x) === isP(p));
  const farmFull = farmSide.length >= (isP(p) ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX);
  const weakestFarm = farmSide.sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
  // farm: he goes down; released: farm full in the offseason (no waivers run
  // then — OffseasonEngine.signFreeAgent); waives: farm full in season, so
  // the farm's weakest on his side goes on waivers (RosterEngine.sendToFarm).
  const outcome = !farmFull ? { kind: 'farm' }
    : offseason(state) ? { kind: 'released' }
    : weakestFarm ? { kind: 'farm', waives: weakestFarm.name } : { kind: 'farm' };
  const candidates = (u.rosterIds || []).map(id => state.players[id])
    .filter(x => x && isP(x) === isP(p) && x.group !== PLAYER_GROUP.IL && x.group !== PLAYER_GROUP.IN_TRANSIT)
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))
    .map(x => ({ player: x, starter: starters.has(x.id), outcome }));
  return { needsDrop, candidates, farmFull, weakestFarm: weakestFarm || null };
}

/** Is `dropId` someone who can go down for `p`? */
function _validDrop(state, p, dropId) {
  return roomFor(state, p).candidates.some(c => c.player.id === dropId);
}

/** Salary our owner must approve: his salary, less a dropped player's on a minor-league deal (§78). */
function _affords(state, salaryK, dropId) {
  const d = dropId ? state.players[dropId] : null;
  const outK = d && !d.contractMLB ? (d.contractSalary || 0) : 0;
  return Finance.canAddSalary(state, salaryK, outK);
}

/** Why we can't sign this free agent right now (null when we can). */
export function signBlocker(state, playerId, dropId = null) {
  const p = state.players[playerId];
  if (!p || p.group !== PLAYER_GROUP.FREE_AGENT) return 'not a free agent any more';
  if (POSTSEASON.has(state.phase)) return 'rosters are set for the postseason — signings open again in the offseason';
  const t = termsFor(state, p);
  const room = roomFor(state, p, { toFarm: !!t.toFarm });
  if (room.needsDrop && !dropId) return 'choose a player to send down to make room';
  if (room.needsDrop && !_validDrop(state, p, dropId)) return 'that player can\'t go down to make room';
  if (!t.toFarm && !_affords(state, t.salary || 0, room.needsDrop ? dropId : null)) return 'ownership won\'t approve the added payroll';
  if (t.bonus && !Finance.canSpend(state, t.bonus)) return 'club funds can\'t cover the signing bonus';
  return null;
}

/** Why we can't put in a claim on this player (null when we can). */
export function claimBlocker(state, playerId, dropId = null, nowMs = Date.now()) {
  const p = state.players[playerId];
  if (!p || !p.onWaivers || !(state.waiverPool || []).includes(playerId)) return 'no longer on waivers';
  if (p._waivedBy === 'user') return 'we put this player on waivers';
  if (waiverEndsAt(p) <= nowMs) return 'the claim window has closed';
  const room = roomFor(state, p);
  if (room.needsDrop && !dropId) return 'choose a player to send down if the claim is awarded';
  if (room.needsDrop && !_validDrop(state, p, dropId)) return 'that player can\'t go down to make room';
  if (!_affords(state, p.contractSalary || 0, room.needsDrop ? dropId : null)) return 'ownership won\'t approve the added payroll';
  return null;
}

/**
 * sign(draft, playerId, atMs, dropId) — we sign a free agent. The player we
 * chose goes down first if his side is full. Returns events. Mutates draft.
 */
export function sign(draft, playerId, atMs, dropId = null) {
  const p = draft.players[playerId];
  const t = termsFor(draft, p);
  const events = [];
  if (offseason(draft)) {
    const r = signFreeAgent(draft, playerId, 'user', atMs, { displaceId: dropId });
    if (r) events.push(...(Array.isArray(r) ? r : [r]));
  } else {
    events.push(...signToClub(draft, playerId, 'user', atMs, { toFarm: !!t.toFarm, displaceId: dropId, terms: t }));
  }
  if (t.bonus) Finance.post(draft.userTeam.finances, -t.bonus, 'bonus', `Signing bonus — ${p.name}`, atMs);
  return events;
}

/**
 * claim(draft, playerId, dropId) — we put in a claim. It's decided when the
 * window closes, in claiming order (TransactionEngine._resolveWaiver); if it's
 * ours, `dropId` goes down to make room then. Mutates draft.
 */
export function claim(draft, playerId, dropId = null) {
  const p = draft.players[playerId];
  if (!p) return;
  p._userClaim = true;
  p._userClaimDrop = dropId || null;
}

/** We take back a claim before the window closes. */
export function withdrawClaim(draft, playerId) {
  const p = draft.players[playerId];
  if (!p) return;
  p._userClaim = false;
  p._userClaimDrop = null;
}

export { REGULAR as REGULAR_PHASES };
