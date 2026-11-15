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
 *   - §122.51 before the game the field is covered whenever it rains (Light
 *     Rain or harder), and first pitch waits for the tarp to come off and the
 *     field to be ready — starting is a higher bar than going on;
 *   - the tarp comes off 30 minutes after the last lightning, once the rain is
 *     down to a sprinkle and the radar shows a clear window ahead; then the
 *     grounds crew needs time for the field (and now and then runs long);
 *   - the club reads the forecast (the same run the GM sees) three hours and
 *     ninety minutes before first pitch and postpones only if, by the day's
 *     own rules, it shows no game (or a first pitch too late to wait for);
 *   - during a delay the crew reads it every 30 minutes and calls the game if
 *     it shows no restart; there are also hard limits (the wait to start and a
 *     long delay once under way — by the club's patience, how hard the game is
 *     to make up — and a 1 AM curfew).
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
import { hash01, hashString } from './WeatherNoise.js';
import { chanceOfPrecip, gameForecast } from './WeatherForecast.js';
import { venueOf, parkBearing } from './WeatherMap.js';
import { GAME_WEATHER as GW, FIELD_CARE as FC } from '../data/constants.js';

/**
 * r170 fieldParams(field) — the field's numbers for a game: GAME_WEATHER's, moved by our park's
 * drainage (field.drainage, 0–3) and the game's prep (field.prep). No field: the league's numbers.
 */
export function fieldParams(field = null) {
  const lvl = Math.max(0, Math.min(FC.drainage.max, field?.drainage || 0)), prep = !!field?.prep, D = FC.drainage, P = FC.prep;
  return {
    soakMin: GW.SOAK_MIN + D.soakPerLevel * lvl,
    soggyIn: GW.SOGGY_IN + D.soggyPerLevel * lvl + (prep ? P.soggy : 0),
    washoutIn: GW.WASHOUT_IN + D.washoutPerLevel * lvl,
    soggyWorkMin: prep ? P.soggyWork : GW.SOGGY_WORK_MIN,
    prepMin: prep ? P.prepMin : GW.PREP_MIN,
    prepPerMm: GW.PREP_PER_MM * (1 - D.prepPerMmCut * lvl) * (prep ? P.prepPerMm : 1),
    prepMax: prep ? P.prepMax : GW.PREP_MAX_MIN,
    dryRate: GW.DRY_RATE_MMH + D.dryRatePerLevel * lvl,              // the rain the field can take with the tarp off
    dryMin: Math.max(5, GW.DRY_MIN - D.dryMinPerLevel * lvl - (prep ? P.dryMinCut : 0)),   // how long it has to be that light first
    softIn: (1 + D.softPerLevel * lvl) / (prep ? P.soft : 1),   // the rain before first pitch that makes the infield fully soft
  };
}
/** A plan's field, as a key (a plan made for another field is made again). */
export const fieldKey = (field) => (field ? `d${field.drainage || 0}${field.prep ? 'p' : ''}` : '');
const NO_FIELD = fieldParams(null);

const MIN = 60_000;
const STEP = GW.STEP_MIN * MIN;

export const PLAN_VERSION = 2;   // §122.51 the pregame tarp, patience, the crew's luck

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
function _stopReason(s, soakMin, F = NO_FIELD) {
  if (s.lightning) return STOP_REASON.LIGHTNING;
  if (s.kind !== PRECIP_RAIN && s.dbz >= GW.SNOW_DBZ) return STOP_REASON.SNOW;
  if (s.rate >= GW.STOP_RATE_MMH || soakMin >= F.soakMin) return STOP_REASON.RAIN;
  return null;
}

const _afterCurfew = (ctx, t) => { const h = localHour(t, ctx.tzMin); return h >= GW.CURFEW_LOCAL_H && h < 9; };
const LIGHTNING_CLEAR = GW.LIGHTNING_CLEAR_MIN * MIN;
/** No more than a sprinkle (the field can take it with the tarp off). */
const _sprinkle = (s, F) => !s.lightning && s.rate < F.dryRate && !(s.kind !== PRECIP_RAIN && s.dbz > DBZ_MIN);
/**
 * §122.51 Is the radar clear ahead? `look(t)` gives the sampler the crew reads at
 * moment t (the truth's: the run of that hour; a forecast's: its own). Before
 * first pitch the bar is the tarp's (Light Rain or harder, lightning, snow);
 * under way, anything that would stop play again.
 */
function _clearAhead(look, t, started, F) {
  const s = look(t);
  for (let u = t + STEP; u <= t + GW.CREW_WINDOW_MIN * MIN; u += STEP) {
    const x = s(u);
    if (x.lightning || (x.kind !== PRECIP_RAIN && x.dbz >= GW.SNOW_DBZ) || x.rate >= (started ? GW.STOP_RATE_MMH : GW.TARP_ON_RATE_MMH)) return false;
  }
  return true;
}

/** The crew's look ahead for the truth: the forecast run of each hour (the radar's next frames), by hour. */
function _crewLook(ctx, venue) {
  const runs = new Map();
  return (t) => {
    const h = Math.floor(t / 3_600_000);
    let s = runs.get(h);
    if (!s) { s = _sampler(forecastContext(ctx, t), venue.x, venue.y); runs.set(h, s); }
    return s;
  };
}

/** The crew's work after the tarp comes off: minutes, by the rain that fell on it. */
const _prepMin = (F, mm) => Math.min(F.prepMax, F.prepMin + Math.round(mm * F.prepPerMm));

/**
 * §122.51 patienceOf(game) — how long a club waits before giving up on a game
 * (GAME_WEATHER.PATIENCE): the game's own (`game.patience`, which GameEngine
 * sets by how hard the game is to make up), else by its kind.
 */
export function patienceOf(game) {
  const key = GW.PATIENCE[game?.patience] ? game.patience : game?.isSpring ? 'spring' : game?.isPlayoff ? 'post' : 'normal';
  return { key, ...GW.PATIENCE[key] };
}

/**
 * §122.51 crewTrouble(ctx, venueId, field) — the crew isn't perfect: now and
 * then the field takes longer than it should once the tarp comes off (more
 * water than expected, the tarp snagging). (key) → extra minutes, seeded per
 * cover-up, so the same delay always has the same luck. Drainage and the
 * crew's prep make it less likely. The truth only: no forecast sees it.
 */
export function crewTrouble(ctx, venueId, field = null) {
  const T = GW.TROUBLE;
  const p = T.chance * (1 - T.drainageCut * Math.min(FC.drainage.max, field?.drainage || 0)) * (field?.prep ? T.prepCut : 1);
  const vk = hashString(String(venueId));
  return (key) => {
    const k = Math.round(key / MIN);
    if (hash01(ctx.seed, 7301, vk, k) >= p) return 0;
    return Math.round(T.minMin + (T.maxMin - T.minMin) * hash01(ctx.seed, 7302, vk, k));
  };
}

// ── The game, five minutes at a time ────────────────────────────────────────

/**
 * Run the game forward from a state through a sampler's weather.
 * state: { t, phase: 'delay'|'play', played (playing minutes), delay?, soak }
 * Returns { outcome, delays, startAt, endT, decidedAt, calledBy, reason, played }.
 * opts.crew(state) → true when the crew's forecast check says call it now.
 * opts.until: stop once this many playing minutes are in (the forecast only needs to know whether the game gets far enough).
 * opts.field: r170 the field's numbers (fieldParams).
 * opts.patience: §122.51 the club's limits (patienceOf).
 * opts.trouble: §122.51 the crew's luck (crewTrouble) — the truth only.
 * opts.look: §122.51 the radar the crew reads before pulling the tarp (_crewLook; a forecast: its own sampler).
 */
function _run(ctx, sample, gameTime, state, opts = {}) {
  const F = opts.field || NO_FIELD;
  const P = opts.patience || GW.PATIENCE.normal;
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
    const why = _stopReason(s, soak, F);

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
    const sprinkle = _sprinkle(s, F);
    if (!sprinkle) { delay.dryFrom = null; delay.resumeAt = null; delay.offT = null; }
    else if (delay.dryFrom == null) delay.dryFrom = t;
    if (delay.resumeAt == null && sprinkle && !delay.fieldOnly
        && t - delay.lastLightning >= LIGHTNING_CLEAR && t - delay.dryFrom >= F.dryMin * MIN
        && (!opts.look || _clearAhead(opts.look, t, startAt != null, F))) {
      // (A wait for lightning alone, with the field never covered, needs no crew work.)
      const covered = !delay.uncovered || delay.mm >= 0.5;
      const trouble = covered && opts.trouble ? opts.trouble(delay.troubleKey ?? delay.startT) : 0;
      delay.trouble = trouble;
      delay.offT = t;
      delay.resumeAt = t + (covered ? _prepMin(F, delay.mm) + trouble : 0) * MIN;
    }
    if (delay.fieldOnly && delay.resumeAt == null && sprinkle && t - delay.lastLightning >= LIGHTNING_CLEAR) {
      delay.resumeAt = Math.max(t, delay.startT + F.soggyWorkMin * MIN);
    }

    const waited = t - delay.startT;
    const notStarted = startAt == null;
    if (delay.resumeAt != null && t >= delay.resumeAt) {
      if (_afterCurfew(ctx, t)) return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'curfew', reason: delay.reason });
      delays.push(_closeDelay(delay, t));
      delay = null;
      phase = 'play';
      continue;   // this sample is playable: play from it
    }
    if (notStarted && t - gameTime >= P.startWait * MIN) return finish(PLAN_OUTCOME.POSTPONED, { decidedAt: t, calledBy: 'limit', reason: delay.reason });
    if (!notStarted && waited >= P.delayMax * MIN) return finish(PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'limit', reason: delay.reason });
    if (_afterCurfew(ctx, t)) return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'curfew', reason: delay.reason });
    if (opts.crew && waited > 0 && waited % (GW.CREW_CHECK_MIN * MIN) === 0
        && opts.crew({ t, phase, played, soak, delay, startAt, delays })) {
      return finish(notStarted ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'forecast', reason: delay.reason });
    }
    t += STEP;
  }
  return finish(startAt == null ? PLAN_OUTCOME.POSTPONED : PLAN_OUTCOME.CALLED, { decidedAt: t, calledBy: 'limit', reason: delay?.reason ?? STOP_REASON.RAIN });
}

/** A delay as the plan keeps it (when the tarp came off and any crew trouble included). */
const _closeDelay = (d, endT) => ({
  startT: d.startT, endT, atPlayMin: d.atPlayMin, reason: d.reason, mm: Math.round((d.mm || 0) * 10) / 10,
  ...(d.tarpOnT != null ? { tarpOnT: d.tarpOnT } : {}), ...(d.offT != null ? { offT: d.offT } : {}), ...(d.trouble ? { trouble: d.trouble } : {}),
});

/**
 * §122.51 _pregame(sample, gameTime, F, opts) — the field before the game.
 * From PREGAME_TARP_MIN out, the crew covers the field when it rains (Light
 * Rain or harder for TARP_ON_MIN, a downpour or snow at once) and takes the
 * tarp off by the delay's rules: a sprinkle for DRY_MIN, 30 minutes past the
 * last lightning, then the crew's work. Returns
 *   { tarps: [{ onT, offT, readyT, mm, trouble? }] (covered and ready again before first pitch),
 *     state: the game's state at first pitch for _run — on time, or a delayed
 *            start still under the tarp (or waiting out lightning) }.
 * Starting is a higher bar than going on: a band of light rain that a game
 * under way would play through keeps the tarp on, and the start waits.
 */
function _pregame(sample, gameTime, F, opts = {}) {
  const t0 = gameTime - GW.PREGAME_TARP_MIN * MIN;
  const tarps = [];
  let tarp = null, wetRun = 0, lastLightning = -Infinity;
  for (let t = t0; t < gameTime; t += STEP) {
    const s = sample(t);
    if (s.lightning) lastLightning = t;
    const frozen = s.kind !== PRECIP_RAIN && s.dbz >= GW.SNOW_DBZ;
    if (!tarp) {
      wetRun = s.rate >= GW.TARP_ON_RATE_MMH || frozen ? wetRun + GW.STEP_MIN : 0;
      // (Already raining when the crew starts watching: the field was covered.)
      if (s.rate >= GW.STOP_RATE_MMH || frozen || wetRun >= GW.TARP_ON_MIN || (t === t0 && wetRun > 0)) {
        tarp = { onT: t === t0 ? t : t - (wetRun - GW.STEP_MIN) * MIN, reason: frozen ? STOP_REASON.SNOW : STOP_REASON.RAIN, mm: 0, dryFrom: null, offT: null, resumeAt: null, trouble: 0 };
      }
    }
    if (!tarp) continue;
    tarp.mm += s.rate * (GW.STEP_MIN / 60);
    const sprinkle = _sprinkle(s, F);
    if (!sprinkle) { tarp.dryFrom = null; tarp.offT = null; tarp.resumeAt = null; }
    else if (tarp.dryFrom == null) tarp.dryFrom = t;
    if (tarp.resumeAt == null && sprinkle && t - lastLightning >= LIGHTNING_CLEAR && t - tarp.dryFrom >= F.dryMin * MIN
        && (!opts.look || _clearAhead(opts.look, t, false, F))) {
      tarp.trouble = opts.trouble ? opts.trouble(tarp.onT) : 0;
      tarp.offT = t;
      tarp.resumeAt = t + (_prepMin(F, tarp.mm) + tarp.trouble) * MIN;
    }
    if (tarp.resumeAt != null && t >= tarp.resumeAt) {
      tarps.push({ onT: tarp.onT, offT: tarp.offT, readyT: tarp.resumeAt, mm: Math.round(tarp.mm * 10) / 10, ...(tarp.trouble ? { trouble: tarp.trouble } : {}) });
      tarp = null; wetRun = 0;
    }
  }
  const at = { t: gameTime, phase: 'play', played: 0, startAt: null, delay: null, soak: 0 };
  if (tarp) {
    // Still under the tarp (or not yet ready) at first pitch: a delayed start that began when the field was covered.
    const why = gameTime - lastLightning < LIGHTNING_CLEAR ? STOP_REASON.LIGHTNING : tarp.reason;
    at.phase = 'delay';
    at.delay = { startT: gameTime, atPlayMin: 0, reason: why, mm: tarp.mm, lastLightning, dryFrom: tarp.dryFrom, offT: tarp.offT,
                 resumeAt: tarp.resumeAt, trouble: tarp.trouble, tarpOnT: tarp.onT, troubleKey: tarp.onT };
  } else if (gameTime - lastLightning < LIGHTNING_CLEAR) {
    // Lightning about, the field uncovered: the start waits 30 minutes past the last of it.
    at.phase = 'delay';
    at.delay = { startT: gameTime, atPlayMin: 0, reason: STOP_REASON.LIGHTNING, mm: 0, lastLightning, dryFrom: null, resumeAt: null, uncovered: true };
  }
  return { tarps, state: at };
}

/**
 * What the forecast run made at `issueT` shows for this game from `state`
 * (null: from before first pitch, the field as the run sees it): the run's
 * own outcome when it shows the game failing, otherwise null. What has
 * already fallen is what the crew saw; what's ahead is the run's.
 * Not started: failing = no first pitch, or called before it's official.
 * Under way: failing = no restart before the limits.
 * The same rules as the day itself (§122.51): a club calls a game off ahead
 * only when its forecast shows the game can't be played.
 */
function _forecastSaysNo(ctx, venue, gameTime, state, issueT, F = NO_FIELD, P = GW.PATIENCE.normal) {
  const fctx = forecastContext(ctx, issueT);
  const truth = _sampler(ctx, venue.x, venue.y), ahead = _sampler(fctx, venue.x, venue.y);
  const sample = (t) => (t <= issueT ? truth(t) : ahead(t));
  const look = () => sample;
  const st = state || _pregame(sample, gameTime, F, { look }).state;
  const notStarted = st.startAt == null;
  const r = _run(fctx, sample, gameTime, st, { field: F, patience: P, look, until: notStarted ? GW.OFFICIAL_PLAY_MIN : Math.min(GW.PLAN_MAX_MIN, st.played + GW.STEP_MIN) });
  if (r.outcome !== PLAN_OUTCOME.PLAYED) return r;
  // (A first pitch this late is as good as none: the club calls it rather than keep everyone waiting.)
  if (notStarted && r.startAt - gameTime >= P.callLate * MIN) return { ...r, outcome: PLAN_OUTCOME.POSTPONED, reason: r.delays[0]?.reason ?? STOP_REASON.RAIN };
  return null;
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
 *   v, venueId, gameTime, patience,
 *   outcome: 'played' | 'postponed' | 'called',
 *   decidedAt,       // postponed / called: when it became known (null when played)
 *   calledBy,        // 'forecast' | 'limit' | 'curfew' | 'field' (postponed / called)
 *   reason,          // why it was postponed / called: 'rain' | 'lightning' | 'snow' | 'wet field'
 *   startAt,         // actual first pitch (null when postponed)
 *   tarps: [{ onT, offT, readyT, mm, trouble? }],   // §122.51 the field covered before the game, and ready again before first pitch
 *   delays: [{ startT, endT, atPlayMin, reason, mm, tarpOnT?, offT?, trouble? }],
 *                    // a delay at 0 playing minutes before startAt is a delayed start (tarpOnT: when the field was covered)
 *   endT,            // called: the call; played: the end of the plan's span (the game itself ends when the sim says)
 *   stopAtPlayMin,   // called: playing minutes completed when it's called
 *   playMin,         // PLAY_MIN (nine innings)
 * }
 * `ctx` is the save's weather context (WeatherClimate.weatherContext). The
 * game may carry `field` (r170, our park) and `patience` (§122.51).
 * opts.aheadCalls = false: the day as it would go with no call made ahead
 * (for the checks: what a game called off ahead would really have done).
 */
export function gameWeatherPlan(ctx, game, opts = {}) {
  const venue = venueOf(ctx.map, game);
  const gameTime = game.gameTime;
  // r170 our park's field (drainage, the game's prep): null elsewhere
  const F = fieldParams(game.field), field = game.field || null;
  const P = patienceOf(game);
  const base = { v: PLAN_VERSION, venueId: venue.teamId, gameTime, playMin: GW.PLAY_MIN, field, fieldKey: fieldKey(field), patience: P.key };
  const sample = _sampler(ctx, venue.x, venue.y);
  const trouble = crewTrouble(ctx, venue.teamId, field);
  const postpone = (decidedAt, calledBy, reason, tarps = []) => ({
    ...base, outcome: PLAN_OUTCOME.POSTPONED, decidedAt, calledBy, reason, startAt: null, tarps, delays: [], endT: null, stopAtPlayMin: null,
  });

  // The field: soaked or snow-covered before the game.
  const pre = _before(ctx, venue, gameTime);
  const fieldCall = gameTime - Math.min(...GW.PREGAME_CALLS_MIN) * MIN;
  if (pre.snowMm >= GW.SNOW_COVER_MM) return postpone(fieldCall, 'field', STOP_REASON.SNOW);
  if (pre.rainIn >= F.washoutIn) return postpone(fieldCall, 'field', STOP_REASON.FIELD);

  // The field before the game (the truth), for the record and the start.
  const look = _crewLook(ctx, venue);
  const pg = _pregame(sample, gameTime, F, { trouble, look });

  // The club reads the forecast before first pitch (the run the GM sees then):
  // the game must look unplayable by the day's own rules, and the chance of
  // rain the GM sees high enough for the club's patience.
  for (let i = 0; opts.aheadCalls !== false && i < GW.PREGAME_CALLS_MIN.length; i++) {
    const t = gameTime - GW.PREGAME_CALLS_MIN[i] * MIN;
    const no = _forecastSaysNo(ctx, venue, gameTime, null, t, F, P);
    if (no && chanceOfPrecip(ctx, t, venue.x, venue.y, gameTime, gameTime + GW.PLAY_MIN * MIN).chance >= P.callChance[i]) {
      return postpone(t, 'forecast', no.reason ?? STOP_REASON.RAIN, pg.tarps.filter(x => x.onT < t));
    }
  }

  // Game day, as it happens.
  const soggy = pre.rainIn >= F.soggyIn;
  const start = soggy && pg.state.phase === 'play'
    ? { t: gameTime, phase: 'delay', played: 0, startAt: null,
        delay: { startT: gameTime, atPlayMin: 0, reason: STOP_REASON.FIELD, mm: 0, lastLightning: -Infinity, dryFrom: gameTime, resumeAt: null, fieldOnly: true } }
    : pg.state;
  const r = _run(ctx, sample, gameTime, start, {
    field: F, patience: P, trouble, look,
    crew: (st) => _forecastSaysNo(ctx, venue, gameTime, st, st.t, F, P),
  });
  const out = {
    ...base, outcome: r.outcome,
    decidedAt: r.outcome === PLAN_OUTCOME.PLAYED ? null : r.decidedAt,
    calledBy: r.calledBy ?? null, reason: r.reason ?? null,
    startAt: r.startAt, tarps: pg.tarps, delays: r.delays.map(_cleanDelay), endT: r.outcome === PLAN_OUTCOME.POSTPONED ? null : r.endT,
    stopAtPlayMin: r.outcome === PLAN_OUTCOME.CALLED ? r.played : null,
  };
  if (out.outcome === PLAN_OUTCOME.POSTPONED) out.startAt = null;   // (its delays are the wait before the call)
  return out;
}

const _cleanDelay = (d) => _closeDelay(d, d.endT);

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
  const soft = Math.min(1, rainIn / fieldParams(plan.field).softIn);   // r170 drainage and prep: a firmer infield
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
