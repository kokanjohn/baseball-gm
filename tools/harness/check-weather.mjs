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

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
