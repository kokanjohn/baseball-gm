/**
 * ui/components/AllStarCard.js
 * The All-Star Game on the Dashboard (§75). From the user's last game before
 * the break until the morning after the game, the game area belongs to it:
 *   - before first pitch: where and when, the two squads, our All-Stars and a
 *     countdown;
 *   - live: the same live card as our own games (DashboardScreen renders it
 *     with this module's view + game adapter), plus our All-Stars' lines;
 *   - final: the score, the MVP, our All-Stars' lines and the box score.
 *
 * Read-only: nothing here writes state. The game is a league-calendar game
 * whose plays reveal on the real clock (like every league game, §67).
 */

import * as AllStar from '../../engine/AllStarEngine.js';
import { GAME_STATUS, ALL_STAR_BREAK_AFTER_GAME } from '../../data/constants.js';

const AFTERGLOW_MS = 18 * 3600_000;   // the final stays up until the next morning

/**
 * allStarFeature(state, nextUserGame, nowMs)
 * The All-Star Game when it owns the game area: the user's last game before
 * the break is final, and it's not yet the morning after the game.
 */
export function allStarFeature(state, nextUserGame, nowMs = Date.now()) {
  const e = AllStar.gameEntry(state);
  if (!e) return null;
  const g = e.game;
  const lastBefore = (state.schedule || []).find(x => x.regularSeasonIndex === ALL_STAR_BREAK_AFTER_GAME - 1);
  if (!lastBefore?._committed) return null;
  if (nextUserGame && !nextUserGame._committed && nextUserGame.gameTime < g.gameTime) return null;
  if (g.played && nowMs > (g.endedAt || g.gameTime) + AFTERGLOW_MS) return null;
  return e;
}

/** Labels for the live card: the two squads, ours highlighted. */
export function allStarView(state, g) {
  const home = AllStar.clubFor(state, g.homeId), away = AllStar.clubFor(state, g.awayId);
  const mine = AllStar.userSquadId(state);
  return {
    awayFull: away.name, homeFull: home.name, awayAbbr: away.abbr, homeAbbr: home.abbr,
    awayIsUser: g.awayId === mine, homeIsUser: g.homeId === mine, userIsHome: g.homeId === mine,
    names: { awayName: away.name, homeName: home.name },
  };
}

/** The game as the live card reads it: plays revealed by the clock, home = side A. */
export function allStarGameLike(g, nowMs = Date.now()) {
  const plays = g.plays || [];
  let n = 0;
  while (n < plays.length && (plays[n]._timestamp || 0) <= nowMs) n++;
  return { ...g, isHome: true, livePlayIndex: n, _committed: !!g.played,
           status: g.played ? GAME_STATUS.FINAL : g.status };
}

export const allStarIsLive = (g) => !g.played && g.status === GAME_STATUS.LIVE && (g.plays?.length || 0) > 0;

/** A derived state for a finished game (plays are gone; the box remains). */
export function allStarFinalDs(g, view) {
  const box = g.boxScore || {};
  const ls = box.linescore || {};
  const maxInning = Math.max(9, ...Object.keys(ls).map(Number));
  const last = Math.max(...Object.keys(ls).map(Number), 9);
  const awayRunsByInn = [], homeRunsByInn = [];
  for (let inn = 1; inn <= maxInning; inn++) {
    awayRunsByInn.push(inn <= last ? (ls[inn]?.top ?? 0) : null);
    // The bottom of the last inning isn't played when the home side leads.
    const skipped = inn === last && (g.homeScore > g.awayScore) && !(ls[inn]?.bot);
    homeRunsByInn.push(inn <= last && !skipped ? (ls[inn]?.bot ?? 0) : null);
  }
  return {
    awayScore: g.awayScore ?? 0, homeScore: g.homeScore ?? 0,
    awayRunsByInn, homeRunsByInn, maxInning, curInning: last, curHalf: 'BOT',
    isFinal: true, isHome: view.userIsHome,
    awayHits: box.away?.hits ?? 0, homeHits: box.home?.hits ?? 0, awayErrors: 0, homeErrors: 0,
    innLabel: 'FINAL', outsLabel: '—', statusLabel: 'FINAL', statusCls: 'lgv-final',
    bases: {}, outs: 0, pbpPlays: [], revealedCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────
// PANELS
// ─────────────────────────────────────────────────────────────

const _esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _where(state, g) {
  const hostId = g.hostId || state.allStar?.season?.hostId;
  if (!hostId) return '';
  if (hostId === 'user') return `in ${state.userTeam.city || state.userTeam.name} — our ballpark`;
  const t = (state.leagueTeams || []).find(x => x.id === hostId);
  return t ? `in ${t.name.split(' ').slice(0, -1).join(' ')}` : '';
}

function _when(g) {
  const d = new Date(g.gameTime);
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** The ribbon above the card. */
export function renderAllStarHeader(state, g) {
  _injectCSS();
  const host = g.hostId || state.allStar?.season?.hostId;
  return `<div class="asg-ribbon${host === 'user' ? ' asg-ours' : ''}">
    <span class="asg-star">★</span>
    <span class="asg-title">All-Star Game</span>
    <span class="asg-where">${_esc(_where(state, g))}</span>
  </div>`;
}

/** Before first pitch: the matchup, the time, a countdown. */
export function renderAllStarPregame(state, g, nowMs = Date.now()) {
  _injectCSS();
  const v = allStarView(state, g);
  return `<div class="asg-pre">
    <div class="asg-match">
      <div class="asg-side${v.awayIsUser ? ' mine' : ''}">${_esc(v.awayFull)}</div>
      <div class="asg-at">at</div>
      <div class="asg-side${v.homeIsUser ? ' mine' : ''}">${_esc(v.homeFull)}</div>
    </div>
    <div class="asg-when">${_esc(_when(g))}</div>
    <div class="asg-count"><span class="asg-count-label">First pitch</span><span id="asg-fp-time">${countdownText(g.gameTime, nowMs)}</span></div>
  </div>`;
}

export function countdownText(gameTime, nowMs = Date.now()) {
  const ms = gameTime - nowMs;
  if (ms <= 0) return 'Now';
  const m = Math.ceil(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${mm ? mm + 'm' : ''}` : `${mm}m`;
}

/**
 * Our All-Stars: who they are and (once the game is on) how they're doing.
 * `box` is the live or final box score, or null before first pitch.
 */
export function renderMyAllStars(state, g, box = null) {
  _injectCSS();
  const mine = AllStar.userSelections(state);
  if (!mine.length) return '';
  const lineOf = (id) => {
    if (!box) return '';
    const h = [...(box.home?.hitters || []), ...(box.away?.hitters || [])].find(x => x.id === id);
    if (h && (h.ab || h.bb || h.hbp || h.r)) {
      const extra = [h.hr ? `${h.hr > 1 ? h.hr : ''}HR` : '', h.rbi ? `${h.rbi} RBI` : '', h.bb ? `${h.bb > 1 ? h.bb : ''}BB` : '', h.sb ? 'SB' : '']
        .filter(Boolean).join(', ');
      return `${h.h}-${h.ab}${extra ? `, ${extra}` : ''}`;
    }
    const p = [...(box.home?.pitchers || []), ...(box.away?.pitchers || [])].find(x => x.id === id);
    if (p) return `${p.ip} IP, ${p.er} ER, ${p.k} K`;
    return g.played ? 'Did not play' : '';
  };
  const mvpId = state.allStar?.season?.result?.mvpId;
  const role = (x) => x.role === 'starter' ? `Starter · ${x.slot}` : x.role === 'pitcher' ? state.players[x.id]?.pos : 'Reserve';
  const rows = mine.map(x => {
    const p = state.players[x.id];
    const ln = lineOf(x.id);
    return `<div class="asg-mine-row">
      <span class="asg-mine-name">${_esc(p?.name || '—')}${x.id === mvpId ? ' <b class="asg-mvp">MVP</b>' : ''}</span>
      <span class="asg-mine-role">${_esc(role(x))}</span>
      ${ln ? `<span class="asg-mine-line">${_esc(ln)}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="asg-mine">
    <div class="asg-mine-head">Our All-Stars</div>
    ${rows}
  </div>`;
}

/** After the final: the MVP line. */
export function renderAllStarResult(state, g) {
  const r = state.allStar?.season?.result;
  const mvp = r?.mvpId && state.players[r.mvpId];
  if (!mvp) return '';
  const club = mvp.teamId === 'user' ? state.userTeam : (state.leagueTeams || []).find(t => t.id === mvp.teamId);
  return `<div class="asg-result">MVP: <b>${_esc(mvp.name)}</b>${club ? ` (${_esc(club.abbr || club.name)})` : ''}</div>`;
}

let _css = false;
function _injectCSS() {
  if (_css || typeof document === 'undefined') return;
  _css = true;
  const st = document.createElement('style');
  st.textContent = `
    :root{--asg-gold:#c9971c;--asg-gold-soft:rgba(201,151,28,.14);}
    .asg-ribbon{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:8px 12px;border-radius:12px;
      background:linear-gradient(100deg,var(--asg-gold-soft),transparent 70%);border:1px solid var(--asg-gold);}
    .asg-ribbon.asg-ours{background:linear-gradient(100deg,rgba(201,151,28,.28),var(--asg-gold-soft) 60%,transparent);}
    .asg-star{color:var(--asg-gold);font-size:16px;line-height:1;}
    .asg-title{font-family:'Bebas Neue',sans-serif;font-size:19px;letter-spacing:1px;color:var(--text);line-height:1;}
    .asg-where{margin-left:auto;font-size:11px;font-weight:600;color:var(--muted);text-align:right;}
    .asg-pre{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-bottom:8px;}
    .asg-match{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;}
    .asg-side{font-size:14px;font-weight:700;color:var(--text);text-align:center;}
    .asg-side.mine{color:var(--accent);}
    .asg-at{font-size:11px;color:var(--muted);}
    .asg-when{text-align:center;font-size:12px;color:var(--muted);margin-top:6px;}
    .asg-count{display:flex;justify-content:center;align-items:baseline;gap:8px;margin-top:10px;}
    .asg-count-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
    #asg-fp-time{font-family:'Bebas Neue',sans-serif;font-size:30px;line-height:1;color:var(--asg-gold);}
    .asg-mine{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px 14px;margin-bottom:8px;}
    .asg-mine-head{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
    .asg-mine-row{display:grid;grid-template-columns:1fr auto;gap:0 10px;padding:5px 0;border-top:1px solid var(--border);}
    .asg-mine-row:first-of-type{border-top:none;}
    .asg-mine-name{font-size:13px;font-weight:600;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .asg-mine-role{font-size:11px;color:var(--muted);text-align:right;}
    .asg-mine-line{grid-column:1 / -1;font-size:12px;color:var(--soft,var(--muted));}
    .asg-mvp{font-size:9px;font-weight:800;letter-spacing:.5px;color:#fff;background:var(--asg-gold);padding:1px 5px;border-radius:6px;margin-left:4px;}
    .asg-result{font-size:13px;color:var(--text);padding:8px 16px;border-top:1px solid var(--border);}
    .asg-result b{color:var(--asg-gold);}
  `;
  document.head.appendChild(st);
}
