/**
 * ui/screens/InboxScreen.js
 * Messages (the bottom nav's Messages tab) rendered into #inbox-content.
 *
 * Three internal tabs (Section 1.14 — LOCKED; §115 renamed):
 *   Inbox     — unresolved cards requiring GM decision
 *   Completed — resolved cards (newest decision first)
 *   Compose   — initiate conversations with staff/departments
 *
 * §115 it reads like a mail app (Gmail / Outlook on a phone): a list of rows
 * (initials, sender, time, subject, a line of preview, labels; bold until
 * opened), with what's due soon under "Important"; tapping a row opens the
 * message full-screen (back to the list with "‹ Inbox"), the decision at the
 * bottom like a reply. A completed message opens as its thread: the message,
 * your reply (the decision), and how it turned out.
 *
 * Rules:
 *   - Card resolution calls CardEngine.resolve() — never direct state writes.
 *   - Compose channels use composeCooldowns from state to prevent repeat use.
 *   - Urgent cards (type === 'urgent') carry an "Urgent" label and sit under Important.
 *   - Inbox tab shows the count of messages waiting, matching the nav badge.
 *   - Compose tab respects Section 8.12 channel map (LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getInbox, getHistory, clearHistory, restoreHistory, markRead } from '../../engine/CardEngine.js';
import { snapshotMetrics } from '../formatters.js';
import * as When from '../../engine/When.js';
import { dealsFor } from '../../engine/TradeAdvice.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab      = 'todo';   // 'todo' | 'completed' | 'compose'
let _undoCleared    = null;     // instanceIds from the last Delete / Delete All (session only)
let _openCard       = null;     // §115 instanceId of the message open in the reading view
let _listScroll     = 0;        // the list's scroll position, restored on the way back
let _composeChannel = null;     // currently selected compose channel id
let _composeTopic   = null;     // currently selected compose topic id
let _composeDeal    = null;     // r150 the deal a trade topic asks about (its key)
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
      { id: 'mgr_trade',     label: 'A trade on the table',     desc: 'How a deal would change us on the field, with the coaches\' read on who\'s coming in', deal: true },
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
      { id: 'pc_prospect',   label: 'Young pitcher check-in',   desc: 'A report on a young arm — and a development plan if you want one' },
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
      { id: 'hc_development', label: 'Development check-in',    desc: 'A young hitter\'s progress — and a development plan if you want one' },
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
      { id: 'sc_free_agents', label: 'Free agents worth a look', desc: 'The scouts look over the free agents (a few a week, by the director)' },
      { id: 'sc_prospect',   label: 'Young player report',      desc: 'A scouting report on one of our young players' },
      { id: 'sc_opponent',   label: 'Opponent scouting',        desc: 'Ask about an upcoming opponent\'s tendencies' },
      { id: 'sc_trade',      label: 'Is there a better deal?',  desc: 'The director\'s counter to a trade on the table, and what the deal does to payroll', deal: true },
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
    _openCard = null;
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

  // §115 a message open full-screen (it may have been withdrawn or decided meanwhile).
  if (_openCard) {
    const open = _activeTab === 'completed' ? getHistory(100).find(c => c.instanceId === _openCard)
                                            : inbox.find(c => c.instanceId === _openCard);
    if (open) {
      container.innerHTML = _activeTab === 'completed' ? _renderThread(open, state) : _renderReading(open, inbox, state);
      _attachTabListeners(state);
      return;
    }
    _openCard = null;
  }

  const unread = inbox.filter(c => !c._readAt).length;
  container.innerHTML = `
    <div class="section-pad" style="padding-bottom:0;">
      <div class="inbox-header">
        <div>
          <div class="section-title">Messages</div>
        </div>
        ${unread > 0 ? `<div class="inbox-count has-mail" id="inbox-count">${unread} unread</div>` : ''}
      </div>

      <div class="inbox-tabs">
        <div class="inbox-tab ${_activeTab === 'todo'      ? 'active' : ''}" id="itab-todo">
          Inbox
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
// INBOX TAB — the list (§115)
// ─────────────────────────────────────────────────────────────

/** Important: urgent, a franchise moment, or due within six hours (Gmail's Priority Inbox, more or less). */
function _isImportant(card) {
  if (card.type === 'urgent' || card._prominent) return true;
  return Number.isFinite(card.expiresAtMs) && card.autoResolve !== 'skip' && card.expiresAtMs - Date.now() < 6 * 3600_000;
}

/** The inbox newest first, Important on top. */
function _inboxOrder(inbox) {
  const newest = (a, b) => (b.arrivedAtMs || b.deliveredAt || 0) - (a.arrivedAtMs || a.deliveredAt || 0);
  return [...inbox.filter(_isImportant).sort(newest), ...inbox.filter(c => !_isImportant(c)).sort(newest)];
}

function _renderToDo(inbox, state) {
  if (inbox.length === 0) {
    return `<div class="ml-empty">
      <div class="ml-empty-h">You're all caught up</div>
      <div class="ml-empty-s">New messages arrive as the season moves. Check back after the next game.</div>
    </div>`;
  }
  const ordered = _inboxOrder(inbox);
  const important = ordered.filter(_isImportant), rest = ordered.filter(c => !_isImportant(c));
  const section = (title, cards) => cards.length
    ? `${important.length && rest.length ? `<div class="ml-section">${title}</div>` : ''}${cards.map(c => _renderRow(c)).join('')}` : '';
  return `<div class="ml-list">${section('Important', important)}${section('Everything else', rest)}</div>`;
}

// §94 when a message reached the inbox — r148 relative, never a calendar date
// (the real calendar and the season's calendar differ; a date here would
// contradict the Schedule): the time today, "Yesterday", "3 days ago",
// "2 weeks ago"; in full when the card is open ("Today at 8:40 PM").
function _clock(ms) { return When.clockText(ms); }
const _shortWhen = (ms) => When.agoShort(ms, Date.now());
const _longWhen  = (ms) => When.agoFull(ms, Date.now());

// §115 a sender's initials in a colored circle (text, not an icon): the same
// sender is always the same color.
const _AV_COLORS = ['#3B6FD6', '#2E9E6A', '#B5562B', '#7A55C7', '#C23F6A', '#2D8C9E', '#8A7A1E', '#5B6B82'];
function _initials(sender) {
  const words = String(sender || '?').replace(/'s\b/g, '').split(/[\s&/-]+/).filter(w => /^[A-Za-z]/.test(w));
  const caps = words.filter(w => /^[A-Z]/.test(w));
  const use = (caps.length ? caps : words).slice(0, 2);
  return use.map(w => w[0].toUpperCase()).join('') || '?';
}
function _avatar(sender, cls = 'ml-av', { me = false } = {}) {
  let h = 2166136261;                                      // FNV-1a: a better spread of colors
  for (const ch of String(sender || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const bg = me ? '#1F8A5B' : _AV_COLORS[h % _AV_COLORS.length];   // (your own replies: one fixed color)
  return `<div class="${cls}" style="background:${bg}">${_escape(_initials(sender))}</div>`;
}

/** The message's labels (Gmail's chips): its kind, urgent / good news / All-Star, and a deadline. */
function _labels(card, { withDue = true } = {}) {
  const out = [];
  if (card._prominent) out.push(['All-Star', 'lbl-gold']);
  else if (card.type === 'urgent') out.push(['Urgent', 'lbl-red']);
  else if (card.type === 'good') out.push(['Good news', 'lbl-green']);
  if (card.tag && !['INFO'].includes(card.tag)) {
    const t = String(card.tag).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bIl\b/, 'IL');
    out.push([t, 'lbl-plain']);
  }
  const due = withDue ? _dueText(card) : null;
  if (due) out.push([due.text, due.soon ? 'lbl-red' : 'lbl-amber']);
  return out.map(([t, c]) => `<span class="ml-label ${c}">${_escape(t)}</span>`).join('');
}

/**
 * A real-time deadline on a decision (roster decisions §65, pre-game cards §74,
 * All-Star week §75, the offseason §70): "Due 7:05 PM" / "Due Tue 7:05 PM".
 * A notice (nothing to decide) just leaves when it's stale: no label.
 */
function _dueText(card) {
  if (Number.isFinite(card.expiresAtMs) && card.autoResolve !== 'skip') {
    const left = card.expiresAtMs - Date.now();
    const d    = new Date(card.expiresAtMs);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const at   = left > 20 * 3600_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : time;
    return { text: `Due ${at}`, soon: left < 3 * 3600_000 };
  }
  if (!card.expiresAt) return null;
  const gamesLeft = card.expiresAt - (StateManager.get()?.currentGameIndex || 0);
  if (gamesLeft <= 0) return { text: 'Due now', soon: true };
  if (gamesLeft <= 2) return { text: `Due in ${gamesLeft} game${gamesLeft === 1 ? '' : 's'}`, soon: gamesLeft <= 1 };
  return null;
}

function _renderRow(card) {
  const unread = !card._readAt;
  const when = Number.isFinite(card.arrivedAtMs) ? _shortWhen(card.arrivedAtMs) : '';
  const labels = _labels(card);
  return `
    <div class="ml-row${unread ? ' unread' : ''}" data-open="${card.instanceId}" id="card-${card.instanceId}">
      ${_avatar(card.sender)}
      <div class="ml-main">
        <div class="ml-top">
          <span class="ml-from">${_escape(card.sender || '')}</span>
          <span class="ml-time">${when}</span>
        </div>
        <div class="ml-subj">${_escape(card.subject || '')}</div>
        <div class="ml-snip">${_escape(card.preview || '')}</div>
        ${labels ? `<div class="ml-labels">${labels}</div>` : ''}
      </div>
      ${unread ? '<div class="ml-dot" aria-label="Unread"></div>' : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// READING VIEW (§115)
// ─────────────────────────────────────────────────────────────

/** The body as paragraphs (a blank line, or a long run of sentences split near its middle). */
function _paragraphs(text, players = []) {
  const blocks = String(text || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => `<p>${_linkPlayers(_escape(b), players).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * r146 the players a message is about: its target, the players its text names
 * (tokens), a reply's report (memo), its choices. Each name in the text opens
 * that player's card, so anyone a message mentions can be found in one tap.
 */
function _messagePlayers(card, state) {
  const ids = new Set([card._targetPlayerId, ...Object.values(card._tokenPlayers || {}), ...(card._playerIds || []),
    ...(card._choices || []).map(c => String(c.key || '').split(':').pop())].filter(Boolean));
  const ps = [...ids].map(id => state.players?.[id]).filter(p => p?.name);
  // A name two of them share would be ambiguous: leave it plain.
  const count = {};
  for (const p of ps) count[p.name] = (count[p.name] || 0) + 1;
  return ps.filter(p => count[p.name] === 1);
}

function _linkPlayers(html, players) {
  if (!players.length) return html;
  const byName = new Map(players.map(p => [_escape(p.name), p.id]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // (with the punctuation right after it, so a line never starts with "." or ",")
  const re = new RegExp(`(?<![\\w'&#;-])(${names.join('|')})(?![\\w-])((?:&#39;s?|'s?)?[.,;:!?)]*)`, 'g');
  return html.replace(re, (m, name, tail) => {
    const btn = `<button class="msg-player" data-msg-player="${byName.get(name)}">${name}</button>`;
    return tail ? `<span class="msg-player-wrap">${btn}${tail}</span>` : btn;
  });
}

function _renderReading(card, inbox, state) {
  const list = _inboxOrder(inbox);
  const i = list.findIndex(c => c.instanceId === card.instanceId);
  const newer = i > 0 ? list[i - 1] : null, older = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  const isSingleAction = !card.noLabel || card.noLabel === card.yesLabel;
  const due = _dueText(card);
  const prominent = card._prominent ? ' mr-prominent' : '';

  const reply = card._choices?.length ? `
      <div class="msg-choices">
        ${card._choices.map((c, k) => `
        <button class="msg-choice${k === 0 ? ' recommended' : ''}" data-resolve="${card.instanceId}" data-choice="yes" data-pick="${_escape(c.key)}">
          <span class="mc-label">${_escape(c.label)}${k === 0 ? ' <span class="mc-rec">Recommended</span>' : ''}</span>
          ${c.sub ? `<span class="mc-sub">${_escape(c.sub)}</span>` : ''}
        </button>`).join('')}
        ${card.noLabel ? `<button class="msg-choice alt" data-resolve="${card.instanceId}" data-choice="no">
          <span class="mc-label">${_escape(card.noLabel)}</span></button>` : ''}
      </div>` : `
      <div class="msg-actions" style="${isSingleAction ? 'justify-content:center' : ''}">
        <button class="btn-yes" ${isSingleAction ? 'style="max-width:280px;flex:0 1 auto;"' : ''}
          data-resolve="${card.instanceId}" data-choice="yes">${_escape(card.yesLabel || 'Accept')}</button>
        ${!isSingleAction ? `<button class="btn-no" data-resolve="${card.instanceId}" data-choice="no">${_escape(card.noLabel)}</button>` : ''}
      </div>`;

  return `
    <div class="mr${prominent}">
      <div class="mr-bar">
        <button class="mr-back" id="mr-back">‹ Inbox</button>
        <div class="mr-nav">
          <button class="mr-step" ${newer ? `data-goto="${newer.instanceId}"` : 'disabled'}>Newer</button>
          <span class="mr-pos">${i + 1} of ${list.length}</span>
          <button class="mr-step" ${older ? `data-goto="${older.instanceId}"` : 'disabled'}>Older</button>
        </div>
      </div>
      <div class="mr-head">
        <h2 class="mr-subject">${_escape(card.subject || '')}</h2>
        <div class="mr-labels">${_labels(card, { withDue: false })}</div>
      </div>
      <div class="mr-sender">
        ${_avatar(card.sender, 'mr-av')}
        <div class="mr-who">
          <div class="mr-name">${_escape(card.sender || '')}</div>
          <div class="mr-to">to me${Number.isFinite(card.arrivedAtMs) ? ` · ${_longWhen(card.arrivedAtMs)}` : ''}</div>
        </div>
      </div>
      <div class="mr-body">${_paragraphs(card.body || card.preview || '', _messagePlayers(card, state))}</div>
      <div class="mr-reply">
        <div class="mr-reply-h">
          <span>Your decision</span>
          ${due ? `<span class="ml-label ${due.soon ? 'lbl-red' : 'lbl-amber'}">${_escape(due.text)}</span>` : ''}
        </div>
        ${reply}
        ${card._reviseOffer ? `<button class="btn-revise" data-revise="${card.instanceId}">${card._reviseLabel || (card._ideaOffer ? 'Adjust the Offer' : 'Make a New Offer')}</button>` : ''}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// COMPLETED TAB
// ─────────────────────────────────────────────────────────────

/** What the GM decided, in words (and whether it was by default). */
function _decision(card) {
  const auto = card.choice === 'auto';
  const autoPick = card.autoChoice || null;
  const text = card.choice === 'yes' ? (card.yesLabel || 'Accepted')
             : card.choice === 'no'  ? (card.noLabel  || 'Declined')
             : auto ? (card._autoLabel || (autoPick === 'yes' ? card.yesLabel : autoPick === 'no' ? card.noLabel : null) || 'Decided by default')
             : (card.yesLabel || 'Read');
  const outcome = card.choice === 'yes' ? card.yesMsg
                : card.choice === 'no'  ? card.noMsg
                : auto ? (card.expireMsg || (autoPick === 'yes' ? card.yesMsg : autoPick === 'no' ? card.noMsg : null))
                : null;
  return { text, outcome, auto, read: card.choice === 'skip' };
}

function _renderCompleted(state) {
  const history = getHistory(100);
  const undoBtn = _undoCleared?.length ? `<button class="completed-tool" id="completed-undo">Undo delete</button>` : '<span></span>';
  const toolbar = (history.length || _undoCleared?.length) ? `
    <div class="completed-toolbar">
      ${undoBtn}
      ${history.length ? `<button class="completed-tool muted" id="completed-delete-all">Delete all</button>` : ''}
    </div>` : '';

  if (history.length === 0) {
    return `<div style="padding:8px 16px 0;">${toolbar}</div>
    <div class="ml-empty">
      <div class="ml-empty-h">Nothing here yet</div>
      <div class="ml-empty-s">Messages you've decided on are kept here, with what you chose and how it turned out.</div>
    </div>`;
  }

  const rows = history.map(card => {
    const d = _decision(card);
    const when = Number.isFinite(card.resolvedAtMs) ? _shortWhen(card.resolvedAtMs) : Number.isFinite(card.arrivedAtMs) ? _shortWhen(card.arrivedAtMs) : '';
    const who = d.read ? 'Read' : d.auto ? 'By default' : 'You';
    return `
      <div class="ml-row" data-open="${card.instanceId}">
        ${_avatar(card.sender)}
        <div class="ml-main">
          <div class="ml-top">
            <span class="ml-from">${_escape(card.sender || '')}</span>
            <span class="ml-time">${when}</span>
          </div>
          <div class="ml-subj">${_escape(card.subject || '')}</div>
          <div class="ml-snip"><span class="ml-you${d.auto ? ' auto' : ''}">${who}:</span> ${_escape(d.read ? (card.preview || '') : d.text)}</div>
        </div>
      </div>`;
  }).join('');

  return `<div style="padding:0 16px;">${toolbar}</div><div class="ml-list">${rows}</div>`;
}

/** §115 a completed message as its thread: the message, your reply (the decision), how it turned out. */
function _renderThread(card, state) {
  const d = _decision(card);
  const gm = state.userTeam?.gmName || 'You';
  return `
    <div class="mr">
      <div class="mr-bar">
        <button class="mr-back" id="mr-back">‹ Completed</button>
        <button class="mr-step danger" data-clear="${card.instanceId}">Delete</button>
      </div>
      <div class="mr-head">
        <h2 class="mr-subject">${_escape(card.subject || '')}</h2>
        <div class="mr-labels">${_labels(card, { withDue: false })}</div>
      </div>
      <div class="mt-msg">
        <div class="mr-sender">
          ${_avatar(card.sender, 'mr-av')}
          <div class="mr-who">
            <div class="mr-name">${_escape(card.sender || '')}</div>
            <div class="mr-to">to me${Number.isFinite(card.arrivedAtMs) ? ` · ${_longWhen(card.arrivedAtMs)}` : ''}</div>
          </div>
        </div>
        <div class="mr-body">${_paragraphs(card.body || card.preview || '', _messagePlayers(card, state))}</div>
      </div>
      ${d.read ? '' : `
      <div class="mt-msg mt-reply${d.auto ? ' auto' : ''}">
        <div class="mr-sender">
          ${d.auto ? _avatar(state.userTeam?.coachingStaff?.manager?.name || 'Manager', 'mr-av') : _avatar(gm, 'mr-av', { me: true })}
          <div class="mr-who">
            <div class="mr-name">${d.auto ? 'No reply in time' : `${_escape(gm)} (me)`}</div>
            <div class="mr-to">${d.auto ? 'decided by default' : `to ${_escape(card.sender || '')}`}${Number.isFinite(card.resolvedAtMs) ? ` · ${_longWhen(card.resolvedAtMs)}` : ''}</div>
          </div>
        </div>
        <div class="mt-decision">${_escape(d.text)}</div>
      </div>`}
      ${d.outcome ? `
      <div class="mt-msg">
        <div class="mr-sender">
          ${_avatar(card.sender, 'mr-av')}
          <div class="mr-who">
            <div class="mr-name">${_escape(card.sender || '')}</div>
            <div class="mr-to">to me</div>
          </div>
        </div>
        <div class="mr-body"><p>${_escape(d.outcome)}</p></div>
      </div>` : ''}
    </div>`;
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
  // r150 a trade topic is about one deal on the table: open while a deal hasn't been asked about.
  if (t.deal) {
    const deals = dealsFor(t.id, state, Date.now());
    const asked = (d) => [...(state.scheduledCards || []), ...(state.inbox || [])]
      .some(c => c.isCompose && c._composeTopic === t.id && c._composeArg?.key === d.key);
    const open = deals.filter(d => !asked(d));
    if (!deals.length) return { none: 'No trade is waiting on our answer' };
    if (!open.length) {
      const waiting = (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id);
      return waiting ? { waiting } : { none: 'Already asked about every trade on the table' };
    }
    return { deals: open };
  }
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

  const STAFF_KEY = { pitching_coach: 'pitchingCoach', hitting_coach: 'hittingCoach', bench_coach: 'benchCoach', bullpen_coach: 'bullpenCoach', scouting: 'scoutingDirector' };
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
      const open = st.filter(x => !x.waiting && !x.left && !x.none).length;
      const wait = st.filter(x => x.waiting).length;
      const left = Math.min(...st.filter(x => x.left).map(x => x.left));
      sub = open ? `${open} topic${open !== 1 ? 's' : ''}${wait ? ` · awaiting ${wait} repl${wait !== 1 ? 'ies' : 'y'}` : ''}`
          : wait ? `Awaiting a reply`
          : Number.isFinite(left) ? `Recently contacted · again in ${left} game${left !== 1 ? 's' : ''}`
          : 'Nothing to ask right now';
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
      : st.left ? `Available again in ${st.left} game${st.left !== 1 ? 's' : ''}` : st.none || '';
    const off = !!(st.waiting || st.left || st.none);
    // r150 a trade topic, picked: which deal (each with its deadline).
    const deals = isSel && !off && st.deals ? `<div class="compose-h compose-deal-h">Which deal?</div>
      <div class="compose-deals">${st.deals.map(d => `<button type="button" class="compose-deal${_composeDeal === d.key ? ' selected' : ''}" data-deal="${_escape(d.key)}">
        <span class="cd-label">${_escape(d.label)}</span>
        ${d.expiresAtMs ? `<span class="cd-due">Answer due ${_escape(When.untilFull(d.expiresAtMs, Date.now()))}</span>` : ''}</button>`).join('')}</div>` : '';
    return `<div class="compose-topic-btn${isSel ? ' selected' : ''}${off ? ' disabled' : ''}" ${off ? '' : `data-topic="${t.id}"`}>
      <span>${_escape(t.label)}</span>
      <span class="topic-desc">${_escape(note || t.desc)}</span>
    </div>${deals}`;
  }).join('');
  const sel = ch.topics.find(t => t.id === _composeTopic);
  const canSend = !!_composeTopic && (!sel?.deal || !!_composeDeal);
  return `
    <button type="button" class="compose-back" id="compose-back">‹ All recipients</button>
    <div class="compose-to"><span class="compose-to-label">To</span> ${_escape(ch.label)}<span class="compose-to-role">${_escape(ch.role)}</span></div>
    <div class="compose-h">What about?</div>
    <div class="compose-topic-list">${rows}</div>
    <button class="compose-send-btn" ${canSend ? '' : 'disabled'} id="compose-send-btn">${canSend ? 'Send Message' : _composeTopic ? 'Pick a deal' : 'Pick a topic'}</button>
    <div class="compose-cooldown-note">Replies come back later, the way they would from a real staff — field staff answer after the game.</div>`;
}

/** A trade topic with one deal on the table: that deal, picked already. */
function _onlyDeal(ch, topicId) {
  const t = ch?.topics.find(x => x.id === topicId);
  if (!t?.deal) return null;
  const st = _topicState(t, StateManager.get());
  return st.deals?.length === 1 ? st.deals[0].key : null;
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
        _composeDeal    = null;
      }
      _activeTab = tab;
      _openCard  = null;
      refresh();
    });
  }

  // §115 open a message (the reading view), back to the list, newer / older
  document.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => _openMessage(el.dataset.open));
  });
  // r146 a player named in a message opens their card.
  document.querySelectorAll('.msg-player[data-msg-player]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      import('../components/PlayerCard.js').then(PC => PC.openPlayerCard(el.dataset.msgPlayer, StateManager.get()));
    });
  });
  document.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => _openMessage(el.dataset.goto, { keepScroll: true }));
  });
  document.getElementById('mr-back')?.addEventListener('click', () => {
    _openCard = null;
    refresh();
    window.scrollTo(0, _listScroll);
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
      _openCard = null;
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
      const open = ch.topics.filter(t => { const st = _topicState(t, StateManager.get()); return !st.waiting && !st.left && !st.none; });
      _composeTopic = open.length === 1 ? open[0].id : null;
      _composeDeal = _onlyDeal(ch, _composeTopic);
      refresh();
      _composeToTop();
    });
  });
  document.getElementById('compose-back')?.addEventListener('click', () => {
    _composeChannel = null; _composeTopic = null; _composeDeal = null;
    refresh();
    _composeToTop();
  });

  // Compose topic selection
  document.querySelectorAll('[data-topic]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      if (_composeTopic !== el.dataset.topic) _composeDeal = null;
      _composeTopic = el.dataset.topic;
      const ch = COMPOSE_CHANNELS.find(c => c.id === _composeChannel);
      _composeDeal = _composeDeal || _onlyDeal(ch, _composeTopic);
      refresh();
    });
  });
  document.querySelectorAll('[data-deal]').forEach(el => {
    el.addEventListener('click', () => { _composeDeal = el.dataset.deal; refresh(); });
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


/** §115 open a message full-screen: marked read, the list's place remembered. */
function _openMessage(instanceId, { keepScroll = false } = {}) {
  if (!keepScroll && !_openCard) _listScroll = window.scrollY || 0;
  _openCard = instanceId;
  if (_activeTab !== 'completed') markRead(instanceId);
  refresh();
  window.scrollTo(0, 0);
  if (_activeTab !== 'completed') App.updateHeader?.(StateManager.get());
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
      _openCard = null;
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
    _openCard = null;
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
  // r150 a trade topic asks about one deal (no cooldown: one question per deal).
  const deal = topic?.deal ? (_topicState(topic, state).deals || []).find(d => d.key === _composeDeal) : null;
  if (topic?.deal && !deal) { App.showToast('That deal is no longer waiting on us.', 'neutral', 2500); refresh(); return; }

  // Record cooldown immediately
  if (!topic?.deal) StateManager.mutate(s => {
    s.composeCooldowns = { ...(s.composeCooldowns || {}), [topicId]: gameIdx };
  });

  // §105 the reply is written now and arrives later (CardEngine schedules it; a push when it lands).
  try {
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    deliverComposeCard(topicId, channelId, deal
      ? { topicLabel: deal.label, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId, expiresAtMs: deal.expiresAtMs } }
      : { topicLabel: topic?.label || '' });
    import('../PushClient.js').then(P => P.syncPushSchedule()).catch(() => {});
  } catch (err) {
    console.error('InboxScreen._sendCompose:', err);
  }

  // Back to the list, where the message waits under "Waiting to hear back".
  _composeChannel = null;
  _composeTopic   = null;
  _composeDeal    = null;
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
