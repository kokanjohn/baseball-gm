/**
 * ui/components/TradeComposer.js
 * §85 Phase 4b — the GM builds a trade and sends it to another club.
 *
 *   openTradeComposer({ teamId, theirIds, ourIds, cashK, retain, round })
 *
 * Up to three players a side (either club's roster or farm), cash either way,
 * and a share of a salary the sending club keeps paying this season. The GM
 * can run it by Pro Scouting (a read in words, never a number) and sees what
 * our owner would say about the payroll. Sending starts (or continues) the
 * talk; the other GM answers in the inbox, on the real clock.
 */

import * as StateManager from '../../store/StateManager.js';
import * as App from '../App.js';
import { TRADE } from '../../data/constants.js';
import {
  tradeBlockers, scoutRead, rapportOf, rapportGrade, clubMode, cooldownUntil, remainingShare,
} from '../../engine/TradeEngine.js';
import { proposeTrade, talkIsOpen, ourSideBlocker } from '../../engine/Negotiation.js';
import * as Finance from '../../engine/FinanceEngine.js';
import { formatK } from '../../engine/CardTokens.js';

let _d = null;          // the deal being built
let _view = 'deal';     // 'teams' | 'deal' | 'theirs' | 'ours'
let _read = null;       // the scout's read (lines), when asked

export function openTradeComposer({ teamId = null, theirIds = [], ourIds = [], cashK = 0, retain = {}, round = null } = {}) {
  _injectCSS();
  _d = { teamId, theirIds: [...theirIds], ourIds: [...ourIds], cashK, retain: { ...retain }, round };
  _view = teamId ? 'deal' : 'teams';
  _read = null;
  document.getElementById('tc-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tc-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet tc-sheet"><div class="modal-handle"></div><div id="tc-body"></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(); });
  _render();
}

function _close() { document.getElementById('tc-overlay')?.remove(); _d = null; }

function _render() {
  const body = document.getElementById('tc-body');
  const state = StateManager.get();
  if (!body || !state || !_d) return;
  body.innerHTML = _view === 'teams' ? _teamsHtml(state)
                 : _view === 'theirs' || _view === 'ours' ? _pickHtml(state, _view)
                 : _dealHtml(state);
  _wire(body, state);
}

// ── Choosing the club ────────────────────────────────────────

function _teamsHtml(state) {
  const now = Date.now();
  const rows = (state.leagueTeams || []).map(t => {
    const mode = clubMode(state, t.id);
    const cool = cooldownUntil(state, t.id) > now;
    const status = talkIsOpen(state, t.id, now) ? 'Talks open'
      : cool ? 'Not taking calls'
      : mode === 'buyer' ? 'Buying' : mode === 'seller' ? 'Selling' : '';
    return `<button class="tc-team" data-team="${t.id}">
      <span class="tc-team-name">${_esc(t.name)}</span>
      <span class="tc-team-meta">${t.wins || 0}–${t.losses || 0}${status ? ` · ${status}` : ''}</span>
      <span class="tc-team-grade">${rapportGrade(rapportOf(state, t.id))}</span>
    </button>`;
  }).join('');
  return `${_head('Other GMs', 'Choose a club to talk to. The grade is our relationship with their front office.')}
    <div class="tc-list">${rows}</div>`;
}

// ── The deal ─────────────────────────────────────────────────

function _offer() {
  return { incomingIds: _d.theirIds, outgoingIds: _d.ourIds, cashK: _d.cashK, retain: _d.retain };
}

function _dealHtml(state) {
  const team = (state.leagueTeams || []).find(t => t.id === _d.teamId);
  const offer = _offer();
  const blocked = tradeBlockers(offer, state, Date.now(), _d.teamId);
  const ours = ourSideBlocker(state, offer);
  const inSeason = remainingShare(state) > 0;
  const mode = clubMode(state, _d.teamId);
  const sub = `${team?.wins || 0}–${team?.losses || 0} · ${mode === 'buyer' ? 'Buying' : mode === 'seller' ? 'Selling' : 'Listening'} · Relationship: ${rapportGrade(rapportOf(state, _d.teamId))}`;
  const side = (ids, who) => ids.map(id => {
    const p = state.players[id];
    if (!p) return '';
    const kept = _d.retain[id] || 0;
    const keepCtl = inSeason && (p.contractSalary || 0) > 0
      ? `<div class="tc-keep">${who === 'theirs' ? 'They keep paying' : 'We keep paying'}:
          ${[0, 0.25, 0.5].map(v => `<button class="tc-pill${kept === v ? ' on' : ''}" data-keep="${id}" data-v="${v}">${v ? `${v * 100}%` : 'None'}</button>`).join('')}
        </div>` : '';
    return `<div class="tc-chip">
      <div class="tc-chip-main"><span class="tc-chip-name">${_esc(p.name)}</span>
        <span class="tc-chip-meta">${p.nativePos || p.pos} · OVR ${p.ovr} · ${formatK(p.contractSalary || 0)}</span>
        <button class="tc-x" data-drop="${id}" data-side="${who}" aria-label="Remove">Remove</button></div>
      ${keepCtl}
    </div>`;
  }).join('');
  const add = (ids, who, label) => ids.length < TRADE.maxPerSide
    ? `<button class="tc-add" data-pick="${who}">${label}</button>` : '';
  const c = _d.cashK;
  const cashLabel = c > 0 ? `They send ${formatK(c)}` : c < 0 ? `We send ${formatK(-c)}` : 'No cash';
  const payAfter = Finance.payrollOf(state, 'user') + _payDelta(state);
  const target = Finance.seasonTarget(state.userTeam.finances);
  const read = _read ? `<div class="tc-read"><div class="tc-read-from">Pro Scouting</div>${_read.map(l => `<p>${_esc(l)}</p>`).join('')}</div>` : '';
  const canSend = !blocked && !ours && (_d.theirIds.length || _d.ourIds.length);
  return `${_head(team?.name || 'Trade', sub, true)}
    ${blocked ? `<div class="tc-warn">Can't send right now: ${_esc(blocked)}.</div>` : ''}
    <div class="tc-sec">They send</div>
    ${side(_d.theirIds, 'theirs') || '<div class="tc-empty">No players yet.</div>'}
    ${add(_d.theirIds, 'theirs', 'Add from their roster')}
    <div class="tc-sec">We send</div>
    ${side(_d.ourIds, 'ours') || '<div class="tc-empty">No players yet.</div>'}
    ${add(_d.ourIds, 'ours', 'Add from our roster')}
    <div class="tc-sec">Cash</div>
    <div class="tc-cash"><button class="tc-step" data-cash="-50">−</button><span>${cashLabel}</span><button class="tc-step" data-cash="50">+</button></div>
    <div class="tc-hint">Minus: we send cash. Plus: they send cash.</div>
    <div class="tc-pay${payAfter > target ? ' over' : ''}">Our payroll after the deal: ${formatK(payAfter)} — ownership's target ${formatK(target)}${ours ? `<br>${_esc(ours[0].toUpperCase() + ours.slice(1))}.` : ''}</div>
    ${read}
    <div class="tc-actions">
      <button class="tc-btn" id="tc-scout" ${(_d.theirIds.length || _d.ourIds.length) ? '' : 'disabled'}>Ask Pro Scouting</button>
      <button class="tc-btn primary" id="tc-send" ${canSend ? '' : 'disabled'}>Send Offer</button>
    </div>`;
}

function _payDelta(state) {
  const P = (id) => state.players[id];
  const ret = _d.retain;
  const inK = _d.theirIds.filter(id => Finance.isPaid(P(id))).reduce((a, id) => a + (P(id)?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  const outK = _d.ourIds.filter(id => Finance.isPaid(P(id))).reduce((a, id) => a + (P(id)?.contractSalary || 0) * (1 - (ret[id] || 0)), 0);
  return Math.round(inK - outK);
}

// ── Picking players ──────────────────────────────────────────

function _pickHtml(state, who) {
  const club = who === 'theirs' ? (state.leagueTeams || []).find(t => t.id === _d.teamId) : state.userTeam;
  const chosen = who === 'theirs' ? _d.theirIds : _d.ourIds;
  const row = (p) => {
    const sel = chosen.includes(p.id);
    const unavailable = p.isInjured || p.group === 'il' || p.group === 'transit';
    return `<button class="tc-row${sel ? ' on' : ''}" data-toggle="${p.id}" ${unavailable ? 'disabled' : ''}>
      <span class="tc-row-name">${_esc(p.name)}</span>
      <span class="tc-row-meta">${p.nativePos || p.pos} · OVR ${p.ovr} · ${formatK(p.contractSalary || 0)}${unavailable ? ' · hurt' : ''}</span>
      <span class="tc-row-mark">${sel ? 'Added' : ''}</span>
    </button>`;
  };
  const byOvr = (ids) => ids.map(id => state.players[id]).filter(Boolean).sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  return `${_head(who === 'theirs' ? `${club?.name || 'Their'} roster` : 'Our roster', `Choose up to ${TRADE.maxPerSide}. Tap again to remove.`, true, 'tc-back')}
    <div class="tc-sec">Active roster</div><div class="tc-list">${byOvr(club?.rosterIds || []).map(row).join('')}</div>
    <div class="tc-sec">Farm</div><div class="tc-list">${byOvr(club?.farmIds || []).map(row).join('')}</div>
    <div class="tc-actions"><button class="tc-btn primary" id="tc-done">Done</button></div>`;
}

// ── Wiring ───────────────────────────────────────────────────

function _wire(body, state) {
  body.querySelector('#tc-close')?.addEventListener('click', _close);
  body.querySelector('#tc-back')?.addEventListener('click', () => { _view = 'deal'; _render(); });
  body.querySelectorAll('[data-team]').forEach(el => el.addEventListener('click', () => {
    _d.teamId = el.dataset.team; _d.theirIds = []; _view = 'deal'; _read = null; _render();
  }));
  body.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => { _view = el.dataset.pick; _render(); }));
  body.querySelector('#tc-done')?.addEventListener('click', () => { _view = 'deal'; _read = null; _render(); });
  body.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
    const list = _view === 'theirs' ? _d.theirIds : _d.ourIds;
    const id = el.dataset.toggle;
    const i = list.indexOf(id);
    if (i >= 0) { list.splice(i, 1); delete _d.retain[id]; }
    else if (list.length < TRADE.maxPerSide) list.push(id);
    _render();
  }));
  body.querySelectorAll('[data-drop]').forEach(el => el.addEventListener('click', () => {
    const list = el.dataset.side === 'theirs' ? _d.theirIds : _d.ourIds;
    const i = list.indexOf(el.dataset.drop);
    if (i >= 0) list.splice(i, 1);
    delete _d.retain[el.dataset.drop];
    _read = null; _render();
  }));
  body.querySelectorAll('[data-keep]').forEach(el => el.addEventListener('click', () => {
    const v = parseFloat(el.dataset.v);
    if (v > 0) _d.retain[el.dataset.keep] = v; else delete _d.retain[el.dataset.keep];
    _read = null; _render();
  }));
  body.querySelectorAll('[data-cash]').forEach(el => el.addEventListener('click', () => {
    _d.cashK += parseInt(el.dataset.cash, 10);
    _read = null; _render();
  }));
  body.querySelector('#tc-scout')?.addEventListener('click', () => {
    const offer = _offer();
    _read = scoutRead(offer, state, _d.teamId, ourSideBlocker(state, offer));
    _render();
  });
  body.querySelector('#tc-send')?.addEventListener('click', () => {
    const team = (state.leagueTeams || []).find(t => t.id === _d.teamId);
    const res = proposeTrade(_d.teamId, _offer(), Date.now(), { round: _d.round });
    if (!res.ok) { App.showToast(`Couldn't send: ${res.reason}.`, 'neutral', 3500); return; }
    App.showToast(`Offer sent to ${team?.name || 'them'}. An answer could take a few hours — or more than a day.`, 'neutral', 4200);
    _close();
  });
}

// ── Helpers ──────────────────────────────────────────────────

function _head(title, sub, back = false, backId = null) {
  return `<div class="tc-head">
    ${backId ? `<button class="tc-link" id="${backId}">Back</button>` : ''}
    <div class="tc-titles"><div class="tc-title">${_esc(title)}</div>${sub ? `<div class="tc-sub">${_esc(sub)}</div>` : ''}</div>
    <button class="modal-close" id="tc-close" aria-label="Close">×</button>
  </div>`;
}
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

let _css = false;
function _injectCSS() {
  if (_css || typeof document === 'undefined') return;
  _css = true;
  const st = document.createElement('style');
  st.textContent = `
    .tc-sheet{max-height:90dvh;overflow-y:auto;padding:0 16px max(16px,env(safe-area-inset-bottom));}
    .tc-head{display:flex;align-items:flex-start;gap:10px;padding:10px 0 12px;border-bottom:1px solid var(--border);margin-bottom:6px;}
    .tc-titles{flex:1;min-width:0;}
    .tc-title{font-size:17px;font-weight:700;color:var(--text);}
    .tc-sub{font-size:12px;color:var(--muted);margin-top:2px;}
    .tc-link{background:none;border:0;color:var(--muted);font:inherit;font-size:13px;font-weight:600;padding:6px 0;cursor:pointer;}
    .tc-sec{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin:14px 0 6px;}
    .tc-list{display:flex;flex-direction:column;gap:6px;}
    .tc-team,.tc-row{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface2);color:var(--text);font:inherit;text-align:left;cursor:pointer;}
    .tc-team-name,.tc-row-name{flex:1;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .tc-team-meta,.tc-row-meta{font-size:11px;color:var(--muted);white-space:nowrap;}
    .tc-team-grade,.tc-row-mark{font-size:11px;font-weight:700;color:var(--soft);min-width:52px;text-align:right;}
    .tc-row.on{border-color:var(--text);}
    .tc-row:disabled{opacity:.45;cursor:default;}
    .tc-chip{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:6px;background:var(--surface2);}
    .tc-chip-main{display:flex;align-items:center;gap:8px;}
    .tc-chip-name{font-size:14px;font-weight:600;color:var(--text);}
    .tc-chip-meta{flex:1;font-size:11px;color:var(--muted);}
    .tc-x{background:none;border:0;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;}
    .tc-keep{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap;}
    .tc-pill{border:1px solid var(--border);background:none;color:var(--soft);border-radius:12px;padding:3px 9px;font:inherit;font-size:11px;cursor:pointer;}
    .tc-pill.on{border-color:var(--text);color:var(--text);}
    .tc-empty{font-size:12px;color:var(--muted);padding:4px 0 8px;}
    .tc-add{width:100%;padding:9px;border:1px dashed var(--border);border-radius:10px;background:none;color:var(--soft);font:inherit;font-size:13px;cursor:pointer;}
    .tc-cash{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:10px;padding:6px;background:var(--surface2);font-size:14px;color:var(--text);}
    .tc-step{width:40px;height:34px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:18px;cursor:pointer;}
    .tc-hint{font-size:11px;color:var(--muted);margin-top:4px;}
    .tc-pay{font-size:12px;color:var(--soft);margin-top:14px;line-height:1.5;}
    .tc-pay.over{color:var(--danger);}
    .tc-warn{font-size:12px;color:var(--danger);border:1px solid var(--danger);border-radius:10px;padding:8px 10px;margin:8px 0;}
    .tc-read{margin-top:12px;border-left:2px solid var(--border);padding:4px 0 4px 12px;}
    .tc-read-from{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
    .tc-read p{font-size:13px;color:var(--text);line-height:1.45;margin:4px 0;}
    .tc-actions{display:flex;gap:8px;margin-top:16px;}
    .tc-btn{flex:1;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer;}
    .tc-btn.primary{background:var(--text);color:var(--bg);border-color:var(--text);}
    .tc-btn:disabled{opacity:.4;cursor:default;}
  `;
  document.head.appendChild(st);
}
