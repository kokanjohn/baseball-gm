/**
 * ui/screens/PlayoffScreen.js
 * Playoff bracket view — rendered into #dashboard-content during playoff phases,
 * or accessible from the Schedule screen via the playoff round dividers.
 *
 * Layout (Playoff Screen Spec — LOCKED):
 *   Two division panels side by side (or stacked on narrow screens)
 *   Per-division bracket:
 *     Wild Card row    → 4th vs 5th seed (1 game)
 *     First Round row  → 1st vs WC winner + 2nd vs 3rd (best of 3)
 *     Division Series  → First Round winners (best of 5)
 *   World Series row   → Division champions face off (best of 7), full width
 *
 * Series chips show: team names, series record (e.g. "2–1"), status (LIVE/FINAL/TBD)
 * User's team chips highlighted with accent border.
 * Eliminated teams shown with muted styling.
 *
 * This screen is read-only — no actions, no advance buttons.
 * Live mode rules (Section 2.1 — LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { formatRecord }  from '../formatters.js';
import {
  PLAYOFF_WILD_CARD_GAMES,
  PLAYOFF_FIRST_ROUND_BEST_OF,
  PLAYOFF_DIVISION_SERIES_BEST_OF,
  PLAYOFF_WORLD_SERIES_BEST_OF,
} from '../../data/constants.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted   = false;
let _listeners = [];

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('schedule', () => refresh()); // shown from schedule tab context

  _listeners.push(EventBus.on('game:committed',    () => refresh()));
  _listeners.push(EventBus.on('game:phaseChanged', () => refresh()));

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
  const container = document.getElementById('playoff-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state) return;

  const bracket = state.playoffBracket;
  if (!bracket) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--muted);">
        <div style="font-size:40px;margin-bottom:12px;">🏆</div>
        <div style="font-size:15px;">Playoffs begin after the regular season.</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="playoff-screen">
      <div class="section-pad" style="padding-bottom:8px;">
        <div class="section-title">Playoffs</div>
        <div class="section-sub">${_playoffStatusLine(bracket, state)}</div>
      </div>

      <!-- Two division panels -->
      <div class="playoff-panels">
        ${_renderDivisionPanel('A', bracket.divA, state)}
        ${_renderDivisionPanel('B', bracket.divB, state)}
      </div>

      <!-- World Series — full width -->
      ${_renderWorldSeries(bracket.WORLD_SERIES, state)}
    </div>
  `;

  _attachListeners(state);
}

// ─────────────────────────────────────────────────────────────
// DIVISION PANEL
// ─────────────────────────────────────────────────────────────

function _renderDivisionPanel(divId, divBracket, state) {
  if (!divBracket) return '';

  return `
    <div class="playoff-division-panel">
      <div class="playoff-division-label">Division ${divId}</div>

      ${_renderRoundRow('Wild Card', 'WILD_CARD', divBracket.WILD_CARD, state, PLAYOFF_WILD_CARD_GAMES, true)}
      ${_renderRoundRow('First Round', 'FIRST_ROUND', divBracket.FIRST_ROUND, state, PLAYOFF_FIRST_ROUND_BEST_OF, false)}
      ${_renderRoundRow('Division Series', 'DIVISION_SERIES', divBracket.DIVISION_SERIES, state, PLAYOFF_DIVISION_SERIES_BEST_OF, false)}
    </div>
  `;
}

function _renderRoundRow(label, roundKey, roundData, state, bestOf, isWildCard) {
  if (!roundData) return '';

  const series = Array.isArray(roundData.series) ? roundData.series : [roundData];

  const chips = series.map(s => _renderSeriesChip(s, state, bestOf, isWildCard)).join('');

  return `
    <div class="playoff-round-row">
      <div class="playoff-round-label">${label}${isWildCard ? ' (1 game)' : ` (best of ${bestOf})`}</div>
      <div class="playoff-series-chips">${chips}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// SERIES CHIP
// ─────────────────────────────────────────────────────────────

function _renderSeriesChip(series, state, bestOf, isWildCard) {
  if (!series) return '';

  const teamA     = _resolveTeam(series.teamA, state);
  const teamB     = _resolveTeam(series.teamB, state);
  const userInvolved = series.teamA?.id === 'user' || series.teamB?.id === 'user';
  const winsA     = series.winsA || 0;
  const winsB     = series.winsB || 0;
  const winner    = series.winner;
  const isActive  = series.status === 'live' || series.status === 'active';
  const isFinal   = !!winner || series.status === 'final';

  // Status label
  const statusCls = isActive ? 'live' : isFinal ? 'final' : '';
  const statusTxt = isActive ? 'LIVE'
    : isFinal ? 'FINAL'
    : series.status === 'upcoming' ? 'TBD'
    : 'TBD';

  // Record string
  const recordStr = isWildCard
    ? (isFinal ? (winner?.id === series.teamA?.id ? 'W' : 'L') : '—')
    : `${winsA}–${winsB}`;

  // Team A display
  const teamAElim   = isFinal && winner?.id !== series.teamA?.id;
  const teamBElim   = isFinal && winner?.id !== series.teamB?.id;
  const teamAIsUser = series.teamA?.id === 'user';
  const teamBIsUser = series.teamB?.id === 'user';

  return `
    <div class="playoff-series-chip ${userInvolved ? 'user-involved' : ''}"
      data-series="${series.id || ''}">
      <div class="playoff-chip-teams">
        <div class="playoff-chip-team ${teamAElim ? 'elim' : ''} ${teamAIsUser ? 'user-team' : ''}">
          ${_teamSeed(series.teamA)} ${_escape(teamA.abbr || teamA.name || '?')}
          ${winsA > winsB && !isWildCard ? `<span class="chip-wins">${winsA}</span>` : ''}
        </div>
        <div class="playoff-chip-vs">vs</div>
        <div class="playoff-chip-team ${teamBElim ? 'elim' : ''} ${teamBIsUser ? 'user-team' : ''}">
          ${_teamSeed(series.teamB)} ${_escape(teamB.abbr || teamB.name || '?')}
          ${winsB > winsA && !isWildCard ? `<span class="chip-wins">${winsB}</span>` : ''}
        </div>
      </div>
      ${!isWildCard ? `<div class="playoff-chip-record">${recordStr}</div>` : ''}
      <div class="playoff-chip-status ${statusCls}">${statusTxt}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// WORLD SERIES (full width)
// ─────────────────────────────────────────────────────────────

function _renderWorldSeries(wsData, state) {
  if (!wsData) return '';

  const series    = wsData.series?.[0] || wsData;
  const teamA     = _resolveTeam(series.teamA, state);
  const teamB     = _resolveTeam(series.teamB, state);
  const winsA     = series.winsA || 0;
  const winsB     = series.winsB || 0;
  const winner    = series.winner;
  const isFinal   = !!winner;
  const isActive  = series.status === 'live' || series.status === 'active';
  const userInvA  = series.teamA?.id === 'user';
  const userInvB  = series.teamB?.id === 'user';
  const userInvolved = userInvA || userInvB;

  const winnerName = winner
    ? _escape(_resolveTeam(winner, state).name || 'Champion')
    : null;

  return `
    <div class="playoff-world-series ${userInvolved ? 'user-in-ws' : ''}">
      <div class="playoff-ws-label">⭐ World Series (best of ${PLAYOFF_WORLD_SERIES_BEST_OF})</div>

      ${winnerName ? `
        <div class="ws-champion-banner">
          🏆 ${winnerName} — World Champions
        </div>
      ` : `
        <div class="ws-matchup">
          <div class="ws-team ${userInvA ? 'user-team' : ''} ${isFinal && winner?.id !== series.teamA?.id ? 'elim' : ''}">
            ${_teamSeed(series.teamA)} ${_escape(teamA.abbr || teamA.name || '—')}
            ${winsA > 0 ? `<span class="ws-wins">${winsA}</span>` : ''}
          </div>
          <div class="ws-vs">
            ${isActive ? '<span class="ws-live-pill">LIVE</span>' : winsA > 0 || winsB > 0 ? `${winsA}–${winsB}` : 'vs'}
          </div>
          <div class="ws-team ${userInvB ? 'user-team' : ''} ${isFinal && winner?.id !== series.teamB?.id ? 'elim' : ''}">
            ${_teamSeed(series.teamB)} ${_escape(teamB.abbr || teamB.name || '—')}
            ${winsB > 0 ? `<span class="ws-wins">${winsB}</span>` : ''}
          </div>
        </div>
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Series chip tap — opens game log for completed series
  document.querySelectorAll('[data-series]').forEach(el => {
    el.addEventListener('click', () => {
      const seriesKey = el.dataset.series;
      if (!seriesKey) return;

      const state  = StateManager.get();
      const bracket = state.playoffBracket;
      if (!bracket) return;

      // Locate the series object from the bracket
      const series = _findSeriesByKey(bracket, seriesKey);
      if (!series) return;

      // Only open log if series has games played
      const games = series.games || [];
      if (games.length === 0 && !series.winner) return;

      _openSeriesLog(series, state);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// SERIES GAME LOG OVERLAY (Phase 15)
// ─────────────────────────────────────────────────────────────

/**
 * _findSeriesByKey(bracket, seriesKey)
 * Locates a series object in the bracket by its key string.
 * Key format: 'divA_WILD_CARD_0', 'divB_FIRST_ROUND_1', 'WORLD_SERIES_0'
 */
function _findSeriesByKey(bracket, seriesKey) {
  if (!bracket || !seriesKey) return null;

  if (seriesKey.startsWith('WORLD_SERIES')) {
    const idx = parseInt(seriesKey.split('_').pop()) || 0;
    return bracket.WORLD_SERIES?.series?.[idx] || null;
  }

  const parts = seriesKey.split('_');
  // parts: ['divA'|'divB', 'WILD', 'CARD'|'FIRST'|..., idx]
  const div   = parts[0]; // 'divA' or 'divB'
  const idx   = parseInt(parts[parts.length - 1]) || 0;
  // Reconstruct round key (everything between div and idx)
  const roundKey = parts.slice(1, parts.length - 1).join('_');

  return bracket[div]?.[roundKey]?.series?.[idx] || null;
}

/**
 * _openSeriesLog(series, state)
 * Opens a lightweight bottom-sheet overlay showing game-by-game scores
 * for a completed or in-progress series.
 */
function _openSeriesLog(series, state) {
  // Remove any existing log
  document.getElementById('series-log-overlay')?.remove();

  const teamA    = _resolveTeam(series.teamA, state);
  const teamB    = _resolveTeam(series.teamB, state);
  const games    = series.games || [];
  const winner   = series.winner;
  const userAbbr = state.userTeam?.abbr || '';

  const isUserA = teamA.abbr === userAbbr;
  const isUserB = teamB.abbr === userAbbr;

  const titleLine = winner
    ? `${_resolveTeam(winner, state).abbr} wins series`
    : `Series in progress`;

  const winsA = (series.wins || {})[series.teamA?.id || ''] || 0;
  const winsB = (series.wins || {})[series.teamB?.id || ''] || 0;

  const gameRows = games.length > 0
    ? games.map((g, i) => {
        const homeScore = g.homeScore ?? 0;
        const awayScore = g.awayScore ?? 0;
        const winnerAbbr = homeScore > awayScore
          ? (g.homeTeamId === series.teamA?.id ? teamA.abbr : teamB.abbr)
          : (g.awayTeamId === series.teamA?.id ? teamA.abbr : teamB.abbr);
        return `
          <div class="series-log-game">
            <span class="series-log-gnum">G${i + 1}</span>
            <span class="series-log-teams">${_escape(teamA.abbr)} ${awayScore > homeScore ? awayScore : homeScore} – ${awayScore > homeScore ? homeScore : awayScore} ${_escape(teamB.abbr)}</span>
            <span class="series-log-winner">${_escape(winnerAbbr)} W</span>
          </div>`;
      }).join('')
    : `<div class="series-log-game" style="color:var(--muted)">No games played yet.</div>`;

  const overlay = document.createElement('div');
  overlay.id = 'series-log-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:70dvh;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div>
          <div style="font-size:16px;font-weight:800;color:var(--text);">
            <span class="${isUserA ? 'series-log-user' : ''}">${_escape(teamA.abbr)}</span>
            <span style="color:var(--muted);margin:0 6px;">${winsA}–${winsB}</span>
            <span class="${isUserB ? 'series-log-user' : ''}">${_escape(teamB.abbr)}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px;">${_escape(titleLine)}</div>
        </div>
        <button class="modal-close" id="series-log-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div style="overflow-y:auto;padding:8px 0 max(16px,env(safe-area-inset-bottom));">
        ${gameRows}
      </div>
    </div>`;

  // Inject minimal CSS if not already present
  if (!document.getElementById('series-log-css')) {
    const style = document.createElement('style');
    style.id = 'series-log-css';
    style.textContent = `
      .series-log-game{display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border);}
      .series-log-gnum{font-size:11px;font-weight:700;color:var(--muted);width:20px;flex-shrink:0;}
      .series-log-teams{flex:1;font-size:14px;font-weight:600;color:var(--text);}
      .series-log-winner{font-size:12px;color:var(--accent2);font-weight:700;}
      .series-log-user{color:var(--accent);}
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  document.getElementById('series-log-close')
    ?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function _playoffStatusLine(bracket, state) {
  const champion = bracket?.champion || bracket?.WORLD_SERIES?.winner;
  if (champion) {
    const name = _resolveTeam(champion, state).name || 'Champion';
    return `🏆 ${_escape(name)} — World Champions`;
  }

  const phase = state.phase;
  const labels = {
    WILD_CARD:       'Wild Card Round',
    FIRST_ROUND:     'First Round',
    DIVISION_SERIES: 'Division Series',
    WORLD_SERIES:    'World Series',
  };
  return labels[phase] || 'Playoffs';
}

function _resolveTeam(teamRef, state) {
  if (!teamRef) return {};
  if (teamRef.id === 'user') {
    return {
      id:   'user',
      name: `${state.userTeam?.city || ''} ${state.userTeam?.nickname || ''}`.trim(),
      abbr: state.userTeam?.abbr || 'US',
    };
  }
  const leagueTeam = (state.leagueTeams || []).find(t => t.id === teamRef.id);
  return leagueTeam || teamRef;
}

function _teamSeed(teamRef) {
  if (!teamRef?.seed) return '';
  return `<span class="chip-seed">${teamRef.seed}</span>`;
}

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
    /* Panels layout — side by side if room, stacked on narrow */
    .playoff-panels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 0 16px 8px;
    }
    @media (max-width: 360px) {
      .playoff-panels { grid-template-columns: 1fr; }
    }

    /* Series chip team rows */
    .playoff-chip-team {
      font-size: 12px; font-weight: 700; color: var(--text);
      display: flex; align-items: center; gap: 4px;
    }
    .playoff-chip-team.elim { opacity: .45; text-decoration: line-through; }
    .playoff-chip-team.user-team { color: var(--accent); }
    .playoff-chip-vs { font-size: 9px; color: var(--muted); margin: 2px 0; }
    .chip-seed { font-size: 9px; color: var(--muted); font-weight: 600;
      background: var(--surface2); padding: 1px 4px; border-radius: 3px; }
    .chip-wins { font-size: 11px; font-weight: 800; color: var(--accent2);
      background: var(--chip-green-bg); padding: 0 4px; border-radius: 4px;
      margin-left: 4px; }

    /* World Series specific */
    .playoff-world-series.user-in-ws {
      border-color: rgba(245,210,83,.5);
      background: linear-gradient(135deg, rgba(245,210,83,.1), rgba(74,222,128,.07));
    }
    .ws-matchup { display: flex; align-items: center; justify-content: center; gap: 12px; }
    .ws-team { font-size: 15px; font-weight: 700; color: var(--text);
      display: flex; align-items: center; gap: 6px; }
    .ws-team.user-team { color: var(--accent); }
    .ws-team.elim { opacity: .4; text-decoration: line-through; }
    .ws-vs { font-size: 13px; color: var(--muted); font-weight: 600; min-width: 32px; text-align: center; }
    .ws-wins { font-size: 16px; font-weight: 800; color: var(--accent2); }
    .ws-live-pill { background: var(--chip-red-bg); color: var(--danger);
      font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 10px; letter-spacing: .5px; }
    .ws-champion-banner { font-size: 16px; font-weight: 700; color: var(--accent2);
      text-align: center; padding: 4px 0; }

    /* Playoff content container */
    #playoff-content { overflow-y: auto; }
  `;
  document.head.appendChild(style);
}
