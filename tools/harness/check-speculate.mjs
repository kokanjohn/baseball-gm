// r203 §122.81 The look-ahead's copy of the state (StateManager.speculate) shares what nothing changes once
// written — the box scores of finished games, each player's game log and season log — and copies the rest.
// The real state comes back exactly as it was, even when the look-ahead changes things or throws. A game
// that's over keeps only what's read after it (GameEngine._settleFinished; the save's one-time trim).
//   node tools/harness/check-speculate.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, _settleFinished } from '../../engine/GameEngine.js';
import { migrate } from '../../store/schema.js';
import { foresee } from '../../engine/LookAhead.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const S = () => SM.get();

seedRandom(31);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });

// A finished game of ours and of the league's, with a box; a player with logs.
const box = { linescore: { 1: { top: 1, bot: 0 } }, home: { batting: [] }, away: { batting: [] } };
let leagueDate, pid;
SM.mutate(s => {
  const g = s.schedule[0];
  Object.assign(g, { _committed: true, boxScore: structuredClone(box), status: 'final', liveLineups: { away: [], home: [] },
                     wxResult: { startAt: 1, delays: [], conditions: [{ t: 1, tempF: 60 }, { t: 2, tempF: 61 }, { t: 3, tempF: 62 }] } });
  leagueDate = Object.keys(s.leagueSchedule.dayMap)[0];
  Object.assign(s.leagueSchedule.dayMap[leagueDate][0], { played: true, status: 'final', boxScore: structuredClone(box) });
  pid = Object.keys(s.players).find(id => s.players[id].teamId === 'user');
  s.players[pid]._impGameLog = [{ gameIndex: 0, date: 'x', stats: { h: 1 } }];
  s.players[pid].seasonLog = [{ season: 0, stats: { g: 1 } }];
});
const real = S();
const before = JSON.stringify(real);

console.log('\nThe copy');
SM.speculate(() => {
  const c = S();
  check('a different state', c !== real && c.players !== real.players && c.schedule !== real.schedule);
  check('a finished game\'s box is shared (ours and the league\'s)', c.schedule[0].boxScore === real.schedule[0].boxScore
    && c.leagueSchedule.dayMap[leagueDate][0].boxScore === real.leagueSchedule.dayMap[leagueDate][0].boxScore);
  check('…the game itself is copied', c.schedule[0] !== real.schedule[0]);
  check('a player\'s game log and season log are shared', c.players[pid]._impGameLog === real.players[pid]._impGameLog
    && c.players[pid].seasonLog === real.players[pid].seasonLog && c.players[pid] !== real.players[pid]);
  check('a game not finished keeps its own box (copied)', !c.schedule[1].boxScore || c.schedule[1].boxScore !== real.schedule[1].boxScore);
  // The look-ahead changes the copy in the usual ways (replacing, not editing, what's shared).
  SM.mutate(s => {
    s.schedule[0].score = 'x'; s.players[pid].ovr = 1;
    s.players[pid]._impGameLog = [...s.players[pid]._impGameLog, { gameIndex: 1 }];
    s.players[pid].seasonLog = [...s.players[pid].seasonLog, { season: 1 }];
    s.inbox = []; s.leagueSchedule.dayMap[leagueDate][0].homeScore = 99;
  });
});
check('after it: the real state is exactly as it was', JSON.stringify(S()) === before);
check('…with its box and logs in place', S().schedule[0].boxScore && S().players[pid]._impGameLog.length === 1 && S().players[pid].seasonLog.length === 1);
try { SM.speculate(() => { throw new Error('boom'); }); } catch { /* expected */ }
check('a look-ahead that throws: the real state is exactly as it was', JSON.stringify(S()) === before);

console.log('\nA real look-ahead');
const t = clock.get();
const r1 = foresee(t, t + 24 * 3600_000, 72 * 3600_000);
check('the real state is exactly as it was', JSON.stringify(S()) === before);
const r2 = foresee(t, t + 24 * 3600_000, 72 * 3600_000);
check('the same answer twice (the shared parts, and the weather\'s remembered answers, change nothing)',
      JSON.stringify(r1) === JSON.stringify(r2), `${JSON.stringify(r1).length} vs ${JSON.stringify(r2).length}`);

console.log('\nA game that\'s over keeps what\'s read after it');
{
  const g = _settleFinished(structuredClone(real.schedule[0]));
  check('no batting orders for a live box', !('liveLineups' in g));
  check('the weather: the conditions at first pitch only; the rest kept', g.wxResult.conditions.length === 1 && g.wxResult.conditions[0].tempF === 60
    && g.wxResult.startAt === 1 && Array.isArray(g.wxResult.delays));
  check('the box kept', !!g.boxScore);
}
{
  const st = structuredClone(real);
  delete st._finishedGamesSettled;
  st.leagueSchedule.dayMap[leagueDate][0].liveLineups = { away: [] };
  st.leagueSchedule.dayMap[leagueDate][0].wxResult = { conditions: [{ t: 1 }, { t: 2 }] };
  const m = migrate(st);
  check('an older save: its finished games trimmed once', m._finishedGamesSettled === true && !m.schedule[0].liveLineups
    && m.schedule[0].wxResult.conditions.length === 1 && !m.leagueSchedule.dayMap[leagueDate][0].liveLineups
    && m.leagueSchedule.dayMap[leagueDate][0].wxResult.conditions.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
