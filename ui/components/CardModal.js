/**
 * ui/components/CardModal.js
 * Expanded card detail modal for InboxScreen.
 *
 * Used when a card body is too long to read comfortably inline.
 * Slides up as a bottom sheet with the full card body,
 * sender info, and action buttons.
 *
 * InboxScreen decides when to use this vs inline expand:
 *   - Short cards (< 400 chars): expand inline (current behavior)
 *   - Long cards (≥ 400 chars): open CardModal instead
 *
 * Usage:
 *   import { openCardModal, closeCardModal } from '../components/CardModal.js';
 *   openCardModal(card, onResolve);
 *
 * @param {Object}   card       — inbox card object
 * @param {Function} onResolve  — called with (instanceId, choice)
 */

// ─────────────────────────────────────────────────────────────
// OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

const LONG_CARD_THRESHOLD = 400; // chars

/**
 * shouldUseModal(card)
 * Returns true if the card body is long enough to warrant a modal.
 *
 * @param {Object} card
 * @returns {Boolean}
 */
export function shouldUseModal(card) {
  return (card?.body?.length || 0) >= LONG_CARD_THRESHOLD;
}

/**
 * openCardModal(card, onResolve)
 * Opens the card detail modal sheet.
 *
 * @param {Object}   card
 * @param {Function} onResolve  — (instanceId, choice) => void
 */
export function openCardModal(card, onResolve) {
  if (!card) return;
  _injectCSS();

  let overlay = document.getElementById('card-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'card-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  const isUrgent  = card.type === 'urgent';
  const isGood    = card.type === 'good';
  const tagClass  = isUrgent ? 'tag-urgent' : isGood ? 'tag-good' : 'tag-normal';
  const tagLabel  = isUrgent ? 'URGENT' : isGood ? 'GOOD' : card.tag || 'INFO';
  const avClass   = isUrgent ? 'av-urgent' : isGood ? 'av-good' : 'av-normal';

  overlay.innerHTML = `
    <div class="modal-sheet" id="card-modal-sheet">
      <div class="modal-handle"></div>

      <!-- Card sender header -->
      <div class="card-modal-sender">
        <div class="msg-avatar ${avClass}" style="width:44px;height:44px;font-size:20px;flex-shrink:0;">
          ${card.avatar || '📋'}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${_escape(card.sender || '')}
            <span class="msg-from-tag ${tagClass}">${tagLabel}</span>
          </div>
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:2px;">
            ${_escape(card.subject || '')}
          </div>
        </div>
        <button class="modal-close" id="card-modal-close">×</button>
      </div>

      <div class="modal-divider"></div>

      <!-- Card body -->
      <div class="card-modal-body">
        <div class="card-modal-text">${_escape(card.body || '')}</div>

        <!-- TTL warning if applicable -->
        ${card.expiresAt !== undefined && card.expiresAt !== null ? `
          <div class="card-modal-ttl">
            ⏰ This decision expires soon
          </div>
        ` : ''}
      </div>

      <!-- Action buttons -->
      <div class="card-modal-actions">
        <button class="btn-no" id="card-modal-no">
          ${_escape(card.noLabel || 'Decline')}
        </button>
        <button class="btn-yes" id="card-modal-yes">
          ${_escape(card.yesLabel || 'Accept')}
        </button>
      </div>

    </div>
  `;

  // Trigger open animation
  requestAnimationFrame(() => overlay.classList.add('open'));

  // Wire buttons
  document.getElementById('card-modal-close')?.addEventListener('click', closeCardModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCardModal(); });

  document.getElementById('card-modal-yes')?.addEventListener('click', () => {
    if (onResolve) onResolve(card.instanceId, 'yes');
    closeCardModal();
  });

  document.getElementById('card-modal-no')?.addEventListener('click', () => {
    if (onResolve) onResolve(card.instanceId, 'no');
    closeCardModal();
  });
}

/**
 * closeCardModal()
 * Dismisses the card modal.
 */
export function closeCardModal() {
  const overlay = document.getElementById('card-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _escape(str) {
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
    #card-modal-overlay .modal-sheet{max-height:85dvh;}
    .card-modal-sender{display:flex;align-items:flex-start;gap:12px;padding:16px 20px 12px;}
    .card-modal-body{overflow-y:auto;padding:0 20px 16px;flex:1;min-height:0;}
    .card-modal-text{font-size:14px;color:var(--soft);line-height:1.8;
      white-space:pre-wrap;word-break:break-word;}
    .card-modal-ttl{margin-top:12px;font-size:12px;font-weight:700;
      color:var(--danger);background:var(--chip-red-bg);
      padding:8px 12px;border-radius:8px;display:flex;align-items:center;gap:6px;}
    .card-modal-actions{display:flex;gap:10px;padding:12px 20px
      max(16px,env(safe-area-inset-bottom));border-top:1px solid var(--border);
      flex-shrink:0;}
    .card-modal-actions .btn-no{flex:1;}
    .card-modal-actions .btn-yes{flex:2;}
  `;
  document.head.appendChild(style);
}
