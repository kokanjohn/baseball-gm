/**
 * ui/components/OutlookSheet.js
 * r277 §122.156 The 10-day outlook, as a TV weather segment shows it: ten tiles — the day, a large icon, the
 * high and low, the chance of rain. Opened from the Forecast button at the top of the Schedule.
 *
 * Each day is the weather where the club is that day: the park of that day's game, or on an off day the park of
 * the next game (the club is there or on the way). The numbers are ForecastSource's (the worker's): the same
 * days the forecast sheet lists, and a day is never less likely to rain than one of our games in it (withinDay),
 * as everywhere else.
 *
 *   openOutlookSheet({ state })
 */

import { gameForecastFor, outlookFor } from './ForecastSource.js';
import { GAME_STATUS } from '../../data/constants.js';
import { withinDay } from '../../engine/WeatherForecast.js';
import { cityOf, regionMap } from '../../engine/WeatherMap.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { venueOf } from './RadarSheet.js';

const DAYS = 10;
let _injected = false;
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openOutlookSheet({ state }) {
  _injectCSS();
  document.getElementById('ol-sheet')?.remove();
  const map = regionMap(weatherContext(state).region);
  const home = cityOf(map, 'user', state.userTeam?.city);
  const overlay = document.createElement('div');
  overlay.id = 'ol-sheet';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet ol-sheet"><div class="modal-handle"></div>
    <div class="ol-panel">
      <div class="ol-head">
        <div><div class="ol-kicker">10-Day Outlook</div><div class="ol-city">${_esc(home)}</div></div>
        <button class="modal-close" id="ol-close" aria-label="Close">×</button>
      </div>
      <div class="ol-grid" id="ol-grid">${Array.from({ length: DAYS }, (_, i) => `<div class="ol-tile ol-wait" id="ol-t-${i}"><div class="ol-day">&nbsp;</div><div class="ol-icon"></div><div class="ol-hi">&nbsp;</div></div>`).join('')}</div>
    </div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 250); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#ol-close').addEventListener('click', close);
  _fill(overlay, state, map);
  return { close, overlay };
}

/** Where the club is each of the ten days: { venues: [venueId × 10], games: upcoming games }. */
export function outlookVenues(state, days, nowMs) {
  const games = (state.schedule || []).filter(g => !g._committed && !g.cancelled && g.status !== GAME_STATUS.SUSPENDED && g.gameTime > nowMs - 6 * 3_600_000)
    .sort((a, b) => a.gameTime - b.gameTime);
  return days.map(d => {
    const today = games.find(g => g.date === d.dateIso);
    const next = today || games.find(g => g.date > d.dateIso);
    return next ? venueOf(next) : 'user';
  });
}

async function _fill(overlay, state, map) {
  const now = Date.now();
  const base = await outlookFor(state, 'user', now);
  const venues = outlookVenues(state, base, now);
  const byVenue = { user: base };
  for (const v of new Set(venues)) if (!byVenue[v]) byVenue[v] = await outlookFor(state, v, now);
  if (!overlay.isConnected) return;
  const games = (state.schedule || []).filter(g => !g._committed && !g.cancelled && g.status !== GAME_STATUS.SUSPENDED && g.gameTime > now);
  for (let i = 0; i < DAYS; i++) {
    const v = venues[i], day = byVenue[v]?.[i];
    const tile = overlay.querySelector(`#ol-t-${i}`);
    if (!tile || !day) continue;
    // (a day is never less likely to rain than one of our games in it there)
    const here = games.filter(g => g.date === day.dateIso && venueOf(g) === v);
    const d = here.length ? withinDay(day, await Promise.all(here.map(g => gameForecastFor(state, g, now)))) : day;
    if (!tile.isConnected) return;
    const when = i === 0 ? 'Today' : new Date(d.dayStartMs + 12 * 3_600_000).toLocaleDateString([], { weekday: 'short' });
    const away = v !== 'user';
    const wet = d.chance >= 30;
    tile.classList.remove('ol-wait');
    tile.dataset.venue = v;
    tile.innerHTML = `
      <div class="ol-day">${_esc(when)}</div>
      <div class="ol-where">${away ? _esc(cityOf(map, v, '')) : ''}</div>
      <div class="ol-icon" role="img" aria-label="${_esc(d.label)}">${weatherIcon(d.icon)}</div>
      <div class="ol-hi">${d.hiF ?? '—'}°</div>
      <div class="ol-lo">${d.loF ?? '—'}°</div>
      <div class="ol-pct${wet ? ' wet' : ''}"><svg viewBox="0 0 10 14" class="ol-drop"><path d="M5 0C5 0 0 6.5 0 9.2A5 5 0 0 0 10 9.2C10 6.5 5 0 5 0Z"/></svg>${d.chance}%</div>`;
  }
}

// ── icons: the broadcast set, drawn (fixed colors, as on TV, in both themes) ──
const SUN = (cx, cy, r) => `<g class="ol-sun"><g stroke="#FFC233" stroke-width="3" stroke-linecap="round">${
  Array.from({ length: 8 }, (_, k) => { const a = k * Math.PI / 4, c = Math.cos(a), s = Math.sin(a); return `<line x1="${(cx + c * (r + 4)).toFixed(1)}" y1="${(cy + s * (r + 4)).toFixed(1)}" x2="${(cx + c * (r + 9)).toFixed(1)}" y2="${(cy + s * (r + 9)).toFixed(1)}"/>`; }).join('')
}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#olSun)"/></g>`;
const CLOUD = (dx = 0, dy = 0, fill = 'url(#olCloud)') => `<path transform="translate(${dx} ${dy})" fill="${fill}" d="M18 52h34a12 12 0 0 0 1-24 16 16 0 0 0-30-4 11 11 0 0 0-5 28z"/>`;
const DARK = 'url(#olCloudDark)';
const DROPS = (n, heavy = false) => Array.from({ length: n }, (_, k) => {
  const x = 22 + k * (30 / Math.max(1, n - 1)) - (n === 1 ? -15 : 0);
  return `<line x1="${x}" y1="58" x2="${x - 4}" y2="${heavy ? 70 : 66}" stroke="#4FA8FF" stroke-width="3" stroke-linecap="round"/>`;
}).join('');
const FLAKES = (n) => Array.from({ length: n }, (_, k) => {
  const x = 22 + k * (30 / Math.max(1, n - 1)) - (n === 1 ? -15 : 0), y = 64;
  return `<g stroke="#8EC5F0" stroke-width="2.2" stroke-linecap="round"><line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}"/><line x1="${x - 2}" y1="${y - 3.5}" x2="${x + 2}" y2="${y + 3.5}"/><line x1="${x + 2}" y1="${y - 3.5}" x2="${x - 2}" y2="${y + 3.5}"/></g>`;
}).join('');
const BOLT = `<path d="M38 50l-8 13h7l-4 11 12-15h-7l5-9z" fill="#FFD23F" stroke="#E5A800" stroke-width="1"/>`;

/** The icon for a forecast's `icon` name (WeatherForecast / WeatherConditions), as an inline SVG. */
export function weatherIcon(name) {
  const n = String(name || 'sun-cloud');
  let body;
  if (n === 'sun' || n === 'hot' || n === 'moon') body = SUN(36, 36, 15);
  else if (n === 'sun-cloud' || n === 'moon-cloud') body = SUN(26, 26, 11) + CLOUD(6, 6);
  else if (n === 'cloud') body = CLOUD(-6, -10, DARK) + CLOUD(4, 2);
  else if (n === 'wind') body = CLOUD(0, -6) + `<g stroke="#BFD8F2" stroke-width="3" stroke-linecap="round" fill="none"><path d="M10 56h34a6 6 0 1 0-6-6"/><path d="M16 64h26a5 5 0 1 1-5 5"/></g>`;
  else if (n === 'rain-light') body = CLOUD(0, -6) + DROPS(2);
  else if (n === 'rain') body = CLOUD(0, -6, DARK) + DROPS(3);
  else if (n === 'rain-heavy') body = CLOUD(0, -6, DARK) + DROPS(4, true);
  else if (n === 'rain-chance') body = SUN(22, 20, 9) + CLOUD(4, -2) + DROPS(2);
  else if (n === 'storm' || n === 'storm-near') body = CLOUD(0, -8, DARK) + BOLT + (n === 'storm' ? `<line x1="22" y1="58" x2="18" y2="66" stroke="#4FA8FF" stroke-width="3" stroke-linecap="round"/><line x1="54" y1="58" x2="50" y2="66" stroke="#4FA8FF" stroke-width="3" stroke-linecap="round"/>` : '');
  else if (n === 'storm-chance') body = SUN(22, 20, 9) + CLOUD(4, -4, DARK) + BOLT;
  else if (n === 'snow-light') body = CLOUD(0, -6) + FLAKES(2);
  else if (n === 'snow' || n === 'snow-chance') body = (n === 'snow-chance' ? SUN(22, 20, 9) : '') + CLOUD(0, -6, n === 'snow' ? DARK : undefined) + FLAKES(3);
  else if (n === 'snow-heavy') body = CLOUD(0, -6, DARK) + FLAKES(4);
  else if (n === 'mix') body = CLOUD(0, -6, DARK) + `<line x1="26" y1="58" x2="22" y2="66" stroke="#4FA8FF" stroke-width="3" stroke-linecap="round"/>` + FLAKES(1) + `<line x1="50" y1="58" x2="46" y2="66" stroke="#4FA8FF" stroke-width="3" stroke-linecap="round"/>`;
  else body = SUN(26, 26, 11) + CLOUD(6, 6);
  return `<svg viewBox="0 0 72 76" class="ol-svg" aria-hidden="true"><defs>
    <radialGradient id="olSun" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#FFF3A0"/><stop offset=".55" stop-color="#FFC233"/><stop offset="1" stop-color="#FF9A1F"/></radialGradient>
    <linearGradient id="olCloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9D6E6"/></linearGradient>
    <linearGradient id="olCloudDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#AEBBCC"/><stop offset="1" stop-color="#6F7E92"/></linearGradient>
  </defs>${body}</svg>`;
}

function _injectCSS() {
  if (_injected) return;
  _injected = true;
  const st = document.createElement('style');
  st.textContent = `
    .ol-sheet{max-height:calc(92 * var(--vh));overflow-y:auto;padding:0 0 18px;}
    /* r278 on the standard sheet (no panel of its own): the theme's colors; the icons keep theirs */
    .ol-panel{padding:0 8px;color:var(--text);}
    .ol-head{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 8px 10px;}
    .ol-kicker{font-size:11px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:var(--muted);}
    .ol-city{font-size:22px;font-weight:900;letter-spacing:.3px;line-height:1.15;color:var(--text);}
    .ol-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:2px 0 8px;}
    .ol-tile{display:flex;flex-direction:column;align-items:center;padding:8px 2px 8px;border-radius:12px;min-height:150px;}
    .ol-tile:first-child{background:var(--surface2);}
    .ol-wait{opacity:.45;}
    .ol-day{font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--text);}
    .ol-where{font-size:9px;font-weight:700;color:var(--muted);height:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;}
    .ol-icon{width:52px;height:55px;margin:2px 0;}
    .ol-svg{width:100%;height:100%;filter:drop-shadow(0 1px 2px rgba(0,0,0,.30));}
    .ol-hi{font-size:22px;font-weight:900;line-height:1;color:var(--text);}
    .ol-lo{font-size:13px;font-weight:700;color:var(--muted);margin-top:2px;}
    .ol-pct{display:flex;align-items:center;gap:3px;font-size:12px;font-weight:800;color:var(--muted);margin-top:6px;}
    .ol-pct.wet{color:#3B9EFF;}
    .ol-drop{width:8px;height:11px;fill:currentColor;}
  `;
  document.head.appendChild(st);
}
