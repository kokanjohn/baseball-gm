/**
 * ui/components/LiveGame.js
 * Live CPU games (§67, plan §28.4): every league game is a real simulated game
 * whose plays reveal on the real clock. This module renders
 *   - renderLeagueLiveRow(state)   — the row of small square cards on the
 *                                    Dashboard (one per CPU game in progress)
 *   - openLeagueGame(date, id)     — the viewer sheet: score, diamond, outs,
 *                                    linescore, play-by-play, box score.
 *                                    Opened from the Dashboard cards and from
 *                                    Schedule → Scores.
 *
 * Read-only: nothing here writes state. What is "revealed" is derived from
 * the clock (plays whose timestamp has passed), so it is the same everywhere.
 */

import * as StateManager from '../../store/StateManager.js';
import { GAME_STATUS } from '../../data/constants.js';
import { accumulateBox, liveSituation, playRuns } from '../../engine/SimEngine.js';
import { renderBoxScore } from './BoxScore.js';
import { clubFor } from '../../engine/AllStarEngine.js';
import { wxState, elapsedLabel, weatherLine, gameNotes } from './WeatherStatus.js';

// ─────────────────────────────────────────────────────────────
// DERIVED LIVE STATE
// ─────────────────────────────────────────────────────────────

/** Every CPU game in progress right now, earliest first pitch first. */
export function liveLeagueGames(state, nowMs = Date.now()) {
  const out = [];
  for (const [date, games] of Object.entries(state?.leagueSchedule?.dayMap || {})) {
    for (const g of games) {
      // (The All-Star Game has the Dashboard's game area to itself, §75.)
      if (g.status === GAME_STATUS.LIVE && g.plays?.length && !g.isAllStar) out.push({ date, game: g });
    }
  }
  return out.sort((a, b) => a.game.gameTime - b.game.gameTime);
}

/**
 * leagueGameState(g, nowMs)
 * Score / inning / outs / bases / linescore for a CPU game at `nowMs`. A CPU
 * game's plays are generated with the HOME team as side A (cumOurScore).
 */
export function leagueGameState(g, nowMs = Date.now()) {
  const final = g.played || g.status === GAME_STATUS.FINAL;
  const plays = g.plays || [];
  const revealed = final ? plays : plays.filter(p => (p._timestamp || 0) <= nowMs);
  const last = revealed[revealed.length - 1];
  let homeScore = final ? (g.homeScore ?? 0) : (last?.cumOurScore ?? 0);
  let awayScore = final ? (g.awayScore ?? 0) : (last?.cumTheirScore ?? 0);
  const next = final ? null : plays[revealed.length] ?? null;
  const { inning, half, outs, bases } = liveSituation(revealed, next);

  // Linescore (from the box once final, else from revealed plays).
  const runs = {};
  if (final && g.boxScore?.linescore) {
    for (const [inn, v] of Object.entries(g.boxScore.linescore)) runs[inn] = { top: v.top, bot: v.bot };
  } else {
    for (const p of revealed) {
      if (!p.inning || (p.half !== 'TOP' && p.half !== 'BOT') || p.type === 'game_end') continue;
      runs[p.inning] = runs[p.inning] || { top: null, bot: null };
      const k = p.half === 'TOP' ? 'top' : 'bot';
      runs[p.inning][k] = (runs[p.inning][k] || 0) + playRuns(p);
    }
  }
  // §102.4 the weather's hold on it (a delay, a delayed start, a suspension).
  const wx = wxState(g, revealed);
  return { final, revealed, homeScore, awayScore, inning, half, outs, bases, runs, wx };
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD ROW
// ─────────────────────────────────────────────────────────────

/** The compact row of live league games (empty string when none). */
export function renderLeagueLiveRow(state, nowMs = Date.now()) {
  _injectCSS();
  const live = liveLeagueGames(state, nowMs);
  if (!live.length) return '';
  const abbr = (id) => _abbr(state, id);
  const cards = live.map(({ date, game: g }) => {
    const ls = leagueGameState(g, nowMs);
    const lead = (a, b) => (a > b ? ' lg-lead' : '');
    return `
      <button class="lg-mini" data-lg-date="${date}" data-lg-id="${g.id}" aria-label="${abbr(g.awayId)} at ${abbr(g.homeId)}">
        <div class="lg-mini-row${lead(ls.awayScore, ls.homeScore)}"><span>${abbr(g.awayId)}</span><b>${ls.awayScore}</b></div>
        <div class="lg-mini-row${lead(ls.homeScore, ls.awayScore)}"><span>${abbr(g.homeId)}</span><b>${ls.homeScore}</b></div>
        <div class="lg-mini-foot">
          <span class="lg-mini-inn">${ls.wx.kind ? '<span class="lg-mini-wx">DELAY</span>' : `${ls.half === 'TOP' ? '▲' : '▼'}${ls.inning}`}</span>
          ${_diamond(ls.bases, 18)}
        </div>
      </button>`;
  }).join('');
  return `
    <div class="lg-row-wrap">
      <div class="lg-row-head">Around the league <span class="lg-live-dot">● LIVE</span></div>
      <div class="lg-row">${cards}</div>
    </div>`;
}

/** Wire taps on any rendered mini cards / score rows inside `root`. */
export function wireLeagueGameTaps(root) {
  root?.querySelectorAll('[data-lg-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openLeagueGame(el.dataset.lgDate, el.dataset.lgId);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// VIEWER SHEET
// ─────────────────────────────────────────────────────────────

let _viewerTimer = null;

/** Opens the live viewer for one league game; refreshes every 5 s while open. */
export function openLeagueGame(date, id) {
  _injectCSS();
  document.getElementById('lg-viewer')?.remove();
  clearInterval(_viewerTimer);
  const overlay = document.createElement('div');
  overlay.id = 'lg-viewer';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-sheet lg-sheet"><div class="modal-handle"></div><div id="lg-viewer-body"></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => { clearInterval(_viewerTimer); overlay.remove(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Redraw only when the game itself moved (a new play, first pitch, the
  // final) — never on a quiet poll, so the viewer holds its scroll. The
  // sheet keeps its position across a redraw; the play-by-play list opens
  // on its newest play, which is the one that just arrived.
  let shown = null;
  const render = () => {
    const state = StateManager.get();
    const g = (state?.leagueSchedule?.dayMap?.[date] || []).find(x => x.id === id);
    const body = overlay.querySelector('#lg-viewer-body');
    if (!g || !body) return;
    const now = Date.now();
    const sig = `${g.status}|${g.played ? 'F' : ''}|${leagueGameState(g, now).revealed.length}`;
    if (sig !== shown) {
      shown = sig;
      const sheet = overlay.querySelector('.lg-sheet');
      const keep = sheet ? sheet.scrollTop : 0;
      body.innerHTML = _viewerHtml(state, g, now);
      body.querySelector('#lg-close')?.addEventListener('click', close);
      if (sheet) sheet.scrollTop = keep;
    }
    if (g.played) clearInterval(_viewerTimer);
  };
  render();
  _viewerTimer = setInterval(() => {
    if (!document.getElementById('lg-viewer')) { clearInterval(_viewerTimer); return; }
    render();
  }, 5000);
}

function _viewerHtml(state, g, now = Date.now()) {
  const ls  = leagueGameState(g, now);
  const away = _team(state, g.awayId), home = _team(state, g.homeId);
  const notStarted = !ls.final && g.status !== GAME_STATUS.LIVE && g.status !== GAME_STATUS.SUSPENDED;
  const status = ls.final ? '<span class="lg-pill lg-final">Final</span>'
    : ls.wx.kind ? `<span class="lg-pill lg-wx">${_esc(ls.wx.title)}</span>`
    : notStarted ? `<span class="lg-pill lg-final">${new Date(g.gameTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`
    : '<span class="lg-pill lg-live">● Live</span>';
  // §102.4 under the header: the weather's hold on the game, or what it was played in; the schedule's notes.
  const wxText = ls.wx.kind
    ? `${ls.wx.sub}${ls.wx.kind === 'delay' || ls.wx.kind === 'start-delay' ? ` (${elapsedLabel(now - ls.wx.sinceMs)} so far)` : ''}`
    : weatherLine(g);
  const notes = gameNotes(g);
  const wxRow = wxText || notes.length ? `<div class="lg-wx">${_esc([wxText, ...notes].filter(Boolean).join(' · '))}</div>` : '';

  // Box: committed box when final, else accumulated from revealed plays.
  let box = g.boxScore;
  if (!ls.final && ls.revealed.length) {
    box = accumulateBox(ls.revealed, state.players || {}, {
      awayOrder: g.liveLineups?.away || [], homeOrder: g.liveLineups?.home || [],
      userIsHome: true, homeIds: g.liveLineups?.homeIds || null,
    });
  }

  const pbp = ls.revealed
    .filter(p => p.description && !['inning_end', 'game_end'].includes(p.type))
    .slice(-30).reverse()
    .map(p => `<div class="lg-pbp${p.type === 'hr' ? ' hr' : ''}${p._wx || p.type === 'game_suspended' || p.type === 'game_resumed' ? ' wx' : ''}">
        <span class="lg-pbp-inn">${p.half === 'TOP' ? '▲' : '▼'}${p.inning}</span>
        <span>${_esc(p.description)}</span></div>`).join('');

  const maxInn = Math.max(9, ...Object.keys(ls.runs).map(Number));
  const cell = (inn, k) => {
    const v = ls.runs[inn]?.[k];
    return `<td>${v === null || v === undefined ? '' : v}</td>`;
  };
  const inns = Array.from({ length: maxInn }, (_, i) => i + 1);
  const hits = (side) => box?.[side]?.hits ?? 0;

  return `
    <div class="lg-head">
      <div class="lg-teams">
        <div class="lg-team${ls.awayScore > ls.homeScore ? ' lg-lead' : ''}"><span>${_esc(away?.name || g.awayId)}</span><b>${ls.awayScore}</b></div>
        <div class="lg-team${ls.homeScore > ls.awayScore ? ' lg-lead' : ''}"><span>${_esc(home?.name || g.homeId)}</span><b>${ls.homeScore}</b></div>
      </div>
      <div class="lg-side">
        ${status}
        ${!ls.final && !notStarted ? `<div class="lg-inn">${ls.half === 'TOP' ? 'Top' : 'Bot'} ${ls.inning}</div>${_diamond(ls.bases, 34)}
          <div class="lg-outs">${[0, 1, 2].map(i => `<i class="${i < ls.outs ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      </div>
      <button class="modal-close" id="lg-close" aria-label="Close">×</button>
    </div>
    ${wxRow}
    ${notStarted ? '<div class="lg-empty">First pitch hasn\'t been thrown yet.</div>' : `
    <div class="lg-ls"><table>
      <thead><tr><th></th>${inns.map(i => `<th>${i}</th>`).join('')}<th>R</th><th>H</th></tr></thead>
      <tbody>
        <tr><td class="lg-ls-team">${_abbr(state, g.awayId)}</td>${inns.map(i => cell(i, 'top')).join('')}<td class="t">${ls.awayScore}</td><td class="t">${hits('away')}</td></tr>
        <tr><td class="lg-ls-team">${_abbr(state, g.homeId)}</td>${inns.map(i => cell(i, 'bot')).join('')}<td class="t">${ls.homeScore}</td><td class="t">${hits('home')}</td></tr>
      </tbody></table></div>
    ${pbp ? `<div class="lg-sec">Play-by-play</div><div class="lg-pbp-list">${pbp}</div>` : ''}
    ${box ? `<div class="lg-sec">Box score</div>${renderBoxScore(box, { awayName: away?.name, homeName: home?.name })}` : ''}`}
  `;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _team(state, id) { return clubFor(state, id); }
function _abbr(state, id) { return (_team(state, id)?.abbr || String(id).slice(0, 3)).toUpperCase(); }

function _diamond(bases, size) {
  const f = (b) => (b ? 'var(--text)' : 'transparent');
  return `<svg viewBox="0 0 44 38" width="${size}" height="${Math.round(size * 0.86)}" aria-hidden="true">
    <rect x="17" y="3" width="10" height="10" rx="1" fill="${f(bases?.second)}" stroke="var(--muted)" stroke-width="1.5" transform="rotate(45,22,8)"/>
    <rect x="30" y="16" width="10" height="10" rx="1" fill="${f(bases?.first)}" stroke="var(--muted)" stroke-width="1.5" transform="rotate(45,35,21)"/>
    <rect x="4" y="16" width="10" height="10" rx="1" fill="${f(bases?.third)}" stroke="var(--muted)" stroke-width="1.5" transform="rotate(45,9,21)"/>
  </svg>`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _css = false;
function _injectCSS() {
  if (_css || typeof document === 'undefined') return;
  _css = true;
  const st = document.createElement('style');
  st.textContent = `
    .lg-row-wrap{margin:10px 0 4px;}
    .lg-row-head{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:0 2px 6px;display:flex;gap:8px;align-items:center;}
    .lg-live-dot{color:var(--danger);font-size:9px;letter-spacing:.5px;}
    .lg-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px;}
    .lg-mini{aspect-ratio:1/1;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:6px 7px;
      display:flex;flex-direction:column;justify-content:space-between;text-align:left;color:var(--text);font-family:inherit;cursor:pointer;min-width:0;}
    .lg-mini:active{transform:scale(.97);}
    .lg-mini-row{display:flex;justify-content:space-between;font-size:11px;font-weight:600;color:var(--muted);}
    .lg-mini-row b{font-family:'Bebas Neue',sans-serif;font-size:17px;line-height:1;color:var(--muted);}
    .lg-mini-row.lg-lead,.lg-mini-row.lg-lead b{color:var(--text);}
    .lg-mini-foot{display:flex;justify-content:space-between;align-items:center;}
    .lg-mini-inn{font-size:10px;font-weight:700;color:var(--text);}
    .lg-sheet{max-height:88dvh;overflow-y:auto;padding-bottom:max(16px,env(safe-area-inset-bottom));}
    .lg-head{display:flex;align-items:flex-start;gap:10px;padding:6px 16px 12px;border-bottom:1px solid var(--border);}
    .lg-teams{flex:1;min-width:0;}
    .lg-team{display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600;color:var(--muted);padding:2px 0;}
    .lg-team span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .lg-team b{font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1;margin-left:10px;}
    .lg-team.lg-lead{color:var(--text);}
    .lg-side{display:flex;flex-direction:column;align-items:center;gap:4px;}
    .lg-pill{font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:3px 7px;border-radius:10px;border:1px solid var(--border);color:var(--muted);}
    .lg-pill.lg-live{color:var(--danger);border-color:var(--danger);}
    .lg-pill.lg-wx{color:#f97316;border-color:rgba(249,115,22,.5);}
    .lg-wx{margin:0 16px 8px;font-size:11px;color:var(--soft);line-height:1.35;}
    .lg-pbp.wx span:last-child{color:#f97316;font-weight:600;}
    .lg-mini-wx{color:#f97316;font-weight:800;font-size:9px;letter-spacing:.5px;}
    .lg-inn{font-size:12px;font-weight:700;color:var(--text);}
    .lg-outs{display:flex;gap:3px;}
    .lg-outs i{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--muted);}
    .lg-outs i.on{background:var(--danger);border-color:var(--danger);}
    .lg-ls{overflow-x:auto;padding:8px 16px;border-bottom:1px solid var(--border);}
    .lg-ls table{border-collapse:collapse;width:100%;font-size:11px;}
    .lg-ls th{color:var(--muted);font-weight:600;padding:2px 3px;text-align:center;}
    .lg-ls td{text-align:center;color:var(--muted);padding:2px 3px;}
    .lg-ls td.t{color:var(--text);font-weight:700;}
    .lg-ls .lg-ls-team{text-align:left;color:var(--text);font-weight:700;}
    .lg-sec{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:12px 16px 4px;}
    .lg-pbp-list{padding:0 16px;max-height:260px;overflow-y:auto;}
    .lg-pbp{display:flex;gap:8px;font-size:12px;color:var(--text);padding:4px 0;border-bottom:1px solid var(--border);}
    .lg-pbp.hr{font-weight:700;}
    .lg-pbp-inn{color:var(--muted);font-size:10px;font-weight:700;min-width:22px;}
    .lg-empty{padding:24px 16px;text-align:center;color:var(--muted);font-size:13px;}
  `;
  document.head.appendChild(st);
}
