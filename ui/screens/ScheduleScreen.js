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
import { GAME_STATUS, GAME_TIMES_BY_DOW }   from '../../data/constants.js';
import { openPlayerCard } from '../components/PlayerCard.js';
import { renderBoxScore } from '../components/BoxScore.js';
import { accumulateBox } from '../../engine/SimEngine.js';
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

  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('game:committed',    () => refresh());
  wire('game:phaseChanged', () => refresh());
  wire('roster:changed',    () => refresh());
  wire('nav:tabActivated',  ({ tab }) => {
    if (tab === 'schedule') {
      refresh();
      _scrollToCurrentGame();
    }
  });

  refresh();
}

export function unmount() {
  _listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
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

  const groups = _groupGames(schedule, gameIdx, phase, state);

  // On first render of a new month (key not yet in _monthOpen), auto-set:
  //   current month = open, all others = closed.
  // On subsequent refreshes, preserve whatever the user has manually toggled.
  // Exception: if the current game moved to a new month (game committed),
  // open the new current month automatically.
  for (const group of groups) {
    if (group.isPlayoff) continue;
    if (!(group.key in _monthOpen)) {
      // First time seeing this month — auto-open only if it's the current month
      _monthOpen[group.key] = group.isCurrent;
    }
    // Do NOT auto-reopen on subsequent refreshes — respect manual toggle
  }

  const html = groups.map(g => _renderGroup(g, gameIdx, state)).join('');

  container.innerHTML = `
    <div style="padding:12px 0 24px;">
      <div class="section-pad" style="padding-bottom:4px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div class="section-title">Schedule</div>
          <div class="section-sub">${formatRecord(state.userTeam?.wins || 0, state.userTeam?.losses || 0)} · ${formatPhaseLabel(phase)}</div>
        </div>
        <button class="scores-btn" id="sched-scores-btn">Scores</button>
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

  // All games grouped by month (YYYY-MM key from game.date).
  // Spring training games have dates in March so they naturally fall
  // into the March group — no separate "Spring Training" section.
  const allGames = schedule.filter(g => !g.isPlayoff);
  const byMonth  = {};
  for (const game of allGames) {
    const mo = (game.date || '').slice(0, 7); // 'YYYY-MM'
    if (!mo) continue;
    if (!byMonth[mo]) byMonth[mo] = [];
    byMonth[mo].push(game);
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Current month key — used to default open state
  const currentGame    = schedule[gameIdx];
  const currentMoKey   = (currentGame?.date || '').slice(0, 7);

  for (const [mo, games] of Object.entries(byMonth).sort()) {
    const [year, month] = mo.split('-');
    const label         = `${MONTHS[parseInt(month) - 1]} ${year}`;
    const hasCurrent    = games.some(g => schedule.indexOf(g) === gameIdx);
    const wins          = games.filter(g => g._committed && g.result === 'win').length;
    const losses        = games.filter(g => g._committed && g.result === 'loss').length;
    const hasSpring     = games.some(g => g.isSpring);

    groups.push({
      key:       mo,
      label,
      meta:      wins + losses > 0 ? `${wins}–${losses}` : '',
      games,
      isCurrent: hasCurrent,
      isSpring:  hasSpring,
      isPlayoff: false,
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
  const isOpen   = _monthOpen[group.key] !== false;
  const schedule = state.schedule;

  // Playoff round — special styling, always visible
  if (group.isPlayoff) {
    const result  = _playoffRoundResult(group.games);
    const resCls  = result === 'won' ? 'champion' : result === 'eliminated' ? 'eliminated' : '';
    const resIcon = result === 'won' ? '🏆' : result === 'eliminated' ? '❌' : '⚾';
    return `
      <div style="margin:0 16px 12px;">
        <div class="playoff-round-divider ${resCls}" id="mg-${group.key}">
          ${resIcon} ${group.label}
        </div>
        ${group.games.map(g => _renderGameRow(g, schedule.indexOf(g), gameIdx, state, true)).join('')}
      </div>
    `;
  }

  // All months render as collapsible month groups.
  // Spring training games have a "ST" badge per row — no header label needed.
  const gameCount = group.games.length;
  const countLabel = `${gameCount} Game${gameCount !== 1 ? 's' : ''}`;

  return `
    <div class="month-group ${group.isCurrent ? 'has-current' : ''}" id="mg-${group.key}">
      <div class="month-header" data-month="${group.key}">
        <span class="month-name">${group.label}</span>
        <span class="month-game-count">${countLabel}</span>
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
  const isCommitted   = game._committed || game.status === GAME_STATUS.FINAL;
  const isSilent      = game._silentlyCommitted; // user didn't watch live — result is still real
  const isUpcoming    = !isCommitted && !isCurrentGame;

  const date      = game.date || '';
  const [, mo, dy] = date.split('-');
  const MONTHS    = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const moStr     = MONTHS[parseInt(mo)] || '';
  const dyStr     = parseInt(dy) || '';

  const hasBoxScore = isCommitted && (!!game.boxScore || game.plays?.length > 0);
  const oppLabel    = _gameLabel(game, state);
  const locLabel    = game.isHome ? 'Home' : 'Away';

  // Only show weather icon if weather has been specifically generated
  const weatherIcon = game._weatherGenerated
    ? _weatherIcon(game.weather?.label || game.weatherCondition)
    : '';
  const badges      = _renderBadges(game, idx, currentIdx, state);

  return `
    <div class="game-item ${isCurrentGame ? 'current-game' : ''} ${isPlayoff ? 'playoff-game' : ''}"
      id="game-row-${idx}" data-game-idx="${idx}"
      ${isCommitted ? `style="cursor:pointer;"` : ''}>
      <div class="game-date">
        <div class="mo">${moStr}</div>
        <div class="dy">${String(dyStr).padStart(2,'0')}</div>
      </div>
      <div class="game-vs">
        <div class="game-opp">
          <span class="game-opp-name" data-opp="${_escape(game.opponent || game.opp || '')}" style="cursor:pointer;">
            ${_escape(oppLabel)}
          </span>${badges}
        </div>
        <div class="game-loc">
          ${locLabel}
          ${game.gameTime && !isCommitted ? ` · <span style="font-weight:600;color:var(--soft)">${_scheduledTime(game)}</span>` : ''}
          ${weatherIcon ? `<span class="game-weather" style="margin-left:6px;">${weatherIcon}</span>` : ''}
        </div>
      </div>
      ${_renderResult(game, isCurrentGame, isCommitted, idx, hasBoxScore)}
    </div>
  `;
}

function _gameLabel(game, state) {
  const isHome = game.isHome;
  const opp    = game.opponent || game.opp || '?';
  return isHome ? `vs ${opp}` : `@ ${opp}`;
}

function _renderResult(game, isCurrentGame, isCommitted, idx, hasBoxScore) {
  if (isCurrentGame && !isCommitted) {
    return '<div class="game-result next">NEXT</div>';
  }

  if (!isCommitted) {
    return `<div class="game-result upcoming">${_scheduledTime(game)}</div>`;
  }

  if (game.status === GAME_STATUS.POSTPONED || game.result === 'postponed') {
    return '<div class="game-result ppd">PPD</div>';
  }

  const won   = game.result === 'win';
  const us    = game.score?.us   ?? game.score?.user     ?? '';
  const them  = game.score?.them ?? game.score?.opponent ?? '';
  const score = (us !== '' && them !== '') ? `${us}–${them}` : '';
  const cls   = won ? 'win' : 'loss';
  const label = won ? 'W' : 'L';

  return `<div class="gri-wrap">
    <div class="game-result ${cls}">${label}${score ? ' ' + score : ''}</div>
    ${hasBoxScore ? `<button class="game-bs-btn" data-game-idx="${idx}">Stats</button>` : ''}
  </div>`;
}

function _renderBadges(game, idx, currentIdx, state) {
  const badges = [];

  if (game.isSpring)         badges.push({ text: 'ST',       cls: 'dh'     });
  if (game.isPlayoff)        badges.push({ text: 'PLAYOFF',  cls: 'playoff' });
  if (game.isMakeup)       badges.push({ text: 'MAKEUP',  cls: 'makeup' });
  if (game.isDoubleHeader) badges.push({ text: 'DH',      cls: 'dh' });

  // Series context badges
  const ctx = _seriesContext(game, idx, state);
  if (ctx) badges.push(ctx);

  if (badges.length === 0) return '';
  return badges.map(b => `<span class="game-badge ${b.cls}">${b.text}</span>`).join('');
}

function _seriesContext(game, idx, state) {
  const schedule = state.schedule;
  const opp = game.opponent || game.opp;
  if (!opp) return null;

  const seriesStart = _findSeriesStart(schedule, idx, opp);
  const seriesEnd   = _findSeriesEnd(schedule, idx, opp);
  const seriesGames = schedule.slice(seriesStart, seriesEnd + 1);
  if (seriesGames.length < 2) return null;

  const committed  = seriesGames.filter(g => g._committed);
  const wins       = committed.filter(g => g.result === 'win').length;
  const losses     = committed.filter(g => g.result === 'loss').length;
  const seriesGame = idx - seriesStart + 1; // 1-based position in series

  // Forward-looking badge on upcoming games
  if (!game._committed) {
    if (seriesGame === 2) {
      if (wins === 1)   return { text: 'Sweep opp.',   cls: 'sweep'   };
      if (losses === 1) return { text: 'Avoid sweep',  cls: 'avoid'   };
    }
    if (seriesGame === 3) {
      if (wins === 2)   return { text: 'Sweep',         cls: 'sweep'   };
      if (losses === 2) return { text: 'Salvage',       cls: 'salvage' };
      if (wins === 1 && losses === 1) return { text: 'Rubber game', cls: 'rubber' };
    }
    return null;
  }

  // Retroactive badge on last game of a fully completed series
  if (committed.length !== seriesGames.length || idx !== seriesEnd) return null;

  const total = seriesGames.length;
  if (wins === total)   return { text: 'SWEEP', cls: 'sweep' };
  if (losses === total) return { text: 'SWEPT', cls: 'avoid' };
  if (wins > losses)    return { text: 'WON',   cls: 'sweep' };
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
  // Scores button
  document.getElementById('sched-scores-btn')?.addEventListener('click', () => {
    App.playClick();
    _openScoresModal(state);
  });

  // Month header collapse/expand — toggle only the tapped month
  document.querySelectorAll('[data-month]').forEach(el => {
    el.addEventListener('click', () => {
      App.playClick();
      const key = el.dataset.month;
      _monthOpen[key] = !_monthOpen[key];
      // Rebuild only this group without full refresh for performance
      refresh();
    });
  });

  // Tap completed game row — opens result sheet
  document.querySelectorAll('[data-game-idx]').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't open if tapping the opponent name or box score button (handled separately)
      if (e.target.closest('[data-opp]') || e.target.closest('.game-bs-btn')) return;
      const idx  = parseInt(el.dataset.gameIdx);
      const game = state.schedule?.[idx];
      if (!game?._committed) return;
      App.playClick();
      _openResultSheet(game, idx, state);
    });
  });

  // Box score Stats button
  document.querySelectorAll('.game-bs-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx  = parseInt(btn.dataset.gameIdx);
      const game = state.schedule?.[idx];
      if (!game) return;
      App.playClick();
      _openResultSheet(game, idx, state);
    });
  });

  // Tap opponent team name — opens team detail modal
  document.querySelectorAll('[data-opp]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const opp = el.dataset.opp;
      if (!opp) return;
      App.playClick();
      _openTeamModal(opp, state);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// RESULT SHEET — tapping a completed game
// ─────────────────────────────────────────────────────────────

function _openResultSheet(game, idx, state) {
  document.getElementById('sched-result-sheet')?.remove();

  const won   = game.result === 'win';
  const us    = game.score?.us   ?? 0;
  const them  = game.score?.them ?? 0;
  const opp   = game.opponent || game.opp || '?';
  const date  = game.date || '';
  const [, mo, dy] = date.split('-');
  const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = `${MONTHS[parseInt(mo)] || ''} ${parseInt(dy) || ''}`;
  const locStr  = game.isHome ? 'Home' : `@ ${_escape(opp)}`;
  const resCls  = won ? 'win' : 'loss';
  const resLbl  = won ? 'W' : 'L';

  // Box score — read the stored box (game.boxScore). Old saves committed before
  // the shared accumulator existed have plays but no boxScore; rebuild on the fly.
  let boxHtml = '';
  let box = game.boxScore;
  if (!box && game.plays?.length > 0) {
    box = accumulateBox(game.plays, state.players || {}, { userIsHome: !!game.isHome });
  }
  if (box) {
    const userName = state.userTeam?.abbr || state.userTeam?.name || 'You';
    const oppName  = game.opponent || game.opp || 'Opp';
    boxHtml = renderBoxScore(box, {
      awayName: game.isHome ? oppName : userName,
      homeName: game.isHome ? userName : oppName,
    });
  }

  const overlay = document.createElement('div');
  overlay.id = 'sched-result-sheet';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:80dvh;">
      <div class="modal-handle"></div>
      <div style="padding:14px 20px 12px;text-align:center;border-bottom:1px solid var(--border);">
        <div style="font-size:12px;color:var(--muted);font-weight:500;">${dateStr} · ${locStr}</div>
        <div style="font-size:13px;font-weight:600;color:var(--soft);margin-top:2px;">${_escape(game.isHome ? `vs ${opp}` : `@ ${opp}`)}</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:48px;line-height:1;margin:8px 0 4px;
          color:${won ? 'var(--accent2)' : 'var(--danger)'};">${us}–${them}</div>
        <div class="game-result ${resCls}" style="display:inline-block;">${resLbl}</div>
      </div>
      <div style="overflow-y:auto;padding:12px 0 max(16px,env(safe-area-inset-bottom));">
        ${boxHtml || '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">No play data available.</div>'}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  App.playSoundOpen();
}

// ─────────────────────────────────────────────────────────────
// TEAM DETAIL MODAL
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
    <div class="tm-player-row" data-player-id="${p.id}" style="display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border);cursor:pointer;">
      <span style="flex:1;font-size:14px;font-weight:600;">${_escape(p.name)}</span>
      <span style="font-size:12px;color:var(--muted);">${p.pos}</span>
      <span style="font-size:13px;font-weight:700;color:${p.ovr >= 75 ? 'var(--accent2)' : p.ovr >= 60 ? 'var(--text)' : 'var(--muted)'};">${p.ovr}</span>
      <span style="font-size:12px;color:var(--muted);">›</span>
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

  // Wire player row taps — open canonical PlayerCard sheet
  overlay.querySelectorAll('.tm-player-row[data-player-id]').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      App.playClick();
      const playerId = row.dataset.playerId;
      if (playerId) openPlayerCard(playerId, StateManager.get());
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SCORES MODAL
// ─────────────────────────────────────────────────────────────

let _scoresInterval  = null;
let _scoresBrowseDate = null;

function _openScoresModal(state) {
  document.getElementById('sched-scores-overlay')?.remove();

  // Default browse date: current game's display date
  const schedule    = state.schedule || [];
  const gameIdx     = state.currentGameIndex || 0;
  const refGame     = schedule[gameIdx] || schedule[Math.max(0, gameIdx - 1)];
  _scoresBrowseDate = refGame?.date || (schedule[0]?.date || '');

  const overlay = document.createElement('div');
  overlay.id = 'sched-scores-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:88dvh;display:flex;flex-direction:column;">
      <div class="modal-handle" style="flex-shrink:0;"></div>
      <div class="modal-header" style="flex-shrink:0;">
        <div class="modal-title">Scores</div>
        <button class="modal-close" id="scores-close">×</button>
      </div>
      <div class="modal-divider" style="flex-shrink:0;"></div>
      <div id="scores-nav" style="flex-shrink:0;"></div>
      <div id="scores-body" style="flex:1;overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));"></div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    clearInterval(_scoresInterval);
    _scoresInterval = null;
    document.getElementById('sched-scores-overlay')?.remove();
  };

  overlay.querySelector('#scores-close')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  _renderScoresModal(state);
  App.playSoundOpen();

  // Refresh every 5 seconds while open (matches app tick)
  _scoresInterval = setInterval(() => {
    const fresh = StateManager.get();
    if (fresh && document.getElementById('sched-scores-overlay')) _renderScoresModal(fresh);
    else { clearInterval(_scoresInterval); _scoresInterval = null; }
  }, 5000);
}

function _renderScoresModal(state) {
  const navEl  = document.getElementById('scores-nav');
  const bodyEl = document.getElementById('scores-body');
  if (!navEl || !bodyEl) return;

  const schedule    = state.schedule || [];
  const dayMap      = state.leagueSchedule?.dayMap || {};
  const leagueTeams = state.leagueTeams || [];

  // All unique display dates from user schedule, sorted
  const allDates = [...new Set(schedule.map(g => g.date).filter(Boolean))].sort();
  if (!allDates.length) {
    bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">No schedule yet.</div>';
    return;
  }

  // Clamp to valid range
  if (!_scoresBrowseDate || _scoresBrowseDate < allDates[0]) _scoresBrowseDate = allDates[0];
  if (_scoresBrowseDate > allDates[allDates.length - 1])     _scoresBrowseDate = allDates[allDates.length - 1];

  const curIdx   = allDates.indexOf(_scoresBrowseDate);
  const prevDate = curIdx > 0                   ? allDates[curIdx - 1] : null;
  const nextDate = curIdx < allDates.length - 1 ? allDates[curIdx + 1] : null;

  const MNAMES  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const moLabel = d => MNAMES[parseInt(d.slice(5, 7)) - 1];
  const [, mo, dy] = _scoresBrowseDate.split('-');
  const dateLabel = `${MNAMES[parseInt(mo) - 1]} ${parseInt(dy)}`;

  // Month jump targets
  const allMonths   = [...new Set(allDates.map(d => d.slice(0, 7)))].sort();
  const curMo       = _scoresBrowseDate.slice(0, 7);
  const prevMo      = allMonths[allMonths.indexOf(curMo) - 1];
  const nextMo      = allMonths[allMonths.indexOf(curMo) + 1];
  const prevMoFirst = prevMo ? allDates.find(d => d.startsWith(prevMo)) : null;
  const nextMoFirst = nextMo ? allDates.find(d => d.startsWith(nextMo)) : null;

  navEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:6px 16px 2px;">
      <div>${prevMoFirst ? `<button class="sg-mo-btn" data-date="${prevMoFirst}">← ${moLabel(prevMoFirst + '-01')}</button>` : ''}</div>
      <span style="font-size:12px;font-weight:700;color:var(--text);">${moLabel(_scoresBrowseDate)} ${_scoresBrowseDate.slice(0,4)}</span>
      <div style="text-align:right;">${nextMoFirst ? `<button class="sg-mo-btn" data-date="${nextMoFirst}">${moLabel(nextMoFirst + '-01')} →</button>` : ''}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 16px 10px;">
      <button class="sg-nav-btn" ${!prevDate ? 'disabled' : ''} data-date="${prevDate || ''}">&#8592;</button>
      <span style="font-size:14px;font-weight:700;color:var(--text);">${dateLabel}</span>
      <button class="sg-nav-btn" ${!nextDate ? 'disabled' : ''} data-date="${nextDate || ''}">&#8594;</button>
    </div>
    <div style="height:1px;background:var(--border);margin-bottom:4px;"></div>`;

  // Wire navigation
  navEl.querySelectorAll('[data-date]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.date;
      if (d) { App.playClick(); _scoresBrowseDate = d; _renderScoresModal(state); }
    });
  });

  // Gather games for this date
  const userGame = schedule.find(g => g.date === _scoresBrowseDate && !g.isPlayoff);
  const cpuGames = dayMap[_scoresBrowseDate] || [];

  if (!userGame && !cpuGames.length) {
    bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">No games today.</div>';
    return;
  }

  const _abbr = id => (leagueTeams.find(t => t.id === id)?.abbr || id?.substring(0,3) || '???').toUpperCase();
  const _sfx  = n => n===1?'st':n===2?'nd':n===3?'rd':'th';

  let rows = '';

  // User's game — shown first with accent highlight
  if (userGame) {
    const isLive = userGame.plays?.length > 0 && !userGame._committed
      && userGame.status !== GAME_STATUS.SCHEDULED
      && userGame.status !== GAME_STATUS.PRE_GAME_WATCH;

    const userAbbr = (state.userTeam?.abbr || 'US').toUpperCase();
    const oppTeam  = leagueTeams.find(t => t.name === userGame.opponent);
    const oppAbbr  = (oppTeam?.abbr || userGame.opponent?.split(' ').pop()?.substring(0,3) || 'OPP').toUpperCase();
    const awayAbbr = userGame.isHome ? oppAbbr  : userAbbr;
    const homeAbbr = userGame.isHome ? userAbbr : oppAbbr;

    let scorePart, metaPart;

    if (isLive) {
      // Derive live score from plays
      const plays = userGame.plays || [];
      const liveIdx = userGame.livePlayIndex || 0;
      const revealed = plays.slice(0, liveIdx);
      let ourScore = 0, theirScore = 0, curInning = 1, curHalf = 'TOP';
      for (let i = revealed.length - 1; i >= 0; i--) {
        const p = revealed[i];
        if (p.cumOurScore !== undefined) { ourScore = p.cumOurScore; theirScore = p.cumTheirScore; break; }
      }
      for (let i = revealed.length - 1; i >= 0; i--) {
        const p = revealed[i];
        if (p.inning && p.half && p.type !== 'game_end') { curInning = p.inning; curHalf = p.half; break; }
      }
      const awayScore = userGame.isHome ? theirScore : ourScore;
      const homeScore = userGame.isHome ? ourScore   : theirScore;
      const halfSym   = curHalf === 'TOP' ? '▲' : '▼';
      scorePart = `<span class="sg-away-score">${awayScore}</span><span class="sg-dash">–</span><span class="sg-home-score">${homeScore}</span>`;
      metaPart  = `<span class="sg-live-pill">● ${halfSym}${curInning}${_sfx(curInning)}</span>`;
    } else if (userGame._committed) {
      const us   = userGame.score?.us   ?? 0;
      const them = userGame.score?.them ?? 0;
      const aw   = userGame.isHome ? them : us;
      const ho   = userGame.isHome ? us   : them;
      const won  = userGame.result === 'win';
      scorePart = `<span class="${won && !userGame.isHome || !won && userGame.isHome ? 'sg-score-winner':''}">${aw}</span><span class="sg-dash">–</span><span class="${won && userGame.isHome || !won && !userGame.isHome ? 'sg-score-winner':''}">${ho}</span>`;
      metaPart  = `<span class="sg-final-pill">F</span>`;
    } else {
      scorePart = `<span class="sg-time">${_scheduledTime(userGame)}</span>`;
      metaPart  = '';
    }

    rows += `<div class="sg-row sg-row-user">
      <span class="sg-abbr sg-abbr-away">${awayAbbr}</span>
      <span class="sg-score-wrap">${scorePart}</span>
      <span class="sg-abbr sg-abbr-home">${homeAbbr}</span>
      <span class="sg-status">${metaPart}</span>
    </div>`;
  }

  // CPU games
  for (const g of cpuGames) {
    const awayAbbr = _abbr(g.awayId);
    const homeAbbr = _abbr(g.homeId);
    let scorePart, metaPart;

    if (g.played && g.homeScore !== null) {
      const aWin = g.awayScore > g.homeScore;
      const hWin = g.homeScore > g.awayScore;
      scorePart = `<span class="${aWin?'sg-score-winner':''}">${g.awayScore}</span><span class="sg-dash">–</span><span class="${hWin?'sg-score-winner':''}">${g.homeScore}</span>`;
      metaPart  = `<span class="sg-final-pill">F</span>`;
    } else {
      // Show a plausible game time from DOW
      const d   = new Date(_scoresBrowseDate + 'T12:00:00');
      const DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
      const dow = DOW[d.getDay()];
      const times = GAME_TIMES_BY_DOW[dow] || ['7:05 PM'];
      scorePart = `<span class="sg-time">${times[0]}</span>`;
      metaPart  = '';
    }

    rows += `<div class="sg-row">
      <span class="sg-abbr sg-abbr-away">${awayAbbr}</span>
      <span class="sg-score-wrap">${scorePart}</span>
      <span class="sg-abbr sg-abbr-home">${homeAbbr}</span>
      <span class="sg-status">${metaPart}</span>
    </div>`;
  }

  bodyEl.innerHTML = `<div style="padding:0 16px 8px;">${rows}</div>`;
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
    .game-item.current-game { animation: currentPulse 2.4s ease-in-out infinite; }
    .game-item.playoff-game { border-color: rgba(245,210,83,.25); }
    .gri-wrap { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0; }
    .game-bs-btn { font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;
      color:var(--accent);background:var(--chip-accent-bg);border:none;border-radius:6px;
      padding:3px 8px;cursor:pointer;font-family:'DM Sans',sans-serif; }
    .game-bs-btn:active { opacity:.7; }
    .month-game-count { font-size:11px; color:var(--muted); font-weight:500; }

    /* Scores button */
    .scores-btn { font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;
      color:var(--muted);background:var(--surface2);border:1px solid var(--border);
      border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'DM Sans',sans-serif;flex-shrink:0; }
    .scores-btn:active { opacity:.7; }

    /* Score grid */
    .sg-row { display:grid;grid-template-columns:2.5rem 1fr 2.5rem 2.5rem;align-items:center;
      padding:9px 0;border-bottom:1px solid var(--border);gap:4px; }
    .sg-row:last-child { border-bottom:none; }
    .sg-row-user { border-left:2px solid var(--accent);padding-left:8px;margin-left:-8px; }
    .sg-abbr { font-size:12px;font-weight:700;color:var(--text); }
    .sg-abbr-away { text-align:right; }
    .sg-abbr-home { text-align:left; }
    .sg-score-wrap { text-align:center;font-family:'Bebas Neue',sans-serif;font-size:18px;line-height:1;color:var(--muted); }
    .sg-score-winner { color:var(--text); }
    .sg-dash { color:var(--border);margin:0 2px; }
    .sg-time { font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;color:var(--muted); }
    .sg-status { text-align:right; }
    .sg-live-pill { font-size:9px;font-weight:800;letter-spacing:.5px;color:var(--danger);white-space:nowrap; }
    .sg-final-pill { font-size:9px;font-weight:700;color:var(--muted); }
    .sg-mo-btn { background:none;border:none;font-size:11px;font-weight:700;color:var(--muted);cursor:pointer;padding:2px 0;font-family:'DM Sans',sans-serif; }
    .sg-mo-btn:active { opacity:.7; }
    .sg-nav-btn { background:none;border:1px solid var(--border);border-radius:6px;padding:4px 12px;font-size:15px;cursor:pointer;color:var(--text); }
    .sg-nav-btn:disabled { color:var(--border);cursor:default; }
    .sg-nav-btn:active:not(:disabled) { opacity:.7; }
  `;
  document.head.appendChild(style);
}
