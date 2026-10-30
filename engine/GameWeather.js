/**
 * engine/GameWeather.js
 * §102 (step 4a) What the weather does to a game: whether it starts on time,
 * starts late or is postponed; every rain, lightning or snow delay — when it
 * starts, why, and when play resumes; and whether a game that can't be
 * finished is called. Read off the same weather the radar, the park reports
 * and the forecasts show, so what happens is always what the GM could see
 * coming:
 *   - play stops for lightning within about 10 miles (the park report's
 *     "lightning"), rain hard enough to bring out the tarp, steady rain that
 *     soaks the field, or snow;
 *   - the tarp comes off 30 minutes after the last lightning and once the rain
 *     is down to a sprinkle, then the grounds crew needs time for the field;
 *   - the club reads the forecast (the same run the GM sees) three hours and
 *     ninety minutes before first pitch and postpones if it shows no game;
 *   - during a delay the crew reads it every 30 minutes and calls the game if
 *     it shows no restart; there are also hard limits (a three-hour wait to
 *     start, a two-and-a-half-hour delay once under way, a 1 AM curfew).
 *
 * The plan is in real time plus "playing minutes": SimEngine paces a game at
 * ten playing minutes a half-inning (nine innings = PLAY_MIN), and the plan
 * turns playing minutes into the clock. A plan covers PLAN_MAX_MIN of play
 * (13½ innings) — a game uses as much of it as it lasts, so a delay or call
 * the plan has after the game is over simply never happens. Whether a called
 * game is official or suspended depends on the innings and score at that
 * point, which the sim knows (SimEngine, §102.2).
 *
 * Pure and deterministic: a weather context and a game in, a plan out —
 * identical for our games and the rest of the league.
 */

import { precipAt, venueSample, forecastContext, PRECIP_RAIN, DBZ_MIN } from './WeatherSystems.js';
import { LIGHTNING_KM, LIGHTNING_DBZ, conditionsAt, windAtPark, rainTotal } from './WeatherConditions.js';
import { localHour } from './WeatherClimate.js';
import { chanceOfPrecip, gameForecast } from './WeatherForecast.js';
import { venueOf, parkBearing } from './WeatherMap.js';
import { GAME_WEATHER as GW } from '../data/constants.js';

const MIN = 60_000;
const STEP = GW.STEP_MIN * MIN;

export const PLAN_VERSION = 1;

/** Why play stopped (or never started). */
export const STOP_REASON = Object.freeze({ LIGHTNING: 'lightning', RAIN: 'rain', SNOW: 'snow', FIELD: 'wet field' });

/** How the plan ends. A called game is official or suspended by the innings played (the sim decides). */
export const PLAN_OUTCOME = Object.freeze({ PLAYED: 'played', POSTPONED: 'postponed', CALLED: 'called' });

// ── What the venue is doing at a moment ─────────────────────────────────────

function _sampler(ctx, x, y) {
  const memo = new Map();
  return (t) => {
    let s = memo.get(t);
    if (s) return s;
    const p = venueSample(ctx, x, y, t, LIGHTNING_KM);
    s = { rate: p.rateMmH, dbz: p.dbz, kind: p.kind, lightning: p.stormDbz >= LIGHTNING_DBZ };
    memo.set(t, s);
    return s;
  };
}

/** Is play possible right now? And if not, why. */
function _stopReason(s, soakMin) {
  if (s.lightning) return STOP_REASON.LIGHTNING;
  if (s.kind !== PRECIP_RAIN && s.dbz >= GW.SNOW_DBZ) return STOP_REASON.SNOW;
  if (s.rate >= GW.STOP_RATE_MMH || soakMin >= GW.SOAK_MIN) return STOP_REASON.RAIN;
  return null;
}

const _afterCurfew = (ctx, t) => { const h = localHour(t, ctx.tzMin); return h >= GW.CURFEW_LOCAL_H && h < 9; };

// ── The game, five minutes at a time ────────────────────────────────────────

/**
 * Run the game forward from a state through a sampler's weather.
 * state: { t, phase: 'delay'|'play', played (playing minutes), delay?, soak }
 * Returns { outcome, delays, startAt, endT, decidedAt, calledBy, reason, played }.
 * opts.crew(state) → true when the crew's forecast check says call it now.
 * opts.until: stop once this many playing minutes are in (the forecast only needs to know whether the game gets far enough).
 */
function _run(ctx, sample, gameTime, state, opts = {}) {
  let { t, phase, played, soak = 0 } = state;
  let delay = state.delay ? { ...state.delay } : null;
  let startAt = state.startAt ?? null;
  const delays = (state.delays || []).map(d => ({ ...d }));
  const until = opts.until ?? GW.PLAN_MAX_MIN;
  const hardEnd = gameTime + 18 * 60 * MIN;

  const finish = (outcome, extra = {}) => {
    if (delay) delays.push({ ...delay, endT: t });
    return { outcome, delays, startAt, endT: t, played, ...extra };
  };

  while (t < hardEnd) {
    const s = sample(t);
    soak = s.rate >= GW.SOAK_RATE_MMH ? soak + GW.STEP_MIN : 0;
    const why = _stopReason(s, soak);

    if (phase === 'play') {
      if (why) {
        phase = 'delay';
        delay = { startT: t, atPlayMin: played, reason: why, mm: 0, lastLightning: s.lightning ? t : -Infinity, dryFrom: null, resumeAt: null };
      } else {
        if (startAt == null) startAt = t;   // first pitch: the first playable moment (a stop before it is a delayed start)
        played += GW.STEP_MIN;
        t += STEP;
        if (played >= until) return { outcome: PLAN_OUTCOME.PLAYED, delays, startAt, endT: t, played };
        continue;
      }
    }

    // In a delay (or waiting to start).
    delay.mm += s.rate * (GW.STEP_MIN / 60);
    if (s.lightning) { delay.lastLightning = t; if (delay.reason !== STOP_REASON.LIGHTNING && delay.atPlayMin === played && t === delay.startT) delay.reason = STOP_REASON.LIGHTNING; }
    const sprinkle = !s.lightning && s.rate < GW.DRY_RATE_MMH && !(s.kind !== PRECIP_RAIN && s.dbz > DBZ_MIN);
    if (!sprinkle) { delay.dryFrom = null; delay.resumeAt = null; }
    else if (delay.dryFrom == null) delay.dryFrom = t;
    if (delay.resumeAt == null && sprinkle && !delay.fieldOnly
        && t - delay.lastLightning >= GW.LIGHTNING_CLEAR_MIN * MIN && t - delay.dryFrom >= GW.DRY_MIN * MIN) {
      delay.resumeAt = t + Math.min(GW.PREP_MAX_MIN, GW.PREP_MIN + Math.round(delay.mm * GW.PREP_PER_MM)) * MIN;
    }
    if (delay.fieldOnly && delay.resumeAt == null && sprinkle && t - delay.lastLightning >= GW.LIGHTNING_CLEAR_MIN * MIN) {
      delay.resumeAt = Math.max(t, delay.startT + GW.SOGGY_WORK_MIN * MIN);
    }

    const waited = t - delay.startT;
    const notStarted = startAt == null;
    if (delay.resumeAt != null && t >= delay.resumeAt) {
      if (_afterCurfew(ctx, t)) return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'curfew', reason: delay.reason });
      delays.push({ startT: delay.startT, endT: t, atPlayMin: delay.atPlayMin, reason: delay.reason, mm: Math.round(delay.mm * 10) / 10 });
      delay = null;
      phase = 'play';
      continue;   // this sample is playable: play from it
    }
    if (notStarted && t - gameTime >= GW.MAX_START_WAIT_MIN * MIN) return finish(PLAN_OUTCOME.POSTPONED, { decidedAt: t, calledBy: 'limit', reason: delay.reason });
    if (!notStarted && waited >= GW.MAX_DELAY_MIN * MIN) return finish(PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'limit', reason: delay.reason });
    if (_afterCurfew(ctx, t)) return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'curfew', reason: delay.reason });
    if (opts.crew && waited > 0 && waited % (GW.CREW_CHECK_MIN * MIN) === 0
        && opts.crew({ t, phase, played, soak, delay, startAt, delays })) {
      return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'forecast', reason: delay.reason });
    }
    t += STEP;
  }
  return finish(startAt == null ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'limit', reason: delay?.reason ?? STOP_REASON.RAIN });
}

/**
 * What the forecast run made at `issueT` shows for this game from `state`:
 * the run's own outcome when it shows the game failing, otherwise null.
 * Not started: failing = no first pitch, or called before it's official.
 * Under way: failing = no restart before the limits.
 */
function _forecastSaysNo(ctx, venue, gameTime, state, issueT = state.t) {
  const fctx = forecastContext(ctx, issueT);
  const sample = _sampler(fctx, venue.x, venue.y);
  const notStarted = state.startAt == null;
  const r = _run(fctx, sample, gameTime, state, { until: notStarted ? GW.OFFICIAL_PLAY_MIN : Math.min(GW.PLAN_MAX_MIN, state.played + GW.STEP_MIN) });
  return r.outcome !== PLAN_OUTCOME.PLAYED ? r : null;
}

/**
 * A wet evening in the forecast run: steady rain (STEADY_RATE_MMH or more)
 * through STEADY_SHARE of the game's three hours — the kind of night a club
 * calls off ahead of time even though play could go on between showers.
 * → 'rain' / 'snow', or null.
 */
function _steadyRain(fctx, venue, gameTime) {
  let wet = 0, snow = 0, n = 0;
  for (let t = gameTime + 7.5 * MIN; t < gameTime + GW.PLAY_MIN * MIN; t += 15 * MIN, n++) {
    const p = precipAt(fctx, venue.x, venue.y, t);
    if (p.rateMmH >= GW.STEADY_RATE_MMH) { wet++; if (p.kind !== PRECIP_RAIN) snow++; }
  }
  return wet >= GW.STEADY_SHARE * n ? (snow * 2 > wet ? STOP_REASON.SNOW : STOP_REASON.RAIN) : null;
}

/** Rain (inches) over the 6 hours and snow (mm, melted) over the 12 hours before first pitch. */
function _before(ctx, venue, gameTime) {
  let rainMm = 0, snowMm = 0;
  for (let t = gameTime - 12 * 60 * MIN + 10 * MIN; t < gameTime; t += 20 * MIN) {
    const s = precipAt(ctx, venue.x, venue.y, t);
    const mm = s.rateMmH / 3;
    if (s.kind === PRECIP_RAIN) { if (t >= gameTime - 6 * 60 * MIN) rainMm += mm; }
    else snowMm += mm;
  }
  return { rainIn: rainMm / 25.4, snowMm };
}

/**
 * gameWeatherPlan(ctx, game) — what the weather does to a game:
 * {
 *   v, venueId, gameTime,
 *   outcome: 'played' | 'postponed' | 'called',
 *   decidedAt,       // postponed / called: when it became known (null when played)
 *   calledBy,        // 'forecast' | 'limit' | 'curfew' | 'field' (postponed / called)
 *   reason,          // why it was postponed / called: 'rain' | 'lightning' | 'snow' | 'wet field'
 *   startAt,         // actual first pitch (null when postponed)
 *   delays: [{ startT, endT, atPlayMin, reason, mm }],   // a delay at 0 playing minutes before startAt is a delayed start
 *   endT,            // called: the call; played: the end of the plan's span (the game itself ends when the sim says)
 *   stopAtPlayMin,   // called: playing minutes completed when it's called
 *   playMin,         // PLAY_MIN (nine innings)
 * }
 * `ctx` is the save's weather context (WeatherClimate.weatherContext).
 */
export function gameWeatherPlan(ctx, game) {
  const venue = venueOf(ctx.map, game);
  const gameTime = game.gameTime;
  const base = { v: PLAN_VERSION, venueId: venue.teamId, gameTime, playMin: GW.PLAY_MIN };
  const sample = _sampler(ctx, venue.x, venue.y);
  const postpone = (decidedAt, calledBy, reason) => ({
    ...base, outcome: PLAN_OUTCOME.POSTPONED, decidedAt, calledBy, reason, startAt: null, delays: [], endT: null, stopAtPlayMin: null,
  });

  // The field: soaked or snow-covered before the game.
  const pre = _before(ctx, venue, gameTime);
  const fieldCall = gameTime - Math.min(...GW.PREGAME_CALLS_MIN) * MIN;
  if (pre.snowMm >= GW.SNOW_COVER_MM) return postpone(fieldCall, 'field', STOP_REASON.SNOW);
  if (pre.rainIn >= GW.WASHOUT_IN) return postpone(fieldCall, 'field', STOP_REASON.FIELD);

  // The club reads the forecast before first pitch (the run the GM sees then).
  // It takes both: the forecast shows no game, and the chance of rain the GM
  // sees for the game is high — a club doesn't call off a 30% chance.
  for (let i = 0; i < GW.PREGAME_CALLS_MIN.length; i++) {
    const t = gameTime - GW.PREGAME_CALLS_MIN[i] * MIN;
    const no = _forecastSaysNo(ctx, venue, gameTime, { t: gameTime, phase: 'play', played: 0, startAt: null, delay: null }, t);
    const wet = no ? null : _steadyRain(forecastContext(ctx, t), venue, gameTime);
    if ((no || wet) && chanceOfPrecip(ctx, t, venue.x, venue.y, gameTime, gameTime + GW.PLAY_MIN * MIN).chance >= GW.PREGAME_CALL_CHANCE[i]) {
      return postpone(t, 'forecast', no ? (no.reason ?? STOP_REASON.RAIN) : wet);
    }
  }

  // Game day, as it happens.
  const soggy = pre.rainIn >= GW.SOGGY_IN;
  const start = soggy
    ? { t: gameTime, phase: 'delay', played: 0, startAt: null,
        delay: { startT: gameTime, atPlayMin: 0, reason: STOP_REASON.FIELD, mm: 0, lastLightning: -Infinity, dryFrom: gameTime, resumeAt: null, fieldOnly: true } }
    : { t: gameTime, phase: 'play', played: 0, startAt: null, delay: null };
  const r = _run(ctx, sample, gameTime, start, {
    crew: (st) => _forecastSaysNo(ctx, venue, gameTime, st),
  });
  const out = {
    ...base, outcome: r.outcome,
    decidedAt: r.outcome === PLAN_OUTCOME.PLAYED ? null : r.decidedAt,
    calledBy: r.calledBy ?? null, reason: r.reason ?? null,
    startAt: r.startAt, delays: r.delays.map(_cleanDelay), endT: r.outcome === PLAN_OUTCOME.POSTPONED ? null : r.endT,
    stopAtPlayMin: r.outcome === PLAN_OUTCOME.CALLED ? r.played : null,
  };
  if (out.outcome === PLAN_OUTCOME.POSTPONED) out.startAt = null;   // (its delays are the wait before the call)
  return out;
}

const _cleanDelay = (d) => ({ startT: d.startT, endT: d.endT, atPlayMin: d.atPlayMin, reason: d.reason, mm: Math.round((d.mm || 0) * 10) / 10 });

/**
 * When a playing minute happens on the clock under a plan: first pitch plus
 * the playing time, plus every delay that came before it. (A plan that never
 * started has no clock: null.)
 */
export function playClock(plan, playMin) {
  if (plan.startAt == null) return null;
  let t = plan.startAt + playMin * MIN;
  for (const d of plan.delays) if (d.atPlayMin > 0 && d.atPlayMin <= playMin && d.startT >= plan.startAt) t += d.endT - d.startT;
  return t;
}

/** The delay (if any) a game is in at a moment. */
export function delayAt(plan, t) {
  return plan.delays.find(d => t >= d.startT && t < d.endT) || null;
}


/**
 * gameConditions(ctx, plan) — the park report through a game, an inning at a
 * time (every 20 playing minutes from first pitch across the plan's span), on
 * the clock the plan gives: [{ playMin, t, tempF, humidity, windMph,
 * windOutMph, windCrossMph, windText, rateMmH, kind, label, icon }]. What
 * SimEngine plays in: the wind and the temperature move the ball, rain while
 * they play through it makes the ball slick. Empty for a postponed game.
 */
export function gameConditions(ctx, plan) {
  if (plan.startAt == null) return [];
  const park = ctx.map.parks[plan.venueId] || ctx.map.parks.user;
  const bearing = parkBearing(ctx.map, plan.venueId);
  const out = [];
  for (let m = 0; m <= GW.PLAN_MAX_MIN; m += 2 * GW.HALF_MIN) {
    if (plan.stopAtPlayMin != null && m > plan.stopAtPlayMin) break;
    const t = playClock(plan, m);
    const c = conditionsAt(ctx, park.x, park.y, t);
    const w = windAtPark(c.wind, bearing);
    out.push({ playMin: m, t, tempF: c.tempF, humidity: c.humidity, windMph: c.wind.mph,
               windOutMph: Math.round(w.outMph * 10) / 10, windCrossMph: Math.round(w.crossMph * 10) / 10, windText: w.text,
               rateMmH: c.precip.rateMmH, kind: c.precip.kind, label: c.label, icon: c.icon });
  }
  return out;
}

/**
 * gameRecord(ctx, plan, conditions) — what's kept on a game (§102.3): the
 * weather at first pitch (the park report) and the field after the rain
 * before it. Replaces the old fixed "Clear":
 *   weather:        { label, icon, tempF, humidity, windMph, windOutMph, windText, scoringMod }
 *   fieldCondition: { infieldSoftness 0..1, moundFirmness, trackCondition, temperature, rainBeforeIn }
 */
export function gameRecord(ctx, plan, conditions) {
  const c = conditions[0];
  const park = ctx.map.parks[plan.venueId] || ctx.map.parks.user;
  const first = plan.startAt ?? plan.gameTime;
  const rainIn = rainTotal(ctx, park.x, park.y, first - 12 * 60 * MIN, first, 20);
  const soft = Math.min(1, rainIn / 1.0);
  return {
    weather: c ? { label: c.label, icon: c.icon, tempF: Math.round(c.tempF), humidity: c.humidity, windMph: c.windMph,
                   windOutMph: c.windOutMph, windText: c.windText, scoringMod: 1.0 } : null,
    fieldCondition: { infieldSoftness: Math.round(soft * 100) / 100, moundFirmness: Math.round((1 - 0.4 * soft) * 100) / 100,
                      trackCondition: Math.round((1 - 0.3 * soft) * 100) / 100, temperature: c ? Math.round(c.tempF) : 72,
                      rainBeforeIn: rainIn },
  };
}

/**
 * resumptionPlan(ctx, game, resumeAt, remainingMin) — the weather for picking
 * up a suspended game: the plan for a "game" at the resumption's time, read
 * only as far as the rest of the game lasts. A plan that would call it again
 * before the rest is played, or postpone it, means it waits for another day:
 * { ok: false, plan } — otherwise { ok: true, plan }.
 */
export function resumptionPlan(ctx, game, resumeAt, remainingMin) {
  const plan = gameWeatherPlan(ctx, { ...game, gameTime: resumeAt });
  if (plan.outcome === PLAN_OUTCOME.POSTPONED) return { ok: false, plan };
  if (plan.outcome === PLAN_OUTCOME.CALLED && plan.stopAtPlayMin <= remainingMin) return { ok: false, plan };
  return { ok: true, plan };
}

/**
 * forecastForGame(ctx, nowMs, game) — §102.7 the forecast for a game at its
 * ballpark (a makeup moved to the other park: that park), as every screen
 * shows it. See WeatherForecast.gameForecast. The venue is added: { venueId }.
 */
export function forecastForGame(ctx, nowMs, game) {
  const venue = venueOf(ctx.map, game);
  return { venueId: venue.teamId, ...gameForecast(ctx, nowMs, venue.x, venue.y, game.gameTime, parkBearing(ctx.map, venue.teamId)) };
}
