/**
 * ui/components/RadarCard.js
 * §100 (step 2d) The small live radar on the dashboard's next-game card:
 * the past two hours at Metro zoom, centred on the game's ballpark, looping
 * gently. Tapping it opens the full-screen radar (RadarSheet).
 *
 *   const card = createRadarCard({ onOpen: (focusId) => … });
 *   slot.appendChild(card.root);      // the same element survives dashboard redraws
 *   card.update({ state, focusId });  // after each redraw
 *   card.pause() / card.resume();     // e.g. while the full radar is open
 *   card.dispose();
 *
 * It pauses while it's off screen or the app is hidden, and picks up a newer
 * radar picture as one comes along. Its frames are the same ones the
 * full-screen radar asks for (same grid), so opening it shows the loop at once.
 */

import { createFrameSource } from './RadarFrameSource.js';
import { createRadarRenderer, formatFrameTime } from './RadarRenderer.js';
import { frameTimes } from '../../engine/RadarFrames.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { cityOf } from '../../engine/WeatherMap.js';

const FRAME_MS = 600, DWELL_MS = 2500, REFRESH_MS = 60_000;
export const MAP_H = 180, MIN_MAP_H = 90;
const LOOP = 'past2h', ZOOM = 1;

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createRadarCard({ onOpen = () => {}, nowMs = null } = {}) {
  _css();
  const clock = () => (nowMs != null ? nowMs : Date.now());
  const root = document.createElement('div');
  root.className = 'radar-card';
  root.setAttribute('role', 'button');
  root.tabIndex = 0;
  root.setAttribute('aria-label', 'Open the radar');
  root.innerHTML = `
    <div class="rc-head"><span class="rc-title">Radar</span><span class="rc-place"></span>
      <span class="rc-time"></span><span class="rc-tag"></span></div>
    <div class="rc-map"><canvas></canvas></div>
    <div class="rc-foot"><span>Past 2 hrs</span><span class="rc-open">Tap for the full radar</span></div>`;
  const canvas = root.querySelector('canvas');
  const renderer = createRadarRenderer(canvas);
  const S = { folded: false, state: null, ctx: null, focusId: null, frames: [], keys: [], index: 0, loaded: new Set(), timer: null, paused: false, visible: true, started: false, w: 0, h: 0 };

  const src = createFrameSource({
    onFrame: (key) => {
      const i = S.keys.indexOf(key);
      if (i < 0) return;
      S.loaded.add(i);
      if (i === S.index) _draw();
      if (!S.timer && _running()) _schedule(FRAME_MS);
    },
  });

  const _running = () => !S.paused && !S.folded && S.visible && !document.hidden && root.isConnected;

  function _view() {
    const userCity = S.state?.userTeam?.city || '';
    renderer.setView({ map: S.ctx.map, focusId: S.focusId, zoomIdx: ZOOM, theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', userCity });
    root.querySelector('.rc-place').textContent = cityOf(S.ctx.map, S.focusId, userCity);
  }

  function _load() {
    S.frames = frameTimes(clock(), LOOP);
    S.index = S.frames.length - 1;   // open on Now
    S.loaded = new Set();
    S.keys = src.request(S.frames, renderer.grid, { first: S.index });
    _draw();
  }

  function _draw() {
    const fr = S.frames[S.index];
    if (!fr || !S.ctx) return;
    renderer.draw(src.get(S.keys[S.index]));
    root.querySelector('.rc-time').textContent = formatFrameTime(fr.t, S.ctx.tzMin, clock());
    const tag = root.querySelector('.rc-tag');
    tag.textContent = fr.isNow ? 'NOW' : 'PAST';
    tag.className = `rc-tag${fr.isNow ? ' now' : ''}`;
  }

  function _schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(_step, ms); }
  function _step() {
    S.timer = null;
    if (!_running() || !S.loaded.size) return;
    let next = S.index;
    for (let k = 1; k <= S.frames.length; k++) { const j = (S.index + k) % S.frames.length; if (S.loaded.has(j)) { next = j; break; } }
    S.index = next;
    _draw();
    _schedule(S.frames[S.index]?.isNow ? DWELL_MS : FRAME_MS);
  }

  // Off screen / hidden: stop. Back: carry on.
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((es) => { S.visible = es.some(e => e.isIntersecting); if (_running()) _schedule(FRAME_MS); })
    : null;
  io?.observe(root);
  const onVis = () => { if (_running()) _schedule(FRAME_MS); };
  document.addEventListener('visibilitychange', onVis);
  const refresh = setInterval(() => {
    if (!S.ctx) return;
    const fresh = frameTimes(clock(), LOOP);
    if (fresh.at(-1)?.t !== S.frames.at(-1)?.t) _load();
  }, REFRESH_MS);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!S.ctx || !w || (w === S.w && h === S.h)) return;
    S.w = w; S.h = h;
    renderer.resize(); _load();
  }) : null;
  ro?.observe(root.querySelector('.rc-map'));

  const open = () => onOpen(S.focusId);
  root.addEventListener('click', open);
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  root.addEventListener('keydown', onKey);

  return {
    root,
    /** After a dashboard redraw (the root has been put back in its slot). */
    update({ state, focusId }) {
      const ctx = weatherContext(state);
      const changed = !S.ctx || focusId !== S.focusId || ctx.seed !== S.ctx.seed || ctx.region !== S.ctx.region || ctx.cal.length !== S.ctx.cal.length;
      S.state = state; S.ctx = ctx; S.focusId = focusId;
      src.setContext(state);
      if (changed || !S.started) {
        S.started = true;
        // Wait a frame so the canvas has its size in the new slot.
        requestAnimationFrame(() => { S.w = canvas.clientWidth; S.h = canvas.clientHeight; _view(); _load(); });
      } else {
        _view();   // (the theme may have changed)
        _draw();
        if (!S.timer && _running()) _schedule(FRAME_MS);
      }
    },
    /**
     * The map's height (px) — the dashboard fits the card to the room it has.
     * Under MIN_MAP_H the card steps aside (hidden; the dashboard offers a
     * Radar button instead). Returns whether it's hidden.
     */
    setMapHeight(h) {
      const mapEl = root.querySelector('.rc-map');
      const folded = h < MIN_MAP_H;
      root.style.display = folded ? 'none' : '';
      mapEl.style.height = folded ? '' : `${Math.round(h)}px`;
      S.folded = folded;
      if (folded) { clearTimeout(S.timer); S.timer = null; }
      else if (_running() && !S.timer) _schedule(FRAME_MS);
      return folded;
    },
    pause() { S.paused = true; clearTimeout(S.timer); S.timer = null; },
    resume() { S.paused = false; if (_running()) _schedule(FRAME_MS); },
    get state() { return { folded: S.folded, focusId: S.focusId, frames: S.frames.length, loaded: S.loaded.size, index: S.index, running: _running(), usesWorker: src.usesWorker }; },
    dispose() {
      clearTimeout(S.timer); clearInterval(refresh);
      io?.disconnect(); ro?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      root.removeEventListener('click', open); root.removeEventListener('keydown', onKey);
      src.dispose(); renderer.dispose();
      root.remove();
    },
  };
}

function _css() {
  if (document.getElementById('radar-card-css')) return;
  const st = document.createElement('style');
  st.id = 'radar-card-css';
  st.textContent = `
    .radar-card{margin-top:10px;background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent;}
    .radar-card:active{opacity:.9;}
    .radar-card .rc-head{display:flex;align-items:center;gap:8px;padding:9px 12px 8px;}
    .radar-card .rc-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);}
    .radar-card .rc-place{font-size:14px;font-weight:700;color:var(--text);}
    .radar-card .rc-time{margin-left:auto;font-size:13px;font-weight:700;color:var(--text);}
    .radar-card .rc-tag{font-size:9px;font-weight:800;letter-spacing:.08em;padding:2px 6px;border-radius:5px;background:var(--surface2);color:var(--soft);}
    .radar-card .rc-map{position:relative;height:${MAP_H}px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);}
    .radar-card .rc-map canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
    .radar-card .rc-foot{display:flex;justify-content:space-between;padding:8px 12px;font-size:12px;font-weight:600;color:var(--muted);}
    .radar-card .rc-open{color:var(--soft);}

  `;
  document.head.appendChild(st);
}
