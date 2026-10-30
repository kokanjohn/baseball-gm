/**
 * engine/WeatherSchedule.js
 * §102.3 (step 4c) Where a game the weather stopped goes next — the way the
 * majors do it:
 *   - a postponed regular-season game, or a suspended one, is played
 *       1. as a doubleheader later in the same series, else
 *       2. on a day both clubs are off within two weeks, else
 *       3. as a doubleheader the next time the two clubs meet, else
 *       4. on a day added after the regular season;
 *   - a doubleheader is day–night (the makeup at 1:05 before a night game),
 *     or, before a day game, that game moves four hours later;
 *   - postponed spring games are cancelled (not made up);
 *   - playoff games (and the All-Star Game) move back a day, and the rest of
 *     the series with them.
 *
 * Pure: state in, a slot out. GameEngine moves the games.
 */

import { GAME_TIMES_BY_DOW, GAME_WEATHER as GW } from '../data/constants.js';

const MIN = 60_000, DAY = 86_400_000;
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** A game as the schedule sees it, ours or the league's: { homeId, awayId, venueId, date, gameTime }. */
export function gameTeams(g, isUser) {
  if (isUser) {
    const homeId = g.isHome ? 'user' : g.opponentId, awayId = g.isHome ? g.opponentId : 'user';
    return { homeId, awayId, venueId: g.venueId ?? homeId };
  }
  return { homeId: g.homeId, awayId: g.awayId, venueId: g.venueId ?? g.homeId };
}

/** Every game on the calendar: [{ g, isUser, homeId, awayId, venueId, date }]. */
export function allGames(state) {
  const out = [];
  for (const g of state.schedule || []) out.push({ g, isUser: true, date: g.date, ...gameTeams(g, true) });
  for (const [date, games] of Object.entries(state.leagueSchedule?.dayMap || {})) {
    for (const g of games) if (!g.isAllStar) out.push({ g, isUser: false, date, ...gameTeams(g, false) });
  }
  return out;
}

const _iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const _isoAdd = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return _iso(new Date(y, m - 1, d + n)); };
const _isoDiff = (a, b) => { const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number); return Math.round((new Date(y1, m1 - 1, d1) - new Date(y2, m2 - 1, d2)) / DAY); };

/** "7:05 PM" on the real day that is `iso` on the baseball calendar (the same offset as `ref`). */
export function timeOnDate(ref, iso, timeStr) {
  const day = new Date(ref.gameTime);
  day.setDate(day.getDate() + _isoDiff(iso, ref.date));
  const [hm, mer] = timeStr.split(' ');
  let [h, m] = hm.split(':').map(Number);
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  day.setHours(h, m, 0, 0);
  return day.getTime();
}

/** The usual night (latest) start on that real weekday. */
function _nightTime(ref, iso) {
  const day = new Date(timeOnDate(ref, iso, '12:00 PM'));
  const times = GAME_TIMES_BY_DOW[DOW[day.getDay()]] || ['7:05 PM'];
  return timeOnDate(ref, iso, times[times.length - 1]);
}

/**
 * findMakeupSlot(state, game, isUser, atMs) — where a postponed or suspended
 * regular-season game goes:
 * { date, gameTime, venueId, how: 'series-dh'|'off-day'|'meeting-dh'|'after-season', moveOther?: { g, isUser, gameTime } }
 * (moveOther: the day game that moves later to make room for the makeup).
 */
export function findMakeupSlot(state, game, isUser, atMs) {
  const me = { date: game.date, gameTime: game.gameTime, ...gameTeams(game, isUser) };
  const pair = [me.homeId, me.awayId];
  const games = allGames(state).filter(x => x.g !== game && !x.g.isSpring && !x.g.isPlayoff && !x.g.cancelled);
  const byTeamDate = new Map();
  for (const x of games) for (const t of [x.homeId, x.awayId]) {
    const k = `${t}|${x.date}`;
    if (!byTeamDate.has(k)) byTeamDate.set(k, []);
    byTeamDate.get(k).push(x);
  }
  const on = (t, d) => byTeamDate.get(`${t}|${d}`) || [];
  const dates = [...new Set(games.map(x => x.date))].sort();
  const lastDate = games.filter(x => !x.g.isMakeup).map(x => x.date).sort().pop() || me.date;
  const soonest = atMs + GW.SLOT_MIN_LEAD_MIN * MIN;
  const later = dates.filter(d => d > me.date);

  // A doubleheader with the clubs' game that day (each plays only that one game then).
  const dh = (d, how) => {
    const a = on(pair[0], d), b = on(pair[1], d);
    if (a.length !== 1 || b.length !== 1 || a[0] !== b[0]) return null;
    const other = a[0], t = other.g.gameTime;
    const hour = new Date(t).getHours();
    if (hour >= GW.DH_NIGHT_FROM_H) {
      const gameTime = timeOnDate(other.g, d, GW.DH_DAY_TIME);
      return gameTime >= soonest ? { date: d, gameTime, venueId: other.venueId, how } : null;
    }
    if (t < soonest || other.g._committed || other.g.played || other.g.status !== 'scheduled') return null;
    return { date: d, gameTime: t, venueId: other.venueId, how,
             moveOther: { g: other.g, isUser: other.isUser, gameTime: t + GW.DH_GAP_MIN * MIN } };
  };
  const meets = (d) => { const a = on(pair[0], d); return a.length === 1 && [a[0].homeId, a[0].awayId].includes(pair[1]); };

  // 1. Later in the same series.
  for (const d of later) {
    if (!game.seriesId || !on(pair[0], d).some(x => x.g.seriesId === game.seriesId)) continue;
    const s = dh(d, 'series-dh');
    if (s) return s;
  }
  // 2. A day both clubs are off (a day the league plays, before the season ends).
  for (const d of later) {
    if (_isoDiff(d, me.date) > GW.MAKEUP_OFFDAY_DAYS || d > lastDate) break;
    if (on(pair[0], d).length || on(pair[1], d).length) continue;
    const gameTime = _nightTime({ date: me.date, gameTime: me.gameTime }, d);
    if (gameTime >= soonest) return { date: d, gameTime, venueId: me.venueId, how: 'off-day' };
  }
  // 3. The next time they meet.
  for (const d of later) {
    if (!meets(d)) continue;
    const s = dh(d, 'meeting-dh');
    if (s) return s;
  }
  // 4. After the season: the first day both are free.
  for (let d = _isoAdd(lastDate, 1), k = 0; k < 30; d = _isoAdd(d, 1), k++) {
    if (on(pair[0], d).length || on(pair[1], d).length) continue;
    const gameTime = _nightTime({ date: me.date, gameTime: me.gameTime }, d);
    if (gameTime >= soonest) return { date: d, gameTime, venueId: me.venueId, how: 'after-season' };
  }
  return null;
}

/**
 * seriesShift(state, game, isUser) — a playoff game (or the All-Star Game)
 * the weather stopped: it and every later game of its series move back a day.
 * [{ g, isUser, date, gameTime }] (the game itself first).
 */
export function seriesShift(state, game, isUser) {
  const out = [{ g: game, isUser, date: _isoAdd(game.date, 1), gameTime: game.gameTime + DAY }];
  if (!game.seriesId) return out;
  for (const x of allGames(state)) {
    const g = x.g;
    if (g === game || g.seriesId !== game.seriesId || g._committed || g.played || !(g.gameTime > game.gameTime)) continue;
    out.push({ g, isUser: x.isUser, date: _isoAdd(g.date, 1), gameTime: g.gameTime + DAY });
  }
  // (Day arithmetic in real days: the device clock's daylight-saving shifts are within the hour.)
  for (const o of out) { const t = new Date(o.g.gameTime); const n = new Date(t); n.setDate(n.getDate() + 1); o.gameTime = n.getTime(); }
  return out;
}

export { _isoAdd as isoAddDays };
