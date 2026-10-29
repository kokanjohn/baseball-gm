/**
 * ui/components/RadarMap.js
 * §100 Draws the league region's flat base map on a canvas — the layer the
 * radar paints precipitation over. Land, water, high ground, state lines,
 * rivers, highways, ballparks and labels, in the style of a real radar
 * app's flat map (no satellite or terrain imagery).
 *
 * Usage:
 *   drawBaseMap(ctx, map, view, { theme, userCity, focusId })
 *   view: { cx, cy, spanKm, w, h } — centre (km), width of the view (km),
 *         canvas size in CSS pixels (ctx already scaled for devicePixelRatio).
 */

import { cityOf } from '../../engine/WeatherMap.js';

/** The radar's three zoom levels: the width of the view in km. */
export const RADAR_ZOOMS = Object.freeze([
  { key: 'region',   label: 'Region',   spanKm: 720 },
  { key: 'metro',    label: 'Metro',    spanKm: 240 },
  { key: 'ballpark', label: 'Ballpark', spanKm: 64 },
]);
export const DEFAULT_ZOOM = 1;

export const MAP_PALETTES = Object.freeze({
  dark: {
    land: '#1c2029', water: '#0a0d13', waterEdge: '#2a3446', relief: '#232833', reliefEdge: '#2d3340',
    flat: '#2a2a29', urban: '#262b36', local: '#2e3441', town: '#9aa3b6', border: '#454d63', river: '#22344c', road: '#5b4c35', roadCasing: '#14171e',
    label: '#d3d8e3', labelHalo: 'rgba(10,12,18,0.92)', waterLabel: '#3e5068', park: '#e8ecf4', parkUser: '#ffffff',
  },
  light: {
    land: '#e9e7e1', water: '#b8c9d8', waterEdge: '#9fb3c6', relief: '#dedad0', reliefEdge: '#cfc9bb',
    flat: '#efece2', urban: '#dcd8cf', local: '#d2cec4', town: '#5d6475', border: '#a6a397', river: '#a9bfd2', road: '#c9a96a', roadCasing: '#f6f4ef',
    label: '#2a2e38', labelHalo: 'rgba(246,244,239,0.95)', waterLabel: '#6d8399', park: '#2a2e38', parkUser: '#111318',
  },
});

/** km → canvas px for a view. */
export function projector(view) {
  const k = view.w / view.spanKm;   // px per km
  return {
    k,
    x: (x) => view.w / 2 + (x - view.cx) * k,
    y: (y) => view.h / 2 - (y - view.cy) * k,
    km: (px, py) => [view.cx + (px - view.w / 2) / k, view.cy - (py - view.h / 2) / k],
  };
}

function _visible(f, view) {
  const hw = view.spanKm / 2, hh = (view.spanKm * view.h) / view.w / 2;
  const b = f.bbox;
  return !(b.x1 < view.cx - hw || b.x0 > view.cx + hw || b.y1 < view.cy - hh || b.y0 > view.cy + hh);
}

function _path(ctx, pts, P, closed) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y))));
  if (closed) ctx.closePath();
}

/**
 * drawBaseMap — the whole base map for one view.
 * opts: theme 'dark'|'light', userCity, focusId (the park the view centres
 * on — marked like ours), labels (default true).
 */
export function drawBaseMap(ctx, map, view, opts = {}) {
  const C = MAP_PALETTES[opts.theme === 'light' ? 'light' : 'dark'];
  const P = projector(view);
  const zoomIdx = view.spanKm > 400 ? 0 : view.spanKm > 100 ? 1 : 2;
  ctx.save();
  ctx.fillStyle = C.land;
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const vis = map.features.filter(f => _visible(f, view));
  const of = (kind) => vis.filter(f => f.kind === kind);

  for (const f of of('relief')) {
    _path(ctx, f.pts, P, true);
    ctx.fillStyle = C.relief; ctx.fill();
    ctx.strokeStyle = C.reliefEdge; ctx.lineWidth = 1; ctx.stroke();
  }
  for (const f of of('flat')) {
    _path(ctx, f.pts, P, true);
    ctx.fillStyle = C.flat; ctx.fill();
  }
  // City areas around the ballparks.
  ctx.fillStyle = C.urban;
  for (const u of map.urban) { if (_visible(u, view)) { _path(ctx, u.pts, P, true); ctx.fill(); } }
  // Street grid inside the city areas (ballpark view).
  if (zoomIdx === 2) {
    ctx.strokeStyle = C.local; ctx.lineWidth = 0.7;
    for (const [k, u] of map.urban.entries()) {
      if (!_visible(u, view)) continue;
      ctx.save();
      _path(ctx, u.pts, P, true); ctx.clip();
      const a = ((k * 37) % 30 - 15) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      const b = u.bbox, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, R = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      ctx.beginPath();
      for (let d = -R; d <= R; d += 1.6) {
        for (const [ux, uy, vx, vy] of [[c, sn, -sn, c], [-sn, c, c, sn]]) {
          ctx.moveTo(P.x(cx + ux * d - vx * R), P.y(cy + uy * d - vy * R));
          ctx.lineTo(P.x(cx + ux * d + vx * R), P.y(cy + uy * d + vy * R));
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  // State lines.
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  for (const f of of('border')) { _path(ctx, f.pts, P, false); ctx.stroke(); }
  ctx.setLineDash([]);
  // Local roads (metro and ballpark views).
  if (zoomIdx > 0) {
    ctx.strokeStyle = C.local; ctx.lineWidth = zoomIdx === 2 ? 1.6 : 0.8;
    for (const r of map.local) { _path(ctx, r, P, false); ctx.stroke(); }
  }
  // Highways: a casing, then the road.
  const roadW = [1.3, 2, 2.6][zoomIdx];
  for (const [w, color] of [[roadW + 1.6, C.roadCasing], [roadW, C.road]]) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    for (const r of map.roads) { _path(ctx, r, P, false); ctx.stroke(); }
  }
  // Rivers.
  ctx.strokeStyle = C.river; ctx.lineWidth = [1, 1.6, 2.6][zoomIdx];
  for (const f of of('river')) { _path(ctx, f.pts, P, false); ctx.stroke(); }
  // Water over everything below it, then islands.
  for (const f of of('water')) {
    _path(ctx, f.pts, P, true);
    ctx.fillStyle = C.water; ctx.fill();
    ctx.strokeStyle = C.waterEdge; ctx.lineWidth = 1; ctx.stroke();
  }
  for (const f of of('island')) {
    _path(ctx, f.pts, P, true);
    ctx.fillStyle = C.land; ctx.fill();
    ctx.strokeStyle = C.waterEdge; ctx.lineWidth = 1; ctx.stroke();
  }

  if (opts.labels !== false) _labels(ctx, map, view, P, C, zoomIdx, opts);
  ctx.restore();
}

function _labels(ctx, map, view, P, C, zoomIdx, opts) {
  const placed = [];
  const hits = (r) => placed.some(q => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  const halo = (text, x, y) => {
    ctx.lineWidth = 3; ctx.strokeStyle = C.labelHalo; ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };

  // Ballparks first (ours and the focus park reserve their spots first).
  const focus = opts.focusId || 'user';
  const parks = Object.entries(map.parks)
    .map(([id, p]) => ({ id, p, px: P.x(p.x), py: P.y(p.y) }))
    .filter(o => o.px > -40 && o.px < view.w + 40 && o.py > -20 && o.py < view.h + 20)
    .sort((a, b) => (b.id === focus) - (a.id === focus) || (b.id === 'user') - (a.id === 'user'));
  for (const o of parks) {
    const key = o.id === focus || o.id === 'user';
    const r = key ? 4 : 3;
    ctx.beginPath(); ctx.arc(o.px, o.py, r, 0, Math.PI * 2);
    ctx.fillStyle = key ? C.parkUser : C.park; ctx.fill();
    if (key) {
      ctx.beginPath(); ctx.arc(o.px, o.py, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = C.parkUser; ctx.lineWidth = 1.5; ctx.stroke();
    }
    placed.push({ x: o.px - r - 2, y: o.py - r - 2, w: 2 * r + 4, h: 2 * r + 4 });
  }
  for (const o of parks) {
    const key = o.id === focus || o.id === 'user';
    const text = cityOf(map, o.id, opts.userCity);
    ctx.font = `${key ? 700 : 600} ${[11, 12, 13][zoomIdx] + (key ? 1 : 0)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const w = ctx.measureText(text).width, h = 13, gap = key ? 11 : 7;
    const spots = [
      [o.px + gap, o.py + 4], [o.px - gap - w, o.py + 4],
      [o.px - w / 2, o.py - gap - 2], [o.px - w / 2, o.py + gap + h - 2],
    ];
    for (const [x, y] of spots) {
      const box = { x: x - 2, y: y - h + 2, w: w + 4, h };
      if (box.x < 2 || box.x + box.w > view.w - 2 || box.y < 2 || box.y + box.h > view.h - 2) continue;
      if (hits(box) && !key) continue;
      ctx.fillStyle = C.label; ctx.textBaseline = 'alphabetic';
      halo(text, x, y);
      placed.push(box);
      break;
    }
  }

  // Towns: bigger ones in the metro view, all of them in the ballpark view.
  if (zoomIdx > 0) {
    const minSize = zoomIdx === 1 ? 2 : 1;
    const towns = map.towns
      .filter(t => t.size >= minSize)
      .map(t => ({ t, px: P.x(t.x), py: P.y(t.y) }))
      .filter(o => o.px > 0 && o.px < view.w && o.py > 0 && o.py < view.h)
      .sort((a, b) => b.t.size - a.t.size);
    for (const o of towns) {
      const fs = zoomIdx === 2 ? 11 + (o.t.size - 1) : 10 + (o.t.size - 2);
      ctx.font = `500 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const w = ctx.measureText(o.t.name).width;
      const dot = { x: o.px - 3, y: o.py - 3, w: 6, h: 6 };
      const box = { x: o.px + 4, y: o.py - fs + 4, w: w + 4, h: fs + 1 };
      if (box.x + box.w > view.w - 2 || box.y < 2 || hits(dot) || hits(box)) continue;
      ctx.beginPath(); ctx.arc(o.px, o.py, o.t.size === 3 ? 2.4 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = C.town; ctx.fill();
      ctx.fillStyle = C.town;
      halo(o.t.name, o.px + 6, o.py + 4);
      placed.push(dot, box);
    }
  }

  // Water names, region view only, where they fit.
  if (zoomIdx === 0) {
    ctx.font = 'italic 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = C.waterLabel;
    for (const f of map.features.filter(f => f.name && f.kind !== 'river')) {
      const inView = f.pts.filter(([x, y]) => Math.abs(x - view.cx) < view.spanKm / 2.4 && Math.abs(y - view.cy) < view.spanKm / 2.4);
      if (inView.length < 6) continue;
      const cx = inView.reduce((s, p) => s + p[0], 0) / inView.length;
      const cy = inView.reduce((s, p) => s + p[1], 0) / inView.length;
      const w = ctx.measureText(f.name).width;
      const box = { x: P.x(cx) - w / 2, y: P.y(cy) - 11, w, h: 13 };
      if (box.x < 4 || box.x + w > view.w - 4 || box.y < 4 || box.y > view.h - 16 || hits(box)) continue;
      ctx.fillText(f.name, box.x, box.y + 11);
      placed.push(box);
    }
  }
}
