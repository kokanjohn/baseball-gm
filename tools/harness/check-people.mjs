/**
 * tools/harness/check-people.mjs — r281 §122.160 every named person has an id, and keeps it.
 *   - A new club: our five staff and the owner, every club's manager and GM, each a distinct id, all in the record
 *     (state.people) under their name, role and club.
 *   - The winter: a CPU club's manager let go keeps the id on the market; one hired from the market keeps theirs;
 *     a GM replaced stays in the record (left), the new one has a new id (`prevId` on the club's GM).
 *   - Ours: a coach let go stays in the record (left, `prevId` on the empty chair); the new coach gets an id; a manager
 *     hired from the market is the same person (same id), and leaves the market.
 *   - A storyline about a coach follows the person: the same id under a new name goes on; a new coach who happens to
 *     share the old name doesn't.
 *   - A message from one of ours carries who it's from (`_senderId`).
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as Managers from '../../engine/ManagerEngine.js';
import * as Off from '../../engine/OffseasonEngine.js';
import { gmTurnover } from '../../engine/FirstDay.js';
import { samePerson, nameOf } from '../../engine/People.js';
import { stampSender } from '../../engine/Senders.js';
import { dice } from '../../engine/Dice.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(281);
clock.set(Date.UTC(2400, 0, 1, 13));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

const st = S(), u = st.userTeam;
const ours = Object.entries(u.coachingStaff).map(([role, c]) => ({ role, ...c }));
const cpu = st.leagueTeams.flatMap(t => [{ role: 'manager', club: t.id, ...t.manager }, { role: 'gm', club: t.id, ...t.gm }]);
const all = [...ours, { role: 'owner', club: 'user', id: u.ownerId, name: u.ownerName }, ...cpu];
const ids = all.map(x => x.id);
check(`a new club: ${all.length} people, each with an id, no two the same`, ids.every(Boolean) && new Set(ids).size === ids.length);
const off = all.filter(x => { const p = st.people?.[x.id]; return !p || p.name !== x.name || p.role !== x.role || p.clubId !== (x.club || 'user') || p.left != null; });
check('…all in the record under their name, role and club', off.length === 0, JSON.stringify(off.slice(0, 3)));

// ── the winter: CPU managers and GMs ──
const rand = dice(281, 'people');
let ev = [];
SM.mutate(s => { for (const t of s.leagueTeams) { t.wins = 50; t.losses = 112; } ev = Managers.cpuWinter(s, clock.get(), rand); });
const out = ev.map(e => cpu.find(x => x.role === 'manager' && x.club === e.teamId));
const market = S().managerPool || [];
// (let go, then on the market — or hired straight away by another club that winter: the same id either way)
const whereNow = (m) => market.find(x => x.id === m.id) ? 'market' : S().leagueTeams.find(t => t.manager?.id === m.id)?.id || null;
check(`managers let go (${ev.length}) keep their ids: ${out.map(m => `${m.name} → ${whereNow(m)}`).join(', ')}`, ev.length > 0
  && out.every(m => { const w = whereNow(m); return w && w !== m.club && S().people[m.id].name === m.name && (S().people[m.id].clubId ?? 'market') === w; }));
const newMgrs = ev.map(e => S().leagueTeams.find(t => t.id === e.teamId).manager);
check('…their clubs\' new managers each have an id, in the record under that club', newMgrs.every((m, i) => m.id && S().people[m.id]?.clubId === ev[i].teamId && m.id !== out[i].id));
// a second winter: one hired from the market keeps the id
let ev2 = [];
SM.mutate(s => { s.seasonNum = (s.seasonNum || 1) + 1; ev2 = Managers.cpuWinter(s, clock.get(), dice(282, 'people')); });
const rehired = S().leagueTeams.map(t => t.manager).filter(m => out.some(o => o.id === m.id));
console.log(`    the second winter: ${ev2.length} changes; ${rehired.length} hired back from the market`);
check('a manager hired from the market is the same person (same id, same name)', rehired.every(m => out.find(o => o.id === m.id).name === m.name && S().people[m.id].clubId !== null));
let gmOut = [];
SM.mutate(s => { gmOut = gmTurnover(s, dice(283, 'gms'), {}); });
const gmOk = gmOut.every(o => { const t = S().leagueTeams.find(x => x.id === o.teamId); const was = cpu.find(x => x.role === 'gm' && x.club === o.teamId);
  return t.gm.id && t.gm.id !== was.id && t.gm.prevId === was.id && S().people[was.id].left != null && S().people[t.gm.id].clubId === t.id; });
check(`a new GM (${gmOut.length}): a new id; the one before stays in the record, left (prevId)`, gmOut.length > 0 && gmOk);

// ── ours: a coach let go, a new one; a manager from the market ──
const pc = S().userTeam.coachingStaff.pitchingCoach;
SM.mutate(s => { Off.applyCoachDecision(s, 'pitchingCoach', 'letgo', { atMs: clock.get() }); });
const chair = S().userTeam.coachingStaff.pitchingCoach;
check(`a coach let go (${pc.name}): stays in the record, left; the chair remembers who (prevId)`, chair.vacant && chair.prevId === pc.id && S().people[pc.id].left != null && S().people[pc.id].clubId === 'user');
SM.mutate(s => { Off.applyCoachHire(s, 'pitchingCoach', { name: 'Newcoach', salary: 100, quality: 60, specialty: 'command', background: '' }); });
const npc = S().userTeam.coachingStaff.pitchingCoach;
check(`the new coach (${npc.name}): an id of their own, in the record`, npc.id && npc.id !== pc.id && S().people[npc.id]?.role === 'pitchingCoach' && S().people[npc.id].left == null);
const [A] = Managers.candidates(S(), { rand: dice(284, 'cand') });
const oldMgr = S().userTeam.coachingStaff.manager;
if (A.id) {
  SM.mutate(s => { Off.applyManagerHire(s, A); });
  const m = S().userTeam.coachingStaff.manager;
  check(`our manager hired from the market (${A.name}): the same person, off the market; the one before stays in the record`,
    m.id === A.id && !(S().managerPool || []).some(x => x.id === A.id) && S().people[A.id].clubId === 'user' && S().people[oldMgr.id].left != null);
} else check('a market candidate (the market is empty)', false);

// ── a storyline about a coach follows the person ──
const { ARCS } = await import('../../engine/Arcs.js').then(m => ({ ARCS: m.ARCS || m.default?.ARCS })).catch(() => ({}));
const arcDef = (ARCS || []).find(a => a.key === 'coach');
if (arcDef) {
  const hc = S().userTeam.coachingStaff.hittingCoach;
  const arc = { who: { role: 'hittingCoach', name: hc.name, id: hc.id, club: S().leagueTeams[0].id } };
  check('a storyline about the hitting coach: on while the coach is here', arcDef.alive(S(), arc));
  SM.mutate(s => { s.userTeam.coachingStaff.hittingCoach.name = 'Renamed'; s.people[hc.id].name = 'Renamed'; });
  check(`…still on under a new name (“${nameOf(S(), hc.id)}”: the same id)`, arcDef.alive(S(), arc));
  SM.mutate(s => { s.userTeam.coachingStaff.hittingCoach = { ...s.userTeam.coachingStaff.hittingCoach, id: 'pp-someone-else', name: hc.name }; });
  check('…over when a different person holds the job, even with the old name', !arcDef.alive(S(), arc));
} else check('the coach storyline is found (Arcs exports ARCS)', false, 'no export');

// ── a message from one of ours ──
const mgr = S().userTeam.coachingStaff.manager;
const msg = stampSender({ sender: `${mgr.name} (Manager)`, subject: 'x' }, S());
const dept = stampSender({ sender: 'Stadium Ops.', subject: 'x' }, S());
check(`a message from our manager carries who it's from (${msg._senderId})`, msg._senderId === mgr.id && samePerson({ id: msg._senderId }, mgr) && !dept._senderId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
