/**
 * engine/Dice.js — seeded, named random streams (§118).
 *
 * OWNS: turning the franchise's fixed seed plus "what this draw is about"
 *   (a game, a player in that game, a day's trade desk…) into a reproducible
 *   stream of numbers in [0, 1).
 *
 * WHY: the look-ahead plays the world forward on a scratch copy to know what
 *   will happen with the app closed (so it can be pushed), and the catch-up
 *   plays it again for real when the app reopens. Both must get the same
 *   answers, whatever order they compute things in and however they step the
 *   clock. A stream belongs to one event, so no other draw can shift it: the
 *   same game rolls the same dice whenever it's played. The weather has worked
 *   this way since §102 (a pure function of the seed and the time).
 *
 * Keys name the event, never a moment of computing it: a game by its schedule
 * identity and first pitch, an injury by the game and the player, the trade
 * desk by its day. Two different events must never share a key.
 *
 * DOES NOT: hold state, read the clock, or import StateManager.
 */

/** The franchise's dice seed: fixed for the life of the save (the weather seed's sibling). */
export function diceSeed(state) {
  return `${state?.weatherSeed ?? 'franchise'}:dice`;
}

/**
 * dice(seed, ...keys) → rand()
 * A stream of numbers in [0, 1) for one event. The same seed and keys always
 * give the same stream.
 * @param {String} seed   — diceSeed(state)
 * @param {...(String|Number)} keys — what the draws are about
 * @returns {Function} rand — () => Number in [0, 1)
 */
export function dice(seed, ...keys) {
  const [a, b, c, d] = _cyrb128(`${seed}|${keys.map(k => String(k ?? '')).join('|')}`);
  return _sfc32(a, b, c, d);
}

/**
 * diceId(rand) — an id for something the world creates (a new player), drawn
 * from its stream, so the look-ahead and the real run create the same id.
 * Shaped like a v4 UUID.
 */
export function diceId(rand) {
  const h = () => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
  const v = (8 + Math.floor(rand() * 4)).toString(16);
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${v}${h().slice(1)}-${h()}${h()}${h()}`;
}

/** An integer in [lo, hi] from a stream. */
export function randInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// ── cyrb128 (string → 128-bit seed) and sfc32 (small fast counter PRNG) ──

function _cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function _sfc32(a, b, c, d) {
  return function rand() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
