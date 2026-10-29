/**
 * ui/screens/InboxScreen.js
 * Inbox tab rendered into #inbox-content.
 *
 * Three internal tabs (Section 1.14 — LOCKED):
 *   To Do     — unresolved cards requiring GM decision
 *   Completed — resolved cards (last 20, newest first)
 *   Compose   — initiate conversations with staff/departments
 *
 * Rules:
 *   - Card resolution calls CardEngine.resolve() — never direct state writes.
 *   - Compose channels use composeCooldowns from state to prevent repeat use.
 *   - Urgent cards (type === 'urgent') shown with red left-border indicator.
 *   - Cards expand inline on tap — no modal, matching v1 behavior.
 *   - To Do tab shows unread badge count matching the nav badge.
 *   - Compose tab respects Section 8.12 channel map (LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getInbox, getHistory, clearHistory, restoreHistory } from '../../engine/CardEngine.js';
import { snapshotMetrics } from '../formatters.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab      = 'todo';   // 'todo' | 'completed' | 'compose'
let _undoCleared    = null;     // instanceIds from the last Delete / Delete All (session only)
let _expandedCard   = null;     // instanceId of expanded card
let _composeChannel = null;     // currently selected compose channel id
let _composeTopic   = null;     // currently selected compose topic id
let _mounted      = false;
let _listeners    = [];

// ─────────────────────────────────────────────────────────────
// COMPOSE CHANNEL MAP (Section 8.12 — LOCKED)
// ─────────────────────────────────────────────────────────────

const COMPOSE_CHANNELS = [
  // §85 trade talks with the other clubs' GMs (opens the trade composer).
  {
    id:       'other_gms',
    label:    'Other GMs',
    icon:     '📞',
    role:     'Around the League',
    priority: 'high',
    topics:   [],
  },
  // High priority — built in initial release
  {
    id:       'manager',
    label:    'Manager',
    icon:     '⚾',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'mgr_lineup',    label: 'Lineup strategy',          desc: 'Ask about the lineup plan for upcoming games' },
      { id: 'mgr_morale',    label: 'Team morale check-in',     desc: 'Get a read on clubhouse atmosphere' },
      { id: 'mgr_rotation',  label: 'Rotation status',          desc: 'Check on SP workload and next starts' },
      { id: 'mgr_matchup',   label: 'Upcoming series prep',     desc: 'Discuss the next opponent\'s tendencies' },
    ],
  },
  {
    id:       'pitching_coach',
    label:    'Pitching Coach',
    icon:     '🎯',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'pc_rotation',   label: 'Rotation health',          desc: 'Check arm health across the rotation' },
      { id: 'pc_reliever',   label: 'Bullpen workload',         desc: 'Review reliever usage and recovery' },
      { id: 'pc_prospect',   label: 'Farm pitcher update',      desc: 'Get a report on a developing arm' },
    ],
  },
  {
    id:       'hitting_coach',
    label:    'Hitting Coach',
    icon:     '🏏',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'hc_slump',      label: 'Hitter in a slump',        desc: 'Ask about a struggling hitter\'s approach' },
      { id: 'hc_development', label: 'Development check-in',    desc: 'Review a young hitter\'s progress' },
      { id: 'hc_lineup',     label: 'Lineup optimization',      desc: 'Discuss batting order construction' },
    ],
  },
  {
    id:       'groundskeeper',
    label:    'Head Groundskeeper',
    icon:     '🌱',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'gk_field',      label: 'Field conditions',         desc: 'Check on playing surface status' },
      { id: 'gk_weather',    label: 'Weather impact',           desc: 'Assess upcoming weather on field conditions' },
    ],
  },
  // Medium priority
  {
    id:       'bench_coach',
    label:    'Bench Coach',
    icon:     '📋',
    role:     'Field Staff',
    priority: 'medium',
    topics: [
      { id: 'bc_morale',     label: 'In-game decisions',        desc: 'Get bench coach\'s read on game tactics' },
    ],
  },
  {
    id:       'bullpen_coach',
    label:    'Bullpen Coach',
    icon:     '💪',
    role:     'Field Staff',
    priority: 'medium',
    topics: [
      { id: 'bpc_health',    label: 'Reliever health check',    desc: 'Review which relievers are available today' },
    ],
  },
  {
    id:       'facilities',
    label:    'Facilities & Ops',
    icon:     '🏟️',
    role:     'Front Office',
    priority: 'medium',
    topics: [
      { id: 'fac_status',    label: 'Ballpark status',          desc: 'Check on any facility concerns or projects' },
    ],
  },
  {
    id:       'ticket_office',
    label:    'Ticket Office',
    icon:     '🎫',
    role:     'Front Office',
    priority: 'medium',
    topics: [
      { id: 'tix_attendance', label: 'Attendance outlook',       desc: 'Review attendance trends and forecasts' },
      { id: 'tix_renewals',   label: 'Season ticket renewals',   desc: 'Check on renewal campaign status' },
    ],
  },
  {
    id:       'scouting',
    label:    'Scouting / Dev',
    icon:     '🔭',
    role:     'Front Office',
    priority: 'medium',
    topics: [
      { id: 'sc_prospect',   label: 'Prospect report',          desc: 'Get an update on a specific prospect' },
      { id: 'sc_opponent',   label: 'Opponent scouting',        desc: 'Ask about an upcoming opponent\'s tendencies' },
    ],
  },
  // Low priority — event-driven
  {
    id:       'media_relations',
    label:    'Media Relations',
    icon:     '📰',
    role:     'Front Office',
    priority: 'low',
    topics: [
      { id: 'mr_narrative',  label: 'Team narrative',           desc: 'Discuss how the team is being covered' },
    ],
  },
  {
    id:       'community',
    label:    'Community Affairs',
    icon:     '🤝',
    role:     'Front Office',
    priority: 'low',
    topics: [
      { id: 'ca_event',      label: 'Community event check',    desc: 'Review upcoming community commitments' },
    ],
  },
];

// Compose cooldown in games (how long before same topic can be used again)
const COMPOSE_COOLDOWN_GAMES = 5;

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('decisions', () => {
    _expandedCard = null;
    refresh();
  });

  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('card:delivered',   () => { if (_activeTab === 'todo') refresh(); });
  wire('card:resolved',    () => refresh());
  wire('inbox:changed',    () => refresh());   // roster clock: new or withdrawn cards (§65)
  wire('nav:tabActivated', ({ tab }) => { if (tab === 'decisions') refresh(); });

  refresh();
}

export function unmount() {
  _listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

export function refresh() {
  const container = document.getElementById('inbox-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state) return;

  const inbox     = getInbox();
  const todoCount = inbox.length;

  container.innerHTML = `
    <div class="section-pad" style="padding-bottom:0;">
      <div class="inbox-header">
        <div>
          <div class="section-title">Inbox</div>
        </div>
        <div class="inbox-count ${todoCount > 0 ? 'has-mail' : ''}" id="inbox-count">
          ${todoCount} message${todoCount !== 1 ? 's' : ''}
        </div>
      </div>

      <div class="inbox-tabs">
        <div class="inbox-tab ${_activeTab === 'todo'      ? 'active' : ''}" id="itab-todo">
          To Do
          ${todoCount > 0 ? `<span class="tab-badge">${Math.min(todoCount,99)}</span>` : ''}
        </div>
        <div class="inbox-tab ${_activeTab === 'completed' ? 'active' : ''}" id="itab-completed">
          Completed
        </div>
        <div class="inbox-tab ${_activeTab === 'compose'   ? 'active' : ''}" id="itab-compose">
          Compose
        </div>
      </div>
    </div>

    <div id="inbox-tab-body">
      ${_renderTabBody(state, inbox)}
    </div>
  `;

  _attachTabListeners(state);
}

function _renderTabBody(state, inbox) {
  switch (_activeTab) {
    case 'todo':      return _renderToDo(inbox, state);
    case 'completed': return _renderCompleted(state);
    case 'compose':   return _renderCompose(state);
    default:          return '';
  }
}

// ─────────────────────────────────────────────────────────────
// TO DO TAB
// ─────────────────────────────────────────────────────────────

function _renderToDo(inbox, state) {
  if (inbox.length === 0) {
    return `<div class="empty-inbox">
      <div class="big">📭</div>
      <div>No decisions waiting</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px;">Check back after the next game</div>
    </div>`;
  }

  // Sort: urgent first, then by deliveredAt descending
  const sorted = [...inbox].sort((a, b) => {
    const priority = { urgent: 0, normal: 1, good: 2 };
    const pa = priority[a.type] ?? 1;
    const pb = priority[b.type] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.deliveredAt || 0) - (a.deliveredAt || 0);
  });

  const gameIdx = state.currentGameIndex || 0;

  const cards = sorted.map(card => _renderCard(card, gameIdx)).join('');

  return `<div style="padding:0 16px 16px;">${cards}</div>`;
}

function _renderCard(card, gameIdx) {
  const isExpanded  = _expandedCard === card.instanceId;
  const isUrgent    = card.type === 'urgent';
  const isGood      = card.type === 'good';
  const typeClass   = isUrgent ? 'unread type-urgent' : isGood ? 'unread type-good' : 'unread type-normal';
  const avatarClass = isUrgent ? 'av-urgent' : isGood ? 'av-good' : 'av-normal';
  const tagClass    = isUrgent ? 'tag-urgent' : isGood ? 'tag-good' : 'tag-normal';
  const tagLabel    = card._prominent ? 'ALL-STAR' : isUrgent ? 'URGENT' : isGood ? 'GOOD' : card.tag || 'INFO';
  // §17.2 / §75: a franchise moment (hosting the All-Star Game) reads as one.
  const prominent   = card._prominent
    ? ' style="margin-top:10px;border:1px solid #c9971c;border-left:4px solid #c9971c;background:linear-gradient(100deg,rgba(201,151,28,.16),transparent 70%);"'
    : ' style="margin-top:10px;"';

  // TTL countdown
  const ttlHtml = _renderTTL(card, gameIdx);

  // One button only when there is one choice. (A card that goes through by
  // default if unanswered — autoResolve 'yes' — still offers both, §92.)
  const isSingleAction = !card.noLabel || card.noLabel === card.yesLabel;

  const bodyHtml = isExpanded ? `
    <div class="msg-body open">
      <div class="msg-body-text">${_escape(card.body || '')}</div>
      <div class="msg-actions" style="${isSingleAction ? 'justify-content:center' : ''}">
        <button class="btn-yes" ${isSingleAction ? 'style="max-width:280px;flex:0 1 auto;"' : ''}
          data-resolve="${card.instanceId}" data-choice="yes">
          ${_escape(card.yesLabel || 'Accept')}
        </button>
        ${!isSingleAction ? `<button class="btn-no" data-resolve="${card.instanceId}" data-choice="no">
          ${_escape(card.noLabel)}
        </button>` : ''}
      </div>
      ${card._reviseOffer ? `<button class="btn-revise" data-revise="${card.instanceId}">${card._reviseLabel || (card._ideaOffer ? 'Adjust the Offer' : 'Make a New Offer')}</button>` : ''}
    </div>
  ` : '';

  return `
    <div class="msg-card ${typeClass}" id="card-${card.instanceId}"${prominent}>
      <div class="msg-header" data-expand="${card.instanceId}">
        <div class="msg-avatar ${avatarClass}">${card.avatar || '📋'}</div>
        <div class="msg-meta">
          <div class="msg-from">
            ${_escape(card.sender || '')}
            <span class="msg-from-tag ${tagClass}">${tagLabel}</span>
            ${ttlHtml}
          </div>
          <div class="msg-subject">${_escape(card.subject || '')}</div>
          <div class="msg-preview">${_escape(card.preview || '')}</div>
        </div>
        <div class="unread-dot"></div>
      </div>
      ${bodyHtml}
    </div>
  `;
}

function _renderTTL(card, gameIdx) {
  // A real-time deadline on a decision (roster decisions §65, pre-game cards
  // §74, All-Star week §75): show the clock time it's due. A notice (nothing
  // to decide) just leaves the inbox when it's stale — no chip.
  if (Number.isFinite(card.expiresAtMs) && card.autoResolve !== 'skip') {
    const left = card.expiresAtMs - Date.now();
    // A deadline more than a day out names its day (offseason decisions, §70).
    const d    = new Date(card.expiresAtMs);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const at   = left > 20 * 3600_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : time;
    const cls  = left < 3 * 3600_000 ? 'ttl-badge ttl-warn' : 'ttl-badge';
    return `<span class="${cls}">⏰ by ${at}</span>`;
  }
  if (!card.expiresAt) return '';
  const gamesLeft = card.expiresAt - gameIdx;
  if (gamesLeft <= 0) return `<span class="ttl-badge">⏰ Expiring</span>`;
  if (gamesLeft <= 1) return `<span class="ttl-badge ttl-warn">⏰ 1g left</span>`;
  if (gamesLeft <= 2) return `<span class="ttl-badge ttl-warn">⏰ ${gamesLeft}g</span>`;
  return '';
}

// ─────────────────────────────────────────────────────────────
// COMPLETED TAB
// ─────────────────────────────────────────────────────────────

function _renderCompleted(state) {
  const history = getHistory(100);

  // Undo (left) appears after a delete; Delete All (right) when there is history.
  const undoBtn = _undoCleared?.length
    ? `<button class="completed-tool" id="completed-undo">↩ Undo</button>` : '<span></span>';
  const toolbar = (history.length || _undoCleared?.length) ? `
    <div class="completed-toolbar">
      ${undoBtn}
      ${history.length ? `<button class="completed-tool muted" id="completed-delete-all">Delete All</button>` : ''}
    </div>` : '';

  if (history.length === 0) {
    return `<div style="padding:8px 16px 0;">${toolbar}</div>
    <div class="empty-completed">
      <div style="font-size:40px;margin-bottom:10px;">✅</div>
      <div style="font-size:14px;color:var(--muted);">No completed messages</div>
    </div>`;
  }

  const cards = history.map(card => {
    const choiceLabel = card.choice === 'yes' ? card.yesLabel || 'Accepted'
                      : card.choice === 'no'  ? card.noLabel  || 'Declined'
                      : card.choice === 'auto' ? (card._autoLabel || 'Auto-resolved')
                      : 'Dismissed';
    const choiceCls   = card.choice === 'yes' ? 'yes'
                      : card.choice === 'no'  ? 'no'
                      : 'dismissed';
    const gameRef     = card.resolvedAt !== null && card.resolvedAt !== undefined
                      ? `Game ${card.resolvedAt + 1}`
                      : '';

    return `
      <div class="completed-card">
        <div class="completed-avatar">${card.avatar || '📋'}</div>
        <div class="completed-meta">
          <div class="completed-from">${_escape(card.sender || '')}</div>
          <div class="completed-subject">${_escape(card.subject || '')}</div>
          <span class="completed-action ${choiceCls}">${_escape(choiceLabel)}</span>
          ${gameRef ? `<div class="completed-game">${gameRef}</div>` : ''}
        </div>
        <button class="completed-del" data-clear="${card.instanceId}" title="Delete" aria-label="Delete">×</button>
      </div>
    `;
  }).join('');

  return `<div style="padding:8px 16px 16px;">${toolbar}${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────
// COMPOSE TAB
// ─────────────────────────────────────────────────────────────

function _renderCompose(state) {
  const gameIdx   = state.currentGameIndex || 0;
  const cooldowns = state.composeCooldowns || {};

  const recipientGrid = COMPOSE_CHANNELS.map(ch => {
    const onCooldown = _isOnCooldown(ch, cooldowns, gameIdx);
    const left       = onCooldown ? _cooldownGamesLeft(ch, cooldowns, gameIdx) : 0;
    const isSel      = _composeChannel === ch.id;
    return `<div class="compose-recipient-btn${isSel ? ' selected' : ''}" data-channel="${ch.id}">
      <div class="compose-recipient-icon">${ch.icon}</div>
      <div class="compose-recipient-label">${ch.label}</div>
      ${onCooldown ? `<div style="font-size:9px;color:var(--muted);margin-top:2px;">📵 ${left}g</div>` : ''}
    </div>`;
  }).join('');

  let topicSection = '';
  if (_composeChannel) {
    const ch = COMPOSE_CHANNELS.find(c => c.id === _composeChannel);
    if (ch) {
      const onCooldown = _isOnCooldown(ch, cooldowns, gameIdx);
      if (onCooldown) {
        const left = _cooldownGamesLeft(ch, cooldowns, gameIdx);
        topicSection = `<div style="background:var(--surface2);border-radius:10px;padding:12px 14px;text-align:center;color:var(--muted);font-size:12px;margin-bottom:18px;">
          <div style="font-size:18px;margin-bottom:6px;">📵</div>
          <div style="font-weight:600;color:var(--soft);margin-bottom:4px;">Recently contacted</div>
          <div>Available again in <strong>${left} game${left !== 1 ? 's' : ''}</strong></div>
        </div>`;
      } else {
        const rows = ch.topics.map(t => {
          const isSel = _composeTopic === t.id;
          const tCool = cooldowns[t.id] !== undefined &&
            (gameIdx - (cooldowns[t.id] || 0)) < (t.cooldown || COMPOSE_COOLDOWN_GAMES);
          const tLeft = tCool ? Math.max(0,
            (t.cooldown || COMPOSE_COOLDOWN_GAMES) - (gameIdx - (cooldowns[t.id] || 0))) : 0;
          if (tCool) {
            return `<div class="compose-topic-btn disabled" style="opacity:.4;cursor:default;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <span>${t.label}</span>
                <span style="font-size:10px;color:var(--muted);">Available in ${tLeft}g</span>
              </div>
              <span class="topic-desc">${t.desc}</span>
            </div>`;
          }
          return `<div class="compose-topic-btn${isSel ? ' selected' : ''}" data-topic="${t.id}">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <span>${t.label}</span>
              <span style="font-size:10px;color:var(--muted);">· ${t.cooldown || COMPOSE_COOLDOWN_GAMES}g lockout</span>
            </div>
            <span class="topic-desc">${t.desc}</span>
          </div>`;
        }).join('');
        topicSection = `<div style="margin-bottom:8px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Topic</div>
          <div class="compose-topic-list">${rows}</div>`;
      }
    }
  }

  const canSend = _composeChannel && _composeTopic;
  return `<div style="padding:0 16px 24px;">
    <div style="margin-bottom:6px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Send a message to…</div>
    <div class="compose-recipient-grid" style="margin-bottom:18px;">${recipientGrid}</div>
    ${topicSection}
    <button class="compose-send-btn" ${canSend ? '' : 'disabled'} id="compose-send-btn">Send Message</button>
  </div>`;
}

function _isOnCooldown(channel, cooldowns, gameIdx) {
  return channel.topics.every(t => {
    const lastUsed = cooldowns[t.id];
    return lastUsed !== undefined &&
      (gameIdx - lastUsed) < (t.cooldown || COMPOSE_COOLDOWN_GAMES);
  });
}

function _cooldownGamesLeft(channel, cooldowns, gameIdx) {
  const vals = channel.topics.map(t => {
    const lastUsed = cooldowns[t.id];
    if (lastUsed === undefined) return 0;
    return Math.max(0, (t.cooldown || COMPOSE_COOLDOWN_GAMES) - (gameIdx - lastUsed));
  });
  return Math.max(...vals, 0);
}

function _renderTopicList() { return ''; }



// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachTabListeners(state) {
  // Tab switching
  const tabs = [
    { id: 'itab-todo',      tab: 'todo'      },
    { id: 'itab-completed', tab: 'completed' },
    { id: 'itab-compose',   tab: 'compose'   },
  ];
  for (const { id, tab } of tabs) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => {
      if (_activeTab === 'compose' && tab !== 'compose') {
        _composeChannel = null;
        _composeTopic   = null;
      }
      _activeTab    = tab;
      _expandedCard = null;
      refresh();
    });
  }

  // Card expand/collapse
  document.querySelectorAll('[data-expand]').forEach(el => {
    el.addEventListener('click', () => {
      const id   = el.dataset.expand;
      // §92 every card expands in place, whatever its length.
      _expandedCard = _expandedCard === id ? null : id;
      refresh();
    });
  });

  // §85 a counter we want to answer with our own revised offer
  document.querySelectorAll('[data-revise]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = getInbox().find(c => c.instanceId === btn.dataset.revise);
      const r = card?._reviseOffer;
      if (!r) return;
      const { openTradeComposer } = await import('../components/TradeComposer.js');
      openTradeComposer({ teamId: r.teamId, theirIds: r.offer.incomingIds || [], ourIds: r.offer.outgoingIds || [],
                          cashK: r.offer.cashK || 0, retain: r.offer.retain || {}, round: r.round });
    });
  });

  // Card resolution buttons
  document.querySelectorAll('[data-resolve]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const instanceId = btn.dataset.resolve;
      const choice     = btn.dataset.choice;
      await _resolveCard(instanceId, choice);
    });
  });

  // Completed tab: delete one / delete all / undo (§63)
  document.querySelectorAll('[data-clear]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _undoCleared = clearHistory([btn.dataset.clear]);
      refresh();
    });
  });
  document.getElementById('completed-delete-all')?.addEventListener('click', () => {
    _undoCleared = clearHistory('all');
    refresh();
  });
  document.getElementById('completed-undo')?.addEventListener('click', () => {
    restoreHistory(_undoCleared);
    _undoCleared = null;
    refresh();
  });

  // Compose channel selection
  document.querySelectorAll('[data-channel]').forEach(el => {
    el.addEventListener('click', () => {
      const ch = COMPOSE_CHANNELS.find(c => c.id === el.dataset.channel);
      if (!ch) return;
      if (ch.id === 'other_gms') {
        import('../components/TradeComposer.js').then(m => m.openTradeComposer({}));
        return;
      }
      const onCooldown = _isOnCooldown(ch, state.composeCooldowns || {}, state.currentGameIndex || 0);
      if (onCooldown) return;
      _composeChannel = el.dataset.channel;
      _composeTopic   = null;
      refresh();
    });
  });

  // Compose topic selection
  document.querySelectorAll('[data-topic]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      _composeTopic = el.dataset.topic;
      refresh();
    });
  });

  // Compose send button
  const sendBtn = document.getElementById('compose-send-btn');
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.addEventListener('click', async () => {
      if (!_composeChannel || !_composeTopic) return;
      await _sendCompose(_composeTopic, _composeChannel, state);
    });
  }
}


/**
 * _resolveCard(instanceId, choice)
 * The ONE path that resolves an inbox decision — the inline Yes/No buttons
 * (§62). Before r57 the inline buttons called this function but it did not
 * exist, so only long cards (which then opened in a sheet) could be decided.
 * Since §92 every card expands inline.
 */
async function _resolveCard(instanceId, choice) {
  try {
    const card = getInbox().find(c => c.instanceId === instanceId);
    if (!card) {
      // Withdrawn while open — its situation was already handled (§65).
      App.showToast('That message is no longer needed — it was already taken care of.', 'neutral', 3000);
      _expandedCard = null;
      refresh();
      return;
    }
    const { resolve } = await import('../../engine/CardEngine.js');
    const before = snapshotMetrics(StateManager.get());
    resolve(instanceId, choice);
    const after  = snapshotMetrics(StateManager.get());
    EventBus.emit('card:resolved', { instanceId, choice });
    if (card._rosterKey || card._tradeOffer) {
      // Roster decisions take effect on the roster clock right away (§65).
      const { advanceClock } = await import('../../engine/GameEngine.js');
      advanceClock(Date.now());
      EventBus.emit('roster:changed', { source: 'inbox', instanceId });
    }
    _expandedCard = null;
    // Outcome line ("Upgrades complete. Players will notice.") as the headline,
    // with animated bars for every metric the decision moved (§63). Falls back
    // to a plain toast when nothing measurable changed.
    const msg   = (choice === 'yes' ? card?.yesMsg : card?.noMsg)
               || (choice === 'yes' ? (card?.yesLabel || 'Decision made.') : (card?.noLabel || 'Declined.'));
    const shown = App.showDecisionEffects({ title: msg, before, after, positive: choice === 'yes' });
    if (!shown) App.showToast(msg, choice === 'yes' ? 'positive' : 'neutral', 3500);
    App.updateHeader(StateManager.get());   // budget in the header
  } catch (err) {
    console.error('InboxScreen._resolveCard:', err);
    App.showToast('That decision could not be saved. Please try again.', 'negative', 3000);
  }
  refresh();
}

async function _sendCompose(topicId, channelId, state) {
  const gameIdx = state.currentGameIndex || 0;

  // Record cooldown immediately
  StateManager.mutate(s => {
    s.composeCooldowns = { ...(s.composeCooldowns || {}), [topicId]: gameIdx };
  });

  // Deliver a compose card via CardEngine
  // The card pool generates the appropriate response card from the topic
  try {
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    if (typeof deliverComposeCard === 'function') {
      deliverComposeCard(topicId, channelId);
    }
  } catch (_) {
    // deliverComposeCard is added in a future content phase — graceful fallback
  }

  // panel reset handled by refresh()
  _activeTab = 'todo';

  App.showToast(`Message sent to ${COMPOSE_CHANNELS.find(c => c.id === channelId)?.label || 'staff'}.`, 'positive', 2500);
  EventBus.emit('card:delivered', { source: 'compose', topicId });

  refresh();
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
    /* Compose topic panel slide */
    #compose-topic-panel{animation:slideUp .2s ease;}
    .completed-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;min-height:28px;}
    .completed-tool{font-size:11px;font-weight:700;padding:5px 10px;border-radius:8px;border:1px solid var(--accent);color:var(--accent);background:transparent;cursor:pointer;}
    .completed-tool.muted{border-color:var(--border);color:var(--muted);}
    .completed-card{position:relative;}
    .completed-del{margin-left:auto;align-self:flex-start;flex-shrink:0;width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:16px;line-height:1;cursor:pointer;}
    @keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  `;
  document.head.appendChild(style);
}
