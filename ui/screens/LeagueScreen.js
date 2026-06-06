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
let _playerFilter = { pos: 'all', team: 'all' };
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

  // Gather all active roster players
  let allPlayers = [
    ...(state.userTeam?.rosterIds || []),
    ...(state.leagueTeams || []).flatMap(t => t.rosterIds || []),
  ]
    .map(id => players[id])
    .filter(Boolean);

  // Apply search filter (last name)
  if (_lpSearch.trim()) {
    const q = _lpSearch.trim().toLowerCase();
    allPlayers = allPlayers.filter(p => {
      const lastName = (p.name || '').split(' ').pop().toLowerCase();
      return lastName.includes(q);
    });
  }

  // Apply position filter
  if (_playerFilter.pos !== 'all') {
    const isPitcher = _playerFilter.pos === 'P';
    allPlayers = allPlayers.filter(p =>
      isPitcher ? ['SP','RP'].includes(p.pos) : !['SP','RP'].includes(p.pos)
    );
  }

  // Apply team filter
  if (_playerFilter.team !== 'all') {
    allPlayers = allPlayers.filter(p =>
      _playerFilter.team === 'user' ? userRosterIds.has(p.id) : p.teamId === _playerFilter.team
    );
  }

  // Sort
  allPlayers = _sortPlayers(allPlayers, _playerSort);

  // Column headers
  const cols  = _getPlayerCols(_playerFilter.pos);
  const heads = cols.map(c => `
    <div class="lp-th ${c.key === _playerSort.col ? 'lp-th-active' : ''} ${c.key === 'name' ? 'lp-th-name' : ''}"
      data-sort="${c.key}">${c.label}${c.key === _playerSort.col ? (_playerSort.dir === 'asc' ? '↑' : '↓') : ''}
    </div>
  `).join('');

  const rows = allPlayers.slice(0, 100).map(p => {
    const isUser    = userRosterIds.has(p.id);
    const imp       = impScores[p.id];
    // Show hot/cold for all players — gating to own-roster is a future
    // monetization decision, not a build-time restriction (Section 28.8)
    const indicator = getHotColdIndicator(imp);
    const statVals  = cols.slice(2).map(c => `<div class="lp-td">${_playerStatVal(p, c.key)}</div>`).join('');
    const teamAbbr  = p.teamId === 'user' ? (state.userTeam?.abbr || 'YOU') : _teamAbbr(p.teamId, state);

    return `
      <div class="lp-row ${isUser ? 'user-player-row' : ''}" data-player="${p.id}">
        <div class="lp-td-name">
          ${_escape(p.name)}
          ${indicator ? `<span style="font-size:11px;margin-left:2px;">${indicator}</span>` : ''}
        </div>
        <div class="lp-td lp-td-tm">${_escape(teamAbbr)}</div>
        ${statVals}
      </div>
    `;
  }).join('');

  // Filter chips
  const posChips = [
    { val: 'all', label: 'All' },
    { val: 'H',   label: 'Hitters' },
    { val: 'P',   label: 'Pitchers' },
  ].map(c => `
    <div class="lp-chip ${_playerFilter.pos === c.val ? 'lp-chip-active' : ''}" data-pos="${c.val}">${c.label}</div>
  `).join('');

  // Per-team chips — user team + all league teams
  const leagueTeams  = state.leagueTeams || [];
  const teamChipData = [
    { val: 'all',  label: 'All' },
    { val: 'user', label: state.userTeam?.abbr || 'My Team' },
    ...leagueTeams.map(t => ({ val: t.id, label: t.abbr || t.name?.slice(0,3).toUpperCase() || '?' })),
  ];
  const teamChips = teamChipData.map(c => `
    <div class="lp-chip lp-chip-sm ${_playerFilter.team === c.val ? 'lp-chip-active' : ''}" data-team="${c.val}">${_escape(c.label)}</div>
  `).join('');

  return `
    <div id="lp-filter-wrap" class="lp-tab-wrap active" style="display:flex;flex-direction:column;">
      <div class="lp-filter-bar">
        <div class="lp-filter-row">
          ${posChips}
          <input id="lp-search" type="search" placeholder="Last Name" value="${_escape(_lpSearch)}"
            style="margin-left:auto;width:90px;padding:3px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:12px;box-sizing:border-box;outline:none;">
        </div>
        <div class="lp-filter-row" style="flex-wrap:wrap;gap:4px;">${teamChips}</div>
      </div>
      <div class="lp-header">
        <div class="lp-th lp-th-name">Player</div>
        <div class="lp-th" style="width:36px;">Tm</div>
        ${heads.replace(/<div class="lp-th [^"]*lp-th-name[^"]*"[^>]*>.*?<\/div>/s, '')}
      </div>
      <div id="lp-list" style="flex:1;overflow-y:auto;">${rows}</div>
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
    case 'sb':   return String(s.sb  || 0);
    case 'era':  return s.ip ? ((s.er/s.ip)*9).toFixed(2) : '—';
    case 'w':    return String(s.w   || 0);
    case 'k':    return String(s.k   || 0);
    case 'sv':   return String(s.sv  || 0);
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
    case 'sb':   return s.sb  || 0;
    case 'era':  return s.ip  ? (s.er/s.ip)*9 : 99;
    case 'w':    return s.w   || 0;
    case 'k':    return s.k   || 0;
    case 'sv':   return s.sv  || 0;
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

  // Players tab — player row tap → PlayerCard modal
  document.querySelectorAll('[data-player]').forEach(el => {
    el.addEventListener('click', () => {
      const playerId = el.dataset.player;
      if (playerId) openPlayerCard(playerId, StateManager.get());
    });
  });

  // Players tab — search input (live, rows only)
  const searchInput = document.getElementById('lp-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _lpSearch = searchInput.value || '';
      refresh();
    });
  }

  // Players tab — position filter chips
  document.querySelectorAll('[data-pos]').forEach(el => {
    el.addEventListener('click', () => {
      _playerFilter.pos = el.dataset.pos;
      _playerSort = { col: el.dataset.pos === 'P' ? 'era' : 'ovr', dir: el.dataset.pos === 'P' ? 'asc' : 'desc' };
      refresh();
    });
  });

  // Players tab — team filter chips
  document.querySelectorAll('[data-team]').forEach(el => {
    el.addEventListener('click', () => {
      _playerFilter.team = el.dataset.team;
      refresh();
    });
  });

  // Players tab — column sort
  document.querySelectorAll('[data-sort]').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.sort;
      if (!col || col === 'name' || col === 'team') return;
      if (_playerSort.col === col) {
        _playerSort.dir = _playerSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        _playerSort.col = col;
        _playerSort.dir = col === 'era' ? 'asc' : 'desc';
      }
      refresh();
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
    /* Player list */
    .user-player-row{background:var(--chip-accent-bg);}
    .lp-td-tm{width:36px;text-align:center;font-size:11px;color:var(--muted);}
    /* Small team chips */
    .lp-chip-sm{font-size:10px;padding:3px 7px;}
    /* Clickable team cards */
    .lgt-card{cursor:pointer;}
    .lgt-card:active{opacity:.8;}
  `;
  document.head.appendChild(style);
}
