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
import { TICK_INTERVAL_MS, GAME_STATUS, COLOR_PALETTE, COLOR_PRIMARY_DEFAULT, COLOR_SECONDARY_DEFAULT } from '../data/constants.js';

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

  if (teamName)    teamName.textContent = state.userTeam?.name || '—';

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

  // Load active slot
  await StateManager.load();
  const state = StateManager.get();

  if (!state || !state.phase) {
    // No saved game — show setup screen
    _showScreen('setup');
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
    });
  }
  if (settingsClose && settingsModal) {
    settingsClose.addEventListener('click', () => {
      settingsModal.classList.remove('open');
    });
  }
  // Tap outside sheet to close
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

  // Wire install button in settings — prompt is deferred until beforeinstallprompt fires
  document.getElementById('pwa-install-btn')
    ?.addEventListener('click', () => {
      triggerInstallPrompt();
      settingsModal?.classList.remove('open');
    });

  // ── Settings: color + theme pickers ──────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// SETTINGS — COLOR + THEME PICKERS (Phase 15)
// ─────────────────────────────────────────────────────────────

/**
 * _initSettingsPickers()
 * Populates the color swatch grids and theme buttons in the settings modal.
 * Reads current settings from state, saves changes via StateManager.mutate.
 * Called once during init() after the settings modal is wired.
 */
function _initSettingsPickers() {
  const state = StateManager.get();
  if (!state) return;

  const palette       = COLOR_PALETTE;
  const currentPrimary   = state.settings?.primaryColor   || COLOR_PRIMARY_DEFAULT;
  const currentSecondary = state.settings?.secondaryColor || COLOR_SECONDARY_DEFAULT;
  const currentTheme     = state.settings?.theme          || 'dark';
  const activeTheme      = currentTheme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : currentTheme;

  // ── Primary swatches ──────────────────────────────────────
  const primaryGrid = document.getElementById('settings-primary-swatches');
  if (primaryGrid) {
    primaryGrid.innerHTML = palette.map(c => `
      <div class="settings-swatch ${c.id === currentPrimary ? 'selected' : ''}"
           data-color-id="${c.id}" data-target="primary"
           style="background:${c[activeTheme] || c.dark};"
           title="${c.name}"></div>
    `).join('');
  }

  // ── Secondary swatches ────────────────────────────────────
  const secondaryGrid = document.getElementById('settings-secondary-swatches');
  if (secondaryGrid) {
    secondaryGrid.innerHTML = palette.map(c => `
      <div class="settings-swatch ${c.id === currentSecondary ? 'selected' : ''}"
           data-color-id="${c.id}" data-target="secondary"
           style="background:${c[activeTheme] || c.dark};"
           title="${c.name}"></div>
    `).join('');
  }

  // ── Color preview label ───────────────────────────────────
  _updateColorPreview(currentPrimary, currentSecondary);

  // ── Color swatch taps ─────────────────────────────────────
  document.querySelectorAll('.settings-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const colorId = swatch.dataset.colorId;
      const target  = swatch.dataset.target; // 'primary' | 'secondary'

      const s = StateManager.get();
      const newPrimary   = target === 'primary'   ? colorId : (s.settings?.primaryColor   || COLOR_PRIMARY_DEFAULT);
      const newSecondary = target === 'secondary' ? colorId : (s.settings?.secondaryColor || COLOR_SECONDARY_DEFAULT);

      // Update state
      StateManager.mutate(st => {
        st.settings.primaryColor   = newPrimary;
        st.settings.secondaryColor = newSecondary;
      });

      // Apply immediately
      const theme = StateManager.get().settings?.theme || 'dark';
      applyTeamColors(newPrimary, newSecondary, theme);

      // Update selected swatches
      document.querySelectorAll(`.settings-swatch[data-target="${target}"]`).forEach(s => {
        s.classList.toggle('selected', s.dataset.colorId === colorId);
      });

      _updateColorPreview(newPrimary, newSecondary);
      EventBus.emit('settings:colorChanged', { primary: newPrimary, secondary: newSecondary });
    });
  });

  // ── Theme toggle ──────────────────────────────────────────
  const themePanel = document.getElementById('settings-theme-panel');
  const themeValue = document.getElementById('settings-theme-value');

  document.querySelectorAll('.settings-theme-btn').forEach(btn => {
    const t = btn.dataset.theme;
    btn.classList.toggle('active', t === currentTheme);
    btn.addEventListener('click', () => {
      const newTheme = btn.dataset.theme;
      StateManager.mutate(st => { st.settings.theme = newTheme; });

      const s = StateManager.get();
      applyTheme(newTheme, s.settings.primaryColor, s.settings.secondaryColor);

      // Update button states
      document.querySelectorAll('.settings-theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === newTheme);
      });

      if (themeValue) {
        themeValue.textContent = { dark: 'Dark', light: 'Light', auto: 'Auto' }[newTheme] || 'Dark';
      }

      EventBus.emit('settings:themeChanged', { theme: newTheme });
    });
  });

  // ── Set initial theme value label ─────────────────────────
  if (themeValue) {
    themeValue.textContent = { dark: 'Dark', light: 'Light', auto: 'Auto' }[currentTheme] || 'Dark';
  }

  // ── Expand/collapse panels ────────────────────────────────
  const colorsRow  = document.getElementById('settings-colors-row');
  const colorPanel = document.getElementById('settings-color-panel');
  const themeRow   = document.getElementById('settings-theme-row');
  const chevron    = document.getElementById('settings-colors-chevron');

  colorsRow?.addEventListener('click', () => {
    const isOpen = colorPanel?.style.display !== 'none';
    if (colorPanel) colorPanel.style.display = isOpen ? 'none' : 'block';
    if (chevron)    chevron.textContent = isOpen ? '›' : '⌄';
    if (themePanel) themePanel.style.display = 'none'; // close other panel
  });

  themeRow?.addEventListener('click', () => {
    const isOpen = themePanel?.style.display !== 'none';
    if (themePanel) themePanel.style.display = isOpen ? 'none' : 'block';
    if (colorPanel) colorPanel.style.display = 'none'; // close other panel
    if (chevron)    chevron.textContent = '›';
  });
}

/**
 * _updateColorPreview(primaryId, secondaryId)
 * Updates the color preview dots shown on the collapsed settings row.
 */
function _updateColorPreview(primaryId, secondaryId) {
  const previewEl = document.getElementById('settings-color-preview');
  if (!previewEl) return;
  const theme    = document.documentElement.getAttribute('data-theme') || 'dark';
  const primary  = COLOR_PALETTE.find(c => c.id === primaryId);
  const secondary = COLOR_PALETTE.find(c => c.id === secondaryId);
  const pHex     = primary?.[theme]   || primary?.dark   || '#F5D253';
  const sHex     = secondary?.[theme] || secondary?.dark || '#22C55E';
  previewEl.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:5px;">
      <span style="width:12px;height:12px;border-radius:50%;background:${pHex};display:inline-block;"></span>
      <span style="width:12px;height:12px;border-radius:50%;background:${sHex};display:inline-block;"></span>
    </span>`;
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
    navigator.serviceWorker.register('/sw.js')
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
