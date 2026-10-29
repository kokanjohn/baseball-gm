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

// ── 1c: what happens — the systems and the precipitation field ──────────────
console.log('\nWeather systems');
const WS = await import('../../engine/WeatherSystems.js');
const { precipAt, radarField, precipTemp, PRECIP_SNOW, PRECIP_RAIN, DBZ_MIN } = WS;
const BOX = { x0: -360, y0: -360, x1: 360, y1: 360 };
{
  const c = ctxFor('south', 'wx-a');
  const WS2 = await import('../../engine/WeatherSystems.js?fresh=1');
  const c2 = { ...c, map: (await import('../../engine/WeatherMap.js?fresh=sys')).regionMap('south') };
  let same = true;
  for (let i = 0; i < 300; i++) {
    const t = START + (100 + i * 0.37) * MS_DAY, x = ((i * 97) % 600) - 300, y = ((i * 53) % 600) - 300;
    if (JSON.stringify(precipAt(c, x, y, t)) !== JSON.stringify(WS2.precipAt(c2, x, y, t))) { same = false; break; }
  }
  check('the same place and moment always gets the same precipitation', same);
}
{
  // The radar is exactly what each place reports — amount and rain / mix / snow.
  let cells = 0, wetCells = 0, bad = [];
  for (const [region, day, hour] of [['north', 14, 6], ['north', 101, 21], ['south', 116, 17], ['east', 30, 12], ['west', 150, 16]]) {
    const c = ctxFor(region, 'wx-a');
    const t = START + day * MS_DAY + hour * MS_HOUR;
    const f = radarField(c, t, BOX, 4);
    for (let k = 0; k < 400; k++) {
      const i = (k * 7919) % (f.nx * f.ny);
      const x = f.x0 + ((i % f.nx) + 0.5) * f.cellKm, y = f.y1 - (Math.floor(i / f.nx) + 0.5) * f.cellKm;
      const p = precipAt(c, x, y, t);
      cells++;
      const wet = p.dbz > DBZ_MIN;
      if (wet) wetCells++;
      if (wet !== (f.dbz[i] > DBZ_MIN) || (wet && (Math.abs(p.dbz - f.dbz[i]) > 1e-3 || p.kind !== f.kind[i]))) bad.push(`${region} ${x},${y}`);
    }
  }
  check(`the radar shows exactly what each place reports (${cells} cells, ${wetCells} wet)`, bad.length === 0 && wetCells > 50, bad.slice(0, 3).join(' | '));
}
{
  // Rain moves west to east: the rain's centre of mass an hour later.
  const shifts = [];
  for (const region of ['north', 'east']) {
    const c = ctxFor(region, 'wx-b');
    for (let d = 5; d < 180; d += 3) {
      const t = START + d * MS_DAY + 10 * MS_HOUR;
      const com = (tt) => {
        const f = radarField(c, tt, { x0: -500, y0: -400, x1: 500, y1: 400 }, 10);
        let sx = 0, sw = 0;
        for (let i = 0; i < f.nx * f.ny; i++) if (f.dbz[i] > 20) { const w = f.dbz[i] - 20; sx += w * (f.x0 + ((i % f.nx) + 0.5) * f.cellKm); sw += w; }
        return sw > 200 ? sx / sw : null;
      };
      const a = com(t), b = com(t + MS_HOUR);
      if (a != null && b != null) shifts.push(b - a);
    }
  }
  const east = shifts.filter(v => v > 0).length / shifts.length;
  const med = [...shifts].sort((x, y) => x - y)[Math.floor(shifts.length / 2)];
  check(`rain moves west to east (${(100 * east).toFixed(0)}% of hours; median ${med.toFixed(0)} km/h east, ${shifts.length} hours)`, east >= 0.8 && med > 10 && med < 90);
}
{
  // Afternoon storms: a Gulf Coast summer, 5 PM against 8 AM.
  const c = ctxFor('south', 'wx-a');
  const cover = (hour) => {
    let n = 0, all = 0;
    for (let d = 110; d < 140; d++) {
      const f = radarField(c, START + d * MS_DAY + hour * MS_HOUR, BOX, 12);
      for (let i = 0; i < f.nx * f.ny; i++) { all++; if (f.dbz[i] >= 40) n++; }
    }
    return n / all;
  };
  const pm = cover(17), am = cover(8);
  check(`summer heavy rain peaks in the afternoon (south, ${(100 * pm).toFixed(1)}% of the map at 5 PM vs ${(100 * am).toFixed(1)}% at 8 AM)`, pm > 1.5 * am && pm > 0.005);
  const pops = (hour) => {
    let n = 0;
    for (let d = 110; d < 140; d++) n += WS.activeSystems(c, START + d * MS_DAY + hour * MS_HOUR, BOX).filter(a => a.s.kind === 'cell').length;
    return n / 30;
  };
  const p17 = pops(17), p8 = pops(8), p3 = pops(3);
  check(`pop-up thunderstorms are an afternoon thing (${p17.toFixed(1)} at 5 PM, ${p8.toFixed(1)} at 8 AM, ${p3.toFixed(1)} at 3 AM)`, p17 > 5 * Math.max(0.5, p8) && p17 > 5 * Math.max(0.5, p3));
}
{
  // Snow only where it's cold: early spring in the North can snow; a southern summer never does.
  let northSnow = 0, southSnow = 0, warmSnow = 0;
  for (let d = 0; d < 40; d += 1) {
    const cn = ctxFor('north', 'wx-a'), cs = ctxFor('south', 'wx-a');
    for (const [c, isN] of [[cn, true], [cs, false]]) {
      const t = START + (isN ? d : 110 + d) * MS_DAY + 6 * MS_HOUR;
      const f = radarField(c, t, BOX, 16);
      for (let i = 0; i < f.nx * f.ny; i++) {
        if (!(f.dbz[i] > DBZ_MIN) || f.kind[i] !== PRECIP_SNOW) continue;
        if (isN) northSnow++; else southSnow++;
        const x = f.x0 + ((i % f.nx) + 0.5) * f.cellKm, y = f.y1 - (Math.floor(i / f.nx) + 0.5) * f.cellKm;
        if (precipTemp(c, x, y, t) > 36) warmSnow++;   // heavy precipitation can drag the air ~3 °F colder
      }
    }
  }
  check(`snow only where it's cold (north early spring ${northSnow} snow cells; south summer ${southSnow}; above 36 °F ${warmSnow})`, northSnow > 0 && southSnow === 0 && warmSnow === 0);
}
{
  // Wet days at our park against each climate (Apr–Sep), and the West driest.
  const wetDays = {};
  for (const region of ['north', 'south', 'east', 'west']) {
    let wet = 0, n = 0, target = 0, k = 0;
    const c = ctxFor(region, 'wx-c');
    for (let d = 20; d < 200; d += 2) {
      let acc = 0;
      for (let q = 0; q < 48; q++) acc += precipAt(c, 0, 0, START + d * MS_DAY + q * 30 * 60_000).rateMmH * 0.5;
      n++; if (acc >= 0.25) wet++;
      target += W.normalsAt(c, START + d * MS_DAY).wet; k++;
    }
    wetDays[region] = wet / n;
    check(`${region}: rain on about as many days as its climate (${(100 * wet / n).toFixed(0)}% vs ${(100 * target / k).toFixed(0)}%)`, Math.abs(wet / n - target / k) <= 0.12);
  }
  check('the West is the driest region', wetDays.west < Math.min(wetDays.north, wetDays.south, wetDays.east));
}
{
  // Real weather surprises: some systems fall apart early, some form right over the region.
  const c = ctxFor('east', 'wx-a');
  const seen = new Map();
  for (let d = 0; d < 200; d += 0.25) for (const a of WS.activeSystems(c, START + d * MS_DAY, BOX)) if (a.s.kind !== 'cell') seen.set(a.s.id, a.s);
  const sys = [...seen.values()];
  const broke = sys.filter(x => x.breakAt != null).length, local = sys.filter(x => x.x0 > -300 && x.x0 < 300 && Math.abs(x.y0) < 300).length;
  check(`some systems break up early and some form over the region (${sys.length} systems: ${broke} break up, ${local} form overhead)`,
        broke / sys.length > 0.08 && broke / sys.length < 0.3 && local > 5);
}
{
  // Speed: a full region frame at radar resolution.
  const c = ctxFor('south', 'wx-a');
  const t0 = performance.now();
  for (let k = 0; k < 6; k++) radarField(c, START + (116 + k * 0.5) * MS_DAY + 17 * MS_HOUR, BOX, 4);
  const ms = (performance.now() - t0) / 6;
  check(`a region radar frame builds in ${ms.toFixed(0)} ms`, ms < 600);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
