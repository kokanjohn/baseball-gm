/**
 * ui/screens/ScheduleScreen.js
 * Schedule tab rendered into #schedule-content.
 *
 * Owns:
 *   - Full season schedule grouped by month (collapsible)
 *   - Spring training games (separate section above regular season)
 *   - All-Star Break divider at the mid-season point
 *   - Playoff round dividers with series results
 *   - Game result pills (W/L with score, upcoming with date, NEXT for current game)
 *   - Weather icon per game
 *   - Makeup and doubleheader badges
 *   - Series context badges (sweep/rubber/salvage/avoid)
 *   - Auto-scrolls to current game on tab activation
 *
 * Live mode rules (Section 2.1 — LOCKED):
 *   No advance button anywhere on this screen. Games play themselves.
 *   The schedule is a read-only historical + forward-looking view.
 *
 * Tapping a completed game opens the score/box score sheet (Phase 13 component pass).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import {
  formatDate, formatRecord, formatGameLabel,
  formatGameStatus, formatPhaseLabel,
} from '../formatters.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted   = false;
let _listeners = [];

// Track which month groups are collapsed — current month open by default
const _monthOpen = {};

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('schedule', () => {
    refresh();
    _scrollToCurrentGame();
  });

  _listeners.push(EventBus.on('game:committed',    () => refresh()));
  _listeners.push(EventBus.on('game:phaseChanged', () => refresh()));
  _listeners.push(EventBus.on('nav:tabActivated',  ({ tab }) => {
    if (tab === 'schedule') {
      refresh();
      _scrollToCurrentGame();
    }
  }));

  refresh();
}

export function unmount() {
  _listeners.forEach(([event, handler]) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

export function refresh() {
  const container = document.getElementById('schedule-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state?.schedule) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted);">Schedule not yet generated.</div>';
    return;
  }

  const schedule  = state.schedule;
  const gameIdx   = state.currentGameIndex || 0;
  const phase     = state.phase;

  // Initialize month open state — current month open, others closed
  const groups = _groupGames(schedule, gameIdx, phase, state);
  for (const group of groups) {
    if (!(group.key in _monthOpen)) {
      _monthOpen[group.key] = group.isCurrent;
    }
  }

  const html = groups.map(g => _renderGroup(g, gameIdx, state)).join('');

  container.innerHTML = `
    <div style="padding:12px 0 24px;">
      <div class="section-pad" style="padding-bottom:4px;">
        <div class="section-title">Schedule</div>
        <div class="section-sub">${formatRecord(state.userTeam?.wins || 0, state.userTeam?.losses || 0)} · ${formatPhaseLabel(phase)}</div>
      </div>
      ${html}
    </div>
  `;

  _attachListeners(state);
}

// ─────────────────────────────────────────────────────────────
// GAME GROUPING
// ─────────────────────────────────────────────────────────────

function _groupGames(schedule, gameIdx, phase, state) {
  const groups = [];

  // Spring training — separate unlabeled section
  const springGames = schedule.filter(g => g.isSpring);
  if (springGames.length > 0) {
    const hasCurrent = springGames.some((g, i) => schedule.indexOf(g) === gameIdx);
    const key = 'spring';
    groups.push({
      key,
      label:     'Spring Training',
      games:     springGames,
      isCurrent: hasCurrent,
      isSpring:  true,
      isPlayoff: false,
    });
  }

  // Regular season — group by month
  const regularGames = schedule.filter(g => !g.isSpring && !g.isPlayoff);
  const byMonth = {};
  for (const game of regularGames) {
    const mo = (game.date || '').slice(0, 7); // 'YYYY-MM'
    if (!byMonth[mo]) byMonth[mo] = [];
    byMonth[mo].push(game);
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (const [mo, games] of Object.entries(byMonth).sort()) {
    const [year, month] = mo.split('-');
    const label     = `${MONTHS[parseInt(month) - 1]} ${year}`;
    const hasCurrent = games.some(g => schedule.indexOf(g) === gameIdx);
    const wins      = games.filter(g => g._committed && g.result === 'win').length;
    const losses    = games.filter(g => g._committed && g.result === 'loss').length;
    groups.push({
      key:       mo,
      label,
      meta:      wins + losses > 0 ? `${wins}–${losses}` : '',
      games,
      isCurrent: hasCurrent,
      isSpring:  false,
      isPlayoff: false,
    });
  }

  // All-Star Break — injected between June and July if mid-season
  const asbIdx = groups.findIndex(g => g.key.endsWith('-07'));
  if (asbIdx > 0) {
    groups.splice(asbIdx, 0, {
      key:       'asb',
      label:     'All-Star Break',
      games:     [],
      isCurrent: false,
      isSpring:  false,
      isPlayoff: false,
      isDivider: true,
    });
  }

  // Playoff rounds — each round as its own group
  const playoffGames = schedule.filter(g => g.isPlayoff);
  if (playoffGames.length > 0) {
    const playoffRounds = _groupPlayoffRounds(playoffGames, schedule, gameIdx);
    groups.push(...playoffRounds);
  }

  return groups;
}

function _groupPlayoffRounds(playoffGames, fullSchedule, gameIdx) {
  const byRound = {};
  for (const game of playoffGames) {
    const round = game.playoffRound || 'PLAYOFF';
    if (!byRound[round]) byRound[round] = [];
    byRound[round].push(game);
  }

  const ROUND_ORDER = ['WILD_CARD','FIRST_ROUND','DIVISION_SERIES','WORLD_SERIES'];
  return ROUND_ORDER
    .filter(r => byRound[r]?.length > 0)
    .map(r => ({
      key:       `playoff_${r}`,
      label:     _playoffRoundLabel(r),
      games:     byRound[r],
      isCurrent: byRound[r].some(g => fullSchedule.indexOf(g) === gameIdx),
      isSpring:  false,
      isPlayoff: true,
      playoffRound: r,
    }));
}

function _playoffRoundLabel(round) {
  const labels = {
    WILD_CARD:       'Wild Card',
    FIRST_ROUND:     'First Round',
    DIVISION_SERIES: 'Division Series',
    WORLD_SERIES:    'World Series',
  };
  return labels[round] || round;
}

// ─────────────────────────────────────────────────────────────
// GROUP RENDERING
// ─────────────────────────────────────────────────────────────

function _renderGroup(group, gameIdx, state) {
  // All-Star Break divider
  if (group.isDivider) {
    return `
      <div class="asb-divider" style="margin:8px 16px;">
        ⭐ All-Star Break
      </div>
    `;
  }

  const isOpen    = _monthOpen[group.key] !== false;
  const schedule  = state.schedule;

  // Playoff round — special styling
  if (group.isPlayoff) {
    const result   = _playoffRoundResult(group.games);
    const resCls   = result === 'won' ? 'champion' : result === 'eliminated' ? 'eliminated' : '';
    const resIcon  = result === 'won' ? '🏆' : result === 'eliminated' ? '❌' : '⚾';
    return `
      <div style="margin:0 16px 12px;">
        <div class="playoff-round-divider ${resCls}" id="mg-${group.key}">
          ${resIcon} ${group.label}
        </div>
        ${group.games.map(g => _renderGameRow(g, schedule.indexOf(g), gameIdx, state, true)).join('')}
      </div>
    `;
  }

  // Spring training — no collapsible header, just show games
  if (group.isSpring) {
    return `
      <div style="margin-bottom:12px;">
        <div style="padding:10px 16px 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">
          Spring Training
        </div>
        ${group.games.map(g => _renderGameRow(g, schedule.indexOf(g), gameIdx, state, false)).join('')}
      </div>
    `;
  }

  // Regular season month group
  const chevronCls = isOpen ? 'open' : '';
  const hasCurrent = group.isCurrent;

  return `
    <div class="month-group ${hasCurrent ? 'has-current' : ''}" id="mg-${group.key}">
      <div class="month-header" data-month="${group.key}">
        <div>
          <span class="month-name">${group.label}</span>
          ${group.meta ? `<span class="month-meta" style="margin-left:10px;">${group.meta}</span>` : ''}
        </div>
        <span class="month-chevron ${chevronCls}">▼</span>
      </div>
      <div class="month-body ${isOpen ? 'open' : ''}">
        ${isOpen ? group.games.map(g => _renderGameRow(g, schedule.indexOf(g), gameIdx, state, false)).join('') : ''}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// GAME ROW RENDERING
// ─────────────────────────────────────────────────────────────

function _renderGameRow(game, idx, currentIdx, state, isPlayoff) {
  if (!game) return '';

  const isCurrentGame = idx === currentIdx;
  const isCommitted   = game._committed || game.status === 'final';
  const isUpcoming    = !isCommitted && !isCurrentGame;

  const date      = game.date || '';
  const [, mo, dy] = date.split('-');
  const MONTHS    = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const moStr     = MONTHS[parseInt(mo)] || '';
  const dyStr     = parseInt(dy) || '';

  const oppLabel  = _gameLabel(game, state);
  const locLabel  = game.isHome ? 'Home' : `@ ${_escape(game.opponent || game.opp || '?')}`;

  // Only show weather icon if weather has been specifically generated
  // (not just the default 'Clear' that all games start with)
  const weatherIcon = game._weatherGenerated
    ? _weatherIcon(game.weather?.label || game.weatherCondition)
    : '';
  const resultEl    = _renderResult(game, isCurrentGame, isCommitted);
  const badges      = _renderBadges(game, idx, currentIdx, state);

  return `
    <div class="game-item ${isCurrentGame ? 'current-game' : ''} ${isPlayoff ? 'playoff-game' : ''}"
      id="game-row-${idx}" data-game-idx="${idx}">
      <div class="game-date">
        <div class="mo">${moStr}</div>
        <div class="dy">${dyStr}</div>
      </div>
      <div class="game-vs">
        <div class="game-opp">
          <span class="game-opp-name" data-opp="${_escape(game.opponent || game.opp || '')}" style="cursor:pointer;">
            ${_escape(oppLabel)}
          </span>${badges}
        </div>
        <div class="game-loc">
          ${locLabel}
          ${weatherIcon ? `<span class="game-weather" style="margin-left:6px;">${weatherIcon}</span>` : ''}
        </div>
      </div>
      ${resultEl}
    </div>
  `;
}

function _gameLabel(game, state) {
  const isHome = game.isHome;
  const opp    = game.opponent || game.opp || '?';
  return isHome ? `vs ${opp}` : `@ ${opp}`;
}

function _renderResult(game, isCurrentGame, isCommitted) {
  if (isCurrentGame && !isCommitted) {
    return '<div class="game-result next">NEXT</div>';
  }

  if (!isCommitted) {
    // Show scheduled time or date
    return `<div class="game-result upcoming">${_scheduledTime(game)}</div>`;
  }

  // Final result
  const won    = game.result === 'win';
  const us     = game.score?.us ?? game.score?.user ?? '';
  const them   = game.score?.them ?? game.score?.opponent ?? '';
  const score  = (us !== '' && them !== '') ? `${us}–${them}` : '';
  const cls    = won ? 'win' : 'loss';
  const label  = won ? 'W' : 'L';
  return `<div class="game-result ${cls}">${label}${score ? ' ' + score : ''}</div>`;
}

function _renderBadges(game, idx, currentIdx, state) {
  const badges = [];

  if (game.isPlayoff)      badges.push({ text: 'PLAYOFF', cls: 'playoff' });
  if (game.isMakeup)       badges.push({ text: 'MAKEUP',  cls: 'makeup' });
  if (game.isDoubleHeader) badges.push({ text: 'DH',      cls: 'dh' });

  // Series context badges
  const ctx = _seriesContext(game, idx, state);
  if (ctx) badges.push(ctx);

  if (badges.length === 0) return '';
  return badges.map(b => `<span class="game-badge ${b.cls}">${b.text}</span>`).join('');
}

function _seriesContext(game, idx, state) {
  if (!game._committed) return null;
  const schedule = state.schedule;

  // Find series boundaries — games against same opponent consecutively
  const opp = game.opponent || game.opp;
  if (!opp) return null;

  // Get the series (consecutive games vs same opponent)
  const seriesStart = _findSeriesStart(schedule, idx, opp);
  const seriesEnd   = _findSeriesEnd(schedule, idx, opp);
  const seriesGames = schedule.slice(seriesStart, seriesEnd + 1);

  if (seriesGames.length < 2) return null; // Not a series game

  const committed = seriesGames.filter(g => g._committed);
  if (committed.length !== seriesGames.length) return null; // Series not complete

  const userWins = committed.filter(g => g.result === 'win').length;
  const oppWins  = committed.filter(g => g.result === 'loss').length;
  const total    = seriesGames.length;

  // Only badge the last game of the series
  if (idx !== seriesEnd) return null;

  if (userWins === total) return { text: 'SWEEP',  cls: 'sweep' };
  if (oppWins  === total) return { text: 'SWEPT',  cls: 'avoid' };
  if (userWins > oppWins) return { text: 'WON',    cls: 'sweep' };
  return { text: 'LOST', cls: 'avoid' };
}

function _findSeriesStart(schedule, idx, opp) {
  let i = idx;
  while (i > 0) {
    const prev = schedule[i - 1];
    if (!prev || (prev.opponent || prev.opp) !== opp) break;
    i--;
  }
  return i;
}

function _findSeriesEnd(schedule, idx, opp) {
  let i = idx;
  while (i < schedule.length - 1) {
    const next = schedule[i + 1];
    if (!next || (next.opponent || next.opp) !== opp) break;
    i++;
  }
  return i;
}

function _playoffRoundResult(games) {
  if (games.length === 0) return 'upcoming';
  const committed = games.filter(g => g._committed);
  if (committed.length === 0) return 'upcoming';
  const wins   = committed.filter(g => g.result === 'win').length;
  const losses = committed.filter(g => g.result === 'loss').length;
  // Check if series is over
  if (games[0].playoffRound === 'WILD_CARD') {
    if (wins >= 1) return 'won';
    if (losses >= 1) return 'eliminated';
  }
  const bestOf = games[0].bestOf || 5;
  const needed = Math.ceil(bestOf / 2) + (bestOf % 2 === 0 ? 0 : 0);
  if (wins >= needed) return 'won';
  if (losses >= needed) return 'eliminated';
  return 'active';
}

function _scheduledTime(game) {
  if (!game.gameTime) return 'TBD';
  const d     = new Date(game.gameTime);
  let hours   = d.getHours();
  const mins  = d.getMinutes().toString().padStart(2, '0');
  const ampm  = hours >= 12 ? 'PM' : 'AM';
  hours       = hours % 12 || 12;
  return `${hours}:${mins} ${ampm}`;
}

function _weatherIcon(label) {
  if (!label) return '';
  const map = {
    Clear: '☀️', Sunny: '☀️', 'Partly Cloudy': '⛅', Cloudy: '☁️',
    Overcast: '☁️', 'Light Rain': '🌦️', Rain: '🌧️', 'Heavy Rain': '⛈️',
    Thunderstorm: '⛈️', Fog: '🌫️', Wind: '💨', Snow: '❄️',
    Hot: '🌡️', Cold: '🥶',
  };
  return map[label] || '';
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Month header collapse/expand
  document.querySelectorAll('[data-month]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.month;
      _monthOpen[key] = !(_monthOpen[key] !== false);
      refresh();
    });
  });

  // Tap completed game — opens box score sheet
  // Phase 13 component pass: wire to ScoreSheet component when built
  document.querySelectorAll('[data-game-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx  = parseInt(el.dataset.gameIdx);
      const game = state.schedule?.[idx];
      if (!game?._committed) return; // Only committed games are tappable
      // TODO Phase 15: open ScoreSheet(game)
    });
  });

  // Tap opponent team name — opens team detail modal
  document.querySelectorAll('[data-opp]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const opp = el.dataset.opp;
      if (!opp) return;
      _openTeamModal(opp, state);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SCROLL TO CURRENT GAME
// ─────────────────────────────────────────────────────────────

function _openTeamModal(teamName, state) {
  // Find the league team
  const leagueTeams = state.leagueTeams || [];
  const team = leagueTeams.find(t =>
    t.name === teamName || t.abbr === teamName ||
    (t.city && t.nickname && `${t.city} ${t.nickname}` === teamName)
  );

  if (!team) return;

  // Remove existing modal
  document.getElementById('sched-team-modal')?.remove();

  const rosterIds = team.rosterIds || [];
  const players   = state.players || {};
  const hitters   = rosterIds.map(id => players[id]).filter(p => p && !['SP','RP'].includes(p.pos)).sort((a,b) => b.ovr - a.ovr);
  const pitchers  = rosterIds.map(id => players[id]).filter(p => p && ['SP','RP'].includes(p.pos)).sort((a,b) => b.ovr - a.ovr);

  const playerRows = (arr) => arr.map(p => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 20px;border-bottom:1px solid var(--border);">
      <span style="flex:1;font-size:14px;font-weight:600;">${_escape(p.name)}</span>
      <span style="font-size:12px;color:var(--muted);">${p.pos}</span>
      <span style="font-size:13px;font-weight:700;color:${p.ovr >= 75 ? 'var(--accent2)' : p.ovr >= 60 ? 'var(--text)' : 'var(--muted)'};">${p.ovr}</span>
    </div>`).join('');

  const overlay = document.createElement('div');
  overlay.id = 'sched-team-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:80dvh;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div>
          <div style="font-size:18px;font-weight:800;">${_escape(team.name || teamName)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${team.wins || 0}–${team.losses || 0}</div>
        </div>
        <button class="modal-close" id="sched-team-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div style="overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));">
        ${hitters.length > 0 ? '<div style="padding:8px 20px 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Hitters</div>' + playerRows(hitters) : ''}
        ${pitchers.length > 0 ? '<div style="padding:8px 20px 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Pitchers</div>' + playerRows(pitchers) : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.getElementById('sched-team-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function _scrollToCurrentGame() {
  // Defer to after render
  setTimeout(() => {
    const el = document.querySelector('.current-game, [id^="game-row-"].current-game');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 80);
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// CSS (injected once)
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    /* Current game highlight pulse */
    @keyframes currentPulse {
      0%,100% { border-color: color-mix(in srgb,var(--accent) 50%,transparent); }
      50%      { border-color: var(--accent); }
    }
    .game-item.current-game {
      animation: currentPulse 2.4s ease-in-out infinite;
    }
    /* Playoff game subtle accent border */
    .game-item.playoff-game {
      border-color: rgba(245,210,83,.25);
    }
  `;
  document.head.appendChild(style);
}
