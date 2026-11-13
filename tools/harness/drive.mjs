// r159 Live the game the way the app does, up to a moment: our games played to the last out and
// committed (rainouts, delays and makeups as they come), the league clock between them, every message
// released as it lands. The same driver multi-season.mjs uses, shared so a check can run days of the
// season without re-implementing it.
//   import { clock } from './shims.js' first (it installs the globals); then
//   await liveUntil(toMs, { onStep })   — onStep() after every step (e.g. the GM answering cards)
import { clock } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { tick, commitGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { GAME_STATUS, PHASE } from '../../data/constants.js';

const noop = () => {};

function stepTo(t, onStep) {
  for (let guard = 0; guard < 400; guard++) {
    const next = (SM.get().scheduledCards || []).map(c => c.deliverAtMs).filter(x => x > clock.get() && x < t).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    clock.set(next + 1000); advanceClock(clock.get()); releaseDueCards(); onStep();
  }
}

/** One game of ours to FINAL (or called off). */
export function playToFinal(idx, onStep = noop) {
  for (let guard = 0; guard < 6000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g) return false;
    if (g.status === GAME_STATUS.FINAL) return true;
    if (g.status === GAME_STATUS.POSTPONED && g.cancelled) return true;
    if (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH
        || (g.status === GAME_STATUS.SUSPENDED && g.gameTime > clock.get())) {
      advanceClock(clock.get()); releaseDueCards(); onStep();
      const id0 = g.id, t0 = g.gameTime;
      stepTo(t0 || clock.get(), onStep);
      const now = SM.get().schedule[idx];
      if (!now || now.id !== id0 || now.gameTime !== t0) continue;
      clock.set((t0 || clock.get()) + 60_000);
    } else if (g.status === GAME_STATUS.LIVE) {
      const np = g.plays?.[g.livePlayIndex];
      if (np && np._timestamp) clock.set(np._timestamp + (g._tickOffset || 0) + 1_000);
      else clock.advance(60_000);
    } else clock.advance(60 * 60_000);
    tick(); releaseDueCards();
  }
  return false;
}

/** Live the game up to `toMs`: our games played and committed, the league clock in between. */
export async function liveUntil(toMs, { onStep = noop } = {}) {
  for (let guard = 0; guard < 6000 && clock.get() < toMs; guard++) {
    const st = SM.get();
    if (st.phase === PHASE.SEASON_SUMMARY || st.phase === PHASE.OFFSEASON) break;
    const idx = st.currentGameIndex;
    const g = st.schedule[idx];
    if (g && !g._committed && Number.isFinite(g.gameTime) && g.gameTime < toMs) {
      if (!playToFinal(idx, onStep)) return false;
      await commitGame(idx); releaseDueCards(); onStep();
      continue;
    }
    // Nothing of ours before `toMs`: the league clock to its next event (or to `toMs`).
    let next = toMs;
    for (const cg of Object.values(st.leagueSchedule?.dayMap || {}).flat()) {
      if (cg.played) continue;
      const t = cg.status === GAME_STATUS.LIVE && cg.plays?.length ? cg.plays[cg.plays.length - 1]._timestamp : cg.gameTime;
      if (t > clock.get() - 1 && t < next) next = t;
    }
    const sched = (st.scheduledCards || []).map(c => c.deliverAtMs).filter(t => t > clock.get() && t < next);
    if (sched.length) next = Math.min(next, ...sched);
    clock.set(Math.max(clock.get() + 1000, next + 1000));
    advanceClock(clock.get()); releaseDueCards(); onStep();
  }
  return true;
}
