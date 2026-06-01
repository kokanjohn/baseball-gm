/**
 * ui/components/PlayerCard.js
 * Full player detail modal sheet.
 *
 * Triggered by tapping a player row in TeamScreen or LeagueScreen.
 * Slides up as a bottom sheet over the current screen.
 *
 * Shows:
 *   - Name, position, age, handedness, team
 *   - OVR with sub-ratings radar (placeholder until RadarWidget
 *     sub-rating mode is built — Phase 13 radar pass)
 *   - Contract: salary, years remaining, expiry
 *   - Season stats (batting or pitching depending on position)
 *   - IMP trend: 7-day, 15-day, 30-day, season
 *   - Hot/cold indicator
 *   - Trait label
 *   - GM relationship bar
 *   - Farm arc label if tier === 'farm'
 *
 * Section 1.11b: No premium gating. All data shown regardless of tier.
 *
 * Usage:
 *   import { openPlayerCard, closePlayerCard } from '../components/PlayerCard.js';
 *   openPlayerCard(playerId, state);
 */

import { formatOVR, formatAge, formatSalary, formatIMP, formatAVG, formatERA } from '../formatters.js';
import { getHotColdIndicator, getImpLabel } from '../../engine/IMPEngine.js';

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
  const indicator    = getHotColdIndicator(impScores);
  const impLabel     = getImpLabel(impScores);
  const isFarm       = player.tier === 'farm';
  const userRosterIds = new Set(state.userTeam?.rosterIds || []);
  const isOwnPlayer  = userRosterIds.has(playerId);

  const teamName = isOwnPlayer
    ? `${state.userTeam?.city || ''} ${state.userTeam?.nickname || ''}`.trim()
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
          <span class="pc-age">${formatAge(player.dob)} yrs</span>
        </div>
        <div class="pc-team">${_escape(teamName)}</div>
        ${isFarm ? `<div class="pc-farm-badge">Farm System</div>` : ''}
        ${player.trait ? `<div class="pc-trait">${_escape(player.trait)}</div>` : ''}
      </div>
      ${indicator ? `<div class="pc-hot-cold">${indicator}</div>` : ''}
    </div>

    <!-- Sub-ratings -->
    ${_renderSubRatings(player, isPitcher)}

    <!-- Season stats -->
    ${_renderStats(player, isPitcher)}

    <!-- IMP trend -->
    ${_renderImpTrend(impScores, impLabel)}

    <!-- Contract -->
    ${_renderContract(player, state)}

    <!-- GM relationship (own players only) -->
    ${isOwnPlayer ? _renderRelationship(player) : ''}

    <!-- Farm arc (farm players only) -->
    ${isFarm ? _renderFarmArc(player) : ''}
  `;
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

function _renderStats(player, isPitcher) {
  const s = player.stats || {};

  if (isPitcher) {
    const era  = s.ip ? ((s.er||0) / s.ip * 9).toFixed(2) : '—';
    const whip = s.ip ? (((s.h||0) + (s.bb||0)) / s.ip).toFixed(2) : '—';
    const ip   = s.ip ? `${Math.floor(s.ip)}.${Math.round((s.ip % 1) * 3)}` : '—';
    return `
      <div class="pc-section">
        <div class="pc-section-label">Season Stats</div>
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
      <div class="pc-section-label">Season Stats</div>
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

function _renderImpTrend(impScores, impLabel) {
  if (!impScores) return '';

  const windows = [
    { label: '7g',  val: impScores.imp7   },
    { label: '15g', val: impScores.imp15  },
    { label: '30g', val: impScores.imp30  },
    { label: 'Ssn', val: impScores.impSeason },
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
      <div class="pc-section-label">Form (IMP) ${impLabel ? `· ${impLabel}` : ''}</div>
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
  const relLabel = rel >= 70 ? '😊 Strong' : rel <= 30 ? '😤 Strained' : '😐 Neutral';
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

function _renderFarmArc(player) {
  if (!player._farmArc) return '';
  const labels = {
    motivation: '↑ Performing above expectations',
    decline:    '↓ Struggling to develop',
    steady:     '— Progressing steadily',
  };
  const label = labels[player._farmArc] || player._farmArc;
  return `
    <div class="pc-section">
      <div class="pc-section-label">Development Arc</div>
      <div style="font-size:13px;color:var(--soft);">${_escape(label)}</div>
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
    .player-card-body{overflow-y:auto;padding:0 20px 32px;flex:1;min-height:0;}
    .pc-identity{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;}
    .pc-ovr-block{text-align:center;flex-shrink:0;background:var(--surface2);
      border-radius:10px;padding:8px 12px;border:1px solid var(--border);}
    .pc-ovr-num{font-family:'Bebas Neue',sans-serif;font-size:36px;line-height:1;}
    .pc-ovr-num.elite{color:var(--accent2);}
    .pc-ovr-num.good{color:var(--accent);}
    .pc-ovr-num.avg{color:var(--soft);}
    .pc-ovr-num.poor{color:var(--danger);}
    .pc-ovr-label{font-size:9px;font-weight:700;letter-spacing:1.5px;
      text-transform:uppercase;color:var(--muted);}
    .pc-identity-info{flex:1;min-width:0;}
    .pc-pos-age{font-size:12px;color:var(--muted);display:flex;gap:5px;flex-wrap:wrap;margin-bottom:3px;}
    .pc-pos{font-weight:700;color:var(--text);}
    .pc-dot{color:var(--border);}
    .pc-team{font-size:13px;color:var(--soft);margin-bottom:3px;}
    .pc-farm-badge{font-size:10px;font-weight:700;color:var(--accent);
      background:var(--chip-accent-bg);padding:1px 6px;border-radius:4px;display:inline-block;}
    .pc-trait{font-size:11px;color:var(--muted);font-style:italic;margin-top:2px;}
    .pc-hot-cold{font-size:24px;flex-shrink:0;}
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
    .pc-imp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
    .pc-imp-cell{background:var(--surface2);border-radius:8px;padding:8px;text-align:center;}
    .pc-imp-val{font-family:'DM Mono',monospace;font-size:14px;font-weight:700;color:var(--text);}
    .pc-imp-val.positive{color:var(--accent2);}
    .pc-imp-val.negative{color:var(--danger);}
    .pc-imp-val.muted{color:var(--muted);}
    .pc-imp-win{font-size:9px;color:var(--muted);margin-top:3px;font-weight:600;}
    .pc-contract-row{display:flex;align-items:center;justify-content:space-between;}
    .pc-contract-salary{font-size:15px;font-weight:700;color:var(--text);}
    .pc-contract-status{font-size:12px;color:var(--muted);font-weight:600;}
    .pc-contract-status.danger{color:var(--danger);}
    .pc-contract-status.warn{color:#f97316;}
  `;
  document.head.appendChild(style);
}
