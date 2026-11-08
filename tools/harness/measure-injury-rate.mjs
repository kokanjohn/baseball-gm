/**
 * tools/harness/measure-injury-rate.mjs
 * DEV/TEST ONLY — injuries across the whole league over N of our games (each
 * day's CPU games included): how many, to hitters / starters / relievers, per
 * team-game. §118 step 2 moves injuries into the plays; this checks the rate
 * stays where it was.
 *   node tools/harness/measure-injury-rate.mjs [ourGames=60] [seed=1]
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { GAME_STATUS, PHASE } from '../../data/constants.js';

const N = parseInt(process.argv[2] || '60', 10);
const SEED = parseInt(process.argv[3] || '1', 10);
seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 6 * 3600_000);   // the harness clock starts far ahead until set
const seen = new Set();
const tally = { hitter: 0, starter: 0, reliever: 0 };
let ours = 0;
function scan() {
  const st = SM.get();
  for (const p of Object.values(st.players)) {
    const at = p.injury?.injuredAt;
    if (!at) continue;
    const k = `${p.id}@${at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (p.teamId === 'user') ours++;
    tally[p.pos === 'SP' ? 'starter' : p.pos === 'RP' ? 'reliever' : 'hitter']++;
  }
}
let played = 0, t0 = clock.get();
for (let guard = 0; played < N && guard < 20000; guard++) {
  const st = SM.get();
  const idx = st.currentGameIndex;
  const g = st.schedule[idx];
  if (!g) break;
  if (g._committed) { clock.advance(3600_000); advanceClock(clock.get()); continue; }
  if (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.POSTPONED || g.cancelled) { await commitGame(idx); scan(); played++; continue; }
  if (g.status === GAME_STATUS.LIVE) { const np = g.plays?.[g.livePlayIndex]; clock.set(Math.max(clock.get(), np ? np._timestamp + 1000 : clock.get() + 60_000)); }
  else clock.set(Math.max(clock.get() + 30 * 60_000, Math.min(g.gameTime, clock.get() + 3 * 3600_000)));
  tick(); releaseDueCards(); scan();
}
const days = (clock.get() - t0) / 86_400_000;
const total = tally.hitter + tally.starter + tally.reliever;
console.log(`seed ${SEED}: ${played} of our games over ${days.toFixed(0)} days — ${total} injuries league-wide (hitters ${tally.hitter}, starters ${tally.starter}, relievers ${tally.reliever}); ours ${ours}`);
console.log(`per team-game ≈ ${(total / (played * 10)).toFixed(3)} (10 clubs, roughly one game each per day we play)`);
