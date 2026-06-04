/**
 * ui/screens/DashboardScreen.js
 * Main dashboard tab — rendered into #dashboard-content.
 *
 * Live game view rules (Section 2.1 — LOCKED):
 *   - No advance button. No simulate option. No tap-to-start.
 *   - Between games: countdown to first pitch.
 *   - At first pitch: game view appears automatically on next tick.
 *   - game:tick from App.js → _onTick() patches the live card in-place.
 *   - game:committed → full refresh.
 *
 * Data correctness rules (prevents the sync bugs seen in v1):
 *   - ALL live game state (score, linescore, outs, bases, PBP) is derived
 *     from a SINGLE call to _deriveGameState(game) which reads
 *     game.plays[0..livePlayIndex-1] in one pass.
 *   - Score always comes from the last revealed play's cumOurScore /
 *     cumTheirScore — never recomputed from rbi sums.
 *   - Linescore inning cells filled only once an inning_end play is revealed
 *     for that half. In-progress half shows '—'.
 *   - Outs and bases read from last revealed play's outsAfter / _basesAfter.
 *   - Box score accumulated only from revealed plays.
 *   - _onTick() patches the DOM directly — no full re-render on each tick.
 *     This avoids the v1 bug where scrolling the PBP was reset every 5s.
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
let _listeners    = [];       // { event, handler } pairs for cleanup
let _liveTab      = 'pbp';
let _firstPitchSounded  = false;
let _countdownInterval  = null; // 1-second interval for fp countdown display

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('dashboard', refresh);

  // Store as { event, handler } so unmount can remove them cleanly
  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('game:tick',         _onTick);
  wire('game:committed',    () => { _firstPitchSounded = false; _stopCountdown(); refresh(); });
  wire('game:phaseChanged', () => refresh());
  wire('roster:changed',    () => refresh());
  wire('app:ready',         () => refresh());

  refresh();
}

export function unmount() {
  _listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
  _listeners = [];
  _stopCountdown();
  _mounted = false;
}

// ─────────────────────────────────────────────────────────────
// COUNTDOWN INTERVAL — 1-second tick for smooth pre-game display
// ─────────────────────────────────────────────────────────────

function _startCountdown(gameTime) {
  _stopCountdown();
  _countdownInterval = setInterval(() => {
    const fpCard = document.getElementById('fp-card');
    const fpTime = document.getElementById('fp-time');
    if (!fpCard || !fpTime) { _stopCountdown(); return; }

    const now    = Date.now();
    const diffMs = gameTime - now;

    if (diffMs <= 0) {
      // First pitch reached — let the next app tick handle the transition
      _stopCountdown();
      fpCard.className = 'fp-card fp-hot';
      fpTime.textContent = 'LIVE';
      return;
    }

    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffMs / 60000);
    const hours    = Math.floor(diffMins / 60);
    const mins     = diffMins % 60;

    const timeStr = diffMs < 60000 ? `${diffSecs}s`
      : hours > 0 ? `${hours}h ${mins > 0 ? mins + 'm' : ''}`
      : `${diffMins}m`;

    fpTime.textContent = timeStr;

    // Update warmth class
    const cls = diffMs < 60000 ? 'fp-card fp-hot'
      : diffMs < 300000 ? 'fp-card fp-warm'
      : 'fp-card';
    if (fpCard.className !== cls) fpCard.className = cls;

    // Haptic in final 60 seconds
    if (diffMs < 60000) {
      if      (diffSecs <= 10) App.haptic([15, 8, 15]);
      else if (diffSecs <= 30) App.haptic([12]);
      else                     App.haptic([8]);
    }
  }, 1000);
}

function _stopCountdown() {
  if (_countdownInterval !== null) {
    clearInterval(_countdownInterval);
    _countdownInterval = null;
  }
}

// ─────────────────────────────────────────────────────────────
// REFRESH — full render
// ─────────────────────────────────────────────────────────────

export function refresh() {
  const container = document.getElementById('dashboard-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state || !state.userTeam) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Loading…</div>';
    return;
  }

  _liveTab = 'pbp';
  _stopCountdown();
  container.innerHTML = _renderDashboard(state);
  _attachListeners(state);

  // Start 1-second countdown if pre-game and gameTime is set
  const game = _getNextGame(state);
  if (game && !game._committed && game.gameTime && Date.now() < game.gameTime
      && !(game.plays && game.plays.length > 0 && (game.livePlayIndex || 0) > 0)) {
    _startCountdown(game.gameTime);
  }
}

// ─────────────────────────────────────────────────────────────
// TICK HANDLER — patches live card only, no full re-render
// ─────────────────────────────────────────────────────────────

function _onTick({ play, game } = {}) {
  if (!game) return;

  const liveWrap = document.getElementById('live-game-wrap');

  // Pre-game: live card not showing yet.
  // Only do a full refresh if the game has actually gone live
  // (plays exist and livePlayIndex > 0). Otherwise let the
  // 1-second countdown interval handle the display update.
  if (!liveWrap) {
    const isNowLive = game.plays
      && game.plays.length > 0
      && (game.livePlayIndex || 0) > 0
      && game.status !== 'SCHEDULED'
      && game.status !== 'PRE_GAME_WATCH';

    if (isNowLive) {
      _stopCountdown();
      refresh();
    }
    return;
  }

  const ds = _deriveGameState(game);

  // Score
  const awayScoreEl = document.getElementById('lgv-away-score');
  const homeScoreEl = document.getElementById('lgv-home-score');
  if (awayScoreEl) awayScoreEl.textContent = ds.awayScore;
  if (homeScoreEl) homeScoreEl.textContent = ds.homeScore;

  // Inning / outs text
  const innEl  = document.getElementById('lgv-inning');
  const outsEl = document.getElementById('lgv-outs');
  if (innEl)  innEl.textContent  = ds.innLabel;
  if (outsEl) outsEl.textContent = ds.outsLabel;

  // Status pill
  const pillEl = document.getElementById('lgv-status-pill');
  if (pillEl) {
    pillEl.textContent = ds.statusLabel;
    pillEl.className   = `lgv-status-pill ${ds.statusCls}`;
  }

  // Linescore — full replace (small table, cheap)
  const lsEl = document.getElementById('lgv-linescore');
  if (lsEl) lsEl.innerHTML = _renderLinescore(ds);

  // Diamond — replace SVG in-place
  const svgWrap = document.getElementById('lgv-diamond-wrap');
  if (svgWrap) svgWrap.innerHTML = _renderDiamond(ds.bases);

  // Outs dots
  const outsRow = document.getElementById('lgv-outs-row');
  if (outsRow) outsRow.innerHTML = _renderOutDots(ds.outs);

  // PBP — prepend new play (don't rebuild the whole feed)
  if (play && play.type !== 'inning_end' && play.type !== 'game_end'
      && play.type !== 'pitching_change') {
    _prependPBPPlay(play);
  } else if (play && play.type === 'inning_end') {
    _prependPBPInningHeader(play);
  }

  // Box score — only rebuild if tab is active
  if (_liveTab === 'box') {
    const boxEl = document.getElementById('lgv-box');
    if (boxEl) boxEl.innerHTML = _renderBoxScore(ds);
  }

  // First pitch sound (on first revealed play)
  if (!_firstPitchSounded && ds.revealedCount === 1) {
    _firstPitchSounded = true;
    App.playSoundFirstPitch();
  }

  // Win/loss sound on game_end play
  if (play?.type === 'game_end') {
    if (ds.ourScore > ds.theirScore) App.playSoundWin();
    else                              App.playSoundLoss();
  }
}

// ─────────────────────────────────────────────────────────────
// MASTER DERIVE — single pass over revealed plays
// EVERYTHING the UI needs from one consistent snapshot.
// This is the fix for v1's sync problems.
// ─────────────────────────────────────────────────────────────

function _deriveGameState(game) {
  const plays         = game.plays        || [];
  const liveIdx       = game.livePlayIndex || 0;
  const revealedPlays = plays.slice(0, liveIdx);
  const isHome        = !!game.isHome;

  // ── Score: always from last play with cum fields ─────────────
  let ourScore = 0, theirScore = 0;
  for (let i = revealedPlays.length - 1; i >= 0; i--) {
    const p = revealedPlays[i];
    if (p.cumOurScore !== undefined && p.cumOurScore !== null) {
      ourScore   = p.cumOurScore;
      theirScore = p.cumTheirScore;
      break;
    }
  }
  const awayScore = isHome ? theirScore : ourScore;
  const homeScore = isHome ? ourScore   : theirScore;

  // ── Outs: from last play with outsAfter ──────────────────────
  let outs = 0;
  for (let i = revealedPlays.length - 1; i >= 0; i--) {
    if (revealedPlays[i].outsAfter !== undefined) { outs = revealedPlays[i].outsAfter; break; }
  }

  // ── Bases: from last play with _basesAfter ───────────────────
  let bases = { first: null, second: null, third: null };
  for (let i = revealedPlays.length - 1; i >= 0; i--) {
    if (revealedPlays[i]._basesAfter) { bases = revealedPlays[i]._basesAfter; break; }
  }

  // ── Current inning/half ──────────────────────────────────────
  let curInning = 1, curHalf = 'TOP';
  for (let i = revealedPlays.length - 1; i >= 0; i--) {
    const p = revealedPlays[i];
    if (p.inning && p.half && p.type !== 'game_end') {
      curInning = p.inning;
      curHalf   = p.half;
      break;
    }
  }

  // ── Linescore: runs per half, sealed by inning_end ───────────
  // A cell is only shown as a number once its inning_end is revealed.
  const completedHalves = new Set();
  const runsByHalf = {};
  for (const p of revealedPlays) {
    const key = `${p.half}_${p.inning}`;
    if (p.type === 'inning_end') {
      completedHalves.add(key);
    } else if (p.type !== 'game_end' && p.type !== 'pitching_change' && (p.rbi || 0) > 0) {
      runsByHalf[key] = (runsByHalf[key] || 0) + p.rbi;
    }
  }
  const maxInning = Math.max(9, curInning);
  const awayRunsByInn = [];
  const homeRunsByInn = [];
  for (let inn = 1; inn <= maxInning; inn++) {
    const topKey = `TOP_${inn}`;
    const botKey = `BOT_${inn}`;
    awayRunsByInn.push(completedHalves.has(topKey) ? (runsByHalf[topKey] || 0) : null);
    homeRunsByInn.push(completedHalves.has(botKey)  ? (runsByHalf[botKey]  || 0) : null);
  }

  // ── Status ────────────────────────────────────────────────────
  const isFinal = game.status === 'FINAL' || game._committed
    || revealedPlays.some(p => p.type === 'game_end');

  const innSuffix = ['st','nd','rd'][curInning - 1] || 'th';
  const halfSym   = curHalf === 'TOP' ? '▲' : '▼';
  const innLabel  = isFinal ? 'FINAL' : `${halfSym} ${curInning}${innSuffix}`;
  const outsLabel = isFinal ? '—' : `${outs} OUT${outs !== 1 ? 'S' : ''}`;

  const statusLabel = isFinal           ? 'FINAL'
    : game.status === 'DELAYED'         ? '⚠ DELAY'
    : liveIdx > 0                       ? '● LIVE'
    : 'PRE-GAME';
  const statusCls = isFinal              ? 'lgv-final'
    : game.status === 'DELAYED'         ? 'lgv-delay'
    : liveIdx > 0                       ? 'lgv-active'
    : '';

  // ── PBP: revealed plays, newest first, excluding housekeeping ─
  const pbpPlays = revealedPlays
    .filter(p => p.type !== 'game_end' && p.type !== 'inning_end')
    .slice()
    .reverse();

  // ── Box score: accumulated from revealed plays only ───────────
  const battersBox  = {};
  const pitchersBox = {};
  for (const p of revealedPlays) {
    if (p.type === 'inning_end' || p.type === 'game_end' || p.type === 'pitching_change') continue;
    if (p.batterId) {
      const hb = battersBox[p.batterId] || (battersBox[p.batterId] = { ab:0, h:0, hr:0, rbi:0, r:0, bb:0, k:0 });
      if (!['walk','hbp'].includes(p.type)) hb.ab++;
      if (['single','double','triple','hr'].includes(p.type)) hb.h++;
      if (p.type === 'hr') hb.hr++;
      if (p.type === 'walk' || p.type === 'hbp') hb.bb++;
      if (p.type === 'strikeout') hb.k++;
      hb.rbi += (p.rbi || 0);
    }
    if (p.pitcherId) {
      const pb = pitchersBox[p.pitcherId] || (pitchersBox[p.pitcherId] = { outs:0, h:0, er:0, bb:0, k:0, hr:0 });
      if (['groundout','flyout','strikeout'].includes(p.type)) pb.outs++;
      if (['single','double','triple','hr'].includes(p.type)) pb.h++;
      if (p.type === 'hr') pb.hr++;
      if (p.type === 'walk' || p.type === 'hbp') pb.bb++;
      if (p.type === 'strikeout') pb.k++;
      pb.er += (p.rbi || 0);
    }
  }

  return {
    ourScore, theirScore, awayScore, homeScore,
    outs, bases,
    curInning, curHalf,
    isFinal, innLabel, outsLabel,
    statusLabel, statusCls,
    awayRunsByInn, homeRunsByInn, maxInning,
    completedHalves, runsByHalf,
    pbpPlays,
    battersBox, pitchersBox,
    revealedCount: revealedPlays.length,
    isHome,
  };
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD RENDER
// ─────────────────────────────────────────────────────────────

function _renderDashboard(state) {
  const team       = state.userTeam;
  const wins       = team.wins       || 0;
  const losses     = team.losses     || 0;
  const morale     = team.morale     || 50;
  const atmosphere = team.atmosphere || 50;
  const ownerTrust = team.ownerTrust || 60;
  const phase      = state.phase;

  const rosterOvr   = _computeRosterOvr(state);
  const divStanding = _getDivStanding(state);
  const nextGame    = _getNextGame(state);

  const springGames  = (state.schedule || []).filter(g => g.isSpring);
  const springPlayed = springGames.filter(g => g._committed).length;
  const springTotal  = springGames.length;
  const isSpring     = phase === 'SPRING_TRAINING';
  const gamesPlayed  = wins + losses;

  let bannerGame, bannerRecord;
  if (isSpring) {
    bannerGame   = springPlayed === 0 ? 'SPRING TRAINING' : `SPRING GAME ${springPlayed}`;
    bannerRecord = springPlayed === 0 ? 'First game coming up' : `${springPlayed} of ${springTotal}`;
  } else {
    bannerGame   = gamesPlayed === 0 ? 'OPENING DAY' : `GAME ${gamesPlayed}`;
    bannerRecord = `${wins}–${losses} · Season record`;
  }

  const ovrClass = rosterOvr >= 70 ? 'c-green' : rosterOvr >= 55 ? 'c-accent' : 'c-red';

  return `
    <div class="section-pad">
      <div class="week-banner">
        <div>
          <div class="week-text">${bannerGame}</div>
          <div class="week-sub">${bannerRecord}</div>
        </div>
        <div class="div-pos-block">
          <div class="div-pos-label">Division</div>
          <div class="div-pos-value">${divStanding}</div>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card c-green" id="dash-wins-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
          <div class="stat-label" style="text-align:center;">Wins</div>
          <div class="stat-value">${wins}</div>
        </div>
        <div class="stat-card c-red" id="dash-losses-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
          <div class="stat-label" style="text-align:center;">Losses</div>
          <div class="stat-value">${losses}</div>
        </div>
        <div class="stat-card ${ovrClass}"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;">
          <div class="stat-label" style="text-align:center;">Rating</div>
          <div class="stat-value">${formatOVR(rosterOvr)}</div>
        </div>
      </div>

      <div class="morale-section">
        <div class="morale-row">
          <span class="morale-label">Team Morale</span>
          <span class="morale-val">${morale}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${morale}%;background:${_barColor(morale)};"></div>
        </div>
        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Stadium Atmosphere</span>
          <span class="morale-val">${atmosphere}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${atmosphere}%;background:${_barColor(atmosphere)};"></div>
        </div>
        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Owner Trust</span>
          <span class="morale-val">${ownerTrust}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${ownerTrust}%;background:${_barColor(ownerTrust)};"></div>
        </div>
      </div>
    </div>

    <div class="advance-section">
      ${_renderGameArea(nextGame, state)}
    </div>

    ${_renderHotColdStrip(state)}
    ${_renderActivityFeed(state)}
  `;
}

// ─────────────────────────────────────────────────────────────
// GAME AREA
// ─────────────────────────────────────────────────────────────

function _renderGameArea(game, state) {
  if (!game) return _renderSeasonDoneCard(state);

  const isLive = game.plays
    && game.plays.length > 0
    && !game._committed
    && game.status !== 'SCHEDULED'
    && game.status !== 'PRE_GAME_WATCH'
    && game.status !== 'POSTPONED';

  if (isLive) return _renderLiveGameCard(game, state);

  if (game._committed) {
    const nextIdx  = state.currentGameIndex || 0;
    const nextGame = state.schedule?.[nextIdx] || null;
    if (!nextGame) return _renderSeasonDoneCard(state);
    return _renderNextGameCard(nextGame, state) + _renderFirstPitchCountdown(nextGame);
  }

  return _renderNextGameCard(game, state) + _renderFirstPitchCountdown(game);
}

// ─────────────────────────────────────────────────────────────
// LIVE GAME CARD
// ─────────────────────────────────────────────────────────────

function _renderLiveGameCard(game, state) {
  const ds       = _deriveGameState(game);
  const userAbbr = (state.userTeam?.abbr || state.userTeam?.nickname?.substring(0,3) || 'US').toUpperCase();
  const opp      = game.opponent || '';
  const oppAbbr  = opp.split(' ').pop().substring(0,3).toUpperCase() || 'OPP';

  const awayLabel  = game.isHome ? oppAbbr  : userAbbr;
  const homeLabel  = game.isHome ? userAbbr : oppAbbr;
  const awayIsUser = !game.isHome;
  const homeIsUser =  game.isHome;

  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div class="live-score-header">
        <div class="live-teams">
          <div class="live-team-row">
            <span class="live-team-name${awayIsUser ? ' our-team' : ''}">${_escape(awayLabel)}</span>
            <span class="live-score-val" id="lgv-away-score">${ds.awayScore}</span>
          </div>
          <div class="live-team-row">
            <span class="live-team-name${homeIsUser ? ' our-team' : ''}">${_escape(homeLabel)}</span>
            <span class="live-score-val" id="lgv-home-score">${ds.homeScore}</span>
          </div>
        </div>
        <div class="lgv-diamond-col">
          <div id="lgv-diamond-wrap">${_renderDiamond(ds.bases)}</div>
          <div class="lgv-outs-row" id="lgv-outs-row">${_renderOutDots(ds.outs)}</div>
        </div>
        <div class="live-meta">
          <span class="live-inning" id="lgv-inning">${ds.innLabel}</span>
          <span class="lgv-outs-label" id="lgv-outs">${ds.outsLabel}</span>
          <span class="lgv-status-pill ${ds.statusCls}" id="lgv-status-pill">${ds.statusLabel}</span>
        </div>
      </div>

      <div class="lgv-linescore-wrap" id="lgv-linescore">
        ${_renderLinescore(ds)}
      </div>

      <div class="live-tabs">
        <div class="live-tab${_liveTab === 'pbp' ? ' active' : ''}" data-tab="pbp">Play by Play</div>
        <div class="live-tab${_liveTab === 'box' ? ' active' : ''}" data-tab="box">Stats</div>
      </div>
      <div class="live-tab-content${_liveTab === 'pbp' ? ' active' : ''}" id="lgv-tc-pbp">
        <div class="pbp-feed" id="lgv-pbp-feed">
          ${_renderPBPFeed(ds)}
        </div>
      </div>
      <div class="live-tab-content${_liveTab === 'box' ? ' active' : ''}" id="lgv-tc-box">
        <div id="lgv-box">${_renderBoxScore(ds)}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// LINESCORE
// ─────────────────────────────────────────────────────────────

function _renderLinescore(ds) {
  const { awayRunsByInn, homeRunsByInn, maxInning,
    awayScore, homeScore, curInning, curHalf, isFinal, isHome } = ds;

  const inns    = Array.from({ length: maxInning }, (_, i) => i + 1);
  const headers = inns.map(inn => {
    const active = !isFinal && inn === curInning;
    return `<th class="ls-inn-head${active ? ' ls-active-head' : ''}">${inn}</th>`;
  }).join('');

  const awayRow = inns.map((inn, i) => {
    const val    = awayRunsByInn[i];
    const active = !isFinal && inn === curInning && curHalf === 'TOP';
    if (active && val === null) return `<td class="ls-cell ls-active-cell">—</td>`;
    if (val === null) return `<td class="ls-cell" style="opacity:.3">·</td>`;
    return `<td class="ls-cell${val > 0 ? ' ls-scoring' : ''}">${val}</td>`;
  }).join('');

  const homeRow = inns.map((inn, i) => {
    const val    = homeRunsByInn[i];
    const active = !isFinal && inn === curInning && curHalf === 'BOT';
    if (active && val === null) return `<td class="ls-cell ls-active-cell">—</td>`;
    if (val === null) return `<td class="ls-cell" style="opacity:.3">·</td>`;
    return `<td class="ls-cell${val > 0 ? ' ls-scoring' : ''}">${val}</td>`;
  }).join('');

  const awayUserCls = !isHome ? ' ls-team-user' : '';
  const homeUserCls =  isHome ? ' ls-team-user' : '';

  return `
    <div class="linescore-live">
      <table>
        <thead><tr>
          <th class="ls-team-head"></th>
          ${headers}
          <th class="ls-total-head">R</th>
        </tr></thead>
        <tbody>
          <tr>
            <td class="ls-team${awayUserCls}">${!isHome ? 'US' : 'OPP'}</td>
            ${awayRow}
            <td class="ls-total${awayScore > homeScore && isFinal ? ' ls-winner' : ''}">${awayScore}</td>
          </tr>
          <tr>
            <td class="ls-team${homeUserCls}">${isHome ? 'US' : 'OPP'}</td>
            ${homeRow}
            <td class="ls-total${homeScore > awayScore && isFinal ? ' ls-winner' : ''}">${homeScore}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// DIAMOND + OUTS
// ─────────────────────────────────────────────────────────────

function _renderDiamond(bases) {
  const on   = b => b !== null && b !== undefined;
  const fill = b => on(b) ? 'var(--accent)' : 'transparent';
  return `
    <svg viewBox="0 0 44 38" width="36" height="31"
      style="flex-shrink:0;display:block;overflow:visible;">
      <rect x="17" y="3" width="10" height="10" rx="1"
        fill="${fill(bases?.second)}" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"
        transform="rotate(45,22,8)"/>
      <rect x="30" y="16" width="10" height="10" rx="1"
        fill="${fill(bases?.first)}" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"
        transform="rotate(45,35,21)"/>
      <rect x="4" y="16" width="10" height="10" rx="1"
        fill="${fill(bases?.third)}" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"
        transform="rotate(45,9,21)"/>
    </svg>`;
}

function _renderOutDots(outs) {
  return [0,1,2].map(i =>
    `<div class="lgv-out-dot${i < outs ? ' active' : ''}"></div>`
  ).join('');
}

// ─────────────────────────────────────────────────────────────
// PBP FEED
// ─────────────────────────────────────────────────────────────

const _PBP_ICONS = {
  hr:'💥', triple:'⚡', double:'◉', single:'●',
  walk:'○', hbp:'⚠', strikeout:'✕',
  groundout:'▲', flyout:'▲', pitching_change:'🔄',
};

function _pbpPlayHtml(play) {
  const icon = _PBP_ICONS[play.type] || '·';
  const cls  = play.type === 'hr'     ? 'pbp-play pbp-homer'
             : ['single','double','triple'].includes(play.type) ? 'pbp-play pbp-hit'
             : play.type === 'pitching_change' ? 'pbp-play pbp-pitching'
             : 'pbp-play';
  return `<div class="${cls}" data-play-idx="${play.playIndex}">
    <div class="pbp-play-icon">${icon}</div>
    <div class="pbp-play-text">${_escape(play.description || '')}</div>
  </div>`;
}

function _renderPBPFeed(ds) {
  if (ds.pbpPlays.length === 0) {
    return `<div class="pbp-empty">Game in progress…</div>`;
  }
  const lines = [];
  let lastKey = null;
  for (const play of ds.pbpPlays) {
    const key = `${play.half}_${play.inning}`;
    if (key !== lastKey) {
      const hw  = play.half === 'TOP' ? '▲ TOP' : '▼ BOT';
      const sfx = ['st','nd','rd'][play.inning - 1] || 'th';
      lines.push(`<div class="pbp-inning-label" data-inn="${key}">${hw} ${play.inning}${sfx}</div>`);
      lastKey = key;
    }
    lines.push(_pbpPlayHtml(play));
  }
  return lines.join('');
}

function _prependPBPPlay(play) {
  const feed = document.getElementById('lgv-pbp-feed');
  if (!feed) return;
  feed.querySelector('.pbp-empty')?.remove();

  const key = `${play.half}_${play.inning}`;
  const existingHeader = feed.querySelector(`.pbp-inning-label[data-inn="${key}"]`);
  const el = document.createElement('div');
  el.innerHTML = _pbpPlayHtml(play);
  const node = el.firstElementChild;

  if (existingHeader) {
    existingHeader.insertAdjacentElement('afterend', node);
  } else {
    const hw  = play.half === 'TOP' ? '▲ TOP' : '▼ BOT';
    const sfx = ['st','nd','rd'][play.inning - 1] || 'th';
    const hdr = document.createElement('div');
    hdr.className    = 'pbp-inning-label';
    hdr.dataset.inn  = key;
    hdr.textContent  = `${hw} ${play.inning}${sfx}`;
    feed.prepend(node);
    feed.prepend(hdr);
  }
}

function _prependPBPInningHeader(play) {
  // inning_end plays don't go in the PBP feed — linescore handles the visual
}

// ─────────────────────────────────────────────────────────────
// BOX SCORE
// ─────────────────────────────────────────────────────────────

function _renderBoxScore(ds) {
  const state   = StateManager.get();
  const players = state?.players || {};
  const _ip     = outs => `${Math.floor(outs/3)}.${outs%3}`;
  const _avg    = (h,ab) => ab > 0 ? (h/ab).toFixed(3).replace('0.','.') : '—';
  const _era    = (er,outs) => outs > 0 ? ((er/(outs/3))*9).toFixed(2) : '—';
  const _ln     = p => p?.name?.split(' ').pop() || '?';

  const batEntries = Object.entries(ds.battersBox)
    .map(([id,s]) => ({ id, p: players[id], s }))
    .filter(e => e.p);

  const pitEntries = Object.entries(ds.pitchersBox)
    .map(([id,s]) => ({ id, p: players[id], s }))
    .filter(e => e.p);

  if (!batEntries.length && !pitEntries.length) {
    return '<div style="padding:16px;color:var(--muted);font-size:12px;">Stats appear as plays are revealed.</div>';
  }

  const batRows = batEntries.map(({p,s}) => `
    <tr>
      <td class="bs-name">${_escape(_ln(p))}</td>
      <td>${s.h}/${s.ab}</td>
      <td>${s.r}</td>
      <td>${s.rbi}</td>
      <td>${s.bb}</td>
      <td>${s.k}</td>
      <td class="${s.h > 0 ? 'bs-hi' : ''}">${_avg(s.h,s.ab)}</td>
    </tr>`).join('');

  const pitRows = pitEntries.map(({p,s}) => `
    <tr>
      <td class="bs-name">${_escape(_ln(p))}</td>
      <td>${_ip(s.outs)}</td>
      <td>${s.h}</td>
      <td>${s.er}</td>
      <td>${s.k}</td>
      <td class="${parseFloat(_era(s.er,s.outs)) < 3.5 ? 'bs-avg' : ''}">${_era(s.er,s.outs)}</td>
    </tr>`).join('');

  return `
    <div class="live-box-wrap">
      <div class="bs-section-label">Batting</div>
      <div class="bs-table-wrap">
        <table class="bs-table">
          <tr><th>Player</th><th>H/AB</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr>
          ${batRows || '<tr><td colspan="7" style="color:var(--muted)">In progress…</td></tr>'}
        </table>
      </div>
      <div class="bs-section-label" style="margin-top:10px">Pitching</div>
      <div class="bs-table-wrap">
        <table class="bs-table">
          <tr><th>Pitcher</th><th>IP</th><th>H</th><th>ER</th><th>K</th><th>ERA</th></tr>
          ${pitRows || '<tr><td colspan="6" style="color:var(--muted)">In progress…</td></tr>'}
        </table>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// NEXT GAME CARD
// ─────────────────────────────────────────────────────────────

function _renderNextGameCard(game, state) {
  const [, month, day] = (game.date || '').split('-');
  const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mo = MONTHS[parseInt(month)] || '';
  const dy = parseInt(day) || '';

  const lastGame = (state.currentGameIndex || 0) > 0
    ? state.schedule?.[(state.currentGameIndex || 0) - 1]
    : null;
  const lastBadge = lastGame?.score && !lastGame?._silentlyCommitted
    ? `<div class="ngc-last ${lastGame.result || ''}">
        ${lastGame.result === 'win' ? 'W' : 'L'}
        ${lastGame.score.us ?? lastGame.score.user ?? 0}–${lastGame.score.them ?? lastGame.score.opp ?? 0}
        <span style="font-weight:500;opacity:.7">vs ${_escape(lastGame.opponent || lastGame.opp || '')}</span>
       </div>`
    : '';

  const springBadge = game.isSpring
    ? `<span style="font-size:9px;font-weight:700;color:var(--accent);letter-spacing:.5px;text-transform:uppercase;background:var(--chip-accent-bg);padding:1px 5px;border-radius:4px;display:inline-block;margin-bottom:3px;">Spring Training</span><br>`
    : '';

  const gameTimeStr = game.gameTime
    ? (() => {
        const d = new Date(game.gameTime);
        const hh = d.getHours(), mm = d.getMinutes();
        const ampm = hh >= 12 ? 'PM' : 'AM';
        const h = hh % 12 || 12;
        return ` · <span style="font-weight:600;color:var(--soft)">${h}${mm > 0 ? ':' + String(mm).padStart(2,'0') : ''} ${ampm}</span>`;
      })()
    : '';

  return `
    <div class="next-game-card">
      <div class="ngc-date">
        <div class="ngc-mo">${mo}</div>
        <div class="ngc-dy">${String(dy).padStart(2,'0')}</div>
      </div>
      <div class="ngc-info">
        <div class="ngc-opp">${game.isHome ? 'vs' : '@'} ${_escape(game.opponent || '')}</div>
        <div class="ngc-loc">${springBadge}${game.isHome ? 'Home' : 'Away'}${gameTimeStr}</div>
        ${lastBadge}
      </div>
      <div class="ngc-right"></div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// FIRST PITCH COUNTDOWN
// ─────────────────────────────────────────────────────────────

function _renderFirstPitchCountdown(game) {
  if (!game || game._committed) return '';
  const now      = Date.now();
  const gameTime = game.gameTime;
  if (!gameTime) return '';

  if (now >= gameTime) {
    return `<div class="fp-card fp-hot" id="fp-card">
      <div class="fp-label">GAME IS LIVE</div>
      <div class="fp-time">LIVE</div>
      <div class="fp-sub">Updates every 5 seconds</div>
    </div>`;
  }

  const diffMs   = gameTime - now;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60000);
  const hours    = Math.floor(diffMins / 60);
  const mins     = diffMins % 60;

  const timeStr = diffMs < 60000 ? `${diffSecs}s`
    : hours > 0 ? `${hours}h ${mins > 0 ? mins + 'm' : ''}`
    : `${diffMins}m`;

  const fpCls = diffMs < 60000 ? 'fp-hot' : diffMs < 300000 ? 'fp-warm' : '';

  return `<div class="fp-card ${fpCls}" id="fp-card">
    <div class="fp-label">First Pitch</div>
    <div class="fp-time">${timeStr}</div>
    <div class="fp-sub">${game.isHome ? 'vs' : '@'} ${_escape(game.opponent || '')}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// SEASON DONE
// ─────────────────────────────────────────────────────────────

function _renderSeasonDoneCard(state) {
  const wins   = state.userTeam?.wins   || 0;
  const losses = state.userTeam?.losses || 0;
  return `<div class="next-game-card">
    <div class="ngc-info">
      <div class="ngc-opp" style="font-size:16px;font-weight:700;">Season Complete</div>
      <div class="ngc-loc">${wins}–${losses} final record</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// HOT/COLD STRIP
// ─────────────────────────────────────────────────────────────

function _renderHotColdStrip(state) {
  const rosterIds = state.userTeam?.rosterIds || [];
  const impScores = state.impScores || {};

  const hot = rosterIds
    .map(id => ({ id, player: state.players[id], imp: impScores[id] }))
    .filter(({ player, imp }) => player && !player.isInjured && imp?.imp7 != null)
    .sort((a,b) => Math.abs(b.imp?.imp7||0) - Math.abs(a.imp?.imp7||0))
    .slice(0, 5);

  if (!hot.length) return '';

  const chips = hot.map(({ player, imp }) => {
    const ind  = getHotColdIndicator(imp);
    const imp7 = imp?.imp7;
    const sign = imp7 > 0 ? '+' : '';
    return `<div class="hot-cold-chip">
      <span class="hot-cold-name">${_escape(player.name.split(' ').pop() || player.name)}</span>
      <span class="hot-cold-pos">${player.pos}</span>
      ${ind ? `<span class="imp-indicator">${ind}</span>` : ''}
      ${imp7 != null ? `<span class="imp-score ${imp7>0?'imp-pos':'imp-neg'}">${sign}${imp7.toFixed(1)}</span>` : ''}
    </div>`;
  }).join('');

  return `<div class="hot-cold-strip">
    <div class="hot-cold-label">FORM</div>
    <div class="hot-cold-chips">${chips}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED
// ─────────────────────────────────────────────────────────────

const _FEED_ICONS = {
  trade:'🔄',injury:'🏥',promotion:'⬆️',demotion:'⬇️',
  signing:'✍️',release:'👋',milestone:'🏆',card:'📋',
  waiver:'📋',win:'✅',loss:'❌',weather:'⛈️',result:'⚾',
};

function _renderActivityFeed(state) {
  const feed = (state.activityFeed || []).slice(-8).reverse();
  if (!feed.length) return '';

  const entries = feed.map(e => {
    const diff = (state.currentGameIndex || 0) - (e.gameIndex || 0);
    const time = diff === 0 ? 'Today' : diff === 1 ? '1g ago' : `${diff}g ago`;
    return `<div class="activity-entry">
      <div class="activity-icon">${_FEED_ICONS[e.type] || '·'}</div>
      <div class="activity-text">${_escape(e.text || '')}</div>
      <div class="activity-time">${time}</div>
    </div>`;
  }).join('');

  return `<div class="activity-feed-wrap">
    <div class="activity-feed-label">RECENT</div>
    ${entries}
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// GAME LOG MODAL
// ─────────────────────────────────────────────────────────────

function _openGameLogModal(state, filter) {
  document.getElementById('dash-game-log-overlay')?.remove();

  const committed = (state.schedule || []).filter(g =>
    g._committed && (filter === 'wins' ? g.result === 'win' : g.result === 'loss')
  );
  const title = `${filter === 'wins' ? 'Wins' : 'Losses'} (${committed.length})`;
  const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const rows = !committed.length
    ? `<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;">No ${filter} yet.</div>`
    : committed.map(g => {
        const us   = g.score?.us   ?? g.ourScore   ?? 0;
        const them = g.score?.them ?? g.theirScore ?? 0;
        const [,mon,dd] = (g.date||'').split('-');
        return `<div style="display:flex;align-items:center;gap:14px;padding:10px 20px;border-bottom:1px solid var(--border);">
          <div style="text-align:center;min-width:36px;">
            <div style="font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;">${MONTHS[parseInt(mon)]||''}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;line-height:1;">${String(parseInt(dd)||'').padStart(2,'0')}</div>
          </div>
          <div style="flex:1;">
            <div style="font-weight:600;font-size:14px;">${g.isHome?'vs':'@'} ${_escape(g.opponent||g.opp||'')}</div>
            <div style="font-size:11px;color:var(--muted);">${g.isHome?'Home':'Away'}</div>
          </div>
          <div class="game-result ${filter==='wins'?'win':'loss'}">${us}–${them}</div>
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
  overlay.querySelector('#dash-log-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  App.playSoundOpen();
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  document.getElementById('dash-wins-card')?.addEventListener('click', () => {
    App.playClick();
    _openGameLogModal(state, 'wins');
  });
  document.getElementById('dash-losses-card')?.addEventListener('click', () => {
    App.playClick();
    _openGameLogModal(state, 'losses');
  });

  document.querySelectorAll('.live-tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      _liveTab = tab.dataset.tab;
      App.playClick();
      document.querySelectorAll('.live-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.live-tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`lgv-tc-${_liveTab}`)?.classList.add('active');

      if (_liveTab === 'box') {
        const game = _getNextGame(state);
        if (game && game.plays) {
          const ds  = _deriveGameState(game);
          const box = document.getElementById('lgv-box');
          if (box) box.innerHTML = _renderBoxScore(ds);
        }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _barColor(val) {
  if (val >= 70) return '#22C55E';
  if (val >= 50) return '#F5D253';
  if (val >= 35) return '#f97316';
  return '#EF4444';
}

function _computeRosterOvr(state) {
  const ids = state.userTeam?.rosterIds || [];
  if (!ids.length) return 0;
  const active = ids.map(id => state.players[id]).filter(p => p && !p.isInjured && p.group !== 'IL');
  if (!active.length) return 0;
  return Math.round(active.reduce((s,p) => s + (p.ovr||0), 0) / active.length);
}

function _getDivStanding(state) {
  const standings = state.standings;
  if (!standings) return '–';
  const divKey = state.userTeam?.divisionId === 'B' ? 'B' : 'A';
  const div    = standings[divKey] || standings.divA || [];
  const idx    = div.findIndex(t => t.id === 'user');
  if (idx < 0) return '–';
  const sfx = ['st','nd','rd'][idx] || 'th';
  return `${idx + 1}${sfx}`;
}

function _getNextGame(state) {
  const schedule = state.schedule || [];
  return schedule[state.currentGameIndex || 0] || null;
}

function _escape(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .live-game-wrap{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-bottom:8px;overflow:hidden;}
    .live-score-header{padding:14px 16px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);}
    .live-teams{flex:1;}
    .live-team-row{display:flex;align-items:center;justify-content:space-between;padding:2px 0;}
    .live-team-name{font-size:14px;font-weight:600;color:var(--text);}
    .live-team-name.our-team{color:var(--accent);}
    .live-score-val{font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1;color:var(--text);min-width:28px;text-align:right;}
    .lgv-diamond-col{display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;padding:0 10px;}
    .lgv-outs-row{display:flex;gap:4px;align-items:center;}
    .lgv-out-dot{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--muted);background:transparent;transition:background .2s;}
    .lgv-out-dot.active{background:var(--danger);border-color:var(--danger);}
    .live-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-left:8px;flex-shrink:0;}
    .live-inning{font-size:13px;font-weight:700;color:var(--text);}
    .lgv-outs-label{font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.3px;}
    .lgv-status-pill{font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:3px 7px;border-radius:10px;border:1px solid;}
    .lgv-active{color:var(--danger);border-color:var(--danger);background:rgba(240,82,82,.08);}
    .lgv-final{color:var(--muted);border-color:var(--border);}
    .lgv-delay{color:#f97316;border-color:rgba(249,115,22,.4);}
    .lgv-linescore-wrap{overflow-x:auto;padding:8px 16px;border-bottom:1px solid var(--border);}
    .linescore-live table{width:100%;border-collapse:collapse;}
    .ls-inn-head{color:var(--muted);font-weight:600;text-align:center;min-width:18px;font-size:10px;padding:2px 3px;}
    .ls-inn-head.ls-active-head{color:var(--accent);}
    .ls-team-head{min-width:28px;}
    .ls-total-head{border-left:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:700;text-align:center;padding:2px 4px;}
    .ls-team{font-size:11px;font-weight:700;color:var(--text);padding-right:6px;white-space:nowrap;}
    .ls-team.ls-team-user{color:var(--accent);}
    .ls-cell{text-align:center;font-size:11px;color:var(--muted);padding:2px 3px;}
    .ls-cell.ls-scoring{color:var(--text);font-weight:700;}
    .ls-cell.ls-active-cell{color:var(--accent);font-weight:700;}
    .ls-total{border-left:1px solid var(--border);text-align:center;font-size:12px;font-weight:700;color:var(--text);padding:2px 4px;}
    .ls-total.ls-winner{color:var(--accent2);}
    .live-tabs{display:flex;border-bottom:1px solid var(--border);}
    .live-tab{flex:1;text-align:center;padding:8px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;}
    .live-tab.active{color:var(--accent);border-bottom-color:var(--accent);}
    .live-tab-content{display:none;}
    .live-tab-content.active{display:block;}
    .pbp-feed{padding:10px 16px 12px;max-height:280px;overflow-y:auto;}
    .pbp-empty{padding:16px 0;color:var(--muted);font-size:13px;}
    .pbp-inning-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:10px 0 4px;}
    .pbp-play{display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);}
    .pbp-play:last-child{border-bottom:none;}
    .pbp-play-icon{font-size:12px;flex-shrink:0;width:16px;text-align:center;margin-top:1px;}
    .pbp-play-text{font-size:13px;color:var(--soft);line-height:1.4;}
    .pbp-play.pbp-homer .pbp-play-text{color:var(--text);font-weight:700;}
    .pbp-play.pbp-hit .pbp-play-text{color:var(--accent2);}
    .pbp-play.pbp-pitching{opacity:.6;}
    .live-box-wrap{padding:12px 16px;}
    .bs-section-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
    .bs-table-wrap{overflow-x:auto;}
    .bs-table{width:100%;border-collapse:collapse;font-size:11px;}
    .bs-table th{color:var(--muted);font-weight:600;text-align:center;padding:3px 4px;font-size:10px;border-bottom:1px solid var(--border);}
    .bs-table th:first-child{text-align:left;}
    .bs-table td{text-align:center;padding:3px 4px;color:var(--soft);}
    .bs-table td.bs-name{text-align:left;color:var(--text);font-weight:500;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .bs-table td.bs-hi{color:#60a5fa;font-weight:700;}
    .bs-table td.bs-avg{color:#34d399;font-weight:700;}
    .fp-card{border-radius:14px;padding:10px 16px;margin-top:8px;text-align:center;background:var(--surface2);border:1px solid var(--border);}
    .fp-card.fp-warm{background:rgba(249,115,22,.10);border-color:rgba(249,115,22,.35);}
    .fp-card.fp-hot{background:rgba(240,82,82,.12);border-color:rgba(240,82,82,.4);}
    .fp-label{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}
    .fp-time{font-family:'Bebas Neue',sans-serif;font-size:40px;line-height:1;color:var(--text);}
    .fp-card.fp-warm .fp-time{color:#f97316;}
    .fp-card.fp-hot  .fp-time{color:var(--danger);}
    .fp-sub{font-size:10px;color:var(--muted);margin-top:2px;}
    .activity-feed-wrap{margin-top:8px;padding-bottom:16px;}
    .activity-feed-label{padding:12px 16px 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);}
    .activity-entry{display:flex;align-items:flex-start;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);}
    .activity-entry:last-child{border-bottom:none;}
    .activity-icon{font-size:14px;flex-shrink:0;width:20px;text-align:center;margin-top:1px;}
    .activity-text{flex:1;font-size:12px;color:var(--soft);line-height:1.4;}
    .activity-time{font-size:10px;color:var(--muted);flex-shrink:0;white-space:nowrap;}
    .game-result{font-size:13px;font-weight:700;font-family:'Bebas Neue',sans-serif;letter-spacing:.5px;}
    .game-result.win{color:var(--accent2);}
    .game-result.loss{color:var(--danger);}
    .hot-cold-strip{padding:8px 16px 4px;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow-x:auto;}
    .hot-cold-strip::-webkit-scrollbar{display:none;}
    .hot-cold-label{font-size:9px;font-weight:800;letter-spacing:2px;color:var(--muted);text-transform:uppercase;flex-shrink:0;}
    .hot-cold-chips{display:flex;gap:6px;overflow-x:auto;}
    .hot-cold-chip{display:flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;white-space:nowrap;flex-shrink:0;}
    .hot-cold-name{font-size:11px;font-weight:600;color:var(--text);}
    .hot-cold-pos{font-size:9px;color:var(--muted);font-weight:600;}
    .imp-indicator{font-size:11px;}
    .imp-score{font-size:10px;font-weight:700;}
    .imp-pos{color:var(--accent2);}
    .imp-neg{color:var(--danger);}
  `;
  document.head.appendChild(s);
}
