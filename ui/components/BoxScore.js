/**
 * ui/components/BoxScore.js
 * Shared box-score renderer. Consumes the boxScore object produced by
 * SimEngine.accumulateBox — committed games pass game.boxScore; the live view
 * passes accumulateBox(revealedPlays, ...). ONE box UI for the Schedule result
 * sheet and the Dashboard live card (replaces three drifting inline versions).
 *
 * Box shape: { linescore, away:{runs,hits,hitters[],pitchers[]}, home:{...}, userIsHome }
 *   hitter: { id, name, pos, ab, r, h, doubles, hr, tb, rbi, bb, hbp, k, sb, cs, sf, sac }
 *   pitcher: { id, name, ip, ipOuts, h, er, bb, k, hr, dec }
 */

export function renderBoxScore(box, opts = {}) {
  if (!box || !box.away || !box.home) return '';
  const awayName = opts.awayName || 'Away';
  const homeName = opts.homeName || 'Home';
  _injectCSS();
  return `<div class="bxs">${_side(awayName, box.away)}${_side(homeName, box.home)}</div>`;
}

function _side(name, side) {
  return `
  <div class="bxs-side">
    <div class="bxs-team">${_esc(name)}<span class="bxs-tot"> ${side.runs} R · ${side.hits} H</span></div>
    ${_batTable(side.hitters)}
    ${_pitTable(side.pitchers)}
  </div>`;
}

function _lastName(n) { return (n || '—').split(' ').slice(-1)[0]; }
function _avg(h, ab)  { return ab > 0 ? (h / ab).toFixed(3).replace(/^0/, '') : '—'; }
function _era(er, o)  { return o > 0 ? ((er / (o / 3)) * 9).toFixed(2) : '—'; }

function _batTable(hitters) {
  if (!hitters || !hitters.length) return '';
  const rows = hitters.map(b => `
    <tr>
      <td class="bxs-name">${_esc(_lastName(b.name))}${b.pos ? `<span class="bxs-pos"> ${_esc(b.pos)}</span>` : ''}</td>
      <td>${b.ab}</td><td>${b.r}</td><td>${b.h}</td><td>${b.rbi}</td>
      <td>${b.bb}</td><td>${b.k}</td><td>${b.sb || 0}</td>
      <td class="bxs-rate">${_avg(b.h, b.ab)}</td>
    </tr>`).join('');
  return `
  <div class="bxs-scroll">
    <table class="bxs-tbl">
      <thead><tr><th class="bxs-name">Batting</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th><th>AVG</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _pitTable(pitchers) {
  if (!pitchers || !pitchers.length) return '';
  const rows = pitchers.map(p => `
    <tr>
      <td class="bxs-name">${_esc(_lastName(p.name))}${p.dec ? `<span class="bxs-dec"> (${p.dec})</span>` : ''}</td>
      <td>${p.ip}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td>
      <td class="bxs-rate">${_era(p.er, p.ipOuts)}</td>
    </tr>`).join('');
  return `
  <div class="bxs-scroll">
    <table class="bxs-tbl">
      <thead><tr><th class="bxs-name">Pitching</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let _cssDone = false;
function _injectCSS() {
  if (_cssDone) return; _cssDone = true;
  const css = `
  .bxs-side { padding: 0 14px 4px; }
  .bxs-team { font-size:11px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text); margin:12px 0 5px; }
  .bxs-tot { color:var(--muted); font-weight:600; }
  .bxs-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; margin-bottom:6px; }
  .bxs-tbl { width:100%; border-collapse:collapse; min-width:300px; }
  .bxs-tbl th, .bxs-tbl td { text-align:center; padding:3px 5px; font-size:12px; color:var(--soft); white-space:nowrap; }
  .bxs-tbl thead th { font-size:10px; color:var(--muted); font-weight:700; border-bottom:1px solid var(--border); }
  .bxs-tbl td.bxs-name, .bxs-tbl th.bxs-name { text-align:left; position:sticky; left:0; background:var(--surface,#161616); font-weight:600; color:var(--text); min-width:78px; }
  .bxs-pos { color:var(--muted); font-weight:400; font-size:10px; }
  .bxs-dec { color:var(--accent,#F5D253); font-weight:700; }
  .bxs-rate { color:#60a5fa; }
  `;
  const el = document.createElement('style');
  el.id = 'bxs-css';
  el.textContent = css;
  document.head.appendChild(el);
}
