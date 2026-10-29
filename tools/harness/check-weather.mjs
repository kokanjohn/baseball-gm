// §100 Weather model checks (maps now; the weather itself as it's built).
//   node tools/harness/check-weather.mjs
import { regionMap, isWater, REGION_KEYS } from '../../engine/WeatherMap.js';
import { hashString } from '../../engine/WeatherNoise.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

console.log('Maps');
for (const r of REGION_KEYS) {
  const t0 = performance.now();
  const m = regionMap(r);
  const ms = performance.now() - t0;
  const parks = Object.entries(m.parks);
  const wet = parks.filter(([, p]) => isWater(m, p.x, p.y)).map(([id]) => id);
  check(`${r}: every ballpark is on land`, wet.length === 0, wet.join(','));
  check(`${r}: 10 ballparks, ours at the centre`, parks.length === 10 && m.parks.user.x === 0 && m.parks.user.y === 0);
  // Every park reachable by highway from ours.
  const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const adj = new Map();
  for (const road of m.roads) {
    const a = key(road[0]), b = key(road[road.length - 1]);
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  const seen = new Set(['0,0']), queue = ['0,0'];
  while (queue.length) for (const n of adj.get(queue.shift()) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const cut = parks.filter(([, p]) => !seen.has(key([p.x, p.y]))).map(([id]) => id);
  check(`${r}: every ballpark is on the highway network`, cut.length === 0, cut.join(','));
  const names = m.towns.map(t => t.name);
  check(`${r}: ${m.towns.length} towns, names unique and on land`,
        new Set(names).size === names.length && !m.towns.some(t => isWater(m, t.x, t.y))
        && !names.some(n => parks.some(([, p]) => p.city === n)));
  const sig = (mm) => hashString(JSON.stringify([mm.features.map(f => f.pts), mm.roads, mm.towns, mm.urban.map(u => u.pts), mm.local]));
  // A second, separate copy of the module builds the map from scratch.
  const fresh = (await import(`../../engine/WeatherMap.js?fresh=${r}`)).regionMap(r);
  check(`${r}: the map is identical every time it's built (${ms.toFixed(0)} ms)`, fresh !== m && sig(m) === sig(fresh) && ms < 1500);
}

// ── 1b: climate ─────────────────────────────────────────────────────────────
console.log('\nClimate');
const W = await import('../../engine/WeatherClimate.js');
const { REGION_CLIMATE } = await import('../../data/region-climate.js');
const { airAt, steeringAt, stormPotential, calendarDay, normalsOnDay, localHour, localDayStart, MS_DAY, MS_HOUR } = W;
const TZ = -240;
const START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
const ctxFor = (region, seed, cal) => ({ seed, region, tzMin: TZ, map: regionMap(region),
  cal: cal || [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] });
const SEEDS = ['wx-a', 'wx-b', 'wx-c'];
const dayOf = (iso) => (Date.UTC(...iso.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(+iso.slice(0, 4), 0, 1)) / MS_DAY;

{
  const c = ctxFor('north', 'wx-a');
  const t = START + 40.3 * MS_DAY;
  const W2 = await import('../../engine/WeatherClimate.js?fresh=1');
  const c2 = { ...c, map: (await import('../../engine/WeatherMap.js?fresh=climate')).regionMap('north') };
  check('the same place and moment always gives the same air', JSON.stringify(airAt(c, 12, -40, t)) === JSON.stringify(W2.airAt(c2, 12, -40, t)));
  const d = calendarDay(c.cal, START + 10 * MS_DAY + 13 * MS_HOUR);
  check(`real days map one-for-one onto the baseball calendar (day ${d.doy.toFixed(2)})`, Math.abs(d.doy - (dayOf('2027-03-14') + 10 + 13 / 24)) < 1e-6);
}

for (const region of ['north', 'south', 'east', 'west']) {
  const months = REGION_CLIMATE[region].months;
  const offHi = [], offLo = [];
  let hotHours = new Array(24).fill(0), east = 0, n = 0, heading = 0;
  for (const seed of SEEDS) {
    const c = ctxFor(region, seed);
    // Each mid-month window: Apr..Sep (the heart of the season).
    for (let mi = 1; mi <= 6; mi++) {
      const midDoy = [74, 105, 135, 166, 196, 227, 258][mi];
      let hi = 0, lo = 0;
      for (let d = -12; d < 13; d++) {
        const day = START + (midDoy - dayOf('2027-03-14') + d) * MS_DAY;
        let dayHi = -999, dayLo = 999;
        for (let h = 0; h < 24; h++) {
          const v = airAt(c, 0, 0, day + h * MS_HOUR).tempF;
          if (v > dayHi) dayHi = v;
          if (v < dayLo) dayLo = v;
          if (mi === 3 && d === 0) hotHours[h] += v;
        }
        hi += dayHi; lo += dayLo;
        const st = steeringAt(c, day + 12 * MS_HOUR);
        n++; if (st.u > 0) east++; if (st.headingDeg > 30 && st.headingDeg < 150) heading++;
      }
      offHi.push(hi / 25 - months[mi].hi); offLo.push(lo / 25 - months[mi].lo);
    }
  }
  const worst = (a) => a.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0);
  check(`${region}: monthly highs match the normals (worst month ${worst(offHi) >= 0 ? '+' : ''}${worst(offHi).toFixed(1)} °F)`, Math.abs(worst(offHi)) <= 5);
  check(`${region}: monthly lows match the normals (worst month ${worst(offLo) >= 0 ? '+' : ''}${worst(offLo).toFixed(1)} °F)`, Math.abs(worst(offLo)) <= 5.5);
  const peak = hotHours.indexOf(Math.max(...hotHours)), low = hotHours.indexOf(Math.min(...hotHours));
  check(`${region}: warmest mid-afternoon, coolest near dawn (${peak}:00 / ${low}:00)`, peak >= 13 && peak <= 17 && low >= 4 && low <= 7);
  check(`${region}: weather moves west to east (${(100 * east / n).toFixed(0)}% eastward, ${(100 * heading / n).toFixed(0)}% within 60° of due east)`, east / n >= 0.97 && heading / n >= 0.9);
}

{
  // Geography: colder to the north, colder on high ground.
  const c = ctxFor('north', 'wx-a'), cw = ctxFor('west', 'wx-a');
  let dN = 0, dR = 0;
  for (let d = 0; d < 60; d++) {
    const t = START + (40 + d) * MS_DAY + 15 * MS_HOUR;
    dN += airAt(c, 0, -150, t).tempF - airAt(c, 0, 150, t).tempF;
    dR += airAt(cw, -150, -80, t).tempF - airAt(cw, -320, -80, t).tempF;   // plains vs Sawtooth Range
  }
  check(`north: 300 km south is warmer (${(dN / 60).toFixed(1)} °F)`, dN / 60 > 3 && dN / 60 < 8);
  check(`west: the Sawtooth Range is colder than the plains (${(dR / 60).toFixed(1)} °F)`, dR / 60 > 6);
}

{
  // Storm potential: afternoons, and by region in midsummer.
  const avg = (region, hour) => {
    let s = 0, k = 0;
    for (const seed of SEEDS) {
      const c = ctxFor(region, seed);
      for (let d = 0; d < 20; d++) { s += stormPotential(c, 0, 0, START + (120 + d) * MS_DAY + hour * MS_HOUR); k++; }
    }
    return s / k;
  };
  const r = Object.fromEntries(['north', 'south', 'east', 'west'].map(g => [g, avg(g, 17)]));
  const morning = avg('south', 8);
  check(`storms brew in the afternoon (south July 5 PM ${r.south.toFixed(2)} vs 8 AM ${morning.toFixed(2)})`, r.south > 4 * morning);
  check(`midsummer storm potential follows each climate (S ${r.south.toFixed(2)} > N ${r.north.toFixed(2)}, E ${r.east.toFixed(2)} > W plains ${r.west.toFixed(2)})`,
        r.south > r.north && r.south > r.east && r.west < r.south);
}

{
  // The calendar through an offseason: no jumps, then the next spring.
  const s1 = START, end = START + 200 * MS_DAY, spring = end + 7 * MS_DAY;
  const cal = [
    { kind: 'season', season: 1, realStartMs: s1, dispIso: '2027-03-14' },
    { kind: 'offseason', season: 1, fromMs: end, toMs: spring, nextDispIso: '2028-03-14' },
    { kind: 'season', season: 2, realStartMs: spring, dispIso: '2028-03-14' },
  ];
  for (const region of ['north', 'south']) {
    const c = ctxFor(region, 'wx-b', cal);
    let worst = 0;
    for (let t = end - 2 * MS_DAY; t < spring + 2 * MS_DAY; t += 15 * 60_000) {
      const a = airAt(c, 0, 0, t).tempF, b = airAt(c, 0, 0, t + 15 * 60_000).tempF;
      worst = Math.max(worst, Math.abs(b - a));
    }
    check(`${region}: no temperature jumps through the offseason (largest 15-minute change ${worst.toFixed(2)} °F)`, worst < 2.5);
  }
  const mid = calendarDay(cal, end + 3.5 * MS_DAY);
  check('the offseason blends toward next spring', mid.blendDoy === dayOf('2028-03-14') && Math.abs(mid.w - 0.5) < 1e-9);
  check('next spring starts on its own day', Math.abs(calendarDay(cal, spring + 6 * MS_HOUR).doy - (dayOf('2028-03-14') + 0.25)) < 1e-9);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
