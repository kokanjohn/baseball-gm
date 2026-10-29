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
 *   ├── Pending Transactions  (collapsible) — state.transactions ledger (§65)
 *   └── Farm System           (collapsible) — farmIds, split into Position Players + Pitchers
 *
 * Farm player row shows: name, pos, OVR, age, story arc indicator, send-down date.
 * Farm section is user-only — CPU farm is not browsable (Section 20.3).
 *
 * Swap buttons (promote/demote) apply roster mutations via RosterEngine.
 * Open roster spots render as dashed cards (TransactionEngine.getRosterNeeds —
 * the same source the inbox uses); a call-up goes through GameEngine.gmCallUp
 * and reports the next calendar day (§65).
 *
 * Screen label is "Team" not "Roster" (Section 1.14 — LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { baseballYear, isAvailable } from '../../engine/PlayerFactory.js';
import { contractIsUp } from '../../engine/OffseasonEngine.js';
import { developmentStatus } from '../../engine/DevelopmentEngine.js';
import { getHotColdIndicator } from '../../engine/IMPEngine.js';
import { bullpenRoles, armStatus, ROLE_ABBR } from '../../engine/PitchingEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { formatMoney, formatOVR, formatAge, formatSalary } from '../formatters.js';
import { PLAYER_GROUP, ROSTER_LIMITS, PHASE } from '../../data/constants.js';
import { eligibleSlotsFor, reconcileRoster, applyRosterMutation }
  from '../../engine/RosterEngine.js';
import { getRosterNeeds, rankCallupCandidates } from '../../engine/TransactionEngine.js';
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

  // True bench = BENCH_HITTERS NOT seated in a lineup slot. All active hitters
  // (starters + bench) share the BENCH_HITTERS group under the lineupSlots model,
  // so without excluding the seated starters the bench pool would contain other
  // starters — producing bogus "start X over Y" moves between two players who are
  // both already starting.
  const starterIdSet = new Set(lineupSlots.map(s => s.playerId).filter(Boolean));
  const benchH     = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.BENCH_HITTERS && isAvailable(p)
    && !starterIdSet.has(p.id));
  const rotation   = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.STARTING_PITCHERS);
  const bullpen    = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.BULLPEN);
  const benchP     = rosterIds.map(id => players[id]).filter(p =>
    p && p.group === PLAYER_GROUP.PITCHER_BENCH && isAvailable(p));
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
  const cap       = Finance.seasonTarget(team.finances) || 22000;   // §78: the owner's payroll target (this season's)
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
            <div class="rrc-sub">${formatMoney(cap)} target</div>
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
        <button class="team-subtab ${_activeTab === 'finances' ? 'active' : ''}" id="tsubtab-finances">Finances</button>
      </div>
    </div>

    <div id="team-tab-body">
      ${_activeTab === 'players' ? _renderPlayers(state) : _activeTab === 'finances' ? _renderFinances(state) : _renderStaff(state)}
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

  // §65 — one source for open spots, arrivals and departures (the inbox reads it too).
  const needs       = getRosterNeeds(state, 'user');
  const isP         = (p) => ['SP', 'RP'].includes(p?.pos);
  const arriving    = needs.arrivals;
  const pending     = _pendingTransactions(state);
  const spotsHtml   = (side) => _renderOpenSpots(
    needs.needs.map((n, i) => ({ ...n, index: i })).filter(n => n.side === side),
    arriving.filter(t => (side === 'pitcher') === isP(players[t.playerId])),
    needs, state);

  const hitterCount = starterIds.size + hitterBench.length;

  const keeperBanner = isSpring ? `
    <div class="keeper-banner">
      <span>Spring Camp</span>
      <span class="keeper-count ${keeperCount >= ROSTER_LIMITS.ACTIVE_TOTAL ? 'keeper-count-full' : ''}">
        Keepers: ${keeperCount}/${ROSTER_LIMITS.ACTIVE_TOTAL}
      </span>
    </div>
  ` : '';

  const vacancyBanner = needs.short > 0 ? `
    <div class="vacancy-banner">
      <span><b>${needs.short} open roster spot${needs.short > 1 ? 's' : ''}</b> — tap a dashed card to call someone up.</span>
      ${needs.deadlineAt ? `<span class="vacancy-deadline">Due ${_clockText(needs.deadlineAt)} or ${_escape(team.coachingStaff?.manager?.name || 'the manager')} picks</span>` : ''}
    </div>` : '';

  return `
    <div style="padding:0 0 16px;">
      ${keeperBanner}
      ${vacancyBanner}
      ${_renderGroup('hitters',  'Hitters',              hitterCount,       _renderHitterGroup(hitterStarters, hitterBench, players, impScores, gameIdx, isSpring, rosterIds) + spotsHtml('hitter'))}
      ${_renderGroup('pitchers', 'Pitchers',             pitchers.length,   _renderPitcherGroup(pitchers, impScores, gameIdx, isSpring, players, rosterIds, team.rotation) + spotsHtml('pitcher'))}
      ${_renderGroup('il',       'Injured List',         ilPlayers.length,  _renderILGroup(ilPlayers, state, gameIdx))}
      ${_renderGroup('pending',  'Pending Transactions', pending.length,    _renderPendingGroup(pending, players))}
      ${_renderGroup('farm',     'Farm System',          farmPlayers.length, _renderFarmGroup(farmPlayers, state, gameIdx, needs), true)}
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
        return _renderHitterRow(player, impScores[player.id], 'starter', slotEntry.slot, gameIdx, isSpring, players, rosterIds, !!slotEntry.emergency);
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

function _renderHitterRow(player, imp, role, slot, gameIdx, isSpring = false, allPlayers = {}, rosterIds = [], emergency = false) {
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
  if (isAvailable(player)) {
    if (role === 'starter') {
      // Bench button: disabled if no bench player is eligible for this slot
      const bench = rosterIds.map(id => allPlayers[id])
        .filter(p => p && p.group === PLAYER_GROUP.BENCH_HITTERS && isAvailable(p));
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
        <div class="player-sub">${nativePos} · ${formatAge(player.dob, baseballYear(StateManager.get()))}y · ${formatSalary(player.contractSalary)}${_contractNote(player)}${emergency ? ' · <span class="oop-note">out of position</span>' : ''}</div>
      </div>
      <div class="player-pos-badge${emergency ? ' oop' : ''}">${slotLabel}</div>
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

function _renderPitcherGroup(pitchers, impScores, gameIdx, isSpring = false, allPlayers = {}, rosterIds = [], rotationMeta = null) {
  if (pitchers.length === 0) return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No pitchers on roster</div>';

  // Rotation is shown in its true pitching order (rotation.order), NOT sorted by
  // OVR — the sim starts rotation.order[currentIndex], so the display must match
  // or it looks like the wrong pitcher started. The upcoming starter gets a NEXT
  // badge. Any STARTING_PITCHERS somehow missing from order are appended.
  const orderIds   = (rotationMeta && Array.isArray(rotationMeta.order)) ? rotationMeta.order : [];
  const nextSPId   = orderIds.length
    ? orderIds[(rotationMeta.currentIndex || 0) % orderIds.length]
    : null;
  const inOrder    = orderIds.map(id => allPlayers[id])
    .filter(p => p && p.group === PLAYER_GROUP.STARTING_PITCHERS);
  const inOrderSet = new Set(inOrder.map(p => p.id));
  const strays     = pitchers
    .filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS && !inOrderSet.has(p.id))
    .sort((a, b) => b.ovr - a.ovr);
  const rotation   = [...inOrder, ...strays];

  // §76: the manager's bullpen roles — listed closer, setup, middle, long.
  const roles    = bullpenRoles({ rosterIds }, allPlayers);
  const depth    = [roles.closer, ...roles.setup, ...roles.middle, ...roles.long].filter(Boolean);
  const byDepth  = (a, b) => (depth.indexOf(a.id) + 1 || 99) - (depth.indexOf(b.id) + 1 || 99) || b.ovr - a.ovr;
  const bullpen  = pitchers.filter(p => p.group === PLAYER_GROUP.BULLPEN).sort(byDepth);
  const pbench   = pitchers.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH).sort(byDepth);
  const reliefRole = (p) => roles.roleOf[p.id] || null;

  return `
    <div class="roster-col-labels">
      <span>Player</span>
      <span class="rcl-rtg">OVR</span>
      <span></span>
    </div>
    <div class="roster-sub-head">Rotation (SP) — in start order</div>
    ${rotation.map(p => _renderPitcherRow(p, impScores[p.id], 'rotation', isSpring, allPlayers, rosterIds, p.id === nextSPId)).join('')}
    ${bullpen.length > 0 ? '<div class="roster-sub-head">Bullpen (RP)</div>' : ''}
    ${bullpen.map(p => _renderPitcherRow(p, impScores[p.id], 'bullpen', isSpring, allPlayers, rosterIds, false, reliefRole(p))).join('')}
    ${pbench.length > 0 ? '<div class="roster-sub-head">Pitcher Bench</div>' : ''}
    ${pbench.map(p => _renderPitcherRow(p, impScores[p.id], 'pbench', isSpring, allPlayers, rosterIds, false, reliefRole(p))).join('')}
  `;
}

function _renderPitcherRow(player, imp, role, isSpring = false, allPlayers = [], rosterIds = [], isNext = false, reliefRole = null) {
  if (!player) return '';
  // §76: his bullpen role, and whether his arm is ready today.
  const roleBadge = reliefRole ? `<span class="rp-role rp-role-${reliefRole}" title="${{ closer: 'Closer', setup: 'Setup', middle: 'Middle relief', long: 'Long relief' }[reliefRole]}">${ROLE_ABBR[reliefRole]}</span>` : '';
  const now = Date.now();
  let armNote = '';
  if (isAvailable(player) && role !== 'rotation') {     // starters rest in turn (the rotation)
    const st = armStatus(player, now).status;
    if (st === 'down')  armNote = ' · <span class="arm-down">resting today</span>';
    if (st === 'tired') armNote = ' · <span class="arm-tired">tired</span>';
  }
  const ovrColor  = _ovrColor(player.ovr);
  const indicator = getHotColdIndicator(imp);
  const statusEl  = _playerStatusEl(player);

  const nextBadge = isNext ? `<span class="sp-next-badge" title="Starts the next game">NEXT</span>` : '';

  const posHand   = `<span class="pitcher-pos-hand">${player.pos} · ${player.hand === 'L' ? 'LHP' : 'RHP'}</span>`;

  const stBadge     = isSpring && player._isSpringInvitee
    ? `<span class="st-badge">ST</span>` : '';
  const keeperBadge = isSpring
    ? `<span class="keeper-badge ${player._isKeeper ? 'keeper-on' : 'keeper-off'}" data-keeper="${player.id}">${player._isKeeper ? '♦' : '◇'}</span>`
    : '';

  let swapBtn = '';
  if (isAvailable(player)) {
    if (role === 'rotation' || role === 'bullpen') {
      // Bench button disabled if no pitcher bench player of same type exists
      const sameType = role === 'rotation' ? 'SP' : 'RP';
      const benchPool = rosterIds.map(id => allPlayers[id])
        .filter(p => p && p.group === PLAYER_GROUP.PITCHER_BENCH
          && p.pos === sameType && isAvailable(p));
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
          ${nextBadge}
          ${roleBadge}
          ${stBadge}
          ${indicator ? `<span class="imp-indicator">${indicator}</span>` : ''}
          ${_dotIndicator(player)}
        </div>
        <div class="player-sub">${posHand} · ${formatAge(player.dob, baseballYear(StateManager.get()))}y · ${formatSalary(player.contractSalary)}${_contractNote(player)}${armNote}</div>
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
    const inj         = player.injury;
    const statusText  = player._pendingILReturn ? 'Cleared'
      : inj?.severity === 'season' ? 'Season'
      : Number.isFinite(inj?.eligibleAt) ? `Elig. ${_dayText(inj.eligibleAt)}`
      : 'TBD';
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
          <div style="font-size:11px;font-weight:700;color:${player._pendingILReturn ? 'var(--text)' : 'var(--muted)'};">
            ${statusText}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// PENDING TRANSACTIONS
// ─────────────────────────────────────────────────────────────

/**
 * _pendingTransactions(state)
 * The user's moves still in flight, from the transaction ledger: a trade that
 * finalizes after today's game, players reporting to us, players we sent away.
 */
function _pendingTransactions(state) {
  const out = [];
  for (const t of state.transactions || []) {
    if (t.status !== 'pending') continue;
    if (t.kind === 'trade' && t.teamId === 'user') out.push({ kind: 'trade', tx: t });
    else if (t.kind === 'arrival' && t.teamId === 'user') out.push({ kind: 'in', tx: t });
    else if (t.kind === 'arrival' && t.fromTeamId === 'user' && t.reason === 'trade') out.push({ kind: 'out', tx: t });
  }
  return out.sort((a, b) => a.tx.effectiveAt - b.tx.effectiveAt);
}

function _renderPendingGroup(pending, players) {
  if (pending.length === 0) {
    return '<div style="padding:10px 14px;font-size:13px;color:var(--muted);">No pending transactions</div>';
  }
  const state = StateManager.get();
  const teamName = (id) => (state.leagueTeams || []).find(t => t.id === id)?.name || id;

  return pending.map(({ kind, tx }) => {
    if (kind === 'trade') {
      const names = (ids) => ids.map(id => players[id]?.name).filter(Boolean).join(', ');
      return `
        <div class="player-row-item" style="grid-template-columns:1fr auto;">
          <div class="player-info">
            <div class="player-name">Trade with ${_escape(teamName(tx.fromTeamId))}</div>
            <div style="font-size:11px;color:var(--muted);">Get ${_escape(names(tx.offer.incomingIds))} · send ${_escape(names(tx.offer.outgoingIds))} — finalizes after today's game</div>
          </div>
          <div class="pending-tag">PENDING</div>
        </div>`;
    }
    const player = players[tx.playerId];
    if (!player) return '';
    const sub = kind === 'in'
      ? `${tx.reason === 'trade' ? `Acquired from ${teamName(tx.fromTeamId)}` : tx.reason === 'callup' ? (tx.by === 'manager' ? 'Called up by the manager' : 'Called up from the farm') : 'Claimed'} — reports ${_whenText(tx.effectiveAt)}`
      : `Traded to ${teamName(tx.teamId)} — reports ${_whenText(tx.effectiveAt)}`;
    return `
      <div class="player-row-item" style="grid-template-columns:1fr auto;" id="pr-${player.id}">
        <div class="player-info">
          <div class="player-name">${_escape(player.name)} <span style="font-size:10px;color:var(--muted);">${player.nativePos || player.pos}</span></div>
          <div style="font-size:11px;color:var(--muted);">${_escape(sub)}</div>
        </div>
        <div class="pending-tag ${kind === 'out' ? 'out' : ''}">${kind === 'in' ? 'INCOMING' : 'OUTGOING'}</div>
      </div>`;
  }).join('');
}

/**
 * _renderOpenSpots(needs, arrivals, allNeeds, state)
 * Dashed cards (§65): one per open active-roster spot (tap → call-up picker)
 * and one per player already on his way (shows who is coming and when).
 */
function _renderOpenSpots(needs, arrivals, allNeeds, state) {
  if (!needs.length && !arrivals.length) return '';
  const players = state.players;
  const label = (n) => n.side === 'pitcher'
    ? (n.pos === 'SP' ? 'Starting pitcher' : 'Relief pitcher')
    : (n.pos ? `Position player — ${n.pos}` : 'Position player');
  const due = allNeeds.deadlineAt ? ` · due ${_clockText(allNeeds.deadlineAt)}` : '';
  return `
    ${arrivals.map(t => {
      const p = players[t.playerId];
      if (!p) return '';
      return `
        <div class="player-row-item vacancy-row arriving" id="pr-${p.id}">
          <div class="player-info">
            <div class="player-name vacancy-name">${_escape(p.name)}</div>
            <div class="player-sub vacancy-sub">${t.reason === 'trade' ? 'Acquired by trade' : 'Called up'} — reports ${_whenText(t.effectiveAt)}</div>
          </div>
          <div class="player-pos-badge vacancy-pos">${p.nativePos || p.pos}</div>
          <div class="rating-cell"><div class="rating-num ${_ovrColor(p.ovr)}">${formatOVR(p.ovr)}</div></div>
          <div class="row-actions"></div>
        </div>`;
    }).join('')}
    ${needs.map(n => `
      <div class="player-row-item vacancy-row" data-need="${n.index}">
        <div class="player-info">
          <div class="player-name vacancy-name">Open spot</div>
          <div class="player-sub vacancy-sub">${label(n)} — tap to call up${due}</div>
        </div>
        <div class="player-pos-badge vacancy-pos">${n.pos || (n.side === 'pitcher' ? 'P' : 'H')}</div>
        <div class="rating-cell"></div>
        <div class="row-actions"><span class="vacancy-plus">+</span></div>
      </div>`).join('')}
  `;
}

function _clockText(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
function _dayText(ms) {
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
/** Between seasons (§70): flag a player whose deal is up — a decision is due. */
function _contractNote(player) {
  const st = StateManager.get();
  if (player.teamId !== 'user') return '';
  if (player.pendingContract) return ' · <span class="contract-note">extended</span>';
  if (player._willWalk) return ' · <span class="contract-note">leaving after season</span>';
  if (!st?.offseason || !contractIsUp(player, st.seasonNum)) return '';
  return ' · <span class="contract-note">contract up</span>';
}

function _whenText(ms) {
  const d = new Date(ms);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString() && d.getHours() === 0) return 'tomorrow';
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

// ─────────────────────────────────────────────────────────────
// FARM SYSTEM (Section 20.3 — LOCKED)
// ─────────────────────────────────────────────────────────────

function _renderFarmGroup(farmPlayers, state, gameIdx, needs = null) {
  const canCallUp = !needs?.applies || needs.short > 0;
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
    ${_farmOpen.hitters ? farmHitters.map(p => _renderFarmRow(p, state, gameIdx, canCallUp)).join('') : ''}

    <!-- Farm Pitchers sub-section -->
    <div class="roster-sub-head" data-farm-group="pitchers" style="cursor:pointer;margin-top:4px;">
      Pitchers
      <span class="roster-chevron ${_farmOpen.pitchers ? 'open' : ''}" style="margin-left:4px;">▼</span>
    </div>
    ${_farmOpen.pitchers ? farmPitchers.map(p => _renderFarmRow(p, state, gameIdx, canCallUp)).join('') : ''}
  `;
}

function _renderFarmRow(player, state, gameIdx, canCallUp = true) {
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
        <div style="font-size:11px;color:var(--muted);">${formatAge(player.dob, baseballYear(StateManager.get()))}y · ${sendDown}${contextNote ? ` · ${contextNote}` : ''}</div>
      </div>
      <div class="rating-cell">
        <div class="rating-num ${ovrColor}" style="font-size:18px;">${formatOVR(player.ovr)}</div>
      </div>
      <div>
        <button class="swap-btn promote${canCallUp ? '' : ' full'}" data-callup="${player.id}" style="font-size:9px;"
          ${canCallUp ? '' : 'title="The active roster is full (28)"'}>Call Up</button>
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
      ? '<span style="font-size:10px;color:var(--text);background:var(--chip-green-bg);padding:2px 6px;border-radius:4px;">Strong</span>'
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
// FINANCES (§78) — Club Funds, the owner, the season's books
// ─────────────────────────────────────────────────────────────

const _OWNER_STAGE_TEXT = {
  content:   ['Content',        'Ownership is happy with the books.'],
  watching:  ['Watching',       'Ownership has noticed the spending. Winning helps.'],
  concerned: ['Concerned',      "No new salary until the books improve."],
  cuts:      ['Ordering cuts',  'Ownership wants payroll down.'],
};

function _renderFinances(state) {
  const u = state.userTeam, fin = u.finances || {};
  const m = (k) => (k < 0 ? `−${formatMoney(-k)}` : formatMoney(k));
  const funds = fin.funds || 0;
  const projected = Finance.projection(state, 'user');
  const payroll = Finance.payrollOf(state, 'user');
  const target = Finance.seasonTarget(fin);
  const room = Math.max(0, Math.round(target * (1 + Finance.tolerance(state)) - payroll));
  const stage = fin.owner?.stage || 'content';
  const [stageName, stageText] = _OWNER_STAGE_TEXT[stage] || _OWNER_STAGE_TEXT.content;
  const order = fin.owner?.order;
  const cal = fin.cal;
  const nextPay = cal && cal.paid < cal.paydays.length ? cal.paydays[cal.paid] : null;
  const inSeason = cal && cal.seasonNum === (state.seasonNum || 1);
  const pct = Math.min(100, Math.round(payroll / Math.max(1, target) * 100));
  // Red only past what ownership tolerates; over the target but tolerated is amber.
  const tolerated = target * (1 + Finance.tolerance(state));
  const barCls = payroll > tolerated && payroll > target ? 'fin-bar-over' : payroll > target || pct > 90 ? 'fin-bar-near' : 'fin-bar-ok';

  const lines = (obj, labels) => Object.entries(obj || {}).filter(([, v]) => v)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div class="fin-line"><span>${_escape(labels[k] || k)}</span><span>${formatMoney(v)}</span></div>`).join('')
    || '<div class="fin-line fin-muted"><span>Nothing yet this season</span><span></span></div>';
  const inc = Object.values(fin.season?.income || {}).reduce((a, b) => a + b, 0);
  const out = Object.values(fin.season?.spend || {}).reduce((a, b) => a + b, 0);

  const homeGames = (state.schedule || []).filter(g => g.isHome && !g.isSpring && g.attendance);
  const avgAtt = homeGames.length ? Math.round(homeGames.reduce((a, g) => a + g.attendance, 0) / homeGames.length) : null;
  const sellouts = homeGames.filter(g => g.sellout).length;

  const recent = [...(fin.ledger || [])].slice(-10).reverse().map(e => `
    <div class="fin-line">
      <span>${_escape(e.label)}<span class="fin-when">${new Date(e.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></span>
      <span class="${e.k < 0 ? 'fin-neg' : 'fin-pos'}">${e.k < 0 ? '−' : '+'}${formatMoney(Math.abs(e.k))}</span>
    </div>`).join('');

  const history = (fin.history || []).slice().reverse().map(h => `
    <div class="fin-line"><span>Season ${h.seasonNum}${h.covered ? ' · owner covered ' + formatMoney(h.covered) : ''}</span>
      <span class="${h.net < 0 ? 'fin-neg' : 'fin-pos'}">${h.net < 0 ? '−' : '+'}${formatMoney(Math.abs(h.net))}</span></div>`).join('');

  return `
    <div class="fin-wrap">
      <div class="fin-card fin-hero">
        <div class="fin-label">Club funds</div>
        <div class="fin-big ${funds < 0 ? 'fin-neg' : ''}">${m(funds)}</div>
        ${inSeason ? `<div class="fin-sub">Projected at season's end: <b class="${projected < 0 ? 'fin-neg' : ''}">${m(projected)}</b></div>` : ''}
        ${nextPay ? `<div class="fin-sub">Next payday: ${new Date(nextPay).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>` : ''}
      </div>

      <div class="fin-card">
        <div class="fin-row-head"><span class="fin-label">Ownership</span><span class="fin-stage fin-stage-${stage}">${stageName}</span></div>
        <div class="fin-sub">${_escape(stageText)}</div>
        ${order ? `<div class="fin-order">Ordered: ${formatMoney(order.amountK)} off the payroll by ${new Date(order.dueAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>` : ''}
      </div>

      <div class="fin-card">
        <div class="fin-row-head"><span class="fin-label">Payroll</span><span>${formatMoney(payroll)} / ${formatMoney(target)} target</span></div>
        <div class="fin-bar"><div class="${barCls}" style="width:${pct}%"></div></div>
        <div class="fin-sub">${room > 0 ? `Ownership would approve about ${formatMoney(room)} more in salary right now.` : 'Ownership won\'t approve more salary right now.'}</div>
      </div>

      <div class="fin-card">
        <div class="fin-row-head"><span class="fin-label">This season</span><span class="${inc - out < 0 ? 'fin-neg' : 'fin-pos'}">${inc - out < 0 ? '−' : '+'}${formatMoney(Math.abs(inc - out))}</span></div>
        <div class="fin-sect">Money in</div>${lines(fin.season?.income, Finance.INCOME_LABELS)}
        <div class="fin-sect">Money out</div>${lines(fin.season?.spend, Finance.SPEND_LABELS)}
      </div>

      ${avgAtt ? `<div class="fin-card">
        <div class="fin-row-head"><span class="fin-label">The ballpark</span><span>${(fin.market?.capacity || 0).toLocaleString()} seats</span></div>
        <div class="fin-sub">Average crowd ${avgAtt.toLocaleString()}${sellouts ? ` · ${sellouts} sellout${sellouts === 1 ? '' : 's'}` : ''} over ${homeGames.length} home game${homeGames.length === 1 ? '' : 's'}.</div>
      </div>` : ''}

      ${recent ? `<div class="fin-card"><div class="fin-label">Recent</div>${recent}</div>` : ''}
      ${history ? `<div class="fin-card"><div class="fin-label">Past seasons</div>${history}</div>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

function _attachListeners(state) {
  // Sub-tab switching
  const pBtn = document.getElementById('tsubtab-players');
  const sBtn = document.getElementById('tsubtab-staff');
  const fBtn = document.getElementById('tsubtab-finances');
  if (fBtn) fBtn.addEventListener('click', () => { _activeTab = 'finances'; refresh(); });
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
          && isAvailable(p)
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

  // Open roster spot (dashed card) → farm call-up picker, best fit first (§65)
  document.querySelectorAll('.vacancy-row[data-need]').forEach(el => {
    el.addEventListener('click', () => {
      const s     = StateManager.get();
      const need  = getRosterNeeds(s, 'user').needs[Number(el.dataset.need)];
      if (!need) { refresh(); return; }
      const ranked = rankCallupCandidates(s, 'user', need);
      if (!ranked.length) {
        App.showToast('Nobody on the farm fits that spot right now.', 'negative');
        return;
      }
      _openReplacementPicker(
        need.side === 'pitcher' ? 'Call up a pitcher — reports tomorrow' : 'Call up a position player — reports tomorrow',
        ranked,
        (player) => { _handleCallUp(player.id, StateManager.get()); }
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
    // One path for every call-up (inbox, dashed card, farm row): the ledger.
    // He reports the next calendar day; any inbox card about this spot is
    // withdrawn by the roster clock (§65).
    const { gmCallUp } = await import('../../engine/GameEngine.js');
    const res = gmCallUp(playerId, Date.now());
    if (!res.ok) {
      App.showToast(res.error || 'Could not make that call-up.', 'negative');
      return;
    }
    EventBus.emit('roster:changed', { type: 'callup', playerId });
    EventBus.emit('inbox:changed', { source: 'team' });
    App.showToast(`${player.name} called up — reports tomorrow.`, 'positive');
    refresh();
  } catch (err) {
    console.error('TeamScreen._handleCallUp:', err);
    App.showToast('Could not process call-up.', 'negative');
  }
}

// ─────────────────────────────────────────────────────────────
// SWAP — modal-driven 1-for-1 exchange
// ─────────────────────────────────────────────────────────────

async function _handleSwap(playerId, role, state) {
  const player = state.players[playerId];
  if (!player) return;
  if (!isAvailable(player)) {
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
        && isAvailable(p)
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
        && p.pos === player.pos && isAvailable(p));

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
  const st = player.injury?.status;
  if (st === 'evaluating') return '<div class="player-status status-il" title="Being evaluated">Eval</div>';
  if (st === 'dtd')        return '<div class="player-status status-il" title="Day-to-day">DTD</div>';
  if (player.isInjured)   return '<div class="player-status status-il">IL</div>';
  if (player.isSuspended) return '<div class="player-status status-inactive">Susp</div>';
  // §71: away for a few games — rest, illness, training, benched, leave.
  const away = player.unavailable;
  if (away) {
    const label = { rest: 'Rest', illness: 'Sick', training: 'Train', benched: 'Sat', suspended: 'Susp', leave: 'Leave' }[away.reason] || 'Away';
    return `<div class="player-status status-inactive" title="${label} — ${away.gamesLeft} game${away.gamesLeft === 1 ? '' : 's'}">${label} ${away.gamesLeft}</div>`;
  }
  // Active: a hitter in his club's lineup (lineupSlots — the source of truth;
  // every active hitter shares the bench group), a pitcher in the rotation or
  // the bullpen. The pitcher bench and the bench bats read "Bench".
  const state = StateManager.get();
  const club  = player.teamId === 'user' ? state?.userTeam : (state?.leagueTeams || []).find(t => t.id === player.teamId);
  const inLineup = (club?.lineupSlots || []).some(sl => sl?.playerId === player.id);
  if (inLineup || player.group === PLAYER_GROUP.STARTING_PITCHERS || player.group === PLAYER_GROUP.BULLPEN) {
    return '<div class="player-status status-active">Active</div>';
  }
  return '<div class="player-status status-bench">Bench</div>';
}

function _dotIndicator(player) {
  return _allStarMark(player) + _statusDot(player);
}

/** §75: an All-Star this season. */
function _allStarMark(player) {
  const season = StateManager.get()?.seasonNum || 1;
  return (player.allStarSeasons || []).includes(season)
    ? `<span class="as-star" title="${(player.allStarMvps || []).includes(season) ? 'All-Star Game MVP' : 'All-Star'}">★</span>` : '';
}

function _statusDot(player) {
  if (player._isNewAcquisition) return '<span class="new-player-dot" title="New"></span>';
  if (player.isSuspended)       return '<span class="suspended-dot" title="Suspended"></span>';
  if (player.condition)         return '<span class="suspended-dot" title="Playing through it"></span>';
  // §71: development in progress — a small arrow with what has landed so far.
  const dev = developmentStatus(StateManager.get(), player.id);
  if (dev.active) return `<span class="dev-arrow" title="In development">▲${dev.appliedActive >= 0.5 ? Math.round(dev.appliedActive) : ''}</span>`;
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
    .keeper-on{color:var(--text);}
    .keeper-off{color:var(--border);}
    .keeper-badge:active{opacity:.6;}

    /* Spring training invitee badge */
    .st-badge{font-size:9px;font-weight:800;letter-spacing:.5px;
      color:var(--text);background:var(--chip-accent-bg);
      border:1px solid var(--accent);border-radius:4px;
      padding:1px 4px;margin-left:5px;vertical-align:middle;}

    .fin-wrap{padding:8px 16px 20px;display:flex;flex-direction:column;gap:10px;}
    .fin-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;}
    .fin-hero{text-align:center;}
    .fin-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
    .fin-big{font-family:'Bebas Neue',sans-serif;font-size:40px;line-height:1.1;color:var(--text);margin:2px 0;}
    .fin-sub{font-size:12px;color:var(--muted);margin-top:4px;}
    .fin-row-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--text);font-weight:600;}
    .fin-stage{font-size:11px;font-weight:800;padding:2px 8px;border-radius:10px;border:1px solid var(--border);}
    .fin-stage-content{color:#22C55E;border-color:#22C55E;}
    .fin-stage-watching{color:#fbbf24;border-color:#fbbf24;}
    .fin-stage-concerned{color:#f97316;border-color:#f97316;}
    .fin-stage-cuts{color:var(--danger);border-color:var(--danger);}
    .fin-order{margin-top:6px;font-size:12px;font-weight:700;color:var(--danger);}
    .fin-bar{height:6px;border-radius:3px;background:var(--surface2);margin-top:8px;overflow:hidden;}
    .fin-bar > div{height:100%;border-radius:3px;}
    .fin-bar-ok{background:#22C55E;} .fin-bar-near{background:#fbbf24;} .fin-bar-over{background:var(--danger);}
    .fin-sect{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin:10px 0 2px;}
    .fin-line{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--text);padding:4px 0;border-top:1px solid var(--border);}
    .fin-line:first-of-type{border-top:none;}
    .fin-muted{color:var(--muted);}
    .fin-when{font-size:11px;color:var(--muted);margin-left:6px;}
    .fin-neg{color:var(--danger);} .fin-pos{color:#22C55E;}
    .rp-role{font-size:9px;font-weight:800;letter-spacing:.5px;border-radius:4px;padding:1px 4px;
      margin-left:5px;vertical-align:middle;color:var(--muted);border:1px solid var(--border);}
    .rp-role-closer{color:#fbbf24;border-color:#fbbf24;}
    .rp-role-setup{color:#60a5fa;border-color:#60a5fa;}
    .arm-tired{color:#fbbf24;}
    .arm-down{color:#f87171;}
    .sp-next-badge{font-size:9px;font-weight:800;letter-spacing:.5px;
      color:#052e1a;background:#34d399;
      border:1px solid #34d399;border-radius:4px;
      padding:1px 4px;margin-left:5px;vertical-align:middle;}

    /* Keeper banner at top of players tab */
    .keeper-banner{display:flex;align-items:center;justify-content:space-between;
      padding:7px 14px;background:var(--chip-accent-bg);
      border-bottom:1px solid var(--accent);font-size:11px;font-weight:700;
      letter-spacing:.5px;text-transform:uppercase;color:var(--text);}
    .keeper-count{font-size:12px;font-weight:800;}
    .keeper-count-full{color:var(--text);}

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
    .vacancy-banner{display:flex;flex-direction:column;gap:2px;margin:8px 12px 4px;padding:8px 12px;border-radius:8px;
      border:1.5px dashed var(--danger);font-size:12px;color:var(--text);background:var(--surface2);}
    .vacancy-deadline{font-size:11px;color:var(--muted);}
    .vacancy-row.arriving{border-color:var(--accent);opacity:.85;cursor:default;}
    .vacancy-row[data-need]{cursor:pointer;}
    .vacancy-plus{font-size:18px;font-weight:700;color:var(--text);padding-right:6px;}
    .pending-tag{font-size:10px;font-weight:700;color:var(--text);padding:5px 0 5px 8px;}
    .pending-tag.out{color:var(--muted);}
    .oop-note{color:var(--danger);}
    .contract-note{color:var(--warning, #f5a524);font-weight:600;}
    .dev-arrow{font-size:9px;font-weight:800;color:var(--success, #22c55e);margin-left:4px;}
    .as-star{font-size:10px;color:#c9971c;margin-left:4px;}
    .player-pos-badge.oop{border-color:var(--danger);color:var(--danger);}
    .swap-btn.full{opacity:.45;}
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
    .sm-slot-label{font-size:14px;font-weight:800;color:var(--text);
      width:36px;flex-shrink:0;text-align:center;}
    .sm-slot-sub{flex:1;font-size:12px;}
    .sm-current{color:var(--text);font-weight:600;}
    .sm-empty{color:var(--text);font-weight:600;}
    .sm-pick-info{flex:1;min-width:0;}
    .sm-pick-name{font-size:13px;font-weight:600;color:var(--text);display:block;}
    .sm-pick-sub{font-size:11px;color:var(--muted);}
    .sm-pick-ovr{font-size:16px !important;flex-shrink:0;}
    .sm-arrow{font-size:16px;color:var(--border);flex-shrink:0;}
  `;
  document.head.appendChild(style);
}
