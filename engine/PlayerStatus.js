/**
 * PlayerStatus.js — r252 §122.131 a player's status right now, in two lengths: a short mark for a row on the
 * Team screen ("1 game", "3 days", "IL") and the full words to tap for (and for the player card).
 * Pure: reads state, writes nothing.
 */
import { untilDay } from './When.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const AWAY = { rest: 'Resting', illness: 'Sick', training: 'Away training', benched: 'Sat down', suspended: 'Suspended',
               leave: 'On leave', 'sim game': 'Pitching a sim game' };

/**
 * statusOf(state, p, atMs) → { kind, short, full, tone } | null
 *   kind: 'evaluating' | 'dtd' | 'il' | 'suspended' | an `unavailable` reason | 'condition'
 *   tone: 'bad' (can't play) | 'warn' (plays, not at full strength)
 */
export function statusOf(state, p, atMs = Date.now()) {
  if (!p) return null;
  const inj = p.injury;
  if (inj?.status === 'evaluating') return { kind: 'evaluating', short: 'Eval', tone: 'bad', full: 'Hurt and being looked at. The trainer\'s report is on its way.' };
  if (inj?.status === 'dtd') {
    const back = Number.isFinite(inj.returnAt) ? ` Back ${untilDay(inj.returnAt, atMs)}.` : '';
    return { kind: 'dtd', short: 'DTD', tone: 'bad', full: `Day-to-day${inj.type ? ` (${inj.type})` : ''}.${back}` };
  }
  if (p.isInjured) {
    const elig = Number.isFinite(inj?.eligibleAt) && inj.eligibleAt > atMs ? ` Eligible to come off ${untilDay(inj.eligibleAt, atMs)}.` : '';
    return { kind: 'il', short: 'IL', tone: 'bad', full: `On the injured list${inj?.type ? ` (${inj.type})` : ''}.${elig}` };
  }
  if (p.isSuspended) {
    const n = Number.isFinite(p._suspendedUntilGame) ? Math.max(1, p._suspendedUntilGame - (state?.currentGameIndex || 0)) : null;
    return { kind: 'suspended', short: n ? plural(n, 'game') : 'Susp', tone: 'bad', full: `Suspended${n ? `: ${plural(n, 'more game')}` : ''}.` };
  }
  const away = p.unavailable;
  if (away) {
    const what = AWAY[away.reason] || 'Away';
    if (Number.isFinite(away.untilMs) && away.untilMs) {
      const d = Math.max(1, Math.ceil((away.untilMs - atMs) / 86_400_000));
      return { kind: away.reason || 'away', short: plural(d, 'day'), tone: 'bad', full: `${what}. Back ${untilDay(away.untilMs, atMs)}.` };
    }
    const g = away.gamesLeft || 1;
    return { kind: away.reason || 'away', short: plural(g, 'game'), tone: 'bad', full: `${what}. Out for the next ${g === 1 ? 'game' : plural(g, 'game')}.` };
  }
  if (p.condition?.gamesLeft > 0) {
    const c = p.condition;
    return { kind: 'condition', short: 'Limited', tone: 'warn', full: `Playing through it: ${c.subRating} down a little for ${plural(c.gamesLeft, 'more game')}.` };
  }
  return null;
}
