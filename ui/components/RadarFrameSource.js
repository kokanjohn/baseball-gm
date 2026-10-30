/**
 * ui/components/RadarFrameSource.js
 * §100 (step 2a) Where the radar screen gets its frames: asks the radar worker
 * to build them (off the main thread), keeps the ones built in a cache, and
 * hands them over as they arrive. Falls back to building on the main thread
 * in small slices when workers aren't available.
 *
 *   const src = createFrameSource({ onFrame: (key, frame) => …, onDone: () => … });
 *   src.setContext(state);                         // the save's weather
 *   src.request(frames, grid, { first: index });   // a loop at a zoom; returns keys
 *   src.get(key);                                  // a built frame, or null
 *   src.dispose();
 */

import { weatherContext } from '../../engine/WeatherClimate.js';
import { buildFrame, frameKey } from '../../engine/RadarFrames.js';
import { regionMap } from '../../engine/WeatherMap.js';

const CACHE_BYTES = 12 * 1024 * 1024;   // ~200 frames at 200×260
const _cache = new Map();                // key → frame (shared by every source: frames don't depend on who asked)
let _cacheBytes = 0;

function _remember(key, frame) {
  if (_cache.has(key)) return;
  _cache.set(key, frame);
  _cacheBytes += frame.data.byteLength;
  while (_cacheBytes > CACHE_BYTES && _cache.size > 1) {
    const [k, f] = _cache.entries().next().value;
    _cache.delete(k); _cacheBytes -= f.data.byteLength;
  }
}

export function createFrameSource({ onFrame = () => {}, onDone = () => {}, useWorker = true } = {}) {
  let worker = null, base = null, gen = 0, disposed = false, fallbackTimer = null, pending = null;
  if (useWorker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./radar-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (disposed || m.gen !== gen) return;
        if (m.type === 'frame') {
          _remember(m.key, m.frame);
          if (pending) pending.todo = pending.todo.filter(it => it.key !== m.key);
          onFrame(m.key, m.frame);
        } else if (m.type === 'done') { pending = null; onDone(); }
        else if (m.type === 'error') console.warn('[radar] frame failed:', m.message);
      };
      worker.onerror = (e) => {
        console.warn('[radar] worker unavailable, building on the main thread', e?.message || '');
        worker = null;
        // Whatever it hadn't finished is built here instead.
        if (pending && pending.gen === gen && !disposed) _fallback(gen, pending.todo);
      };
    } catch { worker = null; }
  }

  const api = {
    get usesWorker() { return !!worker; },

    setContext(state) {
      const ctx = weatherContext(state);
      const params = { seed: ctx.seed, region: ctx.region, cal: ctx.cal, tzMin: ctx.tzMin };
      if (base && JSON.stringify(params) === JSON.stringify({ seed: base.seed, region: base.region, cal: base.cal, tzMin: base.tzMin })) return;
      base = { ...params, map: regionMap(params.region) };
      if (worker) worker.postMessage({ type: 'context', ctx: params });
    },

    /** Build the frames of a loop at a zoom; the one being shown (`first`) first, then outward. */
    request(frames, grid, { first = 0 } = {}) {
      if (!base) throw new Error('RadarFrameSource: setContext first');
      gen++;
      const keys = frames.map(f => frameKey(base, f, grid));
      const order = frames.map((_, i) => i).sort((a, b) => Math.abs(a - first) - Math.abs(b - first));
      const todo = order.filter(i => !_cache.has(keys[i])).map(i => ({ key: keys[i], frame: frames[i], grid }));
      // Already built ones are handed over at once — just after this returns,
      // so the caller knows the keys before any frame arrives.
      const ready = order.filter(i => _cache.has(keys[i])).map(i => keys[i]);
      const g0 = gen;
      queueMicrotask(() => {
        if (disposed || g0 !== gen) return;
        for (const k of ready) if (_cache.has(k)) onFrame(k, _cache.get(k));
        if (!todo.length) onDone();
      });
      if (!todo.length) return keys;
      pending = { gen, todo };
      if (worker) worker.postMessage({ type: 'frames', gen, items: todo });
      else _fallback(gen, todo);
      return keys;
    },

    get(key) { return _cache.get(key) || null; },

    dispose() {
      disposed = true;
      if (worker) worker.terminate();
      if (fallbackTimer) clearTimeout(fallbackTimer);
    },
  };

  function _fallback(g, todo) {
    let i = 0;
    const step = () => {
      if (disposed || g !== gen) return;
      if (i >= todo.length) { onDone(); return; }
      const it = todo[i++];
      const frame = buildFrame(base, it.frame, it.grid);
      _remember(it.key, frame);
      onFrame(it.key, frame);
      fallbackTimer = setTimeout(step, 0);
    };
    fallbackTimer = setTimeout(step, 0);
  }

  return api;
}

/** For tests: forget every built frame. */
export function clearFrameCache() { _cache.clear(); _cacheBytes = 0; }
