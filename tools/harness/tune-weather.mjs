// §100 (step 1g) Weather tuning: each region and month against its normals,
// over several seeds. Not a pass/fail check — numbers to tune by.
//   node tools/harness/tune-weather.mjs [regions] [seeds]
import { precipAt, stormNear } from '../../engine/WeatherSystems.js';
import { conditionsAt } from '../../engine/WeatherConditions.js';
import { regionMap } from '../../engine/WeatherMap.js';
import { localDayStart, normalsOnDay, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { REGION_CLIMATE } from '../../data/region-climate.js';

const tz = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), tz);
const regions = (process.argv[2] || 'north,south,east,west').split(',');
const seeds = (process.argv[3] || 'wx-a,wx-b,wx-c').split(',');
const MONTHS = [['Apr', 105], ['May', 135], ['Jun', 166], ['Jul', 196], ['Aug', 227], ['Sep', 258]];
const doy0 = 72;   // Mar 14
const STEP = 15 * 60_000;

for (const region of regions) {
  console.log(`\n${region}`);
  console.log('month   hi(bias)  lo(bias)  wet days    inches       thunder days  swing  by kind (inches)');
  for (const [lab, mid] of MONTHS) {
    const N = normalsOnDay(region, mid);
    let hi = 0, lo = 0, wet = 0, thunder = 0, mm = 0, days = 0, swings = [], prevHi = null;
    const byKind = {};
    for (const seed of seeds) {
      const ctx = { seed, region, tzMin: tz, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] };
      for (let d = -14; d < 16; d++) {
        const t0 = START + (mid - doy0 + d) * MS_DAY;
        let dayMm = 0, thun = false;
        for (let t = t0 + STEP / 2; t < t0 + MS_DAY; t += STEP) {
          const p = precipAt(ctx, 0, 0, t, { parts: true, kind: false });
          if (!(p.rateMmH > 0)) continue;
          dayMm += p.rateMmH * 0.25;

          // Share the rain out by kind, in proportion to each system's power.
          const z = p.parts.reduce((a, q) => a + 10 ** (q.dbz / 10), 0);
          for (const q of p.parts) byKind[q.kind] = (byKind[q.kind] || 0) + p.rateMmH * 0.25 * (10 ** (q.dbz / 10)) / z;
        }
        // A thunder day as observers count it: lightning within about 10 miles.
        for (let t = t0 + 15 * 60_000; t < t0 + MS_DAY && !thun; t += 30 * 60_000) if (stormNear(ctx, 0, 0, t, 16) >= 43) thun = true;
        const h = Math.max(...[14, 15, 16, 17].map(x => conditionsAt(ctx, 0, 0, t0 + x * MS_HOUR).tempF));
        const l = Math.min(...[4, 5, 6, 7].map(x => conditionsAt(ctx, 0, 0, t0 + x * MS_HOUR).tempF));
        hi += h; lo += l; days++; mm += dayMm;
        if (dayMm >= 0.25) wet++;
        if (thun) thunder++;
        if (prevHi != null && d > -14) swings.push(Math.abs(h - prevHi));
        prevHi = h;
      }
      prevHi = null;
    }
    const inch = (mm / 25.4) * (30.4 / days);
    const sw = swings.reduce((a, b) => a + b, 0) / swings.length;
    const kinds = Object.entries(byKind).map(([k, v]) => `${k} ${((v / 25.4) * (30.4 / days)).toFixed(1)}`).join(', ');
    const f = (v, t) => `${v.toFixed(0)}(${v - t >= 0 ? '+' : ''}${(v - t).toFixed(1)})`;
    console.log(`${lab.padEnd(7)} ${f(hi / days, N.hi).padEnd(9)} ${f(lo / days, N.lo).padEnd(9)} ${(wet / days).toFixed(2)}/${N.wet.toFixed(2)}   ${inch.toFixed(1)}/${N.inches.toFixed(1)}`.padEnd(52)
      + ` ${(thunder / days).toFixed(2)}/${(N.wet * N.storms).toFixed(2)}     ${sw.toFixed(1)}   ${kinds}`);
  }
}
