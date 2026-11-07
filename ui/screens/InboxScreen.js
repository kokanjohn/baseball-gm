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
    icon:     '⚾',
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

  // (Compose too: a reply arriving leaves "Waiting to hear back", §105.)
  wire('card:delivered',   () => { if (_activeTab === 'todo' || _activeTab === 'compose') refresh(); });
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

// §94 when a message reached the inbox: the time today, "Yesterday", the
// weekday this week, the date before that; in full when the card is open.
function _clock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function _shortWhen(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return _clock(ms);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function _longWhen(ms) {
  return `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${_clock(ms)}`;
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
      ${Number.isFinite(card.arrivedAtMs) ? `<div class="msg-received">Received ${_longWhen(card.arrivedAtMs)}</div>` : ''}
      <div class="msg-body-text">${_escape(card.body || '')}</div>
      ${card._choices?.length ? `
      <div class="msg-choices">
        ${card._choices.map((c, i) => `
        <button class="msg-choice${i === 0 ? ' recommended' : ''}" data-resolve="${card.instanceId}" data-choice="yes" data-pick="${_escape(c.key)}">
          <span class="mc-label">${_escape(c.label)}${i === 0 ? ' <span class="mc-rec">Recommended</span>' : ''}</span>
          ${c.sub ? `<span class="mc-sub">${_escape(c.sub)}</span>` : ''}
        </button>`).join('')}
        ${card.noLabel ? `<button class="msg-choice alt" data-resolve="${card.instanceId}" data-choice="no">
          <span class="mc-label">${_escape(card.noLabel)}</span></button>` : ''}
      </div>` : `
      <div class="msg-actions" style="${isSingleAction ? 'justify-content:center' : ''}">
        <button class="btn-yes" ${isSingleAction ? 'style="max-width:280px;flex:0 1 auto;"' : ''}
          data-resolve="${card.instanceId}" data-choice="yes">
          ${_escape(card.yesLabel || 'Accept')}
        </button>
        ${!isSingleAction ? `<button class="btn-no" data-resolve="${card.instanceId}" data-choice="no">
          ${_escape(card.noLabel)}
        </button>` : ''}
      </div>`}
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
        <div class="msg-side">
          ${Number.isFinite(card.arrivedAtMs) ? `<div class="msg-time">${_shortWhen(card.arrivedAtMs)}</div>` : ''}
          <div class="unread-dot"></div>
        </div>
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

  // §95 each decided message in full: who sent it and when, the whole
  // message, the decision, and how it turned out.
  const cards = history.map(card => {
    const auto = card.choice === 'auto';
    const autoPick = card.autoChoice || null;
    const decision = card.choice === 'yes' ? (card.yesLabel || 'Accepted')
                   : card.choice === 'no'  ? (card.noLabel  || 'Declined')
                   : auto ? (card._autoLabel || (autoPick === 'yes' ? card.yesLabel : autoPick === 'no' ? card.noLabel : null) || 'Decided by default')
                   : (card.yesLabel || 'Read');
    const choiceCls = card.choice === 'yes' ? 'yes' : card.choice === 'no' ? 'no' : 'dismissed';
    const outcome = card.choice === 'yes' ? card.yesMsg
                  : card.choice === 'no'  ? card.noMsg
                  : auto ? (card.expireMsg || (autoPick === 'yes' ? card.yesMsg : autoPick === 'no' ? card.noMsg : null))
                  : null;
    const decidedLine = card.choice === 'skip' ? 'Read' : auto ? 'No answer in time — decided by default' : 'Your decision';
    const when = [
      Number.isFinite(card.arrivedAtMs)  ? `Received ${_longWhen(card.arrivedAtMs)}` : '',
      Number.isFinite(card.resolvedAtMs) ? `${card.choice === 'skip' ? 'Read' : 'Decided'} ${_longWhen(card.resolvedAtMs)}` : '',
    ].filter(Boolean).join(' · ');
    const tagLabel = card.tag || 'INFO';

    return `
      <div class="completed-card completed-full">
        <div class="completed-head">
          <div class="completed-avatar">${card.avatar || '📋'}</div>
          <div class="completed-meta">
            <div class="completed-from">${_escape(card.sender || '')} <span class="msg-from-tag tag-normal">${_escape(tagLabel)}</span></div>
            <div class="completed-subject">${_escape(card.subject || '')}</div>
          </div>
          <button class="completed-del" data-clear="${card.instanceId}" title="Delete" aria-label="Delete">×</button>
        </div>
        ${when ? `<div class="completed-when">${when}</div>` : ''}
        <div class="completed-body">${_escape(card.body || card.preview || '')}</div>
        <div class="completed-decision">
          <div class="completed-decision-label">${decidedLine}</div>
          ${card.choice === 'skip' ? '' : `<span class="completed-action ${choiceCls}">${_escape(decision)}</span>`}
          ${outcome ? `<div class="completed-outcome">${_escape(outcome)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `<div style="padding:8px 16px 16px;">${toolbar}${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────
// COMPOSE TAB
// ─────────────────────────────────────────────────────────────

function _renderCompose(state) {
  // §105 Two steps, each a screen of its own: who (the list of people), then what (that person's
  // topics, with Send right under them) — the topics are never below the fold after picking someone.
  const ch = _composeChannel && COMPOSE_CHANNELS.find(c => c.id === _composeChannel);
  return `<div id="compose-panel" style="padding:0 16px 24px;">${ch ? _composeTopics(state, ch) : _composeRecipients(state)}</div>`;
}

/** Topic state for one topic: awaiting a reply, cooling down (games left), or open. */
function _topicState(t, state) {
  const gameIdx = state.currentGameIndex || 0, cd = state.composeCooldowns || {};
  const waiting = (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id);
  if (waiting) return { waiting };
  const span = t.cooldown || COMPOSE_COOLDOWN_GAMES;
  const left = cd[t.id] !== undefined ? Math.max(0, span - (gameIdx - cd[t.id])) : 0;
  return { left };
}

function _composeRecipients(state) {
  const waiting = (state.scheduledCards || []).filter(c => c.isCompose).sort((a, b) => (a._sentAtMs || 0) - (b._sentAtMs || 0));
  const waitingHtml = waiting.length ? `
    <div class="compose-h">Waiting to hear back</div>
    <div class="compose-waiting">${waiting.map(c => {
      const who = COMPOSE_CHANNELS.find(x => x.id === c._composeChannel)?.label || c.sender || 'Staff';
      return `<div class="compose-wait-row"><span class="cw-who">${_escape(who)}</span>
        <span class="cw-what">${_escape(c._composeLabel || '')}${c._sentAtMs ? ` · sent ${_shortWhen(c._sentAtMs)}` : ''}</span></div>`;
    }).join('')}</div>` : '';

  const STAFF_KEY = { pitching_coach: 'pitchingCoach', hitting_coach: 'hittingCoach', bench_coach: 'benchCoach', bullpen_coach: 'bullpenCoach' };
  const rows = COMPOSE_CHANNELS.map(ch => {
    // §112.2 an empty chair on the staff: nobody to write to until someone's hired.
    if (state.userTeam?.coachingStaff?.[STAFF_KEY[ch.id]]?.vacant) {
      return `<div class="compose-person" aria-disabled="true" style="opacity:.55">
        <span class="cp-main"><span class="cp-name">${_escape(ch.label)}</span><span class="cp-sub">Vacant · hiring</span></span></div>`;
    }
    let sub;
    if (ch.id === 'other_gms') sub = 'Trade talks with the other clubs';
    else {
      const st = ch.topics.map(t => _topicState(t, state));
      const open = st.filter(x => !x.waiting && !x.left).length;
      const wait = st.filter(x => x.waiting).length;
      sub = open ? `${open} topic${open !== 1 ? 's' : ''}${wait ? ` · awaiting ${wait} repl${wait !== 1 ? 'ies' : 'y'}` : ''}`
          : wait ? `Awaiting a reply`
          : `Recently contacted · again in ${Math.min(...st.map(x => x.left))} game${Math.min(...st.map(x => x.left)) !== 1 ? 's' : ''}`;
    }
    return `<button type="button" class="compose-person" data-channel="${ch.id}">
      <span class="cp-main"><span class="cp-name">${_escape(ch.label)}</span><span class="cp-sub">${_escape(ch.role)} · ${_escape(sub)}</span></span>
      <span class="cp-go">›</span></button>`;
  }).join('');

  return `${waitingHtml}
    <div class="compose-h">Send a message to…</div>
    <div class="compose-people">${rows}</div>`;
}

function _composeTopics(state, ch) {
  const rows = ch.topics.map(t => {
    const st = _topicState(t, state);
    const isSel = _composeTopic === t.id;
    const note = st.waiting ? `Sent ${_shortWhen(st.waiting._sentAtMs)} · awaiting reply`
      : st.left ? `Available again in ${st.left} game${st.left !== 1 ? 's' : ''}` : '';
    const off = !!(st.waiting || st.left);
    return `<div class="compose-topic-btn${isSel ? ' selected' : ''}${off ? ' disabled' : ''}" ${off ? '' : `data-topic="${t.id}"`}>
      <span>${_escape(t.label)}</span>
      <span class="topic-desc">${_escape(note || t.desc)}</span>
    </div>`;
  }).join('');
  const canSend = !!_composeTopic;
  return `
    <button type="button" class="compose-back" id="compose-back">‹ All recipients</button>
    <div class="compose-to"><span class="compose-to-label">To</span> ${_escape(ch.label)}<span class="compose-to-role">${_escape(ch.role)}</span></div>
    <div class="compose-h">What about?</div>
    <div class="compose-topic-list">${rows}</div>
    <button class="compose-send-btn" ${canSend ? '' : 'disabled'} id="compose-send-btn">${canSend ? 'Send Message' : 'Pick a topic'}</button>
    <div class="compose-cooldown-note">Replies come back later, the way they would from a real staff — field staff answer after the game.</div>`;
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
      await _resolveCard(instanceId, choice, btn.dataset.pick ?? null);
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

  // Compose: pick a person (step 1) → that person's topics (step 2), shown from the top.
  document.querySelectorAll('[data-channel]').forEach(el => {
    el.addEventListener('click', () => {
      const ch = COMPOSE_CHANNELS.find(c => c.id === el.dataset.channel);
      if (!ch) return;
      if (ch.id === 'other_gms') {
        import('../components/TradeComposer.js').then(m => m.openTradeComposer({}));
        return;
      }
      _composeChannel = ch.id;
      // One open topic: picked already.
      const open = ch.topics.filter(t => { const st = _topicState(t, StateManager.get()); return !st.waiting && !st.left; });
      _composeTopic = open.length === 1 ? open[0].id : null;
      refresh();
      _composeToTop();
    });
  });
  document.getElementById('compose-back')?.addEventListener('click', () => {
    _composeChannel = null; _composeTopic = null;
    refresh();
    _composeToTop();
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
async function _resolveCard(instanceId, choice, pick = null) {
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
    resolve(instanceId, choice, { pick });
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
    const picked = pick != null ? card?._choices?.find(c => c.key === pick)?.label : null;
    const msg   = (choice === 'yes' ? card?.yesMsg : card?.noMsg)
               || (choice === 'yes' ? (picked || card?.yesLabel || 'Decision made.') : (card?.noLabel || 'Declined.'));
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
  const ch = COMPOSE_CHANNELS.find(c => c.id === channelId);
  const topic = ch?.topics.find(t => t.id === topicId);

  // Record cooldown immediately
  StateManager.mutate(s => {
    s.composeCooldowns = { ...(s.composeCooldowns || {}), [topicId]: gameIdx };
  });

  // §105 the reply is written now and arrives later (CardEngine schedules it; a push when it lands).
  try {
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    deliverComposeCard(topicId, channelId, { topicLabel: topic?.label || '' });
    import('../PushClient.js').then(P => P.syncPushSchedule()).catch(() => {});
  } catch (err) {
    console.error('InboxScreen._sendCompose:', err);
  }

  // Back to the list, where the message waits under "Waiting to hear back".
  _composeChannel = null;
  _composeTopic   = null;
  App.showToast(`Message sent to ${ch?.label || 'staff'}. You'll hear back.`, 'positive', 2500);
  refresh();
  _composeToTop();
}

function _composeToTop() {
  document.getElementById('compose-panel')?.scrollIntoView({ block: 'start' });
  document.querySelector('.inbox-tabs')?.scrollIntoView({ block: 'start' });
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
    /* Compose (§105): who, then what */
    #compose-panel{animation:slideUp .2s ease;}
    .compose-h{margin:4px 0 8px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}
    .compose-people{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
    .compose-person{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:11px 14px;cursor:pointer;color:var(--text);}
    .compose-person:active{opacity:.8;}
    .cp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
    .cp-name{font-size:14px;font-weight:700;}
    .cp-sub{font-size:11px;color:var(--muted);}
    .cp-go{font-size:20px;color:var(--muted);line-height:1;}
    .compose-waiting{display:flex;flex-direction:column;gap:4px;margin-bottom:16px;background:var(--surface2);border-radius:12px;padding:10px 14px;}
    .compose-wait-row{display:flex;flex-direction:column;font-size:12px;}
    .cw-who{font-weight:700;color:var(--text);}
    .cw-what{color:var(--muted);font-size:11px;}
    .compose-back{font:inherit;font-size:13px;font-weight:700;color:var(--accent);background:none;border:none;padding:4px 0 10px;cursor:pointer;}
    .compose-to{font-size:17px;font-weight:800;color:var(--text);margin-bottom:14px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
    .compose-to-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}
    .compose-to-role{font-size:12px;font-weight:600;color:var(--muted);}
    .completed-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;min-height:28px;}
    .completed-tool{font-size:11px;font-weight:700;padding:5px 10px;border-radius:8px;border:1px solid var(--accent);color:var(--text);background:transparent;cursor:pointer;}
    .completed-tool.muted{border-color:var(--border);color:var(--muted);}
    .completed-card{position:relative;}
    .completed-full{display:block;padding:14px 16px;}
    .completed-head{display:flex;align-items:flex-start;gap:10px;}
    .completed-full .completed-from{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;font-weight:700;color:var(--text);}
    .completed-full .completed-subject{font-size:14px;margin-top:3px;margin-bottom:0;}
    .completed-when{font-size:11px;font-weight:600;color:var(--muted);margin-top:10px;}
    .completed-body{font-size:14px;color:var(--soft);line-height:1.65;margin-top:6px;white-space:pre-line;}
    .completed-decision{margin-top:12px;padding-top:10px;border-top:1px solid var(--border);}
    .completed-decision-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
    .completed-outcome{font-size:13px;color:var(--text);line-height:1.5;margin-top:8px;}
    .completed-del{margin-left:auto;align-self:flex-start;flex-shrink:0;width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:16px;line-height:1;cursor:pointer;}
    @keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  `;
  document.head.appendChild(style);
}
