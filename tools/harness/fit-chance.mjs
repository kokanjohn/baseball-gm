// §102.7 (3d) Chance calibration by window length — data, fit, and the check.
//   node tools/harness/fit-chance.mjs collect out.json seeds=a,b   — samples: { raw, climate, lead, hours, wet }
//   node tools/harness/fit-chance.mjs fit fit.json valid.json       — the window terms (kA, kB), and reliability before/after
// The forecast's chance (WeatherForecast.chanceOfPrecip) turns the ensemble's share into a chance against
// the climate's chance for a window that long. Short windows (an hour, a game's three) were sharpened too
// hard against their small climate chance; the window term softens that.
import { writeFileSync, readFileSync } from 'node:fs';
import { regionMap, REGION_KEYS } from '../../engine/WeatherMap.js';
import { localDayStart, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { chanceOfPrecip, calibrateChance } from '../../engine/WeatherForecast.js';
import { rainTotal } from '../../engine/WeatherConditions.js';

const [mode, a1, a2] = process.argv.slice(2);
const TZ = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
const WINDOWS = [1, 3, 24], LEADS = [3, 12, 24, 48, 96];

if (mode === 'collect') {
  const seeds = (a2 || 'fit-a,fit-b').split(',');
  const out = [];
  for (const region of REGION_KEYS) for (const seed of seeds) {
    const ctx = { seed, region, tzMin: TZ, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] };
    const parks = Object.keys(ctx.map.parks);
    for (let d = 16; d < 196; d += 2) {
      const pk = ctx.map.parks[parks[(d * 3) % parks.length]];
      for (const hours of WINDOWS) {
        const t0 = START + d * MS_DAY + (hours === 24 ? 0 : (d % 4 < 2 ? 19 : 13)) * MS_HOUR + (hours === 24 ? 0 : 5 * 60_000);
        const t1 = t0 + hours * MS_HOUR;
        const wet = rainTotal(ctx, pk.x, pk.y, t0, t1, hours === 24 ? 15 : 10) >= 0.01;
        for (const L of LEADS) {
          const c = chanceOfPrecip(ctx, t0 - L * MS_HOUR, pk.x, pk.y, t0, t1);
          out.push({ raw: c.raw / 100, climate: c.climate / 100, lead: L + hours / 2, hours, wet: wet ? 1 : 0, region });
        }
      }
    }
    console.log(region, seed, out.length);
  }
  writeFileSync(a1, JSON.stringify(out));
} else if (mode === 'table') {
  // A recalibration table for short windows: for each window length, how often the current chance verifies,
  // in steps of 10 (pooled over leads), made monotone (pool-adjacent-violators), anchored at 0 → 0 and 100 → 100.
  const fit = JSON.parse(readFileSync(a1, 'utf8')), valid = JSON.parse(readFileSync(a2, 'utf8'));
  const cur = (s) => calibrateChance(s.raw, s.climate, s.lead, 24);
  const table = {};
  for (const hours of [1, 3]) {
    const bins = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, n: 0, w: 0 }));
    for (const s of fit.filter(s => s.hours === hours)) { const b = bins[Math.min(10, Math.round(cur(s) * 10))]; b.n++; b.w += s.wet; }
    // Pool adjacent violators (weighted), with a light prior toward no change (5 samples at the bin's own value).
    let blocks = bins.map(b => ({ xs: [b.x], n: b.n + 5, v: (b.w + 5 * b.x / 100) / (b.n + 5) }));
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < blocks.length - 1; i++) {
        if (blocks[i].v > blocks[i + 1].v) {
          const a = blocks[i], b = blocks[i + 1];
          blocks.splice(i, 2, { xs: [...a.xs, ...b.xs], n: a.n + b.n, v: (a.v * a.n + b.v * b.n) / (a.n + b.n) });
          changed = true;
        }
      }
    }
    const map = {};
    for (const bl of blocks) for (const x of bl.xs) map[x] = Math.round(100 * bl.v);
    map[0] = Math.min(map[0], 2); map[100] = Math.max(map[100], 95);
    table[hours] = Array.from({ length: 11 }, (_, i) => map[i * 10]);
  }
  console.log('table', JSON.stringify(table));
  const apply = (p, hours) => {
    if (hours >= 24) return p;
    const lerp = (t, q) => { const x = Math.min(10, Math.max(0, q * 10)), i = Math.min(9, Math.floor(x)); return (t[i] + (t[i + 1] - t[i]) * (x - i)) / 100; };
    const m1 = lerp(table[1], p), m3 = lerp(table[3], p);
    const u = Math.log2(hours);   // 0 at 1h, 1.58 at 3h, 4.58 at 24h
    return u <= Math.log2(3) ? m1 + (m3 - m1) * (u / Math.log2(3)) : m3 + (p - m3) * ((u - Math.log2(3)) / (Math.log2(24) - Math.log2(3)));
  };
  for (const hours of [1, 3, 24]) {
    const show = (f) => { const m = new Map(); for (const s of valid.filter(s => s.hours === hours)) { const b = Math.min(100, Math.round(f(s) * 10) * 10); const c = m.get(b) || { n: 0, w: 0 }; c.n++; c.w += s.wet; m.set(b, c); }
      return [...m.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.n >= 15).map(([b, c]) => `${b}→${Math.round(100 * c.w / c.n)}(${c.n})`).join(' '); };
    console.log(`\n${hours}h, validation`);
    console.log('  before:', show(cur));
    console.log('  after: ', show(s => apply(cur(s), hours)));
  }
} else if (mode === 'fit') {
  const fit = JSON.parse(readFileSync(a1, 'utf8')), valid = JSON.parse(readFileSync(a2, 'utf8'));
  const logit = (p) => Math.log(p / (1 - p)), sig = (z) => 1 / (1 + Math.exp(-z));
  // The candidate: today's calibration in logit space, then the window term:
  //   positive departures (wetter than the climate) sharpened less for short windows: × exp(−kA·w),
  //   and the whole shifted by kB·w, where w = log2(24 / hours) (0 for a day, 3 for three hours, 4.6 for an hour).
  const model = (s, kA, kB) => {
    const base = calibrateChance(s.raw, s.climate, s.lead, 24);
    const w = Math.log2(24 / s.hours);
    const c = Math.min(0.98, Math.max(0.02, s.climate));
    const dep = logit(Math.max(1e-4, Math.min(1 - 1e-4, base))) - logit(c);
    const z = logit(c) + dep * (dep > 0 ? Math.exp(-kA * w) : 1) + kB * w;
    return Math.min(0.995, Math.max(0.005, sig(z)));
  };
  const loss = (data, kA, kB) => data.reduce((a, s) => { const p = model(s, kA, kB); return a - (s.wet ? Math.log(p) : Math.log(1 - p)); }, 0) / data.length;
  let best = { kA: 0, kB: 0, l: loss(fit, 0, 0) };
  for (let kA = 0; kA <= 0.6; kA += 0.02) for (let kB = -0.6; kB <= 0.2; kB += 0.02) {
    const l = loss(fit, kA, kB);
    if (l < best.l) best = { kA: +kA.toFixed(2), kB: +kB.toFixed(2), l };
  }
  console.log('fit:', best, 'before', loss(fit, 0, 0).toFixed(4), '| validation before', loss(valid, 0, 0).toFixed(4), 'after', loss(valid, best.kA, best.kB).toFixed(4));
  const rel = (data, kA, kB, hours, lead) => {
    const m = new Map();
    for (const s of data.filter(s => s.hours === hours && (lead == null || Math.abs(s.lead - hours / 2 - lead) < 1))) {
      const b = Math.min(100, Math.round(model(s, kA, kB) * 10) * 10);
      const c = m.get(b) || { n: 0, w: 0 }; c.n++; c.w += s.wet; m.set(b, c);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.n >= 15).map(([b, c]) => `${b}→${Math.round(100 * c.w / c.n)}(${c.n})`).join(' ');
  };
  for (const hours of WINDOWS) {
    console.log(`\n${hours}h window, validation`);
    console.log('  before:', rel(valid, 0, 0, hours));
    console.log('  after: ', rel(valid, best.kA, best.kB, hours));
  }
}
