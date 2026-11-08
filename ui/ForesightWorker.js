/**
 * ui/ForesightWorker.js — the look-ahead, off the page's thread (r139 §121).
 *
 * The push schedule needs to know what the world will do while the app is
 * closed: our next game (LookAhead.lookAhead) and every message through the
 * next day (LookAhead.lookAheadMessages). Played on a copy of the save, that
 * takes a few hundred milliseconds to a couple of seconds on a phone — too long
 * for the page, which would stutter after every tap. Here it runs beside it:
 * the page posts a copy of the save, this posts back what will happen.
 *
 * Message in:  { id, state, nowMs, untilMs, gameHorizonMs, seenMoments }
 * Message out: { id, game, foreseen: { untilMs, messages }, ms } | { id, error }
 *
 * Module worker (new Worker(url, { type: 'module' })). Nothing here is saved:
 * the save it holds is a copy (StateManager.adopt), and every look-ahead runs
 * on a scratch copy of that (StateManager.speculate).
 */

import * as StateManager from '../store/StateManager.js';
import { foresee } from '../engine/LookAhead.js';
import { setSeenMoments } from '../engine/CardEngine.js';

self.onmessage = (e) => {
  const { id, state, nowMs, untilMs, gameHorizonMs, seenMoments } = e.data || {};
  const t0 = performance.now();
  try {
    StateManager.adopt(state);
    setSeenMoments(seenMoments || []);
    const out = foresee(nowMs, untilMs, gameHorizonMs);
    self.postMessage({ id, ...out, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

