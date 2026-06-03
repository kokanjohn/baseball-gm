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

  // Week banner text — v1 style
  const springGames       = (state.schedule || []).filter(g => g.isSpring);
  const springPlayed      = springGames.filter(g => g._committed).length;
  const springTotal       = springGames.length;
  const isSpring          = phase === 'SPRING_TRAINING';
  const gamesPlayed       = wins + losses;

  let bannerGame, bannerRecord;
  if (isSpring) {
    bannerGame   = springPlayed === 0 ? 'SPRING TRAINING' : `SPRING GAME ${springPlayed}`;
    bannerRecord = springPlayed === 0 ? 'First game coming up' : `${springPlayed} of ${springTotal}`;
  } else {
    bannerGame   = gamesPlayed === 0 ? 'OPENING DAY' : `GAME ${gamesPlayed}`;
    bannerRecord = `${wins}–${losses} · Season record`;
  }

  // OVR card color class
  const ovrClass = rosterOvr >= 70 ? 'c-green' : rosterOvr >= 55 ? 'c-accent' : 'c-red';

  return `
    <div class="section-pad">

      <!-- Week banner: game number + division position — v1 style -->
      <div class="week-banner">
        <div>
          <div class="week-text" id="banner-game">${bannerGame}</div>
          <div class="week-sub" id="banner-record">${bannerRecord}</div>
        </div>
        <div class="div-pos-block">
          <div class="div-pos-label">Division</div>
          <div class="div-pos-value" id="banner-divpos">${divStanding}</div>
        </div>
      </div>

      <!-- Stat grid: W / L / OVR — v1 centered card style -->
      <div class="stat-grid">
        <div class="stat-card c-green" id="dash-wins-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
          <div class="stat-label" style="text-align:center;">Wins</div>
          <div class="stat-value" id="stat-wins">${wins}</div>
        </div>
        <div class="stat-card c-red" id="dash-losses-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
          <div class="stat-label" style="text-align:center;">Losses</div>
          <div class="stat-value" id="stat-losses">${losses}</div>
        </div>
        <div class="stat-card ${ovrClass}" id="dash-ovr-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
          <div class="stat-label" style="text-align:center;">Rating</div>
          <div class="stat-value" id="stat-ovr">${formatOVR(rosterOvr)}</div>
        </div>
      </div>

      <!-- Progress bars: morale / atmosphere / owner trust -->
      <div class="morale-section">
        <div class="morale-row">
          <span class="morale-label">Team Morale</span>
          <span class="morale-val" id="morale-val">${morale}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="morale-bar" style="width:${morale}%;background:${_barColor(morale)};"></div>
        </div>

        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Stadium Atmosphere</span>
          <span class="morale-val" id="atmo-val">${atmosphere}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="atmo-bar" style="width:${atmosphere}%;background:${_barColor(atmosphere)};"></div>
        </div>

        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Owner Trust</span>
          <span class="morale-val" id="trust-val">${ownerTrust}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="trust-bar" style="width:${ownerTrust}%;background:${_barColor(ownerTrust)};"></div>
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

  const now      = Date.now();
  const gameTime = nextGame.gameTime;

  if (!gameTime) return '';

  if (now >= gameTime) {
    return `<div class="fp-card fp-hot" id="fp-card">
      <div class="fp-label">GAME IS LIVE</div>
      <div class="fp-time" id="fp-time">LIVE</div>
      <div class="fp-sub">Updates every 5 seconds</div>
    </div>`;
  }

  const diffMs   = gameTime - now;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60000);
  const hours    = Math.floor(diffMins / 60);
  const mins     = diffMins % 60;
  const secs     = diffSecs % 60;

  // v1 time string: seconds in final minute, h+m beyond that
  const timeStr = diffMs < 60000
    ? `${diffSecs}s`
    : hours > 0
    ? `${hours}h ${mins > 0 ? mins + 'm' : ''}`
    : `${diffMins}m`;

  const fpCls = diffMs < 60000 ? 'fp-hot' : diffMs < 300000 ? 'fp-warm' : '';

  // Haptic in final 60 seconds (navigator.vibrate is mobile-only, fails silently on desktop)
  if (diffMs < 60000 && typeof navigator !== 'undefined' && navigator.vibrate) {
    if (diffSecs <= 10)      navigator.vibrate([15, 8, 15]);
    else if (diffSecs <= 30) navigator.vibrate([12]);
    else                     navigator.vibrate([8]);
  }

  return `<div class="fp-card ${fpCls}" id="fp-card">
    <div class="fp-label">First Pitch</div>
    <div class="fp-time" id="fp-time">${timeStr}</div>
    <div class="fp-sub">${nextGame.isHome ? 'vs' : '@'} ${nextGame.opponent || ''}</div>
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

  // Last game badge — W/L result with score
  const lastGame = (state.currentGameIndex || 0) > 0
    ? state.schedule?.[(state.currentGameIndex || 0) - 1]
    : null;
  const lastWasSilent = lastGame?._silentlyCommitted;
  const lastBadge = lastGame?.score && !lastWasSilent
    ? `<div class="ngc-last ${lastGame.result || ''}">${lastGame.result === 'win' ? 'W' : 'L'} ${lastGame.score.us ?? lastGame.score.user ?? 0}–${lastGame.score.them ?? lastGame.score.opp ?? 0} <span style="font-weight:500;opacity:.7">vs ${lastGame.opponent || lastGame.opp || ''}</span></div>`
    : '';

  // Spring training badge
  const springBadge = nextGame.isSpring
    ? `<div style="margin-bottom:3px;"><span style="font-size:9px;font-weight:700;color:var(--accent);letter-spacing:.5px;text-transform:uppercase;background:var(--chip-accent-bg);padding:1px 5px;border-radius:4px;">Spring Training</span></div>`
    : '';

  // Game time — format Unix ms to 12h
  const gameTimeStr = nextGame.gameTime
    ? (() => {
        const d = new Date(nextGame.gameTime);
        const hh = d.getHours(), mm = d.getMinutes();
        const ampm = hh >= 12 ? 'PM' : 'AM';
        const h = hh % 12 || 12;
        return ` · <span style="font-weight:600;color:var(--soft)">${h}${mm > 0 ? ':' + String(mm).padStart(2,'0') : ''} ${ampm}</span>`;
      })()
    : '';

  const homeAwayLabel = nextGame.isHome ? 'Home' : 'Away';
  const locLabel = `${springBadge}<div>${homeAwayLabel}${gameTimeStr}</div>`;

  return `
    <div class="next-game-card">
      <div class="ngc-date">
        <div class="ngc-mo">${mo}</div>
        <div class="ngc-dy">${String(dy).padStart(2,'0')}</div>
      </div>
      <div class="ngc-info">
        <div class="ngc-opp">${nextGame.isHome ? 'vs' : '@'} ${nextGame.opponent || ''}</div>
        <div class="ngc-loc">${locLabel}</div>
        ${lastBadge}
      </div>
      <div class="ngc-right">
        <div class="ngc-badge" id="ngc-status">${_gameStatusBadge(nextGame, state)}</div>
      </div>
    </div>
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

  // Stat cards — tapping wins/losses opens a game result modal
  const winsCard = document.getElementById('dash-wins-card');
  if (winsCard) winsCard.addEventListener('click', () => _openGameLogModal(state, 'wins'));

  const lossesCard = document.getElementById('dash-losses-card');
  if (lossesCard) lossesCard.addEventListener('click', () => _openGameLogModal(state, 'losses'));
}

// ─────────────────────────────────────────────────────────────
// GAME LOG MODAL (W/L tap)
// ─────────────────────────────────────────────────────────────

function _openGameLogModal(state, filter) {
  document.getElementById('dash-game-log-overlay')?.remove();

  const schedule   = state.schedule || [];
  const committed  = schedule.filter(g => g._committed && (filter === 'wins' ? g.result === 'win' : g.result === 'loss'));
  const title      = filter === 'wins' ? `Wins (${committed.length})` : `Losses (${committed.length})`;

  const rows = committed.length === 0
    ? `<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;">No ${filter} yet this season.</div>`
    : committed.map(g => {
        const score = g.score ? `${g.score.us}–${g.score.them}` : '';
        const cls   = filter === 'wins' ? 'win' : 'loss';
        return `
          <div style="display:flex;align-items:center;gap:14px;padding:10px 20px;border-bottom:1px solid var(--border);">
            <div style="text-align:center;min-width:36px;">
              <div style="font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;">${g.mo || ''}</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;line-height:1;">${String(g.dy || g.index || '').padStart ? String(g.dy || '').padStart(2,'0') : ''}</div>
            </div>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:14px;">${g.home ? 'vs' : '@'} ${g.opponent || ''}</div>
              <div style="font-size:11px;color:var(--muted);">${g.home ? 'Home' : 'Away'}</div>
            </div>
            <div class="game-result ${cls}">${score}</div>
          </div>`;
      }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'dash-game-log-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:80dvh;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div style="font-size:18px;font-weight:800;color:var(--text);">${title}</div>
        <button class="modal-close" id="dash-log-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div style="overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));">${rows}</div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.getElementById('dash-log-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// _handleAdvance removed — Section 2.1 (LOCKED)
// Games commit automatically when the final play is revealed by the tick cycle.
// Dashboard does not initiate game commits.

// ─────────────────────────────────────────────────────────────
// STATE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _barColor(val)
 * Returns a CSS color string for progress bars based on value 0–100.
 * Matches v1 _barColor behavior exactly.
 */
function _barColor(val) {
  if (val >= 70) return '#22C55E';   // green  — always, never tracks team color
  if (val >= 50) return '#F5D253';   // amber/gold — always, never tracks --accent
  if (val >= 35) return '#f97316';   // orange
  return '#EF4444';                  // red
}

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
  const now   = Date.now();
  const gTime = game.gameTime;
  if (gTime && now < gTime) {
    const mins = Math.round((gTime - now) / 60000);
    const hrs  = Math.floor(mins / 60);
    const m    = mins % 60;
    if (hrs > 0) return `${hrs}h ${m}m`;
    if (mins > 0) return `${mins}m`;
  }
  // Fall back to date string (not PRE-GAME) when no real time is set
  if (game.date) {
    const parts = game.date.split('-');
    if (parts.length === 3) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2])}`;
    }
  }
  return 'Upcoming';
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
