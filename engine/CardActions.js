/**
 * engine/CardActions.js
 * What a decision card actually does (§71–72).
 *
 * Every card action is one entry: { feasible(state, card), apply(draft, card, atMs) }.
 *   feasible — can it still happen? Checked when the card would be delivered
 *              (an impossible card is never sent) and on every clock step
 *              (a card that can no longer apply is withdrawn, never a ghost).
 *   apply    — carries it out on the draft through the engines that own the
 *              data (DevelopmentEngine, TransactionEngine, RosterEngine,
 *              OffseasonEngine). Returns events.
 *
 * A card names its players through tokens; `card._targetPlayerId` is the first
 * player its text names and `card._tokenPlayers` holds every role it named
 * (e.g. prospect_hitter, drop_hitter, audition_hitter).
 *
 * Pure: never imports StateManager. CardEngine applies inside mutate().
 */

import { PLAYER_GROUP, PHASE, ROSTER_LIMITS } from '../data/constants.js';
import { isAvailable } from './PlayerFactory.js';
import { setUnavailable, setCondition, startPlan } from './DevelopmentEngine.js';
import { callUp, rosterIsFull } from './TransactionEngine.js';
import { sendToFarm, applyRosterMutation, eligibleSlotsFor, defaultActiveGroup } from './RosterEngine.js';
import { marketTerms, contractIsUp } from './OffseasonEngine.js';

const isPitcher = (p) => ['SP', 'RP'].includes(p?.pos);
const ours = (st, id) => !!id && (st.userTeam.rosterIds || []).includes(id) && st.players[id]?.teamId === 'user';
const role = (card, r) => card._tokenPlayers?.[r] || null;
const starting = (st) => new Set((st.userTeam.lineupSlots || []).map(s => s.playerId).filter(Boolean));
const slotOf = (st, id) => (st.userTeam.lineupSlots || []).findIndex(s => s.playerId === id);
const REGULAR = new Set([PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE]);

// ─────────────────────────────────────────────────────────────
// COVERAGE
// ─────────────────────────────────────────────────────────────

/**
 * canSpare(state, playerId)
 * Could the club play without him for a few games? A hitter needs a healthy
 * bench bat; a starter, five other healthy starters (rotation or bench); a
 * reliever, four other healthy arms.
 */
export function canSpare(state, playerId) {
  const u = state.userTeam;
  const p = state.players[playerId];
  if (!p) return false;
  const mine = (u.rosterIds || []).map(id => state.players[id]).filter(x => x && x.id !== playerId && isAvailable(x));
  if (!isPitcher(p)) {
    const st = starting(state);
    return mine.some(x => x.group === PLAYER_GROUP.BENCH_HITTERS && !st.has(x.id));
  }
  if (p.pos === 'SP' && p.group === PLAYER_GROUP.STARTING_PITCHERS) {
    return mine.filter(x => x.pos === 'SP' && [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.PITCHER_BENCH].includes(x.group)).length >= 5;
  }
  return mine.filter(x => [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(x.group)).length >= 4;
}

const awayOk = (st, c) => {
  const p = st.players[c._targetPlayerId];
  return ours(st, c._targetPlayerId) && isAvailable(p) && canSpare(st, p.id);
};

// ─────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────

const away = (reasonOf, defaultGames) => ({
  feasible: awayOk,
  apply(d, c, atMs) {
    const raw = c._raw || {};
    const reason = reasonOf(raw);
    const games = c._actionGames || raw._restGames || defaultGames;
    return [setUnavailable(d, c._targetPlayerId, { reason, games }, atMs)].filter(Boolean);
  },
});

const restReason = (raw) => raw.tag === 'DISCIPLINE' ? 'suspended' : raw.tag === 'HEALTH' ? 'illness' : 'rest';

const train = {
  feasible: awayOk,
  apply(d, c, atMs) {
    const raw = c._raw || {};
    const id = c._targetPlayerId;
    return [
      setUnavailable(d, id, { reason: 'training', games: raw._trainGames || 3 }, atMs),
      startPlan(d, id, { gain: raw._trainGain || 2, focus: raw._trainFocus || null, source: c.cardId }, atMs)
        && { type: 'DEV_STARTED', playerId: id },
    ].filter(Boolean);
  },
};

/** In-season extension: the new deal starts when the current one ends. */
const extend = {
  feasible: (st, c) => {
    const p = st.players[c._targetPlayerId];
    return ours(st, c._targetPlayerId) && contractIsUp(p, st.seasonNum || 1) && !p.pendingContract && !p._willWalk;
  },
  apply(d, c) {
    const p = d.players[c._targetPlayerId];
    const t = marketTerms(d, p);
    p.pendingContract = { salary: t.salary, years: t.years, signedSeason: d.seasonNum || 1 };
    return [{ type: 'EXTENDED', playerId: p.id, terms: t }];
  },
};

/** No extension: he plays out the season and leaves as a free agent. */
const letWalk = {
  feasible: extend.feasible,
  apply(d, c) {
    const p = d.players[c._targetPlayerId];
    p._willWalk = true;
    return [{ type: 'WILL_WALK', playerId: p.id }];
  },
};

/** Spring: a farm player is flagged for the Opening Day roster (joins camp as a keeper). */
const springFlag = (r) => ({
  feasible: (st, c) => {
    const id = role(c, r);
    const p = st.players[id];
    if (st.phase !== PHASE.SPRING_TRAINING || !p || !isAvailable(p)) return false;
    return (st.userTeam.farmIds || []).includes(id) ? !rosterIsFull(st, 'user') : ours(st, id);
  },
  apply(d, c) {
    const id = role(c, r);
    const p = d.players[id];
    const u = d.userTeam;
    if ((u.farmIds || []).includes(id)) {
      u.farmIds = u.farmIds.filter(x => x !== id);
      u.rosterIds = [...u.rosterIds, id];
      Object.assign(p, { group: defaultActiveGroup(p), tier: 'active', _isSpringInvitee: true, _farmArc: null });
    }
    p._isKeeper = true;
    return [{ type: 'SPRING_FLAGGED', playerId: id }];
  },
});

/** The farm's best bat is called up; the weakest bench bat goes down if the 28 is full. */
const callupHitter = {
  feasible: (st, c) => {
    const id = role(c, 'prospect_hitter');
    if (!REGULAR.has(st.phase) || !(st.userTeam.farmIds || []).includes(id) || !isAvailable(st.players[id])) return false;
    return !rosterIsFull(st, 'user') || ours(st, role(c, 'drop_hitter'));
  },
  apply(d, c, atMs) {
    const events = [];
    const down = role(c, 'drop_hitter');
    if (rosterIsFull(d, 'user') && down) {
      applyRosterMutation(d, sendToFarm(d, down, 'user'));
      events.push({ type: 'OPTIONED', playerId: down, teamId: 'user', atMs });
    }
    const res = callUp(d, role(c, 'prospect_hitter'), 'user', atMs, 'gm');
    if (res.ok) events.push({ type: 'CALLED_UP', playerId: role(c, 'prospect_hitter'), tx: res.tx });
    return events;
  },
};

/** A bench bat takes the named starter's lineup spot (the starter sits). */
const audition = {
  feasible: (st, c) => {
    const s = c._targetPlayerId, b = role(c, 'audition_hitter');
    const i = slotOf(st, s);
    return ours(st, s) && ours(st, b) && i >= 0 && isAvailable(st.players[b]) && !starting(st).has(b)
      && eligibleSlotsFor(st.players[b]).includes(st.userTeam.lineupSlots[i].slot);
  },
  apply(d, c) {
    const i = slotOf(d, c._targetPlayerId);
    d.userTeam.lineupSlots[i].playerId = role(c, 'audition_hitter');
    delete d.userTeam.lineupSlots[i].emergency;
    return [{ type: 'LINEUP_CHANGE', playerId: role(c, 'audition_hitter'), replaced: c._targetPlayerId }];
  },
};

/** The named fielder becomes the DH; the DH (or the best bench option) takes his spot. */
const moveToDH = {
  feasible: (st, c) => {
    const id = c._targetPlayerId;
    const i = slotOf(st, id);
    const slots = st.userTeam.lineupSlots || [];
    if (!ours(st, id) || i < 0 || slots[i].slot === 'DH') return false;
    return !!_dhReplacement(st, slots[i].slot);
  },
  apply(d, c) {
    const slots = d.userTeam.lineupSlots;
    const id = c._targetPlayerId;
    const i = slotOf(d, id);
    const dhI = slots.findIndex(s => s.slot === 'DH');
    const rep = _dhReplacement(d, slots[i].slot);
    slots[dhI].playerId = id;
    slots[i].playerId = rep.id;
    delete slots[i].emergency; delete slots[dhI].emergency;
    return [{ type: 'LINEUP_CHANGE', playerId: id, slot: 'DH' }];
  },
};
function _dhReplacement(st, slot) {
  const dh = (st.userTeam.lineupSlots || []).find(s => s.slot === 'DH')?.playerId;
  const cur = st.players[dh];
  if (cur && isAvailable(cur) && eligibleSlotsFor(cur).includes(slot)) return cur;
  const sts = starting(st);
  return (st.userTeam.rosterIds || []).map(id => st.players[id])
    .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS && !sts.has(p.id) && isAvailable(p) && eligibleSlotsFor(p).includes(slot))
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
}

/** A reliever with a starter's stamina joins the rotation; the weakest starter goes to the pen. */
const bpToRotation = {
  feasible: (st, c) => {
    const p = st.players[c._targetPlayerId];
    return ours(st, p?.id) && isAvailable(p) && p.group === PLAYER_GROUP.BULLPEN
      && (p.subRatings?.stamina || 0) >= 55 && (st.userTeam.rotation?.order || []).length >= 1;
  },
  apply(d, c) {
    const p = d.players[c._targetPlayerId];
    const order = d.userTeam.rotation.order;
    const out = order.map(id => d.players[id]).filter(Boolean).sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
    if (out) {
      order[order.indexOf(out.id)] = p.id;
      Object.assign(out, { group: PLAYER_GROUP.BULLPEN, pos: 'RP' });
    } else order.push(p.id);
    Object.assign(p, { group: PLAYER_GROUP.STARTING_PITCHERS, pos: 'SP' });
    return [{ type: 'ROLE_CHANGE', playerId: p.id, to: 'SP', replaced: out?.id || null }];
  },
};

const sickStart = {
  feasible: (st, c) => ours(st, c._targetPlayerId) && isAvailable(st.players[c._targetPlayerId]),
  apply: (d, c) => [setCondition(d, c._targetPlayerId, { subRating: 'stuff', amount: 5, games: 1, reason: 'sick' })].filter(Boolean),
};

export const CARD_ACTIONS = Object.freeze({
  rest_active_hitter:   away(restReason, 1),
  bench_active_pitcher: away(restReason, 1),
  bench_active_hitter:  away((raw) => raw.tag === 'DISCIPLINE' ? 'suspended' : raw.tag === 'HEALTH' ? 'illness' : 'benched', 2),
  train_hitter:         train,
  train_pitcher_sp:     train,
  train_pitcher_bp:     train,
  ill2_sick_start:      sickStart,
  retain_active_pitcher: extend,
  retain_active_hitter:  extend,
  release_active_pitcher: letWalk,
  release_active_hitter:  letWalk,
  sp11_callup:          springFlag('farm_pitcher'),
  sp11b_callup:         springFlag('farm_hitter'),
  callup_hitter:        callupHitter,
  audition_promote:     audition,
  move_to_dh:           moveToDH,
  move_bp_to_rotation:  bpToRotation,
});

/** Can this card's choices all still happen? (no handler = not ours to judge) */
export function cardFeasible(state, card) {
  const raw = card._raw || card;
  return [raw.onYes].filter(a => a && CARD_ACTIONS[a]).every(a => CARD_ACTIONS[a].feasible(state, card));
}

