/**
 * tools/harness/check-gm-connections.mjs — r212 §122.90
 *   - who a message is from, the same way everywhere: "Name, Role" for a person (the owner, the manager, the
 *     coaches, the scouting director, another club's GM), the department as it is; the role stamped on arrival
 *     survives a staff change;
 *   - every spring after the first, a club or two has a new GM (a losing club likelier), named, not a name in use;
 *     our standing carries over in part;
 *   - each new GM reaches out in spring, and so does one club we've never traded with;
 *   - welcoming a new GM first (Compose → Other GMs) goes further than answering, takes their hello back, and the
 *     GM writes back.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { buildCardContext } from '../../engine/GameEngine.js';
import { senderLabel, stampSender } from '../../engine/Senders.js';
import { gmTurnover, newGms, gmsToWelcome, greetedThisSeason, tradedWith, cpuGmName, GM_TURNOVER } from '../../engine/FirstDay.js';
import { rapportOf } from '../../engine/TradeEngine.js';
import { dice } from '../../engine/Dice.js';
import { inQuietHours } from '../../engine/CardScheduler.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

seedRandom(12);
await startNewGame({ archetypeId: 'lab', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

// ── Who it's from ──
console.log('Who it\'s from');
{
  const st = S(), cs = st.userTeam.coachingStaff;
  const L = (sender, extra = {}) => senderLabel({ sender, ...extra }, st);
  const cases = [
    [st.userTeam.ownerName, `${st.userTeam.ownerName}, Owner`],
    [cs.manager.name, `${cs.manager.name}, Manager`],
    [cs.scoutingDirector.name, `${cs.scoutingDirector.name}, Scouting Director`],
    [cs.pitchingCoach.name, `${cs.pitchingCoach.name}, Pitching Coach`],
    [`${cs.scoutingDirector.name}, Scouting Director`, `${cs.scoutingDirector.name}, Scouting Director`],
    [`${cs.manager.name} (Manager)`, `${cs.manager.name}, Manager`],
    ['Morello (Gulfport Mullets GM)', 'Morello, Gulfport Mullets GM'],
    ['Pro Scouting', 'Pro Scouting'], ['Ticket Office', 'Ticket Office'], ['Team Physician', 'Team Physician'],
    ["Spencer (L)'s agent", "Spencer (L)'s agent"],
  ];
  const bad = cases.filter(([s, want]) => L(s) !== want).map(([s, want]) => `${s} → ${L(s)} (want ${want})`);
  check(`a person reads "Name, Role"; a department as it is (${cases.length} cases)`, bad.length === 0, bad.join(' | '));
  const stamped = stampSender({ sender: cs.manager.name }, st);
  const after = structuredClone(st); after.userTeam.coachingStaff.manager = { ...after.userTeam.coachingStaff.manager, name: 'Someoneelse' };
  check(`stamped on arrival: an old message still reads "${senderLabel(stamped, after)}" after the manager changes`, senderLabel(stamped, after) === `${cs.manager.name}, Manager` && senderLabel({ sender: cs.manager.name }, after) === cs.manager.name);
  const pushes = CE.getPushSchedule(S(), clock.get()).filter(p => p.kind === 'messages').map(p => ({ ...p, sender: p.title }));
  const push = pushes.filter(p => /, (Owner|Manager|Scouting Director|Pitching Coach|Hitting Coach|Bench Coach)$|GM$/.test(p.sender));
  const bare = pushes.filter(p => Object.values(cs).some(x => x?.name === p.sender) || p.sender === st.userTeam.ownerName || /\)$/.test(p.sender) && !/'s agent$/.test(p.sender));
  check(`the phone's pushes read the same way (${push.length} from a person: ${[...new Set(push.map(p => p.sender))].slice(0, 3).join('; ')} — none bare)`, push.length > 0 && bare.length === 0, bare.map(p => p.sender).join());
  // The first day's messages arrive: each from a person carries the role.
  const t0 = clock.get();
  clock.set(t0 + 30 * 3_600_000); CE.releaseDueCards(clock.get());
  const arrived = (S().inbox || []).filter(c => /\(.+\)$/.test(c.sender) || c.sender === st.userTeam.ownerName || Object.values(cs).some(x => x?.name === c.sender));
  check(`messages that arrive carry the role (${arrived.length} from our people: ${[...new Set(arrived.map(c => senderLabel(c, S())))].slice(0, 3).join('; ')})`, arrived.length > 0 && arrived.every(c => !!c._senderRole));
  clock.set(t0);
}

// ── GMs come and go ──
console.log('\nA new GM or two each spring');
{
  const names0 = Object.fromEntries(S().leagueTeams.map(t => [t.id, cpuGmName(S(), t.id)]));
  let worst = null;
  let counts = [], fromLosers = 0, total = 0;
  for (let k = 0; k < 200; k++) {
    const d = structuredClone(S());
    d.seasonNum = 2;
    const recs = Object.fromEntries(d.leagueTeams.map((t, i) => [t.id, { wins: 40 + i * 5, losses: 80 - i * 5 }]));
    worst = d.leagueTeams[0].id;
    const out = gmTurnover(d, dice(k, 'test'), { records: recs });
    counts.push(out.length); total += out.length; fromLosers += out.filter(o => o.teamId === d.leagueTeams[0].id || o.teamId === d.leagueTeams[1].id).length;
    if (k === 0) {
      const names = d.leagueTeams.map(t => t.gm.name);
      const staff = Object.values(d.userTeam.coachingStaff).map(c => c?.name);
      check(`a change: ${out.map(o => `${d.leagueTeams.find(t => t.id === o.teamId).name}: ${o.prev} → ${o.name}`).join('; ')}`,
            out.every(o => o.prev === names0[o.teamId] && o.name !== o.prev) && new Set(names).size === names.length && !names.some(n => staff.includes(n))
            && d.leagueTeams.filter(t => !out.some(o => o.teamId === t.id)).every(t => t.gm.name === names0[t.id] && t.gm.since === 1)
            && out.every(o => d.leagueTeams.find(t => t.id === o.teamId).gm.since === 2));
    }
  }
  const twos = counts.filter(n => n === 2).length;
  check(`one club a winter, two sometimes (${200 - twos} / ${twos}); the worst two clubs make ${Math.round(fromLosers / total * 100)}% of the changes (${Math.round(2 / S().leagueTeams.length * 100)}% if even)`,
        counts.every(n => n === 1 || n === 2) && twos > 40 && twos < 120 && fromLosers / total > 2 / S().leagueTeams.length + 0.05);
  const d = structuredClone(S()); d.seasonNum = 2;
  const id = d.leagueTeams[0].id;
  d.userTeam.gmRelationships = { [id]: 80 };
  for (const t of d.leagueTeams) t.gm = { name: cpuGmName(d, t.id), since: 1 };
  const r = () => 0.01;   // the first club
  gmTurnover(d, r, { records: { [id]: { wins: 0, losses: 100 } } });
  check(`our standing carries over in part (80 with the old GM → ${d.userTeam.gmRelationships[id]} with the new)`, d.userTeam.gmRelationships[id] === 65);
}

// ── Spring: the new GMs reach out, and a club we've never traded with ──
console.log('\nSpring');
const spring = clock.get() + 2 * DAY;
let fresh;
{
  SM.mutate(s => {
    s.seasonNum = 2;
    for (const t of s.leagueTeams) t.gm = { name: cpuGmName(s, t.id), since: 1 };
    s.leagueTeams[2].gm = { name: 'Newcomb', since: 2, prev: s.leagueTeams[2].gm.name };
    s.leagueTeams[5].gm = { name: 'Halberg', since: 2, prev: s.leagueTeams[5].gm.name };
    // a trade with club 7
    s.transactions = [...(s.transactions || []), { reason: 'trade', teamId: 'user', fromTeamId: s.leagueTeams[7].id, atMs: 1 }];
  });
  fresh = newGms(S());
  check(`new GMs this season: ${fresh.map(t => `${t.gm.name} (${t.name})`).join(', ')}`, fresh.length === 2);
  check('a club we\'ve traded with is known', tradedWith(S()).has(S().leagueTeams[7].id) && tradedWith(S()).size === 1);
  const parked = CE.scheduleSpringGms(spring, buildCardContext());
  for (const c of parked) console.log(`    day ${((c.deliverAtMs - spring) / DAY).toFixed(1)}  ${senderLabel(c, S())} — ${c.subject}`);
  const forNew = parked.filter(c => fresh.some(t => t.id === c._gmTeamId));
  const later = parked.filter(c => c._gmKind === 'later');
  check('each new GM reaches out; one club we\'ve never traded with too (not a new GM, not the club we traded with)',
        forNew.length === 2 && later.length === 1 && !fresh.some(t => t.id === later[0]._gmTeamId) && later[0]._gmTeamId !== S().leagueTeams[7].id);
  check('inside staff hours, through spring', parked.every(c => !inQuietHours(c.deliverAtMs) && c.deliverAtMs > spring && c.deliverAtMs < spring + 12 * DAY));
  check('from the GM, by name and club', forNew.every(c => senderLabel(c, S()) === `${S().leagueTeams.find(t => t.id === c._gmTeamId).gm.name}, ${S().leagueTeams.find(t => t.id === c._gmTeamId).name} GM`));
}

// ── Welcome a new GM first ──
console.log('\nWelcome a new GM (Compose → Other GMs)');
{
  const list = gmsToWelcome(S());
  check(`the new GMs to welcome: ${list.map(x => x.label).join(', ')}`, list.length === 2);
  const [a, b] = fresh;
  const r0 = rapportOf(S(), a.id);
  const sent = CE.deliverComposeCard('gm_welcome', 'other_gms', { topicLabel: 'Welcome to the league', arg: { key: a.id, gm: a.gm.name, club: a.name }, nowMs: spring });
  check(`welcoming first: our standing +${GM_TURNOVER.welcomeBonus} (${r0} → ${rapportOf(S(), a.id)}), more than any answer to a hello`, rapportOf(S(), a.id) - r0 === GM_TURNOVER.welcomeBonus);
  check('their hello is taken back; they can\'t be welcomed twice', !(S().scheduledCards || []).some(c => c._rosterKey === `gmhello:2:${a.id}`) && greetedThisSeason(S(), a.id) && gmsToWelcome(S()).length === 1);
  clock.set(sent.deliverAtMs + 60_000);
  CE.releaseDueCards(clock.get());
  const reply = CE.getInbox().find(c => c.instanceId === sent.instanceId);
  console.log(`    ${senderLabel(reply, S())} — ${reply?.subject}\n    ${reply?.body?.replace(/\n\n/g, ' / ')}`);
  check('the GM writes back, signed, from the GM (not our staff)', !!reply && senderLabel(reply, S()) === `${a.gm.name}, ${a.name} GM` && reply.body.endsWith(`— ${a.gm.name}`) && !/Glad you asked|Here's my read/.test(reply.body));
  // Answering the other GM's hello counts as having heard from us.
  const hb = (S().scheduledCards || []).find(c => c._rosterKey === `gmhello:2:${b.id}`);
  clock.set(hb.deliverAtMs + 60_000);
  CE.releaseDueCards(clock.get());
  CE.resolve(hb.instanceId, 'yes');
  check('answering a new GM\'s hello: nobody left to welcome', greetedThisSeason(S(), b.id) && gmsToWelcome(S()).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
