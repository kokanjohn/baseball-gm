/**
 * ui/screens/OffseasonScreen.js
 * Offseason screen — shown when state.phase === PHASE.OFFSEASON.
 * Rendered into #offseason-content (injected into the dashboard area).
 *
 * Layout (Offseason Screen Spec — LOCKED):
 *   Day pill         — "Offseason · Day X of 6"
 *   Progress bar     — real-time progress through the current day
 *   Daily focus      — changes per day (Season Review, Contract Decisions, etc.)
 *   Hard gate row    — 3 icons: Ownership / Contracts / Manager
 *                      green checkmark = cleared, amber lock = pending
 *   Inbox cards      — normal card list (same as InboxScreen To Do tab)
 *   Ready banner     — shown when all 3 gates cleared + "Start Spring Training" button
 *   Day 6 auto       — "Auto-resolving…" banner when Day 6 reached with unresolved gates
 *
 * Section 23 (offseason structure — LOCKED):
 *   6 real calendar days, time-based advancement.
 *   Spring training blocked until all 3 hard gates clear.
 *   Day 6 fires autoResolveHardGates() if any remain unresolved.
 *
 * Live mode rules (Section 2.1 — LOCKED): no advance button. Time passes naturally.
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import {
  getOffseasonStatus,
  checkHardGates,
  canBeginSpringTraining,
  autoResolveHardGates,
  OFFSEASON_DAY_POOLS,
} from '../../engine/OffseasonEngine.js';
import { getInbox } from '../../engine/CardEngine.js';

// ─────────────────────────────────────────────────────────────
// DAILY FOCUS LABELS (Section 23)
// ─────────────────────────────────────────────────────────────

const DAILY_FOCUS = Object.freeze({
  1: { label: 'Season Review',         sub: 'Reflect on the season and ownership evaluation.' },
  2: { label: 'Contract Decisions',    sub: 'Re-sign, release, or let players walk.' },
  3: { label: 'Staff & Trades',        sub: 'Coach renewals, trade activity, free agency.' },
  4: { label: 'Development',           sub: 'Farm system, facilities, and long-term planning.' },
  5: { label: 'Final Decisions',       sub: 'Last chance to act before spring training.' },
  6: { label: 'Spring Begins',         sub: 'Unresolved items auto-close. Spring training ahead.' },
});

// Hard gate metadata
const HARD_GATES = Object.freeze([
  { key: 'ownership', icon: '👔', label: 'Ownership' },
  { key: 'contracts', icon: '✍️',  label: 'Contracts' },
  { key: 'manager',   icon: '⚾',  label: 'Manager'   },
]);

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _mounted          = false;
let _listeners        = [];
let _progressTimer    = null;  // setInterval to refresh progress bar in real time
let _startingSpring   = false; // prevent double-tap on Start Spring Training

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('schedule', () => refresh());

  _listeners.push(EventBus.on('card:resolved',     () => refresh()));
  _listeners.push(EventBus.on('card:delivered',    () => refresh()));
  _listeners.push(EventBus.on('game:phaseChanged', () => refresh()));

  refresh();
  _startProgressTimer();
}

export function unmount() {
  _stopProgressTimer();
  _listeners.forEach(([event, handler]) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

export function refresh() {
  const container = document.getElementById('offseason-content');
  if (!container) return;

  const state  = StateManager.get();
  if (!state)  return;

  const now    = Date.now();
  const status = getOffseasonStatus(state, now);
  const inbox  = getInbox();

  container.innerHTML = `
    <div class="offseason-screen">

      <!-- Day pill + section title -->
      <div class="section-pad" style="padding-bottom:4px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div class="offseason-day-pill">
            <span class="offseason-day-label">Offseason · Day ${status.day} of 6</span>
          </div>
          ${status.daysLeft > 0
            ? `<span style="font-size:11px;color:var(--muted);">${status.daysLeft} day${status.daysLeft !== 1 ? 's' : ''} remaining</span>`
            : ''}
        </div>

        <!-- Real-time progress bar through current day -->
        <div class="offseason-progress">
          <div class="offseason-progress-fill" id="os-progress-fill"
            style="width:${_dayProgress(state, now)}%"></div>
        </div>

        <!-- Daily focus -->
        <div class="offseason-focus">${DAILY_FOCUS[status.day]?.label || 'Offseason'}</div>
        <div class="offseason-focus-sub">${DAILY_FOCUS[status.day]?.sub || ''}</div>
      </div>

      <!-- Hard gate status row -->
      ${_renderGateRow(status)}

      <!-- Day 6 auto-resolve banner -->
      ${status.autoResolvesFiring ? _renderAutoResolveBanner() : ''}

      <!-- Ready for spring training banner -->
      ${status.canBeginSpring && !status.autoResolvesFiring ? _renderReadyBanner() : ''}

      <!-- Inbox cards — same as To Do tab -->
      <div style="padding:8px 16px 24px;">
        ${inbox.length === 0
          ? _renderEmptyInbox(status)
          : inbox.map(card => _renderCard(card, state)).join('')}
      </div>

    </div>
  `;

  _attachListeners(state, status);
}

// ─────────────────────────────────────────────────────────────
// GATE ROW
// ─────────────────────────────────────────────────────────────

function _renderGateRow(status) {
  const { gates } = checkHardGates(StateManager.get());

  const gateEls = HARD_GATES.map(g => {
    const cleared = gates[g.key];
    return `
      <div class="offseason-gate ${cleared ? 'cleared' : 'pending'}">
        <div class="offseason-gate-icon">${cleared ? '✅' : g.icon}</div>
        <div class="offseason-gate-label">${g.label}</div>
      </div>
    `;
  }).join('');

  const allClear = gates.ownership && gates.contracts && gates.manager;

  return `
    <div style="padding:0 16px 8px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;
        color:var(--muted);margin-bottom:8px;">
        Required Before Spring Training
      </div>
      <div class="offseason-gates">${gateEls}</div>
      ${!allClear
        ? `<div style="font-size:11px;color:var(--muted);margin-top:6px;">
            ${status.blockers.map(b => `⚠ ${_escape(b)}`).join(' · ')}
           </div>`
        : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// BANNERS
// ─────────────────────────────────────────────────────────────

function _renderReadyBanner() {
  return `
    <div style="padding:0 16px 12px;">
      <div class="offseason-ready-banner">
        <div class="offseason-ready-text">✅ All decisions complete — ready for spring training</div>
      </div>
      <button class="offseason-start-btn" id="start-spring-btn">
        Begin Spring Training →
      </button>
    </div>
  `;
}

function _renderAutoResolveBanner() {
  return `
    <div style="padding:0 16px 12px;">
      <div style="background:var(--chip-red-bg);border:1px solid rgba(240,82,82,.3);
        border-radius:12px;padding:12px 16px;text-align:center;">
        <div style="font-size:13px;font-weight:700;color:var(--danger);margin-bottom:4px;">
          Auto-resolving remaining decisions…
        </div>
        <div style="font-size:12px;color:var(--muted);">
          Day 6 has arrived. Unresolved items are being handled conservatively.
        </div>
      </div>
    </div>
  `;
}

function _renderEmptyInbox(status) {
  if (status.canBeginSpring) {
    return `<div style="text-align:center;padding:20px;color:var(--muted);font-size:14px;">
      No pending decisions — everything is handled.
    </div>`;
  }
  return `<div style="text-align:center;padding:30px 20px;color:var(--muted);">
    <div style="font-size:36px;margin-bottom:8px;">📭</div>
    <div style="font-size:14px;">Decisions will arrive as the offseason progresses.</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// INBOX CARD (inline — mirrors InboxScreen To Do tab)
// ─────────────────────────────────────────────────────────────

function _renderCard(card, state) {
  const isUrgent  = card.type === 'urgent';
  const isGood    = card.type === 'good';
  const typeClass = isUrgent ? 'unread type-urgent' : isGood ? 'unread type-good' : 'unread type-normal';
  const avClass   = isUrgent ? 'av-urgent' : isGood ? 'av-good' : 'av-normal';
  const tagClass  = isUrgent ? 'tag-urgent' : isGood ? 'tag-good' : 'tag-normal';
  const tagLabel  = isUrgent ? 'URGENT' : isGood ? 'GOOD' : card.tag || 'INFO';

  // Gate-relevant cards get an indicator
  const isHardGateCard = ['OWNERSHIP','CONTRACT_EXPIRY','MANAGER_CONTRACT'].includes(card.tag);
  const gateFlag = isHardGateCard
    ? `<span style="font-size:9px;font-weight:700;color:var(--danger);margin-left:4px;">REQUIRED</span>`
    : '';

  return `
    <div class="msg-card ${typeClass}" id="osc-card-${card.instanceId}" style="margin-top:10px;">
      <div class="msg-header" data-os-expand="${card.instanceId}">
        <div class="msg-avatar ${avClass}">${card.avatar || '📋'}</div>
        <div class="msg-meta">
          <div class="msg-from">
            ${_escape(card.sender || '')}
            <span class="msg-from-tag ${tagClass}">${tagLabel}</span>
            ${gateFlag}
          </div>
          <div class="msg-subject">${_escape(card.subject || '')}</div>
          <div class="msg-preview">${_escape(card.preview || '')}</div>
        </div>
        <div class="unread-dot"></div>
      </div>
      <div class="msg-body" id="osc-body-${card.instanceId}" style="display:none;">
        <div class="msg-body-text">${_escape(card.body || '')}</div>
        <div class="msg-actions">
          <button class="btn-yes" data-os-resolve="${card.instanceId}" data-choice="yes">
            ${_escape(card.yesLabel || 'Yes')}
          </button>
          <button class="btn-no" data-os-resolve="${card.instanceId}" data-choice="no">
            ${_escape(card.noLabel || 'No')}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state, status) {
  // Start spring training button
  const startBtn = document.getElementById('start-spring-btn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      if (_startingSpring) return;
      _startingSpring = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Starting spring training…';
      await _handleStartSpring();
      _startingSpring = false;
    });
  }

  // Card expand/collapse
  document.querySelectorAll('[data-os-expand]').forEach(el => {
    el.addEventListener('click', () => {
      const id   = el.dataset.osExpand;
      const body = document.getElementById(`osc-body-${id}`);
      if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });
  });

  // Card resolution
  document.querySelectorAll('[data-os-resolve]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _resolveCard(btn.dataset.osResolve, btn.dataset.choice);
    });
  });

  // Day 6 auto-resolve — fires automatically, but also on first render of Day 6
  if (status.autoResolvesFiring) {
    _handleAutoResolve(state);
  }
}

// ─────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────

async function _handleStartSpring() {
  try {
    const { resumeOffseasonAfterOwnership } = await import('../../engine/GameEngine.js');
    await resumeOffseasonAfterOwnership();
    EventBus.emit('game:phaseChanged', { from: 'OFFSEASON', to: 'SPRING_TRAINING' });
    App.showToast('Spring training has begun!', 'positive', 3000);
  } catch (err) {
    console.error('OffseasonScreen._handleStartSpring:', err);
    App.showToast('Something went wrong. Please try again.', 'negative');
    _startingSpring = false;
  }
}

async function _resolveCard(instanceId, choice) {
  try {
    const { resolve } = await import('../../engine/CardEngine.js');
    resolve(instanceId, choice);

    EventBus.emit('card:resolved', { instanceId, choice });
    App.showToast(choice === 'yes' ? 'Decision made.' : 'Declined.', choice === 'yes' ? 'positive' : 'neutral', 2000);

    // Check if all hard gates cleared after this resolution
    const state  = StateManager.get();
    const { cleared } = checkHardGates(state);
    if (cleared && !state.offseasonHardGatesCleared) {
      StateManager.mutate(s => { s.offseasonHardGatesCleared = true; });
    }

    refresh();
  } catch (err) {
    console.error('OffseasonScreen._resolveCard:', err);
    App.showToast('Something went wrong. Please try again.', 'negative');
  }
}

function _handleAutoResolve(state) {
  // Only fires once — check if already auto-resolved
  if (state.offseasonHardGatesCleared) return;
  const { cleared } = checkHardGates(state);
  if (cleared) return;

  try {
    const mutations = autoResolveHardGates(state);
    StateManager.mutate(s => {
      if (mutations.mutations?.userTeam) Object.assign(s.userTeam, mutations.mutations.userTeam);
      if (mutations.mutations?.players) {
        for (const [id, upd] of Object.entries(mutations.mutations.players || {})) {
          if (s.players[id]) Object.assign(s.players[id], upd);
        }
      }
      if (mutations.mutations?.inbox) s.inbox = mutations.mutations.inbox;
      s.offseasonHardGatesCleared = mutations.mutations?.offseasonHardGatesCleared ?? true;
    });

    if (mutations.penalties?.length > 0) {
      mutations.penalties.forEach(p => App.showToast(p, 'negative', 4000));
    }

    EventBus.emit('card:resolved', { source: 'auto-resolve' });
    refresh();
  } catch (err) {
    console.error('OffseasonScreen._handleAutoResolve:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// REAL-TIME PROGRESS
// ─────────────────────────────────────────────────────────────

function _dayProgress(state, now) {
  const started = state.offseasonStartedAt || now;
  const MS_PER_DAY = 86_400_000;
  const elapsed = (now - started) % MS_PER_DAY; // progress within current day
  return Math.min(100, Math.round((elapsed / MS_PER_DAY) * 100));
}

function _startProgressTimer() {
  _stopProgressTimer();
  // Update progress bar every minute
  _progressTimer = setInterval(() => {
    const fill = document.getElementById('os-progress-fill');
    if (!fill) { _stopProgressTimer(); return; }
    fill.style.width = `${_dayProgress(StateManager.get(), Date.now())}%`;
  }, 60000);
}

function _stopProgressTimer() {
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

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
    #offseason-content { overflow-y: auto; }
    /* Required badge on gate cards */
    .gate-required-badge {
      font-size: 9px; font-weight: 700; color: var(--danger);
      background: var(--chip-red-bg); padding: 1px 5px; border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}
