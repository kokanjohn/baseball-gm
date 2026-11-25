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
 * opened), newest first in one list (r252: no "Important" section); tapping a row opens the
 * message full-screen (back to the list with "‹ Inbox"), the decision at the
 * bottom like a reply. A completed message opens as its thread: the message,
 * your reply (the decision), and how it turned out.
 *
 * Rules:
 *   - Card resolution calls CardEngine.resolve() — never direct state writes.
 *   - Compose channels use composeCooldowns from state to prevent repeat use.
 *   - Inbox tab shows the count of messages waiting, matching the nav badge.
 *   - Compose tab respects Section 8.12 channel map (LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getInbox, getHistory, clearHistory, restoreHistory, markRead, inboxCounts } from '../../engine/CardEngine.js';
import { snapshotMetrics, formatMoney } from '../formatters.js';
import * as When from '../../engine/When.js';
import { dealsFor, shoppable, SHOP_AGAIN_MS, scoutingAsked, scoutingDeal } from '../../engine/TradeAdvice.js';
import { namedPlayers, faLooks } from '../../engine/ComposeReplies.js';
import { starredIds } from '../../engine/Starred.js';   // r275 §122.154
import { workPlayers, skillsOf, teachablePositions } from '../../engine/PlayerWork.js';
import { posLabel, startsAt, familiarity } from '../../engine/Positions.js';   // r163 §122.35
import { penRoleOf } from '../../engine/Strategy.js';   // r169
import { dealOfCard } from '../../engine/TradeEngine.js';   // r198 the deal table
import * as FaWatch from '../../engine/FaWatch.js';   // r204 §122.82
import * as FreeAgency from '../../engine/FreeAgency.js';
import { formatK } from '../../engine/CardTokens.js';
import { FA_WATCH, PHASE } from '../../data/constants.js';
import { askScoutingButton, askScouting } from '../components/AskScouting.js';   // r208 §122.86
import { senderLabel, fromScouting, viewOf } from '../../engine/Senders.js';   // r212 §122.90, r235 §122.114, r283 §122.162
import { newGms, gmsToWelcome } from '../../engine/FirstDay.js';
import { askable as retireAskable } from '../../engine/Retirement.js';   // r223 §122.102
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab      = 'todo';   // 'todo' | 'completed' | 'compose'
let _undoCleared    = null;     // instanceIds from the last Delete / Delete All (session only)
let _openCard       = null;     // §115 instanceId of the message open in the reading view
let _listScroll     = 0;        // the list's scroll position, restored on the way back
let _composeChannel = null;     // currently selected compose channel id
let _composeTopic   = null;     // currently selected compose topic id
let _composeDeal    = null;     // r150 the deal a trade topic asks about (its key) — or r151 the player a topic is about
let _composeSkill   = null;     // r159 the skill a work topic is about
let _composeRank    = null;     // r251 "who should we work on": 'likely' | 'help'
let _composeWhere   = null;     // r251 … 'coach' | 'program'
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
    // r212 §122.90 trade talk opens the trade screen; a new GM can be welcomed first (it goes further than answering)
    topics:   [
      { id: 'gm_trade',   label: 'Talk trade',            desc: 'Put an offer together for another club', opens: 'trade' },
      { id: 'gm_welcome', label: 'Welcome a new GM',      desc: 'Reach out before they reach out to you', deal: 'gms' },
    ],
  },
  // High priority — built in initial release
  {
    id:       'manager',
    label:    'Manager',
    icon:     '⚾',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'mgr_lineup',    label: 'The batting order',        desc: 'How the order is built, and how you want it built' },
      { id: 'mgr_morale',    label: 'Team morale check-in',     desc: 'Get a read on clubhouse atmosphere' },
      { id: 'mgr_hook',      label: 'When to go to the bullpen', desc: 'How long the starters stay in: a quick hook or a long leash' },
      { id: 'mgr_rest',      label: 'A day off for a hitter',   desc: 'Pick a hitter: how worn down they are, and a day off if you want one', player: 'hitters' },
    ],
  },
  {
    id:       'pitching_coach',
    label:    'Pitching Coach',
    icon:     '🎯',
    role:     'Field Staff',
    priority: 'high',
    topics: [
      { id: 'pc_rotation',   label: 'The rotation',             desc: 'The next turns, and how each starter\'s arm is doing' },
      // r196 §122.73 the bullpen coach's topics, now the pitching coach's
      { id: 'pc_bullpen',    label: 'The bullpen',              desc: 'Who\'s available, the work they\'ve done, and the roles' },
      { id: 'pc_roles',      label: 'A reliever\'s role',        desc: 'Pick a pitcher: name the closer or a setup arm, or leave it to the manager', player: 'relievers', skill: true, choices: 'roles' },
      { id: 'pc_prospect',   label: 'Young pitcher check-in',   desc: 'A report on a young arm — and a development plan if you want one' },
      // (r251 §122.130 "Work with a pitcher on…" is the Bench Coach's now: all the development work in one place)
      { id: 'pc_stretch',    label: 'Stretch a pitcher out',     desc: 'Pick a reliever: sim games to build the length to start', player: 'pitchers' },
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
      // (r251 §122.130 "Work with a hitter on…" is the Bench Coach's now)
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
      { id: 'gk_prep',       label: 'Get the field ready',      desc: 'The next home game: the extra crew and the full tarp, by the forecast' },
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
      { id: 'bc_tactics',    label: 'The running game',         desc: 'Close games, steals, and how much you want us to run' },
      // r251 §122.130 all the development work, here: any player and skill (the skill's coach does it), who to work
      // with, the complex (from Scouting), a new position
      { id: 'bc_work',       label: 'Work with a player on…',   desc: 'Pick a player and a skill: the right coach does the work', player: 'any', skill: true, choices: 'work' },
      { id: 'bc_who',        label: 'Who should we work on…?',  desc: 'Pick a skill: the three players it would do the most for', who: true },
      { id: 'sc_program',    label: 'A development program',    desc: 'A week at our complex: focused work on one skill', player: 'any', skill: true },
      { id: 'bc_teach',      label: 'Teach a player a position', desc: 'Pick a hitter and a position: extra reps there in practice', player: 'hitters', skill: true, choices: 'positions' },
    ],
  },
  {
    id:       'ticket_office',
    label:    'Ticket Office',
    icon:     '🎫',
    role:     'Front Office',
    priority: 'medium',
    topics: [
      { id: 'tix_attendance', label: 'Attendance outlook',       desc: 'The crowds lately, the next homestand, and renewals' },
      { id: 'tix_promo',      label: 'Run a promotion',          desc: 'A promotion for the next homestand: what each would do for the crowd and the gate' },
    ],
  },
  {
    id:       'scouting',
    label:    'Scouting Director',   // r235 §122.114 (was "Scouting / Dev": the Staff tab's name for the job)
    icon:     '🔭',
    role:     'Front Office',
    priority: 'medium',
    topics: [
      { id: 'sc_free_agents', label: 'Free agents worth a look', desc: 'The scouts look over the free agents', looks: true },   // r199 the week's looks, not a cooldown
      { id: 'sc_prospect',   label: 'Young player report',      desc: 'A scouting report on one of our young players' },
      { id: 'sc_starred',    label: 'Our starred players',      desc: 'How the players we starred are doing, and whether we could get them', starred: true, cooldown: 3 },   // r275 §122.154
      { id: 'sc_opponent',   label: 'Opponent scouting',        desc: 'Ask about an upcoming opponent\'s tendencies' },
      { id: 'sc_trade',      label: 'A trade on the table',     desc: 'The director\'s read on a deal: on the field, the value, a counter, the payroll', deal: true },   // r202 §122.79 (the manager's folded in)
      { id: 'sc_shop',       label: 'What could we get for…?',  desc: 'Pick one of our players: the director calls the clubs that could use them', player: true },
      // (r251 §122.130 the development program is the Bench Coach's now)
      { id: 'sc_retire',     label: 'Is … retiring?',           desc: 'Pick a veteran on another club, or a free agent', player: 'league' },   // r223 §122.102
    ],
  },
  // Low priority — event-driven
  // r159 §122.31 the team physician on one player.
  {
    id:       'physician',
    label:    'Team Physician',
    icon:     '🩺',
    role:     'Medical Staff',
    priority: 'medium',
    topics: [
      { id: 'doc_health',    label: 'A player\'s health',        desc: 'Pick a player: what\'s bothering them, their history, how worn down they are', player: 'any' },
    ],
  },
];

// Compose cooldown in days (how long before the same topic can be asked again). r264 §122.143 it was games: the
// game count stands still all winter and starts over each season, so a topic asked late in a season stayed shut
// most of the next one. Now the day it was asked, and back at the start of the fifth day after.
const COMPOSE_COOLDOWN_DAYS = 5;

/** r264 when a topic asked at `sentAt` can be asked again (midnight, `days` days on); null for an old save's game count. */
function _composeBackAt(sentAt, days) {
  if (!Number.isFinite(sentAt) || sentAt < 1e11) return null;   // (before r264: a game index — let it go)
  const d = new Date(sentAt); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
  return d.getTime();
}

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
  // r155 leaving the Inbox: next time it opens on To Do, at the top, no message open, no half-made message.
  App.registerTabLeave('decisions', () => {
    _activeTab = 'todo';
    _openCard = null;
    _listScroll = 0;
    _composeChannel = null;
    _composeTopic = null;
    _composeDeal = null;
    _composeSkill = null; _composeRank = null; _composeWhere = null;
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
  wire('roster:changed',   () => { if (_activeTab === 'todo') refresh(); });   // r204 §122.82 a signing from the free-agent report's sheet

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

  // r283 §122.162 every message as it's shown now: today's names for the people it names
  const inbox     = getInbox().map(c => viewOf(c, state));

  // §115 a message open full-screen (it may have been withdrawn or decided meanwhile).
  if (_openCard) {
    const open = _activeTab === 'completed' ? _history(state).find(c => c.instanceId === _openCard)
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
          ${(() => { const b = inboxCounts().badge;   // r267 §122.146 red: unread; muted: waiting on an answer
             return b ? `<span class="tab-badge${b.tone === 'waiting' ? ' muted' : ''}">${Math.min(b.n, 99)}</span>` : ''; })()}
        </div>
        <div class="inbox-tab ${_activeTab === 'compose'   ? 'active' : ''}" id="itab-compose">
          Compose
        </div>
        <div class="inbox-tab ${_activeTab === 'completed' ? 'active' : ''}" id="itab-completed">
          Completed
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

/** The inbox newest first. r252 §122.131 one list: no "Important" / "Everything else" — the GM reads each one. */
function _inboxOrder(inbox) {
  // (r279 §122.158 a follow-up brings a message back to the top: its latest word)
  const latest = (c) => Math.max(c.arrivedAtMs || c.deliveredAt || 0, c._followUp?.atMs || 0);
  const newest = (a, b) => latest(b) - latest(a);
  return [...inbox].sort(newest);
}

function _renderToDo(inbox, state) {
  if (inbox.length === 0) {
    return `<div class="ml-empty">
      <div class="ml-empty-h">You're all caught up</div>
    </div>`;
  }
  return `<div class="ml-list">${_inboxOrder(inbox).map(c => _renderRow(c)).join('')}</div>`;
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
  // r212 the person's initials, not the role's
  const words = String(sender || '?').split(', ')[0].replace(/'s\b/g, '').split(/[\s&/-]+/).filter(w => /^[A-Za-z]/.test(w));
  const caps = words.filter(w => /^[A-Z]/.test(w));
  const use = (caps.length ? caps : words).slice(0, 2);
  return use.map(w => w[0].toUpperCase()).join('') || '?';
}
/** r212 §122.90 who it's from, as shown everywhere: "Name, Role" for a person, the department as it is. */
function _from(card) { return senderLabel(card, StateManager.get()); }

function _avatar(sender, cls = 'ml-av', { me = false } = {}) {
  let h = 2166136261;                                      // FNV-1a: a better spread of colors
  for (const ch of String(sender || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const bg = me ? '#1F8A5B' : _AV_COLORS[h % _AV_COLORS.length];   // (your own replies: one fixed color)
  return `<div class="${cls}" style="background:${bg}">${_escape(_initials(sender))}</div>`;
}

/**
 * r155 A message carries no tags (no "Good news", "Urgent", "Trade" …): the
 * subject and the sender say what it is. The one chip left is a decision's
 * deadline, "Due 7:05 PM", which is information, not a tag.
 */
function _labels(card) {
  const due = _dueText(card);
  return due ? `<span class="ml-label ${due.soon ? 'lbl-red' : 'lbl-amber'}">${_escape(due.text)}</span>` : '';
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
  const at = card._followUp?.atMs ?? card.arrivedAtMs;   // r279 §122.158 the latest word
  const when = Number.isFinite(at) ? _shortWhen(at) : '';
  const labels = _labels(card);
  return `
    <div class="ml-row${unread ? ' unread' : ''}" data-open="${card.instanceId}" id="card-${card.instanceId}">
      ${_avatar(_from(card))}
      <div class="ml-main">
        <div class="ml-top">
          <span class="ml-from">${_escape(_from(card))}</span>
          <span class="ml-time">${when}</span>
        </div>
        <div class="ml-subj">${_escape(card.subject || '')}</div>
        <div class="ml-snip">${_escape(card._followUp ? card._followUp.text : (card.preview || ''))}</div>
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
  const linked = new Set();       // r195 a name is a link the first time only: once it's been tappable, the rest is plain text
  return blocks.map(b => `<p>${_linkPlayers(_escape(b), players, linked).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * r146 the players a message is about: its target, the players its text names
 * (tokens), a reply's report (memo), its choices. Each name in the text opens
 * that player's card, so anyone a message mentions can be found in one tap.
 */
function _messagePlayers(card, state) {
  // r152 the deal a trade message is about (an offer, a counter, a package), and the talk it belongs to.
  const talk = card._talkTeamId ? state.tradeTalks?.[card._talkTeamId]?.talk : null;
  const deals = [card._tradeOffer, card._ideaOffer, card._reviseOffer?.offer,
    talk && talk.id === card._talkId ? (card.cardId === 'talk_counter' ? talk.counter : talk.offer) : null].filter(Boolean);
  const tied = [card._targetPlayerId, ...Object.values(card._tokenPlayers || {}), ...(card._playerIds || []),
    ...(card._choices || []).map(c => String(c.key || '').split(':').pop()),
    ...deals.flatMap(o => [...(o.incomingIds || []), ...(o.outgoingIds || [])])].filter(id => id && state.players?.[id]);
  // …and any other player the text names whose name is nobody else's (an older message, any kind of card).
  const ids = new Set(namedPlayers(state, `${card.subject || ''}\n${card.body || card.preview || ''}`, tied));
  const ps = [...ids].map(id => state.players?.[id]).filter(p => p?.name);
  // A name two of them share would be ambiguous: leave it plain.
  const count = {};
  for (const p of ps) count[p.name] = (count[p.name] || 0) + 1;
  return ps.filter(p => count[p.name] === 1);
}

function _linkPlayers(html, players, linked = new Set()) {
  if (!players.length) return html;
  const byName = new Map(players.map(p => [_escape(p.name), p.id]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // (with the punctuation right after it, so a line never starts with "." or ",")
  const re = new RegExp(`(?<![\\w'&#;-])(${names.join('|')})(?![\\w-])((?:&#39;s?|'s?)?[.,;:!?)]*)`, 'g');
  return html.replace(re, (m, name, tail) => {
    const id = byName.get(name);
    if (linked.has(id)) return m;
    linked.add(id);
    const btn = `<button class="msg-player" data-msg-player="${id}">${name}</button>`;
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
        <button class="msg-choice${k === 0 && !card._noRec ? ' recommended' : ''}" data-resolve="${card.instanceId}" data-choice="yes" data-pick="${_escape(c.key)}">
          <span class="mc-label">${_escape(c.label)}${k === 0 && !card._noRec ? ' <span class="mc-rec">Recommended</span>' : ''}</span>
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
      </div>
      <div class="mr-sender">
        ${_avatar(_from(card), 'mr-av')}
        <div class="mr-who">
          <div class="mr-name">${_escape(_from(card))}</div>
          <div class="mr-to">to me${Number.isFinite(card.arrivedAtMs) ? ` · ${_longWhen(card.arrivedAtMs)}` : ''}</div>
        </div>
      </div>
      <div class="mr-body">${_paragraphs(card.body || card.preview || '', _messagePlayers(card, state))}</div>
      ${_followUpHtml(card)}
      ${dealOfCard(state, card) ? `<button class="btn-revise btn-deal" data-deal-sheet="${card.instanceId}">See the Deal</button>` : ''}
      ${card.resolved || fromScouting(card, state) ? '' : askScoutingButton(state, { instanceId: card.instanceId })}
      <div class="mr-reply">
        <div class="mr-reply-h">
          <span>Your decision</span>
          ${due ? `<span class="ml-label ${due.soon ? 'lbl-red' : 'lbl-amber'}">${_escape(due.text)}</span>` : ''}
        </div>
        ${card._faRows ? _faRowsHtml(card, state) : ''}
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
  // r204 §122.82 the free-agent report, closed: what came of each player
  if (card._summary && card.resolved) return { text: card._summary, auto: false, read: false };
  const autoPick = card.autoChoice || null;
  const text = card.choice === 'yes' ? (card.yesLabel || 'Accepted')
             : card.choice === 'no'  ? (card.noLabel  || 'Declined')
             : auto ? (card._autoLabel || (autoPick === 'yes' ? card.yesLabel : autoPick === 'no' ? card.noLabel : null) || 'Decided by default')
             : (card.yesLabel || 'Read');
  // r271 §122.150 no reply from the sender here: the GM wouldn't hear back the moment they answered.
  return { text, auto, read: card.choice === 'skip' };
}

/** r283 §122.162 Completed, as shown now (today's names). */
function _history(state) { return getHistory(100).map(c => viewOf(c, state)); }

function _renderCompleted(state) {
  const history = _history(state);
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
    </div>`;
  }

  const rows = history.map(card => {
    const d = _decision(card);
    const when = Number.isFinite(card.resolvedAtMs) ? _shortWhen(card.resolvedAtMs) : Number.isFinite(card.arrivedAtMs) ? _shortWhen(card.arrivedAtMs) : '';
    const who = d.read ? 'Read' : d.auto ? 'By default' : 'You';
    return `
      <div class="ml-row" data-open="${card.instanceId}">
        ${_avatar(_from(card))}
        <div class="ml-main">
          <div class="ml-top">
            <span class="ml-from">${_escape(_from(card))}</span>
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
      </div>
      <div class="mt-msg">
        <div class="mr-sender">
          ${_avatar(_from(card), 'mr-av')}
          <div class="mr-who">
            <div class="mr-name">${_escape(_from(card))}</div>
            <div class="mr-to">to me${Number.isFinite(card.arrivedAtMs) ? ` · ${_longWhen(card.arrivedAtMs)}` : ''}</div>
          </div>
        </div>
        <div class="mr-body">${_paragraphs(card.body || card.preview || '', _messagePlayers(card, state))}</div>
      </div>
      ${_followUpHtml(card)}
      ${d.read ? '' : `
      <div class="mt-msg mt-reply${d.auto ? ' auto' : ''}">
        <div class="mr-sender">
          ${d.auto ? _avatar(state.userTeam?.coachingStaff?.manager?.name || 'Manager', 'mr-av') : _avatar(gm, 'mr-av', { me: true })}
          <div class="mr-who">
            <div class="mr-name">${d.auto ? 'No reply in time' : `${_escape(gm)} (me)`}</div>
            <div class="mr-to">${d.auto ? 'decided by default' : `to ${_escape(_from(card))}`}${Number.isFinite(card.resolvedAtMs) ? ` · ${_longWhen(card.resolvedAtMs)}` : ''}</div>
          </div>
        </div>
        <div class="mt-decision">${_escape(d.text)}</div>
      </div>`}
      ${d.read ? '' : _impactHtml(card)}
    </div>`;
}

/** r279 §122.158 the sender's follow-up, in the same thread: from the sender, to me, when. */
function _followUpHtml(card) {
  const f = card._followUp;
  if (!f) return '';
  return `
      <div class="mt-msg mt-follow">
        <div class="mr-sender">
          ${_avatar(_from(card), 'mr-av')}
          <div class="mr-who">
            <div class="mr-name">${_escape(_from(card))}</div>
            <div class="mr-to">to me · ${_longWhen(f.atMs)}</div>
          </div>
        </div>
        <div class="mr-body"><p>${_escape(f.text)}</p></div>
      </div>`;
}

/** r255 §122.134 what the decision changed, and by how much (kept on the card when it was decided). */
function _impactHtml(card) {
  const rows = Array.isArray(card._impact) ? card._impact : null;
  if (!rows) return '';                                   // decided before r255: nothing was kept
  // Club funds in millions: two decimals when the change is smaller than $100K, so "$3.30M → $3.28M" shows it.
  const money = (k, fine) => (k < 0 ? '−' : '') + (Math.abs(k) >= 1000 && fine ? `$${(Math.abs(k) / 1000).toFixed(2)}M` : formatMoney(Math.abs(k)));
  const signed = (n, f = String) => `${n > 0 ? '+' : '−'}${f(Math.abs(n))}`;
  const line = (r) => {
    const name = `<span class="mi-label">${_escape(r.label)}${r.sub ? `<span class="mi-sub">${_escape(r.sub)}</span>` : ''}</span>`;
    if (r.unit === 'text') return `<div class="mi-row">${name}<span class="mi-text">${_escape(r.text || '')}</span></div>`;
    const tone = r.delta > 0 ? 'up' : 'down';
    if (r.unit === 'pct') return `<div class="mi-row">${name}<span class="mi-val"></span><span class="mi-d ${tone}">${signed(r.delta)}%</span></div>`;
    const fine = Math.abs(r.delta) < 100;
    const v = r.unit === 'k' ? `${money(r.from, fine)} → ${money(r.to, fine)}` : `${r.from} → ${r.to}`;
    const dd = r.unit === 'k' ? signed(r.delta, formatMoney) : signed(r.delta);
    return `<div class="mi-row">${name}<span class="mi-val">${v}</span><span class="mi-d ${tone}">${dd}</span></div>`;
  };
  const body = rows.length ? rows.map(line).join('') : '<div class="mi-row"><span class="mi-label mi-none">Nothing changed</span></div>';
  const later = card._impactLater ? '<div class="mi-row"><span class="mi-label">Later</span><span class="mi-text">More comes of this later.</span></div>' : '';
  return `
      <div class="mt-msg mi">
        <div class="mi-h">What changed</div>
        ${body}${later}
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
/**
 * r204 §122.82 the free-agent report's players: sign any of them (the sign sheet), or have the director
 * watch one (up to FA_WATCH.max at once). Each row shows how it stands; the message stays open for the rest.
 */
function _faRowsHtml(card, state) {
  const now = Date.now();
  const rows = FaWatch.reportRows(state, card, now);
  const watchingN = FaWatch.watching(state, now).length;
  const html = rows.map(r => {
    const p = r.p;
    const price = FreeAgency.termsFor(state, p).salary || 0;
    let acts;
    if (r.status === 'signed') acts = `<span class="fa-state good">Signed</span>`;
    else if (r.status === 'gone') acts = `<span class="fa-state">Signed with ${_escape(r.team)}</span>`;
    else if (r.status === 'watching') acts = `<span class="fa-state">Watching</span>`;
    else {
      // (room on the roster and the money: the sign sheet's questions, with the choices; here only what no choice fixes)
      const why = FreeAgency.signBlocker(state, p.id, null);
      const blocked = why && /postseason|no coming back|not a free agent/.test(why) ? why : null;
      const wb = FaWatch.watchBlocker(state, p.id, now);
      acts = `${blocked ? `<span class="fa-why">${_escape(blocked[0].toUpperCase() + blocked.slice(1))}</span>`
                        : `<button class="fa-btn primary" data-fa-sign="${p.id}">Sign (${_escape(formatK(price))})</button>`}
              ${wb ? `<span class="fa-why">${_escape(wb === 'already watching' ? 'Watching' : wb[0].toUpperCase() + wb.slice(1))}</span>`
                   : `<button class="fa-btn" data-fa-watch="${p.id}">Watch</button>`}`;
    }
    return `<div class="fa-row">
        <div class="fa-who"><button class="msg-player" data-msg-player="${p.id}">${_escape(p.name)}</button>
          <span class="fa-meta">${_escape(posLabel(p))} · OVR ${p.ovr}</span>
          ${r.race ? `<span class="fa-race fa-race-${r.race}">${r.race === 'alone' ? 'No other clubs yet' : 'Other clubs asking'}</span>` : ''}</div>
        <div class="fa-acts">${acts}</div>
      </div>`;
  }).join('');
  return `<div class="fa-rows">${html}<div class="fa-limit">Watching ${watchingN} of ${FA_WATCH.max}</div></div>`;
}

function _topicState(t, state) {
  if (t.opens) return {};
  // r212 §122.90 the new GMs this season we haven't reached out to (or answered) yet.
  if (t.deal === 'gms') {
    const fresh = newGms(state);
    if (!fresh.length) return { none: (state.seasonNum || 1) > 1 ? 'No new GMs this season' : 'Every GM is new to you this spring' };
    const open = gmsToWelcome(state);
    if (!open.length) {
      const waiting = (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id);
      return waiting ? { waiting } : { none: 'Every new GM has heard from us' };
    }
    return { deals: open };
  }
  // r150 a trade topic is about one deal on the table: open while a deal hasn't been asked about.
  if (t.deal) {
    const deals = dealsFor(t.id, state, Date.now());
    const asked = (d) => scoutingAsked(state, d.key);   // r208 §122.86 one answer everywhere
    const open = deals.filter(d => !asked(d));
    if (!deals.length) return { none: 'No trade is waiting on our answer' };
    if (!open.length) {
      const waiting = (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id);
      return waiting ? { waiting } : { none: 'Already asked about every trade on the table' };
    }
    return { deals: open };
  }
  // r223 §122.102 a veteran on another club, or a free agent (35+ next season): not one already asked about and
  // waiting; nothing to find out in the winter (next season's plans come in the spring).
  if (t.player === 'league') {
    if (state.phase === PHASE.OFFSEASON) return { none: 'Ask again in the spring' };
    const asked = new Set((state.scheduledCards || []).filter(c => c.isCompose && c._composeTopic === t.id).map(c => c._composeArg?.playerId));
    const ps = retireAskable(state).filter(p => !asked.has(p.id));
    if (!ps.length) return asked.size ? { waiting: (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id) } : { none: 'No veteran to ask about' };
    return { players: ps };
  }
  // r159 a player topic (work, a day off, health): any of ours it fits, not one already asked about.
  if (t.player && t.player !== true) {
    const asked = new Set((state.scheduledCards || []).filter(c => c.isCompose && c._composeTopic === t.id).map(c => c._composeArg?.playerId));
    const ps = workPlayers(state, t.player).filter(p => !asked.has(p.id));
    if (!ps.length) return asked.size ? { waiting: (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id) } : { none: 'No player to ask about' };
    return { players: ps };
  }
  // r151 shopping a player: one of ours who can be traded now, not shopped in the last few days.
  if (t.player) {
    const now = Date.now();
    const recent = new Set([...(state.scheduledCards || []).filter(c => c.isCompose && c._composeTopic === t.id).map(c => c._composeArg?.playerId),
      ...(state.composeLog || []).filter(e => e.topicId === t.id && now - e.atMs < SHOP_AGAIN_MS).map(e => e.memo?.shopId)]);
    const ps = shoppable(state, now);
    if (!ps.length) return { none: 'The trade window is closed' };
    const open = ps.filter(p => !recent.has(p.id));
    if (!open.length) return { none: 'Every player was shopped in the last few days' };
    return { players: open };
  }
  const cd = state.composeCooldowns || {};
  const waiting = (state.scheduledCards || []).find(c => c.isCompose && c._composeTopic === t.id);
  if (waiting) return { waiting };
  // r199 §122.76 the scouts' looks at free agents: what's left this week, or how long until one comes back.
  if (t.looks) {
    const L = faLooks(state, Date.now());
    return L.left ? { info: `${L.left} of ${L.looks} looks left this week` } : { none: `Next look in ${L.inDays} day${L.inDays === 1 ? '' : 's'}` };
  }
  if (t.starred && !starredIds(state).length) return { none: 'No starred players' };   // r275 §122.154
  const back = _composeBackAt(cd[t.id], t.cooldown || COMPOSE_COOLDOWN_DAYS);
  return back && back > Date.now() ? { backAt: back } : {};
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

  const STAFF_KEY = { pitching_coach: 'pitchingCoach', hitting_coach: 'hittingCoach', bench_coach: 'benchCoach', scouting: 'scoutingDirector' };
  const rows = COMPOSE_CHANNELS.map(ch => {
    // §112.2 an empty chair on the staff: nobody to write to until someone's hired.
    if (state.userTeam?.coachingStaff?.[STAFF_KEY[ch.id]]?.vacant) {
      return `<div class="compose-person" aria-disabled="true" style="opacity:.55">
        <span class="cp-main"><span class="cp-name">${_escape(ch.label)}</span><span class="cp-sub">Vacant · hiring</span></span></div>`;
    }
    let sub;
    if (ch.id === 'other_gms') { const n = gmsToWelcome(state).length; sub = n ? `${n} new GM${n === 1 ? '' : 's'} to welcome` : 'Trade talks with the other clubs'; }
    else {
      const st = ch.topics.map(t => _topicState(t, state));
      const open = st.filter(x => !x.waiting && !x.backAt && !x.none).length;
      const wait = st.filter(x => x.waiting).length;
      const back = Math.min(...st.filter(x => x.backAt).map(x => x.backAt));   // r264 the soonest a topic opens again
      sub = open ? `${open} topic${open !== 1 ? 's' : ''}${wait ? ` · awaiting ${wait} repl${wait !== 1 ? 'ies' : 'y'}` : ''}`
          : wait ? `Awaiting a reply`
          : Number.isFinite(back) ? `Recently contacted · again ${When.untilDay(back, Date.now())}`
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
      : st.backAt ? `Available again ${When.untilDay(st.backAt, Date.now())}` : st.none || '';
    const off = !!(st.waiting || st.backAt || st.none);
    // r150 a trade topic, picked: which deal (each with its deadline).
    const deals = isSel && !off && st.deals ? `<div class="compose-h compose-deal-h">${t.deal === 'gms' ? 'Which GM?' : 'Which deal?'}</div>
      <div class="compose-deals">${st.deals.map(d => `<button type="button" class="compose-deal${_composeDeal === d.key ? ' selected' : ''}" data-deal="${_escape(d.key)}">
        <span class="cd-label">${_escape(d.label)}</span>
        ${d.expiresAtMs ? `<span class="cd-due">Answer due ${_escape(When.untilFull(d.expiresAtMs, Date.now()))}</span>` : ''}</button>`).join('')}</div>` : '';
    // r151 shopping: which player (hitters, then pitchers, best first).
    const byOvr = (a, b) => (b.ovr || 0) - (a.ovr || 0);
    const opt = (p) => `<option value="${p.id}"${_composeDeal === p.id ? ' selected' : ''}>${_escape(p.name)} — ${_escape(posLabel(p))}, OVR ${p.ovr}</option>`;
    const isP = (p) => p.pos === 'SP' || p.pos === 'RP';
    const hit = st.players ? st.players.filter(p => !isP(p)).sort(byOvr) : [], arm = st.players ? st.players.filter(isP).sort(byOvr) : [];
    // r223 §122.102 the league's veterans: free agents first, then by club (with the age next season)
    const yr = baseballYear(state);
    const optAge = (p) => `<option value="${p.id}"${_composeDeal === p.id ? ' selected' : ''}>${_escape(p.name)} — ${_escape(posLabel(p))}, OVR ${p.ovr}, age ${computeAge(p.dob, yr)}</option>`;
    const groups = t.player === 'league' && st.players ? [
      ['Free agents', st.players.filter(p => !p.teamId)],
      ...(state.leagueTeams || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(c => [c.name, st.players.filter(p => p.teamId === c.id)]),
    ].filter(([, ps]) => ps.length) : null;
    const players = isSel && !off && st.players ? `<div class="compose-h compose-deal-h">Which player?</div>
      <select class="compose-player-select" id="compose-player" aria-label="Which player">
        <option value=""${_composeDeal ? '' : ' selected'}>Choose a player</option>
        ${groups ? groups.map(([label, ps]) => `<optgroup label="${_escape(label)}">${ps.sort(byOvr).map(optAge).join('')}</optgroup>`).join('') : `
        ${hit.length ? `<optgroup label="Hitters">${hit.map(opt).join('')}</optgroup>` : ''}
        ${arm.length ? `<optgroup label="Pitchers">${arm.map(opt).join('')}</optgroup>` : ''}`}
      </select>` : '';
    // r159 a work topic, a player picked: which skill (with where it stands now).
    const pick = isSel && !off && t.skill && _composeDeal ? state.players[_composeDeal] : null;
    const skills = pick ? `<div class="compose-h compose-deal-h">${t.choices === 'positions' ? 'Which position?' : t.choices === 'roles' ? 'Which role?' : 'Work on what?'}</div>
      <div class="compose-skills">${_choicesFor(t, pick).map(c => `<button type="button" class="compose-skill${_composeSkill === c.key ? ' selected' : ''}" data-skill="${c.key}">
        <span class="cs-name">${c.name}</span><span class="cs-val">${c.val}</span></button>`).join('')}</div>` : '';
    // r251 §122.130 "who should we work on": a skill, how to rank, where
    const btn = (attr, key, name, sub, on) => `<button type="button" class="compose-skill${on ? ' selected' : ''}" ${attr}="${key}"><span class="cs-name">${name}</span>${sub ? `<span class="cs-sub">${sub}</span>` : ''}</button>`;
    const grp = (g, cls) => `<div class="compose-skill-grp">${g}</div><div class="compose-skills ${cls}">${WHO_SKILL_LIST.filter(x => x[2] === g).map(([k, n]) => btn('data-skill', k, n, '', _composeSkill === k)).join('')}</div>`;
    const whoSteps = isSel && !off && t.who ? `
      <div class="compose-h compose-deal-h">Which skill?</div>
      ${grp('Hitters', 'compose-four')}${grp('Pitchers', '')}
      ${_composeSkill ? `<div class="compose-h compose-deal-h">Rank by</div>
      <div class="compose-skills compose-two">${btn('data-rank', 'likely', 'Most likely to improve', '', _composeRank === 'likely')}${btn('data-rank', 'help', 'Most help to the team', '', _composeRank === 'help')}</div>` : ''}
      ${_composeSkill && _composeRank && _composeSkill !== 'defense' ? `<div class="compose-h compose-deal-h">Where</div>
      <div class="compose-skills compose-two">${btn('data-where', 'coach', 'With the coach', 'In practice or days away', _composeWhere === 'coach')}${btn('data-where', 'program', 'At the complex', 'A week away', _composeWhere === 'program')}</div>` : ''}` : '';
    // r197 the Send button right under the topic's last step: where the eye already is.
    const send = isSel && !off ? _composeSendBtn(t) : '';
    return `<div class="compose-topic-btn${isSel ? ' selected' : ''}${off ? ' disabled' : ''}" ${off ? '' : `data-topic="${t.id}"`}>
      <span>${_escape(t.label)}</span>
      <span class="topic-desc">${_escape(note || (st.info ? `${t.desc}. ${st.info}` : t.desc))}</span>
    </div>${deals}${players}${skills}${whoSteps}${send}`;
  }).join('');
  return `
    <button type="button" class="compose-back" id="compose-back">‹ All recipients</button>
    <div class="compose-to"><span class="compose-to-label">To</span> ${_escape(ch.label)}<span class="compose-to-role">${_escape(ch.role)}</span></div>
    <div class="compose-h">What about?</div>
    <div class="compose-topic-list">${rows}</div>`;
}

/** The picked topic's Send button: ready once every step is chosen, else what's left to pick. */
function _composeSendBtn(sel) {
  if (sel.who) {   // r251
    const ready = !!_composeSkill && !!_composeRank && (_composeSkill === 'defense' || !!_composeWhere);
    const label = ready ? 'Send Message' : !_composeSkill ? 'Pick a skill' : !_composeRank ? 'Pick how to rank' : 'Pick where';
    return `<button class="compose-send-btn compose-send-inline" ${ready ? '' : 'disabled'} id="compose-send-btn">${label}</button>`;
  }
  const canSend = (!(sel.deal || sel.player) || !!_composeDeal) && (!sel.skill || !!_composeSkill);
  const label = canSend ? 'Send Message' : sel.player && !_composeDeal ? 'Pick a player'
    : sel.skill ? (sel.choices === 'positions' ? 'Pick a position' : sel.choices === 'roles' ? 'Pick a role' : 'Pick a skill') : sel.deal === 'gms' ? 'Pick a GM' : 'Pick a deal';
  return `<button class="compose-send-btn compose-send-inline" ${canSend ? '' : 'disabled'} id="compose-send-btn">${label}</button>`;
}

/** r197 after a step is picked: the Send button in view, clear of the tab bar (its scroll-margin), scrolled only as far as needed. */
function _composeShowSend() {
  document.getElementById('compose-send-btn')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** A trade topic with one deal on the table: that deal, picked already. */
function _onlyDeal(ch, topicId) {
  const t = ch?.topics.find(x => x.id === topicId);
  if (!t?.deal) return null;
  const st = _topicState(t, StateManager.get());
  return st.deals?.length === 1 ? st.deals[0].key : null;
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
        _composeSkill   = null;
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

  // r198 §122.75 a trade message's deal as a table
  document.querySelectorAll('[data-deal-sheet]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const st = StateManager.get();
      const d = dealOfCard(st, getInbox().find(c => c.instanceId === btn.dataset.dealSheet));
      if (!d) return;
      const { openDealSheet } = await import('../components/DealSheet.js');
      openDealSheet({ offer: d.offer, teamName: d.team, versions: d.versions || null });
    });
  });

  // r204 §122.82 the free-agent report: sign (the sign sheet), or watch
  document.querySelectorAll('[data-fa-sign]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { openSignSheet } = await import('../components/SignSheet.js');
      openSignSheet(btn.dataset.faSign, 'sign');
    });
  });
  document.querySelectorAll('[data-fa-watch]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.faWatch;
      const { gmWatchFreeAgent } = await import('../../engine/GameEngine.js');
      const res = gmWatchFreeAgent(id);
      const st = StateManager.get();
      if (!res.ok) { App.showToast(`Can't do that: ${res.reason}.`, 'negative', 3500); refresh(); return; }
      const n = FaWatch.watching(st, Date.now()).length;
      App.showToast(`Watching ${st.players[id]?.name}: we'll hear first if a club moves to sign (${n} of ${FA_WATCH.max}).`, 'positive', 3500);
      refresh();
    });
  });

  // r202 §122.79 / r208 §122.86 ask Scouting about this deal (the Compose question, with the deal already picked)
  document.querySelectorAll('#inbox-content [data-ask-scouting]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      await askScouting(btn.dataset.askScouting);
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
      // r208 §122.86 the deal on the table this counters (the message itself, or the one Scouting's reply is about)
      const on = scoutingDeal(StateManager.get(), card._adviceDeal ? { key: card._adviceDeal } : { instanceId: card.instanceId }, Date.now());
      openTradeComposer({ teamId: r.teamId, theirIds: r.offer.incomingIds || [], ourIds: r.offer.outgoingIds || [],
                          cashK: r.offer.cashK || 0, retain: r.offer.retain || {}, round: r.round, dealKey: on?.deal.key || null });
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
      _composeChannel = ch.id;
      // One open topic: picked already.
      const open = ch.topics.filter(t => { if (t.opens) return false; const st = _topicState(t, StateManager.get()); return !st.waiting && !st.backAt && !st.none; });
      _composeTopic = open.length === 1 ? open[0].id : null;
      _composeDeal = _onlyDeal(ch, _composeTopic);
      _composeSkill = null; _composeRank = null; _composeWhere = null;
      refresh();
      _composeToTop();
    });
  });
  document.getElementById('compose-back')?.addEventListener('click', () => {
    _composeChannel = null; _composeTopic = null; _composeDeal = null; _composeSkill = null; _composeRank = null; _composeWhere = null;
    refresh();
    _composeToTop();
  });

  // Compose topic selection
  document.querySelectorAll('[data-topic]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      // r212 §122.90 "Talk trade" opens the trade screen
      const chNow = COMPOSE_CHANNELS.find(c => c.id === _composeChannel);
      if (chNow?.topics.find(x => x.id === el.dataset.topic)?.opens === 'trade') {
        import('../components/TradeComposer.js').then(m => m.openTradeComposer({}));
        return;
      }
      if (_composeTopic !== el.dataset.topic) { _composeDeal = null; _composeSkill = null; _composeRank = null; _composeWhere = null; }
      _composeTopic = el.dataset.topic;
      const ch = COMPOSE_CHANNELS.find(c => c.id === _composeChannel);
      _composeDeal = _composeDeal || _onlyDeal(ch, _composeTopic);
      refresh();
      _composeShowSend();
    });
  });
  document.querySelectorAll('[data-deal]').forEach(el => {
    el.addEventListener('click', () => { _composeDeal = el.dataset.deal; refresh(); _composeShowSend(); });
  });
  document.getElementById('compose-player')?.addEventListener('change', (e) => { _composeDeal = e.target.value || null; _composeSkill = null; _composeRank = null; _composeWhere = null; refresh(); _composeShowSend(); });
  document.querySelectorAll('[data-skill]').forEach(el => {
    el.addEventListener('click', () => { _composeSkill = el.dataset.skill; refresh(); _composeShowSend(); });
  });
  document.querySelectorAll('[data-rank]').forEach(el => el.addEventListener('click', () => { _composeRank = el.dataset.rank; refresh(); _composeShowSend(); }));     // r251
  document.querySelectorAll('[data-where]').forEach(el => el.addEventListener('click', () => { _composeWhere = el.dataset.where; refresh(); _composeShowSend(); }));

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
  if (_activeTab !== 'completed' && markRead(instanceId)) EventBus.emit('card:read', { instanceId });   // r267 the badges
  import('../PushClient.js').then(P => P.clearNotification(instanceId)).catch(() => {});   // r236 §122.115 opened here: its notification goes too
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
    const raw = getInbox().find(c => c.instanceId === instanceId);
    const card = raw && viewOf(raw, StateManager.get());   // r283 (the words the toast shows)
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
    // What the GM chose as the headline, with animated bars for every metric the decision moved (§63);
    // a plain toast when nothing measurable changed. r271 §122.150 never the sender's reply: it isn't here yet.
    const picked = pick != null ? card?._choices?.find(c => c.key === pick)?.label : null;
    const msg   = choice === 'yes' ? (picked || card?.yesLabel || 'Decision made.') : (card?.noLabel || 'Declined.');
    const shown = App.showDecisionEffects({ title: msg, before, after, positive: choice === 'yes' });
    if (!shown) App.showToast(msg, choice === 'yes' ? 'positive' : 'neutral', 3500);
    App.updateHeader(StateManager.get());   // budget in the header
  } catch (err) {
    console.error('InboxScreen._resolveCard:', err);
    App.showToast('That decision could not be saved. Please try again.', 'negative', 3000);
  }
  refresh();
}

/** r159 a work topic's choices: a skill (its rating) — r166 §122.35 or a position to teach (where it stands). */
function _choicesFor(t, p) {
  if (!p) return [];
  if (t.choices === 'roles') {   // r169 a reliever's role
    const now = penRoleOf(StateManager.get().userTeam, p.id);
    return [{ key: 'closer', name: 'Closer', val: now === 'closer' ? 'now' : '' }, { key: 'setup', name: 'Setup', val: now === 'setup' ? 'now' : '' },
            { key: 'auto', name: 'Manager\'s call', val: now ? '' : 'now' }];
  }
  if (t.choices === 'positions') return teachablePositions(p).map(x => {
    const n = startsAt(p, x);
    return { key: x, name: x, val: n ? `${n}/10` : familiarity(p, x) > 0 ? 'practiced' : 'new' };
  });
  // r251 §122.130 the Bench Coach's "work with a player on…": a hitter's glove too
  const ks = t.choices === 'work' && !['SP', 'RP'].includes(p.pos) && p.subRatings?.defense != null ? [...skillsOf(p), 'defense'] : skillsOf(p);
  return ks.map(k => ({ key: k, name: k[0].toUpperCase() + k.slice(1), val: p.subRatings?.[k] ?? '—' }));
}

/** r251 §122.130 the skills "who should we work on" can be about (hitters', then pitchers'). */
const WHO_SKILL_LIST = [['contact', 'Contact', 'Hitters'], ['power', 'Power', 'Hitters'], ['speed', 'Speed', 'Hitters'], ['defense', 'Defense', 'Hitters'],
  ['stuff', 'Stuff', 'Pitchers'], ['control', 'Control', 'Pitchers'], ['stamina', 'Stamina', 'Pitchers']];

async function _sendCompose(topicId, channelId, state) {
  const ch = COMPOSE_CHANNELS.find(c => c.id === channelId);
  const topic = ch?.topics.find(t => t.id === topicId);
  // r150 a trade topic asks about one deal (no cooldown: one question per deal).
  const deal = topic?.deal ? (_topicState(topic, state).deals || []).find(d => d.key === _composeDeal) : null;
  if (topic?.deal && !deal) { App.showToast('That deal is no longer waiting on us.', 'neutral', 2500); refresh(); return; }
  const player = topic?.player ? (_topicState(topic, state).players || []).find(p => p.id === _composeDeal) : null;
  if (topic?.player && !player) { App.showToast(topic.player === true ? 'That player can\'t be traded right now.' : 'That player isn\'t available to ask about.', 'neutral', 2500); refresh(); return; }
  // r251 §122.130 who should we work on: the skill, how to rank, where (no cooldown: ask about each skill)
  if (topic?.who) {
    const sk = _composeSkill, rank = _composeRank, where = sk === 'defense' ? 'coach' : _composeWhere;
    if (!WHO_SKILL_LIST.some(([k]) => k === sk) || !rank || !where) { App.showToast('Pick a skill, how to rank, and where.', 'neutral', 2500); refresh(); return; }
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    deliverComposeCard(topicId, channelId, { topicLabel: `Who should we work on for ${sk}?`, arg: { skill: sk, rank, where } });
    import('../PushClient.js').then(P => P.syncPushSchedule()).catch(() => {});
    _composeChannel = null; _composeTopic = null; _composeDeal = null; _composeSkill = null; _composeRank = null; _composeWhere = null;
    App.showToast(`Message sent to ${ch?.label || 'staff'}. You'll hear back.`, 'positive', 2500);
    refresh(); _composeToTop();
    return;
  }
  const skill = topic?.skill ? _composeSkill : null;
  if (topic?.skill && !_choicesFor(topic, player).some(c => c.key === skill)) { App.showToast(topic.choices === 'positions' ? 'Pick a position.' : topic.choices === 'roles' ? 'Pick a role.' : 'Pick a skill to work on.', 'neutral', 2500); refresh(); return; }
  const WORK_LABEL = { hc_work: (p) => `Work with ${p.name} on ${skill}`, pc_work: (p) => `Work with ${p.name} on ${skill}`, bc_work: (p) => `Work with ${p.name} on ${skill}`,
                       sc_program: (p) => `A development program for ${p.name}`, mgr_rest: (p) => `A day off for ${p.name}`,
                       doc_health: (p) => `${p.name}'s health`, bc_teach: (p) => `Teach ${p.name} ${skill}`,
                       pc_stretch: (p) => `Stretch ${p.name} out`, bc_defense: (p) => `Work with ${p.name} on defense`, pc_roles: (p) => `${p.name}'s role`,
                       sc_retire: (p) => `Is ${p.name} retiring?` };

  // Record cooldown immediately (r264 the moment it was asked)
  if (!topic?.deal && !topic?.player && !topic?.looks) StateManager.mutate(s => {
    s.composeCooldowns = { ...(s.composeCooldowns || {}), [topicId]: Date.now() };
  });

  // §105 the reply is written now and arrives later (CardEngine schedules it; a push when it lands).
  try {
    const { deliverComposeCard } = await import('../../engine/CardEngine.js');
    deliverComposeCard(topicId, channelId, topic?.deal === 'gms' && deal
      ? { topicLabel: 'Welcome to the league', arg: { key: deal.key, gm: deal.gm, club: deal.club, label: deal.label } }
      : deal
      ? { topicLabel: deal.label, arg: { key: deal.key, label: deal.label, instanceId: deal.instanceId, expiresAtMs: deal.expiresAtMs } }
      : player && WORK_LABEL[topicId] ? { topicLabel: WORK_LABEL[topicId](player), arg: { playerId: player.id, skill, label: player.name } }
      : player ? { topicLabel: `What could we get for ${player.name}?`, arg: { playerId: player.id, label: player.name } }
      : { topicLabel: topic?.label || '' });
    import('../PushClient.js').then(P => P.syncPushSchedule()).catch(() => {});
  } catch (err) {
    console.error('InboxScreen._sendCompose:', err);
  }

  // Back to the list, where the message waits under "Waiting to hear back".
  _composeChannel = null;
  _composeTopic   = null;
  _composeDeal    = null;
  _composeSkill   = null;
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
