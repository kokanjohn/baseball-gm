/**
 * engine/WeatherSystems.js
 * §100 (step 1c) What actually happens: the weather systems that cross the
 * league's region, and the precipitation they lay down at any place and
 * moment. The radar draws this field; every ballpark's weather is read from
 * it (step 1d); forecasts (step 1e) are predictions of it.
 *
 * Kinds of system:
 *   front   — a long band (a cold front) with lighter rain behind it; in the
 *             warm months its leading edge is a line of storms.
 *   shield  — a broad area of steady rain (a low, a warm front).
 *   squall  — a summer squall line: an intense, bowed leading edge racing
 *             ahead of the flow, a trough, then a wide trailing rain area.
 *             Forms in the late afternoon/evening, fades by morning, and
 *             sometimes falls apart early.
 *   showers — a cool, unsettled day: scattered small showers over a wide area.
 *   cell    — a pop-up thunderstorm (short-lived, small, intense), formed
 *             where the air is ripe (WeatherClimate.stormPotential).
 *
 * Every system comes from the save's seed and the time slot it forms in, so
 * the weather at any (x, y, t) is a pure function — computed the same way
 * every time, never stored, never re-rolled. Systems form both upstream and
 * over the region itself, move with the steering flow, build, peak and
 * decay; some break up early.
 *
 * Units: reflectivity, dBZ (as on real radar). ~15 dBZ is barely anything,
 * 20 light rain, 30 moderate, 40 heavy, 50 very heavy, 60+ hail-producing.
 */

import { stream, hash, hash01, fbm3, valueNoise3 } from './WeatherNoise.js';
import { normalsAt, steeringAt, stormPotential, airAt, localHour, diurnal, tempBiasAt, MS_HOUR } from './WeatherClimate.js';

export const DBZ_MIN = 12;                 // below this nothing shows on radar or reaches the ground
const SLOT_MS = 6 * MS_HOUR;               // synoptic systems are born in 6-hour slots
const MAX_LIFE_MS = 54 * MS_HOUR;          // no synoptic system lives longer than this
const CELL_GRID_KM = 36;                   // pop-up storms: one chance per grid square…
const CELL_SLOT_MS = 20 * 60_000;          // …per 20 minutes
const CELL_MAX_LIFE_MS = 2 * MS_HOUR;
const CELL_RATE = 0.075;                   // chance per square per slot at full storm potential
const SPAWN_X = [-1150, 350];              // where systems are born (km, west → east)
const SPAWN_Y = [-750, 750];

// ── Building systems (deterministic) ────────────────────────────────────────

const _slotCache = new Map();
const _cellCache = new Map();
const _cap = (m, n) => { if (m.size > n) m.clear(); };

/** Life on a 0..1 scale: build, hold, decay (faster after an early breakup). */
function _life(s, t) {
  if (t <= s.t0 || t >= s.t1) return 0;
  const up = Math.min(1, (t - s.t0) / s.rampMs);
  const downStart = Math.min(s.t1 - s.decayMs, s.breakAt ?? Infinity);
  const decay = s.breakAt != null && s.breakAt < s.t1 - s.decayMs ? s.breakDecayMs : s.decayMs;
  const down = t < downStart ? 1 : Math.max(0, 1 - (t - downStart) / decay);
  const v = Math.min(up, down);
  return v * v * (3 - 2 * v);
}

/** The synoptic systems born in one 6-hour slot. */
function _slotSystems(ctx, slot) {
  const key = `${ctx.seed}|${ctx.region}|${slot}`;
  const hit = _slotCache.get(key);
  if (hit) return hit;
  _cap(_slotCache, 4000);
  const t0Slot = slot * SLOT_MS;
  const N = normalsAt(ctx, t0Slot + SLOT_MS / 2);
  const warm = Math.max(0, Math.min(1, (N.hi - 68) / 18));          // 0 cool season … 1 midsummer
  const wetK = N.wet / 0.33;
  // Expected systems born per slot, by kind (tuned against each region's wet days, step 1g).
  const rate = {
    front:   0.19 * wetK * (1 - 0.35 * warm) * (1.15 - 0.5 * N.storms),
    shield:  0.15 * wetK * (1 - 0.6 * warm) * (1 - 0.5 * N.storms),
    squall:  0.22 * wetK * N.storms * warm,
    showers: 0.06 * wetK * (1 - warm) * (0.5 + N.storms),
  };
  const out = [];
  let k = 0;
  for (const [kind, lam] of Object.entries(rate)) {
    for (let j = 0; j < 3; j++) {
      const r = stream(ctx.seed, hash(ctx.region), slot, k++);
      if (r.next() >= lam / 3) continue;
      const t0 = t0Slot + r.next() * SLOT_MS;
      const s = _make(ctx, kind, r, t0, warm, N, `${slot}:${kind}:${j}`);
      if (s) out.push(s);
    }
  }
  _slotCache.set(key, out);
  return out;
}

function _make(ctx, kind, r, t0, warm, N, id) {
  const flow = steeringAt(ctx, t0 + 6 * MS_HOUR);
  let speedK = 1, life, ramp, decay, peak;
  const s = { id, kind, seed: hash(ctx.seed, hash(id)) };
  if (kind === 'squall') {
    // Squall lines form in the late afternoon/evening.
    const hour = localHour(t0, ctx.tzMin);
    const shift = ((17 + r.range(-2, 4) - hour + 24) % 24) * MS_HOUR;
    t0 += shift;
  }
  switch (kind) {
    case 'front':
      speedK = r.range(0.95, 1.3); life = r.range(26, 48); ramp = r.range(4, 9); decay = r.range(6, 12);
      // Cool-season fronts: wide, steady rain. Summer fronts: weak, narrow, often just a line of storms.
      peak = 36 + 2 * warm + r.range(0, 8);
      Object.assign(s, { len: r.range(600, 1100), wid: r.range(18, 40) * (1 - 0.4 * warm), trail: r.range(40, 140) * (1 - 0.6 * warm),
                         trailDbz: r.range(24, 32) - 4 * warm, tilt: r.range(-0.45, 0.05), curve: r.range(-60, 90), conv: 0.1 });
      // Some fronts come through with a line of thunderstorms — more often in the stormy months.
      if (r.chance(Math.min(0.9, 1.2 * N.storms))) { s.conv = 0.6 + 0.4 * warm; peak += 7; }
      break;
    case 'shield':
      speedK = r.range(0.65, 0.95); life = r.range(14, 32); ramp = r.range(3, 7); decay = r.range(4, 9);
      peak = r.range(29, 39) + 2 * warm;
      Object.assign(s, { len: r.range(200, 420), wid: r.range(120, 260), conv: 0.15 * N.storms });
      break;
    case 'squall':
      speedK = r.range(1.25, 1.65); life = r.range(8, 16); ramp = r.range(2, 4); decay = r.range(3, 6);
      peak = r.range(50, 60);
      Object.assign(s, { len: r.range(180, 420), wid: r.range(7, 14), trail: r.range(60, 150), trailDbz: r.range(29, 37),
                         tilt: r.range(-0.3, 0.3), curve: r.range(30, 90), conv: 1 });
      // A quarter of squall lines fall apart well before their time.
      if (r.chance(0.25)) s.breakFrac = r.range(0.25, 0.6);
      break;
    case 'showers':
      speedK = r.range(0.85, 1.1); life = r.range(8, 14); ramp = r.range(2, 3); decay = r.range(2, 4);
      peak = r.range(30, 40);
      Object.assign(s, { len: r.range(220, 380), wid: r.range(180, 300), conv: 0.5 });
      break;
    default: return null;
  }
  // Fronts and shields sometimes fizzle early too (less often than squall lines).
  if (kind !== 'squall' && r.chance(0.12)) s.breakFrac = r.range(0.35, 0.7);
  const vx = flow.u * speedK, vy = flow.v * speedK;
  const sp = Math.hypot(vx, vy) || 1;
  Object.assign(s, {
    t0, t1: t0 + life * MS_HOUR, rampMs: ramp * MS_HOUR, decayMs: decay * MS_HOUR,
    peakDbz: peak, vx, vy, mx: vx / sp, my: vy / sp,
    x0: r.range(SPAWN_X[0], SPAWN_X[1]), y0: r.range(SPAWN_Y[0], SPAWN_Y[1]),
    wobble: r.range(10, 35), wobbleP: r.range(0, 6.28), wobbleH: r.range(7, 14),
  });
  if (s.breakFrac != null) {
    s.breakAt = s.t0 + (s.t1 - s.t0) * s.breakFrac;
    s.breakDecayMs = r.range(1.2, 2.5) * MS_HOUR;
  }
  // The air a front brings (°F cooler behind it); a squall line's rain-cooled outflow.
  if (kind === 'front') s.drop = r.range(9, 18) * (1 - 0.45 * warm);
  if (kind === 'squall') s.drop = r.range(5, 11);
  return s;
}

/** Where a system's centre is at t (km) — in a forecast, where the run thinks it is. */
function _centre(s, t) {
  const h = (t - s.t0) / MS_HOUR;
  const w = s.wobble * Math.sin(h / s.wobbleH + s.wobbleP);
  let x = s.x0 + s.vx * h - s.my * w, y = s.y0 + s.vy * h + s.mx * w;
  if (s.fc) {
    const L = Math.max(0, (t - s.fc.issue) / MS_HOUR);
    const da = s.fc.ea * (TRACK_ALONG_KM_H * L + TRACK_ALONG_KM_H2 * L * L);   // timing: early or late
    const dc = s.fc.ec * (TRACK_ACROSS_KM_H * L + TRACK_ACROSS_KM_H2 * L * L); // track: north or south of where it goes
    x += s.mx * da - s.my * dc; y += s.my * da + s.mx * dc;
  }
  return [x, y];
}

/**
 * Pop-up storms born in one grid square in one 20-minute slot. `model`
 * (forecasts only): the run's own storms — placed from its own seed, set
 * off by the run's read of the day (the true trigger at short range,
 * its own guess further out).
 */
function _cellWorld(ctx, model) {
  const wk = `${ctx.seed}|${ctx.region}${model ? `|${model.key}` : ''}`;
  let world = _cellCache.get(wk);
  if (!world) { _cap(_cellCache, 400); world = new Map(); _cellCache.set(wk, world); }
  return world;
}

function _cellsAt(ctx, gx, gy, slot, model = null, world = _cellWorld(ctx, model)) {
  // Numeric keys inside a map per world (truth, or a run's own storms): this is the hot path.
  const key = (slot * 256 + (gx + 128)) * 256 + (gy + 128);
  const hit = world.get(key);
  if (hit) return hit;
  if (world.size > 200000) world.clear();
  const placeSeed = model ? model.placeSeed : ctx.seed;
  const r = stream(placeSeed, hash(ctx.region, 7), gx, gy, slot);
  const roll = r.next();
  let out = [];
  // Cheap pre-check: no chance at all in the small hours.
  const tMid = slot * CELL_SLOT_MS + CELL_SLOT_MS / 2;
  const hour = localHour(tMid, ctx.tzMin);
  if (hour >= 9 || hour < 2) {
    const x = (gx + r.next()) * CELL_GRID_KM, y = (gy + r.next()) * CELL_GRID_KM;
    // Some days the air is ripe but nothing sets it off; some days storms go up everywhere.
    // Zones a few hundred km across: quiet in some, storms going up together in others.
    const trig = (sd) => {
      const z = 0.5 + 0.5 * valueNoise3(hash(sd, 31), x / 260, y / 260, tMid / (16 * MS_HOUR));
      // …and a regime across the whole region: some days storms go up everywhere,
      // some days hardly anywhere.
      const regime = Math.max(0, Math.min(1, 0.5 + 0.9 * valueNoise3(hash(sd, 32), 0.5, 0.5, tMid / (30 * MS_HOUR))));
      return Math.max(0, z - 0.38) * 3.6 * (0.15 + 1.25 * regime * regime);
    };
    let trigger = trig(ctx.seed);
    if (model) {
      // How well the run reads the day: the truth up close, its own guess a few days out.
      const w = Math.min(1, Math.max(0, (tMid - model.issue) / MS_HOUR) / CELL_TRIGGER_LEAD_H);
      trigger = trigger * (1 - w) + trig(model.placeSeed) * w;
    }
    const p = stormPotential(ctx, x, y, tMid) * trigger * CELL_RATE;
    if (roll < p) {
      const flow = steeringAt(ctx, tMid);
      const n = r.chance(0.35) ? r.int(2, 3) : 1;   // multicell clusters
      for (let i = 0; i < n; i++) {
        const t0 = slot * CELL_SLOT_MS + r.next() * CELL_SLOT_MS + i * r.range(15, 35) * 60_000;
        const sk = r.range(0.35, 0.7);
        const vx = flow.u * sk, vy = flow.v * sk, sp = Math.hypot(vx, vy) || 1;
        out.push({
          id: `${model ? 'm' : 'c'}${gx}:${gy}:${slot}:${i}`, kind: 'cell', seed: hash(placeSeed, gx, gy, slot, i),
          t0, t1: t0 + r.range(45, 105) * 60_000, rampMs: r.range(12, 22) * 60_000, decayMs: r.range(18, 35) * 60_000,
          // Most storms are modest; a few are severe.
          peakDbz: 36 + 26 * r.next() ** 1.7, rad: 3 + 8 * r.next() ** 1.4, anvil: r.range(8, 26),
          stretch: r.range(1, 1.9), turn: r.range(-0.6, 0.6),
          lobes: Array.from({ length: r.int(1, 3) }, (_, k) => k === 0 ? [0, 0, 1] : [r.range(-1.3, 1.3), r.range(-1.3, 1.3), r.range(0.45, 0.85)]),
          x0: x + (i ? r.range(-14, 14) : 0), y0: y + (i ? r.range(-14, 14) : 0), vx, vy, mx: vx / sp, my: vy / sp,
          wobble: 0, wobbleP: 0, wobbleH: 1, conv: 1,
        });
      }
    }
  }
  world.set(key, out);
  return out;
}

// ── The systems active at a moment ──────────────────────────────────────────

/** A generous radius (km) around a system's centre outside of which it's nothing. */
function _reach(s) {
  switch (s.kind) {
    case 'front':   return s.len / 2 + s.trail + 160;
    case 'squall':  return s.len / 2 + s.trail + 120;
    case 'shield':  return Math.max(s.len, s.wid) * 0.8 + 60;
    case 'showers': return Math.max(s.len, s.wid) * 0.7 + 40;
    default:        return s.rad * 3 + s.anvil + 10;
  }
}

/**
 * activeSystems(ctx, t, bounds) — the systems alive at t that can touch the
 * box { x0, y0, x1, y1 } (km): [{ s, cx, cy, life }].
 */
export function activeSystems(ctx, t, bounds, cellBounds = bounds) {
  const out = [];
  const inBox = (b, s, cx, cy) => {
    const R = _reach(s);
    return cx + R >= b.x0 && cx - R <= b.x1 && cy + R >= b.y0 && cy - R <= b.y1;
  };
  const near = (s, cx, cy) => inBox(bounds, s, cx, cy);
  const nearCell = (s, cx, cy) => inBox(cellBounds, s, cx, cy);
  for (let slot = Math.floor((t - MAX_LIFE_MS) / SLOT_MS); slot <= Math.floor(t / SLOT_MS) + 1; slot++) {
    for (const s of _viewSlot(ctx, slot)) {
      const life = _life(s, t);
      if (life <= 0) continue;
      const [cx, cy] = _centre(s, t);
      if (near(s, cx, cy)) out.push({ s, cx, cy, life });
    }
  }
  const pad = 40, cb = cellBounds;
  const gx0 = Math.floor((cb.x0 - pad) / CELL_GRID_KM), gx1 = Math.floor((cb.x1 + pad) / CELL_GRID_KM);
  const gy0 = Math.floor((cb.y0 - pad) / CELL_GRID_KM), gy1 = Math.floor((cb.y1 + pad) / CELL_GRID_KM);
  const sl0 = Math.floor((t - CELL_MAX_LIFE_MS - 3 * 35 * 60_000) / CELL_SLOT_MS), sl1 = Math.floor(t / CELL_SLOT_MS);
  const run = ctx.run, model = run ? _modelOf(ctx) : null;
  const wT = _cellWorld(ctx, null), wM = model ? _cellWorld(ctx, model) : null;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) for (let sl = sl0; sl <= sl1; sl++) {
    // In a forecast: the storms already up when the run was made (nowcast),
    // then the run's own storms after that.
    const slotStart = sl * CELL_SLOT_MS;
    const lists = !run ? [_cellsAt(ctx, gx, gy, sl, null, wT)]
      : slotStart + CELL_SLOT_MS <= run.issueMs + NOWCAST_MS ? [_cellsAt(ctx, gx, gy, sl, null, wT).filter(c => c.t0 <= run.issueMs + NOWCAST_MS)]
      : slotStart >= run.issueMs + NOWCAST_MS ? [_cellsAt(ctx, gx, gy, sl, model, wM)]
      : [_cellsAt(ctx, gx, gy, sl, null, wT).filter(c => c.t0 <= run.issueMs + NOWCAST_MS), _cellsAt(ctx, gx, gy, sl, model, wM).filter(c => c.t0 > run.issueMs + NOWCAST_MS)];
    for (const list of lists) for (const s of list) {
      const life = _life(s, t);
      if (life <= 0) continue;
      const [cx, cy] = _centre(s, t);
      if (nearCell(s, cx, cy)) out.push({ s, cx, cy, life });
    }
  }
  return out;
}

// ── Forecasts: the same weather, as a run made at one hour sees it ──────────
//
// A run (ctx.run = { issueMs, member }) knows every system that exists when
// it's made. Its errors grow with lead time and change only a little from one
// hourly run to the next, so forecasts firm up as the time approaches:
//   - timing (early/late) and track (north/south) errors on every system;
//   - strength errors; smoother, less detailed rain at long range;
//   - an early breakup is only seen a few hours ahead — before that, the
//     run shows the system arriving;
//   - systems not yet born are foreseen with a chance that rises as they
//     approach (fronts days ahead, squall lines only hours ahead), and runs
//     also show "phantom" systems that never happen, which fade away as
//     their time nears;
//   - pop-up storms: the ones already up are tracked (nowcast); after that
//     the run places its own, from the true trigger at short range and its
//     own guess further out.
// At lead 0 a run is exactly the truth.

const TRACK_ALONG_KM_H = 1.5, TRACK_ALONG_KM_H2 = 0.008;     // timing error (s.d., km) ≈ 1.5·L + 0.008·L²
const TRACK_ACROSS_KM_H = 1.0, TRACK_ACROSS_KM_H2 = 0.006;   // track error ≈ 1.0·L + 0.006·L²
const PEAK_ERR_DBZ_H = 0.15, PEAK_ERR_MAX = 8;               // strength error grows to ±8 dBZ
const BREAK_SEEN_MS = 4 * MS_HOUR;                           // breakups are seen this far ahead
const NOWCAST_MS = 60 * 60_000;                              // storms up within this of the run are tracked (stands in for minute-by-minute nowcast updates between hourly runs)
const CELL_TRIGGER_LEAD_H = 60;                              // the run's read of where storms fire fades to a guess by here
const RUN_DRIFT_H = 9;                                       // a run's errors change over about this many runs
const MODEL_CELL_BUCKET_MS = 6 * MS_HOUR;                    // the run's own storm placement refreshes every 6 runs
const FORESEE_TAU_H = { front: 130, shield: 72, squall: 14, showers: 36 };
const PHANTOM_SHARE = 0.85;                                   // phantoms keep long-range forecasts as wet as the climate

const _viewCache = new Map();

/** A forecast context: the run made at the hour containing `nowMs` (member 0 = the forecast; others = ensemble). */
export function forecastContext(ctx, nowMs, member = 0) {
  return { ...ctx, run: { issueMs: Math.floor(nowMs / MS_HOUR) * MS_HOUR, member } };
}

function _runNoise(seed, k, member, issueMs) {
  // ≈ unit spread, smooth from one hourly run to the next.
  return 2.4 * valueNoise3(hash(seed, 950 + k, member), issueMs / MS_HOUR / RUN_DRIFT_H, 0.37, 0.71);
}

function _modelOf(ctx) {
  const run = ctx.run;
  if (run._model) return run._model;
  const bucket = Math.floor(run.issueMs / MODEL_CELL_BUCKET_MS);
  run._model = { key: `m${run.member}|${bucket}|${run.issueMs}`, placeSeed: `${ctx.seed}~cells~${run.member}~${bucket}`, issue: run.issueMs };
  return run._model;
}

/** The synoptic systems of one slot as the run sees them (truth when there's no run). */
function _viewSlot(ctx, slot) {
  const truth = _slotSystems(ctx, slot);
  const run = ctx.run;
  if (!run) return truth;
  const key = `${ctx.seed}|${ctx.region}|${slot}|${run.issueMs}|${run.member}`;
  const hit = _viewCache.get(key);
  if (hit) return hit;
  _cap(_viewCache, 20000);
  const out = [];
  for (const s of truth) {
    if (s.t0 > run.issueMs) {
      const lead = (s.t0 - run.issueMs) / MS_HOUR;
      if (hash01(s.seed, 901, run.member) >= Math.exp(-lead / FORESEE_TAU_H[s.kind])) continue;   // not foreseen (yet)
    }
    out.push(_forecastCopy(s, run));
  }
  // Phantoms: systems the run shows that never happen.
  for (const ph of _slotSystems({ ...ctx, seed: `${ctx.seed}~ph~${run.member}` }, slot)) {
    if (ph.t0 <= run.issueMs) continue;
    const lead = (ph.t0 - run.issueMs) / MS_HOUR;
    if (hash01(ph.seed, 911) >= PHANTOM_SHARE * (1 - Math.exp(-lead / FORESEE_TAU_H[ph.kind]))) continue;
    out.push(_forecastCopy({ ...ph, id: `ph:${ph.id}`, phantom: true }, run));
  }
  _viewCache.set(key, out);
  return out;
}

function _forecastCopy(s, run) {
  const c = { ...s, fc: {
    issue: run.issueMs,
    ea: _runNoise(s.seed, 0, run.member, run.issueMs),
    ec: _runNoise(s.seed, 1, run.member, run.issueMs),
    ep: _runNoise(s.seed, 2, run.member, run.issueMs),
    el: _runNoise(s.seed, 3, run.member, run.issueMs),
  } };
  // An early breakup more than a few hours off isn't in the run.
  if (s.breakAt != null && s.breakAt - run.issueMs > BREAK_SEEN_MS) { c.breakAt = undefined; c.breakFrac = undefined; }
  // When it winds down is uncertain too (once that's still ahead).
  if (s.t1 - s.decayMs > run.issueMs) c.t1 = s.t1 + c.fc.el * Math.min(6 * MS_HOUR, 0.06 * (s.t1 - run.issueMs));
  return c;
}

/** A forecast's strength error at t (dBZ); 0 for the truth. */
function _peakAdj(s, t) {
  if (!s.fc) return 0;
  const L = Math.max(0, (t - s.fc.issue) / MS_HOUR);
  return Math.max(-PEAK_ERR_MAX, Math.min(PEAK_ERR_MAX, s.fc.ep * PEAK_ERR_DBZ_H * L));
}

/** How much fine detail a forecast keeps at t (1 = all, as the truth). */
function _detail(s, t) {
  if (!s.fc) return 1;
  return Math.max(0.45, 1 - Math.max(0, (t - s.fc.issue) / MS_HOUR) / 30);
}

// ── Reflectivity from one system at a point ─────────────────────────────────

const _sst = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** dBZ from one active system at (x, y, t), or −Infinity. */
function _systemDbz(a, x, y, t) {
  const { s, cx, cy, life } = a;
  const dx = x - cx, dy = y - cy;
  const along = dx * s.mx + dy * s.my;        // + is ahead (downstream)
  const across = -dx * s.my + dy * s.mx;
  const ageH = (t - s.t0) / MS_HOUR;
  const adj = _peakAdj(s, t), det = _detail(s, t);
  let v = 0;
  switch (s.kind) {
    case 'front':
    case 'squall': {
      // Distance ahead of the line; the line is tilted, bowed and ragged.
      const u = across / (s.len / 2);
      if (Math.abs(u) > 1.3) return -Infinity;
      // Cheap bound before any texture: well ahead of the line or past the trailing rain.
      const n0 = along - s.tilt * across - s.curve * (1 - Math.min(1, u * u));
      if (n0 > s.wid * 3 + 45 || -n0 > s.trail * 1.25 + 45) return -Infinity;
      const warp = 22 * fbm3(s.seed, across / 70, along / 70, ageH / 6, 3) + 7 * fbm3(s.seed + 7, across / 14, along / 14, ageH / 1.5, 2);
      const n = along - s.tilt * across - s.curve * (1 - Math.min(1, u * u)) + warp;
      const endNoise = 0.3 * fbm3(s.seed + 1, across / 120, along / 120, ageH / 8, 2);
      const ends = _sst(1.2, 0.6, Math.abs(u) + endNoise);
      if (ends <= 0) return -Infinity;
      const isSq = s.kind === 'squall';
      // The leading edge: a line of storms in the warm months, a band of rain otherwise.
      const lead = Math.exp(-((n / s.wid) ** 2)) * (n > 0 ? 1 : Math.exp(-((n / (s.wid * 1.6)) ** 2)) ** 0.2);
      const tex = det * fbm3(s.seed + 2, along / (isSq ? 10 : 18), across / (isSq ? 12 : 26), ageH / 1.2, 4);
      const cells = s.conv > 0.15 ? Math.max(0.05, 0.5 + s.conv * 1.3 * tex) : Math.max(0.1, 0.75 + 0.6 * tex);
      // Behind it, after a lighter gap: a wide area of steadier rain.
      const back = -n;
      let trail = 0;
      if (back > 0 && back < s.trail * 1.2) {
        const gap = isSq ? 0.35 + 0.65 * _sst(s.wid * 1.2, s.wid * 3.5, back) : _sst(0, s.wid * 1.5, back);
        // Rounded: the trailing rain is an arc behind the line, not a box.
        const rr = Math.hypot(Math.abs(u) * 1.05, back / s.trail) + endNoise;
        trail = gap * _sst(1.1, 0.55, rr) * Math.max(0, 0.6 + 0.8 * det * fbm3(s.seed + 3, along / 45, across / 45, ageH / 4, 4));
      }
      const leadDbz = _toDbz(s.peakDbz + adj, lead * cells * ends * a.life);
      const trailDbz = _toDbz(s.trailDbz + adj, trail * a.life);
      return _sum([leadDbz, trailDbz]);
    }
    case 'shield': {
      if (Math.hypot(along / s.len, across / s.wid) > 1.8) return -Infinity;
      const warp = 0.3 * fbm3(s.seed, along / 120, across / 120, ageH / 6, 3) + 0.12 * fbm3(s.seed + 9, along / 25, across / 25, ageH / 2, 3);
      const rr = Math.hypot(along / s.len, across / s.wid) + warp;
      if (rr > 1.3) return -Infinity;
      const body = _sst(1.08, 0.5, rr);
      const bands = 0.6 + 0.4 * Math.sin(across / 28 + 3 * fbm3(s.seed + 1, along / 80, across / 80, ageH / 5, 2));
      const tex = det * fbm3(s.seed + 2, along / 35, across / 35, ageH / 3, 4);
      // Gaps and lighter patches inside the rain area.
      v = body * (0.55 + 0.45 * bands) * Math.max(0, 0.55 + 0.9 * tex);
      break;
    }
    case 'showers': {
      const rr = Math.hypot(along / s.len, across / s.wid);
      if (rr > 1.1) return -Infinity;
      const area = _sst(1.1, 0.6, rr);
      const hf = fbm3(s.seed, along / 11, across / 11, ageH / 1.2, 3);
      v = area * Math.max(0, hf - 0.18) / 0.55;
      break;
    }
    case 'cell': {
      if (Math.abs(along) > s.rad * 4 + s.anvil + 10 || Math.abs(across) > s.rad * 4 + 10) return -Infinity;
      // An irregular, somewhat elongated cell, its outline shifting as it lives.
      const ca = Math.cos(s.turn), sa = Math.sin(s.turn);
      const p = along * ca - across * sa, q = along * sa + across * ca;
      const wob = 1 + 0.45 * fbm3(s.seed + 5, p / (s.rad * 1.2), q / (s.rad * 1.2), ageH * 1.5, 3);
      let core = 0;
      for (const [lx, ly, lk] of s.lobes) {
        const el = Math.hypot((p - lx * s.rad) / s.stretch, q - ly * s.rad) / (s.rad * wob * (0.6 + 0.4 * lk));
        core = Math.max(core, lk * Math.exp(-(el * el)));
      }
      core *= 0.8 + 0.4 * fbm3(s.seed, along / 4, across / 4, ageH * 3, 2);
      const an = along > 0 ? 0.18 * Math.exp(-((across / (s.rad * 1.6)) ** 2)) * _sst(s.anvil + s.rad, s.rad, along) : 0;
      v = Math.max(core, an);
      break;
    }
  }
  return _toDbz(s.peakDbz + adj, v * life);
}

/** Shape strength (0..~1.2) → dBZ: full strength is the system's peak; each halving is about 7.5 dBZ less. */
function _toDbz(peak, v) {
  if (!(v > 0.01)) return -Infinity;
  return peak + 25 * Math.log10(Math.min(1.2, v));
}

// ── The field ───────────────────────────────────────────────────────────────

export const PRECIP_RAIN = 0, PRECIP_MIX = 1, PRECIP_SNOW = 2;

/** Rain, mix or snow from the air temperature (heavier precipitation drags the air colder). */
export function precipKind(tempF, dbz) {
  const t = tempF - (dbz > 28 ? Math.min(3, (dbz - 28) / 5) : 0);
  return t <= 32.5 ? PRECIP_SNOW : t <= 35.5 ? PRECIP_MIX : PRECIP_RAIN;
}

/** Combine reflectivities the way radar does: add the powers. */
function _sum(dbzs) {
  let z = 0;
  for (const d of dbzs) z += _power(d);
  return z > 0 ? 10 * Math.log10(z) : -Infinity;
}
const _power = (d) => (d > -Infinity ? 10 ** (d / 10) : 0);

// ── Clouds and the air fronts bring ─────────────────────────────────────────

const FRONT_LINGER_MS = 18 * MS_HOUR;   // a front's air stays most of a day after its rain is gone
const CLOUD_MEAN = 0.45;                // an average sky — temperatures are normal under it
const TEMP_ERR_F_DAY = 1.6, TEMP_ERR_MAX_F = 3.6;   // a forecast's own temperature error: s.d. 1.6 °F at a day, growing with √lead to 3.6
const CLOUD_PAD_KM = 220;               // a big system's cloud reaches this far beyond its rain
const CELL_CLOUD_PAD_KM = 60;           // a thunderstorm's anvil, this far

/** A front's / squall line's geometry at a point: n (km ahead of the line, + ahead), u (along it, −1..1 over its length). */
function _lineAt(s, x, y, t) {
  const [cx, cy] = _centre(s, t);
  const dx = x - cx, dy = y - cy;
  const along = dx * s.mx + dy * s.my, across = -dx * s.my + dy * s.mx;
  const u = across / (s.len / 2);
  return { n: along - s.tilt * across - s.curve * (1 - Math.min(1, u * u)), u, along, across };
}

/**
 * frontAir(ctx, x, y, t) — what fronts and squall lines do to the air here:
 * { dT, dDew (°F), behind, ahead (0..1 — how far into the cold air / warm
 * sector), outflow (0..1 — in a squall line's rain-cooled outflow) }.
 * A front's air lingers a day after its rain is gone, fading smoothly.
 */
export function frontAir(ctx, x, y, t) {
  // The strongest effect of each kind counts — fronts don't stack.
  let cold = 0, coldDew = 0, warm = 0, warmDew = 0, behind = 0, ahead = 0, outflow = 0, outT = 0, outDew = 0;
  const first = Math.floor((t - MAX_LIFE_MS - FRONT_LINGER_MS) / SLOT_MS), last = Math.floor(t / SLOT_MS);
  for (let slot = first; slot <= last; slot++) {
    for (const s of _viewSlot(ctx, slot)) {
      if ((s.kind !== 'front' && s.kind !== 'squall') || t <= s.t0) continue;
      if (s.kind === 'front') {
        if (t >= s.t1 + FRONT_LINGER_MS) continue;
        const up = Math.min(1, (t - s.t0) / s.rampMs);
        const w0 = t < s.t1 ? up : 1 - (t - s.t1) / FRONT_LINGER_MS;
        const w = w0 * w0 * (3 - 2 * w0);
        if (w <= 0) continue;
        const L = _lineAt(s, x, y, t);
        const span = _sst(1.7, 1.0, Math.abs(L.u));
        if (span <= 0) continue;
        // The cold air behind it (modified as it moves on), the warm sector ahead.
        const b = _sst(0, 140, -L.n) * _sst(1400, 500, -L.n) * span * w;
        const a = _sst(-10, 25, L.n) * _sst(500, 120, L.n) * span * w;
        cold = Math.max(cold, s.drop * b); coldDew = Math.max(coldDew, 0.8 * s.drop * b);
        warm = Math.max(warm, 0.6 * s.drop * a); warmDew = Math.max(warmDew, 0.3 * s.drop * a);
        behind = Math.max(behind, b); ahead = Math.max(ahead, a);
      } else {
        const life = _life(s, t);
        if (life <= 0) continue;
        const L = _lineAt(s, x, y, t);
        if (Math.abs(L.u) > 1.3) continue;
        const o = _sst(-5, 12, -L.n) * _sst(s.trail * 1.3, s.trail * 0.6, -L.n) * _sst(1.25, 0.8, Math.abs(L.u)) * life;
        outT = Math.max(outT, s.drop * o); outDew = Math.max(outDew, 0.3 * s.drop * o);
        outflow = Math.max(outflow, o);
      }
    }
  }
  // Inside the cold air the warm sector doesn't apply.
  const dT = -cold - outT + warm * (1 - behind), dDew = -coldDew - outDew + warmDew * (1 - behind);
  return { dT, dDew, behind, ahead: ahead * (1 - behind), outflow };
}

/** How much of the sky one system's clouds cover at a point (0..1). */
function _systemCloud(a, x, y, t) {
  const { s, cx, cy, life } = a;
  const dx = x - cx, dy = y - cy;
  const along = dx * s.mx + dy * s.my, across = -dx * s.my + dy * s.mx;
  const lit = Math.sqrt(life);   // clouds build before the rain and linger after it
  switch (s.kind) {
    case 'front':
    case 'squall': {
      const L = _lineAt(s, x, y, t);
      const aheadKm = s.kind === 'squall' ? 110 : 60 + s.wid;
      const v = _sst(aheadKm + 60, aheadKm, L.n) * _sst(-(s.trail + 200), -(s.trail + 120), L.n) * _sst(1.4, 1.0, Math.abs(L.u));
      return v * lit;
    }
    case 'shield':  return _sst(1.15, 0.75, Math.hypot(along / (s.len * 1.5), across / (s.wid * 1.5))) * lit;
    case 'showers': return 0.8 * _sst(1.15, 0.7, Math.hypot(along / (s.len * 1.2), across / (s.wid * 1.2))) * lit;
    default: {
      const ex = along > 0 ? Math.max(0, along - s.anvil * 1.6) : along;
      return 0.85 * _sst(1.2, 0.45, Math.hypot(ex, across) / (s.rad * 3.5)) * lit;
    }
  }
}

/**
 * cloudAt(ctx, x, y, t) — sky cover 0 (clear) .. 1 (overcast): the systems'
 * cloud (wider than their rain) over a background of everyday cloud that
 * drifts with the flow, and fair-weather cumulus on humid afternoons.
 */
export function cloudAt(ctx, x, y, t, air = null) {
  const pad = CLOUD_PAD_KM;
  let sys = 0;
  const cp = CELL_CLOUD_PAD_KM;
  for (const a of activeSystems(ctx, t, { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad }, { x0: x - cp, y0: y - cp, x1: x + cp, y1: y + cp })) {
    sys = Math.max(sys, _systemCloud(a, x, y, t));
    if (sys >= 0.999) break;
  }
  const h = t / MS_HOUR;
  let bg = 0.06 + 0.5 * Math.max(0, 0.5 + 0.6 * fbm3(hash(ctx.seed, 41), (x - 30 * h) / 420, y / 420, h / 30, 3));
  const hour = localHour(t, ctx.tzMin);
  const dew = (air || airAt(ctx, x, y, t)).dewF;
  if (hour > 10.5 && hour < 19.5 && dew > 50) bg += 0.22 * Math.sin(Math.PI * (hour - 10.5) / 9) * Math.min(1, (dew - 50) / 16);
  bg = Math.max(0, Math.min(0.95, bg));
  return 1 - (1 - bg) * (1 - sys);
}

/**
 * surfaceTemp(ctx, x, y, t) — the air at the surface, before any rain cools
 * it: the background (WeatherClimate.airAt) with the sky (sunny days run
 * warmer, cloudy ones cooler; clear nights colder, cloudy ones milder) and
 * the fronts. { tempF, dewF, cloud }.
 */
export function surfaceTemp(ctx, x, y, t) {
  const air = airAt(ctx, x, y, t);
  const cloud = cloudAt(ctx, x, y, t, air);
  const N = normalsAt(ctx, t);
  const range = N.hi - N.lo, dh = diurnal(localHour(t, ctx.tzMin));
  const f = frontAir(ctx, x, y, t);
  // (Less the calibration: clouds, fronts and rain-cooled air average out to the normals.)
  let tempF = air.tempF + (CLOUD_MEAN - cloud) * range * (0.42 * dh - 0.22 * (1 - dh)) + f.dT - tempBiasAt(N, localHour(t, ctx.tzMin));
  // A forecast's own temperature error: small tomorrow, several degrees a week out.
  if (ctx.run && t > ctx.run.issueMs) {
    const L = (t - ctx.run.issueMs) / MS_HOUR;
    const sd = Math.min(TEMP_ERR_MAX_F, TEMP_ERR_F_DAY * Math.sqrt(L / 24));
    tempF += sd * 2.4 * valueNoise3(hash(ctx.seed, 960, ctx.run.member), x / 700, y / 700, t / (30 * MS_HOUR) + ctx.run.issueMs / MS_HOUR / 40);
  }
  const dewF = Math.min(air.dewF + f.dDew, tempF - 0.5);
  return { tempF, dewF, cloud, front: f };
}

/**
 * stormNear(ctx, x, y, t, km) — the strongest thunderstorm reflectivity
 * within `km` of a point (−Infinity when none): what decides "lightning in
 * the area" (a game stops when it's within about 10 miles).
 */
export function stormNear(ctx, x, y, t, km = 16) {
  let best = -Infinity;
  const act = activeSystems(ctx, t, { x0: x - km, y0: y - km, x1: x + km, y1: y + km }).filter(a => a.s.conv > 0.5);
  if (!act.length) return best;
  const pts = [[0, 0]];
  for (let r = km / 2; r <= km; r += km / 2) for (let i = 0; i < 8; i++) pts.push([Math.cos(i * Math.PI / 4) * r, Math.sin(i * Math.PI / 4) * r]);
  for (const a of act) for (const [ox, oy] of pts) best = Math.max(best, _systemDbz(a, x + ox, y + oy, t));
  return best;
}

// ── Rain, mix or snow: one temperature for the radar and the ballparks ──────
// The surface temperature that decides rain / mix / snow is read from a fixed
// lattice (every 24 km, anchored to the map, every 15 minutes) and
// interpolated — the same numbers whether the radar or a ballpark asks, so
// the radar's colour over a park always matches what the park reports.

const LAT_KM = 24, LAT_MS = 15 * 60_000;
const _latCache = new Map();

function _latNode(ctx, i, j, k) {
  const key = `${ctx.seed}|${ctx.region}|${i}|${j}|${k}${ctx.run ? `|${ctx.run.issueMs}|${ctx.run.member}` : ''}`;
  let v = _latCache.get(key);
  if (v === undefined) {
    _cap(_latCache, 200000);
    v = surfaceTemp(ctx, i * LAT_KM, j * LAT_KM, k * LAT_MS).tempF;
    _latCache.set(key, v);
  }
  return v;
}

/** The temperature (°F) that decides rain / mix / snow at (x, y, t). */
export function precipTemp(ctx, x, y, t) {
  const fx = x / LAT_KM, fy = y / LAT_KM, ft = t / LAT_MS;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(ft);
  const ax = fx - i, ay = fy - j, at = ft - k;
  const plane = (kk) => {
    const a = _latNode(ctx, i, j, kk), b = _latNode(ctx, i + 1, j, kk);
    const c = _latNode(ctx, i, j + 1, kk), d = _latNode(ctx, i + 1, j + 1, kk);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  };
  return plane(k) * (1 - at) + plane(k + 1) * at;
}

/**
 * precipAt(ctx, x, y, t) — what's falling at a point:
 * { dbz, kind, rateMmH, convective } (dbz −Infinity / rate 0 when dry).
 */
export function precipAt(ctx, x, y, t, opts = null) {
  const act = activeSystems(ctx, t, { x0: x, y0: y, x1: x, y1: y });
  let conv = 0;
  const parts = act.map(a => {
    const d = _systemDbz(a, x, y, t);
    if (d > DBZ_MIN && a.s.conv > 0.5 && d > 38) conv = 1;
    return d;
  });
  const dbz = _sum(parts);
  if (!(dbz > DBZ_MIN)) return { dbz: -Infinity, kind: PRECIP_RAIN, rateMmH: 0, convective: false };
  // (opts.kind === false: the caller knows it can't be snow — skip the temperature.)
  const kind = opts && opts.kind === false ? PRECIP_RAIN : precipKind(precipTemp(ctx, x, y, t), dbz);
  // How much rain the echo delivers: the radar's rule, times the climate's calibration.
  const out = { dbz, kind, rateMmH: rainRate(dbz) * normalsAt(ctx, t).rainK, convective: !!conv };
  // (opts.parts: which systems it came from — for the tuning tool.)
  if (opts && opts.parts) out.parts = act.map((a, i) => ({ kind: a.s.kind, dbz: parts[i] })).filter(p => p.dbz > -Infinity);
  return out;
}

/**
 * Marshall–Palmer: rain rate (mm/h) from reflectivity, capped at 53 dBZ as
 * radar rainfall estimates are (stronger echoes are hail, not more rain).
 */
export const RAIN_DBZ_CAP = 53;
export function rainRate(dbz) {
  if (!(dbz > DBZ_MIN)) return 0;
  return ((10 ** (Math.min(dbz, RAIN_DBZ_CAP) / 10)) / 200) ** (1 / 1.6);
}

/**
 * radarField(ctx, t, bounds, cellKm) — the whole picture for a radar frame:
 * { x0, y0, cellKm, nx, ny, dbz: Float32Array (row 0 = north), kind: Uint8Array }.
 * Each cell is exactly what precipAt reports at the cell's centre.
 */
export function radarField(ctx, t, bounds, cellKm) {
  const nx = Math.max(1, Math.round((bounds.x1 - bounds.x0) / cellKm));
  const ny = Math.max(1, Math.round((bounds.y1 - bounds.y0) / cellKm));
  const dbz = new Float32Array(nx * ny).fill(-Infinity);
  const kind = new Uint8Array(nx * ny);
  const act = activeSystems(ctx, t, bounds);
  if (act.length) {
    // Each system only touches the cells within its reach.
    const z = new Float64Array(nx * ny);
    for (const a of act) {
      const R = _reach(a.s);
      const c0 = Math.max(0, Math.floor((a.cx - R - bounds.x0) / cellKm)), c1 = Math.min(nx - 1, Math.ceil((a.cx + R - bounds.x0) / cellKm));
      const r0 = Math.max(0, Math.floor((bounds.y1 - (a.cy + R)) / cellKm)), r1 = Math.min(ny - 1, Math.ceil((bounds.y1 - (a.cy - R)) / cellKm));
      for (let r = r0; r <= r1; r++) {
        const y = bounds.y1 - (r + 0.5) * cellKm;
        for (let c = c0; c <= c1; c++) {
          z[r * nx + c] += _power(_systemDbz(a, bounds.x0 + (c + 0.5) * cellKm, y, t));
        }
      }
    }
    for (let i = 0; i < nx * ny; i++) {
      if (z[i] <= 0) continue;
      const d = 10 * Math.log10(z[i]);
      if (!(d > DBZ_MIN)) continue;
      dbz[i] = d;
      const x = bounds.x0 + ((i % nx) + 0.5) * cellKm, y = bounds.y1 - (Math.floor(i / nx) + 0.5) * cellKm;
      kind[i] = precipKind(precipTemp(ctx, x, y, t), d);
    }
  }
  return { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1, cellKm, nx, ny, dbz, kind };
}
