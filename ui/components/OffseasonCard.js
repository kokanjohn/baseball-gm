/**
 * ui/components/OffseasonCard.js
 * The dashboard card between the last out of the season and spring training
 * (§70). Live-only: no "start spring" button — the league calendar opens
 * spring training the midnight after offseason day 6.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ OFFSEASON · DAY 3 OF 6        Spring in 3d 14h│
 *   │ Staff & Free Agency                           │
 *   │ The manager's future, and the market keeps…   │
 *   │ [✓ Ownership] [● Contracts 2] [✓ Manager]     │
 *   │ Season 1 · 88–44 · Lost in the Division Series│
 *   │ 14 free agents on the market                  │
 *   └──────────────────────────────────────────────┘
 *
 * Reads only: OffseasonEngine (calendar, gates). Decisions happen in the inbox.
 */

import { offseasonDay, hardGates, DAY_FOCUS, freeAgents } from '../../engine/OffseasonEngine.js';

let _cssInjected = false;

/** HTML for the card, or '' when the league is not between seasons. */
export function renderOffseasonCard(state, nowMs = Date.now()) {
  const os = state?.offseason;
  if (!os) return '';
  _injectCSS();
  const day   = offseasonDay(state, nowMs);
  const focus = DAY_FOCUS[day] || DAY_FOCUS[0];
  const target = day === 0 ? os.dayStarts[0] : os.springAt;
  const gates = hardGates(state);
  const cards = [...(state.inbox || []).filter(c => !c.resolved), ...(state.scheduledCards || [])];
  const openContracts = cards.filter(c => c._osGate === 'contracts').length;
  const last = (state.seasonHistory || []).find(h => h.seasonNum === os.seasonNum);
  const u = state.userTeam || {};
  const record = last ? `${last.wins}–${last.losses}` : `${u.wins || 0}–${u.losses || 0}`;
  const result = last?.postseason?.result || '';
  const fa = day >= 2 ? freeAgents(state).length : 0;

  const chip = (ok, label, extra = '') =>
    `<span class="os-chip ${ok ? 'os-ok' : 'os-open'}">${ok ? '✓' : '●'} ${label}${extra}</span>`;
  const gateRow = day === 0 ? '' : `
    <div class="os-gates" aria-label="Required before spring training">
      ${chip(gates.ownership, 'Ownership')}
      ${chip(gates.contracts, 'Contracts', openContracts ? ` <b>${openContracts}</b>` : '')}
      ${chip(gates.manager, 'Manager')}
    </div>`;

  return `
    <div class="os-card" id="os-card">
      <div class="os-top">
        <span class="os-day">${day === 0 ? 'SEASON COMPLETE' : `OFFSEASON · DAY ${day} OF 6`}</span>
        <span class="os-count" id="os-count" data-target="${target}">${_countdown(target - nowMs, day === 0 ? 'Offseason' : 'Spring')}</span>
      </div>
      <div class="os-focus">${focus.label}</div>
      <div class="os-sub">${focus.sub}</div>
      ${gateRow}
      <div class="os-foot">
        <span>Season ${os.seasonNum} · ${record}${result ? ` · ${result}` : ''}</span>
        ${fa ? `<span>${fa} free agent${fa === 1 ? '' : 's'} on the market</span>` : ''}
      </div>
    </div>`;
}

/** Refresh the countdown text in place (called by the dashboard's timer). */
export function updateOffseasonCountdown(nowMs = Date.now()) {
  const el = typeof document !== 'undefined' && document.getElementById('os-count');
  if (!el) return;
  const target = Number(el.dataset.target);
  const label  = el.textContent.startsWith('Offseason') ? 'Offseason' : 'Spring';
  el.textContent = _countdown(target - nowMs, label);
}

function _countdown(ms, label) {
  if (!(ms > 0)) return `${label} opening…`;
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const t = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `${label} in ${t}`;
}

function _injectCSS() {
  if (_cssInjected || typeof document === 'undefined') return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .os-card { margin: 12px 16px; padding: 14px 16px; border-radius: 14px;
      background: var(--card, #161b26); border: 1px solid var(--border, rgba(255,255,255,.08)); }
    .os-top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .os-day { font-size:10px; font-weight:800; letter-spacing:1.5px; color: var(--accent); }
    .os-count { font-size:11px; font-weight:700; color: var(--muted); font-variant-numeric: tabular-nums; white-space:nowrap; }
    .os-focus { margin-top:6px; font-size:17px; font-weight:800; }
    .os-sub { margin-top:2px; font-size:12px; color: var(--muted); line-height:1.35; }
    .os-gates { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .os-chip { font-size:11px; font-weight:700; padding:4px 9px; border-radius:999px; white-space:nowrap; }
    .os-chip b { font-weight:900; }
    .os-ok   { background: var(--chip-green-bg, rgba(34,197,94,.14)); color: var(--success, #22c55e); }
    .os-open { background: var(--chip-red-bg, rgba(240,82,82,.14));   color: var(--danger, #f05252); }
    .os-foot { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 10px; margin-top:10px;
      font-size:11px; color: var(--muted); }
  `;
  document.head.appendChild(style);
}
