/**
 * ui/screens/TeamScreen.js
 * Team tab rendered into #team-content.
 *
 * Two internal tabs (Section 1.14 — LOCKED):
 *   Players — active roster + IL + pending transactions + farm system
 *   Staff   — coaching staff with contracts and relationships
 *
 * Roster sections (Section 20.3 — LOCKED order):
 *   ├── Hitters               (collapsible) — STARTING_HITTERS + BENCH_HITTERS
 *   ├── Pitchers              (collapsible) — STARTING_PITCHERS + BULLPEN + PITCHER_BENCH
 *   ├── Injured List          (collapsible) — IL group
 *   ├── Pending Transactions  (collapsible) — _pendingAcquisitions
 *   └── Farm System           (collapsible) — farmIds, split into Position Players + Pitchers
 *
 * Farm player row shows: name, pos, OVR, age, story arc indicator, send-down date.
 * Farm section is user-only — CPU farm is not browsable (Section 20.3).
 *
 * Swap buttons (promote/demote) apply roster mutations via RosterEngine.
 * Call-up from farm applies via RosterEngine.callUpFromFarm() lazy import.
 *
 * Screen label is "Team" not "Roster" (Section 1.14 — LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { getHotColdIndicator } from '../../engine/IMPEngine.js';
import { formatMoney, formatOVR, formatAge, formatSalary } from '../formatters.js';
import { PLAYER_GROUP } from '../../data/constants.js';
import { openPlayerCard } from '../components/PlayerCard.js';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab   = 'players';
let _mounted     = false;
let _listeners   = [];

// Track which collapsible groups are open
// Default: hitters open, pitchers open, others closed
const _groupOpen = {
  hitters:      false,
  pitchers:     false,
  il:           false,
  pending:      false,
  farm:         false,
};

// Track which farm sub-section is open
const _farmOpen = {
  hitters:  true,
  pitchers: true,
};

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('roster', () => refresh());

  _listeners.push(EventBus.on('roster:changed',    () => refresh()));
  _listeners.push(EventBus.on('game:committed',    () => refresh()));
  _listeners.push(EventBus.on('nav:tabActivated',  ({ tab }) => { if (tab === 'roster') refresh(); }));

  refresh();
}

export function unmount() {
  _listeners.forEach(([event, handler]) => EventBus.off(event, handler));
  _listeners = [];
  _mounted   = false;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

export function refresh() {
  const container = document.getElementById('team-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state?.userTeam) return;

  const team      = state.userTeam;
  const payroll   = team.finances?.payroll    || 0;
  const cap       = team.finances?.payrollCap || 22000;
  const capPct    = Math.min(100, Math.round((payroll / cap) * 100));
  const capColor  = capPct > 90 ? 'pf-red' : capPct > 75 ? '' : 'pf-green';

  container.innerHTML = `
    <div class="section-pad" style="padding-bottom:0;">
      <div class="roster-title-row">
        <div class="section-title">Team</div>
        <div class="roster-ratings-pair">
          <div class="roster-rating-card">
            <div class="rrc-label">Payroll</div>
            <div class="rrc-value" style="font-size:15px;margin-top:2px;">${formatMoney(payroll)}</div>
            <div class="rrc-sub">${formatMoney(cap)} cap</div>
          </div>
        </div>
      </div>
      <!-- Payroll bar -->
      <div class="progress-bar" style="margin-bottom:10px;">
        <div class="progress-fill ${capColor}" style="width:${capPct}%"></div>
      </div>

      <!-- Internal tabs -->
      <div class="team-subtabs">
        <button class="team-subtab ${_activeTab === 'players' ? 'active' : ''}" id="tsubtab-players">Players</button>
        <button class="team-subtab ${_activeTab === 'staff'   ? 'active' : ''}" id="tsubtab-staff">Staff</button>
      </div>
    </div>

    <div id="team-tab-body">
      ${_activeTab === 'players' ? _renderPlayers(state) : _renderStaff(state)}
    </div>
  `;

  _attachListeners(state);
}

// ─────────────────────────────────────────────────────────────
// PLAYERS TAB
// ─────────────────────────────────────────────────────────────

function _renderPlayers(state) {
  const team      = state.userTeam;
  const rosterIds = team.rosterIds || [];
  const farmIds   = team.farmIds   || [];
  const players   = state.players  || {};
  const impScores = state.impScores || {};
  const gameIdx   = state.currentGameIndex || 0;

  // Partition by group
  const hitters      = rosterIds.map(id => players[id]).filter(p => p && [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group));
  const pitchers     = rosterIds.map(id => players[id]).filter(p => p && [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group));
  const ilPlayers    = rosterIds.map(id => players[id]).filter(p => p && p.group === PLAYER_GROUP.IL);
  const farmPlayers  = farmIds.map(id => players[id]).filter(Boolean);
  const pending      = team._pendingAcquisitions || [];

  return `
    <div style="padding:0 0 16px;">
      ${_renderGroup('hitters',  'Hitters',              hitters.length,  _renderHitterGroup(hitters, impScores, gameIdx))}
      ${_renderGroup('pitchers', 'Pitchers',             pitchers.length, _renderPitcherGroup(pitchers, impScores, gameIdx))}
      ${_renderGroup('il',       'Injured List',         ilPlayers.length, _renderILGroup(ilPlayers, state, gameIdx))}
      ${_renderGroup('pending',  'Pending Transactions', pending.length,   _renderPendingGroup(pending, players))}
      ${_renderGroup('farm',     'Farm System',          farmPlayers.length, _renderFarmGroup(farmPlayers, state, gameIdx), true)}
    </div>
  `;
}

function _renderGroup(key, label, count, bodyHtml, isFarm = false) {
  const isOpen    = _groupOpen[key];
  const headClass = key === 'hitters' ? 'hitters'
                  : key === 'pitchers' ? 'pitchers'
                  : key === 'il' ? 'il-group'
                  : '';

  return `
    <div class="roster-group" id="rg-${key}">
      <div class="roster-group-head ${headClass}" data-group="${key}">
        <span>${label}</span>
        <span class="roster-group-head-right">
          <span class="roster-group-count">${count}</span>
          <span class="roster-chevron ${isOpen ? 'open' : ''}">▼</span>
        </span>
      </div>
      <div class="roster-group-body ${isOpen ? 'open' : ''}">
        ${isOpen ? bodyHtml : ''}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// HITTER GROUP
// ─────────────────────────────────────────────────────────────

function _renderHitterGroup(hitters, impScores, gameIdx) {
  if (hitters.length === 0) return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No hitters on roster</div>';

  const starters = hitters.filter(p => p.group === PLAYER_GROUP.STARTING_HITTERS)
    .sort((a, b) => _posOrder(a.pos) - _posOrder(b.pos));
  const bench    = hitters.filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS)
    .sort((a, b) => b.ovr - a.ovr);

  return `
    <div class="roster-col-labels" style="grid-template-columns:var(--rcols-pos);">
      <span>Player</span><span class="rcl-pos">Pos</span>
      <span class="rcl-rtg">OVR</span><span></span><span class="rcl-status">Status</span>
    </div>
    ${starters.map(p => _renderHitterRow(p, impScores[p.id], 'starter', gameIdx)).join('')}
    ${bench.length > 0 ? `<div class="roster-sub-head">Bench</div>` : ''}
    ${bench.map(p => _renderHitterRow(p, impScores[p.id], 'bench', gameIdx)).join('')}
  `;
}

function _renderHitterRow(player, imp, role, gameIdx) {
  if (!player) return '';
  const ovrColor  = _ovrColor(player.ovr);
  const indicator = getHotColdIndicator(imp);
  const statusEl  = _playerStatusEl(player);
  const nativePos = player.nativePos || player.pos;

  let swapBtn = '';
  if (player.isInjured || player.isSuspended) {
    swapBtn = ''; // no swap for injured/suspended
  } else if (role === 'starter') {
    swapBtn = `<button class="swap-btn demote" data-swap="${player.id}" data-role="starter">Bench</button>`;
  } else if (role === 'bench') {
    swapBtn = `<button class="swap-btn promote" data-swap="${player.id}" data-role="bench">▲ Start</button>`;
  }

  return `
    <div class="player-row-item" style="grid-template-columns:var(--rcols-pos);" id="pr-${player.id}">
      <div class="player-info">
        <div class="player-name">
          ${_escape(player.name)}
          ${indicator ? `<span class="imp-indicator" style="margin-left:4px;">${indicator}</span>` : ''}
          ${_dotIndicator(player)}
        </div>
        <div style="font-size:11px;color:var(--muted);">${formatAge(player.dob)}y · ${formatSalary(player.contractSalary)}</div>
      </div>
      <div class="player-pos-badge">${nativePos}</div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}">${formatOVR(player.ovr)}</div>
      </div>
      <div>${swapBtn}</div>
      <div>${statusEl}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// PITCHER GROUP
// ─────────────────────────────────────────────────────────────

function _renderPitcherGroup(pitchers, impScores, gameIdx) {
  if (pitchers.length === 0) return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No pitchers on roster</div>';

  const rotation = pitchers.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS)
    .sort((a, b) => {
      const ri = (a.rotationIndex ?? 99) - (b.rotationIndex ?? 99);
      return ri !== 0 ? ri : b.ovr - a.ovr;
    });
  const bullpen  = pitchers.filter(p => p.group === PLAYER_GROUP.BULLPEN).sort((a, b) => b.ovr - a.ovr);
  const pbench   = pitchers.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH).sort((a, b) => b.ovr - a.ovr);

  return `
    <div class="roster-col-labels">
      <span>Player</span><span class="rcl-rtg">OVR</span><span></span><span class="rcl-status">Status</span>
    </div>
    <div class="roster-sub-head starter-label">Rotation</div>
    ${rotation.map((p,i) => _renderPitcherRow(p, impScores[p.id], i+1, 'rotation')).join('')}
    ${bullpen.length > 0 ? '<div class="roster-sub-head">Bullpen</div>' : ''}
    ${bullpen.map(p => _renderPitcherRow(p, impScores[p.id], null, 'bullpen')).join('')}
    ${pbench.length > 0 ? '<div class="roster-sub-head">P Bench</div>' : ''}
    ${pbench.map(p => _renderPitcherRow(p, impScores[p.id], null, 'pbench')).join('')}
  `;
}

function _renderPitcherRow(player, imp, slotNum, role) {
  if (!player) return '';
  const ovrColor  = _ovrColor(player.ovr);
  const indicator = getHotColdIndicator(imp);
  const statusEl  = _playerStatusEl(player);
  const handTag   = player.hand === 'L' ? '<span style="font-size:10px;color:var(--muted);margin-left:3px;">(L)</span>' : '';

  let swapBtn = '';
  if (!player.isInjured && !player.isSuspended) {
    if (role === 'rotation' || role === 'bullpen') {
      swapBtn = `<button class="swap-btn demote" data-swap="${player.id}" data-role="${role}">Bench</button>`;
    } else if (role === 'pbench') {
      swapBtn = `<button class="swap-btn promote" data-swap="${player.id}" data-role="pbench">▲ Active</button>`;
    }
  }

  return `
    <div class="player-row-item" id="pr-${player.id}">
      <div class="player-info">
        <div class="player-name">
          ${slotNum ? `<span style="font-size:10px;color:var(--muted);margin-right:4px;">#${slotNum}</span>` : ''}
          ${_escape(player.name)}${handTag}
          ${indicator ? `<span class="imp-indicator" style="margin-left:4px;">${indicator}</span>` : ''}
          ${_dotIndicator(player)}
        </div>
        <div style="font-size:11px;color:var(--muted);">${formatAge(player.dob)}y · ${formatSalary(player.contractSalary)}</div>
      </div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}">${formatOVR(player.ovr)}</div>
      </div>
      <div>${swapBtn}</div>
      <div>${statusEl}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// IL GROUP
// ─────────────────────────────────────────────────────────────

function _renderILGroup(ilPlayers, state, gameIdx) {
  if (ilPlayers.length === 0) {
    return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No players on IL</div>';
  }

  return ilPlayers.map(player => {
    const report      = player.injuryReport;
    const returnGame  = player.ilReturnGame;
    const gamesLeft   = returnGame != null ? Math.max(0, returnGame - gameIdx) : '?';
    const penaltyNote = player.injuryPenalty
      ? `${player.injuryPenalty.subRating} −${player.injuryPenalty.amount}`
      : '';

    return `
      <div class="player-row-item" style="grid-template-columns:1fr 80px;" id="pr-${player.id}">
        <div class="player-info">
          <div class="player-name">${_escape(player.name)}</div>
          <div style="font-size:11px;color:var(--danger);margin-top:2px;">
            ${_escape(report?.generalText || 'Injured')}
            ${penaltyNote ? `<span style="color:var(--muted);margin-left:6px;">${penaltyNote}</span>` : ''}
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;font-weight:700;color:var(--muted);">
            ${typeof gamesLeft === 'number' ? `${gamesLeft}g left` : 'TBD'}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// PENDING TRANSACTIONS
// ─────────────────────────────────────────────────────────────

function _renderPendingGroup(pending, players) {
  if (pending.length === 0) {
    return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No pending transactions</div>';
  }

  return pending.map(tx => {
    const player = players[tx.playerId];
    if (!player) return '';
    return `
      <div class="player-row-item" style="grid-template-columns:1fr auto;" id="pr-${player.id}">
        <div class="player-info">
          <div class="player-name">${_escape(player.name)}</div>
          <div style="font-size:11px;color:var(--muted);">${_escape(tx.type || 'Incoming')}</div>
        </div>
        <div style="font-size:10px;font-weight:700;color:var(--accent);padding:5px 0 5px 8px;">PENDING</div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// FARM SYSTEM (Section 20.3 — LOCKED)
// ─────────────────────────────────────────────────────────────

function _renderFarmGroup(farmPlayers, state, gameIdx) {
  if (farmPlayers.length === 0) {
    return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">Farm system empty</div>';
  }

  const farmHitters  = farmPlayers
    .filter(p => !['SP','RP'].includes(p.pos))
    .sort((a, b) => _posOrder(a.pos) - _posOrder(b.pos) || b.ovr - a.ovr);
  const farmPitchers = farmPlayers
    .filter(p => ['SP','RP'].includes(p.pos))
    .sort((a, b) => b.ovr - a.ovr);

  const hitterCap  = 12;
  const pitcherCap = 8;

  return `
    <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted);">
      ${farmHitters.length}/${hitterCap} position players · ${farmPitchers.length}/${pitcherCap} pitchers
    </div>

    <!-- Farm Position Players sub-section -->
    <div class="roster-sub-head" data-farm-group="hitters" style="cursor:pointer;">
      Position Players
      <span class="roster-chevron ${_farmOpen.hitters ? 'open' : ''}" style="margin-left:4px;">▼</span>
    </div>
    ${_farmOpen.hitters ? farmHitters.map(p => _renderFarmRow(p, state, gameIdx)).join('') : ''}

    <!-- Farm Pitchers sub-section -->
    <div class="roster-sub-head" data-farm-group="pitchers" style="cursor:pointer;margin-top:4px;">
      Pitchers
      <span class="roster-chevron ${_farmOpen.pitchers ? 'open' : ''}" style="margin-left:4px;">▼</span>
    </div>
    ${_farmOpen.pitchers ? farmPitchers.map(p => _renderFarmRow(p, state, gameIdx)).join('') : ''}
  `;
}

function _renderFarmRow(player, state, gameIdx) {
  if (!player) return '';

  const ovrColor  = _ovrColor(player.ovr);
  const arcIcon   = _farmArcIcon(player._farmArc);
  const sendDown  = player._sentDownGame != null
    ? `Game ${player._sentDownGame + 1}`
    : 'Farm';

  // Context note: performance relative to expectations
  const contextNote = _farmContextNote(player);

  return `
    <div class="player-row-item farm-row" style="grid-template-columns:1fr 36px 56px;" id="fpr-${player.id}"
      data-callup="${player.id}">
      <div class="player-info">
        <div class="player-name">
          ${_escape(player.name)}
          <span style="font-size:10px;color:var(--muted);margin-left:3px;">${player.pos}</span>
          ${arcIcon ? `<span class="farm-arc-icon" title="${player._farmArc || ''}">${arcIcon}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--muted);">${formatAge(player.dob)}y · ${sendDown}${contextNote ? ` · ${contextNote}` : ''}</div>
      </div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}" style="font-size:18px;">${formatOVR(player.ovr)}</div>
      </div>
      <div>
        <button class="swap-btn promote" data-callup="${player.id}" style="font-size:9px;">Call Up</button>
      </div>
    </div>
  `;
}

function _farmArcIcon(arc) {
  if (!arc) return '';
  return arc === 'motivation' ? '↑' : arc === 'decline' ? '↓' : '—';
}

function _farmContextNote(player) {
  if (!player._farmArc) return '';
  if (player._farmArc === 'motivation') return 'performing well';
  if (player._farmArc === 'decline')    return 'struggling';
  return '';
}

// ─────────────────────────────────────────────────────────────
// STAFF TAB
// ─────────────────────────────────────────────────────────────

function _renderStaff(state) {
  const staff  = state.userTeam?.coachingStaff || {};
  const season = state.seasonNum || 1;

  const entries = [
    { key: 'manager',      label: 'Manager',        role: 'Field Staff',  data: staff.manager       },
    { key: 'pitchingCoach',label: 'Pitching Coach',  role: 'Field Staff',  data: staff.pitchingCoach },
    { key: 'hittingCoach', label: 'Hitting Coach',   role: 'Field Staff',  data: staff.hittingCoach  },
    { key: 'benchCoach',   label: 'Bench Coach',     role: 'Field Staff',  data: staff.benchCoach    },
    { key: 'bullpenCoach', label: 'Bullpen Coach',   role: 'Field Staff',  data: staff.bullpenCoach  },
  ].filter(e => e.data);

  if (entries.length === 0) {
    return '<div style="padding:20px;text-align:center;color:var(--muted);">No staff data</div>';
  }

  const cards = entries.map(({ key, label, role, data }) => {
    const yearsLeft   = (data.contractExpiry || season) - season;
    const contractTag = yearsLeft <= 0
      ? '<span style="font-size:10px;font-weight:700;color:var(--danger);background:var(--chip-red-bg);padding:2px 6px;border-radius:4px;">Final Year</span>'
      : yearsLeft === 1
      ? '<span style="font-size:10px;color:var(--muted);background:var(--surface2);padding:2px 6px;border-radius:4px;">1 yr left</span>'
      : `<span style="font-size:10px;color:var(--muted);background:var(--surface2);padding:2px 6px;border-radius:4px;">${yearsLeft} yrs left</span>`;

    const rel         = data.gmRelationship ?? 50;
    const relTag      = rel >= 70
      ? '<span style="font-size:10px;color:var(--accent2);background:var(--chip-green-bg);padding:2px 6px;border-radius:4px;">Strong</span>'
      : rel <= 30
      ? '<span style="font-size:10px;color:var(--danger);background:var(--chip-red-bg);padding:2px 6px;border-radius:4px;">Strained</span>'
      : '';

    return `
      <div class="staff-card">
        <div class="staff-card-left">
          <div class="staff-card-name">${_escape(data.name || label)}</div>
          <div class="staff-card-role">${label}</div>
        </div>
        <div class="staff-card-meta">
          <span class="staff-salary">${formatSalary(data.salary || 0)}/yr</span>
          ${contractTag}
          ${relTag}
        </div>
      </div>
    `;
  }).join('');

  return `<div style="padding:8px 16px 16px;">${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Sub-tab switching
  const pBtn = document.getElementById('tsubtab-players');
  const sBtn = document.getElementById('tsubtab-staff');
  if (pBtn) pBtn.addEventListener('click', () => { _activeTab = 'players'; refresh(); });
  if (sBtn) sBtn.addEventListener('click', () => { _activeTab = 'staff';   refresh(); });

  // Collapsible group headers
  document.querySelectorAll('[data-group]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.group;
      if (key in _groupOpen) {
        _groupOpen[key] = !_groupOpen[key];
        refresh();
      }
    });
  });

  // Farm sub-section headers
  document.querySelectorAll('[data-farm-group]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.farmGroup;
      if (key in _farmOpen) {
        _farmOpen[key] = !_farmOpen[key];
        refresh();
      }
    });
  });

  // Call-up buttons in farm section
  document.querySelectorAll('.swap-btn.promote[data-callup]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _handleCallUp(btn.dataset.callup, state);
    });
  });

  // Swap buttons — bench↔starter / bench↔rotation/bullpen
  document.querySelectorAll('.swap-btn[data-swap]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _handleSwap(btn.dataset.swap, btn.dataset.role, state);
    });
  });

  // Player row tap → PlayerCard modal
  document.querySelectorAll('.player-row-item[id^="pr-"]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.swap-btn')) return;
      const playerId = el.id.replace('pr-', '');
      openPlayerCard(playerId, StateManager.get());
    });
  });
}

// ─────────────────────────────────────────────────────────────
// CALL-UP FROM FARM
// ─────────────────────────────────────────────────────────────

async function _handleCallUp(playerId, state) {
  const player = state.players[playerId];
  if (!player) return;

  try {
    const { callUpFromFarm } = await import('../../engine/RosterEngine.js');
    const mutations = callUpFromFarm(state, playerId, 'user');

    StateManager.mutate(s => {
      if (mutations.players) {
        for (const [id, upd] of Object.entries(mutations.players)) {
          if (s.players[id]) Object.assign(s.players[id], upd);
        }
      }
      if (mutations.userTeam) Object.assign(s.userTeam, mutations.userTeam);
    });

    EventBus.emit('roster:changed', { type: 'callup', playerId });
    App.showToast(`${player.name} called up.`, 'positive');
    refresh();

  } catch (err) {
    console.error('TeamScreen._handleCallUp:', err);
    App.showToast('Could not process call-up. Check roster space.', 'negative');
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/**
 * _handleSwap(playerId, role, state)
 * Moves a player between active/bench slots.
 * Hitters: starter↔bench. Pitchers: rotation/bullpen↔pitcher bench.
 */
async function _handleSwap(playerId, role, state) {
  const player = state.players[playerId];
  if (!player) return;
  if (player.isInjured || player.isSuspended) {
    App.showToast(`${player.name} can't be moved right now.`, 'negative');
    return;
  }

  const { PLAYER_GROUP } = await import('../../data/constants.js');

  StateManager.mutate(s => {
    const p = s.players[playerId];
    if (!p) return;

    if (role === 'starter') {
      // Move hitter starter → bench
      p.group = PLAYER_GROUP.BENCH_HITTERS;
    } else if (role === 'bench') {
      // Move bench hitter → starter (only if starter slots not full at pos)
      const starters = s.userTeam.rosterIds.map(id => s.players[id])
        .filter(x => x && x.group === PLAYER_GROUP.STARTING_HITTERS);
      if (starters.length >= 9) {
        // find someone at the same pos to swap with
        const target = starters.find(x => x.pos === p.pos || x.nativePos === p.nativePos);
        if (target) {
          target.group = PLAYER_GROUP.BENCH_HITTERS;
          p.group      = PLAYER_GROUP.STARTING_HITTERS;
        } else {
          // Just promote anyway — let the sim handle it
          p.group = PLAYER_GROUP.STARTING_HITTERS;
        }
      } else {
        p.group = PLAYER_GROUP.STARTING_HITTERS;
      }
    } else if (role === 'rotation') {
      p.group = PLAYER_GROUP.PITCHER_BENCH;
    } else if (role === 'bullpen') {
      p.group = PLAYER_GROUP.PITCHER_BENCH;
    } else if (role === 'pbench') {
      // Promote pitcher bench → bullpen (default) or rotation if SP
      const isSP = p.pos === 'SP' || p.nativePos === 'SP';
      p.group = isSP ? PLAYER_GROUP.STARTING_PITCHERS : PLAYER_GROUP.BULLPEN;
    }
  });

  EventBus.emit('roster:changed', { type: 'swap', playerId });
  App.showToast(`${player.name} moved.`, 'positive');
  refresh();
}

function _playerStatusEl(player) {
  if (player.isInjured)   return '<div class="player-status status-il">IL</div>';
  if (player.isSuspended) return '<div class="player-status status-inactive">Susp</div>';
  if (player.group === PLAYER_GROUP.STARTING_HITTERS || player.group === PLAYER_GROUP.STARTING_PITCHERS) {
    return '<div class="player-status status-active">Active</div>';
  }
  return '<div class="player-status status-bench">Bench</div>';
}

function _dotIndicator(player) {
  if (player._isNewAcquisition) return '<span class="new-player-dot" title="New"></span>';
  if (player.isSuspended)       return '<span class="suspended-dot" title="Suspended"></span>';
  if (player._isResting)        return '<span class="resting-dot" title="Resting"></span>';
  if (player._isOnLeave)        return '<span class="leave-dot" title="Personal Leave"></span>';
  return '';
}

function _ovrColor(ovr) {
  if (ovr >= 80) return 'elite';
  if (ovr >= 70) return 'good';
  if (ovr >= 60) return 'avg';
  return 'poor';
}

// Position display order for hitter sorting
const _POS_ORDER = { C:1, '1B':2, '2B':3, '3B':4, SS:5, LF:6, CF:7, RF:8, OF:9, DH:10 };
function _posOrder(pos) { return _POS_ORDER[pos] || 99; }

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
    .farm-row{cursor:pointer;}
    .farm-row:active{opacity:.8;}
    .farm-arc-icon{font-size:12px;margin-left:4px;font-weight:700;}
    .imp-indicator{font-size:11px;}
  `;
  document.head.appendChild(style);
}
