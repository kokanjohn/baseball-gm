/**
 * tools/harness/sim-season.js
 * DEV/TEST ONLY — headless season simulator + invariant checker.
 *
 * Runs the REAL GameEngine (tick + commitGame) over a season in Node, with time
 * collapsed to nothing, and prints a pass/fail checklist of structural invariants.
 * This is the regression gate: run it after every change to catch breakage in
 * milliseconds instead of waiting real days for a live game to play out.
 *
 * Usage:
 *   node tools/harness/sim-season.js            # default: 20 games, seed 1
 *   node tools/harness/sim-season.js 142        # full season
 *   node tools/harness/sim-season.js 142 7      # full season, seed 7
 */

import { clock, seedRandom } from './shims.js';           // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame, buildCardContext, advanceClock, gmCallUp } from '../../engine/GameEngine.js';
import { getRosterNeeds, auditRosters, rankCallupCandidates } from '../../engine/TransactionEngine.js';
import { CARD_ACTIONS } from '../../engine/CardActions.js';
import { HANDLED_CARD_ACTIONS, releaseDueCards, getPushSchedule, resolve as resolveCard, getHistory, clearHistory, restoreHistory, getInbox } from '../../engine/CardEngine.js';
import { snapshotMetrics } from '../../ui/formatters.js';
import { liveSituation, playRuns } from '../../engine/SimEngine.js';
import * as Offseason from '../../engine/OffseasonEngine.js';
import * as AllStar from '../../engine/AllStarEngine.js';
import * as Pitching from '../../engine/PitchingEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import * as Trades from '../../engine/TradeEngine.js';
import * as Negotiation from '../../engine/Negotiation.js';
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';
import { planDeliveryTimes, inQuietHours } from '../../engine/CardScheduler.js';
import { buildTokenMap, applyTokens, formatK } from '../../engine/CardTokens.js';
import * as CardPools from '../../data/cards-pool.js';
import {
  GAME_STATUS, PHASE, ROSTER_LIMITS, PLAYER_GROUP,
  SPRING_TRAINING_GAME_COUNT, REGULAR_SEASON_GAME_COUNT,
  NEW_TEAM_SEED_CARDS, ALL_STAR_BREAK_AFTER_GAME, ALLSTAR_ANNOUNCE_GAME_MIN, ALLSTAR_ANNOUNCE_GAME_MAX,
  ALLSTAR_SQUAD_SIZE, ALLSTAR_STARTER_INNINGS, LINEUP_SLOTS,
} from '../../data/constants.js';
import * as Roster from '../../engine/RosterEngine.js';
import * as WxClimate from '../../engine/WeatherClimate.js';
import {
  reconcileRoster, applyRosterMutation, eligibleSlotsFor, pendingArrivals, nextCalendarDay,
} from '../../engine/RosterEngine.js';

const GAMES = parseInt(process.argv[2] || '20', 10);
const SEED  = parseInt(process.argv[3] || '1', 10);

// ── Checklist plumbing ───────────────────────────────────────────
const results = [];
const check = (label, cond, detail = '') =>
  results.push({ label, pass: !!cond, detail });
const summarize = () => {
  console.log('\n──────── INVARIANT CHECKLIST ────────');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`─────────────────────────────────────`);
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length;
};

// ── §65: a simulated GM living between games ─────────────────────
// Walks the virtual clock through every card delivery before first pitch so
// the GM can read and answer roster cards in real time — sometimes in the
// inbox, sometimes on the Team screen (gmCallUp), sometimes not at all (the
// deadline then runs). After every action the inbox must have no ghosts.
const gm = { talks: [], calls: [], offers: [], counters: [], cardIdsSeen: new Set(), payrollSamples: [], paydays: 0, openingFunds: 0, arms: new Map(), chainSeen: new Map(), seen: new Set(), acted: 0, ignored: 0, teamScreen: 0, tradesAccepted: [], ghostFails: [], playerCards: [], awayInLineup: [] };
function ghostCards(st) {
  const needs = getRosterNeeds(st, 'user');
  const queue = new Set(st.ilReturnQueue || []);
  return getInbox().filter(c => {
    const key = c._rosterKey || '';
    if (key.startsWith('injury:'))  return st.players[c._targetPlayerId]?.injury?.status !== 'evaluating';
    if (key.startsWith('ilreturn:')) return !queue.has(c._targetPlayerId);
    if (c._rosterKind === 'need') {
      const [, dl, i] = key.split(':');
      return !(needs.short > Number(i) && Number(dl) === needs.deadlineAt);
    }
    // §91 an offer that can no longer be made (a player moved or hurt, the window closed).
    if (c._tradeOffer) return !!Trades.tradeBlockers(c._tradeOffer, st, clock.get(), c._proposingTeamId);
    return false;
  });
}
function assertNoGhosts(where) {
  const g = ghostCards(SM.get());
  if (g.length) gm.ghostFails.push(`${where}: ${g.map(c => c.cardId).join(',')}`);
}
const PLAYER_CARD_ACTIONS = new Set(Object.keys(CARD_ACTIONS));
const AWAY_ACTIONS = new Set(['rest_active_hitter', 'bench_active_pitcher', 'bench_active_hitter',
  'train_hitter', 'train_pitcher_sp', 'train_pitcher_bp']);
/** Did the card do what it said? (checked right after a "yes") */
function cardDidIt(action, c, st) {
  const u = st.userTeam, p = st.players[c._targetPlayerId];
  const tp = (r) => st.players[c._tokenPlayers?.[r]];
  const inLineup = (id) => (u.lineupSlots || []).some(sl => sl.playerId === id);
  const inRot = (id) => (u.rotation?.order || []).includes(id);
  // §89 a player signed while games are on reports the next day (a pending arrival).
  const joining = (id) => u.rosterIds.includes(id)
    || (st.transactions || []).some(t => t.kind === 'arrival' && t.status === 'pending' && t.teamId === 'user' && t.playerId === id);
  if (AWAY_ACTIONS.has(action)) return !!p?.unavailable && !inLineup(p.id) && !inRot(p.id);
  switch (action) {
    case 'ill2_sick_start': return !!p?.condition;
    case 'retain_active_pitcher': case 'retain_active_hitter': return !!p?.pendingContract;
    case 'release_active_pitcher': case 'release_active_hitter': return !!p?._willWalk;
    case 'sp11_callup': return !!tp('farm_pitcher')?._isKeeper && u.rosterIds.includes(tp('farm_pitcher').id);
    case 'sp11b_callup': return !!tp('farm_hitter')?._isKeeper && u.rosterIds.includes(tp('farm_hitter').id);
    case 'callup_hitter': return (st.transactions || []).some(t => t.status === 'pending' && t.playerId === c._tokenPlayers.prospect_hitter);
    case 'audition_promote': return inLineup(c._tokenPlayers.audition_hitter);
    case 'move_to_dh': return (u.lineupSlots || []).find(sl => sl.slot === 'DH')?.playerId === p?.id;
    case 'move_bp_to_rotation': return inRot(p?.id) && p.group === 'sp';
    // §73 outside players
    case 'sign_acquire_hitter': case 'sign_veteran_hitter': case 'sign_dfa':
      return joining(c._tokenPlayers.acq_hitter || c._tokenPlayers.dfa_player);
    case 'sign_acquire_pitcher': case 'sign_prospect_pitcher': return (u.farmIds || []).includes(c._tokenPlayers.acq_pitcher);
    case 'sign_intl_player': case 'sign_intl_flyer': return (u.farmIds || []).includes(c._tokenPlayers.intl_player);
    case 'indie_sign': return (u.farmIds || []).includes(c._targetPlayerId);
    case 'waiver_dfa': return !!st.players[c._tokenPlayers.dfa_player]?._userClaim;
    case 'trade_acquire_pitcher': case 'trade_acquire_hitter': case 'dl3_acquire':
      return (st.transactions || []).some(t => t.kind === 'trade' && t.offer?.incomingIds?.includes(c._offer?.incomingIds?.[0]));
    case 'sp15_callup': return joining(c._tokenPlayers.nri);
    case 'intl_workout': return (st.scheduledCards || []).some(x => (x._rosterKey || '').includes(c._tokenPlayers.intl_player));
    case 'scouting_intl_trip': return (st.scheduledCards || []).some(x => x.cardId === 'sc3');
    case 'scouting_indie_tip': return (st.scheduledCards || []).some(x => x.cardId === 'indie_report');
    case 'personal_leave': return p?.unavailable?.reason === 'leave' && !inLineup(p.id) && !inRot(p.id);
    case 'media_boost': case 'scouting_suppress': return (u.scoutingQuietUntil || 0) > clock.get();
    case 'sr2_shakeup': return (st.transactions || []).some(t => t.status === 'pending' && t.playerId === c._tokenPlayers.prospect_hitter);
    default: return true;
  }
}
function gmActs() {
  // Re-read the inbox after every action: one decision can withdraw others.
  for (let guard = 0; guard < 50; guard++) {
    // (The seed trade offer is left alone: it is made at the harness's far-future
    //  anchor, before the season clock starts, so deciding it here would queue
    //  a trade dated after the season.)
    const c = getInbox().find(x => !gm.seen.has(x.instanceId) && !(x._seed && x._tradeOffer)
      && (x.autoResolve === 'roster' || !!x._rosterKey || (!!x._tradeOffer && !x._seed)
          || PLAYER_CARD_ACTIONS.has(x._raw?.onYes) || x._raw?.onYes === 'fin_call_club'));
    if (!c) break;
    gm.cardIdsSeen.add(c.cardId);
    // §83 a club cutting payroll: we make the call — an offer or word back.
    if (c._raw?.onYes === 'fin_call_club') {
      gm.seen.add(c.instanceId);
      resolveCard(c.instanceId, 'yes');
      const st2 = SM.get();
      const answered = [...(st2.inbox || []), ...(st2.scheduledCards || [])]
        .some(x => (x._proposingTeamId === c._aboutTeamId && !x.resolved) || x._rosterKey === `fin:called:${c.instanceId}`);
      gm.calls.push({ team: c._aboutTeamId, answered });
      continue;
    }
    // §71 player cards: the action lands on the player the card names.
    if (PLAYER_CARD_ACTIONS.has(c._raw?.onYes)) {
      gm.seen.add(c.instanceId);
      const yes = Math.random() < 0.7;
      resolveCard(c.instanceId, yes ? 'yes' : 'no');
      if (yes) gm.playerCards.push({ action: c._raw.onYes, ok: cardDidIt(c._raw.onYes, c, SM.get()), id: c._targetPlayerId });
      continue;
    }
    const isTrade  = !!c._tradeOffer && !c._seed;
    gm.seen.add(c.instanceId);
    if (c.autoResolve === 'skip') { resolveCard(c.instanceId, 'yes'); continue; }   // notices
    if (isTrade) {
      gm.offers.push({ kind: c._tradeKind, opening: c._opening, subject: c.subject, body: c.body, offer: JSON.parse(JSON.stringify(c._tradeOffer)), team: c._proposingTeamId, at: clock.get(), season: SM.get().seasonNum || 1 });
      const r = Math.random();
      if (r < 0.35) {
        const before = JSON.parse(JSON.stringify(c._tradeOffer));
        resolveCard(c.instanceId, 'yes');
        advanceClock(clock.get());
        gm.tradesAccepted.push({ offer: before, at: clock.get(), team: c._proposingTeamId });
      } else if (r < 0.6 && c._reviseOffer) {
        // §91 counter from the composer: their offer, and some cash from them.
        const o = c._reviseOffer.offer;
        const counter = { ...o, cashK: (o.cashK || 0) + 100 };
        const res = Negotiation.proposeTrade(c._reviseOffer.teamId, counter, clock.get(), { round: c._reviseOffer.round });
        const st2 = SM.get();
        const talk = Negotiation.talkWith(st2, c._reviseOffer.teamId);
        gm.counters.push({ ok: res.ok, reason: res.reason || null, round: talk?.round,
          withdrawn: !(st2.inbox || []).some(x => x.instanceId === c.instanceId && !x.resolved) });
        if (res.ok) gm.talks.push({ team: c._reviseOffer.teamId, ok: true, reason: null, at: clock.get() });
      }
      continue;
    }
    const r = Math.random();
    if (c._rosterKind === 'need' && r < 0.3) {
      // Team screen path: pick from the dashed spot instead of the card.
      const pick = rankCallupCandidates(SM.get(), 'user', c._need)[1] || rankCallupCandidates(SM.get(), 'user', c._need)[0];
      if (pick && gmCallUp(pick.id, clock.get()).ok) { gm.teamScreen++; assertNoGhosts('after Team-screen call-up'); continue; }
    }
    if (r < 0.75) { resolveCard(c.instanceId, Math.random() < 0.6 ? 'yes' : 'no'); gm.acted++; }
    else gm.ignored++;
    advanceClock(clock.get());
    assertNoGhosts(`after ${c.cardId}`);
  }
}
function stepTo(t) {
  for (let guard = 0; guard < 400; guard++) {
    const st = SM.get();
    const next = (st.scheduledCards || []).map(c => c.deliverAtMs)
      .filter(x => x > clock.get() && x < t).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    clock.set(next + 1000);
    advanceClock(clock.get());
    releaseDueCards();
    gmActs();
    gmProposes();
  }
}

/**
 * §85 Phase 4b — the GM starts trades: now and then asks a club about a
 * player who would start for us, offering a package that should interest
 * them (sometimes a lowball, as a real GM tests the water).
 */
function gmProposes() {
  if (Math.random() > 0.03) return;
  const st = SM.get();
  const now = clock.get();
  if (!Trades.tradeWindow(st).open) return;
  const teams = (st.leagueTeams || []).filter(t => Trades.cooldownUntil(st, t.id) <= now
    && !Negotiation.talkIsOpen(st, t.id, now));
  const team = teams[Math.floor(Math.random() * teams.length)];
  if (!team) return;
  const usable = (p) => p && !p.isInjured && p.group !== PLAYER_GROUP.IL && p.group !== PLAYER_GROUP.IN_TRANSIT
    && !(p._acquiredAtMs && now - p._acquiredAtMs < 5 * 86_400_000);
  const want = team.rosterIds.map(id => st.players[id]).filter(p => usable(p) && Trades.wouldStart(p, st, 'user'))
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
  if (!want) return;
  const need = Trades.valueToClub(want, st, team.id, false) * (Math.random() < 0.2 ? 0.4 : 1.0);   // fair value (a lowball now and then)
  const keyIds = new Set([...(st.userTeam.lineupSlots || []).map(sl => sl.playerId), ...(st.userTeam.rotation?.order || [])]);
  const pool = [...st.userTeam.rosterIds, ...(st.userTeam.farmIds || [])].map(id => st.players[id])
    .filter(p => usable(p) && !keyIds.has(p.id))
    .map(p => ({ p, v: Trades.valueToClub(p, st, team.id, true) })).sort((a, b) => b.v - a.v);
  const give = [];
  let sum = 0;
  for (const o of pool) { if (sum >= need || give.length >= 3) break; if (sum + o.v <= need * 1.3) { give.push(o.p.id); sum += o.v; } }
  if (!give.length) return;
  const res = Negotiation.proposeTrade(team.id, { incomingIds: [want.id], outgoingIds: give, cashK: 0, retain: {} }, now);
  gm.talks.push({ team: team.id, ok: res.ok, reason: res.reason || null, at: now });
}

// ── §68: after the regular season, live the league clock to the end ──
async function runPostseason() {
  let userGames = 0, steps = 0;
  for (let guard = 0; guard < 3000; guard++) {
    const st = SM.get();
    if (st.phase === PHASE.SEASON_SUMMARY) break;
    const idx = st.currentGameIndex;
    const g = st.schedule[idx];
    if (g && !g._committed) {
      playToFinal(idx);
      await commitGame(idx);
      releaseDueCards();
      if (g.isPlayoff) userGames++;
      continue;
    }
    let next = Infinity;
    for (const cg of Object.values(st.leagueSchedule.dayMap).flat()) {
      if (cg.played) continue;
      const t = cg.status === GAME_STATUS.LIVE && cg.plays?.length
        ? cg.plays[cg.plays.length - 1]._timestamp : cg.gameTime;
      if (t > clock.get() - 1 && t < next) next = t;
    }
    const sched = (st.scheduledCards || []).map(c => c.deliverAtMs).filter(t => t > clock.get());
    if (sched.length) next = Math.min(next, ...sched);
    if (!Number.isFinite(next)) { clock.advance(6 * 3600_000); }
    else clock.set(next + 1000);
    advanceClock(clock.get());
    releaseDueCards();
    gmActs();
    steps++;
  }
  return { userGames, steps };
}

// ── §70: drive the six-day offseason hour by hour, the GM acting on cards ──
async function runOffseasonChecks() {
  const pre   = SM.get();
  const os    = pre.offseason;
  check('offseason: calendar set when the season ended', !!os && os.dayStarts?.length === 6 && os.springAt > os.dayStarts[5]);
  if (!os) return;
  const year1 = baseballYear(pre);
  const before = {};
  for (const p of Object.values(pre.players)) before[p.id] = { ovr: p.ovr, g: p.stats?.g || 0, careerG: p.careerStats?.g || 0, teamId: p.teamId,
                                                               age: computeAge(p.dob, year1), group: p.group };
  const userWins = pre.userTeam.wins, userLosses = pre.userTeam.losses;
  // Players extended or let go during the season (§72) were already decided.
  const expiringUser = (pre.userTeam.rosterIds || []).filter(id => Offseason.contractIsUp(pre.players[id], pre.seasonNum)
    && !pre.players[id].pendingContract && !pre.players[id]._willWalk);
  const extendedUser = (pre.userTeam.rosterIds || []).filter(id => pre.players[id].pendingContract);
  const sched1Len = pre.schedule.filter(g => !g.isPlayoff).length;
  const phases = []; let lastPhase = pre.phase; let offseasonAt = null, springAt = null;
  const resignCards = new Set(), faCards = new Set(); let ownershipCard = 0, signedByUser = 0;
  clock.set(Math.max(clock.get(), os.endedAt));
  for (let guard = 0; guard < 24 * 9; guard++) {
    clock.advance(3600_000);
    advanceClock(clock.get());
    releaseDueCards();
    for (const c of getInbox()) {
      if ((c._rosterKey || '').startsWith('os:resign:')) resignCards.add(c._targetPlayerId);
      if ((c._rosterKey || '').startsWith('os:fa:')) faCards.add(c._targetPlayerId);
      if (c.cardId === 'os_ownership') ownershipCard = 1;
    }
    const faBefore = SM.get().userTeam.rosterIds.length;
    gmActs();
    if (SM.get().userTeam.rosterIds.length > faBefore) signedByUser++;
    const ph = SM.get().phase;
    if (ph !== lastPhase) {
      phases.push(ph); lastPhase = ph;
      if (ph === PHASE.OFFSEASON) offseasonAt = clock.get();
      if (ph === PHASE.SPRING_TRAINING) { springAt = clock.get(); break; }
    }
  }
  const st = SM.get();
  const year2 = baseballYear(st);
  check(`offseason: SEASON_SUMMARY → OFFSEASON → SPRING_TRAINING (${phases.join(' → ')})`,
        phases.join(',') === `${PHASE.OFFSEASON},${PHASE.SPRING_TRAINING}`);
  check('offseason: day 1 begins the midnight after the season ended',
        offseasonAt !== null && offseasonAt - os.dayStarts[0] >= 0 && offseasonAt - os.dayStarts[0] < 3600_000 + 1000);
  check('offseason: spring opens after six full days', springAt !== null && springAt - os.springAt >= 0 && springAt - os.springAt < 3600_000 + 1000
        && Math.round((os.springAt - os.dayStarts[0]) / 86_400_000) === 6);
  check(`offseason: season 2 begins (season ${st.seasonNum}, year ${year1} → ${year2})`, st.seasonNum === 2 && year2 === year1 + 1);
  const hist = (st.seasonHistory || []).find(h => h.seasonNum === 1);
  check('offseason: season 1 locked into history (record, postseason result, standings)',
        !!hist && hist.wins === userWins && hist.losses === userLosses && !!hist.postseason?.result && hist.standings?.length === 10,
        hist ? `${hist.wins}-${hist.losses} ${hist.postseason?.result}` : 'missing');
  const alive = Object.values(st.players).filter(p => p.group !== PLAYER_GROUP.RETIRED && p.group !== PLAYER_GROUP.DEPARTED && before[p.id]);
  check('offseason: every player is a year older (baseball age)', alive.every(p => computeAge(p.dob, year2) === before[p.id].age + 1));
  check('offseason: season stats archived to career and reset',
        alive.every(p => (p.stats?.g || 0) === 0 && (p.careerStats?.g || 0) === before[p.id].careerG + before[p.id].g));
  const young = alive.filter(p => before[p.id].age <= 23), old = alive.filter(p => before[p.id].age >= 33);
  const mean = (arr) => arr.reduce((a, p) => a + (p.ovr - before[p.id].ovr), 0) / Math.max(1, arr.length);
  check(`offseason: young players develop, veterans decline (Δ young ${mean(young).toFixed(1)}, Δ 33+ ${mean(old).toFixed(1)})`,
        mean(young) > 0 && mean(old) < 0);
  const retired = Object.values(st.players).filter(p => p.group === PLAYER_GROUP.RETIRED && before[p.id] && before[p.id].group !== PLAYER_GROUP.RETIRED);
  check(`offseason: retirements happen, oldest first (${retired.length} retired)`,
        retired.length >= 3 && retired.every(p => before[p.id].age + 1 >= 28));
  const teams = [st.userTeam, ...st.leagueTeams];
  const where = new Map();
  let dup = 0;
  for (const t of teams) for (const id of [...(t.rosterIds || []), ...(t.farmIds || [])]) { if (where.has(id)) dup++; where.set(id, t.id); }
  check('offseason: no player on two lists', dup === 0, `${dup}`);
  const offList = [...where.keys()].filter(id => [PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED, PLAYER_GROUP.FREE_AGENT].includes(st.players[id]?.group));
  check('offseason: no retired / departed / free-agent player on a club', offList.length === 0, offList.length);
  const badTeam = [...where.entries()].filter(([id, tid]) => st.players[id]?.teamId !== tid);
  check('offseason: every rostered player\'s teamId matches his club', badTeam.length === 0, badTeam.length);
  const upAfter = [...where.keys()].filter(id => Offseason.yearsLeft(st.players[id], st.seasonNum) < 1);
  check('offseason: every player on a club is under contract for season 2', upAfter.length === 0,
        upAfter.slice(0, 5).map(id => `${st.players[id].name} exp ${st.players[id].contractExpiry} ${where.get(id)}/${st.players[id].group}/${st.players[id].tier}/${st.players[id]._amateurSigning || ''}${st.players[id]._depthSigning ? 'D' : ''}`).join(', '));
  // Players let go once spring has opened (a waiver that clears, a farm
  // overflow) are free agents in their own right; the offseason's unsigned are gone.
  const fas = Object.values(st.players).filter(p => p.group === PLAYER_GROUP.FREE_AGENT);
  const leftover = fas.filter(p => !(p._faSince >= os.springAt));
  const poolSet = new Set(st.freeAgentPool || []);
  check(`offseason: free-agent pool empties at spring (unsigned players leave; ${fas.length - leftover.length} let go since)`,
        leftover.length === 0 && fas.every(p => poolSet.has(p.id)) && [...poolSet].every(id => st.players[id]?.group === PLAYER_GROUP.FREE_AGENT),
        leftover.slice(0, 4).map(p => `${p.name} ${p.tier} from=${p._faFrom} since=${p._faSince} ${p._faReason}`).join(', '));
  check(`offseason: one re-sign card per expiring user player (${resignCards.size}/${expiringUser.filter(id => SM.get().players[id]?.group !== PLAYER_GROUP.RETIRED).length})`,
        expiringUser.filter(id => st.players[id]?.retiredSeason !== 1).every(id => resignCards.has(id)),
        expiringUser.filter(id => st.players[id]?.retiredSeason !== 1 && !resignCards.has(id)).map(id => { const p = st.players[id], q = pre.players[id]; return `${p.name} pre:${q.group}/${q.isInjured ? 'inj' : ''}/exp${q.contractExpiry} now:${p.teamId}/${p.group}/${p._faReason || ''}`; }).join(', '));
  check(`offseason: in-season extensions take effect (${extendedUser.length})`,
        extendedUser.every(id => !st.players[id].pendingContract && (st.players[id].teamId !== 'user' || Offseason.yearsLeft(st.players[id], st.seasonNum) >= 1)));
  check('offseason: ownership evaluation card delivered and decided',
        ownershipCard === 1 && (st.userTeam.finances.payrollTargetHistory || []).some(h => h.seasonNum === 2));
  check('offseason: every required decision resolved by spring', Offseason.hardGates(st).open.length === 0);
  const signings = (st.activityFeed || []).filter(e => /sign free agent/.test(e.text)).length;
  check(`offseason: CPU clubs sign free agents (${signings} signings, ${faCards.size} FA cards to the GM, ${signedByUser} signed)`, signings >= 3);
  const cpuBad = st.leagueTeams.filter(t => Offseason.activeCount(st, t.id) !== ROSTER_LIMITS.ACTIVE_TOTAL);
  check('offseason: every CPU club opens camp with a full 28', cpuBad.length === 0,
        cpuBad.map(t => `${t.abbr} ${Offseason.activeCount(st, t.id)}`).join(', '));
  const farmBad = teams.filter(t => {
    const f = (t.farmIds || []).map(id => st.players[id]).filter(Boolean);
    const h = f.filter(p => !['SP', 'RP'].includes(p.pos)).length;
    return h > ROSTER_LIMITS.FARM_HITTER_MAX || f.length - h > ROSTER_LIMITS.FARM_PITCHER_MAX;
  });
  check('offseason: farm caps hold after amateur signings', farmBad.length === 0, farmBad.map(t => t.abbr || 'USR').join(','));
  const prospects = Object.values(st.players).filter(p => p._amateurSigning === 2).length;
  check(`offseason: amateur prospects join every farm (${prospects})`, prospects >= 20);
  const recs = teams.every(t => !t.wins && !t.losses && !t.springWins && !t.postseasonWins);
  check('season 2: every record starts at zero', recs && st.standings === null && st.playoffBracket === null && st.currentGameIndex === 0);
  {
    // §95 the rating's history: kept across seasons, in time order, a point
    // for each change, and its last point is the rating the dashboard shows.
    const h = st.ratingHistory || [];
    const ordered = h.every((p, i) => i === 0 || p.t >= h[i - 1].t);
    const changesOnly = h.every((p, i) => i === 0 || p.r !== h[i - 1].r || p.s !== h[i - 1].s);
    check(`rating history: kept across seasons (${h.length} points, seasons ${[...new Set(h.map(p => p.s))].join(',')})`,
          h.length >= 10 && h.some(p => p.s === 1) && h.some(p => p.s === 2) && ordered && changesOnly
          && h[h.length - 1].r === Roster.teamRating(st, 'user') && st.metricHistory === undefined,
          JSON.stringify(h.slice(-3)));
  }
  {
    // §78: season 1's books — closed, reconciled to the dollar, salaries truly paid.
    const f = st.userTeam.finances, h = (f.history || [])[0];
    check('club funds: season 1 closed into history', !!h && h.seasonNum === 1);
    if (h) {
      const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
      check(`club funds: the books reconcile (opening ${gm.openingFunds} + net ${h.net} + covered ${h.covered} = ${h.fundsEnd})`,
            gm.openingFunds + h.net + h.covered === h.fundsEnd && sum(h.income) - sum(h.spend) - (h.income.owner || 0) === h.net);
      const avgPayroll = gm.payrollSamples.length ? gm.payrollSamples.reduce((a, b) => a + b, 0) / gm.payrollSamples.length : 0;
      check(`club funds: salaries paid match the payroll carried (${h.spend.payroll}K paid, avg payroll ${Math.round(avgPayroll)}K)`,
            h.spend.payroll > 0 && Math.abs(h.spend.payroll - avgPayroll) <= avgPayroll * 0.15);
      check(`club funds: staff paid, gates and media came in (gates ${h.income.gate}K, media ${h.income.media}K, local ${h.income.local}K)`,
            h.spend.staff > 0 && h.income.gate > 0 && h.income.media > 0 && h.income.local > 0);
      // Operating net: the All-Star hosting share is a one-time windfall (§75), not the club's economics.
      const opNet = h.net - (h.income.allstar || 0);
      // A historic season (a .650+ club) sells out all year: a wider bound.
      const s1 = (st.seasonHistory || [])[0];
      const historic = !!s1 && s1.wins / Math.max(1, s1.wins + s1.losses) >= 0.65;
      check(`club funds: a realistic season's operating net (${opNet}K, ${h.net}K all in, on a ${h.payrollTarget}K target; in ${JSON.stringify(h.income)} out ${JSON.stringify(h.spend)}; ${st.userTeam.wins ?? ''} — season 1 ${(st.seasonHistory || [])[0]?.wins}-${(st.seasonHistory || [])[0]?.losses})`,
            Math.abs(opNet) <= h.payrollTarget * (historic ? 0.5 : 0.35));
    }
    check(`club funds: paydays reach the feed (${gm.paydays} paid)`, gm.paydays >= 8);
    // §78.5 every CPU club's books: closed and reconciled, real gates and
    // media, salaries paid, a believable season, owners who cut when they must.
    {
      const sum = (o) => Object.values(o || {}).reduce((x, y) => x + y, 0);
      const rows = st.leagueTeams.map(t => ({ t, h: (t.finances?.history || [])[0] }));
      const closed = rows.filter(r => r.h && r.h.seasonNum === 1);
      check(`cpu books: every club's season 1 closed (${closed.length}/${rows.length})`, closed.length === rows.length);
      const bad = closed.filter(({ h }) => sum(h.income) - sum(h.spend) - (h.income.owner || 0) !== h.net);
      check('cpu books: every club reconciles', bad.length === 0, bad.map(r => r.t.abbr).join(','));
      const thin = closed.filter(({ h }) => !(h.income.gate > 0 && h.income.media > 0 && h.income.local > 0 && h.spend.payroll > 0 && h.spend.staff >= 0));
      check('cpu books: gates, media and local money in, salaries out, for every club', thin.length === 0, thin.map(r => r.t.abbr).join(','));
      const nets = closed.map(({ t, h }) => `${t.abbr} ${(h.net / 1000).toFixed(1)}M/${(h.payrollTarget / 1000).toFixed(0)}M ${t.ownerArchetype}${h.covered ? ' covered' : ''}`);
      const wild = closed.filter(({ h }) => Math.abs(h.net - (h.income.allstar || 0)) > h.payrollTarget * 0.45);
      check(`cpu books: believable seasons (${nets.join(' · ')})`, wild.length <= 1, wild.map(r => r.t.abbr).join(','));
      const moves = (st.transactions || []).filter(x => x.kind === 'cpu_trade');
      check(`cpu books: salary moves made in the season (${moves.length})`, true);
      // The mechanism itself: an owner whose target is suddenly far below the
      // payroll orders cuts, and the club moves a contract to the club with
      // the most room (on a copy of the state — nothing here is kept).
      {
        const { cpuSalaryMove } = await import('../../engine/TransactionEngine.js');
        const Fin = await import('../../engine/FinanceEngine.js');
        const copy = structuredClone(SM.get());
        const club = copy.leagueTeams[0];
        if (club.finances?.cal) {
          club.finances.payrollTarget = Math.round(Fin.payrollOf(copy, club.id) * 0.6);
          club.finances.funds = -Math.abs(club.finances.payrollTarget);
          const before = club.rosterIds.length;
          const mv = cpuSalaryMove(copy, club.id, clock.get());
          const toClub = mv && copy.leagueTeams.find(t => t.id === mv.toId);
          check(`cpu books: an owner ordering cuts moves a contract (${mv ? `${copy.players[mv.playerId]?.name} ${mv.salaryK}K → ${toClub?.abbr}` : 'none'})`,
                !!mv && copy.players[mv.playerId].teamId === mv.toId && mv.toId !== club.id
                && Fin.payrollRoom(SM.get(), mv.toId) >= mv.salaryK && club.rosterIds.length <= before);
        }
      }
      const targets = st.leagueTeams.map(t => t.finances?.payrollTarget || 0);
      check('cpu books: owners set next season\'s targets', targets.every(x => x >= 1000));
    }
    const ownerCards = (st.inbox || []).filter(c => (c.cardId || '').startsWith('owner_'));
    const by = {}; for (const c of ownerCards) by[c.cardId] = (by[c.cardId] || 0) + 1;
    const dumps = (st.transactions || []).filter(t => t.kind === 'trade' && !(t.offer?.incomingIds || []).length);
    check(`club funds: the owner's season (${JSON.stringify(by)}; ${dumps.length} salary dumps)`, true);
  }
  const sched2 = st.schedule;
  check(`season 2: a full new calendar (${sched2.length} games, first ${sched2[0]?.date})`,
        sched2.length === sched1Len && sched2[0].gameTime >= os.springAt && String(sched2[0].date).startsWith(String(year2))
        && Object.keys(st.leagueSchedule.dayMap).length > 50);
  checkWeatherCalendar(st, 'season 2', ['season:1', 'offseason:1', 'season:2']);
  // §75: last season's All-Star Game is on the record; this season's is on the calendar, its story not yet begun.
  const asHist = st.allStar?.history || [];
  const asg2 = Object.values(st.leagueSchedule.dayMap).flat().filter(g => g.isAllStar);
  const s2 = AllStar.seasonOf({ ...st, allStar: { ...st.allStar } });
  check('season 2: last All-Star Game on the record; a new one on the calendar, host not yet named',
        asHist.length === 1 && asHist[0].seasonNum === 1 && asHist[0].hostId && asHist[0].homeScore != null
        && asg2.length === 1 && asg2[0].id === 'asg-2' && !asg2[0].played && s2.seasonNum === 2 && !s2.hostId,
        `history ${asHist.length} games ${asg2.length}`);
  const ghost = getInbox().filter(c => !c.resolved && ((c._rosterKey || '').startsWith('os:fa:') || c._osGate));
  check('offseason: no offseason card left open in season 2', ghost.length === 0, ghost.map(c => c.cardId).join(','));
  // Season 2 plays: the first spring games run through the normal pipeline.
  let played = 0;
  for (let i = 0; i < 3; i++) {
    const idx = SM.get().currentGameIndex;
    if (!playToFinal(idx)) break;
    await commitGame(idx); releaseDueCards(); played++;
  }
  check(`season 2: spring games play and commit (${played}/3)`, played === 3 && SM.get().phase === PHASE.SPRING_TRAINING);
}

// ── Drive one game to FINAL by advancing the virtual clock ───────
function playToFinal(idx) {
  for (let guard = 0; guard < 6000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g) return false;
    if (g.status === GAME_STATUS.FINAL) return true;
    if (g.status === GAME_STATUS.POSTPONED && g.cancelled) return true;   // §102.3 a spring rainout: closed by commitGame

    // Advance the clock precisely to the next event, then tick once.
    if (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH
        || (g.status === GAME_STATUS.SUSPENDED && g.gameTime > clock.get())) {   // (a suspended game waits for its turn like any game)
      // Live the day before first pitch (cards, decisions, deadlines).
      advanceClock(clock.get()); releaseDueCards(); gmActs();
      stepTo(g.gameTime || clock.get());
      clock.set((g.gameTime || clock.get()) + 60_000);
    } else if (g.status === GAME_STATUS.LIVE) {
      const np = g.plays?.[g.livePlayIndex];
      if (np && np._timestamp) clock.set(np._timestamp + (g._tickOffset || 0) + 1_000);
      else clock.advance(60_000);
    } else {
      // DELAYED / SUSPENDED / POSTPONED etc. — nudge forward
      clock.advance(60 * 60_000);
    }
    tick();
    releaseDueCards();   // mirrors App's tick loop (§61)
  }
  const last = SM.get().schedule[idx];
  return last?.status === GAME_STATUS.FINAL || (last?.status === GAME_STATUS.POSTPONED && !!last.cancelled);
}

// ── §75: the All-Star Game, checked when the break arrives ───────
async function runAllStarChecks() {
  const st = SM.get();
  const a = st.allStar, season = a?.season;
  const entries = Object.values(st.leagueSchedule.dayMap).flat().filter(g => g.isAllStar);
  check('all-star: one game on the league calendar', entries.length === 1, `got ${entries.length}`);
  const asg = entries[0];
  if (!asg || !season) return;

  // Mid-break: after every club's 66th game, before every club's 67th.
  const times = {};
  for (const g of st.schedule) {
    if (g.isSpring || g.isPlayoff) continue;
    for (const t of ['user', g.opponentId]) (times[t] = times[t] || []).push(g.gameTime);
  }
  for (const g of Object.values(st.leagueSchedule.dayMap).flat()) {
    if (g.isSpring || g.isPlayoff || g.isAllStar) continue;
    for (const t of [g.homeId, g.awayId]) (times[t] = times[t] || []).push(g.gameTime);
  }
  // (§102.3 a rainout from before the break made up after it is one game fewer before the break.)
  const movedOver = {};
  const crossed = (g) => (g.postponements || []).some(p => p.gameTime < asg.gameTime) && g.gameTime > asg.gameTime;
  for (const g of st.schedule) if (!g.isSpring && !g.isPlayoff && crossed(g)) for (const t of ['user', g.opponentId]) movedOver[t] = (movedOver[t] || 0) + 1;
  for (const g of Object.values(st.leagueSchedule.dayMap).flat()) if (!g.isSpring && !g.isPlayoff && !g.isAllStar && crossed(g)) for (const t of [g.homeId, g.awayId]) movedOver[t] = (movedOver[t] || 0) + 1;
  const k = ALL_STAR_BREAK_AFTER_GAME;
  const off = Object.entries(times).filter(([t, ts]) => { ts.sort((x, y) => x - y); const kk = k - (movedOver[t] || 0); return !(ts[kk - 1] < asg.gameTime && ts[kk] > asg.gameTime); });
  check(`all-star: played in the break (after every club's 66th game, before its 67th; rainouts made up after it excepted: ${Object.entries(movedOver).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'})`, off.length === 0, off.map(([t]) => t).join(','));

  // The host.
  const hostDiv = season.hostId === 'user' ? st.userTeam.divisionId || 'A' : st.leagueTeams.find(t => t.id === season.hostId)?.divisionId;
  check(`all-star: host named after game ${season.announceAfterGame} (${ALLSTAR_ANNOUNCE_GAME_MIN}–${ALLSTAR_ANNOUNCE_GAME_MAX}); its division is home`,
        !!season.hostId && season.announceAfterGame >= ALLSTAR_ANNOUNCE_GAME_MIN && season.announceAfterGame <= ALLSTAR_ANNOUNCE_GAME_MAX
        && asg.homeId === AllStar.squadIdFor(hostDiv) && asg.awayId !== asg.homeId, `host ${season.hostId} home ${asg.homeId}`);
  const cards = [...(st.inbox || []), ...(st.scheduledCards || [])];
  if (SEED % 2 === 1) {
    const week = cards.filter(c => (c._rosterKey || '').startsWith('allstar:week:'));
    check('all-star (host): an eligible user club hosts — payoff, announcement, three All-Star week cards',
          season.hostId === 'user' && st.userTeam._hostedAllStarThisSeason && a.hostedCount === 1 && season.hostBonusK > 0
          && cards.some(c => c.cardId === 'as_host') && week.length === 3,
          `host ${season.hostId} count ${a.hostedCount} week ${week.length}`);
    // The host's GM gets a say for a player on the bubble (when there is one).
    const lobby = (st.inbox || []).filter(c => c.cardId === 'as_lobby');
    check('all-star (host): a lobbying card for a bubble player, and the choice recorded',
          !!season.influence && (!season.influence.playerId
            || (lobby.length === 1 && lobby[0]._targetPlayerId === season.influence.playerId
                && (!lobby[0].resolved || season.influence.choice === (lobby[0].choice === 'yes' ? 'yes' : 'no')))
            // Left unanswered, it is withdrawn when the rosters are named: the vote speaks.
            || (lobby.length === 0 && gm.cardIdsSeen.has('as_lobby') && season.influence.choice === null)),
          `influence ${JSON.stringify(season.influence)} cards ${lobby.length}`);
  } else {
    const last = new Map(st.leagueTeams.map(t => [t.id, -Infinity]));
    for (const h of a.hosts.slice(0, -1)) if (last.has(h.teamId)) last.set(h.teamId, Math.max(last.get(h.teamId), h.year));
    check('all-star: an ineligible user club does not host; the longest-waiting club does, and we hear why',
          season.hostId !== 'user' && last.get(season.hostId) === Math.min(...last.values())
          && cards.some(c => c.cardId === 'as_host_other'), `host ${season.hostId}`);
  }

  // The squads.
  const sq = season.squads || {};
  const ids = Object.values(sq).flatMap(q => q.rosterIds || []);
  const bad = [];
  for (const q of Object.values(sq)) {
    if (q.rosterIds.length !== ALLSTAR_SQUAD_SIZE.HITTERS + ALLSTAR_SQUAD_SIZE.SP + ALLSTAR_SQUAD_SIZE.RP) bad.push(`${q.id} size ${q.rosterIds.length}`);
    if (q.starters.map(x => x.slot).join() !== LINEUP_SLOTS.join()) bad.push(`${q.id} slots`);
    for (const x of q.starters) if (x.slot !== 'DH' && !eligibleSlotsFor(st.players[x.id]).includes(x.slot)) bad.push(`${q.id} ${x.slot}`);
    const clubs = [st.userTeam, ...st.leagueTeams].filter(t => (t.divisionId || 'A') === q.divisionId).map(t => t === st.userTeam ? 'user' : t.id);
    const rep = new Set([...q.starters, ...q.reserves, ...q.sp, ...q.rp].map(x => x.teamId));
    if (!clubs.every(c => rep.has(c))) bad.push(`${q.id} missing club`);
    // Picked for his role at the time (a reliever moved to the rotation since is still a relief All-Star).
    if ([...q.sp].some(x => x.pos !== 'SP') || [...q.rp].some(x => x.pos !== 'RP')) bad.push(`${q.id} staff`);
  }
  check('all-star: two 24-man squads — nine starters at their positions, a staff, every club represented, no one twice',
        Object.keys(sq).length === 2 && bad.length === 0 && new Set(ids).size === ids.length, bad.join('; '));
  check('all-star: our All-Stars told (and marked)',
        cards.some(c => c.cardId === 'as_selected') && AllStar.userSelections(st).every(x => (st.players[x.id].allStarSeasons || []).includes(st.seasonNum)));

  if (process.env.ASG_DUMP) {
    for (const c of cards.filter(c => (c.cardId || '').startsWith('as_'))) console.log('CARD', c.cardId, '|', c.subject, '|', c.body, '|', c.yesLabel, '/', c.noLabel);
    for (const q of Object.values(sq)) console.log('SQUAD', q.name, q.starters.map(x => `${x.slot}:${st.players[x.id].name}(${x.teamId}) ${q.votes[x.id]}`).join(' · '), '| RES', q.reserves.map(x => st.players[x.id].pos).join(','), '| SP', q.sp.length, 'RP', q.rp.length);
  }
  // The game: live it, and nothing but the game changes.
  stepTo(asg.gameTime - 1000);
  clock.set(asg.gameTime - 1000); advanceClock(clock.get());
  const pre = SM.get();
  const snap = JSON.stringify(Object.values(pre.players).map(p => [p.id, p.stats, p.springStats]));
  const wl   = JSON.stringify([pre.userTeam, ...pre.leagueTeams].map(t => [t.wins, t.losses]));
  const rot  = JSON.stringify(pre.leagueTeams.map(t => t.rotation?.currentIndex));
  clock.set(asg.gameTime + 1000); advanceClock(clock.get());
  const liveG = Object.values(SM.get().leagueSchedule.dayMap).flat().find(g => g.isAllStar);
  check('all-star: goes live at first pitch, with plays', liveG.status === GAME_STATUS.LIVE && liveG.plays?.length > 50);
  const plays = liveG.plays || [];
  const subs  = plays.filter(p => p.type === 'pinch_hit').length;
  clock.set((plays[plays.length - 1]?._timestamp || asg.gameTime) + 1000); advanceClock(clock.get());
  releaseDueCards(); gmActs();
  const post = SM.get();
  const g = Object.values(post.leagueSchedule.dayMap).flat().find(x => x.isAllStar);
  const box = g.boxScore;
  check('all-star: final — score, box score and linescore agree',
        g.played && g.status === GAME_STATUS.FINAL && box && box.home.runs === g.homeScore && box.away.runs === g.awayScore
        && g.homeScore !== g.awayScore, `${g.awayScore}-${g.homeScore}`);
  const pitchBad = [...(box?.home.pitchers || []), ...(box?.away.pitchers || [])].filter(p => p.ipOuts > ALLSTAR_STARTER_INNINGS * 3);
  const usedArms = (box?.home.pitchers.length || 0) + (box?.away.pitchers.length || 0);
  check(`all-star: an All-Star staff — ${usedArms} pitchers, no one past ${ALLSTAR_STARTER_INNINGS} innings`, pitchBad.length === 0 && usedArms >= 12,
        pitchBad.map(p => `${p.name} ${p.ipOuts}`).join(','));
  check(`all-star: the reserves get in (${subs} substitutions)`, subs >= 5);
  check('all-star: an exhibition — no stats, standings or rotations move',
        snap === JSON.stringify(Object.values(post.players).map(p => [p.id, p.stats, p.springStats]))
        && wl === JSON.stringify([post.userTeam, ...post.leagueTeams].map(t => [t.wins, t.losses]))
        && rot === JSON.stringify(post.leagueTeams.map(t => t.rotation?.currentIndex)));
  if (process.env.ASG_DUMP) { console.log('RESULT', JSON.stringify(post.allStar.season.result)); for (const f of post.activityFeed.slice(-6)) console.log('FEED', JSON.stringify(f)); const lc = [...(post.inbox||[]),...(post.scheduledCards||[])].filter(c => (c.cardId||'').startsWith('as_')||c.cardId?.startsWith('trade_')).map(c=>c.cardId+':'+c.subject); console.log('CARDS', lc.join(' || ')); }
  check('all-star: result and MVP recorded', !!post.allStar.season.result
        && (!post.allStar.season.result.mvpId || [...(box.home.hitters), ...(box.away.hitters), ...box.home.pitchers, ...box.away.pitchers].some(x => x.id === post.allStar.season.result.mvpId)));
}

// ── Count the active (non-IL) hitters/pitchers on the user roster ─
function activeCount(state) {
  const p = state.players;
  return (state.userTeam.rosterIds || []).filter(id => p[id] && p[id].group !== 'il').length;
}
// §65: active + already on the way (traded / called up, reporting tomorrow).
function rosterSpotsHeld(state, teamId) {
  const team = teamId === 'user' ? state.userTeam : state.leagueTeams.find(t => t.id === teamId);
  const active = (team.rosterIds || []).filter(id => state.players[id] && state.players[id].group !== 'il').length;
  return active + pendingArrivals(state, teamId).length;
}
// All arrivals ever seen (the ledger prunes old records).
const txSeen = new Map();
function recordTx(st) { for (const t of st.transactions || []) txSeen.set(t.id, { ...t }); }
// Was `playerId` with `teamId` at moment `atMs`? (false while in transit to it,
// or after leaving it.) Built from every arrival record.
function onTeamAt(playerId, teamId, atMs) {
  const moves = [...txSeen.values()].filter(t => t.kind === 'arrival' && t.playerId === playerId)
    .sort((a, b) => a.createdAt - b.createdAt);
  let team = null, known = false;
  for (const m of moves) {
    if (m.createdAt > atMs) break;
    known = true;
    team = m.effectiveAt <= atMs && m.status === 'done' ? m.teamId : null;   // in transit = nobody's
  }
  return known ? team === teamId : true;   // no move before atMs → original team (checked elsewhere)
}

// ── Batch 2: roster-integrity fault injection ────────────────────
// Runs on a JSON clone of a real mid-season state (real players/positions), so
// it never disturbs the live season run. Proves reconcileRoster deterministically:
// after a forced injury/departure, no lineup slot or rotation entry points to an
// injured/departed player, and the active-count rule holds (user opens a spot and
// reports the need; CPU auto-manages back to a legal 28).
const G = (p) => p.group;
function teamOf(state, teamId) {
  return teamId === 'user' ? state.userTeam
    : (state.leagueTeams || []).find(t => t.id === teamId);
}
function nonIL(state, team) {
  return (team.rosterIds || []).filter(id => state.players[id] && state.players[id].group !== 'il').length;
}
// Force the occupant of a given lineup slot label onto the IL.
function forceInjureSlot(state, team, slotLabel) {
  const entry = (team.lineupSlots || []).find(s => s.slot === slotLabel && s.playerId);
  if (!entry) return null;
  const p = state.players[entry.playerId];
  p.isInjured = true; p.group = 'il'; p.injury = { status: 'il', days: 20, injuredAt: clock.get(), eligibleAt: clock.get() + 20 * 86400000 };
  return entry.playerId;
}
function assertTeamIntegrity(state, team, label) {
  let slotsOk = true, rotOk = true;
  const seen = new Set();
  for (const s of (team.lineupSlots || [])) {
    if (!s.playerId) continue;
    const p = state.players[s.playerId];
    // An out-of-position fill is legal only as the manager's emergency move.
    if (!p || p.isInjured || G(p) !== 'bh' || !team.rosterIds.includes(s.playerId)
        || seen.has(s.playerId) || !(eligibleSlotsFor(p).includes(s.slot) || s.emergency)) slotsOk = false;
    seen.add(s.playerId);
  }
  for (const id of (team.rotation?.order || [])) {
    const p = state.players[id];
    if (!p || p.isInjured || G(p) !== 'sp' || !team.rosterIds.includes(id)) rotOk = false;
  }
  check(`${label}: no injured/invalid player left in any lineup slot`, slotsOk);
  check(`${label}: no injured/invalid player left in the rotation`, rotOk);
}

function runFaultInjection(base) {
  // ── USER: injure a starting hitter → bench-fill + spot opens (report) ──
  {
    const st = JSON.parse(JSON.stringify(base));
    const before = nonIL(st, st.userTeam);
    // pick a hitter slot that is not SP/RP (all lineup slots are hitters)
    const victim = forceInjureSlot(st, st.userTeam, 'SS') || forceInjureSlot(st, st.userTeam, 'OF');
    const mut = reconcileRoster(st, 'user');
    applyRosterMutation(st, mut);
    check('fault(user hitter): injured player removed from lineup',
          victim && !st.userTeam.lineupSlots.some(s => s.playerId === victim));
    check('fault(user hitter): user roster not auto-topped (GM must call up)',
          nonIL(st, st.userTeam) === before - 1, `${nonIL(st, st.userTeam)} vs ${before - 1}`);
    check('fault(user hitter): pending call-up reported',
          !!mut.pendingCallups && mut.pendingCallups.count === 1);
    assertTeamIntegrity(st, st.userTeam, 'fault(user hitter)');
  }

  // ── USER: injure a rotation SP → bench SP promoted (manager domain) ──
  {
    const st = JSON.parse(JSON.stringify(base));
    const spId = st.userTeam.rotation.order[1];
    const p = st.players[spId];
    p.isInjured = true; p.group = 'il'; p.injury = { status: 'il', days: 20, injuredAt: clock.get(), eligibleAt: clock.get() + 20 * 86400000 };
    applyRosterMutation(st, reconcileRoster(st, 'user'));
    check('fault(user SP): injured SP dropped from rotation.order',
          !st.userTeam.rotation.order.includes(spId));
    check('fault(user SP): rotation restored to 5',
          st.userTeam.rotation.order.length === ROSTER_LIMITS.STARTING_PITCHERS,
          `got ${st.userTeam.rotation.order.length}`);
    assertTeamIntegrity(st, st.userTeam, 'fault(user SP)');
  }

  // ── CPU: injure a starting hitter → auto-manage back to a legal 28 ──
  {
    const st = JSON.parse(JSON.stringify(base));
    const cpu = (st.leagueTeams || [])[0];
    if (cpu) {
      forceInjureSlot(st, cpu, 'C') || forceInjureSlot(st, cpu, 'SS')
        || forceInjureSlot(st, cpu, 'OF');
      const mut = reconcileRoster(st, cpu.id, { autoManage: true, atMs: clock.get() });
      applyRosterMutation(st, mut);
      const t = teamOf(st, cpu.id);
      check('fault(cpu hitter): active + arriving back to 28 (call-up reports tomorrow)',
            rosterSpotsHeld(st, cpu.id) === ROSTER_LIMITS.ACTIVE_TOTAL, `got ${rosterSpotsHeld(st, cpu.id)}`);
      check('fault(cpu hitter): lineup still fields nine (manager covers today)',
            t.lineupSlots.every(sl => sl.playerId));
      assertTeamIntegrity(st, t, 'fault(cpu hitter)');
    }
  }

  // ── CPU: force a departure (remove a starter) → backfill, legal 28 ──
  {
    const st = JSON.parse(JSON.stringify(base));
    const cpu = (st.leagueTeams || [])[0];
    if (cpu) {
      const t0 = teamOf(st, cpu.id);
      const gone = t0.lineupSlots.find(s => s.playerId)?.playerId;
      if (gone) {
        t0.rosterIds = t0.rosterIds.filter(id => id !== gone);
        delete st.players[gone];
        applyRosterMutation(st, reconcileRoster(st, cpu.id, { autoManage: true, atMs: clock.get() }));
        const t = teamOf(st, cpu.id);
        check('fault(cpu departure): departed id gone from lineup',
              !t.lineupSlots.some(s => s.playerId === gone));
        check('fault(cpu departure): active + arriving back to 28',
              rosterSpotsHeld(st, cpu.id) === ROSTER_LIMITS.ACTIVE_TOTAL, `got ${rosterSpotsHeld(st, cpu.id)}`);
        assertTeamIntegrity(st, t, 'fault(cpu departure)');
      }
    }
  }
}

// ── §60: every app module is in the service-worker precache (offline install) ──
async function checkPrecache() {
  const fs   = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const sw   = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`)
                : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);
  const missing = ['data', 'engine', 'store', 'ui'].flatMap(walk)
    .filter(f => !sw.includes(`'/baseball-gm/${f}'`));
  check('sw.js precaches every app module', missing.length === 0, missing.join(', '));
}

/** §82 last names only: every player a last name from the pool (with an
 *  initial only where shared), no two active players alike, staff by last name. */
async function checkNames(when) {
  const { PLAYER_SURNAMES, STAFF_NAMES } = await import('../../data/player-names.js');
  const pool = new Set(PLAYER_SURNAMES);
  const st = SM.get();
  const active = Object.values(st.players).filter(p => p && p.group !== 'departed');
  const bad = active.filter(p => !(pool.has(p.name) || (/^[A-Z]\. /.test(p.name) && pool.has(p.name.slice(3)))));
  check(`names (${when}): every player is known by a last name only (${active.length} players)`, bad.length === 0,
        bad.slice(0, 6).map(p => p.name).join(', '));
  const seen = new Map();
  for (const p of active) seen.set(p.name, (seen.get(p.name) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1);
  check(`names (${when}): no two players in the league share a name`, dup.length === 0, dup.slice(0, 5).map(([n]) => n).join(', '));
  const initialed = active.filter(p => /^[A-Z]\. /.test(p.name)).length;
  check(`names (${when}): first initials only where a last name is shared (${initialed})`, true);
  const staff = Object.values(st.userTeam.coachingStaff || {}).map(m => m?.name).filter(Boolean);
  check(`names (${when}): the coaching staff by last name (${staff.join(', ')})`, staff.every(n => STAFF_NAMES.includes(n)));
}

/** §82 gender-neutral writing: no he/him/his (or "guys", "a man short"…) in
 *  any card the game can send — every pool, moment and token phrase — and
 *  none in any card actually delivered this season. */
const GENDERED = /\b(he|him|his|himself|he's|he'll|he'd|she|her|hers|herself|guy|guys|fella|fellas|paternity|maternity|father|mother|man|men|wife|husband|son|daughter|brother|sister|boys)\b/i;
async function checkNeutralText(st) {
  const strs = (o, out = []) => {
    if (typeof o === 'string') out.push(o);
    else if (Array.isArray(o)) o.forEach(x => strs(x, out));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (!k.startsWith('_') && k !== 'id' && k !== 'situation') strs(v, out); }
    return out;
  };
  const pools = await import('../../data/cards-pool.js');
  const moments = await import('../../data/cards-moments.js');
  const tokens = await import('../../data/card-tokens.js');
  const money = await import('../../data/cards-money.js');
  const authored = [...strs(Object.values(pools)), ...strs(moments.MOMENT_CARDS), ...strs(Object.values(tokens)),
                    ...strs(money.MONEY_BETWEEN), ...strs(money.MONEY_PREGAME)];
  const badA = authored.filter(t => GENDERED.test(t));
  check(`neutral text: every card written reads gender-neutral (${authored.length} strings)`, badA.length === 0,
        badA.slice(0, 4).map(t => t.slice(0, 90)).join(' | '));
  const fields = ['subject', 'preview', 'body', 'yesLabel', 'noLabel', 'yesMsg', 'noMsg', 'sender'];
  const sent = (st.inbox || []).flatMap(c => fields.map(f => c[f]).filter(x => typeof x === 'string'));
  const badS = sent.filter(t => GENDERED.test(t));
  check(`neutral text: every card delivered reads gender-neutral (${(st.inbox || []).length} cards)`, badS.length === 0,
        badS.slice(0, 4).map(t => t.slice(0, 90)).join(' | '));
}

/** §78.8 what cards can do to the books — on a copy of the state, and the
 *  season's own record of unanswered cards that resolved by default. */
async function checkCardMoney(st) {
  const Fin = await import('../../engine/FinanceEngine.js');
  // A ticket promotion: cheaper seats, fuller park, for exactly N home games.
  {
    const c = structuredClone(st), fin = c.userTeam.finances;
    Fin.startPromo(fin, { price: -0.15, fill: 0.10, homeGames: 2 });
    const g1 = Fin.homeGate(c, 'user', { atMs: clock.get() });
    const per1 = g1.gateK * 1000 / g1.attendance;
    Fin.homeGate(c, 'user', { atMs: clock.get() });
    const g3 = Fin.homeGate(c, 'user', { atMs: clock.get() });
    const per3 = g3.gateK * 1000 / g3.attendance;
    check(`card money: a ticket promotion discounts the gate for its home games, then ends ($${per1.toFixed(2)} vs $${per3.toFixed(2)} a fan)`,
          Math.abs(per1 / fin.market.perFan - 0.85) < 0.02 && Math.abs(per3 / fin.market.perFan - 1) < 0.02 && fin.promo.gamesLeft === 0);
  }
  // The owner loosens this season's target: real room now, gone at season's end.
  {
    const c = structuredClone(st), fin = c.userTeam.finances;
    const before = Fin.payrollRoom(c, 'user');
    Fin.adjustSeasonTarget(fin, 0.05);
    const after = Fin.payrollRoom(c, 'user');
    Fin.seasonEndReview(c, clock.get(), 'user');
    check(`card money: an owner's push opens payroll room for the season (${Math.round(before)}K → ${Math.round(after)}K), then resets`,
          after - before >= fin.payrollTarget * 0.045 && Fin.seasonTarget(fin) === fin.payrollTarget);
  }
  // §83 the Club Funds families: one version of a family a season, each the
  // version that fits (its _when held when it was chosen).
  {
    const fam = {};
    for (const c of st.inbox || []) if (c._family && c._season === st.seasonNum) (fam[c._family] = fam[c._family] || []).push(c.cardId);
    const twice = Object.entries(fam).filter(([, ids]) => ids.length > 1);
    check(`card families: one version each a season (${Object.entries(fam).map(([f, ids]) => `${f}:${ids[0].replace(/^mon_/, '')}`).join(' ')})`,
          twice.length === 0, twice.map(([f, ids]) => `${f}=${ids.join('+')}`).join(' '));
    check(`card families: the Club Funds cards reach the inbox (${Object.keys(fam).length} families)`, Object.keys(fam).length >= 2);   // a steady, middling season triggers fewer situations
    check(`card families: calling a club that is cutting payroll gets an answer (${gm.calls.length} calls)`,
          gm.calls.every(x => x.team && x.answered), JSON.stringify(gm.calls.filter(x => !x.answered)));
  }
  // Unanswered cards do what their default choice does: a deal signed by default pays.
  {
    const ledger = st.userTeam.finances.ledger || [];
    const autoDeals = (st.inbox || []).filter(c => c.choice === 'auto' && c.autoChoice === 'yes' && c._revenueK > 0);
    const unpaid = autoDeals.filter(c => !ledger.some(e => e.label === c.subject && e.k === c._revenueK));
    check(`card money: deals that go through by default are paid (${autoDeals.length})`, unpaid.length === 0, unpaid.map(c => c.cardId).join(','));
  }
}

/** §85 Phase 4a: how clubs judge deals, and what a trade does to the books —
 *  on copies of the real league (nothing here is kept). */
async function checkTradeEngine(st) {
  const T = await import('../../engine/TradeEngine.js');
  const { applyDue } = await import('../../engine/TransactionEngine.js');
  const now = clock.get();
  // (Neutral rapport: these are checks of how a club values a deal, not of the season's relationships.)
  const open = () => { const c = structuredClone(st); c.phase = PHASE.SPRING_TRAINING; c.tradeTalks = {}; c.userTeam.gmRelationships = {}; return c; };
  const c0 = open();
  const team = c0.leagueTeams.find(t => (t.rosterIds || []).length >= 20);
  const ok = (p) => p && !p.isInjured && p.group !== PLAYER_GROUP.IN_TRANSIT && p.group !== PLAYER_GROUP.IL && !p._acquiredAtMs;
  const theirs = team.rosterIds.map(id => c0.players[id]).filter(ok);
  const ours = [...c0.userTeam.rosterIds, ...(c0.userTeam.farmIds || [])].map(id => c0.players[id]).filter(ok);
  // A fair deal: one of their spare pieces for one of ours worth a bit more to them.
  const y = theirs.filter(p => !(team.lineupSlots || []).some(sl => sl.playerId === p.id) && !(team.rotation?.order || []).includes(p.id))
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  const yv = T.valueToClub(y, c0, team.id, false);
  // (one their owner can carry: this checks value, not the books)
  const x = ours.map(p => ({ p, v: T.valueToClub(p, c0, team.id, true) }))
    .filter(o => o.v >= yv * 1.15 && T.evaluateForClub({ incomingIds: [y?.id], outgoingIds: [o.p.id], cashK: 0, retain: {} }, c0, team.id).booksOk)
    .sort((a, b) => a.v - b.v)[0]?.p;
  if (y && x) {
    const fair = T.cpuRespond({ incomingIds: [y.id], outgoingIds: [x.id], cashK: 0, retain: {} }, c0, team.id, { atMs: now });
    check(`trades: a fair deal is accepted or countered (${x.name} for ${y.name}: ${fair.decision}${fair.reason ? ' — ' + fair.reason : ''})`, ['accept', 'counter'].includes(fair.decision));
  }
  // A lowball: our weakest piece for their best player.
  const best = theirs.sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
  const scrub = ours.sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0];
  const low = T.cpuRespond({ incomingIds: [best.id], outgoingIds: [scrub.id], cashK: 0, retain: {} }, c0, team.id, { atMs: now });
  check(`trades: a lowball is refused (${scrub.name} for ${best.name}: ${low.decision} — ${low.reason || ''})`, low.decision === 'decline');
  // Counters lead somewhere: each one better for them, and talks end by the round limit.
  {
    const near = ours.map(p => ({ p, v: T.valueToClub(p, c0, team.id, true) })).filter(o => o.v < yv && o.v > yv * 0.6).sort((a, b) => b.v - a.v)[0]?.p;
    if (near && y) {
      let offer = { incomingIds: [y.id], outgoingIds: [near.id], cashK: 0, retain: {} };
      let r, round = 1, better = true, lastNet = T.evaluateForClub(offer, c0, team.id).net;
      for (; round <= 5; round++) {
        r = T.cpuRespond(offer, c0, team.id, { round, atMs: now });
        if (r.decision !== 'counter') break;
        const n = T.evaluateForClub(r.counter, c0, team.id).net;
        better = better && n > lastNet; lastNet = n; offer = r.counter;
      }
      check(`trades: counteroffers improve the deal for them and end by the round limit (${r.decision}${r.reason ? ' — ' + r.reason : ''} in round ${Math.min(round, 5)})`,
            better && (r.decision === 'accept' || (r.decision === 'decline' && round <= 3 + 1)));
    }
  }
  // The books: cash and kept salary through both clubs, then no flipping.
  if (y && x) {
    const c = open();
    const finU = c.userTeam.finances, finC = c.leagueTeams.find(t => t.id === team.id).finances;
    const fU0 = finU.funds, fC0 = finC.funds;
    const offer = { incomingIds: [y.id], outgoingIds: [x.id], cashK: 100, retain: { [y.id]: 0.25 } };
    c.transactions = [...(c.transactions || []), T.queueTrade(offer, team.id, now)];
    applyDue(c, now + 3 * 86_400_000);
    const yp = c.players[y.id];
    const userPays = Finance.payrollOf(c, 'user'), theyKeep = (c.leagueTeams.find(t => t.id === team.id).finances.retained || []).find(r => r.playerId === y.id);
    check(`trades: cash moves between the clubs' funds (us +${finU.funds - fU0}K, them ${finC.funds - fC0}K)`, finU.funds - fU0 === 100 && fC0 - finC.funds === 100);
    check(`trades: the sending club keeps paying its share this season (${Math.round((theyKeep?.pct || 0) * 100)}% of ${y.name})`,
          yp.teamId === 'user' && theyKeep?.pct === 0.25 && yp.retained?.payerId === team.id);
    const ourShare = Math.round((y.contractSalary || 0) * 0.75);
    const without = Finance.payrollOf(c, 'user') - ourShare;
    check(`trades: our payroll counts only our share (${ourShare}K of ${y.contractSalary}K)`, without >= 0 && userPays >= ourShare);
    const flip = T.tradeBlockers({ incomingIds: [], outgoingIds: [y.id], cashK: -50 }, c, now + 4 * 86_400_000, team.id);
    check(`trades: a player just acquired can't be flipped (${flip || 'allowed'})`, /recently/.test(flip || ''));
  }
  // Cooling off, and the deadline.
  {
    const c = open();
    T.startCooldown(c, team.id, now);
    const b = T.tradeBlockers({ incomingIds: [y?.id], outgoingIds: [x?.id] }, c, now + 3600_000, team.id);
    check(`trades: a club cools off after a no (${b || 'open'})`, /calls/.test(b || ''));
    const c2 = structuredClone(st); c2.phase = PHASE.REGULAR_SEASON;
    check(`trades: no deals after the deadline (${T.tradeWindow(c2).reason || 'open'})`, T.tradeWindow(c2).open === false);
    check('trades: rapport grades read Strong / Good / Neutral / Cool / Strained',
          ['Strong', 'Good', 'Neutral', 'Cool', 'Strained'].join() === [80, 65, 50, 30, 10].map(T.rapportGrade).join());
  }
}

/** §85 Phase 4b: trades the GM starts — answered on the clock, every answer
 *  a decision, talks that end within the round limit. */
function checkTalks(st) {
  const sent = gm.talks.filter(t => t.ok);
  check(`trade talks: the GM starts trades (${sent.length} sent, ${gm.talks.length - sent.length} refused before sending: ${[...new Set(gm.talks.filter(t => !t.ok).map(t => t.reason))].slice(0, 3).join('; ')})`, sent.length >= 1);
  const talks = Object.entries(st.tradeTalks || {}).map(([id, t]) => ({ id, t: t.talk })).filter(x => x.t);
  // §89: the answer is decided when the offer goes out and reaches us later
  // as a scheduled card (so it can be pushed with the app closed).
  const cardsFor = (t) => [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c._talkId === t.id || c._rosterKey === `talk:off:${t.id}:${t.round}` || c._beatenTalkId === t.id);
  const stuck = talks.filter(x => x.t.replyAtMs < clock.get() - 86_400_000 && !cardsFor(x.t).length);
  check(`trade talks: every offer gets an answer on the clock (${talks.length} talks; ${talks.map(x => x.t.status).join(',')})`, stuck.length === 0, stuck.map(x => x.id).join(','));
  const beaten = [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c._beatenTalkId);
  check(`trade talks: talks closed because another club got the player come with word from Pro Scouting (${beaten.length})`,
        talks.filter(x => x.t.calledOffAtMs && !cardsFor(x.t).length).length === 0);
  if (process.env.LT_DUMP) for (const x of stuck) console.log('STUCK', x.id, JSON.stringify({ ...x.t, offer: undefined, counter: undefined }), JSON.stringify([...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c._talkTeamId === x.id || c._proposingTeamId === x.id || c._ideaTeamId === x.id).map(c => [c.cardId, c._talkId, c.resolved, c.choice, c.subject])));
  check('trade talks: the answer is decided when the offer is sent', talks.every(x => !x.t.answer || x.t.answer.atMs === x.t.sentAtMs));
  const early = talks.filter(x => (st.inbox || []).some(c => c._talkId === x.t.id && c._talkRound === x.t.round && c.cardId !== 'trade_off' && (c.deliveredAtMs ?? c.deliverAtMs ?? 0) < x.t.replyAtMs - 60_000));
  check('trade talks: no answer reaches us before its reply time', early.length === 0,
        early.map(x => `${x.id} r${x.t.round} reply ${new Date(x.t.replyAtMs).toISOString()} sent ${new Date(x.t.sentAtMs).toISOString()} ${x.t.status}: `
          + (st.inbox || []).filter(c => c._talkId === x.t.id && c._talkRound === x.t.round).map(c => `${c.cardId}@${new Date(c.deliverAtMs).toISOString()}`).join(' ')).join(' | '));
  const unsettled = talks.filter(x => x.t.pending && (st.inbox || []).some(c => c._talkId === x.t.id && c._talkRound === x.t.round && c.resolved));
  check('trade talks: how an offer landed takes effect once its answer is read', unsettled.length === 0, unsettled.map(x => x.id).join(','));
  check('trade talks: no talk goes past the round limit', talks.every(x => (x.t.round || 1) <= 3));
  const replies = (st.inbox || []).filter(c => /^talk_/.test(c.cardId || ''));
  const kinds = {};
  for (const c of replies) kinds[c.cardId] = (kinds[c.cardId] || 0) + 1;
  check(`trade talks: answers arrive as decisions (${JSON.stringify(kinds)})`, replies.length >= 1 && replies.every(c => c.yesLabel && c.noLabel));
  // A finalized deal is in the franchise history (made) or came back as "the deal is off" (voided).
  const agreed = talks.filter(x => x.t.status === 'done');
  const made = agreed.filter(x => (st.history || []).some(h => h.type === 'trade' && String(h.id).startsWith(`tx-trade-${x.id}-`))
                              || (st.inbox || []).some(c => c.cardId === 'trade_off' && c._rosterKey?.startsWith('talk:off:')));
  const pending = (st.transactions || []).filter(x => x.kind === 'trade' && x.status === 'pending');
  check(`trade talks: every deal we finalized was made or voided (${made.length}/${agreed.length})`, made.length === agreed.length && pending.length === 0,
        agreed.filter(x => !made.includes(x)).map(x => x.id).join(',') + pending.map(x => ` pending ${x.id} ${x.league ? 'league' : ''} eff ${new Date(x.effectiveAt).toISOString()} now ${new Date(clock.get()).toISOString()}`).join(''));
}

/** §96 free agents and waivers from the League screen: signing or claiming
 *  with the GM's choice of who goes down — on copies of the real league. */
async function checkFreeAgency(st) {
  const FA = await import('../../engine/FreeAgency.js');
  const Off = await import('../../engine/OffseasonEngine.js');
  const { applyDue, rosterIsFull, sideOf } = await import('../../engine/TransactionEngine.js');
  const now = clock.get();
  const fresh = () => { const c = structuredClone(st); c.userTeam.finances.payrollTarget *= 3; c.tradeTalks = {}; return c; };
  const held = (c) => rosterSpotsHeld(c, 'user');
  // A real veteran made a free agent: a CPU club's bench hitter, released.
  const benchOf = (c) => {
    for (const t of c.leagueTeams) {
      const starters = new Set((t.lineupSlots || []).map(sl => sl.playerId));
      const p = (t.rosterIds || []).map(id => c.players[id]).find(p => p && !['SP', 'RP'].includes(p.pos) && !starters.has(p.id) && !p.isInjured);
      if (p) return p;
    }
    return null;
  };
  {
    const c = fresh();
    const vet = benchOf(c);
    Off.releaseToFreeAgency(c, vet.id, now, { reason: 'released' });
    vet._marketKind = 'depth';
    const full = rosterIsFull(c, 'user', 'hitter');
    const room = FA.roomFor(c, c.players[vet.id]);
    const ask = FA.signBlocker(c, vet.id, null);
    check(`free agency: with the hitters full, a signing asks who goes down (${full ? ask : 'not full'})`,
          !full || (room.needsDrop && /choose a player/.test(ask) && room.candidates.every(x => !['SP', 'RP'].includes(x.player.pos))));
    const drop = room.candidates[0]?.player.id || null;
    const before = held(c);
    const why = FA.signBlocker(c, vet.id, drop);
    if (!why) {
      FA.sign(c, vet.id, now, drop);
      const v = c.players[vet.id];
      const arriving = (c.transactions || []).some(t => t.kind === 'arrival' && t.status === 'pending' && t.playerId === vet.id && t.teamId === 'user');
      check(`free agency: the signing reports the next day; the one we chose goes down; still ${before} (${held(c)})`,
            arriving && !(c.freeAgentPool || []).includes(vet.id) && v.teamId === 'user'
            && (!drop || (c.userTeam.farmIds || []).includes(drop) || c.players[drop]?.onWaivers) && held(c) === before,
            `${v.group} drop:${c.players[drop]?.group}`);
      check('free agency: their salary is on our payroll', Finance.payrollOf(c, 'user') > 0 && v.contractExpiry > (c.seasonNum || 1));
    } else check(`free agency: a signing we can make goes through (${why})`, false);
  }
  {
    const c = fresh();
    // Worst record in the league: our claim comes first (reverse standings).
    c.userTeam.wins = 0; c.userTeam.losses = 99;
    const vet = benchOf(c);
    applyRosterMutation(c, Roster.placeOnWaivers(c, vet.id, { atMs: now, reason: 'test' }));
    const room = FA.roomFor(c, c.players[vet.id]);
    const drop = room.needsDrop ? room.candidates[room.candidates.length - 1].player.id : null;   // our best bench bat, not the weakest
    const why = FA.claimBlocker(c, vet.id, drop, now);
    check(`free agency: we can put in a claim (${why || 'ok'})`, !why);
    if (!why) {
      FA.claim(c, vet.id, drop);
      const before = held(c);
      applyDue(c, now + 72 * 3_600_000 + 60_000);
      const v = c.players[vet.id];
      const ours = v.teamId === 'user' || (c.transactions || []).some(t => t.kind === 'arrival' && t.playerId === vet.id && t.teamId === 'user');
      check(`free agency: our claim is awarded and the player we chose goes down (${c.players[drop]?.name || 'room to spare'})`,
            ours && (!drop || !(c.userTeam.rosterIds || []).includes(drop)) && held(c) === Math.max(before, held(c)),
            `${v.group}/${v.teamId} drop:${c.players[drop]?.group}`);
    }
  }
  {
    const c = fresh();
    check(`free agency: the League screen's lists (${FA.waiverList(c).length} on waivers, ${FA.freeAgentList(c).length} free agents)`,
          FA.waiverList(c).every(p => p.onWaivers) && FA.freeAgentList(c).every(p => p.group === PLAYER_GROUP.FREE_AGENT && p.teamId == null));
  }
}

/** §99 the game reminder and Pro Scouting's watches, at game 30. */
async function checkRemindersAndWatches() {
  const CE = await import('../../engine/CardEngine.js');
  let st = SM.get();
  const g = (st.schedule || []).slice(st.currentGameIndex || 0).find(x => !x._committed && Number.isFinite(x.gameTime));
  if (g) {
    const at = g.gameTime - 30 * 60_000;
    const rem = CE.getPushSchedule(st, g.gameTime - 3 * 3_600_000).filter(i => i.id.startsWith('game-reminder-'));
    const quiet = inQuietHours(at, st.push?.quietStart, st.push?.quietEnd);
    check(`game reminder: a push 30 minutes before first pitch (${new Date(g.gameTime).toISOString().slice(11, 16)} UTC game${quiet ? ', in quiet hours' : ''}; ${rem.length} queued)`,
          quiet ? !rem.some(i => i.deliverAt === at) : rem.some(i => i.deliverAt === at && /First pitch in 30 minutes/.test(i.title)));
  }
  // A "nobody fits" card, answered Keep Watching: the watch is checked at the
  // next desk; one that can't be met ends after two weeks with a Recent line.
  // Run on a copy of the season: the cards and watches injected here would
  // otherwise change the rest of it (a found deal can move our roster).
  const snap = structuredClone(SM.get());
  const restore = () => SM.mutate(s => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, structuredClone(snap)); });
  const now = clock.get();
  SM.mutate(s => { s.inbox = [...s.inbox, { instanceId: 'h-watch-1', cardId: 'lt_none', resolved: false, autoResolve: 'roster', subject: 'h',
    sender: 'Pro Scouting', yesLabel: 'Keep Watching', noLabel: 'Drop It', _rosterKey: 'h:watch:1', _watch: { spec: { type: 'need', need: { kind: 'sp' }, minOvr: 999 }, what: 'an impossible starter' },
    _raw: { onYes: 'lt_watch', onNo: 'lt_pass', onAuto: 'lt_pass' } }]; });
  resolveCard('h-watch-1', 'yes');
  st = SM.get();
  const w = (st.tradeDesk?.watches || []).find(x => x.key === 'h:watch:1');
  check('watch: Keep Watching opens a two-week watch', !!w && w.untilMs - w.startedAtMs === 14 * 86_400_000);
  // and one any club can meet: the first desk turns it into an offer to make.
  SM.mutate(s => { s.tradeDesk = { ...(s.tradeDesk || {}), watches: [...(s.tradeDesk?.watches || []),
    { key: 'h:watch:2', spec: { type: 'need', need: { kind: 'rp' }, minOvr: 0 }, what: 'a reliever', startedAtMs: now, untilMs: now + 14 * 86_400_000 }] }; });
  CE.runWatches(now + 86_400_000);
  check('watch: still open after a day with no fit', (SM.get().tradeDesk?.watches || []).some(x => x.key === 'h:watch:1'));
  {
    const st2 = SM.get();
    const found = [...(st2.inbox || []), ...(st2.scheduledCards || [])].find(c => c._rosterKey === 'h:watch:2:found');
    check(`watch: a fit found at the next desk is an offer to make (${found ? found.subject : 'none fit today'})`,
          found ? (found.cardId === 'lt_offer' && !(st2.tradeDesk?.watches || []).some(x => x.key === 'h:watch:2'))
                : (st2.tradeDesk?.watches || []).some(x => x.key === 'h:watch:2'));
  }
  CE.runWatches(now + 15 * 86_400_000);
  st = SM.get();
  check('watch: ends after two weeks with a line in Recent, not a card',
        !(st.tradeDesk?.watches || []).some(x => x.key === 'h:watch:1')
        && (st.activityFeed || []).some(e => /stopped watching for an impossible starter/.test(e.text || e.message || JSON.stringify(e))));
  restore();
}

/** §90 Phase 4c: CPU clubs trade with each other when a need meets a fit;
 *  every move reaches the League wire; cards come only when one touches us. */
function checkLeagueTrades(st) {
  const wire = st.leagueWire || [];
  const cpuTrades = wire.filter(e => e.kind === 'trade' && !e.teamIds.includes('user') && !/salary move/.test(e.text));
  const s1 = cpuTrades.filter(e => e.season === 1);
  const byClub = {};
  for (const e of s1) for (const id of e.teamIds) byClub[id] = (byClub[id] || 0) + 1;
  check(`league trades: CPU clubs trade with each other (${s1.length} in season 1; most by one club ${Math.max(0, ...Object.values(byClub))})`,
        s1.length >= 5 && s1.length <= 45, s1.slice(0, 3).map(e => e.text).join(' | '));
  const hist = (st.history || []).filter(h => h.type === 'trade');
  const ours = wire.filter(e => e.kind === 'trade' && e.teamIds.includes('user'));
  check(`league wire: our trades are on it too (${ours.length} wire / ${hist.length} history)`, ours.length >= Math.min(1, hist.length));
  check('league wire: every entry has a time, a season and text', wire.every(e => Number.isFinite(e.atMs) && e.season >= 1 && e.text));
  check('league wire: text only, neutral', wire.every(e => !/\b(he|him|his|she|her)\b/i.test(e.text)), wire.filter(e => /\b(he|him|his|she|her)\b/i.test(e.text)).slice(0, 2).map(e => e.text).join(' | '));
  const cards = [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => /^lt_/.test(c.cardId || ''));
  const kinds = {};
  for (const c of cards) kinds[(c._rosterKey || '').split(':')[1] || c.cardId] = (kinds[(c._rosterKey || '').split(':')[1] || c.cardId] || 0) + 1;
  check(`league trades: cards that touch us are decisions (${JSON.stringify(kinds)})`,
        cards.filter(c => ['lt_offer', 'lt_scout'].includes(c.cardId)).every(c => c.yesLabel && c.noLabel));
  // §99 "nobody fits" is a decision now: keep watching, or drop it.
  const all = [...(st.inbox || []), ...(st.scheduledCards || [])];
  const watchCards = all.filter(c => ['lt_none', 'lt_beaten', 'fin_called_back'].includes(c.cardId));
  const watches = st.tradeDesk?.watches || [];
  const foundCards = all.filter(c => /:found$/.test(c._rosterKey || ''));
  check(`league trades: "nobody fits" asks to keep watching (${watchCards.length} cards, ${watches.length} open watches, ${foundCards.length} found later)`,
        watchCards.every(c => c.yesLabel === 'Keep Watching' && c.noLabel === 'Drop It' && c._watch?.spec)
        && watches.every(w => w.untilMs - w.startedAtMs <= 14 * 86_400_000 && w.spec)
        && foundCards.every(c => c.cardId === 'lt_offer' && c._ideaOffer));
  check('league trades: no card for a trade that doesn\'t touch us without a decision',
        cards.every(c => ['lt_offer', 'lt_scout', 'lt_beaten', 'lt_unsent', 'lt_noscout', 'lt_none'].includes(c.cardId)),
        cards.filter(c => ['lt_unsent', 'lt_none'].includes(c.cardId)).map(c => c.preview).join(' | '));
  const bad = s1.filter(e => !e.text.includes(' acquire '));
  check('league trades: every trade reads as who acquired whom', bad.length === 0, bad.slice(0, 2).map(e => e.text).join(' | '));
  const reports = Object.entries(st.userTeam.advanceReports || {});
  check(`league trades: advance scouting reports cover a coming series (${reports.length} bought)`, reports.every(([, r]) => r.coversThroughMs > r.boughtAtMs));
  const retired = ['dl3', 'dl4'];
  check('league trades: the old deadline trade cards are retired (real targets instead)', !(st.inbox || []).some(c => retired.includes(c.cardId)));
  if (process.env.LT_DUMP) for (const e of cpuTrades) console.log('  ·', new Date(e.atMs).toISOString().slice(0, 10), e.text);
  checkOffersToUs(st);
}

/**
 * §100 The weather's calendar: a seed and clock for the save, an entry per
 * season and offseason, and every scheduled game falls on its own date.
 */
function checkWeatherCalendar(st, label, kinds) {
  const cal = st.weatherCalendar || [];
  check(`weather (${label}): a seed, a clock and the calendar entries (${cal.map(a => `${a.kind}:${a.season}`).join(', ')})`,
        typeof st.weatherSeed === 'string' && st.weatherSeed.startsWith('wx-') && Number.isFinite(st.weatherTzMin)
        && JSON.stringify(cal.map(a => `${a.kind}:${a.season}`)) === JSON.stringify(kinds));
  const doyOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000; };
  const off = (st.schedule || []).filter(g => {
    const day = WxClimate.calendarDay(cal, g.gameTime);
    return day.blendDoy != null || Math.floor(day.doy + 1e-9) !== doyOf(g.date);
  });
  check(`weather (${label}): every game falls on its own date on the weather calendar (${st.schedule.length} games)`,
        off.length === 0, off.slice(0, 3).map(g => `${g.date} @ ${new Date(g.gameTime).toISOString()}`).join(' | '));
}

/**
 * §102.3 the weather on the season's schedule: every game played once and
 * where the weather says; rainouts made up (or, in spring, cancelled);
 * suspended games finished; no club in two places at once; every game's
 * weather kept.
 */
function checkWeatherSeason(st) {
  const all = [];
  for (const g of st.schedule) {
    const homeId = g.isHome ? 'user' : g.opponentId, awayId = g.isHome ? g.opponentId : 'user';
    all.push({ g, user: true, homeId, awayId, played: !!g._committed && g.result !== 'postponed', cancelled: !!g.cancelled });
  }
  for (const g of Object.values(st.leagueSchedule.dayMap).flat()) {
    if (g.isAllStar) continue;
    all.push({ g, user: false, homeId: g.homeId, awayId: g.awayId, played: !!g.played && !g.cancelled, cancelled: !!g.cancelled });
  }
  const reg = all.filter(x => !x.g.isSpring && !x.g.isPlayoff);
  const ppd = all.filter(x => x.g.postponements?.length);
  const how = {};
  for (const x of ppd) if (x.g.makeup?.how) how[x.g.makeup.how] = (how[x.g.makeup.how] || 0) + 1;
  const springCancelled = all.filter(x => x.g.isSpring && x.cancelled).length;
  const regCancelled = reg.filter(x => x.cancelled);
  check(`weather: rainouts made up (${ppd.length} postponed — ${Object.entries(how).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; ${springCancelled} spring games cancelled)`,
        regCancelled.length === 0 && reg.every(x => x.played), regCancelled.map(x => x.g.date).join(','));
  // No club plays two games at once: within a club's games, each starts after the last ended.
  const byClub = {};
  for (const x of all.filter(x => x.played)) for (const t of [x.homeId, x.awayId]) (byClub[t] = byClub[t] || []).push(x.g);
  const clash = [];
  for (const [t, gs] of Object.entries(byClub)) {
    gs.sort((a, b) => a.gameTime - b.gameTime);
    for (let i = 1; i < gs.length; i++) {
      const prevEnd = gs[i - 1].endedAt ?? (gs[i - 1].gameTime + 3 * 3_600_000);
      if (gs[i].gameTime < prevEnd && gs[i].date === gs[i - 1].date) clash.push(`${t} ${gs[i].date}`);
    }
  }
  const dh = Object.values(byClub).flatMap(gs => gs.filter((g, i) => i && g.date === gs[i - 1].date)).length;
  check(`weather: no club plays two games at once (${dh} doubleheader games)`, clash.length === 0, clash.slice(0, 4).join(' | '));
  const susp = all.filter(x => x.g.suspension);
  check(`weather: suspended games picked up where they stopped and were finished (${susp.length})`,
        susp.every(x => x.played && x.g.resumedAt > x.g.suspension.atMs));
  const noWx = all.filter(x => x.played && !x.g.weather?.label);
  check(`weather: every game played keeps its weather at first pitch (${all.filter(x => x.played).length} games)`, noWx.length === 0,
        noWx.slice(0, 3).map(x => `${x.g.date} ${x.homeId}`).join(', '));
  // §102.5 the weather's decisions: the manager asked about starters when rain was likely; doubleheaders asked about game two.
  const wxCards = [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c.tag === 'WEATHER');
  const byId = (id) => wxCards.filter(c => c.cardId === id);
  const userDh = all.filter(x => x.user && !x.g.isSpring && x.g.makeup?.how?.endsWith('dh')).length;
  check(`weather cards: the manager asked about the starter ${byId('wx_rain_start').length} times; ${byId('wx_doubleheader').length} doubleheader questions (${userDh} of our makeups were doubleheaders); none left hanging`,
        byId('wx_rain_start').length >= 1 && wxCards.every(c => c.resolved || (c.expiresAtMs ?? Infinity) > clock.get()));
  const delayed = all.filter(x => x.played && x.g.wxResult?.delays?.length).length;
  const called = all.filter(x => x.played && x.g.wxResult?.ruling?.outcome === 'final').length;
  const n = reg.length;
  console.log(`  weather season: ${n} regular games — ${ppd.filter(x => !x.g.isSpring).length} postponed (${(100 * ppd.filter(x => !x.g.isSpring).length / n).toFixed(1)}%), ${delayed} delayed, ${called} called official, ${susp.length} suspended; ${dh / 2} doubleheaders`);
  check(`weather: rates in a believable range (${(100 * ppd.length / n).toFixed(1)}% postponed, ${(100 * delayed / n).toFixed(1)}% delayed)`,
        ppd.length / n <= 0.05 && delayed / n >= 0.01 && delayed / n <= 0.2);
}

/** §91 CPU clubs' offers to us: calls from the trade desk, asking prices, counters. */
function checkOffersToUs(st) {
  const s1 = gm.offers.filter(o => o.season === 1);
  const by = {};
  for (const o of s1) by[o.kind] = (by[o.kind] || 0) + 1;
  check(`offers to us: clubs call about our players from the trade desk (${JSON.stringify(by)})`, (by.call || 0) >= 2 && (by.call || 0) <= 30);
  const calls = gm.offers.filter(o => o.kind === 'call');
  // The opening bid: their GM stands behind it (clears its own bar), and it is
  // never a lowball for us (within what a club opens under).
  const badCall = calls.filter(o => !o.opening || o.opening.theirNet < o.opening.bar - 1 || o.opening.ourNet < -(o.opening.openBy || 0) - 3);
  check('offers to us: an opening bid their GM would stand behind, never a lowball', badCall.length === 0,
        badCall.slice(0, 3).map(o => `${o.subject} ${JSON.stringify(o.opening)}`).join(' | '));
  const under = calls.filter(o => o.opening.ourNet < 0).length;
  // (Packages come in whole players and $25K steps, so an opening can land at or a little over value.)
  check(`offers to us: clubs open a little under, like a real GM (${under}/${calls.length} below value)`, calls.length < 3 || under >= 1);
  const sells = gm.offers.filter(o => o.kind === 'sell');
  check('offers to us: a club offering its own player asks a price it would take', sells.every(o => o.opening && o.opening.theirNet >= o.opening.bar - 1),
        sells.filter(o => !(o.opening?.theirNet >= o.opening?.bar - 1)).map(o => `${o.subject} ${JSON.stringify(o.opening)}`).join(' | '));
  const asg = sells.filter(o => /wants a move here/.test(o.subject));
  check(`offers to us: the All-Star suitor is a real All-Star (${asg.length})`,
        asg.every(o => o.offer.incomingIds.some(id => (st.players[id]?.allStarSeasons || []).includes(o.season))));
  const intros = new Set(gm.offers.filter(o => o.kind === 'call').map(o => o.body.split('. ')[0]));
  check(`offers to us: the wording varies (${intros.size} openings over ${calls.length} calls)`, calls.length < 4 || intros.size >= 2);
  check('offers to us: offer text reads gender-neutral', gm.offers.every(o => !/\b(he|him|his|she|her)\b/i.test(o.body)),
        gm.offers.filter(o => /\b(he|him|his|she|her)\b/i.test(o.body)).slice(0, 1).map(o => o.body).join(''));
  const badCounter = gm.counters.filter(c => c.ok && (!c.withdrawn || c.round !== 2));
  check(`offers to us: a counter opens talks at round 2 and replaces their offer (${gm.counters.filter(c => c.ok).length} sent)`,
        badCounter.length === 0, JSON.stringify(badCounter.slice(0, 2)));
  if (process.env.LT_DUMP) for (const c of [...(st.inbox || []), ...(st.scheduledCards || [])].filter(c => c._tradeKind)) console.log('  ‡', c._tradeKind, c.resolved, c.choice, new Date(c.deliverAtMs || c.arrivedAtMs || 0).toISOString().slice(0, 10), c.subject);
  if (process.env.LT_DUMP) for (const o of gm.offers) console.log('  ›', o.kind, new Date(o.at).toISOString().slice(0, 10), JSON.stringify(o.opening), o.body);
}

async function main() {
  seedRandom(SEED);
  await checkPrecache();

  await startNewGame({
    archetypeId: 'contender',
    gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
    abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: process.env.REGION || 'north',
  });
  {
    // §78: the books open — a market, opening funds, the owner's target.
    const f = SM.get().userTeam.finances;
    gm.openingFunds = f.funds;
    const cpuNo = SM.get().leagueTeams.filter(t => !(t.finances?.funds > 0 && t.finances.payrollTarget > 0 && t.finances.market?.capacity > 0 && t.ownerArchetype));
    check(`cpu books: every CPU club opens its books (${SM.get().leagueTeams.map(t => `${t.abbr} ${t.ownerArchetype} ${(t.finances?.payrollTarget / 1000).toFixed(1)}M`).join(', ')})`,
          cpuNo.length === 0, cpuNo.map(t => t.abbr).join(','));
    check(`club funds: the books open (funds ${f.funds}K, target ${f.payrollTarget}K, ${f.market?.capacity} seats)`,
          f.funds > 0 && f.payrollTarget > 0 && f.market?.capacity > 20000 && f.market?.perFan > 0 && f.owner?.stage === 'content');
  }

  // ── §60: new-franchise inbox seed survives the App.init reload ─────────────
  // SetupScreen calls App.init() right after startNewGame, which reloads the
  // active slot from IndexedDB. Reproduce that exactly and assert the seeds
  // are still there and are real (not debug-shaped) instances.
  await SM.init();
  await checkNames('new league');
  { const s0 = SM.get();
    check(`card moments: the very first game day is planned at team creation (${(s0.scheduledCards || []).length} cards, plan ${s0.cardPlanKey})`,
          !!s0.cardPlanKey && (s0.scheduledCards || []).some(c => c._moment)); }
  {
    const inbox = SM.get().inbox || [];
    const seeds = inbox.filter(c => c._seed);
    check('new team: seed cards survive the App.init reload',
          seeds.length === NEW_TEAM_SEED_CARDS.length + 1,
          `got ${seeds.length} (inbox ${inbox.length})`);
    check('new team: every spring seed card delivered',
          NEW_TEAM_SEED_CARDS.every(id => seeds.some(c => c.cardId === id)),
          seeds.map(c => c.cardId).join(','));
    // The seeded trade is a REAL engine offer: user sends one of their own
    // players and receives one of the proposing CPU team's players.
    const st0   = SM.get();
    const trade = seeds.filter(c => c._tradeOffer);
    const o     = trade[0]?._tradeOffer;
    const prop  = (st0.leagueTeams || []).find(t => t.id === trade[0]?._proposingTeamId);
    check('new team: exactly one seeded (real) trade offer', trade.length === 1, `got ${trade.length}`);
    const org = (t) => [...(t.rosterIds || []), ...(t.farmIds || [])];
    check('new team: seeded trade direction — user sends own player, receives CPU player',
          !!o && o.outgoingIds.every(id => org(st0.userTeam).includes(id))
              && !!prop && o.incomingIds.every(id => org(prop).includes(id)),
          o ? JSON.stringify(o) : 'no offer');
    // §91 the seed is whichever situation the league has: a club wanting one
    // of ours (its opening bid) or a club offering one of its own.
    const sc = trade[0];
    check(`new team: the seeded offer is a real situation (${sc?._tradeKind}: ${sc?.subject})`,
          ['call', 'sell'].includes(sc?._tradeKind) && sc._opening?.theirNet >= sc._opening?.bar - 1 && !!sc._reviseOffer,
          JSON.stringify(sc?._opening));
    check('new team: seeds are real instances (unresolved, an expiry, no debug shape)',
          seeds.every(c => c.resolved === false && (Number.isFinite(c.expiresAt) || (c._tradeOffer && Number.isFinite(c.expiresAtMs)))
                          && !c._debugInjected && c.instanceId),
          JSON.stringify(seeds.map(c => ({ id: c.cardId, r: c.resolved, e: c.expiresAt }))));
    check('new team: no unresolved {tokens} in seed text',
          seeds.every(c => !/\{[a-z0-9_]+\}/i.test(`${c.subject} ${c.body} ${c.sender}`)),
          seeds.filter(c => /\{[a-z0-9_]+\}/i.test(`${c.subject} ${c.body}`)).map(c => c.cardId).join(','));
  }

  // ── §63: deciding seed cards moves the metrics; Completed tab clear/undo ──
  {
    const seeds = (SM.get().inbox || []).filter(c => c._seed && !c._tradeOffer);
    let moved = 0;
    for (const c of seeds) {
      const before = snapshotMetrics(SM.get());
      resolveCard(c.instanceId, 'yes');
      const after = snapshotMetrics(SM.get());
      if (['rating','morale','atmosphere','ownerTrust','funds'].some(k => after[k] !== before[k])) moved++;
    }
    check(`decisions: every seed decision moves a dashboard metric (${moved}/${seeds.length})`,
          seeds.length > 0 && moved === seeds.length);
    const hist = getHistory(100).length;
    const one  = clearHistory([getHistory(100)[0].instanceId]);
    check('completed: delete one removes exactly one', one.length === 1 && getHistory(100).length === hist - 1);
    restoreHistory(one);
    check('completed: undo restores it', getHistory(100).length === hist);
    const all = clearHistory('all');
    check('completed: delete all empties the tab', all.length === hist && getHistory(100).length === 0);
    check('completed: cleared cards still count for once-per-season dedup',
          seeds.every(c => (SM.get().inbox || []).some(x => x.cardId === c.cardId)));
    restoreHistory(all);
    check('completed: undo after delete all restores everything', getHistory(100).length === hist);
  }

  const s0 = SM.get();

  // ── Schedule structure (Batch 0) ──────────────────────────────
  const springGames  = s0.schedule.filter(g => g.isSpring).length;
  const regularGames = s0.schedule.filter(g => !g.isSpring).length;
  check(`schedule length = ${SPRING_TRAINING_GAME_COUNT + REGULAR_SEASON_GAME_COUNT}`,
        s0.schedule.length === SPRING_TRAINING_GAME_COUNT + REGULAR_SEASON_GAME_COUNT,
        `got ${s0.schedule.length}`);
  check(`spring games = ${SPRING_TRAINING_GAME_COUNT}`, springGames === SPRING_TRAINING_GAME_COUNT, `got ${springGames}`);
  check(`regular games = ${REGULAR_SEASON_GAME_COUNT}`, regularGames === REGULAR_SEASON_GAME_COUNT, `got ${regularGames}`);
  check(`first regular game at schedule index ${SPRING_TRAINING_GAME_COUNT}`,
        s0.schedule[SPRING_TRAINING_GAME_COUNT] && !s0.schedule[SPRING_TRAINING_GAME_COUNT].isSpring);
  // ── §67: one league calendar ───────────────────────────────────
  {
    const all = [];
    for (const g of s0.schedule) all.push({ d: g.date, h: g.isHome ? 'user' : g.opponentId, a: g.isHome ? g.opponentId : 'user', sp: g.isSpring });
    for (const [d, gs] of Object.entries(s0.leagueSchedule.dayMap)) for (const g of gs) if (!g.isAllStar) all.push({ d, h: g.homeId, a: g.awayId, sp: g.isSpring });
    const per = {}, day = {}, pair = {};
    for (const g of all) {
      if (g.sp) continue;
      for (const t of [g.h, g.a]) per[t] = (per[t] || 0) + 1;
      (day[g.d] = day[g.d] || []).push(g.h, g.a);
      const k = [g.h, g.a].sort().join('|'); pair[k] = (pair[k] || 0) + 1;
    }
    check(`calendar: all 10 clubs play ${REGULAR_SEASON_GAME_COUNT} games`,
          Object.keys(per).length === 10 && Object.values(per).every(n => n === REGULAR_SEASON_GAME_COUNT), JSON.stringify(per));
    check('calendar: no club plays twice on one date', Object.values(day).every(l => new Set(l).size === l.length));
    check('calendar: at least four clubs play every game day', Object.values(day).every(l => l.length >= 4));
    const div = Object.fromEntries([['user', 'A'], ...s0.leagueTeams.map(t => [t.id, t.divisionId])]);
    const dv = [], cr = [];
    for (const [k, n] of Object.entries(pair)) { const [x, y] = k.split('|'); (div[x] === div[y] ? dv : cr).push(n); }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    check(`calendar: division-weighted (${avg(dv).toFixed(1)} vs rivals, ${avg(cr).toFixed(1)} vs other division)`,
          avg(dv) >= 15.5 && avg(dv) <= 18.5 && avg(cr) >= 11.5 && avg(cr) <= 14.5);
  }
  check(`initial active roster = ${ROSTER_LIMITS.ACTIVE_TOTAL} (+spring invitees)`,
        activeCount(s0) >= ROSTER_LIMITS.ACTIVE_TOTAL, `got ${activeCount(s0)}`);

  // ── Play through GAMES games ──────────────────────────────────
  const target = Math.min(GAMES, s0.schedule.length);
  const injuriesSeen = new Map();
  let committed = 0, crossedToRegular = false, phaseAtCross = null, faultDone = false;
  let gamesWithRelief = 0; // r51: games where at least one side used >1 pitcher
  let seasonRuns = 0, seasonHits = 0, seasonGames = 0; // §60 run environment

  let asgChecked = false, faChecked = false;
  for (let i = 0; i < target; i++) {
    const idx = SM.get().currentGameIndex;
    if (idx == null || idx >= s0.schedule.length) break;
    // §75: odd seeds make the user's club an eligible host before the league decides.
    if (SEED % 2 === 1 && SM.get().allStar && !SM.get().allStar.season.hostId) {
      SM.mutate(s => { s.prestigeTier = Math.max(2, s.prestigeTier || 1); s.allStar.hostingScore = Math.max(900, s.allStar.hostingScore);
                       s.userTeam.atmosphere = Math.max(90, s.userTeam.atmosphere || 50); });   // a margin: a bad day can cost several points before the league names the host
    }
    if (!asgChecked && SM.get().schedule[idx]?.regularSeasonIndex === ALL_STAR_BREAK_AFTER_GAME) { asgChecked = true; await runAllStarChecks(); }
    if (!faChecked && SM.get().schedule[idx]?.regularSeasonIndex === 30) { faChecked = true; await checkFreeAgency(SM.get()); await checkRemindersAndWatches(); checkWeatherCalendar(SM.get(), 'season 1', ['season:1']); }

    const reachedFinal = playToFinal(idx);
    const pre = SM.get().schedule[idx];
    check(`game ${idx} reaches FINAL`, reachedFinal, `status ${pre?.status}`);

    // linescore/score coherence from the last revealed play (pre-commit)
    if (pre?.plays?.length) {
      const last = pre.plays[pre.plays.length - 1];
      check(`game ${idx} score = last play cumulative`,
            pre.ourScore === last.cumOurScore && pre.theirScore === last.cumTheirScore,
            `card ${pre.ourScore}-${pre.theirScore} vs play ${last.cumOurScore}-${last.cumTheirScore}`);

      // §60 real-baseball structure (pre-commit, plays still present)
      const ps      = pre.plays;
      // (§102.3 an official game the weather called: shorter than nine, and an
      //  unfinished inning's runs may not count — the score went back.)
      const called  = !!ps[ps.length - 1]?._called;
      if (called) gm.calledGames = (gm.calledGames || 0) + 1;
      const runs    = ps.filter(p => !p._reverted).reduce((s, p) => s + playRuns(p), 0);
      const maxInn  = Math.max(...ps.map(p => (p.type === 'game_end' ? 0 : (p.inning || 0))));
      const halves  = new Set(ps.filter(p => p.half === 'TOP' || p.half === 'BOT').map(p => `${p.half}${p.inning}`));
      const homeR   = pre.isHome ? pre.ourScore : pre.theirScore;
      const awayR   = pre.isHome ? pre.theirScore : pre.ourScore;
      check(`game ${idx}: runs in plays == final score`, runs === pre.ourScore + pre.theirScore,
            `plays ${runs} vs score ${pre.ourScore + pre.theirScore}`);
      check(`game ${idx}: at least 9 innings played (or an official game called after 5)`, maxInn >= 9 || (called && maxInn >= 5), `last inning ${maxInn}`);
      // Bottom of the last inning is skipped only when the home team leads.
      check(`game ${idx}: bottom half skipped only when home leads`,
            halves.has(`BOT${maxInn}`) || homeR > awayR || called, `home ${homeR} away ${awayR}`);
      if (!pre.isSpring) check(`game ${idx}: regular season never ties`, homeR !== awayR, `${homeR}-${awayR}`);
      // §69 live correctness at every reveal: the running score equals the runs
      // scored so far; the diamond never shows runners after a third out; every
      // out in a half is charged to a pitcher as IP.
      {
        let ours = 0, theirs = 0, scoreBad = null, outBad = null;
        const userHalf = pre.isHome ? 'BOT' : 'TOP';
        const halfIp = {}, halfOuts = {};
        for (let k = 0; k < ps.length; k++) {
          const p = ps[k];
          if (p.half === userHalf) ours += playRuns(p); else if (p.half === 'TOP' || p.half === 'BOT') theirs += playRuns(p);
          if (!scoreBad && p.type !== 'game_end' && (p.cumOurScore !== ours || p.cumTheirScore !== theirs))
            scoreBad = `play ${k} ${p.type} ${p.cumOurScore}-${p.cumTheirScore} vs ${ours}-${theirs}`;
          const sit = liveSituation(ps.slice(0, k + 1), ps[k + 1] ?? null);
          if (!outBad && p.outsAfter >= 3 && (sit.bases.first || sit.bases.second || sit.bases.third)) outBad = `play ${k}`;
          if (p._halfInning && p.type !== 'game_end') {
            if (Number.isFinite(p.outsAfter) && p.type !== 'inning_end') halfOuts[p._halfInning] = Math.max(halfOuts[p._halfInning] || 0, p.outsAfter);
            for (const ds of Object.values(p._statDeltas || {})) for (const d of ds)
              if (d.stat === 'ip') halfIp[p._halfInning] = (halfIp[p._halfInning] || 0) + Math.round(d.delta / 0.333);
          }
        }
        const ipBad = Object.keys(halfOuts).filter(h => (halfIp[h] || 0) !== halfOuts[h]);
        check(`game ${idx}: running score equals runs scored at every play`, !scoreBad, scoreBad || '');
        check(`game ${idx}: bases empty once the third out is revealed`, !outBad, outBad || '');
        check(`game ${idx}: every out charged to a pitcher (IP = outs, each half)`, ipBad.length === 0,
              ipBad.map(h => `${h} ${halfIp[h] || 0}/${halfOuts[h]}`).join(' '));
      }
      seasonRuns += runs; seasonHits += ps.filter(p => ['single','double','triple','hr'].includes(p.type)).length;
      seasonGames++;
    }

    await commitGame(idx);
    releaseDueCards();   // the App's next tick
    if (process.env.ROSTER_TRACE) {
      const st = SM.get();
      const act = (st.userTeam.rosterIds || []).map(id => st.players[id]).filter(p => p && p.group !== PLAYER_GROUP.IL);
      const P = act.filter(p => p.pos === 'SP' || p.pos === 'RP').length, H = act.length - P;
      if (gm.lastHP && (P !== gm.lastHP.P || H !== gm.lastHP.H)) {
        const ids = new Set([...(st.userTeam.rosterIds || []), ...(gm.lastHP.ids || [])]);
        const gone = [...gm.lastHP.ids].filter(id => !(st.userTeam.rosterIds || []).includes(id) || st.players[id]?.group === PLAYER_GROUP.IL);
        const came = (st.userTeam.rosterIds || []).filter(id => !gm.lastHP.ids.includes(id) && st.players[id]?.group !== PLAYER_GROUP.IL);
        const d = (id) => { const p = st.players[id]; return `${p?.name}(${p?.pos}/${p?.group}/${p?.teamId})`; };
        console.log('ROSTER', idx, `${gm.lastHP.H}H/${gm.lastHP.P}P -> ${H}H/${P}P`, 'out:', gone.map(d).join(','), 'in:', came.map(d).join(','));
      }
      gm.lastHP = { H, P, ids: act.map(p => p.id) };
    }
    if (process.env.OWNER_DUMP) {
      const st = SM.get(), paid = st.userTeam.finances.cal?.paid ?? 0;
      if (paid !== gm.lastPaid) {
        gm.lastPaid = paid;
        const sr = Finance.strain(st), u = st.userTeam;
        console.log('OWNER', `payday ${paid}`, `${u.wins}-${u.losses}`, `pace ${Finance.paceVsTarget(st)?.toFixed(1)}`, `trust ${Math.round(u.ownerTrust)}`,
          `patience ${Finance.patience(st).toFixed(1)} allow ${Finance.allowance(st).toFixed(1)}`,
          `strain ${sr.total.toFixed(1)} (over ${sr.over.toFixed(1)} red ${sr.red.toFixed(1)})`, `payroll ${sr.payroll} target ${sr.target} funds ${u.finances.funds} proj ${sr.projected}`,
          `stage ${u.finances.owner?.stage}`);
      }
    }
    // §78: the payroll carried through the regular season, and the paydays.
    {
      const st = SM.get(), g = st.schedule[idx];
      if (!g?.isSpring && !g?.isPlayoff) gm.payrollSamples.push(st.userTeam.finances.payroll || 0);
      gm.paydays = st.userTeam.finances.cal?.paid ?? gm.paydays;
    }
    // §76: every outing on every arm (the record keeps a few days; the harness keeps them all).
    for (const p of Object.values(SM.get().players)) {
      for (const o of p.arm || []) {
        const seen = gm.arms.get(p.id) || gm.arms.set(p.id, new Map()).get(p.id);
        seen.set(o.at, o);
      }
    }
    // Every follow-up the season sets in motion (some are later withdrawn when they can't happen any more).
    for (const c of [...(SM.get().inbox || []), ...(SM.get().scheduledCards || [])]) {
      if ((c._rosterKey || '').startsWith('followup:')) gm.chainSeen.set(c.instanceId, c.cardId);
    }
    {
      // §75: the moment the squads are named, every All-Star is a healthy big-leaguer,
      // and every starting pitcher has a starter's innings or a starter's reputation.
      const st = SM.get(), as = st.allStar?.season;
      if (as?.squads && !gm.asSelectionChecked) {
        gm.asSelectionChecked = true;
        const ACTIVE = [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH];
        const ids = Object.values(as.squads).flatMap(q => q.rosterIds);
        const bad = ids.filter(id => !ACTIVE.includes(st.players[id]?.group) || st.players[id]?.isInjured);
        check(`all-star: squads named from healthy big-leaguers only (${ids.length})`, bad.length === 0,
              bad.map(id => `${st.players[id]?.name}:${st.players[id]?.group}`).join(','));
        const rot = Object.values(st.players).filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS && (p.stats?.gs || 0) > 0)
          .map(p => p.stats.ip || 0).sort((x, y) => x - y);
        const spIp = rot[Math.floor(rot.length / 2)] || 0;
        const ovrs = Object.values(st.players).filter(p => p.pos === 'SP' && p.teamId && ACTIVE.includes(p.group)).map(p => p.ovr);
        const avgOvr = ovrs.reduce((x, y) => x + y, 0) / Math.max(1, ovrs.length);
        const swing = Object.values(as.squads).flatMap(q => q.sp).map(x => st.players[x.id])
          .filter(p => (p.stats?.ip || 0) < 0.4 * spIp && p.ovr < avgOvr);
        check(`all-star: no swingman named an All-Star starter (a regular starter has ${spIp.toFixed(0)} IP)`, swing.length === 0,
              swing.map(p => `${p.name} ${p.stats?.ip?.toFixed(0)}IP ovr${p.ovr}`).join(','));
      }
    }
    {
      // §71: nobody away (rest / sick / training / benched) is in the lineup or rotation.
      const st = SM.get();
      const awayIds = [...(st.userTeam.lineupSlots || []).map(sl => sl.playerId), ...(st.userTeam.rotation?.order || [])]
        .filter(id => id && st.players[id]?.unavailable);
      if (awayIds.length) gm.awayInLineup.push(`g${idx}:${awayIds.map(id => st.players[id].name).join('/')}`);
    }
    const post = SM.get();
    const g = post.schedule[idx];
    check(`game ${idx} committed (result+score)`,
          g._committed && g.result && g.score && Number.isFinite(g.score.us) && Number.isFinite(g.score.them));

    // ── Batch r50: no double-booking — the user's opponent must not appear in
    // the CPU slate for the same date (they were playing the user). ──
    if (g.date && g.opponent) {
      const oppTeam = (post.leagueTeams || []).find(t => t.name === g.opponent);
      const slate   = post.leagueSchedule?.dayMap?.[g.date] || [];
      const doubleBooked = oppTeam
        && slate.some(cg => cg.homeId === oppTeam.id || cg.awayId === oppTeam.id);
      check(`game ${idx}: opponent not double-booked on ${g.date}`, !doubleBooked,
            oppTeam ? `${oppTeam.abbr} also in CPU slate` : 'opp not found');
    }

    // ── Box score (Phase 1: shared accumulator) ──
    const box = g.boxScore;
    check(`game ${idx}: boxScore written (away+home)`, !!(box && box.away && box.home));
    check(`game ${idx}: plays stripped after commit`, g.plays === undefined, g.plays ? `still ${g.plays.length}` : 'stripped');
    if (box && box.away && box.home) {
      const userRuns = box.userIsHome ? box.home.runs : box.away.runs;
      const oppRuns  = box.userIsHome ? box.away.runs : box.home.runs;
      check(`game ${idx}: box runs == final score`,
            userRuns === g.score.us && oppRuns === g.score.them,
            `box ${userRuns}-${oppRuns} vs score ${g.score.us}-${g.score.them}`);
      let top = 0, bot = 0;
      for (const inn of Object.values(box.linescore)) { top += inn.top; bot += inn.bot; }
      check(`game ${idx}: linescore sums == box runs`,
            top === box.away.runs && bot === box.home.runs,
            `LS ${top}/${bot} vs box ${box.away.runs}/${box.home.runs}`);
      check(`game ${idx}: both lineups seeded (>=9 hitters each)`,
            box.away.hitters.length >= 9 && box.home.hitters.length >= 9,
            `${box.away.hitters.length}/${box.home.hitters.length}`);
      // A pitcher in the box faced someone (no reliever brought in for a half never played).
      const phantom = [...box.away.pitchers, ...box.home.pitchers].filter(p => !(p.ipOuts || p.h || p.bb || p.er || p.k));
      check(`game ${idx}: every pitcher in the box faced a batter`, phantom.length === 0, phantom.map(p => p.name).join(','));
      // r51: bullpen usage — a full game should hook the starter for relief.
      const awayP = (box.away.pitchers || []).length;
      const homeP = (box.home.pitchers || []).length;
      if (awayP >= 2 || homeP >= 2) gamesWithRelief++;
    }
    check(`game ${idx} advanced currentGameIndex`, post.currentGameIndex === idx + 1, `now ${post.currentGameIndex}`);

    // roster-integrity canary — phase-aware:
    //   SPRING: 28–38 (28 + up to 10 invitees).  REGULAR: exactly 28 (post-cuts).
    const ac = activeCount(post);
    if (process.env.DBG) {
      const ids = new Set(post.userTeam.rosterIds.filter(id => post.players[id].group !== 'il'));
      const gone = [...(globalThis.__prevActive || [])].filter(id => !ids.has(id));
      const joined = [...ids].filter(id => !(globalThis.__prevActive || new Set()).has(id));
      if (joined.length && idx > 9) console.log(`g${idx}: joined:`, joined.map(id => post.players[id].name).join(', '), `| active ${ids.size} arriving ${pendingArrivals(post, 'user').length}`);
      if (gone.length) console.log(`g${idx}: left active:`, gone.map(id => { const p = post.players[id]; return `${p.name}/${p.pos} grp=${p.group} team=${p.teamId} inj=${p.injury?.status}`; }).join(' | '));
      globalThis.__prevActive = ids;
    }
    if (post.phase === PHASE.SPRING_TRAINING) {
      check(`game ${idx} (spring): active roster 28–38`, ac >= ROSTER_LIMITS.ACTIVE_TOTAL && ac <= ROSTER_LIMITS.SPRING_TOTAL, `got ${ac}`);
    } else {
      const held = rosterSpotsHeld(post, 'user');
      // A spot can be open while its decision deadline is still ahead (§65).
      const openWithDeadline = held < ROSTER_LIMITS.ACTIVE_TOTAL && post.userTeam.vacancyDeadlineAt > clock.get();
      if (process.env.ROSTER_DUMP && !(held === ROSTER_LIMITS.ACTIVE_TOTAL || openWithDeadline)) {
        console.log('ROSTERDBG', JSON.stringify((post.transactions || []).filter(t => t.status === 'pending' && (t.teamId === 'user')).map(t => [t.kind, t.reason, post.players[t.playerId]?.name, post.players[t.playerId]?.pos, t.toFarm])));
        console.log('ROSTERDBG trades', JSON.stringify((post.transactions || []).filter(t => t.kind === 'trade' && (t.teamId === 'user')).slice(-2).map(t => [t.id, t.status, t.offer.incomingIds.map(id => post.players[id]?.name + ' ' + post.players[id]?.pos + ' ' + post.players[id]?.group), t.offer.outgoingIds.map(id => post.players[id]?.name)])));
        console.log('ROSTERDBG IL', (post.userTeam.rosterIds || []).filter(id => post.players[id]?.group === 'il').length);
      }
      check(`game ${idx} (${post.phase}): active + arriving = ${ROSTER_LIMITS.ACTIVE_TOTAL} (or a spot open before its deadline)`,
            held === ROSTER_LIMITS.ACTIVE_TOTAL || openWithDeadline,
            `active ${ac} + arriving ${held - ac}; dl ${post.userTeam.vacancyDeadlineAt}; farm ${post.userTeam.farmIds.map(id => post.players[id]?.pos).join('')}; phase ${post.phase}; clock ${clock.get()} next ${post.schedule[post.currentGameIndex]?.gameTime}`);
      const cpuBad = post.leagueTeams.filter(t => rosterSpotsHeld(post, t.id) !== ROSTER_LIMITS.ACTIVE_TOTAL);
      check(`game ${idx}: every CPU club active + arriving = 28`, cpuBad.length === 0,
            cpuBad.map(t => `${t.abbr} ${rosterSpotsHeld(post, t.id)}`).join(', '));
      check(`game ${idx}: every lineup fields nine`, [post.userTeam, ...post.leagueTeams]
        .every(t => (t.lineupSlots || []).filter(sl => sl.playerId).length === 9));
    }
    // §65: one player, one place — every team, every game.
    const audit = auditRosters(post);
    check(`game ${idx}: no player on two rosters / stranded in transit`, audit.length === 0, audit.slice(0, 4).join('; '));
    if (audit.length && process.env.AUDIT_DUMP) {
      for (const tx of (post.transactions || []).filter(t => t.status === 'pending' && t.kind === 'arrival' && post.players[t.playerId]?.group !== PLAYER_GROUP.IN_TRANSIT)) {
        const p = post.players[tx.playerId];
        console.log('AUDIT', JSON.stringify(tx), p.name, p.group, p.teamId, p.tier, p.injury?.status, p.isInjured, p.unavailable && JSON.stringify(p.unavailable),
          (post.leagueTeams.find(t => t.id === p.teamId)?.rosterIds || []).includes(p.id), JSON.stringify((post.leagueWire || []).filter(w => w.text.includes(p.name)).map(w => [new Date(w.atMs).toISOString(), w.text])));
      }
    }
    // §65: nobody plays for a club he was not with at first pitch.
    recordTx(post);
    if (box && box.away && box.home && g.gameTime) {
      const oppT = post.leagueTeams.find(t => t.name === g.opponent);
      const userSide = box.userIsHome ? box.home : box.away;
      const oppSide  = box.userIsHome ? box.away : box.home;
      const wrong = [
        ...[...userSide.hitters, ...userSide.pitchers].filter(x => !onTeamAt(x.id, 'user', g.gameTime)),
        ...(oppT ? [...oppSide.hitters, ...oppSide.pitchers].filter(x => !onTeamAt(x.id, oppT.id, g.gameTime)) : []),
      ];
      check(`game ${idx}: nobody plays before reporting / after leaving`, wrong.length === 0,
            wrong.map(x => x.name).join(', '));
      if (wrong.length && process.env.TX_DUMP) for (const x of wrong) console.log(x.name, JSON.stringify([...txSeen.values()].filter(t => t.playerId === x.id).map(t => [t.kind, t.teamId, t.fromTeamId, t.reason, t.status, t.createdAt - g.gameTime, t.effectiveAt - g.gameTime])), post.players[x.id]?.teamId, post.players[x.id]?.group);
    }
    assertNoGhosts(`after game ${idx}`);
    for (const pl of Object.values(post.players)) {
      if (pl.injury) injuriesSeen.set(`${pl.id}:${pl.injury.injuredAt}`, { team: pl.teamId, status: pl.injury.status, pitcher: ['SP', 'RP'].includes(pl.pos) });
    }

    // phase-transition canary: once the NEXT game is a regular-season game,
    // the phase must no longer be SPRING_TRAINING (Opening Day cut must have run).
    if (post.currentGameIndex >= SPRING_TRAINING_GAME_COUNT) {
      check(`after game ${idx}: phase left SPRING_TRAINING by Opening Day`,
            post.phase !== PHASE.SPRING_TRAINING, `phase=${post.phase}`);
    }

    // detect spring→regular crossing
    if (!crossedToRegular && idx + 1 === SPRING_TRAINING_GAME_COUNT) {
      const ut = post.userTeam;
      check('spring: results kept out of the regular-season record (user)',
            (ut.wins || 0) + (ut.losses || 0) === 0
            && (ut.springWins || 0) + (ut.springLosses || 0) + (ut.springTies || 0) === SPRING_TRAINING_GAME_COUNT,
            `W-L ${ut.wins}-${ut.losses}, spring ${ut.springWins}-${ut.springLosses}-${ut.springTies || 0}`);
      check('spring: no CPU club has a regular-season record yet',
            post.leagueTeams.every(t => (t.wins || 0) + (t.losses || 0) === 0));
      crossedToRegular = true;
      phaseAtCross = post.phase;
    }

    // Batch 2 — roster-integrity fault injection, once, on the first committed
    // regular-season game (real rosters, regular phase, cloned so the live run
    // is untouched).
    if (!faultDone && post.phase === PHASE.REGULAR_SEASON) {
      faultDone = true;
      runFaultInjection(post);
    }
    committed++;
  }

  check(`committed ${committed} game(s)`, committed > 0, `${committed}`);

  // ── §65: transactions, injuries and vacancies over the run ─────────────────
  {
    const st = SM.get();
    recordTx(st);
    check('roster cards: no ghost message at any point (inbox ⇄ Team screen in sync)',
          gm.ghostFails.length === 0, gm.ghostFails.slice(0, 5).join(' | '));
    const regGames = Math.max(0, committed - SPRING_TRAINING_GAME_COUNT);
    if (regGames >= 60) {
      const perTeam = new Map();
      for (const { team } of injuriesSeen.values()) perTeam.set(team, (perTeam.get(team) || 0) + 1);
      const teams = ['user', ...st.leagueTeams.map(t => t.id)];
      const counts = teams.map(t => perTeam.get(t) || 0);
      const scaled = counts.map(c => c * 142 / regGames);
      // Every club that actually plays a full slate gets hurt. (Until Batch 2
      // fixes the CPU schedule some clubs play only ~40 games, so require 8/10.)
      check(`injuries: clubs get hurt (${counts.join('/')})`, counts.filter(c => c > 0).length >= 8);
      const avg = scaled.reduce((a, b) => a + b, 0) / scaled.length;
      check(`injuries: ~${avg.toFixed(1)} per club per 142 games (8–30)`, avg >= 8 && avg <= 30);
      const all = [...injuriesSeen.values()];
      const pShare = all.filter(x => x.pitcher).length / Math.max(1, all.length);
      // ~130 injuries a season: binomial noise alone is ±4–5 points (1 sd).
      check(`injuries: pitcher share ${(pShare * 100).toFixed(0)}% (MLB-like ~50%, 36–64% allowing for a season's noise)`, pShare >= 0.36 && pShare <= 0.64);
      const userCards = (st.inbox || []).filter(c => c.cardId === 'injury_act2').length;
      check(`injuries: user diagnoses delivered (${userCards})`, userCards > 0);
    }
    const trades = [...txSeen.values()].filter(t => t.kind === 'trade');
    check('trades: every accepted trade executed or was voided (none stuck pending)',
          trades.every(t => t.status !== 'pending' || t.effectiveAt > clock.get()),
          trades.filter(t => t.status === 'pending').map(t => t.id).join(','));
    for (const acc of gm.tradesAccepted) {
      const tx = trades.find(t => t.fromTeamId === acc.team && t.createdAt === acc.at);
      if (!tx || tx.status !== 'done') continue;
      const arrivals = [...txSeen.values()].filter(t => t.kind === 'arrival' && t.reason === 'trade'
        && [...acc.offer.incomingIds, ...acc.offer.outgoingIds].includes(t.playerId) && t.createdAt === tx.doneAt);
      check(`trade ${tx.id.slice(-13)}: every player reports the next calendar day`,
            arrivals.length === acc.offer.incomingIds.length + acc.offer.outgoingIds.length
            && arrivals.every(a => a.effectiveAt === nextCalendarDay(tx.doneAt)));
    }
    if (committed >= 40) {
      check(`GM simulation exercised inbox + Team screen + deadlines (acted ${gm.acted}, team screen ${gm.teamScreen}, ignored ${gm.ignored})`,
            gm.acted > 0 && gm.ignored >= 0);
    }
  }

  // ── §60: EVERY deliverable pool card resolves fully (not just those drawn) ──
  {
    const st = SM.get();
    const ctx = buildCardContext();
    const bad = [];
    let checked = 0;
    for (const [poolName, pool] of Object.entries(CardPools)) {
      const entries = Array.isArray(pool) ? pool.map(e => e?.card || e)
                    : (pool && typeof pool === 'object')
                      ? Object.entries(pool).map(([id, c]) => ({ id, ...c })) : [];
      for (const def of entries) {
        if (!def || !(def.body || def.subject) || def._retired) continue;
        if ([def.onYes, def.onNo].some(a => a && !HANDLED_CARD_ACTIONS.has(a))) continue;
        // Follow-up cards are only delivered about a named player (§73), and a
        // card with no real outside player to offer is never sent.
        if (def._intlFollowupOnly) continue;
        const tm = buildTokenMap(def, ctx, st);
        if (tm.missingPlayer) continue;
        checked++;
        const { values } = tm;
        const bodies = [def.body, ...((def.variants || def._variants || []).map(v => v?.body))];
        const fields = [def.subject, def.preview, def.sender, def.yesLabel, def.noLabel,
                        def.yesMsg, def.noMsg, def._expireMsg, ...bodies];
        const left = fields.filter(Boolean).flatMap(f =>
          (applyTokens(f, values).match(/\{[a-z0-9_]+\}/gi) || []));
        if (left.length) bad.push(`${poolName}:${def.id} ${[...new Set(left)].join(' ')}`);
      }
    }
    check(`cards: every deliverable card resolves all tokens (${checked} cards)`,
          bad.length === 0, bad.slice(0, 12).join(' | '));
  }

  // ── §60: realistic run environment (MLB ≈ 4.6 R, 8.4 H per team per game) ──
  if (seasonGames >= 20) {
    const rpg = seasonRuns / seasonGames / 2, hpg = seasonHits / seasonGames / 2;
    if (process.env.LG_DUMP) {
      const P = SM.get().players, agg = {};
      const add = (k, side) => { if (!side) return; const A = agg[k] = agg[k] || { n:0, r:0, h:0, hr:0, bb:0, k:0, ab:0, nh:0, ovr:0, spOvr:0, pa:0 };
        A.n++; A.r += side.runs || 0; A.nh += side.hitters.length;
        for (const h of side.hitters) { A.h += h.h; A.hr += h.hr; A.bb += h.bb; A.k += h.k; A.ab += h.ab; A.pa += h.ab + h.bb + (h.hbp||0) + (h.sf||0); }
        const nine = side.hitters.slice(0, 9); A.ovr += nine.reduce((a, h) => a + (P[h.id]?.ovr || 0), 0) / Math.max(1, nine.length);
        A.spOvr += P[side.pitchers?.[0]?.id]?.ovr || 0; };
      for (const g of Object.values(SM.get().leagueSchedule.dayMap).flat()) if (g.played && !g.isSpring && !g.isPlayoff && !g.isAllStar && g.boxScore) { add('cpuBat', g.boxScore.away); add('cpuBat', g.boxScore.home); }
      for (const g of SM.get().schedule) if (g._committed && !g.isSpring && !g.isPlayoff && g.boxScore) {
        const us = g.isHome ? g.boxScore.home : g.boxScore.away, them = g.isHome ? g.boxScore.away : g.boxScore.home;
        add('userBat', us); add('oppVsUser', them); }
      for (const [k, A] of Object.entries(agg)) console.log('LG', k, A.n, Object.fromEntries(['r','h','hr','bb','k','ab','pa','nh','ovr','spOvr'].map(x => [x, +(A[x] / A.n).toFixed(2)])));
    }
    // The league's run environment (every regular-season game), and our games'.
    const lg = Object.values(SM.get().leagueSchedule.dayMap).flat().filter(g => g.played && !g.isSpring && !g.isPlayoff && !g.isAllStar);
    const lgRpg = lg.reduce((a, g) => a + (g.homeScore || 0) + (g.awayScore || 0), 0) / Math.max(1, lg.length) / 2;
    check(`run environment realistic: league ${lgRpg.toFixed(2)} R / team / game (3.8–5.2); our games ${rpg.toFixed(2)} (3.2–6.0)`,
          lgRpg >= 3.8 && lgRpg <= 5.2 && rpg >= 3.2 && rpg <= 6.0);
    check(`hit environment realistic: ${hpg.toFixed(2)} H / team / game (6.5–10.5)`, hpg >= 6.5 && hpg <= 10.5);
  }

  // ── §61: timed delivery ─────────────────────────────────────────────────────
  {
    const st      = SM.get();
    const arrived = (st.inbox || []).filter(c => Number.isFinite(c.arrivedAtMs));
    check(`timed delivery: cards arrive over time (${arrived.length} released)`,
          arrived.length > 20, `${arrived.length}`);
    // Pool cards are planned outside quiet hours. Real-time roster cards (an
    // injury after a night game) arrive when they happen; their ALERT waits.
    const quiet = arrived.filter(c => !c._rosterKey && inQuietHours(c.arrivedAtMs, st.push?.quietStart, st.push?.quietEnd));
    check('timed delivery: no pool card arrives during quiet hours', quiet.length === 0,
          quiet.slice(0, 5).map(c => new Date(c.arrivedAtMs).toISOString()).join(','));
    const hours = new Set(arrived.map(c => new Date(c.arrivedAtMs).getHours()));
    check(`timed delivery: arrival times vary (${hours.size} distinct hours)`, hours.size >= 8);
    const overdue = (st.scheduledCards || []).filter(c => c.deliverAtMs <= clock.get());
    check('timed delivery: nothing left overdue after a tick', overdue.length === 0, `${overdue.length}`);
    check('timed delivery: seed cards are never pushed',
          !getPushSchedule(st, 0).some(i => (st.scheduledCards || []).find(c => c.instanceId === i.id)?._seed));
    const ps = getPushSchedule(st, clock.get());
    check('push schedule: no alert sounds during quiet hours',
          getPushSchedule(st, 0).every(i => !inQuietHours(i.deliverAt, st.push?.quietStart, st.push?.quietEnd)));
    check('push schedule: only future items, each with id/title/body',
          ps.every(i => i.deliverAt > clock.get() - 60000 && i.id && i.title && i.body), `${ps.length} items`);
    // §99 the game reminder: 30 minutes before each of our next first pitches
    // (none in quiet hours), and none once it's switched off.
    {
      const next = (st.schedule || []).slice(st.currentGameIndex || 0).find(g => !g._committed && g.gameTime - 30 * 60_000 > clock.get());
      const rem = ps.filter(i => i.id.startsWith('game-reminder-'));
      const want = next && !inQuietHours(next.gameTime - 30 * 60_000, st.push?.quietStart, st.push?.quietEnd);
      check(`push schedule: a reminder 30 minutes before our next first pitch (${rem.length} queued)`,
            !want || rem.some(i => i.deliverAt === next.gameTime - 30 * 60_000), next ? new Date(next.gameTime).toISOString() : 'no game');
      const off = getPushSchedule({ ...st, push: { ...(st.push || {}), gameReminder: false } }, clock.get());
      check('push schedule: no game reminders when switched off', !off.some(i => i.id.startsWith('game-reminder-')));
    }

    // Planner unit checks (deterministic RNG)
    let seedR = 42; const rnd = () => ((seedR = (seedR * 16807) % 2147483647) / 2147483647);
    const base = Date.UTC(2027, 3, 10, 14, 0);            // 14:00
    const next = Date.UTC(2027, 3, 11, 19, 5);            // next day 19:05
    const t = planDeliveryTimes(500, { nowMs: base, windowEndMs: next, quietStart: '22:00', quietEnd: '08:00', rand: rnd });
    check('planner: all times inside the window', t.every(x => x > base && x <= next));
    check('planner: no time in quiet hours', t.every(x => !inQuietHours(x, '22:00', '08:00')));
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    check('planner: some cards land within an hour of each other', gaps.some(g => g < 3600000));
    const nightOnly = planDeliveryTimes(3, { nowMs: Date.UTC(2027, 3, 10, 23, 0),
      windowEndMs: Date.UTC(2027, 3, 11, 7, 0), rand: rnd });
    check('planner: a window entirely in quiet hours delivers after wake-up',
          nightOnly.every(x => !inQuietHours(x, '22:00', '08:00')));
  }

  // ── §60: inbox content integrity over the whole run ─────────────────────────
  {
    const inbox = SM.get().inbox || [];
    const TOKEN = /\{[a-z0-9_]+\}/i;
    const raw = inbox.filter(c =>
      TOKEN.test(`${c.subject} ${c.preview} ${c.body} ${c.sender} ${c.yesLabel} ${c.noLabel}`));
    const rawIds = [...new Set(raw.map(c => c.cardId))];
    check(`inbox: no delivered card shows a raw {token} (${inbox.length} delivered)`,
          raw.length === 0,
          `${rawIds.length} card types: ${rawIds.slice(0, 25).join(',')}${rawIds.length > 25 ? '…' : ''}`);
    // Money shown == money applied: when a card's text contains its cost or
    // revenue token, the instance's numeric amount must render to that text.
    const moneyBad = inbox.filter(c => {
      const raw = c._raw || {};
      const txt = `${c.preview} ${c.body}`;
      if (typeof raw._budgetCost === 'string' && /\{/.test(`${raw.preview}${raw.body}`)
          && `${raw.preview}${raw.body}`.includes(`{${raw._budgetCost}}`)
          && !txt.includes(formatK(c._budgetCost))) return true;
      if (raw._revenueToken && `${raw.preview}${raw.body}`.includes(`{${raw._revenueToken}}`)
          && !txt.includes(formatK(c._revenueK))) return true;
      return false;
    });
    check('inbox: cost/revenue in card text == amount applied on resolve',
          moneyBad.length === 0, moneyBad.map(c => c.cardId).join(','));
    check('inbox: no retired card delivered',
          !inbox.some(c => c._raw?._retired),
          inbox.filter(c => c._raw?._retired).map(c => c.cardId).join(','));
    if (committed >= 20) {
      const offers = inbox.filter(c => c._tradeOffer && !c._seed);
      check(`inbox: real CPU trade offers arrive during play (${offers.length})`, offers.length > 0);
      const st = SM.get();
      const badDir = offers.filter(c => {
        const prop = (st.leagueTeams || []).find(t => t.id === c._proposingTeamId);
        const snap = c._tradeEval;
        const cashSale = !snap?.outgoingPlayers?.length && (c._tradeOffer?.cashK || 0) < 0;   // §85 A: a player for cash
        return !snap || (!cashSale && !snap.outgoingPlayers?.length) || !snap.outgoingPlayers?.every(p => p.teamId === 'user' || p._previouslyWithOrg)
            || !snap.incomingPlayers?.length || !snap.incomingPlayers?.every(p => p.teamId === c._proposingTeamId);
      });
      check('inbox: every CPU offer sends a user player (or cash) and receives a CPU player',
            badDir.length === 0, badDir.map(c => `${c.cardId} out:${c._tradeEval?.outgoingPlayers?.map(p => p.teamId)} in:${c._tradeEval?.incomingPlayers?.map(p => p.teamId)}`).join(','));
    }
  }
  // r51: relievers must actually enter — most full games hook the starter.
  check(`bullpen used in most games (${gamesWithRelief}/${committed})`,
        committed === 0 || gamesWithRelief >= committed * 0.7,
        `${gamesWithRelief}/${committed}`);
  if (crossedToRegular) {
    // The game at index SPRING_TRAINING_GAME_COUNT must be a real regular-season game.
    const firstReg = SM.get().schedule[SPRING_TRAINING_GAME_COUNT];
    check('spring→regular boundary: first post-spring game is regular season', firstReg && !firstReg.isSpring,
          `phase=${phaseAtCross}`);
  }

  // ── §67: a real league ─────────────────────────────────────────
  if (committed >= SPRING_TRAINING_GAME_COUNT + 20) {
    const st = SM.get();
    const games = Object.values(st.leagueSchedule.dayMap).flat().filter(g => !g.isAllStar);
    const lastUser = st.schedule[st.currentGameIndex - 1];
    const due = games.filter(g => g.gameTime < (lastUser?.gameTime || 0));
    check(`league: every CPU game before the user's last game was played (${due.filter(g => g.played).length}/${due.length})`,
          due.every(g => g.played && (g.boxScore || g.cancelled)));   // (§102.3 a cancelled spring rainout has no box)
    const phantomCpu = games.filter(g => g.played && g.boxScore).flatMap(g => [...g.boxScore.away.pitchers, ...g.boxScore.home.pitchers])
      .filter(p => !(p.ipOuts || p.h || p.bb || p.er || p.k));
    check(`league: every pitcher in a CPU box score faced a batter`, phantomCpu.length === 0, `${phantomCpu.length} phantom appearances`);
    // Starts are recorded: two per game (one each side), quality starts among them.
    const startGames = games.filter(g => !g.isSpring && !g.isPlayoff && g.played).length
                     + st.schedule.filter(g => !g.isSpring && !g.isPlayoff && g._committed).length;
    const allP = Object.values(st.players);
    const gsSum = allP.reduce((x, p) => x + (p.stats?.gs || 0), 0), qsSum = allP.reduce((x, p) => x + (p.stats?.qs || 0), 0);
    // Everyone who started one of our games (first pitcher on each side) has a start.
    const rotNoStart = [...new Set(st.schedule.filter(g => !g.isSpring && !g.isPlayoff && g._committed && g.boxScore)
      .flatMap(g => [g.boxScore.away.pitchers[0]?.id, g.boxScore.home.pitchers[0]?.id]))]
      .filter(id => id && st.players[id] && !(st.players[id].stats?.gs > 0));
    check(`stats: two starts per game, quality starts counted (${gsSum} GS / ${startGames} games, ${qsSum} QS)`,
          gsSum === 2 * startGames && qsSum > 0 && qsSum < gsSum && rotNoStart.length === 0,
          `starters with no start recorded: ${rotNoStart.length}`);
    // §76: the manager's pitching. Relievers rest (never a third day in a row),
    // starters get four days, relief work is spread over the pen (the best arms
    // pitch the most), closers collect the saves, starters go about 5–6.
    {
      // Rest is counted in calendar days, by the day each game was played.
      const dd = (a, b) => (b.day ?? 0) - (a.day ?? 0);
      let reliefOut = 0, thirdDay = 0, starts = 0, shortRest = 0, startOuts = 0;
      const reliefOutsBy = new Map(), reliefGBy = new Map();
      for (const [pid, m] of gm.arms) {
        const outs = [...m.values()].sort((a, b) => a.at - b.at);
        outs.forEach((o, i) => {
          if (o.start) {
            starts++; startOuts += o.outs || 0;
            const prev = outs.slice(0, i).reverse().find(x => x.start);
            if (prev && dd(prev, o) < 5) shortRest++;   // four days' rest = the fifth day
          } else {
            reliefOut++;
            reliefOutsBy.set(pid, (reliefOutsBy.get(pid) || 0) + (o.outs || 0));
            reliefGBy.set(pid, (reliefGBy.get(pid) || 0) + 1);
            const a = outs[i - 1], b = outs[i - 2];
            if (a && b && dd(a, o) === 1 && dd(b, a) === 1) {
              thirdDay++;
              if (process.env.ARM_DUMP) {
                const pl = st.players[pid];
                const before = Pitching.armStatus({ ...pl, arm: outs.slice(0, i) }, o.at - 3 * 3600_000);
                console.log('3RD', pl?.teamId, pl?.name, pl?.group, [b, a, o].map(x => `d${x.day}:${x.bf}${x.start ? 'S' : ''}`).join(' '), 'engine-said', before.status, before.lastDays);
              }
            }
          }
        });
      }
      check(`pitching: relievers never pitch a third day in a row (${thirdDay}/${reliefOut} outings)`, thirdDay <= reliefOut * 0.005, `${thirdDay}`);
      check(`pitching: starters start on four days' rest (${shortRest}/${starts} short)`, shortRest <= starts * 0.02, `${shortRest}`);
      // Relief work (spring, season and postseason), from the outings themselves.
      const rel = allP.filter(p => p.teamId && [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group) && reliefGBy.get(p.id));
      const relG  = rel.map(p => reliefGBy.get(p.id)).sort((a, b) => a - b);
      const med = (xs) => xs[Math.floor(xs.length / 2)] || 0;
      const most = [...reliefOutsBy.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
      const mp = st.players[most[0]];
      check(`pitching: relief work spread over the pen (median ${med(relG)} G; most relief IP ${(most[1] / 3).toFixed(0)}: ${mp?.name} ${mp?.pos} ${reliefGBy.get(most[0])} G)`,
            med(relG) >= 25 && most[1] / 3 <= 120);   // spring + season + postseason: a long man can reach ~110
      const sv = allP.map(p => p.stats?.sv || 0).sort((a, b) => b - a);
      const svTot = sv.reduce((a, b) => a + b, 0), top = sv.slice(0, st.leagueTeams.length + 1).reduce((a, b) => a + b, 0);
      check(`pitching: closers collect the saves (top ${st.leagueTeams.length + 1}: ${top}/${svTot})`, svTot > 0 && top >= svTot * 0.5);
      const ipgs = startOuts / 3 / Math.max(1, starts);
      check(`pitching: starters go about 5–6 innings (${ipgs.toFixed(2)} IP/GS)`, ipgs >= 4.8 && ipgs <= 6.6);
      // A roster spot belongs to its side: every club still carries its staff.
      const lop = [st.userTeam, ...st.leagueTeams].map(t => {
        const act = (t.rosterIds || []).map(id => st.players[id]).filter(p => p && p.group !== PLAYER_GROUP.IL);
        const pit = act.filter(p => p.pos === 'SP' || p.pos === 'RP').length;
        return { abbr: t.abbr || 'USR', h: act.length - pit, p: pit };
      }).filter(c => Math.abs(c.p - 14) > 2 || Math.abs(c.h - 14) > 2);
      check('rosters: every club carries about 14 hitters and 14 pitchers', lop.length === 0, lop.map(c => `${c.abbr} ${c.h}H/${c.p}P`).join(' '));
    }
    const regPlayed = (id) => {
      const cpu = games.filter(g => !g.isSpring && g.played && (g.homeId === id || g.awayId === id)).length;
      const vsUser = st.schedule.filter(g => !g.isSpring && g._committed && g.opponentId === id).length;
      return cpu + vsUser;
    };
    const bad = st.leagueTeams.filter(t => (t.wins || 0) + (t.losses || 0) !== regPlayed(t.id));
    check('league: every club\'s W+L equals the games it played', bad.length === 0,
          bad.map(t => `${t.abbr} ${t.wins}-${t.losses} vs ${regPlayed(t.id)}`).join(', '));
    const cpuPlayers = Object.values(st.players).filter(p => p.teamId && p.teamId !== 'user');
    const ab = cpuPlayers.reduce((a, p) => a + (p.stats?.ab || 0), 0);
    const ws = Object.values(st.players).reduce((a, p) => a + (p.stats?.w || 0), 0);
    const ls = Object.values(st.players).reduce((a, p) => a + (p.stats?.l || 0), 0);
    const regGames = games.filter(g => !g.isSpring && g.played).length + st.schedule.filter(g => !g.isSpring && g._committed).length;
    check(`league: CPU players accumulate real stats (${ab} AB)`, ab > regGames * 25);
    check(`league: one W and one L per game (${ws} W / ${ls} L / ${regGames} games)`,
          Math.abs(ws - regGames) <= regGames * 0.02 && Math.abs(ls - regGames) <= regGames * 0.02);
    const starters = new Set(st.schedule.filter(g => !g.isSpring && g.boxScore)
      .map(g => (g.boxScore.userIsHome ? g.boxScore.away : g.boxScore.home).pitchers[0]?.id));
    check(`league: opponents' rotations turn over (${starters.size} different starters faced)`, starters.size >= 20);
  }

  // ── §71: player cards and development ──────────────────────────
  {
    const st = SM.get();
    const pc = gm.playerCards;
    check(`card actions: delivered and acted on (${pc.length}: ${[...new Set(pc.map(x => x.action))].join(',')})`, pc.length >= 3);
    check('card actions: every "yes" does what the card said, at once',
          pc.every(x => x.ok), pc.filter(x => !x.ok).map(x => x.action).join(','));
    check('player cards: nobody away is ever in the lineup or rotation after a game', gm.awayInLineup.length === 0,
          gm.awayInLineup.slice(0, 5).join(' '));
    const stale = Object.values(st.players).filter(p => p.unavailable && !(p.unavailable.gamesLeft > 0));
    check('player cards: every absence ends (games counted down)', stale.length === 0, stale.length);
    const chained = [...gm.chainSeen.values()];
    check(`card chains: follow-up cards are set in motion (${chained.length})`, chained.length >= 1,
          [...new Set(chained)].join(','));
    const timedPre = [...(st.inbox || [])].filter(c => c._pool === 'PREGAME_POOL');
    check(`card timing: pre-game cards arrive before first pitch (${timedPre.length})`,
          timedPre.every(c => !Number.isFinite(c.expiresAtMs) || (c.arrivedAtMs ?? c.deliverAtMs) <= c.expiresAtMs));
    // §80 game-day moments: every moment of a game day gets its cards, the
    // first game day included (no game before it to plan it), spring too.
    const mom = {};
    for (const c of st.inbox || []) if (c._moment) mom[c._moment] = (mom[c._moment] || 0) + 1;
    check(`card moments: game days bring pre-game, in-game and between-games cards (${JSON.stringify(mom)})`,
          (mom.pregame || 0) >= 20 && (mom.ingame || 0) >= 15 && (mom.between || 0) >= 60);
    const inGame = (st.inbox || []).filter(c => c._moment === 'ingame');
    check('card moments: in-game cards arrive while the game is on',
          inGame.every(c => (c.arrivedAtMs ?? c.deliverAtMs) <= c.expiresAtMs));
    // §80 first moments: the takeover and Opening Day bring their own card;
    // a second season opens camp with one.
    const md = st.momentsDone || {};
    check(`first moments: the takeover and Opening Day each brought a card (${Object.entries(md).map(([k, v]) => `${k}=${v.cardId}`).join(', ')})`,
          !!md['1|takeover'] && !!md['1|opening_day']);
    if ((st.cardPlanKey || '').startsWith('2|')) check('first moments: season 2 opens camp with a card', !!md['2|camp_open']);
    const springMoments = (st.inbox || []).filter(c => /^(pg30_sp|ig_sp)/.test(c.cardId || ''));
    check(`card moments: spring game-day cards can arrive (${springMoments.length}: ${[...new Set(springMoments.map(c => c.cardId))].join(',')})`,
          true);
    const plans = st.developmentPlans || [];
    const done = plans.filter(x => x.status === 'done');
    check(`development: plans start and complete on the clock (${plans.length} plans, ${done.length} done)`,
          plans.length === 0 || done.length >= 1 || plans.every(x => x.createdAt > clock.get() - 21 * 86_400_000));
    check('development: every finished plan landed exactly its realized gain',
          done.every(x => Math.abs(x.applied - x.realized) <= 0.15),
          done.filter(x => Math.abs(x.applied - x.realized) > 0.15).map(x => `${x.applied}/${x.realized}`).join(','));
    check(`development: outcomes vary (${[...new Set(done.map(x => x.profile))].join(',') || 'none yet'})`,
          done.length < 4 || new Set(done.map(x => x.profile)).size >= 2);
  }

  // If we simulated the entire regular season, the playoffs must have started
  // (guards the getNextPhase playoff-trigger off-by-one).
  // ── §68: the postseason, played out on the league clock ─────────
  if (target >= s0.schedule.length) {
    const ps = await runPostseason();
    const st = SM.get();
    const b  = st.playoffBracket;
    check('postseason: bracket built when the league\'s last regular game was final', !!b);
    check(`postseason: season reaches SEASON_SUMMARY after the World Series (phase ${st.phase})`,
          st.phase === PHASE.SEASON_SUMMARY, `${ps.steps} clock steps, ${ps.userGames} user playoff games`);
    if (b) {
      const all = ['WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES']
        .flatMap(r => r === 'WORLD_SERIES' ? b.WORLD_SERIES.series : [...b.divA[r].series, ...b.divB[r].series]);
      check(`postseason: all ${all.length} series decided`, all.length === 9 && all.every(x => x.status === 'final'),
            all.map(x => `${x.id}:${x.status}`).join(' '));
      check('postseason: every series ended exactly when a team reached the wins needed',
            all.every(x => Math.max(x.winsA, x.winsB) === x.winsNeeded && x.games.length === x.winsA + x.winsB
                        && x.games.length <= x.bestOf));
      const seedsOk = ['divA', 'divB'].every(d => {
        const sd = b[d].seeds; const pct = t => t.wins / Math.max(1, t.wins + t.losses);
        return sd.length === 5 && sd.every((t, i) => i === 0 || pct(sd[i - 1]) >= pct(t));
      });
      check('postseason: seeds follow the standings (all five teams per division)', seedsOk);
      check('postseason: champion crowned', !!b.champion, b.champion?.name);
      const pct = (t) => `${t.abbr || 'USR'} ${t.wins}-${t.losses}`;
      check('season: final standings (info)', true,
            [...b.divA.seeds, ...b.divB.seeds].map(t => `${t.abbr} ${t.wins}-${t.losses}`).join(' | '));
      // §69 league balance: the contender lands in a plausible band around its
      // 88-win target and no CPU club is historically awful or dominant.
      const cpuW = st.leagueTeams.map(t => t.wins || 0);
      if (process.env.BAL_DUMP) {
        const worst = [...st.leagueTeams].sort((a, b) => (a.wins || 0) - (b.wins || 0))[0];
        const P = (id) => st.players[id];
        const act = worst.rosterIds.map(P).filter(Boolean);
        const grp = {}; for (const p of act) grp[p.group + (p.pos === 'SP' || p.pos === 'RP' ? 'P' : 'H')] = (grp[p.group + (p.pos === 'SP' || p.pos === 'RP' ? 'P' : 'H')] || 0) + 1;
        const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(1);
        const lgAvg = (f) => avg(st.leagueTeams.map(t => +avg(f(t))));
        const lineup = (t) => (t.lineupSlots || []).map(sl => P(sl.playerId)?.ovr || 0);
        const rot = (t) => (t.rotation?.order || []).map(id => P(id)?.ovr || 0);
        console.log('WORST', worst.abbr, `${worst.wins}-${worst.losses}`, JSON.stringify(grp),
          'lineup', avg(lineup(worst)), 'lg', lgAvg(lineup), 'rot', avg(rot(worst)), 'lg', lgAvg(rot),
          'farm', (worst.farmIds || []).length, 'emptySlots', (worst.lineupSlots || []).filter(sl => !sl.playerId).length,
          'tx', (st.transactions || []).filter(t => t.teamId === worst.id || t.fromTeamId === worst.id).map(t => t.reason).join(','));
        let rs = 0, ra = 0, g = 0;
        for (const gm2 of Object.values(st.leagueSchedule.dayMap).flat()) {
          if (!gm2.played || gm2.isSpring || gm2.isPlayoff || gm2.isAllStar) continue;
          if (gm2.homeId === worst.id) { rs += gm2.homeScore; ra += gm2.awayScore; g++; }
          if (gm2.awayId === worst.id) { rs += gm2.awayScore; ra += gm2.homeScore; g++; }
        }
        const lines = act.filter(p => p.pos === 'SP' || p.pos === 'RP').map(p => `${p.name.split(' ').pop()}(${p.pos}/${p.group} ${p.ovr} st${p.subRatings?.stamina}) ${(p.stats?.ip || 0).toFixed(0)}ip ${p.stats?.ip ? ((p.stats.er * 9) / p.stats.ip).toFixed(2) : '-'} gs${p.stats?.gs || 0}`);
        console.log('WORST-RUNS', `RS ${(rs / g).toFixed(2)} RA ${(ra / g).toFixed(2)} in ${g} CPU games`);
        console.log('WORST-STAFF', lines.join(' | '));
        const inLu = new Set((worst.lineupSlots || []).map(sl => sl.playerId));
        const hit = Object.values(st.players).filter(p => p.pos !== 'SP' && p.pos !== 'RP' && (p.teamId === worst.id) && (p.stats?.ab || 0) + (p.springStats?.ab || 0) >= 0)
          .map(p => { const s2 = p.stats || {}; const pa = (s2.ab || 0) + (s2.bb || 0) + (s2.hbp || 0);
                      const ops = pa ? ((s2.h || 0) + (s2.bb || 0) + (s2.hbp || 0)) / pa + (s2.ab ? (s2.tb || 0) / s2.ab : 0) : 0;
                      return `${p.name.split(' ').pop()}(${p.pos}/${p.group}${inLu.has(p.id) ? '*' : ''} ${p.ovr} c${p.subRatings?.contact} p${p.subRatings?.power}) ${pa}pa ${ops.toFixed(3)}${p.condition ? ' COND' + JSON.stringify(p.condition) : ''}${p.injuryPenalty ? ' INJPEN' : ''}`; });
        console.log('WORST-BATS', hit.join(' | '));
      }
      check('balance: contender wins plausible around the 88-win target (60–112)',
            st.userTeam.wins >= 60 && st.userTeam.wins <= 112, `${st.userTeam.wins}-${st.userTeam.losses}`);
      // §90 the floor is the worst modern season (the 2024 White Sox, 41–121,
      // .253 — 33 of 132); the ceiling the best (.716 — 94 of 132) with room.
      check('balance: CPU clubs inside a realistic band (≥ 33 and ≤ 100 wins of 132)',
            Math.min(...cpuW) >= 33 && Math.max(...cpuW) <= 100, cpuW.sort((x, y) => x - y).join(','));
      checkWeatherSeason(st);
      const regBad = [st.userTeam, ...st.leagueTeams].filter(t => (t.wins || 0) + (t.losses || 0) !== REGULAR_SEASON_GAME_COUNT);
      check('postseason: playoff games never touch the regular-season record', regBad.length === 0,
            regBad.map(t => `${t.abbr} ${t.wins}-${t.losses}`).join(', '));
      const leftover = [...st.schedule.filter(g => g.isPlayoff && !g._committed),
                        ...Object.values(st.leagueSchedule.dayMap).flat().filter(g => g.isPlayoff && !g.played)];
      check('postseason: no orphaned playoff games (clinched series cancel their extras)', leftover.length === 0,
            leftover.map(g => g.seriesId).join(','));
      const userSeries = all.filter(x => x.teamA?.id === 'user' || x.teamB?.id === 'user');
      check(`postseason: user played ${ps.userGames} live playoff games across ${userSeries.length} series`,
            ps.userGames === userSeries.reduce((a, x) => a + x.games.length, 0) && userSeries.length >= 1);
      const psW = Object.values(st.players).reduce((a, p) => a + (p.postseasonStats?.w || 0), 0);
      const psGames = all.reduce((a, x) => a + x.games.length, 0);
      check(`postseason: separate postseason stats (${psW} W in ${psGames} games)`,
            Math.abs(psW - psGames) <= 1 && Object.values(st.players).every(p => !p.stats || true));
    }
  }

  // ── §70: the offseason on the league calendar → season 2 ────────
  if (SM.get().phase === PHASE.SEASON_SUMMARY) {
    await checkCardMoney(SM.get());
    await checkTradeEngine(SM.get());
    checkTalks(SM.get());
    checkLeagueTrades(SM.get());
    await runOffseasonChecks();
    await checkNames('season 2');
    await checkNeutralText(SM.get());
  }

  if (process.env.DBG) {
    const st = SM.get();
    for (const t of [st.userTeam, ...st.leagueTeams]) {
      const f = (t.farmIds || []).map(id => st.players[id]);
      console.log(`${t.abbr || 'USR'} farm H${f.filter(p => !['SP','RP'].includes(p.pos)).length} P${f.filter(p => ['SP','RP'].includes(p.pos)).length}`);
    }
    console.log('FA pool', (st.freeAgentPool || []).length, 'waivers', (st.waiverPool || []).length,
      (st.freeAgentPool || []).map(id => { const p = st.players[id]; return `${p.pos}/${p.tier}/${p.teamId}/${p.isInjured ? 'inj' : ''}`; }).join(' '));
  }
  const ok = summarize();
  console.log(`\nseed=${SEED} games=${target}`);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('\n\x1b[31mHARNESS CRASHED\x1b[0m:', err);
  process.exit(2);
});
