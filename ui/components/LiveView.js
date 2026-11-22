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
    stale: !!(last?._halfInning && last._halfInning !== halfKey && !isFinal),   // (r234 the last play was the half before)
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
  // r248 §122.127 drawn like the radar's map: flat tones from its palette (land, relief, the warm "flat" for the
  // dirt), thin lines, the fence a border line with its distances marked like the map's water labels, the
  // outfield's mowing in faint bands like its terrain. (Grass green and dirt brown are gone.)
  const fence = [];
  for (let a = -45; a <= 45; a += 1.5) fence.push(xy(pt(a, fenceAt(a))));   // (r231 finer: a smooth arc)
  const arc = (ft) => { const out = []; for (let a = -45; a <= 45; a += 1.5) out.push(xy(pt(a, Math.min(ft, fenceAt(a))))); return out; };
  // (r231 the dirt's edge: a circle around the mound, as on a real infield — 110 feet from the mound, about 170 from
  //  the plate to straightaway center, 144 along the lines)
  const dirt = [];
  const ARC = 110, MOUND = 60.5;
  for (let a = -45; a <= 45; a += 2) {
    const s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180);
    dirt.push(xy(pt(a, MOUND * c + Math.sqrt(ARC * ARC - MOUND * MOUND * s * s))));
  }
  // the outfield's mowing: bands every 30 ft out from the dirt, alternate ones a shade lighter
  const bands = [];
  for (let d = 180, k = 0; d < 420; d += 30, k++) {
    if (k % 2) continue;
    const outer = arc(d + 30), inner = arc(d).reverse();
    bands.push(`<polygon class="lv-mow" points="${outer.join(' ')} ${inner.join(' ')}"/>`);
  }
  // the warning track: the last 12 ft inside the fence
  const track = [];
  for (let a = -45; a <= 45; a += 1.5) track.push(xy(pt(a, fenceAt(a) - 12)));
  const diamond = [pt(0, 0), pt(45, 90), pt(0, 127.3), pt(-45, 90)].map(xy).join(' ');
  const bag = (p) => `<rect x="${(p[0] - 3.6).toFixed(1)}" y="${(p[1] - 3.6).toFixed(1)}" width="7.2" height="7.2" transform="rotate(45 ${xy(p).replace(',', ' ')})" class="lv-bag"/>`;
  const [mx, my] = pt(0, 60.5);   // (the mound)
  const foulEnd = (sgn) => pt(sgn * 45, fenceAt(45));
  // the fence's distances, just beyond it: the lines, the gaps, center
  // (the lines' numbers a little in from the corners, so they clear the foul lines and the edges)
  const marks = [-45, -22.5, 0, 22.5, 45].map(a => {
    const corner = Math.abs(a) === 45;
    const [x, y] = pt(corner ? Math.sign(a) * 39 : a, fenceAt(a) + (corner ? 16 : 14));
    const anchor = 'middle';
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" class="lv-dist">${Math.round(fenceAt(a))}</text>`;
  }).join('');
  return `
    <rect class="lv-foul" x="0" y="${TOP}" width="${W}" height="${H - TOP}"/>
    <polygon class="lv-grass" points="${xy(pt(0, 0))} ${fence.join(' ')}"/>
    ${bands.join('')}
    <polygon class="lv-track" points="${fence.join(' ')} ${[...track].reverse().join(' ')}"/>
    <polyline class="lv-fence" points="${fence.join(' ')}"/>
    ${marks}
    <polygon class="lv-dirt" points="${xy(pt(0, 0))} ${dirt.join(' ')}"/>
    <circle class="lv-dirt" cx="${HX}" cy="${HY}" r="${(15 * IN).toFixed(1)}"/>
    <polygon class="lv-infield" points="${diamond}"/>
    <line class="lv-line" x1="${HX}" y1="${HY}" x2="${foulEnd(-1)[0].toFixed(1)}" y2="${foulEnd(-1)[1].toFixed(1)}"/>
    <line class="lv-line" x1="${HX}" y1="${HY}" x2="${foulEnd(1)[0].toFixed(1)}" y2="${foulEnd(1)[1].toFixed(1)}"/>
    <circle class="lv-mound" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="7"/>
    <rect class="lv-rubber" x="${(mx - 2.5).toFixed(1)}" y="${(my - 0.6).toFixed(1)}" width="5" height="1.2"/>
    ${bag(BASE.first)}${bag(BASE.second)}${bag(BASE.third)}
    <polygon class="lv-plate" points="${HX - 3.2},${HY - 2.8} ${HX + 3.2},${HY - 2.8} ${HX + 3.2},${HY} ${HX},${HY + 2.8} ${HX - 3.2},${HY}"/>
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
  let shownIndex = null, raf = null, staleTimer = null, cleared = false;
  const CLEAR_MS = 4000;   // (r234 a half that's over: its last play and path stay this long, then clear)
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
      out.push(label(x, y + 3.5, players[id]?.name || pos, 'lv-fname', id));   // (r234 the name alone, on the spot)
    };
    for (const pos of POS) if (v.fielders[pos]) put(pos, v.fielders[pos]);
    if (v.pitcher) put('P', v.pitcher);
    if (v.atBat && !v.isFinal) out.push(label(HX, HY - 7, players[v.atBat]?.name || '', 'lv-batter', v.atBat));   // (r234 centred over the plate: no side implied)
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
    // (r248 the path with a soft glow under it, like a storm track; where it lands, a dot and a ring)
    paths.innerHTML = `<line x1="${start[0]}" y1="${start[1]}" x2="${end[0].toFixed(1)}" y2="${end[1].toFixed(1)}" class="lv-glow ${cls}"/>`
      + `<line x1="${start[0]}" y1="${start[1]}" x2="${end[0].toFixed(1)}" y2="${end[1].toFixed(1)}" class="lv-path ${cls}${ground ? ' lv-ground' : ''}"/>`
      + `<g class="lv-landing"${animate ? ' opacity="0"' : ''}><circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="7" class="lv-ring ${cls}"/>`
      + `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="3" class="lv-land ${cls}"/></g>`;
    balls.innerHTML = `<ellipse class="lv-shadow" rx="3" ry="1.6"/><circle class="lv-ball" r="3"/>`;
    const sh = balls.querySelector('.lv-shadow'), bl = balls.querySelector('.lv-ball'), line = paths.querySelector('.lv-path'), glow = paths.querySelector('.lv-glow');
    const at = (t) => {
      const x = start[0] + (end[0] - start[0]) * t, y = start[1] + (end[1] - start[1]) * t;
      const lift = ground ? 0 : Math.sin(Math.PI * t) * (b.flight === 'line' ? 5 : b.hr ? 16 : 12);
      sh.setAttribute('cx', x.toFixed(1)); sh.setAttribute('cy', y.toFixed(1));
      bl.setAttribute('cx', x.toFixed(1)); bl.setAttribute('cy', (y - lift).toFixed(1));
      bl.setAttribute('r', (3 + lift / 6).toFixed(2));
      line.setAttribute('x2', x.toFixed(1)); line.setAttribute('y2', y.toFixed(1));
      glow.setAttribute('x2', x.toFixed(1)); glow.setAttribute('y2', y.toFixed(1));
    };
    if (!animate) { at(1); return; }
    const ms = ground ? 900 : b.hr ? 1700 : 1300, t0 = performance.now();
    const land = paths.querySelector('.lv-landing');
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
    // a half that's over: the play that ended it stays a few seconds, then the words and the path clear
    if (!v.stale) { clearTimeout(staleTimer); staleTimer = null; cleared = false; }
    const clearStale = () => { cleared = true; el.querySelector('.lv-last').textContent = ''; layer('lv-path-layer').innerHTML = ''; layer('lv-ball-layer').innerHTML = ''; };
    if (v.stale && !cleared && !staleTimer) {
      if (!moved) clearStale();   // (opened after it: already old)
      else staleTimer = setTimeout(() => { staleTimer = null; clearStale(); }, CLEAR_MS);
    }
    if (!(v.stale && cleared)) el.querySelector('.lv-last').textContent = v.last?.description || '';
    else { layer('lv-path-layer').innerHTML = ''; layer('lv-ball-layer').innerHTML = ''; }
    const name = (id) => (id ? `<button type="button" class="lv-link" data-pid="${id}">${_esc(players[id]?.name || '')}</button>` : '—');
    const bl = v.batLine, pl = v.pitLine;
    const batWords = bl ? [`${bl.h}-for-${bl.ab}`, bl.hr ? `${bl.hr} HR` : '', bl.rbi ? `${bl.rbi} RBI` : '', bl.bb ? `${bl.bb} BB` : '', bl.k ? `${bl.k} K` : ''].filter(Boolean).join(', ') : '';
    el.querySelector('.lv-rows').innerHTML = v.isFinal ? '' : `
      <div class="lv-row"><span class="lv-k">At bat</span><span class="lv-v">${name(v.atBat)}</span><span class="lv-s">${_esc(batWords)}</span></div>
      <div class="lv-row"><span class="lv-k">On deck</span><span class="lv-v">${name(v.onDeck)}</span></div>
      <div class="lv-row"><span class="lv-k">In the hole</span><span class="lv-v">${name(v.inHole)}</span></div>
      <div class="lv-row lv-row-wrap"><span class="lv-k">Pitching</span><span class="lv-v">${name(v.pitcher)}</span>${pl ? `<span class="lv-line2">${_esc(`${pl.ip} IP, ${pl.h} H, ${pl.er} ER, ${pl.bb} BB, ${pl.k} K, ${v.bf} batter${v.bf === 1 ? '' : 's'} faced`)}</span>` : ''}</div>`;
    const r = (s) => `<tr><td class="lv-t">${_esc(abbr[s])}</td><td>${v.rhe[s].r}</td><td>${v.rhe[s].h}</td><td>${v.rhe[s].e}</td></tr>`;
    const oppName = (st.leagueTeams || []).find(t => t.id === game.opponentId)?.name || 'Opponent';
    const uName = `${st.userTeam?.city || ''} ${st.userTeam?.nickname || ''}`.trim();
    el.querySelector('.lv-box').innerHTML = `<table class="lv-rhe"><thead><tr><th></th><th>R</th><th>H</th><th>E</th></tr></thead><tbody>${r('away')}${r('home')}</tbody></table>`
      + `<div class="lv-full">${renderBoxScore(v.box, { awayName: v.isHome ? oppName : uName, homeName: v.isHome ? uName : oppName })}</div>`;
  };

  const close = () => {
    listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(staleTimer);
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
    .lv-overlay{position:fixed;inset:0;z-index:450;background:var(--bg);display:flex;opacity:0;transform:translateY(16px);transition:opacity .2s ease,transform .2s ease;}
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
    /* r248 §122.127 the field in the radar map's palette (RadarMap PALETTE), dark and light */
    .lv-overlay{--f-land:#1c2029;--f-fair:#232833;--f-mow:#262c38;--f-edge:#2d3340;--f-dirt:#312d28;--f-dirt-edge:#3d3832;
      --f-track:#29272a;--f-fence:#454d63;--f-line:#9aa3b6;--f-dist:#5b6a82;--f-bag:#e8ecf4;--f-label:#d3d8e3;--f-halo:rgba(10,12,18,.92);
      --f-batter:#ffffff;--f-run:#facc15;--f-run-label:#fde68a;--f-out:#cbd5e1;}
    [data-theme="light"] .lv-overlay{--f-land:#e9e7e1;--f-fair:#dedad0;--f-mow:#e2ded5;--f-edge:#cfc9bb;--f-dirt:#e7dccb;--f-dirt-edge:#d4c6b0;
      --f-track:#ddd2c1;--f-fence:#a6a397;--f-line:#ffffff;--f-dist:#6d8399;--f-bag:#ffffff;--f-label:#2a2e38;--f-halo:rgba(246,244,239,.95);
      --f-batter:#111318;--f-run:#eab308;--f-run-label:#854d0e;--f-out:#475569;}
    .lv-field{padding:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--f-land);}
    .lv-field svg{display:block;width:100%;height:auto;max-height:52vh;}
    .lv-foul{fill:var(--f-land);} .lv-grass{fill:var(--f-fair);} .lv-mow{fill:var(--f-mow);}
    .lv-track{fill:var(--f-track);} .lv-fence{fill:none;stroke:var(--f-fence);stroke-width:2;stroke-linejoin:round;}
    .lv-dist{font:italic 600 8px -apple-system,system-ui,sans-serif;fill:var(--f-dist);}
    .lv-dirt{fill:var(--f-dirt);stroke:var(--f-dirt-edge);stroke-width:.8;}
    .lv-infield{fill:var(--f-fair);stroke:var(--f-line);stroke-width:.8;stroke-opacity:.45;}
    .lv-line{stroke:var(--f-line);stroke-width:.9;opacity:.5;}
    .lv-mound{fill:var(--f-dirt);stroke:var(--f-dirt-edge);stroke-width:.8;} .lv-rubber{fill:var(--f-bag);opacity:.8;}
    .lv-bag{fill:var(--f-bag);stroke:var(--f-edge);stroke-width:.6;} .lv-plate{fill:var(--f-bag);stroke:var(--f-edge);stroke-width:.6;}
    .lv-fname,.lv-rname,.lv-batter{font:700 9.5px -apple-system,system-ui,sans-serif;fill:var(--f-label);paint-order:stroke;stroke:var(--f-halo);stroke-width:2.8px;stroke-linejoin:round;cursor:pointer;}
    .lv-batter{font-size:10.5px;font-weight:800;fill:var(--f-batter);}
    .lv-runner{transition:transform .9s ease,opacity .4s ease;}
    .lv-rdot{fill:var(--f-run);stroke:var(--f-halo);stroke-width:1.6;}
    .lv-rname{fill:var(--f-run-label);}
    .lv-path{stroke-width:1.6;stroke-linecap:round;} .lv-ground{stroke-dasharray:3 3;}
    .lv-glow{stroke-width:6;stroke-linecap:round;opacity:.22;}
    .lv-ring{fill:none !important;stroke-width:1.2;opacity:.7;transform-box:fill-box;transform-origin:center;animation:lv-ping 1.6s ease-out 1;}
    @keyframes lv-ping{from{transform:scale(.4);opacity:1;}to{transform:scale(1);opacity:.7;}}
    .lv-p-hit{stroke:#facc15;fill:#facc15;} .lv-p-out{stroke:var(--f-out);fill:var(--f-out);} .lv-p-hr{stroke:#f87171;fill:#f87171;} .lv-p-err{stroke:#fb923c;fill:#fb923c;}
    [data-theme="light"] .lv-p-hit{stroke:#ca8a04;fill:#ca8a04;} [data-theme="light"] .lv-p-hr{stroke:#dc2626;fill:#dc2626;} [data-theme="light"] .lv-p-err{stroke:#ea580c;fill:#ea580c;}
    .lv-ball{fill:#fff;stroke:#333;stroke-width:.8;} .lv-shadow{fill:rgba(0,0,0,.35);}
    .lv-last{padding:14px 14px 4px;font-size:14px;font-weight:600;color:var(--text);min-height:20px;}
    .lv-rows{padding:2px 14px;}
    .lv-row{display:flex;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid var(--border);font-size:14px;}
    .lv-k{width:84px;flex:none;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);}
    .lv-v{font-weight:700;color:var(--text);}
    .lv-s{margin-left:auto;font-size:12px;color:var(--muted);text-align:right;}
    .lv-row-wrap{flex-wrap:wrap;} .lv-line2{flex-basis:100%;padding-left:94px;font-size:12px;color:var(--muted);margin-top:2px;}
    .lv-link{font:inherit;font-weight:700;color:var(--text);background:none;border:0;padding:0;cursor:pointer;}
    .lv-box{padding:8px 14px 0;}
    .lv-rhe{border-collapse:collapse;font-size:14px;color:var(--text);}
    .lv-rhe th{font-size:11px;font-weight:700;color:var(--muted);padding:2px 10px;}
    .lv-rhe td{padding:3px 10px;text-align:center;font-weight:700;}
    .lv-rhe .lv-t{text-align:left;padding-left:0;}
    .lv-full{margin:10px -14px 0;}`;
  document.head.appendChild(st);
}
