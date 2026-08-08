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
  let committed = 0, crossedToRegular = false, phaseAtCross = null;

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
    committed++;
  }

  check(`committed ${committed} game(s)`, committed > 0, `${committed}`);
  if (crossedToRegular) {
    // The game at index SPRING_TRAINING_GAME_COUNT must be a real regular-season game.
    const firstReg = SM.get().schedule[SPRING_TRAINING_GAME_COUNT];
    check('spring→regular boundary: first post-spring game is regular season', firstReg && !firstReg.isSpring,
          `phase=${phaseAtCross}`);
  }

  const ok = summarize();
  console.log(`\nseed=${SEED} games=${target}`);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('\n\x1b[31mHARNESS CRASHED\x1b[0m:', err);
  process.exit(2);
});
