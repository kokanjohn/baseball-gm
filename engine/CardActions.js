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
import { callUp, rosterIsFull, sideOf } from './TransactionEngine.js';
import { sendToFarm, applyRosterMutation, eligibleSlotsFor, defaultActiveGroup, computePayroll } from './RosterEngine.js';
import { marketTerms, contractIsUp } from './OffseasonEngine.js';
import { signToClub, signingTerms } from './MarketEngine.js';
import { queueTrade } from './TradeEngine.js';

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
    return (st.userTeam.farmIds || []).includes(id) ? !rosterIsFull(st, 'user', sideOf(p)) : ours(st, id);
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
    // Room for a bat — now, or once the weakest bench bat goes down.
    const down = role(c, 'drop_hitter');
    return !rosterIsFull(st, 'user', 'hitter') || (ours(st, down) && !rosterIsFull(st, 'user', 'hitter', { excluding: down }));
  },
  apply(d, c, atMs) {
    const events = [];
    const down = role(c, 'drop_hitter');
    if (rosterIsFull(d, 'user', 'hitter') && down) {
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

// ─────────────────────────────────────────────────────────────
// OUTSIDE PLAYERS (§73)
// ─────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const TRIP_FOLLOW_THROUGH_K = 300;   // a workout plus a typical international bonus
const isFA = (st, id) => st.players[id]?.group === PLAYER_GROUP.FREE_AGENT;

// Money is the real limit on adding players (§74): salaries must fit under the
// payroll cap (a player optioned to make room comes off it), bonuses under the
// operating budget that's left.
const payrollRoom = (st) => (st.userTeam.finances?.payrollCap || 0) - computePayroll(st);
const opRoom = (st) => (st.userTeam.finances?.operatingBudget || 0) - (st.userTeam.finances?.operatingSpent || 0);
const salaryOf = (st, id) => st.players[id]?.contractSalary || 0;
// Room on the incoming player's side (§76); a player who goes down to make it frees his salary.
const affords = (st, addK, outId = null, side = null) => addK <= payrollRoom(st) + (outId && fullFor(st, side) ? salaryOf(st, outId) : 0);
const fullFor = (st, side = null) => rosterIsFull(st, 'user', side);
const between = (lo, hi) => lo + Math.random() * (hi - lo);

/** A veteran who wants to start: signs, takes the weak starter's spot; the weakest bench bat goes down. */
const signStarter = {
  feasible: (st, c) => isFA(st, role(c, 'acq_hitter')) && REGULAR_OR_SPRING.has(st.phase)
    && (!fullFor(st, 'hitter') || (ours(st, role(c, 'drop_hitter')) && !rosterIsFull(st, 'user', 'hitter', { excluding: role(c, 'drop_hitter') })))
    && affords(st, signingTerms(st, st.players[role(c, 'acq_hitter')]).salary, role(c, 'drop_hitter'), 'hitter'),
  apply(d, c, atMs) {
    const id = role(c, 'acq_hitter');
    const events = signToClub(d, id, 'user', atMs, { displaceId: role(c, 'drop_hitter') });
    const p = d.players[id];
    const i = (d.userTeam.lineupSlots || []).findIndex(s => s.slot === p?._startAt && s.playerId === role(c, 'replaced_starter'));
    if (i >= 0 && eligibleSlotsFor(p).includes(d.userTeam.lineupSlots[i].slot)) d.userTeam.lineupSlots[i].playerId = id;
    if (p) p._startAt = undefined;
    return events;
  },
};

/** A prospect signs a bonus and reports to the farm. */
const signProspect = (r) => ({
  feasible: (st, c) => isFA(st, role(c, r))
    && (c.cardId === 'sc3_fail' || (signingTerms(st, st.players[role(c, r)]).bonus || 0) <= opRoom(st)),
  apply(d, c, atMs) {
    const id = role(c, r);
    const t = signingTerms(d, d.players[id]);
    const ev = signToClub(d, id, 'user', atMs, { toFarm: true, terms: t });
    if (c.cardId !== 'sc3_fail') d.userTeam.finances.operatingSpent = (d.userTeam.finances.operatingSpent || 0) + (t.bonus || 0);
    return ev;
  },
});

/** A released veteran signs a short deal and joins the active roster. */
const signReleased = {
  feasible: (st, c) => isFA(st, role(c, 'dfa_player')) && REGULAR_OR_SPRING.has(st.phase)
    && affords(st, signingTerms(st, st.players[role(c, 'dfa_player')]).salary),
  apply: (d, c, atMs) => signToClub(d, role(c, 'dfa_player'), 'user', atMs),
};

/** A waiver claim: resolved when the 72-hour window closes, by claiming order (§20.2). */
const claimWaivers = {
  feasible: (st, c) => {
    const p = st.players[role(c, 'dfa_player')];
    return !!p && (st.waiverPool || []).includes(p.id) && p._waivedBy !== 'user' && !p._userClaim
      && affords(st, p.contractSalary || 0);
  },
  apply(d, c) {
    d.players[role(c, 'dfa_player')]._userClaim = true;
    return [{ type: 'WAIVER_CLAIM_ENTERED', playerId: role(c, 'dfa_player') }];
  },
};

/** A CPU club's player for one of our prospects — through the trade ledger (§65). */
const tradeFor = {
  feasible: (st, c) => {
    const o = c._offer;
    if (!o || st.phase === PHASE.SPRING_TRAINING) return false;
    const team = (st.leagueTeams || []).find(t => t.id === o.proposingTeamId);
    const inK  = o.incomingIds.reduce((a, id) => a + salaryOf(st, id), 0);
    const outK = o.outgoingIds.filter(id => ours(st, id)).reduce((a, id) => a + salaryOf(st, id), 0);
    return !!team && o.incomingIds.every(id => team.rosterIds.includes(id) && isAvailable(st.players[id]))
      && o.outgoingIds.every(id => (st.userTeam.farmIds || []).includes(id) || ours(st, id))
      && affords(st, inK - outK);
  },
  apply(d, c, atMs) {
    d.transactions = [...(d.transactions || []), queueTrade(c._offer, c._offer.proposingTeamId, atMs)];
    return [{ type: 'TRADE_QUEUED', offer: c._offer }];
  },
};

/** Spring: a non-roster invitee joins camp to compete for a job. */
const inviteNRI = {
  feasible: (st, c) => st.phase === PHASE.SPRING_TRAINING && isFA(st, role(c, 'nri')) && !rosterIsFull(st, 'user', sideOf(st.players[role(c, 'nri')])),
  apply(d, c, atMs) {
    const id = role(c, 'nri');
    const ev = signToClub(d, id, 'user', atMs, { terms: { salary: 75, years: 1 } });
    if (d.players[id]) d.players[id]._isSpringInvitee = true;
    return ev;
  },
};

/** A workout: the result comes in 3–5 days — good or a disappointment. */
const workout = {
  // Don't fly a player in we couldn't afford to sign afterwards.
  feasible: (st, c) => isFA(st, role(c, 'intl_player'))
    && (signingTerms(st, st.players[role(c, 'intl_player')]).bonus || 0) <= opRoom(st) - (c._budgetCost || 0),
  apply(d, c, atMs) {
    const id = role(c, 'intl_player');
    const p = d.players[id];
    const rel = (p.ovr || 45) - (d.leagueTalentOffset || 0);
    const good = Math.random() < (rel >= 44 ? 0.7 : 0.35);
    p._workout = good ? 'impressed' : 'disappointed';
    return [{ type: 'SCHEDULE_CARD', defId: good ? 'sc3_sign' : 'sc3_fail', preset: { intl_player: id }, atMs: atMs + between(3, 5) * DAY }];
  },
};

/** An international scouting trip: 1–2 workout leads over the next week. */
const intlTrip = {
  // A trip only makes sense if there'd be money left to fly a lead in and sign him.
  feasible: (st, c) => opRoom(st) - (c._budgetCost || 0) >= TRIP_FOLLOW_THROUGH_K,
  apply(d, c, atMs) {
    const n = 1 + (Math.random() < 0.5 ? 1 : 0);
    return Array.from({ length: n }, (_, i) => ({ type: 'SCHEDULE_CARD', defId: 'sc3', preset: { _country: c._intlCountry },
                                                  atMs: atMs + between(2 + i * 2, 4 + i * 2) * DAY }));
  },
};

/** An independent-league tip: the scout's report arrives in 2–4 days. */
const indieTip = {
  feasible: (st, c) => isFA(st, role(c, 'indie_player')),
  apply: (d, c, atMs) => [{ type: 'SCHEDULE_INDIE', playerId: role(c, 'indie_player'), atMs: atMs + between(2, 4) * DAY }],
};

const indieSign = {
  feasible: (st, c) => isFA(st, c._targetPlayerId) && (signingTerms(st, st.players[c._targetPlayerId]).bonus || 0) <= opRoom(st),
  apply(d, c, atMs) {
    const t = signingTerms(d, d.players[c._targetPlayerId]);
    d.userTeam.finances.operatingSpent = (d.userTeam.finances.operatingSpent || 0) + (t.bonus || 0);
    return signToClub(d, c._targetPlayerId, 'user', atMs, { toFarm: true, terms: t });
  },
};

const REGULAR_OR_SPRING = new Set([...REGULAR, PHASE.SPRING_TRAINING]);

// ─────────────────────────────────────────────────────────────
// LIFE, THE BALLPARK AND THE FRONT OFFICE (§74)
// ─────────────────────────────────────────────────────────────

/** Personal leave: he goes either way — the choice sets how long and how it lands. */
const personalLeave = {
  feasible: (st, c) => ours(st, c._targetPlayerId) && isAvailable(st.players[c._targetPlayerId]),
  apply(d, c, atMs) {
    const raw = c._raw || {};
    const games = (c.choice === 'no' ? raw._leaveGamesNo : raw._leaveGamesYes) || raw.leaveGames || 3;
    return [setUnavailable(d, c._targetPlayerId, { reason: 'leave', games }, atMs)].filter(Boolean);
  },
};

/** Stadium staff out sick and nobody hired: how the night goes. */
const staffShort = (what) => ({
  feasible: () => true,
  apply(d) {
    const u = d.userTeam;
    const roll = Math.random();
    const clamp = (v) => Math.max(0, Math.min(100, v));
    if (what === 'crew') {
      if (roll < 0.55) { u.groundskeeperRelationship = clamp((u.groundskeeperRelationship || 50) + 2); return [{ type: 'STAFF_NIGHT', what, ok: true }]; }
      u.atmosphere = clamp((u.atmosphere || 50) - 2); return [{ type: 'STAFF_NIGHT', what, ok: false }];
    }
    if (what === 'pa' && roll < 0.2) { u.atmosphere = clamp((u.atmosphere || 50) + 2); return [{ type: 'STAFF_NIGHT', what, ok: true }]; }
    u.atmosphere = clamp((u.atmosphere || 50) - (what === 'mascot' ? 2 : 1));
    return [{ type: 'STAFF_NIGHT', what, ok: false }];
  },
});

/** The media tour (or a scouting budget cut) costs scouting leads for a while. */
const scoutingQuiet = (days, refund = false) => ({
  feasible: () => true,
  apply(d, c, atMs) {
    d.userTeam.scoutingQuietUntil = Math.max(d.userTeam.scoutingQuietUntil || 0, atMs + days * DAY);
    if (refund) {
      const saved = c._amountsK?.misc_cost_lg || 0;
      d.userTeam.finances.operatingSpent = Math.max(0, (d.userTeam.finances.operatingSpent || 0) - saved);
    }
    return [{ type: 'SCOUTING_QUIET', untilMs: d.userTeam.scoutingQuietUntil }];
  },
});

export const CARD_ACTIONS = Object.freeze({
  sign_acquire_hitter:   signStarter,
  sign_veteran_hitter:   signStarter,
  sign_acquire_pitcher:  signProspect('acq_pitcher'),
  sign_prospect_pitcher: signProspect('acq_pitcher'),
  sign_intl_player:      signProspect('intl_player'),
  sign_intl_flyer:       signProspect('intl_player'),
  sign_dfa:              signReleased,
  waiver_dfa:            claimWaivers,
  trade_acquire_pitcher: tradeFor,
  trade_acquire_hitter:  tradeFor,
  dl3_acquire:           tradeFor,
  sp15_callup:           inviteNRI,
  intl_workout:          workout,
  scouting_intl_trip:    intlTrip,
  scouting_indie_tip:    indieTip,
  indie_sign:            indieSign,
  sr2_shakeup:           callupHitter,
  personal_leave:        personalLeave,
  ill5a_crew:            staffShort('crew'),
  ill5b_mascot:          staffShort('mascot'),
  ill5c_pa:              staffShort('pa'),
  media_boost:           scoutingQuiet(2),
  media_suppress:        { feasible: () => true, apply: () => [] },
  scouting_suppress:     scoutingQuiet(8, true),
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

