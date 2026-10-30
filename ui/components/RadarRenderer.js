/**
 * ui/components/RadarRenderer.js
 * §100 (step 2b) Draws a radar frame: the flat base map, the precipitation in
 * real radar colours, place names on top (as radar apps do), and a scale bar.
 *
 *   const r = createRadarRenderer(canvas);
 *   r.setView({ map, focusId, zoomIdx, theme, userCity });   // when any of these change
 *   r.draw(frame);                                            // a packed frame (RadarFrames), or null
 *
 * The base map and the labels are drawn once per view and reused. The
 * precipitation is drawn by interpolating the reflectivity between grid
 * points before colouring — smooth edges, crisp colour bands — at about the
 * screen's resolution, and each frame's picture is kept, so a loop only
 * redraws what changes.
 *
 * Also here: the legend (radarLegendHTML) and frame times (formatFrameTime).
 */

import { drawBaseMap, MAP_PALETTES, projector } from './RadarMap.js';
import { RAIN_SCALE, MIX_SCALE, SNOW_SCALE } from './RadarPrecip.js';
import { viewBox, unpackDbz, unpackKind } from '../../engine/RadarFrames.js';

const EDGE_DBZ = 6;              // an empty grid point counts as this when blending, so edges fade out between points
const PRECIP_ALPHA = 0.86;
const PICTURE_CACHE = 30;        // frame pictures kept per renderer (a loop's worth)
const MI_PER_KM = 0.621371;

// ── Colours: a lookup per kind for every half-dBZ ────────────────────────────

const _rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const LUT_MIN = 12, LUT_STEPS = 140;   // 12 … 82 dBZ by 0.5
const _luts = [RAIN_SCALE, MIX_SCALE, SNOW_SCALE].map((scale, kind) => {
  const lut = new Uint8ClampedArray(LUT_STEPS * 4);
  for (let i = 0; i < LUT_STEPS; i++) {
    const d = LUT_MIN + i * 0.5;
    let c = scale[0][1];
    for (const [min, hex] of scale) if (d >= min) c = hex;
    const [r, g, b] = _rgb(c);
    // The faintest echoes fade in rather than starting at full strength.
    // (Snow fades in less: pale blue at low strength reads as grey fog on the dark map.)
    const floor = kind === 2 ? 0.7 : 0.45;
    const a = Math.round(255 * PRECIP_ALPHA * (d < 16 ? floor + (1 - floor) * (d - 12) / 4 : 1));
    lut.set([r, g, b, a], i * 4);
  }
  return lut;
});

// ── The renderer ────────────────────────────────────────────────────────────

export function createRadarRenderer(canvas) {
  let opts = null, view = null, cssW = 0, cssH = 0, dpr = 1;
  let baseLayer = null, labelLayer = null;
  const pictures = new Map();   // frame key → canvas (the precipitation, at view size)

  function _size() {
    dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    cssW = Math.max(1, Math.round(canvas.clientWidth || canvas.width / dpr));
    cssH = Math.max(1, Math.round(canvas.clientHeight || canvas.height / dpr));
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) { canvas.width = cssW * dpr; canvas.height = cssH * dpr; }
  }

  function _layer(draw) {
    const c = document.createElement('canvas');
    c.width = cssW * dpr; c.height = cssH * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    draw(g);
    return c;
  }

  function _rebuild() {
    _size();
    const vb = viewBox(opts.map, opts.focusId, opts.zoomIdx, cssW / cssH);
    view = { cx: vb.cx, cy: vb.cy, spanKm: vb.spanKm, w: cssW, h: cssH, grid: vb.grid };
    const mapOpts = { theme: opts.theme, userCity: opts.userCity, focusId: opts.focusId };
    baseLayer = _layer(g => drawBaseMap(g, opts.map, view, { ...mapOpts, labels: false }));
    // The scale bar's corner is kept clear of labels.
    const reserve = [{ x: 0, y: cssH - 30, w: 150, h: 30 }];
    labelLayer = _layer(g => { drawBaseMap(g, opts.map, view, { ...mapOpts, labelsOnly: true, reserve }); _scaleBar(g); });
    pictures.clear();
  }

  function _scaleBar(g) {
    const C = MAP_PALETTES[opts.theme === 'light' ? 'light' : 'dark'];
    const pxPerMi = cssW / (view.spanKm * MI_PER_KM);
    const target = 80 / pxPerMi;   // about 80 px long
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].reduce((b, n) => (Math.abs(n - target) < Math.abs(b - target) ? n : b), 1);
    const len = nice * pxPerMi, x = 12, y = cssH - 14;
    g.save();
    g.strokeStyle = C.labelHalo; g.lineWidth = 4; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
    g.strokeStyle = C.label; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x, y); g.lineTo(x + len, y); g.lineTo(x + len, y - 4); g.stroke();
    g.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    g.fillStyle = C.label; g.lineWidth = 3; g.strokeStyle = C.labelHalo;
    const text = `${nice} mi`;
    g.strokeText(text, x + len + 5, y + 3); g.fillText(text, x + len + 5, y + 3);
    g.restore();
  }

  /** The precipitation of one frame as a picture the size of the view (cached per frame). */
  function _picture(frame) {
    const key = `${frame.t}|${frame.issueMs ?? 'T'}|${frame.x0}|${frame.y0}|${frame.nx}|${frame.ny}|${frame.cellKm}`;
    const hit = pictures.get(key);
    if (hit) return hit;
    // Drawn at up to 1.25× the CSS size: the smoothness comes from blending
    // the reflectivity, so more pixels add nothing you can see.
    const scale = Math.min(dpr, 1.25);
    const W = Math.round(cssW * scale), H = Math.round(cssH * scale);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const px = img.data;
    const P = projector({ ...view, w: W, h: H });
    const { x0, y1, cellKm, nx, ny, data } = frame;
    // The frame unpacked once into a grid with a one-cell border of "nothing":
    // reflectivity (empty = EDGE_DBZ) and the kind of the nearest wet cell.
    const PW = nx + 2, PH = ny + 2;
    const zg = new Float32Array(PW * PH).fill(EDGE_DBZ);
    const kg = new Uint8Array(PW * PH);
    for (let r = 0; r < ny; r++) for (let q = 0; q < nx; q++) {
      const v = data[r * nx + q];
      if (v) { zg[(r + 1) * PW + q + 1] = unpackDbz(v); kg[(r + 1) * PW + q + 1] = unpackKind(v); }
    }
    // Grid position of each pixel column / row (padded grid; cell centres at +0.5).
    const colF = new Float32Array(W), rowF = new Float32Array(H);
    for (let i = 0; i < W; i++) colF[i] = (P.km(i + 0.5, 0)[0] - x0) / cellKm + 0.5;
    for (let j = 0; j < H; j++) rowF[j] = (y1 - P.km(0, j + 0.5)[1]) / cellKm + 0.5;
    for (let j = 0; j < H; j++) {
      const rf = rowF[j], r0 = Math.floor(rf);
      if (r0 < 0 || r0 >= PH - 1) continue;
      const fy = rf - r0, row0 = r0 * PW, row1 = row0 + PW;
      let o = j * W * 4;
      for (let i = 0; i < W; i++, o += 4) {
        const cf = colF[i], c0 = Math.floor(cf);
        if (c0 < 0 || c0 >= PW - 1) continue;
        const a = zg[row0 + c0], b = zg[row0 + c0 + 1], cc = zg[row1 + c0], d = zg[row1 + c0 + 1];
        if (a + b + cc + d === 4 * EDGE_DBZ) continue;
        const fx = cf - c0;
        const z = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
        if (z < LUT_MIN) continue;
        // Rain / mix / snow: the strongest of the four grid points around.
        let k = kg[row0 + c0], best = a;
        if (b > best) { best = b; k = kg[row0 + c0 + 1]; }
        if (cc > best) { best = cc; k = kg[row1 + c0]; }
        if (d > best) { k = kg[row1 + c0 + 1]; }
        const lut = _luts[k];
        const li = (((z - LUT_MIN) * 2 + 0.5) | 0) * 4;
        const L = li < LUT_STEPS * 4 ? li : (LUT_STEPS - 1) * 4;
        px[o] = lut[L]; px[o + 1] = lut[L + 1]; px[o + 2] = lut[L + 2]; px[o + 3] = lut[L + 3];
      }
    }
    g.putImageData(img, 0, 0);
    pictures.set(key, c);
    if (pictures.size > PICTURE_CACHE) pictures.delete(pictures.keys().next().value);
    return c;
  }

  return {
    /** Set what the radar looks at: { map, focusId, zoomIdx, theme, userCity }. */
    setView(next) {
      const changed = !opts || ['map', 'focusId', 'zoomIdx', 'theme', 'userCity'].some(k => next[k] !== opts[k]);
      opts = { ...opts, ...next };
      if (changed) _rebuild();
    },
    /** After the canvas changes size. */
    resize() { if (opts) _rebuild(); },
    /** The view in km (for the frame grid to request). */
    get grid() { return view?.grid || null; },
    /** Draw a frame (or just the map, with null). Returns ms spent. */
    draw(frame) {
      const t0 = performance.now();
      if (!opts) return 0;
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(baseLayer, 0, 0);
      if (frame) {
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(_picture(frame), 0, 0, canvas.width, canvas.height);
      }
      g.drawImage(labelLayer, 0, 0);
      return performance.now() - t0;
    },
    /** A frame's precipitation picture and its scale (for tests: what colour is over a place). */
    pictureOf(frame) { const c = _picture(frame); return { canvas: c, px: (x, y) => projector({ ...view, w: c.width, h: c.height }).x(x), py: (y) => projector({ ...view, w: c.width, h: c.height }).y(y) }; },
    /** Pre-draw a frame's picture (e.g. while the loop's frames arrive). */
    prepare(frame) { if (opts && frame) _picture(frame); },
    dispose() { pictures.clear(); baseLayer = labelLayer = null; },
  };
}

// ── Legend and time ─────────────────────────────────────────────────────────

/** The colour legend: Rain, Mix, Snow, light → heavy. (CSS: radarLegendCSS.) */
export function radarLegendHTML() {
  const bar = (scale) => `<span class="rl-bar" style="background:linear-gradient(90deg,${scale.map(([, c], i) => `${c} ${(i / (scale.length - 1) * 100).toFixed(0)}%`).join(',')})"></span>`;
  return `<div class="radar-legend">
    <span class="rl-item"><span class="rl-name">Rain</span>${bar(RAIN_SCALE)}</span>
    <span class="rl-item"><span class="rl-name">Mix</span>${bar(MIX_SCALE)}</span>
    <span class="rl-item"><span class="rl-name">Snow</span>${bar(SNOW_SCALE)}</span>
    <span class="rl-ends"><span>Light</span><span>Heavy</span></span>
  </div>`;
}

export const radarLegendCSS = `
  .radar-legend{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;font-size:11px;font-weight:600;color:var(--soft);}
  .radar-legend .rl-item{display:flex;align-items:center;gap:6px;}
  .radar-legend .rl-bar{display:inline-block;height:8px;border-radius:4px;width:64px;}
  .radar-legend .rl-item:first-child .rl-bar{width:96px;}
  .radar-legend .rl-ends{display:flex;gap:8px;color:var(--muted);font-weight:500;margin-left:auto;}
  .radar-legend .rl-ends span:first-child::after{content:'→';margin-left:8px;}
`;

/**
 * formatFrameTime(t, tzMin, nowMs) — "2:30 PM", with the day when it isn't
 * today ("Tomorrow 1:00 AM", "Sat 4:00 PM"); in the save's clock.
 */
export function formatFrameTime(t, tzMin, nowMs) {
  const local = (ms) => new Date(ms + tzMin * 60_000);
  const d = local(t), n = local(nowMs);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const dayDiff = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 86_400_000);
  const day = dayDiff === 0 ? '' : dayDiff === 1 ? 'Tomorrow ' : dayDiff === -1 ? 'Yesterday ' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} `;
  return `${day}${h}:${m} ${ampm}`;
}
