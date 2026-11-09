/**
 * engine/TransactionEngine.js
 * The roster clock (§65). Every roster move in the league — trades, free-agent
 * signings and waiver claims (§122), IL eligibility, day-to-day returns, the
 * GM's decision deadline — happens here, in real-time order, for all ten teams.
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
 * open spots and the inbox open-spot messages read the same function, so the
 * two can never disagree and a message whose need is gone is withdrawn.
 *
 * Rules:
 *   - Never imports StateManager. applyDue(draft, …) mutates the draft the
 *     caller hands it (inside the caller's StateManager.mutate), the same
 *     contract as RosterEngine.applyRosterMutation.
 *   - All times are real ms. Callers pass them in; nothing here reads Date.now().
 */

import { dice, diceSeed, diceId } from './Dice.js';
import {
  PLAYER_GROUP,
  PHASE,
  ROSTER_LIMITS,
  ROSTER_DECISION_LEAD_MS,
  MANAGER_FILL_PENALTY,
  TRANSACTION_HISTORY_KEEP,
  GM_RELATIONSHIP_DEFAULT,
  WAIVER_CLAIM_WINDOW_MS,
  FA_CPU_UPGRADE_MARGIN,
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
  placeOnWaivers,
  HITTER_TARGET,
  PITCHER_TARGET,
} from './RosterEngine.js';

import { cpuWaiverClaimant, weakestPeer } from './LeagueEngine.js';

import { tradePlayerPatches } from './TradeEngine.js';
import { payrollRoom, contractToMove, cutOrderAmount, post as postFunds, retainSalary, canAddSalary } from './FinanceEngine.js';
import { signToClub, signingTerms } from './MarketEngine.js';
import { adjustRapport } from './TradeEngine.js';
import { releaseToFreeAgency } from './OffseasonEngine.js';
import { clearInjuryUpdate, confirmDiagnosis, dayToDayUpdate } from './InjuryEngine.js';
import { computeAge, createPlayer, baseballYear } from './PlayerFactory.js';
import { newPlayerName } from './Names.js';

const MS_PER_DAY = 86_400_000;
const isPitcher  = (p) => ['SP', 'RP'].includes(p?.pos);

// Phases in which the 28-man rule (and so roster needs) applies — §122 spring too (no 38-man camp).
const CAP_PHASES = new Set([
  PHASE.SPRING_TRAINING, PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE,
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
 * No room for one more active player: 28 (active + arriving). Adding anyone
 * then needs a corresponding move.
 *
 * With `side` ('hitter' | 'pitcher' — the player being added, §76): a spot
 * belongs to its side. A spot a pitcher left (the IL, a trade) is a pitcher's
 * spot: a hitter fits only while the hitters are under their 14, a pitcher
 * while the pitchers are under theirs. Without
 * this, every pitcher's empty spot filled with a bat and staffs hollowed out.
 * `excluding`: a player about to make room (not counted).
 */
export function rosterIsFull(state, teamId = 'user', side = null, { excluding = null } = {}) {
  if (!CAP_PHASES.has(state.phase)) return false;
  const team = teamId === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === teamId);
  const players = state.players || {};
  const count = { hitter: 0, pitcher: 0 };
  for (const id of team?.rosterIds || []) {
    const p = players[id];
    if (p && p.group !== PLAYER_GROUP.IL && id !== excluding) count[isPitcher(p) ? 'pitcher' : 'hitter']++;
  }
  for (const t of pendingArrivals(state, teamId)) count[isPitcher(players[t.playerId]) ? 'pitcher' : 'hitter']++;
  if (count.hitter + count.pitcher >= ROSTER_LIMITS.ACTIVE_TOTAL) return true;
  if (!side) return false;
  return count[side] >= (side === 'pitcher' ? PITCHER_TARGET : HITTER_TARGET);
}

/** The side a player takes a roster spot on. */
export const sideOf = (p) => (isPitcher(p) ? 'pitcher' : 'hitter');

/**
 * rankPickups(state, teamId, need)
 * §122 Free agents who could fill a need, best fit first (position, then
 * OVR): healthy, on the need's side of the roster, and within what the
 * club's owner will add to the payroll. What a GM scanning the free agents
 * would pick. (Waiver claims are decided days later — not a fill for today.)
 */
export function rankPickups(state, teamId, need) {
  const fits = _fitFn(need);
  return _signable(state, teamId)
    .filter(p => !need?.side || (need.side === 'pitcher') === isPitcher(p))
    .sort((a, b) => fits(b) - fits(a) || (b.ovr || 0) - (a.ovr || 0));
}

/**
 * managerPick(state, teamId, need, exclude)
 * The field manager's signing when the GM doesn't act at the deadline: the
 * right position, then the veteran (the oldest) — not the best rating, and
 * never a pitcher to play the field.
 */
export function managerPick(state, teamId, need, exclude = new Set()) {
  const fits = _fitFn(need);
  const year = baseballYear(state);
  return _signable(state, teamId)
    .filter(p => !exclude.has(p.id) && (need.side === 'pitcher') === isPitcher(p))
    .sort((a, b) => fits(b) - fits(a)
      || (computeAge(b.dob, year) - computeAge(a.dob, year))
      || ((a.ovr || 0) - (b.ovr || 0)))[0] || null;
}

/** Free agents this club could sign today: healthy, and its owner would carry the salary. */
function _signable(state, teamId) {
  return (state.freeAgentPool || []).map(id => state.players[id])
    .filter(p => p && p.group === PLAYER_GROUP.FREE_AGENT && !p.isInjured
              && canAddSalary(state, signingTerms(state, p).salary || 0, 0, teamId));
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
 * signPickup(draft, playerId, teamId, atMs, by)
 * §122 A club signs a free agent to fill a spot (the GM from an open-spot
 * card, the manager at the deadline, a CPU club): a one-year deal at his
 * asking price; he reports the next calendar day. Refused (an error string)
 * when the roster has no room on his side.
 * @returns {{ ok: true } | { ok: false, error: String }}
 */
export function signPickup(draft, playerId, teamId, atMs, by = 'gm') {
  const player = draft.players[playerId];
  if (!player || player.group !== PLAYER_GROUP.FREE_AGENT) return { ok: false, error: `${player?.name || 'He'} is no longer a free agent.` };
  if (player.isInjured) return { ok: false, error: `${player.name} is injured.` };
  if (rosterIsFull(draft, teamId, sideOf(player))) {
    if (rosterIsFull(draft, teamId)) return { ok: false, error: 'The roster is full (28). Open a spot first.' };
    const kind = sideOf(player) === 'pitcher' ? 'pitchers' : 'position players';
    const n = sideOf(player) === 'pitcher' ? PITCHER_TARGET : HITTER_TARGET;
    return { ok: false, error: `We already carry our ${n} ${kind}. Open one of their spots first.` };
  }
  signToClub(draft, playerId, teamId, atMs, { by });
  return { ok: true };
}

/**
 * releasePickups(draft, playerIds, teamId, atMs)
 * r135 / §122 The GM lets the manager's deadline signings go before they
 * report: each pending signing is cancelled and the player is a free agent
 * again (he never reported, so never cost anything). The open spot is the
 * vacancy clock's again (a new deadline, the open-spot card). A player who
 * already reported is left alone.
 * @returns {String[]} the players let go
 */
export function releasePickups(draft, playerIds, teamId, atMs) {
  const back = [];
  for (const id of playerIds || []) {
    const tx = (draft.transactions || []).find(t => t.status === 'pending' && t.kind === 'arrival'
      && t.reason === 'signing' && t.playerId === id && t.teamId === teamId);
    const p = draft.players[id];
    if (!tx || p?.group !== PLAYER_GROUP.IN_TRANSIT) continue;
    tx.status = 'cancelled';
    tx.note   = 'released before reporting';
    tx.doneAt = atMs;
    Object.assign(p, { teamId: null, group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent',
                       _faFrom: teamId, _faSince: atMs, _faReason: 'released' });
    draft.freeAgentPool = [...(draft.freeAgentPool || []).filter(x => x !== id), id];
    back.push(id);
  }
  return back;
}

/**
 * dropPlayer(draft, playerId, teamId, atMs, { reason })
 * §122 A club lets a player go. With games on the calendar he goes on
 * waivers (any club may claim him and his contract for 72 hours; then he's a
 * free agent); between seasons, when no waivers run, straight to free agency.
 * Either way his salary leaves the club's payroll now — there's no dead money.
 * @returns {Object} the event
 */
export function dropPlayer(draft, playerId, teamId, atMs, { reason = null } = {}) {
  const p = draft.players[playerId];
  if (!p) return null;
  if (draft.phase === PHASE.OFFSEASON || draft.phase === PHASE.SEASON_SUMMARY) {
    return releaseToFreeAgency(draft, playerId, atMs, { reason: reason || 'released' });
  }
  applyRosterMutation(draft, placeOnWaivers(draft, playerId, { atMs, reason }));
  return { type: 'WAIVED', playerId, teamId, atMs, reason };
}

/**
 * _cpuFill(draft, teamId, atMs, short, events)
 * §122 A CPU club short of 28 (an injury, a trade, a release, a new season)
 * signs free agents for it at once — its open lineup positions and a short
 * rotation first, then by roster balance (14 and 14); best fit, then best OVR
 * its owner will pay for. No randomness: the same world signs the same players.
 */
function _cpuFill(draft, teamId, atMs, short, events) {
  const wants = [...(short?.positions || []).map(pos => ({ side: 'hitter', pos })),
                 ...Array.from({ length: short?.rotationShort || 0 }, () => ({ side: 'pitcher', pos: 'SP' }))];
  for (let guard = 0; guard < 10; guard++) {
    const team = (draft.leagueTeams || []).find(t => t.id === teamId);
    const count = { hitter: 0, pitcher: 0 };
    for (const id of team?.rosterIds || []) { const q = draft.players[id]; if (q && q.group !== PLAYER_GROUP.IL) count[sideOf(q)]++; }
    for (const t of pendingArrivals(draft, teamId)) count[sideOf(draft.players[t.playerId])]++;
    if (count.hitter + count.pitcher >= ROSTER_LIMITS.ACTIVE_TOTAL) break;
    const open = { hitter: count.hitter < HITTER_TARGET, pitcher: count.pitcher < PITCHER_TARGET };
    let need = wants.shift();
    while (need && !open[need.side]) need = wants.shift();
    if (!need) need = { side: open.hitter && (!open.pitcher || count.hitter <= count.pitcher) ? 'hitter' : 'pitcher', pos: null };
    if (!open[need.side]) break;
    const pick = rankPickups(draft, teamId, need)[0];
    if (!pick) break;
    events.push(...signToClub(draft, pick.id, teamId, atMs, { by: 'cpu' }));
    events.push({ type: 'CPU_SIGNED', playerId: pick.id, teamId, atMs, reason: 'fill' });
  }
}

/**
 * cpuFreeAgentLook(draft, atMs) — §122 once a day each CPU club looks at the
 * free agents, worst record first (like waivers): a free agent at least
 * FA_CPU_UPGRADE_MARGIN better than its weakest healthy player in that role,
 * whom its owner can pay (the man he replaces comes off), is signed — at most
 * one a club a day — and that weakest player goes on waivers, where any club
 * (the GM too) can claim him. So a good player doesn't sit unsigned while a
 * club has a much weaker one in his role and the money to fix it. No
 * randomness: the same world makes the same moves.
 * @returns {Object[]} events
 */
export function cpuFreeAgentLook(draft, atMs) {
  const events = [];
  const order = [...(draft.leagueTeams || [])].sort((a, b) =>
    ((a.wins || 0) - (a.losses || 0)) - ((b.wins || 0) - (b.losses || 0)) || String(a.id).localeCompare(String(b.id)));
  for (const team of order) {
    let best = null;
    for (const fa of _healthyFreeAgents(draft)) {
      const weak = weakestPeer(team, fa, draft.players);
      if (!weak || (fa.ovr || 0) < (weak.ovr || 0) + FA_CPU_UPGRADE_MARGIN) continue;
      if (!canAddSalary(draft, signingTerms(draft, fa).salary || 0, weak.contractSalary || 0, team.id)) continue;
      const gain = (fa.ovr || 0) - (weak.ovr || 0);
      if (!best || gain > best.gain || (gain === best.gain && (fa.ovr || 0) > (best.fa.ovr || 0))) best = { fa, weak, gain };
    }
    if (!best) continue;
    events.push(...signToClub(draft, best.fa.id, team.id, atMs, { displaceId: best.weak.id, by: 'cpu' }));
    // (a full side lets the weak one go inside signToClub; otherwise he goes now)
    if (draft.players[best.weak.id]?.teamId === team.id) events.push(dropPlayer(draft, best.weak.id, team.id, atMs, { reason: 'upgrade' }));
    events.push({ type: 'CPU_SIGNED', playerId: best.fa.id, teamId: team.id, atMs, reason: 'upgrade', replaces: best.weak.id });
    _reconcile(draft, team.id, atMs);   // the lineup / rotation without the man let go
  }
  return events;
}

function _healthyFreeAgents(draft) {
  return (draft.freeAgentPool || []).map(id => draft.players[id])
    .filter(p => p && p.group === PLAYER_GROUP.FREE_AGENT && !p.isInjured);
}

/**
 * fillShortRosters(draft, atMs) — §122 every CPU club with fewer than 28
 * signs free agents for the spots (at a new season: deals for that season).
 * @returns {Object[]} events
 */
export function fillShortRosters(draft, atMs) {
  const events = [];
  for (const t of draft.leagueTeams || []) {
    const mut = reconcileRoster(draft, t.id, { autoManage: true, atMs });
    applyRosterMutation(draft, mut);
    _cpuFill(draft, t.id, atMs, mut.cpuShort, events);
  }
  return events;
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
        // Left the active roster while being evaluated (waived): no IL
        // decision to make — he simply heals on the timeline.
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
  // §122 a CPU club short of 28 signs free agents for it at once.
  if (!isUser && mut.cpuShort && CAP_PHASES.has(draft.phase)) _cpuFill(draft, teamId, atMs, mut.cpuShort, []);
}

/** When a game in progress involving this club ends (0 if it isn't playing at `atMs`). */
export function clubBusyUntil(state, teamId, atMs) {
  const endOf = (g) => {
    const last = g?.plays?.[g.plays.length - 1];
    return last && Number.isFinite(last._timestamp) ? last._timestamp : (g.gameTime || 0) + _GAME_FALLBACK_MS;
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
  const inOrg = (t, id) => (t.rosterIds || []).includes(id);

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
  const formerClub = {};
  for (const m of moves) {
    const fromTeam = club(m.from);
    fromTeam.rosterIds = fromTeam.rosterIds.filter(x => x !== m.id);
    formerClub[m.id] = m.from;
  }
  for (const m of moves) {
    const player = draft.players[m.id];
    const { tx: arr, patch } = makeArrival({ player, teamId: m.to, fromTeamId: m.from,
                                             reason: 'trade', atMs: at, by: 'trade' });
    // Room is made when the deal is made: a side that is already full puts
    // its weakest reserve on waivers now, not when the new player reports.
    if (rosterIsFull(draft, m.to, sideOf(player))) {
      const out = _weakestReserve(draft, player, m.to, player.id);
      if (out) {
        events.push(dropPlayer(draft, out.id, m.to, at, { reason: 'corresponding move' }));
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
  const claimant = cpuWaiverClaimant(draft, player.id, atMs);
  const userClaimed = !!player._userClaim;
  const userDrop = player._userClaimDrop || null;   // §96 who the GM chose to send down if the claim is ours
  player._userClaim = false;
  player._userClaimDrop = null;
  if (claimant) {
    draft.waiverPool = (draft.waiverPool || []).filter(id => id !== player.id);
    // The claim won (§73, any club): with no spot on his side (§76), the
    // weakest same-side reserve — the man he's an upgrade on — is optioned so
    // the claimed player has a spot when he reports.
    if (rosterIsFull(draft, claimant, sideOf(player))) {
      // Ours: the player the GM chose, if still on our active roster on his
      // side; otherwise (or a CPU club) the weakest reserve on his side.
      const chosen = claimant === 'user' && userDrop ? draft.players[userDrop] : null;
      const out = chosen && (draft.userTeam.rosterIds || []).includes(chosen.id) && chosen.group !== PLAYER_GROUP.IL
                  && ['SP', 'RP'].includes(chosen.pos) === ['SP', 'RP'].includes(player.pos)
        ? chosen : _weakestReserve(draft, player, claimant);
      if (out) events.push(dropPlayer(draft, out.id, claimant, atMs, { reason: 'corresponding move' }));
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
 * his spot from the free agents. Returns the move, or null when
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

/** More players on this side of the active roster than its share (14). */
function _sideOver(draft, teamId, side) {
  if (!CAP_PHASES.has(draft.phase)) return false;
  const team = teamId === 'user' ? draft.userTeam : (draft.leagueTeams || []).find(t => t.id === teamId);
  let n = 0;
  for (const id of team?.rosterIds || []) {
    const p = draft.players[id];
    if (p && p.group !== PLAYER_GROUP.IL && sideOf(p) === side) n++;
  }
  return n > (side === 'pitcher' ? PITCHER_TARGET : HITTER_TARGET);
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
  if (!team.rosterIds.includes(player.id)) team.rosterIds = [...team.rosterIds, player.id];
  Object.assign(player, { group: tx.toGroup || defaultActiveGroup(player), teamId: tx.teamId, tier: 'active' });
  // The corresponding move (§78 roster balance): a player reporting to a side
  // that's already full — a bat for an arm in a trade — puts that side's
  // weakest reserve on waivers, so his club keeps its 14 and 14 and the side
  // he left opens for a signing.
  if (_sideOver(draft, tx.teamId, sideOf(player))) {
    const out = _weakestReserve(draft, player, tx.teamId, player.id);
    if (out) events.push(dropPlayer(draft, out.id, tx.teamId, tx.effectiveAt, { reason: 'corresponding move' }));
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
 * sign free agents himself and charges the front office for not acting.
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

  // Deadline passed with spots still open: the manager signs free agents (§122).
  const at = team.vacancyDeadlineAt;
  const picked = [];
  const taken  = new Set();
  for (const need of needs.needs) {
    const pick = managerPick(draft, 'user', need, taken);
    if (!pick) continue;
    taken.add(pick.id);
    const res = signPickup(draft, pick.id, 'user', at, 'manager');
    if (res.ok) picked.push(pick.id);
  }
  for (const [k, v] of Object.entries(MANAGER_FILL_PENALTY)) {
    team[k] = Math.max(0, Math.min(100, (team[k] ?? 50) + v));
  }
  team.vacancyDeadlineAt = null;
  events.push({ type: 'MANAGER_FILL', playerIds: picked, atMs: at, penalty: MANAGER_FILL_PENALTY });
  return picked.length > 0;
}

// The free-agent market is never truly empty: independent-league and
// released veterans are always available on minor-league terms. When the
// pool has nobody of the needed type, one of them is created (low OVR).
const DEPTH_POSITIONS = Object.freeze(['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', '2B/SS', '1B/3B']);
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
 * Every player belongs to at most one roster; every IN_TRANSIT
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
  for (const t of state.leagueTeams || []) {
    for (const id of t.rosterIds || []) note(id, `${t.abbr} roster`);
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
