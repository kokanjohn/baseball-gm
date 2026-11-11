/**
 * engine/GamePushes.js — the pushes our next game will send (§120, r138).
 *
 * OWNS: turning the look-ahead (engine/LookAhead.js — our next game as it will
 *   happen, from seeded dice) into push items for the worker's schedule, so
 *   the phone hears about the game as it happens with the app closed:
 *     - weather: the start held, a rain / lightning / snow delay, play resuming
 *     - called off: postponed (with the makeup date), suspended (with the day
 *       it resumes)
 *     - our player hurt on a play
 *     - the final score
 *   and which of those the GM wants (Settings → Notifications, all on unless
 *   turned off: state.push.alerts).
 *
 * Every item is exactly what the game will do — never a guess — because the
 * look-ahead runs the real engine on the same dice. Anything the GM changes
 * changes the look-ahead, and the app re-sends the schedule (ui/PushClient.js).
 *
 * Quiet hours: a delay or a restart is news only as it happens, so inside
 * quiet hours it isn't sent at all; a postponement, a suspension, an injury
 * and the final still matter in the morning, so they wait for quiet hours to
 * end (like the inbox's alerts).
 *
 * Pure: state and a look-ahead in, items out. No StateManager.
 */

import { pushTimeFor } from './CardScheduler.js';
import * as When from './When.js';

/** The kinds a GM can turn off, as Settings shows them (and the inbox's). */
export const PUSH_ALERTS = Object.freeze({
  messages:  'messages',    // inbox cards (CardEngine.getPushSchedule)
  weather:   'weather',     // start held, delays, play resumes
  calledOff: 'calledOff',   // postponed, suspended
  injury:    'injury',      // our player hurt during a game
  final:     'final',       // the final score
});

/** Is this kind of push on? (All on unless the GM turned one off.) */
export function alertOn(state, kind) {
  return state?.push?.alerts?.[kind] !== false;
}

const ORD = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const DELAY_WORD = { lightning: 'Lightning delay', snow: 'Snow delay', rain: 'Rain delay', 'wet field': 'Rain delay' };
const WHY_WORD = { lightning: 'storms', snow: 'snow', rain: 'rain', 'wet field': 'a wet field' };

/**
 * gamePushes(state, L, nowMs)
 * @param {Object} state
 * @param {Object|null} L — LookAhead.lookAhead()'s result
 * @param {Number} nowMs
 * @returns {Array<{ id, deliverAt, title, body, tag, kind }>} — only items still to come
 */
export function gamePushes(state, L, nowMs) {
  if (!L || !state?.userTeam || L.isAllStar) return [];
  const qs = state.push?.quietStart, qe = state.push?.quietEnd;
  const us = state.userTeam.nickname || state.userTeam.name || 'We';
  const oppTeam = (state.leagueTeams || []).find(t => t.name === L.opponent);
  const them = oppTeam?.nickname || String(L.opponent || '').split(' ').pop() || 'Them';
  const match = `${L.isHome ? 'vs' : '@'} ${L.opponent}`;
  const key = `g:${L.gameTime}`;
  const out = [];
  // live: sent only as it happens; later: waits out quiet hours.
  const add = (kind, at, id, title, body, { tag = id, live = false } = {}) => {
    if (!Number.isFinite(at) || !alertOn(state, kind)) return;
    const when = pushTimeFor(at, qs, qe);
    if (live && when !== at) return;   // news only as it happens
    out.push({ id, deliverAt: when, title, body, tag, kind });
  };

  // ── Called off before it started ──────────────────────────────
  if (L.postponed) {
    const p = L.postponed, why = WHY_WORD[p.reason] || 'rain';
    if (p.startHeld) {
      add(PUSH_ALERTS.weather, L.gameTime, `${key}:held`, `Start delayed: ${match}`,
          `The start is held — ${why} at the park.`, { tag: `${key}:wx`, live: true });
    }
    const when = p.cancelled ? (L.isSpring ? 'Spring games aren\'t made up.' : 'It won\'t be made up.')
      : `Makeup: ${_day(p.makeupTime, L.gameTime)}${p.doubleheader ? ', part of a doubleheader' : ''}.`;
    const how = p.calledBy === 'forecast' && !p.startHeld ? `With ${why} in the forecast, today's game is off.`
      : p.calledBy === 'curfew' ? `The ${why} never let up before the curfew.`
      : p.startHeld ? `Called off after the start was held for ${why}.`
      : `Called off for ${why}.`;
    add(PUSH_ALERTS.calledOff, p.decidedAt, `${key}:ppd`, `Postponed: ${match}`, `${how} ${when}`);
    return _future(out, nowMs);
  }

  // ── The game, play by play ────────────────────────────────────
  const plays = (L.plays || []).filter(p => Number.isFinite(p._timestamp));
  let score = { us: 0, them: 0 }, k = 0;
  for (const p of plays) {
    k++;
    if (p.type !== 'weather_delay' && p.type !== 'weather_resume' && Number.isFinite(p.cumOurScore)) {
      score = { us: p.cumOurScore, them: p.cumTheirScore };
    }
    const where = _situation(p, score, us, them);
    if (p.type === 'weather_delay') {
      if (p._wx?.pre) {
        add(PUSH_ALERTS.weather, p._timestamp, `${key}:held:${k}`, `Start delayed: ${match}`, p.description, { tag: `${key}:wx`, live: true });
      } else {
        add(PUSH_ALERTS.weather, p._timestamp, `${key}:delay:${k}`, `${DELAY_WORD[p._wx?.reason] || 'Rain delay'}: ${match}`,
            `${p.description} ${where}`, { tag: `${key}:wx`, live: true });
      }
    } else if (p.type === 'weather_resume') {
      const len = _length(p._wx?.minutes);
      if (p._wx?.pre) {
        add(PUSH_ALERTS.weather, p._timestamp, `${key}:start:${k}`, `Under way: ${match}`,
            `First pitch after a ${len} delay.`, { tag: `${key}:wx`, live: true });
      } else {
        add(PUSH_ALERTS.weather, p._timestamp, `${key}:resume:${k}`, `Play resumes: ${match}`,
            `Back on the field after a ${len} delay. ${where}`, { tag: `${key}:wx`, live: true });
      }
    } else if (p.type === 'injury' && state.players?.[p._injury?.playerId]?.teamId === 'user') {
      const name = state.players[p._injury.playerId].name;
      add(PUSH_ALERTS.injury, p._timestamp, `${key}:hurt:${p._injury.playerId}`, `Injury: ${name}`,
          `${p.description} (${p.half === 'TOP' ? 'Top' : 'Bottom'} ${ORD(p.inning)}, ${match}.) The Head Trainer will report.`);
    } else if (p.type === 'game_suspended') {
      const s = L.suspended;
      const resume = s?.resumeTime ? ` It resumes ${_day(s.resumeTime, p._timestamp)}, right where it stopped.` : ' It will be finished another day.';
      add(PUSH_ALERTS.calledOff, p._timestamp, `${key}:susp`, `Suspended: ${match}`,
          `${p.description} ${_score(score, us, them)}.${resume}`);
    } else if (p.type === 'game_end') {
      const fin = { us: p.cumOurScore ?? score.us, them: p.cumTheirScore ?? score.them };
      const called = p._called ? `Called after ${p._called.innings} innings (${WHY_WORD[p._called.reason] || 'rain'}). ` : '';
      const dec = _decisions(L.boxScore);
      const word = fin.us > fin.them ? `${us} win` : fin.us < fin.them ? `${us} lose` : 'Tie';
      add(PUSH_ALERTS.final, p._timestamp, `${key}:final`, `Final: ${us} ${fin.us}, ${them} ${fin.them}`,
          `${called}${word} ${match}.${dec ? ' ' + dec : ''}`);
    }
  }
  return _future(out, nowMs);
}

/** Only what's still to come (an item already due is the worker's to send, or past). */
function _future(items, nowMs) {
  return items.filter(i => i.deliverAt > nowMs);
}

function _situation(p, score, us, them) {
  if (!p.inning || (p.half !== 'TOP' && p.half !== 'BOT')) return `${_score(score, us, them)}.`;
  return `${p.half === 'TOP' ? 'Top' : 'Bottom'} ${ORD(p.inning)}: ${_score(score, us, them)}.`;
}

function _score(s, us, them) {
  if (s.us === s.them) return `tied ${s.us}–${s.them}`;
  return s.us > s.them ? `${us} lead ${s.us}–${s.them}` : `${them} lead ${s.them}–${s.us}`;
}

function _length(mins) {
  if (!Number.isFinite(mins)) return 'weather';
  if (mins < 60) return `${mins}-minute`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return r ? `${h} hr ${r} min` : `${h}-hour`;
}

/** r149 relative to when the push is sent, never a calendar date: "tomorrow at 1:05 PM", "in 9 days". */
function _day(ms, fromMs) {
  if (!Number.isFinite(ms)) return 'a later date';
  return When.untilFull(ms, Number.isFinite(fromMs) ? fromMs : ms);
}

/** "W: Miura · L: Bray · S: Ortiz" from the box score's decisions. */
function _decisions(box) {
  if (!box) return '';
  const ps = [...(box.away?.pitchers || []), ...(box.home?.pitchers || [])];
  const by = (d) => ps.find(p => p.dec === d)?.name;
  return [['W', by('W')], ['L', by('L')], ['S', by('S')]].filter(([, n]) => n).map(([d, n]) => `${d}: ${n}`).join(' · ');
}

/** The reminder 30 minutes before first pitch is moot when the game's already off. */
export function reminderMoot(L, gameTime, atMs) {
  return !!(L?.postponed && L.gameTime === gameTime && Number.isFinite(L.postponed.decidedAt) && L.postponed.decidedAt <= atMs);
}

