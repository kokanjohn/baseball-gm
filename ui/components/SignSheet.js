/**
 * ui/components/SignSheet.js
 * §96 Sign a free agent, put in a waiver claim, or withdraw our claim — from
 * a player's card on the League screen. When the incoming player's side of
 * the 28 is full, the GM chooses who goes down to make room (for a claim: who
 * goes down if the claim is awarded). The sheet says what each choice costs
 * (a full farm side puts its weakest player on waivers), shows the payroll
 * against ownership's target, and the reason when the move can't be made.
 */

import * as StateManager from '../../store/StateManager.js';
import * as App from '../App.js';
import * as EventBus from '../EventBus.js';
import * as FreeAgency from '../../engine/FreeAgency.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { formatK } from '../../engine/CardTokens.js';
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';
import { PHASE } from '../../data/constants.js';

let _drop = null;

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isP = (p) => ['SP', 'RP'].includes(p?.pos);

function _leftText(ms) {
  const left = Math.max(0, ms - Date.now());
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function openSignSheet(playerId, kind) {
  _drop = null;
  _css();
  document.getElementById('sign-sheet-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'sign-sheet-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet ss-sheet"><div class="modal-handle"></div><div id="ss-body"></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  _render(playerId, kind);
}

function _render(playerId, kind) {
  const st = StateManager.get();
  const p = st.players[playerId];
  const body = document.getElementById('ss-body');
  if (!p || !body) return;
  const close = () => document.getElementById('sign-sheet-overlay')?.remove();
  const who = `${_esc(p.name)} (${p.nativePos || p.pos}, OVR ${p.ovr}, age ${computeAge(p.dob, baseballYear(st))})`;

  if (kind === 'withdraw') {
    body.innerHTML = `
      <div class="ss-title">Withdraw our claim</div>
      <div class="ss-text">Our claim on ${who} comes off the table. Another club can still claim before the window closes in ${_leftText(FreeAgency.waiverEndsAt(p))}.</div>
      <div class="ss-actions"><button class="ss-btn" id="ss-cancel">Keep the Claim</button><button class="ss-btn primary" id="ss-go">Withdraw</button></div>`;
    body.querySelector('#ss-cancel').onclick = close;
    body.querySelector('#ss-go').onclick = async () => {
      const { gmWithdrawClaim } = await import('../../engine/GameEngine.js');
      gmWithdrawClaim(playerId);
      EventBus.emit('roster:changed');
      App.showToast(`Claim on ${p.name} withdrawn.`, 'neutral', 3000);
      close();
    };
    return;
  }

  const claiming = kind === 'claim';
  const terms = claiming ? { salary: p.contractSalary || 0, years: Math.max(1, (p.contractExpiry || 0) - (st.seasonNum || 1)) } : FreeAgency.termsFor(st, p);
  const room = FreeAgency.roomFor(st, p, { toFarm: !claiming && !!terms.toFarm });
  const gamesOn = ![PHASE.OFFSEASON, PHASE.SEASON_SUMMARY].includes(st.phase);
  const blocker = claiming ? FreeAgency.claimBlocker(st, playerId, _drop) : FreeAgency.signBlocker(st, playerId, _drop);
  const needChoice = room.needsDrop && !_drop;

  // Payroll after the move, against ownership's target (§78).
  const d = _drop ? st.players[_drop] : null;
  const addK = terms.toFarm ? 0 : (terms.salary || 0);
  const outK = room.needsDrop && d && !d.contractMLB ? (d.contractSalary || 0) : 0;
  const payroll = Finance.payrollOf(st, 'user') + addK - outK;
  const target = Finance.seasonTarget(st.userTeam.finances) || 0;

  const intro = claiming
    ? `${who} is on waivers for another ${_leftText(FreeAgency.waiverEndsAt(p))}. Claims are decided when the window closes, and clubs with worse records claim first. If the claim is ours, ${_esc(p.name)} reports the next day and comes with the contract: ${formatK(terms.salary)} a year.`
    : terms.toFarm
      ? `${who} signs a minor-league deal and reports to the farm${terms.bonus ? `, with a ${formatK(terms.bonus)} signing bonus` : ''}.`
      : `${who} signs for ${formatK(terms.salary)} a year, ${terms.years || 1} year${(terms.years || 1) === 1 ? '' : 's'}. ${gamesOn ? `${_esc(p.name)} reports tomorrow.` : ''}`;

  const outcomeText = (c) => c.outcome.kind === 'released' ? 'released — the farm is full'
    : c.outcome.waives ? `to the farm — it's full, so ${_esc(c.outcome.waives)} goes on waivers`
    : 'to the farm';
  const list = room.needsDrop ? `
    <div class="ss-label">Make room</div>
    <div class="ss-text">${isP(p) ? 'Our pitching staff is' : 'Our position-player spots are'} full. Choose who goes down${claiming ? ' if the claim is awarded' : ''}:</div>
    <div class="ss-list">${room.candidates.map(c => `
      <button class="ss-row${_drop === c.player.id ? ' on' : ''}" data-drop="${c.player.id}">
        <span class="ss-radio">${_drop === c.player.id ? '●' : '○'}</span>
        <span class="ss-name">${_esc(c.player.name)} <span class="ss-meta">${c.player.nativePos || c.player.pos} · OVR ${c.player.ovr}${c.starter ? ' · starter' : ''}${c.player.isInjured ? ' · hurt' : ''}</span></span>
        <span class="ss-out">${outcomeText(c)}</span>
      </button>`).join('')}</div>` : '';

  body.innerHTML = `
    <div class="ss-title">${claiming ? `Claim ${_esc(p.name)}` : `Sign ${_esc(p.name)}`}</div>
    <div class="ss-text">${intro}</div>
    ${list}
    ${terms.toFarm ? '' : `<div class="ss-pay${payroll > target ? ' over' : ''}">Payroll after: ${formatK(Math.round(payroll))} of ${formatK(target)} target</div>`}
    ${blocker && !needChoice ? `<div class="ss-why">${_esc(blocker[0].toUpperCase() + blocker.slice(1))}.</div>` : ''}
    <div class="ss-actions">
      <button class="ss-btn" id="ss-cancel">Cancel</button>
      <button class="ss-btn primary" id="ss-go" ${blocker ? 'disabled' : ''}>${claiming ? 'Put In the Claim' : 'Sign'}</button>
    </div>`;

  body.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { _drop = b.dataset.drop; _render(playerId, kind); });
  body.querySelector('#ss-cancel').onclick = close;
  body.querySelector('#ss-go').onclick = async () => {
    const GE = await import('../../engine/GameEngine.js');
    const res = claiming ? GE.gmClaimOffWaivers(playerId, _drop) : GE.gmSignFreeAgent(playerId, _drop);
    if (!res.ok) { App.showToast(`Can't do that: ${res.reason}.`, 'negative', 4500); _render(playerId, kind); return; }
    EventBus.emit('roster:changed');
    const down = _drop ? StateManager.get().players[_drop]?.name : null;
    App.showToast(claiming
      ? `Claim in on ${p.name}. We'll know when the window closes.`
      : `${p.name} signed${down ? `; ${down} goes down` : ''}.`, 'positive', 4000);
    close();
  };
}

function _css() {
  if (document.getElementById('sign-sheet-css')) return;
  const st = document.createElement('style');
  st.id = 'sign-sheet-css';
  st.textContent = `
    .ss-sheet{max-height:88dvh;overflow-y:auto;padding:4px 18px max(18px,env(safe-area-inset-bottom));}
    .ss-title{font-size:18px;font-weight:800;color:var(--text);margin:8px 0 8px;}
    .ss-text{font-size:14px;line-height:1.55;color:var(--soft);margin-bottom:10px;}
    .ss-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 0 4px;}
    .ss-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}
    .ss-row{display:grid;grid-template-columns:18px 1fr;gap:2px 8px;text-align:left;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;cursor:pointer;}
    .ss-row.on{border-color:var(--text);}
    .ss-radio{grid-row:span 2;font-size:14px;color:var(--text);line-height:1.3;}
    .ss-name{font-size:14px;font-weight:700;}
    .ss-meta{font-size:12px;font-weight:600;color:var(--muted);}
    .ss-out{font-size:12px;color:var(--muted);}
    .ss-pay{font-size:13px;font-weight:600;color:var(--text);margin:6px 0;}
    .ss-pay.over{color:var(--danger);}
    .ss-why{font-size:13px;font-weight:600;color:var(--danger);margin:6px 0;}
    .ss-actions{display:flex;gap:10px;margin-top:14px;}
    .ss-btn{flex:1;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:14px;font-weight:700;cursor:pointer;}
    .ss-btn.primary{background:var(--text);color:var(--bg);border-color:var(--text);}
    .ss-btn:disabled{opacity:.4;cursor:default;}
  `;
  document.head.appendChild(st);
}
