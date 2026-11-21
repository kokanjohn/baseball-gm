// r239 §122.118 A spot the GM opens with MOVE stays open: the manager doesn't fill it at once.
//   node tools/harness/check-move-open.mjs [seed=1]
// Before the roster deadline it waits until the deadline (as before). After the deadline, it waits until first
// pitch. During a game (its lineup already taken), it's for the next game: it waits until that game's deadline.
// A starter moved to the DH leaves their old slot open the same way.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, gmMove, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { moveOptions, managerFillAt } from '../../engine/RosterEngine.js';
import { ROSTER_DECISION_LEAD_MS as LEAD } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const step = (t) => { clock.set(t); tick(); releaseDueCards(); };
const slots = () => SM.get().userTeam.lineupSlots;
const line = () => slots().map(s => `${s.slot}:${SM.get().players[s.playerId]?.name || '—'}`).join(' ');
const first = (i) => slots()[i].playerId;

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
step(clock.get());
const st0 = SM.get();
const g1 = st0.schedule[st0.currentGameIndex], g2 = st0.schedule[st0.currentGameIndex + 1];

// ── 1. after the deadline: open until first pitch ──
step(g1.gameTime - 30 * 60_000);
const a = first(1);
check('the bench move is offered ("Leave 1B open")', moveOptions(SM.get(), a).some(o => o.key === 'bench'));
gmMove(a, 'bench');
check(`benched half an hour before first pitch: 1B stays open (${line()})`, !first(1));
step(g1.gameTime - 5 * 60_000);
check('…still open five minutes before first pitch', !first(1), line());
check('…no "open spots" message for it', !(SM.get().inbox || []).some(c => c.cardId === 'open_spots' && !c.resolved));
step(g1.gameTime + 60_000);
const g1Now = SM.get().schedule[g1.index ?? st0.currentGameIndex];
check(`at first pitch the manager fills it (${line()})`, !!first(1));
check('…and the game starts with nine', (g1Now.liveLineups?.home?.length || g1Now.liveLineups?.away?.length || 9) >= 9);

// ── 2. during the game: for the next game, open until its deadline ──
step(g1.gameTime + 40 * 60_000);
check('the game is under way', !!SM.get().schedule[g1.index ?? st0.currentGameIndex].liveLineups);
check('the manager now fills for the next game, at its deadline', managerFillAt(SM.get()) === g2.gameTime - LEAD,
      `${managerFillAt(SM.get())} vs ${g2.gameTime - LEAD}`);
const b = first(1);
gmMove(b, 'bench');
check(`benched during the game: 1B stays open (${line()})`, !first(1));
const c = first(3);
const toDh = moveOptions(SM.get(), c).find(o => o.key === 'slot:8');
check('a starter can move to the DH', !!toDh);
if (toDh) { gmMove(c, 'slot:8'); check(`moved 3B to the DH during the game: 3B stays open (${line()})`, !first(3) && first(8) === c); }
for (let t = g1.gameTime + 50 * 60_000; t < g1.gameTime + 6 * 3_600_000; t += 10 * 60_000) step(t);   // (the game plays out)
{ const i = SM.get().schedule.indexOf(SM.get().schedule.find(x => x.gameTime === g1.gameTime && x.liveLineups)); await commitGame(i); releaseDueCards(); }   // (as the app does at the final)
step(g2.gameTime - LEAD - 10 * 60_000);
check('…still open just before the next game\'s deadline', !first(1) && !first(3), line());
step(g2.gameTime - LEAD + 60_000);
check(`at the next game's deadline the manager fills them (${line()})`, !!first(1) && !!first(3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
