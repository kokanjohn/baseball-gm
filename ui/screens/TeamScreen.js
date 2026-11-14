/**
 * ui/screens/TeamScreen.js
 * Team tab rendered into #team-content.
 *
 * Two internal tabs (Section 1.14 — LOCKED):
 *   Players — active roster + IL + pending transactions (§122: no farm)
 *   Staff   — coaching staff with contracts and relationships
 *
 * Players (r153, ESPN-fantasy style — no collapsible groups):
 *   Hitters table  — the nine by slot (lineupSlots), the bench, players
 *                    reporting (Pending), open roster spots, the IL.
 *   Pitchers table — SP1–SP5, the bullpen by role, the pitcher bench,
 *                    players reporting, open roster spots, the IL.
 * Slot, name and MOVE are frozen; the line scrolls; IMP and OVR on the right.
 * MOVE carries out RosterEngine.moveOptions through GameEngine.gmMove.
 * Open roster spots (TransactionEngine.getRosterNeeds — the same source the
 * inbox uses) open League → Players with everyone who fits (§122.4).
 *
 * Screen label is "Team" not "Roster" (Section 1.14 — LOCKED).
 */

import * as App          from '../App.js';
import * as EventBus     from '../EventBus.js';
import * as StateManager from '../../store/StateManager.js';
import { baseballYear, isAvailable } from '../../engine/PlayerFactory.js';
import { contractIsUp } from '../../engine/OffseasonEngine.js';
import { developmentStatus, wearOf } from '../../engine/DevelopmentEngine.js';
import { lastSeasonIMP } from '../../engine/IMPEngine.js';
import { armStatus } from '../../engine/PitchingEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { formatMoney, formatOVR, formatAge, formatSalary } from '../formatters.js';
import { PLAYER_GROUP, ROSTER_LIMITS, PHASE, POSITION_RULES } from '../../data/constants.js';
import { eligibleSlotsFor, moveOptions, tradedAway, managerFillAt }
  from '../../engine/RosterEngine.js';
import * as GameEngine from '../../engine/GameEngine.js';
import { getRosterNeeds } from '../../engine/TransactionEngine.js';
import { openPlayerCard } from '../components/PlayerCard.js';
import * as Coach from '../../engine/CoachEngine.js';
import * as When from '../../engine/When.js';
import { posLabel, eligibleAt, pitchRoles } from '../../engine/Positions.js';   // r163 §122.35

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _activeTab   = 'players';
let _mounted     = false;
let _listeners   = [];

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

// Which slots a bench player is eligible to fill (Positions — r163 §122.35).
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
  App.registerTabLeave('roster', () => { _activeTab = 'players'; });   // r155 back on Players next time

  const wire = (event, handler) => {
    EventBus.on(event, handler);
    _listeners.push({ event, handler });
  };

  wire('roster:changed',   () => refresh());
  wire('game:committed',   () => refresh());
  wire('nav:tabActivated', ({ tab }) => { if (tab === 'roster') refresh(); });

  refresh();
}

/** r145 the club funds pill in the header: Team → Finances. */
export function showFinances() {
  _activeTab = 'finances';
  App.switchTab('roster');
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

/**
 * r153 The Players tab, ESPN-fantasy style: one table per side, the slot on
 * the left, the name and MOVE frozen, this season's line scrolling (last
 * season's, marked, before there is one), Impact and the rating on the right.
 *   Hitters:  C 1B 2B 3B SS OF OF OF DH (lineupSlots — the source of truth),
 *             the bench, players reporting (Pending), open roster spots, the IL.
 *   Pitchers: the rotation (SP) and the bullpen (RP), each best-rated first —
 *             who starts next is marked, a reliever's role is on the player
 *             card (r154) — the pitcher bench, players reporting, open roster
 *             spots, the IL.
 * Everyone who reports lands on the bench; an open lineup slot, rotation turn
 * or bullpen spot waits for the GM until the roster deadline (RosterEngine).
 */
const HIT_COLS = [['wear', 'Wear'], ['hab', 'H/AB'], ['r', 'R'], ['hr', 'HR'], ['rbi', 'RBI'], ['bb', 'BB'], ['sb', 'SB'], ['avg', 'AVG'], ['ops', 'OPS']];
const PIT_COLS = [['wear', 'Wear'], ['ip', 'IP'], ['w', 'W'], ['l', 'L'], ['sv', 'SV'], ['era', 'ERA'], ['whip', 'WHIP'], ['k', 'K'], ['bb', 'BB']];

function _renderPlayers(state) {
  const team      = state.userTeam;
  const rosterIds = team.rosterIds || [];
  const players   = state.players || {};
  const impScores = state.impScores || {};
  const slots     = team.lineupSlots || [];
  const isP       = (p) => ['SP', 'RP'].includes(p?.pos);
  const ours      = rosterIds.map(id => players[id]).filter(Boolean);

  const needs     = getRosterNeeds(state, 'user');
  const coming    = _comingPlayers(state);
  const needRows  = (side) => needs.needs.map((n, i) => ({ ...n, index: i })).filter(n => n.side === side);

  // Hitters
  const seated    = new Set(slots.map(s => s.playerId).filter(Boolean));
  const hitBench  = ours.filter(p => !isP(p) && p.group === PLAYER_GROUP.BENCH_HITTERS && !seated.has(p.id)).sort((a, b) => b.ovr - a.ovr);
  const hitIL     = ours.filter(p => !isP(p) && p.group === PLAYER_GROUP.IL);
  const hitRows = [
    ...slots.map((sl, i) => {
      const p = sl.playerId ? players[sl.playerId] : null;
      return p ? _row(state, p, sl.slot, impScores[p.id], { oop: !!(sl.emergency || sl.oop) })
               : _emptyRow(sl.slot, { slotIdx: i });
    }),
    ...hitBench.map((p, i) => _row(state, p, 'Bench', impScores[p.id], { first: i === 0 })),
    ...coming.filter(c => !isP(c.p)).map((c, i) => _row(state, c.p, 'Bench', impScores[c.p.id], { first: !hitBench.length && i === 0, coming: c })),
    ...needRows('hitter').map((n, i) => _needRow(n, needs, { first: !hitBench.length && !coming.some(c => !isP(c.p)) && i === 0 })),
    ...hitIL.map((p, i) => _row(state, p, 'IL', impScores[p.id], { first: i === 0, il: true })),
  ];

  // Pitchers
  const rot       = team.rotation || {};
  const order     = (rot.order || []).map(id => players[id]).filter(p => p && p.group === PLAYER_GROUP.STARTING_PITCHERS);
  const byOvr     = (a, b) => b.ovr - a.ovr;
  const rotation  = ours.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS).sort(byOvr);
  const nextSPId  = order.length ? order[(rot.currentIndex || 0) % order.length].id : null;
  const pen       = ours.filter(p => p.group === PLAYER_GROUP.BULLPEN).sort(byOvr);
  const pBench    = ours.filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH).sort((a, b) => (a.pos === 'SP' ? 0 : 1) - (b.pos === 'SP' ? 0 : 1) || b.ovr - a.ovr);
  const pitIL     = ours.filter(p => isP(p) && p.group === PLAYER_GROUP.IL);
  const comingP   = coming.filter(c => isP(c.p));
  const pitRows = [
    ...rotation.map(p => _row(state, p, 'SP', impScores[p.id], { next: p.id === nextSPId })),
    ...Array.from({ length: Math.max(0, ROSTER_LIMITS.STARTING_PITCHERS - rotation.length) }, () => _emptyRow('SP', { turn: true })),
    ...pen.map((p, i) => _row(state, p, 'RP', impScores[p.id], { first: i === 0 })),
    ...Array.from({ length: Math.max(0, ROSTER_LIMITS.BULLPEN - pen.length) }, (_, i) => _emptyRow('RP', { pen: true, first: !pen.length && i === 0 })),
    ...pBench.map((p, i) => _row(state, p, 'Bench', impScores[p.id], { first: i === 0 })),
    ...comingP.map((c, i) => _row(state, c.p, 'Bench', impScores[c.p.id], { first: !pBench.length && i === 0, coming: c })),
    ...needRows('pitcher').map((n, i) => _needRow(n, needs, { first: !pBench.length && !comingP.length && i === 0 })),
    ...pitIL.map((p, i) => _row(state, p, 'IL', impScores[p.id], { first: i === 0, il: true })),
  ];

  const vacancyBanner = needs.short > 0 ? `
    <div class="vacancy-banner">
      <span><b>${needs.short} open roster spot${needs.short > 1 ? 's' : ''}</b> — tap Add to see the free agents who fit.</span>
      ${needs.deadlineAt ? `<span class="vacancy-deadline">Due ${_clockText(needs.deadlineAt)} or ${_escape(team.coachingStaff?.manager?.name || 'the manager')} signs someone</span>` : ''}
    </div>` : '';

  return `
    <div class="tr-players">
      ${vacancyBanner}
      ${_table('Hitters', HIT_COLS, hitRows, _seasonLabel(state, ours.filter(p => !isP(p))))}
      ${_table('Pitchers', PIT_COLS, pitRows, _seasonLabel(state, ours.filter(isP)))}
    </div>`;
}

function _table(title, cols, rows, season) {
  return `
    <div class="tr-block">
      <div class="tr-title"><span>${title}</span>${season ? `<span class="tr-season">${season}</span>` : ''}</div>
      <div class="tr-scroll">
        <div class="tr-head">
          <div class="tr-fz"><div class="tr-slot">Slot</div><div class="tr-name">Player</div><div class="tr-act">Action</div></div>
          ${cols.map(([k, l]) => `<div class="tr-td tr-c-${k}">${l}</div>`).join('')}
          <div class="tr-td tr-c-imp">IMP</div><div class="tr-td tr-c-ovr">OVR</div>
        </div>
        ${rows.join('')}
      </div>
    </div>`;
}

/**
 * Players on their way to us (§65): signed, claimed or traded (reporting the
 * next day), and the players coming back in a trade that goes through after
 * tonight's final out. They report to the bench.
 */
function _comingPlayers(state) {
  const out = [];
  for (const t of state.transactions || []) {
    if (t.status !== 'pending') continue;
    if (t.kind === 'arrival' && t.teamId === 'user') {
      const p = state.players[t.playerId];
      if (p) out.push({ p, sub: `Reports ${_whenText(t.effectiveAt)}` });
    } else if (t.kind === 'trade' && (t.teamId || 'user') === 'user') {
      for (const id of t.offer?.incomingIds || []) if (state.players[id]) out.push({ p: state.players[id], sub: 'Joins after the game' });
    }
  }
  return out;
}

/** The line a row shows: this season's, or — with none yet — last season's (and its year). */
function _statsShown(p) {
  const s = p.stats || {};
  if ((s.ab || 0) > 0 || (s.ip || 0) > 0 || (s.outs || 0) > 0) return { s, year: null };
  const last = (p.seasonLog || []).filter(e => e?.stats).at(-1);
  return last ? { s: last.stats, year: last.year } : { s, year: null };
}

const _f3 = (x) => x.toFixed(3).replace(/^0(?=\.)/, '');
function _statVal(p, s, key) {
  const pitcher = ['SP', 'RP'].includes(p.pos);
  const outs = s.outs || Math.round((s.ip || 0) * 3);
  const ip = outs / 3;
  if (pitcher) {
    if (key === 'ip')   return outs ? `${Math.floor(outs / 3)}.${outs % 3}` : '--';
    if (key === 'era')  return ip > 0 ? ((s.er || 0) * 9 / ip).toFixed(2) : '--';
    if (key === 'whip') return ip > 0 ? (((s.h_allowed || 0) + (s.bb || 0)) / ip).toFixed(2) : '--';
    if (!outs) return '--';
    return String(s[key] || (key === 'w' ? s.wins || 0 : 0));
  }
  const ab = s.ab || 0;
  if (key === 'hab') return ab ? `${s.h || 0}/${ab}` : '--/--';
  if (!ab) return '--';
  if (key === 'avg') return _f3((s.h || 0) / ab);
  if (key === 'ops') {
    // (a hit-by-pitch counts in bb as well as hbp — SimEngine)
    const pa = ab + (s.bb || 0) + (s.sf || 0);
    const obp = pa ? ((s.h || 0) + (s.bb || 0)) / pa : 0;
    const tb = s.tb ?? ((s.h || 0) + (s.doubles || 0) + 2 * (s.triples || 0) + 3 * (s.hr || 0));
    return _f3(obp + tb / ab);
  }
  return String(s[key] || 0);
}

function _statCells(p, imp) {
  const cols = ['SP', 'RP'].includes(p.pos) ? PIT_COLS : HIT_COLS;
  const { s } = _statsShown(p);
  const now = imp?.impS;
  const v = now ?? lastSeasonIMP(p);
  const impHtml = v == null ? '<span class="tr-imp">--</span>'
    : `<span class="tr-imp ${v >= 1 ? 'tr-imp-pos' : v <= -1 ? 'tr-imp-neg' : ''}" title="${now == null ? 'Last season' : 'This season'}">${v > 0 ? '+' : ''}${v.toFixed(1)}</span>`;
  return cols.map(([k]) => `<div class="tr-td tr-c-${k}">${k === 'wear' ? _wearCell(p) : _statVal(p, s, k)}</div>`).join('')
    + `<div class="tr-td tr-c-imp">${impHtml}</div>`
    + `<div class="tr-td tr-c-ovr"><span class="rating-num ${_ovrColor(p.ovr)}">${formatOVR(p.ovr)}</span></div>`;
}

/**
 * r160 §122.32 wear: a short meter and the word (Fresh, Fine, Tiring, Tired, Worn
 * down) — the first column, so it shows without scrolling. r161 §122.33 pitchers
 * too (the arm's workload); the bar is full and green when fresh and shrinks
 * toward the left as the wear builds, changing color by level.
 */
function _wearCell(p) {
  if (p.group === PLAYER_GROUP.IL) return '<span class="tr-muted">--</span>';
  const w = wearOf(p, Date.now());
  const tip = w.pitcher ? `Workload: ${w.word}` : w.straight ? `${w.straight} straight start${w.straight === 1 ? '' : 's'}` : 'No recent starts';
  return `<span class="tr-wear tr-wear-${w.level}" title="${tip}">`
    + `<span class="tr-wear-bar"><i style="width:${Math.max(6, Math.round(w.left * 100))}%"></i></span>`
    + `<span class="tr-wear-word">${w.level === 'worn' ? 'Worn' : w.word}</span></span>`;
}

const _blankCells = (cols) => cols.map(([k]) => `<div class="tr-td tr-c-${k}"></div>`).join('') + '<div class="tr-td tr-c-imp"></div><div class="tr-td tr-c-ovr"></div>';

/** One of our players: slot, name (with marks and tags), MOVE, the line. */
function _row(state, p, slot, imp, { first = false, il = false, coming = null, oop = false, next = false } = {}) {
  const traded = !coming && tradedAway(state, p.id);
  const canMove = !coming && !il && moveOptions(state, p.id).length > 0;
  const shown = _statsShown(p);
  const pitcher = ['SP', 'RP'].includes(p.pos);
  const pos = pitcher ? `${posLabel(p)} · ${p.hand === 'L' ? 'L' : 'R'}` : posLabel(p);   // r167 SP/RP
  // The sub-line: position (and hand), then what matters about the row today.
  // A row with a status (reporting, traded, on the IL) shows that alone, so it fits.
  const subBits = [];
  if (coming) subBits.push(`<span class="tr-pend">Pending</span>`, _escape(coming.sub.replace(/^Reports /, '')));
  else if (traded) subBits.push('<span class="tr-hurt">Traded</span>', 'leaves tonight');
  else if (il) subBits.push(`<span class="tr-hurt">${_escape(_ilText(p))}</span>`);
  else {
    subBits.push(pos);
    // r164 §122.35 working toward a new position: its regular-season starts so far
    // r167 §122.35 a pitcher working toward a designation, or out of role where he is
    if (pitcher) {
      const roles = pitchRoles(p), s = p.positions || {};
      if (!roles.includes('RP') && (s.relief || 0) > 0) subBits.push(`<span class="tr-learn">RP ${s.relief}/${POSITION_RULES.pitch.gainRelief}</span>`);
      if (!roles.includes('SP') && (s.starts || 0) > 0) subBits.push(`<span class="tr-learn">SP ${s.starts}/${POSITION_RULES.pitch.gainStarts}</span>`);
      const inRot = (state.userTeam.rotation?.order || []).includes(p.id);
      if ((inRot && !roles.includes('SP')) || (p.group === PLAYER_GROUP.BULLPEN && !roles.includes('RP'))) subBits.push('<span class="tr-hurt">out of role</span>');
    }
    if (!pitcher) for (const [x, n] of Object.entries(p.positions?.starts || {})) {
      if (x !== 'DH' && n > 0 && !eligibleAt(p).includes(x)) subBits.push(`<span class="tr-learn">${x} ${n}/10</span>`);
    }
    if (next) subBits.push('<span class="tr-next" title="Starts the next game">Next</span>');
    const st = _statusWord(p);
    if (st) subBits.push(`<span class="tr-hurt">${st}</span>`);
    if (oop) subBits.push('<span class="tr-hurt">out of position</span>');
    if (pitcher && isAvailable(p) && slot !== 'Bench' && !slot.startsWith('SP')) {
      const arm = armStatus(p, Date.now()).status;
      if (arm === 'down') subBits.push('<span class="tr-hurt">resting today</span>');
      if (arm === 'tired') subBits.push('<span class="tr-warn">tired</span>');
    }
    const cn = _contractNote(p);
    if (cn) subBits.push(cn.replace(/^ · /, ''));
    if (shown.year && _rowMarksYear(state, p)) subBits.push(`<span class="tr-ly">'${String(shown.year).slice(-2)}</span>`);
  }
  return `
    <div class="tr-row${first ? ' tr-first' : ''}${coming ? ' tr-coming' : ''}" data-player="${p.id}">
      <div class="tr-fz">
        <div class="tr-slot${oop ? ' tr-oop' : ''}">${slot}</div>
        <div class="tr-name">
          <div class="tr-name-line">${_escape(p.name)}${_dotIndicator(p)}</div>
          <div class="tr-sub">${subBits.join(' · ')}</div>
        </div>
        <div class="tr-act"><button class="tr-move" data-move="${p.id}"${canMove ? '' : ' disabled'}>MOVE</button></div>
      </div>
      ${_statCells(p, imp)}
    </div>`;
}

/** An open lineup slot, rotation turn or bullpen spot: tap to fill it from the bench. */
function _emptyRow(slot, { slotIdx = null, turn = false, pen = false, first = false } = {}) {
  const cols = turn || pen ? PIT_COLS : HIT_COLS;
  const attr = slotIdx != null ? `data-fill-slot="${slotIdx}"` : turn ? 'data-fill-turn="1"' : 'data-fill-pen="1"';
  return `
    <div class="tr-row tr-empty${first ? ' tr-first' : ''}" ${attr}>
      <div class="tr-fz">
        <div class="tr-slot">${slot}</div>
        <div class="tr-name"><div class="tr-name-line tr-muted">Empty</div><div class="tr-sub">Tap to fill</div></div>
        <div class="tr-act"></div>
      </div>
      ${_blankCells(cols)}
    </div>`;
}

/** §65 / §122.4 an open roster spot: Add opens League → Players with everyone who fits. */
function _needRow(n, needs, { first = false } = {}) {
  const what = n.side === 'pitcher' ? (n.pos === 'SP' ? 'Find a starter' : 'Find a reliever') : (n.pos ? `Find a ${n.pos}` : 'Find a bat');
  const due = '';   // (the deadline is in the banner above)
  return `
    <div class="tr-row tr-need${first ? ' tr-first' : ''}" data-need="${n.index}">
      <div class="tr-fz">
        <div class="tr-slot">${n.pos || (n.side === 'pitcher' ? 'P' : 'H')}</div>
        <div class="tr-name"><div class="tr-name-line">Open spot</div><div class="tr-sub">${what}${due}</div></div>
        <div class="tr-act"><button class="tr-move tr-add" data-need-add="${n.index}">ADD</button></div>
      </div>
      ${_blankCells(n.side === 'pitcher' ? PIT_COLS : HIT_COLS)}
    </div>`;
}

/** On the IL: when they can come back (what it is is on the player card). */
function _ilText(p) {
  const inj = p.injury;
  return p._pendingILReturn ? 'Cleared'
    : inj?.severity === 'season' ? 'Out for the season'
    : Number.isFinite(inj?.eligibleAt) ? (inj.eligibleAt <= Date.now() ? 'Eligible now' : `Elig. ${_dayText(inj.eligibleAt)}`)
    : 'Timeline TBD';
}

/**
 * The table's season, beside its title: "This season" once anyone on that side
 * has played this season (a row still on last season's line is marked '25),
 * else last season's year ("'25 season") with no mark on every row.
 */
function _seasonLabel(state, list) {
  const any = list.some(p => _statsShown(p).year == null && _hasLine(p));
  if (any) return 'This season';
  const yr = list.map(p => _statsShown(p).year).find(Boolean);
  return yr ? `'${String(yr).slice(-2)} season` : '';
}
const _hasLine = (p) => { const s = p.stats || {}; return (s.ab || 0) > 0 || (s.ip || 0) > 0 || (s.outs || 0) > 0; };
/** A row marks its year only when its table is on this season. */
function _rowMarksYear(state, p) {
  const ids = state.userTeam.rosterIds || [];
  const side = ['SP', 'RP'].includes(p.pos);
  return ids.map(id => state.players[id]).some(q => q && ['SP', 'RP'].includes(q.pos) === side && _hasLine(q));
}

/** Not available today, in a word (day-to-day, being evaluated, rest, suspended…). */
function _statusWord(p) {
  const st = p.injury?.status;
  if (st === 'evaluating') return 'being evaluated';
  if (st === 'dtd')        return 'day-to-day';
  if (p.isInjured)         return 'injured';
  if (p.isSuspended)       return 'suspended';
  const away = p.unavailable;
  if (away) {
    const what = { rest: 'resting', illness: 'sick', training: 'training', benched: 'sat down', suspended: 'suspended', leave: 'on leave', 'sim game': 'after a sim game' }[away.reason] || 'away';
    // r159 away for a stretch of days (focused work, a program): back by the clock, not a game count.
    if (away.untilMs) { const d = Math.max(1, Math.ceil((away.untilMs - Date.now()) / 86_400_000)); return `${what}, ${d} day${d === 1 ? '' : 's'}`; }
    return `${what}, ${away.gamesLeft} game${away.gamesLeft === 1 ? '' : 's'}`;
  }
  return '';
}

function _clockText(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
/** r149 relative, never a calendar date: "tomorrow", "Saturday", "in 9 days". */
function _dayText(ms) {
  return When.untilDay(ms, Date.now());
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
  return When.untilDay(ms, Date.now());   // r149 "tomorrow", "Saturday", "in 9 days"
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
    { key: 'scoutingDirector', label: 'Scouting Director', role: 'Front Office', data: staff.scoutingDirector },
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


    if (data.vacant) {
      return `
      <div class="staff-card">
        <div class="staff-card-left">
          <div class="staff-card-name">Vacant</div>
          <div class="staff-card-role">${label}${data.prev ? ` · ${_escape(data.prev)} is gone` : ''}</div>
        </div>
        <div class="staff-card-meta"><span style="font-size:10px;font-weight:700;color:var(--danger);background:var(--chip-red-bg);padding:2px 6px;border-radius:4px;">Hiring</span></div>
      </div>`;
    }
    // r145 the card: name, job, salary, contract. Rating, specialty and the rest open in a sheet (tap).
    return `
      <button class="staff-card staff-card-tap" data-staff="${key}" aria-label="${_escape(data.name || label)}, ${label}">
        <div class="staff-card-left">
          <div class="staff-card-name">${_escape(data.name || label)}</div>
          <div class="staff-card-role">${label}</div>
        </div>
        <div class="staff-card-meta">
          <span class="staff-salary">${formatSalary(data.salary || 0)}/yr</span>
          ${contractTag}
        </div>
      </button>
    `;
  }).join('');

  return `<div style="padding:8px 16px 16px;">${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────
// FINANCES (§78) — Club Funds, the owner, the season's books
// ─────────────────────────────────────────────────────────────

/** §112.4 the winter's front-office decisions, as they stand: prices, the campaign, the facilities. */
function _ballparkExtras(state) {
  const u = state.userTeam || {}, fin = u.finances || {};
  const bits = [];
  const tp = fin.ticketPrice || 1;
  if (Math.abs(tp - 1) >= 0.005) bits.push(`Ticket prices ${Math.round(Math.abs(tp - 1) * 100)}% ${tp > 1 ? 'above' : 'below'} where they started`);
  if (fin.campaign?.season >= (state.seasonNum || 1)) bits.push(`season-ticket campaign: about ${Math.round(fin.campaign.fill * (fin.market?.capacity || 0)).toLocaleString()} more fans a game${fin.campaign.season > (state.seasonNum || 1) ? ' next season' : ''}`);
  const f = u.facilities || {};
  if (f.concourse) bits.push(`concourse upgrades ${f.concourse} of 3`);
  if (f.training) bits.push(`training center ${f.training} of 3`);
  return bits.length ? `<div class="fin-sub">${_escape(bits.join(' · ').replace(/^./, c => c.toUpperCase()))}.</div>` : '';
}

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
  const room = Math.max(0, Math.round(Finance.payrollRoom(state)));
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
      <span>${_escape(e.label)}<span class="fin-when">${When.agoDay(e.at, Date.now())}</span></span>
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
        ${nextPay ? `<div class="fin-sub">Next payday: ${When.untilDay(nextPay, Date.now())}</div>` : ''}
      </div>

      <div class="fin-card">
        <div class="fin-row-head"><span class="fin-label">Ownership</span><span class="fin-stage fin-stage-${stage}">${stageName}</span></div>
        <div class="fin-sub">${_escape(stageText)}</div>
        ${order ? `<div class="fin-order">Ordered: ${formatMoney(order.amountK)} off the payroll ${(() => { const u = When.untilDay(order.dueAt, Date.now()); return u.startsWith('in ') ? u : `by ${u}`; })()}</div>` : ''}
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
        ${_ballparkExtras(state)}
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
  // r145 a staff card opens the staff member's sheet.
  document.querySelectorAll('.staff-card-tap[data-staff]').forEach(el => {
    el.addEventListener('click', () => _openStaffSheet(StateManager.get(), el.dataset.staff));
  });

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

  // r153 MOVE: where this player can go (RosterEngine.moveOptions).
  document.querySelectorAll('.tr-move[data-move]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      App.playClick();
      _openMoveSheet(btn.dataset.move);
    });
  });

  // An empty lineup slot, rotation turn or bullpen spot: who on the bench can fill it.
  document.querySelectorAll('.tr-empty').forEach(el => {
    el.addEventListener('click', () => {
      App.playClick();
      const st = StateManager.get();
      const idx = el.dataset.fillSlot != null ? Number(el.dataset.fillSlot) : null;
      const key = idx != null ? `slot:${idx}` : el.dataset.fillTurn ? 'turn:new' : 'pen:new';
      const label = idx != null ? `the ${st.userTeam.lineupSlots[idx]?.slot} slot` : el.dataset.fillTurn ? 'the open rotation spot' : 'the open bullpen spot';
      // (the bench only: r167 MOVE offers a starter the bullpen too, but filling one hole shouldn't open another;
      //  those holding the role first, out of role after)
      const seated = new Set((st.userTeam.lineupSlots || []).map(sl => sl.playerId).filter(Boolean));
      const onBench = (p) => p.group === PLAYER_GROUP.PITCHER_BENCH || (p.group === PLAYER_GROUP.BENCH_HITTERS && !seated.has(p.id));
      const optFor = (p) => moveOptions(st, p.id).find(o => o.key === key);
      const who = (st.userTeam.rosterIds || []).map(id => st.players[id]).filter(p => p && onBench(p) && optFor(p))
        .sort((a, b) => (!!optFor(a).oop - !!optFor(b).oop) || (b.ovr - a.ovr));
      if (!who.length) { App.showToast(`Nobody on the bench can fill ${label}.`, 'negative'); return; }
      _showSwapSheet(`Fill ${_escape(label)}`, null, who.map(p => `
        <div class="sm-row" data-pick="${p.id}">
          <div class="sm-pick-info"><span class="sm-pick-name">${_escape(p.name)}</span>
            <span class="sm-pick-sub">${posLabel(p)}${optFor(p).oop ? ` · <span class="sm-oop-tag">Out of ${['SP', 'RP'].includes(p.pos) ? 'role' : 'position'}</span>` : ''}</span></div>
          <span class="rating-num ${_ovrColor(p.ovr)} sm-pick-ovr">${p.ovr}</span>
        </div>`).join(''), (overlay) => {
        overlay.querySelectorAll('.sm-row[data-pick]').forEach(row => row.addEventListener('click', () => {
          App.playClick(); overlay.remove(); _doMove(row.dataset.pick, key);
        }));
      });
    });
  });

  // Open roster spot → §122.4 League → Players: everyone we could add who fits it
  document.querySelectorAll('.tr-need').forEach(el => {
    el.addEventListener('click', async () => {
      const need = getRosterNeeds(StateManager.get(), 'user').needs[Number(el.dataset.need)];
      if (!need) { refresh(); return; }
      App.playClick();
      const League = await import('./LeagueScreen.js');
      League.showAvailable({ side: need.side, pos: need.pos });
    });
  });

  // A row → the player's card (age, contract and the rest live there).
  document.querySelectorAll('.tr-row[data-player]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tr-move')) return;
      openPlayerCard(el.dataset.player, StateManager.get());
    });
  });
}

// ─────────────────────────────────────────────────────────────
// MOVE (r153) — one sheet of where a player can go
// ─────────────────────────────────────────────────────────────

function _openMoveSheet(playerId) {
  const st = StateManager.get();
  const p = st.players[playerId];
  const opts = moveOptions(st, playerId);
  if (!p || !opts.length) { refresh(); return; }
  const deadline = managerFillAt(st);
  const leaves = opts.some(o => o.key === 'bench');
  const row = (o) => `
    <div class="sm-row${o.oop ? ' sm-oop' : ''}" data-key="${o.key}">
      <div class="sm-slot-label${['SP', 'RP'].includes(p.pos) ? ' sm-wide' : ''}">${_escape(o.label)}</div>
      <div class="sm-slot-sub">${o.oop ? `<span class="sm-oop-tag">Out of ${['SP', 'RP'].includes(p.pos) ? 'role' : 'position'}</span> ` : ''}<span class="${o.detail === 'Open' ? 'sm-empty' : 'sm-current'}">${_escape(o.detail)}</span></div>
    </div>`;
  // r165 §122.35 the spots he's eligible at first; out-of-position spots behind a button, clearly lesser choices
  const elig = opts.filter(o => !o.oop), oop = opts.filter(o => o.oop);
  // (r167 a pitcher's are out of role)
  const arm = ['SP', 'RP'].includes(p.pos);
  const oopWord = (show) => `${show ? 'Show' : 'Hide'} out-of-${arm ? 'role' : 'position'} spots`;
  const rows = elig.map(row).join('')
    + (oop.length ? `<button class="sm-oop-toggle" type="button">${oopWord(true)} (${oop.length})</button>
       <div class="sm-oop-list" hidden>${oop.map(row).join('')}</div>` : '')
    + (leaves && deadline ? `<div class="sm-note">An open spot waits for you until ${_clockText(deadline)}, an hour before first pitch. Then ${_escape(st.userTeam.coachingStaff?.manager?.name || 'the manager')} fills it from the bench.</div>` : '');
  const pos = posLabel(p);
  _showSwapSheet(`Move ${_escape(p.name)}`, `${pos} · OVR ${p.ovr}`, rows, (overlay) => {
    overlay.querySelectorAll('.sm-row[data-key]').forEach(row => row.addEventListener('click', () => {
      App.playClick(); overlay.remove(); _doMove(playerId, row.dataset.key);
    }));
    overlay.querySelector('.sm-oop-toggle')?.addEventListener('click', (e) => {
      App.playClick();
      const list = overlay.querySelector('.sm-oop-list');
      list.hidden = !list.hidden;
      e.currentTarget.textContent = list.hidden ? `${oopWord(true)} (${oop.length})` : oopWord(false);
    });
  });
}

function _doMove(playerId, key) {
  const res = GameEngine.gmMove(playerId, key);
  if (!res.ok) { App.showToast(res.reason, 'negative'); refresh(); return; }
  EventBus.emit('roster:changed', { type: 'move' });
  const ropt = _calcRopt(StateManager.get());
  if (ropt.hitterScore >= 100 && ropt.pitcherScore >= 100) App.playSoundPositive();
  refresh();
}

const STAFF_LABELS = { manager: 'Manager', pitchingCoach: 'Pitching Coach', hittingCoach: 'Hitting Coach', benchCoach: 'Bench Coach',
                       bullpenCoach: 'Bullpen Coach', scoutingDirector: 'Scouting Director' };

/** r145 a staff member's sheet: rating and specialty (coaches and the scouting director), background, pay, contract, the relationship. */
function _openStaffSheet(state, key) {
  const d = state.userTeam?.coachingStaff?.[key];
  if (!d || d.vacant) return;
  const season = state.seasonNum || 1;
  const left = (d.contractExpiry || season) - season;
  const cap = (w) => w ? w[0].toUpperCase() + w.slice(1) : '';
  const rel = d.relationship ?? d.gmRelationship ?? 50;
  const relWord = rel >= 70 ? 'Strong' : rel >= 55 ? 'Good' : rel > 30 ? 'Neutral' : 'Strained';
  const row = (label, value, sub = '') => `
    <div class="staff-sheet-row"><div class="staff-sheet-label">${label}</div>
      <div class="staff-sheet-value">${value}${sub ? `<div class="staff-sheet-sub">${sub}</div>` : ''}</div></div>`;
  const words = Coach.specialtyWords(key, d.specialty);
  const rows = [
    Number.isFinite(d.quality) ? row('Rating', `${cap(Coach.qualityWord(d.quality))} (${d.quality})`) : '',
    d.specialty ? row('Specialty', _escape(cap(Coach.specialtyShort(d.specialty))), words ? _escape(cap(words.replace(/^an? [^:]+: /, ''))) : '') : '',
    d.background ? row('Background', _escape(cap(d.background))) : '',
    row('Salary', `${formatSalary(d.salary || 0)} a year`),
    row('Contract', left <= 0 ? 'Final year' : `${left} year${left === 1 ? '' : 's'} left`, `Through season ${d.contractExpiry || season}`),
    row('Relationship with you', relWord),
  ].join('');
  _showSwapSheet(_escape(d.name || STAFF_LABELS[key]), STAFF_LABELS[key] || '', `<div class="staff-sheet">${rows}</div>`, () => {});
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
    .imp-note{font-weight:700;} .imp-note.imp-pos{color:#22C55E;} .imp-note.imp-neg{color:var(--danger);}

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

    /* r153 the roster tables (ESPN-fantasy style): slot, name and MOVE frozen; the line scrolls */
    .tr-players{padding:0 0 16px;}
    .tr-block{margin-top:10px;}
    .tr-title{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;font-weight:800;letter-spacing:1.2px;
      text-transform:uppercase;color:var(--text);padding:6px 16px 6px;}
    .tr-season{font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:none;color:var(--muted);}
    .tr-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;border-top:1px solid var(--border);}
    .tr-scroll::-webkit-scrollbar{height:3px;}
    .tr-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px;}
    .tr-head,.tr-row{display:flex;align-items:stretch;min-width:max-content;border-bottom:1px solid var(--border);}
    .tr-head{background:var(--surface2);}
    .tr-row{cursor:pointer;}
    .tr-row:active .tr-fz,.tr-row:active .tr-td{background:var(--surface2);}
    .tr-row.tr-first{border-top:2px solid var(--border);}
    .tr-fz{position:sticky;left:0;z-index:2;display:flex;align-items:center;flex-shrink:0;width:206px;
      background:var(--bg);border-right:1px solid var(--border);}
    .tr-head .tr-fz{background:var(--surface2);z-index:3;}
    .tr-head .tr-fz > div,.tr-head .tr-td{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;
      color:var(--muted);white-space:nowrap;padding-top:6px;padding-bottom:6px;}
    .tr-slot{width:46px;flex-shrink:0;padding-left:10px;box-sizing:border-box;font-size:11px;font-weight:600;color:var(--soft);white-space:nowrap;}
    .tr-slot.tr-oop{color:var(--danger);}
    .tr-name{width:98px;flex-shrink:0;min-width:0;padding:7px 4px 7px 2px;}
    .tr-name-line{font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .tr-sub{font-size:10px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .tr-act{width:62px;flex-shrink:0;display:flex;justify-content:center;padding-right:6px;}
    .tr-move{font-family:'DM Sans',sans-serif;font-size:10px;font-weight:800;letter-spacing:.6px;color:var(--link);
      background:transparent;border:1.5px solid var(--link);border-radius:12px;padding:4px 0;width:54px;cursor:pointer;}
    .tr-move:active{opacity:.6;}
    .tr-move:disabled{color:var(--muted);border-color:var(--border);opacity:.6;cursor:default;}
    .tr-td{width:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--soft);
      font-variant-numeric:tabular-nums;background:var(--bg);}
    .tr-head .tr-td{background:var(--surface2);}
    .tr-c-hab{width:50px;} .tr-c-whip{width:42px;} .tr-c-avg,.tr-c-ops,.tr-c-era{width:42px;}
    .tr-learn{color:#3b82f6;font-weight:700;}
    .tr-c-wear{width:52px;}
    .tr-wear{display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;padding:0 6px;}
    .tr-wear-bar{display:block;width:100%;height:4px;border-radius:2px;background:var(--surface2);overflow:hidden;}
    .tr-wear-bar i{display:block;height:100%;border-radius:2px;background:#34C97A;}
    .tr-wear-word{font-size:9px;font-weight:700;letter-spacing:.2px;color:var(--soft);}
    .tr-wear-tiring .tr-wear-bar i{background:#e0a800;} .tr-wear-tiring .tr-wear-word{color:#d49b00;}
    .tr-wear-tired .tr-wear-bar i{background:#f97316;} .tr-wear-tired .tr-wear-word{color:#f97316;}
    .tr-wear-worn .tr-wear-bar i{background:var(--danger);} .tr-wear-worn .tr-wear-word{color:var(--danger);}
    .tr-c-imp{width:46px;} .tr-c-ovr{width:40px;padding-right:6px;}
    .tr-c-imp,.tr-head .tr-c-imp{border-left:1px solid var(--border);}
    .tr-c-ovr .rating-num{font-size:13px;font-weight:800;}
    .tr-imp{font-size:10px;font-weight:800;color:var(--muted);}
    .tr-imp-pos{color:#22C55E;} .tr-imp-neg{color:var(--danger);}
    .tr-pend{color:var(--warning,#f5a524);font-weight:700;}
    .tr-next{color:#22C55E;font-weight:700;}
    .tr-coming .tr-name-line{color:var(--soft);}
    .tr-hurt{color:var(--danger);} .tr-warn{color:#fbbf24;} .tr-ly{color:var(--muted);font-style:italic;}
    .tr-muted{color:var(--muted);font-style:italic;font-weight:500;}
    .tr-empty .tr-fz{background:var(--surface);}
    .tr-need .tr-fz{background:var(--surface);}
    .tr-need .tr-slot,.tr-empty .tr-slot{color:var(--muted);}
    .sm-note{font-size:12px;color:var(--muted);padding:12px 20px;line-height:1.45;}

    /* Swap modal rows */
    .sm-row{display:flex;align-items:center;gap:10px;padding:12px 20px;
      border-bottom:1px solid var(--border);cursor:pointer;}
    .sm-row:active{background:var(--surface2);}
    .sm-slot-label{font-size:14px;font-weight:800;color:var(--text);
      width:36px;flex-shrink:0;text-align:center;}
    .sm-slot-label.sm-wide{width:78px;text-align:left;font-size:13px;line-height:1.25;}   /* r167 Rotation, Bullpen, Pitcher bench */
    .sm-slot-sub{flex:1;font-size:12px;}
    .sm-current{color:var(--text);font-weight:600;}
    .sm-empty{color:var(--text);font-weight:600;}
    .sm-oop-toggle{display:block;width:calc(100% - 40px);margin:12px 20px 6px;padding:11px;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--soft);font-size:13px;font-weight:600;}
    .sm-oop .sm-slot-label{color:var(--muted);}
    .sm-oop-tag{font-size:10px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:#d49b00;}
    .sm-pick-info{flex:1;min-width:0;}
    .sm-pick-name{font-size:13px;font-weight:600;color:var(--text);display:block;}
    .sm-pick-sub{font-size:11px;color:var(--muted);}
    .sm-pick-ovr{font-size:16px !important;flex-shrink:0;}
    .sm-arrow{font-size:16px;color:var(--border);flex-shrink:0;}
  `;
  document.head.appendChild(style);
}
