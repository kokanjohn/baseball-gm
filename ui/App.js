/**
 * ui/App.js
 * Root app shell. Mounts on DOMContentLoaded.
 *
 * Owns:
 *   - Bottom nav tab switching
 *   - Theme + team color initialization and persistence
 *   - Milestone screen routing (blocks tab switching while active)
 *   - Active slot loading and per-slot state application
 *   - EventBus wiring for cross-screen events
 *   - PWA install prompt handling
 *
 * Does NOT own:
 *   - Game logic (GameEngine owns that)
 *   - Card delivery (CardEngine owns that)
 *   - Screen rendering (each screen module owns its own render)
 *
 * Tab IDs match v1 exactly:
 *   dashboard → #tab-dashboard
 *   decisions → #tab-decisions   (Inbox)
 *   roster    → #tab-roster      (Team)
 *   league    → #tab-league
 *   schedule  → #tab-schedule
 */

import * as EventBus  from './EventBus.js';
import * as StateManager from '../store/StateManager.js';
import { applyTheme, applyTeamColors } from './formatters.js';
import { TICK_INTERVAL_MS, GAME_STATUS } from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// TAB STATE
// ─────────────────────────────────────────────────────────────

let _activeTab       = 'dashboard';
let _milestoneActive = false;
let _tickInterval    = null;   // Section 8.4 — App.js owns the tick interval

// Tab → inner reset functions registered by each screen on mount
const _tabResetFns = {};

/**
 * registerTabReset(tab, fn)
 * Called by screen modules to register a reset function that fires
 * when the user navigates to that tab. Keeps each screen's reset
 * logic owned by the screen, not App.js.
 *
 * @param {String}   tab  — e.g. 'roster', 'league'
 * @param {Function} fn
 */
export function registerTabReset(tab, fn) {
  _tabResetFns[tab] = fn;
}

// ─────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────

/**
 * switchTab(tab)
 * Activates a bottom nav tab. Blocked while a milestone screen is showing.
 * Mirrors v1 switchTab() but wired to EventBus instead of inline renders.
 *
 * @param {String} tab  — 'dashboard'|'decisions'|'roster'|'league'|'schedule'
 */
export function switchTab(tab) {
  if (_milestoneActive) return;

  // Deactivate all tab content panels and nav buttons
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  // Activate target panel
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.classList.add('active');

  // Activate nav button
  const navBtn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Update active tab
  _activeTab = tab;

  // Run screen-specific reset if registered
  if (_tabResetFns[tab]) {
    try { _tabResetFns[tab](); }
    catch (err) { console.error(`App.switchTab: reset error on '${tab}':`, err); }
  }

  // Inbox: default to To Do tab unless Completed is open by user intent
  if (tab === 'decisions') {
    EventBus.emit('nav:tabActivated', { tab: 'decisions' });
  }

  // Update inbox badge visibility
  _updateInboxBadge();
}

/**
 * getActiveTab()
 * @returns {String}
 */
export function getActiveTab() {
  return _activeTab;
}

// ─────────────────────────────────────────────────────────────
// MILESTONE SCREEN ROUTING
// ─────────────────────────────────────────────────────────────

/**
 * showMilestone(milestoneId)
 * Displays a milestone screen overlay, blocking all tab navigation.
 * Emits 'nav:milestone' for MilestoneScreen.js to render.
 *
 * @param {String} milestoneId
 */
export function showMilestone(milestoneId) {
  _milestoneActive = true;
  const overlay = document.getElementById('milestone-overlay');
  if (overlay) overlay.classList.add('active');
  EventBus.emit('nav:milestone', { milestoneId });
}

/**
 * clearMilestone()
 * Dismisses the milestone screen and resumes normal navigation.
 * Called by MilestoneScreen when user taps Continue.
 */
export function clearMilestone() {
  _milestoneActive = false;
  const overlay = document.getElementById('milestone-overlay');
  if (overlay) overlay.classList.remove('active');
  EventBus.emit('nav:milestoneCleared');
}

// ─────────────────────────────────────────────────────────────
// INBOX BADGE
// ─────────────────────────────────────────────────────────────

function _updateInboxBadge() {
  const state = StateManager.get();
  const count = (state.inbox || []).filter(c => !c.resolved).length;
  const badge = document.getElementById('inbox-badge');
  if (!badge) return;
  badge.textContent = count > 0 ? String(Math.min(count, 99)) : '0';
  badge.classList.toggle('visible', count > 0);
}

// ─────────────────────────────────────────────────────────────
// THEME + COLOR INITIALIZATION
// ─────────────────────────────────────────────────────────────

/**
 * initThemeAndColors(settings)
 * Applies theme and team colors from the active slot's settings.
 * Called at startup and whenever the active slot changes.
 *
 * Also sets up the system theme change listener for 'auto' mode.
 *
 * @param {Object} settings  — state.settings
 */
export function initThemeAndColors(settings) {
  const theme     = settings?.theme          || 'dark';
  const primary   = settings?.primaryColor   || 'gold';
  const secondary = settings?.secondaryColor || 'green';

  applyTheme(theme, primary, secondary);

  // Watch for OS-level dark/light changes when in auto mode
  _watchSystemTheme(theme, primary, secondary);
}

let _systemThemeMediaQuery = null;
let _systemThemeListener   = null;

function _watchSystemTheme(theme, primary, secondary) {
  // Remove any existing listener
  if (_systemThemeMediaQuery && _systemThemeListener) {
    _systemThemeMediaQuery.removeEventListener('change', _systemThemeListener);
  }

  if (theme !== 'auto') return;

  _systemThemeMediaQuery  = window.matchMedia('(prefers-color-scheme: dark)');
  _systemThemeListener    = () => applyTheme('auto', primary, secondary);
  _systemThemeMediaQuery.addEventListener('change', _systemThemeListener);
}

// ─────────────────────────────────────────────────────────────
// HEADER UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * updateHeader(state)
 * Refreshes the persistent header: team name, season/game info,
 * prestige tier badge, and budget pill.
 *
 * @param {Object} state
 */
export function updateHeader(state) {
  if (!state) return;

  const { formatMoney, formatPhaseLabel } = _lazyFormatters();

  const teamName   = _el('head-team-name');
  const seasonEl   = _el('head-season');
  const tierEl     = _el('head-tier');
  const budgetEl   = _el('head-budget');
  const badgeDiamond = document.querySelector('.badge-diamond');

  if (teamName) {
    const city     = state.userTeam?.city     || '';
    const nickname = state.userTeam?.nickname || '';
    teamName.textContent = `${city} ${nickname}`.trim() || '—';
  }

  if (seasonEl) {
    const gameIdx = state.currentGameIndex || 0;
    const phase   = formatPhaseLabel(state.phase);
    seasonEl.textContent = `S${state.seasonNum || 1} · ${phase} · G${gameIdx + 1}`;
  }

  if (tierEl) {
    const tier     = state.prestigeTier || 1;
    const TIER_NAMES = ['', 'Cellar Dweller', 'Fringe Contender',
      'Established Franchise', 'Perennial Contender', 'Dynasty'];
    tierEl.textContent = TIER_NAMES[tier] || '';
    tierEl.className   = `tier-badge t${tier}`;
  }

  if (budgetEl) {
    const remaining = (state.userTeam?.finances?.operatingBudget || 0)
                    - (state.userTeam?.finances?.operatingSpent  || 0);
    budgetEl.textContent = formatMoney(remaining);
  }

  // Update team icon and badge background with primary team color
  if (badgeDiamond) {
    const primaryHex = document.documentElement.style.getPropertyValue('--accent') || '#F5D253';
    badgeDiamond.style.background = primaryHex;
    if (state.userTeam?.icon) {
      badgeDiamond.textContent = state.userTeam.icon;
    }
  }

  _updateInboxBadge();
}

// ─────────────────────────────────────────────────────────────
// APP INITIALIZATION
// ─────────────────────────────────────────────────────────────

/**
 * init()
 * Main entry point. Called once on DOMContentLoaded.
 * Wires EventBus listeners, loads active slot, applies theme/colors.
 */
export async function init() {
  // Wire EventBus listeners
  EventBus.on('card:delivered',      () => _updateInboxBadge());
  EventBus.on('card:resolved',       () => _updateInboxBadge());
  EventBus.on('game:committed',      (payload) => _onGameCommitted(payload));
  EventBus.on('game:phaseChanged',   (payload) => _onPhaseChanged(payload));
  EventBus.on('settings:themeChanged', (payload) => {
    const state = StateManager.get();
    initThemeAndColors({
      ...state.settings,
      theme: payload.theme,
    });
  });
  EventBus.on('settings:colorChanged', (payload) => {
    const state = StateManager.get();
    applyTeamColors(payload.primary, payload.secondary, state.settings?.theme);
  });

  // Load active slot (restores previous session if one exists)
  const hasSlot = await StateManager.init();

  if (!hasSlot) {
    // No saved game — show setup screen
    _showScreen('setup');
    const { mount: mountSetup } = await import('./screens/SetupScreen.js');
    mountSetup();
    return;
  }

  const state = StateManager.get();

  if (!state || !state.phase) {
    // Slot loaded but state is invalid — show setup screen
    _showScreen('setup');
    const { mount: mountSetup } = await import('./screens/SetupScreen.js');
    mountSetup();
    return;
  }

  // Apply theme + colors from loaded state
  initThemeAndColors(state.settings);

  // Update header
  updateHeader(state);

  // Show main app shell
  _showScreen('app');

  // Wire settings gear button — opens the settings modal
  const gearBtn       = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');

  if (gearBtn && settingsModal) {
    gearBtn.addEventListener('click', () => {
      settingsModal.classList.add('open');
      // Re-populate swatches with current colors every time settings opens
      _refreshSettingsSwatches();
    });
  }
  if (settingsClose && settingsModal) {
    settingsClose.addEventListener('click', () => {
      settingsModal.classList.remove('open');
    });
  }
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) settingsModal.classList.remove('open');
    });
  }

  // Wire Franchise Story button in settings
  document.getElementById('history-open-btn')
    ?.addEventListener('click', async () => {
      settingsModal?.classList.remove('open');
      const { openHistory } = await import('./screens/HistoryScreen.js');
      openHistory();
    });

  // Wire install button in settings
  document.getElementById('pwa-install-btn')
    ?.addEventListener('click', () => {
      triggerInstallPrompt();
      settingsModal?.classList.remove('open');
    });

  // Wire New / Switch Team button
  document.getElementById('settings-reset-row')
    ?.addEventListener('click', async () => {
      settingsModal?.classList.remove('open');
      await _openTeamSelect();
    });

  // Wire settings pickers (listeners only — swatches populated on open)
  _initSettingsPickers();

  // Wire debug panel — long-press (700ms) on the version string in settings
  // Hidden from users; no visible affordance.
  let _debugPressTimer = null;
  const versionEl = settingsModal?.querySelector('[data-debug-trigger]')
    || Array.from(settingsModal?.querySelectorAll('div') || [])
         .find(el => el.textContent.includes('The Front Office — v2'));

  if (versionEl) {
    versionEl.addEventListener('pointerdown', () => {
      _debugPressTimer = setTimeout(async () => {
        settingsModal?.classList.remove('open');
        const { openDebug } = await import('./screens/DebugScreen.js');
        openDebug();
      }, 700);
    });
    versionEl.addEventListener('pointerup',    () => clearTimeout(_debugPressTimer));
    versionEl.addEventListener('pointerleave', () => clearTimeout(_debugPressTimer));
  }

  // ── Mount all screens ──────────────────────────────────────────────────
  // Each screen module registers itself with registerTabReset on mount.
  // Must happen before switchTab() is called.
  const [
    { mount: mountDashboard },
    { mount: mountInbox     },
    { mount: mountTeam      },
    { mount: mountLeague    },
    { mount: mountSchedule  },
  ] = await Promise.all([
    import('./screens/DashboardScreen.js'),
    import('./screens/InboxScreen.js'),
    import('./screens/TeamScreen.js'),
    import('./screens/LeagueScreen.js'),
    import('./screens/ScheduleScreen.js'),
  ]);

  mountDashboard();
  mountInbox();
  mountTeam();
  mountLeague();
  mountSchedule();

  // Navigate to dashboard by default
  switchTab('dashboard');

  // Start the tick loop (Section 8.4 — owns the game tick interval)
  startTick();

  EventBus.emit('app:ready', { state });
}

// ─────────────────────────────────────────────────────────────
// SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────────

function _showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${screenId}`);
  if (target) target.classList.add('active');
}

// ─────────────────────────────────────────────────────────────
// GAME EVENT HANDLERS
// ─────────────────────────────────────────────────────────────

function _onGameCommitted({ result, gameIndex } = {}) {
  const state = StateManager.get();
  updateHeader(state);

  // Check if a milestone should fire
  const milestone = state.pendingMilestone;
  if (milestone) {
    StateManager.mutate(s => { s.pendingMilestone = null; });
    showMilestone(milestone);
  }
}

function _onPhaseChanged({ from, to } = {}) {
  updateHeader(StateManager.get());
}

// ─────────────────────────────────────────────────────────────
// PWA INSTALL PROMPT
// ─────────────────────────────────────────────────────────────

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Show install button if it exists in the settings screen
  const installBtn = document.getElementById('pwa-install-btn');
  if (installBtn) installBtn.classList.remove('hidden');
});

/**
 * triggerInstallPrompt()
 * Called by the Settings screen "Add to Home Screen" button.
 */
export function triggerInstallPrompt() {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  _deferredInstallPrompt.userChoice.then(() => {
    _deferredInstallPrompt = null;
  });
}

// ─────────────────────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

let _toastTimer = null;

/**
 * showToast(message, type?, duration?)
 * Shows a brief toast notification at the bottom of the screen.
 *
 * @param {String} message
 * @param {String} [type]      — 'positive'|'negative'|'neutral' (default 'neutral')
 * @param {Number} [duration]  — ms (default 3500)
 */
export function showToast(message, type = 'neutral', duration = 3500) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  clearTimeout(_toastTimer);
  toast.textContent = message;
  toast.className   = `show ${type}`;

  _toastTimer = setTimeout(() => {
    toast.className = '';
    toast.textContent = '';
  }, duration);

  toast.onclick = () => {
    clearTimeout(_toastTimer);
    toast.className   = '';
    toast.textContent = '';
    toast.onclick     = null;
  };
}

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────

function _el(id) {
  return document.getElementById(id);
}

// Lazy import formatters to avoid circular dependency issues
// (formatters.js imports constants; App.js imports formatters —
//  this is fine as long as we don't create a circular loop with StateManager)
let _formatters = null;
function _lazyFormatters() {
  if (!_formatters) {
    // These are synchronously available after the module graph resolves
    _formatters = { formatMoney, formatPhaseLabel };
  }
  return _formatters;
}

// Direct imports for use in updateHeader (avoid the lazy wrapper for these)
import { formatMoney, formatPhaseLabel } from './formatters.js';

// ─────────────────────────────────────────────────────────────
// TICK LOOP (Section 8.4 — LOCKED)
// App.js owns the one tick interval for the entire app lifecycle.
// Started on init(), never stopped — cheap when no game is live.
// ─────────────────────────────────────────────────────────────

/**
 * startTick()
 * Starts the 5-second tick loop. Called once from init().
 * Safe to call multiple times — idempotent.
 */
export function startTick() {
  if (_tickInterval) return;

  _tickInterval = setInterval(async () => {
    // Lazy import to avoid circular dep at module load time
    const { tick, commitGame } = await import('../engine/GameEngine.js');
    const state   = StateManager.get();
    const gameIdx = state?.currentGameIndex ?? 0;
    const game    = state?.schedule?.[gameIdx];

    if (!game) return;

    // Reveal next play(s)
    const play = tick();
    if (play) {
      EventBus.emit('game:tick', { play, game: StateManager.get().schedule[gameIdx] });
    }

    // Auto-commit when game reaches FINAL
    if (game.status === GAME_STATUS.FINAL && !game._committed) {
      try {
        const result = await commitGame(gameIdx);
        EventBus.emit('game:committed', { result, gameIndex: gameIdx });
        if (result?.milestone) showMilestone(result.milestone);
      } catch (err) {
        console.error('App.startTick: auto-commit error:', err);
      }
    }
  }, TICK_INTERVAL_MS);
}

/**
 * _openTeamSelect()
 * Shows the Load or Start a Team screen (TeamSelectScreen).
 * Called from the Settings "New / Switch Team" button.
 */
async function _openTeamSelect() {
  _showScreen('setup');
  const { mount: mountTeamSelect } = await import('./screens/TeamSelectScreen.js');

  await mountTeamSelect(
    // onTeamLoaded — a different slot was loaded, go to dashboard
    async () => {
      const state = StateManager.get();
      if (!state) return;
      initThemeAndColors(state.settings);
      updateHeader(state);
      _showScreen('app');

      const [
        { mount: mountDashboard },
        { mount: mountInbox     },
        { mount: mountTeam      },
        { mount: mountLeague    },
        { mount: mountSchedule  },
      ] = await Promise.all([
        import('./screens/DashboardScreen.js'),
        import('./screens/InboxScreen.js'),
        import('./screens/TeamScreen.js'),
        import('./screens/LeagueScreen.js'),
        import('./screens/ScheduleScreen.js'),
      ]);
      mountDashboard();
      mountInbox();
      mountTeam();
      mountLeague();
      mountSchedule();
      switchTab('dashboard');
      startTick();
    },

    // onNewTeam — user wants to create a new team
    async () => {
      const { mount: mountSetup } = await import('./screens/SetupScreen.js');
      mountSetup();
    }
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — COLOR + THEME PICKERS (Phase 15)
// ─────────────────────────────────────────────────────────────

/**
// ─────────────────────────────────────────────────────────────
// AUDIO SYSTEM (ported from v1 Chapter 2)
// Web Audio API — all sounds generated procedurally, no files.
// ─────────────────────────────────────────────────────────────

let _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

/**
 * warmUpAudio()
 * Must be called from a user gesture (tap) before any sound plays.
 * Resumes a suspended AudioContext and primes it with a silent buffer.
 * Called by App on the first tap anywhere in the app.
 */
export function warmUpAudio() {
  try {
    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) {}
}

/**
 * playTone(freq, type, duration, vol, delay)
 * Plays a single synthesized tone. Respects soundEnabled and soundVolume.
 */
export function playTone(freq, type, duration, vol, delay = 0) {
  if (!_soundEnabled) return;
  try {
    const ctx  = _getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    const t = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol * _soundVolume, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  } catch (e) {}
}

/**
 * playClick()
 * Short noise burst for button taps. Matches v1 exactly.
 */
export function playClick() {
  if (!_soundEnabled) return;
  haptic(10);
  try {
    const ctx     = _getAudioCtx();
    const t       = ctx.currentTime;
    const bufSize = ctx.sampleRate * 0.08;
    const buf     = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data    = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    const bp   = ctx.createBiquadFilter();
    bp.type    = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 3.5;
    const ls   = ctx.createBiquadFilter();
    ls.type    = 'lowshelf';
    ls.frequency.value = 200;
    ls.gain.value = 6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.55 * _soundVolume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
    src.connect(bp); bp.connect(ls); ls.connect(gain); gain.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.08);
  } catch (e) {}
}

/** Win sound — ascending major triad */
export function playSoundWin() {
  haptic([15, 10, 20]);
  playTone(523,  'sine', 0.12, 0.18);
  playTone(659,  'sine', 0.12, 0.18, 0.10);
  playTone(784,  'sine', 0.14, 0.20, 0.20);
  playTone(1047, 'sine', 0.10, 0.22, 0.32);
}

/** Loss sound — descending minor drop */
export function playSoundLoss() {
  haptic([12]);
  playTone(494, 'sine',     0.14, 0.14);
  playTone(440, 'sine',     0.14, 0.13, 0.14);
  playTone(370, 'sine',     0.16, 0.12, 0.28);
  playTone(294, 'triangle', 0.18, 0.10, 0.42);
}

/** First pitch — celebratory ascending chime */
export function playSoundFirstPitch() {
  haptic([10, 20, 10, 20, 15]);
  playTone(523,  'sine', 0.13, 0.09);
  playTone(659,  'sine', 0.13, 0.09, 0.10);
  playTone(784,  'sine', 0.14, 0.10, 0.20);
  playTone(1047, 'sine', 0.18, 0.14, 0.32);
}

/** Positive action (card accept, trade success etc.) */
export function playSoundPositive() {
  haptic([15, 50, 25]);
  playTone(523, 'sine', 0.12, 0.12);
  playTone(659, 'sine', 0.12, 0.12, 0.10);
  playTone(784, 'sine', 0.18, 0.12, 0.20);
}

/** Negative action (card decline, error) */
export function playSoundNegative() {
  haptic([25, 40, 25]);
  playTone(330, 'sine', 0.14, 0.12);
  playTone(277, 'sine', 0.20, 0.12, 0.15);
}

/** Modal / sheet open */
export function playSoundOpen() {
  haptic(8);
  playTone(698, 'sine', 0.10, 0.07);
  playTone(880, 'sine', 0.10, 0.07, 0.08);
}

// Wire warmUpAudio to first user tap anywhere in the app
document.addEventListener('pointerdown', warmUpAudio, { once: true });

// ─────────────────────────────────────────────────────────────
// SETTINGS — DEVICE PREFERENCES (localStorage, not save-slot)
// ─────────────────────────────────────────────────────────────

let _soundEnabled   = localStorage.getItem('bgm_sound')   !== 'false';
let _soundVolume    = parseFloat(localStorage.getItem('bgm_volume')         || '0.5');
let _hapticEnabled  = localStorage.getItem('bgm_haptic')  !== 'false';
let _hapticIntensity = parseFloat(localStorage.getItem('bgm_haptic_intensity') || '0.5');

/**
 * haptic(pattern)
 * Fires vibration if enabled. Pattern is array of ms durations or single number.
 */
export function haptic(pattern) {
  if (!_hapticEnabled) return;
  try {
    if (!navigator.vibrate) return;
    const p = Array.isArray(pattern) ? pattern : [pattern];
    navigator.vibrate(p.map(v => Math.round(v * _hapticIntensity)));
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — REFRESH (called every time modal opens)
// ─────────────────────────────────────────────────────────────

/**
 * _refreshSettingsSwatches()
 * Called every time the settings modal opens.
 * Syncs all display values from current state + localStorage.
 */
function _refreshSettingsSwatches() {
  const state = StateManager.get();
  if (!state) return;

  // ── Team info ─────────────────────────────────────────────
  const teamNameEl = document.getElementById('settings-team-name');
  if (teamNameEl) {
    const city = state.userTeam?.city     || '';
    const nick = state.userTeam?.nickname || '';
    teamNameEl.textContent = `${city} ${nick}`.trim() || '—';
  }
  const seasonEl = document.getElementById('settings-season-val');
  if (seasonEl) seasonEl.textContent = `Season ${state.seasonNum || 1}`;

  // Close edit panel on open (stale state)
  const editPanel = document.getElementById('settings-team-edit-panel');
  if (editPanel) editPanel.style.display = 'none';

  // ── Color sliders ─────────────────────────────────────────
  const currentPrimary   = state.settings?.primaryColor   || '#F5D253';
  const currentSecondary = state.settings?.secondaryColor || '#22C55E';

  const primaryHueSlider   = document.getElementById('settings-primary-hue');
  const secondaryHueSlider = document.getElementById('settings-secondary-hue');
  const primarySwatch      = document.getElementById('settings-primary-swatch');
  const secondarySwatch    = document.getElementById('settings-secondary-swatch');

  if (primaryHueSlider) primaryHueSlider.value = _hexToHue(currentPrimary);
  if (secondaryHueSlider) secondaryHueSlider.value = _hexToHue(currentSecondary);
  if (primarySwatch)   primarySwatch.style.background   = currentPrimary;
  if (secondarySwatch) secondarySwatch.style.background = currentSecondary;

  _updateColorPreview(currentPrimary, currentSecondary);

  // ── Theme ─────────────────────────────────────────────────
  const currentTheme = state.settings?.theme || 'dark';
  document.querySelectorAll('.settings-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === currentTheme);
  });
  const themeValue = document.getElementById('settings-theme-value');
  if (themeValue) {
    themeValue.textContent = { dark: 'Dark', light: 'Light', auto: 'Auto' }[currentTheme] || 'Dark';
  }

  // ── Sound ─────────────────────────────────────────────────
  const soundToggle = document.getElementById('sound-toggle');
  if (soundToggle) soundToggle.checked = _soundEnabled;
  const volSlider = document.getElementById('vol-slider');
  if (volSlider) {
    volSlider.value    = Math.round(_soundVolume * 100);
    volSlider.disabled = !_soundEnabled;
  }
  const volRow = document.getElementById('vol-row');
  if (volRow) volRow.style.opacity = _soundEnabled ? '1' : '0.4';

  // ── Haptic ────────────────────────────────────────────────
  const hapticToggle = document.getElementById('haptic-toggle');
  if (hapticToggle) hapticToggle.checked = _hapticEnabled;
  const hapticSlider = document.getElementById('haptic-slider');
  if (hapticSlider) {
    hapticSlider.value    = Math.round(_hapticIntensity * 100);
    hapticSlider.disabled = !_hapticEnabled;
  }
  const hapticRow = document.getElementById('haptic-row');
  if (hapticRow) hapticRow.style.opacity = _hapticEnabled ? '1' : '0.4';

  // ── Notifications ─────────────────────────────────────────
  _refreshNotifStatus();

  // ── Quiet hours ───────────────────────────────────────────
  const qStart = document.getElementById('quiet-start');
  const qEnd   = document.getElementById('quiet-end');
  if (qStart) qStart.value = localStorage.getItem('bgm_quiet_start') || '22:00';
  if (qEnd)   qEnd.value   = localStorage.getItem('bgm_quiet_end')   || '08:00';

  // Always reset to main view
  document.getElementById('settings-view-main')?.classList.remove('tdm-view-hidden');
  document.getElementById('settings-view-teams')?.classList.add('tdm-view-hidden');
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — INIT (called once at app boot)
// ─────────────────────────────────────────────────────────────

/**
 * _initSettingsPickers()
 * Wires ALL settings event listeners. Called once during init().
 * Never called again — listeners persist on the DOM.
 */
function _initSettingsPickers() {
  // ── Sound toggle ──────────────────────────────────────────
  document.getElementById('sound-toggle')?.addEventListener('change', (e) => {
    _soundEnabled = e.target.checked;
    localStorage.setItem('bgm_sound', _soundEnabled ? 'true' : 'false');
    const volSlider = document.getElementById('vol-slider');
    const volRow    = document.getElementById('vol-row');
    if (volSlider) volSlider.disabled = !_soundEnabled;
    if (volRow)    volRow.style.opacity = _soundEnabled ? '1' : '0.4';
  });

  document.getElementById('vol-slider')?.addEventListener('input', (e) => {
    _soundVolume = e.target.value / 100;
    localStorage.setItem('bgm_volume', _soundVolume);
  });

  // ── Haptic toggle ─────────────────────────────────────────
  document.getElementById('haptic-toggle')?.addEventListener('change', (e) => {
    _hapticEnabled = e.target.checked;
    localStorage.setItem('bgm_haptic', _hapticEnabled ? 'true' : 'false');
    const hapticSlider = document.getElementById('haptic-slider');
    const hapticRow    = document.getElementById('haptic-row');
    if (hapticSlider) hapticSlider.disabled = !_hapticEnabled;
    if (hapticRow)    hapticRow.style.opacity = _hapticEnabled ? '1' : '0.4';
    if (_hapticEnabled) haptic([15, 8, 15]); // confirm buzz on enable
  });

  document.getElementById('haptic-slider')?.addEventListener('input', (e) => {
    _hapticIntensity = e.target.value / 100;
    localStorage.setItem('bgm_haptic_intensity', _hapticIntensity);
    haptic([12]); // preview on drag
  });

  // ── Notifications ─────────────────────────────────────────
  document.getElementById('notif-enable-btn')?.addEventListener('click', _requestNotifPermission);
  document.getElementById('notif-toggle')?.addEventListener('change', _toggleNotifications);
  document.getElementById('notif-test-btn')?.addEventListener('click', _sendTestNotification);

  document.getElementById('quiet-start')?.addEventListener('change', (e) => {
    localStorage.setItem('bgm_quiet_start', e.target.value);
  });
  document.getElementById('quiet-end')?.addEventListener('change', (e) => {
    localStorage.setItem('bgm_quiet_end', e.target.value);
  });

  // ── Team info edit ────────────────────────────────────────
  document.getElementById('settings-team-edit-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('settings-team-edit-panel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (!isOpen) {
      // Populate fields with current values
      const st = StateManager.get();
      const cityInput = document.getElementById('settings-edit-city');
      const nickInput = document.getElementById('settings-edit-nick');
      const abbrInput = document.getElementById('settings-edit-abbr');
      if (cityInput) cityInput.value = st?.userTeam?.city     || '';
      if (nickInput) nickInput.value = st?.userTeam?.nickname || '';
      if (abbrInput) abbrInput.value = st?.userTeam?.abbr     || '';
    }
    panel.style.display = isOpen ? 'none' : 'block';
  });

  document.getElementById('settings-team-cancel-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('settings-team-edit-panel');
    if (panel) panel.style.display = 'none';
  });

  document.getElementById('settings-team-save-btn')?.addEventListener('click', () => {
    const city = document.getElementById('settings-edit-city')?.value.trim();
    const nick = document.getElementById('settings-edit-nick')?.value.trim();
    const abbr = document.getElementById('settings-edit-abbr')?.value.trim().toUpperCase().replace(/[^A-Z]/g, '');

    if (!city || !nick) { showToast('City and nickname are required.', 'negative'); return; }
    if (!abbr || abbr.length < 2) { showToast('Abbreviation must be 2–3 letters.', 'negative'); return; }

    StateManager.mutate(st => {
      st.userTeam.city     = city;
      st.userTeam.nickname = nick;
      st.userTeam.abbr     = abbr;
    });

    // Update header display
    updateHeader(StateManager.get());

    // Refresh team name display in settings
    const teamNameEl = document.getElementById('settings-team-name');
    if (teamNameEl) teamNameEl.textContent = `${city} ${nick}`;

    // Close edit panel
    const panel = document.getElementById('settings-team-edit-panel');
    if (panel) panel.style.display = 'none';

    showToast('Team info updated.', 'positive');
    EventBus.emit('roster:changed');
  });

  // Abbr input: uppercase + letters only
  document.getElementById('settings-edit-abbr')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  // ── Color hue sliders ─────────────────────────────────────
  document.getElementById('settings-primary-hue')?.addEventListener('input', (e) => {
    const hex = _hueToHex(parseInt(e.target.value));
    const swatch = document.getElementById('settings-primary-swatch');
    if (swatch) swatch.style.background = hex;

    const st = StateManager.get();
    const secondary = st?.settings?.secondaryColor || '#22C55E';
    StateManager.mutate(s => { s.settings.primaryColor = hex; });
    applyTeamColors(hex, secondary, st?.settings?.theme);
    _updateColorPreview(hex, secondary);
    EventBus.emit('settings:colorChanged', { primary: hex, secondary });
  });

  document.getElementById('settings-secondary-hue')?.addEventListener('input', (e) => {
    const hex = _hueToHex(parseInt(e.target.value));
    const swatch = document.getElementById('settings-secondary-swatch');
    if (swatch) swatch.style.background = hex;

    const st = StateManager.get();
    const primary = st?.settings?.primaryColor || '#F5D253';
    StateManager.mutate(s => { s.settings.secondaryColor = hex; });
    applyTeamColors(primary, hex, st?.settings?.theme);
    _updateColorPreview(primary, hex);
    EventBus.emit('settings:colorChanged', { primary, secondary: hex });
  });

  // ── Expand/collapse: colors panel ────────────────────────
  const colorsRow  = document.getElementById('settings-colors-row');
  const colorPanel = document.getElementById('settings-color-panel');
  const themeRow   = document.getElementById('settings-theme-row');
  const themePanel = document.getElementById('settings-theme-panel');
  const chevron    = document.getElementById('settings-colors-chevron');

  colorsRow?.addEventListener('click', () => {
    const isOpen = colorPanel?.style.display !== 'none';
    if (colorPanel) colorPanel.style.display = isOpen ? 'none' : 'block';
    if (chevron)    chevron.textContent = isOpen ? '›' : '⌄';
    if (themePanel) themePanel.style.display = 'none';
  });

  themeRow?.addEventListener('click', () => {
    const isOpen = themePanel?.style.display !== 'none';
    if (themePanel) themePanel.style.display = isOpen ? 'none' : 'block';
    if (colorPanel) colorPanel.style.display = 'none';
    if (chevron)    chevron.textContent = '›';
  });

  // ── Theme buttons ─────────────────────────────────────────
  document.querySelectorAll('.settings-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTheme = btn.dataset.theme;
      StateManager.mutate(st => { st.settings.theme = newTheme; });

      const s = StateManager.get();
      applyTheme(newTheme, s.settings.primaryColor, s.settings.secondaryColor);

      document.querySelectorAll('.settings-theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === newTheme);
      });

      const themeValue = document.getElementById('settings-theme-value');
      if (themeValue) {
        themeValue.textContent = { dark: 'Dark', light: 'Light', auto: 'Auto' }[newTheme] || 'Dark';
      }
      EventBus.emit('settings:themeChanged', { theme: newTheme });
    });
  });

  // ── League team names ─────────────────────────────────────
  document.getElementById('settings-league-teams-btn')?.addEventListener('click', () => {
    _openLeagueTeamsView();
  });

  document.getElementById('settings-teams-back-btn')?.addEventListener('click', () => {
    document.getElementById('settings-view-teams')?.classList.add('tdm-view-hidden');
    document.getElementById('settings-view-main')?.classList.remove('tdm-view-hidden');
  });

  document.getElementById('league-teams-reset-btn')?.addEventListener('click', () => {
    _renderLeagueTeamsList(_LEAGUE_TEAM_DEFAULTS);
  });

  document.getElementById('league-teams-apply-btn')?.addEventListener('click', () => {
    _applyLeagueTeams();
  });
}

/**
 * _updateColorPreview(primary, secondary)
 * Updates the two small dots on the collapsed Team Colors row.
 * Accepts hex strings or palette IDs — handled by formatters._resolveColor.
 */
function _updateColorPreview(primary, secondary) {
  const previewEl = document.getElementById('settings-color-preview');
  if (!previewEl) return;
  // Both values are now hex strings from hue sliders
  const pHex = primary  || '#F5D253';
  const sHex = secondary || '#22C55E';
  previewEl.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:5px;">
      <span style="width:12px;height:12px;border-radius:50%;background:${pHex};display:inline-block;"></span>
      <span style="width:12px;height:12px;border-radius:50%;background:${sHex};display:inline-block;"></span>
    </span>`;
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

const _NOTIF_PREF_KEY = 'bgm_notif_enabled';

function _refreshNotifStatus() {
  if (!('Notification' in window)) {
    const status = document.getElementById('notif-status');
    if (status) { status.textContent = 'Not supported on this device'; status.className = 'notif-status'; }
    return;
  }

  const perm       = Notification.permission;
  const status     = document.getElementById('notif-status');
  const enableBtn  = document.getElementById('notif-enable-btn');
  const toggleWrap = document.getElementById('notif-toggle-label');
  const toggle     = document.getElementById('notif-toggle');
  const testRow    = document.getElementById('notif-test-row');

  if (perm === 'granted') {
    const enabled = localStorage.getItem(_NOTIF_PREF_KEY) !== 'false';
    if (status)     { status.textContent = enabled ? 'Enabled' : 'Paused'; status.className = 'notif-status ' + (enabled ? 'granted' : ''); }
    if (enableBtn)  enableBtn.style.display  = 'none';
    if (toggleWrap) toggleWrap.style.display = 'inline-flex';
    if (toggle)     toggle.checked = enabled;
    if (testRow)    testRow.style.display = enabled ? '' : 'none';
  } else if (perm === 'denied') {
    if (status)     { status.textContent = 'Blocked — change in browser settings'; status.className = 'notif-status denied'; }
    if (enableBtn)  enableBtn.style.display  = 'none';
    if (toggleWrap) toggleWrap.style.display = 'none';
    if (testRow)    testRow.style.display = 'none';
  } else {
    // default — not yet asked
    if (status)     { status.textContent = 'Not enabled'; status.className = 'notif-status'; }
    if (enableBtn)  enableBtn.style.display  = 'inline-block';
    if (toggleWrap) toggleWrap.style.display = 'none';
    if (testRow)    testRow.style.display = 'none';
  }
}

async function _requestNotifPermission() {
  if (!('Notification' in window)) return;
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    localStorage.setItem(_NOTIF_PREF_KEY, 'true');
    // Register push subscription via service worker if available
    _registerPushSubscription().catch(() => {});
  }
  _refreshNotifStatus();
}

function _toggleNotifications(e) {
  const on = e.target.checked;
  localStorage.setItem(_NOTIF_PREF_KEY, on ? 'true' : 'false');
  _refreshNotifStatus();
}

function _sendTestNotification() {
  if (Notification.permission !== 'granted') return;
  try {
    new Notification('The Front Office', {
      body: 'Push notifications are working. ⚾',
      icon: '/baseball-gm/icon-192.png',
    });
  } catch (e) {
    // Some browsers require service worker notifications
    navigator.serviceWorker?.ready.then(sw => {
      sw.showNotification('The Front Office', {
        body: 'Push notifications are working. ⚾',
        icon: '/baseball-gm/icon-192.png',
      });
    });
  }
}

async function _registerPushSubscription() {
  if (!navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.pushManager) return;
  // Subscription handled by service worker — no VAPID key needed for local test
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — LEAGUE TEAM NAMES
// ─────────────────────────────────────────────────────────────

const _LEAGUE_TEAM_DEFAULTS = [
  { city: 'New York',  nickname: 'Empire',     abbr: 'NYE' },
  { city: 'LA',        nickname: 'Palms',      abbr: 'LAP' },
  { city: 'Houston',   nickname: 'Pilots',     abbr: 'HOU' },
  { city: 'Chicago',   nickname: 'Rivermen',   abbr: 'CHI' },
  { city: 'Boston',    nickname: 'Navigators', abbr: 'BOS' },
  { city: 'Atlanta',   nickname: 'Pines',      abbr: 'ATL' },
  { city: 'Seattle',   nickname: 'Tide',       abbr: 'SEA' },
  { city: 'Miami',     nickname: 'Waves',      abbr: 'MIA' },
  { city: 'Tampa',     nickname: 'Admirals',   abbr: 'TAM' },
];

function _openLeagueTeamsView() {
  const st = StateManager.get();
  if (!st) return;

  // leagueTeams objects have `name` (e.g. "New York Empire") and `abbr`
  // but not separate city/nickname fields — split name for the editor.
  const teams = (st.leagueTeams || []).map(t => {
    const parts    = (t.name || '').trim().split(' ');
    const nickname = parts.length > 1 ? parts[parts.length - 1] : (t.name || '');
    const city     = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    return {
      city:     t.city     || city,     // use stored city if rename already applied
      nickname: t.nickname || nickname,
      abbr:     t.abbr     || '',
    };
  });

  _renderLeagueTeamsList(teams);

  document.getElementById('settings-view-main')?.classList.add('tdm-view-hidden');
  document.getElementById('settings-view-teams')?.classList.remove('tdm-view-hidden');
}

function _renderLeagueTeamsList(teams) {
  const list = document.getElementById('league-teams-list');
  if (!list) return;

  list.innerHTML = teams.map((t, i) => `
    <div class="league-team-row">
      <div class="league-team-row-label">TEAM ${i + 1}</div>
      <div class="league-team-fields">
        <input class="league-team-input league-team-city" data-idx="${i}"
          type="text" maxlength="14" value="${_escapeAttr(t.city)}"
          placeholder="City">
        <input class="league-team-input league-team-nick" data-idx="${i}"
          type="text" maxlength="14" value="${_escapeAttr(t.nickname)}"
          placeholder="Nickname">
        <input class="league-team-input league-team-abbr" data-idx="${i}"
          type="text" maxlength="3" value="${_escapeAttr(t.abbr)}"
          placeholder="ABC">
      </div>
      <div class="league-team-error" data-idx="${i}"></div>
    </div>
  `).join('');

  // Wire abbr inputs to uppercase
  list.querySelectorAll('.league-team-abbr').forEach(input => {
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '');
      _validateLeagueTeams();
    });
  });
  list.querySelectorAll('.league-team-city, .league-team-nick').forEach(input => {
    input.addEventListener('input', _validateLeagueTeams);
  });

  _validateLeagueTeams();
}

function _validateLeagueTeams() {
  const cities  = [...document.querySelectorAll('.league-team-city')].map(el => el.value.trim());
  const nicks   = [...document.querySelectorAll('.league-team-nick')].map(el => el.value.trim());
  const abbrs   = [...document.querySelectorAll('.league-team-abbr')].map(el => el.value.trim().toUpperCase());
  const errors  = document.querySelectorAll('.league-team-error');
  const applyBtn = document.getElementById('league-teams-apply-btn');
  let valid = true;

  abbrs.forEach((abbr, i) => {
    const err = errors[i];
    if (!err) return;
    let msg = '';
    if (!cities[i])           msg = 'City is required.';
    else if (!nicks[i])       msg = 'Nickname is required.';
    else if (abbr.length < 2) msg = 'Abbreviation must be 2–3 letters.';
    else {
      const dupAbbr = abbrs.findIndex((a, j) => a === abbr && j !== i);
      if (dupAbbr >= 0) msg = 'Duplicate abbreviation.';
      else {
        const fullName = cities[i] + ' ' + nicks[i];
        const dupName  = cities.findIndex((c, j) => j !== i && c + ' ' + nicks[j] === fullName);
        if (dupName >= 0) msg = 'Duplicate team name.';
      }
    }
    err.textContent     = msg;
    err.style.display   = msg ? '' : 'none';
    if (msg) valid = false;
  });

  if (applyBtn) {
    applyBtn.disabled     = !valid;
    applyBtn.style.opacity = valid ? '1' : '0.4';
    applyBtn.style.cursor  = valid ? 'pointer' : 'not-allowed';
  }
  return valid;
}

function _applyLeagueTeams() {
  if (!_validateLeagueTeams()) return;

  const cities = [...document.querySelectorAll('.league-team-city')].map(el => el.value.trim());
  const nicks  = [...document.querySelectorAll('.league-team-nick')].map(el => el.value.trim());
  const abbrs  = [...document.querySelectorAll('.league-team-abbr')].map(el => el.value.trim().toUpperCase());

  StateManager.mutate(st => {
    (st.leagueTeams || []).forEach((t, i) => {
      if (cities[i] === undefined) return;
      const oldAbbr = t.abbr;
      t.name     = `${cities[i]} ${nicks[i]}`;  // primary name field used by engines
      t.city     = cities[i];                    // stored for future settings edits
      t.nickname = nicks[i];
      t.abbr     = abbrs[i];

      // Cascade abbr change to schedule game entries
      if (oldAbbr !== abbrs[i] && st.leagueSchedule?.dayMap) {
        for (const dayGames of Object.values(st.leagueSchedule.dayMap)) {
          for (const game of dayGames) {
            if (game.homeId === t.id) game.homeAbbr = abbrs[i];
            if (game.awayId === t.id) game.awayAbbr = abbrs[i];
          }
        }
      }
    });
  });

  // Return to main settings view
  document.getElementById('settings-view-teams')?.classList.add('tdm-view-hidden');
  document.getElementById('settings-view-main')?.classList.remove('tdm-view-hidden');

  showToast('League team names updated.', 'positive');
  EventBus.emit('roster:changed');
}

// ─────────────────────────────────────────────────────────────
// SETTINGS — COLOR HELPERS (shared with SetupScreen pattern)
// ─────────────────────────────────────────────────────────────

function _hueToHex(hue) {
  const s = 78;
  let l;
  if (hue >= 40  && hue <= 80)  l = 52;
  else if (hue >= 100 && hue <= 160) l = 45;
  else l = 55;
  return _hslToHex(hue, s, l);
}

function _hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k     = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function _hexToHue(hex) {
  if (!hex || hex.length < 7) return 48;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let hue;
  if      (max === r) hue = 60 * (((g - b) / d) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else                hue = 60 * ((r - g) / d + 4);
  return Math.round((hue + 360) % 360);
}

function _escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

// ─────────────────────────────────────────────────────────────
// SERVICE WORKER REGISTRATION (Phase 14 — PWA)
// ─────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/baseball-gm/sw.js', { scope: '/baseball-gm/' })
      .then(registration => {
        console.log('[App] Service worker registered — scope:', registration.scope);

        // If a new service worker is waiting, activate it immediately
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available — activate immediately on next navigation
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => {
        console.warn('[App] Service worker registration failed:', err);
      });
  });
}
