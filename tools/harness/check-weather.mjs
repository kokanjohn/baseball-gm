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

// ── 1d: the ballpark report ─────────────────────────────────────────────────
console.log('\nBallpark conditions');
const WC = await import('../../engine/WeatherConditions.js');
const { conditionsAt, parkConditions, rainTotal, daylight, windAtPark } = WC;
{
  // Every report agrees with the radar: wet ⇔ precipitation, and the kind.
  let n = 0, wet = 0, bad = [], snowWarm = 0, rainCold = 0, labelBad = [], storms = 0, stormBad = 0;
  for (const region of ['north', 'south', 'east', 'west']) {
    const c = ctxFor(region, 'wx-a');
    for (let d = 0; d < 200; d += 1.37) {
      const t = START + d * MS_DAY;
      for (const id of Object.keys(c.map.parks).slice(0, 4)) {
        const pk = c.map.parks[id];
        const r = parkConditions(c, id, t), p = precipAt(c, pk.x, pk.y, t);
        n++;
        const isWet = p.dbz > DBZ_MIN;
        if (isWet) wet++;
        const kind = isWet ? ['rain', 'mix', 'snow'][p.kind] : null;
        if (r.precip.kind !== kind) bad.push(`${region} ${id} d${d.toFixed(1)}`);
        if (r.precip.kind === 'snow' && r.tempF > 33) snowWarm++;
        if (r.precip.kind === 'rain' && r.tempF < 33.4) rainCold++;
        const precipWord = /Rain|Drizzle|Snow|Sleet|Thunderstorm/.test(r.label);
        if (precipWord !== isWet && !(r.label === 'Storms Nearby' && !isWet)) labelBad.push(`${r.label} wet=${isWet}`);
        if (/Thunderstorm/.test(r.label)) { storms++; if (!(r.lightning || r.precip.convective)) stormBad++; }
        if (isWet && r.cloud < 0.85) labelBad.push(`raining under ${r.cloud} cloud`);
      }
    }
  }
  check(`every ballpark report agrees with the radar (${n} reports, ${wet} wet)`, bad.length === 0 && wet > 50, bad.slice(0, 3).join(' | '));
  check(`snow is never reported warm, rain never below freezing (${snowWarm}, ${rainCold})`, snowWarm === 0 && rainCold === 0);
  check(`the label says rain exactly when it's raining, under a full sky; thunderstorms only with lightning (${storms} thunderstorm reports)`,
        labelBad.length === 0 && stormBad === 0, labelBad.slice(0, 3).join(' | '));
}
{
  // Temperatures move smoothly — even a front or a storm's outflow takes some minutes.
  let worst = 0, at = '';
  for (const region of ['north', 'south']) {
    const c = ctxFor(region, 'wx-b');
    for (let d = 30; d < 70; d += 3) {
      let prev = null;
      for (let m = 0; m < 24 * 60; m += 5) {
        const v = conditionsAt(c, 0, 0, START + d * MS_DAY + m * 60_000).tempF;
        if (prev != null && Math.abs(v - prev) > worst) { worst = Math.abs(v - prev); at = `${region} d${d} ${(m / 60).toFixed(1)}h`; }
        prev = v;
      }
    }
  }
  // (A thunderstorm's gust front can knock 10 °F off in minutes; nothing faster than that.)
  check(`ballpark temperatures move smoothly (largest 5-minute change ${worst.toFixed(1)} °F, ${at})`, worst <= 8);
}
{
  // Clouds and fronts don't move the averages: monthly highs still match normals; skies vary.
  for (const region of ['north', 'south', 'east', 'west']) {
    const months = REGION_CLIMATE[region].months;
    let worstOff = 0;
    const skies = {};
    for (const mi of [1, 3, 5]) {
      const midDoy = [74, 105, 135, 166, 196, 227, 258][mi];
      let hi = 0, k = 0;
      for (const seed of ['wx-a', 'wx-c']) {
        const c = ctxFor(region, seed);
        for (let d = -12; d < 13; d += 2) {
          const day = START + (midDoy - dayOf('2027-03-14') + d) * MS_DAY;
          let dayHi = -999;
          for (const h of [13, 14, 15, 16, 17]) dayHi = Math.max(dayHi, conditionsAt(c, 0, 0, day + h * MS_HOUR).tempF);
          hi += dayHi; k++;
          const r = conditionsAt(c, 0, 0, day + 15 * MS_HOUR);
          if (!r.precip.kind) skies[r.sky] = (skies[r.sky] || 0) + 1;
        }
      }
      const off = hi / k - months[mi].hi;
      if (Math.abs(off) > Math.abs(worstOff)) worstOff = off;
    }
    const total = Object.values(skies).reduce((a, b) => a + b, 0);
    const clearish = ((skies.Clear || 0) + (skies['Mostly Clear'] || 0)) / total, cloudy = (skies.Cloudy || 0) / total;
    check(`${region}: afternoon highs still match the normals (worst ${worstOff >= 0 ? '+' : ''}${worstOff.toFixed(1)} °F)`, Math.abs(worstOff) <= 6);
    check(`${region}: dry afternoons run the range of skies (${Object.entries(skies).map(([k, v]) => `${k} ${v}`).join(', ')})`,
          Object.keys(skies).length >= 4 && clearish > (region === 'south' ? 0.1 : 0.2) && clearish < 0.85 && cloudy < 0.35);
  }
}
{
  // Wind: mostly from the south round to the north-west; north-west and cooler once a front has passed.
  const c = ctxFor('north', 'wx-a');
  let n = 0, sw = 0, mph = 0, normal = 0, behindNW = 0, behindN = 0, coolings = [];
  for (let d = 10; d < 190; d += 0.5) {
    const t = START + d * MS_DAY;
    const s0 = WS.surfaceTemp(c, 0, 0, t);
    const r = conditionsAt(c, 0, 0, t);
    n++; mph += r.wind.mph; normal += W.normalsAt(c, t).wind;
    if (r.wind.fromDeg >= 160 && r.wind.fromDeg <= 340) sw++;
    if (s0.front.behind > 0.6) { behindN++; if (r.wind.fromDeg >= 270 && r.wind.fromDeg <= 360) behindNW++; }
  }
  // Each front passage: the same hour a day later against a day before.
  for (let d = 10; d < 190; d += 0.25) {
    const t = START + d * MS_DAY;
    const a = WS.frontAir(c, 0, 0, t), b = WS.frontAir(c, 0, 0, t + 3 * MS_HOUR);
    if (a.behind < 0.2 && b.behind > 0.6) coolings.push(conditionsAt(c, 0, 0, t + 18 * MS_HOUR).tempF - conditionsAt(c, 0, 0, t - 6 * MS_HOUR).tempF);
  }
  const avgCool = coolings.reduce((x, y) => x + y, 0) / Math.max(1, coolings.length);
  check(`wind mostly from the south round to the north-west (${(100 * sw / n).toFixed(0)}%), about normal strength (${(mph / n).toFixed(1)} vs ${(normal / n).toFixed(1)} mph)`,
        sw / n >= 0.7 && mph / n > 0.6 * normal / n && mph / n < 1.5 * normal / n);
  check(`behind a cold front the wind comes from the north-west (${behindNW}/${behindN})`, behindN > 10 && behindNW / behindN >= 0.7);
  check(`a front's passage cools things off (${coolings.length} passages, ${avgCool.toFixed(1)} °F a day later)`, coolings.length >= 5 && avgCool < -3);
}
{
  // Wind at the park: straight out to centre, in from centre, across.
  const out = windAtPark({ mph: 12, fromDeg: 225 }, 45), inn = windAtPark({ mph: 12, fromDeg: 45 }, 45);
  const lr = windAtPark({ mph: 12, fromDeg: 315 }, 45), outL = windAtPark({ mph: 12, fromDeg: 180 }, 45);
  check(`wind reads right at the park (${out.text}, ${inn.text}, ${lr.text}, ${outL.text})`,
        out.text === 'out to center' && out.outMph > 11 && inn.text === 'in from center' && inn.outMph < -11 && lr.text === 'left to right' && outL.text === 'out to left');
  const dl = daylight(ctxFor('north', 'wx-a'), START + 100 * MS_DAY);
  check(`sunrise and sunset in June (${dl.sunrise.toFixed(2)} / ${dl.sunset.toFixed(2)})`, dl.sunrise > 5 && dl.sunrise < 6.2 && dl.sunset > 20 && dl.sunset < 21);
}
{
  // Rain totals add up, and it rains more where the climate is wetter.
  const c = ctxFor('south', 'wx-a');
  const t0 = START + 100 * MS_DAY;
  const day = rainTotal(c, 0, 0, t0, t0 + MS_DAY), halves = rainTotal(c, 0, 0, t0, t0 + MS_DAY / 2) + rainTotal(c, 0, 0, t0 + MS_DAY / 2, t0 + MS_DAY);
  check(`rain totals add up (${day}" for the day; ${halves.toFixed(2)}" in two halves)`, Math.abs(day - halves) <= 0.02);
  const ms0 = performance.now();
  for (let k = 0; k < 20; k++) parkConditions(ctxFor('east', 'wx-c'), 'HBR', START + (40 + k * 1.7) * MS_DAY);
  const per = (performance.now() - ms0) / 20;
  check(`a ballpark report takes ${per.toFixed(1)} ms`, per < 40);
}

// ── 1e: forecast runs ───────────────────────────────────────────────────────
console.log('\nForecasts');
const { forecastContext } = WS;
const csi = (a, b, thr) => {
  let h = 0, m = 0, f = 0;
  for (let i = 0; i < a.dbz.length; i++) { const x = a.dbz[i] >= thr, y = b.dbz[i] >= thr; if (x && y) h++; else if (x) m++; else if (y) f++; }
  return { csi: h / Math.max(1, h + m + f), obs: h + m, fc: h + f };
};
{
  // At lead 0 a run is exactly what happens.
  let diff = 0, cdiff = 0;
  for (const [region, d] of [['east', 20.5], ['north', 101.9], ['south', 115.7]]) {
    const c = ctxFor(region, 'wx-a');
    const t = Math.floor((START + d * MS_DAY) / MS_HOUR) * MS_HOUR;
    const f = forecastContext(c, t);
    const a = radarField(c, t, BOX, 8), b = radarField(f, t, BOX, 8);
    for (let i = 0; i < a.dbz.length; i++) if (a.dbz[i] !== b.dbz[i] || a.kind[i] !== b.kind[i]) diff++;
    for (const id of Object.keys(c.map.parks)) if (JSON.stringify(parkConditions(c, id, t)) !== JSON.stringify(parkConditions(f, id, t))) cdiff++;
  }
  check(`a forecast at lead 0 is exactly what happens (${diff} radar cells, ${cdiff} ballpark reports differ)`, diff === 0 && cdiff === 0);
  const WS2 = await import('../../engine/WeatherSystems.js?fresh=fc');
  const c = ctxFor('south', 'wx-a'), t = START + 117.3 * MS_DAY;
  const a = radarField(forecastContext(c, t - 50 * MS_HOUR), t, BOX, 12), b = WS2.radarField(WS2.forecastContext(c, t - 50 * MS_HOUR), t, BOX, 12);
  check('the same run always gives the same forecast', a.dbz.every((v, i) => v === b.dbz[i] || (isNaN(v) && isNaN(b.dbz[i]))));
}
{
  // Skill falls with lead; long-range forecasts are no wetter or drier than what happens.
  const leads = [1, 6, 24, 72, 168];
  const tot = Object.fromEntries(leads.map(L => [L, { h: 0, n: 0, obs: 0, fc: 0 }]));
  for (const region of ['north', 'east', 'south']) {
    const c = ctxFor(region, 'wx-b');
    for (let d = 8; d < 190; d += 4.3) {
      const t = START + d * MS_DAY;
      const truth = radarField(c, t, BOX, 16);
      for (const L of leads) {
        const r = csi(truth, radarField(forecastContext(c, t - L * MS_HOUR), t, BOX, 16), 20);
        tot[L].h += r.csi * (r.obs + r.fc); tot[L].n += r.obs + r.fc; tot[L].obs += r.obs; tot[L].fc += r.fc;
      }
    }
  }
  const sk = leads.map(L => tot[L].h / Math.max(1, tot[L].n));
  check(`rain-forecast skill falls with lead (CSI ${leads.map((L, i) => `${L}h ${sk[i].toFixed(2)}`).join(', ')})`,
        sk.every((v, i) => i === 0 || v < sk[i - 1]) && sk[0] > 0.5 && sk[4] < 0.25);
  const bias = leads.map(L => tot[L].fc / Math.max(1, tot[L].obs));
  check(`forecasts are no wetter or drier than what happens (rain area vs actual: ${leads.map((L, i) => `${L}h ×${bias[i].toFixed(2)}`).join(', ')})`,
        bias.every(b => b > 0.6 && b < 1.6));
}
{
  // Temperatures: about 2 °F off tomorrow, more a week out — like real forecasts.
  const c = ctxFor('east', 'wx-c');
  const mae = {};
  for (const L of [6, 24, 72, 168]) {
    let e = 0, n = 0;
    for (let d = 10; d < 190; d += 2.3) { const t = START + d * MS_DAY + 15 * MS_HOUR; e += Math.abs(conditionsAt(c, 0, 0, t).tempF - conditionsAt(forecastContext(c, t - L * MS_HOUR), 0, 0, t).tempF); n++; }
    mae[L] = e / n;
  }
  check(`temperature forecasts: off by ${Object.entries(mae).map(([L, v]) => `${v.toFixed(1)}° at ${L}h`).join(', ')}`,
        mae[6] < mae[24] && mae[24] < mae[72] && mae[72] < mae[168] && mae[24] >= 1 && mae[24] <= 3.2 && mae[72] <= 5.5 && mae[168] >= 3.5 && mae[168] <= 8);
}
{
  // Runs firm up: one hourly run to the next changes a forecast only a little.
  const c = ctxFor('north', 'wx-a');
  let dT = 0, n = 0, agree = 0, cnt = 0;
  for (let d = 12; d < 180; d += 5.1) {
    const t = START + d * MS_DAY + 17 * MS_HOUR;
    for (const L of [48, 24]) {
      const f1 = forecastContext(c, t - L * MS_HOUR), f2 = forecastContext(c, t - (L - 1) * MS_HOUR);
      dT += Math.abs(conditionsAt(f1, 0, 0, t).tempF - conditionsAt(f2, 0, 0, t).tempF); n++;
      const r = csi(radarField(f1, t, BOX, 16), radarField(f2, t, BOX, 16), 20);
      if (r.obs + r.fc > 20) { agree += r.csi; cnt++; }
    }
  }
  check(`one hourly run to the next changes a forecast only a little (${(dT / n).toFixed(2)} °F; rain areas overlap ${(agree / cnt).toFixed(2)})`, dT / n < 0.8 && agree / cnt > 0.65);
}
{
  // A breakup is a surprise until a few hours before it happens.
  const c = ctxFor('south', 'wx-a');
  let checked = 0, early = 0, late = 0, formed = 0;
  for (let d = 60; d < 190 && checked < 12; d += 0.25) {
    for (const a of WS.activeSystems(c, START + d * MS_DAY, BOX)) {
      const s0 = a.s;
      if (s0.breakAt == null || s0.breakAt > s0.t1 - s0.decayMs - MS_HOUR || s0._seen) continue;
      s0._seen = true; checked++;
      const after = s0.breakAt + s0.breakDecayMs + 30 * 60_000;
      const aliveIn = (issueMs) => WS.activeSystems(forecastContext(c, issueMs), after, { x0: -3000, y0: -3000, x1: 3000, y1: 3000 }).some(x => x.s.id === s0.id);
      // (Only systems already formed 10 hours before their breakup can be in that run.)
      if (s0.breakAt - 10 * MS_HOUR > s0.t0) { formed++; if (aliveIn(s0.breakAt - 10 * MS_HOUR)) early++; }
      if (!aliveIn(s0.breakAt - 2 * MS_HOUR)) late++;
    }
  }
  check(`a breakup is a surprise until a few hours out (${checked} breakups: still forecast 10 h before ${early}/${formed} already formed, seen 2 h before ${late}/${checked})`,
        formed >= 5 && early === formed && late === checked);
}
{
  // Pop-up storms: about the right number a day out, but not where they'll actually go up.
  const c = ctxFor('south', 'wx-a');
  let near = 0, far = 0, obs = 0, fcn = 0, k = 0;
  for (let d = 110; d < 150; d += 1) {
    const t = START + d * MS_DAY + 17 * MS_HOUR;
    const truth = radarField(c, t, BOX, 8);
    const a = csi(truth, radarField(forecastContext(c, t - 0.25 * MS_HOUR), t, BOX, 8), 40);
    const b = csi(truth, radarField(forecastContext(c, t - 26 * MS_HOUR), t, BOX, 8), 40);
    if (a.obs > 5) { near += a.csi; far += b.csi; obs += b.obs; fcn += b.fc; k++; }
  }
  check(`pop-up storms: tracked minutes ahead (overlap ${(near / k).toFixed(2)}); a day ahead about the right amount (×${(fcn / obs).toFixed(2)}) but not the right spots (overlap ${(far / k).toFixed(2)})`,
        near / k > 0.5 && far / k < 0.25 && fcn / obs > 0.35 && fcn / obs < 2.5);
}
{
  // Phantoms: runs a few days out show systems that never happen; up close, hardly any.
  const c = ctxFor('east', 'wx-a');
  let farPh = 0, nearPh = 0;
  for (let d = 10; d < 190; d += 1.7) {
    const t = START + d * MS_DAY;
    farPh += WS.activeSystems(forecastContext(c, t - 120 * MS_HOUR), t, BOX).filter(a => a.s.phantom).length;
    nearPh += WS.activeSystems(forecastContext(c, t - 2 * MS_HOUR), t, BOX).filter(a => a.s.phantom).length;
  }
  check(`forecasts a few days out show systems that never happen; up close they're gone (${farPh} at 5 days, ${nearPh} at 2 hours)`, farPh > 20 && nearPh <= farPh * 0.05);
}

// ── 1f: chances and the 10-day forecast ─────────────────────────────────────
console.log('\nChances and the 10-day forecast');
const WF = await import('../../engine/WeatherForecast.js');
{
  // Calibration, on seeds the calibration wasn't fitted on: "40%" rains about 40% of the time.
  const leads = [12, 84, 228];
  const res = Object.fromEntries(leads.map(L => [L, []]));
  let radarBad = 0, radarN = 0;
  for (const region of ['north', 'south', 'east', 'west']) for (const seed of ['wx-g', 'wx-h']) {
    const c = ctxFor(region, seed);
    for (let d = 15; d < 195; d += 6) {
      const t0 = START + d * MS_DAY, t1 = t0 + MS_DAY;
      const obs = rainTotal(c, 0, 0, t0, t1, 10) >= 0.01 ? 1 : 0;
      for (const L of leads) {
        const ch = WF.chanceOfPrecip(c, t0 - L * MS_HOUR, 0, 0, t0, t1);
        res[L].push([ch.chance / 100, ch.climate / 100, obs]);
        if (L <= 24) { radarN++; if (ch.mainWet ? ch.chance < 30 : ch.chance > 80) radarBad++; }
      }
    }
  }
  const bss = (r) => 1 - r.reduce((a, [p, , o]) => a + (p - o) ** 2, 0) / r.reduce((a, [, c, o]) => a + (c - o) ** 2, 0);
  const pooled = [...res[12], ...res[84]];
  const bins = [[0, 0.15], [0.15, 0.35], [0.35, 0.55], [0.55, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const b = pooled.filter(x => x[0] >= lo && x[0] < hi);
    return { n: b.length, fc: b.reduce((a, x) => a + x[0], 0) / Math.max(1, b.length), obs: b.reduce((a, x) => a + x[2], 0) / Math.max(1, b.length) };
  });
  const worst = bins.filter(b => b.n >= 30).reduce((m, b) => Math.max(m, Math.abs(b.fc - b.obs)), 0);
  check(`chances verify: ${bins.filter(b => b.n).map(b => `${Math.round(100 * b.fc)}%→${Math.round(100 * b.obs)}% (${b.n})`).join(', ')} (days 1 and 4, held-out seeds)`, worst <= 0.12);
  const meanFc = pooled.reduce((a, x) => a + x[0], 0) / pooled.length, meanObs = pooled.reduce((a, x) => a + x[2], 0) / pooled.length;
  check(`no wet or dry lean (forecast ${(100 * meanFc).toFixed(0)}% vs ${(100 * meanObs).toFixed(0)}% of days wet)`, Math.abs(meanFc - meanObs) <= 0.06);
  const s1 = bss(res[12]), s4 = bss(res[84]), s10 = bss(res[228]);
  check(`chances beat the climate where they should (skill day 1 ${s1.toFixed(2)}, day 4 ${s4.toFixed(2)}, day 10 ${s10.toFixed(2)})`, s1 >= 0.4 && s4 > 0.1 && s10 > -0.05);
  check(`within a day the chance never contradicts the radar (${radarBad} of ${radarN})`, radarBad === 0);
}
{
  // The 10-day forecast: dates, words that match the numbers, highs near what happens.
  const c = ctxFor('east', 'wx-g');
  let datesOk = true, wordsBad = [], hiLo = 0, n = 0;
  const err = { 1: [], 7: [], 10: [], raw10: [] };
  for (let d = 20; d < 180; d += 9) {
    const now = START + d * MS_DAY + 8 * MS_HOUR;
    const f = WF.dailyForecast(c, now, 0, 0, 10);
    if (f.length !== 10) datesOk = false;
    f.forEach((e, i) => {
      if (i && e.dateIso && f[i - 1].dateIso && (Date.parse(e.dateIso) - Date.parse(f[i - 1].dateIso)) !== MS_DAY) datesOk = false;
      if (e.chance >= 60 && !/Thunderstorms|Rain|Snow|Storms/.test(e.label)) wordsBad.push(`${e.chance}% ${e.label}`);
      if (e.chance < 10 && /Rain|Storm|Snow|showers/.test(e.label + e.summary)) wordsBad.push(`${e.chance}% ${e.summary}`);
      if (e.chance >= 10 && !e.summary.includes('chance') && !e.summary.includes('Chance')) wordsBad.push(`${e.chance}% "${e.summary}"`);
      n++; if (e.hiF >= e.loF - 2) hiLo++;
    });
    // Highs against what happened.
    for (const k of [1, 7, 10]) {
      const e = f[k - 1], t0 = e.dayStartMs;
      const actual = Math.max(...[13, 14.5, 16, 17.5].map(h => conditionsAt(c, 0, 0, t0 + h * MS_HOUR).tempF));
      if (k > 1 || e.hiF != null) err[k].push(Math.abs(e.hiF - actual));
      if (k === 10) {
        const run = WS.forecastContext(c, now, 0);
        err.raw10.push(Math.abs(Math.max(...[13, 14.5, 16, 17.5].map(h => conditionsAt(run, 0, 0, t0 + h * MS_HOUR).tempF)) - actual));
      }
    }
  }
  const mae = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  check('the 10-day forecast runs ten days on the baseball calendar', datesOk);
  check(`its words match its chances (${wordsBad.length} mismatches)`, wordsBad.length === 0, wordsBad.slice(0, 3).join(' | '));
  check(`highs above tonight's lows (${hiLo}/${n})`, hiLo / n >= 0.95);
  check(`forecast highs: off by ${mae(err[1]).toFixed(1)}° today, ${mae(err[7]).toFixed(1)}° at day 7, ${mae(err[10]).toFixed(1)}° at day 10 (the run alone: ${mae(err.raw10).toFixed(1)}°)`,
        mae(err[1]) <= 3.5 && mae(err[7]) <= 7 && mae(err[10]) <= mae(err.raw10) + 0.3);
  const t0 = performance.now();
  WF.dailyForecast(c, START + 150.4 * MS_DAY, 0, 0, 10);
  const ms = performance.now() - t0;
  check(`a 10-day forecast takes ${ms.toFixed(0)} ms (computed once an hour)`, ms < 3000);
  const hr = WF.hourlyForecast(c, START + 150.4 * MS_DAY, 0, 0, 6);
  check(`an hourly forecast for a game window (${hr.map(h => `${h.tempF}° ${h.chance}%`).join(', ')})`, hr.length === 6 && hr.every((h, i) => !i || h.t - hr[i - 1].t === MS_HOUR));
}

// ── 2a: radar frames ────────────────────────────────────────────────────────
console.log('\nRadar frames');
const RF = await import('../../engine/RadarFrames.js');
{
  const now = START + 100 * MS_DAY + 14 * MS_HOUR + 37 * 60_000;   // 2:37 PM
  const past = RF.frameTimes(now, 'past2h'), n6 = RF.frameTimes(now, 'next6h'), n24 = RF.frameTimes(now, 'next24h');
  const steps = (a) => a.slice(1).map((f, i) => (f.t - a[i].t) / 60_000);
  check(`past 2 hrs: ${past.length} frames, 10 minutes apart, ending at the latest picture (${new Date(past.at(-1).t - 240 * 60_000).toISOString().slice(11, 16)} local)`,
        past.length === 13 && steps(past).every(s => s === 10) && past.every(f => !f.forecast) && past.at(-1).isNow && now - past.at(-1).t < 10 * 60_000);
  check(`next 6 hrs: now, then ${n6.length - 1} forecast frames 15 minutes apart from this hour's run`,
        n6.length === 25 && n6[0].isNow && !n6[0].forecast && n6.slice(1).every(f => f.forecast && f.issueMs === Math.floor(now / MS_HOUR) * MS_HOUR)
        && steps(n6.slice(1)).every(s => s === 15) && n6.at(-1).t <= now + 6 * MS_HOUR);
  check(`next 24 hrs: now, then ${n24.length - 1} hourly forecast frames`, n24.length === 25 && n24[0].isNow && steps(n24.slice(1)).every(s => s === 60));
}
{
  const c = ctxFor('north', 'wx-a');
  const v = RF.viewBox(c.map, 'NHV', 1, 390 / 500);
  const g = v.grid, pk = c.map.parks.NHV;
  check(`the view centres on the park and the grid covers it (${g.nx}×${g.ny} cells of ${g.cellKm} km)`,
        v.cx === pk.x && v.cy === pk.y && g.x0 <= pk.x - v.spanKm / 2 && g.x1 >= pk.x + v.spanKm / 2 && g.y0 <= pk.y - v.spanYKm / 2 && g.y1 >= pk.y + v.spanYKm / 2 && g.nx <= 220);
  // A packed frame is what the radar field says, to the nearest dBZ, kind for kind — truth and forecast.
  let bad = 0, wet = 0;
  for (const [day, hour, zoom] of [[14, 6, 0], [101, 23, 1], [102, 0, 2]]) {
    const t = START + day * MS_DAY + hour * MS_HOUR;
    const vb = RF.viewBox(c.map, 'user', zoom, 0.8).grid;
    for (const fr of [{ t, forecast: false }, { t: t + 3 * MS_HOUR, forecast: true, issueMs: Math.floor(t / MS_HOUR) * MS_HOUR }]) {
      const pf = RF.buildFrame(c, fr, vb);
      const ref = radarField(fr.forecast ? forecastContext(c, fr.issueMs) : c, fr.t, vb, vb.cellKm);
      for (let i = 0; i < pf.data.length; i++) {
        const d = RF.unpackDbz(pf.data[i]), r = ref.dbz[i];
        if (r > DBZ_MIN) wet++;
        if ((r > DBZ_MIN) !== (d > DBZ_MIN) || (d > DBZ_MIN && (Math.abs(d - Math.min(74.5, r)) > 0.51 + (r < 12.5 ? 0.5 : 0) || RF.unpackKind(pf.data[i]) !== ref.kind[i]))) bad++;
      }
    }
  }
  check(`packed frames match the radar field (${wet} wet cells, ${bad} off)`, bad === 0 && wet > 500);
  const ms = {};
  for (const z of [0, 1, 2]) {
    const vb = RF.viewBox(c.map, 'user', z, 0.8).grid;
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) RF.buildFrame(c, { t: START + (101 + k * 0.1) * MS_DAY + 22 * MS_HOUR, forecast: false }, vb);
    ms[z] = (performance.now() - t0) / 5;
  }
  check(`a frame builds in ${ms[0].toFixed(0)} / ${ms[1].toFixed(0)} / ${ms[2].toFixed(0)} ms (region / metro / ballpark)`, Math.max(ms[0], ms[1], ms[2]) < 400);
}


// ── 4a: each game's weather ─────────────────────────────────────────────────
console.log('\nGame weather');
{
  const GWm = await import('../../engine/GameWeather.js');
  const { GAME_WEATHER: GW } = await import('../../data/constants.js');
  const { venueSample, stormNear } = WS;
  // One look at the systems gives exactly what the separate reads do.
  {
    const c = ctxFor('south', 'wx-b');
    let off = 0;
    for (let i = 0; i < 400; i++) {
      const t = START + (60 + i * 0.29) * MS_DAY;
      const x = -150 + (i * 37) % 300, y = -150 + (i * 53) % 300;
      const cc = i % 3 ? c : forecastContext(c, t - (i % 7) * MS_HOUR);
      const v = venueSample(cc, x, y, t, 16), p = precipAt(cc, x, y, t), sn = stormNear(cc, x, y, t, 16);
      if (v.dbz !== p.dbz || v.kind !== p.kind || v.rateMmH !== p.rateMmH || v.stormDbz !== sn) off++;
    }
    check('a ballpark read in one look matches the radar and the storm check exactly', off === 0, `${off} off`);
  }
  const rates = {}, ms = [];
  let structBad = 0, reportBad = 0, resumeBad = 0, callBad = 0, fieldBad = 0, nForecastCalls = 0, checkedSteps = 0;
  const someGames = [];
  for (const region of REGION_KEYS) {
    const c = ctxFor(region, 'wx-a');
    const parks = Object.keys(c.map.parks);
    const r = rates[region] = { n: 0, ppd: 0, called: 0, delayed: 0 };
    for (let d = 0; d < 186; d += 2) for (let k = 0; k < 4; k++) {
      const home = parks[(d * 3 + k * 2) % parks.length], pk = c.map.parks[home];
      const g = { homeId: home, gameTime: START + d * MS_DAY + Math.round((d % 7 === 3 ? 13.08 : 19.08) * MS_HOUR) };
      const t0 = performance.now(); const p = GWm.gameWeatherPlan(c, g); ms.push(performance.now() - t0);
      if (someGames.length < 24 && (p.delays.length || p.outcome !== 'played' || d % 40 === 0)) someGames.push([region, g, p]);
      r.n++;
      if (p.outcome === 'postponed') r.ppd++;
      else { if (p.outcome === 'called') r.called++; if (p.delays.length) r.delayed++; }
      // The plan hangs together.
      let last = g.gameTime, lastMin = 0;
      for (const dl of p.delays) {
        if (dl.startT < last || dl.endT <= dl.startT || dl.atPlayMin < lastMin) structBad++;
        last = dl.endT; lastMin = dl.atPlayMin;
      }
      if (p.outcome === 'played' && (p.startAt < g.gameTime || p.endT !== GWm.playClock(p, GW.PLAN_MAX_MIN))) structBad++;
      if (p.outcome === 'called' && !(p.stopAtPlayMin < GW.PLAN_MAX_MIN && p.decidedAt === p.endT)) structBad++;
      if (p.outcome === 'postponed' && (p.startAt !== null || p.endT !== null || !(p.decidedAt > 0))) structBad++;
      // A postponement made off the forecast is one the GM's forecast showed coming.
      if (p.outcome === 'postponed' && p.calledBy === 'forecast' && p.decidedAt < g.gameTime) {
        nForecastCalls++;
        const i = GW.PREGAME_CALLS_MIN.indexOf((g.gameTime - p.decidedAt) / 60_000);
        if (WF.chanceOfPrecip(c, p.decidedAt, pk.x, pk.y, g.gameTime, g.gameTime + GW.PLAY_MIN * 60_000).chance < GW.PREGAME_CALL_CHANCE[i]) callBad++;
      }
      // A field call is for rain or snow that already fell.
      if (p.outcome === 'postponed' && p.calledBy === 'field') {
        const fell = rainTotal(c, pk.x, pk.y, g.gameTime - 12 * MS_HOUR, g.gameTime, 20);
        if (!(fell > 0.1)) fieldBad++;
      }
      // Play never resumes within 30 minutes of lightning.
      for (const dl of p.delays) {
        if (p.outcome === 'postponed' || (dl.endT === p.endT && p.outcome !== 'played')) continue;   // ended by the call, not a restart
        for (let t = dl.endT - GW.LIGHTNING_CLEAR_MIN * 60_000 + 5 * 60_000; t <= dl.endT; t += 5 * 60_000) {
          if (venueSample(c, pk.x, pk.y, t, 16).stormDbz >= 43) { resumeBad++; break; }
        }
      }
    }
  }
  check('every plan hangs together (delays in order, clock adds up, outcomes complete)', structBad === 0, `${structBad} bad`);
  // The park report agrees with the plan, five minutes at a time, through games with weather.
  for (const [region, g, p] of someGames) {
    const c = ctxFor(region, 'wx-a');
    const pk = c.map.parks[p.venueId];
    if (p.outcome === 'postponed') continue;
    for (const dl of p.delays) {
      const rep = conditionsAt(c, pk.x, pk.y, dl.startT);
      const ok = dl.reason === 'lightning' ? rep.lightning : dl.reason === 'wet field' ? true : rep.precip.kind !== null;
      if (!ok) reportBad++;
    }
    for (let t = p.startAt; t < p.endT; t += 5 * 60_000) {
      if (GWm.delayAt(p, t)) continue;
      checkedSteps++;
      const rep = conditionsAt(c, pk.x, pk.y, t);
      if (rep.lightning || rep.precip.inPerHr * 25.4 >= GW.STOP_RATE_MMH + 0.06 || (rep.precip.kind && rep.precip.kind !== 'rain' && rep.precip.dbz >= GW.SNOW_DBZ)) reportBad++;
    }
  }
  check(`the park report agrees with the plan (${someGames.length} games, ${checkedSteps} playing moments)`, reportBad === 0, `${reportBad} off`);
  check('play never resumes within 30 minutes of lightning in the area', resumeBad === 0, `${resumeBad}`);
  check(`clubs postpone ahead only when the GM's forecast shows a high chance (${nForecastCalls} calls)`, callBad === 0 && nForecastCalls > 0, `${callBad} low`);
  check('field postponements follow rain or snow that already fell', fieldBad === 0, `${fieldBad}`);
  const pct = (a, n) => (100 * a / n);
  for (const region of REGION_KEYS) {
    const r = rates[region];
    const ppd = pct(r.ppd, r.n), called = pct(r.called, r.n), delayed = pct(r.delayed, r.n);
    check(`${region}: postponed ${ppd.toFixed(1)}%, delayed ${delayed.toFixed(1)}%, called ${called.toFixed(1)}% of ${r.n} games`,
          ppd >= 0.1 && ppd <= 3.5 && delayed >= 1 && delayed <= 14 && called <= 2);
  }
  check('the west is the driest for baseball', REGION_KEYS.every(k => k === 'west' || rates[k].delayed + rates[k].ppd > rates.west.delayed + rates.west.ppd));
  // The same plan every time, from a separate copy of the code.
  const GW2 = await import('../../engine/GameWeather.js?fresh=1');
  const same = someGames.slice(0, 10).every(([region, g, p]) => JSON.stringify(GW2.gameWeatherPlan(ctxFor(region, 'wx-a'), g)) === JSON.stringify(p));
  check('a game\'s weather is the same every time it\'s worked out', same);
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  check(`a game's weather takes ${avg.toFixed(1)} ms on average`, avg < 40);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
