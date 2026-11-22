// r251 §122.130 All the development work through the Bench Coach.
//   node tools/harness/check-bench-work.mjs [seed=1]
// "Who should we work on…?": by the odds or by what it's worth to the club, the best three for a skill, each with its
// work; picking one starts it (its cost out of club funds). "Work with a player on…": any player, any skill — the
// skill's coach does it (the reply names them), the glove is the bench coach's own. The program from here too.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick } from '../../engine/GameEngine.js';
import { releaseDueCards, deliverComposeCard, resolve, getInbox } from '../../engine/CardEngine.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { whoRead, coachRead } from '../../engine/PlayerWork.js';
import { gainMultiplier, roomLeft } from '../../engine/DevelopmentEngine.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(clock.get() + 60_000); tick(); releaseDueCards();
let st = SM.get();
const P = (id) => SM.get().players[id];
const names = (r) => r.list.map(x => `${x.p.name} ${x.read.value} (${x.score.toFixed(2)})`).join(', ');
const inLineup = (id) => st.userTeam.lineupSlots.some(sl => sl.playerId === id);

// ── whoRead ──
for (const skill of ['contact', 'power', 'speed', 'defense', 'stuff', 'control', 'stamina']) {
  const L = whoRead(st, skill, 'likely', 'coach', clock.get()), H = whoRead(st, skill, 'help', 'coach', clock.get());
  const okL = L.list.length === 3 && L.list.every((x, i) => i === 0 || L.list[i - 1].score >= x.score)
    && L.list.every(x => Math.abs(x.score - gainMultiplier(st, x.p, skill === 'defense' ? 'benchCoach' : null) * roomLeft(x.read.value)) < 1e-9);
  check(`${skill}, most likely: three, by the odds the work rolls on — ${names(L)}`, okL);
  check(`${skill}, most help: three, best first — ${names(H)}`, H.list.length === 3 && H.list.every((x, i) => i === 0 || H.list[i - 1].score >= x.score));
}
{ const H = whoRead(st, 'power', 'help', 'coach', clock.get());
  check('most help leans to the lineup over the bench (power)', H.list.filter(x => inLineup(x.p.id)).length >= 2, names(H)); }
{ const H = whoRead(st, 'stamina', 'help', 'coach', clock.get());
  check('most help with stamina leans to the rotation', H.list.filter(x => st.userTeam.rotation.order.includes(x.p.id)).length >= 2, names(H)); }
{ const D = whoRead(st, 'defense', 'help', 'coach', clock.get());
  check('the glove: no DH on the list (it only counts in the field)', !D.list.some(x => st.userTeam.lineupSlots.find(sl => sl.playerId === x.p.id)?.slot === 'DH'), names(D));
  check('the glove is the bench coach\'s, never the complex', whoRead(st, 'defense', 'likely', 'program', clock.get()).owner === 'benchCoach'); }
{ const G = whoRead(st, 'contact', 'likely', 'program', clock.get());
  check(`at the complex: the program's terms (${G.list.map(x => `${x.read.days}d $${x.read.costK}K`).join(', ')})`, G.owner === 'program' && G.list.every(x => x.read.days >= 5 && x.read.costK > 0)); }

// ── the reply and picking one ──
const rep = writeComposeReply(st, { topicId: 'bc_who', channelId: 'bench_coach', atMs: clock.get(), arg: { skill: 'contact', rank: 'help', where: 'coach' } });
check(`the reply lists three, numbered (“${(rep?.body || '').split('\n').find(x => /^1\. /.test(x))}”)`, !!rep && ((rep.body || '').match(/^\d\. /gm) || []).length === 3 && rep.decision?.choices?.length === 3);
deliverComposeCard('bc_who', 'bench_coach', { topicLabel: 'Who should we work on for contact?', arg: { skill: 'contact', rank: 'help', where: 'program' } });
clock.set(clock.get() + 6 * 3_600_000); tick(); releaseDueCards();
let card = getInbox().find(c => c.isCompose && c._composeTopic === 'bc_who' && !c.resolved);
check(`the Bench Coach answers (${card?.sender}), with three buttons: ${(card?._choices || []).map(c => `${c.label} [${c.sub}]`).join(' | ')}`,
      !!card && card._choices?.length === 3 && String(card.sender).startsWith(SM.get().userTeam.coachingStaff.benchCoach.name));
const pick = card?._choices?.[1]?.key, w = card?._whoWorks?.[pick];
const funds0 = SM.get().userTeam.finances.funds;
if (card) { resolve(card.instanceId, 'yes', { pick }); releaseDueCards(); }
st = SM.get();
const plan = (st.developmentPlans || []).find(x => x.status === 'active' && x.playerId === pick);
check(`picking the second (${P(pick)?.name}) starts their program on contact`, !!plan && plan.keys.includes('contact') && w.owner === 'program', JSON.stringify(plan?.keys));
const funds1 = st.userTeam.finances.funds;
check(`…its cost out of club funds ($${w?.costK}K)`, Number.isFinite(funds0) && Math.round(funds0 - funds1) === w.costK, `${funds0} → ${funds1}`);
check(`…and ${P(pick)?.name} is away`, !!P(pick)?.unavailable);

// ── "Work with a player on…": the skill's coach does it ──
const hitter = st.userTeam.lineupSlots.map(sl => P(sl.playerId)).find(p => p && p.id !== pick && p.subRatings?.defense != null);
const B = (r) => String(r?.body || '').split('\n\n');
const r1 = writeComposeReply(st, { topicId: 'bc_work', channelId: 'bench_coach', atMs: clock.get(), arg: { playerId: hitter.id, skill: 'power' } });
const hc = st.userTeam.coachingStaff.hittingCoach.name;
check(`power, asked of the Bench Coach: the hitting coach does it, named (“${B(r1).find(x => x.includes(hc))?.slice(0, 90)}…”)`,
      r1?.decision?.work?.owner === 'hittingCoach' && B(r1).some(x => x.includes(hc)) && !B(r1).some(x => /with me at the complex|I'll fold it/.test(x)));
const r2 = writeComposeReply(st, { topicId: 'bc_work', channelId: 'bench_coach', atMs: clock.get(), arg: { playerId: hitter.id, skill: 'defense' } });
check('the glove: the bench coach\'s own work ("I")', r2?.decision?.work?.owner === 'benchCoach' && !B(r2).some(x => x.includes(hc)));
const arm = st.userTeam.rotation.order.map(P).find(Boolean);
const r3 = writeComposeReply(st, { topicId: 'bc_work', channelId: 'bench_coach', atMs: clock.get(), arg: { playerId: arm.id, skill: 'control' } });
check('control: the pitching coach does it, named', r3?.decision?.work?.owner === 'pitchingCoach' && B(r3).some(x => x.includes(st.userTeam.coachingStaff.pitchingCoach.name)));
const r4 = writeComposeReply(st, { topicId: 'sc_program', channelId: 'bench_coach', atMs: clock.get(), arg: { playerId: arm.id, skill: 'stuff' } });
check('the development program, from the Bench Coach: the complex is busy with the one sent (one at a time)', !!r4 && /one player at a time|would go next/.test(String(r4.body)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
