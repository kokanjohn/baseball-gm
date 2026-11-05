// §107 A doubleheader's second game never starts before the first has ended (plus the break) —
// ours included, whose second game the engine only looks at once the first is committed.
// Our next two games are made a doubleheader with game two scheduled only 60 minutes after game one,
// so game one always runs past it.
//   node tools/harness/check-doubleheader.mjs [seed=1]
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { GAME_STATUS, GAME_WEATHER } from '../../data/constants.js';
seedRandom(+(process.argv[2] || 1));
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? ` — ${info}` : ''}`); };
await startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Testville', nickname: 'Testers', abbr: 'TST', icon: '⚾', bannerColor: '#3366cc', region: 'west' });
const play = async (idx) => {
  for (let guard = 0; guard < 20000; guard++) {
    const g = SM.get().schedule[idx];
    if (g.status === GAME_STATUS.FINAL) break;
    if (g.status === GAME_STATUS.LIVE) { const np = g.plays?.[g.livePlayIndex]; clock.set(np?._timestamp ? np._timestamp + 1000 : clock.get() + 60_000); }
    else clock.set(Math.max(clock.get() + 60_000, g.status === GAME_STATUS.SCHEDULED ? g.gameTime : 0));
    tick();
  }
  await commitGame(idx);
};
const MIN = 60_000;
let k = 0;
for (let tries = 0; k < 3 && tries < 12; tries++) {
  const i0 = SM.get().currentGameIndex;
  SM.mutate(s => { const a = s.schedule[i0], b = s.schedule[i0 + 1]; b.date = a.date; b.gameTime = a.gameTime + 60 * MIN; b.wx = null; a.wx = null; });
  const planned = SM.get().schedule[i0 + 1].gameTime;
  clock.set(SM.get().schedule[i0].gameTime - 30 * MIN);
  await play(i0);
  const g1 = SM.get().schedule[i0];
  if (!g1.endedAt || g1.result === 'postponed') { if (SM.get().currentGameIndex === i0 + 1) await play(i0 + 1); continue; }   // (rained out: try the next pair)
  await play(i0 + 1);
  const g2 = SM.get().schedule[i0 + 1];
  if (g2.result === "postponed") continue;
  k++;
  const gap = Math.round((g2.gameTime - g1.endedAt) / MIN);
  check(`doubleheader ${k}: game two (planned ${Math.round((planned - g1.gameTime) / MIN)} min after game one's first pitch) starts ${gap} min after game one ended`,
        g2.gameTime >= g1.endedAt + GAME_WEATHER.DH_BREAK_MIN * MIN && g2.date === g1.date,
        `game one ${new Date(g1.gameTime).toISOString()}–${new Date(g1.endedAt).toISOString()}, game two ${new Date(g2.gameTime).toISOString()}`);
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
