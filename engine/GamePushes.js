/**
 * engine/GamePushes.js — the pushes our next game will send (§120, r138).
 *
 * OWNS: turning the look-ahead (engine/LookAhead.js — our next game as it will
 *   happen, from seeded dice) into push items for the worker's schedule, so
 *   the phone hears about the game as it happens with the app closed:
 *     - our player hurt on a play
 *     - the final score
 *   §122.58 the weather (a start held, a delay, play resuming, a game called
 *   off or suspended) is told by its messages, home and road — the grounds
 *   crew's and the traveling party's — and pushed with them under the Weather
 *   and Called Off alerts (CardEngine.getPushSchedule).
 *   and which of those the GM wants (Settings → Notifications, all on unless
 *   turned off: state.push.alerts).
 *
 * Every item is exactly what the game will do — never a guess — because the
 * look-ahead runs the real engine on the same dice. Anything the GM changes
 * changes the look-ahead, and the app re-sends the schedule (ui/PushClient.js).
 *
 * Quiet hours: an injury and the final still matter in the morning, so they
 * wait for quiet hours to end (like the inbox's alerts). (The weather's
 * messages near game time get through them: CardEngine's urgent rule.)
 *
 * Pure: state and a look-ahead in, items out. No StateManager.
 */

import { pushTimeFor } from './CardScheduler.js';

/** The kinds a GM can turn off, as Settings shows them (and the inbox's). */
export const PUSH_ALERTS = Object.freeze({
  messages:  'messages',    // inbox cards (CardEngine.getPushSchedule)
  weather:   'weather',     // the weather's messages: start held, delays, play resumes (§122.58)
  calledOff: 'calledOff',   // the weather's messages: postponed, called, suspended (§122.58)
  injury:    'injury',      // our player hurt during a game
  final:     'final',       // the final score
});

/** Is this kind of push on? (All on unless the GM turned one off.) */
export function alertOn(state, kind) {
  return state?.push?.alerts?.[kind] !== false;
}

const ORD = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
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

  // ── Called off before it started: no game (§122.58 its messages say so) ──
  if (L.postponed) return [];

  // ── The game, play by play ────────────────────────────────────
  const plays = (L.plays || []).filter(p => Number.isFinite(p._timestamp));
  let score = { us: 0, them: 0 };
  for (const p of plays) {
    if (p.type !== 'weather_delay' && p.type !== 'weather_resume' && Number.isFinite(p.cumOurScore)) {
      score = { us: p.cumOurScore, them: p.cumTheirScore };
    }
    if (p.type === 'weather_delay' || p.type === 'weather_resume' || p.type === 'game_suspended') {
      continue;   // (§122.58 the weather's messages)
    } else if (p.type === 'injury' && state.players?.[p._injury?.playerId]?.teamId === 'user') {
      const name = state.players[p._injury.playerId].name;
      add(PUSH_ALERTS.injury, p._timestamp, `${key}:hurt:${p._injury.playerId}`, `Injury: ${name}`,
          `${p.description} (${p.half === 'TOP' ? 'Top' : 'Bottom'} ${ORD(p.inning)}, ${match}.) The Head Trainer will report.`);
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

function _score(s, us, them) {
  if (s.us === s.them) return `tied ${s.us}–${s.them}`;
  return s.us > s.them ? `${us} lead ${s.us}–${s.them}` : `${them} lead ${s.them}–${s.us}`;
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

