/**
 * engine/WeatherConditions.js
 * §100 (step 1d) What it's like at a place and moment — the ballpark report.
 * Read off the same weather the radar draws (WeatherSystems), so the two can
 * never disagree:
 *   - precipitation and rain / mix / snow: WeatherSystems.precipAt
 *   - temperature: the shared rain/mix/snow lattice (precipTemp), less the
 *     cooling of the rain itself — so a park reporting snow is never warm,
 *     and the radar's colour over it always matches
 *   - sky: WeatherSystems.cloudAt (forced overcast while it rains)
 *   - wind: the flow, fronts (south-southwest ahead, northwest behind),
 *     thunderstorm outflow, sea breezes
 *   - lightning in the area: a thunderstorm within about 10 miles
 *
 * Pure: a weather context (WeatherClimate.weatherContext) and a moment in;
 * a report out. No state, no Math.random.
 */

import { localHour, normalsAt, steeringAt, calendarDay, MS_HOUR } from './WeatherClimate.js';
import { precipAt, precipTemp, surfaceTemp, stormNear, rainRate, PRECIP_RAIN, PRECIP_MIX, PRECIP_SNOW, DBZ_MIN } from './WeatherSystems.js';
import { waterKmAt, parkBearing, MASK_WATER, maskAt } from './WeatherMap.js';
import { hash, fbm3 } from './WeatherNoise.js';

export const LIGHTNING_KM = 16;            // ~10 miles: lightning this close stops play
const LIGHTNING_DBZ = 43;                  // a thunderstorm strong enough to be making lightning
const KM_PER_MILE = 1.609;
const RAIN_COOL_STEP_MS = 15 * 60_000, RAIN_COOL_LOOKBACK = 6;   // rain-cooled air lingers ~90 minutes

const _wrap = (d) => ((d % 360) + 360) % 360;
const _angDiff = (a, b) => { const d = _wrap(a - b); return d > 180 ? d - 360 : d; };

// ── Wind ────────────────────────────────────────────────────────────────────

/**
 * windAt(ctx, x, y, t, front) — { mph, gustMph, fromDeg }.
 * The surface wind backs from the steering flow (it blows from the
 * south-west when systems move east); ahead of a cold front it swings round
 * to the south and freshens, behind it to the north-west with gusts; a
 * thunderstorm's outflow gusts hard; on summer afternoons near the coast the
 * breeze comes off the water. Stronger in the afternoon, lighter at night.
 */
export function windAt(ctx, x, y, t, front, storm = -Infinity) {
  const N = normalsAt(ctx, t);
  const flow = steeringAt(ctx, t);
  const hour = localHour(t, ctx.tzMin);
  const h = t / MS_HOUR;
  const day = 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, Math.min(14, hour - 6))) / 14);   // 0 at night … 1 mid-afternoon
  const gusty = 0.5 + 0.5 * fbm3(hash(ctx.seed, 51), x / 300, y / 300, h / 10, 3);
  let mph = N.wind * (0.7 + 0.6 * day) * (0.65 + 0.8 * gusty);
  let from = _wrap(flow.headingDeg + 180 - 35 + 45 * fbm3(hash(ctx.seed, 52), x / 500, y / 500, h / 16, 2));
  // Fronts.
  if (front) {
    if (front.ahead > 0.05) { from = _blend(from, 195, front.ahead * 0.8); mph *= 1 + 0.35 * front.ahead; }
    if (front.behind > 0.05) { from = _blend(from, 315, front.behind * 0.9); mph *= 1 + 0.45 * front.behind; }
    if (front.outflow > 0.05) { from = _blend(from, flow.headingDeg + 180 + 180, front.outflow * 0.7); mph *= 1 + 0.8 * front.outflow; }
  }
  // Thunderstorm outflow nearby.
  let gust = mph * (1.3 + 0.3 * gusty);
  if (storm > 38) { const k = Math.min(1, (storm - 38) / 18); gust = Math.max(gust, 22 + 30 * k); mph = Math.max(mph, 10 + 14 * k); }
  // Sea / lake breeze: summer afternoons, within ~50 km of big water, off the water.
  const wk = waterKmAt(ctx.map, x, y);
  if (wk > 0 && wk < 50 && hour > 11 && hour < 19 && N.hi > 75) {
    const toWater = _towardWater(ctx, x, y);
    if (toWater != null) from = _blend(from, toWater, 0.6 * (1 - wk / 50) * Math.sin(Math.PI * (hour - 11) / 8));
  }
  return { mph: Math.max(0, mph), gustMph: Math.max(gust, mph), fromDeg: Math.round(_wrap(from)) };
}

function _blend(a, b, w) { return _wrap(a + _angDiff(b, a) * Math.max(0, Math.min(1, w))); }

/** Compass bearing toward the nearest water (null if none close). */
function _towardWater(ctx, x, y) {
  let best = null, bk = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 2 * Math.PI;
    const k = waterKmAt(ctx.map, x + Math.sin(a) * 20, y + Math.cos(a) * 20);
    if (k < bk) { bk = k; best = (i / 16) * 360; }
  }
  return best;
}

/**
 * How the wind plays at a ballpark: home plate → centre field faces
 * `bearing`. { text, outMph } — outMph > 0 blowing out (toward the
 * outfield), < 0 blowing in. Text: "out to center", "in from left",
 * "left to right", "calm".
 */
export function windAtPark(wind, bearing) {
  if (wind.mph < 3) return { text: 'calm', outMph: 0, crossMph: 0 };
  const toward = _wrap(wind.fromDeg + 180);
  const d = _angDiff(toward, bearing);          // 0 = straight out to centre; − toward left field
  const outMph = wind.mph * Math.cos((d * Math.PI) / 180);
  const crossMph = wind.mph * Math.sin((d * Math.PI) / 180);   // + toward right field
  const a = Math.abs(d);
  const side = d < 0 ? 'left' : 'right';
  const text = a <= 25 ? 'out to center' : a <= 65 ? `out to ${side}`
    : a <= 115 ? (d < 0 ? 'right to left' : 'left to right')
    : a <= 155 ? `in from ${d < 0 ? 'right' : 'left'}` : 'in from center';
  return { text, outMph, crossMph };
}

// ── Daylight ────────────────────────────────────────────────────────────────

/** Sunrise and sunset (local hours) on the baseball calendar, for a park around 40° N. */
export function daylight(ctx, t) {
  const doy = calendarDay(ctx.cal, t).doy;
  const len = 12.2 + 2.9 * Math.sin((2 * Math.PI * (doy - 80)) / 365);
  const noon = 13.1;   // clocks on daylight time
  return { sunrise: noon - len / 2, sunset: noon + len / 2 };
}

// ── The report ──────────────────────────────────────────────────────────────

export const SKY_LABELS = Object.freeze(['Clear', 'Mostly Clear', 'Partly Cloudy', 'Mostly Cloudy', 'Cloudy']);

/**
 * conditionsAt(ctx, x, y, t) — the weather at a place and moment:
 * {
 *   tempF, dewF, humidity (%), feelsLikeF,
 *   wind: { mph, gustMph, fromDeg },
 *   cloud (0..1), sky ('Clear' … 'Cloudy'),
 *   precip: { dbz, kind ('rain'|'mix'|'snow'|null), rateMmH, inPerHr, convective },
 *   lightning (bool), stormDbz,
 *   isDay, label ('Thunderstorm', 'Heavy Rain', 'Snow', 'Partly Cloudy', …), icon (a key)
 * }
 */
export function conditionsAt(ctx, x, y, t) {
  const p = precipAt(ctx, x, y, t);
  const surf = surfaceTemp(ctx, x, y, t);
  const wet = p.dbz > DBZ_MIN;
  // Temperature: the shared lattice (as the radar's rain/mix/snow uses), less
  // heavy precipitation's drag, less rain's evaporative cooling.
  const base = precipTemp(ctx, x, y, t);
  const drag = wet && p.dbz > 28 ? Math.min(3, (p.dbz - 28) / 5) : 0;
  let tempF = base - drag;
  // Rain cools the air, and the rain-cooled air lingers: the coolest of now
  // and the last 90 minutes, recovering with a one-hour half-life.
  const dep = Math.max(0, tempF - surf.dewF);
  let cool = wet && p.kind === PRECIP_RAIN ? dep * Math.min(0.55, 0.12 + p.rateMmH / 30) : 0;
  for (let k = 1; k <= RAIN_COOL_LOOKBACK; k++) {
    const q = precipAt(ctx, x, y, t - k * RAIN_COOL_STEP_MS);
    if (q.dbz > DBZ_MIN && q.kind === PRECIP_RAIN) {
      cool = Math.max(cool, dep * Math.min(0.55, 0.12 + q.rateMmH / 30) * 0.5 ** ((k * RAIN_COOL_STEP_MS) / MS_HOUR));
    }
  }
  if (cool > 0) {
    tempF -= cool;
    if (wet && p.kind === PRECIP_RAIN) tempF = Math.max(tempF, 33.5);   // rain stays rain
  }
  const dewF = Math.min(surf.dewF + (wet ? 1.5 : 0), tempF - (wet ? 0.3 : 0.5));
  const humidity = Math.round(100 * _rh(tempF, dewF));
  const storm = stormNear(ctx, x, y, t, LIGHTNING_KM);
  const lightning = storm >= LIGHTNING_DBZ;
  const wind = windAt(ctx, x, y, t, surf.front, storm);
  const cloud = wet ? Math.max(surf.cloud, p.convective ? 0.85 : 0.92) : surf.cloud;
  const sky = SKY_LABELS[cloud < 0.15 ? 0 : cloud < 0.38 ? 1 : cloud < 0.62 ? 2 : cloud < 0.86 ? 3 : 4];
  const hour = localHour(t, ctx.tzMin);
  const dl = daylight(ctx, t);
  const isDay = hour >= dl.sunrise && hour < dl.sunset;
  const kind = wet ? (p.kind === PRECIP_SNOW ? 'snow' : p.kind === PRECIP_MIX ? 'mix' : 'rain') : null;
  const { label, icon } = _label({ wet, kind, dbz: p.dbz, convective: p.convective || (wet && lightning), lightning, sky, isDay, tempF, wind });
  return {
    tempF: _r1(tempF), dewF: _r1(dewF), humidity, feelsLikeF: _r1(_feelsLike(tempF, humidity, wind.mph)),
    wind: { mph: Math.round(wind.mph), gustMph: Math.round(wind.gustMph), fromDeg: wind.fromDeg },
    cloud: Math.round(cloud * 100) / 100, sky,
    precip: { dbz: wet ? _r1(p.dbz) : null, kind, rateMmH: _r1(p.rateMmH), inPerHr: Math.round((p.rateMmH / 25.4) * 100) / 100, convective: !!p.convective },
    lightning, stormDbz: storm > -Infinity ? _r1(storm) : null,
    isDay, label, icon,
  };
}

/** The report at a club's ballpark, with how the wind plays there. */
export function parkConditions(ctx, teamId, t) {
  const park = ctx.map.parks[teamId] || ctx.map.parks.user;
  const c = conditionsAt(ctx, park.x, park.y, t);
  const bearing = parkBearing(ctx.map, teamId);
  return { ...c, teamId, bearing, windAtPark: windAtPark(c.wind, bearing) };
}

/**
 * rainTotal(ctx, x, y, t0, t1, stepMin) — liquid precipitation between two
 * moments, inches (snow counted as its melted water). For the field's
 * condition and the groundskeeper.
 */
export function rainTotal(ctx, x, y, t0, t1, stepMin = 10) {
  const step = stepMin * 60_000;
  let mm = 0;
  for (let t = t0 + step / 2; t < t1; t += step) mm += precipAt(ctx, x, y, t).rateMmH * (step / MS_HOUR);
  return Math.round((mm / 25.4) * 100) / 100;
}

function _label({ wet, kind, dbz, convective, lightning, sky, isDay, tempF, wind }) {
  if (wet && kind === 'snow') return dbz >= 30 ? { label: 'Heavy Snow', icon: 'snow-heavy' } : dbz >= 20 ? { label: 'Snow', icon: 'snow' } : { label: 'Light Snow', icon: 'snow-light' };
  if (wet && kind === 'mix') return { label: dbz >= 25 ? 'Sleet' : 'Rain and Snow', icon: 'mix' };
  if (wet) {
    if (convective && dbz >= 40) return { label: dbz >= 52 ? 'Severe Thunderstorm' : 'Thunderstorm', icon: 'storm' };
    if (dbz >= 40) return { label: 'Heavy Rain', icon: 'rain-heavy' };
    if (dbz >= 28) return { label: 'Rain', icon: 'rain' };
    return { label: dbz >= 20 ? 'Light Rain' : 'Drizzle', icon: 'rain-light' };
  }
  if (lightning) return { label: 'Storms Nearby', icon: 'storm-near' };
  const night = !isDay;
  const sk = night && sky === 'Clear' ? 'Clear' : night && sky === 'Mostly Clear' ? 'Mostly Clear' : !night && sky === 'Clear' ? 'Sunny' : !night && sky === 'Mostly Clear' ? 'Mostly Sunny' : sky;
  const icon = { Clear: 'moon', 'Mostly Clear': 'moon-cloud', Sunny: 'sun', 'Mostly Sunny': 'sun-cloud', 'Partly Cloudy': night ? 'moon-cloud' : 'sun-cloud', 'Mostly Cloudy': 'cloud', Cloudy: 'cloud' }[sk];
  if (wind.mph >= 20) return { label: `${sk}, Windy`, icon: 'wind' };
  if (tempF >= 95 && !night) return { label: `${sk}, Hot`, icon: 'hot' };
  return { label: sk, icon };
}

const _r1 = (v) => Math.round(v * 10) / 10;

/** Relative humidity (0..1) from temperature and dew point (Magnus). */
function _rh(tF, dF) {
  const t = (tF - 32) / 1.8, d = (dF - 32) / 1.8;
  const g = (c) => Math.exp((17.625 * c) / (243.04 + c));
  return Math.max(0.03, Math.min(1, g(d) / g(t)));
}

/** Heat index above 80 °F, wind chill below 50 °F, otherwise the air temperature. */
function _feelsLike(t, rh, mph) {
  if (t >= 80 && rh >= 40) {
    const R = rh;
    return -42.379 + 2.04901523 * t + 10.14333127 * R - 0.22475541 * t * R - 0.00683783 * t * t
      - 0.05481717 * R * R + 0.00122874 * t * t * R + 0.00085282 * t * R * R - 0.00000199 * t * t * R * R;
  }
  if (t <= 50 && mph > 3) return 35.74 + 0.6215 * t - 35.75 * mph ** 0.16 + 0.4275 * t * mph ** 0.16;
  return t;
}

export { KM_PER_MILE };
