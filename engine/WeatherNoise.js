/**
 * engine/WeatherNoise.js
 * §100 Deterministic randomness for the weather and its maps. Every value is
 * a pure function of its inputs (a seed and some integers), so the same
 * place and moment always produce the same weather — nothing is stored or
 * re-rolled. Never use Math.random in weather code.
 */

/** 32-bit hash of a string (FNV-1a). */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix any number of integers (and a string/number seed) into one 32-bit hash. */
export function hash(seed, ...ints) {
  let h = typeof seed === 'number' ? (seed >>> 0) : hashString(seed);
  for (const n of ints) {
    let k = Math.imul((n | 0) ^ ((n / 4294967296) | 0), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) from a seed and integers. */
export function hash01(seed, ...ints) {
  return hash(seed, ...ints) / 4294967296;
}

/** Uniform [-1, 1). */
export function hashSigned(seed, ...ints) {
  return hash01(seed, ...ints) * 2 - 1;
}

/** A small seeded stream (mulberry32) for building one object's parameters. */
export function stream(seed, ...ints) {
  let a = hash(seed, ...ints);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    /** Approximately normal (sum of three uniforms), mean 0, sd ≈ 1. */
    normal: () => (next() + next() + next() - 1.5) * 2,
  };
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 2-D value noise in [-1, 1], smooth, with unit cell size. */
export function valueNoise2(seed, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const v00 = hashSigned(seed, xi, yi),     v10 = hashSigned(seed, xi + 1, yi);
  const v01 = hashSigned(seed, xi, yi + 1), v11 = hashSigned(seed, xi + 1, yi + 1);
  const a = v00 + (v10 - v00) * fx, b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/** 3-D value noise in [-1, 1] (x, y, time) — for textures that evolve. */
export function valueNoise3(seed, x, y, z) {
  const zi = Math.floor(z), fz = smooth(z - zi);
  const a = valueNoise2(hash(seed, zi), x, y), b = valueNoise2(hash(seed, zi + 1), x, y);
  return a + (b - a) * fz;
}

/** Fractal noise: `octaves` layers of value noise, each half the size. Range ≈ [-1, 1]. */
export function fbm2(seed, x, y, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(hash(seed, o), x * f, y * f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

export function fbm3(seed, x, y, z, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(hash(seed, o), x * f, y * f, z * f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
