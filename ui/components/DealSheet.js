/**
 * ui/components/DealSheet.js
 * r198 §122.75 a deal as a table: what we get and what we send, side by side,
 * and the money under both — a year, the rest of this season, later seasons,
 * cash, and the payroll after the deal against ownership's target.
 *
 *   openDealSheet({ offer, teamName, title, versions, start })
 *     offer: our terms (incomingIds we get, outgoingIds we send, cashK + to us,
 *            retain { id: share the sending club keeps paying this season })
 *     versions: r202 §122.79 [{ key, label, offer }] — a switch between them (the deal as
 *            offered, and the director's counter); `start` the one shown first (default: the last)
 *
 * The numbers are TradeEngine.dealSheet's: the same totals the staff's words use.
 * A player's card opens the player card, over the sheet (closing it comes back here). r208 §122.86 the cards
 * are one height: rows across both sides, each as tall as the tallest card.
 */

import * as StateManager from '../../store/StateManager.js';
import { dealSheet } from '../../engine/TradeEngine.js';
import { formatK } from '../../engine/CardTokens.js';
import { posLabel } from '../../engine/Positions.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _e = (s) => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export function openDealSheet({ offer, teamName = 'They', title = 'The Deal', versions = null, start = null } = {}) {
  const state = StateManager.get();
  const vs = versions?.length > 1 ? versions : null;
  if (!state || !(offer || vs)) return;
  _injectCSS();
  document.getElementById('ds-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ds-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet ds-sheet"><div class="modal-handle"></div><div id="ds-body"></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  let shown = 0;
  if (vs) { const i = vs.findIndex(v => v.key === start); shown = i >= 0 ? i : vs.length - 1; }
  const draw = () => {
    const st = StateManager.get();
    const o = vs ? vs[shown].offer : offer;
    const sw = vs ? `<div class="ds-switch" role="tablist">${vs.map((v, i) => `<button type="button" role="tab" class="ds-sw${i === shown ? ' on' : ''}" data-ds-v="${i}" aria-selected="${i === shown}">${_e(v.label)}</button>`).join('')}</div>` : '';
    overlay.querySelector('#ds-body').innerHTML = _html(st, dealSheet(st, o, { teamName }), title, sw);
    overlay.querySelector('#ds-close')?.addEventListener('click', close);
    overlay.querySelectorAll('[data-ds-v]').forEach(b => b.addEventListener('click', () => { shown = +b.dataset.dsV; draw(); }));
    overlay.querySelectorAll('[data-ds-player]').forEach(b => b.addEventListener('click', () => {
      import('./PlayerCard.js').then(PC => PC.openPlayerCard(b.dataset.dsPlayer, StateManager.get()));
    }));
  };
  draw();
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

/** "2 more seasons" / "final season" */
const _years = (n) => (n > 0 ? `${n} more season${n === 1 ? '' : 's'}` : 'final season');
/** A sum that costs us (+) or saves us (−). */
const _net = (k) => (Math.round(k) > 0 ? `Costs us ${formatK(Math.round(k))}` : Math.round(k) < 0 ? `Saves us ${formatK(-Math.round(k))}` : 'No change');

function _cell(state, r, col, row) {
  const p = state.players[r.id];
  const kept = r.kept ? `<span class="ds-kept">${r.keptBy === 'us' ? 'We keep' : 'They keep'} paying ${Math.round(r.kept * 100)}% this season</span>` : '';
  return `<button type="button" class="ds-player" data-ds-player="${_e(r.id)}" style="grid-column:${col};grid-row:${row}">
    <span class="ds-name">${_e(r.name)}</span>
    <span class="ds-meta">${_e(p ? posLabel(p) : r.pos)} · OVR ${r.ovr} · ${r.age}${r.injured ? ' · hurt' : ''}</span>
    <span class="ds-pay">${r.salary > 0 ? `${formatK(r.salary)} a year` : 'No salary'} · ${_years(r.years)}</span>
    ${kept}
  </button>`;
}

function _html(state, d, title, sw = '') {
  // one grid: a row per pair, so every card in it is the height of the tallest (grid-auto-rows: 1fr)
  const col = (rows, c) => (rows.length ? rows.map((r, i) => _cell(state, r, c, i + 2)).join('')
                                        : `<div class="ds-none" style="grid-column:${c};grid-row:2">No players</div>`);
  const k = (v) => formatK(Math.round(v));
  const cash = d.cashK > 0 ? `${formatK(d.cashK)} to us` : d.cashK < 0 ? `${formatK(-d.cashK)} from us` : null;
  const gap = d.payroll.target > 0 ? d.payroll.after - d.payroll.target : null;
  const restRow = d.rem > 0.02 && d.rem < 0.98;
  return `
    <div class="ds-head">
      <div class="ds-titles"><div class="ds-title">${_e(title)}</div><div class="ds-sub">With ${_e(d.teamName)}</div></div>
    </div>
    ${sw}
    <div class="ds-grid">
      <div class="ds-colh" style="grid-column:1;grid-row:1">We Get</div><div class="ds-colh" style="grid-column:2;grid-row:1">We Send</div>
      ${col(d.get, 1)}${col(d.send, 2)}
    </div>
    <table class="ds-money">
      <thead><tr><th></th><th>We Get</th><th>We Send</th></tr></thead>
      <tbody>
        <tr><td>Salary a year</td><td>${k(d.salary.get)}</td><td>${k(d.salary.send)}</td></tr>
        ${restRow ? `<tr><td>Rest of this season</td><td>${k(d.rest.get)}</td><td>${k(d.rest.send)}</td></tr>` : ''}
        <tr><td>Later seasons</td><td>${k(d.later.get)}</td><td>${k(d.later.send)}</td></tr>
      </tbody>
    </table>
    <div class="ds-totals">
      ${cash ? `<div class="ds-row"><span>Cash</span><span>${cash}</span></div>` : ''}
      <div class="ds-row"><span>This season, net</span><span>${_net(d.netThisSeason)}</span></div>
      <div class="ds-row"><span>Payroll after the deal</span><span class="${gap > 0 ? 'ds-cost' : ''}">${k(d.payroll.after)}${gap == null ? '' : gap > 0 ? ` · ${k(gap)} over target` : ` · ${k(-gap)} under target`}</span></div>
      <div class="ds-row"><span>Later seasons, net</span><span>${_net(d.later.net)}</span></div>
    </div>
    <button type="button" class="ds-close" id="ds-close">Close</button>`;
}

function _injectCSS() {
  if (document.getElementById('ds-css')) return;
  const st = document.createElement('style');
  st.id = 'ds-css';
  st.textContent = `
    .ds-sheet{max-height:calc(90 * var(--vh));overflow-y:auto;padding:0 16px max(16px,env(safe-area-inset-bottom));}
    .ds-head{padding:10px 0 12px;border-bottom:1px solid var(--border);margin-bottom:10px;}
    .ds-title{font-size:17px;font-weight:700;color:var(--text);}
    .ds-sub{font-size:12px;color:var(--muted);margin-top:2px;}
    .ds-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:auto;grid-auto-rows:1fr;gap:6px 8px;}
    .ds-colh{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);}
    .ds-player{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;width:100%;height:100%;box-sizing:border-box;
      border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:var(--surface2);min-width:0;font:inherit;color:inherit;text-align:left;cursor:pointer;}
    .ds-player:active{border-color:var(--text);}
    .ds-name{display:block;max-width:100%;font-size:14px;font-weight:700;color:var(--text);
      text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ds-meta,.ds-pay,.ds-kept{display:block;font-size:11px;color:var(--soft);margin-top:3px;}
    .ds-pay{color:var(--text);font-variant-numeric:tabular-nums;}
    .ds-kept{font-size:11px;color:var(--muted);margin-top:3px;}
    .ds-none{font-size:12px;color:var(--muted);padding:8px 2px;}
    .ds-money{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px;font-variant-numeric:tabular-nums;}
    .ds-money th{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);text-align:right;padding:0 0 6px;}
    .ds-money td{padding:7px 0;border-top:1px solid var(--border);color:var(--text);text-align:right;}
    .ds-money td:first-child,.ds-money th:first-child{text-align:left;color:var(--soft);}
    .ds-totals{margin-top:10px;border-top:1px solid var(--border);}
    .ds-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--soft);}
    .ds-row span:last-child{color:var(--text);font-weight:600;text-align:right;font-variant-numeric:tabular-nums;}
    .ds-row span.ds-cost{color:var(--danger);}
    .ds-switch{display:flex;gap:4px;padding:3px;margin:0 0 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface2);}
    .ds-sw{flex:1;padding:8px 6px;border:0;border-radius:8px;background:none;color:var(--soft);font:inherit;font-size:13px;font-weight:600;cursor:pointer;}
    .ds-sw.on{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.18);}
    .ds-close{display:block;width:100%;margin-top:16px;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer;}
  `;
  document.head.appendChild(st);
}
