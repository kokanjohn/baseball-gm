/**
 * tools/harness/check-memory.mjs
 * DEV/TEST ONLY — r298 §122.185 Memory (the design: §122.184).
 *
 *   - The cast: each save's own names, drawn the same every time, the club's city in them; each club's GM a party.
 *   - The tagged messages: each names a party in the cast, how its answers weigh, words for its moments (neutral).
 *   - Entry stamps the party: from the message, from a club's GM (`_gmTeamId`), from a trade offer.
 *   - The standing: a yes to a request warms, a no cools, left to its deadline cools more, an offer turned down is
 *     no slight; slights fade over about two seasons, good turns over about three; a big moment never fades and its
 *     note is kept always; the staff's answers (Important only) don't count.
 *   - Felt: a version may read the standing or call back to a moment; a warm party offers a favor, a sour one pulls
 *     back, naming itself and the moment; clubs wait for the rivals release; a party isn't heard from that way again
 *     within a month.
 *   - Never shown: no screen reads the memory.
 *   - Played: the tagged messages arrive with their party.
 *
 *   node tools/harness/check-memory.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { castOf, partyName, partyTags, standingOf, memoryOf, recordOf, STANDINGS } from '../../engine/Memory.js';
import { PARTIES, PARTY_ASK, MEMORY } from '../../data/parties.js';
import { ALL_POOLS } from '../../engine/cards/Pools.js';
import { AROUND_POOL } from '../../data/cards-around.js';
import { aroundCandidates } from '../../engine/AroundGame.js';
import { compose, holds } from '../../engine/MessageParts.js';
import { noteOf } from '../../engine/MessageHistory.js';
import { liveUntil } from './drive.mjs';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(298);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'Port Ellis', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const now = () => clock.get();

// ── The cast ──
const cast = castOf(S());
check(`the cast: every party named (${Object.keys(cast).length})`, PARTIES.every(p => cast[p.id]?.name && !/\{/.test(cast[p.id].name)));
check('…the club\'s city in the names that take it', PARTIES.filter(p => p.names.every(n => n.includes('{city}'))).every(p => cast[p.id].name.includes('Port Ellis')));
check('…drawn the same every time', JSON.stringify(castOf(S())) === JSON.stringify(cast));
const club = S().leagueTeams.find(t => t.id !== S().userTeam.id);
check('…each club\'s GM a party', partyName(S(), `club:${club.id}`) === `the ${club.name}`);

// ── The tagged messages ──
const allDefs = [...Object.values(ALL_POOLS).flat().map(e => e?.card || e).filter(Boolean)];
const away = readFileSync('data/cards-away.js', 'utf8');
const tagged = allDefs.filter(d => d.party);
const GENDERED = /\b(he|him|his|she|her|guys?|man|men)\b/i;
const bad = [];
for (const d of [...tagged, ...AROUND_POOL.filter(d => d.partyMoment)]) {
  if (d.party && !cast[d.party]) bad.push(`${d.id}: party '${d.party}' isn't in the cast`);
  if (d.partyAsk && !PARTY_ASK[d.partyAsk]) bad.push(`${d.id}: ask '${d.partyAsk}'`);
  if (d.partyW && !['yes', 'no', 'ignored'].every(k => Number.isFinite(d.partyW[k]))) bad.push(`${d.id}: weights`);
  if (d.partyBig != null && ![true, 'yes', 'no'].includes(d.partyBig)) bad.push(`${d.id}: big '${d.partyBig}'`);
  for (const m of Object.values(d.partyMoment || {})) if (GENDERED.test(m) || /[{}]/.test(m)) bad.push(`${d.id}: moment '${m}'`);
}
const followups = (away.match(/party: '\w+'/g) || []).length;
check(`the existing messages tagged: ${tagged.length} drawn and ${followups} follow-ups, each in the cast, weighed and worded`, tagged.length >= 25 && followups >= 3 && bad.length === 0, bad.slice(0, 4).join('; '));

// ── Entry stamps the party ──
const t1 = partyTags({ _raw: { party: 'bank', partyAsk: 'offer', partyMoment: { yes: 'x' } } });
const t2 = partyTags({ _gmTeamId: club.id, _raw: {} });
const t3 = partyTags({ _proposingTeamId: club.id, _raw: {} });
check('Entry stamps the party: from the message, a club\'s GM, a trade offer', t1?._party === 'bank' && t1._partyW.no === 0 && t2?._party === `club:${club.id}` && t2._partyW.no === -1 && t3?._party === `club:${club.id}` && t3._partyW.no === 0 && partyTags({ _raw: {} }) === null);

// ── The standing ──
let k = 0;
const note = (party, choice, daysAgo, extra = {}) => noteOf({ instanceId: `m${k++}`, cardId: 'test', resolved: true, choice, arrivedAtMs: now() - daysAgo * DAY, resolvedAtMs: now() - daysAgo * DAY, _season: 1,
  ...partyTags({ _raw: { party, partyAsk: extra.ask || 'request', ...(extra.big != null ? { partyBig: extra.big } : {}), partyMoment: extra.moment || { yes: 'the good day', no: 'the bad day' } } }), ...(extra.c || {}) });
// (each call replaces the test notes of the parties it names; others stay)
const withNotes = (notes) => { const ps = new Set(notes.map(n => n._party)); SM.mutate(s => { s.messageHistory = [...(s.messageHistory || []).filter(n => !(n.cardId === 'test' && ps.has(n._party))), ...notes]; }); };
const clearNotes = () => SM.mutate(s => { s.messageHistory = (s.messageHistory || []).filter(n => n.cardId !== 'test'); });
const st = (p, at = now()) => standingOf(S(), p, at);
withNotes([note('bank', 'yes', 5), note('bank', 'yes', 10)]);
check('two yeses to a party\'s requests: warm', st('bank').standing === 'warm', JSON.stringify(st('bank')));
withNotes([note('charity', 'no', 5)]);
check('a no to a request: cool', st('charity').standing === 'cool');
withNotes([note('charity', 'no', 5), note('charity', 'auto', 5), note('charity', 'expired', 6)]);
check('left to its deadline, twice: sour', st('charity').standing === 'sour', JSON.stringify(st('charity')));
withNotes([note('brewery', 'no', 5, { ask: 'offer' }), note('brewery', 'no', 9, { ask: 'offer' })]);
check('an offer turned down is no slight: neutral', st('brewery').standing === 'neutral');
withNotes([note('paper', 'no', 365), note('paper', 'no', 365)]);
const half = st('paper').score;
withNotes([note('paper', 'no', 750), note('paper', 'no', 750)]);
check(`slights fade over about two seasons (a year on, two count ${half}; past two years, ${st('paper').score})`, Math.abs(half + 1) < 0.05 && st('paper').score === 0);
withNotes([note('radio', 'yes', 730), note('radio', 'yes', 730), note('radio', 'yes', 730)]);
const goodAt2 = st('radio').score;
withNotes([note('radio', 'yes', 1100), note('radio', 'yes', 1100), note('radio', 'yes', 1100)]);
check(`good turns over about three (two years on, three count ${goodAt2}; past three, ${st('radio').score})`, goodAt2 > 0.9 && goodAt2 < 1.1 && st('radio').score === 0);
withNotes([note('schools', 'yes', 2000, { big: true, moment: { yes: 'the state championship' } }), note('schools', 'yes', 2000, { big: true, moment: { yes: 'the state championship' } })]);
check('a big moment never fades (five years on, still warm, recalled)', st('schools').standing === 'warm' && st('schools').moment === 'the state championship');
const big = note('city', 'no', 1, { big: 'no' }), notBig = note('city', 'yes', 1, { big: 'no' });
check('…its note kept always (a public refusal: the no, not the yes)', big._keep === true && !notBig._keep);
withNotes([note('neighbors', 'no', 3, { c: { _staffHandled: true, autoChoice: 'no' } }), note('neighbors', 'no', 4, { c: { _staffHandle: true } })]);
check('the staff\'s answers in Important only don\'t count', recordOf(S(), 'neighbors', now()).length === 0 && st('neighbors').standing === 'neutral');
check('a cool party recalls the slight; a warm one the good turn', st('charity').moment === 'the bad day' && st('bank').moment === 'the good day');

// ── Felt ──
const def = { id: 'mem_test', from: 'dept:test', party: 'bank', parts: { open: ['Plain open.', { text: 'A warm open about {party_moment}.', when: { standing: 'warm', recall: true } }, { text: 'A sour open.', when: { standing: ['sour', 'cool'] } }] }, subject: 'S', body: '{@open}', yesLabel: 'Y', noLabel: 'N' };
const warmOut = compose(def, S(), now());
const sourOut = compose({ ...def, party: 'charity' }, S(), now());
const plainOut = compose({ ...def, party: 'university' }, S(), now());
check('a version reads the standing and calls back (warm, sour, neutral)', /A warm open/.test(warmOut.body) && /A sour open/.test(sourOut.body) && /Plain open/.test(plainOut.body), `${warmOut.body} | ${sourOut.body} | ${plainOut.body}`);
check('…holds reads standing as one or a list, recall, and the kind', holds({ standing: ['warm', 'cool'], partyKind: 'sponsor' }, memoryOf(S(), 'bank', now())) && !holds({ recall: true }, memoryOf(S(), 'university', now())));

// a warm party offers a favor; a sour one pulls back: the strongest felt first
const pick = (draft) => aroundCandidates(S(), {}, now()).find(c => c.kind === 'memory');
const c1 = pick();
check(`the most strongly felt party is heard from: a sour one pulls back (${c1?.id}, ${c1?.party}, its cost ${c1?.facts.values.mend_cost}, recalling "${c1?.facts.values.party_moment}")`,
  c1?.id === 'mem_cold_community' && c1.party === 'charity' && c1.facts.amountsK.mend_cost >= 5 && c1.facts.values.party_moment === 'the bad day' && c1.facts.values.party_name === cast.charity.name);
SM.mutate(s => { s.around = { season: s.seasonNum || 1, done: { 'mem:charity': now() - 5 * DAY, memory: now() - 5 * DAY }, n: {} }; });
const c2 = pick();
check(`…a warm one offers a favor (${c2?.id}, ${c2?.party}, recalling "${c2?.facts.values.party_moment}"); the sour one not again within a month`,
  c2?.id === 'mem_favor_community' && c2.party === 'schools' && c2.facts.values.party_moment === 'the state championship');
SM.mutate(s => { s.around = { season: s.seasonNum || 1, done: { 'mem:charity': now() - 5 * DAY, 'mem:schools': now() - 5 * DAY }, n: {} }; });
const c3 = pick();
check(`…a sponsor's favor comes with its money (${c3?.id}, ${c3?.facts.values.favor_amt})`, c3?.id === 'mem_favor_sponsor' && c3.party === 'bank' && c3.facts.amountsK.favor_amt >= 15);
withNotes([note(`club:${club.id}`, 'no', 2), note(`club:${club.id}`, 'auto', 2), note(`club:${club.id}`, 'auto', 3)]);
SM.mutate(s => { s.around = { season: s.seasonNum || 1, done: { 'mem:charity': now(), 'mem:bank': now(), 'mem:schools': now() }, n: {} }; });
check('…clubs wait for the rivals release', !pick() || !pick().party.startsWith('club:'));
// the composed favor, end to end: a whole message naming the party, every fact filled
const { _createInstance } = await import('../../engine/cards/Selection.js');
SM.mutate(s => { s.around = null; });
const cw = aroundCandidates(S(), {}, now()).find(c => c.kind === 'memory');
const inst = _createInstance({ ...AROUND_POOL.find(d => d.id === cw.id), party: cw.party }, { _facts: cw.facts }, S());
check(`…the message whole: "${inst?.subject}"`, inst && inst.body.includes(cw.facts.values.party_name.replace(/^the /, '')) && !/\{[a-z_]+\}/.test(`${inst.subject} ${inst.body} ${inst.preview}`));
clearNotes();

// ── Never shown ──
const ui = [...readdirSync('ui').filter(f => f.endsWith('.js')).map(f => `ui/${f}`), ...readdirSync('ui/components').filter(f => f.endsWith('.js')).map(f => `ui/components/${f}`), ...(readdirSync('ui').includes('screens') ? readdirSync('ui/screens').filter(f => f.endsWith('.js')).map(f => `ui/screens/${f}`) : [])];
const reads = ui.filter(f => /Memory\.js|standingOf|memoryOf|_partyW/.test(readFileSync(f, 'utf8')));
check(`never shown: no screen reads the memory (${ui.length} files)`, reads.length === 0, reads.join(', '));

// ── Played: the tagged messages come with their party ──
const answered = new Set();
const gm = () => { for (const c of CE.getInbox()) { if (answered.has(c.instanceId)) continue; answered.add(c.instanceId); try { CE.resolve(c.instanceId, Math.random() < 0.6 ? 'yes' : 'no', c.choices?.length ? { pick: c.choices[0].key } : {}); } catch { /* */ } } };
const reg = S().schedule.filter(g => !g.isSpring);
await liveUntil(reg[40].gameTime + 6 * 3_600_000, { onStep: gm });
const msgs = [...S().inbox, ...(S().messageHistory || [])];
const taggedIds = new Set(tagged.map(d => d.id));
const arrivedTagged = msgs.filter(c => taggedIds.has(c.cardId));
const gmMsgs = msgs.filter(c => c._gmTeamId || c._proposingTeamId);
check(`played: the tagged messages arrive with their party (${arrivedTagged.length}), and a club's GM's with the club (${gmMsgs.length})`,
  arrivedTagged.length > 0 && arrivedTagged.every(c => c._party === tagged.find(d => d.id === c.cardId).party && c._partyW)
  && gmMsgs.every(c => c._party === `club:${c._gmTeamId || c._proposingTeamId}`));
const parties = new Set(msgs.map(c => c._party).filter(Boolean));
check(`…a record builds (${parties.size} parties: ${[...parties].map(p => `${p.startsWith('club:') ? 'club' : p} ${standingOf(S(), p, now()).standing}`).slice(0, 8).join(', ')})`, parties.size >= 2 && [...parties].every(p => STANDINGS.includes(standingOf(S(), p, now()).standing)));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
