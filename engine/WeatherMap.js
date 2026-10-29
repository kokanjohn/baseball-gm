/**
 * engine/WeatherMap.js
 * §100 The league region's map, shared by the weather model and the radar:
 * the authored outlines from data/region-maps.js roughened into natural
 * shores (deterministically — the same every time), a highway network
 * between the ballparks that never crosses water, and the questions the
 * weather asks of the map (where is a club's park, is this point water).
 *
 * Pure: no state reads or writes. Results are cached per region.
 */

import { REGION_MAPS, MAP_HALF_KM, TOWN_NAME_PARTS } from '../data/region-maps.js';
import { hash, hash01, hashSigned } from './WeatherNoise.js';

export { MAP_HALF_KM };
export const REGION_KEYS = Object.freeze(['north', 'south', 'east', 'west']);

const MIN_SEG_KM = 3;          // roughen until segments are this short
const ROAD_MAX_KM = 270;       // longest highway link between two parks
const ROAD_EXTRA = 4;          // links beyond the spanning tree, shortest first
const _cache = new Map();

// ── Geometry ────────────────────────────────────────────────────────────────

/** Midpoint displacement: a coarse line becomes a natural one. */
function _roughen(pts, seed, rough, closed) {
  if (!rough) return pts.map(p => [...p]);
  const out = [];
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0], a[1]]);
    _subdivide(a, b, seed, rough, i, 1, out);
  }
  if (!closed) out.push([...pts[n - 1]]);
  return out;
}

function _subdivide(a, b, seed, rough, id, depth, out) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < MIN_SEG_KM || depth > 12) return;
  const off = hashSigned(seed, id, depth, Math.round(a[0] * 7), Math.round(a[1] * 7)) * len * rough;
  const m = [(a[0] + b[0]) / 2 - (dy / len) * off, (a[1] + b[1]) / 2 + (dx / len) * off];
  _subdivide(a, m, seed, rough, id * 2 + 1, depth + 1, out);
  out.push(m);
  _subdivide(m, b, seed, rough, id * 2 + 2, depth + 1, out);
}

/** Ray-cast point-in-polygon. */
export function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function _bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

// ── The map ─────────────────────────────────────────────────────────────────

/**
 * regionMap(region) — the processed map:
 * { region, half, parks: { teamId: { x, y, city } },
 *   features: [{ kind, name?, pts, closed, bbox }]   (authored, roughened),
 *   urban: [{ teamId, pts, bbox }]                    (city area around each park),
 *   towns: [{ x, y, name, size: 1|2|3, suburb? }]      (small towns and suburbs, generated),
 *   roads: [[x,y]...][]  (highways)   local: [[x,y]...][]  (local roads) }
 */
export function regionMap(region) {
  const key = REGION_MAPS[region] ? region : 'north';
  if (_cache.has(key)) return _cache.get(key);
  const src = REGION_MAPS[key];
  const features = src.features.map((f, i) => {
    const closed = !['river', 'border'].includes(f.kind);
    const rough = f.kind === 'border' ? 0 : f.kind === 'river' ? 0.12 : (f.rough ?? 0.2);
    const pts = _roughen(f.pts, hash(src.seed, i), rough, closed);
    return { kind: f.kind, name: f.name || null, closed, pts, bbox: _bbox(pts) };
  });
  const map = { region: key, half: MAP_HALF_KM, parks: src.parks, features, roads: [], urban: [], towns: [], local: [] };
  map.roads = _buildRoads(map, src.seed);
  map.urban = _buildUrban(map, src.seed);
  map.towns = _buildTowns(map, src.seed);
  map.local = _buildLocalRoads(map, src.seed);
  _cache.set(key, map);
  return map;
}

/** Is (x, y) on water (lake, gulf, ocean — not an island)? */
export function isWater(map, x, y) {
  let water = false;
  for (const f of map.features) {
    const b = f.bbox;
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    if (f.kind === 'water' && inPolygon(f.pts, x, y)) water = true;
  }
  if (!water) return false;
  return !map.features.some(f => f.kind === 'island' && inPolygon(f.pts, x, y));
}

/** Distance (km) from (x, y) to the nearest water's edge, capped at `cap`. */
export function distanceToWater(map, x, y, cap = 200, step = 4) {
  if (isWater(map, x, y)) return 0;
  for (let r = step; r <= cap; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / (step * 2)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (isWater(map, x + Math.cos(a) * r, y + Math.sin(a) * r)) return r;
    }
  }
  return cap;
}

/** A club's ballpark on the map ('user' for ours). */
export function parkOf(map, teamId) {
  return map.parks[teamId] || null;
}

/** The ballpark a game is played at: the home club's. */
export function venueOf(map, game) {
  if (!game) return null;
  const home = game.homeId ?? (game.isHome ? 'user' : game.opponentId);
  return { teamId: home, ...(map.parks[home] || map.parks.user) };
}

/** City name for a park; ours comes from the save. */
export function cityOf(map, teamId, userCity = '') {
  if (teamId === 'user') return userCity || 'Home';
  return map.parks[teamId]?.city || teamId;
}

// ── Highways ────────────────────────────────────────────────────────────────

function _crossesWater(map, a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.ceil(len / 2.5);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (isWater(map, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return true;
  }
  return false;
}

function _buildRoads(map, seed) {
  const nodes = Object.entries(map.parks).map(([id, p]) => ({ id, pt: [p.x, p.y] }));
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].pt, b = nodes[j].pt;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > ROAD_MAX_KM || _crossesWater(map, a, b)) continue;
      edges.push({ i, j, d });
    }
  }
  edges.sort((x, y) => x.d - y.d);
  // Spanning tree (Kruskal), then a few short extra links.
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const chosen = [], extra = [];
  for (const e of edges) {
    const a = find(e.i), b = find(e.j);
    if (a !== b) { parent[a] = b; chosen.push(e); } else extra.push(e);
  }
  chosen.push(...extra.slice(0, ROAD_EXTRA));
  const lines = chosen.map(e => [nodes[e.i].pt, nodes[e.j].pt]);
  // Highways that leave the map: from the park nearest each edge, outward.
  const H = map.half + 60;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) {
    const best = nodes.map(n => ({ n, s: n.pt[0] * dx + n.pt[1] * dy })).sort((a, b) => b.s - a.s)[0].n;
    const end = dx ? [dx * H, best.pt[1] + hashSigned(seed, dx, dy) * 60] : [best.pt[0] + hashSigned(seed, dy, dx) * 60, dy * H];
    if (!_crossesWater(map, best.pt, end)) lines.push([best.pt, end]);
  }
  // A gentle bend, then a little roughness, so highways don't look ruled.
  return lines.map(([a, b], k) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bend = hashSigned(seed, 7001, k) * len * 0.08;
    const m = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * bend, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * bend];
    const mid = _crossesWater(map, a, m) || _crossesWater(map, m, b) ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : m;
    return _roughen([a, mid, b], hash(seed, 7002, k), 0.035, false);
  });
}

// ── City areas, towns and local roads ───────────────────────────────────────

/** A built-up area around each ballpark (a rough blob, land only). */
function _buildUrban(map, seed) {
  return Object.entries(map.parks).map(([teamId, p], k) => {
    const r = 9 + hash01(seed, 7101, k) * 6;
    const n = 10;
    const coarse = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.7 + 0.5 * hash01(seed, 7102, k, i));
      return [p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr];
    });
    const pts = _roughen(coarse, hash(seed, 7103, k), 0.25, true);
    return { teamId, pts, bbox: _bbox(pts) };
  });
}

const TOWN_CELL_KM = 26;

/** Small towns: one candidate per grid cell, kept on land away from the parks. */
function _buildTowns(map, seed) {
  const C = TOWN_NAME_PARTS.common, R = TOWN_NAME_PARTS[map.region] || {};
  const words = [...C.words, ...(R.words || []), ...(R.words || [])];   // region words weigh double
  const roots = C.roots;
  const joined = [...C.joined, ...(R.joined || [])];
  const spaced = [...C.spaced, ...(R.spaced || []), ...(R.spaced || [])];
  const pick = (arr, ...k) => arr[Math.floor(hash01(seed, ...k) * arr.length)];
  /** "Oakdale", "Pine Falls", "Wexford" — never "Kentton", "Willowwood", "Wex Falls". */
  const nameFor = (gx, gy, t) => {
    const useRoot = hash01(seed, 7205, gx, gy, t) < 0.4;
    const base = useRoot ? pick(roots, 7206, gx, gy, t) : pick(words, 7207, gx, gy, t);
    if (!useRoot && hash01(seed, 7208, gx, gy, t) < 0.4) return `${base} ${pick(spaced, 7209, gx, gy, t)}`;
    const end = pick(joined, 7210, gx, gy, t);
    if (base.slice(-1).toLowerCase() === end[0] || base.toLowerCase().endsWith(end) || end.startsWith(base.slice(-2).toLowerCase())) return null;
    return base + end;
  };
  const used = new Set(Object.values(map.parks).map(p => p.city).filter(Boolean));
  const parks = Object.values(map.parks);
  const towns = [];
  const H = map.half;
  for (let gx = -Math.ceil(H / TOWN_CELL_KM); gx <= Math.ceil(H / TOWN_CELL_KM); gx++) {
    for (let gy = -Math.ceil(H / TOWN_CELL_KM); gy <= Math.ceil(H / TOWN_CELL_KM); gy++) {
      if (hash01(seed, 7201, gx, gy) > 0.62) continue;
      const x = (gx + 0.15 + 0.7 * hash01(seed, 7202, gx, gy)) * TOWN_CELL_KM;
      const y = (gy + 0.15 + 0.7 * hash01(seed, 7203, gx, gy)) * TOWN_CELL_KM;
      if (Math.abs(x) > H || Math.abs(y) > H) continue;
      if (parks.some(p => Math.hypot(p.x - x, p.y - y) < 22)) continue;
      if (isWater(map, x, y)) continue;
      // Bigger towns near highways and parks, smaller in the back country.
      const near = Math.min(...parks.map(p => Math.hypot(p.x - x, p.y - y)));
      const sz = hash01(seed, 7204, gx, gy) + (near < 70 ? 0.25 : 0);
      const size = sz > 0.92 ? 3 : sz > 0.6 ? 2 : 1;
      let name = null;
      for (let t = 0; t < 12 && !name; t++) {
        const cand = nameFor(gx, gy, t);
        if (cand && !used.has(cand)) name = cand;
      }
      if (!name) continue;
      used.add(name);
      towns.push({ x, y, name, size });
    }
  }
  // Suburbs ring each ballpark — the detail of the ballpark view.
  Object.values(map.parks).forEach((p, k) => {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = ((i + hash01(seed, 7221, k, i) * 0.6) / n) * Math.PI * 2;
      const r = 13 + hash01(seed, 7222, k, i) * 16;
      const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
      if (isWater(map, x, y) || towns.some(t => Math.hypot(t.x - x, t.y - y) < 8)) continue;
      let name = null;
      for (let t = 0; t < 12 && !name; t++) {
        const cand = nameFor(9000 + k, i, t);
        if (cand && !used.has(cand)) name = cand;
      }
      if (!name) continue;
      used.add(name);
      towns.push({ x, y, name, size: 1, suburb: true });
    }
  });
  return towns;
}

/** Local roads: each town to its two nearest neighbours (towns or parks), never over water. */
function _buildLocalRoads(map, seed) {
  const nodes = [...map.towns.map(t => [t.x, t.y]), ...Object.values(map.parks).map(p => [p.x, p.y])];
  const seen = new Set(), lines = [];
  map.towns.forEach((t, i) => {
    const near = nodes.map((n, j) => ({ j, d: Math.hypot(n[0] - t.x, n[1] - t.y) }))
      .filter(o => o.j !== i && o.d < 60).sort((a, b) => a.d - b.d).slice(0, 2);
    for (const { j } of near) {
      const k = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (_crossesWater(map, [t.x, t.y], nodes[j])) continue;
      lines.push(_roughen([[t.x, t.y], nodes[j]], hash(seed, 7301, i, j), 0.06, false));
    }
  });
  return lines;
}
