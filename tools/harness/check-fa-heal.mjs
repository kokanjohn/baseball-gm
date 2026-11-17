// §122.71 A player let go while hurt heals as a free agent: in the pool, group free agent, no club.
// (The injury clock gave every healed player outside our club an active group — a reliever with no
// club, still in the free-agent pool.)
//   node tools/harness/check-fa-heal.mjs
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { applyDue } from '../../engine/TransactionEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
seedRandom(3);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const st = SM.get(), now = Date.now();
const fa = st.freeAgentPool.find(x => st.players[x].pos === 'RP');
const cpu = st.leagueTeams[0], hurt = cpu.rosterIds.find(x => st.players[x].pos === 'RP');
SM.mutate(s => {
  for (const id of [fa, hurt]) Object.assign(s.players[id], { injury: { status: 'il', eligibleAt: now - 1000, injuredAt: now - 9e8 }, isInjured: true });
  s.players[hurt].group = 'il';
});
SM.mutate(d => applyDue(d, now));
const p = SM.get().players[fa], q = SM.get().players[hurt];
check(`a free agent's injury heals: still a free agent in the pool (${p.group}, club ${p.teamId})`, p.group === 'freeAgent' && p.teamId === null && !p.injury && SM.get().freeAgentPool.includes(fa));
check(`a CPU club's reliever back from the IL: active again (${q.group})`, q.group === 'bp' && q.teamId === cpu.id && !q.injury);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
