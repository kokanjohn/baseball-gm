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
 * r138 (§120) also follows the game past the moments the push schedule needs
 * to name: a postponement (and the makeup date the schedule finds for it), a
 * start the weather holds and then calls off, a game two that waits for game
 * one, and a suspension (and the day it resumes).
 *
 * DOES NOT: change the real save, schedule anything, or send anything — the
 * push schedule reads its result (engine/GamePushes.js).
 */

import * as StateManager from '../store/StateManager.js';
import { clockNow, runAt, setClock } from './Clock.js';
import { tick, getNextGame } from './GameEngine.js';
import { GAME_STATUS } from '../data/constants.js';

const MIN = 60_000;
const HOLD_STEP = 10 * MIN, HOLD_MAX = 8 * 60 * MIN;   // a game two waiting on game one

/**
 * lookAhead(nowMs)
 * Our next game, as it will happen — computed on a scratch copy.
 * @param {Number} [nowMs] — the moment to look from (default: now)
 * @returns {null | {
 *   index: Number, gameTime: Number, date: String, opponent: String, isHome: Boolean,
 *   status: String,          // after first pitch: LIVE, DELAYED (start held), POSTPONED…
 *   plays: Object[],         // the whole game (empty if it never starts)
 *   wx: Object|null,         // the game's weather plan (GameWeather)
 *   wxResult: Object|null,   // how the weather played out in it (start held, delays, suspension)
 *   boxScore: Object|null,   // the full game's box (the final score), as it will be committed
 *   postponed: null | { decidedAt, reason, calledBy, startHeld, cancelled, makeupDate, makeupTime, doubleheader },
 *   suspended: null | { atMs, resumeDate, resumeTime },
 * }}
 */
export function lookAhead(nowMs = clockNow()) {
  return StateManager.speculate(() => runAt(nowMs, () => {
    const g0 = getNextGame();
    if (!g0 || !Number.isFinite(g0.gameTime)) return null;
    const T0 = g0.gameTime, opp = g0.opponent;
    // The game, wherever the weather moves it (the schedule re-sorts on a move).
    const find = () => {
      const s = StateManager.get().schedule || [];
      return s.find(x => x.gameTime === T0 && x.opponent === opp && !x.postponements?.some(p => p.gameTime === T0))
          || s.find(x => x.opponent === opp && x.postponements?.some(p => p.gameTime === T0))
          || s.find(x => x.opponent === opp && x.suspension?.gameTime === T0)
          || null;
    };
    // The world up to our first pitch, then first pitch itself (the roster
    // clock holds there — §65 — so the game starts with the rosters it has).
    let t = Math.max(nowMs, T0);
    setClock(t);
    tick();
    let g = find();
    // A start the weather holds, then calls off: on to the call.
    if (g && g.status === GAME_STATUS.DELAYED && !g.plays?.length && g.wx?.outcome === 'postponed' && Number.isFinite(g.wx.decidedAt)) {
      t = Math.max(t, g.wx.decidedAt);
      setClock(t);
      tick();
      g = find();
    }
    // Game two of a doubleheader waits for game one.
    for (let k = 0; g && !g.plays?.length && !_postponedFrom(g, T0) && k * HOLD_STEP < HOLD_MAX
         && (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH); k++) {
      t += HOLD_STEP;
      setClock(t);
      tick();
      g = find();
    }
    if (!g) return null;
    const ppd = _postponedFrom(g, T0);
    const out = {
      index:    g0.index,
      gameTime: T0,
      date:     g0.date,
      opponent: opp,
      isHome:   !!g0.isHome,
      isAllStar: !!g0.isAllStar,
      isSpring: !!g0.isSpring,
      status:   ppd ? GAME_STATUS.POSTPONED : g.status,
      plays:    ppd || !g.plays ? [] : structuredClone(g.plays),
      wx:       g.wx ? structuredClone(g.wx) : null,
      wxResult: g.wxResult ? structuredClone(g.wxResult) : null,
      boxScore: !ppd && g._precomputedBoxScore ? structuredClone(g._precomputedBoxScore) : null,
      postponed: ppd ? {
        decidedAt:    ppd.decidedAt,
        reason:       ppd.reason,
        calledBy:     ppd.calledBy,
        startHeld:    Number.isFinite(ppd.decidedAt) && ppd.decidedAt > T0,
        cancelled:    !!g.cancelled,
        makeupDate:   g.cancelled ? null : g.date,
        makeupTime:   g.cancelled ? null : g.gameTime,
        doubleheader: /dh$/.test(g.makeup?.how || ''),
      } : null,
      suspended: null,
    };
    // Stopped by the weather, to be finished another day: when it resumes.
    const sp = out.plays.find(p => p.type === 'game_suspended' && Number.isFinite(p._timestamp));
    if (sp) {
      setClock(Math.max(t, sp._timestamp + 1000));
      tick();
      const x = find();
      const moved = x?.status === GAME_STATUS.SUSPENDED;
      out.suspended = { atMs: sp._timestamp, resumeDate: moved ? x.date : null, resumeTime: moved ? x.gameTime : null };
    }
    return out;
  }));
}

/** The postponement that moved the game from T0 (null if it wasn't). */
function _postponedFrom(g, T0) {
  const list = g.postponements || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].gameTime === T0) return list[i];
  return null;
}
