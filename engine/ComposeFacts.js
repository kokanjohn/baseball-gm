/**
 * engine/ComposeFacts.js
 * §106 What the staff know when they write back to the GM: the club as it
 * stands at the moment of the reply. Pure — reads a state, never writes it,
 * never imports StateManager. Each fact is worked out the first time a reply
 * asks for it (forecasts are not cheap), then kept for the rest of that reply.
 *
 * The staff know only what the club could know: the weather comes from the
 * same forecasts and observations the GM sees (never the game's own weather
 * plan); a game's result only once it has been played and committed.
 *
 *   composeFacts(state, atMs) → facts (lazy getters, see below)
 */

import { PHASE, PLAYER_GROUP, PITCH_SP_REST_DAYS } from '../data/constants.js';
import { weatherContext, MS_HOUR, MS_DAY, localHour, localDayStart, baseballDateIso } from './WeatherClimate.js';
import { forecastForGame } from './GameWeather.js';
import { dailyForecastDay } from './WeatherForecast.js';
import { rainTotal, conditionsAt } from './WeatherConditions.js';
import { armStatus, starterRested, bullpenRoles, dayOf } from './PitchingEngine.js';
import { computeAge, baseballYear, isAvailable } from './PlayerFactory.js';
import { developmentStatus } from './DevelopmentEngine.js';

const REGULAR = new Set([PHASE.REGULAR_SEASON, PHASE.ALL_STAR_BREAK, PHASE.TRADE_DEADLINE]);
const POST    = new Set([PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);

export const avgOf  = (h, ab) => (ab > 0 ? h / ab : 0);
export const fmtAvg = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(3).replace(/^0/, ''));
export const eraOf  = (er, ip) => (ip > 0 ? (9 * er) / ip : 0);

/**
 * "tonight", "tomorrow", "June 12" — a moment as someone writing at `atMs` would put it. Past tomorrow
 * it's the baseball calendar's date, as the schedule shows it (the app never names weekdays: the real
 * calendar's weekday would not match the baseball date).
 */
export function dayWord(t, atMs, tzMin, cal = null) {
  const d = Math.round((localDayStart(t, tzMin) - localDayStart(atMs, tzMin)) / MS_DAY);
  const h = localHour(t, tzMin);
  if (d === 0) return h >= 17 ? 'tonight' : 'today';
  if (d === 1) return h >= 17 ? 'tomorrow night' : 'tomorrow';
  if (d === -1) return h >= 17 ? 'last night' : 'yesterday';
  const iso = baseballDateIso(cal, t);
  const [, m, day] = (iso || new Date(t).toISOString().slice(0, 10)).split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${day}`;
}

/** "7:05" — a first pitch in the club's local time. */
export function clockWord(t, tzMin) {
  const d = new Date(t + tzMin * 60_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
}

export function composeFacts(state, atMs) {
  const memo = {};
  const once = (k, f) => () => (k in memo ? memo[k] : (memo[k] = f()));
  const u = state.userTeam || {};
  const players = state.players || {};
  const P = (id) => players[id];
  const wx = once('wx', () => weatherContext(state));
  const tz = () => wx().tzMin;
  const year = baseballYear(state);

  // ── The calendar ──────────────────────────────────────────────
  const phase = state.phase;
  const season = REGULAR.has(phase) ? 'regular' : POST.has(phase) ? 'post'
    : phase === PHASE.SPRING_TRAINING ? 'spring' : 'off';

  const upcoming = once('upcoming', () => (state.schedule || [])
    .filter(g => !g._committed && !g.cancelled && Number.isFinite(g.gameTime) && g.gameTime + 4 * MS_HOUR > atMs)
    .sort((a, b) => a.gameTime - b.gameTime));
  const played = once('played', () => (state.schedule || [])
    .filter(g => g._committed && g.boxScore && !g.cancelled && Number.isFinite(g.gameTime) && g.gameTime <= atMs)
    .sort((a, b) => b.gameTime - a.gameTime));            // newest first
  const nextGame = () => upcoming()[0] || null;
  const liveNow = () => { const g = nextGame(); return g && g.gameTime <= atMs ? g : null; };
  const lastGame = () => played()[0] || null;
  const oppTeam = (id) => (state.leagueTeams || []).find(t => t.id === id) || null;
  const venueId = (g) => g?.venueId || (g?.isHome ? 'user' : g?.opponentId) || 'user';
  const atHome = (g) => venueId(g) === 'user';
  const nextHome = () => upcoming().find(atHome) || null;

  /** The run of games against the next opponent (a series), from the next game on. */
  const nextSeries = once('nextSeries', () => {
    const g = nextGame();
    if (!g) return null;
    const run = [];
    for (const x of upcoming()) { if (x.opponentId !== g.opponentId || atHome(x) !== atHome(g)) break; run.push(x); }
    return { games: run, opp: oppTeam(g.opponentId), home: atHome(g) };
  });
  /** Home games coming up within `days` days. */
  const homeGamesWithin = (days) => upcoming().filter(g => atHome(g) && g.gameTime - atMs <= days * MS_DAY);
  /** Days with no game of ours in the next `days` days (local calendar days). */
  const offDays = (days = 10) => {
    const out = [];
    const z = tz();
    const busy = new Set(upcoming().map(g => localDayStart(g.gameTime, z)));
    const d0 = localDayStart(atMs, z);
    for (let d = 1; d <= days; d++) { const t = d0 + d * MS_DAY; if (!busy.has(t) && upcoming().some(g => g.gameTime > t)) out.push(t + 12 * MS_HOUR); }
    return out;
  };

  // ── Record, standing, momentum ─────────────────────────────────
  const record = () => ({ w: u.wins || 0, l: u.losses || 0, streak: u.streak || 0 });
  const standing = once('standing', () => {
    for (const rows of Object.values(state.standings || {})) {
      const i = (rows || []).findIndex(r => r.id === 'user');
      if (i >= 0) return { place: i + 1, of: rows.length, gb: rows[i].gb, leader: rows[0], rows };
    }
    return null;
  });
  const lastN = (n) => played().slice(0, n).map(g => ({ g, won: g.result === 'win', us: g.score?.us ?? g.ourScore ?? 0, them: g.score?.them ?? g.theirScore ?? 0 }));
  const oneRun = once('oneRun', () => {
    const xs = played().filter(g => !g.isSpring && Math.abs((g.score?.us ?? 0) - (g.score?.them ?? 0)) === 1);
    return { w: xs.filter(g => g.result === 'win').length, l: xs.filter(g => g.result !== 'win').length };
  });
  const extraInnings = once('extra', () => played().filter(g => !g.isSpring && Object.keys(g.boxScore?.linescore || {}).length > 9)
    .map(g => ({ won: g.result === 'win' })));

  // ── Box scores: our side of each game ──────────────────────────
  const ourSide = (g) => (g.boxScore?.userIsHome ? g.boxScore.home : g.boxScore?.away) || null;
  /** Each hitter's line over our last `n` games. */
  const recentBats = (n = 10) => {
    const m = {};
    for (const g of played().slice(0, n)) {
      for (const h of ourSide(g)?.hitters || []) {
        const r = m[h.id] || (m[h.id] = { id: h.id, g: 0, ab: 0, h: 0, hr: 0, bb: 0, k: 0, rbi: 0, doubles: 0 });
        r.g++; r.ab += h.ab || 0; r.h += h.h || 0; r.hr += h.hr || 0; r.bb += (h.bb || 0) + (h.hbp || 0); r.k += h.k || 0; r.rbi += h.rbi || 0; r.doubles += h.doubles || 0;
      }
    }
    return m;
  };
  /** Each pitcher's outings over our last `n` games (newest first): { id, start, outs, er, h, bb, k, hr, at }. */
  const recentArms = (n = 10) => {
    const m = {};
    for (const g of played().slice(0, n)) {
      const ps = ourSide(g)?.pitchers || [];
      ps.forEach((p, i) => (m[p.id] ||= []).push({ id: p.id, start: i === 0, outs: p.ipOuts || 0, er: p.er || 0, h: p.h || 0, bb: p.bb || 0, k: p.k || 0, hr: p.hr || 0, at: g.gameTime, dec: p.dec, opp: g.opponent }));
    }
    return m;
  };

  // ── The roster ─────────────────────────────────────────────────
  const roster = once('roster', () => (u.rosterIds || []).map(P).filter(Boolean));
  const lineup = once('lineup', () => (u.lineupSlots || []).map(s => ({ slot: s.slot, p: P(s.playerId) })).filter(x => x.p));
  const rotation = once('rotation', () => {
    const order = (u.rotation?.order || []).map(P).filter(Boolean);
    const idx = u.rotation?.currentIndex || 0;
    return { order, next: order.length ? [...order.slice(idx % order.length), ...order.slice(0, idx % order.length)] : [] };
  });
  /** Who starts each of our next games, as the sim will choose (the one in turn, or the next who's had four days). */
  const nextStarters = once('nextStarters', () => {
    const order = (u.rotation?.order || []).filter(id => P(id));
    const n = order.length;
    if (!n) return [];
    const lastDay = {};   // starts we plan from here on
    const ready = (id, t) => { const p = P(id); if (!p || !isAvailable(p)) return false;
      return lastDay[id] != null ? dayOf(t) - lastDay[id] > PITCH_SP_REST_DAYS : starterRested(p, t); };
    let idx = u.rotation?.currentIndex || 0;
    const out = [];
    for (const g of upcoming().filter(g => g.gameTime > atMs).slice(0, n)) {
      let pick = null;
      for (let k = 0; k < n; k++) { const id = order[(idx + k) % n]; if (ready(id, g.gameTime)) { pick = id; idx = (idx + k + 1) % n; break; } }
      if (!pick) { pick = order[idx % n]; idx = (idx + 1) % n; }
      lastDay[pick] = dayOf(g.gameTime);
      out.push({ g, p: P(pick) });
    }
    return out;
  });
  const injured = once('injured', () => roster().filter(p => p.group === PLAYER_GROUP.IL || p.injury?.status === 'il'));
  const bullpen = once('bullpen', () => {
    const roles = bullpenRoles(u, players);
    const at = nextGame()?.gameTime && nextGame().gameTime > atMs ? nextGame().gameTime : atMs;
    const ids = [roles.closer, ...roles.setup, ...roles.middle, ...roles.long].filter(Boolean);
    return { roles, arms: ids.map(id => ({ p: P(id), role: roles.roleOf[id], ...armStatus(P(id), at) })).filter(x => x.p) };
  });
  const starterStatus = (p, at = atMs) => ({ rested: starterRested(p, at), lastDays: armStatus(p, at).lastDays });
  const age = (p) => computeAge(p?.dob, year);
  // §122 our young players (25 or younger), healthy — the club's future, on its roster (there's no farm).
  const young = once('young', () => (u.rosterIds || []).map(P).filter(p => p && !p.isInjured && computeAge(p.dob, year) <= 25));
  const devStatus = (p) => developmentStatus(state, p.id);

  // ── Weather (what the club can see) ───────────────────────────
  const park = (id = 'user') => wx().map.parks[id] || wx().map.parks.user;
  const forecastFor = (g) => (g && g.gameTime > atMs ? forecastForGame(wx(), atMs, g) : null);
  const outlook = (id = 'user', d = 0) => { const pk = park(id); return dailyForecastDay(wx(), atMs, pk.x, pk.y, d); };
  /** Rain that has fallen at a park (inches) in the hours before `atMs`. */
  // (The last day in 20-minute steps, earlier days in hourly ones; each span worked out once.)
  const rainSpan = (id, h0, h1, step) => (memo[`rain|${id}|${h0}|${h1}`] ??= (() => { const pk = park(id); return rainTotal(wx(), pk.x, pk.y, atMs - h1 * MS_HOUR, atMs - h0 * MS_HOUR, step); })());
  const rainPast = (hours, id = 'user') => Math.round((rainSpan(id, 0, Math.min(24, hours), 20) + (hours > 24 ? rainSpan(id, 24, hours, 60) : 0)) * 100) / 100;
  const nowAt = (id = 'user') => { const pk = park(id); return conditionsAt(wx(), pk.x, pk.y, atMs); };
  /** Recent weather trouble at our park: delays, rainouts, suspensions (newest first). */
  const homeWeatherEvents = once('homeWx', () => {
    const out = [];
    for (const g of (state.schedule || [])) {
      if (!Number.isFinite(g.gameTime) || atMs - g.gameTime > 14 * MS_DAY) continue;
      for (const pp of g.postponements || []) if (pp.venueId ? pp.venueId === 'user' : atHome(g)) if (pp.gameTime <= atMs) out.push({ kind: pp.resumption ? 'suspended' : 'postponed', t: pp.gameTime, reason: pp.reason, g });
      if (g._committed && atHome(g)) for (const d of g.wxResult?.delays || []) if (d.endT <= atMs) out.push({ kind: 'delay', t: d.startT, min: Math.round((d.endT - d.startT) / 60_000), reason: d.reason, g });
    }
    return out.sort((a, b) => b.t - a.t);
  });
  const lastHomeGame = () => played().find(atHome) || null;

  // ── The front office ──────────────────────────────────────────
  const fin = () => u.finances || {};
  const capacity = () => fin().market?.capacity || 0;
  const homeGates = once('gates', () => played().filter(g => atHome(g) && g.attendance).slice(0, 8)
    .map(g => ({ g, n: g.attendance, sellout: !!g.sellout, gateK: g.gateK || 0, weekend: [0, 5, 6].includes(new Date(g.gameTime + tz() * 60_000).getUTCDay()) })));
  const ledger = (pred = () => true, days = 60) => (fin().ledger || []).filter(e => atMs - e.at < days * MS_DAY && pred(e)).sort((a, b) => b.at - a.at);

  // ── What the GM decided, and what happened ────────────────────
  /** Answered inbox cards (newest first): { cardId, tag, choice, subject, at }. */
  const decisions = once('decisions', () => (state.inbox || [])
    .filter(c => c.resolved && (c.choice === 'yes' || c.choice === 'no'))
    .map(c => ({ cardId: c.cardId, tag: c.tag, choice: c.choice, subject: c.subject || '', at: c.resolvedAtMs || c.resolvedAt || 0, card: c }))
    .filter(d => d.at <= atMs)
    .sort((a, b) => b.at - a.at));
  /** The GM's log: trades and injuries (newest first). */
  const gmLog = once('gmLog', () => [...(state.history || [])].reverse());
  const tradesSince = (ms) => (state.transactions || []).filter(t => t.kind === 'trade' && t.status === 'done' && (t.doneAt || t.createdAt) > ms && (t.teamId === 'user' || t.fromTeamId === 'user'));
  /** What this person told the GM before, on this topic (newest first). */
  const pastReplies = (topicId) => (state.composeLog || []).filter(r => r.topicId === topicId && r.atMs < atMs).sort((a, b) => b.atMs - a.atMs);

  return {
    atMs, state, u, players, P, year, phase, season, tz, wx,
    upcoming, played, nextGame, liveNow, lastGame, nextHome, nextSeries, homeGamesWithin, offDays, oppTeam, venueId, atHome,
    record, standing, lastN, oneRun, extraInnings,
    ourSide, recentBats, recentArms,
    roster, lineup, rotation, nextStarters, injured, bullpen, starterStatus, age, young, devStatus,
    park, forecastFor, outlook, rainPast, nowAt, homeWeatherEvents, lastHomeGame,
    fin, capacity, homeGates, ledger,
    decisions, gmLog, tradesSince, pastReplies,
    isAvailable,
    when: (t) => dayWord(t, atMs, tz(), wx().cal),
    /** "on June 12" / "tonight" — for after a verb. */
    onWhen: (t) => { const w = dayWord(t, atMs, tz(), wx().cal); return /^[A-Z]/.test(w) ? `on ${w}` : w; },
    clock: (t) => clockWord(t, tz()),
  };
}
