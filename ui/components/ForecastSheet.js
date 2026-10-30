/**
 * ui/components/ForecastSheet.js
 * §102.7 (step 3) The forecast sheet: a game's forecast — the headline, the
 * hours it spans — and the 10-day outlook at that ballpark (3b). Opened from
 * the dashboard's next-game forecast line and from the schedule. Everything
 * comes from ForecastSource (the worker), the same numbers every screen shows.
 *
 *   openForecastSheet({ state, game, venueId })   game optional; venueId defaults to the game's park (or ours)
 */

import { gameForecastFor, outlookFor } from './ForecastSource.js';
import { cityOf, regionMap } from '../../engine/WeatherMap.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { venueOf } from './RadarSheet.js';
import { dayLabel, timeLabel } from './WeatherStatus.js';

let _injected = false;

/** "74° · Chance of storms 40% · after 8 PM" — the one line the dashboard and the schedule show for a game. */
export function forecastLine(f) {
  if (!f) return '';
  const pct = f.chance >= 10 ? ` ${f.chance}%` : '';
  const when = f.whenHour && f.chance >= 30 && f.whenHour > f.gameTime ? ` · after ${_hourLabel(f.whenHour)}` : '';
  return `${f.tempF}° · ${f.label}${pct}${when}`;
}

const _hourLabel = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openForecastSheet({ state, game = null, venueId = null }) {
  _injectCSS();
  document.getElementById('fc-sheet')?.remove();
  const venue = venueId || (game ? venueOf(game) : 'user');
  const map = regionMap(weatherContext(state).region);
  const city = cityOf(map, venue, state.userTeam?.city);
  const now = Date.now();
  const overlay = document.createElement('div');
  overlay.id = 'fc-sheet';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet fc-sheet"><div class="modal-handle"></div>
    <div class="fc-head"><div><div class="fc-kicker">Forecast</div><div class="fc-city">${_esc(city)}</div></div>
      <button class="modal-close" id="fc-close" aria-label="Close">×</button></div>
    <div id="fc-game"></div>
    <div id="fc-days"></div>
    <div class="fc-note">From the forecast made at ${_esc(timeLabel(Math.floor(now / 3_600_000) * 3_600_000))}. It's updated every hour; chances further out are less certain.</div>
  </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#fc-close').addEventListener('click', close);

  if (game && game.gameTime > now) {
    const el = overlay.querySelector('#fc-game');
    el.innerHTML = '<div class="fc-loading">Working out the forecast…</div>';
    gameForecastFor(state, game, now).then(f => { if (el.isConnected) el.innerHTML = _gameHtml(state, game, f); });
  }
  return { close, overlay };
}

function _gameHtml(state, game, f) {
  const opp = game.opponent ? `${game.isHome ? 'vs' : '@'} ${game.opponent}` : '';
  const hours = f.hours.length ? `<div class="fc-hours">${f.hours.map(h => `
      <div class="fc-hour"><div class="fc-h-t">${_esc(timeLabel(h.t))}</div><div class="fc-h-temp">${h.tempF}°</div>
        <div class="fc-h-pct${h.chance >= 30 ? ' wet' : ''}">${h.chance}%</div></div>`).join('')}</div>` : '';
  const wind = f.windMph < 3 || f.windText === 'calm' ? 'Wind calm' : `Wind ${f.windMph} mph, ${f.windText}`;
  return `<div class="fc-game">
      <div class="fc-g-when">${_esc(opp)} · ${_esc(dayLabel(game.date))} ${_esc(timeLabel(game.gameTime))}</div>
      <div class="fc-g-main"><span class="fc-g-temp">${f.tempF}°</span><span class="fc-g-label">${_esc(f.label)}</span></div>
      <div class="fc-g-sub">${f.chance}% chance of ${f.kind === 'storms' ? 'storms' : f.kind === 'snow' ? 'snow' : 'rain'} during the game · ${_esc(wind)} at first pitch</div>
      ${hours}
    </div>`;
}

function _injectCSS() {
  if (_injected) return;
  _injected = true;
  const st = document.createElement('style');
  st.textContent = `
    .fc-sheet{max-height:88vh;overflow-y:auto;padding-bottom:24px;}
    .fc-head{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 16px 8px;}
    .fc-kicker{font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);}
    .fc-city{font-size:20px;font-weight:800;color:var(--text);}
    .fc-loading{padding:16px;color:var(--muted);font-size:12px;}
    .fc-game{margin:0 16px 12px;padding:12px;border:1px solid var(--border);border-radius:14px;}
    .fc-g-when{font-size:11px;font-weight:700;color:var(--muted);}
    .fc-g-main{display:flex;align-items:baseline;gap:10px;margin-top:4px;}
    .fc-g-temp{font-size:30px;font-weight:800;color:var(--text);}
    .fc-g-label{font-size:15px;font-weight:700;color:var(--text);}
    .fc-g-sub{font-size:11px;color:var(--soft);margin-top:2px;}
    .fc-hours{display:flex;gap:6px;margin-top:10px;}
    .fc-hour{flex:1;text-align:center;padding:6px 0;border-radius:10px;background:var(--surface2, rgba(127,127,127,.08));}
    .fc-h-t{font-size:10px;font-weight:700;color:var(--muted);}
    .fc-h-temp{font-size:14px;font-weight:800;color:var(--text);}
    .fc-h-pct{font-size:10px;color:var(--muted);}
    .fc-h-pct.wet{color:#3b82f6;font-weight:800;}
    .fc-note{font-size:10px;color:var(--muted);padding:4px 16px 0;line-height:1.4;}
  `;
  document.head.appendChild(st);
}
