/**
 * ui/components/WeatherStatus.js
 * §102.4 (4d-1) The weather on a game, in words — one source for the
 * dashboard's live card and next-game card, the league game viewer, and the
 * schedule. Everything is read off what the GM can already see: the plays
 * revealed so far (a delay is "on" from its delay play until its resume
 * play), the game's status, and what the game keeps (its weather at first
 * pitch, its postponements, its suspension).
 *
 * Read-only. Text, not icons. (§122.58 the live line reads the park's conditions at the half-inning.)
 */

import { GAME_STATUS } from '../../data/constants.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { parkConditions, windAtPark } from '../../engine/WeatherConditions.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** "Apr 12" from "2027-04-12". */
export function dayLabel(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "7:05 PM". */
export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "12 min", "1 hr 05 min". */
export function elapsedLabel(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${String(m % 60).padStart(2, '0')} min`;
}

/** What stopped play, as a name: "Rain delay", "Lightning delay", "Snow delay". */
export function delayName(reason) {
  return reason === 'lightning' ? 'Lightning delay' : reason === 'snow' ? 'Snow delay' : 'Rain delay';
}
const _why = (reason) => (reason === 'lightning' ? 'lightning' : reason === 'snow' ? 'snow' : reason === 'wet field' ? 'a wet field' : 'rain');

/**
 * wxState(game, revealed) — the weather's hold on a game right now:
 *   { kind: 'start-delay' | 'delay' | 'suspended' | 'called' | null,
 *     reason, sinceMs, title, sub, pill }
 *   - 'start-delay': first pitch held up (the status says so before the
 *     game's plays exist; or the delay play is the last one revealed before
 *     first pitch);
 *   - 'delay': play stopped (its delay play is the last revealed);
 *   - 'suspended': stopped for the day, to be finished later;
 *   - 'called': over — an official game called short.
 */
export function wxState(game, revealed) {
  const none = { kind: null };
  if (!game) return none;
  const last = revealed?.length ? revealed[revealed.length - 1] : null;
  if (!last && game.status === GAME_STATUS.DELAYED) {
    const reason = game.wx?.reason || 'rain';
    return { kind: 'start-delay', reason, sinceMs: game.gameTime, pill: 'START DELAYED',
             title: 'Start delayed', sub: `Waiting on the ${_why(reason) === 'a wet field' ? 'field' : 'weather'} — the radar shows what's coming.` };
  }
  if (!last) return none;
  if (last.type === 'game_suspended') {
    const resumeAt = game.status === GAME_STATUS.SUSPENDED && Number.isFinite(game.gameTime) ? game.gameTime : null;
    return { kind: 'suspended', reason: last._suspended?.reason || 'rain', sinceMs: last._timestamp, pill: 'SUSPENDED',
             title: 'Suspended', sub: `${last.description}.${resumeAt ? ` It picks up ${dayLabel(game.date)} at ${timeLabel(resumeAt)}.` : ''}` };
  }
  if (last.type === 'game_end' && last._called) {
    return { kind: 'called', reason: last._called.reason, sinceMs: last._timestamp, pill: 'FINAL',
             title: 'Called', sub: `${last.description.replace(/^Final — /, '')}.`.replace(/^c/, 'C') };
  }
  if (last.type === 'weather_delay') {
    const pre = !!last._wx?.pre;
    const reason = last._wx?.reason || 'rain';
    return { kind: pre ? 'start-delay' : 'delay', reason, sinceMs: last._timestamp,
             pill: pre ? 'START DELAYED' : delayName(reason).toUpperCase(),
             title: pre ? 'Start delayed' : delayName(reason), sub: last.description };
  }
  return none;
}

/** The weather a game was played in (at first pitch): "72° Partly Cloudy · Wind 8 mph out to right". */
export function weatherLine(game) {
  const w = game?.weather;
  if (!w || !Number.isFinite(w.tempF)) return '';
  return _line(w.tempF, w.label, w.windMph, w.windText);
}

const _line = (tempF, label, windMph, windText) => {
  const wind = !windMph || windMph < 3 || windText === 'calm' ? 'Wind calm' : `Wind ${windMph} mph ${windText}`;
  return `${Math.round(tempF)}° ${label} · ${wind}`;
};

/** The first play of the half-inning `revealed` ends in (its moment is when that half began). */
function _halfStart(revealed) {
  let k = revealed.length - 1;
  while (k >= 0 && !(revealed[k].inning && (revealed[k].half === 'TOP' || revealed[k].half === 'BOT'))) k--;
  if (k < 0) return null;
  const { inning, half } = revealed[k];
  while (k > 0 && revealed[k - 1].inning === inning && revealed[k - 1].half === half) k--;
  return revealed[k];
}

const _live = new Map();   // `${venue}|${t}` → line (the same half-inning is read once)
/**
 * §122.58 (§122.51 phase 5) liveWeatherLine(state, game, revealed, venueId) — the conditions at the park as the
 * game goes: read at the start of the half-inning being played, so the label and the temperature move half-inning
 * by half-inning (rain coming and going, the evening cooling). Before the first play, the weather at first pitch.
 */
export function liveWeatherLine(state, game, revealed, venueId) {
  const p = revealed?.length ? _halfStart(revealed) : null;
  const t = p?._timestamp;
  if (!Number.isFinite(t) || !state || !venueId) return weatherLine(game);
  const key = `${venueId}|${t}`;
  if (!_live.has(key)) {
    try {
      const ctx = weatherContext(state);
      const c = parkConditions(ctx, venueId, t);
      _live.set(key, _line(c.tempF, c.label, c.wind.mph, windAtPark(c.wind, c.bearing).text));
    } catch { return weatherLine(game); }
    if (_live.size > 200) _live.delete(_live.keys().next().value);
  }
  return _live.get(key);
}

/** A called game's innings for a result: "6" (official short games), else ''. */
export function calledInnings(game) {
  const r = game?.wxResult?.ruling;
  return r && r.outcome === 'final' ? String(r.innings) : '';
}

/**
 * gameNotes(game, siblings) — the schedule's notes on a game, short and in
 * words: a makeup (and of what date), a doubleheader game, a suspended game
 * (where it stopped, when it picks up, or that it was finished), a spring
 * rainout, a delay it was played through.
 * `siblings`: the club's other games that date (for "Game 1 of 2").
 */
export function gameNotes(game, siblings = []) {
  const out = [];
  if (!game) return out;
  const pp = game.postponements || [];
  const first = pp.find(p => !p.resumption);
  if (game.cancelled) out.push(`Postponed (${_why(first?.reason)}) — spring games aren't made up`);
  else if (first) out.push(`Makeup of ${dayLabel(first.date)} (${_why(first.reason)})`);
  const same = [game, ...siblings].filter(Boolean).sort((a, b) => a.gameTime - b.gameTime);
  if (same.length > 1) out.push(`Game ${same.indexOf(game) + 1} of ${same.length}`);
  const sus = game.suspension;
  if (sus) {
    const where = sus.half ? `${sus.half === 'TOP' ? 'top' : 'bottom'} of the ${_ord(sus.inning)}` : '';
    if (game.status === GAME_STATUS.SUSPENDED) out.push(`Suspended ${dayLabel(sus.date)}${where ? ` in the ${where}` : ''} — picks up ${dayLabel(game.date)} ${timeLabel(game.gameTime)}`);
    else out.push(`Suspended ${dayLabel(sus.date)}${where ? ` in the ${where}` : ''}, finished ${dayLabel(game.date)}`);
  }
  const delays = (game.wxResult?.delays || []).filter(d => d.endT > d.startT);
  if (delays.length && (game._committed || game.played)) {
    const mins = Math.round(delays.reduce((a, d) => a + (d.endT - d.startT), 0) / 60_000);
    out.push(`${delays.length > 1 ? `${delays.length} delays` : delays[0].startT < (game.wxResult.startAt ?? Infinity) ? 'Delayed start' : delayName(delays[0].reason)}, ${elapsedLabel(mins * 60_000)}`);
  }
  const n = calledInnings(game);
  if (n) out.push(`Called after ${n} innings (${_why(game.wxResult.ruling.reason)})`);
  return out;
}

/** The game's postponements on a given date (for that date's scoreboard): [{ entry, game }]. */
export function postponedOn(games, iso) {
  const out = [];
  for (const g of games) for (const p of g.postponements || []) if (p.date === iso) out.push({ entry: p, game: g });
  return out;
}

/**
 * §122.58 (§122.51 phase 5) startStatus(told, game, nowMs) — the first-pitch card, following what's been told about
 * the game's weather (`told`: GameEngine.weatherToldOf — the same moments as the messages, home or road):
 *   { kind: 'ontime' | 'watch' | 'tarp' | 'delayed' | 'doubt' | 'starting',
 *     label, sub, estStart (ms, the latest estimate), wasStart (the estimate before it), revised }
 * Nothing told → 'ontime' (the countdown). Back on schedule or the rain sliding past → 'ontime' again.
 */
export function startStatus(told, game, nowMs) {
  const T = game?.gameTime;
  const out = { kind: 'ontime', label: 'First Pitch', sub: '', estStart: null, wasStart: null, revised: false };
  if (!Number.isFinite(T)) return out;
  let watch = null, tarp = false, est = null, was = null, doubt = false, revised = false, off = null;
  for (const e of told || []) {
    if (e.inGame || e.kind === 'first_pitch') continue;
    switch (e.kind) {
      case 'outlook': case 'update':
        watch = e.proj === 'ontime' && !(e.chance >= 40) ? null : e;
        doubt = e.proj === 'doubt';
        break;
      case 'clearing': case 'start_on_time':
        watch = null; doubt = false; est = null; was = null; revised = false; tarp = false;
        break;
      case 'tarp_on': tarp = true; off = null; if (e.estStart) est = e.estStart; break;
      case 'tarp_off': tarp = false; off = e; if (e.estStart) est = e.estStart; break;
      case 'start_delayed': est = e.estStart; doubt = false; break;
      case 'start_estimate': case 'crew_trouble':
        if ((e.estStart ?? null) != null) { was = e.prevEst ?? est; est = e.estStart; revised = true; }
        break;
      case 'start_doubt': doubt = true; break;
      default: break;
    }
  }
  const t = (ms) => timeLabel(ms);
  const rainWord = (e) => (e?.wx === 'storms' ? 'storms' : e?.wx === 'snow' ? 'snow' : e?.wx === 'mix' ? 'sleet and snow' : 'rain');
  if (doubt) return { ...out, kind: 'doubt', label: 'In doubt', sub: 'No window on the radar yet', estStart: est };
  if (off && est && est > T && nowMs < est) return { ...out, kind: 'starting', label: 'Tarp coming off', sub: `First pitch about ${t(est)}`, estStart: est };
  if (est && est > T) {
    return { ...out, kind: 'delayed', label: revised ? 'New estimate' : 'First pitch delayed', estStart: est, wasStart: revised ? was : T, revised,
             sub: revised && was ? `Was ${t(was)} · scheduled ${t(T)}` : `Scheduled ${t(T)}` };
  }
  if (tarp) return { ...out, kind: 'tarp', label: 'Tarp on', sub: 'Rain at the park · first pitch still on time' };
  if (watch) {
    const when = watch.rainAt ? ` around ${t(watch.rainAt)}` : '';
    return { ...out, kind: 'watch', label: 'First Pitch', sub: `Watching the weather: ${rainWord(watch)}${when}${watch.chance != null ? ` (${watch.chance}%)` : ''}` };
  }
  return out;
}

/** §122.58 our game postponed today (its first pitch hasn't passed by much): { at, makeupMs, makeupDate, dh, cancelled, reason } | null. */
export function postponedToday(schedule, nowMs) {
  let best = null;
  for (const g of schedule || []) {
    for (const p of g.postponements || []) {
      if (p.resumption || !(p.decidedAt <= nowMs) || !(nowMs < Math.max(p.gameTime, p.decidedAt) + 4 * 3_600_000)) continue;
      if (best && best.at > p.decidedAt) continue;
      best = { at: p.decidedAt, gameTime: p.gameTime, reason: p.reason, cancelled: !!g.cancelled, makeupMs: g.cancelled ? null : g.gameTime,
               makeupDate: g.cancelled ? null : g.date, dh: !!g.makeup?.how?.endsWith('dh'), opp: g.opponent || '', isHome: !!g.isHome };
    }
  }
  return best;
}

/** §122.58 the start's state in a few words for a schedule row: "Delayed · est. 7:40 PM", "In doubt", '' when on time. */
export function startNote(st, game) {
  if (!st || !game) return '';
  if (st.kind === 'delayed') return `Delayed · est. first pitch ${timeLabel(st.estStart)}`;
  if (st.kind === 'starting') return `Tarp coming off · first pitch about ${timeLabel(st.estStart)}`;
  if (st.kind === 'doubt') return 'In doubt · no window on the radar yet';
  if (st.kind === 'tarp') return 'Tarp on';
  if (game.status === GAME_STATUS.DELAYED) return 'Start delayed';
  return '';
}

/** §122.58 the park right now, for a start the weather holds up: "Now: 64° Steady Rain · Wind 9 mph in from left". */
export function parkNowLine(state, venueId, nowMs) {
  try {
    const c = parkConditions(weatherContext(state), venueId, nowMs);
    return `Now: ${_line(c.tempF, c.label, c.wind.mph, c.windAtPark.text)}`;
  } catch { return ''; }
}
