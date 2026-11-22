// r253 §122.132 The player card's History: what happens to our players, kept.
//   node tools/harness/check-player-log.mjs [seed=1]
// Rests and other time out, training started and how it ended, position lessons, injuries — written while the
// player is ours (never for another club's); newest first; the status line from PlayerStatus.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { startWork, startTeaching, teachablePositions } from '../../engine/PlayerWork.js';
import { setUnavailable } from '../../engine/DevelopmentEngine.js';
import { historyOf } from '../../engine/PlayerLog.js';
import { statusOf } from '../../engine/PlayerStatus.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const t0 = clock.get() + 60_000;
clock.set(t0); tick(); releaseDueCards();
let st = SM.get();
const P = (id) => SM.get().players[id];
const ids = st.userTeam.lineupSlots.map(s => s.playerId);
const [a, b, c] = ids;

// A rest, a training stint (days away), a lesson; and a CPU player's rest
const cpu = Object.values(st.players).find(p => p.teamId && p.teamId !== 'user' && p.group !== 'freeAgent');
SM.mutate(s => {
  setUnavailable(s, a, { reason: 'rest', games: 1 }, t0);
  startWork(s, { playerId: b, skill: 'contact', owner: 'hittingCoach', days: 2, gain: 4, source: 'test' }, t0 + 1000);
  const pos = teachablePositions(s.players[c])[0];
  if (pos) startTeaching(s, { playerId: c, pos, odds: 0.6 }, t0 + 2000);
  setUnavailable(s, cpu.id, { reason: 'rest', games: 1 }, t0);
});
st = SM.get();
check(`a rest: “${P(a).log?.at(-1)?.text}”`, P(a).log?.at(-1)?.text === 'Rested (1 game)');
check(`training: “${P(b).log?.at(-1)?.text}”`, /^Training: contact with the hitting coach \(2 days away\)$/.test(P(b).log?.at(-1)?.text || ''));
check(`a lesson: “${P(c).log?.at(-1)?.text}”`, /^Learning \w+$/.test(P(c).log?.at(-1)?.text || ''));
check('another club\'s player: nothing kept', !(P(cpu.id).log || []).length);
check(`the status line now: “${statusOf(st, P(b)).full}”`, /^Away training\. Back /.test(statusOf(st, P(b))?.full || ''));

// Time passes: the training lands (or doesn't), the lesson ends
// (each time one of ours is out, from whatever sends them out: the History has it, at that moment)
const outs = new Map(), missed = [];
for (let t = t0 + 6 * 3_600_000; t < t0 + 90 * DAY; t += 6 * 3_600_000) {
  clock.set(t); tick(); releaseDueCards();
  for (const g of SM.get().schedule) if (g.status === 'final' && !g._committed && g.liveLineups) { await commitGame(SM.get().schedule.indexOf(g)); releaseDueCards(); }   // (as the app does at the final)
  for (const id of SM.get().userTeam.rosterIds) {
    const u = P(id)?.unavailable;
    if (!u || u.reason === 'training' || !(u.since > t0) || outs.has(`${id}:${u.since}`)) continue;
    outs.set(`${id}:${u.since}`, u.reason);
    if (!(P(id).log || []).some(x => x.at === u.since)) missed.push(`${P(id).name} ${u.reason}`);
  }
  if ((P(b).log || []).some(x => /^Training done/.test(x.text)) && (P(c).log || []).length > 1) break;
}
const done = (P(b).log || []).find(x => /^Training done/.test(x.text));
check(`the training ends in the History: “${done?.text}”`, !!done && /contact (\d+ → \d+|didn't move)/.test(done.text));
check(`the lesson ends: “${P(c).log?.at(-1)?.text}”`, /^(Learned \w+|Lessons at \w+ done)$/.test(P(c).log?.at(-1)?.text || ''));
const h = historyOf(SM.get(), P(b));
check(`newest first (${h.map(x => x.text).join(' | ')})`, h.length >= 2 && h.every((x, i) => i === 0 || h[i - 1].at >= x.at));
check(`over ${Math.round((clock.get() - t0) / DAY)} days, every time one of ours was out is kept (${outs.size}${outs.size ? `: ${[...new Set(outs.values())].join(', ')}` : ', none this early'})`, !missed.length, missed.join(', '));
const inj = SM.get().userTeam.rosterIds.map(P).find(p => (p.injuryLog || []).length);
check(`an injury in the History${inj ? ` (${inj.name}: “${historyOf(SM.get(), inj).find(x => x.kind === 'injury')?.text}”)` : ' (none happened)'}`, !inj || historyOf(SM.get(), inj).some(x => x.kind === 'injury' && /^Hurt: /.test(x.text)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
