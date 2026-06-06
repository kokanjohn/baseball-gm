/**
 * ui/screens/LeagueScreen.js
 * League tab rendered into #league-content.
 *
 * Three internal tabs (Section 1.14 — LOCKED):
 *   Players   — league-wide player list, filterable by pos/team, sortable by stat
 *   Teams     — all 10 teams grouped by division with record and streak
 *   Standings — division standings with W/L/GB + stat leaders (Section 28.7)
 *
 * Stat leaders (Section 28.7 — LOCKED):
 *   Batting: AVG, HR, RBI, SB
 *   Pitching: ERA, W, K, SV
 *   Top 5 per category. User's players highlighted.
 *
 * Activity feed (Section 28.5 — LOCKED):
 *   72-hour rolling feed shown at bottom of Standings tab.
 *   CPU farm is NOT browsable — only user's farm shown in TeamScreen.
 *
 * Hot/cold indicators shown on Players tab (own roster only on free tier).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getHotColdIndicator, getImpLeaderboard } from '../../engine/IMPEngine.js';
import {
  formatRecord, formatGB, formatOVR,
  formatERA, formatAVG, formatStreak,
} from '../formatters.js';
import { openPlayerCard } from '../components/PlayerCard.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab  = 'players';
let _mounted    = false;
let _listeners  = [];

// Players tab filter/sort state
let _playerFilter = { pos: 'batters', team: 'all', onRosters: false };
let _playerSort   = { col: 'ovr', dir: 'desc' };
let _lpSearch     = '';

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

  wire('game:committed',    () => { if (_activeTab === 'standings') refresh(); });
  wire('game:phaseChanged', () => refresh());
  wire('nav:tabActivated',  ({ tab }) => { if (tab === 'league') refresh(); });

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
        <div class="standing-row ${isUser ? 'player-row' : ''}" data-team-id="${entry.id}" style="${!isUser ? 'cursor:pointer;' : ''}">
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

  const hitters  = allPlayerIds.map(id => players[id]).filter(p => p && !['SP','RP'].includes(p.pos) && (p.stats?.ab || 0) >= 1);
  const pitchers = allPlayerIds.map(id => players[id]).filter(p => p && ['SP','RP'].includes(p.pos) && (p.stats?.ip || 0) >= 0.1);

  const top5 = (arr, sortFn) => arr.sort(sortFn).slice(0, 5);

  // Batting categories
  const avgLeaders = top5([...hitters], (a,b) => {
    const aAvg = a.stats.ab ? a.stats.h / a.stats.ab : 0;
    const bAvg = b.stats.ab ? b.stats.h / b.stats.ab : 0;
    return bAvg - aAvg;
  });
  const hrLeaders  = top5([...hitters], (a,b) => (b.stats.hr||0)  - (a.stats.hr||0));
  const rbiLeaders = top5([...hitters], (a,b) => (b.stats.rbi||0) - (a.stats.rbi||0));
  const sbLeaders  = top5([...hitters], (a,b) => (b.stats.sb||0)  - (a.stats.sb||0));

  // Pitching categories
  const eraLeaders = top5([...pitchers], (a,b) => {
    const aEra = a.stats.ip ? (a.stats.er / a.stats.ip) * 9 : 99;
    const bEra = b.stats.ip ? (b.stats.er / b.stats.ip) * 9 : 99;
    return aEra - bEra; // lower is better
  });
  const wLeaders   = top5([...pitchers], (a,b) => (b.stats.w||0)  - (a.stats.w||0));
  const kLeaders   = top5([...pitchers], (a,b) => (b.stats.k||0)  - (a.stats.k||0));
  const svLeaders  = top5([...pitchers], (a,b) => (b.stats.sv||0) - (a.stats.sv||0));

  const renderCategory = (label, players, statFn) => {
    if (players.length === 0) return '';
    const rows = players.map((p, i) => {
      const isUser = userRosterIds.has(p.id);
      return `
        <div class="stat-leader-row ${isUser ? 'user-player' : ''}">
          <span class="slr-rank">${i+1}</span>
          <span class="slr-name">${_escape(p.name.split(' ').pop())}</span>
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
      <div style="font-size:10px;color:var(--muted);margin-bottom:8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Batting</div>
      <div class="stat-leaders-grid">
        ${renderCategory('AVG', avgLeaders,  p => formatAVG(p.stats.h||0, p.stats.ab||0))}
        ${renderCategory('HR',  hrLeaders,   p => String(p.stats.hr||0))}
        ${renderCategory('RBI', rbiLeaders,  p => String(p.stats.rbi||0))}
        ${renderCategory('SB',  sbLeaders,   p => String(p.stats.sb||0))}
      </div>
      <div style="font-size:10px;color:var(--muted);margin:10px 0 8px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Pitching</div>
      <div class="stat-leaders-grid">
        ${renderCategory('ERA', eraLeaders, p => p.stats.ip ? ((p.stats.er/p.stats.ip)*9).toFixed(2) : '—')}
        ${renderCategory('W',   wLeaders,   p => String(p.stats.w||0))}
        ${renderCategory('K',   kLeaders,   p => String(p.stats.k||0))}
        ${renderCategory('SV',  svLeaders,  p => String(p.stats.sv||0))}
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

  // All active roster players
  let allPlayers = [
    ...(state.userTeam?.rosterIds || []),
    ...leagueTeams.flatMap(t => t.rosterIds || []),
  ]
    .map(id => players[id])
    .filter(Boolean);

  const isSearching = _lpSearch.trim().length > 0;

  // "Other Teams" = hide user's own players — bypassed when searching
  if (_playerFilter.onRosters && !isSearching) {
    allPlayers = allPlayers.filter(p => !userRosterIds.has(p.id));
  }

  // Search filter (last name) — always runs, no other filters apply when searching
  if (isSearching) {
    const q = _lpSearch.trim().toLowerCase();
    allPlayers = allPlayers.filter(p =>
      (p.name || '').split(' ').pop().toLowerCase().includes(q)
    );
  }

  // Position filter — bypassed when searching so cross-position search works
  const HITTER_POS  = ['C','1B','2B','3B','SS','OF','DH'];
  const PITCHER_POS = ['SP','RP'];
  const POS_FAMILY  = {
    '2B': ['2B','2B/SS'],
    '1B': ['1B','1B/3B'],
    'DH': ['DH','DH/OF'],
    'SS': ['SS','2B/SS'],
    '3B': ['3B','1B/3B'],
    'OF': ['OF','DH/OF'],
  };
  const pos = _playerFilter.pos;

  if (!isSearching) {
    if (pos === 'batters') {
      allPlayers = allPlayers.filter(p => !['SP','RP'].includes(p.pos));
    } else if (pos === 'pitchers') {
      allPlayers = allPlayers.filter(p => ['SP','RP'].includes(p.pos));
    } else if (pos !== 'all') {
      const family = POS_FAMILY[pos] || [pos];
      allPlayers = allPlayers.filter(p => family.includes(p.nativePos || p.pos));
    }
  }

  // Team filter
  if (_playerFilter.team === 'user') {
    allPlayers = allPlayers.filter(p => userRosterIds.has(p.id));
  } else if (_playerFilter.team !== 'all') {
    allPlayers = allPlayers.filter(p => p.teamId === _playerFilter.team);
  }

  allPlayers = _sortPlayers(allPlayers, _playerSort);

  const isPitcherView = pos === 'pitchers' || PITCHER_POS.includes(pos);

  // ── Filter UI (sticky) ────────────────────────────────────────
  const posBtn = (label, key) =>
    `<button class="lp-pos-btn ${_playerFilter.pos === key ? 'active' : ''}" data-pos="${key}">${label}</button>`;

  // Row 1: Batters | Pitchers
  // Row 2: position chips
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
    </div>
  `;

  // Roster bar: All | On Rosters | [team select] [search]
  const teamOptions = [
    `<option value="all"  ${_playerFilter.team === 'all'  ? 'selected' : ''}>All Teams</option>`,
    `<option value="user" ${_playerFilter.team === 'user' ? 'selected' : ''}>${_escape(state.userTeam?.abbr || 'My Team')}</option>`,
    ...leagueTeams.map(t =>
      `<option value="${t.id}" ${_playerFilter.team === t.id ? 'selected' : ''}>${_escape(t.name)}</option>`
    ),
  ].join('');

  const rosterFilterBar = `
    <div class="lp-roster-bar">
      <button class="lp-roster-btn ${!_playerFilter.onRosters ? 'active' : ''}" data-roster="all">All</button>
      <button class="lp-roster-btn ${_playerFilter.onRosters  ? 'active' : ''}" data-roster="on">Other Teams</button>
      <select class="lp-team-select" id="lp-team-select">${teamOptions}</select>
      <input id="lp-search" type="search" placeholder="Last name…" value="${_escape(_lpSearch)}"
        class="lp-search-input" autocomplete="off" autocorrect="off" spellcheck="false">
    </div>
  `;

  // Columns — IMP gets its own column
  const statCols = isPitcherView
    ? [{ key:'ovr',label:'RTG' },{ key:'era',label:'ERA' },{ key:'ip',label:'IP' },{ key:'k',label:'K' },{ key:'bb',label:'BB' },{ key:'svhd',label:'SVHD' }]
    : [{ key:'ovr',label:'RTG' },{ key:'avg',label:'AVG' },{ key:'hr',label:'HR' },{ key:'rbi',label:'RBI' },{ key:'r',label:'R' },{ key:'sb',label:'SB' }];

  const allCols = [{ key:'imp7', label:'IMP' }, ...statCols];

  const heads = allCols.map(c => {
    const isActive = c.key === _playerSort.col;
    // No arrows — just highlight the active column
    return `<div class="lp-th ${isActive ? 'lp-th-active' : ''}" data-sort="${c.key}">${c.label}</div>`;
  }).join('');

  const rows = allPlayers.slice(0, 100).map(p => {
    const isUser    = userRosterIds.has(p.id);
    const imp       = impScores[p.id];
    const indicator = getHotColdIndicator(imp);
    const imp7      = imp?.imp7;
    const impCell   = imp7 != null
      ? `<span class="lp-imp ${imp7 > 0 ? 'lp-imp-pos' : imp7 < 0 ? 'lp-imp-neg' : 'lp-imp-neu'}">${imp7 > 0 ? '+' : ''}${imp7.toFixed(1)}</span>`
      : `<span class="lp-imp lp-imp-neu">—</span>`;
    const teamAbbr  = p.teamId === 'user' ? (state.userTeam?.abbr || 'YOU') : _teamAbbr(p.teamId, state);
    const statVals  = statCols.map(c => `<div class="lp-td">${_playerStatVal(p, c.key)}</div>`).join('');

    return `
      <div class="lp-row ${isUser ? 'user-player-row' : ''}" data-player="${p.id}">
        <div class="lp-td-name">
          <div class="lp-name-line">
            ${_escape(p.name)}
            ${indicator ? `<span class="lp-hot">${indicator}</span>` : ''}
          </div>
          <div class="lp-name-sub">${_escape(teamAbbr)} · ${p.nativePos || p.pos}</div>
        </div>
        <div class="lp-td lp-td-imp">${impCell}</div>
        ${statVals}
      </div>
    `;
  }).join('');

  return `
    <div id="lp-filter-wrap" class="lp-tab-wrap active">
      <div class="lp-sticky-header">
        ${filterBar}
        ${rosterFilterBar}
        <div class="lp-header">
          <div class="lp-th lp-th-name">Player</div>
          ${heads}
        </div>
      </div>
      <div id="lp-list">${rows}</div>
      ${allPlayers.length > 100 ? `<div style="padding:8px 16px;font-size:11px;color:var(--muted);">Showing 100 of ${allPlayers.length}</div>` : ''}
    </div>
  `;
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
    case 'avg':  return s.ab ? formatAVG(s.h||0, s.ab||0) : '.---';
    case 'hr':   return String(s.hr  || 0);
    case 'rbi':  return String(s.rbi || 0);
    case 'r':    return String(s.r   || 0);
    case 'sb':   return String(s.sb  || 0);
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
    case 'svhd': return String((s.sv || 0) + (s.hd || 0));
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

function _sortPlayers(players, { col, dir }) {
  return [...players].sort((a, b) => {
    let va = _sortVal(a, col);
    let vb = _sortVal(b, col);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (vb - va);
    return dir === 'asc' ? -cmp : cmp;
  });
}

function _sortVal(player, col) {
  const s = player.stats || {};
  switch (col) {
    case 'ovr':  return player.ovr || 0;
    case 'avg':  return s.ab ? (s.h||0) / s.ab : 0;
    case 'hr':   return s.hr  || 0;
    case 'rbi':  return s.rbi || 0;
    case 'r':    return s.r   || 0;
    case 'sb':   return s.sb  || 0;
    case 'era':  return s.outs > 0 ? (s.er||0)/(s.outs/3)*9 : s.ip ? (s.er||0)/s.ip*9 : 99;
    case 'ip':   return s.outs ? s.outs/3 : s.ip || 0;
    case 'bb':   return s.bb   || 0;
    case 'svhd': return (s.sv || 0) + (s.hd || 0);
    case 'w':    return s.w    || s.wins || 0;
    case 'k':    return s.k    || 0;
    case 'sv':   return s.sv   || 0;
    case 'imp7': return player._imp7  || 0;
    case 'name': return player.name || '';
    default:     return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Tab switching
  for (const [id, tab] of [['ltab-players','players'],['ltab-teams','teams'],['ltab-standings','standings']]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { _activeTab = tab; refresh(); });
  }

  if (_activeTab !== 'players') return;

  // Position filter buttons
  document.querySelectorAll('.lp-pos-btn[data-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.playClick();
      _playerFilter.pos = btn.dataset.pos;
      refresh();
    });
  });

  // All / Other Teams toggle
  document.querySelectorAll('.lp-roster-btn[data-roster]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.playClick();
      _playerFilter.onRosters = btn.dataset.roster === 'on';
      refresh();
    });
  });

  // Team dropdown
  const teamSel = document.getElementById('lp-team-select');
  if (teamSel) {
    teamSel.addEventListener('change', () => {
      _playerFilter.team = teamSel.value;
      refresh();
    });
  }

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

  // Teams tab — team card click → team detail modal
  document.querySelectorAll('.lgt-card[data-team]').forEach(el => {
    el.addEventListener('click', () => {
      const teamId = el.dataset.team;
      if (!teamId || teamId === 'user') return;
      const s = StateManager.get();
      const team = (s.leagueTeams || []).find(t => t.id === teamId);
      if (team) _openLeagueTeamModal(team, s);
    });
  });

  // Standings tab — standing row click → team detail modal
  document.querySelectorAll('.lg-stand-row[data-team-id]').forEach(el => {
    el.addEventListener('click', () => {
      const teamId = el.dataset.teamId;
      if (!teamId || teamId === 'user') return;
      const s = StateManager.get();
      const team = (s.leagueTeams || []).find(t => t.id === teamId);
      if (team) _openLeagueTeamModal(team, s);
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

function _openLeagueTeamModal(team, state) {
  document.getElementById('league-team-modal')?.remove();

  const rosterIds = team.rosterIds || [];
  const players   = state.players || {};
  const hitters   = rosterIds.map(id => players[id]).filter(p => p && !['SP','RP'].includes(p.pos)).sort((a,b) => b.ovr - a.ovr);
  const pitchers  = rosterIds.map(id => players[id]).filter(p => p && ['SP','RP'].includes(p.pos)).sort((a,b) => b.ovr - a.ovr);

  const playerRow = (p) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 20px;border-bottom:1px solid var(--border);">
      <span style="flex:1;font-size:14px;font-weight:600;">${_escape(p.name)}</span>
      <span style="font-size:12px;color:var(--muted);">${p.pos}</span>
      <span style="font-size:13px;font-weight:700;color:${p.ovr >= 75 ? 'var(--accent2)' : p.ovr >= 60 ? 'var(--text)' : 'var(--muted)'};">${p.ovr}</span>
    </div>`;

  const overlay = document.createElement('div');
  overlay.id = 'league-team-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:82dvh;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div>
          <div style="font-size:18px;font-weight:800;">${_escape(team.name || team.abbr || '?')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${team.wins || 0}–${team.losses || 0} · OVR ${Math.round(
            rosterIds.map(id => players[id]?.ovr || 0).reduce((a,b) => a+b, 0) / Math.max(1, rosterIds.length)
          )}</div>
        </div>
        <button class="modal-close" id="league-team-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div style="overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));">
        ${hitters.length > 0 ? '<div style="padding:8px 20px 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Hitters</div>' + hitters.map(playerRow).join('') : ''}
        ${pitchers.length > 0 ? '<div style="padding:8px 20px 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Pitchers</div>' + pitchers.map(playerRow).join('') : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.getElementById('league-team-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
    .lp-pos-btn.active{background:var(--chip-accent-bg);border-color:var(--accent);color:var(--accent);}
    .lp-pos-btn:active{opacity:.7;}
    .lp-sep{color:var(--border);font-size:13px;line-height:1;align-self:center;margin:0 1px;flex-shrink:0;}

    /* Roster filter bar */
    .lp-roster-bar{display:flex;align-items:center;gap:5px;padding:5px 10px;
      background:var(--surface2);border-bottom:1px solid var(--border);}
    .lp-roster-btn{font-size:10px;font-weight:700;padding:4px 7px;border-radius:6px;
      border:1px solid var(--border);background:transparent;color:var(--muted);
      cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;flex-shrink:0;}
    .lp-roster-btn.active{background:var(--chip-accent-bg);border-color:var(--accent);color:var(--accent);}
    .lp-team-select{width:130px;flex-shrink:0;font-size:11px;font-weight:500;
      background:var(--surface);border:1px solid var(--border);border-radius:7px;
      color:var(--text);padding:4px 6px;font-family:'DM Sans',sans-serif;outline:none;}
    .lp-search-input{width:90px;flex-shrink:0;padding:4px 8px;border-radius:7px;
      border:1px solid var(--border);background:var(--surface);color:var(--text);
      font-size:11px;font-family:'DM Sans',sans-serif;outline:none;box-sizing:border-box;}

    /* Sticky header — filter bars + column headers stay fixed, only list scrolls */
    .lp-tab-wrap{display:flex;flex-direction:column;height:100%;}
    .lp-sticky-header{position:sticky;top:0;z-index:10;background:var(--bg);}
    #lp-list{flex:1;overflow-y:auto;}

    /* Player rows */
    .user-player-row{background:var(--chip-accent-bg);}
    .lp-td-name{min-width:0;overflow:hidden;}
    .lp-name-line{font-size:12px;font-weight:600;color:var(--text);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .lp-name-sub{font-size:10px;color:var(--muted);margin-top:1px;white-space:nowrap;}
    .lp-hot{font-size:11px;margin-left:3px;}

    /* IMP column */
    .lp-td-imp{text-align:center;}
    .lp-imp{font-size:10px;font-weight:800;padding:2px 4px;border-radius:4px;
      letter-spacing:.2px;white-space:nowrap;}
    .lp-imp-pos{color:var(--accent2);background:rgba(52,201,122,.12);}
    .lp-imp-neg{color:var(--danger);background:rgba(240,82,82,.12);}
    .lp-imp-neu{color:var(--muted);background:transparent;}

    /* Clickable team cards */
    .lgt-card{cursor:pointer;}
    .lgt-card:active{opacity:.8;}
  `;
  document.head.appendChild(style);
}
