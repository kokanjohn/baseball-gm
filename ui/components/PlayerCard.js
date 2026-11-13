/**
 * ui/components/PlayerCard.js
 * Full player detail modal sheet.
 *
 * Triggered by tapping a player row in TeamScreen or LeagueScreen.
 * Slides up as a bottom sheet over the current screen.
 *
 * Shows:
 *   - Name, position, age, handedness, team
 *   - OVR with sub-ratings radar (placeholder until a radar chart
 *     sub-rating mode is built — Phase 13 radar pass)
 *   - Contract: salary, years remaining, expiry
 *   - Season stats (batting or pitching depending on position)
 *   - IMP trend: 7-day, 15-day, 30-day, season
 *   - Trait label
 *   - GM relationship bar
 *   - Career: the seasons before this one (§122.9), or why there are none
 *
 * Section 1.11b: No premium gating. All data shown regardless of tier.
 *
 * Usage:
 *   import { openPlayerCard, closePlayerCard } from '../components/PlayerCard.js';
 *   openPlayerCard(playerId, state);
 */

import * as FreeAgency from '../../engine/FreeAgency.js';
import { formatOVR, formatAge, formatSalary, formatIMP, formatAVG, formatERA } from '../formatters.js';
import { getImpLabel, lastSeasonIMP } from '../../engine/IMPEngine.js';
import { PHASE, PLAYER_GROUP } from '../../data/constants.js';
import { bullpenRoles, armStatus } from '../../engine/PitchingEngine.js';
import * as StateManager from '../../store/StateManager.js';
import { baseballYear, computeAge } from '../../engine/PlayerFactory.js';
import { wearOf } from '../../engine/DevelopmentEngine.js';

// ─────────────────────────────────────────────────────────────
// OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

let _currentPlayerId = null;

/**
 * openPlayerCard(playerId, state)
 * Opens the player detail modal sheet.
 *
 * @param {String} playerId
 * @param {Object} state
 */
export function openPlayerCard(playerId, state) {
  if (!playerId || !state) return;
  _injectCSS();

  _currentPlayerId = playerId;
  const player = state.players?.[playerId];
  if (!player) return;

  // Create or reuse the modal overlay
  let overlay = document.getElementById('player-card-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'player-card-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="modal-sheet" id="player-card-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div class="modal-title">${_escape(player.name)}</div>
        <button class="modal-close" id="player-card-close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div class="player-card-body">
        ${_renderCard(player, playerId, state)}
      </div>
    </div>
  `;

  // Trigger open animation
  requestAnimationFrame(() => overlay.classList.add('open'));

  // Wire close
  document.getElementById('player-card-close')?.addEventListener('click', closePlayerCard);
  // §85 open the trade composer from this player
  document.getElementById('pc-trade')?.addEventListener('click', async () => {
    const st = StateManager.get();
    const p = st.players[playerId];
    if (!p) return;
    closePlayerCard();
    const { openTradeComposer } = await import('./TradeComposer.js');
    if (p.teamId === 'user') openTradeComposer({ ourIds: [p.id] });
    else openTradeComposer({ teamId: p.teamId, theirIds: [p.id] });
  });
  // §96 sign / claim / withdraw
  document.getElementById('pc-market')?.addEventListener('click', async (e) => {
    const kind = e.currentTarget.dataset.market;
    closePlayerCard();
    const { openSignSheet } = await import('./SignSheet.js');
    openSignSheet(playerId, kind);
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closePlayerCard(); });
}

/**
 * closePlayerCard()
 * Dismisses the player detail modal.
 */
export function closePlayerCard() {
  const overlay = document.getElementById('player-card-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  _currentPlayerId = null;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────

function _renderCard(player, playerId, state) {
  const isPitcher    = ['SP','RP'].includes(player.pos);
  const impScores    = state.impScores?.[playerId];
  const impLast      = lastSeasonIMP(player);
  const impLabel     = impScores?.impS != null ? getImpLabel(impScores.impS) : '';
  const userRosterIds = new Set(state.userTeam?.rosterIds || []);
  const isOwnPlayer  = userRosterIds.has(playerId);

  // §96 a player no club has: on waivers, or a free agent.
  const formerly = player.onWaivers ? player._waivedBy : player._faFrom;
  const formerName = formerly === 'user' ? `${state.userTeam?.city || ''} ${state.userTeam?.nickname || ''}`.trim() : _teamName(formerly, state);
  const teamName = isOwnPlayer
    ? `${state.userTeam?.city || ''} ${state.userTeam?.nickname || ''}`.trim()
    : player.onWaivers ? `On waivers${formerName ? ` — from ${formerName}` : ''}`
    : player.group === 'freeAgent' ? `Free agent${formerName ? ` — formerly ${formerName}` : ''}`
    : _teamName(player.teamId, state);

  return `
    <!-- Identity row -->
    <div class="pc-identity">
      <div class="pc-ovr-block">
        <div class="pc-ovr-num ${_ovrClass(player.ovr)}">${formatOVR(player.ovr)}</div>
        <div class="pc-ovr-label">OVR</div>
      </div>
      <div class="pc-identity-info">
        <div class="pc-pos-age">
          <span class="pc-pos">${player.pos}</span>
          <span class="pc-dot">·</span>
          <span class="pc-hand">${player.hand === 'L' ? 'Left' : 'Right'}</span>
          <span class="pc-dot">·</span>
          <span class="pc-age">${formatAge(player.dob, baseballYear(StateManager.get()))} yrs</span>
        </div>
        <div class="pc-team">${_escape(teamName)}</div>
        ${_roleLine(player, state)}
        ${player.trait ? `<div class="pc-trait">${_escape(TRAIT_WORDS[player.trait] || player.trait)}</div>` : ''}
        ${(player.allStarSeasons || []).length ? `<div class="pc-trait" style="color:#c9971c;">★ ${player.allStarSeasons.length > 1 ? `${player.allStarSeasons.length}× ` : ''}All-Star${(player.allStarMvps || []).length ? ` · ${player.allStarMvps.length > 1 ? `${player.allStarMvps.length}× ` : ''}ASG MVP` : ''}</div>` : ''}
      </div>
    </div>

    <!-- Sub-ratings -->
    ${_renderSubRatings(player, isPitcher)}

    <!-- r160 §122.32 our players' wear (r161 §122.33 pitchers too: the arm's workload, and today's arm) -->
    ${isOwnPlayer && player.group !== PLAYER_GROUP.IL ? _renderWear(player, isPitcher, state) : ''}

    <!-- Season stats -->
    ${_renderStats(player, isPitcher, state)}

    <!-- §122.9 career: the seasons before this one, or why there are none -->
    ${_renderCareer(player, isPitcher)}

    <!-- IMP trend -->
    ${_renderImpTrend(impScores, impLabel, impLast)}

    <!-- Contract (a free agent: what they're asking) -->
    ${player.group === 'freeAgent' ? _renderAsk(player, state) : _renderContract(player, state)}

    <!-- GM relationship (own players only) -->
    ${isOwnPlayer ? _renderRelationship(player) : ''}


    <!-- §85 trade talks: start from any player's card -->
    ${_tradeButton(player, state)}
    <!-- §96 sign a free agent, or claim a player off waivers -->
    ${_marketButton(player, state)}
  `;
}

/** §96 what a free agent asks of us. */
function _renderAsk(player, state) {
  const t = FreeAgency.termsFor(state, player);
  const years = t.years || 1;
  return `
    <div class="pc-section">
      <div class="pc-section-label">Asking</div>
      <div class="pc-contract-row">
        <div class="pc-contract-salary">${formatSalary(t.salary)}/yr</div>
        <div class="pc-contract-status">${years} year${years === 1 ? '' : 's'}${t.bonus ? ` · ${formatSalary(t.bonus)} bonus` : ''}</div>
      </div>
      ${Number.isFinite(player._faSince) ? `<div class="pc-ask-note">Unsigned for ${_daysText(Math.max(0, Math.floor((Date.now() - player._faSince) / 86_400_000)))}${years === 1 && state.phase !== PHASE.OFFSEASON ? ' · paid only for the days on a roster' : ''}</div>` : ''}
    </div>`;
}

/**
 * r154 A reliever's bullpen role (the Team screen lists the pen by rating, so
 * the role lives here): the manager's roles from PitchingEngine.bullpenRoles —
 * closer, setup, middle, long. An arm on the pitcher bench is a reserve.
 */
const ROLE_WORDS = { closer: 'Closer', setup: 'Setup', middle: 'Middle relief', long: 'Long relief' };
function _roleLine(player, state) {
  if (![PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(player.group)) return '';
  const team = player.teamId === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === player.teamId);
  if (!team) return '';
  const role = ROLE_WORDS[bullpenRoles(team, state.players || {}).roleOf[player.id]];
  if (!role) return '';
  const reserve = player.group === PLAYER_GROUP.PITCHER_BENCH;
  return `<div class="pc-role"><span class="pc-role-label">Bullpen role</span> ${reserve ? `Reserve · ${role.toLowerCase()}` : role}</div>`;
}

const TRAIT_WORDS = { youngGun: 'Young gun', clubhouseLeader: 'Clubhouse leader', veteran: 'Veteran', volatile: 'Volatile', consistent: 'Consistent' };
const _daysText = (d) => (d === 0 ? 'less than a day' : `${d} day${d === 1 ? '' : 's'}`);

const ORIGIN_NOTE = {
  rookie:      'First season in the league: no league record yet. The ratings are our scouts\' projection.',
  overseas:    'Played professionally overseas: no league record. The ratings are our scouts\' estimate.',
  independent: 'Came up through independent ball: little or no league record. The ratings are mostly our scouts\' estimate.',
};

/** §122.9 the seasons before this one (no clubs, just the numbers), with the career line. */
function _renderCareer(player, isPitcher) {
  const log = (player.seasonLog || []).filter(e => e?.stats);
  const note = ORIGIN_NOTE[player.origin] || '';
  if (!log.length) {
    return note ? `<div class="pc-section"><div class="pc-section-label">Career</div><div class="pc-origin-note">${_escape(note)}</div></div>` : '';
  }
  const f3 = (x) => x.toFixed(3).replace(/^0/, '');
  const ipText = (ip) => `${Math.floor(ip + 1e-6)}.${Math.round(((ip + 1e-6) % 1) * 3)}`;
  const tot = {};
  for (const e of log) for (const [k, v] of Object.entries(e.stats)) if (typeof v === 'number') tot[k] = (tot[k] || 0) + v;
  const head = isPitcher ? ['Year', 'G', 'IP', 'W-L', 'ERA', 'K', 'SV'] : ['Year', 'G', 'AB', 'AVG', 'HR', 'RBI', 'SB', 'OPS'];
  const row = (label, st) => {
    if (isPitcher) {
      const era = st.ip ? (9 * (st.er || 0) / st.ip).toFixed(2) : '—';
      return [label, st.g || 0, st.ip ? ipText(st.ip) : '0.0', `${st.w || 0}-${st.l || 0}`, era, st.k || 0, st.sv || 0];
    }
    const pa = (st.ab || 0) + (st.bb || 0) + (st.hbp || 0) + (st.sf || 0);
    const ops = st.ab ? f3(((st.h || 0) + (st.bb || 0) + (st.hbp || 0)) / Math.max(1, pa) + (st.tb || 0) / st.ab) : '—';
    return [label, st.g || 0, st.ab || 0, st.ab ? f3((st.h || 0) / st.ab) : '—', st.hr || 0, st.rbi || 0, st.sb || 0, ops];
  };
  const rows = [...log].reverse().map(e => row(String(e.year ?? e.season), e.stats));
  const cells = (xs, cls = '') => `<tr class="${cls}">${xs.map(x => `<td>${_escape(String(x))}</td>`).join('')}</tr>`;
  return `
    <div class="pc-section">
      <div class="pc-section-label">Career · ${log.length} season${log.length === 1 ? '' : 's'}</div>
      <div class="pc-career-wrap">
        <table class="pc-career">
          <thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => cells(r)).join('')}${cells(row('Total', tot), 'pc-career-tot')}</tbody>
        </table>
      </div>
      ${note ? `<div class="pc-origin-note">${_escape(note)}</div>` : ''}
    </div>`;
}

/** §96 Sign (free agent), Put In a Claim / Withdraw Claim (waivers). */
function _marketButton(player, state) {
  if (player.group === 'freeAgent') return `<button class="pc-trade-btn" id="pc-market" data-market="sign">Sign Free Agent</button>`;
  if (player.onWaivers && player._waivedBy !== 'user') {
    return player._userClaim
      ? `<button class="pc-trade-btn" id="pc-market" data-market="withdraw">Withdraw Our Claim</button>`
      : `<button class="pc-trade-btn" id="pc-market" data-market="claim">Put In a Claim</button>`;
  }
  return '';
}

/** "Shop this player" on ours; "Ask about this player" on another club's. */
function _tradeButton(player, state) {
  const ours = player.teamId === 'user';
  const theirs = (state.leagueTeams || []).some(t => t.id === player.teamId);
  if (!ours && !theirs) return '';
  return `<button class="pc-trade-btn" id="pc-trade" data-trade-player="${player.id}">${ours ? 'Shop This Player' : 'Ask About This Player'}</button>`;
}

function _renderSubRatings(player, isPitcher) {
  const sub = player.subRatings || {};
  const ratings = isPitcher
    ? [
        { label: 'Stuff',    val: sub.stuff    ?? 0 },
        { label: 'Control',  val: sub.control  ?? 0 },
        { label: 'Stamina',  val: sub.stamina  ?? 0 },
      ]
    : [
        { label: 'Contact',  val: sub.contact  ?? 0 },
        { label: 'Power',    val: sub.power    ?? 0 },
        { label: 'Speed',    val: sub.speed    ?? 0 },
      ];

  const bars = ratings.map(r => `
    <div class="pc-subr-row">
      <div class="pc-subr-label">${r.label}</div>
      <div class="pc-subr-bar-wrap">
        <div class="pc-subr-bar-fill" style="width:${r.val}%;"></div>
      </div>
      <div class="pc-subr-val">${Math.round(r.val)}</div>
    </div>
  `).join('');

  return `
    <div class="pc-section">
      <div class="pc-section-label">Ratings</div>
      ${bars}
    </div>
  `;
}

/**
 * r160 §122.32 how worn down one of our players is: the meter (full and green when fresh, shrinking
 * toward the left as it builds — r161), the word, what it means now. r161 §122.33 pitchers too (the
 * arm's workload, and how the arm is today), and what age does to it.
 */
const WEAR_LINES = {
  fresh:  'Rested and ready.',
  fine:   'Holding up fine.',
  tiring: 'Starting to wear down. A day off soon keeps it from reaching the bat.',
  tired:  'The bat has slowed a little, and injuries come more often. A day off clears it.',
  worn:   'Worn down: the bat is slower and the injury risk is up. A day off clears it.',
};
const ARM_LINES = {
  fresh:  'The arm is fresh.',
  fine:   'The arm is holding up.',
  tiring: 'The workload is building. Rest soon keeps it from reaching the stuff.',
  tired:  'The stuff and control have slipped a little, and a tired arm gets hurt more often. Rest brings it back.',
  worn:   'Worn down: the stuff is short and the injury risk is up. Rest brings it back.',
};
function _armToday(player, now) {
  const a = armStatus(player, now);
  if (player.pos === 'SP' && player.group === PLAYER_GROUP.STARTING_PITCHERS) {
    const last = (player.arm || []).filter(o => o.start && o.at <= now).map(o => Math.floor((now - o.at) / 86_400_000)).sort((x, y) => x - y)[0];
    return last == null ? 'Today: ready for the next turn.' : `Today: last start ${last === 0 ? 'today' : last === 1 ? 'yesterday' : `${last} days ago`}.`;
  }
  return a.status === 'down' ? 'Today: resting, after pitching recently.' : a.status === 'tired' ? 'Today: available, but pitched yesterday.' : 'Today: ready.';
}
function _renderWear(player, isPitcher, state) {
  const now = Date.now();
  const w = wearOf(player, now);
  const age = computeAge(player.dob, baseballYear(state));
  const ageLine = age >= 31 ? ` At ${age}, it builds faster${isPitcher ? ' and comes off slower' : ''}.`
                : age <= 25 ? ` At ${age}, it builds slower${isPitcher ? ' and comes off quicker' : ''}.` : '';
  let note;
  if (isPitcher) note = `${_armToday(player, now)} ${ARM_LINES[w.level]}${ageLine}`;
  else {
    const caught = (state.userTeam?.lineupSlots || []).some(s => s.slot === 'C' && s.playerId === player.id);
    note = `${w.straight ? `${caught ? 'Caught' : 'Started'} ${w.straight} straight. ` : ''}${WEAR_LINES[w.level]}${ageLine}`;
  }
  return `
    <div class="pc-section">
      <div class="pc-section-label">Wear</div>
      <div class="pc-wear pc-wear-${w.level}">
        <div class="pc-subr-bar-wrap"><div class="pc-wear-fill" style="width:${Math.max(4, Math.round(w.left * 100))}%;"></div></div>
        <div class="pc-wear-word">${w.word}</div>
      </div>
      <div class="pc-ask-note">${note}</div>
    </div>`;
}

function _renderStats(player, isPitcher, state) {
  // During spring training the season line is empty — read springStats instead,
  // and label the block clearly so it's never mistaken for regular-season stats.
  const inSpring = state?.phase === PHASE.SPRING_TRAINING;
  const s = (inSpring ? player.springStats : player.stats) || {};
  const label = inSpring ? 'Spring Training Stats' : 'Season Stats';
  const springBadge = inSpring
    ? `<span style="display:inline-block;margin-left:8px;padding:2px 7px;border-radius:5px;background:#F5A524;color:#1a1a1a;font-size:9px;font-weight:800;letter-spacing:1px;vertical-align:middle;">SPRING TRAINING</span>`
    : '';

  if (isPitcher) {
    const era  = s.ip ? ((s.er||0) / s.ip * 9).toFixed(2) : '—';
    const whip = s.ip ? (((s.h_allowed||0) + (s.bb||0)) / s.ip).toFixed(2) : '—';
    const ip   = s.ip ? `${Math.floor(s.ip)}.${Math.round((s.ip % 1) * 3)}` : '—';
    return `
      <div class="pc-section">
        <div class="pc-section-label">${label}${springBadge}</div>
        <div class="pc-stats-grid">
          ${_statCell('ERA', era)}
          ${_statCell('WHIP', whip)}
          ${_statCell('IP', ip)}
          ${_statCell('W', s.w ?? '—')}
          ${_statCell('K', s.k ?? '—')}
          ${_statCell('SV', s.sv ?? '—')}
        </div>
      </div>
    `;
  }

  const avg = s.ab ? formatAVG(s.h||0, s.ab||0) : '.---';
  const ops = s.ab ? _calcOPS(s) : '---';
  return `
    <div class="pc-section">
      <div class="pc-section-label">${label}${springBadge}</div>
      <div class="pc-stats-grid">
        ${_statCell('AVG', avg)}
        ${_statCell('OPS', ops)}
        ${_statCell('HR',  s.hr  ?? '—')}
        ${_statCell('RBI', s.rbi ?? '—')}
        ${_statCell('R',   s.r   ?? '—')}
        ${_statCell('SB',  s.sb  ?? '—')}
      </div>
    </div>
  `;
}

function _renderImpTrend(impScores, impLabel, impLast = null) {
  if (!impScores && impLast == null) return '';

  // §122.9 the windows are days; last season's comes from the season log.
  const windows = [
    { label: '7 days',      val: impScores?.imp7  },
    { label: '15 days',     val: impScores?.imp15 },
    { label: '30 days',     val: impScores?.imp30 },
    { label: 'Season',      val: impScores?.impS  },
    { label: 'Last season', val: impLast },
  ];

  const cells = windows.map(w => {
    if (w.val === null || w.val === undefined) return `<div class="pc-imp-cell"><div class="pc-imp-val muted">—</div><div class="pc-imp-win">${w.label}</div></div>`;
    const cls = w.val > 0 ? 'positive' : w.val < 0 ? 'negative' : '';
    const txt = w.val > 0 ? `+${w.val.toFixed(1)}` : w.val.toFixed(1);
    return `
      <div class="pc-imp-cell">
        <div class="pc-imp-val ${cls}">${txt}</div>
        <div class="pc-imp-win">${w.label}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="pc-section">
      <div class="pc-section-label">Impact${impLabel ? ` · ${impLabel}` : ''}</div>
      <div class="pc-imp-grid">${cells}</div>
    </div>
  `;
}

function _renderContract(player, state) {
  const season    = state.seasonNum || 1;
  const yearsLeft = (player.contractExpiry || season) - season;
  const status    = yearsLeft <= 0 ? 'Expiring' : yearsLeft === 1 ? '1 year left' : `${yearsLeft} years left`;
  const statusCls = yearsLeft <= 0 ? 'danger' : yearsLeft <= 1 ? 'warn' : '';

  return `
    <div class="pc-section">
      <div class="pc-section-label">Contract</div>
      <div class="pc-contract-row">
        <div class="pc-contract-salary">${formatSalary(player.contractSalary)}/yr</div>
        <div class="pc-contract-status ${statusCls}">${status}</div>
      </div>
    </div>
  `;
}

function _renderRelationship(player) {
  const rel     = player.gmRelationship ?? 50;
  const relLabel = rel >= 70 ? 'Strong' : rel <= 30 ? 'Strained' : 'Neutral';
  const barColor = rel >= 70 ? 'var(--accent2)' : rel <= 30 ? 'var(--danger)' : 'var(--accent)';

  return `
    <div class="pc-section">
      <div class="pc-section-label">GM Relationship</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:13px;">${relLabel}</div>
        <div style="flex:1;background:var(--surface2);height:6px;border-radius:3px;overflow:hidden;">
          <div style="width:${rel}%;height:100%;background:${barColor};border-radius:3px;transition:width .4s;"></div>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _statCell(label, val) {
  return `
    <div class="pc-stat-cell">
      <div class="pc-stat-val">${val}</div>
      <div class="pc-stat-label">${label}</div>
    </div>
  `;
}

function _calcOPS(s) {
  if (!s.ab) return '.000';
  const pa  = (s.ab||0) + (s.bb||0);
  if (!pa) return '.000';
  const obp = ((s.h||0) + (s.bb||0)) / pa;
  const tb  = (s.h||0) - (s.doubles||0) - (s.hr||0) + ((s.doubles||0)*2) + ((s.hr||0)*4);
  const slg = tb / s.ab;
  return (obp + slg).toFixed(3).replace(/^0/,'');
}

function _ovrClass(ovr) {
  if (ovr >= 80) return 'elite';
  if (ovr >= 70) return 'good';
  if (ovr >= 60) return 'avg';
  return 'poor';
}

function _teamName(teamId, state) {
  if (!teamId || teamId === 'user') return '';
  const t = (state.leagueTeams || []).find(t => t.id === teamId);
  return t?.name || teamId;
}

function _escape(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .pc-trade-btn{display:block;width:100%;margin:16px 0 4px;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer;}
    .player-card-body{overflow-y:auto;padding:0 20px 32px;flex:1;min-height:0;}
    .pc-identity{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;}
    .pc-ovr-block{text-align:center;flex-shrink:0;background:var(--surface2);
      border-radius:10px;padding:8px 12px;border:1px solid var(--border);}
    .pc-ovr-num{font-family:'Bebas Neue',sans-serif;font-size:36px;line-height:1;}
    .pc-ovr-num.elite{color:var(--text);}
    .pc-ovr-num.good{color:var(--text);}
    .pc-ovr-num.avg{color:var(--soft);}
    .pc-ovr-num.poor{color:var(--danger);}
    .pc-ovr-label{font-size:9px;font-weight:700;letter-spacing:1.5px;
      text-transform:uppercase;color:var(--muted);}
    .pc-identity-info{flex:1;min-width:0;}
    .pc-pos-age{font-size:12px;color:var(--muted);display:flex;gap:5px;flex-wrap:wrap;margin-bottom:3px;}
    .pc-pos{font-weight:700;color:var(--text);}
    .pc-dot{color:var(--border);}
    .pc-team{font-size:13px;color:var(--soft);margin-bottom:3px;}
    .pc-role{font-size:13px;font-weight:700;color:var(--text);margin-bottom:3px;}
    .pc-role-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-right:4px;}
    .pc-career-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-height:220px;overflow-y:auto;}
    .pc-career{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums;}
    .pc-career th{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);text-align:right;padding:3px 5px;position:sticky;top:0;background:var(--surface);}
    .pc-career td{text-align:right;padding:3px 5px;color:var(--text);border-top:1px solid var(--border);white-space:nowrap;}
    .pc-career th:first-child,.pc-career td:first-child{text-align:left;}
    .pc-career-tot td{font-weight:800;}
    .pc-origin-note{font-size:12px;color:var(--soft);line-height:1.45;margin-top:6px;}
    .pc-ask-note{font-size:12px;color:var(--muted);margin-top:4px;}
    .pc-wear{display:flex;align-items:center;gap:10px;}
    .pc-wear-fill{height:100%;border-radius:3px;background:#34C97A;}
    .pc-wear-word{font-size:12px;font-weight:700;min-width:70px;text-align:right;color:var(--soft);}
    .pc-wear-tiring .pc-wear-fill{background:#e0a800;} .pc-wear-tiring .pc-wear-word{color:#d49b00;}
    .pc-wear-tired .pc-wear-fill{background:#f97316;} .pc-wear-tired .pc-wear-word{color:#f97316;}
    .pc-wear-worn .pc-wear-fill{background:var(--danger);} .pc-wear-worn .pc-wear-word{color:var(--danger);}
    .pc-farm-badge{font-size:10px;font-weight:700;color:var(--text);
      background:var(--chip-accent-bg);padding:1px 6px;border-radius:4px;display:inline-block;}
    .pc-trait{font-size:11px;color:var(--muted);font-style:italic;margin-top:2px;}
    .pc-section{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border);}
    .pc-section:last-child{border-bottom:none;}
    .pc-section-label{font-size:10px;font-weight:700;letter-spacing:2px;
      text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
    .pc-subr-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;}
    .pc-subr-label{font-size:11px;color:var(--muted);width:52px;flex-shrink:0;}
    .pc-subr-bar-wrap{flex:1;background:var(--surface2);height:6px;border-radius:3px;overflow:hidden;}
    .pc-subr-bar-fill{height:100%;background:var(--accent-bar);border-radius:3px;transition:width .4s;}
    .pc-subr-val{font-size:12px;font-weight:700;color:var(--text);width:24px;text-align:right;flex-shrink:0;}
    .pc-stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
    .pc-stat-cell{background:var(--surface2);border-radius:8px;padding:8px;text-align:center;}
    .pc-stat-val{font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--text);}
    .pc-stat-label{font-size:9px;font-weight:700;letter-spacing:1px;
      text-transform:uppercase;color:var(--muted);margin-top:2px;}
    .pc-imp-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;}
    .pc-imp-cell{background:var(--surface2);border-radius:8px;padding:8px;text-align:center;}
    .pc-imp-val{font-family:'DM Mono',monospace;font-size:14px;font-weight:700;color:var(--text);}
    .pc-imp-val.positive{color:var(--text);}
    .pc-imp-val.negative{color:var(--danger);}
    .pc-imp-val.muted{color:var(--muted);}
    .pc-imp-win{font-size:9px;color:var(--muted);margin-top:3px;font-weight:600;white-space:nowrap;}
    .pc-contract-row{display:flex;align-items:center;justify-content:space-between;}
    .pc-contract-salary{font-size:15px;font-weight:700;color:var(--text);}
    .pc-contract-status{font-size:12px;color:var(--muted);font-weight:600;}
    .pc-contract-status.danger{color:var(--danger);}
    .pc-contract-status.warn{color:#f97316;}
  `;
  document.head.appendChild(style);
}
