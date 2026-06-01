/**
 * ui/screens/GameScreen.js
 * Live game view. Rendered into #dashboard-content alongside DashboardScreen.
 *
 * GameScreen does not replace the Dashboard tab — it IS the dashboard when
 * a game is in progress. DashboardScreen mounts GameScreen as a sub-view
 * that overlays the standard dashboard content during live game states.
 *
 * Live mode rules (Section 2.1 — LOCKED):
 *   No advance button. No tap-to-reveal. No simulate button.
 *   The game plays itself via App.js tick loop (Section 8.4).
 *   GameScreen is a pure display layer — it reads state and renders.
 *
 * Seven display states (Section 8.8 — LOCKED):
 *   SCHEDULED      — first-pitch countdown
 *   PRE_GAME_WATCH — countdown + weather warning banner
 *   DELAYED        — rain overlay, delay countdown, radar placeholder
 *   LIVE           — PBP feed + linescore + diamond state
 *   SUSPENDED      — frozen score/inning/outs/bases + next steps
 *   POSTPONED      — rescheduled date
 *   FINAL          — final box score (pre-commit)
 *
 * EventBus:
 *   Listens for 'game:tick' → updates PBP feed and linescore incrementally
 *   Listens for 'game:committed' → transitions to post-game summary
 *
 * RadarWidget: Section 8.8 / Phase 13 component pass TODO
 *   Wire _renderRadarWidget(game, state) when RadarWidget.js is built.
 *   Already flagged in DashboardScreen with the same TODO.
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { GAME_STATUS }   from '../../data/constants.js';
import { renderRadarWidget }          from '../components/RadarWidget.js';
import { renderDiamond, updateDiamond } from '../components/LiveDiamond.js';
import { renderLinescore, linescoreFromGame } from '../components/Linescore.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted      = false;
let _listeners    = [];
let _activeTab    = 'pbp';   // 'pbp' | 'box'
let _countdownTimer = null;  // setInterval for first-pitch countdown display refresh

// Max plays to show in PBP feed before truncating older plays
const MAX_PBP_DISPLAY = 40;

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

/**
 * mount()
 * Called by DashboardScreen when it detects a live game is active.
 * Wires EventBus listeners for tick updates.
 */
export function mount() {
  if (_mounted) return;
  _mounted = true;

  // Incremental tick update — append new play without full re-render
  _listeners.push(EventBus.on('game:tick', ({ play, game }) => {
    _onTick(play, game);
  }));

  // Full refresh on commit (transitions to FINAL / post-game state)
  _listeners.push(EventBus.on('game:committed', () => {
    render();
  }));

  // Phase change can affect display state
  _listeners.push(EventBus.on('game:phaseChanged', () => {
    render();
  }));

  render();
}

export function unmount() {
  _listeners.forEach(([event, handler]) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
  _stopCountdown();
}

// ─────────────────────────────────────────────────────────────
// RENDER — FULL
// ─────────────────────────────────────────────────────────────

/**
 * render()
 * Full re-render of the game view. Called on mount, commit, and phase change.
 * Tick updates use incremental DOM patching via _onTick() instead.
 */
export function render() {
  const container = document.getElementById('live-game-container');
  if (!container) return;

  const state = StateManager.get();
  const game  = _getCurrentGame(state);

  if (!game) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = _renderGameState(game, state);
  _attachListeners(game, state);

  // Start countdown refresh if pre-game
  if ([GAME_STATUS.SCHEDULED, GAME_STATUS.PRE_GAME_WATCH].includes(game.status)) {
    _startCountdown(game);
  } else {
    _stopCountdown();
  }

  // Scroll PBP feed to bottom to show latest play
  _scrollPBPToBottom();
}

// ─────────────────────────────────────────────────────────────
// DISPLAY STATE ROUTER (Section 8.8)
// ─────────────────────────────────────────────────────────────

function _renderGameState(game, state) {
  switch (game.status) {
    case GAME_STATUS.SCHEDULED:
      return _renderPreGame(game, state, false);

    case GAME_STATUS.PRE_GAME_WATCH:
      return _renderPreGame(game, state, true);

    case GAME_STATUS.DELAYED:
      return _renderDelayed(game, state);

    case GAME_STATUS.LIVE:
      return _renderLive(game, state);

    case GAME_STATUS.SUSPENDED:
      return _renderSuspended(game, state);

    case GAME_STATUS.POSTPONED:
      return _renderPostponed(game, state);

    case GAME_STATUS.FINAL:
      return _renderFinal(game, state);

    default:
      return _renderPreGame(game, state, false);
  }
}

// ─────────────────────────────────────────────────────────────
// PRE-GAME (SCHEDULED + PRE_GAME_WATCH)
// ─────────────────────────────────────────────────────────────

function _renderPreGame(game, state, hasWeatherWarning) {
  const now       = Date.now();
  const gameTime  = game._scheduledMs || 0;
  const diffMs    = Math.max(0, gameTime - now);
  const diffMins  = Math.ceil(diffMs / 60000);
  const hours     = Math.floor(diffMins / 60);
  const mins      = diffMins % 60;
  const timeStr   = hours > 0 ? `${hours}h ${mins}m` : `${diffMins}m`;
  const warmClass = diffMins <= 30 ? 'fp-hot' : diffMins <= 90 ? 'fp-warm' : '';

  const weatherWarning = hasWeatherWarning ? `
    <div class="weather-warning-banner">
      ⛈️ <strong>Weather Watch</strong> — Threatening conditions near game time.
      Check your inbox for the latest update.
    </div>
  ` : '';

  const matchupLabel = _matchupLabel(game, state);

  // RADAR WIDGET — Phase 13 component pass ✓
  const radarPlaceholder = hasWeatherWarning && state?.weatherBuffer
    ? renderRadarWidget(state.weatherBuffer, game.status)
    : '';

  return `
    <div class="live-game-wrap" id="live-game-wrap">
      ${weatherWarning}
      <div style="padding:16px;text-align:center;">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">${_escape(matchupLabel)}</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px;">${_gameMetaLine(game, state)}</div>
        <div class="fp-card ${warmClass}" id="fp-card">
          <div class="fp-label">First Pitch</div>
          <div class="fp-time" id="fp-countdown">${diffMs === 0 ? 'LIVE' : timeStr}</div>
          <div class="fp-sub">${diffMins <= 90 ? 'Check your inbox before the game' : 'See you at game time'}</div>
        </div>
        ${radarPlaceholder}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// DELAYED
// ─────────────────────────────────────────────────────────────

function _renderDelayed(game, state) {
  const delayStart  = game._delayStartMs || Date.now();
  const delayMins   = Math.floor((Date.now() - delayStart) / 60000);

  // RADAR WIDGET — TODO Phase 13 component pass
  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div class="live-score-header">
        <div class="live-teams">
          ${_renderScoreRow(game, state, false)}
          ${_renderScoreRow(game, state, true)}
        </div>
        <div class="live-meta">
          <div class="live-inning">${_inningLabel(game)}</div>
          <div class="live-status-pill live-delay">DELAYED</div>
        </div>
      </div>
      <div style="padding:16px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">⛈️</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;color:var(--text);">
          Game Delayed
        </div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px;">
          ${delayMins > 0 ? `Delayed ${delayMins} minute${delayMins !== 1 ? 's' : ''}` : 'Delay in progress'}
          · Rain overlay active
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px;">
          The game will resume automatically when conditions clear.
          Check your inbox for updates.
        </div>
        <div id="delayed-radar">${state?.weatherBuffer
          ? renderRadarWidget(state.weatherBuffer, game.status) : ''}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// LIVE — main game view
// ─────────────────────────────────────────────────────────────

function _renderLive(game, state) {
  const revealedPlays = _getRevealedPlays(game);

  return `
    <div class="live-game-wrap" id="live-game-wrap">

      <!-- Score header -->
      <div class="live-score-header">
        <div class="live-teams">
          ${_renderScoreRow(game, state, false)}
          ${_renderScoreRow(game, state, true)}
        </div>
        <div class="live-meta">
          <div class="live-inning" id="live-inning">${_inningLabel(game)}</div>
          <div class="live-status-pill live-active">LIVE</div>
        </div>
      </div>

      <!-- Linescore -->
      ${renderLinescore(linescoreFromGame(game, state))}

      <!-- Outs + bases row -->
      <div style="display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--border);">
        <div id="live-diamond-container">${renderDiamond(game)}</div>
        <div style="flex:1;font-size:11px;color:var(--muted);text-align:right;" id="live-count">
          ${_countLabel(game)}
        </div>
      </div>

      <!-- Tab bar: PBP / Box Score -->
      <div class="live-tabs">
        <div class="live-tab ${_activeTab === 'pbp' ? 'active' : ''}" id="live-tab-pbp">Play by Play</div>
        <div class="live-tab ${_activeTab === 'box' ? 'active' : ''}" id="live-tab-box">Box Score</div>
      </div>

      <!-- Tab content -->
      <div class="live-tab-content ${_activeTab === 'pbp' ? 'active' : ''}" id="live-tab-content-pbp">
        <div class="pbp-feed" id="pbp-feed">
          ${_renderPBP(revealedPlays)}
        </div>
      </div>
      <div class="live-tab-content ${_activeTab === 'box' ? 'active' : ''}" id="live-tab-content-box">
        <div class="live-box-wrap">
          ${_renderBoxScore(game, state, revealedPlays)}
        </div>
      </div>

    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// SUSPENDED
// ─────────────────────────────────────────────────────────────

function _renderSuspended(game, state) {
  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div class="live-score-header">
        <div class="live-teams">
          ${_renderScoreRow(game, state, false)}
          ${_renderScoreRow(game, state, true)}
        </div>
        <div class="live-meta">
          <div class="live-inning">${_inningLabel(game)}</div>
          <div class="live-status-pill live-delay">SUSP</div>
        </div>
      </div>
      <div style="padding:16px;text-align:center;">
        <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:6px;">Game Suspended</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;">
          Score, inning, outs, and baserunner state are preserved.
          The game will resume from this point — check your inbox for the makeup schedule.
        </div>
        ${_renderOutsIndicator(game)}
        <div style="margin-top:8px;">${_renderBasesIndicator(game)}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// POSTPONED
// ─────────────────────────────────────────────────────────────

function _renderPostponed(game, state) {
  const makeupDate = game._makeupDate ? `Rescheduled: ${game._makeupDate}` : 'Makeup date TBD';
  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div style="padding:20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">🌧️</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;color:var(--text);">
          Game Postponed
        </div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px;">${_escape(makeupDate)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px;">
          ${_escape(_matchupLabel(game, state))}
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// FINAL (pre-commit box score)
// ─────────────────────────────────────────────────────────────

function _renderFinal(game, state) {
  const won       = (game.ourScore || 0) > (game.theirScore || 0);
  const scoreStr  = `${game.ourScore ?? 0}–${game.theirScore ?? 0}`;
  const resultCls = won ? 'lgt-str-w' : 'lgt-str-l';
  const resultTxt = won ? 'W' : 'L';
  const revealedPlays = _getRevealedPlays(game);

  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div class="live-score-header">
        <div class="live-teams">
          ${_renderScoreRow(game, state, false)}
          ${_renderScoreRow(game, state, true)}
        </div>
        <div class="live-meta">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1;
            color:var(--text);">${scoreStr}</div>
          <div class="live-status-pill live-final">FINAL</div>
        </div>
      </div>

      ${renderLinescore(linescoreFromGame(game, state))}

      <!-- Tab bar -->
      <div class="live-tabs">
        <div class="live-tab ${_activeTab === 'pbp' ? 'active' : ''}" id="live-tab-pbp">Play by Play</div>
        <div class="live-tab ${_activeTab === 'box' ? 'active' : ''}" id="live-tab-box">Box Score</div>
      </div>
      <div class="live-tab-content ${_activeTab === 'pbp' ? 'active' : ''}" id="live-tab-content-pbp">
        <div class="pbp-feed" id="pbp-feed">
          ${_renderPBP(revealedPlays)}
        </div>
      </div>
      <div class="live-tab-content ${_activeTab === 'box' ? 'active' : ''}" id="live-tab-content-box">
        <div class="live-box-wrap">
          ${_renderBoxScore(game, state, revealedPlays)}
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// LINESCORE (Section 8.2 — LOCKED)
// ─────────────────────────────────────────────────────────────

function _renderLinescore(game, state, revealedPlays) {
  // Determine innings played
  const maxInning = Math.max(9, game.currentInning || 1);
  const innings   = Array.from({ length: maxInning }, (_, i) => i + 1);

  // Build per-inning run totals from revealed plays
  const awayRuns = {};  // inning → runs
  const homeRuns = {};
  const userIsHome = game.isHome;

  for (const play of revealedPlays) {
    if (!play._halfInning) continue;
    const [half, inning] = play._halfInning.split('_');
    const inn = parseInt(inning);
    if (!inn) continue;
    const runsOnPlay = (play.cumOurScore || 0) + (play.cumTheirScore || 0);
    // Simpler: just use the last play in each half-inning for the total
    if (half === 'TOP') {
      awayRuns[inn] = userIsHome ? (play.cumTheirScore || 0) : (play.cumOurScore || 0);
    } else {
      homeRuns[inn] = userIsHome ? (play.cumOurScore || 0) : (play.cumTheirScore || 0);
    }
  }

  const activeInning = game.currentInning || 1;
  const activeHalf   = game.currentHalf   || 'TOP';

  const inningCells = innings.map(inn => {
    const isActive = inn === activeInning;
    const awayVal  = awayRuns[inn] !== undefined ? awayRuns[inn] : null;
    const homeVal  = homeRuns[inn] !== undefined ? homeRuns[inn] : null;
    return `
      <th style="text-align:center;min-width:20px;color:var(--muted);font-size:11px;
        ${isActive ? 'color:var(--accent);' : ''}">${inn}</th>
    `;
  }).join('');

  const awayCells = innings.map(inn => {
    const val       = awayRuns[inn];
    const isActive  = inn === activeInning && activeHalf === 'TOP';
    const isPending = val === null && inn > activeInning;
    return `<td class="${isActive ? 'ls-active' : isPending ? 'ls-pending' : ''}" style="text-align:center;font-size:11px;padding:2px 4px;">
      ${isPending ? '·' : val ?? (isActive ? '—' : '·')}
    </td>`;
  }).join('');

  const homeCells = innings.map(inn => {
    const val       = homeRuns[inn];
    const isActive  = inn === activeInning && activeHalf === 'BOT';
    const isPending = val === null && (inn > activeInning || (inn === activeInning && activeHalf === 'TOP'));
    return `<td class="${isActive ? 'ls-active' : isPending ? 'ls-pending' : ''}" style="text-align:center;font-size:11px;padding:2px 4px;">
      ${isPending ? '·' : val ?? (isActive ? '—' : '·')}
    </td>`;
  }).join('');

  const awayName = userIsHome ? _escape(game.opponent || game.opp || 'Away') : (state.userTeam?.abbr || 'US');
  const homeName = userIsHome ? (state.userTeam?.abbr || 'US') : _escape(game.opponent || game.opp || 'Away');
  const awayTotal = game.theirScore ?? 0;
  const homeTotal = game.ourScore   ?? 0;

  return `
    <div class="linescore-live">
      <table>
        <thead>
          <tr>
            <th style="text-align:left;min-width:36px;"></th>
            ${inningCells}
            <th class="ls-total" style="text-align:center;min-width:20px;font-size:11px;color:var(--muted);border-left:1px solid var(--border);">R</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="ls-team" style="font-size:11px;font-weight:700;">${awayName}</td>
            ${awayCells}
            <td class="ls-run ls-total" style="border-left:1px solid var(--border);text-align:center;">${userIsHome ? awayTotal : homeTotal}</td>
          </tr>
          <tr>
            <td class="ls-team" style="font-size:11px;font-weight:700;color:var(--accent);">${homeName}</td>
            ${homeCells}
            <td class="ls-run ls-total" style="border-left:1px solid var(--border);text-align:center;">${userIsHome ? homeTotal : awayTotal}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// PLAY BY PLAY FEED
// ─────────────────────────────────────────────────────────────

function _renderPBP(revealedPlays) {
  if (revealedPlays.length === 0) {
    return '<div class="pbp-inning-label" style="text-align:center;">Waiting for first pitch…</div>';
  }

  // Group by half-inning
  const groups = {};
  for (const play of revealedPlays.slice(-MAX_PBP_DISPLAY)) {
    const key = play._halfInning || 'GAME';
    if (!groups[key]) groups[key] = [];
    groups[key].push(play);
  }

  return Object.entries(groups).reverse().map(([halfInning, plays]) => {
    const label = _halfInningLabel(halfInning);
    const rows  = plays.reverse().map(play => {
      const isHomer   = play.type === 'hr';
      const isMuted   = ['pitching_change','inning_end','game_end'].includes(play.type);
      const cls       = isHomer ? 'pbp-homer' : isMuted ? 'pbp-muted' : '';
      const icon      = _playIcon(play.type);
      return `
        <div class="pbp-play ${cls}">
          <div class="pbp-play-icon">${icon}</div>
          <div class="pbp-play-text">${_escape(play.description || play.text || '')}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="pbp-inning-label">${label}</div>
      ${rows}
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// BOX SCORE
// ─────────────────────────────────────────────────────────────

function _renderBoxScore(game, state, revealedPlays) {
  // Aggregate stat deltas from all revealed plays
  const playerStats = {};

  for (const play of revealedPlays) {
    const deltas = play._statDeltas || {};
    for (const [playerId, statChanges] of Object.entries(deltas)) {
      if (!playerStats[playerId]) playerStats[playerId] = {};
      for (const { stat, delta } of (statChanges || [])) {
        playerStats[playerId][stat] = (playerStats[playerId][stat] || 0) + delta;
      }
    }
  }

  const rosterIds = state.userTeam?.rosterIds || [];
  const players   = state.players || {};

  // Hitters
  const hitters = rosterIds
    .map(id => ({ id, player: players[id], stats: playerStats[id] || {} }))
    .filter(({ player }) => player && !['SP','RP'].includes(player.pos));

  const hitterRows = hitters.map(({ player, stats }) => `
    <tr>
      <td style="text-align:left;font-size:11px;padding:3px 8px;">${_escape(player.name.split(' ').pop())}</td>
      <td style="text-align:center;font-size:11px;">${stats.ab || 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.h  || 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.rbi|| 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.bb || 0}</td>
    </tr>
  `).join('');

  // Pitchers
  const pitchers = rosterIds
    .map(id => ({ id, player: players[id], stats: playerStats[id] || {} }))
    .filter(({ player, stats }) => player && ['SP','RP'].includes(player.pos) && (stats.ip || 0) > 0);

  const pitcherRows = pitchers.map(({ player, stats }) => `
    <tr>
      <td style="text-align:left;font-size:11px;padding:3px 8px;">${_escape(player.name.split(' ').pop())}</td>
      <td style="text-align:center;font-size:11px;">${(stats.ip || 0).toFixed(1)}</td>
      <td style="text-align:center;font-size:11px;">${stats.h  || 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.er || 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.k  || 0}</td>
      <td style="text-align:center;font-size:11px;">${stats.bb || 0}</td>
    </tr>
  `).join('');

  const thStyle = 'font-size:10px;font-weight:700;color:var(--muted);text-align:center;padding:4px 6px;letter-spacing:.5px;';

  return `
    <div style="margin-bottom:12px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
        color:var(--muted);padding:8px 8px 4px;">Batting</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${thStyle};text-align:left;">Player</th>
          <th style="${thStyle}">AB</th><th style="${thStyle}">H</th>
          <th style="${thStyle}">RBI</th><th style="${thStyle}">BB</th>
        </tr></thead>
        <tbody>${hitterRows || '<tr><td colspan="5" style="text-align:center;color:var(--muted);font-size:11px;padding:8px;">—</td></tr>'}</tbody>
      </table>
    </div>
    ${pitcherRows ? `
    <div>
      <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
        color:var(--muted);padding:8px 8px 4px;">Pitching</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${thStyle};text-align:left;">Pitcher</th>
          <th style="${thStyle}">IP</th><th style="${thStyle}">H</th>
          <th style="${thStyle}">ER</th><th style="${thStyle}">K</th>
          <th style="${thStyle}">BB</th>
        </tr></thead>
        <tbody>${pitcherRows}</tbody>
      </table>
    </div>` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────
// INCREMENTAL TICK UPDATE (Section 8.3)
// ─────────────────────────────────────────────────────────────

/**
 * _onTick(play, game)
 * Called on every game:tick event. Updates only what changed rather
 * than re-rendering the whole screen. Much cheaper than render().
 */
function _onTick(play, game) {
  if (!play || !game) return;

  // If not on live state, do a full render (status may have changed)
  if (game.status !== GAME_STATUS.LIVE && game.status !== GAME_STATUS.FINAL) {
    render();
    return;
  }

  // If game just became live, do a full render to switch display states
  const container = document.getElementById('live-game-container');
  if (!container?.querySelector('#live-game-wrap')) {
    render();
    return;
  }

  // Update score display
  _updateElement('live-score-user',  String(game.ourScore   ?? 0));
  _updateElement('live-score-opp',   String(game.theirScore ?? 0));
  _updateElement('live-inning',      _inningLabel(game));

  // Update outs indicator
  const outsEl = document.getElementById('outs-indicator');
  if (outsEl) outsEl.innerHTML = _renderOutsIndicator(game);

  // Update diamond via LiveDiamond component
  const diamondEl = document.getElementById('live-diamond-container');
  if (diamondEl) updateDiamond(diamondEl, game);

  // Append new play to PBP feed
  if (_activeTab === 'pbp') {
    _appendPlayToPBP(play);
  }

  // If this play ends a half-inning, update the linescore
  if (play.outsAfter === 3 || play.type === 'inning_end' || play.type === 'game_end') {
    _updateLinescore(game, StateManager.get());
  }
}

function _appendPlayToPBP(play) {
  const feed = document.getElementById('pbp-feed');
  if (!feed) return;

  const isHomer  = play.type === 'hr';
  const isMuted  = ['pitching_change','inning_end','game_end'].includes(play.type);
  const cls      = isHomer ? 'pbp-homer' : isMuted ? 'pbp-muted' : '';
  const icon     = _playIcon(play.type);

  const div = document.createElement('div');
  div.className = `pbp-play ${cls}`;
  div.innerHTML = `
    <div class="pbp-play-icon">${icon}</div>
    <div class="pbp-play-text">${_escape(play.description || play.text || '')}</div>
  `;

  // Insert inning label when half-inning changes
  const lastLabel = feed.querySelector('.pbp-inning-label');
  const newLabel  = _halfInningLabel(play._halfInning || '');
  if (!lastLabel || lastLabel.textContent !== newLabel) {
    const label = document.createElement('div');
    label.className = 'pbp-inning-label';
    label.textContent = newLabel;
    feed.insertBefore(label, feed.firstChild);
  }

  feed.insertBefore(div, feed.firstChild);

  // Trim feed to MAX_PBP_DISPLAY
  const plays = feed.querySelectorAll('.pbp-play');
  if (plays.length > MAX_PBP_DISPLAY) {
    plays[plays.length - 1].remove();
  }
}

function _updateLinescore(game, state) {
  const linescoreEl = document.querySelector('.linescore-live');
  if (!linescoreEl) return;
  const revealedPlays = _getRevealedPlays(game);
  linescoreEl.outerHTML = _renderLinescore(game, state, revealedPlays);
}

// ─────────────────────────────────────────────────────────────
// SCORE / INNING ROWS
// ─────────────────────────────────────────────────────────────

function _renderScoreRow(game, state, isHomeRow) {
  const userIsHome = game.isHome;
  const isUserRow  = userIsHome === isHomeRow;
  const name       = isUserRow
    ? (state.userTeam?.abbr || 'US')
    : _escape(game.opponent || game.opp || 'OPP');
  const score      = isUserRow
    ? (game.ourScore   ?? 0)
    : (game.theirScore ?? 0);
  const scoreId    = isUserRow ? 'live-score-user' : 'live-score-opp';

  return `
    <div class="live-team-row">
      <span class="live-team-name ${isUserRow ? 'our-team' : ''}">${name}</span>
      <span class="live-score-val" id="${scoreId}">${score}</span>
    </div>
  `;
}

function _renderOutsIndicator(game) {
  const outs = game.outs ?? 0;
  const dots = [0,1,2].map(i =>
    `<div style="width:10px;height:10px;border-radius:50%;border:2px solid var(--muted);
      background:${i < outs ? 'var(--danger)' : 'transparent'};"></div>`
  ).join('');
  return `<div id="outs-indicator" style="display:flex;gap:4px;align-items:center;">
    <span style="font-size:10px;color:var(--muted);font-weight:700;margin-right:4px;">OUT</span>
    ${dots}
  </div>`;
}

function _renderBasesIndicator(game) {
  const bases = game.bases || { first: null, second: null, third: null };
  const on    = (b) => b !== null && b !== undefined && b !== false;
  // Diamond: second top, third left, first right
  return `<div id="bases-indicator" style="position:relative;width:36px;height:36px;flex-shrink:0;">
    <!-- Second base (top) -->
    <div style="position:absolute;top:0;left:50%;transform:translateX(-50%) rotate(45deg);
      width:11px;height:11px;background:${on(bases.second) ? 'var(--accent)' : 'var(--surface2)'};
      border:2px solid var(--border);"></div>
    <!-- Third base (left) -->
    <div style="position:absolute;bottom:0;left:2px;transform:rotate(45deg);
      width:11px;height:11px;background:${on(bases.third) ? 'var(--accent)' : 'var(--surface2)'};
      border:2px solid var(--border);"></div>
    <!-- First base (right) -->
    <div style="position:absolute;bottom:0;right:2px;transform:rotate(45deg);
      width:11px;height:11px;background:${on(bases.first) ? 'var(--accent)' : 'var(--surface2)'};
      border:2px solid var(--border);"></div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(game, state) {
  const pbpTab = document.getElementById('live-tab-pbp');
  const boxTab = document.getElementById('live-tab-box');

  if (pbpTab) pbpTab.addEventListener('click', () => {
    _activeTab = 'pbp';
    render();
  });
  if (boxTab) boxTab.addEventListener('click', () => {
    _activeTab = 'box';
    render();
  });
}

// ─────────────────────────────────────────────────────────────
// COUNTDOWN REFRESH
// ─────────────────────────────────────────────────────────────

function _startCountdown(game) {
  _stopCountdown();
  _countdownTimer = setInterval(() => {
    const el = document.getElementById('fp-countdown');
    if (!el) { _stopCountdown(); return; }
    const now      = Date.now();
    const gameTime = game._scheduledMs || 0;
    const diffMs   = Math.max(0, gameTime - now);
    if (diffMs === 0) { el.textContent = 'LIVE'; _stopCountdown(); return; }
    const diffMins = Math.ceil(diffMs / 60000);
    const hours    = Math.floor(diffMins / 60);
    const mins     = diffMins % 60;
    el.textContent = hours > 0 ? `${hours}h ${mins}m` : `${diffMins}m`;

    // Update warm class
    const card = document.getElementById('fp-card');
    if (card) {
      card.className = 'fp-card' + (diffMins <= 30 ? ' fp-hot' : diffMins <= 90 ? ' fp-warm' : '');
    }
  }, 30000); // refresh every 30s — no need for per-second updates
}

function _stopCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _getCurrentGame(state) {
  const idx = state?.currentGameIndex ?? 0;
  return state?.schedule?.[idx] || null;
}

function _getRevealedPlays(game) {
  const plays     = game.plays || [];
  const revealIdx = game.livePlayIndex || 0;
  return plays.slice(0, revealIdx);
}

function _matchupLabel(game, state) {
  const userAbbr = state.userTeam?.abbr || 'US';
  const oppAbbr  = game.opponent || game.opp || 'OPP';
  return game.isHome ? `${oppAbbr} @ ${userAbbr}` : `${userAbbr} @ ${oppAbbr}`;
}

function _gameMetaLine(game, state) {
  const date = game.date ? game.date.slice(5).replace('-','/') : '';
  const loc  = game.isHome
    ? `${state.userTeam?.city || ''} · Home`
    : `@ ${game.opponent || ''}`;
  return `${date} · ${loc}`;
}

function _inningLabel(game) {
  const half   = game.currentHalf   || 'TOP';
  const inning = game.currentInning || 1;
  const arrow  = half === 'TOP' ? '▲' : '▼';
  return `${arrow} ${inning}`;
}

function _halfInningLabel(halfInning) {
  if (!halfInning) return '';
  const [half, inn] = halfInning.split('_');
  return half === 'TOP' ? `Top ${inn}` : `Bot ${inn}`;
}

function _countLabel(game) {
  if (!game.count) return '';
  const { balls = 0, strikes = 0 } = game.count;
  return `${balls}–${strikes}`;
}

function _playIcon(type) {
  const map = {
    hr:             '💥', single:   '•', double: '••', triple: '•••',
    walk:           '🚶', strikeout:'K', groundout:'⤵', flyout:'⤴',
    pitching_change:'🔄', inning_end:'',  game_end:'🏁', error:'❌',
    sb:             '➡️', cs:'⬅️',  hbp:'🩹',
  };
  return map[type] || '•';
}

function _scrollPBPToBottom() {
  setTimeout(() => {
    const feed = document.getElementById('pbp-feed');
    if (feed) feed.scrollTop = 0; // Feed is newest-first
  }, 50);
}

function _updateElement(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
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
export function injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    #live-game-container { padding: 0 0 16px; }
    .weather-warning-banner {
      background: rgba(249,115,22,.12); border-bottom: 1px solid rgba(249,115,22,.3);
      padding: 10px 16px; font-size: 13px; color: #f97316;
    }
    /* Rain overlay for DELAYED state */
    .rain-overlay {
      position: absolute; inset: 0; pointer-events: none; overflow: hidden; border-radius: 10px;
    }
    @keyframes rain { 0%{transform:translateY(-100%)} 100%{transform:translateY(200%)} }
    .rain-drop {
      position: absolute; width: 1px; background: rgba(100,160,255,.5);
      animation: rain linear infinite;
    }
  `;
  document.head.appendChild(style);
}

injectCSS();
