/**
 * tools/harness/check-starred-report.mjs — r275 §122.154 starred players are league players, and the Scouting
 * Director reports on them.
 *   - One of ours can't be starred; a starred player who joins us is no longer starred.
 *   - "Our starred players": up to three a report, each named, with the season, the money (contract, asking price
 *     or the waiver clock) and whether the club would move the player; the next report starts with whoever
 *     waited longest.
 *   - Written clean: nothing broken, nothing gendered.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { toggleStar, starredIds, canStar, isStarred } from '../../engine/Starred.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(275);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const now = clock.get();

const ours = S().userTeam.rosterIds[0];
SM.mutate(s => toggleStar(s, ours, now));
check('one of ours can\'t be starred', !canStar(S(), ours) && !isStarred(S(), ours) && starredIds(S()).length === 0);

// four league players: two regulars on other clubs, a bench piece, a free agent
const clubs = S().leagueTeams;
const reg1 = clubs[0].lineupSlots[0].playerId, reg2 = clubs[1].rotation.order[0];
const bench = clubs[2].rosterIds.find(id => !(clubs[2].lineupSlots || []).some(sl => sl.playerId === id) && !(clubs[2].rotation?.order || []).includes(id));
const fa = (S().freeAgentPool || []).find(id => S().players[id]?.group === 'freeAgent');
const four = [reg1, reg2, bench, fa];
four.forEach((id, i) => SM.mutate(s => toggleStar(s, id, now + i)));
check(`four league players starred (${four.map(id => S().players[id]?.name).join(', ')})`, starredIds(S()).length === 4 && four.every(id => isStarred(S(), id)));

const GENDERED = /\b(he|him|his|himself|he's|he'll|he'd|she|her|hers|herself|guy|guys|man|men)\b/i;
const write = (atMs) => {
  const r = writeComposeReply(S(), { topicId: 'sc_starred', channelId: 'scouting', atMs });
  if (r) SM.mutate(s => { s.composeLog = [...(s.composeLog || []), { topicId: 'sc_starred', atMs, memo: r.memo }]; });
  return r;
};
const r1 = write(now + 60_000);
const n1 = r1?.memo?.playerIds || [];
console.log(`\n${r1?.body}\n`);
check(`a report: three players (${n1.map(id => S().players[id].name).join(', ')})`, n1.length === 3 && n1.every(id => r1.body.includes(S().players[id].name)));
check('…clean: nothing broken, nothing gendered', !/undefined|NaN|null|\[object|\$\{/.test(r1.body) && !GENDERED.test(r1.body), r1.body.match(GENDERED)?.[0]);
check('…a regular\'s contract and whether the club would move the player', /Paid \$[\d.]+[KM] a year/.test(r1.body) && /(could be had|would cost a lot|might listen|real value back|Worth a call|Nothing can happen now)/.test(r1.body));
const left = four.find(id => !n1.includes(id));
const r2 = write(now + 4 * 86_400_000);
check(`the next report starts with who waited (${S().players[left].name})`, r2?.memo?.playerIds?.[0] === left);
if (n1.includes(fa) || r2.memo.playerIds.includes(fa)) {
  const body = n1.includes(fa) ? r1.body : r2.body;
  check('a free agent: the asking price', new RegExp(`${S().players[fa].name}[^]*Asking`).test(body));
}

// a starred player who joins us
SM.mutate(s => { const p = s.players[reg1]; const from = s.leagueTeams.find(t => t.rosterIds.includes(reg1)); from.rosterIds = from.rosterIds.filter(x => x !== reg1); from.lineupSlots = from.lineupSlots.map(sl => sl.playerId === reg1 ? { ...sl, playerId: null } : sl); p.teamId = 'user'; s.userTeam.rosterIds.push(reg1); });
check('a starred player who joins us is no longer starred', !isStarred(S(), reg1) && !starredIds(S()).includes(reg1) && starredIds(S()).length === 3);

// nobody starred
SM.mutate(s => { s.starred = {}; });
const r3 = writeComposeReply(S(), { topicId: 'sc_starred', channelId: 'scouting', atMs: now + 9 * 86_400_000 });
check(`nobody starred: says so (“${r3?.body}”)`, /anyone starred/.test(r3?.body || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
