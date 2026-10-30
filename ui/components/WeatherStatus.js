/**
 * ui/components/WeatherStatus.js
 * §102.4 (4d-1) The weather on a game, in words — one source for the
 * dashboard's live card and next-game card, the league game viewer, and the
 * schedule. Everything is read off what the GM can already see: the plays
 * revealed so far (a delay is "on" from its delay play until its resume
 * play), the game's status, and what the game keeps (its weather at first
 * pitch, its postponements, its suspension).
 *
 * Read-only. Text, not icons.
 */

import { GAME_STATUS } from '../../data/constants.js';

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
  const wind = !w.windMph || w.windMph < 3 || w.windText === 'calm' ? 'Wind calm' : `Wind ${w.windMph} mph ${w.windText}`;
  return `${w.tempF}° ${w.label} · ${wind}`;
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
