/**
 * engine/Clock.js — the engines' one source of "now" (§118).
 *
 * OWNS: what time the engines think it is. Normally the real time. The
 *   look-ahead (StateManager.speculate) plays the world forward on a scratch
 *   copy by running engine code at a moment in the future (runAt).
 *
 * Every engine reads the time through clockNow(), never Date.now() directly,
 * so a look-ahead sees exactly the moment it's computing. (The test harness
 * moves Date.now itself; clockNow follows it.)
 *
 * DOES NOT: schedule anything, or import StateManager.
 */

let _at = null;

/** The engines' "now", in Unix ms. */
export function clockNow() {
  return _at ?? Date.now();
}

/**
 * runAt(ms, fn) — run fn with the engines' clock at `ms` (and moved by
 * setClock inside it); the clock is restored afterwards, even on a throw.
 */
export function runAt(ms, fn) {
  const prev = _at;
  _at = ms;
  try { return fn(); } finally { _at = prev; }
}

/** Move the clock inside a runAt (the look-ahead stepping forward). */
export function setClock(ms) {
  if (_at === null) throw new Error('Clock.setClock: only inside runAt');
  _at = ms;
}
