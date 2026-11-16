/**
 * engine/GameWeatherStory.js
 * §122.51 (phase 2) A game's weather story: what the grounds crew knows about
 * the weather at the ballpark, moment by moment, from the morning of game day
 * to an hour past the end — the timeline the messages (phase 3, 4) and the
 * dashboard's first-pitch card (phase 5) are built on.
 *
 * Two kinds of moment:
 *   - what happens (the plan, GameWeather.gameWeatherPlan): the tarp on and
 *     off, crew trouble found out, first pitch, a postponement, a delay, play
 *     resuming, a game called;
 *   - what the crew expects (GameWeather.projectGame: what has happened, then
 *     the radar's forecast run of that hour): the morning look, hourly changes,
 *     the start's estimate and every revision, the resume estimate in a delay,
 *     a heads-up before rain stops play, a late watch near the end.
 * The crew's estimates are honest: made from what it could see then, so they
 * firm up as the moment nears and now and then run late (rain heavier than
 * the radar showed, the crew hitting trouble).
 *
 * Pure and deterministic: the weather context, a game and its plan in; the
 * same story every time. Ours and the league's alike — who hears about it is
 * for the callers (home: the crew's own; away: what reaches us).
 *
 * Events, in time order: { id, at, kind, ...detail }
 *   outlook        { chance, wx: 'rain'|'storms'|'snow'|'mix', rainAt, field?, proj, estStart? }   the morning look
 *                  (chance: of rain during the game; rainAt: when the radar's run first has it at the park,
 *                   from three hours before first pitch — rain before the game matters too)
 *   update         { chance, prevChance, rainAt, proj, prevProj, estStart? }       an hourly look that changed
 *   clearing       { chance }                                                        the rain no longer looks like reaching the game
 *   tarp_on        { reason, inGame }                                               the field covered
 *   tarp_off       { estStart? | estResume?, inGame }                               the tarp coming off: the field nearly ready
 *   crew_trouble   { mins, estStart? | estResume?, inGame }                         the field taking longer than it should
 *   start_delayed  { estStart }                                                     the first word that the start will be late
 *   start_estimate { estStart, prevEst }                                            a revised estimate
 *   start_doubt    { }                                                              no start in sight: the game is in doubt
 *   start_on_time  { prevEst }                                                      back on schedule
 *   first_pitch    { lateMin }                                                      a held start under way
 *   postponed      { reason, calledBy }
 *   heads_up       { eta }                                                          rain due to stop play
 *   delay          { reason, playMin, estResume? }
 *   resume_estimate{ estResume, prevEst }
 *   resumed        { mins, playMin }
 *   called         { reason }
 *   late_watch     { eta }                                                          rain due around the end
 *   gap            { gapStart, estStart }                                           (phase 3) a held start: going ahead in light rain
 *                                                                                    would start it at gapStart (first such moment only)
 * proj: 'ontime' | 'delayed' | 'doubt'.
 */

import { projectGame, runShows, fieldOutlook, forecastForGame, playClock, PLAN_OUTCOME } from './GameWeather.js';
import { localDayStart } from './WeatherClimate.js';
import { hash01 } from './WeatherNoise.js';
import { GAME_WEATHER as GW, WEATHER_STORY as WS } from '../data/constants.js';

const MIN = 60_000;
const NOWCAST_MIN = 60;   // a run tracks storms already up for its first hour (WeatherSystems NOWCAST_MS)
const r5 = (t) => (t == null ? null : Math.round(t / (5 * MIN)) * 5 * MIN);

/** The morning look's moment on game day. */
export function outlookAt(ctx, gameTime) {
  const day = localDayStart(gameTime, ctx.tzMin);
  const t = day + WS.outlookHour * 60 * MIN + Math.floor(hash01(ctx.seed, 7401, Math.round(gameTime / MIN)) * WS.outlookJitterMin) * MIN;
  return Math.min(t, gameTime - WS.outlookLeadMin * MIN);
}

/**
 * gameStory(ctx, game, plan, opts) → events (see above).
 *   game — as for gameWeatherPlan ({ homeId | venueId, gameTime, field?, patience?, isSpring? … })
 *   plan — its plan
 *   opts.result — the sim's weather once the game has been played (game.wxResult): the delays that
 *                 really happened (a plan's delay after the last out never does). Without it, the plan's
 *                 delays inside nine innings stand in.
 *   opts.until  — stop at this moment (the story so far)
 */
export function gameStory(ctx, game, plan, opts = {}) {
  const gameTime = game.gameTime;
  const until = opts.until ?? Infinity;
  const cache = new Map();
  const ev = [];
  const add = (at, kind, detail = {}) => { if (at <= until) ev.push({ id: `${kind}:${gameTime}:${Math.round(at / MIN)}`, at, kind, ...detail }); };
  const proj = (t, playTo) => projectGame(ctx, game, plan, t, { cache, until: playTo });
  const projKind = (p) => (p.outcome !== PLAN_OUTCOME.PLAYED || p.late ? 'doubt' : p.startAt - gameTime >= WS.delayedMin * MIN ? 'delayed' : 'ontime');
  const chanceAt = (t) => { try { return forecastForGame(ctx, t, game); } catch { return null; } };
  const wxWord = (f) => (f?.kind === 'snow' ? 'snow' : f?.kind === 'mix' ? 'mix' : f?.kind === 'storms' ? 'storms' : 'rain');
  const postponed = plan.outcome === PLAN_OUTCOME.POSTPONED;
  const settled = postponed ? plan.decidedAt : plan.startAt;   // the start's question answered

  // 1. The morning look, then hourly until the crew is watching.
  const t0 = outlookAt(ctx, gameTime);
  const crewFrom = gameTime - WS.crewFromMin * MIN;
  let told = null;   // { chance, proj } last told
  for (let t = t0; t < crewFrom && t < settled; t += 60 * MIN) {
    const rainAt = runShows(ctx, game, t, Math.max(t, gameTime - WS.watchBeforeMin * MIN), gameTime + WS.watchAfterMin * MIN, GW.TARP_ON_RATE_MMH, cache);
    // (A field the rain or snow has already soaked counts too: the crew is worried about it.)
    const fo = rainAt == null ? fieldOutlook(ctx, game, t) : null;
    const wet = rainAt != null || !!(fo && (fo.soggy || fo.washout || fo.snowCover));
    if (!told) {
      if (!wet) continue;
      const f = chanceAt(t), p = proj(t);
      told = { chance: f?.chance ?? null, proj: projKind(p) };
      add(t, 'outlook', { chance: told.chance, wx: wxWord(f), rainAt: r5(rainAt), ...(fo && rainAt == null ? { field: fo.snowCover ? 'snow' : 'wet' } : {}), proj: told.proj, ...(told.proj === 'delayed' ? { estStart: r5(p.startAt) } : {}) });
      continue;
    }
    if (told.cleared) { if (!wet) continue; told.cleared = false; }
    else if (!wet) { const f = chanceAt(t); add(t, 'clearing', { chance: f?.chance ?? null }); told = { ...told, cleared: true, chance: f?.chance ?? told.chance, proj: 'ontime' }; continue; }
    const f = chanceAt(t), p = proj(t), k = projKind(p), c = f?.chance ?? null;
    if (k !== told.proj || (c != null && told.chance != null && Math.abs(c - told.chance) >= WS.chanceStep)) {
      add(t, 'update', { chance: c, prevChance: told.chance, rainAt: r5(rainAt), proj: k, prevProj: told.proj, ...(k === 'delayed' ? { estStart: r5(p.startAt) } : {}) });
      told = { chance: c, proj: k };
    }
  }

  // 2. The crew watches the start: the field, and its estimate of first pitch.
  const tarpsBefore = [...(plan.tarps || [])];
  const startDelay = (plan.delays || []).find(d => d.atPlayMin === 0 && d.startT <= gameTime + 5 * MIN);
  const truthMoments = [];
  for (const x of tarpsBefore) {
    truthMoments.push({ at: x.onT, kind: 'tarp_on', reason: 'rain' });
    truthMoments.push({ at: x.offT, kind: 'tarp_off' });
    if (x.trouble) truthMoments.push({ at: x.offT + GW.TROUBLE_SEEN_MIN * MIN, kind: 'crew_trouble', mins: x.trouble });
  }
  if (startDelay) {
    const on = startDelay.tarpOnT ?? startDelay.startT;
    truthMoments.push({ at: on, kind: 'tarp_on', reason: startDelay.reason, light: startDelay.tarpOnT == null });
    if (startDelay.offT != null && (!postponed || startDelay.offT < plan.decidedAt)) {
      truthMoments.push({ at: startDelay.offT, kind: 'tarp_off' });
      if (startDelay.trouble) truthMoments.push({ at: startDelay.offT + GW.TROUBLE_SEEN_MIN * MIN, kind: 'crew_trouble', mins: startDelay.trouble });
    }
  }
  const watchFrom = Math.min(crewFrom, ...truthMoments.map(m => m.at));
  const end = settled ?? Infinity;
  const grid = [];
  for (let t = Math.ceil(watchFrom / (WS.crewEveryMin * MIN)) * WS.crewEveryMin * MIN; t < end; t += WS.crewEveryMin * MIN) grid.push({ at: t, kind: 'check' });
  const moments = [...truthMoments.filter(m => m.at < end && m.at >= t0 - 6 * 60 * MIN), ...grid].sort((a, b) => a.at - b.at || (a.kind === 'check') - (b.kind === 'check'));
  let est = null, doubt = false, gapTold = false;   // the estimate last given (null: on time, as scheduled)
  const estFrom = gameTime - WS.estLeadMin * MIN;
  for (const m of moments) {
    if (m.kind === 'tarp_on') { add(m.at, 'tarp_on', { reason: m.light ? 'lightning' : m.reason, inGame: false }); }
    const p = proj(m.at), k = projKind(p), e = k === 'doubt' ? null : r5(Math.max(gameTime, p.startAt));
    // (The crew gives the start's estimate once it's close — the tarp on, or rain on the radar within the
    //  hour — never off a forecast alone hours out, which the next hour's run may take back.)
    const tarpOn = truthMoments.some(x => x.kind === 'tarp_on' && x.at <= m.at) && !truthMoments.some(x => x.kind === 'tarp_off' && x.at <= m.at && x.at > Math.max(...truthMoments.filter(y => y.kind === 'tarp_on' && y.at <= m.at).map(y => y.at)));
    // (Only as far as the run tracks what's already up — its first hour; past that it places storms of its own.)
    const nowcastTo = Math.floor(m.at / (60 * MIN)) * 60 * MIN + NOWCAST_MIN * MIN;
    const near = tarpOn || runShows(ctx, game, m.at, m.at, Math.min(m.at + 60 * MIN, nowcastTo), GW.TARP_ON_RATE_MMH, cache) != null;
    const speak = (m.at >= estFrom && (near || est != null || doubt)) || m.kind !== 'check';
    if (m.kind === 'tarp_off' || m.kind === 'crew_trouble') {
      const isLate = k !== 'doubt' && e - gameTime >= WS.delayedMin * MIN;
      const detail = { inGame: false, ...(isLate ? { estStart: e } : {}) };
      if (m.kind === 'tarp_off') add(m.at, 'tarp_off', detail); else add(m.at, 'crew_trouble', { mins: m.mins, ...detail });
      if (speak && k !== 'doubt') { if (isLate) est = e; else if (est != null) { add(m.at, 'start_on_time', { prevEst: est }); est = null; } doubt = false; }
      continue;
    }
    if (!speak) continue;
    // (phase 3) a held start that could go ahead in light rain: the GM could start it sooner.
    if (!gapTold && m.at >= gameTime - 30 * MIN && k === 'delayed' && !game.startInRain) {
      const alt = projectGame(ctx, game, plan, m.at, { cache, startInRain: true });
      if (alt.outcome === PLAN_OUTCOME.PLAYED && !alt.late && alt.startAt > m.at && alt.startAt <= p.startAt - WS.gapGainMin * MIN) {
        add(m.at, 'gap', { gapStart: r5(alt.startAt), estStart: e });
        gapTold = true;
      }
    }
    if (k === 'doubt') { if (!doubt) { add(m.at, 'start_doubt'); doubt = true; } continue; }
    const late = e - gameTime >= WS.delayedMin * MIN;
    if (est == null) {
      if (late) { add(m.at, 'start_delayed', { estStart: e }); est = e; doubt = false; }
      else if (doubt) { doubt = false; }
    } else if (Math.abs(e - est) >= WS.estStepMin * MIN || doubt) {
      if (!late) { add(m.at, 'start_on_time', { prevEst: est }); est = null; }
      else { add(m.at, 'start_estimate', { estStart: e, prevEst: est }); est = e; }
      doubt = false;
    }
  }
  if (postponed) { add(plan.decidedAt, 'postponed', { reason: plan.reason, calledBy: plan.calledBy }); return _sorted(ev); }
  if (plan.startAt > gameTime) add(plan.startAt, 'first_pitch', { lateMin: Math.round((plan.startAt - gameTime) / MIN) });

  // 3. Under way: the delays that happen (the sim's, once played; else the plan's inside nine innings).
  const inGame = (opts.result?.delays || plan.delays || [])
    .filter(d => d.atPlayMin > 0 && d.startT >= plan.startAt && (opts.result || d.atPlayMin < GW.PLAY_MIN));
  const calledAt = plan.outcome === PLAN_OUTCOME.CALLED ? plan.decidedAt : null;
  for (const d of inGame) {
    const warnAt = d.startT - WS.headsUpMin * MIN;
    if (warnAt >= plan.startAt) {
      const eta = runShows(ctx, game, warnAt, warnAt, d.startT + 15 * MIN, GW.STOP_RATE_MMH, cache);
      if (eta != null) add(warnAt, 'heads_up', { eta: r5(eta) });
    }
    const resumeEst = (t) => {
      const p = proj(t, d.atPlayMin + GW.STEP_MIN);
      const x = p.delays.find(y => y.startT === d.startT);
      return p.outcome === PLAN_OUTCOME.PLAYED && x ? r5(x.endT) : null;
    };
    let rest = resumeEst(d.startT);
    add(d.startT, 'delay', { reason: d.reason, playMin: d.atPlayMin, inGame: true, ...(rest ? { estResume: rest } : {}) });
    add(d.startT, 'tarp_on', { reason: d.reason, inGame: true });
    const stop = calledAt != null && calledAt >= d.startT && calledAt <= d.endT ? calledAt : d.endT;
    const ms = [];
    for (let t = d.startT + WS.crewEveryMin * MIN; t < stop; t += WS.crewEveryMin * MIN) ms.push({ at: t, kind: 'check' });
    if (d.offT != null && d.offT < stop) ms.push({ at: d.offT, kind: 'tarp_off' });
    if (d.trouble && d.offT != null && d.offT + GW.TROUBLE_SEEN_MIN * MIN < stop) ms.push({ at: d.offT + GW.TROUBLE_SEEN_MIN * MIN, kind: 'crew_trouble', mins: d.trouble });
    ms.sort((a, b) => a.at - b.at || (a.kind === 'check') - (b.kind === 'check'));
    for (const m of ms) {
      const e = resumeEst(m.at);
      if (m.kind === 'tarp_off') { add(m.at, 'tarp_off', { inGame: true, ...(e ? { estResume: e } : {}) }); if (e) rest = e; continue; }
      if (m.kind === 'crew_trouble') { add(m.at, 'crew_trouble', { mins: m.mins, inGame: true, ...(e ? { estResume: e } : {}) }); if (e) rest = e; continue; }
      if (e && (rest == null || Math.abs(e - rest) >= WS.estStepMin * MIN)) { add(m.at, 'resume_estimate', { estResume: e, prevEst: rest }); rest = e; }
    }
    if (stop === d.endT && !(calledAt != null && calledAt === d.endT)) add(d.endT, 'resumed', { mins: Math.round((d.endT - d.startT) / MIN), playMin: d.atPlayMin });
  }
  if (calledAt != null && (!opts.result || opts.result.ruling)) add(calledAt, 'called', { reason: plan.reason });

  // 4. Near the end: rain due around the last outs (extra innings, a long game).
  if (calledAt == null) {
    const estEnd = opts.result?.endT ?? playClock(plan, GW.PLAY_MIN);
    const lookAt = estEnd - WS.lateWatchMin * MIN;
    if (estEnd && lookAt > plan.startAt && !inGame.some(d => d.endT > lookAt)) {
      const eta = runShows(ctx, game, lookAt, estEnd, estEnd + WS.lateWatchMin * MIN, GW.STOP_RATE_MMH, cache);
      if (eta != null) add(lookAt, 'late_watch', { eta: r5(eta) });
    }
  }
  return _sorted(ev);
}

function _sorted(ev) {
  const seen = new Set();
  return ev.sort((a, b) => a.at - b.at).filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
