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
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import {
  GAME_STATUS, PHASE, ROSTER_LIMITS,
  SPRING_TRAINING_GAME_COUNT, REGULAR_SEASON_GAME_COUNT,
} from '../../data/constants.js';
import {
  reconcileRoster, applyRosterMutation, eligibleSlotsFor,
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

// ── Drive one game to FINAL by advancing the virtual clock ───────
function playToFinal(idx) {
  for (let guard = 0; guard < 6000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g) return false;
    if (g.status === GAME_STATUS.FINAL) return true;

    // Advance the clock precisely to the next event, then tick once.
    if (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH) {
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
  }
  return SM.get().schedule[idx]?.status === GAME_STATUS.FINAL;
}

// ── Count the active (non-IL) hitters/pitchers on the user roster ─
function activeCount(state) {
  const p = state.players;
  return (state.userTeam.rosterIds || []).filter(id => p[id] && p[id].group !== 'il').length;
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
  p.isInjured = true; p.group = 'il'; p.ilReturnGame = (state.currentGameIndex || 0) + 20;
  return entry.playerId;
}
function assertTeamIntegrity(state, team, label) {
  let slotsOk = true, rotOk = true;
  const seen = new Set();
  for (const s of (team.lineupSlots || [])) {
    if (!s.playerId) continue;
    const p = state.players[s.playerId];
    if (!p || p.isInjured || G(p) !== 'bh' || !team.rosterIds.includes(s.playerId)
        || seen.has(s.playerId) || !eligibleSlotsFor(p).includes(s.slot)) slotsOk = false;
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
    p.isInjured = true; p.group = 'il'; p.ilReturnGame = (st.currentGameIndex || 0) + 20;
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
      const mut = reconcileRoster(st, cpu.id, { autoManage: true });
      applyRosterMutation(st, mut);
      const t = teamOf(st, cpu.id);
      check('fault(cpu hitter): active roster back to 28',
            nonIL(st, t) === ROSTER_LIMITS.ACTIVE_TOTAL, `got ${nonIL(st, t)}`);
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
        applyRosterMutation(st, reconcileRoster(st, cpu.id, { autoManage: true }));
        const t = teamOf(st, cpu.id);
        check('fault(cpu departure): departed id gone from lineup',
              !t.lineupSlots.some(s => s.playerId === gone));
        check('fault(cpu departure): active roster back to 28',
              nonIL(st, t) === ROSTER_LIMITS.ACTIVE_TOTAL, `got ${nonIL(st, t)}`);
        assertTeamIntegrity(st, t, 'fault(cpu departure)');
      }
    }
  }
}

async function main() {
  seedRandom(SEED);

  await startNewGame({
    archetypeId: 'contender',
    gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
    abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'north',
  });

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
  check(`initial active roster = ${ROSTER_LIMITS.ACTIVE_TOTAL} (+spring invitees)`,
        activeCount(s0) >= ROSTER_LIMITS.ACTIVE_TOTAL, `got ${activeCount(s0)}`);

  // ── Play through GAMES games ──────────────────────────────────
  const target = Math.min(GAMES, s0.schedule.length);
  let committed = 0, crossedToRegular = false, phaseAtCross = null, faultDone = false;
  let gamesWithRelief = 0; // r51: games where at least one side used >1 pitcher

  for (let i = 0; i < target; i++) {
    const idx = SM.get().currentGameIndex;
    if (idx == null || idx >= s0.schedule.length) break;

    const reachedFinal = playToFinal(idx);
    const pre = SM.get().schedule[idx];
    check(`game ${idx} reaches FINAL`, reachedFinal, `status ${pre?.status}`);

    // linescore/score coherence from the last revealed play (pre-commit)
    if (pre?.plays?.length) {
      const last = pre.plays[pre.plays.length - 1];
      check(`game ${idx} score = last play cumulative`,
            pre.ourScore === last.cumOurScore && pre.theirScore === last.cumTheirScore,
            `card ${pre.ourScore}-${pre.theirScore} vs play ${last.cumOurScore}-${last.cumTheirScore}`);
    }

    await commitGame(idx);
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
      // r51: bullpen usage — a full game should hook the starter for relief.
      const awayP = (box.away.pitchers || []).length;
      const homeP = (box.home.pitchers || []).length;
      if (awayP >= 2 || homeP >= 2) gamesWithRelief++;
    }
    check(`game ${idx} advanced currentGameIndex`, post.currentGameIndex === idx + 1, `now ${post.currentGameIndex}`);

    // roster-integrity canary — phase-aware:
    //   SPRING: 28–38 (28 + up to 10 invitees).  REGULAR: exactly 28 (post-cuts).
    const ac = activeCount(post);
    if (post.phase === PHASE.SPRING_TRAINING) {
      check(`game ${idx} (spring): active roster 28–38`, ac >= ROSTER_LIMITS.ACTIVE_TOTAL && ac <= ROSTER_LIMITS.SPRING_TOTAL, `got ${ac}`);
    } else {
      check(`game ${idx} (${post.phase}): active roster = ${ROSTER_LIMITS.ACTIVE_TOTAL}`, ac === ROSTER_LIMITS.ACTIVE_TOTAL, `got ${ac}`);
    }

    // phase-transition canary: once the NEXT game is a regular-season game,
    // the phase must no longer be SPRING_TRAINING (Opening Day cut must have run).
    if (post.currentGameIndex >= SPRING_TRAINING_GAME_COUNT) {
      check(`after game ${idx}: phase left SPRING_TRAINING by Opening Day`,
            post.phase !== PHASE.SPRING_TRAINING, `phase=${post.phase}`);
    }

    // detect spring→regular crossing
    if (!crossedToRegular && idx + 1 === SPRING_TRAINING_GAME_COUNT) {
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

  // If we simulated the entire regular season, the playoffs must have started
  // (guards the getNextPhase playoff-trigger off-by-one).
  if (target >= SM.get().schedule.length) {
    check('playoffs triggered after final regular game',
          SM.get().phase === PHASE.PLAYOFF_BRACKET_BUILD, `phase=${SM.get().phase}`);
  }

  const ok = summarize();
  console.log(`\nseed=${SEED} games=${target}`);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('\n\x1b[31mHARNESS CRASHED\x1b[0m:', err);
  process.exit(2);
});
