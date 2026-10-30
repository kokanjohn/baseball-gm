/**
 * ui/components/ForecastSource.js
 * §102.7 (step 3) Where screens get forecasts: one long-lived worker
 * (forecast-worker.js) works them out off the main thread; answers are kept
 * for the forecast hour they belong to (a new hourly run makes new ones), so
 * the dashboard, the forecast sheet and the schedule share them. Without
 * workers, they're worked out on the main thread a slice at a time.
 *
 *   gameForecastFor(state, game, nowMs)        → Promise<forecast>   (GameWeather.forecastForGame)
 *   outlookFor(state, venueId, nowMs, onDay)   → Promise<days[]>      (the 10-day, onDay(i, day) as each comes)
 *   hourlyFor(state, venueId, nowMs, hours)    → Promise<hours[]>
 *   peek(kind, …)                              → the cached answer, or null
 */

import { weatherContext, MS_HOUR } from '../../engine/WeatherClimate.js';
import { regionMap } from '../../engine/WeatherMap.js';
import { dailyForecastDay, hourlyForecast } from '../../engine/WeatherForecast.js';
import { forecastForGame } from '../../engine/GameWeather.js';

const _done = new Map();      // key → value
const _waiting = new Map();   // key → Promise
let _worker = null, _workerTried = false, _ctxSent = null, _nextId = 1;
const _calls = new Map();     // id → { resolve, reject, onPart }
let _base = null;

function _ctx(state) {
  const c = weatherContext(state);
  const params = { seed: c.seed, region: c.region, cal: c.cal, tzMin: c.tzMin };
  const sig = JSON.stringify(params);
  if (!_base || _base.sig !== sig) _base = { sig, params, full: { ...params, map: regionMap(params.region) } };
  return _base;
}

function _getWorker() {
  if (_workerTried) return _worker;
  _workerTried = true;
  if (typeof Worker === 'undefined') return null;
  try {
    _worker = new Worker(new URL('./forecast-worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const m = e.data || {};
      const call = _calls.get(m.id);
      if (!call) return;
      if (m.type === 'part') { call.onPart?.(m.index, m.value); return; }
      _calls.delete(m.id);
      if (m.type === 'res') call.resolve(m.value); else call.reject(new Error(m.message));
    };
    _worker.onerror = (e) => {
      console.warn('[forecast] worker unavailable, working on the main thread', e?.message || '');
      _worker = null;
      for (const [, call] of _calls) call.retry();
      _calls.clear();
    };
  } catch { _worker = null; }
  return _worker;
}

function _onMain(kind, base, args, onPart) {
  return new Promise((resolve) => {
    const later = (f) => setTimeout(f, 0);
    if (kind === 'daily') {
      const out = [];
      const step = (d) => later(() => {
        if (d >= (args.days || 10)) { resolve(out); return; }
        const v = dailyForecastDay(base, args.nowMs, args.x, args.y, d);
        out.push(v); onPart?.(d, v); step(d + 1);
      });
      step(0);
    } else later(() => resolve(kind === 'game' ? forecastForGame(base, args.nowMs, args.game) : hourlyForecast(base, args.nowMs, args.x, args.y, args.hours)));
  });
}

function _ask(state, kind, keyParts, args, onPart) {
  const b = _ctx(state);
  const issue = Math.floor(args.nowMs / MS_HOUR) * MS_HOUR;
  const key = [b.sig, kind, issue, ...keyParts].join('|');
  if (_done.has(key)) {
    const v = _done.get(key);
    if (kind === 'daily' && onPart) v.forEach((d, i) => onPart(i, d));
    return Promise.resolve(v);
  }
  if (_waiting.has(key)) {
    const p = _waiting.get(key);
    if (onPart) p.parts.push(onPart);
    return p;
  }
  const parts = onPart ? [onPart] : [];
  const fan = (i, v) => parts.forEach(f => f(i, v));
  const w = _getWorker();
  let p;
  const main = () => _onMain(kind, b.full, args, fan);
  if (w) {
    if (_ctxSent !== b.sig) { w.postMessage({ type: 'context', ctx: b.params }); _ctxSent = b.sig; }
    p = new Promise((resolve, reject) => {
      const id = _nextId++;
      _calls.set(id, { resolve, reject, onPart: fan, retry: () => main().then(resolve, reject) });
      w.postMessage({ type: 'req', id, kind, args });
    });
  } else p = main();
  p.parts = parts;
  _waiting.set(key, p);
  // (Answers for older runs aren't needed again; keep the cache small.)
  if (_done.size > 300) _done.clear();
  return p.then(v => { _done.set(key, v); _waiting.delete(key); return v; }, err => { _waiting.delete(key); throw err; });
}

const _gameArg = (g) => ({ gameTime: g.gameTime, homeId: g.homeId, venueId: g.venueId, isHome: g.isHome, opponentId: g.opponentId });
const _parkOf = (state, venueId) => { const m = regionMap(weatherContext(state).region); return m.parks[venueId] || m.parks.user; };

export function gameForecastFor(state, game, nowMs = Date.now()) {
  const g = _gameArg(game);
  return _ask(state, 'game', [g.gameTime, g.venueId ?? g.homeId ?? (g.isHome ? 'user' : g.opponentId)], { nowMs, game: g });
}

export function outlookFor(state, venueId, nowMs = Date.now(), onDay = null, days = 10) {
  const p = _parkOf(state, venueId);
  return _ask(state, 'daily', [venueId, days], { nowMs, x: p.x, y: p.y, days }, onDay);
}

export function hourlyFor(state, venueId, nowMs = Date.now(), hours = 24) {
  const p = _parkOf(state, venueId);
  return _ask(state, 'hourly', [venueId, hours], { nowMs, x: p.x, y: p.y, hours });
}

/** The answer already worked out for this forecast hour, or null (no work started). */
export function peekGameForecast(state, game, nowMs = Date.now()) {
  const b = _ctx(state), g = _gameArg(game);
  const key = [b.sig, 'game', Math.floor(nowMs / MS_HOUR) * MS_HOUR, g.gameTime, g.venueId ?? g.homeId ?? (g.isHome ? 'user' : g.opponentId)].join('|');
  return _done.get(key) || null;
}
