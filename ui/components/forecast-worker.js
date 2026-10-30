/**
 * ui/components/forecast-worker.js
 * §102.7 (step 3) Works out forecasts off the main thread (a module worker):
 * a game's forecast, the hour-by-hour, and the 10-day outlook (day by day, so
 * the screen fills in as each is ready). The same pure functions the engine
 * and the harness use, so the numbers are identical wherever they're made.
 * Messages in:
 *   { type: 'context', ctx: { seed, region, cal, tzMin } }
 *   { type: 'req', id, kind: 'game'|'daily'|'hourly', args }
 * Messages out:
 *   { type: 'part', id, index, value }  (the 10-day: one day at a time)
 *   { type: 'res', id, value } | { type: 'error', id, message }
 */

import { regionMap } from '../../engine/WeatherMap.js';
import { dailyForecastDay, hourlyForecast } from '../../engine/WeatherForecast.js';
import { forecastForGame } from '../../engine/GameWeather.js';

let base = null;
const queue = [];
let busy = false;
const tick = () => new Promise(r => setTimeout(r, 0));

async function run(m) {
  const a = m.args || {};
  if (m.kind === 'game') return forecastForGame(base, a.nowMs, a.game);
  if (m.kind === 'hourly') return hourlyForecast(base, a.nowMs, a.x, a.y, a.hours);
  if (m.kind === 'daily') {
    const out = [];
    for (let d = 0; d < (a.days || 10); d++) {
      const v = dailyForecastDay(base, a.nowMs, a.x, a.y, d);
      out.push(v);
      self.postMessage({ type: 'part', id: m.id, index: d, value: v });
      await tick();
    }
    return out;
  }
  throw new Error(`unknown forecast kind ${m.kind}`);
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    await tick();
    try { self.postMessage({ type: 'res', id: m.id, value: await run(m) }); }
    catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) }); }
  }
  busy = false;
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'context') { base = { ...m.ctx, map: regionMap(m.ctx.region) }; return; }
  if (m.type === 'req' && base) { queue.push(m); pump(); }
};
