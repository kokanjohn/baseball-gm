/**
 * tools/harness/check-live-names.mjs — r283 §122.162 messages name people as they're called now.
 *   - A message notes who it names when it arrives (`_people`); a department's message too, for the staff it mentions.
 *   - Renamed: the message, its sender line and its follow-up read the new name; the stored text is untouched.
 *   - Written before a rename, arriving after: still the new name (found by the old one).
 *   - Renamed twice: the latest name, whichever name the message was written with.
 *   - The push for a message on its way reads the new name.
 *   - A name two people share is nobody's unless one of them sent it (left as written).
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { renamePerson } from '../../engine/People.js';
import { viewOf, senderLabel, peopleIn, stampSender } from '../../engine/Senders.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(283);
clock.set(Date.UTC(2400, 0, 1, 13));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const mgr = { ...S().userTeam.coachingStaff.manager };   // (as it was: the name before any rename)
const card = (id) => S().inbox.find(c => c.instanceId === id);

const m = CE.deliverCardById('sp12');   // from the manager
check(`a message from the manager notes who it names (${JSON.stringify(card(m.instanceId)._people)})`, card(m.instanceId)._people?.[mgr.id] === mgr.name);
const dept = stampSender({ sender: 'Stadium Ops.', subject: 'x', body: `${mgr.name} asked about the bullpen mound.` }, S());
check('a department\'s message mentioning the manager notes the manager', dept._people?.[mgr.id] === mgr.name && !dept._senderId);

SM.mutate(s => { renamePerson(s, mgr.id, 'Quillfeather'); });
const raw = card(m.instanceId), v = viewOf(raw, S());
check(`renamed: the sender line (“${senderLabel(raw, S())}”) and the text read the new name`, senderLabel(raw, S()) === 'Quillfeather, Manager' && !new RegExp(`\\b${mgr.name}\\b`).test(v.body + v.subject) && raw.sender.includes(mgr.name));
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === m.instanceId); c._followUp = { atMs: clock.get(), text: `Following up on this. ${mgr.name} needs your answer.` }; });
check('…its follow-up too', viewOf(card(m.instanceId), S())._followUp.text.includes('Quillfeather'));

// written before the rename, arriving after
const s2 = CE.deliverCardById('ls1');   // (any card; rewrite its words to name the manager by the old name, as written earlier)
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === s2.instanceId); c.body = `${mgr.name} wants a word before the game.`; delete c._people; });
const arrived = stampSender({ ...card(s2.instanceId), _senderRole: undefined }, S());
check('written before the rename, arriving after: found by the old name, read with the new', arrived._people?.[mgr.id] === mgr.name && viewOf(arrived, S()).body.startsWith('Quillfeather'));

// renamed twice
SM.mutate(s => { renamePerson(s, mgr.id, 'Brightwater'); });
check('renamed twice: the latest name, whichever the message was written with', viewOf(card(m.instanceId), S()).subject === viewOf(card(m.instanceId), S()).subject && senderLabel(card(m.instanceId), S()) === 'Brightwater, Manager'
  && viewOf(card(m.instanceId), S())._followUp.text.includes('Brightwater') && viewOf(arrived, S()).body.startsWith('Brightwater'));

// the push for a message on its way
SM.mutate(s => { s.scheduledCards = [...(s.scheduledCards || []), { instanceId: 'test-push', cardId: 'x', sender: `${mgr.name} (Manager)`, subject: `${mgr.name} has a question`, deliverAtMs: clock.get() + 3_600_000, expiresAtMs: clock.get() + 30 * 3_600_000 }]; });
const push = CE.getPushSchedule(S(), clock.get()).find(p => p.id === 'test-push');
check(`the push for a message on its way: “${push?.title}: ${push?.body}”`, push?.title === 'Brightwater, Manager' && push.body === 'Brightwater has a question');

// a name two people share
SM.mutate(s => { const gm = s.leagueTeams[0].gm; gm.name = 'Twinname'; s.people[gm.id].name = 'Twinname'; s.userTeam.ownerName = 'Twinname'; s.people[s.userTeam.ownerId].name = 'Twinname'; });
const amb = peopleIn({ sender: 'Stadium Ops.', body: 'Twinname called.' }, S());
const fromOwner = peopleIn({ sender: 'Twinname', _senderId: S().userTeam.ownerId, body: 'Twinname here.' }, S());
check('a name two people share: nobody\'s (left as written), unless one of them sent it', Object.keys(amb).length === 0 && Object.keys(fromOwner).join() === S().userTeam.ownerId);

// r284 §122.163 a name someone went by is never handed to someone new; text kept as words reads the new name
const { liveText, namesInUse } = await import('../../engine/People.js');
const Coach = await import('../../engine/CoachEngine.js');
const { nameProblem } = await import('../../engine/NameRules.js');
check(`the old names stay taken (${mgr.name}, Quillfeather)`, namesInUse(S()).has(mgr.name) && namesInUse(S()).has('Quillfeather'));
const cands = Array.from({ length: 30 }, (_, k) => Coach.candidates(S(), 'hittingCoach', null, { rand: (() => { let x = k + 1; return () => (x = (x * 9301 + 49297) % 233280) / 233280; })() })).flat().map(c => c.name);
check('…no candidate is ever given one', !cands.includes(mgr.name) && !cands.includes('Quillfeather'));
check(`the feed's words read the new name (“${liveText(S(), `${mgr.name} takes over as manager.`)}”)`, liveText(S(), `${mgr.name} takes over as manager.`) === 'Brightwater takes over as manager.');
const pid = S().userTeam.coachingStaff.benchCoach.id;
check('renaming: a name someone else goes by is refused; a word the game uses; a club\'s; a player\'s; a good one is fine',
  !!nameProblem(S(), pid, 'Brightwater') && !!nameProblem(S(), pid, 'Weather') && !!nameProblem(S(), pid, S().leagueTeams[0].city)
  && !!nameProblem(S(), pid, Object.values(S().players)[0].name) && nameProblem(S(), pid, 'Ollivander') === null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
