/**
 * engine/WeatherForecast.js
 * §100 (step 1f) The forecast the GM reads: chances of rain and the 10-day
 * outlook, for any ballpark.
 *
 *   - The forecast itself (temperatures, the icon, the radar's future frames)
 *     is the current hourly run, member 0 (WeatherSystems.forecastContext).
 *   - Chances come from an ensemble: ENSEMBLE_SIZE more runs made at the same
 *     hour, each wrong in its own way (different timing and track errors,
 *     different systems foreseen or missed, its own pop-up storms). The share
 *     of members that bring measurable rain (0.01") to the park is the raw
 *     chance; it is then calibrated (calibrateChance) — sharpened where the
 *     ensemble is under-confident, faded to the region's climate as the lead
 *     grows — so that across a season "40%" rains about 40% of the time (the
 *     harness checks this on seeds the calibration wasn't fitted on).
 *   - Long-range highs and lows are drawn toward the normals the same way, as
 *     real forecasters do: a week out, the normal is a better guess than one
 *     run's number.
 *
 * Every answer is a pure function of the save's weather context, the run's
 * hour and the place, cached per run: the dashboard, the schedule and the
 * radar all read the same numbers.
 */

import { MS_HOUR, MS_DAY, localDayStart, localHour, normalsAt, baseballDateIso } from './WeatherClimate.js';
import { forecastContext, precipAt, DBZ_MIN, PRECIP_SNOW, PRECIP_MIX } from './WeatherSystems.js';
import { conditionsAt } from './WeatherConditions.js';

export const ENSEMBLE_SIZE = 12;
const MAIN_WEIGHT = 2;
const RADAR_HOURS = 24;                        // the radar's future frames reach this far
const WET_MM = 0.25;                           // measurable: 0.01 inch
const _cache = new Map();
const _cap = () => { if (_cache.size > 5000) _cache.clear(); };

/** How often a member is sampled over a window, by lead (finer up close). */
function _stepMs(leadH) {
  return leadH <= 72 ? 30 * 60_000 : 60 * 60_000;
}

/**
 * One member's view of a window at a point: { wet, mm, convective, snow,
 * mix, wetHours: [local hours with rain] }.
 */
function _memberWindow(fctx, x, y, t0, t1, step, warm) {
  let mm = 0, conv = 0, snow = 0, mix = 0, wetN = 0;
  const wetHours = [];
  const opts = warm ? { kind: false } : null;    // no snow possible: skip the temperature
  for (let t = t0 + step / 2; t < t1; t += step) {
    const p = precipAt(fctx, x, y, t, opts);
    if (!(p.dbz > DBZ_MIN)) continue;
    mm += p.rateMmH * (step / MS_HOUR);
    wetN++;
    if (p.convective) conv++;
    if (p.kind === PRECIP_SNOW) snow++; else if (p.kind === PRECIP_MIX) mix++;
    if (p.dbz >= 20) wetHours.push(localHour(t, fctx.tzMin));
  }
  return { wet: mm >= WET_MM, mm, convective: wetN ? conv / wetN : 0, snow: wetN ? snow / wetN : 0, mix: wetN ? mix / wetN : 0, wetHours };
}

/** The climate's chance of measurable rain in a window of `hours` (from the day's wet-day normal). */
export function climateChance(ctx, t0, t1) {
  const pDay = normalsAt(ctx, (t0 + t1) / 2).wet;
  const hours = Math.max(0.25, (t1 - t0) / MS_HOUR);
  return Math.min(pDay, 1 - (1 - pDay) ** ((hours / 24) ** 0.7));
}

const _logit = (p) => Math.log(p / (1 - p));
const _sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * calibrateChance(raw, climate, leadH) — the ensemble's raw share turned into
 * a chance that verifies: start from the climate's chance and add the
 * ensemble's departure from it — sharpened (×1.65 when it leans wet, ×1.15
 * when it leans dry: the ensemble undersells rain it agrees on) out to about
 * 4½ days, then fading to the climate by
 * day 8–9 (where it knows little). Fitted against what happens over four
 * regions, a full season and windows of 3 hours to a day (harness: reliability).
 */
export function calibrateChance(raw, climate, leadH) {
  const r = Math.min(0.98, Math.max(0.02, raw)), c = Math.min(0.98, Math.max(0.02, climate));
  const f = Math.min(1, Math.max(0, (leadH - 110) / 100));
  // Wetter than the climate: the ensemble undersells it — sharpen more. Drier: about right.
  const dep = _logit(r) - _logit(c);
  const a = dep > 0 ? 1.65 - 1.45 * f : 1.15 - 0.95 * f;
  const b = -0.1 + 0.3 * Math.min(1, Math.max(0, (leadH - 60) / 120));
  return _sigmoid(_logit(c) + a * dep + b);
}

/**
 * chanceOfPrecip(ctx, nowMs, x, y, t0, t1) — the forecast chance (0–100) of
 * measurable precipitation at a point between t0 and t1, from the run made
 * at nowMs's hour. { chance, raw, climate, kind ('rain'|'storms'|'snow'|'mix'),
 * timing: { morning, afternoon, evening, overnight } (share of members' rain) }.
 * Windows already over are certain (it did or didn't); a window in progress
 * counts what has fallen.
 */
export function chanceOfPrecip(ctx, nowMs, x, y, t0, t1) {
  const issue = Math.floor(nowMs / MS_HOUR) * MS_HOUR;
  const key = `${ctx.seed}|${ctx.region}|${issue}|${x.toFixed(1)}|${y.toFixed(1)}|${t0}|${t1}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  _cap();
  const lead = Math.max(0, ((t0 + t1) / 2 - issue) / MS_HOUR);
  const step = _stepMs(lead);
  const warm = normalsAt(ctx, t0).lo > 40 && normalsAt(ctx, t1).lo > 40;
  const members = [];
  for (let m = 1; m <= ENSEMBLE_SIZE; m++) members.push(_memberWindow(forecastContext(ctx, issue, m), x, y, t0, t1, step, warm));
  const main = _memberWindow(forecastContext(ctx, issue, 0), x, y, t0, t1, step, warm);
  const all = [main, ...members];
  const wet = all.filter(w => w.wet);
  // The main run (what the radar's future frames show) is the best single
  // guess: it counts as MAIN_WEIGHT members.
  const wetW = members.filter(w => w.wet).length + (main.wet ? MAIN_WEIGHT : 0);
  const raw = (wetW + 0.25) / (ENSEMBLE_SIZE + MAIN_WEIGHT + 0.5);
  const climate = climateChance(ctx, t0, t1);
  let p = calibrateChance(raw, climate, lead);
  // Within a day the chance never contradicts the radar: rain the radar shows
  // at the park is never a long shot (≥ 30%), and a dry radar is never a sure
  // thing (≤ 80%).
  if (lead <= RADAR_HOURS) p = main.wet ? Math.max(p, 0.3) : Math.min(p, 0.8);
  const conv = wet.length ? wet.reduce((a, b) => a + b.convective, 0) / wet.length : 0;
  const snow = wet.length ? wet.reduce((a, b) => a + b.snow, 0) / wet.length : 0;
  const mix = wet.length ? wet.reduce((a, b) => a + b.mix, 0) / wet.length : 0;
  const hours = wet.flatMap(w2 => w2.wetHours);
  const share = (lo, hi) => hours.length ? hours.filter(h => h >= lo && h < hi).length / hours.length : 0;
  const out = {
    chance: roundChance(100 * p), raw: Math.round(100 * raw), climate: Math.round(100 * climate),
    kind: snow > 0.5 ? 'snow' : (snow + mix) > 0.4 ? 'mix' : conv > 0.2 ? 'storms' : 'rain',
    timing: { overnight: share(0, 6), morning: share(6, 12), afternoon: share(12, 18), evening: share(18, 24) },
    mainWet: main.wet,
  };
  _cache.set(key, out);
  return out;
}

/** Chances are shown the way forecasters give them: 0, then steps of 10 (a 5 rounds up only from 5). */
export function roundChance(pct) {
  if (pct < 5) return 0;
  return Math.min(100, Math.max(10, Math.round(pct / 10) * 10));
}

/**
 * dailyForecast(ctx, nowMs, x, y, days) — the outlook at a point, one entry a
 * local day, starting today:
 * { dayStartMs, dateIso (baseball calendar, null in the offseason), hiF (the day's high), loF (tonight's low),
 *   chance, kind, label, summary, icon, windMph, windFromDeg }.
 */
export function dailyForecast(ctx, nowMs, x, y, days = 10) {
  const issue = Math.floor(nowMs / MS_HOUR) * MS_HOUR;
  const key = `daily|${ctx.seed}|${ctx.region}|${issue}|${x.toFixed(1)}|${y.toFixed(1)}|${days}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const main = forecastContext(ctx, issue, 0);
  const out = [];
  const today = localDayStart(nowMs, ctx.tzMin);
  for (let d = 0; d < days; d++) {
    const t0 = today + d * MS_DAY, t1 = t0 + MS_DAY;
    const from = Math.max(t0, nowMs);
    const N = normalsAt(ctx, t0 + 15 * MS_HOUR);
    // Highs and lows from the run, drawn toward the normals further out.
    const hiSamples = [13, 14.5, 16, 17.5].map(h => t0 + h * MS_HOUR).filter(t => t >= nowMs);
    // The low is tonight's (into tomorrow morning), as forecasts give it.
    const loSamples = [22, 25, 28, 30].map(h => t0 + h * MS_HOUR).filter(t => t >= nowMs);
    const lead = Math.max(0, (t0 + 15 * MS_HOUR - issue) / MS_HOUR);
    const keep = tempTrust(lead);
    const runHi = hiSamples.length ? Math.max(...hiSamples.map(t => conditionsAt(main, x, y, t).tempF)) : null;
    const runLo = loSamples.length ? Math.min(...loSamples.map(t => conditionsAt(main, x, y, t).tempF)) : null;
    const hiF = runHi == null ? null : Math.round(keep * runHi + (1 - keep) * N.hi);
    const Nn = normalsAt(ctx, t0 + 29 * MS_HOUR);
    const loF = runLo == null ? null : Math.round(keep * runLo + (1 - keep) * Nn.lo);
    const c = chanceOfPrecip(ctx, nowMs, x, y, from, t1);
    // Sky by day, from the run's afternoon.
    const mid = conditionsAt(main, x, y, Math.max(nowMs, t0 + 14 * MS_HOUR));
    const wind = mid.wind;
    const { label, summary, icon } = _words(c, mid);
    out.push({ dayStartMs: t0, dateIso: baseballDateIso(ctx.cal, t0 + 12 * MS_HOUR), hiF, loF, chance: c.chance, kind: c.chance >= 10 ? c.kind : null,
               label, summary, icon, windMph: wind.mph, windFromDeg: wind.fromDeg, partial: from > t0 });
  }
  _cap();
  _cache.set(key, out);
  return out;
}

/** How much of the run's own temperature to keep at a lead (the rest is the normal). */
export function tempTrust(leadH) {
  return Math.max(0.35, Math.min(1, 1 - 0.0035 * Math.max(0, leadH - 24)));
}

const _when = (timing) => {
  const parts = Object.entries(timing).filter(([, v]) => v >= 0.55);
  if (parts.length === 1) return parts[0][0];
  return null;
};

function _words(c, sky) {
  const kindWord = { storms: 'Thunderstorms', rain: 'Rain', snow: 'Snow', mix: 'Rain and Snow' }[c.kind];
  const chanceWord = { storms: 'storms', rain: 'showers', snow: 'snow', mix: 'rain and snow' }[c.kind];
  const when = _when(c.timing);
  const whenWord = when === 'overnight' ? 'overnight' : when ? `in the ${when}` : '';
  const skyWord = sky.sky === 'Clear' ? 'Sunny' : sky.sky === 'Mostly Clear' ? 'Mostly Sunny' : sky.sky;
  const skySentence = skyWord.charAt(0) + skyWord.slice(1).toLowerCase();   // "Partly cloudy" in a sentence
  const icon = c.chance >= 50 ? { storms: 'storm', rain: 'rain', snow: 'snow', mix: 'mix' }[c.kind]
    : c.chance >= 30 ? { storms: 'storm-chance', rain: 'rain-chance', snow: 'snow-chance', mix: 'mix' }[c.kind]
    : sky.icon && !/rain|storm|snow|mix/.test(sky.icon) ? sky.icon : 'sun-cloud';
  if (c.chance >= 60) {
    const label = when === 'afternoon' && c.kind === 'storms' ? 'Afternoon Storms' : kindWord;
    return { label, summary: `${kindWord}${whenWord ? ` ${whenWord}` : ''}. Chance ${c.chance}%.`, icon };
  }
  if (c.chance >= 30) return { label: `Chance of ${chanceWord}`, summary: `${skySentence}, with a chance of ${chanceWord}${whenWord ? ` ${whenWord}` : ''}. Chance ${c.chance}%.`, icon };
  if (c.chance >= 10) return { label: skyWord, summary: `${skySentence}. A slight chance of ${chanceWord}${whenWord ? ` ${whenWord}` : ''}.`, icon };
  return { label: skyWord, summary: `${skySentence}.`, icon };
}

/**
 * hourlyForecast(ctx, nowMs, x, y, hours) — hour by hour from now (for a game
 * window): [{ t, tempF, chance, label, icon, windMph, windFromDeg }]. The
 * temperature, label and wind are the run's; the chance is the ensemble's
 * for that hour.
 */
export function hourlyForecast(ctx, nowMs, x, y, hours = 24) {
  const issue = Math.floor(nowMs / MS_HOUR) * MS_HOUR;
  const key = `hourly|${ctx.seed}|${ctx.region}|${issue}|${x.toFixed(1)}|${y.toFixed(1)}|${hours}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const main = forecastContext(ctx, issue, 0);
  const out = [];
  const first = Math.ceil(nowMs / MS_HOUR) * MS_HOUR;
  for (let h = 0; h < hours; h++) {
    const t = first + h * MS_HOUR;
    const c = conditionsAt(main, x, y, t);
    const ch = chanceOfPrecip(ctx, nowMs, x, y, t, t + MS_HOUR);
    out.push({ t, tempF: Math.round(c.tempF), chance: ch.chance, label: c.label, icon: c.icon, windMph: c.wind.mph, windFromDeg: c.wind.fromDeg });
  }
  _cap();
  _cache.set(key, out);
  return out;
}
