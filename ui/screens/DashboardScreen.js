/**
 * ui/screens/DashboardScreen.js
 * Main dashboard tab — rendered into #dashboard-content.
 *
 * Owns:
 *   - Win/loss/OVR stat grid
 *   - Morale, atmosphere, owner trust progress bars
 *   - Division standing pill
 *   - Next game preview card with first-pitch countdown
 *   - Live game view (transitions automatically at first pitch time)
 *   - Activity feed (recent transactions and events)
 *
 * Does NOT own:
 *   - Inbox cards (InboxScreen.js owns that)
 *   - Payroll bar (header owns that via App.updateHeader)
 *
 * Live mode rules (Section 2.1 — LOCKED):
 *   - There is NO advance button. No simulate option. No tap-to-start.
 *   - Between games: dashboard shows countdown to first pitch.
 *   - At first pitch time: game view transitions automatically (5-second tick).
 *   - Game plays out in real time, auto-commits when final play is revealed.
 *   - The only deliberate actions are inbox card decisions — never a dashboard button.
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getHotColdIndicator } from '../../engine/IMPEngine.js';
import {
  formatRecord, formatStreak, formatDate,
  formatPhaseLabel, formatMoney, formatOVR, formatGameLabel,
} from '../formatters.js';
import { renderRadarWidget } from '../components/RadarWidget.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted      = false;
// _advanceBusy removed — no advance button in live mode (Section 2.1)
let _listeners    = [];     // EventBus handlers to clean up on unmount

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

/**
 * mount()
 * Called once by App.js after the app shell is ready.
 * Renders initial content and registers EventBus listeners.
 */
export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  // Register tab reset — called each time user taps Dashboard
  App.registerTabReset('dashboard', refresh);

  // Listen for game events that need a dashboard refresh
  _listeners.push(EventBus.on('game:committed',    () => refresh()));
  _listeners.push(EventBus.on('game:phaseChanged', () => refresh()));
  _listeners.push(EventBus.on('roster:changed',    () => refresh()));
  _listeners.push(EventBus.on('app:ready',         () => refresh()));

  refresh();
}

/**
 * unmount()
 * Cleans up EventBus listeners. Called if the screen is ever torn down.
 */
export function unmount() {
  _listeners.forEach(([event, handler]) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

/**
 * refresh()
 * Re-renders the full dashboard from current state.
 * Called on tab activation, game commit, and phase changes.
 */
export function refresh() {
  const container = document.getElementById('dashboard-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state || !state.userTeam) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Loading…</div>';
    return;
  }

  container.innerHTML = _renderDashboard(state);
  _attachListeners(state);
}

function _renderDashboard(state) {
  const team       = state.userTeam;
  const wins       = team.wins   || 0;
  const losses     = team.losses || 0;
  const streak     = team.streak || 0;
  const morale     = team.morale     || 50;
  const atmosphere = team.atmosphere || 50;
  const ownerTrust = team.ownerTrust || 60;
  const phase      = state.phase;
  const gameIdx    = state.currentGameIndex || 0;

  // Roster OVR — average of active players
  const rosterOvr = _computeRosterOvr(state);

  // Division standing
  const divStanding = _getDivStanding(state);

  // Next game
  const nextGame    = _getNextGame(state);

  // Progress bar colors
  const moraleColor    = morale    < 40 ? 'pf-red' : morale    > 65 ? 'pf-green' : '';
  const atmosphereColor = atmosphere < 40 ? 'pf-red' : atmosphere > 65 ? 'pf-green' : '';
  const trustColor     = ownerTrust < 40 ? 'pf-red' : ownerTrust > 65 ? 'pf-green' : '';

  return `
    <div class="section-pad">

      <!-- Week banner: record + division position -->
      <div class="week-banner">
        <div>
          <div class="week-text">${formatRecord(wins, losses)}</div>
          <div class="week-sub">${formatPhaseLabel(phase)} · ${formatStreak(streak)}</div>
        </div>
        <div class="div-pos-block">
          <div class="div-pos-label">Div</div>
          <div class="div-pos-value">${divStanding}</div>
        </div>
      </div>

      <!-- Stat grid: W / L / OVR -->
      <div class="stat-grid">
        <div class="stat-card c-green" id="dash-wins-card">
          <div>
            <div class="stat-label">Wins</div>
            <div class="stat-value" id="stat-wins">${wins}</div>
          </div>
        </div>
        <div class="stat-card c-red" id="dash-losses-card">
          <div>
            <div class="stat-label">Losses</div>
            <div class="stat-value" id="stat-losses">${losses}</div>
          </div>
        </div>
        <div class="stat-card" id="dash-ovr-card">
          <div>
            <div class="stat-label">Rating</div>
            <div class="stat-value" id="stat-ovr">${formatOVR(rosterOvr)}</div>
          </div>
        </div>
      </div>

      <!-- Progress bars: morale / atmosphere / owner trust -->
      <div class="morale-section">
        <div class="morale-row">
          <span class="morale-label">Team Morale</span>
          <span class="morale-val" id="morale-val">${morale}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${moraleColor}" id="morale-bar" style="width:${morale}%"></div>
        </div>

        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Stadium Atmosphere</span>
          <span class="morale-val" id="atmo-val">${atmosphere}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${atmosphereColor}" id="atmo-bar" style="width:${atmosphere}%"></div>
        </div>

        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Owner Trust</span>
          <span class="morale-val" id="trust-val">${ownerTrust}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${trustColor}" id="trust-bar" style="width:${ownerTrust}%"></div>
        </div>
      </div>

    </div><!-- /section-pad -->

    <!-- Next game preview + first pitch countdown -->
    <!-- Section 2.1: No advance button. Game starts itself at first pitch time. -->
    <div class="advance-section">
      ${_renderNextGameCard(nextGame, state)}
      ${_renderFirstPitchCountdown(nextGame)}
    </div>

    <!-- Hot/cold indicators for top performers -->
    ${_renderHotColdStrip(state)}

    <!-- Activity feed -->
    ${_renderActivityFeed(state)}
  `;
}

// ─────────────────────────────────────────────────────────────
// NEXT GAME CARD + FIRST PITCH COUNTDOWN
// ─────────────────────────────────────────────────────────────

/**
 * _renderFirstPitchCountdown(nextGame)
 * Replaces the v1/classic-mode "advance button".
 * Live mode has no button — the game starts itself at first pitch time.
 * Shows a countdown pill that warms up as game time approaches.
 */
function _renderFirstPitchCountdown(nextGame) {
  if (!nextGame) return '';
  if (nextGame._committed) return '';

  const now       = Date.now();
  const gameTime  = nextGame._scheduledMs;

  if (!gameTime) return '';

  if (now >= gameTime) {
    // Game should be live — tick cycle handles the transition
    return `<div class="fp-card fp-hot" id="fp-card">
      <div class="fp-label">GAME IS LIVE</div>
      <div class="fp-time" id="fp-time">LIVE</div>
      <div class="fp-sub">Updates every 5 seconds</div>
    </div>`;
  }

  const diffMs   = gameTime - now;
  const diffMins = Math.ceil(diffMs / 60000);
  const hours    = Math.floor(diffMins / 60);
  const mins     = diffMins % 60;
  const timeStr  = hours > 0 ? `${hours}h ${mins}m` : `${diffMins}m`;

  const warmClass = diffMins <= 30 ? 'fp-hot' : diffMins <= 90 ? 'fp-warm' : '';

  return `<div class="fp-card ${warmClass}" id="fp-card">
    <div class="fp-label">First Pitch</div>
    <div class="fp-time" id="fp-time">${timeStr}</div>
    <div class="fp-sub">${diffMins <= 90 ? 'Warming up — check your inbox' : 'Check back closer to game time'}</div>
  </div>`;
}

function _renderNextGameCard(nextGame, state) {
  if (!nextGame) {
    return `<div class="next-game-card">
      <div class="ngc-info">
        <div class="ngc-opp" style="color:var(--muted)">Season complete</div>
      </div>
    </div>`;
  }

  const phase = state.phase;
  const date  = nextGame.date || '';
  const [, month, day] = (date || '').split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mo = months[parseInt(month)] || '';
  const dy = parseInt(day) || '';

  const locLabel  = nextGame.isHome
    ? `Home · ${state.userTeam.city || ''}`
    : `Away · ${nextGame.opponent || ''}`;

  const weatherEmoji = _weatherEmoji(nextGame.weatherCondition);

  // RADAR WIDGET — Phase 13 component pass ✓
  // Renders inline below the weather emoji when a weather buffer exists.

  const badgeLabel = _getGameBadgeLabel(nextGame, state);
  const badgeHtml  = badgeLabel
    ? `<span class="game-badge ${badgeLabel.cls}">${badgeLabel.text}</span>`
    : '';

  const radarHtml = state.weatherBuffer
    ? renderRadarWidget(state.weatherBuffer, nextGame?.status)
    : '';

  return `
    <div class="next-game-card">
      <div class="ngc-date">
        <div class="ngc-mo">${mo}</div>
        <div class="ngc-dy">${dy}</div>
      </div>
      <div class="ngc-info">
        <div class="ngc-opp">${formatGameLabel(nextGame)}${badgeHtml}</div>
        <div class="ngc-loc">${locLabel} ${weatherEmoji}</div>
      </div>
      <div class="ngc-badge" id="ngc-status">${_gameStatusBadge(nextGame, state)}</div>
    </div>
    ${radarHtml}
  `;
}

// _renderAdvanceButton removed — Section 2.1 (LOCKED)
// Live mode has no advance button. Games start themselves at first pitch time.
// The only phase-level transitions (offseason, playoffs) are handled by inbox cards.

// ─────────────────────────────────────────────────────────────
// HOT/COLD STRIP
// ─────────────────────────────────────────────────────────────

function _renderHotColdStrip(state) {
  const rosterIds  = state.userTeam?.rosterIds || [];
  const impScores  = state.impScores || {};

  const hotPlayers = rosterIds
    .map(id => ({ id, player: state.players[id], imp: impScores[id] }))
    .filter(({ player, imp }) =>
      player && !player.isInjured && imp?.imp7 !== null && imp?.imp7 !== undefined
    )
    .sort((a, b) => (b.imp?.imp7 || 0) - (a.imp?.imp7 || 0))
    .slice(0, 5);

  if (hotPlayers.length === 0) return '';

  const chips = hotPlayers.map(({ player, imp }) => {
    const indicator = getHotColdIndicator(imp);
    const imp7      = imp?.imp7;
    const sign      = imp7 > 0 ? '+' : '';
    const impText   = imp7 !== null && imp7 !== undefined
      ? `<span class="imp-score ${imp7 > 0 ? 'positive' : 'negative'}">${sign}${imp7.toFixed(1)}</span>`
      : '';
    return `
      <div class="hot-cold-chip">
        <span class="hot-cold-name">${player.name.split(' ')[1] || player.name}</span>
        <span class="hot-cold-pos">${player.pos}</span>
        ${indicator ? `<span class="imp-indicator">${indicator}</span>` : ''}
        ${impText}
      </div>
    `;
  }).join('');

  return `
    <div class="hot-cold-strip">
      <div class="hot-cold-label">FORM</div>
      <div class="hot-cold-chips">${chips}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED
// ─────────────────────────────────────────────────────────────

function _renderActivityFeed(state) {
  const feed = (state.activityFeed || []).slice(-8).reverse();
  if (feed.length === 0) return '';

  const entries = feed.map(entry => `
    <div class="activity-feed-entry">
      <div class="activity-feed-icon">${_activityIcon(entry.type)}</div>
      <div class="activity-feed-text">${_escape(entry.text || '')}</div>
      <div class="activity-feed-time">${_formatFeedTime(entry.gameIndex, state)}</div>
    </div>
  `).join('');

  return `
    <div style="margin-top:8px;">
      <div style="padding:12px 16px 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Recent</div>
      ${entries}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // No advance button in live mode — Section 2.1

  // Stat cards — tapping wins/losses opens the schedule
  const winsCard = document.getElementById('dash-wins-card');
  if (winsCard) winsCard.addEventListener('click', () => App.switchTab('schedule'));

  const lossesCard = document.getElementById('dash-losses-card');
  if (lossesCard) lossesCard.addEventListener('click', () => App.switchTab('schedule'));
}

// _handleAdvance removed — Section 2.1 (LOCKED)
// Games commit automatically when the final play is revealed by the tick cycle.
// Dashboard does not initiate game commits.

// ─────────────────────────────────────────────────────────────
// STATE HELPERS
// ─────────────────────────────────────────────────────────────

function _computeRosterOvr(state) {
  const rosterIds = state.userTeam?.rosterIds || [];
  if (rosterIds.length === 0) return 0;
  const active = rosterIds
    .map(id => state.players[id])
    .filter(p => p && !p.isInjured && p.group !== 'IL');
  if (active.length === 0) return 0;
  return Math.round(active.reduce((sum, p) => sum + (p.ovr || 0), 0) / active.length);
}

function _getDivStanding(state) {
  const standings = state.standings;
  if (!standings) return '–';
  const divKey = state.userTeam?.divisionId === 'B' ? 'B' : 'A';
  const div    = standings[divKey] || standings.divA || [];
  const idx    = div.findIndex(t => t.id === 'user');
  return idx >= 0 ? `${idx + 1}${_ordinal(idx + 1)}` : '–';
}

function _getNextGame(state) {
  const schedule = state.schedule || [];
  const gameIdx  = state.currentGameIndex || 0;
  return schedule[gameIdx] || null;
}

function _getGameBadgeLabel(game, state) {
  if (!game) return null;
  if (game.isMakeup)   return { text: 'MAKEUP',   cls: 'makeup' };
  if (game.isDoubleHeader) return { text: '2X',   cls: 'dh' };
  if (state.phase !== 'REGULAR_SEASON') return { text: 'PLAYOFF', cls: 'playoff' };
  return null;
}

function _gameStatusBadge(game, state) {
  if (!game) return '';
  if (game._committed) return 'FINAL';
  if (game.status === 'live') return 'LIVE';
  if (game.status === 'postponed') return 'PPD';
  if (game.status === 'delayed') return 'DELAY';
  // Time until first pitch
  const now  = Date.now();
  const gTime = game._scheduledMs;
  if (gTime && now < gTime) {
    const mins = Math.round((gTime - now) / 60000);
    if (mins > 120) return formatDate(game.date);
    if (mins > 0)   return `${mins}m`;
  }
  return 'PRE-GAME';
}

function _weatherEmoji(condition) {
  const map = {
    Clear: '☀️', Sunny: '☀️', Partly_Cloudy: '⛅', Cloudy: '☁️',
    Overcast: '☁️', Light_Rain: '🌦️', Rain: '🌧️', Heavy_Rain: '⛈️',
    Thunderstorm: '⛈️', Fog: '🌫️', Wind: '💨', Snow: '❄️',
    Hot: '🌡️', Cold: '🥶',
  };
  return map[condition] || '';
}

function _activityIcon(type) {
  const map = {
    trade: '🔄', injury: '🏥', promotion: '⬆️', demotion: '⬇️',
    signing: '✍️', release: '👋', milestone: '🏆', card: '📋',
    waiver: '📋', win: '✅', loss: '❌', weather: '⛈️',
  };
  return map[type] || '•';
}

function _formatFeedTime(gameIndex, state) {
  if (gameIndex === undefined) return '';
  const current = state.currentGameIndex || 0;
  const diff    = current - gameIndex;
  if (diff === 0) return 'Today';
  if (diff === 1) return '1g ago';
  return `${diff}g ago`;
}

function _ordinal(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
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
    /* Hot/cold strip */
    .hot-cold-strip{padding:8px 16px 4px;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow-x:auto;}
    .hot-cold-strip::-webkit-scrollbar{display:none;}
    .hot-cold-label{font-size:9px;font-weight:800;letter-spacing:2px;color:var(--muted);text-transform:uppercase;flex-shrink:0;}
    .hot-cold-chips{display:flex;gap:6px;overflow-x:auto;}
    .hot-cold-chip{display:flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);
      border-radius:20px;padding:4px 10px;white-space:nowrap;flex-shrink:0;}
    .hot-cold-name{font-size:11px;font-weight:600;color:var(--text);}
    .hot-cold-pos{font-size:9px;color:var(--muted);font-weight:600;}
    .imp-indicator{font-size:11px;}
  `;
  document.head.appendChild(style);
}
