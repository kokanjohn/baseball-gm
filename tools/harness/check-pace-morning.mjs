/**
 * tools/harness/check-pace-morning.mjs — r214 §122.93
 *   - a staff message written in the night that can wait comes in the morning (8–9:30); one due before then, an
 *     injury, an emergency, the weather, a trade on the clock come at once;
 *   - the between-games pool is paced: a draw needs a whole credit; credit grows by what's left ÷ the games left.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const H = 3_600_000;

seedRandom(31);
await startNewGame({ archetypeId: 'lab', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

console.log('The night\'s messages');
{
  const base = (() => { const d = new Date(clock.get() + 2 * 24 * H); d.setHours(23, 15, 0, 0); return d.getTime(); })();
  const morning = (() => { const d = new Date(base); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); })();
  const park = (extra) => SM.speculate(() => CE._testDeliverAt({ cardId: 'rest_ask', sender: 'Team Physician', subject: 'x', body: 'x', instanceId: 'x', _rosterKey: `test:${Math.random()}`, ...extra }, base));
  const can = park({ expiresAtMs: morning + 6 * H });
  check(`a rest question at 11:15pm, due in the afternoon: in the morning (${new Date(can.deliverAtMs).toTimeString().slice(0, 5)})`, can.deliverAtMs >= morning && can.deliverAtMs <= morning + 1.5 * H);
  const soon = park({ expiresAtMs: morning + H });
  check('one due before 10am: at once', soon.deliverAtMs === base);
  const none = park({});
  check('one with no deadline: in the morning', none.deliverAtMs >= morning && none.deliverAtMs <= morning + 1.5 * H);
  const kept = [{ cardId: 'injury_act1' }, { cardId: 'em_labor_a', _emergency: true }, { cardId: 'wx_x', _wxCrew: true }, { cardId: 'lt_offer' }, { cardId: 'talk_accepted', _talkId: 't' }, { cardId: 'x', _urgent: true }]
    .map(e => park({ ...e, expiresAtMs: morning + 6 * H }));
  check('an injury, an emergency, the weather, a trade, an urgent one: at once', kept.every(c => c.deliverAtMs === base), kept.map(c => `${c.cardId}:${new Date(c.deliverAtMs).toTimeString().slice(0, 5)}`).join(' '));
  const day = SM.speculate(() => CE._testDeliverAt({ cardId: 'rest_ask', instanceId: 'y', _rosterKey: 'test:day', expiresAtMs: base + 20 * H }, morning + 5 * H));
  check('in the day: as it comes', day.deliverAtMs === morning + 5 * H);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
