/**
 * tools/harness/trace-draws.mjs
 * DEV/TEST ONLY — every Math.random() draw the engines make, grouped by the
 * function that made it, over N regular-season game days (each from one
 * commit through the next game's final out and its commit). §118 step 1: the
 * list of draws that must come from seeded dice.
 *   node tools/harness/trace-draws.mjs [days=8]
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { GAME_STATUS, PHASE } from '../../data/constants.js';

const DAYS = parseInt(process.argv[2] || '8', 10);
seedRandom(21);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; });

const counts = new Map();
let phaseLabel = 'clock';
const real = Math.random;
Math.random = function traced() {
  const st = new Error().stack.split('\n').slice(2);
  const f = st.find(l => l.includes('/engine/') || l.includes('/store/')) || st[0] || '';
  const m = f.match(/at (?:(\S+) )?\(?.*\/((?:engine|store)\/[\w.]+\.js):(\d+)/);
  const key = m ? `${m[2]}:${m[3]} ${m[1] || ''}` : f.trim();
  const k = `${phaseLabel}\t${key}`;
  counts.set(k, (counts.get(k) || 0) + 1);
  return real();
};

for (let d = 0; d < DAYS; d++) {
  const idx = SM.get().currentGameIndex;
  const g = SM.get().schedule[idx];
  if (!g) break;
  phaseLabel = 'before first pitch';
  for (let guard = 0; guard < 400 && clock.get() < g.gameTime - 60_000; guard++) {
    clock.set(Math.min(g.gameTime - 60_000, clock.get() + 20 * 60_000)); advanceClock(clock.get()); releaseDueCards();
  }
  phaseLabel = 'our game';
  for (let guard = 0; guard < 3000; guard++) {
    const gg = SM.get().schedule[idx];
    if (gg.status === GAME_STATUS.FINAL || gg._committed || gg.cancelled) break;
    if (gg.status === GAME_STATUS.LIVE) { const np = gg.plays?.[gg.livePlayIndex]; clock.set(np ? np._timestamp + 1000 : clock.get() + 60_000); }
    else clock.set(Math.max(clock.get() + 60_000, gg.gameTime));
    tick(); releaseDueCards();
  }
  phaseLabel = 'commit';
  if (!SM.get().schedule[idx]._committed) await commitGame(idx);
}
Math.random = real;
const rows = [...counts.entries()].map(([k, n]) => { const [p, where] = k.split('\t'); return { when: p, where, draws: n }; })
  .sort((a, b) => a.when.localeCompare(b.when) || b.draws - a.draws);
console.table(rows);
