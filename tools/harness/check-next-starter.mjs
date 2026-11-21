// r243 §122.122 Benching the starter who's next up: the pitching coach says who starts now, with ways to fix it.
//   node tools/harness/check-next-starter.mjs [seed=1]
// The next rested starter in turn takes the game. The message names them and the game, and offers: put the
// benched starter back in line, or start a rested starter from the pitcher bench (into the open turn, next up),
// or leave it. Leaving it, the manager's fill at the deadline slots in behind: the named starter still starts.
// A swap that puts someone in that turn sends nothing. The message goes when the game starts.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, gmMove } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, nextStarterId } from '../../engine/CardEngine.js';
import { nextLineupGame, moveOptions } from '../../engine/RosterEngine.js';
import { PLAYER_GROUP, ROSTER_DECISION_LEAD_MS as LEAD } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const step = (t) => { clock.set(t); tick(); releaseDueCards(); };
const P = (id) => SM.get().players[id];
const card = () => getInbox().filter(c => c.cardId === 'next_starter' && !c.resolved).at(-1);
const nextUp = () => nextStarterId(SM.get(), nextLineupGame(SM.get()).gameTime);

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
step(clock.get());
const g = nextLineupGame(SM.get());
// a starter on the pitcher bench, to have one to offer
{ const st = SM.get(); const sp = st.userTeam.rotation.order.at(-1);
  if (!(st.userTeam.rosterIds || []).some(id => st.players[id]?.group === PLAYER_GROUP.PITCHER_BENCH && st.players[id]?.pos === 'SP'))
    gmMove(sp, 'bench', clock.get()); }
step(clock.get() + 5 * 60_000);
getInbox().filter(c => c.cardId === 'next_starter' && !c.resolved).forEach(c => resolve(c.instanceId, 'no'));
// fill the turn again so the rotation is whole
{ const st = SM.get(); const open = 5 - st.userTeam.rotation.order.length; if (open > 0) {
  const sp = (st.userTeam.rosterIds || []).map(id => st.players[id]).filter(p => p?.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'SP').sort((a, b) => a.ovr - b.ovr)[0];
  if (sp) gmMove(sp.id, 'turn:new', clock.get()); } }

// ── 1. bench the one next up: the coach names who starts now ──
const B = nextUp();
gmMove(B, 'bench', clock.get());
const X = nextUp();
check(`benched ${P(B).name} (next up): ${P(X)?.name} is next now`, !!X && X !== B);
step(clock.get() + 3 * 60_000);
let c = card();
check(`the pitching coach's message: “${c?.subject}”`, !!c && c.subject.startsWith(P(X).name) && c.sender === SM.get().userTeam.coachingStaff.pitchingCoach.name);
check(`…says who and when: “${c?.body}”`, !!c && c.body.includes(`${P(X).name} is up next`) && c.body.includes(P(B).name));
const keys = (c?._choices || []).map(x => x.key);
step(clock.get() + 25 * 60_000);   // (when the manager's open-spots message would come)
check('…and no second message about the open rotation turn', !getInbox().some(x => x.cardId === 'open_spots' && !x.resolved && /rotation/.test(x.body)));
check(`…offers to fix it (${(c?._choices || []).map(x => x.label).join(' | ')}) or leave it (“${c?.noLabel}”)`, keys[0] === 'back' && keys.some(k => k.startsWith('pick:')) && /^Leave it/.test(c?.noLabel || ''));

// Put them back
resolve(c.instanceId, 'yes', { pick: 'back' }); releaseDueCards();
check(`"Put ${P(B).name} back in line": next up again`, nextUp() === B && SM.get().userTeam.rotation.order.includes(B));

// ── 2. bench again; start one from the pitcher bench ──
gmMove(B, 'bench', clock.get());
step(clock.get() + 3 * 60_000);
c = card();
const pick = (c?._choices || []).find(x => x.key.startsWith('pick:'));
check('a second message for the second time', !!c && !!pick);
if (pick) {
  resolve(c.instanceId, 'yes', { pick: pick.key }); releaseDueCards();
  const R = pick.key.slice(5);
  check(`"${pick.label}": into the open turn, next up`, nextUp() === R && P(R).group === PLAYER_GROUP.STARTING_PITCHERS);
}

// ── 3. a swap that puts someone in that turn: nothing ──
const up = nextUp();
const swap = moveOptions(SM.get(), up).find(o => o.key.startsWith('in:'));
const before = getInbox().filter(x => x.cardId === 'next_starter').length;
if (swap) { gmMove(up, swap.key, clock.get()); step(clock.get() + 3 * 60_000); }
check('a swap (a bench starter takes that turn): no message', !swap || getInbox().filter(x => x.cardId === 'next_starter').length === before);

// ── 4. bench, leave it: the deadline fill slots in behind ──
const B2 = nextUp();
gmMove(B2, 'bench', clock.get());
const X2 = nextUp();
step(clock.get() + 3 * 60_000);
c = card();
if (c) { resolve(c.instanceId, 'no'); releaseDueCards(); }
check('leave it: the named starter is still next', nextUp() === X2);
step(g.gameTime - LEAD + 60_000);
check(`at the deadline the turn is filled (${SM.get().userTeam.rotation.order.length} in the rotation), and ${P(X2).name} still starts`, SM.get().userTeam.rotation.order.length === 5 && nextUp() === X2);

// ── 5. unanswered when the game starts: it goes ──
const B3 = nextUp();
gmMove(B3, 'bench', clock.get());
step(clock.get() + 3 * 60_000);
check('another message, unanswered', !!card());
step(g.gameTime + 60_000);
step(g.gameTime + 2 * 60_000);
check('the game started: the message is gone', !card());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
