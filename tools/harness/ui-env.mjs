// §122.69 The UI tests' world, pinned: the same moment and the same dice on every run.
//
// A UI test used to run on the real clock and the page's real Math.random: the league, its
// weather (a first spring game rained out), the time of day the games fell at, all changed from
// run to run, and a test could pass at one hour and fail at the next ("flaky"). Every test now
// calls pinEnv(ctx) right after browser.newContext:
//   - the page's clock stands at PIN (a fixed date and time; Playwright's setFixedTime: Date stays put, timers
//     run) until the test moves it with its own page.clock calls. A clock that ran on its own made every new
//     club different: the weather seed hashes the moment the club is founded (GameEngine.startNewGame);
//   - the test's own Date.now (Node) stands at the same PIN, so `now` in a test and in the page agree (a test
//     that measures how long something took uses performance.now);
//   - the page's Math.random is a seeded generator (mulberry32), the same sequence every load;
//   - the page's crypto.randomUUID is seeded too (its own stream, as shims.js does for the checks):
//     ids order and hash things — the schedule's club order among them.
// TFO_PIN (ISO time or ms) and TFO_SEED override them, to look at a failure at another moment.
//   import { pinEnv } from './ui-env.mjs';  …  await pinEnv(ctx);

const PIN_DEFAULT = '2026-11-16T10:00:00-05:00';   // a Monday morning
export const PIN = Number.isFinite(Number(process.env.TFO_PIN)) && process.env.TFO_PIN
  ? Number(process.env.TFO_PIN) : Date.parse(process.env.TFO_PIN || PIN_DEFAULT);
export const SEED = Number(process.env.TFO_SEED || 1);

// Node's Date.now stands at PIN too (Playwright times its waits with its own monotonic clock).
if (!globalThis.__tfoPinned) {
  globalThis.__tfoPinned = true;
  Date.now = () => PIN;
}

export async function pinEnv(ctx, { seed = SEED } = {}) {
  await ctx.clock.setFixedTime(PIN);
  await ctx.addInitScript((seed) => {
    let a = seed >>> 0;
    Math.random = function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let n = 0;
    const word = (k) => {
      let t = (seed ^ Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(k + 1, 0x85EBCA77)) | 0;
      t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, '0');
    };
    const uuid = () => {
      const h = word(0) + word(1) + word(2) + word(3); n++;
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    try { Object.defineProperty(crypto, 'randomUUID', { value: uuid, configurable: true, writable: true }); } catch { /* left as is */ }
  }, seed);
  return ctx;
}
