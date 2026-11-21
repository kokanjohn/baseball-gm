/**
 * ui/components/LiveView.js
 * r229 §122.108 The Live View: our game on the field, opened from the live game card ("Live View").
 *   - the nine fielders at their positions by last name, the pitcher on the mound (tap for the player card);
 *   - the runners on base by name; the batter at the plate, on deck and in the hole;
 *   - each new play: the ball travels from the plate to where it was fielded (r226's spot) and the runners move;
 *     the path stays until the next play;
 *   - score, inning, outs, the last play in words; a simple box score: R/H/E, the batter's line today, the pitcher's.
 * Read-only: everything is derived from the game's revealed plays (the same clock as the card).
 *
 *   openLiveView(game)            open it on this game (ours)
 *   liveViewState(game, state)    the view's facts (exported for the checks)
 */

import * as StateManager from '../../store/StateManager.js';
import * as EventBus from '../EventBus.js';
import { GAME_STATUS } from '../../data/constants.js';
import { liveSituation, accumulateBox, fenceAt } from '../../engine/SimEngine.js';
import { wxState } from './WeatherStatus.js';
import { openPlayerCard } from './PlayerCard.js';
import { renderBoxScore } from './BoxScore.js';   // (the live card's Stats tab: the same box)

// ─────────────────────────────────────────────────────────────
// THE FACTS
// ─────────────────────────────────────────────────────────────

const PA_TYPES = new Set(['single', 'double', 'triple', 'hr', 'walk', 'hbp', 'strikeout', 'groundout', 'flyout', 'double_play',
  'fielders_choice', 'sac_fly', 'sac_bunt', 'error']);
const HIT = new Set(['single', 'double', 'triple', 'hr']);
const POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
// Where each fielder stands (degrees from straight away, feet from the plate).
const STAND = { P: [0, 60.5], C: [0, -19], '1B': [38, 112], '2B': [17, 148], SS: [-17, 148], '3B': [-38, 112], LF: [-28, 275], CF: [0, 315], RF: [28, 275] };

/** The fielders from a lineup's slots (a game from before r229): C … the outfield left, center, right in order. */
function _fieldFromSlots(team) {
  const out = {}, ofs = ['LF', 'CF', 'RF'];
  let of = 0;
  for (const sl of team?.lineupSlots || []) {
    if (!sl?.playerId || sl.slot === 'DH') continue;
    if (sl.slot === 'OF') { if (of < 3) out[ofs[of++]] = sl.playerId; } else out[sl.slot] = sl.playerId;
  }
  return out;
}

export function liveViewState(game, state) {
  const players = state.players || {};
  const plays = game.plays || [];
  const final = game.status === GAME_STATUS.FINAL || !!game._committed;
  const idx = final ? plays.length : (game.livePlayIndex || 0);
  const revealed = plays.slice(0, idx);
  const isFinal = final || revealed.some(p => p.type === 'game_end');
  const sit = liveSituation(revealed, plays[idx] ?? null);
  const isHome = !!game.isHome;

  let our = 0, their = 0;
  for (let i = revealed.length - 1; i >= 0; i--) if (revealed[i].cumOurScore != null) { our = revealed[i].cumOurScore; their = revealed[i].cumTheirScore; break; }
  const score = { away: isHome ? their : our, home: isHome ? our : their };

  const bat = sit.half === 'TOP' ? 'away' : 'home', field = bat === 'away' ? 'home' : 'away';
  const halfKey = `${sit.half}_${sit.inning}`;

  // The batting orders, with the substitutions made so far.
  const orders = { away: [...(game.liveLineups?.away || [])], home: [...(game.liveLineups?.home || [])] };
  const byName = (side, name) => orders[side].find(id => players[id]?.name === name) || null;
  const swap = (side, from, to) => { const i = orders[side].indexOf(from); if (i >= 0 && to) orders[side][i] = to; };
  for (const p of revealed) {
    const side = p.half === 'TOP' ? 'away' : 'home';
    if (p.type === 'pinch_hit') swap(side, p._for || byName(side, (p.description || '').split(' pinch hits for ')[1]), p.batterId);
    if (p.type === 'injury' && p._injury?.role === 'hitter') swap(side, p._injury.playerId, p._injury.subId);
  }

  // At bat: the next plate appearance in this half (a pinch hitter announced counts).
  let atBat = null, atBatFor = null;
  if (!isFinal) for (let i = idx; i < plays.length; i++) {
    const p = plays[i];
    if (p._halfInning && p._halfInning !== halfKey) break;
    if (p.type === 'pinch_hit') { atBat = p.batterId; atBatFor = p._for || byName(bat, (p.description || '').split(' pinch hits for ')[1]); break; }
    if (p.batterId && PA_TYPES.has(p.type)) { atBat = p.batterId; break; }
  }
  const order = orders[bat];
  let at = atBat ? order.indexOf(atBat) : -1;
  if (at < 0 && atBatFor) at = order.indexOf(atBatFor);
  const onDeck = at >= 0 && order.length ? order[(at + 1) % order.length] : null;
  const inHole = at >= 0 && order.length ? order[(at + 2) % order.length] : null;

  // The fielders this half (saved on the half's first play), else from the fielding club's lineup.
  const fieldPlay = plays.find(p => p._halfInning === halfKey && p._field);
  const fieldingUser = (field === 'home') === isHome;
  const opp = (state.leagueTeams || []).find(t => t.id === game.opponentId);
  const fielders = fieldPlay?._field || _fieldFromSlots(fieldingUser ? state.userTeam : opp);

  // The pitcher: the fielding club's latest so far (a change not yet announced isn't shown); at the very start, the
  // one about to throw the first pitch.
  let pitcher = null;
  for (let i = revealed.length - 1; i >= 0; i--) {
    const p = revealed[i];
    if (p.pitcherId && p.half && (p.half === 'TOP' ? 'home' : 'away') === field) { pitcher = p.pitcherId; break; }
  }
  if (!pitcher) for (let i = idx; i < plays.length; i++) if (plays[i].pitcherId && plays[i].half && (plays[i].half === 'TOP' ? 'home' : 'away') === field) { pitcher = plays[i].pitcherId; break; }

  // The last ball in play (its spot; a play from before r226: placed at the fielder).
  let ball = null;
  for (let i = revealed.length - 1; i >= 0; i--) {
    const p = revealed[i];
    if (!PA_TYPES.has(p.type) || ['walk', 'hbp', 'strikeout'].includes(p.type)) continue;
    let b = p._ball;
    if (!b && p._fielderId) {
      const f = Object.entries(p._field || fielders).find(([, id]) => id === p._fielderId)?.[0];
      if (f && STAND[f]) b = { at: f, flight: ['groundout', 'double_play', 'fielders_choice'].includes(p.type) ? 'ground' : 'fly', angle: STAND[f][0], dist: STAND[f][1] };
    }
    if (b) ball = { ...b, index: i, type: p.type, hit: HIT.has(p.type), hr: p.type === 'hr', err: p.type === 'error' };
    break;
  }
  const last = [...revealed].reverse().find(p => p.description && !['inning_end', 'game_end', 'game_start'].includes(p.type)) || null;

  const box = accumulateBox(revealed, players, { awayOrder: game.liveLineups?.away || [], homeOrder: game.liveLineups?.home || [],
    userIsHome: isHome, homeIds: game.liveLineups?.homeIds || null });
  const batLine = atBat ? box[bat].hitters.find(h => h.id === atBat) || null : null;
  const pitLine = pitcher ? box[field].pitchers.find(x => x.id === pitcher) || null : null;
  const bf = pitcher ? revealed.filter(p => p.pitcherId === pitcher && p.batterId && PA_TYPES.has(p.type)).length : 0;

  // The runners now, and who scored on the last play (for the motion).
  const scoredLast = last ? Object.entries(last._statDeltas || {}).filter(([, ds]) => ds.some(d => d.stat === 'r')).map(([id]) => id) : [];
  const wx = wxState(game, revealed);

  return { isFinal, isHome, inning: sit.inning, half: sit.half, outs: sit.outs, bases: sit.bases, score, bat, field,
    atBat, onDeck, inHole, fielders, pitcher, ball, last, lastIndex: revealed.length - 1, scoredLast,
    box, batLine, pitLine, bf, rhe: { away: { r: score.away, h: box.away.hits, e: box.away.errors }, home: { r: score.home, h: box.home.hits, e: box.home.errors } },
    status: isFinal ? 'Final' : wx.kind ? wx.pill : game.status === GAME_STATUS.DELAYED ? 'Delayed' : 'Live' };
}

// ─────────────────────────────────────────────────────────────
// THE FIELD (SVG)
// ─────────────────────────────────────────────────────────────

// (r229 the infield drawn larger than true scale, so the names fit: feet to pixels at IN out to KNEE feet — the diamond
//  square — and OUT beyond, the outfield compressed. Every spot goes through the same scale, so a ball lands where it was
//  fielded, relative to the fielders and the fence.)
const W = 380, H = 376, HX = 190, HY = 340, TOP = 8, IN = 1.05, KNEE = 130, OUT = 0.6;
const rad = (a) => a * Math.PI / 180;
const px = (d) => (d <= KNEE ? d * IN : KNEE * IN + (d - KNEE) * OUT);
const pt = (a, d) => { const r = d < 0 ? d * IN : px(d); return [HX + r * Math.sin(rad(a)), HY - r * Math.cos(rad(a))]; };
const xy = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
const BASE = { first: pt(45, 90), second: pt(0, 127.3), third: pt(-45, 90), home: pt(0, 0) };

function _fieldSvg() {
  const fence = [];
  for (let a = -45; a <= 45; a += 3) fence.push(xy(pt(a, fenceAt(a))));
  const dirt = [];
  for (let a = -45; a <= 45; a += 3) dirt.push(xy(pt(a, 158)));   // (the arc, past second base)
  const diamond = [pt(0, 0), pt(45, 90), pt(0, 127.3), pt(-45, 90)].map(xy).join(' ');
  const bag = (p) => `<rect x="${(p[0] - 4.5).toFixed(1)}" y="${(p[1] - 4.5).toFixed(1)}" width="9" height="9" transform="rotate(45 ${xy(p).replace(',', ' ')})" class="lv-bag"/>`;
  const [mx, my] = pt(0, 60.5);   // (the mound)
  return `
    <rect class="lv-foul" x="0" y="${TOP}" width="${W}" height="${H - TOP}"/>
    <polygon class="lv-grass" points="${xy(pt(0, 0))} ${fence.join(' ')}"/>
    <polyline class="lv-fence" points="${fence.join(' ')}"/>
    <polygon class="lv-dirt" points="${xy(pt(0, 0))} ${dirt.join(' ')}"/>
    <circle class="lv-dirt" cx="${HX}" cy="${HY}" r="${(15 * IN).toFixed(1)}"/>
    <polygon class="lv-infield" points="${diamond}"/>
    <line class="lv-line" x1="${HX}" y1="${HY}" x2="${xy(pt(-45, fenceAt(45))).split(',')[0]}" y2="${xy(pt(-45, fenceAt(45))).split(',')[1]}"/>
    <line class="lv-line" x1="${HX}" y1="${HY}" x2="${xy(pt(45, fenceAt(45))).split(',')[0]}" y2="${xy(pt(45, fenceAt(45))).split(',')[1]}"/>
    <circle class="lv-mound" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="8"/>
    ${bag(BASE.first)}${bag(BASE.second)}${bag(BASE.third)}
    <polygon class="lv-plate" points="${HX - 3.5},${HY - 3} ${HX + 3.5},${HY - 3} ${HX + 3.5},${HY} ${HX},${HY + 3} ${HX - 3.5},${HY}"/>
    <g class="lv-path-layer"></g>
    <g class="lv-fielder-layer"></g>
    <g class="lv-runner-layer"></g>
    <g class="lv-ball-layer"></g>`;
}

// ─────────────────────────────────────────────────────────────
// OPEN / UPDATE / CLOSE
// ─────────────────────────────────────────────────────────────

let _open = null;

/** Open the Live View on our game (`game`: the schedule's game object). */
export function openLiveView(game) {
  if (_open) _open.close();
  _css();
  const key = { id: game.id, gameTime: game.gameTime };
  const find = () => (StateManager.get().schedule || []).find(g => (key.id != null && g.id === key.id) || g.gameTime === key.gameTime) || null;
  const el = document.createElement('div');
  el.id = 'live-view';
  el.className = 'lv-overlay';
  el.innerHTML = `
    <div class="lv-panel" role="dialog" aria-label="Live View">
      <div class="lv-head">
        <div class="lv-score"></div>
        <button class="lv-done" type="button">Done</button>
      </div>
      <div class="lv-sit"></div>
      <div class="lv-field"><svg viewBox="0 ${TOP} ${W} ${H - TOP}" preserveAspectRatio="xMidYMid meet">${_fieldSvg()}</svg></div>
      <div class="lv-last"></div>
      <div class="lv-rows"></div>
      <div class="lv-box"></div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));

  const svg = el.querySelector('svg');
  const layer = (c) => svg.querySelector(`.${c}`);
  const runners = new Map();   // id → <g>
  let shownIndex = null, raf = null;
  const listeners = [];
  const wire = (event, handler) => { EventBus.on(event, handler); listeners.push({ event, handler }); };

  const tap = (e) => {
    const t = e.target.closest?.('[data-pid]');
    if (!t) return;
    openPlayerCard(t.dataset.pid, StateManager.get());
  };
  el.addEventListener('click', tap);

  const label = (x, y, text, cls, pid, anchor = 'middle') =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="${cls}"${pid ? ` data-pid="${pid}"` : ''}>${_esc(text)}</text>`;

  const drawFielders = (v, players) => {
    const out = [];
    const put = (pos, id) => {
      const [a, d] = STAND[pos];
      const [x, y] = pt(a, d);
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" class="lv-fdot"/>`);
      out.push(label(x, pos === 'C' ? y + 11 : y - 6, players[id]?.name || pos, 'lv-fname', id));   // (the catcher's under: the batter's at the plate)
    };
    for (const pos of POS) if (v.fielders[pos]) put(pos, v.fielders[pos]);
    if (v.pitcher) put('P', v.pitcher);
    if (v.atBat && !v.isFinal) out.push(label(HX - 9, HY + 1, players[v.atBat]?.name || '', 'lv-batter', v.atBat, 'end'));
    layer('lv-fielder-layer').innerHTML = out.join('');
  };

  const placeRunner = (g, p) => { g.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`; };
  const drawRunners = (v, players, moved) => {
    const now = new Map();
    for (const b of ['first', 'second', 'third']) if (v.bases[b]) now.set(v.bases[b], b);
    // gone: scored (to the plate) or out (fade)
    for (const [id, g] of runners) {
      if (now.has(id)) continue;
      runners.delete(id);
      if (moved && v.scoredLast.includes(id)) { placeRunner(g, BASE.home); g.style.opacity = '0'; setTimeout(() => g.remove(), 1100); }
      else { g.style.opacity = '0'; setTimeout(() => g.remove(), 500); }
    }
    for (const [id, b] of now) {
      let g = runners.get(id);
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'lv-runner');
        const side = { first: [9, 3.5, 'start'], second: [0, -9, 'middle'], third: [-9, 3.5, 'end'] }[b];
        g.innerHTML = `<circle r="5" class="lv-rdot"/>` + label(side[0], side[1], players[id]?.name || '', 'lv-rname', id, side[2]);
        placeRunner(g, moved ? BASE.home : BASE[b]);
        layer('lv-runner-layer').appendChild(g);
        runners.set(id, g);
        if (moved) { void g.getBoundingClientRect(); }
      }
      requestAnimationFrame(() => placeRunner(g, BASE[b]));
    }
  };

  const drawBall = (v, animate) => {
    const paths = layer('lv-path-layer'), balls = layer('lv-ball-layer');
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (!v.ball) { paths.innerHTML = ''; balls.innerHTML = ''; return; }
    const b = v.ball, end = pt(b.angle, b.dist), start = BASE.home;
    const cls = b.hr ? 'lv-p-hr' : b.err ? 'lv-p-err' : b.hit ? 'lv-p-hit' : 'lv-p-out';
    const ground = b.flight === 'ground' || b.flight === 'bunt';
    paths.innerHTML = `<line x1="${start[0]}" y1="${start[1]}" x2="${end[0].toFixed(1)}" y2="${end[1].toFixed(1)}" class="lv-path ${cls}${ground ? ' lv-ground' : ''}"/>`
      + `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="3" class="lv-land ${cls}"${animate ? ' opacity="0"' : ''}/>`;
    balls.innerHTML = `<ellipse class="lv-shadow" rx="3" ry="1.6"/><circle class="lv-ball" r="3"/>`;
    const sh = balls.querySelector('.lv-shadow'), bl = balls.querySelector('.lv-ball'), line = paths.querySelector('line');
    const at = (t) => {
      const x = start[0] + (end[0] - start[0]) * t, y = start[1] + (end[1] - start[1]) * t;
      const lift = ground ? 0 : Math.sin(Math.PI * t) * (b.flight === 'line' ? 5 : b.hr ? 16 : 12);
      sh.setAttribute('cx', x.toFixed(1)); sh.setAttribute('cy', y.toFixed(1));
      bl.setAttribute('cx', x.toFixed(1)); bl.setAttribute('cy', (y - lift).toFixed(1));
      bl.setAttribute('r', (3 + lift / 6).toFixed(2));
      line.setAttribute('x2', x.toFixed(1)); line.setAttribute('y2', y.toFixed(1));
    };
    if (!animate) { at(1); return; }
    const ms = ground ? 900 : b.hr ? 1700 : 1300, t0 = performance.now();
    const land = paths.querySelector('.lv-land');
    const step = (now) => { const t = Math.min(1, (now - t0) / ms); at(t); if (t < 1) raf = requestAnimationFrame(step); else land?.removeAttribute('opacity'); };
    at(0); raf = requestAnimationFrame(step);
  };

  const update = () => {
    const state = StateManager.get(), game = find();
    if (!game) return;
    const v = liveViewState(game, state), players = state.players || {};
    const st = state, oppAbbr = (st.leagueTeams || []).find(t => t.id === game.opponentId)?.abbr || 'OPP';
    const uAbbr = st.userTeam?.abbr || 'US';
    const abbr = { away: v.isHome ? oppAbbr : uAbbr, home: v.isHome ? uAbbr : oppAbbr };
    el.querySelector('.lv-score').innerHTML = `<span>${_esc(abbr.away)} <b>${v.score.away}</b></span><span class="lv-dash">·</span><span>${_esc(abbr.home)} <b>${v.score.home}</b></span>`;
    el.querySelector('.lv-sit').innerHTML = v.isFinal ? '<span class="lv-pill lv-final">Final</span>'
      : `<span class="lv-inn">${v.half === 'TOP' ? 'Top' : 'Bottom'} ${v.inning}</span><span>${v.outs} out${v.outs === 1 ? '' : 's'}</span><span class="lv-pill${v.status === 'Live' ? ' lv-live' : ''}">${_esc(v.status)}</span>`;
    const moved = shownIndex !== null && v.lastIndex !== shownIndex;
    drawFielders(v, players);
    drawRunners(v, players, moved);
    // (on opening: as it stands; on a new play: the ball travels if that play put it in play)
    if (shownIndex === null || moved) drawBall(v, moved && !!v.ball && v.ball.index === v.lastIndex);
    shownIndex = v.lastIndex;
    el.querySelector('.lv-last').textContent = v.last?.description || '';
    const name = (id) => (id ? `<button type="button" class="lv-link" data-pid="${id}">${_esc(players[id]?.name || '')}</button>` : '—');
    const bl = v.batLine, pl = v.pitLine;
    const batWords = bl ? [`${bl.h}-for-${bl.ab}`, bl.hr ? `${bl.hr} HR` : '', bl.rbi ? `${bl.rbi} RBI` : '', bl.bb ? `${bl.bb} BB` : '', bl.k ? `${bl.k} K` : ''].filter(Boolean).join(', ') : '';
    el.querySelector('.lv-rows').innerHTML = v.isFinal ? '' : `
      <div class="lv-row"><span class="lv-k">At bat</span><span class="lv-v">${name(v.atBat)}</span><span class="lv-s">${_esc(batWords)}</span></div>
      <div class="lv-row"><span class="lv-k">On deck</span><span class="lv-v">${name(v.onDeck)}</span></div>
      <div class="lv-row"><span class="lv-k">In the hole</span><span class="lv-v">${name(v.inHole)}</span></div>
      <div class="lv-row"><span class="lv-k">Pitching</span><span class="lv-v">${name(v.pitcher)}</span><span class="lv-s">${pl ? _esc(`${pl.ip} IP, ${pl.h} H, ${pl.er} ER, ${pl.bb} BB, ${pl.k} K, ${v.bf} BF`) : ''}</span></div>`;
    const r = (s) => `<tr><td class="lv-t">${_esc(abbr[s])}</td><td>${v.rhe[s].r}</td><td>${v.rhe[s].h}</td><td>${v.rhe[s].e}</td></tr>`;
    const oppName = (st.leagueTeams || []).find(t => t.id === game.opponentId)?.name || 'Opponent';
    const uName = `${st.userTeam?.city || ''} ${st.userTeam?.nickname || ''}`.trim();
    el.querySelector('.lv-box').innerHTML = `<table class="lv-rhe"><thead><tr><th></th><th>R</th><th>H</th><th>E</th></tr></thead><tbody>${r('away')}${r('home')}</tbody></table>`
      + `<div class="lv-full">${renderBoxScore(v.box, { awayName: v.isHome ? oppName : uName, homeName: v.isHome ? uName : oppName })}</div>`;
  };

  const close = () => {
    listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
    if (raf) cancelAnimationFrame(raf);
    el.classList.remove('open');
    setTimeout(() => el.remove(), 200);
    _open = null;
  };
  el.querySelector('.lv-done').addEventListener('click', close);
  wire('game:tick', update);
  wire('game:committed', update);
  update();
  _open = { close, update };
  return _open;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _css() {
  if (document.getElementById('live-view-css')) return;
  const st = document.createElement('style');
  st.id = 'live-view-css';
  st.textContent = `
    .lv-overlay{position:fixed;inset:0;z-index:1000;background:var(--bg);display:flex;opacity:0;transform:translateY(16px);transition:opacity .2s ease,transform .2s ease;}
    .lv-overlay.open{opacity:1;transform:none;}
    .lv-panel{flex:1;display:flex;flex-direction:column;min-height:0;overflow-y:auto;padding:max(8px,env(safe-area-inset-top)) 0 max(12px,env(safe-area-inset-bottom));}
    .lv-panel > *{flex-shrink:0;}   /* (a long page scrolls; nothing in it is squeezed) */
    .lv-head{display:flex;align-items:center;gap:10px;padding:6px 14px 2px;}
    .lv-score{display:flex;align-items:baseline;gap:8px;font-size:18px;font-weight:700;color:var(--text);}
    .lv-score b{font-size:22px;font-weight:800;}
    .lv-dash{color:var(--muted);}
    .lv-done{margin-left:auto;font:inherit;font-size:14px;font-weight:700;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:7px 12px;cursor:pointer;}
    .lv-sit{display:flex;align-items:center;gap:10px;padding:2px 14px 6px;font-size:13px;font-weight:600;color:var(--muted);}
    .lv-inn{color:var(--text);}
    .lv-pill{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:var(--surface2);color:var(--text);}
    .lv-pill.lv-live{background:#14532d;color:#86efac;}
    [data-theme="light"] .lv-pill.lv-live{background:#dcfce7;color:#166534;}
    .lv-field{padding:0 6px;}
    .lv-field svg{display:block;width:100%;height:auto;max-height:52vh;}
    .lv-grass{fill:#2f6e43;} .lv-foul{fill:#29603b;} .lv-fence{fill:none;stroke:#1d4a2c;stroke-width:3;}
    .lv-dirt{fill:#9a7348;} .lv-infield{fill:#a98053;stroke:#f1f1f1;stroke-width:1;stroke-opacity:.7;}
    .lv-line{stroke:#f1f1f1;stroke-width:1;opacity:.85;}
    .lv-mound{fill:#a77d51;stroke:#8a6440;} .lv-bag{fill:#fafafa;} .lv-plate{fill:#fafafa;}
    .lv-fdot{fill:#1e3a8a;stroke:#fff;stroke-width:1;}
    .lv-fname,.lv-rname,.lv-batter{font:700 9.5px -apple-system,system-ui,sans-serif;fill:#fff;paint-order:stroke;stroke:rgba(0,0,0,.75);stroke-width:2.6px;cursor:pointer;}
    .lv-batter{font-size:10.5px;}
    .lv-runner{transition:transform .9s ease,opacity .4s ease;}
    .lv-rdot{fill:#facc15;stroke:#111;stroke-width:1.2;}
    .lv-rname{fill:#fde68a;}
    .lv-path{stroke-width:1.6;stroke-linecap:round;opacity:.9;} .lv-ground{stroke-dasharray:3 3;}
    .lv-p-hit{stroke:#facc15;fill:#facc15;} .lv-p-out{stroke:#e5e7eb;fill:#e5e7eb;} .lv-p-hr{stroke:#f87171;fill:#f87171;} .lv-p-err{stroke:#fb923c;fill:#fb923c;}
    .lv-ball{fill:#fff;stroke:#333;stroke-width:.8;} .lv-shadow{fill:rgba(0,0,0,.35);}
    .lv-last{padding:14px 14px 4px;font-size:14px;font-weight:600;color:var(--text);min-height:20px;}
    .lv-rows{padding:2px 14px;}
    .lv-row{display:flex;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid var(--border);font-size:14px;}
    .lv-k{width:84px;flex:none;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);}
    .lv-v{font-weight:700;color:var(--text);}
    .lv-s{margin-left:auto;font-size:12px;color:var(--muted);text-align:right;}
    .lv-link{font:inherit;font-weight:700;color:var(--text);background:none;border:0;padding:0;cursor:pointer;}
    .lv-box{padding:8px 14px 0;}
    .lv-rhe{border-collapse:collapse;font-size:14px;color:var(--text);}
    .lv-rhe th{font-size:11px;font-weight:700;color:var(--muted);padding:2px 10px;}
    .lv-rhe td{padding:3px 10px;text-align:center;font-weight:700;}
    .lv-rhe .lv-t{text-align:left;padding-left:0;}
    .lv-full{margin:10px -14px 0;}`;
  document.head.appendChild(st);
}
