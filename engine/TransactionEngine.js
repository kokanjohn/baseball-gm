/**
 * engine/TransactionEngine.js
 * The roster clock (§65). Every roster move in the league — trades, farm
 * call-ups, IL eligibility, day-to-day returns, the GM's decision deadline —
 * happens here, in real-time order, for all ten teams.
 *
 * THE ROSTER CLOCK
 *   rosterClock(state, now) = min(now, first pitch of the next game not yet
 *   played). The clock never runs past a game that hasn't been played, so:
 *     - nothing changes a roster in the middle of a game (a trade accepted in
 *       the 6th inning executes after the final out);
 *     - when the app was closed for days, games and roster moves are replayed
 *       in the order they really happened (each game is simulated with the
 *       roster it would actually have had).
 *
 * THE LEDGER — state.transactions
 *   'trade'   → executes at effectiveAt: every player in the deal leaves his
 *               roster and goes IN_TRANSIT (a real player is never on two
 *               rosters, and never on none without a ledger record).
 *   'arrival' → the player reports at effectiveAt (local midnight after the
 *               move) and joins the active roster.
 *
 * ROSTER NEEDS are DERIVED (getRosterNeeds), never stored: the Team screen's
 * dashed cards and the inbox call-up messages read the same function, so the
 * two can never disagree and a message whose need is gone is withdrawn.
 *
 * Rules:
 *   - Never imports StateManager. applyDue(draft, …) mutates the draft the
 *     caller hands it (inside the caller's StateManager.mutate), the same
 *     contract as RosterEngine.applyRosterMutation.
 *   - All times are real ms. Callers pass them in; nothing here reads Date.now().
 */

import {
  PLAYER_GROUP,
  PHASE,
  ROSTER_LIMITS,
  ROSTER_DECISION_LEAD_MS,
  MANAGER_FILL_PENALTY,
  TRANSACTION_HISTORY_KEEP,
  GM_RELATIONSHIP_DEFAULT,
  WAIVER_CLAIM_WINDOW_MS,
  FARM_DEPTH_FLOOR_HITTERS,
  FARM_DEPTH_FLOOR_PITCHERS,
  FARM_PITCHER_MIN_SP,
  FARM_PITCHER_MIN_RP,
  SALARY_BY_OVR,
  GAME_STATUS as _GS,
  GAME_DURATION_FALLBACK_MS as _GAME_FALLBACK_MS,
} from '../data/constants.js';

import {
  reconcileRoster,
  applyRosterMutation,
  eligibleSlotsFor,
  defaultActiveGroup,
  pendingArrivals,
  makeArrival,
  clearWaivers,
  sendToFarm,
  HITTER_TARGET,
  PITCHER_TARGET,
} from './RosterEngine.js';

import { cpuWaiverClaimant } from './LeagueEngine.js';

import { tradePlayerPatches } from './TradeEngine.js';
import { payrollRoom, contractToMove, cutOrderAmount, post as postFunds, retainSalary } from './FinanceEngine.js';
import { adjustRapport } from './TradeEngine.js';
import { releaseToFreeAgency } from './OffseasonEngine.js';
import { clearInjuryUpdate, confirmDiagnosis, dayToDayUpdate } from './InjuryEngine.js';
import { computeAge, createPlayer, baseballYear } from './PlayerFactory.js';
import { newPlayerName } from './Names.js';

const MS_PER_DAY = 86_400_000;
const isPitcher  = (p) => ['SP', 'RP'].includes(p?.pos);

// Phases in which the 28-man rule (and so roster needs) applies.
const CAP_PHASES = new Set([
  PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE,
  PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND,
  PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES,
]);

// ─────────────────────────────────────────────────────────────
// CLOCK
// ─────────────────────────────────────────────────────────────

/** The first scheduled game that has not been committed yet (or null). */
export function nextUnplayedGame(state) {
  const sched = state?.schedule || [];
  for (let i = state?.currentGameIndex || 0; i < sched.length; i++) {
    const g = sched[i];
    if (g && !g._committed && Number.isFinite(g.gameTime)) return g;
  }
  return null;
}

/**
 * rosterClock(state, nowMs)
 * Real time, held at the first pitch of any game that has not been played.
 */
export function rosterClock(state, nowMs) {
  const g = nextUnplayedGame(state);
  return g && g.gameTime < nowMs ? g.gameTime : nowMs;
}

/**
 * decisionDeadlineAfter(state, atMs)
 * The roster-decision deadline that is still ahead at `atMs`: one hour before
 * the first pitch of the next game whose deadline hasn't passed. A spot that
 * opens inside the final hour before a game is due before the FOLLOWING game
 * (a call-up made then couldn't report in time anyway).
 */
export function decisionDeadlineAfter(state, atMs) {
  const sched = state?.schedule || [];
  for (let i = state?.currentGameIndex || 0; i < sched.length; i++) {
    const g = sched[i];
    if (!g || g._committed || !Number.isFinite(g.gameTime)) continue;
    const dl = g.gameTime - ROSTER_DECISION_LEAD_MS;
    if (dl > atMs) return dl;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// NEEDS (derived — the single source for Team screen + inbox)
// ─────────────────────────────────────────────────────────────

/**
 * getRosterNeeds(state, teamId = 'user')
 * @returns {{
 *   short: Number, surplus: Number,
 *   needs: [{ key, side: 'hitter'|'pitcher', pos: String|null }],
 *   arrivals: Object[], deadlineAt: Number|null, applies: Boolean
 * }}
 */
export function getRosterNeeds(state, teamId = 'user') {
  const team = teamId === 'user' ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  const arrivals = pendingArrivals(state, teamId);
  const empty = { short: 0, surplus: 0, needs: [], arrivals, deadlineAt: null, applies: false };
  if (!team || !CAP_PHASES.has(state.phase)) return empty;

  const players = state.players || {};
  const active  = (team.rosterIds || []).map(id => players[id])
    .filter(p => p && p.group !== PLAYER_GROUP.IL);
  const count   = { hitter: 0, pitcher: 0 };
  for (const p of active) count[isPitcher(p) ? 'pitcher' : 'hitter']++;
  for (const t of arrivals) count[isPitcher(players[t.playerId]) ? 'pitcher' : 'hitter']++;

  const total   = active.length + arrivals.length;
  const cap     = ROSTER_LIMITS.ACTIVE_TOTAL;
  const short   = Math.max(0, cap - total);
  const surplus = Math.max(0, total - cap);

  // Position hints: lineup positions nobody on the roster can play (held by
  // an out-of-position emergency fill), and a short rotation.
  const posHints = (team.lineupSlots || []).filter(s => !s.playerId || s.emergency).map(s => s.slot);
  const rotation = (team.rotation?.order || []).length;
  const benchSP  = active.filter(p => p.pos === 'SP' && p.group === PLAYER_GROUP.PITCHER_BENCH && !p.isInjured).length;
  const spShort  = Math.max(0, ROSTER_LIMITS.STARTING_PITCHERS - rotation - benchSP);

  const needs = [];
  for (let i = 0; i < short; i++) {
    const side = count.hitter < HITTER_TARGET ? 'hitter'
      : count.pitcher < PITCHER_TARGET ? 'pitcher'
      : (count.hitter <= count.pitcher ? 'hitter' : 'pitcher');
    count[side]++;
    const pos = side === 'hitter'
      ? (posHints.shift() || null)
      : (spShort > needs.filter(n => n.pos === 'SP').length ? 'SP' : 'RP');
    needs.push({ key: `need:${i}`, side, pos });
  }

  return {
    short, surplus, needs, arrivals,
    deadlineAt: team.vacancyDeadlineAt ?? null,
    applies: true,
  };
}

/**
 * rosterIsFull(state, teamId, side?)
 * No room for one more active player: 28 in season (active + arriving), the
 * 38-man camp limit in spring. Adding anyone then needs a corresponding move.
 *
 * With `side` ('hitter' | 'pitcher' — the player being added, §76): a spot
 * belongs to its side. A spot a pitcher left (the IL, a trade) is a pitcher's
 * spot: a hitter fits only while the hitters are under their 14 (19 in camp,
 * with the invitees), a pitcher while the pitchers are under theirs. Without
 * this, every pitcher's empty spot filled with a bat and staffs hollowed out.
 * `excluding`: a player about to make room (not counted).
 */
export function rosterIsFull(state, teamId = 'user', side = null, { excluding = null } = {}) {
  const spring = state.phase === PHASE.SPRING_TRAINING;
  if (!CAP_PHASES.has(state.phase) && !spring) return false;
  const team = teamId === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === teamId);
  const players = state.players || {};
  const count = { hitter: 0, pitcher: 0 };
  for (const id of team?.rosterIds || []) {
    const p = players[id];
    if (p && p.group !== PLAYER_GROUP.IL && id !== excluding) count[isPitcher(p) ? 'pitcher' : 'hitter']++;
  }
  for (const t of pendingArrivals(state, teamId)) count[isPitcher(players[t.playerId]) ? 'pitcher' : 'hitter']++;
  const cap = spring ? ROSTER_LIMITS.SPRING_TOTAL : ROSTER_LIMITS.ACTIVE_TOTAL;
  if (count.hitter + count.pitcher >= cap) return true;
  if (!side) return false;
  const target = side === 'pitcher'
    ? PITCHER_TARGET + (spring ? ROSTER_LIMITS.SPRING_INVITEE_PITCHERS : 0)
    : HITTER_TARGET  + (spring ? ROSTER_LIMITS.SPRING_INVITEE_HITTERS  : 0);
  return count[side] >= target;
}

/** The side a player takes a roster spot on. */
export const sideOf = (p) => (isPitcher(p) ? 'pitcher' : 'hitter');

/**
 * rankCallupCandidates(state, teamId, need)
 * Healthy farm players for a need, best fit first (position, then OVR) —
 * what a GM looking at the farm report would pick.
 */
export function rankCallupCandidates(state, teamId, need) {
  const team = teamId === 'user' ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  const fits = _fitFn(need);
  return (team?.farmIds || []).map(id => state.players[id])
    .filter(p => p && !p.isInjured && (!need?.side || (need.side === 'pitcher') === isPitcher(p)))
    .sort((a, b) => fits(b) - fits(a) || (b.ovr || 0) - (a.ovr || 0));
}

/**
 * managerPick(state, teamId, need, exclude)
 * The field manager's call-up when the GM doesn't act: the right position,
 * then the longest-serving (oldest) player — not the best rating.
 */
export function managerPick(state, teamId, need, exclude = new Set()) {
  const team = teamId === 'user' ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
  const fits = _fitFn(need);
  // Same side of the roster only — a manager never calls up a pitcher to
  // play the field.
  const side = (team?.farmIds || []).map(id => state.players[id])
    .filter(p => p && !p.isInjured && !exclude.has(p.id) && (need.side === 'pitcher') === isPitcher(p));
  return side
    .sort((a, b) => fits(b) - fits(a)
      || (computeAge(b.dob, baseballYear(state)) - computeAge(a.dob, baseballYear(state)))
      || ((a.ovr || 0) - (b.ovr || 0)))[0] || null;
}

function _fitFn(need) {
  if (!need?.pos) return () => 0;
  return need.side === 'pitcher'
    ? (p) => (p.pos === need.pos ? 1 : 0)
    : (p) => (eligibleSlotsFor(p).includes(need.pos) ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────
// MOVES (draft-mutating; caller wraps in StateManager.mutate)
// ─────────────────────────────────────────────────────────────

/**
 * callUp(draft, playerId, teamId, atMs, by)
 * Farm → IN_TRANSIT → reports the next calendar day. Refused (returns an
 * error string) when the active roster has no open spot: a real club can't
 * add a 29th man.
 * @returns {{ ok: true, tx } | { ok: false, error: String }}
 */
export function callUp(draft, playerId, teamId, atMs, by = 'gm') {
  const team = teamId === 'user' ? draft.userTeam
    : (draft.leagueTeams || []).find(t => t.id === teamId);
  const player = draft.players[playerId];
  if (!team || !player) return { ok: false, error: 'Player not found.' };
  if (!(team.farmIds || []).includes(playerId)) return { ok: false, error: `${player.name} is not in the farm system.` };
  if (player.isInjured) return { ok: false, error: `${player.name} is injured.` };
  if (rosterIsFull(draft, teamId, sideOf(player))) {
    const spring = draft.phase === PHASE.SPRING_TRAINING;
    if (rosterIsFull(draft, teamId)) {
      return { ok: false, error: spring ? 'Spring camp is full (38). Open a spot first.'
                                        : 'The active roster is full (28). Open a spot first.' };
    }
    const kind = sideOf(player) === 'pitcher' ? 'pitchers' : 'position players';
    const n = sideOf(player) === 'pitcher'
      ? PITCHER_TARGET + (spring ? ROSTER_LIMITS.SPRING_INVITEE_PITCHERS : 0)
      : HITTER_TARGET  + (spring ? ROSTER_LIMITS.SPRING_INVITEE_HITTERS  : 0);
    return { ok: false, error: `We already carry our ${n} ${kind}. Open one of their spots first.` };
  }
  const { tx, patch } = makeArrival({ player, teamId, fromTeamId: teamId, reason: 'callup', atMs, by });
  team.farmIds = team.farmIds.filter(id => id !== playerId);
  Object.assign(player, patch);
  draft.transactions = [...(draft.transactions || []), tx];
  return { ok: true, tx };
}

// ─────────────────────────────────────────────────────────────
// APPLY DUE — the clock processor
// ─────────────────────────────────────────────────────────────

/**
 * applyDue(draft, clockMs, { reconcileAll })
 * Carries out everything due at or before `clockMs`, in time order, then
 * restores every affected team's roster invariants and runs the GM's
 * decision deadline. Loops until nothing more is due (a manager call-up made
 * at a deadline that is itself in the past reports in the same pass).
 *
 * @returns {{ changed: Boolean, events: Object[] }}
 *   events: { type: 'TRADE_EXECUTED'|'TRADE_VOIDED'|'ARRIVED'|'DTD_RETURN'
 *             |'IL_ELIGIBLE'|'NEED_OPENED'|'NEED_CLEARED'|'MANAGER_FILL', … }
 */
export function applyDue(draft, clockMs, { reconcileAll = false } = {}) {
  if (!Array.isArray(draft.transactions)) draft.transactions = [];
  const events  = [];
  const touched = new Set(reconcileAll ? ['user', ...(draft.leagueTeams || []).map(t => t.id)] : []);

  for (let pass = 0; pass < 12; pass++) {
    let progressed = false;

    // 1. Ledger, oldest first.
    const due = draft.transactions
      .filter(t => t.status === 'pending' && t.effectiveAt <= clockMs)
      .sort((a, b) => a.effectiveAt - b.effectiveAt || a.createdAt - b.createdAt);
    for (const tx of due) {
      progressed = true;
      if (tx.kind === 'trade')   _executeTrade(draft, tx, events, touched);
      if (tx.kind === 'arrival') _arrive(draft, tx, events, touched);
    }

    // 1b. Waiver wire: the 72-hour window closes → claimed or outrighted.
    const expiredWaivers = (draft.waiverPool || [])
      .map(id => draft.players[id])
      .filter(p => p && p.onWaivers && Number.isFinite(p.waiverStartTime)
                && p.waiverStartTime + WAIVER_CLAIM_WINDOW_MS <= clockMs)
      .sort((a, b) => a.waiverStartTime - b.waiverStartTime);
    for (const p of expiredWaivers) {
      _resolveWaiver(draft, p, p.waiverStartTime + WAIVER_CLAIM_WINDOW_MS, events, touched);
      progressed = true;
    }

    // 2. Injury timeline.
    for (const p of Object.values(draft.players)) {
      const inj = p?.injury;
      if (!inj) continue;
      if (inj.status === 'evaluating' && !_onActiveRoster(draft, p)) {
        // Left the active roster while being evaluated (cut to the farm,
        // waived): no IL decision to make — he simply heals on the timeline.
        Object.assign(p, dayToDayUpdate({ ...p, ...confirmDiagnosis(p, inj.injuredAt) }),
                      { injuryReport: confirmDiagnosis(p, inj.injuredAt).injuryReport || p.injuryReport });
        progressed = true;
        continue;
      }
      if (inj.status === 'dtd' && Number.isFinite(inj.returnAt) && inj.returnAt <= clockMs) {
        Object.assign(p, clearInjuryUpdate());
        events.push({ type: 'DTD_RETURN', playerId: p.id, teamId: p.teamId, atMs: inj.returnAt });
        touched.add(p.teamId);
        progressed = true;
      } else if (inj.status === 'il' && Number.isFinite(inj.eligibleAt) && inj.eligibleAt <= clockMs) {
        if (p.teamId === 'user') {
          // GM decides (IL return card). Healthy, still on the IL list.
          p.isInjured = false;
          p._pendingILReturn = true;
          p.injury = { ...inj, status: 'cleared' };
          if (!(draft.ilReturnQueue || []).includes(p.id)) {
            draft.ilReturnQueue = [...(draft.ilReturnQueue || []), p.id];
          }
          events.push({ type: 'IL_ELIGIBLE', playerId: p.id, teamId: 'user', atMs: inj.eligibleAt });
        } else {
          Object.assign(p, clearInjuryUpdate(), { group: defaultActiveGroup(p) });
          events.push({ type: 'IL_ELIGIBLE', playerId: p.id, teamId: p.teamId, atMs: inj.eligibleAt });
          touched.add(p.teamId);
        }
        progressed = true;
      }
    }

    // 3. Restore invariants on every team something happened to.
    for (const teamId of touched) _reconcile(draft, teamId, clockMs);
    touched.clear();

    // 4. The GM's decision deadline on open spots (user only — CPU GMs act at once).
    progressed = _runVacancyClock(draft, clockMs, events) || progressed;

    if (!progressed) break;
  }

  // Once per game day (commit): every farm director restocks depth. Not in
  // spring — the user's top prospects are only borrowed by big-league camp.
  if (reconcileAll && CAP_PHASES.has(draft.phase)) _maintainFarmDepth(draft, clockMs, events);

  _prune(draft);
  return { changed: events.length > 0, events };
}

/**
 * hasDue(state, clockMs)
 * Cheap read-only probe: would applyDue() change anything at `clockMs`?
 * Lets the 5-second app tick skip the state write (and save) when idle.
 */
export function hasDue(state, clockMs) {
  if ((state.transactions || []).some(t => t.status === 'pending' && t.effectiveAt <= clockMs)) return true;
  for (const id of state.waiverPool || []) {
    const p = state.players?.[id];
    if (p?.onWaivers && p.waiverStartTime + WAIVER_CLAIM_WINDOW_MS <= clockMs) return true;
  }
  for (const p of Object.values(state.players || {})) {
    const inj = p?.injury;
    if (!inj) continue;
    if (inj.status === 'dtd' && inj.returnAt <= clockMs) return true;
    if (inj.status === 'il'  && inj.eligibleAt <= clockMs) return true;
  }
  const needs = getRosterNeeds(state, 'user');
  const dl    = state.userTeam?.vacancyDeadlineAt ?? null;
  if (!needs.applies || needs.short === 0) return dl != null;
  return dl == null ? decisionDeadlineAfter(state, clockMs) != null : dl <= clockMs;
}

function _onActiveRoster(draft, p) {
  const team = p.teamId === 'user' ? draft.userTeam
    : (draft.leagueTeams || []).find(t => t.id === p.teamId);
  return !!team && (team.rosterIds || []).includes(p.id);
}

function _reconcile(draft, teamId, atMs) {
  if (!teamId) return;
  const isUser = teamId === 'user';
  if (!isUser && !(draft.leagueTeams || []).some(t => t.id === teamId)) return;
  const mut = reconcileRoster(draft, teamId, isUser ? {} : { autoManage: true, atMs });
  applyRosterMutation(draft, mut);
}

/** When a game in progress involving this club ends (0 if it isn't playing at `atMs`). */
export function clubBusyUntil(state, teamId, atMs) {
  const endOf = (g) => {
    const last = g?.plays?.[g.plays.length - 1];
    return last && Number.isFinite(last._timestamp) ? last._timestamp + (g._tickOffset || 0) : (g.gameTime || 0) + _GAME_FALLBACK_MS;
  };
  let end = 0;
  for (const games of Object.values(state.leagueSchedule?.dayMap || {})) {
    for (const cg of games) if (cg.status === _GS.LIVE && (cg.homeId === teamId || cg.awayId === teamId)) end = Math.max(end, endOf(cg));
  }
  for (const g of state.schedule || []) {
    if (g.status === _GS.LIVE && (teamId === 'user' || g.opponentId === teamId)) end = Math.max(end, endOf(g));
  }
  return end > atMs ? end : 0;
}

function _executeTrade(draft, tx, events, touched) {
  const { incomingIds = [], outgoingIds = [] } = tx.offer || {};
  // §90 a club in the middle of a game finishes it first: its players in the
  // deal are in that game. The trade goes through at the final out.
  const busy = Math.max(clubBusyUntil(draft, tx.teamId || 'user', tx.effectiveAt), clubBusyUntil(draft, tx.fromTeamId, tx.effectiveAt));
  if (busy) { tx.effectiveAt = busy + 60_000; tx.waitedForGame = true; return; }
  // §90 the two clubs: `teamId` receives incomingIds from `fromTeamId` and
  // sends outgoingIds. Ours with a CPU club (teamId 'user'), or two CPU clubs.
  const club = (id) => id === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === id);
  const aId = tx.teamId || 'user', bId = tx.fromTeamId;
  const A = club(aId), B = club(bId);
  const withUser = aId === 'user' || bId === 'user';
  const at   = tx.effectiveAt;
  const inOrg = (t, id) => (t.rosterIds || []).includes(id) || (t.farmIds || []).includes(id);

  // Re-validate at execution: every player still where the deal expects him
  // and healthy. Otherwise the deal is off (a failed physical voids trades).
  const problem =
      !A || !B ? 'team not found'
    : outgoingIds.some(id => !inOrg(A, id)) ? (aId === 'user' ? 'a player is no longer in our organization' : `a player is no longer with ${A.name}`)
    : incomingIds.some(id => !inOrg(B, id)) ? (bId === 'user' ? 'a player is no longer in our organization' : `a player is no longer with ${B.name}`)
    : [...outgoingIds, ...incomingIds].some(id => draft.players[id]?.isInjured) ? 'a player failed the physical'
    : null;
  if (problem) {
    tx.status = 'cancelled';
    tx.note   = problem;
    tx.doneAt = at;
    events.push({ type: 'TRADE_VOIDED', tx, reason: problem });
    return;
  }

  if (withUser) Object.entries(tradePlayerPatches(draft, tx)).forEach(([id, upd]) => Object.assign(draft.players[id], upd));
  const moves = [
    ...outgoingIds.map(id => ({ id, from: aId, to: bId })),
    ...incomingIds.map(id => ({ id, from: bId, to: aId })),
  ];
  // §85 everyone in the deal leaves the old club first; only then does each
  // club make room for who is coming (so a corresponding move can never pick
  // a player who is himself in the deal).
  const fromFarm = new Set();
  const formerClub = {};
  for (const m of moves) {
    const fromTeam = club(m.from);
    if ((fromTeam.farmIds || []).includes(m.id)) fromFarm.add(m.id);   // a prospect reports to the new farm
    fromTeam.rosterIds = fromTeam.rosterIds.filter(x => x !== m.id);
    fromTeam.farmIds = (fromTeam.farmIds || []).filter(x => x !== m.id);
    formerClub[m.id] = m.from;
  }
  for (const m of moves) {
    const player = draft.players[m.id];
    const { tx: arr, patch } = makeArrival({ player, teamId: m.to, fromTeamId: m.from,
                                             reason: 'trade', atMs: at, by: 'trade' });
    if (fromFarm.has(m.id)) arr.toFarm = true;
    // Room is made when the deal is made: a side that is already full options
    // its weakest reserve now, not when the new player reports.
    if (!fromFarm.has(m.id) && rosterIsFull(draft, m.to, sideOf(player))) {
      const out = _weakestReserve(draft, player, m.to, player.id);
      if (out) {
        applyRosterMutation(draft, sendToFarm(draft, out.id, m.to));
        events.push({ type: 'OPTIONED', playerId: out.id, teamId: m.to, atMs: at, reason: 'corresponding move' });
        touched.add(m.to);
      }
    }
    Object.assign(player, patch, { _acquiredAtMs: at, _tradedFrom: m.from });   // §85 no flipping a player for a few days
    draft.transactions.push(arr);
  }
  // §85 the money: a one-time payment between the clubs, and salary the
  // sending club keeps paying this season on players it sent.
  const cashK = tx.offer.cashK || 0;
  const label = (t, other) => other === draft.userTeam ? 'us' : other.name;
  if (cashK) {
    const [payer, payee] = cashK > 0 ? [B, A] : [A, B];
    const k = Math.abs(cashK);
    if (payer.finances) postFunds(payer.finances, -k, 'trade', `Cash sent in a trade with ${label(payer, payee)}`, at);
    if (payee.finances) postFunds(payee.finances, k, 'trade', `Cash received in a trade with ${label(payee, payer)}`, at);
  }
  for (const [id, pct] of Object.entries(tx.offer.retain || {})) {
    retainSalary(draft, formerClub[id] || (outgoingIds.includes(id) ? aId : bId), id, pct);
  }
  if (withUser) adjustRapport(draft, aId === 'user' ? bId : aId, 2);   // §85 a completed deal warms the relationship

  tx.status = 'done';
  tx.doneAt = at;
  if (withUser) {
    // Our franchise history, from our side.
    const cpu = aId === 'user' ? B : A;
    const got  = aId === 'user' ? incomingIds : outgoingIds;
    const sent = aId === 'user' ? outgoingIds : incomingIds;
    const name = (id) => draft.players[id]?.name || '—';
    const user = draft.userTeam;
    draft.history = [...(draft.history || []), {
      id:       tx.id,
      type:     'trade',
      season:   draft.seasonNum || 1,
      gameIdx:  draft.currentGameIndex || 0,
      headline: got.length === 1 && sent.length === 1
        ? `${name(got[0])} acquired, ${name(sent[0])} traded away`
        : `Trade: received ${got.map(name).join(', ')} — sent ${sent.map(name).join(', ')}`,
      detail:   `Acquired from ${cpu.name}: ${got.map(name).join(', ') || '—'}. Traded away: ${sent.map(name).join(', ') || '—'}. Record at the time: ${user.wins || 0}–${user.losses || 0}.`,
      playerId: got[0] || null,
      icon:     '🔄',
      userNote: '',
    }];
  }
  touched.add(aId);
  touched.add(bId);
  events.push({ type: 'TRADE_EXECUTED', tx, atMs: at, league: !withUser });
}

function _resolveWaiver(draft, player, atMs, events, touched) {
  const claimant = cpuWaiverClaimant(draft, player.id);
  const userClaimed = !!player._userClaim;
  player._userClaim = false;
  if (claimant) {
    draft.waiverPool = (draft.waiverPool || []).filter(id => id !== player.id);
    // The claim won (§73, any club): with no spot on his side (§76), the
    // weakest same-side reserve — the man he's an upgrade on — is optioned so
    // the claimed player has a spot when he reports.
    if (rosterIsFull(draft, claimant, sideOf(player))) {
      const out = _weakestReserve(draft, player, claimant);
      if (out) { applyRosterMutation(draft, sendToFarm(draft, out.id, claimant)); events.push({ type: 'OPTIONED', playerId: out.id, teamId: claimant, atMs }); }
    }
    const { tx, patch } = makeArrival({ player, teamId: claimant, fromTeamId: player._waivedBy || null,
                                        reason: 'waiver', atMs, by: claimant === 'user' ? 'gm' : 'cpu' });
    Object.assign(player, patch, { onWaivers: false, waiverStartTime: null, _waivedBy: null, _waiveReason: null });
    draft.transactions.push(tx);
    touched.add(claimant);   // "the claiming team must immediately drop a player"
    events.push({ type: 'WAIVER_CLAIMED', playerId: player.id, teamId: claimant, atMs, userClaimed });
    return;
  }
  const from = player._waivedBy;
  applyRosterMutation(draft, clearWaivers(draft, player.id, atMs));
  if (from) touched.add(from);
  events.push({ type: 'WAIVER_CLEARED', playerId: player.id, teamId: draft.players[player.id]?.teamId || null, atMs });
}

/**
 * cpuSalaryMove(draft, fromId, atMs)
 * §78.5: a CPU club whose owner has ordered cuts moves a contract — the
 * smallest salary (outside its core five) that covers the cut — to the club
 * with the most payroll room that can absorb it, for nothing back (a salary
 * dump). He reports the next day like any trade; the club that sent him fills
 * his spot from its farm on the vacancy clock. Returns the move, or null when
 * no club can take the contract. Pure (mutates the draft).
 */
export function cpuSalaryMove(draft, fromId, atMs) {
  const from = (draft.leagueTeams || []).find(t => t.id === fromId);
  if (!from) return null;
  const amountK = cutOrderAmount(draft, fromId);
  if (!(amountK > 0)) return null;
  const p = contractToMove(draft, amountK, fromId);
  if (!p) return null;
  const taker = (draft.leagueTeams || [])
    .filter(t => t.id !== fromId)
    .map(t => ({ t, room: payrollRoom(draft, t.id) }))
    .filter(x => x.room >= (p.contractSalary || 0))
    .sort((a, b) => b.room - a.room)[0]?.t;
  if (!taker) return null;
  from.rosterIds = from.rosterIds.filter(x => x !== p.id);
  const { tx, patch } = makeArrival({ player: p, teamId: taker.id, fromTeamId: fromId, reason: 'trade', atMs, by: 'cpu' });
  Object.assign(p, patch, { _previouslyWithOrg: false });
  draft.transactions = [...(draft.transactions || []), tx, {
    id: `tx-cpudump-${fromId}-${atMs}`, kind: 'cpu_trade', teamId: taker.id, fromTeamId: fromId,
    offer: { incomingIds: [p.id], outgoingIds: [] }, createdAt: atMs, effectiveAt: atMs, doneAt: atMs,
    status: 'done', note: 'salary', amountK: p.contractSalary || 0,
  }];
  _reconcile(draft, fromId, atMs);          // the lineup / rotation / a call-up fill his spot
  return { playerId: p.id, fromId, toId: taker.id, salaryK: p.contractSalary || 0 };
}

/** The weakest healthy same-side player not in the lineup / rotation. */
function _weakestReserve(draft, incoming, teamId = 'user', exceptId = null) {
  const u = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === teamId);
  if (!u) return null;
  const isP = (p) => ['SP', 'RP'].includes(p?.pos);
  const busy = new Set([...(u.lineupSlots || []).map(s => s.playerId), ...(u.rotation?.order || [])]);
  return (u.rosterIds || []).map(id => draft.players[id])
    .filter(p => p && p.id !== exceptId && isP(p) === isP(incoming) && !busy.has(p.id) && p.group !== PLAYER_GROUP.IL)
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
}

/** More players on this side of the active roster than its share (14, or 19 in camp). */
function _sideOver(draft, teamId, side) {
  if (!CAP_PHASES.has(draft.phase) && draft.phase !== PHASE.SPRING_TRAINING) return false;
  const team = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === teamId);
  const spring = draft.phase === PHASE.SPRING_TRAINING;
  let n = 0;
  for (const id of team?.rosterIds || []) {
    const p = draft.players[id];
    if (p && p.group !== PLAYER_GROUP.IL && sideOf(p) === side) n++;
  }
  const target = side === 'pitcher'
    ? PITCHER_TARGET + (spring ? ROSTER_LIMITS.SPRING_INVITEE_PITCHERS : 0)
    : HITTER_TARGET  + (spring ? ROSTER_LIMITS.SPRING_INVITEE_HITTERS  : 0);
  return n > target;
}

function _arrive(draft, tx, events, touched) {
  const player = draft.players[tx.playerId];
  const team   = tx.teamId === 'user' ? draft.userTeam
    : (draft.leagueTeams || []).find(t => t.id === tx.teamId);
  tx.doneAt = tx.effectiveAt;
  if (!player || !team || player.group !== PLAYER_GROUP.IN_TRANSIT) {
    tx.status = 'cancelled';
    tx.note   = 'player no longer in transit';
    return;
  }
  if (tx.toFarm) {
    // §85 a traded prospect joins the farm; a full farm side releases its weakest.
    const isP = ['SP', 'RP'].includes(player.pos);
    const side = (team.farmIds || []).map(id => draft.players[id]).filter(p => p && ['SP', 'RP'].includes(p.pos) === isP);
    if (side.length >= (isP ? ROSTER_LIMITS.FARM_PITCHER_MAX : ROSTER_LIMITS.FARM_HITTER_MAX)) {
      const weakest = side.sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
      const ev = weakest && releaseToFreeAgency(draft, weakest.id, tx.effectiveAt, { reason: 'farm full' });
      if (ev) events.push(ev);
    }
    team.farmIds = [...(team.farmIds || []).filter(x => x !== player.id), player.id];
    Object.assign(player, { group: PLAYER_GROUP.PRACTICE_SQUAD, teamId: tx.teamId, tier: 'farm' });
    tx.status = 'done';
    touched.add(tx.teamId);
    events.push({ type: 'ARRIVED', tx, playerId: player.id, teamId: tx.teamId, atMs: tx.effectiveAt });
    return;
  }
  if (!team.rosterIds.includes(player.id)) team.rosterIds = [...team.rosterIds, player.id];
  Object.assign(player, { group: tx.toGroup || defaultActiveGroup(player), teamId: tx.teamId, tier: 'active' });
  // The corresponding move (§78 roster balance): a player reporting to a side
  // that's already full — a bat for an arm in a trade — sends that side's
  // weakest reserve down, so his club keeps its 14 and 14 and the side he
  // left opens for a call-up.
  if (_sideOver(draft, tx.teamId, sideOf(player))) {
    const out = _weakestReserve(draft, player, tx.teamId, player.id);
    if (out) {
      applyRosterMutation(draft, sendToFarm(draft, out.id, tx.teamId));
      events.push({ type: 'OPTIONED', playerId: out.id, teamId: tx.teamId, atMs: tx.effectiveAt, reason: 'corresponding move' });
    }
  }
  // §89 a veteran signed to start takes the spot he was signed for, if the
  // player he replaces still holds it.
  if (tx.startAt) {
    const sl = (team.lineupSlots || []).find(x => x.slot === tx.startAt.slot && x.playerId === tx.startAt.replacing);
    if (sl && eligibleSlotsFor(player).includes(sl.slot)) sl.playerId = player.id;
  }
  tx.status = 'done';
  touched.add(tx.teamId);
  events.push({ type: 'ARRIVED', tx, playerId: player.id, teamId: tx.teamId, atMs: tx.effectiveAt });
}

/**
 * _runVacancyClock(draft, clockMs, events)
 * Opens the decision deadline when the user's roster falls short, clears it
 * when the roster is whole, and — when it passes — has the field manager
 * call players up himself and charges the front office for not acting.
 * @returns {Boolean} progressed
 */
function _runVacancyClock(draft, clockMs, events) {
  const team  = draft.userTeam;
  const needs = getRosterNeeds(draft, 'user');
  if (!needs.applies || needs.short === 0) {
    if (team.vacancyDeadlineAt != null) {
      team.vacancyDeadlineAt = null;
      events.push({ type: 'NEED_CLEARED' });
    }
    return false;
  }
  if (team.vacancyDeadlineAt == null) {
    const dl = decisionDeadlineAfter(draft, clockMs);
    if (dl == null) return false;          // no game left to field
    team.vacancyDeadlineAt = dl;
    events.push({ type: 'NEED_OPENED', deadlineAt: dl, count: needs.short });
    return false;
  }
  if (team.vacancyDeadlineAt > clockMs) return false;

  // Deadline passed with spots still open: the manager makes the moves.
  const at = team.vacancyDeadlineAt;
  const picked = [];
  const taken  = new Set();
  for (const need of needs.needs) {
    const pick = managerPick(draft, 'user', need, taken);
    if (!pick) continue;
    taken.add(pick.id);
    const res = callUp(draft, pick.id, 'user', at, 'manager');
    if (res.ok) picked.push(pick.id);
  }
  for (const [k, v] of Object.entries(MANAGER_FILL_PENALTY)) {
    team[k] = Math.max(0, Math.min(100, (team[k] ?? 50) + v));
  }
  team.vacancyDeadlineAt = null;
  events.push({ type: 'MANAGER_FILL', playerIds: picked, atMs: at, penalty: MANAGER_FILL_PENALTY });
  return picked.length > 0;
}

const FARM_HITTER_GROUPS = Object.freeze({
  C:  ['C'],
  CI: ['1B', '3B', '1B/3B'],
  MI: ['2B', 'SS', '2B/SS'],
  OF: ['OF', 'DH/OF'],
});

/**
 * _maintainFarmDepth(draft, atMs, events)
 * Keeps every organization able to cover an injury: signs free agents to
 * minor-league deals when a farm loses a required position or falls below the
 * depth floor. Without this a farm only ever shrinks (call-ups, waiver
 * claims) and a late-season injury can't be covered.
 */
function _maintainFarmDepth(draft, atMs, events) {
  const pool = () => (draft.freeAgentPool || []).map(id => draft.players[id])
    .filter(p => p && p.tier !== 'retired' && !p.isInjured && !p.teamId);
  const teams = [['user', draft.userTeam], ...(draft.leagueTeams || []).map(t => [t.id, t])];

  for (const [teamId, team] of teams) {
    for (let guard = 0; guard < 6; guard++) {
      const farm = (team.farmIds || []).map(id => draft.players[id]).filter(Boolean);
      const hitters  = farm.filter(p => !isPitcher(p));
      const nat = (p) => p.nativePos || p.pos;
      const missing = Object.entries(FARM_HITTER_GROUPS)
        .find(([, list]) => !hitters.some(p => list.includes(nat(p))));
      const sp = farm.filter(p => p.pos === 'SP').length;
      const rp = farm.filter(p => p.pos === 'RP').length;

      let want = null;
      if (missing)                                   want = (p) => !isPitcher(p) && missing[1].includes(nat(p));
      else if (sp < FARM_PITCHER_MIN_SP)             want = (p) => p.pos === 'SP';
      else if (rp < FARM_PITCHER_MIN_RP)             want = (p) => p.pos === 'RP';
      else if (hitters.length < FARM_DEPTH_FLOOR_HITTERS)            want = (p) => !isPitcher(p);
      else if (farm.length - hitters.length < FARM_DEPTH_FLOOR_PITCHERS) want = (p) => isPitcher(p);
      if (!want) break;

      const sign = pool().filter(want).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0]
        || _depthSigning(draft, want, missing ? missing[1][0] : null);
      if (!sign) break;
      draft.freeAgentPool = (draft.freeAgentPool || []).filter(id => id !== sign.id);
      team.farmIds = [...(team.farmIds || []), sign.id];
      Object.assign(sign, {
        teamId, tier: 'farm', group: PLAYER_GROUP.PRACTICE_SQUAD,
        contractSalary: SALARY_BY_OVR.tier1.salMin,
        contractYears:  1,
        contractExpiry: draft.seasonNum || 1,
        contractMLB:    false,          // a minor-league depth deal (§78)
        _farmArc: null, _farmArcStart: atMs,
      });
      events.push({ type: 'FARM_SIGNING', teamId, playerId: sign.id, atMs });
    }
  }
}

// The free-agent market is never truly empty: independent-league and
// released veterans are always available on minor-league terms. When the
// pool has nobody of the needed type, one of them is created (low OVR).
const DEPTH_POSITIONS = Object.freeze(['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', '2B/SS', '1B/3B']);
function _depthSigning(draft, want, pos) {
  const probe = (p) => want({ pos: p, nativePos: p });
  const choices = pos ? [pos] : [...DEPTH_POSITIONS, 'SP', 'RP'].filter(probe);
  const position = choices[Math.floor(Math.random() * choices.length)];
  if (!position || !probe(position)) return null;
  const name = newPlayerName(draft.players);   // §82
  const p = createPlayer({
    id:        crypto.randomUUID(),
    name,
    pos:       position,
    group:     PLAYER_GROUP.PRACTICE_SQUAD,
    hand:      ['SP', 'RP'].includes(position) ? (Math.random() < 0.28 ? 'L' : 'R') : null,
    // Independent-league talent sits below the league's level (§69).
    targetOvr: 42 + (draft.leagueTalentOffset || 0) + Math.floor(Math.random() * 9),
    ageMin:    24,
    ageMax:    31,
    seasonNum: draft.seasonNum || 1,
    contractLengthOverride: 1,
    teamId:    null,
    leagueLevel: draft.leagueTalentOffset || 0,
    seasonYear: baseballYear(draft),
  });
  draft.players[p.id] = p;
  return p;
}

function _prune(draft) {
  const list = draft.transactions || [];
  const closed = list.filter(t => t.status !== 'pending');
  if (closed.length <= TRANSACTION_HISTORY_KEEP) return;
  const keep = new Set(closed
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    .slice(0, TRANSACTION_HISTORY_KEEP)
    .map(t => t.id));
  draft.transactions = list.filter(t => t.status === 'pending' || keep.has(t.id));
}

// ─────────────────────────────────────────────────────────────
// INVARIANT CHECK (harness + debug)
// ─────────────────────────────────────────────────────────────

/**
 * auditRosters(state)
 * Every player belongs to at most one roster/farm list; every IN_TRANSIT
 * player has exactly one pending arrival; nobody in transit is on a list.
 * @returns {String[]} problems (empty when sound)
 */
export function auditRosters(state) {
  const problems = [];
  const where = new Map();
  const note = (id, label) => {
    if (where.has(id)) problems.push(`${state.players[id]?.name || id} on ${where.get(id)} and ${label}`);
    else where.set(id, label);
  };
  for (const id of state.userTeam.rosterIds || []) note(id, 'user roster');
  for (const id of state.userTeam.farmIds   || []) note(id, 'user farm');
  for (const t of state.leagueTeams || []) {
    for (const id of t.rosterIds || []) note(id, `${t.abbr} roster`);
    for (const id of t.farmIds   || []) note(id, `${t.abbr} farm`);
  }
  const arrivals = new Map();
  for (const t of state.transactions || []) {
    if (t.status === 'pending' && t.kind === 'arrival') arrivals.set(t.playerId, (arrivals.get(t.playerId) || 0) + 1);
  }
  for (const p of Object.values(state.players || {})) {
    if (p?.group !== PLAYER_GROUP.IN_TRANSIT) continue;
    if (where.has(p.id)) problems.push(`${p.name} in transit but on ${where.get(p.id)}`);
    if (arrivals.get(p.id) !== 1) problems.push(`${p.name} in transit with ${arrivals.get(p.id) || 0} arrivals`);
  }
  for (const [id] of arrivals) {
    if (state.players[id]?.group !== PLAYER_GROUP.IN_TRANSIT) problems.push(`${state.players[id]?.name || id} has an arrival but is not in transit`);
  }
  return problems;
}

export { MS_PER_DAY };
