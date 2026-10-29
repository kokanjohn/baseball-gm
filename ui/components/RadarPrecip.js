/**
 * ui/components/RadarPrecip.js
 * §100 Paints a precipitation field (WeatherSystems.radarField) over the base
 * map in real radar colours:
 *   rain — light green → green → dark green → yellow → orange → red → dark
 *          red → magenta (hail) as it gets heavier;
 *   mix  — pinks;  snow — light blue → dark blue.
 * The field is painted cell-by-cell into a small image, then scaled up with
 * smoothing, which gives the soft edges of real radar imagery.
 */

import { projector } from './RadarMap.js';

// [minimum dBZ, colour] — each band runs up to the next one's minimum.
export const RAIN_SCALE = Object.freeze([
  [12, '#8be08b'], [18, '#4ec24e'], [23, '#22a022'], [28, '#127a12'], [33, '#0b5d0b'],
  [38, '#f2e600'], [42, '#f5bf00'], [46, '#f58a00'], [50, '#e83a14'], [54, '#c4100c'],
  [58, '#8f0000'], [62, '#ff2bd6'], [67, '#b44bff'],
]);
export const MIX_SCALE = Object.freeze([
  [12, '#f7c4df'], [20, '#f09ac8'], [27, '#e46cb0'], [34, '#d0408f'], [41, '#ad1f6f'],
]);
export const SNOW_SCALE = Object.freeze([
  [12, '#bfe3ff'], [17, '#94cdf8'], [22, '#66adef'], [27, '#3b86de'], [32, '#1f60c4'], [37, '#103a94'],
]);

const _rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const _tables = [RAIN_SCALE, MIX_SCALE, SNOW_SCALE].map(scale => scale.map(([d, c]) => [d, _rgb(c)]));

/** The colour for a reflectivity and kind (0 rain, 1 mix, 2 snow), or null. */
export function colorFor(dbz, kind = 0) {
  const t = _tables[kind] || _tables[0];
  if (!(dbz >= t[0][0])) return null;
  let c = t[0][1];
  for (const [d, rgb] of t) if (dbz >= d) c = rgb;
  return c;
}

let _scratch = null;

/**
 * drawPrecip(ctx, field, view, { alpha }) — paint the field into the view.
 * The field's box (km) is projected with the same view as the base map.
 */
export function drawPrecip(ctx, field, view, opts = {}) {
  const alpha = Math.round(255 * (opts.alpha ?? 0.82));
  const { nx, ny } = field;
  if (!_scratch || typeof document === 'undefined') _scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(nx, ny) : document.createElement('canvas');
  _scratch.width = nx; _scratch.height = ny;
  const sctx = _scratch.getContext('2d');
  const img = sctx.createImageData(nx, ny);
  const px = img.data;
  for (let i = 0; i < nx * ny; i++) {
    const c = colorFor(field.dbz[i], field.kind[i]);
    if (!c) continue;
    const o = i * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
    // The faintest echoes fade in rather than starting at full strength.
    px[o + 3] = field.dbz[i] < 16 ? Math.round(alpha * (0.45 + 0.55 * (field.dbz[i] - 12) / 4)) : alpha;
  }
  sctx.putImageData(img, 0, 0);
  const P = projector(view);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_scratch, P.x(field.x0), P.y(field.y1), (field.x1 - field.x0) * P.k, (field.y1 - field.y0) * P.k);
  ctx.restore();
}
