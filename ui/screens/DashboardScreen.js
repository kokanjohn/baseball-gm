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
import { accumulateBox, liveSituation, playRuns } from '../../engine/SimEngine.js';
import { renderBoxScore } from '../components/BoxScore.js';
import { renderLeagueLiveRow, wireLeagueGameTaps } from '../components/LiveGame.js';
import { renderOffseasonCard, updateOffseasonCountdown } from '../components/OffseasonCard.js';
import {
  allStarFeature, allStarView, allStarGameLike, allStarIsLive, allStarFinalDs, countdownText,
  renderAllStarHeader, renderAllStarPregame, renderMyAllStars, renderAllStarResult,
} from '../components/AllStarCard.js';
import { GAME_STATUS, PLAYER_GROUP } from '../../data/constants.js';
import {
  formatRecord, formatStreak, formatDate, metricBarColor, computeRosterOvr,
  formatPhaseLabel, formatMoney, formatOVR, formatGameLabel,
} from '../formatters.js';
import { createRadarCard, MAP_H as RADAR_MAP_H } from '../components/RadarCard.js';
import { openRadarSheet, venueOf } from '../components/RadarSheet.js';
import { wxState, weatherLine, gameNotes, elapsedLabel } from '../components/WeatherStatus.js';
import { gameForecastFor, peekGameForecast } from '../components/ForecastSource.js';
import { openForecastSheet, forecastLine } from '../components/ForecastSheet.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted      = false;
let _listeners    = [];       // { event, handler } pairs for cleanup
let _liveTab      = 'pbp';
let _shownGameKey = null;   // which game the live card last showed (refresh keeps its tab/scroll)
let _pbpRenderedIdx = 0;   // count of plays already placed in the live PBP feed
let _firstPitchSounded  = false;
let _countdownInterval  = null; // 1-second interval for fp countdown display
let _visibilityHandler  = null; // document visibilitychange handler
let _asgMode            = null; // §75: 'pre' | 'live' | 'final' while the All-Star Game owns the game area
let _radar              = null; // §100 the next-game card's radar — one element, moved into each redraw's slot
let _wxKindShown        = null; // §102.4 the weather's hold on the live card as last drawn (a change redraws it)
let _wxSig              = null; // §102.4 our next game's status / time / weather, as last drawn
let _fcHour             = null; // §102.7 the forecast hour the next-game forecast line was drawn from

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
  // Offseason (§70): decisions and new days change the card's gates and focus.
  const offseasonRefresh = () => { if (StateManager.get()?.offseason) refresh(); };
  wire('inbox:changed',     offseasonRefresh);
  wire('card:resolved',     offseasonRefresh);
  wire('card:delivered',    offseasonRefresh);

  // League games in progress (§67): the small cards update on the same
  // 5-second cadence as the app tick, without re-rendering the dashboard.
  _leagueTimer = setInterval(_refreshLeagueRow, 5000);

  // Android Chrome throttles setInterval when the tab/app is in the background.
  // When the user returns to the app or navigates back to the dashboard tab,
  // restart the countdown so it immediately shows the correct remaining time.
  _visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      // Re-check if we should be showing a countdown and restart it
      const state = StateManager.get();
      const game  = state ? _getNextGame(state) : null;
      if (game && !game._committed && game.gameTime && Date.now() < game.gameTime
          && !(game.plays?.length > 0 && (game.livePlayIndex || 0) > 0)) {
        _startCountdown(game.gameTime);
      }
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);
  window.addEventListener('resize', _fitRadar);

  refresh();
}

export function unmount() {
  _listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
  _listeners = [];
  clearInterval(_leagueTimer);
  _leagueTimer = null;
  _stopCountdown();
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
  window.removeEventListener('resize', _fitRadar);
  _radar?.dispose();
  _radar = null;
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
      // First pitch reached — trigger a tick immediately rather than waiting
      // up to 5 seconds for the next app tick interval to fire.
      _stopCountdown();
      _triggerImmediateTick();
      return;
    }

    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.ceil(diffMs / 60000);   // round up so "4m 45s left" shows 5m
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

/**
 * _triggerImmediateTick()
 * Called when the countdown hits zero. Fires a tick immediately so the
 * live game card appears at first pitch rather than waiting up to 5s
 * for the next app interval tick.
 *
 * Uses dynamic import to avoid circular dependency — same pattern as
 * App.startTick. Fires and forgets; errors are silent since the
 * regular app tick will catch up within 5 seconds regardless.
 */
async function _triggerImmediateTick() {
  try {
    const { tick } = await import('../../engine/GameEngine.js');
    const play = tick();
    // Get fresh game state after tick
    const state   = StateManager.get();
    const gameIdx = state?.currentGameIndex ?? 0;
    const game    = state?.schedule?.[gameIdx];
    if (!game) return;

    if (play || (game.plays && game.plays.length > 0)) {
      // Game is now live — full refresh to show the live game card
      refresh();
      // Emit tick event so other screens can react
      if (play) {
        const EventBusModule = await import('../EventBus.js');
        EventBusModule.emit('game:tick', { play, game });
      }
    } else {
      // Plays not generated yet (shouldn't happen) — show LIVE on countdown card
      const fpCard = document.getElementById('fp-card');
      const fpTime = document.getElementById('fp-time');
      if (fpCard) fpCard.className = 'fp-card fp-hot';
      if (fpTime) fpTime.textContent = 'LIVE';
    }
  } catch (err) {
    // Fallback — show LIVE on countdown card, regular tick will handle the rest
    const fpCard = document.getElementById('fp-card');
    const fpTime = document.getElementById('fp-time');
    if (fpCard) fpCard.className = 'fp-card fp-hot';
    if (fpTime) fpTime.textContent = 'LIVE';
    console.warn('[DashboardScreen._triggerImmediateTick]', err);
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

  // A redraw for some other reason (a roster move elsewhere, a card) keeps
  // the viewer where they were in the same game: the tab they chose and the
  // play-by-play's scroll. A different game starts fresh on Play by Play.
  const game   = _getNextGame(state);
  const gameKey = game ? `${game.index ?? ''}|${game.date ?? ''}|${game.opponent ?? ''}` : null;
  const sameGame = gameKey !== null && gameKey === _shownGameKey;
  const feedScroll = sameGame ? (document.getElementById('lgv-pbp-feed')?.scrollTop || 0) : 0;
  if (!sameGame) _liveTab = 'pbp';
  _shownGameKey = gameKey;
  _stopCountdown();
  container.innerHTML = _renderDashboard(state);
  _attachListeners(state);
  _attachRadar(state);
  _fillForecast(state);
  _syncScrollRoom();
  if (feedScroll) { const f = document.getElementById('lgv-pbp-feed'); if (f) f.scrollTop = feedScroll; }

  // Start 1-second countdown if pre-game and gameTime is set
  // The feed was just rebuilt with all currently-revealed plays; subsequent
  // ticks only append plays beyond this index.
  _pbpRenderedIdx = game?.livePlayIndex || 0;
  if (_asgMode === 'live') {
    const asg = allStarFeature(state, game);
    if (asg) _pbpRenderedIdx = allStarGameLike(asg.game).livePlayIndex;
  }
  if (!_asgMode && game && !game._committed && game.gameTime && Date.now() < game.gameTime
      && !(game.plays && game.plays.length > 0 && (game.livePlayIndex || 0) > 0)) {
    _startCountdown(game.gameTime);
  }
}

// ─────────────────────────────────────────────────────────────
// TICK HANDLER — patches live card only, no full re-render
// ─────────────────────────────────────────────────────────────

function _onTick({ play, game } = {}) {
  if (!game || _asgMode) return;   // the All-Star Game has the card (_refreshAllStar)

  const liveWrap = document.getElementById('live-game-wrap');

  // Pre-game: live card not showing yet.
  // Only do a full refresh if the game has actually gone live
  // (plays exist and livePlayIndex > 0). Otherwise let the
  // 1-second countdown interval handle the display update.
  if (!liveWrap) {
    const isNowLive = game.plays
      && game.plays.length > 0
      && (game.livePlayIndex || 0) > 0
      && game.status !== GAME_STATUS.SCHEDULED
      && game.status !== GAME_STATUS.PRE_GAME_WATCH;

    if (isNowLive) {
      _stopCountdown();
      refresh();
    }
    return;
  }

  const ds = _deriveGameState(game);
  _patchLiveCard(game, ds, _userView(StateManager.get(), game));

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

/**
 * _patchLiveCard(game, ds, view)
 * Brings the live card up to date in place (no re-render: the PBP keeps its
 * scroll). Shared by our own games (game:tick) and the All-Star Game (§75).
 */
function _patchLiveCard(game, ds, view) {
  // PBP first — append every play revealed since the last render (oldest→newest
  // so the newest ends on top), so the play appears together with the score it
  // produced rather than a beat behind it. Handles batches at high speed.
  const liveIdx = game.livePlayIndex || 0;
  if (liveIdx < _pbpRenderedIdx) _pbpRenderedIdx = 0; // new game / feed rebuilt
  for (let i = _pbpRenderedIdx; i < liveIdx; i++) {
    const p = game.plays?.[i];
    if (p && p.description
        && p.type !== 'inning_end' && p.type !== 'game_end'
        && p.inning && p.half && p.half !== 'END') {
      _prependPBPPlay(p);
    }
  }
  _pbpRenderedIdx = liveIdx;

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

  // Linescore team abbrs via shared helpers (never a placeholder)
  const lsEl = document.getElementById('lgv-linescore');
  if (lsEl) lsEl.innerHTML = _renderLinescore({ ...ds, isHome: view.userIsHome }, view.awayAbbr, view.homeAbbr);

  // Diamond — replace SVG in-place
  const svgWrap = document.getElementById('lgv-diamond-wrap');
  if (svgWrap) svgWrap.innerHTML = _renderDiamond(ds.bases);

  // Outs dots
  const outsRow = document.getElementById('lgv-outs-row');
  if (outsRow) outsRow.innerHTML = _renderOutDots(ds.outs);

  // §102.4 the weather took hold of the game or let go: redraw the card (banner, radar).
  if ((ds.wx?.kind || null) !== _wxKindShown && document.getElementById('lgv-wx')) {
    const el = document.getElementById('lgv-wx');
    el.innerHTML = _wxBanner(game, ds);
    _attachRadar(StateManager.get());
  }

  // Box score — only rebuild if tab is active
  if (_liveTab === 'box') {
    const boxEl = document.getElementById('lgv-box');
    if (boxEl) boxEl.innerHTML = _renderBoxScore(ds, game, StateManager.get(), view.names);
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

  // ── Situation (inning / half / outs / bases): the shared derivation ──
  const sit = liveSituation(revealedPlays, plays[liveIdx] ?? null);
  let outs = sit.outs;
  const bases = sit.bases;
  const curInning = sit.inning, curHalf = sit.half;

  // ── Linescore accumulation: runs per half, H/E totals, halves seen ──
  const runsByHalf   = {};
  const halvesSeen   = new Set();   // any half that has had a revealed play
  let totalAwayHits   = 0, totalHomeHits   = 0;
  let totalAwayErrors = 0, totalHomeErrors = 0;

  for (const p of revealedPlays) {
    const key = `${p.half}_${p.inning}`;
    if (p.type === 'game_end') continue;
    if (p.inning && (p.half === 'TOP' || p.half === 'BOT')) halvesSeen.add(key);

    if (p.type !== 'inning_end' && p.type !== 'pitching_change'
        && p.type !== 'game_start' && p.type !== 'stolen_base'
        && p.type !== 'caught_stealing') {
      if (playRuns(p) > 0) runsByHalf[key] = (runsByHalf[key] || 0) + playRuns(p);

      // Hits — batter batting for our team vs their team
      const isOurBatter = isHome
        ? p.half === 'BOT'   // home team bats in bottom
        : p.half === 'TOP';  // away team bats in top
      if (['single','double','triple','hr'].includes(p.type)) {
        if (isOurBatter) totalHomeHits++;
        else             totalAwayHits++;
      }
      // Errors — error charged to the fielding team = not the batting team
      if (p.type === 'error') {
        if (isOurBatter) totalAwayErrors++;
        else             totalHomeErrors++;
      }
    }
  }

  // ── Status ────────────────────────────────────────────────────
  const isFinal = game.status === GAME_STATUS.FINAL || game._committed
    || revealedPlays.some(p => p.type === 'game_end');

  // (liveSituation already advanced past a completed half — and holds the
  //  final half when game_end is next — so the highlight and the posted
  //  score move together.)

  // ── Linescore cells by PROGRESSION, not inning_end plays ─────────────
  // Every half we've moved past posts its runs; the half in progress shows
  // its runs so far (as on a broadcast), once it has had a pitch. The running
  // score (cumOurScore) is stamped per play, so the R column and the cells
  // always add up.
  const ord     = (half, inn) => (inn - 1) * 2 + (half === 'TOP' ? 0 : 1);
  const curOrd  = ord(curHalf, curInning);
  const done    = (half, inn) => {
    const key = `${half}_${inn}`;
    return ord(half, inn) < curOrd || (halvesSeen.has(key) && (isFinal || ord(half, inn) === curOrd));
  };

  const maxInning = Math.max(9, curInning);
  const awayRunsByInn = [];
  const homeRunsByInn = [];
  for (let inn = 1; inn <= maxInning; inn++) {
    awayRunsByInn.push(done('TOP', inn) ? (runsByHalf[`TOP_${inn}`] || 0) : null);
    homeRunsByInn.push(done('BOT', inn) ? (runsByHalf[`BOT_${inn}`] || 0) : null);
  }
  const completedHalves = halvesSeen; // retained in return for compatibility

  const innSuffix = _innSuffix(curInning);
  const halfSym   = curHalf === 'TOP' ? '▲' : '▼';
  const innLabel  = isFinal ? 'FINAL' : `${halfSym} ${curInning}${innSuffix}`;
  const outsLabel = isFinal ? '—' : `${outs} OUT${outs !== 1 ? 'S' : ''}`;

  // §102.4 the weather's hold on the game (a delay, a suspension, a called game).
  const wx = wxState(game, revealedPlays);
  const statusLabel = isFinal                              ? 'FINAL'
    : wx.kind                                              ? wx.pill
    : game.status === GAME_STATUS.DELAYED                  ? 'DELAYED'
    : liveIdx > 0                                          ? '● LIVE'
    : 'PRE-GAME';
  const statusCls = isFinal                               ? 'lgv-final'
    : wx.kind || game.status === GAME_STATUS.DELAYED       ? 'lgv-delay'
    : liveIdx > 0                                          ? 'lgv-active'
    : '';

  // ── PBP: revealed plays, newest first, excluding housekeeping ─
  // Also exclude any play missing inning/half — these are edge-case
  // pitching_change plays that inherit from a null previous play.
  const pbpPlays = revealedPlays
    .filter(p => p.type !== 'game_end' && p.type !== 'inning_end'
              && p.inning && p.half && p.half !== 'END'
              && p.description) // skip any play with no description (dash guard)
    .slice()
    .reverse();

  // ── Box score is built in _renderBoxScore via the shared accumulator
  //    (SimEngine.accumulateBox over revealed plays) — single source of truth. ──

  return {
    ourScore, theirScore, awayScore, homeScore,
    outs, bases,
    curInning, curHalf,
    isFinal, innLabel, outsLabel,
    statusLabel, statusCls, wx,
    awayRunsByInn, homeRunsByInn, maxInning,
    completedHalves, runsByHalf,
    pbpPlays,
    revealedCount: revealedPlays.length,
    isHome,
    awayHits:   isHome ? totalAwayHits   : totalHomeHits,
    homeHits:   isHome ? totalHomeHits   : totalAwayHits,
    awayErrors: isHome ? totalAwayErrors : totalHomeErrors,
    homeErrors: isHome ? totalHomeErrors : totalAwayErrors,
  };
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD RENDER
// ─────────────────────────────────────────────────────────────

function _renderDashboard(state) {
  const team       = state.userTeam;
  const wins       = team.wins       || 0;
  const losses     = team.losses     || 0;
  const ties       = team.ties       || 0;
  const morale     = team.morale     || 50;
  const atmosphere = team.atmosphere || 50;
  const ownerTrust = team.ownerTrust || 60;
  const phase      = state.phase;

  const rosterOvr   = computeRosterOvr(state);
  const divStanding = _getDivStanding(state);
  const nextGame    = _getNextGame(state);

  const springGames  = (state.schedule || []).filter(g => g.isSpring);
  const springPlayed = springGames.filter(g => g._committed).length;
  const springTotal  = springGames.length;
  const isSpring     = phase === 'SPRING_TRAINING';
  const gamesPlayed  = wins + losses;

  let bannerGame, bannerRecord;
  const POST = { PLAYOFF_BRACKET_BUILD: 'POSTSEASON', WILD_CARD: 'WILD CARD', FIRST_ROUND: 'FIRST ROUND',
                 DIVISION_SERIES: 'DIVISION SERIES', WORLD_SERIES: 'WORLD SERIES', SEASON_SUMMARY: 'SEASON COMPLETE',
                 OFFSEASON: 'OFFSEASON' };
  if (POST[phase]) {
    bannerGame   = POST[phase];
    bannerRecord = `${wins}–${losses} season · ${team.postseasonWins || 0}–${team.postseasonLosses || 0} postseason`;
  } else if (isSpring) {
    bannerGame   = springPlayed === 0 ? 'SPRING TRAINING' : `SPRING GAME ${springPlayed}`;
    bannerRecord = springPlayed === 0 ? 'First game coming up' : `${springPlayed} of ${springTotal}`;
  } else {
    bannerGame   = gamesPlayed === 0 ? 'OPENING DAY' : `GAME ${gamesPlayed}`;
    bannerRecord = `${wins}–${losses}${ties ? `–${ties}` : ''} · Season record`;
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
        <div class="stat-card ${ovrClass}" id="dash-rating-card"
          style="flex-direction:column;align-items:center;justify-content:center;padding:10px 8px;cursor:pointer;">
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
          <div class="progress-fill" style="width:${morale}%;background:${metricBarColor(morale)};"></div>
        </div>
        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Stadium Atmosphere</span>
          <span class="morale-val">${atmosphere}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${atmosphere}%;background:${metricBarColor(atmosphere)};"></div>
        </div>
        <div class="morale-row" style="margin-top:10px">
          <span class="morale-label">Owner Trust</span>
          <span class="morale-val">${ownerTrust}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${ownerTrust}%;background:${metricBarColor(ownerTrust)};"></div>
        </div>
      </div>
    </div>

    <div class="advance-section">
      ${_renderGameArea(nextGame, state)}
      <div id="dash-league-live">${renderLeagueLiveRow(state)}</div>
    </div>

    ${gamesPlayed >= 3 ? _renderHotColdStrip(state) : ''}
    ${_renderActivityFeed(state)}
  `;
}

// ─────────────────────────────────────────────────────────────
// GAME AREA
// ─────────────────────────────────────────────────────────────

function _renderGameArea(game, state) {
  // §75: from our last game before the break to the morning after the
  // All-Star Game, the game area is the All-Star Game's.
  const asg = allStarFeature(state, game);
  _asgMode = null;
  if (asg) return _renderAllStarArea(asg.game, state, game);
  if (!game) return _renderSeasonDoneCard(state);

  const isLive = game.plays
    && game.plays.length > 0
    && !game._committed
    && game.status !== GAME_STATUS.SCHEDULED
    && game.status !== GAME_STATUS.PRE_GAME_WATCH
    && game.status !== GAME_STATUS.POSTPONED;

  if (isLive) return _renderLiveGameCard(game, state);

  if (game._committed) {
    const nextIdx  = state.currentGameIndex || 0;
    const nextGame = state.schedule?.[nextIdx] || null;
    if (!nextGame) return _renderSeasonDoneCard(state);
    return _renderNextGameCard(nextGame, state) + _renderFirstPitchCountdown(nextGame) + _radarSlot(nextGame);
  }

  return _renderNextGameCard(game, state) + _renderFirstPitchCountdown(game) + _radarSlot(game);
}

// ─────────────────────────────────────────────────────────────
// RADAR (§100) — the next game's ballpark, live; tap for the full radar
// ─────────────────────────────────────────────────────────────

function _radarSlot(game) {
  return `<div id="dash-radar-slot" data-focus="${_escape(venueOf(game))}"></div>`;
}

/** Put the radar card into this redraw's slot (creating it the first time). */
function _attachRadar(state) {
  const slot = document.getElementById('dash-radar-slot');
  if (!slot) { _radar?.pause(); return; }
  if (!_radar) {
    _radar = createRadarCard({
      onOpen: (focusId) => {
        App.playClick();
        _radar?.pause();
        openRadarSheet({ state: StateManager.get(), focusId, onClose: () => _radar?.resume() });
      },
    });
  }
  slot.appendChild(_radar.root);
  _radar.update({ state, focusId: slot.dataset.focus || 'user' });
  _radar.resume();
  // The short-screen Radar button opens the same full radar (a new button each redraw).
  document.querySelectorAll('#dashboard-content .ngc-radar').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    App.playClick();
    openRadarSheet({ state: StateManager.get(), focusId: slot.dataset.focus || 'user' });
  }));
  _fitRadar();
}

/** The All-Star Game in the game area: pre-game, live, or final (§75). */
function _renderAllStarArea(g, state, nextUserGame) {
  const view = allStarView(state, g);
  const head = renderAllStarHeader(state, g);
  if (g.played) {
    _asgMode = 'final';
    _liveTab = 'box';   // the plays are gone after the final; the box tells it
    const ds = allStarFinalDs(g, view);
    const next = nextUserGame && !nextUserGame._committed ? _renderNextGameCard(nextUserGame, state) : '';
    return head + _renderLiveGameCard({ ...g, isHome: true, _committed: true, boxScore: g.boxScore }, state, view, ds,
                                      renderAllStarResult(state, g))
         + renderMyAllStars(state, g, g.boxScore) + next;
  }
  if (allStarIsLive(g)) {
    _asgMode = 'live';
    const like = allStarGameLike(g);
    const ds = _deriveGameState(like);
    return head + _renderLiveGameCard(like, state, view, ds) + `<div id="asg-mine">${renderMyAllStars(state, g, _liveBox(like, state))}</div>`;
  }
  _asgMode = 'pre';
  return head + renderAllStarPregame(state, g) + renderMyAllStars(state, g, null);
}

/** The box from the revealed plays (the same accumulator as everywhere). */
function _liveBox(game, state) {
  const revealed = (game.plays || []).slice(0, game.livePlayIndex || 0);
  if (!revealed.length) return null;
  return accumulateBox(revealed, state.players || {}, {
    awayOrder: game.liveLineups?.away || [], homeOrder: game.liveLineups?.home || [],
    userIsHome: !!game.isHome, homeIds: game.liveLineups?.homeIds || null,
  });
}

/**
 * _refreshAllStar() — every 5 s while the All-Star Game owns the game area:
 * the countdown, the live card patched in place, a full render when it goes
 * live or final.
 */
function _refreshAllStar() {
  const state = StateManager.get();
  if (!state || !document.getElementById('dashboard-content')) return;
  const nextUserGame = _getNextGame(state);
  const asg = allStarFeature(state, nextUserGame);
  const mode = !asg ? null : asg.game.played ? 'final' : allStarIsLive(asg.game) ? 'live' : 'pre';
  if (mode !== _asgMode) { refresh(); return; }
  if (mode === 'pre') {
    const el = document.getElementById('asg-fp-time');
    if (el) el.textContent = countdownText(asg.game.gameTime);
  } else if (mode === 'live') {
    const like = allStarGameLike(asg.game);
    const view = allStarView(state, asg.game);
    _patchLiveCard(like, _deriveGameState(like), view);
    const mine = document.getElementById('asg-mine');
    if (mine) mine.innerHTML = renderMyAllStars(state, asg.game, _liveBox(like, state));
  }
}

// ─────────────────────────────────────────────────────────────
// TEAM LABELS — one source of truth, never a placeholder
// ─────────────────────────────────────────────────────────────
function _userAbbr(state) {
  const t = state?.userTeam || {};
  return String(t.abbr || t.nickname || t.city || t.name || 'HOME').toUpperCase().slice(0, 4);
}
function _userFull(state) {
  const t = state?.userTeam || {};
  return `${t.city || ''} ${t.nickname || ''}`.trim() || t.name || t.abbr || 'Your Team';
}
function _oppAbbr(state, game) {
  const opp = game?.opponent || '';
  const oppTeam = state?.leagueTeams?.find(t => t.name === opp);
  return String(oppTeam?.abbr || opp.split(' ').pop() || 'AWAY').toUpperCase().slice(0, 4);
}
function _oppFull(game) {
  return game?.opponent || 'Opponent';
}
/** §78: the crowd at our home game (and, at the final, the gate). */
function _crowdLine(game, ds) {
  if (!game?.attendance || game.isAllStar) return '';
  const gate = ds?.isFinal && game.gateK ? ` · Gate ${formatMoney(game.gateK)}` : '';
  return `<div class="lgv-crowd">Attendance ${game.attendance.toLocaleString()}${game.sellout ? ' · Sellout' : ''}${gate}</div>`;
}

/** Labels for our own game's live card. */
function _userView(state, game) {
  const uA = _userAbbr(state), uF = _userFull(state), oA = _oppAbbr(state, game), oF = _oppFull(game);
  return {
    awayFull: game.isHome ? oF : uF, homeFull: game.isHome ? uF : oF,
    awayAbbr: game.isHome ? oA : uA, homeAbbr: game.isHome ? uA : oA,
    awayIsUser: !game.isHome, homeIsUser: !!game.isHome, userIsHome: !!game.isHome,
    names: { awayName: game.isHome ? oF : uF, homeName: game.isHome ? uF : oF },
  };
}

// ─────────────────────────────────────────────────────────────
// LIVE GAME CARD
// ─────────────────────────────────────────────────────────────

/**
 * §102.4 Under the linescore: while the weather holds the game up, what's
 * happening and for how long, with the radar on the ballpark; once it's
 * over and it was called short, why. Otherwise the weather it's played in.
 */
function _wxBanner(game, ds) {
  const w = ds.wx || { kind: null };
  _wxKindShown = w.kind;
  if (!w.kind) {
    const line = weatherLine(game);
    return line ? `<div class="lgv-wx-line">${_escape(line)}</div>` : '';
  }
  const clock = w.kind === 'delay' || w.kind === 'start-delay'
    ? ` · <span data-wx-since="${w.sinceMs}">${elapsedLabel(Date.now() - w.sinceMs)}</span>` : '';
  const radar = w.kind === 'called' ? '' : _radarSlot(game);
  return `<div class="lgv-wx-banner lgv-wx-${w.kind}">
      <div class="lgv-wx-title">${_escape(w.title)}${clock}</div>
      <div class="lgv-wx-sub">${_escape(w.sub)}</div>
    </div>${radar}`;
}

function _renderLiveGameCard(game, state, view = null, ds = null, footer = '') {
  view = view || _userView(state, game);
  ds   = ds   || _deriveGameState(game);
  // Away always top, home always bottom
  const { awayFull, homeFull, awayAbbr, homeAbbr, awayIsUser, homeIsUser } = view;

  return `
    <div class="live-game-wrap" id="live-game-wrap">
      <div class="live-score-header">
        <div class="live-teams">
          <div class="live-team-row">
            <span class="live-team-name${awayIsUser ? ' our-team' : ''}">${_escape(awayFull)}</span>
            <span class="live-score-val" id="lgv-away-score">${ds.awayScore}</span>
          </div>
          <div class="live-team-row">
            <span class="live-team-name${homeIsUser ? ' our-team' : ''}">${_escape(homeFull)}</span>
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
        ${_renderLinescore({ ...ds, isHome: view.userIsHome }, awayAbbr, homeAbbr)}
      </div>
      <div id="lgv-wx">${_wxBanner(game, ds)}</div>
      ${footer}
      ${_crowdLine(game, ds)}

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
        <div id="lgv-box">${_renderBoxScore(ds, game, state, view.names)}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// LINESCORE
// ─────────────────────────────────────────────────────────────

function _renderLinescore(ds, awayAbbr, homeAbbr) {
  const { awayRunsByInn, homeRunsByInn, maxInning,
    awayScore, homeScore, curInning, curHalf, isFinal, isHome,
    awayHits = 0, homeHits = 0, awayErrors = 0, homeErrors = 0 } = ds;

  // Fall back to US/OPP if abbrs not passed
  const awayLabel = awayAbbr || 'AWAY';
  const homeLabel = homeAbbr || 'HOME';

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
          <th class="ls-total-head">H</th>
          <th class="ls-total-head ls-err-head">E</th>
        </tr></thead>
        <tbody>
          <tr>
            <td class="ls-team${awayUserCls}">${_escape(awayLabel)}</td>
            ${awayRow}
            <td class="ls-total${awayScore > homeScore && isFinal ? ' ls-winner' : ''}">${awayScore}</td>
            <td class="ls-total">${awayHits}</td>
            <td class="ls-total ls-err${awayErrors > 0 ? ' ls-has-err' : ''}">${awayErrors}</td>
          </tr>
          <tr>
            <td class="ls-team${homeUserCls}">${_escape(homeLabel)}</td>
            ${homeRow}
            <td class="ls-total${homeScore > awayScore && isFinal ? ' ls-winner' : ''}">${homeScore}</td>
            <td class="ls-total">${homeHits}</td>
            <td class="ls-total ls-err${homeErrors > 0 ? ' ls-has-err' : ''}">${homeErrors}</td>
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
  const fill = b => on(b) ? 'var(--text)' : 'transparent';
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
  groundout:'▲', flyout:'▲',
  double_play:'▲▲', fielders_choice:'FC', sac_fly:'SF', sac_bunt:'SB',
  error:'E', stolen_base:'SB', caught_stealing:'CS',
  pitching_change:'🔄', pinch_hit:'🔁',
  game_start: '⚾',
  weather_delay:'⏸', weather_resume:'▶', game_suspended:'⏸', game_resumed:'▶',
};

function _pbpPlayHtml(play) {
  if (!play.description) return ''; // guard against empty/dash plays
  const icon = _PBP_ICONS[play.type] || '·';
  const cls  = play.type === 'hr'     ? 'pbp-play pbp-homer'
             : ['single','double','triple'].includes(play.type) ? 'pbp-play pbp-hit'
             : play.type === 'pitching_change' || play.type === 'pinch_hit' ? 'pbp-play pbp-pitching'
             : play.type === 'game_start' ? 'pbp-play pbp-pitching'
             : ['weather_delay', 'weather_resume', 'game_suspended', 'game_resumed'].includes(play.type) ? 'pbp-play pbp-weather'
             : 'pbp-play';
  return `<div class="${cls}" data-play-idx="${play.playIndex}">
    <div class="pbp-play-icon">${icon}</div>
    <div class="pbp-play-text">${_escape(play.description)}</div>
  </div>`;
}

function _innSuffix(n) {
  const i = parseInt(n);
  if (!i) return 'th';
  if (i === 1) return 'st';
  if (i === 2) return 'nd';
  if (i === 3) return 'rd';
  return 'th';
}

function _innHeader(half, inning) {
  const hw = half === 'TOP' ? '▲ TOP' : '▼ BOT';
  return `${hw} ${inning}${_innSuffix(inning)}`;
}

function _renderPBPFeed(ds) {
  if (ds.pbpPlays.length === 0) {
    return `<div class="pbp-empty">${ds.isFinal ? 'Final — the box score has the whole game.' : 'Game in progress…'}</div>`;
  }
  const lines = [];
  let lastKey = null;
  for (const play of ds.pbpPlays) {
    const key = `${play.half}_${play.inning}`;
    if (key !== lastKey) {
      lines.push(`<div class="pbp-inning-label" data-inn="${key}">${_innHeader(play.half, play.inning)}</div>`);
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
    const hdr = document.createElement('div');
    hdr.className    = 'pbp-inning-label';
    hdr.dataset.inn  = key;
    hdr.textContent  = _innHeader(play.half, play.inning);
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

// ─────────────────────────────────────────────────────────────
// BOX SCORE RENDERER
// ─────────────────────────────────────────────────────────────

function _renderBoxScore(ds, game, state, names = null) {
  if (!state) state = StateManager.get();
  const players = state?.players || {};

  // Live box from the SAME accumulator as the committed box + season stats
  // (revealed plays only). Both teams, full 9-man lineup seeded from first pitch,
  // runs and steals included. Falls back to the stored box once plays are gone.
  const revealed = (game.plays || []).slice(0, game.livePlayIndex || 0);
  let box = game.boxScore;
  if (revealed.length) {
    box = accumulateBox(revealed, players, {
      awayOrder:  game.liveLineups?.away || [],
      homeOrder:  game.liveLineups?.home || [],
      userIsHome: !!game.isHome,
      homeIds:    game.liveLineups?.homeIds || null,
    });
  }
  if (!box || !box.away || !box.home) {
    return '<div style="padding:16px;color:var(--muted);font-size:12px;">Stats appear as plays are revealed.</div>';
  }

  return renderBoxScore(box, names || _userView(state, game).names);
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
        ${lastGame.result === 'win' ? 'W' : lastGame.result === 'tie' ? 'T' : 'L'}
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
        ${_ngcNotes(game, state)}
        ${_ngcForecast(game, state)}
        ${lastBadge}
      </div>
      <div class="ngc-right"><button type="button" class="ngc-radar" hidden>Radar</button></div>
    </div>`;
}

/**
 * §102.7 the next game's forecast, one line (the same numbers the forecast
 * sheet and the schedule show): drawn from what's already worked out for this
 * forecast hour, or filled in by the forecast worker a moment later. Tap for
 * the forecast sheet. Only for a game that hasn't started.
 */
function _ngcForecast(game, state) {
  if (!game || game._committed || game.status !== GAME_STATUS.SCHEDULED || !(game.gameTime > Date.now())) return '';
  const f = peekGameForecast(state, game);
  return `<button type="button" class="ngc-fc" id="ngc-fc">${f ? _escape(forecastLine(f)) : 'Forecast…'}</button>`;
}

/** Fill in the forecast line (and remember the forecast hour it's from). */
function _fillForecast(state) {
  const el = document.getElementById('ngc-fc');
  if (!el) return;
  const game = _getNextGame(state);
  if (!game) return;
  const now = Date.now();
  _fcHour = Math.floor(now / 3_600_000);
  el.onclick = (e) => { e.stopPropagation(); App.playClick(); openForecastSheet({ state: StateManager.get(), game }); };
  gameForecastFor(state, game, now).then(f => {
    const cur = document.getElementById('ngc-fc');
    if (cur && _getNextGame(StateManager.get()) === game) { cur.textContent = forecastLine(f); _fitRadar(); }
  }).catch(err => console.warn('[forecast]', err));
}

/** §102.4 a makeup, a doubleheader game, a suspended game picking up. */
function _ngcNotes(game, state) {
  const siblings = (state.schedule || []).filter(g => g !== game && g.date === game.date && !g.cancelled);
  const notes = gameNotes(game, siblings);
  return notes.length ? `<div class="ngc-notes">${notes.map(n => _escape(n)).join(' · ')}</div>` : '';
}

// ─────────────────────────────────────────────────────────────
// FIRST PITCH COUNTDOWN
// ─────────────────────────────────────────────────────────────

function _renderFirstPitchCountdown(game) {
  if (!game || game._committed) return '';
  const now      = Date.now();
  const gameTime = game.gameTime;
  if (!gameTime) return '';

  // §102.4 the weather is holding up first pitch.
  if (game.status === GAME_STATUS.DELAYED) {
    const w = wxState(game, []);
    return `<div class="fp-card fp-delay" id="fp-card">
      <div class="fp-label">${_escape(w.title || 'Start delayed')}</div>
      <div class="fp-time"><span data-wx-since="${gameTime}">${elapsedLabel(now - gameTime)}</span></div>
      <div class="fp-sub">${_escape(w.sub || '')}</div>
    </div>`;
  }

  if (now >= gameTime) {
    return `<div class="fp-card fp-hot" id="fp-card">
      <div class="fp-label">GAME IS LIVE</div>
      <div class="fp-time" id="fp-time">LIVE</div>
      <div class="fp-sub">Updates every 5 seconds</div>
    </div>`;
  }

  const diffMs   = gameTime - now;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.ceil(diffMs / 60000);   // round up — matches _startCountdown
  const hours    = Math.floor(diffMins / 60);
  const mins     = diffMins % 60;

  const timeStr = diffMs < 60000 ? `${diffSecs}s`
    : hours > 0 ? `${hours}h ${mins > 0 ? mins + 'm' : ''}`
    : `${diffMins}m`;

  const fpCls = diffMs < 60000 ? 'fp-hot' : diffMs < 300000 ? 'fp-warm' : '';

  return `<div class="fp-card ${fpCls}" id="fp-card">
    <div class="fp-label">First Pitch</div>
    <div class="fp-time" id="fp-time">${timeStr}</div>
    <div class="fp-sub">${game.isHome ? 'vs' : '@'} ${_escape(game.opponent || '')}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// SEASON DONE
// ─────────────────────────────────────────────────────────────

function _renderSeasonDoneCard(state) {
  // Between seasons the offseason card says where the league calendar is (§70).
  if (state.offseason) return renderOffseasonCard(state);
  // No game of ours is scheduled: say where the season stands (§68).
  const wins   = state.userTeam?.wins   || 0;
  const losses = state.userTeam?.losses || 0;
  const b      = state.playoffBracket;
  const phase  = state.phase;
  const ROUND  = { WILD_CARD: 'Wild Card', FIRST_ROUND: 'First Round', DIVISION_SERIES: 'Division Series', WORLD_SERIES: 'World Series' };
  const series = b ? ['WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES']
    .flatMap(r => r === 'WORLD_SERIES' ? b.WORLD_SERIES.series : [...b.divA[r].series, ...b.divB[r].series]) : [];
  const lostIn = series.find(x => x.status === 'final'
    && ((x.winner === 'A' ? x.teamB : x.teamA)?.id === 'user'));
  const champ  = b?.champion;

  let title, line;
  if (!b && ['REGULAR_SEASON', 'ALL_STAR_BREAK', 'TRADE_DEADLINE'].includes(phase)) {
    title = 'Regular season complete';
    line  = `${wins}–${losses}. The bracket is set when the league's last games are final.`;
  } else if (champ) {
    title = champ.id === 'user' ? 'World Series Champions 🏆' : 'Season complete';
    line  = champ.id === 'user' ? `${wins}–${losses} in the regular season — and the last team standing.`
                                : `The ${_escape(champ.name)} won the World Series.`;
  } else if (lostIn) {
    title = `Eliminated in the ${ROUND[lostIn.round]}`;
    line  = 'The playoffs go on — follow the games below or in League → Playoffs.';
  } else if (b) {
    title = 'Through to the next round';
    line  = 'The next round starts once the other series are decided.';
  } else {
    title = 'Season complete';
    line  = `${wins}–${losses} final record`;
  }
  return `<div class="next-game-card">
    <div class="ngc-info">
      <div class="ngc-opp" style="font-size:16px;font-weight:700;">${title}</div>
      <div class="ngc-loc">${line}</div>
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
      <span class="hot-cold-name">${_escape(player.name)}</span>
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


/** Real-time label for a feed entry (the league runs on the real clock). */
function _agoText(ms) {
  if (!Number.isFinite(ms)) return '';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1)  return 'now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24)    return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/**
 * §86 Recent — the league's latest, text only. Collapsed it is one line (the
 * newest entry); a tap opens the list. Kept short so the dashboard doesn't scroll.
 */
let _recentOpen = false;
const RECENT_SHOWN = 12;
function _renderActivityFeed(state) {
  const feed = (state.activityFeed || []).slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-RECENT_SHOWN).reverse();
  if (!feed.length) return '';
  const row = (e) => `<div class="recent-row"><span class="recent-text">${_escape(e.text || '')}</span><span class="recent-time">${_agoText(e.timestamp)}</span></div>`;
  return `<div class="recent-wrap${_recentOpen ? ' open' : ''}" id="recent-wrap">
    <button class="recent-head" id="recent-toggle" aria-expanded="${_recentOpen}">
      <span class="recent-label">Recent</span>
      <span class="recent-latest">${_recentOpen ? '' : _escape(feed[0].text || '')}</span>
      <span class="recent-more">${_recentOpen ? 'Less' : 'More'}</span>
    </button>
    ${_recentOpen ? `<div class="recent-list">${feed.map(row).join('')}</div>` : ''}
  </div>`;
}

function _wireRecent() {
  document.getElementById('recent-toggle')?.addEventListener('click', () => {
    _recentOpen = !_recentOpen;
    const wrap = document.getElementById('recent-wrap');
    const st = StateManager.get();
    if (wrap && st) { wrap.outerHTML = _renderActivityFeed(st); _wireRecent(); }
    _syncScrollRoom();
  });
}

/**
 * §93 the dashboard only scrolls when it has to. With no game in progress
 * and Recent collapsed, nothing trails the last card (no bottom padding or
 * margin), so a dashboard that fits the screen doesn't scroll by those few
 * pixels. A live game or an open Recent list gets its room back. (A screen
 * too short for the cards still scrolls — nothing is ever cut off.)
 */
function _syncScrollRoom() {
  const tab = document.getElementById('tab-dashboard');
  if (!tab) return;
  const live = !!document.querySelector('#dashboard-content .live-game-wrap');
  tab.classList.toggle('dash-idle', !live && !_recentOpen);
  _fitRadar();
}

/**
 * §100 The radar takes the room the idle dashboard has (it doesn't scroll):
 * full height when it fits, shorter on shorter screens; with too little room
 * the card steps aside and the next-game card shows a Radar button instead.
 */
function _fitRadar() {
  const tab = document.getElementById('tab-dashboard');
  if (!_radar || !tab || !_radar.root.isConnected) return;
  let hidden = _radar.setMapHeight(RADAR_MAP_H);
  if (tab.classList.contains('dash-idle')) {
    const over = tab.scrollHeight - tab.clientHeight;
    if (over > 0) hidden = _radar.setMapHeight(RADAR_MAP_H - over);
  }
  document.querySelectorAll('#dashboard-content .ngc-radar').forEach(b => { b.hidden = !hidden; });
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

let _leagueTimer = null;
/**
 * §102.4 Every 5 seconds: the delay clocks move, and if our next game's
 * status or time changed without a play (a start held up, a postponement, a
 * suspended game's turn) the dashboard redraws.
 */
function _wxPulse() {
  const now = Date.now();
  document.querySelectorAll('#dashboard-content [data-wx-since]').forEach(el => {
    el.textContent = elapsedLabel(now - Number(el.dataset.wxSince));
  });
  const st = StateManager.get();
  const g = st ? _getNextGame(st) : null;
  const sig = g ? `${g.index}|${g.date}|${g.gameTime}|${g.status}|${g.opponent}` : 'none';
  if (_wxSig !== null && sig !== _wxSig && !_asgMode) { _wxSig = sig; refresh(); return; }
  _wxSig = sig;
  // §102.7 a new hourly forecast: the next game's line is worked out again.
  if (_fcHour !== null && Math.floor(now / 3_600_000) !== _fcHour && document.getElementById('ngc-fc')) _fillForecast(st);
}

function _refreshLeagueRow() {
  updateOffseasonCountdown();
  _refreshAllStar();
  _wxPulse();
  const el = document.getElementById('dash-league-live');
  const st = StateManager.get();
  if (!el || !st) return;
  el.innerHTML = renderLeagueLiveRow(st);
  wireLeagueGameTaps(el);
}

function _attachListeners(state) {
  wireLeagueGameTaps(document.getElementById('dash-league-live'));
  _wireRecent();
  // §95 the Rating card opens the club's rating over time.
  document.getElementById('dash-rating-card')?.addEventListener('click', async () => {
    const { openRatingHistory } = await import('../components/RatingHistory.js');
    openRatingHistory(StateManager.get());
    App.playSoundOpen();
  });
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
        const st  = StateManager.get();
        const box = document.getElementById('lgv-box');
        const asg = _asgMode ? allStarFeature(st, _getNextGame(st)) : null;
        if (asg && box) {
          const view = allStarView(st, asg.game);
          const like = asg.game.played ? { ...asg.game, isHome: true } : allStarGameLike(asg.game);
          box.innerHTML = _renderBoxScore(asg.game.played ? allStarFinalDs(asg.game, view) : _deriveGameState(like), like, st, view.names);
        } else {
          const liveGame = _getNextGame(st);
          if (liveGame && box) box.innerHTML = _renderBoxScore(_deriveGameState(liveGame), liveGame, st);
        }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────



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
    .live-team-name.our-team{color:var(--text);}
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
    .pbp-play.pbp-weather .pbp-play-text{color:#f97316;font-weight:600;}
    .lgv-wx-line{font-size:11px;color:var(--muted);padding:6px 14px 0;}
    .lgv-wx-banner{margin:8px 12px 4px;padding:8px 10px;border-radius:10px;border:1px solid rgba(249,115,22,.35);background:rgba(249,115,22,.08);}
    .lgv-wx-banner.lgv-wx-called{border-color:var(--border);background:var(--surface2, rgba(127,127,127,.08));}
    .lgv-wx-title{font-size:12px;font-weight:800;color:#f97316;letter-spacing:.3px;}
    .lgv-wx-called .lgv-wx-title{color:var(--text);}
    .lgv-wx-sub{font-size:11px;color:var(--soft);margin-top:2px;line-height:1.35;}
    #lgv-wx #dash-radar-slot{margin:6px 12px 2px;}
    .ngc-fc{display:block;margin-top:3px;padding:0;border:0;background:none;font:inherit;font-size:11px;font-weight:700;color:#3b82f6;text-align:left;cursor:pointer;}
    .ngc-notes{font-size:10px;font-weight:600;color:#f97316;margin-top:2px;}
    .fp-card.fp-delay .fp-label{color:#f97316;}
    .lgv-linescore-wrap{overflow-x:auto;padding:8px 16px;border-bottom:1px solid var(--border);}
    .lgv-crowd{font-size:11px;color:var(--muted);padding:6px 16px;border-bottom:1px solid var(--border);}
    .linescore-live table{width:100%;border-collapse:collapse;}
    .ls-inn-head{color:var(--muted);font-weight:600;text-align:center;min-width:18px;font-size:10px;padding:2px 3px;}
    .ls-inn-head.ls-active-head{color:var(--text);}
    .ls-team-head{min-width:28px;}
    .ls-total-head{border-left:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:700;text-align:center;padding:2px 4px;}
    .ls-team{font-size:11px;font-weight:700;color:var(--text);padding-right:6px;white-space:nowrap;}
    .ls-team.ls-team-user{color:var(--text);}
    .ls-cell{text-align:center;font-size:11px;color:var(--muted);padding:2px 3px;}
    .ls-cell.ls-scoring{color:var(--text);font-weight:700;}
    .ls-cell.ls-active-cell{color:var(--text);font-weight:700;}
    .ls-total{border-left:1px solid var(--border);text-align:center;font-size:12px;font-weight:700;color:var(--text);padding:2px 4px;}
    .ls-total.ls-winner{color:var(--text);}
    .ls-err-head{color:var(--danger);opacity:.7;}
    .ls-err{color:var(--muted);}
    .ls-has-err{color:var(--danger) !important;}
    .live-tabs{display:flex;border-bottom:1px solid var(--border);}
    .live-tab{flex:1;text-align:center;padding:8px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text);opacity:.55;cursor:pointer;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s;}
    .live-tab.active{color:var(--text);opacity:1;border-bottom-color:var(--text);}
    .live-tab-content{display:none;}
    .live-tab-content.active{display:block;}
    .pbp-feed{padding:10px 16px 12px;max-height:280px;overflow-y:auto;}
    .pbp-empty{padding:16px 0;color:var(--muted);font-size:13px;}
    .pbp-inning-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text);padding:10px 0 4px;}
    .pbp-play{display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);}
    .pbp-play:last-child{border-bottom:none;}
    .pbp-play-icon{font-size:12px;flex-shrink:0;width:16px;text-align:center;margin-top:1px;}
    .pbp-play-text{font-size:13px;color:var(--text);line-height:1.4;}
    .pbp-play.pbp-homer .pbp-play-text{color:var(--text);font-weight:700;}
    .pbp-play.pbp-hit .pbp-play-text{color:var(--text);}
    .pbp-play.pbp-pitching .pbp-play-text{font-style:italic;}
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
    .fp-card.fp-hot{background:rgba(240,82,82,.12);border-color:rgba(240,82,82,.4);animation:fp-pulse 1s ease-in-out infinite;}
    @keyframes fp-pulse{0%,100%{border-color:rgba(240,82,82,.4);}50%{border-color:rgba(240,82,82,.9);box-shadow:0 0 8px rgba(240,82,82,.3);}}
    .fp-label{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}
    .fp-time{font-family:'Bebas Neue',sans-serif;font-size:40px;line-height:1;color:var(--text);}
    .fp-card.fp-warm .fp-time{color:#f97316;}
    .fp-card.fp-hot  .fp-time{color:var(--danger);}
    .fp-sub{font-size:10px;color:var(--muted);margin-top:2px;}
    #tab-dashboard.dash-idle{padding-bottom:0;}
    .ngc-radar{font:inherit;font-size:13px;font-weight:700;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:7px 12px;cursor:pointer;}
    .ngc-radar[hidden]{display:none;}
    #tab-dashboard.dash-idle .recent-wrap{margin-bottom:0;}
    .recent-wrap{margin:8px 16px 16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow:hidden;}
    .recent-head{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;background:none;border:0;color:var(--text);font-family:inherit;text-align:left;cursor:pointer;}
    .recent-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);flex-shrink:0;}
    .recent-latest{flex:1;min-width:0;font-size:12px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .recent-more{font-size:11px;font-weight:600;color:var(--muted);flex-shrink:0;}
    .recent-list{border-top:1px solid var(--border);max-height:260px;overflow-y:auto;}
    .recent-row{display:flex;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);}
    .recent-row:last-child{border-bottom:none;}
    .recent-text{flex:1;font-size:12px;color:var(--soft);line-height:1.4;}
    .recent-time{font-size:10px;color:var(--muted);flex-shrink:0;white-space:nowrap;}
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
