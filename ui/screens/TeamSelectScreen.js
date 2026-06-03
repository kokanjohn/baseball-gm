/**
 * ui/screens/TeamSelectScreen.js
 * Load or Start a Team screen.
 *
 * Shown when:
 *   - User taps "New / Switch Team" in Settings (from the main app)
 *
 * NOT shown on normal app launch — the app silently restores the last
 * active slot on open. This screen is only for explicitly managing slots.
 *
 * Premium: unlimited slots shown as a list of team cards.
 * Free:    1 slot max — "New Team" warns it will replace the existing save.
 *
 * Flow:
 *   Tap team card  → load that slot → go to dashboard
 *   Tap New Team   → (free: confirm overwrite) → go to setup
 *   Tap Delete     → confirm sheet → delete slot → refresh list
 *
 * Rules:
 *   - No direct state writes. Uses StateManager.load(), deleteSlot(), createSlot().
 *   - CSS injected once via _cssInjected guard.
 *   - Rendered into #setup-content (reuses the setup screen shell).
 */

import * as StateManager from '../../store/StateManager.js';
import { SAVE_SLOT_LIMIT_FREE } from '../../data/constants.js';

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

let _onTeamLoaded = null;   // callback when a slot is loaded → go to dashboard
let _onNewTeam    = null;   // callback when user wants to create a new team → go to setup

/**
 * mount(onTeamLoaded, onNewTeam)
 * Renders the team select screen into #setup-content.
 *
 * @param {Function} onTeamLoaded  — called after a slot is loaded
 * @param {Function} onNewTeam     — called when user starts new team flow
 */
export async function mount(onTeamLoaded, onNewTeam) {
  _injectCSS();
  _onTeamLoaded = onTeamLoaded;
  _onNewTeam    = onNewTeam;
  await _render();
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

async function _render() {
  const container = document.getElementById('setup-content');
  if (!container) return;

  let slots = [];
  try {
    slots = await StateManager.listSlots();
  } catch (err) {
    console.warn('[TeamSelectScreen] listSlots failed:', err);
  }

  const activeSlotId = StateManager.getActiveSlotId();
  const isPremium    = true;  // Always full functionality until Phase 18
  const slotLimit    = Infinity;
  const atLimit      = false;

  container.innerHTML = `
    <div class="ts-wrap">

      <!-- Header -->
      <div class="ts-header">
        <div class="ts-title">Your Team</div>
        <div class="ts-sub">Load or Start a Team</div>
      </div>

      <!-- Team list -->
      ${slots.length > 0 ? `
        <div class="ts-section-label">YOUR TEAMS</div>
        <div class="ts-list" id="ts-list">
          ${slots.map(slot => _renderSlotCard(slot, activeSlotId)).join('')}
        </div>
      ` : ''}

      <!-- Divider (only when there are existing slots) -->
      ${slots.length > 0 ? '<div class="ts-divider"></div>' : ''}

      <!-- Start fresh -->
      <div class="ts-section-label">START FRESH</div>
      <div class="ts-new-card" id="ts-new-btn">
        <div class="ts-new-plus">+</div>
        <div class="ts-new-label">New Team</div>
      </div>

    </div>
  `;

  _attachListeners(slots, activeSlotId);
}

// ─────────────────────────────────────────────────────────────
// SLOT CARD
// ─────────────────────────────────────────────────────────────

function _renderSlotCard(slot, activeSlotId) {
  const isActive     = slot.slotId === activeSlotId;
  const state        = slot.state || {};
  const wins         = state.userTeam?.wins    || 0;
  const losses       = state.userTeam?.losses  || 0;
  const tier         = state.prestigeTier      || 1;
  const tierLabel    = `Tier ${Math.min(tier, 5)} of 5`;
  const archetype    = slot.archetype ? _capitalize(slot.archetype) : '';
  const seasonNum    = slot.seasonNum || 1;
  const lastPlayed   = slot.lastPlayed ? _timeAgo(slot.lastPlayed) : '';

  const tierCls = tier >= 4 ? 'tier-gold' : tier >= 3 ? 'tier-purple' : tier >= 2 ? 'tier-blue' : 'tier-muted';

  return `
    <div class="ts-card ${isActive ? 'ts-card-active' : ''}" data-slot-id="${_esc(slot.slotId)}">
      <div class="ts-card-main">
        ${isActive ? '<div class="ts-active-dot"></div><span class="ts-active-label">ACTIVE</span>' : ''}
        <div class="ts-card-name">${_esc(slot.teamName || 'Unknown Team')}</div>
        <div class="ts-card-meta">${archetype}${archetype ? ' · ' : ''}Season ${seasonNum} · ${wins}–${losses}</div>
        ${lastPlayed ? `<div class="ts-card-last">Last played ${lastPlayed}</div>` : ''}
      </div>
      <div class="ts-card-right">
        <div class="ts-tier-badge ${tierCls}">${tierLabel}</div>
        <button class="ts-delete-btn" data-delete-slot="${_esc(slot.slotId)}" data-team-name="${_esc(slot.teamName || 'this team')}">Delete</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(slots, activeSlotId) {

  // Tap card → load slot
  document.querySelectorAll('.ts-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      // Don't fire if tapping the delete button
      if (e.target.closest('.ts-delete-btn')) return;
      const slotId = card.dataset.slotId;
      if (!slotId) return;
      await _loadSlot(slotId);
    });
  });

  // Delete button → confirm sheet
  document.querySelectorAll('.ts-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slotId   = btn.dataset.deleteSlot;
      const teamName = btn.dataset.teamName;
      _showDeleteConfirm(slotId, teamName);
    });
  });

  // New Team button — always goes straight to setup
  const newBtn = document.getElementById('ts-new-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      _onNewTeam?.();
    });
  }
}

// ─────────────────────────────────────────────────────────────
// LOAD SLOT
// ─────────────────────────────────────────────────────────────

async function _loadSlot(slotId) {
  try {
    await StateManager.load(slotId);
    _onTeamLoaded?.();
  } catch (err) {
    console.error('[TeamSelectScreen._loadSlot]', err);
    _showToast('Could not load team. Please try again.');
  }
}

// ─────────────────────────────────────────────────────────────
// CONFIRM SHEETS
// ─────────────────────────────────────────────────────────────

function _showDeleteConfirm(slotId, teamName) {
  _removeOverlay();

  const overlay = document.createElement('div');
  overlay.id    = 'ts-confirm-overlay';
  overlay.className = 'ts-overlay';
  overlay.innerHTML = `
    <div class="ts-confirm-sheet">
      <div class="ts-confirm-handle"></div>
      <div class="ts-confirm-icon">⚠️</div>
      <div class="ts-confirm-title">Delete this team?</div>
      <div class="ts-confirm-body">
        <strong>${_esc(teamName)}</strong> will be permanently deleted.<br>This cannot be undone.
      </div>
      <div class="ts-confirm-actions">
        <button class="ts-confirm-cancel" id="ts-confirm-cancel">Cancel</button>
        <button class="ts-confirm-danger" id="ts-confirm-delete">Delete Forever</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  document.getElementById('ts-confirm-cancel')?.addEventListener('click', _removeOverlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) _removeOverlay(); });

  document.getElementById('ts-confirm-delete')?.addEventListener('click', async () => {
    _removeOverlay();
    try {
      await StateManager.deleteSlot(slotId);
      // If we deleted the active slot, clear it
      if (StateManager.getActiveSlotId() === slotId) {
        localStorage.removeItem('bgm_activeSlotId');
      }
      await _render(); // re-render with updated list
    } catch (err) {
      console.error('[TeamSelectScreen] delete failed:', err);
      _showToast('Could not delete team. Please try again.');
    }
  });
}

function _removeOverlay() {
  document.getElementById('ts-confirm-overlay')?.remove();
}

function _showToast(msg) {
  // Reuse App.showToast if available, else fallback
  if (typeof App !== 'undefined' && App.showToast) {
    App.showToast(msg, 'negative');
  } else {
    alert(msg);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _tierName(tier) {
  const names = ['','Cellar Dweller','Rising Club','Contender','Powerhouse','Dynasty'];
  return names[Math.min(tier, 5)] || 'Unknown';
}

function _capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function _timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .ts-wrap {
      padding: 0 0 max(32px, env(safe-area-inset-bottom));
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .ts-header {
      padding: 48px 20px 24px;
      text-align: center;
    }
    .ts-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 32px;
      letter-spacing: 3px;
      color: var(--text);
      line-height: 1;
    }
    .ts-sub {
      font-size: 13px;
      color: var(--muted);
      margin-top: 6px;
      font-weight: 500;
    }

    /* Section labels */
    .ts-section-label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
      padding: 0 16px 8px;
    }

    /* Team list */
    .ts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 12px 16px;
    }

    /* Team card */
    .ts-card {
      background: var(--surface);
      border: 1.5px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      gap: 10px;
    }
    .ts-card:active { background: var(--surface2); }
    .ts-card-active {
      border-color: var(--accent);
      background: var(--chip-accent-bg);
    }

    .ts-card-main { flex: 1; min-width: 0; }

    .ts-active-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      margin-right: 6px;
      vertical-align: middle;
      margin-bottom: 2px;
    }
    .ts-active-label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 1px;
      color: var(--accent);
      text-transform: uppercase;
    }

    .ts-card-name {
      font-size: 18px;
      font-weight: 800;
      color: var(--text);
      margin-top: 6px;
      line-height: 1.2;
    }
    .ts-card-meta {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .ts-card-last {
      font-size: 11px;
      color: var(--muted);
      opacity: .6;
      margin-top: 3px;
    }

    /* Right column */
    .ts-card-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      flex-shrink: 0;
    }

    /* Tier badge */
    .ts-tier-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .tier-gold   { background: rgba(245,210,83,.12); border: 1px solid rgba(245,210,83,.3); color: var(--accent); }
    .tier-purple { background: rgba(167,139,250,.12); border: 1px solid rgba(167,139,250,.3); color: #a78bfa; }
    .tier-blue   { background: rgba(99,179,255,.10); border: 1px solid rgba(99,179,255,.2); color: #63b3ff; }
    .tier-muted  { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); }

    /* Delete button */
    .ts-delete-btn {
      font-size: 11px;
      font-weight: 700;
      color: var(--danger);
      background: rgba(240,82,82,.1);
      border: 1px solid rgba(240,82,82,.3);
      border-radius: 8px;
      padding: 5px 10px;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
    }
    .ts-delete-btn:active { background: rgba(240,82,82,.2); }

    /* Divider */
    .ts-divider {
      height: 1px;
      background: var(--border);
      margin: 8px 12px 16px;
    }

    /* New team card */
    .ts-new-card {
      margin: 0 12px;
      background: var(--surface);
      border: 1.5px dashed var(--border);
      border-radius: 14px;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      transition: background .15s;
    }
    .ts-new-card:active { background: var(--surface2); }
    .ts-new-plus  { font-size: 24px; color: var(--muted); line-height: 1; }
    .ts-new-label { font-size: 14px; font-weight: 700; color: var(--soft); }

    /* Limit note */
    .ts-limit-note {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      padding: 10px 20px 0;
      line-height: 1.6;
    }
    .ts-slot-count {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      padding: 8px 0 0;
    }

    /* Confirm overlay */
    .ts-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.7);
      z-index: 500;
      align-items: flex-end;
      justify-content: center;
    }
    .ts-overlay.open { display: flex; }

    .ts-confirm-sheet {
      background: var(--surface);
      border-radius: 20px 20px 0 0;
      width: 100%;
      max-width: 540px;
      padding: 12px 24px max(28px, env(safe-area-inset-bottom));
      text-align: center;
    }
    .ts-confirm-handle {
      width: 36px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin: 0 auto 20px;
    }
    .ts-confirm-icon  { font-size: 32px; margin-bottom: 12px; }
    .ts-confirm-title { font-size: 18px; font-weight: 800; color: var(--text); margin-bottom: 10px; }
    .ts-confirm-body  { font-size: 13px; color: var(--muted); line-height: 1.7; margin-bottom: 24px; }

    .ts-confirm-actions {
      display: flex;
      gap: 10px;
    }
    .ts-confirm-cancel {
      flex: 1;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface2);
      color: var(--soft);
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
    }
    .ts-confirm-danger {
      flex: 1;
      padding: 14px;
      border: 1.5px solid rgba(240,82,82,.4);
      border-radius: 12px;
      background: rgba(240,82,82,.12);
      color: var(--danger);
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
    }
    .ts-confirm-cancel:active { background: var(--border); }
    .ts-confirm-danger:active { background: rgba(240,82,82,.22); }
  `;
  document.head.appendChild(style);
}
