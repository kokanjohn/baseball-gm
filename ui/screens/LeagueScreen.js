/**
 * ui/screens/LeagueScreen.js
 * League tab rendered into #league-content.
 *
 * Three internal tabs (Section 1.14 — LOCKED):
 *   Players   — §122.7 ESPN-fantasy style: opens on everyone we could add (free
 *               agents and waivers); Filter / Team / Health / Sort; add from the row
 *   Teams     — all 10 teams grouped by division with record and streak
 *   Standings — division standings with W/L/GB + stat leaders (Section 28.7)
 *   Moves     — §90 the League wire: every trade, signing, claim and release,
 *               this season and last, newest first (text only)
 *
 * Stat leaders (Section 28.7 — LOCKED):
 *   Batting: AVG, HR, RBI, SB
 *   Pitching: ERA, W, K, SV
 *   Top 5 per category. User's players highlighted.
 *
 * Activity feed (Section 28.5 — LOCKED):
 *   72-hour rolling feed shown at bottom of Standings tab.
 *
 * Hot/cold indicators shown on Players tab (own roster only on free tier).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getHotColdIndicator, getImpLeaderboard, lastSeasonIMP } from '../../engine/IMPEngine.js';
import { openSignSheet } from '../components/SignSheet.js';
import {
  formatRecord, formatGB, formatOVR,
  formatERA, formatAVG, formatStreak,
} from '../formatters.js';
import { openPlayerCard } from '../components/PlayerCard.js';
import * as FreeAgency from '../../engine/FreeAgency.js';
import * as Roster from '../../engine/RosterEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { PHASE } from '../../data/constants.js';
import * as When from '../../engine/When.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab  = 'players';
let _mounted    = false;
let _listeners  = [];

// Players tab filter/sort state
let _playerFilter = { pos: 'batters', view: 'available', team: 'all', health: 'all' };   // §122.7
let _playerSort   = { col: 'ovr', dir: 'desc' };
let _lpSearch     = '';
let _rowLimit     = 100;   // r146 the list shows this many; "Show more" adds the next hundred
let _limitKey     = '';    // the filters the limit was raised for (new filters start at 100 again)
// §90 Moves tab filter: 'all' | 'trades' | 'ours'
let _wireFilter   = 'all';

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('league', () => refresh());

  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('game:committed',    () => { if (_activeTab === 'standings' || _activeTab === 'playoffs') refresh(); });
  wire('game:phaseChanged', () => refresh());
  wire('roster:changed',    () => { if (_activeTab === 'playoffs') refresh(); });
  wire('game:phaseChanged', () => refresh());
  wire('roster:changed',    () => refresh());
  wire('nav:tabActivated',  ({ tab }) => { if (tab === 'league') refresh(); });

  refresh();
}

/**
 * showAvailable({ side, pos }) — §122.4 an open spot on the Team screen jumps
 * here: League → Players, everyone we could add who fits the spot.
 */
export function showAvailable({ side = 'hitter', pos = null } = {}) {
  _activeTab = 'players';
  _lpSearch = '';
  const key = side === 'pitcher' ? (pos === 'SP' || pos === 'RP' ? pos : 'pitchers') : (pos && pos !== 'DH' ? pos : 'batters');
  _playerFilter = { pos: key, view: 'available', team: 'all', health: 'healthy' };
  _playerSort = { col: 'ovr', dir: 'desc' };
  App.switchTab('league');
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
  const container = document.getElementById('league-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state) return;

  container.innerHTML = `
    <div class="league-screen">
      <div class="league-tab-bar">
        <button class="league-tab-btn ${_activeTab === 'players'   ? 'active' : ''}" id="ltab-players">Players</button>
        <button class="league-tab-btn ${_activeTab === 'teams'     ? 'active' : ''}" id="ltab-teams">Teams</button>
        <button class="league-tab-btn ${_activeTab === 'standings' ? 'active' : ''}" id="ltab-standings">Standings</button>
        <button class="league-tab-btn ${_activeTab === 'moves'     ? 'active' : ''}" id="ltab-moves">Moves</button>
        ${state.playoffBracket ? `<button class="league-tab-btn ${_activeTab === 'playoffs' ? 'active' : ''}" id="ltab-playoffs">Playoffs</button>` : ''}
      </div>
      <div class="league-tab-content active" id="league-body">
        ${_renderTabBody(state)}
      </div>
    </div>
  `;

  _attachListeners(state);
}

function _renderTabBody(state) {
  switch (_activeTab) {
    case 'players':   return _renderPlayers(state);
    case 'teams':     return _renderTeams(state);
    case 'standings': return _renderStandings(state);
    case 'moves':     return _renderMoves(state);
    case 'playoffs':  return '<div id="playoff-content"></div>';   // filled by PlayoffScreen (§68)
    default:          return '';
  }
}

// ─────────────────────────────────────────────────────────────
// STANDINGS TAB
// ─────────────────────────────────────────────────────────────

function _renderStandings(state) {
  const standings  = state.standings || { divA: [], divB: [] };
  const userTeamId = 'user';

  const renderDiv = (label, teams) => {
    if (!teams || teams.length === 0) return '';

    const rows = teams.map((entry, idx) => {
      const isUser  = entry.id === userTeamId;
      const streak  = formatStreak(entry.streak || 0);
      const strCls  = (entry.streak || 0) > 0 ? 'lgt-str-w'
                    : (entry.streak || 0) < 0  ? 'lgt-str-l' : '';

      const gp    = (entry.wins || 0) + (entry.losses || 0);
      const pct   = gp > 0 ? (entry.wins / gp).toFixed(3).replace(/^0/, '') : '.000';

      return `
        <div class="standing-row ${isUser ? 'player-row' : ''}" data-team-id="${entry.id}" style="cursor:pointer;">
          <span class="pos-num">${idx + 1}</span>
          <span class="s-name">
            ${_escape(entry.name || entry.abbr || '?')}
            ${isUser ? '<span class="lgt-you">YOU</span>' : ''}
          </span>
          <span class="wl">${formatRecord(entry.wins || 0, entry.losses || 0)}</span>
          <span class="lg-stand-pct" style="font-size:11px;color:var(--muted);width:38px;text-align:right;">${pct}</span>
          <span class="gb">${idx === 0 ? '—' : formatGB(entry.gb)}</span>
          <span class="lgt-str ${strCls}" style="width:28px;text-align:right;font-size:11px;">${streak}</span>
        </div>
      `;
    }).join('');

    return `
      <div style="margin-bottom:12px;">
        <div style="padding:12px 16px 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">
          ${_escape(label)}
        </div>
        <div class="standings-card">${rows}</div>
      </div>
    `;
  };

  const statLeaders = _renderStatLeaders(state);
  const feed        = _renderActivityFeed(state);

  return `
    <div style="padding:8px 0 16px;">
      ${renderDiv('Division A', standings.divA)}
      ${renderDiv('Division B', standings.divB)}
      ${statLeaders}
      ${feed}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// STAT LEADERS (Section 28.7 — LOCKED)
// ─────────────────────────────────────────────────────────────

function _renderStatLeaders(state) {
  const userRosterIds = new Set(state.userTeam?.rosterIds || []);
  const players       = state.players || {};

  // Gather all active players across all teams
  const allPlayerIds = [
    ...(state.userTeam?.rosterIds || []),
    ...(state.leagueTeams || []).flatMap(t => t.rosterIds || []),
  ];

  // During spring training the season stat line is empty — everything lives in
  // springStats. Read the phase-appropriate source so leaders show in spring too.
  const inSpring = state.phase === PHASE.SPRING_TRAINING;
  const SK = inSpring ? 'springStats' : 'stats';

  const hitters  = allPlayerIds.map(id => players[id]).filter(p => p && !['SP','RP'].includes(p.pos) && (p[SK]?.ab || 0) >= 1);
  const pitchers = allPlayerIds.map(id => players[id]).filter(p => p && ['SP','RP'].includes(p.pos) && (p[SK]?.ip || 0) >= 0.1);

  const top5 = (arr, sortFn) => arr.sort(sortFn).slice(0, 5);

  // Batting categories
  const avgLeaders = top5([...hitters], (a,b) => {
    const aAvg = a[SK].ab ? a[SK].h / a[SK].ab : 0;
    const bAvg = b[SK].ab ? b[SK].h / b[SK].ab : 0;
    return bAvg - aAvg;
  });
  const hrLeaders  = top5([...hitters], (a,b) => (b[SK].hr||0)  - (a[SK].hr||0));
  const rbiLeaders = top5([...hitters], (a,b) => (b[SK].rbi||0) - (a[SK].rbi||0));
  const sbLeaders  = top5([...hitters], (a,b) => (b[SK].sb||0)  - (a[SK].sb||0));

  // Pitching categories
  const eraLeaders = top5([...pitchers], (a,b) => {
    const aEra = a[SK].ip ? (a[SK].er / a[SK].ip) * 9 : 99;
    const bEra = b[SK].ip ? (b[SK].er / b[SK].ip) * 9 : 99;
    return aEra - bEra; // lower is better
  });
  const wLeaders   = top5([...pitchers], (a,b) => (b[SK].w||0)  - (a[SK].w||0));
  const kLeaders   = top5([...pitchers], (a,b) => (b[SK].k||0)  - (a[SK].k||0));
  const svLeaders  = top5([...pitchers], (a,b) => (b[SK].sv||0) - (a[SK].sv||0));

  const renderCategory = (label, players, statFn) => {
    if (players.length === 0) return '';
    const rows = players.map((p, i) => {
      const isUser = userRosterIds.has(p.id);
      return `
        <div class="stat-leader-row ${isUser ? 'user-player' : ''}">
          <span class="slr-rank">${i+1}</span>
          <span class="slr-name">${_escape(p.name)}</span>
          <span class="slr-team">${_escape(p.teamId === 'user' ? state.userTeam?.abbr || 'YOU' : _teamAbbr(p.teamId, state))}</span>
          <span class="slr-stat">${statFn(p)}</span>
        </div>
      `;
    }).join('');
    return `
      <div class="stat-leader-cat">
        <div class="slc-label">${label}</div>
        ${rows}
      </div>
    `;
  };

  return `
    <div style="padding:4px 16px 8px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">
        Stat Leaders
      </div>
      ${inSpring ? `
      <div style="display:flex;align-items:center;gap:8px;margin:-4px 0 12px;padding:6px 10px;border-radius:8px;background:rgba(245,165,36,0.12);border:1px solid rgba(245,165,36,0.4);">
        <span style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#F5A524;">⚾ SPRING TRAINING</span>
        <span style="font-size:10px;color:var(--muted);">Preseason stats — reset for opening day</span>
      </div>` : ''}
      <div style="font-size:10px;color:var(--muted);margin-bottom:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Batting</div>
      <div class="stat-leaders-grid">
        ${renderCategory('AVG', avgLeaders,  p => formatAVG(p[SK].h||0, p[SK].ab||0))}
        ${renderCategory('HR',  hrLeaders,   p => String(p[SK].hr||0))}
        ${renderCategory('RBI', rbiLeaders,  p => String(p[SK].rbi||0))}
        ${renderCategory('SB',  sbLeaders,   p => String(p[SK].sb||0))}
      </div>
      <div style="font-size:10px;color:var(--muted);margin:10px 0 8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Pitching</div>
      <div class="stat-leaders-grid">
        ${renderCategory('ERA', eraLeaders, p => p[SK].ip ? ((p[SK].er/p[SK].ip)*9).toFixed(2) : '—')}
        ${renderCategory('W',   wLeaders,   p => String(p[SK].w||0))}
        ${renderCategory('K',   kLeaders,   p => String(p[SK].k||0))}
        ${renderCategory('SV',  svLeaders,  p => String(p[SK].sv||0))}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED (Section 28.5 — LOCKED)
// ─────────────────────────────────────────────────────────────

function _renderActivityFeed(state) {
  const feed = (state.activityFeed || []).slice(-20).reverse();
  if (feed.length === 0) return '';

  const entries = feed.map(entry => `
    <div class="activity-feed-entry">
      <div class="activity-feed-icon">${_activityIcon(entry.type)}</div>
      <div class="activity-feed-text">${_escape(entry.text || '')}</div>
      <div class="activity-feed-time">${_feedTime(entry, state)}</div>
    </div>
  `).join('');

  return `
    <div style="margin:4px 0 8px;">
      <div style="padding:12px 16px 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">
        Around the League
      </div>
      <div style="background:var(--surface);border-top:1px solid var(--border);border-bottom:1px solid var(--border);">
        ${entries}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// MOVES TAB — the League wire (§90)
// ─────────────────────────────────────────────────────────────

function _renderMoves(state) {
  const all = (state.leagueWire || []).slice().reverse();
  const shown = all.filter(e => _wireFilter === 'trades' ? e.kind === 'trade'
    : _wireFilter === 'ours' ? (e.teamIds || []).includes('user') : true);
  const chip = (id, label) => `<button class="lw-chip ${_wireFilter === id ? 'active' : ''}" data-wire="${id}">${label}</button>`;
  const head = `<div class="lw-bar">${chip('all', 'All')}${chip('trades', 'Trades')}${chip('ours', 'Our Club')}</div>`;
  if (!shown.length) {
    return `${head}<div class="lw-empty">${all.length ? 'Nothing here yet.' : 'No moves yet. Trades, signings, waiver claims and releases around the league appear here as they happen.'}</div>`;
  }
  const dayKey = (ms) => new Date(ms).toDateString();
  const dayLabel = (ms) => When.agoDay(ms, Date.now());   // r149 relative: "Today", "Yesterday", "3 days ago"
  const KIND = { trade: 'Trade', signing: 'Signing', claim: 'Waiver claim', release: 'Free agent', retire: 'Retirement' };
  let html = head, last = null;
  for (const e of shown.slice(0, 200)) {
    const k = dayKey(e.atMs);
    if (k !== last) {
      html += `<div class="lw-day">${dayLabel(e.atMs)}${e.season !== (state.seasonNum || 1) ? ' · last season' : ''}</div>`;
      last = k;
    }
    const ours = (e.teamIds || []).includes('user');
    html += `<div class="lw-row${ours ? ' lw-ours' : ''}">
      <div class="lw-kind">${KIND[e.kind] || 'Move'}</div>
      <div class="lw-text">${_escape(e.text)}</div>
    </div>`;
  }
  return html;
}

// ─────────────────────────────────────────────────────────────
// TEAMS TAB
// ─────────────────────────────────────────────────────────────

function _renderTeams(state) {
  const userTeam    = state.userTeam;
  const leagueTeams = state.leagueTeams || [];
  const standings   = state.standings   || {};

  // Build a combined list with standings info
  const allTeams = _buildTeamList(userTeam, leagueTeams, standings);
  const divA     = allTeams.filter(t => t.divisionId === 'A');
  const divB     = allTeams.filter(t => t.divisionId === 'B');

  const renderDivTeams = (label, teams) => {
    if (teams.length === 0) return '';
    return `
      <div class="lgt-div-label">${label}</div>
      ${teams.map(t => {
        const isUser  = t.id === 'user';
        const streak  = t.streak || 0;
        const strTxt  = formatStreak(streak);
        const strCls  = streak > 0 ? 'lgt-str-w' : streak < 0 ? 'lgt-str-l' : '';
        return `
          <div class="lgt-card" data-team="${t.id}">
            <span class="lgt-abbr">${_escape(t.abbr || '?')}</span>
            <span class="lgt-name">
              ${_escape(t.name || '')}
              ${isUser ? '<span class="lgt-you">YOU</span>' : ''}
            </span>
            <span class="lgt-wl">${formatRecord(t.wins || 0, t.losses || 0)}</span>
            <span class="lgt-str ${strCls}">${strTxt}</span>
          </div>
        `;
      }).join('')}
    `;
  };

  return `
    <div style="padding-bottom:16px;">
      ${renderDivTeams('Division A', divA)}
      ${renderDivTeams('Division B', divB)}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// PLAYERS TAB
// ─────────────────────────────────────────────────────────────

function _renderPlayers(state) {
  const userRosterIds = new Set(state.userTeam?.rosterIds || []);
  const players       = state.players || {};
  const impScores     = state.impScores || {};
  const leagueTeams   = state.leagueTeams || [];
  const f             = _playerFilter;

  const isSearching = _lpSearch.trim().length > 0;
  const limitKey = JSON.stringify([f, _lpSearch.trim()]);
  if (limitKey !== _limitKey) { _limitKey = limitKey; _rowLimit = 100; }
  const waivers = FreeAgency.waiverList(state), fas = FreeAgency.freeAgentList(state);
  const rostered = () => [...(state.userTeam?.rosterIds || []), ...leagueTeams.flatMap(t => t.rosterIds || [])].map(id => players[id]).filter(Boolean);

  // §122.7 Filter: who's in the list. Available (the default) is everyone we could add.
  let allPlayers = isSearching ? [...rostered(), ...waivers, ...fas]
    : f.view === 'waivers' ? waivers
    : f.view === 'fa'      ? fas
    : f.view === 'rosters' ? rostered()
    : f.view === 'all'     ? [...rostered(), ...waivers, ...fas]
    : [...waivers, ...fas];
  const available = (p) => p.onWaivers || p.group === 'freeAgent';
  const showMarket = !isSearching && ['available', 'waivers', 'fa'].includes(f.view);

  // Team: one club's players (On Rosters / All).
  if (!isSearching && ['rosters', 'all'].includes(f.view) && f.team !== 'all') {
    allPlayers = allPlayers.filter(p => (f.team === 'user' ? userRosterIds.has(p.id) : p.teamId === f.team) && !available(p));
  }
  // Health: IL-eligible (out long enough for the IL) or healthy (day-to-day counts, tagged DTD).
  if (!isSearching && f.health === 'il') allPlayers = allPlayers.filter(p => _ilEligible(p));
  if (!isSearching && f.health === 'healthy') allPlayers = allPlayers.filter(p => !_ilEligible(p));

  // Search filter (last name) — runs over everyone
  if (isSearching) {
    const q = _lpSearch.trim().toLowerCase();
    allPlayers = allPlayers.filter(p => (p.name || '').toLowerCase().includes(q));
  }

  // Position filter — bypassed when searching so cross-position search works
  const HITTER_POS  = ['C','1B','2B','3B','SS','OF','DH'];
  const PITCHER_POS = ['SP','RP'];
  const POS_FAMILY  = {
    '2B': ['2B','2B/SS'], '1B': ['1B','1B/3B'], 'DH': ['DH','DH/OF'],
    'SS': ['SS','2B/SS'], '3B': ['3B','1B/3B'], 'OF': ['OF','DH/OF'],
  };
  const pos = f.pos;
  if (!isSearching) {
    if (pos === 'batters') allPlayers = allPlayers.filter(p => !['SP','RP'].includes(p.pos));
    else if (pos === 'pitchers') allPlayers = allPlayers.filter(p => ['SP','RP'].includes(p.pos));
    else if (pos !== 'all') {
      const family = POS_FAMILY[pos] || [pos];
      allPlayers = allPlayers.filter(p => family.includes(p.nativePos || p.pos));
    }
  }

  allPlayers = _sortPlayers(allPlayers, _playerSort, impScores, state);
  const isPitcherView = pos === 'pitchers' || PITCHER_POS.includes(pos);

  // ── Filter UI (sticky) ────────────────────────────────────────
  const posBtn = (label, key) =>
    `<button class="lp-pos-btn ${f.pos === key ? 'active' : ''}" data-pos="${key}">${label}</button>`;
  const filterBar = `
    <div class="lp-pos-bar">
      <div class="lp-pos-row1">
        ${posBtn('Batters',  'batters')}
        ${posBtn('Pitchers', 'pitchers')}
      </div>
      <div class="lp-pos-row2">
        ${HITTER_POS.map(p => posBtn(p, p)).join('')}
        <span class="lp-sep">|</span>
        ${PITCHER_POS.map(p => posBtn(p, p)).join('')}
      </div>
    </div>`;

  const opt = (v, label, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
  const viewSel = [
    opt('available', 'Available', f.view),
    opt('waivers', 'On Waivers', f.view),
    opt('fa', 'Free Agents', f.view),
    opt('rosters', 'On Rosters', f.view),
    opt('all', 'All', f.view),
  ].join('');
  const teamSel = [
    opt('all', 'All Teams', f.team),
    opt('user', _escape(state.userTeam?.abbr || 'My Team'), f.team),
    ...leagueTeams.map(t => opt(t.id, _escape(t.name), f.team)),
  ].join('');
  const healthSel = [opt('all', 'Health: All', f.health), opt('il', 'IL-eligible', f.health), opt('healthy', 'Healthy', f.health)].join('');

  const rosterFilterBar = `
    <div class="lp-roster-bar">
      <select class="lp-sel" id="lp-view-select" aria-label="Filter">${viewSel}</select>
      ${['rosters', 'all'].includes(f.view) ? `<select class="lp-sel" id="lp-team-select" aria-label="Team">${teamSel}</select>` : ''}
      <select class="lp-sel" id="lp-health-select" aria-label="Health">${healthSel}</select>
    </div>
    <div class="lp-roster-bar">
      <input id="lp-search" type="search" placeholder="Last name…" value="${_escape(_lpSearch)}"
        class="lp-search-input" autocomplete="off" autocorrect="off" spellcheck="false">
      <button class="lp-reset-btn" id="lp-reset-btn" title="Reset filters">Reset</button>
    </div>`;

  // Columns: for players we could add, the add button and the asking price come first.
  // (Time left on waivers sits beside the name: "2d".)
  const market = showMarket ? [{ key: 'add', label: '' }, { key: 'price', label: 'ASK' }] : [];
  const statCols = [...market, ...(isPitcherView
    ? [
        { key:'ip',   label:'IP'   },
        { key:'h_allowed', label:'H' },
        { key:'er',   label:'ER'   },
        { key:'bb',   label:'BB'   },
        { key:'k',    label:'K'    },
        { key:'w',    label:'W'    },
        { key:'era',  label:'ERA'  },
        { key:'svhd', label:'SVHD' },
        { key:'imp',  label:'IMP'  },
        { key:'ovr',  label:'RTG'  },
      ]
    : [
        { key:'hab',  label:'H/AB' },
        { key:'avg',  label:'AVG'  },
        { key:'r',    label:'R'    },
        { key:'hr',   label:'HR'   },
        { key:'rbi',  label:'RBI'  },
        { key:'bb',   label:'BB'   },
        { key:'sb',   label:'SB'   },
        { key:'imp',  label:'IMP'  },
        { key:'ovr',  label:'RTG'  },
      ])];

  const extra = (k) => k === 'hab' ? ' lp-th-hab' : k === 'imp' ? ' lp-td-imp' : k === 'add' ? ' lp-td-add' : k === 'price' ? ' lp-td-mkt' : '';
  const heads = statCols.map(c => {
    const isActive = c.key === _playerSort.col;
    return `<div class="lp-th${extra(c.key)} ${isActive ? 'lp-th-active' : ''}" ${c.key === 'add' ? '' : `data-sort="${c.key}"`}>${c.label}</div>`;
  }).join('');

  const rows = allPlayers.slice(0, _rowLimit).map(p => {
    const isUser   = userRosterIds.has(p.id);
    const teamAbbr = isUser
      ? ((state.userTeam?.abbr || '').toUpperCase() || '—')
      : p.onWaivers ? 'Waivers'
      : p.group === 'freeAgent' ? 'FA'
      : _teamAbbr(p.teamId, state);
    const dtd = p.injury?.status === 'dtd' ? ' · <span class="lp-dtd">DTD</span>' : _ilEligible(p) ? ' · <span class="lp-il">IL</span>' : '';
    // §122.9 a player with nothing this season (a free agent, spring): last season's line, marked.
    const shown = _statsShown(p);
    const statVals = statCols.map(c => {
      if (c.key === 'add') {
        const label = p.onWaivers ? (p._userClaim ? 'Claimed' : 'Claim') : p.group === 'freeAgent' ? 'Add' : '';
        const kind = p.onWaivers ? (p._userClaim ? 'withdraw' : 'claim') : 'sign';
        return `<div class="lp-td lp-td-add">${label && !(p.onWaivers && p._waivedBy === 'user') && !p.isInjured
          ? `<button class="lp-add-btn${p._userClaim ? ' on' : ''}" data-add="${p.id}" data-kind="${kind}">${label}</button>` : ''}</div>`;
      }
      if (c.key === 'price') return `<div class="lp-td lp-td-mkt">${p.group === 'freeAgent' ? _askText(state, p) : p.onWaivers ? _money(p.contractSalary || 0) : '—'}</div>`;
      if (c.key === 'imp') {
        const now = impScores[p.id]?.impS;
        const v = now ?? lastSeasonIMP(p);
        return `<div class="lp-td lp-td-imp">${
          v != null
            ? `<span class="lp-imp ${v > 0 ? 'lp-imp-pos' : v < 0 ? 'lp-imp-neg' : 'lp-imp-neu'}${now == null ? ' lp-imp-ly' : ''}" title="${now == null ? 'Last season' : 'This season'}">${v > 0 ? '+' : ''}${v.toFixed(1)}${now == null ? '<span class="lp-ly">LY</span>' : ''}</span>`
            : `<span class="lp-imp lp-imp-neu">—</span>`
        }</div>`;
      }
      return `<div class="lp-td${c.key === 'hab' ? ' lp-td-hab' : ''}">${_playerStatVal(shown.p, c.key)}</div>`;
    }).join('');

    return `
      <div class="lp-row ${isUser ? 'user-player-row' : ''}" data-player="${p.id}">
        <div class="lp-td-name">
          <div class="lp-name-line">${_escape(p.name)}${p.onWaivers ? ` <span class="lp-wv-left" title="Time left on waivers">${_waiverLeft(p)}</span>` : ''}</div>
          <div class="lp-name-sub">${_escape(teamAbbr)} · ${p.nativePos || p.pos}${shown.year ? ` · <span class="lp-lyline">'${String(shown.year).slice(-2)} stats</span>` : ''}${dtd}</div>
        </div>
        ${statVals}
      </div>`;
  }).join('');

  const leaders = f.view === 'rosters' && !isSearching ? _renderImpactLeaders(state) : '';

  return `
    <div id="lp-filter-wrap" class="lp-tab-wrap active">
      <div class="lp-sticky-header">
        ${filterBar}
        ${rosterFilterBar}
      </div>
      ${leaders}
      <div class="lp-scroll-wrap">
        <div class="lp-header">
          <div class="lp-th-name lp-col-sticky">Player</div>
          ${heads}
        </div>
        <div id="lp-list">${rows || `<div class="lw-empty">${
          f.view === 'waivers' ? 'No one on waivers fits these filters right now. A club puts a player on waivers to clear a roster spot; any club can claim for 72 hours, worst record first.'
          : f.view === 'fa' || f.view === 'available' ? 'No free agents fit these filters right now.'
          : 'No players match these filters.'}</div>`}</div>
        ${allPlayers.length > _rowLimit ? `<button class="lp-more-btn" id="lp-more-btn">Show ${Math.min(100, allPlayers.length - _rowLimit)} more <span>(${_rowLimit} of ${allPlayers.length} shown)</span></button>` : ''}
      </div>
    </div>
  `;
}

/** The stats a row shows: this season's, or — with none yet — last season's (and its year). */
function _statsShown(p) {
  const s = p.stats || {};
  if ((s.ab || 0) > 0 || (s.ip || 0) > 0 || (s.outs || 0) > 0) return { p, year: null };
  const last = (p.seasonLog || []).filter(e => e?.stats).at(-1);
  return last ? { p: { ...p, stats: last.stats }, year: last.year } : { p, year: null };
}

/** §122.7 out long enough for the IL (not day-to-day). */
function _ilEligible(p) {
  if (!p?.isInjured && p?.group !== 'il') return false;
  return p.injury?.status !== 'dtd';
}

const _money = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(k >= 10000 ? 0 : 1)}M` : `$${Math.round(k)}K`);
function _askText(state, p) {
  const t = FreeAgency.termsFor(state, p);
  return _money(t.salary || 0);
}
/** Time left on waivers, beside the name: "2d", or "14h" on the last day. */
function _waiverLeft(p) {
  const left = Math.max(0, FreeAgency.waiverEndsAt(p) - Date.now());
  const h = Math.floor(left / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d` : `${h}h`;
}

/** §30.6 the Impact leaders: the season's top five hitters and pitchers (labels with the number). */
function _renderImpactLeaders(state) {
  const lb = getImpLeaderboard(state, 5);
  if (!lb.hitters.length && !lb.pitchers.length) return '';
  const col = (title, xs) => `
    <div class="lp-lead-col">
      <div class="lp-lead-title">${title}</div>
      ${xs.map((e, i) => `<div class="lp-lead-row" data-player="${e.playerId}"><span>${i + 1}. ${_escape(e.name)} <span class="lp-lead-tm">${_escape(_teamAbbr(e.teamId, state))}</span></span><span class="lp-lead-v">${e.impS > 0 ? '+' : ''}${e.impS.toFixed(1)}</span></div>`).join('')}
    </div>`;
  return `<div class="lp-leaders"><div class="lp-lead-head">Impact leaders</div><div class="lp-lead-cols">${col('Hitters', lb.hitters)}${col('Pitchers', lb.pitchers)}</div></div>`;
}

function _getPlayerCols(posFilter) {
  if (posFilter === 'P') {
    return [
      { key: 'name', label: 'Player' },
      { key: 'team', label: 'Tm' },
      { key: 'ovr',  label: 'OVR' },
      { key: 'era',  label: 'ERA' },
      { key: 'w',    label: 'W' },
      { key: 'k',    label: 'K' },
      { key: 'sv',   label: 'SV' },
    ];
  }
  return [
    { key: 'name', label: 'Player' },
    { key: 'team', label: 'Tm' },
    { key: 'ovr',  label: 'OVR' },
    { key: 'avg',  label: 'AVG' },
    { key: 'hr',   label: 'HR' },
    { key: 'rbi',  label: 'RBI' },
  ];
}

function _playerStatVal(player, key) {
  const s = player.stats || {};
  switch (key) {
    case 'ovr':  return formatOVR(player.ovr);
    case 'hab':  return s.ab ? `${s.h||0}/${s.ab}` : '0/0';
    case 'avg':  return s.ab ? formatAVG(s.h||0, s.ab||0) : '.---';
    case 'hr':   return String(s.hr  || 0);
    case 'rbi':  return String(s.rbi || 0);
    case 'r':    return String(s.r   || 0);
    case 'sb':   return String(s.sb  || 0);
    case 'h_allowed': return String(s.h_allowed || 0);
    case 'er':   return String(s.er  || 0);
    case 'era':  {
      // ip may be stored as decimal (0.333 per out) or as outs count
      const outs = s.outs || 0;
      const ip   = outs > 0 ? outs / 3 : (s.ip || 0);
      return ip > 0 ? ((s.er||0) / ip * 9).toFixed(2) : '—';
    }
    case 'ip':   {
      const outs = s.outs || 0;
      if (outs > 0) return `${Math.floor(outs/3)}.${outs%3}`;
      const ip = s.ip || 0;
      return ip > 0 ? `${Math.floor(ip)}.${Math.round((ip % 1) * 3)}` : '—';
    }
    case 'bb':   return String(s.bb  || 0);
    case 'svhd': return String((s.sv || 0) + (s.hld || 0));
    case 'w':    return String(s.w   || s.wins || 0);
    case 'k':    return String(s.k   || 0);
    case 'sv':   return String(s.sv  || 0);
    case 'imp7': {
      // handled separately as impCell in the row — return placeholder
      return '—';
    }
    default:     return '—';
  }
}

/**
 * Sorts by the line the row shows (r145: this season's, or last season's when
 * there's nothing yet — spring, a free agent — it used to sort this season's
 * zeros, so only Rating and Impact seemed to sort). The first tap shows the
 * best first (ERA: lowest); a second tap flips it. A row with no sample for the
 * column (no at-bats, no innings, no Impact) sorts last either way.
 */
function _sortPlayers(players, { col, dir }, impScores = {}, state = null) {
  const val = new Map(players.map(p => [p.id, _sortVal(_statsShown(p).p, col, impScores, state)]));
  return [...players].sort((a, b) => {
    const va = val.get(a.id), vb = val.get(b.id);
    if (va == null || vb == null) return (va == null) - (vb == null);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (vb - va);
    return dir === 'asc' ? -cmp : cmp;
  });
}

function _sortVal(player, col, impScores = {}, state = null) {
  const s = player.stats || {};
  const ab = s.ab || 0, ip = s.outs ? s.outs / 3 : (s.ip || 0);
  if (['hab', 'avg', 'r', 'hr', 'rbi', 'sb'].includes(col) && !ab) return null;
  if (['ip', 'h_allowed', 'er', 'era', 'k', 'w', 'svhd', 'sv'].includes(col) && !ip) return null;
  if (col === 'bb' && !ab && !ip) return null;
  switch (col) {
    case 'ovr':  return player.ovr || 0;
    case 'hab':  return s.ab ? (s.h||0) / s.ab : 0; // sort by avg for H/AB
    case 'avg':  return s.ab ? (s.h||0) / s.ab : 0;
    case 'hr':   return s.hr  || 0;
    case 'rbi':  return s.rbi || 0;
    case 'r':    return s.r   || 0;
    case 'sb':   return s.sb  || 0;
    case 'h_allowed': return s.h_allowed || 0;
    case 'er':   return s.er  || 0;
    case 'era':  return -((s.er || 0) / ip * 9);   // lowest first
    case 'ip':   return s.outs ? s.outs/3 : s.ip || 0;
    case 'bb':   return s.bb   || 0;
    case 'svhd': return (s.sv || 0) + (s.hld || 0);
    case 'w':    return s.w    || s.wins || 0;
    case 'k':    return s.k    || 0;
    case 'sv':   return s.sv   || 0;
    case 'imp':  return impScores[player.id]?.impS ?? lastSeasonIMP(player) ?? null;   // no sample sorts last
    // §122.7 the market sort: cheapest first
    case 'price': return -(player.group === 'freeAgent' && state ? (FreeAgency.termsFor(state, player).salary || 0) : (player.contractSalary || 0));
    case 'name': return player.name || '';
    default:     return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Tab switching
  for (const [id, tab] of [['ltab-players','players'],['ltab-teams','teams'],['ltab-standings','standings'],['ltab-moves','moves'],['ltab-playoffs','playoffs']]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { _activeTab = tab; refresh(); });
  }
  for (const btn of document.querySelectorAll('[data-wire]')) {
    btn.addEventListener('click', () => { _wireFilter = btn.dataset.wire; refresh(); });
  }
  if (_activeTab === 'playoffs') {
    import('./PlayoffScreen.js').then(P => P.refresh());
    return;
  }

  // r146 Teams and Standings: tap a team → its sheet (these used to sit below the
  // players-only return, so a tap did nothing).
  const openTeam = (teamId) => {
    if (!teamId) return;
    const s = StateManager.get();
    const team = teamId === 'user' ? s.userTeam : (s.leagueTeams || []).find(t => t.id === teamId);
    if (team) _openLeagueTeamModal(team, s);
  };
  document.querySelectorAll('.lgt-card[data-team]').forEach(el => el.addEventListener('click', () => openTeam(el.dataset.team)));
  document.querySelectorAll('.lg-stand-row[data-team-id], .standing-row[data-team-id]').forEach(el => el.addEventListener('click', () => openTeam(el.dataset.teamId)));

  if (_activeTab !== 'players') return;

  document.getElementById('lp-more-btn')?.addEventListener('click', () => { _rowLimit += 100; refresh(); });

  // Reset button — clears all filters, search, and sort back to defaults
  document.getElementById('lp-reset-btn')?.addEventListener('click', () => {
    App.playClick();
    _playerFilter = { pos: 'batters', view: 'available', team: 'all', health: 'all' };
    _playerSort   = { col: 'ovr', dir: 'desc' };
    _lpSearch     = '';
    refresh();
  });

  // Position filter buttons
  document.querySelectorAll('.lp-pos-btn[data-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.playClick();
      _playerFilter.pos = btn.dataset.pos;
      refresh();
    });
  });

  // §122.7 Filter / Team / Health / Sort
  const sel = (id, fn) => document.getElementById(id)?.addEventListener('change', (e) => { fn(e.target.value); refresh(); });
  sel('lp-view-select',   (v) => { _playerFilter.view = v; if (!['available', 'waivers', 'fa'].includes(v) && _playerSort.col === 'price') _playerSort = { col: 'ovr', dir: 'desc' }; });
  sel('lp-team-select',   (v) => { _playerFilter.team = v; });
  sel('lp-health-select', (v) => { _playerFilter.health = v; });

  // Add from the row: sign a free agent, claim off waivers, or withdraw our claim (the sign sheet asks who goes when full)
  document.querySelectorAll('.lp-add-btn[data-add]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      App.playClick();
      openSignSheet(btn.dataset.add, btn.dataset.kind);
    });
  });

  // Search input — key fix: save cursor position, refresh, restore focus+cursor
  // This prevents the "type one letter then lose focus" bug caused by DOM re-render.
  const search = document.getElementById('lp-search');
  if (search) {
    search.addEventListener('input', () => {
      _lpSearch = search.value;
      const cursorPos = search.selectionStart;
      refresh();
      // After refresh the input was replaced — re-find and restore focus
      const newSearch = document.getElementById('lp-search');
      if (newSearch) {
        newSearch.focus();
        try { newSearch.setSelectionRange(cursorPos, cursorPos); } catch(_) {}
      }
    });
  }

  // Sort column headers — clicking same column toggles asc/desc, no arrows shown
  document.querySelectorAll('.lp-th[data-sort]').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.sort;
      if (_playerSort.col === col) {
        _playerSort.dir = _playerSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        _playerSort = { col, dir: 'desc' };
      }
      refresh();
    });
  });

  // Player row tap → PlayerCard
  document.querySelectorAll('[data-player]').forEach(el => {
    el.addEventListener('click', () => {
      const playerId = el.dataset.player;
      if (playerId) openPlayerCard(playerId, StateManager.get());
    });
  });

}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _buildTeamList(userTeam, leagueTeams, standings) {
  const all = [];

  if (userTeam) {
    all.push({
      id:         'user',
      name:       `${userTeam.city || ''} ${userTeam.nickname || ''}`.trim(),
      abbr:       userTeam.abbr || 'YOU',
      divisionId: userTeam.divisionId || 'A',
      wins:       userTeam.wins   || 0,
      losses:     userTeam.losses || 0,
      streak:     userTeam.streak || 0,
    });
  }

  for (const team of leagueTeams) {
    all.push({
      id:         team.id,
      name:       team.name  || team.id,
      abbr:       team.abbr  || team.id?.slice(0,3).toUpperCase(),
      divisionId: team.divisionId || 'B',
      wins:       team.wins   || 0,
      losses:     team.losses || 0,
      streak:     team.streak || 0,
    });
  }

  return all;
}

// ─────────────────────────────────────────────────────────────
// TEAM DETAIL MODAL
// ─────────────────────────────────────────────────────────────

/**
 * r146 a club's sheet (League → Teams or Standings): where it stands (place,
 * record, games back, streak), its rating and payroll, and the roster the way
 * a lineup card reads — the lineup by position, the rotation in order, the
 * bullpen, the bench, the injured list — each with its line (this season's,
 * or last season's before there is one). A row opens the player's card.
 */
function _openLeagueTeamModal(team, state) {
  document.getElementById('league-team-modal')?.remove();
  const players = state.players || {};
  const isUser  = team === state.userTeam || team.id === 'user' || !team.id;
  const id      = isUser ? 'user' : team.id;
  const name    = isUser ? `${team.city || ''} ${team.nickname || ''}`.trim() : (team.name || team.abbr || '?');
  const P       = (pid) => players[pid];
  const roster  = (team.rosterIds || []).map(P).filter(Boolean);

  // Where it stands.
  const st = state.standings || {};
  const div = [...(st.divA || []), ...(st.divB || [])].some(e => e.id === id)
    ? ((st.divA || []).some(e => e.id === id) ? st.divA : st.divB) : null;
  const place = div ? div.findIndex(e => e.id === id) : -1;
  const entry = place >= 0 ? div[place] : null;
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const gp = (team.wins || 0) + (team.losses || 0);
  const standLine = [
    entry ? `${ord(place + 1)} in Division ${team.divisionId || entry.divisionId || ''}`.trim() : '',
    entry && place > 0 ? `${formatGB(entry.gb)} GB` : '',
    team.streak ? `Streak ${formatStreak(team.streak)}` : '',
  ].filter(Boolean).join(' · ');
  let rating = null, payroll = null;
  try { rating = Roster.teamRating(state, id); } catch { /* not rated */ }
  try { payroll = Finance.payrollOf(state, id); } catch { /* no books */ }

  // The roster, as a lineup card reads.
  const used = new Set();
  const take = (p) => { if (p && !used.has(p.id)) { used.add(p.id); return p; } return null; };
  const injured = roster.filter(p => p.isInjured || p.group === 'il').map(take).filter(Boolean);
  const lineup = (team.lineupSlots || []).map(sl => ({ slot: sl.slot, p: take(P(sl.playerId)) })).filter(x => x.p);
  const rotation = (team.rotation?.order || []).map(pid => take(P(pid))).filter(Boolean);
  const bullpen = roster.filter(p => p.pos === 'RP' || p.pos === 'SP').filter(p => !used.has(p.id)).sort((a, b) => b.ovr - a.ovr).map(take).filter(Boolean);
  const bench = roster.filter(p => !used.has(p.id)).sort((a, b) => b.ovr - a.ovr).map(take).filter(Boolean);

  const line = (p) => {
    const sh = _statsShown(p), x = sh.p.stats || {}, ly = sh.year ? ` <span class="ltm-ly">'${String(sh.year).slice(-2)}</span>` : '';
    if (['SP', 'RP'].includes(p.pos)) {
      const ip = x.outs ? x.outs / 3 : (x.ip || 0);
      return ip ? `${formatERA(x.er || 0, ip)} ERA · ${Math.floor(ip)} IP${ly}` : 'No innings yet';
    }
    return x.ab ? `${formatAVG(x.h || 0, x.ab)} · ${x.hr || 0} HR${ly}` : 'No at-bats yet';
  };
  const row = (p, tag) => `
    <button class="ltm-row" data-player-id="${p.id}">
      <span class="ltm-tag">${_escape(tag)}</span>
      <span class="ltm-name">${_escape(p.name)}${p.injury?.status === 'dtd' ? ' <span class="lp-dtd">DTD</span>' : ''}</span>
      <span class="ltm-line">${line(p)}</span>
      <span class="ltm-ovr">${p.ovr}</span>
    </button>`;
  const section = (label, rows) => rows.length ? `<div class="ltm-head">${label}</div>${rows.join('')}` : '';

  const overlay = document.createElement('div');
  overlay.id = 'league-team-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:88dvh;display:flex;flex-direction:column;">
      <div class="modal-handle" style="flex-shrink:0;"></div>
      <div class="modal-header" style="flex-shrink:0;">
        <div style="min-width:0;">
          <div class="modal-title">${_escape(name)}</div>
          <div class="ltm-sub">${formatRecord(team.wins || 0, team.losses || 0)}${gp ? ` (${((team.wins || 0) / gp).toFixed(3).replace(/^0/, '')})` : ''}${standLine ? ` · ${standLine}` : ''}${isUser ? ' · <b>Your team</b>' : ''}</div>
        </div>
        <button class="modal-close" id="league-team-close">×</button>
      </div>
      <div class="ltm-stats">
        ${rating != null ? `<div><div class="ltm-k">Team rating</div><div class="ltm-v">${rating}</div></div>` : ''}
        ${payroll != null ? `<div><div class="ltm-k">Payroll</div><div class="ltm-v">${_money(payroll)}</div></div>` : ''}
        <div><div class="ltm-k">Roster</div><div class="ltm-v">${roster.length}</div></div>
      </div>
      <div class="modal-divider" style="flex-shrink:0;"></div>
      <div style="overflow-y:auto;flex:1;padding-bottom:max(16px,env(safe-area-inset-bottom));">
        ${section('Lineup', lineup.map(x => row(x.p, x.slot)))}
        ${section('Rotation', rotation.map((p, i) => row(p, `SP${i + 1}`)))}
        ${section('Bullpen', bullpen.map(p => row(p, p.pos)))}
        ${section('Bench', bench.map(p => row(p, p.nativePos || p.pos)))}
        ${section('Injured', injured.map(p => row(p, p.nativePos || p.pos)))}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('#league-team-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll('.ltm-row[data-player-id]').forEach(r => {
    r.addEventListener('click', (e) => { e.stopPropagation(); openPlayerCard(r.dataset.playerId, StateManager.get()); });
  });
}

/** §96 a waived player's line: the claim window, and our claim if it's in. */
function _waiverTag(p) {
  const left = Math.max(0, FreeAgency.waiverEndsAt(p) - Date.now());
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  return `Waivers · ${h ? `${h}h` : `${m}m`} left${p._userClaim ? ' · claim in' : ''}`;
}

function _teamAbbr(teamId, state) {
  if (!teamId) return '?';
  if (teamId === 'user') return state.userTeam?.abbr || 'YOU';
  const team = (state.leagueTeams || []).find(t => t.id === teamId);
  return team?.abbr || teamId?.slice(0,3).toUpperCase() || '?';
}

function _activityIcon(type) {
  const map = {
    trade: '🔄', injury: '🏥', promotion: '⬆️', demotion: '⬇️',
    signing: '✍️', release: '👋', milestone: '🏆', win: '✅',
    loss: '❌', waiver: '📋', standings: '📊', weather: '⛈️',
  };
  return map[type] || '•';
}

function _feedTime(entry, state) {
  const diff = (state.currentGameIndex || 0) - (entry.gameIndex || 0);
  if (diff === 0) return 'Today';
  if (diff === 1) return '1g ago';
  return `${diff}g ago`;
}

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
    /* Stat leaders */
    .stat-leaders-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    .stat-leader-cat{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
    .slc-label{font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;
      padding:6px 10px 4px;color:var(--muted);background:var(--surface2);border-bottom:1px solid var(--border);}
    .stat-leader-row{display:flex;align-items:center;gap:6px;padding:5px 10px;
      border-bottom:1px solid var(--border);font-size:12px;}
    .stat-leader-row:last-child{border-bottom:none;}
    .stat-leader-row.user-player{background:var(--chip-accent-bg);}
    .slr-rank{font-size:10px;color:var(--muted);width:12px;flex-shrink:0;font-family:'DM Mono',monospace;}
    .slr-name{flex:1;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .slr-team{font-size:10px;color:var(--muted);flex-shrink:0;width:24px;text-align:center;}
    .slr-stat{font-family:'DM Mono',monospace;font-size:12px;font-weight:700;color:var(--text);
      flex-shrink:0;min-width:32px;text-align:right;}

    /* Position filter bar — 2 rows */
    .lp-pos-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:6px 10px 5px;}
    .lp-pos-row1{display:flex;gap:4px;margin-bottom:5px;}
    .lp-pos-row2{display:flex;flex-wrap:nowrap;gap:3px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;}
    .lp-pos-row2::-webkit-scrollbar{display:none;}
    .lp-pos-btn{font-size:10px;font-weight:700;letter-spacing:.3px;padding:4px 8px;
      border-radius:6px;border:1px solid var(--border);background:transparent;
      color:var(--muted);cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;flex-shrink:0;}
    .lp-pos-btn.active{background:var(--chip-accent-bg);border-color:var(--accent);color:var(--text);}
    .lp-pos-btn:active{opacity:.7;}
    .lp-sep{color:var(--border);font-size:13px;line-height:1;align-self:center;margin:0 1px;flex-shrink:0;}

    /* Roster filter bar */
    .lp-roster-bar{display:flex;align-items:center;gap:5px;padding:5px 10px;
      background:var(--surface2);border-bottom:1px solid var(--border);}
    .lp-roster-btn{font-size:10px;font-weight:700;padding:4px 7px;border-radius:6px;
      border:1px solid var(--border);background:transparent;color:var(--muted);
      cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;flex-shrink:0;}
    .lp-roster-btn.active{background:var(--chip-accent-bg);border-color:var(--accent);color:var(--text);}
    .lp-team-select{width:130px;flex-shrink:0;font-size:11px;font-weight:500;
      background:var(--surface);border:1px solid var(--border);border-radius:7px;
      color:var(--text);padding:4px 6px;font-family:'DM Sans',sans-serif;outline:none;}
    .lp-search-input{width:90px;flex-shrink:0;padding:4px 8px;border-radius:7px;
      border:1px solid var(--border);background:var(--surface);color:var(--text);
      font-size:11px;font-family:'DM Sans',sans-serif;outline:none;box-sizing:border-box;}
    .lp-reset-btn{flex-shrink:0;width:28px;height:28px;border-radius:7px;
      border:1px solid var(--border);background:transparent;color:var(--muted);
      font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;
      font-family:'DM Sans',sans-serif;padding:0;}
    .lp-reset-btn:active{opacity:.6;}

    /* Horizontal scroll wrapper — name col sticks left, stats scroll right */
    .lp-tab-wrap{display:block;}
    .lp-sticky-header{position:sticky;top:0;z-index:10;background:var(--bg);}
    .lp-scroll-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}
    .lp-scroll-wrap::-webkit-scrollbar{height:3px;}
    .lp-scroll-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px;}

    /* Header and rows — flex with same widths so columns align */
    .lp-header{display:flex;align-items:center;border-bottom:2px solid var(--border);
      background:var(--surface2);min-width:max-content;}
    .lp-row{display:flex;align-items:center;border-bottom:1px solid var(--border);
      cursor:pointer;min-width:max-content;}
    .lp-row:active{background:var(--surface2);}

    /* Sticky name column — ONE width rule for the heading and every row, so
       the heading always sits over its column (§93). */
    .lp-col-sticky,.lp-td-name{
      position:sticky;left:0;
      width:120px;min-width:120px;max-width:120px;flex-shrink:0;
      padding-left:8px;padding-right:8px;text-align:left;overflow:hidden;
    }
    .lp-col-sticky{z-index:3;background:var(--surface2);padding-top:5px;padding-bottom:5px;}
    .lp-td-name{z-index:2;background:var(--bg);padding-top:7px;padding-bottom:7px;}
    /* our players' tint over a solid fill, so stats scrolling under the frozen name never show through */
    .user-player-row .lp-td-name{background:linear-gradient(var(--chip-accent-bg),var(--chip-accent-bg)),var(--bg);}

    /* Player name text — 12px matching the previous fix */
    .lp-name-line{font-size:12px;font-weight:600;color:var(--text);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .lp-name-sub{font-size:10px;color:var(--muted);margin-top:1px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

    /* Column headings: the same lettering for the name and the stats */
    .lp-th,.lp-th-name{font-size:9px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;
      color:var(--muted);white-space:nowrap;}
    /* Stat column headers — uniform 38px, text centered */
    .lp-th{width:38px;min-width:38px;flex-shrink:0;text-align:center;padding:5px 2px;cursor:pointer;}
    .lp-th:active{opacity:.7;}
    .lp-th-active{color:var(--text);}

    /* Stat cells — match header widths exactly */
    .lp-td{width:38px;min-width:38px;flex-shrink:0;text-align:center;
      padding:8px 2px;font-size:11px;color:var(--soft);}

    /* H/AB needs extra width for two numbers */
    .lp-td-hab,.lp-th-hab{width:46px;min-width:46px;}

    /* IMP badge column */
    .lp-td-imp{width:44px;min-width:44px;}
    .lp-imp{font-size:10px;font-weight:800;padding:2px 4px;border-radius:4px;
      letter-spacing:.2px;white-space:nowrap;}
    .lp-imp-pos{color:var(--text);background:rgba(52,201,122,.12);}
    .lp-imp-neg{color:var(--danger);background:rgba(240,82,82,.12);}
    .lp-imp-neu{color:var(--muted);background:transparent;}

    /* IMP badge */
    .lp-imp{font-size:10px;font-weight:800;padding:2px 4px;border-radius:4px;
      letter-spacing:.2px;white-space:nowrap;}
    .lp-imp-pos{color:var(--text);background:rgba(52,201,122,.12);}
    .lp-imp-neg{color:var(--danger);background:rgba(240,82,82,.12);}
    .lp-imp-neu{color:var(--muted);background:transparent;}

    /* §90 Moves (the League wire) — text only */
    .lw-bar{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface);}
    .lw-chip{font-size:11px;font-weight:700;padding:5px 10px;border-radius:7px;border:1px solid var(--border);
      background:transparent;color:var(--muted);cursor:pointer;font-family:'DM Sans',sans-serif;}
    .lw-chip.active{background:var(--chip-accent-bg);border-color:var(--accent);color:var(--text);}
    .lw-day{padding:12px 16px 5px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);}
    .lw-row{padding:9px 16px;border-top:1px solid var(--border);background:var(--surface);}
    .lw-row.lw-ours{background:var(--chip-accent-bg);}
    .lw-kind{font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}
    .lw-text{font-size:13px;line-height:1.4;color:var(--text);}
    /* §122.7 filters, the market columns, add from the row, Impact leaders */
    .lp-sel{flex:1 1 0;min-width:0;font-size:11px;font-weight:600;padding:5px 6px;border-radius:7px;
      border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:inherit;}
    .lp-search-input{flex:1 1 auto;width:auto;}
    .lp-reset-btn{width:auto;padding:0 10px;font-size:11px;font-weight:700;}
    .lp-td-add{width:52px;min-width:52px;}
    .lp-td-mkt{width:52px;min-width:52px;font-size:11px;}
    .lp-add-btn{font-size:10px;font-weight:800;padding:4px 6px;border-radius:6px;border:1px solid var(--text);
      background:var(--text);color:var(--bg);font-family:inherit;cursor:pointer;}
    .lp-add-btn.on{background:transparent;color:var(--text);}
    .lp-dtd{color:#fbbf24;font-weight:700;}
    .lp-more-btn{display:block;margin:10px auto 14px;padding:9px 16px;font:inherit;font-size:13px;font-weight:700;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:10px;cursor:pointer;}
    .lp-more-btn span{font-weight:500;color:var(--muted);font-size:11px;}
    .ltm-sub{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.4;}
    .ltm-sub b{color:var(--text);font-weight:700;}
    .ltm-stats{display:flex;gap:22px;padding:0 20px 12px;flex-shrink:0;}
    .ltm-k{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);}
    .ltm-v{font-size:17px;font-weight:800;color:var(--text);margin-top:1px;}
    .ltm-head{padding:8px 20px 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);background:var(--surface2);}
    .ltm-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 20px;border:0;border-bottom:1px solid var(--border);background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;}
    .ltm-row:active{background:var(--surface2);}
    .ltm-tag{width:30px;flex-shrink:0;font-size:10px;font-weight:700;color:var(--muted);}
    .ltm-name{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ltm-line{font-size:11px;color:var(--soft);white-space:nowrap;}
    .ltm-ly{color:var(--muted);font-size:10px;}
    .ltm-ovr{width:24px;text-align:right;font-size:13px;font-weight:800;color:var(--text);}
    .lp-wv-left{font-size:10px;font-weight:700;color:var(--muted);margin-left:3px;} .lp-il{color:var(--danger);font-weight:700;}
    .lp-lyline{color:var(--soft);}
    .lp-ly{font-size:8px;font-weight:700;margin-left:2px;opacity:.75;}
    .lp-leaders{margin:8px 10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);}
    .lp-lead-head{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
    .lp-lead-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
    .lp-lead-title{font-size:11px;font-weight:700;color:var(--text);margin-bottom:2px;}
    .lp-lead-row{display:flex;justify-content:space-between;gap:4px;font-size:11px;color:var(--text);padding:2px 0;cursor:pointer;min-width:0;}
    .lp-lead-row > span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .lp-lead-tm{color:var(--muted);font-size:10px;}
    .lp-lead-v{font-weight:800;}
    .lw-empty{padding:28px 20px;font-size:13px;line-height:1.5;color:var(--muted);text-align:center;}

    /* Clickable team cards */
    .lgt-card{cursor:pointer;}
    .lgt-card:active{opacity:.8;}
  `;
  document.head.appendChild(style);
}
