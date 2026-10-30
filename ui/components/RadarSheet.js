/**
 * ui/components/RadarSheet.js
 * §100 (step 2c) The full-screen radar: the loop of what's happened and
 * what's forecast, centred on a ballpark.
 *
 *   openRadarSheet({ state, focusId, nowMs?, onClose? })
 *
 * Controls (text labels): which park to centre on; Play / Pause; a timeline
 * with a tick per frame (lit once it's built) and the Now marker; the loop
 * (Past 2 hrs / Next 6 hrs / Next 24 hrs); the zoom (Region / Metro /
 * Ballpark); the legend. The past and now are what happened; the future is
 * the forecast run the dashboard and the schedule read — every future frame
 * says FORECAST.
 *
 * Frames come from the radar worker (RadarFrameSource) and are drawn by
 * RadarRenderer. The loop pauses while the app is hidden and refreshes when a
 * new radar picture or forecast run comes along. Everything is torn down on
 * close (listeners, the worker, the timers).
 */

import { createFrameSource } from './RadarFrameSource.js';
import { createRadarRenderer, radarLegendHTML, radarLegendCSS, formatFrameTime } from './RadarRenderer.js';
import { RADAR_ZOOMS, DEFAULT_ZOOM } from './RadarMap.js';
import { frameTimes, LOOP_WINDOWS, LOOP_ORDER, DEFAULT_LOOP } from '../../engine/RadarFrames.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { cityOf } from '../../engine/WeatherMap.js';

const FRAME_MS = 500;        // each frame of the loop
const DWELL_MS = 1600;       // hold on the last frame before starting over
const REFRESH_MS = 60_000;   // look for a newer radar picture / forecast run

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The ballpark a game is played at (the home club's). */
export function venueOf(game) {
  if (!game) return 'user';
  if (game.venueId) return game.venueId;   // §102.3 a makeup played at the other club's park
  return game.isHome ? 'user' : (game.opponentId || 'user');
}

let _open = null;

export function openRadarSheet({ state, focusId = 'user', nowMs = null, onClose = null, loop = DEFAULT_LOOP, zoomIdx = DEFAULT_ZOOM } = {}) {
  if (_open) _open.close();
  _css();
  const clock = () => (nowMs != null ? nowMs : Date.now());
  const ctx = weatherContext(state);
  const map = ctx.map;
  const userCity = state?.userTeam?.city || '';
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  const parks = Object.keys(map.parks)
    .map(id => ({ id, name: cityOf(map, id, userCity) }))
    .sort((a, b) => (b.id === 'user') - (a.id === 'user') || a.name.localeCompare(b.name));

  const el = document.createElement('div');
  el.id = 'radar-sheet';
  el.className = 'rs-overlay';
  el.innerHTML = `
    <div class="rs-panel" role="dialog" aria-label="Radar">
      <div class="rs-head">
        <div class="rs-title">Radar</div>
        <label class="rs-park-wrap"><span class="rs-park-label">Center on</span>
          <select class="rs-park" aria-label="Center the radar on">${parks.map(p => `<option value="${p.id}">${_esc(p.name)}</option>`).join('')}</select>
        </label>
        <button class="rs-done" type="button">Done</button>
      </div>
      <div class="rs-timebar">
        <span class="rs-time"></span><span class="rs-tag"></span>
        <span class="rs-status"></span>
      </div>
      <div class="rs-map"><canvas></canvas></div>
      <div class="rs-controls">
        <div class="rs-row">
          <button class="rs-play" type="button">Pause</button>
          <div class="rs-timeline">
            <input class="rs-scrub" type="range" min="0" max="0" step="1" value="0" aria-label="Radar time">
            <div class="rs-ticks"></div>
            <div class="rs-ends"><span class="rs-start"></span><span class="rs-now">Now</span><span class="rs-end"></span></div>
          </div>
        </div>
        <div class="rs-seg rs-loops">${LOOP_ORDER.map(k => `<button type="button" data-loop="${k}">${LOOP_WINDOWS[k].label}</button>`).join('')}</div>
        <div class="rs-seg rs-zooms">${RADAR_ZOOMS.map((z, i) => `<button type="button" data-zoom="${i}">${z.label}</button>`).join('')}</div>
        ${radarLegendHTML()}
      </div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));

  const $ = (sel) => el.querySelector(sel);
  const canvas = $('canvas');
  const renderer = createRadarRenderer(canvas);
  const listeners = [];
  const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); listeners.push(() => target.removeEventListener(ev, fn, opts)); };

  const S = { focusId: map.parks[focusId] ? focusId : 'user', loop, zoomIdx, frames: [], keys: [], index: 0, loaded: new Set(), playing: true, timer: null, built: 0 };
  $('.rs-park').value = S.focusId;

  const src = createFrameSource({
    onFrame: (key) => {
      const i = S.keys.indexOf(key);
      if (i < 0) return;
      S.loaded.add(i);
      const f = src.get(key);
      // Draw the shown frame now; get the rest ready while the screen is idle.
      if (i === S.index) _draw();
      else _idle(() => renderer.prepare(f));
      _ticks(); _status();
    },
    onDone: () => _status(),
  });
  src.setContext(state);

  function _setView() {
    renderer.setView({ map, focusId: S.focusId, zoomIdx: S.zoomIdx, theme: theme(), userCity });
  }

  function _load({ keepTime = false } = {}) {
    const prevT = S.frames[S.index]?.t;
    S.frames = frameTimes(clock(), S.loop);
    const nowIdx = S.frames.findIndex(f => f.isNow);
    S.index = keepTime && prevT != null ? Math.max(0, S.frames.findIndex(f => f.t >= prevT)) : nowIdx;
    if (S.index < 0) S.index = nowIdx;
    S.loaded = new Set();
    S.keys = src.request(S.frames, renderer.grid, { first: S.index });
    const scrub = $('.rs-scrub');
    scrub.max = String(S.frames.length - 1);
    scrub.value = String(S.index);
    const tz = ctx.tzMin, now = clock();
    $('.rs-start').textContent = formatFrameTime(S.frames[0].t, tz, now);
    $('.rs-end').textContent = formatFrameTime(S.frames.at(-1).t, tz, now);
    // The Now marker sits under the now frame.
    const pct = S.frames.length > 1 ? (nowIdx / (S.frames.length - 1)) * 100 : 0;
    const nowEl = $('.rs-now');
    nowEl.style.left = `${pct}%`;
    nowEl.classList.toggle('at-end', pct > 90);
    nowEl.classList.toggle('at-start', pct < 10);
    el.querySelectorAll('[data-loop]').forEach(b => b.classList.toggle('on', b.dataset.loop === S.loop));
    el.querySelectorAll('[data-zoom]').forEach(b => b.classList.toggle('on', +b.dataset.zoom === S.zoomIdx));
    _ticks(); _draw(); _status();
  }

  function _draw() {
    const fr = S.frames[S.index];
    if (!fr) return;
    const f = src.get(S.keys[S.index]);
    renderer.draw(f);
    $('.rs-time').textContent = formatFrameTime(fr.t, ctx.tzMin, clock());
    const tag = $('.rs-tag');
    tag.textContent = fr.forecast ? 'FORECAST' : fr.isNow ? 'NOW' : 'PAST';
    tag.className = `rs-tag ${fr.forecast ? 'fc' : fr.isNow ? 'now' : 'past'}`;
    $('.rs-scrub').value = String(S.index);
    el.querySelectorAll('.rs-tick').forEach((t, i) => t.classList.toggle('cur', i === S.index));
  }

  function _ticks() {
    const box = $('.rs-ticks');
    if (box.children.length !== S.frames.length) {
      box.innerHTML = S.frames.map(f => `<span class="rs-tick${f.forecast ? ' fc' : ''}"></span>`).join('');
    }
    [...box.children].forEach((t, i) => { t.classList.toggle('ready', S.loaded.has(i)); t.classList.toggle('cur', i === S.index); });
  }

  function _status() {
    const n = S.frames.length, k = S.loaded.size;
    $('.rs-status').textContent = k < n ? `Loading ${k}/${n}` : '';
  }

  // ── Playback ──
  function _schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(_step, ms); }
  function _step() {
    if (!S.playing || document.hidden) return;
    if (S.loaded.size === 0) { _schedule(FRAME_MS); return; }
    // The next built frame; after the last, start over.
    let next = S.index;
    for (let k = 1; k <= S.frames.length; k++) {
      const j = (S.index + k) % S.frames.length;
      if (S.loaded.has(j)) { next = j; break; }
    }
    S.index = next;
    _draw();
    _schedule(S.index === S.frames.length - 1 || ![...S.loaded].some(j => j > S.index) ? DWELL_MS : FRAME_MS);
  }
  function _play(on) {
    S.playing = on;
    $('.rs-play').textContent = on ? 'Pause' : 'Play';
    if (on) _schedule(FRAME_MS); else clearTimeout(S.timer);
  }

  // ── Wiring ──
  on($('.rs-play'), 'click', () => _play(!S.playing));
  on($('.rs-scrub'), 'input', (e) => { _play(false); S.index = +e.target.value; _draw(); });
  el.querySelectorAll('[data-loop]').forEach(b => on(b, 'click', () => { if (S.loop === b.dataset.loop) return; S.loop = b.dataset.loop; _load(); _play(true); }));
  el.querySelectorAll('[data-zoom]').forEach(b => on(b, 'click', () => { if (S.zoomIdx === +b.dataset.zoom) return; S.zoomIdx = +b.dataset.zoom; _setView(); _load({ keepTime: true }); }));
  on($('.rs-park'), 'change', (e) => { S.focusId = e.target.value; _setView(); _load({ keepTime: true }); });
  on($('.rs-done'), 'click', () => api.close());
  on(el, 'click', (e) => { if (e.target === el) api.close(); });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') api.close(); if (e.key === ' ') { e.preventDefault(); _play(!S.playing); } });
  on(document, 'visibilitychange', () => { if (!document.hidden && S.playing) _schedule(FRAME_MS); });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { renderer.resize(); _load({ keepTime: true }); }) : null;
  // A newer radar picture or forecast run: rebuild the loop, keeping the time shown.
  const refresh = setInterval(() => {
    const fresh = frameTimes(clock(), S.loop);
    if (fresh[0]?.t !== S.frames[0]?.t || fresh.at(-1)?.t !== S.frames.at(-1)?.t || fresh[1]?.issueMs !== S.frames[1]?.issueMs) _load({ keepTime: true });
  }, REFRESH_MS);

  const api = {
    close() {
      if (!_open) return;
      _open = null;
      clearTimeout(S.timer); clearInterval(refresh);
      ro?.disconnect();
      listeners.forEach(off => off());
      src.dispose(); renderer.dispose();
      el.classList.remove('open');
      setTimeout(() => el.remove(), 220);
      onClose?.();
    },
    /** For tests: the sheet's state. */
    get state() { return { focusId: S.focusId, loop: S.loop, zoomIdx: S.zoomIdx, index: S.index, frames: S.frames.length, loaded: S.loaded.size, playing: S.playing, usesWorker: src.usesWorker }; },
  };
  _open = api;

  // Slide in first; draw the map on the frame after (it's the heavy part), so
  // the tap answers at once.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _setView();
    _load();
    ro?.observe($('.rs-map'));
    _play(true);
  }));
  return api;
}

function _idle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 400 });
  else setTimeout(fn, 16);
}

function _css() {
  if (document.getElementById('radar-sheet-css')) return;
  const st = document.createElement('style');
  st.id = 'radar-sheet-css';
  st.textContent = `
    .rs-overlay{position:fixed;inset:0;z-index:1000;background:var(--bg);display:flex;opacity:0;transform:translateY(16px);transition:opacity .2s ease,transform .2s ease;}
    .rs-overlay.open{opacity:1;transform:none;}
    .rs-panel{flex:1;display:flex;flex-direction:column;min-height:0;padding:max(8px,env(safe-area-inset-top)) 0 max(10px,env(safe-area-inset-bottom));}
    .rs-head{display:flex;align-items:center;gap:10px;padding:6px 14px 8px;}
    .rs-title{font-size:18px;font-weight:800;color:var(--text);}
    .rs-park-wrap{display:flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--muted);font-weight:600;}
    .rs-park{font:inherit;font-size:14px;font-weight:700;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:6px 8px;max-width:150px;}
    .rs-done{font:inherit;font-size:14px;font-weight:700;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:7px 12px;cursor:pointer;}
    .rs-timebar{display:flex;align-items:center;gap:8px;padding:0 14px 8px;font-size:15px;font-weight:700;color:var(--text);min-height:24px;}
    .rs-tag{font-size:10px;font-weight:800;letter-spacing:.08em;padding:3px 7px;border-radius:6px;background:var(--surface2);color:var(--soft);}
    .rs-tag.fc{background:#3b2f0b;color:#f5c542;}
    [data-theme="light"] .rs-tag.fc{background:#fff2c7;color:#8a6200;}
    .rs-status{margin-left:auto;font-size:12px;font-weight:600;color:var(--muted);}
    .rs-map{flex:1;min-height:200px;position:relative;border-top:1px solid var(--border);border-bottom:1px solid var(--border);}
    .rs-map canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;}
    .rs-controls{padding:10px 14px 0;display:flex;flex-direction:column;gap:10px;}
    .rs-row{display:flex;align-items:center;gap:12px;}
    .rs-play{font:inherit;font-size:14px;font-weight:700;min-width:70px;padding:9px 12px;border-radius:12px;border:1px solid var(--text);background:var(--text);color:var(--bg);cursor:pointer;}
    .rs-timeline{flex:1;position:relative;padding-bottom:16px;}
    .rs-scrub{width:100%;margin:0;accent-color:var(--text);height:24px;}
    .rs-ticks{display:flex;justify-content:space-between;padding:0 6px;margin-top:-2px;}
    .rs-tick{width:3px;height:6px;border-radius:2px;background:var(--border);}
    .rs-tick.ready{background:var(--muted);}
    .rs-tick.fc.ready{background:#c9a13a;}
    .rs-tick.cur{background:var(--text);height:9px;}
    .rs-ends{position:absolute;left:0;right:0;bottom:0;font-size:11px;font-weight:600;color:var(--muted);height:14px;}
    .rs-start{position:absolute;left:0;}
    .rs-end{position:absolute;right:0;}
    .rs-now{position:absolute;transform:translateX(-50%);color:var(--text);font-weight:800;}
    .rs-now.at-start{transform:none;}
    .rs-now.at-end{transform:translateX(-100%);}
    .rs-now.at-start ~ .rs-start, .rs-ends:has(.rs-now.at-start) .rs-start{visibility:hidden;}
    .rs-ends:has(.rs-now.at-end) .rs-end{visibility:hidden;}
    .rs-seg{display:flex;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:3px;gap:3px;}
    .rs-seg button{flex:1;font:inherit;font-size:13px;font-weight:700;padding:8px 4px;border:0;border-radius:9px;background:transparent;color:var(--soft);cursor:pointer;}
    .rs-seg button.on{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.25);}
    ${radarLegendCSS}
  `;
  document.head.appendChild(st);
}
