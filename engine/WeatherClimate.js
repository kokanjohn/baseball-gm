/**
 * engine/WeatherClimate.js
 * §100 (step 1b) The background the weather plays out against: what time of
 * year it is on the baseball calendar, the region's normals for that day, the
 * day/night temperature cycle, warm and cold spells that drift west to east,
 * geography (colder to the north, calmer near big water, colder up high), the
 * steering flow that moves weather systems, and how ripe the air is for
 * storms. The weather systems (step 1c) are built on top of this.
 *
 * Pure: every answer is a function of a weather context and a moment. The
 * context comes from the save (weatherContext(state)) but nothing here reads
 * or writes state. No Math.random — WeatherNoise only.
 */

import { REGION_CLIMATE, CLIMATE_FIRST_MONTH } from '../data/region-climate.js';
import { SPRING_START_MONTH, SPRING_START_DAY } from '../data/constants.js';
import { WEATHER_CALIBRATION } from '../data/weather-calibration.js';
import { regionMap, maskAt, waterKmAt, MASK_RELIEF } from './WeatherMap.js';
import { hash, fbm2, fbm3, valueNoise2 } from './WeatherNoise.js';

export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

// ── The weather context ─────────────────────────────────────────────────────

/**
 * weatherContext(state) — everything the weather needs from a save:
 * { seed, region, cal, tzMin, map }. Cheap; the map is cached per region.
 */
export function weatherContext(state) {
  const region = REGION_CLIMATE[state?.settings?.region] ? state.settings.region : 'north';
  return {
    seed: state?.weatherSeed ?? 'weather',
    region,
    cal: state?.weatherCalendar || [],
    tzMin: Number.isFinite(state?.weatherTzMin) ? state.weatherTzMin : -new Date().getTimezoneOffset(),
    map: regionMap(region),
  };
}

/** A save's weather seed: fixed for the life of the franchise. */
export function newWeatherSeed(parts) {
  return `wx-${hash(JSON.stringify(parts)).toString(36)}`;
}

// ── Clock and calendar ──────────────────────────────────────────────────────

/** Hour of the day (0–24, fractional) on the save's clock. */
export function localHour(t, tzMin) {
  const m = (((t / 60_000 + tzMin) % 1440) + 1440) % 1440;
  return m / 60;
}

/** The start of the local day containing t. */
export function localDayStart(t, tzMin) {
  const off = tzMin * 60_000;
  return Math.floor((t + off) / MS_DAY) * MS_DAY - off;
}

const _doyMemo = new Map();
const _doyOfIso = (iso) => {
  let v = _doyMemo.get(iso);
  if (v === undefined) {
    const [y, m, d] = String(iso).split('-').map(Number);
    v = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / MS_DAY;
    _doyMemo.set(iso, v);
  }
  return v;
};

/**
 * calendarAnchor(schedule, seasonNum, tzMin) — a season's entry in
 * state.weatherCalendar, read off its first game: from that real day, the
 * baseball calendar runs one day per day (SeasonEngine.generateLeagueCalendar).
 */
export function calendarAnchor(schedule, seasonNum, tzMin) {
  const g = (schedule || []).find(x => x && x.date && Number.isFinite(x.gameTime));
  if (!g) return null;
  return { kind: 'season', season: seasonNum, realStartMs: localDayStart(g.gameTime, tzMin), dispIso: g.date };
}

/** The first day of spring on the baseball calendar in a league year. */
export function springStartIso(year) {
  return `${year}-${String(SPRING_START_MONTH + 1).padStart(2, '0')}-${String(SPRING_START_DAY).padStart(2, '0')}`;
}

/**
 * addCalendarEntry(draft, entry) — append to state.weatherCalendar unless an
 * entry of that kind for that season is already there. Entries are never
 * changed once written.
 */
export function addCalendarEntry(draft, entry) {
  if (!entry) return;
  const cal = Array.isArray(draft.weatherCalendar) ? draft.weatherCalendar : (draft.weatherCalendar = []);
  if (cal.some(a => a.kind === entry.kind && a.season === entry.season)) return;
  cal.push(entry);
}

/**
 * offseasonAnchor(fromMs, toMs, nextDispIso, seasonNum) — the offseason's
 * entry: between the last out and the next spring the climate blends from
 * where the season ended to where the next one starts (the offseason is a
 * few real days, so it never passes through winter).
 */
export function offseasonAnchor(fromMs, toMs, nextDispIso, seasonNum) {
  return { kind: 'offseason', season: seasonNum, fromMs, toMs, nextDispIso };
}

/**
 * calendarDay(cal, t) — where t falls on the baseball calendar:
 * { doy, blendDoy?, w? } (day of year, fractional). In an offseason the
 * normals are a blend: (1 − w)·normals(doy) + w·normals(blendDoy).
 * Entries are appended over the life of the save and never changed, so the
 * answer for a moment never changes once that moment has an entry.
 */
export function calendarDay(cal, t) {
  const seasons = cal.filter(a => a.kind === 'season');
  if (!seasons.length) {
    // No calendar yet (a save mid-migration, a tool): the real date.
    const d = new Date(t);
    return { doy: (t - Date.UTC(d.getUTCFullYear(), 0, 1)) / MS_DAY };
  }
  let seg = seasons[0];
  for (const a of cal) {
    const start = a.kind === 'season' ? a.realStartMs : a.fromMs;
    if (start <= t) seg = a;
  }
  if (seg.kind === 'season') return { doy: _doyOfIso(seg.dispIso) + (t - seg.realStartMs) / MS_DAY };
  // Offseason: the season before it, continued to the last out, blended
  // toward the next spring's first day.
  const prev = seasons.filter(s => s.realStartMs <= seg.fromMs).pop() || seasons[0];
  const endDoy = _doyOfIso(prev.dispIso) + (seg.fromMs - prev.realStartMs) / MS_DAY;
  const w = Math.min(1, Math.max(0, (t - seg.fromMs) / Math.max(1, seg.toMs - seg.fromMs)));
  return { doy: endDoy, blendDoy: _doyOfIso(seg.nextDispIso), w };
}

/**
 * baseballDateIso(cal, t) — the date on the baseball calendar for moment t
 * ('YYYY-MM-DD'), or null in an offseason (no games, no dates) or with no
 * calendar. A season's days run one-for-one from its first day.
 */
export function baseballDateIso(cal, t) {
  let seg = null;
  for (const a of cal || []) { const start = a.kind === 'season' ? a.realStartMs : a.fromMs; if (start <= t) seg = a; }
  if (!seg || seg.kind !== 'season') return null;
  const days = Math.floor((t - seg.realStartMs) / MS_DAY);
  const [y, m, d] = seg.dispIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ── Normals ─────────────────────────────────────────────────────────────────

const MONTH_MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];
const FIELDS = ['hi', 'lo', 'dew', 'wet', 'storms', 'steer', 'wind', 'inches', 'rainK', 'tb0', 'tb1', 'tb2', 'tb3', 'tb4', 'tb5'];

// The calibration (data/weather-calibration.js) rides along with the normals,
// so it is interpolated by day and blended through the offseason the same way.
let _calibrated = true;
/** The calibration tool turns the corrections off while it measures. */
export function useCalibration(on) { _calibrated = !!on; _normMemo.clear(); _monthsMemo.clear(); }
const _monthsMemo = new Map();
function _months(region) {
  const key = `${region}|${_calibrated}`;
  let m = _monthsMemo.get(key);
  if (!m) {
    const base = (REGION_CLIMATE[region] || REGION_CLIMATE.north).months;
    const cal = _calibrated ? WEATHER_CALIBRATION[region] || WEATHER_CALIBRATION.north : null;
    m = base.map((mo, i) => {
      const tb = cal ? cal.tempBias[i] : [0, 0, 0, 0, 0, 0];
      return { ...mo, rainK: cal ? cal.rainK[i] : 1, tb0: tb[0], tb1: tb[1], tb2: tb[2], tb3: tb[3], tb4: tb[4], tb5: tb[5] };
    });
    _monthsMemo.set(key, m);
  }
  return m;
}

/** The surface weather's average departure from the background at this hour (°F), from the calibration. */
export function tempBiasAt(N, hour) {
  const h = ((hour % 24) + 24) % 24, i = Math.floor(h / 4), f = (h - 4 * i) / 4;
  const a = N[`tb${i}`] ?? 0, b = N[`tb${(i + 1) % 6}`] ?? 0;
  return a + (b - a) * f;
}

/** A region's normals on a day of the year (interpolated between mid-months, held outside Mar–Nov). */
export function normalsOnDay(region, doy) {
  const months = _months(region);
  const mids = months.map((_, i) => MONTH_MID_DOY[CLIMATE_FIRST_MONTH + i]);
  if (doy <= mids[0]) return { ...months[0] };
  if (doy >= mids[mids.length - 1]) return { ...months[months.length - 1] };
  let i = 0;
  while (doy > mids[i + 1]) i++;
  const f = (doy - mids[i]) / (mids[i + 1] - mids[i]);
  const out = {};
  for (const k of FIELDS) out[k] = months[i][k] + (months[i + 1][k] - months[i][k]) * f;
  return out;
}

/** The normals in force at moment t (offseason-blended). Memoised per 10 minutes (they change slowly). */
const _normMemo = new Map();
export function normalsAt(ctx, t) {
  const bucket = Math.floor(t / 600_000);
  let byCal = _normMemo.get(ctx.cal);
  if (!byCal) { if (_normMemo.size > 20) _normMemo.clear(); byCal = new Map(); _normMemo.set(ctx.cal, byCal); }
  const key = bucket * 4 + ['north', 'south', 'east', 'west'].indexOf(ctx.region);
  let v = byCal.get(key);
  if (!v) { if (byCal.size > 50000) byCal.clear(); v = _normalsAt(ctx, bucket * 600_000 + 300_000); byCal.set(key, v); }
  return v;
}

function _normalsAt(ctx, t) {
  const day = calendarDay(ctx.cal, t);
  const a = normalsOnDay(ctx.region, day.doy);
  if (day.blendDoy == null) return a;
  const b = normalsOnDay(ctx.region, day.blendDoy);
  const out = {};
  for (const k of FIELDS) out[k] = a[k] + (b[k] - a[k]) * day.w;
  return out;
}

/**
 * Day/night shape, 0 at the morning low (~6 AM), 1 at the afternoon high
 * (~4 PM), smooth in between — a slow fall through the evening and night.
 */
export function diurnal(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 6 && h <= 16) return 0.5 - 0.5 * Math.cos((Math.PI * (h - 6)) / 10);
  const since = h > 16 ? h - 16 : h + 8;   // hours since the high
  return 0.5 + 0.5 * Math.cos((Math.PI * since) / 14);
}

// ── Air: temperature and dew point (before rain cools it — step 1d) ─────────

const ANOM_SPAN_KM = 1300;       // warm/cold spells are about this wide
const ANOM_DRIFT_KMH = 32;       // and drift east at about this speed
const ANOM_HOURS = 84;           // and evolve over about this many hours
const ANOM_F = 22;               // amplitude at a fast spring/fall jet: s.d. ≈ 8 °F
const ANOM_CAP_F = 24;

/**
 * The warm/cold spell at (x, y, t), °F. Bigger swings when the jet stream is
 * fast (spring, fall), smaller in midsummer — as in real climates.
 */
export function tempAnomaly(ctx, x, y, t, N = normalsAt(ctx, t)) {
  const h = t / MS_HOUR;
  const v = fbm3(hash(ctx.seed, 11), (x - ANOM_DRIFT_KMH * h) / ANOM_SPAN_KM, y / ANOM_SPAN_KM, h / ANOM_HOURS, 3);
  const amp = ANOM_F * (0.35 + 0.65 * Math.min(1, N.steer / 55));
  return Math.max(-ANOM_CAP_F, Math.min(ANOM_CAP_F, v * amp));
}

/**
 * airAt(ctx, x, y, t) — background air at a point: { tempF, dewF }.
 * Normals for the day, the day/night cycle, the spell of the week, colder to
 * the north, evened out near big water (which lags the season), colder on
 * high ground. Rain-cooled air and fronts come with the systems (1c/1d).
 */
export function airAt(ctx, x, y, t) {
  const C = REGION_CLIMATE[ctx.region];
  const N = normalsAt(ctx, t);
  const hour = localHour(t, ctx.tzMin);
  const anom = tempAnomaly(ctx, x, y, t, N);
  let temp = N.lo + (N.hi - N.lo) * diurnal(hour) + anom - (C.gradientF * y) / 100;
  // Big water: smaller day/night swing, and it runs about six weeks behind
  // the season (cool in spring, mild in fall).
  const wk = waterKmAt(ctx.map, x, y);
  if (wk < 45) {
    const w = C.waterCalm * (1 - wk / 45);
    const lag = normalsAt(ctx, t - 42 * MS_DAY);
    const waterF = (lag.hi + lag.lo) / 2 + anom * 0.3;
    temp = temp * (1 - w) + waterF * w;
  }
  if (maskAt(ctx.map, x, y) & MASK_RELIEF) temp -= C.reliefF;
  // Dew point: humid in the warm spells, a little more near water; never above the air.
  const dn = valueNoise2(hash(ctx.seed, 12), x / 600, t / MS_HOUR / 40) * 3;
  let dew = N.dew + anom * 0.6 + dn + (wk < 30 ? 2 * (1 - wk / 30) : 0) - (C.gradientF * y) / 160;
  dew = Math.min(dew, temp - 0.5);
  return { tempF: temp, dewF: dew };
}

// ── The steering flow: how weather systems move ─────────────────────────────

/**
 * steeringAt(ctx, t) — the flow that carries systems across the region:
 * { u, v } km/h (u east, v north), headingDeg (compass, toward), speed.
 * Mostly west → east, usually with a little northward drift, wandering by
 * ±35° over a couple of days; fast in spring and fall, slow in midsummer.
 */
export function steeringAt(ctx, t) {
  const N = normalsAt(ctx, t);
  const h = t / MS_HOUR;
  const wander = fbm2(hash(ctx.seed, 21), h / 50, 0.5, 3);            // −1..1
  const pace = fbm2(hash(ctx.seed, 22), h / 40, 3.5, 2);
  const angle = (12 + 40 * wander) * Math.PI / 180;                    // from due east, + = toward north
  const speed = Math.max(8, N.steer * (1 + 0.45 * pace));
  const u = Math.cos(angle) * speed, v = Math.sin(angle) * speed;
  const headingDeg = (90 - (angle * 180) / Math.PI + 360) % 360;
  return { u, v, speed, headingDeg };
}

// ── How ripe the air is for storms ──────────────────────────────────────────

/**
 * stormPotential(ctx, x, y, t) — 0..1: how readily pop-up thunderstorms form
 * here and now. Warm, humid afternoons in the stormy months; sea breezes
 * along the coast; late-summer monsoon storms over high ground. Step 1c
 * scales pop-up storms by this so each region's storm days match its climate.
 */
export function stormPotential(ctx, x, y, t) {
  const C = REGION_CLIMATE[ctx.region];
  const N = normalsAt(ctx, t);
  const air = airAt(ctx, x, y, t);
  const hour = localHour(t, ctx.tzMin);
  // Afternoon heating: builds from late morning, peaks ~4–6 PM, fades by midnight.
  const heat = hour < 10 ? 0.08 : hour < 17 ? 0.08 + 0.92 * ((hour - 10) / 7) ** 1.4 : hour < 24 ? Math.max(0.08, 1 - (hour - 17) / 7) : 0.08;
  const moist = Math.max(0, Math.min(1, (air.dewF - 45) / 25));
  const warm = Math.max(0, Math.min(1, (air.tempF - 60) / 25));
  let p = N.storms * heat * (0.35 + 0.65 * moist) * (0.4 + 0.6 * warm);
  const wk = waterKmAt(ctx.map, x, y);
  if (C.seaBreeze && wk > 6 && wk < 70 && hour >= 12 && hour <= 19) p *= 1 + 0.6 * (1 - Math.abs(wk - 30) / 40);
  if (C.monsoon && (maskAt(ctx.map, x, y) & MASK_RELIEF)) p *= 1.6;
  if (wk < 4) p *= 0.5;   // storms rarely pop over the water itself in the afternoon
  return Math.max(0, Math.min(1, p));
}
