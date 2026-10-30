/**
 * engine/RadarFrames.js
 * §100 (step 2a) The radar's frames: which moments a loop shows, what each
 * frame is (what happened for the past and now; the current forecast run for
 * the future), the box of map it covers at each zoom, and the frame itself —
 * a compact grid of what's falling, one byte a cell.
 *
 * Pure. The radar worker (ui/components/radar-worker.js) builds frames with
 * this off the main thread; RadarFrameSource caches them for the screen.
 */

import { radarField, forecastContext, DBZ_MIN } from './WeatherSystems.js';
import { MS_HOUR } from './WeatherClimate.js';

const MIN = 60_000;

/** The loops the radar offers (GM decision, §100): the past two hours, and the forecast six and twenty-four hours ahead. */
export const LOOP_WINDOWS = Object.freeze({
  past2h:  { key: 'past2h',  label: 'Past 2 hrs',  fromMin: -120, toMin: 0,    stepMin: 10 },
  next6h:  { key: 'next6h',  label: 'Next 6 hrs',  fromMin: 0,    toMin: 360,  stepMin: 15 },
  next24h: { key: 'next24h', label: 'Next 24 hrs', fromMin: 0,    toMin: 1440, stepMin: 60 },
});
export const LOOP_ORDER = Object.freeze(['past2h', 'next6h', 'next24h']);
export const DEFAULT_LOOP = 'past2h';
const NOW_STEP_MIN = 10;   // the latest radar picture is at the last 10-minute mark

/** Zoom levels: the width of the view in km (same as the base map's). */
export const RADAR_SPANS_KM = Object.freeze([720, 240, 64]);
export const CELLS_ACROSS = 200;   // the frame's grid: about 200 cells across the view at any zoom

/**
 * frameTimes(nowMs, loopKey) — the frames of a loop, oldest first:
 * [{ t, forecast, issueMs?, isNow }]. The past and now are what happened;
 * the future is the forecast run made in now's hour — the same run the
 * dashboard and the schedule read.
 */
export function frameTimes(nowMs, loopKey = DEFAULT_LOOP) {
  const w = LOOP_WINDOWS[loopKey] || LOOP_WINDOWS[DEFAULT_LOOP];
  const nowMark = Math.floor(nowMs / (NOW_STEP_MIN * MIN)) * NOW_STEP_MIN * MIN;
  const issueMs = Math.floor(nowMs / MS_HOUR) * MS_HOUR;
  const out = [];
  if (w.toMin <= 0) {
    const step = w.stepMin * MIN;
    const last = Math.floor(nowMs / step) * step;
    for (let t = last + w.fromMin * MIN; t <= last; t += step) out.push({ t, forecast: false, isNow: t === last });
    return out;
  }
  out.push({ t: nowMark, forecast: false, isNow: true });
  const step = w.stepMin * MIN;
  for (let t = Math.floor(nowMs / step) * step + step; t <= nowMs + w.toMin * MIN; t += step) {
    out.push({ t, forecast: true, issueMs, isNow: false });
  }
  return out;
}

/**
 * viewBox(map, focusId, zoomIdx, aspect) — the radar's view, centred on a
 * ballpark: { cx, cy, spanKm (width), spanYKm (height) } and the frame grid
 * that covers it with a small margin: { x0, y0, x1, y1, cellKm, nx, ny }.
 * aspect = view width ÷ height.
 */
export function viewBox(map, focusId, zoomIdx = 1, aspect = 1) {
  const park = map.parks[focusId] || map.parks.user;
  const spanKm = RADAR_SPANS_KM[Math.max(0, Math.min(2, zoomIdx))];
  const spanYKm = spanKm / Math.max(0.3, aspect);
  const cellKm = Math.round((spanKm / CELLS_ACROSS) * 1000) / 1000;
  const mx = spanKm * 0.53, my = spanYKm * 0.53;
  const nx = Math.ceil((2 * mx) / cellKm), ny = Math.ceil((2 * my) / cellKm);
  const x0 = park.x - (nx * cellKm) / 2, y0 = park.y - (ny * cellKm) / 2;
  return { cx: park.x, cy: park.y, spanKm, spanYKm, grid: { x0, y0, x1: x0 + nx * cellKm, y1: y0 + ny * cellKm, cellKm, nx, ny } };
}

// ── Packed frames: one byte a cell ───────────────────────────────────────────
// 0 = nothing falling; otherwise kind (0 rain, 1 mix, 2 snow) in the top two
// bits and the reflectivity in the low six: dBZ = level + 11.5 (12.5…74.5,
// to the nearest half-dBZ either side — so anything that falls stays falling).

export function packLevel(dbz, kind) {
  if (!(dbz > DBZ_MIN)) return 0;
  const level = Math.max(1, Math.min(63, Math.round(dbz - 11.5)));
  return ((kind & 3) << 6) | level;
}
export const unpackDbz = (v) => (v & 63 ? (v & 63) + 11.5 : -Infinity);
export const unpackKind = (v) => v >> 6;

/** The cache key for a frame: what was asked (save's weather, moment, run, box). */
export function frameKey(base, frame, grid) {
  return [base.seed, base.region, base.tzMin, base.cal.length, frame.forecast ? frame.issueMs : 'T', frame.t,
          grid.x0.toFixed(2), grid.y0.toFixed(2), grid.nx, grid.ny, grid.cellKm].join('|');
}

/**
 * buildFrame(base, frame, grid) — one radar frame: { t, forecast, issueMs,
 * x0, y0, x1, y1, cellKm, nx, ny, data: Uint8Array (row 0 = north) }.
 * `base` is the save's weather context (WeatherClimate.weatherContext).
 */
export function buildFrame(base, frame, grid) {
  const ctx = frame.forecast ? forecastContext(base, frame.issueMs) : base;
  const f = radarField(ctx, frame.t, { x0: grid.x0, y0: grid.y0, x1: grid.x1, y1: grid.y1 }, grid.cellKm);
  const data = new Uint8Array(f.nx * f.ny);
  for (let i = 0; i < data.length; i++) data[i] = packLevel(f.dbz[i], f.kind[i]);
  return { t: frame.t, forecast: !!frame.forecast, issueMs: frame.issueMs ?? null, isNow: !!frame.isNow,
           x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, cellKm: f.cellKm, nx: f.nx, ny: f.ny, data };
}
