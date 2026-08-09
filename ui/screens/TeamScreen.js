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
import { PLAYER_GROUP, ROSTER_LIMITS, PHASE } from '../../data/constants.js';
import { eligibleSlotsFor, reconcileRoster, applyRosterMutation }
  from '../../engine/RosterEngine.js';
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
// SLOT MODEL
// ─────────────────────────────────────────────────────────────
// userTeam.lineupSlots (from schema) is the source of truth for
// who is starting. It's a 9-entry array in fixed order:
// C / 1B / 2B / 3B / SS / OF / OF / OF / DH
// Each entry: { slot: String, playerId: String|null }
// Slot index (0–8) uniquely identifies each position.
// player.group is NOT used to identify starters — BENCH_HITTERS
// means "available but not currently in a lineup slot".

// Which slots a bench player is eligible to fill (based on nativePos).
// Slot labels match lineupSlots entries: 'C','1B','2B','3B','SS','OF','DH'.
// 'OF' covers all three OF positions — no LF/CF/RF distinction.
// Every hitter is eligible for 'DH'.
// Eligibility is defined once in RosterEngine (eligibleSlotsFor) so the swap UI
// and reconcileRoster can never disagree about which slots a player can fill.
function _eligibleSlots(player) {
  return eligibleSlotsFor(player);
}

// ─────────────────────────────────────────────────────────────
// ROSTER OPTIMIZATION
// ─────────────────────────────────────────────────────────────

/**
 * _calcRopt(state)
 * Returns { hitterScore, pitcherScore, moves, teamOvr }
 * Two separate scores — one for hitters, one for pitchers.
 * Reads active hitters from lineupSlots (source of truth).
 */
function _calcRopt(state) {
  const players    = state.players || {};
  const rosterIds  = state.userTeam?.rosterIds || [];
  const lineupSlots = state.userTeam?.lineupSlots || [];

  // Active hitters from lineupSlots
  const starters   = lineupSlots
    .map(s => s.playerId ? players[s.playerId] : null)
    .filter(Boolean);

  const benchH     = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.BENCH_HITTERS && !p.isInjured && !p.isSuspended);
  const rotation   = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.STARTING_PITCHERS);
  const bullpen    = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.BULLPEN);
  const benchP     = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.PITCHER_BENCH && !p.isInjured && !p.isSuspended);
  const benchSP    = benchP.filter(p => p.pos === 'SP');
  const benchRP    = benchP.filter(p => p.pos === 'RP');

  const moves = [];
  const seen  = new Set();

  // ── Hitters — iterate lineupSlots to know each slot label ────
  let hActiveSum = 0, hBestSum = 0;
  for (let i = 0; i < lineupSlots.length; i++) {
    const slotEntry = lineupSlots[i];
    const active    = slotEntry.playerId ? players[slotEntry.playerId] : null;
    if (!active) continue;
    const slotLabel = slotEntry.slot; // 'C','1B','OF','DH' etc.
    const eligible  = benchH.filter(b => _eligibleSlots(b).includes(slotLabel));
    const best      = eligible.sort((a,b) => b.ovr - a.ovr)[0];
    hActiveSum += active.ovr;
    if (best && best.ovr > active.ovr && !seen.has(best.id)) {
      seen.add(best.id);
      hBestSum += best.ovr;
      moves.push(`Start ${best.name} (${best.ovr}) over ${active.name} (${active.ovr}) at ${slotLabel}`);
    } else {
      hBestSum += active.ovr;
    }
  }
  const hitterScore = hBestSum > 0 ? Math.floor(hActiveSum / hBestSum * 100) : 100;

  // ── Pitchers ─────────────────────────────────────────────────
  let pActiveSum = 0, pBestSum = 0;
  for (const active of [...rotation].sort((a,b) => a.ovr - b.ovr)) {
    const better = [...benchSP].sort((a,b) => b.ovr - a.ovr)
      .find(b => b.ovr > active.ovr && !seen.has(b.id));
    pActiveSum += active.ovr;
    if (better) {
      seen.add(better.id);
      pBestSum += better.ovr;
      moves.push(`Move SP ${better.name} (${better.ovr}) into rotation over ${active.name} (${active.ovr})`);
    } else { pBestSum += active.ovr; }
  }
  for (const active of [...bullpen].sort((a,b) => a.ovr - b.ovr)) {
    const better = [...benchRP].sort((a,b) => b.ovr - a.ovr)
      .find(b => b.ovr > active.ovr && !seen.has(b.id));
    pActiveSum += active.ovr;
    if (better) {
      seen.add(better.id);
      pBestSum += better.ovr;
      moves.push(`Move RP ${better.name} (${better.ovr}) into bullpen over ${active.name} (${active.ovr})`);
    } else { pBestSum += active.ovr; }
  }
  const pitcherScore = pBestSum > 0 ? Math.floor(pActiveSum / pBestSum * 100) : 100;

  const allActive = [...starters, ...rotation, ...bullpen];
  const teamOvr   = allActive.length
    ? Math.round(allActive.reduce((s,p) => s + p.ovr, 0) / allActive.length) : 0;

  return { hitterScore, pitcherScore, moves: moves.slice(0, 5), teamOvr };
}

// ─────────────────────────────────────────────────────────────
// MOUNT / UNMOUNT
// ─────────────────────────────────────────────────────────────

export function mount() {
  if (_mounted) return;
  _mounted = true;
  _injectCSS();

  App.registerTabReset('roster', () => refresh());

  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('roster:changed',   () => refresh());
  wire('game:committed',   () => refresh());
  wire('nav:tabActivated', ({ tab }) => { if (tab === 'roster') refresh(); });

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
  const container = document.getElementById('team-content');
  if (!container) return;

  const state = StateManager.get();
  if (!state?.userTeam) return;

  const team      = state.userTeam;
  const payroll   = team.finances?.payroll    || 0;
  const cap       = team.finances?.payrollCap || 22000;
  const capPct    = Math.min(100, Math.round((payroll / cap) * 100));
  const capColor  = capPct > 90 ? 'pf-red' : capPct > 75 ? '' : 'pf-green';

  const ropt       = _calcRopt(state);
  const hColor     = ropt.hitterScore  >= 90 ? '#22C55E' : ropt.hitterScore  >= 60 ? '#4A9EE0' : 'var(--danger)';
  const pColor     = ropt.pitcherScore >= 90 ? '#22C55E' : ropt.pitcherScore >= 60 ? '#4A9EE0' : 'var(--danger)';
  const ovrColor   = ropt.teamOvr >= 75 ? '#22C55E' : ropt.teamOvr >= 65 ? '#4A9EE0' : 'var(--muted)';

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
          <div class="roster-rating-card">
            <div class="rrc-label">Team OVR</div>
            <div class="rrc-value" style="font-size:22px;color:${ovrColor};">${ropt.teamOvr}</div>
          </div>
        </div>
      </div>
      <!-- Ropt bars — hitters and pitchers separately -->
      <div class="ropt-row">
        <span class="ropt-label">Hitters</span>
        <div class="ropt-bar-wrap">
          <div class="ropt-bar-fill" style="width:${ropt.hitterScore}%;background:${hColor};"></div>
        </div>
        <span class="ropt-val" style="color:${hColor};">${ropt.hitterScore}%</span>
        <button class="ropt-hint-btn" id="ropt-hint-btn" title="What needs to change?">?</button>
      </div>
      <div class="ropt-row" style="margin-top:4px;">
        <span class="ropt-label">Pitchers</span>
        <div class="ropt-bar-wrap">
          <div class="ropt-bar-fill" style="width:${ropt.pitcherScore}%;background:${pColor};"></div>
        </div>
        <span class="ropt-val" style="color:${pColor};">${ropt.pitcherScore}%</span>
        <div style="width:22px;flex-shrink:0;"></div>
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
  const team       = state.userTeam;
  const rosterIds  = team.rosterIds  || [];
  const farmIds    = team.farmIds    || [];
  const players    = state.players   || {};
  const impScores  = state.impScores || {};
  const lineupSlots = team.lineupSlots || [];
  const gameIdx    = state.currentGameIndex || 0;
  const isSpring   = state.phase === PHASE.SPRING_TRAINING;

  // Keeper count — only meaningful during spring
  const keeperCount = isSpring
    ? rosterIds.filter(id => players[id]?._isKeeper).length
    : 0;

  // Starters = players in lineupSlots; bench = BENCH_HITTERS not in lineupSlots
  const starterIds   = new Set(lineupSlots.map(s => s.playerId).filter(Boolean));
  const hitterStarters = lineupSlots; // iterate in slot order
  const hitterBench  = rosterIds.map(id => players[id])
    .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS && !starterIds.has(p.id));

  const pitchers    = rosterIds.map(id => players[id]).filter(p => p && [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group));
  const ilPlayers   = rosterIds.map(id => players[id]).filter(p => p && p.group === PLAYER_GROUP.IL);
  const farmPlayers = farmIds.map(id => players[id]).filter(Boolean);
  const pending     = team._pendingAcquisitions || [];

  const hitterCount = starterIds.size + hitterBench.length;

  const keeperBanner = isSpring ? `
    <div class="keeper-banner">
      <span>Spring Camp</span>
      <span class="keeper-count ${keeperCount >= ROSTER_LIMITS.ACTIVE_TOTAL ? 'keeper-count-full' : ''}">
        Keepers: ${keeperCount}/${ROSTER_LIMITS.ACTIVE_TOTAL}
      </span>
    </div>
  ` : '';

  return `
    <div style="padding:0 0 16px;">
      ${keeperBanner}
      ${_renderGroup('hitters',  'Hitters',              hitterCount,       _renderHitterGroup(hitterStarters, hitterBench, players, impScores, gameIdx, isSpring, rosterIds))}
      ${_renderGroup('pitchers', 'Pitchers',             pitchers.length,   _renderPitcherGroup(pitchers, impScores, gameIdx, isSpring, players, rosterIds))}
      ${_renderGroup('il',       'Injured List',         ilPlayers.length,  _renderILGroup(ilPlayers, state, gameIdx))}
      ${_renderGroup('pending',  'Pending Transactions', pending.length,    _renderPendingGroup(pending, players))}
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

function _renderHitterGroup(lineupSlots, bench, players, impScores, gameIdx, isSpring = false, rosterIds = []) {
  if (!lineupSlots.length && !bench.length) {
    return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No hitters on roster</div>';
  }

  const sortedBench = [...bench].sort((a, b) => b.ovr - a.ovr);

  return `
    <div class="roster-col-labels">
      <span>Player</span>
      <span class="rcl-pos">Pos</span>
      <span class="rcl-rtg">OVR</span>
      <span></span>
    </div>
    ${lineupSlots.map(slotEntry => {
      const player = slotEntry.playerId ? players[slotEntry.playerId] : null;
      if (player) {
        return _renderHitterRow(player, impScores[player.id], 'starter', slotEntry.slot, gameIdx, isSpring, players, rosterIds);
      } else {
        // Dashed vacancy card in this slot position
        return `
          <div class="player-row-item vacancy-row" data-vacant-slot="${slotEntry.slot}">
            <div class="player-info">
              <div class="player-name vacancy-name">— ${slotEntry.slot} —</div>
              <div class="player-sub vacancy-sub">Slot empty — tap to fill</div>
            </div>
            <div class="player-pos-badge vacancy-pos">${slotEntry.slot}</div>
            <div class="rating-cell"></div>
            <div class="row-actions"></div>
          </div>`;
      }
    }).join('')}
    ${sortedBench.length > 0 ? `<div class="roster-sub-head">Bench</div>` : ''}
    ${sortedBench.map(p => _renderHitterRow(p, impScores[p.id], 'bench', null, gameIdx, isSpring, players, rosterIds)).join('')}
  `;
}

function _renderHitterRow(player, imp, role, slot, gameIdx, isSpring = false, allPlayers = {}, rosterIds = []) {
  if (!player) return '';
  const ovrColor  = _ovrColor(player.ovr);
  const indicator = getHotColdIndicator(imp);
  const statusEl  = _playerStatusEl(player);
  const nativePos = player.nativePos || player.pos;
  // slot is the lineupSlot label (e.g. 'OF', 'DH') — may differ from player's nativePos
  // Show slot in the pos badge; show nativePos below the name line (like pitchers)
  const slotLabel = slot || nativePos;

  const stBadge     = isSpring && player._isSpringInvitee
    ? `<span class="st-badge">ST</span>` : '';
  const keeperBadge = isSpring
    ? `<span class="keeper-badge ${player._isKeeper ? 'keeper-on' : 'keeper-off'}" data-keeper="${player.id}">${player._isKeeper ? '♦' : '◇'}</span>`
    : '';

  let swapBtn = '';
  if (!player.isInjured && !player.isSuspended) {
    if (role === 'starter') {
      // Bench button: disabled if no bench player is eligible for this slot
      const bench = rosterIds.map(id => allPlayers[id])
        .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS && !p.isInjured && !p.isSuspended);
      const hasReplacement = bench.some(b => _eligibleSlots(b).includes(slotLabel));
      swapBtn = `<button class="swap-btn demote" data-swap="${player.id}" data-role="starter"${hasReplacement ? '' : ' disabled title="No eligible bench player"'}>Bench</button>`;
    } else if (role === 'bench') {
      swapBtn = `<button class="swap-btn promote" data-swap="${player.id}" data-role="bench">▲</button>`;
    }
  }

  return `
    <div class="player-row-item" id="pr-${player.id}">
      <div class="player-info">
        <div class="player-name">
          ${_escape(player.name)}
          ${stBadge}
          ${indicator ? `<span class="imp-indicator">${indicator}</span>` : ''}
          ${_dotIndicator(player)}
        </div>
        <div class="player-sub">${nativePos} · ${formatAge(player.dob)}y · ${formatSalary(player.contractSalary)}</div>
      </div>
      <div class="player-pos-badge">${slotLabel}</div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}">${formatOVR(player.ovr)}</div>
        ${keeperBadge}
      </div>
      <div class="row-actions">${swapBtn}${statusEl}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// PITCHER GROUP
// ─────────────────────────────────────────────────────────────

function _renderPitcherGroup(pitchers, impScores, gameIdx, isSpring = false, allPlayers = {}, rosterIds = []) {
  if (pitchers.length === 0) return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No pitchers on roster</div>';

  const rotation = pitchers.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS)
    .sort((a, b) => b.ovr - a.ovr);
  const bullpen  = pitchers.filter(p => p.group === PLAYER_GROUP.BULLPEN).sort((a, b) => b.ovr - a.ovr);
  const pbench   = pitchers.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH).sort((a, b) => b.ovr - a.ovr);

  return `
    <div class="roster-col-labels">
      <span>Player</span>
      <span class="rcl-rtg">OVR</span>
      <span></span>
    </div>
    <div class="roster-sub-head">Rotation (SP)</div>
    ${rotation.map(p => _renderPitcherRow(p, impScores[p.id], 'rotation', isSpring, allPlayers, rosterIds)).join('')}
    ${bullpen.length > 0 ? '<div class="roster-sub-head">Bullpen (RP)</div>' : ''}
    ${bullpen.map(p => _renderPitcherRow(p, impScores[p.id], 'bullpen', isSpring, allPlayers, rosterIds)).join('')}
    ${pbench.length > 0 ? '<div class="roster-sub-head">Pitcher Bench</div>' : ''}
    ${pbench.map(p => _renderPitcherRow(p, impScores[p.id], 'pbench', isSpring, allPlayers, rosterIds)).join('')}
  `;
}

function _renderPitcherRow(player, imp, role, isSpring = false, allPlayers = [], rosterIds = []) {
  if (!player) return '';
  const ovrColor  = _ovrColor(player.ovr);
  const indicator = getHotColdIndicator(imp);
  const statusEl  = _playerStatusEl(player);

  const posHand   = `<span class="pitcher-pos-hand">${player.pos} · ${player.hand === 'L' ? 'LHP' : 'RHP'}</span>`;

  const stBadge     = isSpring && player._isSpringInvitee
    ? `<span class="st-badge">ST</span>` : '';
  const keeperBadge = isSpring
    ? `<span class="keeper-badge ${player._isKeeper ? 'keeper-on' : 'keeper-off'}" data-keeper="${player.id}">${player._isKeeper ? '♦' : '◇'}</span>`
    : '';

  let swapBtn = '';
  if (!player.isInjured && !player.isSuspended) {
    if (role === 'rotation' || role === 'bullpen') {
      // Bench button disabled if no pitcher bench player of same type exists
      const sameType = role === 'rotation' ? 'SP' : 'RP';
      const benchPool = rosterIds.map(id => allPlayers[id])
        .filter(p => p && p.group === PLAYER_GROUP.PITCHER_BENCH
          && p.pos === sameType && !p.isInjured && !p.isSuspended);
      const disabled = benchPool.length === 0 ? ' disabled title="No bench pitcher available"' : '';
      swapBtn = `<button class="swap-btn demote" data-swap="${player.id}" data-role="${role}"${disabled}>Bench</button>`;
    } else if (role === 'pbench') {
      swapBtn = `<button class="swap-btn promote" data-swap="${player.id}" data-role="pbench">▲</button>`;
    }
  }

  return `
    <div class="player-row-item" id="pr-${player.id}">
      <div class="player-info">
        <div class="player-name">
          ${_escape(player.name)}
          ${stBadge}
          ${indicator ? `<span class="imp-indicator">${indicator}</span>` : ''}
          ${_dotIndicator(player)}
        </div>
        <div class="player-sub">${posHand} · ${formatAge(player.dob)}y · ${formatSalary(player.contractSalary)}</div>
      </div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}">${formatOVR(player.ovr)}</div>
        ${keeperBadge}
      </div>
      <div class="row-actions">${swapBtn}${statusEl}</div>
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

    const rel         = data.relationship ?? data.gmRelationship ?? 50;
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

  // Ropt hint button — toast with up to 3 suggested moves, matching v1 format
  document.getElementById('ropt-hint-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const ropt = _calcRopt(state);
    if (ropt.moves.length === 0) {
      App.showToast(
        'Best available players are already active — optimization is maxed out.',
        'positive', 4000
      );
    } else {
      App.showToast(
        'To improve: ' + ropt.moves.slice(0, 3).join(' · '),
        'neutral', 5500
      );
    }
  });

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

  // Keeper toggle — fires during spring training only
  document.querySelectorAll('.keeper-badge[data-keeper]').forEach(badge => {
    badge.addEventListener('click', async e => {
      e.stopPropagation();
      const playerId = badge.dataset.keeper;
      const { toggleKeeperTag } = await import('../../engine/RosterEngine.js');
      const result = toggleKeeperTag(StateManager.get(), playerId);
      if (result.error) {
        App.showToast(result.error, 'negative');
        return;
      }
      StateManager.mutate(s => {
        if (result.players?.[playerId]) {
          Object.assign(s.players[playerId], result.players[playerId]);
        }
      });
      refresh();
    });
  });

  // Swap buttons — now opens swap modal instead of auto-swapping
  document.querySelectorAll('.swap-btn[data-swap]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _handleSwap(btn.dataset.swap, btn.dataset.role, StateManager.get());
    });
  });

  // Vacant slot rows — tap to open bench picker for that slot
  document.querySelectorAll('.vacancy-row[data-vacant-slot]').forEach(el => {
    el.addEventListener('click', () => {
      const slotLabel  = el.dataset.vacantSlot;
      const s          = StateManager.get();
      const lineupSlots = s.userTeam.lineupSlots || [];
      const slotIdx    = lineupSlots.findIndex(ls => ls.slot === slotLabel && !ls.playerId);
      const bench      = (s.userTeam.rosterIds || []).map(id => s.players[id])
        .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS
          && !p.isInjured && !p.isSuspended
          && _eligibleSlots(p).includes(slotLabel))
        .sort((a, b) => a.ovr - b.ovr);
      if (bench.length === 0) {
        App.showToast(`No bench player can fill the ${slotLabel} slot.`, 'negative');
        return;
      }
      _openReplacementPicker(
        `Fill the ${slotLabel} slot:`,
        bench,
        (player) => { _execHitterSwap(player, slotIdx, null); }
      );
    });
  });

  // Player row tap → PlayerCard — guard against swap btn, keeper badge, vacancy
  document.querySelectorAll('.player-row-item[id^="pr-"]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.swap-btn') || e.target.closest('.keeper-badge')) return;
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

    // Reconcile lineup/rotation integrity. A manual call-up can push the active
    // roster over 28 — that's a GM decision (option B), so reconcile reports the
    // surplus rather than auto-dropping, and we prompt the user to make room.
    const rec = reconcileRoster(StateManager.get(), 'user');
    StateManager.mutate(s => applyRosterMutation(s, rec));

    EventBus.emit('roster:changed', { type: 'callup', playerId });
    if (rec.pendingSurplus && rec.pendingSurplus.length) {
      App.showToast(
        `${player.name} called up — roster is over 28. Send someone down or waive to get legal.`,
        'negative'
      );
    } else {
      App.showToast(`${player.name} called up.`, 'positive');
    }
    refresh();

  } catch (err) {
    console.error('TeamScreen._handleCallUp:', err);
    App.showToast('Could not process call-up. Check roster space.', 'negative');
  }
}

// ─────────────────────────────────────────────────────────────
// SWAP — modal-driven 1-for-1 exchange
// ─────────────────────────────────────────────────────────────

async function _handleSwap(playerId, role, state) {
  const player = state.players[playerId];
  if (!player) return;
  if (player.isInjured || player.isSuspended) {
    App.showToast(`${player.name} can't be moved right now.`, 'negative');
    return;
  }

  const players   = state.players;
  const rosterIds = state.userTeam.rosterIds;

  // ── HITTER: bench → starter ──────────────────────────────────
  if (role === 'bench') {
    const eligibleSlots = _eligibleSlots(player);
    const lineupSlots   = StateManager.get().userTeam.lineupSlots || [];

    // Find empty eligible slots — promote directly with no modal
    const emptyEligible = eligibleSlots.filter(sl =>
      lineupSlots.some(s => s.slot === sl && !s.playerId)
    );
    if (emptyEligible.length > 0) {
      // Find the slot index for the first empty eligible slot
      const slotIdx = lineupSlots.findIndex(s => s.slot === emptyEligible[0] && !s.playerId);
      _execHitterSwap(player, slotIdx, null);
      return;
    }

    // All eligible slots occupied — show slot picker.
    // For each eligible slot LABEL, find ALL matching lineupSlot entries.
    // This correctly shows all 3 OF slots when an OF bench player is promoted.
    const slotOccupants = [];
    const seenIndices   = new Set();

    for (const sl of eligibleSlots) {
      // Find all lineupSlot entries matching this label (OF has 3 entries)
      lineupSlots.forEach((s, idx) => {
        if (s.slot !== sl || seenIndices.has(idx)) return;
        seenIndices.add(idx);
        const occupant = s.playerId ? StateManager.get().players[s.playerId] : null;
        slotOccupants.push({ slot: sl, slotIdx: idx, occupant });
      });
    }

    _openSlotPicker(player, slotOccupants, (chosenSlotIdx, outgoing) => {
      _execHitterSwap(player, chosenSlotIdx, outgoing);
    });
    return;
  }

  // ── HITTER: starter → bench ──────────────────────────────────
  if (role === 'starter') {
    const lineupSlots = StateManager.get().userTeam.lineupSlots || [];
    const slotIdx     = lineupSlots.findIndex(s => s.playerId === playerId);
    const slotLabel   = slotIdx >= 0 ? lineupSlots[slotIdx].slot : (player.nativePos || player.pos);

    const bench = rosterIds.map(id => players[id])
      .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS
        && !p.isInjured && !p.isSuspended
        && _eligibleSlots(p).includes(slotLabel));

    if (bench.length === 0) {
      App.showToast('No eligible bench player for this slot.', 'negative');
      return;
    }

    const sorted = [...bench].sort((a, b) => a.ovr - b.ovr);
    _openReplacementPicker(
      `Who replaces ${player.name} (${slotLabel})?`,
      sorted,
      (replacement) => {
        _execHitterSwap(replacement, slotIdx, player);
      }
    );
    return;
  }

  // ── PITCHER: pbench → rotation/bullpen ───────────────────────
  if (role === 'pbench') {
    const isSP      = player.pos === 'SP';
    const activeGrp = isSP ? PLAYER_GROUP.STARTING_PITCHERS : PLAYER_GROUP.BULLPEN;
    const active    = rosterIds.map(id => players[id]).filter(p => p && p.group === activeGrp);
    const cap       = isSP ? ROSTER_LIMITS.STARTING_PITCHERS : ROSTER_LIMITS.BULLPEN;

    if (active.length < cap) {
      _execPitcherSwap(player, null, isSP);
      return;
    }

    // Sort ascending OVR (weakest first)
    const sorted = [...active].sort((a, b) => a.ovr - b.ovr);
    _openReplacementPicker(
      `Move ${player.name} into ${isSP ? 'rotation' : 'bullpen'} — who comes out?`,
      sorted,
      (target) => { _execPitcherSwap(player, target, isSP); }
    );
    return;
  }

  // ── PITCHER: rotation/bullpen → bench ────────────────────────
  if (role === 'rotation' || role === 'bullpen') {
    const isSP   = player.pos === 'SP';
    const benchP = rosterIds.map(id => players[id])
      .filter(p => p && p.group === PLAYER_GROUP.PITCHER_BENCH
        && p.pos === player.pos && !p.isInjured && !p.isSuspended);

    if (benchP.length === 0) {
      App.showToast('No bench pitcher available.', 'negative');
      return;
    }

    // Sort ascending OVR (weakest first)
    const sorted = [...benchP].sort((a, b) => a.ovr - b.ovr);
    _openReplacementPicker(
      `Who replaces ${player.name} in the ${isSP ? 'rotation' : 'bullpen'}?`,
      sorted,
      (replacement) => { _execPitcherSwap(replacement, player, isSP); }
    );
    return;
  }
}

// ─────────────────────────────────────────────────────────────
// SWAP EXECUTION
// ─────────────────────────────────────────────────────────────

function _execHitterSwap(incoming, slotIdx, outgoing) {
  // slotIdx is the index into userTeam.lineupSlots
  StateManager.mutate(s => {
    const slots = s.userTeam.lineupSlots;
    if (slotIdx >= 0 && slotIdx < slots.length) {
      slots[slotIdx].playerId = incoming.id;
    }
    // outgoing goes to bench — nothing to write to lineupSlots
    // (they're already removed from the slot by setting incoming)
  });
  // Reconcile lineup integrity (dedupe, valid occupants) after the edit.
  const rec = reconcileRoster(StateManager.get(), 'user');
  StateManager.mutate(s => applyRosterMutation(s, rec));
  EventBus.emit('roster:changed', { type: 'swap' });
  const slotLabel = StateManager.get().userTeam.lineupSlots[slotIdx]?.slot || '';
  const ropt      = _calcRopt(StateManager.get());
  if (ropt.hitterScore >= 100) App.playSoundPositive();
  App.showToast(
    outgoing
      ? `${incoming.name} in at ${slotLabel}, ${outgoing.name} to bench.`
      : `${incoming.name} added to lineup at ${slotLabel}.`,
    'positive'
  );
  refresh();
}

function _execPitcherSwap(incoming, outgoing, isSP) {
  const activeGrp = isSP ? PLAYER_GROUP.STARTING_PITCHERS : PLAYER_GROUP.BULLPEN;
  StateManager.mutate(s => {
    s.players[incoming.id].group = activeGrp;
    if (outgoing) s.players[outgoing.id].group = PLAYER_GROUP.PITCHER_BENCH;
  });
  // Reconcile so rotation.order reflects the swap. The sim reads rotation.order,
  // NOT group — before this, a rotation swap changed only the group and had zero
  // effect on which pitcher actually started.
  const rec = reconcileRoster(StateManager.get(), 'user');
  StateManager.mutate(s => applyRosterMutation(s, rec));
  EventBus.emit('roster:changed', { type: 'swap' });
  // Play success sound only when pitcher optimization reaches 100%
  const ropt = _calcRopt(StateManager.get());
  if (ropt.pitcherScore >= 100) App.playSoundPositive();
  App.showToast(
    outgoing
      ? `${incoming.name} active, ${outgoing.name} to bench.`
      : `${incoming.name} added to ${isSP ? 'rotation' : 'bullpen'}.`,
    'positive'
  );
  refresh();
}

// ─────────────────────────────────────────────────────────────
// SWAP MODALS
// ─────────────────────────────────────────────────────────────

function _openSlotPicker(player, slotOccupants, onSlotChosen) {
  document.getElementById('ts-swap-modal')?.remove();

  const slotRows = slotOccupants.map(({ slot, slotIdx, occupant }) => {
    const sub = occupant
      ? `<span class="sm-current">${_escape(occupant.name)} <span style="color:var(--muted)">(${occupant.ovr})</span></span>`
      : `<span class="sm-empty">Empty — promote directly</span>`;
    return `
      <div class="sm-row" data-slot-idx="${slotIdx}" data-occupant="${occupant?.id || ''}">
        <div class="sm-slot-label">${slot}</div>
        <div class="sm-slot-sub">${sub}</div>
        <span class="sm-arrow">›</span>
      </div>`;
  }).join('');

  _showSwapSheet(
    `Where does ${_escape(player.name)} play?`,
    `${player.nativePos || player.pos} · OVR ${player.ovr}`,
    slotRows,
    (overlay) => {
      overlay.querySelectorAll('.sm-row[data-slot-idx]').forEach(row => {
        row.addEventListener('click', () => {
          App.playClick();
          overlay.remove();
          const chosenSlotIdx = parseInt(row.dataset.slotIdx, 10);
          const occupantId    = row.dataset.occupant;
          const occupant      = occupantId ? StateManager.get().players[occupantId] : null;
          onSlotChosen(chosenSlotIdx, occupant || null);
        });
      });
    }
  );
}

function _openReplacementPicker(title, candidates, onChosen) {
  document.getElementById('ts-swap-modal')?.remove();

  const rows = candidates.map(p => {
    const posTag = ['SP','RP'].includes(p.pos)
      ? `${p.pos} · ${p.hand === 'L' ? 'LHP' : 'RHP'}`
      : (p.nativePos || p.pos);
    return `
      <div class="sm-row" data-pick="${p.id}">
        <div class="sm-pick-info">
          <span class="sm-pick-name">${_escape(p.name)}</span>
          <span class="sm-pick-sub">${posTag}</span>
        </div>
        <span class="rating-num ${_ovrColor(p.ovr)} sm-pick-ovr">${p.ovr}</span>
        <span class="sm-arrow">›</span>
      </div>`;
  }).join('');

  _showSwapSheet(title, null, rows, (overlay) => {
    overlay.querySelectorAll('.sm-row[data-pick]').forEach(row => {
      row.addEventListener('click', () => {
        App.playClick();
        const candidate = StateManager.get().players[row.dataset.pick];
        if (candidate) { overlay.remove(); onChosen(candidate); }
      });
    });
  });
}

function _showSwapSheet(title, subtitle, rowsHtml, wireRows) {
  document.getElementById('ts-swap-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ts-swap-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:80dvh;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div>
          <div class="modal-title">${title}</div>
          ${subtitle ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">${subtitle}</div>` : ''}
        </div>
        <button class="modal-close" id="ts-swap-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div style="overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));">
        ${rowsHtml}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('#ts-swap-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  wireRows(overlay);
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
    /* Farm rows */
    .farm-row{cursor:pointer;}
    .farm-row:active{opacity:.8;}
    .farm-arc-icon{font-size:12px;margin-left:4px;font-weight:700;}
    .imp-indicator{font-size:11px;margin-left:3px;}

    /* Ropt bar */
    .ropt-row{display:flex;align-items:center;gap:7px;margin-bottom:6px;}
    .ropt-label{font-size:10px;font-weight:700;letter-spacing:.5px;
      text-transform:uppercase;color:var(--muted);white-space:nowrap;flex-shrink:0;}
    .ropt-bar-wrap{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;}
    .ropt-bar-fill{height:100%;border-radius:3px;transition:width .6s cubic-bezier(.4,0,.2,1);}
    .ropt-val{font-size:12px;font-weight:700;white-space:nowrap;flex-shrink:0;min-width:32px;text-align:right;}
    .ropt-hint-btn{flex-shrink:0;width:22px;height:22px;border-radius:50%;
      border:1px solid var(--border);background:transparent;color:var(--muted);
      font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;
      justify-content:center;font-family:'DM Sans',sans-serif;padding:0;}
    .ropt-hint-btn:active{opacity:.6;}

    /* Keeper badge — shown during spring training */
    .keeper-badge{font-size:13px;cursor:pointer;margin-left:4px;line-height:1;
      transition:color .15s;}
    .keeper-on{color:var(--accent2);}
    .keeper-off{color:var(--border);}
    .keeper-badge:active{opacity:.6;}

    /* Spring training invitee badge */
    .st-badge{font-size:9px;font-weight:800;letter-spacing:.5px;
      color:var(--accent);background:var(--chip-accent-bg);
      border:1px solid var(--accent);border-radius:4px;
      padding:1px 4px;margin-left:5px;vertical-align:middle;}

    /* Keeper banner at top of players tab */
    .keeper-banner{display:flex;align-items:center;justify-content:space-between;
      padding:7px 14px;background:var(--chip-accent-bg);
      border-bottom:1px solid var(--accent);font-size:11px;font-weight:700;
      letter-spacing:.5px;text-transform:uppercase;color:var(--accent);}
    .keeper-count{font-size:12px;font-weight:800;}
    .keeper-count-full{color:var(--accent2);}

    /* Pitcher pos/hand subtitle */
    .pitcher-pos-hand{font-size:11px;font-weight:700;color:var(--soft);}

    /* Player sub line */
    .player-sub{font-size:11px;color:var(--muted);margin-top:1px;}

    /* Row actions — swap button + status stacked */
    .row-actions{display:flex;flex-direction:column;align-items:flex-end;gap:3px;}
    .swap-btn:disabled{opacity:.3;cursor:not-allowed;}

    /* OVR tier colors — fixed, never follow team accent color */
    .rating-num.elite{color:#34C97A !important;}   /* 80+ green */
    .rating-num.good {color:#4A9EE0 !important;}   /* 70-79 blue */
    .rating-num.avg  {color:#F5C842 !important;}   /* 60-69 yellow */
    .rating-num.poor {color:#E05050 !important;}   /* <60 red */

    /* Vacancy row (empty lineup slot) */
    .vacancy-row{border:1.5px dashed var(--border);border-radius:8px;margin:4px 12px;
      opacity:.7;cursor:pointer;}
    .vacancy-row:active{opacity:.5;}
    .vacancy-name{color:var(--muted);font-style:italic;font-size:12px;}
    .vacancy-sub{color:var(--muted);font-size:10px;}
    .vacancy-pos{color:var(--muted);}

    /* Swap modal rows */
    .sm-row{display:flex;align-items:center;gap:10px;padding:12px 20px;
      border-bottom:1px solid var(--border);cursor:pointer;}
    .sm-row:active{background:var(--surface2);}
    .sm-slot-label{font-size:14px;font-weight:800;color:var(--accent);
      width:36px;flex-shrink:0;text-align:center;}
    .sm-slot-sub{flex:1;font-size:12px;}
    .sm-current{color:var(--text);font-weight:600;}
    .sm-empty{color:var(--accent2);font-weight:600;}
    .sm-pick-info{flex:1;min-width:0;}
    .sm-pick-name{font-size:13px;font-weight:600;color:var(--text);display:block;}
    .sm-pick-sub{font-size:11px;color:var(--muted);}
    .sm-pick-ovr{font-size:16px !important;flex-shrink:0;}
    .sm-arrow{font-size:16px;color:var(--border);flex-shrink:0;}
  `;
  document.head.appendChild(style);
}
