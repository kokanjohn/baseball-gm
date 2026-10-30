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
import { GAME_STATUS } from '../../data/constants.js';
import { withinDay } from '../../engine/WeatherForecast.js';
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
    <div class="fc-head"><div><div class="fc-kicker">Forecast</div><div class="fc-city" id="fc-city">${_esc(city)}</div></div>
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
  _showOutlook(overlay, state, venue, now, game ? venueOf(game) : null);
  return { close, overlay };
}

/**
 * The 10-day outlook at a ballpark (3b): one row a day — the baseball
 * calendar's date, the words, high / low, the chance — filled in as each day
 * is worked out; under each day, our games there with their game-window
 * chance (the same number the dashboard and the schedule show), and our games
 * elsewhere that day with a link to that park's outlook. A switch between our
 * park and the game's.
 */
function _showOutlook(overlay, state, venue, now, gameVenue) {
  const box = overlay.querySelector('#fc-days');
  if (!box) return;
  const map = regionMap(weatherContext(state).region);
  const name = (id) => cityOf(map, id, state.userTeam?.city);
  overlay.querySelector('#fc-city').textContent = name(venue);
  const parks = [...new Set(['user', gameVenue].filter(Boolean))];
  const chips = parks.length > 1 ? `<div class="fc-parks">${parks.map(id =>
      `<button type="button" class="fc-park${id === venue ? ' on' : ''}" data-park="${id}">${_esc(id === 'user' ? `Our park · ${name(id)}` : name(id))}</button>`).join('')}</div>` : '';
  box.innerHTML = `<div class="fc-sec">10-day forecast</div>${chips}<div class="fc-day-list">${Array.from({ length: 10 }, (_, i) =>
      `<div class="fc-day" id="fc-day-${i}"><div class="fc-d-date">…</div></div>`).join('')}</div>`;
  box.querySelectorAll('[data-park]').forEach(b => b.addEventListener('click', () => _showOutlook(overlay, state, b.dataset.park, now, gameVenue)));
  const ours = (state.schedule || []).filter(g => !g._committed && !g.cancelled && g.status !== GAME_STATUS.SUSPENDED && g.gameTime > now);
  outlookFor(state, venue, now, (i, day) => {
    const row = box.querySelector(`#fc-day-${i}`);
    if (!row || !row.isConnected) return;
    const d = day;
    const date = d.dateIso;
    const when = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(date);
    const temps = `${d.hiF ?? '—'}°<span class="fc-d-lo"> / ${d.loF ?? '—'}°</span>`;
    const here = ours.filter(g => g.date === date && venueOf(g) === venue);
    const away = ours.filter(g => g.date === date && venueOf(g) !== venue);
    row.innerHTML = `<div class="fc-d-main">
        <div class="fc-d-date">${_esc(when)}${i > 1 ? '' : `<span class="fc-d-sub"> ${_esc(dayLabel(date))}</span>`}</div>
        <div class="fc-d-label">${_esc(d.label)}</div>
        <div class="fc-d-pct${d.chance >= 30 ? ' wet' : ''}">${d.chance >= 10 ? `${d.chance}%` : ''}</div>
        <div class="fc-d-temp">${temps}</div>
      </div>
      ${here.map(g => `<div class="fc-d-game" data-gt="${g.gameTime}">${_esc(`${g.isHome ? 'vs' : '@'} ${g.opponent} · ${timeLabel(g.gameTime)}`)} <span class="fc-d-gfc">…</span></div>`).join('')}
      ${away.map(g => `<button type="button" class="fc-d-game fc-d-away" data-park="${venueOf(g)}">${_esc(`${g.isHome ? 'vs' : '@'} ${g.opponent} · ${timeLabel(g.gameTime)} — at ${name(venueOf(g))}, see its forecast`)}</button>`).join('')}`;
    row.querySelectorAll('[data-park]').forEach(b => b.addEventListener('click', () => _showOutlook(overlay, state, b.dataset.park, now, gameVenue)));
    // Our games there: their forecast lines — and the day can't be less likely to rain than a game inside it.
    if (here.length) Promise.all(here.map(g => gameForecastFor(state, g, now))).then(fs => {
      if (!row.isConnected) return;
      fs.forEach((f, k) => { const el = row.querySelector(`[data-gt="${here[k].gameTime}"] .fc-d-gfc`); if (el) el.textContent = `· ${forecastLine(f)}`; });
      const dd = withinDay(day, fs);
      if (dd !== day) {
        row.querySelector('.fc-d-label').textContent = dd.label;
        const pct = row.querySelector('.fc-d-pct');
        pct.textContent = dd.chance >= 10 ? `${dd.chance}%` : '';
        pct.classList.toggle('wet', dd.chance >= 30);
      }
    });
  });
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
    .fc-sec{font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);padding:6px 16px 6px;}
    .fc-parks{display:flex;gap:6px;padding:0 16px 8px;flex-wrap:wrap;}
    .fc-park{font:inherit;font-size:11px;font-weight:700;padding:5px 10px;border-radius:14px;border:1px solid var(--border);background:none;color:var(--soft);cursor:pointer;}
    .fc-park.on{border-color:#3b82f6;color:#3b82f6;}
    .fc-day-list{padding:0 16px;}
    .fc-day{padding:8px 0;border-bottom:1px solid var(--border);}
    .fc-d-main{display:grid;grid-template-columns:76px 1fr 38px 66px;align-items:baseline;gap:6px;}
    .fc-d-date{font-size:12px;font-weight:800;color:var(--text);}
    .fc-d-sub{font-weight:500;color:var(--muted);}
    .fc-d-label{font-size:12px;color:var(--soft);}
    .fc-d-pct{font-size:12px;color:var(--muted);text-align:right;}
    .fc-d-pct.wet{color:#3b82f6;font-weight:800;}
    .fc-d-temp{font-size:13px;font-weight:800;color:var(--text);text-align:right;}
    .fc-d-lo{font-weight:500;color:var(--muted);}
    .fc-d-game{display:block;font:inherit;font-size:11px;font-weight:600;color:#3b82f6;margin:3px 0 0 82px;padding:0;border:0;background:none;text-align:left;}
    .fc-d-away{color:var(--muted);cursor:pointer;text-decoration:underline;}
    .fc-note{font-size:10px;color:var(--muted);padding:4px 16px 0;line-height:1.4;}
  `;
  document.head.appendChild(st);
}
