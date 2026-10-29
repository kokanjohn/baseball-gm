/**
 * ui/components/RatingHistory.js
 * §95 The club's Rating over time — opened from the Rating card on the
 * dashboard. A bottom sheet with a line chart of every change since the GM
 * took over (state.ratingHistory, kept for the life of the franchise), season
 * boundaries marked, a touch/hover crosshair with the date and rating, and a
 * list of the changes as a text view of the same data.
 *
 * The rating only changes at moments (a move, an injury, development), so the
 * line is drawn as steps: flat until the moment it changed.
 */

import { teamRating } from '../../engine/RosterEngine.js';

const W = 340, H = 190;                       // viewBox; scales to the sheet width
const PAD = { l: 30, r: 12, t: 22, b: 26 };

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const _dayYear = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The points to draw: the history, then today's rating at this moment. */
function _series(state, nowMs) {
  const h = (state.ratingHistory || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.r));
  const now = teamRating(state, 'user');
  const pts = h.map(p => ({ t: p.t, r: p.r, s: p.s || 1 }));
  if (now && (!pts.length || nowMs > pts[pts.length - 1].t)) {
    pts.push({ t: nowMs, r: now, s: state.seasonNum || 1, now: true });
  }
  return pts;
}

/** The rating in effect at time t (steps: the last change at or before t). */
function _at(pts, t) {
  let v = pts[0];
  for (const p of pts) { if (p.t <= t) v = p; else break; }
  return v;
}

function _chart(pts) {
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const rs = pts.map(p => p.r);
  let lo = Math.min(...rs), hi = Math.max(...rs);
  // A little room, and never a scale so tight a 1-point change looks like a cliff.
  const mid = (lo + hi) / 2;
  if (hi - lo < 6) { lo = Math.floor(mid - 3); hi = Math.ceil(mid + 3); }
  lo = Math.floor(lo - 1); hi = Math.ceil(hi + 1);
  const x = (t) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (r) => PAD.t + (1 - (r - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  // Recessive grid: three or four whole-number lines.
  const step = Math.max(1, Math.ceil((hi - lo) / 4));
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" class="rh-grid"/>`
         +  `<text x="${PAD.l - 6}" y="${y(v) + 3}" class="rh-axis" text-anchor="end">${v}</text>`;
  }

  // Season boundaries: a dashed line where each later season's first point is.
  let seasons = '';
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].s !== pts[i - 1].s) {
      const sx = x(pts[i].t);
      seasons += `<line x1="${sx}" x2="${sx}" y1="${PAD.t - 6}" y2="${H - PAD.b}" class="rh-season"/>`
              +  `<text x="${sx + 4}" y="${PAD.t - 9}" class="rh-axis">Season ${pts[i].s}</text>`;
    }
  }

  // The step line.
  let d = `M${x(pts[0].t)},${y(pts[0].r)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].r)}`;

  const last = pts[pts.length - 1];
  const xLabels = `<text x="${PAD.l}" y="${H - 8}" class="rh-axis">${_day(t0)}</text>`
                + `<text x="${W - PAD.r}" y="${H - 8}" class="rh-axis" text-anchor="end">${last.now ? 'Now' : _day(t1)}</text>`;

  return {
    svg: `<svg viewBox="0 0 ${W} ${H}" class="rh-svg" id="rh-svg" role="img" aria-label="Rating over time">
      ${grid}${seasons}
      <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}" class="rh-base"/>
      <path d="${d}" class="rh-line"/>
      <circle cx="${x(last.t)}" cy="${y(last.r)}" r="4" class="rh-end"/>
      ${xLabels}
      <g id="rh-cross" style="display:none;">
        <line id="rh-cross-line" y1="${PAD.t}" y2="${H - PAD.b}" class="rh-cross"/>
        <circle id="rh-cross-dot" r="5" class="rh-dot"/>
      </g>
      <rect x="${PAD.l}" y="0" width="${W - PAD.l - PAD.r}" height="${H}" fill="transparent" id="rh-hit"/>
    </svg>`,
    x, y, t0, t1,
  };
}

export function openRatingHistory(state) {
  document.getElementById('rating-history-overlay')?.remove();
  _css();
  const nowMs = Date.now();
  const pts = _series(state, nowMs);

  let content;
  if (pts.length < 2 || pts[pts.length - 1].t - pts[0].t < 60_000) {
    const r = pts[0]?.r ?? teamRating(state, 'user');
    content = `
      <div class="rh-summary"><div class="rh-now">${r}</div><div class="rh-sub">Rating today</div></div>
      <div class="rh-empty">The history starts the day you took over. Every time the rating moves — a trade, a call-up, an injury, a player developing — it's added here, season after season.</div>`;
  } else {
    const first = pts[0], last = pts[pts.length - 1];
    const hi = pts.reduce((a, p) => (p.r > a.r ? p : a)), lo = pts.reduce((a, p) => (p.r < a.r ? p : a));
    const delta = last.r - first.r;
    const c = _chart(pts);
    // The changes, newest first: the same data as text.
    const changes = [];
    for (let i = pts.length - 1; i >= 1; i--) if (!pts[i].now && pts[i].r !== pts[i - 1].r) changes.push({ p: pts[i], from: pts[i - 1].r });
    content = `
      <div class="rh-summary">
        <div class="rh-now">${last.r}</div>
        <div class="rh-sub">Rating now · ${delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`} since ${_dayYear(first.t)}</div>
      </div>
      <div class="rh-stats">
        <div><span class="rh-k">High</span> ${hi.r} <span class="rh-d">${_day(hi.t)}</span></div>
        <div><span class="rh-k">Low</span> ${lo.r} <span class="rh-d">${_day(lo.t)}</span></div>
        <div><span class="rh-k">Seasons</span> ${new Set(pts.map(p => p.s)).size}</div>
      </div>
      <div class="rh-chart">${c.svg}<div class="rh-tip" id="rh-tip" style="display:none;"></div></div>
      <div class="rh-list-head">Changes</div>
      <div class="rh-list">${changes.length ? changes.slice(0, 40).map(({ p, from }) => `
        <div class="rh-row"><span class="rh-row-d">${_dayYear(p.t)}</span><span class="rh-row-v">${from} → ${p.r}</span></div>`).join('')
        : '<div class="rh-row"><span class="rh-row-d">No changes yet</span></div>'}</div>`;
    setTimeout(() => _wireCrosshair(pts, c), 0);
  }

  const overlay = document.createElement('div');
  overlay.id = 'rating-history-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-height:86dvh;display:flex;flex-direction:column;">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div style="font-size:18px;font-weight:800;color:var(--text);">Rating</div>
        <button class="modal-close" id="rh-close" aria-label="Close">×</button>
      </div>
      <div class="modal-divider"></div>
      <div class="rh-body">${content}</div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => overlay.remove();
  overlay.querySelector('#rh-close')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

/** Crosshair + tooltip: touch and drag, or hover, anywhere along the chart. */
function _wireCrosshair(pts, c) {
  const svg = document.getElementById('rh-svg');
  const hit = document.getElementById('rh-hit');
  const cross = document.getElementById('rh-cross'), line = document.getElementById('rh-cross-line'), dot = document.getElementById('rh-cross-dot');
  const tip = document.getElementById('rh-tip');
  if (!svg || !hit) return;
  const show = (ev) => {
    const box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * W;
    const t = c.t0 + Math.max(0, Math.min(1, (sx - PAD.l) / (W - PAD.l - PAD.r))) * (c.t1 - c.t0);
    const p = _at(pts, t);
    const cx = c.x(t), cy = c.y(p.r);
    cross.style.display = '';
    line.setAttribute('x1', cx); line.setAttribute('x2', cx);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
    tip.style.display = '';
    tip.innerHTML = `<div class="rh-tip-v">${p.r}</div><div class="rh-tip-d">${_dayYear(t)} · Season ${p.s}</div>`;
    const px = (cx / W) * box.width;
    tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
  };
  const hide = () => { cross.style.display = 'none'; tip.style.display = 'none'; };
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);
}

function _css() {
  if (document.getElementById('rating-history-css')) return;
  const style = document.createElement('style');
  style.id = 'rating-history-css';
  // The line is a fixed readable blue, never the team color (§93: a dark team
  // color can't be read on the dark sheet); its own step for each theme.
  style.textContent = `
    #rating-history-overlay{--rh-line:#5AA9E6;}
    [data-theme="light"] #rating-history-overlay{--rh-line:#1F6FB2;}
    .rh-body{overflow-y:auto;padding:14px 18px max(18px,env(safe-area-inset-bottom));}
    .rh-summary{display:flex;align-items:baseline;gap:10px;}
    .rh-now{font-family:'Bebas Neue',sans-serif;font-size:44px;line-height:1;color:var(--text);}
    .rh-sub{font-size:13px;color:var(--muted);font-weight:600;}
    .rh-stats{display:flex;gap:18px;margin:10px 0 6px;font-size:14px;font-weight:700;color:var(--text);}
    .rh-k{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-right:4px;}
    .rh-d{font-size:11px;font-weight:600;color:var(--muted);}
    .rh-chart{position:relative;margin:6px -4px 8px;touch-action:none;}
    .rh-svg{width:100%;height:auto;display:block;overflow:visible;}
    .rh-grid{stroke:var(--border);stroke-width:1;}
    .rh-base{stroke:var(--border);stroke-width:1.5;}
    .rh-season{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;opacity:.7;}
    .rh-axis{font-size:9px;fill:var(--muted);font-family:'DM Sans',sans-serif;font-weight:600;}
    .rh-line{fill:none;stroke:var(--rh-line);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}
    .rh-end{fill:var(--rh-line);stroke:var(--surface);stroke-width:2;}
    .rh-cross{stroke:var(--muted);stroke-width:1;}
    .rh-dot{fill:var(--rh-line);stroke:var(--surface);stroke-width:2;}
    .rh-tip{position:absolute;top:-6px;pointer-events:none;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 9px;white-space:nowrap;box-shadow:0 4px 12px var(--shadow);}
    .rh-tip-v{font-size:16px;font-weight:800;color:var(--text);line-height:1.1;}
    .rh-tip-d{font-size:11px;color:var(--muted);font-weight:600;}
    .rh-empty{font-size:13px;line-height:1.6;color:var(--soft);margin-top:12px;}
    .rh-list-head{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 0 4px;}
    .rh-row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-size:13px;}
    .rh-row-d{color:var(--muted);font-weight:600;}
    .rh-row-v{color:var(--text);font-weight:700;}
  `;
  document.head.appendChild(style);
}
