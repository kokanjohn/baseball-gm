// r236 §122.115 A message already in Messages is never on the push schedule.
//   node tools/harness/check-push-arrived.mjs
// The foresight (LookAhead.foresee) is kept for hours; a message it saw coming
// used to stay on the worker's list for a minute after it arrived in the app,
// so the phone got a push for a message the GM was already looking at.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick } from '../../engine/GameEngine.js';
import { releaseDueCards, getPushSchedule } from '../../engine/CardEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(1);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
tick(); releaseDueCards();

// A planned card about to arrive: on the schedule before, gone once it's in Messages.
let st = SM.get();
const next = (st.scheduledCards || []).filter(c => !c._seed).sort((a, b) => a.deliverAtMs - b.deliverAtMs)[0];
check('a planned card is waiting', !!next);
if (next) {
  const before = getPushSchedule(st, next.deliverAtMs - 60_000);
  check('it is on the schedule before it arrives', before.some(i => i.id === next.instanceId));
  // The foresight saw it coming at its moment (as LookAhead hands it over).
  const foreseen = { untilMs: next.deliverAtMs + 3600_000, messages: [{ instanceId: next.instanceId, cardId: next.cardId,
    sender: next.sender, subject: next.subject, arrivedAtMs: next.deliverAtMs, expiresAtMs: next.expiresAtMs }] };
  clock.set(next.deliverAtMs + 5_000);
  tick(); releaseDueCards();
  st = SM.get();
  const inInbox = (st.inbox || []).some(c => c.instanceId === next.instanceId);
  check('it arrived in Messages', inInbox);
  const after = getPushSchedule(st, clock.get(), null, foreseen);
  check('a foreseen message already in Messages is not pushed', !after.some(i => i.id === next.instanceId),
        JSON.stringify(after.filter(i => i.id === next.instanceId)));
  // One not yet arrived, within the cron's minute, still is.
  const ghost = { untilMs: clock.get() + 3600_000, messages: [{ instanceId: 'not-yet', cardId: 'x', subject: 'Soon',
    arrivedAtMs: clock.get() - 10_000 }] };
  check('a foreseen message not yet in Messages is still pushed', getPushSchedule(st, clock.get(), null, ghost).some(i => i.id === 'not-yet'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
