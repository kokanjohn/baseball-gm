/**
 * ui/components/radar-worker.js
 * §100 (step 2a) Builds radar frames off the main thread (a module worker).
 * Messages in:
 *   { type: 'context', ctx: { seed, region, cal, tzMin } }
 *   { type: 'frames', gen, items: [{ key, frame, grid }] }   — newest gen wins
 * Messages out:
 *   { type: 'frame', gen, key, frame }   (frame.data transferred)
 *   { type: 'done', gen } | { type: 'error', gen, key, message }
 * Frames are built one at a time, yielding between them so a newer request
 * (a zoom or loop change) cancels the rest of an older one.
 */

import { regionMap } from '../../engine/WeatherMap.js';
import { buildFrame } from '../../engine/RadarFrames.js';

let base = null;
let latestGen = 0;

const tick = () => new Promise(r => setTimeout(r, 0));

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'context') {
    base = { ...m.ctx, map: regionMap(m.ctx.region) };
    return;
  }
  if (m.type !== 'frames' || !base) return;
  latestGen = m.gen;
  for (const it of m.items) {
    await tick();
    if (m.gen !== latestGen) return;          // superseded
    try {
      const frame = buildFrame(base, it.frame, it.grid);
      self.postMessage({ type: 'frame', gen: m.gen, key: it.key, frame }, [frame.data.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', gen: m.gen, key: it.key, message: String(err?.message || err) });
    }
  }
  if (m.gen === latestGen) self.postMessage({ type: 'done', gen: m.gen });
};
