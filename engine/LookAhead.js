/**
 * engine/LookAhead.js — what our next game will bring, known ahead (§118).
 *
 * OWNS: playing the world forward on a scratch copy of the save
 *   (StateManager.speculate) from a moment through our next game's first
 *   pitch, and reporting how that game goes: its plays, its weather (a held
 *   start, delays, a suspension, a postponement) and its final.
 *
 * Why it can be trusted: every random event in the world draws from its own
 * seeded stream (engine/Dice.js), so the forward run and the real one — when
 * the app is open at first pitch, or catching up when it reopens — roll the
 * same dice. Anything the GM changes before then (a lineup, an answer) changes
 * the inputs, and the look-ahead is run again.
 *
 * Runs the real engine code (GameEngine.tick: the roster clock, the weather,
 * our first pitch), so it can't drift from what actually happens.
 *
 * DOES NOT: change the real save, schedule anything, or send anything — the
 * push schedule reads its result (§118 step 3).
 */

import * as StateManager from '../store/StateManager.js';
import { clockNow, runAt, setClock } from './Clock.js';
import { tick, getNextGame } from './GameEngine.js';
import { GAME_STATUS } from '../data/constants.js';

/**
 * lookAhead(nowMs)
 * Our next game, as it will happen — computed on a scratch copy.
 * @param {Number} [nowMs] — the moment to look from (default: now)
 * @returns {null | {
 *   index: Number, gameTime: Number, opponent: String,
 *   status: String,          // after first pitch: LIVE, DELAYED (start held), POSTPONED…
 *   plays: Object[],         // the whole game (empty if it never starts)
 *   wx: Object|null,         // the game's weather plan (GameWeather)
 *   wxResult: Object|null,   // how the weather played out in it (start held, delays, suspension)
 *   boxScore: Object|null,   // the full game's box (the final score), as it will be committed
 * }}
 */
export function lookAhead(nowMs = clockNow()) {
  return StateManager.speculate(() => runAt(nowMs, () => {
    const g0 = getNextGame();
    if (!g0 || !Number.isFinite(g0.gameTime)) return null;
    // The world up to our first pitch, then first pitch itself (the roster
    // clock holds there — §65 — so the game starts with the rosters it has).
    const at = Math.max(nowMs, g0.gameTime);
    setClock(at);
    tick();
    const g = StateManager.get().schedule[g0.index];
    if (!g) return null;
    // Held by the weather before it starts: the plan says when it's called off.
    return {
      index:    g.index,
      gameTime: g.gameTime,
      opponent: g.opponent,
      status:   g.status,
      plays:    g.status === GAME_STATUS.POSTPONED || !g.plays ? [] : structuredClone(g.plays),
      wx:       g.wx ? structuredClone(g.wx) : null,
      wxResult: g.wxResult ? structuredClone(g.wxResult) : null,
      boxScore: g._precomputedBoxScore ? structuredClone(g._precomputedBoxScore) : null,
    };
  }));
}
