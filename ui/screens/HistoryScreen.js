/**
 * ui/screens/HistoryScreen.js
 * Franchise History — a browsable record of significant franchise events.
 *
 * Accessible from the Settings gear button panel (Phase 15 wires it there).
 * Renders as a full-screen overlay sheet, not a bottom nav tab (Section 35.3).
 *
 * Layout:
 *   - Season groups, most recent first, each collapsible
 *   - Each entry: icon + headline, expandable to detail
 *   - User can add/edit a short personal note on any entry
 *   - Empty state shown when no history exists yet
 *
 * Rules:
 *   - No direct state writes except for user notes (via StateManager.mutate).
 *   - CSS injected once via _cssInjected guard.
 *   - Called 'History' or 'Franchise Story' in UI — never 'diary' (Section 35).
 *
 * Usage:
 *   import { openHistory, closeHistory } from './HistoryScreen.js';
 *   openHistory();   // renders over the current screen
 *   closeHistory();  // dismisses
 */

import * as StateManager from '../../store/StateManager.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _expandedEntries = new Set();  // entry IDs currently showing detail
let _editingEntry    = null;       // entry ID currently being edited (user note)

// Icon map by entry type — used when the stored icon is missing
const TYPE_ICONS = {
  trade:        '🔄',
  injury:       '🩹',
  retirement:   '🎓',
  coaching:     '📋',
  playoff:      '🏟️',
  milestone:    '🌟',
  prestige:     '⭐',
  record:       '📊',
  championship: '🏆',
};

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * openHistory()
 * Opens the franchise history overlay.
 */
export function openHistory() {
  _injectCSS();

  let overlay = document.getElementById('history-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'history-overlay';
    overlay.className = 'history-overlay';
    document.body.appendChild(overlay);
  }

  _expandedEntries = new Set();
  _editingEntry    = null;

  _render(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

/**
 * closeHistory()
 * Dismisses the franchise history overlay.
 */
export function closeHistory() {
  const overlay = document.getElementById('history-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

function _render(overlay) {
  const state   = StateManager.get();
  const history = state?.history || [];

  overlay.innerHTML = `
    <div class="history-sheet">
      <div class="history-handle"></div>

      <div class="history-header">
        <div class="history-title">Franchise Story</div>
        <button class="history-close" id="history-close-btn">×</button>
      </div>

      <div class="history-divider"></div>

      <div class="history-body" id="history-body">
        ${history.length === 0 ? _renderEmpty() : _renderSeasons(history, state)}
      </div>
    </div>
  `;

  // Wire close button
  document.getElementById('history-close-btn')
    ?.addEventListener('click', closeHistory);

  // Wire entry taps (expand/collapse)
  overlay.querySelectorAll('.history-entry-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't toggle if tapping note input or save button
      if (e.target.closest('.history-note-area')) return;
      const id = row.dataset.entryId;
      if (!id) return;
      if (_expandedEntries.has(id)) {
        _expandedEntries.delete(id);
      } else {
        _expandedEntries.add(id);
      }
      _render(overlay);
    });
  });

  // Wire note edit buttons
  overlay.querySelectorAll('.history-note-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.entryId;
      _editingEntry = (_editingEntry === id) ? null : id;
      _render(overlay);
    });
  });

  // Wire note save buttons
  overlay.querySelectorAll('.history-note-save-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id    = btn.dataset.entryId;
      const input = document.getElementById(`note-input-${id}`);
      if (!input) return;
      const note = input.value.trim().slice(0, 280); // 280 char cap
      StateManager.mutate(s => {
        const entry = (s.history || []).find(h => h.id === id);
        if (entry) entry.userNote = note;
      });
      _editingEntry = null;
      _render(overlay);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SEASON GROUPS
// ─────────────────────────────────────────────────────────────

function _renderSeasons(history, state) {
  // Group entries by season, most recent first
  const bySeason = {};
  for (const entry of history) {
    const s = entry.season || 1;
    if (!bySeason[s]) bySeason[s] = [];
    bySeason[s].push(entry);
  }

  const seasons = Object.keys(bySeason)
    .map(Number)
    .sort((a, b) => b - a); // descending — most recent first

  return seasons.map(seasonNum => {
    const entries   = bySeason[seasonNum];
    const teamName  = `${state.userTeam?.city || ''} ${state.userTeam?.nickname || ''}`.trim();
    const label     = `Season ${seasonNum}`;
    const subLabel  = _getSeasonSubLabel(entries);

    return `
      <div class="history-season-group">
        <div class="history-season-header">
          <div>
            <div class="history-season-label">${_escape(label)}</div>
            ${subLabel ? `<div class="history-season-sub">${_escape(subLabel)}</div>` : ''}
          </div>
          <div class="history-season-count">${entries.length} event${entries.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="history-entries">
          ${entries.map(entry => _renderEntry(entry)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function _getSeasonSubLabel(entries) {
  const record = entries.find(e => e.type === 'record');
  const champ  = entries.find(e => e.type === 'championship');
  if (champ)  return '🏆 Championship';
  if (record) return record.headline;
  return '';
}

// ─────────────────────────────────────────────────────────────
// ENTRY ROWS
// ─────────────────────────────────────────────────────────────

function _renderEntry(entry) {
  const icon      = entry.icon || TYPE_ICONS[entry.type] || '📌';
  const isOpen    = _expandedEntries.has(entry.id);
  const isEditing = _editingEntry === entry.id;
  const hasNote   = (entry.userNote || '').length > 0;

  const detailBlock = isOpen ? `
    <div class="history-detail">
      <div class="history-detail-text">${_escape(entry.detail || '')}</div>
      ${_renderNoteArea(entry, isEditing, hasNote)}
    </div>
  ` : '';

  return `
    <div class="history-entry-row ${isOpen ? 'open' : ''} ${entry.type === 'championship' ? 'entry-championship' : ''}"
         data-entry-id="${_escape(entry.id)}">
      <div class="history-entry-main">
        <div class="history-entry-icon">${icon}</div>
        <div class="history-entry-headline">${_escape(entry.headline)}</div>
        <div class="history-entry-chevron">${isOpen ? '▲' : '▾'}</div>
      </div>
      ${detailBlock}
    </div>
  `;
}

function _renderNoteArea(entry, isEditing, hasNote) {
  if (isEditing) {
    return `
      <div class="history-note-area" onclick="event.stopPropagation()">
        <textarea
          id="note-input-${_escape(entry.id)}"
          class="history-note-input"
          maxlength="280"
          placeholder="Add a personal note about this moment…"
        >${_escape(entry.userNote || '')}</textarea>
        <div class="history-note-actions">
          <button class="history-note-save-btn btn-primary" data-entry-id="${_escape(entry.id)}">
            Save Note
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="history-note-area">
      ${hasNote
        ? `<div class="history-note-display">${_escape(entry.userNote)}</div>`
        : ''
      }
      <button class="history-note-edit-btn" data-entry-id="${_escape(entry.id)}">
        ${hasNote ? '✏️ Edit note' : '+ Add a note'}
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────────

function _renderEmpty() {
  return `
    <div class="history-empty">
      <div class="history-empty-icon">📖</div>
      <div class="history-empty-title">Your story starts here</div>
      <div class="history-empty-sub">
        Trades, injuries, milestones, and championships will be recorded here as your franchise grows.
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    /* ── Overlay shell ── */
    .history-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: var(--modal-overlay);
      z-index: 400;
      align-items: flex-end;
      justify-content: center;
    }
    .history-overlay.open {
      display: flex;
    }

    /* ── Sheet ── */
    .history-sheet {
      background: var(--surface);
      border-radius: 24px 24px 0 0;
      width: 100%;
      max-width: 540px;
      max-height: 92dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .history-handle {
      width: 40px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin: 14px auto 0;
      flex-shrink: 0;
    }

    /* ── Header ── */
    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      flex-shrink: 0;
    }
    .history-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 26px;
      letter-spacing: 3px;
      color: var(--text);
    }
    .history-close {
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 50%;
      background: var(--surface2);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .history-close:active { background: var(--border); }

    .history-divider {
      height: 1px;
      background: var(--border);
      margin: 0 20px;
      flex-shrink: 0;
    }

    /* ── Body scroll area ── */
    .history-body {
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      padding: 0 0 max(20px, env(safe-area-inset-bottom));
    }

    /* ── Season group ── */
    .history-season-group {
      margin-bottom: 4px;
    }
    .history-season-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px 8px;
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 1;
      border-bottom: 1px solid var(--border);
    }
    .history-season-label {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--accent);
    }
    .history-season-sub {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    .history-season-count {
      font-size: 11px;
      color: var(--muted);
      font-weight: 600;
    }

    /* ── Entry rows ── */
    .history-entries {
      padding: 4px 0;
    }
    .history-entry-row {
      padding: 0 20px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }
    .history-entry-row:active { background: var(--surface2); }
    .history-entry-row.entry-championship {
      background: linear-gradient(90deg, rgba(245,210,83,.07) 0%, transparent 100%);
    }

    .history-entry-main {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 0;
    }
    .history-entry-icon {
      font-size: 18px;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }
    .history-entry-headline {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.4;
    }
    .history-entry-chevron {
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
    }

    /* ── Expanded detail ── */
    .history-detail {
      padding: 0 0 14px 34px;
    }
    .history-detail-text {
      font-size: 13px;
      color: var(--soft);
      line-height: 1.7;
      margin-bottom: 10px;
    }

    /* ── User notes ── */
    .history-note-area {
      margin-top: 4px;
    }
    .history-note-display {
      font-size: 12px;
      color: var(--accent2);
      font-style: italic;
      line-height: 1.6;
      margin-bottom: 6px;
      background: var(--chip-accent2-bg, var(--surface2));
      padding: 8px 10px;
      border-radius: 8px;
    }
    .history-note-edit-btn {
      font-size: 12px;
      color: var(--muted);
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 10px;
      cursor: pointer;
    }
    .history-note-edit-btn:active { background: var(--surface2); }

    .history-note-input {
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 13px;
      padding: 10px;
      resize: none;
      height: 72px;
      line-height: 1.5;
      box-sizing: border-box;
    }
    .history-note-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .history-note-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
    }
    .history-note-actions .btn-primary {
      font-size: 13px;
      padding: 8px 16px;
    }

    /* ── Empty state ── */
    .history-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 60px 32px 40px;
      gap: 12px;
    }
    .history-empty-icon { font-size: 40px; }
    .history-empty-title {
      font-size: 18px;
      font-weight: 800;
      color: var(--text);
    }
    .history-empty-sub {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.7;
      max-width: 280px;
    }
  `;
  document.head.appendChild(style);
}
