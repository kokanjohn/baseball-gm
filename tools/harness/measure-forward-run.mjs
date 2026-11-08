/**
 * tools/harness/measure-forward-run.mjs
 * DEV/TEST ONLY — how long would a "forward run" take: playing the world ahead
 * on a scratch copy from now through our next game (§118 design)?
 * Times, over several regular-season days:
 *   - copying the state (structuredClone)
 *   - one day of the world clock (CPU games, trade desk, waivers, roster events)
 *   - generating our game's plays
 *   node tools/harness/measure-forward-run.mjs [days=6]
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import { dice } from '../../engine/Dice.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { generatePlays } from '../../engine/SimEngine.js';
import { GAME_STATUS, PHASE } from '../../data/constants.js';

const DAYS = parseInt(process.argv[2] || '6', 10);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const T = () => process.hrtime.bigint();

seedRandom(9);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
// Skip spring: measure the regular season (a full league of CPU games a day).
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; });
const st0 = SM.get();
console.log(`state: ${(JSON.stringify(st0).length / 1024).toFixed(0)} KB, ${Object.keys(st0.players).length} players`);

const rows = [];
for (let d = 0; d < DAYS; d++) {
  const st = SM.get();
  const idx = st.currentGameIndex;
  const g = st.schedule[idx];
  if (!g) break;
  // 1. copy the state
  let t = T(); const copy = structuredClone(SM.get()); const tClone = ms(t);
  // 2. the world up to our first pitch (from 24h before it)
  const from = Math.max(clock.get(), g.gameTime - 24 * 3600_000);
  clock.set(from); advanceClock(from); releaseDueCards();
  t = T(); clock.set(g.gameTime - 1000); advanceClock(clock.get()); releaseDueCards(); const tDay = ms(t);
  // 3. our game's plays (as _activateGame calls it)
  const s2 = SM.get();
  const opp = s2.leagueTeams.find(x => x.name === g.opponent) || null;
  t = T();
  const out = generatePlays(g, s2.userTeam, opp, s2.players, { phase: s2.phase, isSpring: false, winProb: 0.5, rand: dice('measure', d) });
  const tGame = ms(t);
  rows.push({ day: d + 1, tClone, tDay, tGame, plays: out.plays.length, cpuGames: (s2.leagueSchedule?.dayMap?.[g.date] || []).length });
  // play it for real and commit, to move on
  for (let guard = 0; guard < 3000; guard++) {
    const gg = SM.get().schedule[idx];
    if (gg.status === GAME_STATUS.FINAL || gg._committed) break;
    if (gg.status === GAME_STATUS.LIVE) { const np = gg.plays?.[gg.livePlayIndex]; clock.set(np ? np._timestamp + 1000 : clock.get() + 60_000); }
    else clock.set(Math.max(clock.get() + 60_000, gg.gameTime));
    tick(); releaseDueCards();
  }
  if (!SM.get().schedule[idx]._committed) await commitGame(idx);
  void copy;
}
console.table(rows.map(r => ({ day: r.day, 'copy ms': r.tClone.toFixed(1), 'world day ms': r.tDay.toFixed(0), 'our game ms': r.tGame.toFixed(1), plays: r.plays, 'CPU games': r.cpuGames })));
const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
console.log(`average: copy ${avg('tClone').toFixed(1)} ms · a world day ${avg('tDay').toFixed(0)} ms · our game ${avg('tGame').toFixed(1)} ms (node on this machine; a phone is slower)`);
