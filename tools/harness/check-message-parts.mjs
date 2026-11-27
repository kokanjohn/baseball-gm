/**
 * tools/harness/check-message-parts.mjs
 * DEV/TEST ONLY — r294 §122.177 (foundation step 6): messages written in parts (engine/MessageParts.js; §122.176).
 *
 *   - Every message in the pools comes through untouched (so the record matches).
 *   - The rules: a sample message in parts is right; broken ones are named (an unknown condition, a part that isn't
 *     one, a core part with fewer than 3 versions, no `from`, a staff job that doesn't exist); one that can't be put
 *     together isn't delivered.
 *   - Sent again and again, answered: put together into an ordinary message (no {@part} left), carrying whose history
 *     it is; the first time reads as a first; after a no, as after a no; after a run of yeses, as mostly yes; after
 *     one left to its deadline, as ignored; every fitting version used before any repeats, in shuffled rounds (each
 *     round its own order, never twice in a row, the whole message never the same twice, no two reading alike); the
 *     same state chooses
 *     the same; one that lapsed unseen doesn't count as used.
 *   - The history: a staff member's is every message from them (by person: someone new starts afresh); a note keeps
 *     the history as its message did.
 *
 *   node tools/harness/check-message-parts.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { _createInstance } from '../../engine/cards/Selection.js';
import { toInbox, VIA } from '../../engine/cards/Entry.js';
import { ALL_POOLS } from '../../engine/cards/Pools.js';
import { compose, partsProblems, historyWith, isParts, wordRuns, alike, READ_ALIKE } from '../../engine/MessageParts.js';
import { trimAnswered } from '../../engine/MessageHistory.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

// ── Every message in the pools, untouched ──
const defs = Object.values(ALL_POOLS).flat().map(e => e?.card || e).filter(d => d?.id);
const touched = defs.filter(d => compose(d, {}, 0) !== d || isParts(d));
check(`every message in the pools comes through untouched (${defs.length})`, touched.length === 0, touched.slice(0, 5).map(d => d.id).join(', '));

// ── The sample: the Visitors Bureau and the summer fair ──
const FAIR = {
  id: 'test_vb_fair', from: 'city:visitors_bureau', sender: 'Visitors Bureau', tag: 'COMMUNITY', avatar: '🎡', type: 'normal',
  autoResolve: 'no', _ttl: 3,
  parts: {
    open: [
      { text: 'We haven\'t worked together before, so a quick hello first.', when: { first: true } },
      { text: 'We know the last ask didn\'t work out for you.', when: { last: 'no' } },
      { text: 'You\'ve been good to us, so we\'re coming to you first.', when: { mostly: 'yes' } },
      { text: 'We didn\'t hear back last time, so we\'ll keep this short.', when: { last: 'ignored' } },
      'Hope the homestand is treating you well.',
      'Thanks for taking a minute.',
      'A quick one from the Bureau.',
    ],
    ask: ['Could the county fair use the north lot for its weekend?', 'The fair is short on parking. Could it borrow the north lot?', 'Would you share the north lot with the fair for one weekend?'],
    stakes: ['It would cost a game day\'s parking.', 'You\'d give up a weekend of lot fees.', 'The lot fees for one weekend go with it.'],
    close: ['Let us know.', 'Either way, thanks.', 'We\'ll take your answer to the board.'],
  },
  subject: ['The fair needs a lot', 'Parking for the county fair', 'A weekend for the fair'],
  preview: '{@ask}',
  body: '{@open} {@ask} {@stakes} {@close}',
  yesLabel: ['Share the lot', 'Lend it'], noLabel: ['Not this time', 'We need it'],
  yesMsg: ['The Bureau thanks you.', 'The fair gets its lot.', 'The board will hear about this.'],
  noMsg: ['The Bureau understands.', 'They\'ll look elsewhere.', 'Noted, with some disappointment.'],
};
check('the sample message in parts has nothing wrong', partsProblems(FAIR).length === 0, partsProblems(FAIR).join('; '));
const broken = {
  ...FAIR, from: 'staff:shortstop',
  parts: { ...FAIR.parts, ask: FAIR.parts.ask.slice(0, 2), stakes: [...FAIR.parts.stakes.slice(0, 2), { text: 'x', when: { moodiness: 3 } }] },
  body: '{@open} {@asks} {@close}',
};
const probs = partsProblems(broken).join(' | ');
check(`…broken ones are named: an unknown condition, a part that isn't one, too few versions, a staff job that doesn't exist`,
  /unknown condition 'moodiness'/.test(probs) && /\{@asks\} isn't a part/.test(probs) && /parts\.ask: 2 versions/.test(probs) && /names no staff job/.test(probs), probs);
check('…and a message with no `from` is named', partsProblems({ ...FAIR, from: undefined }).some(p => /no `from`/.test(p)));

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(294);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
check('…one that can\'t be put together isn\'t delivered', compose({ ...FAIR, body: '{@nope}' }, S(), clock.get()) === null && _createInstance({ ...FAIR, body: '{@nope}' }, {}, S()) === null);

// ── Sent again and again ──
const sent = [];
function send(via = VIA.DEBUG) {
  clock.set(clock.get() + DAY);
  const inst = _createInstance(FAIR, {}, S());
  if (!inst) return null;
  SM.mutate(s => { toInbox(s, [inst], () => clock.get(), via); });
  const c = S().inbox.find(x => x.instanceId === inst.instanceId);
  sent.push(c);
  return c;
}
const answer = (c, choice) => CE.resolve(c.instanceId, choice);
const openOf = (c) => FAIR.parts.open.map(v => (typeof v === 'string' ? v : v.text)).find(t => c.body.startsWith(t));

const c1 = send();
check(`put together into an ordinary message: “${c1.subject}”, no part left, whose history it is (${c1._from})`,
  !!c1 && !/\{@/.test(JSON.stringify(c1)) && c1._from === 'city:visitors_bureau' && c1.cardId === FAIR.id && typeof c1.body === 'string' && c1.yesLabel && c1.noLabel && Object.keys(c1._parts).length > 5);
check(`…the first time reads as a first (“${openOf(c1)}”)`, openOf(c1) === FAIR.parts.open[0].text);
answer(c1, 'no');
const c2 = send();
check(`after a no, it reads as after a no (“${openOf(c2)}”)`, openOf(c2) === FAIR.parts.open[1].text);
answer(c2, 'yes');
const c3 = send(); answer(c3, 'yes');
const c4 = send(); answer(c4, 'yes');
const c5 = send();
check(`after a run of yeses, as mostly yes (“${openOf(c5)}”; ${JSON.stringify(historyWith(S(), FAIR.from, clock.get()))})`, openOf(c5) === FAIR.parts.open[2].text);
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === c5.instanceId); c.resolved = true; c.choice = 'auto'; c.resolvedAtMs = clock.get(); });
const c6 = send();
check(`after one left to its deadline, as ignored (“${openOf(c6)}”)`, openOf(c6) === FAIR.parts.open[3].text);
answer(c6, 'yes');

// every fitting version before any repeats: the ask (three, none with a condition), over nine more sends
const asks = [];
for (let i = 0; i < 9; i++) { const c = send(); asks.push(c._parts['@ask']); answer(c, i % 2 ? 'yes' : 'no'); }
const allAsks = [c1, c2, c3, c4, c5, c6].map(c => c._parts['@ask']).concat(asks);
// the round rule, piece by piece: a version comes back only once every version has had its turn — except on a send
// where that piece was bent to keep the message from reading alike an earlier one (_partsRelaxed), which is counted
const roundBroken = (field, n) => {
  let seen = new Set(); const bad = [];
  sent.forEach((c, i) => {
    const v = c._parts[field];
    if (c._partsRelaxed === field) { seen.add(v); return; }
    if (seen.size >= n) seen = new Set();
    if (seen.has(v)) bad.push(i + 1);
    seen.add(v);
  });
  return bad;
};
const PIECES = { '@ask': 3, '@stakes': 3, '@close': 3, subject: 3 };
const roundsBroken = Object.entries(PIECES).flatMap(([f, n]) => roundBroken(f, n).map(i => `${f} at send ${i}`));
const bent = sent.filter(c => c._partsRelaxed);
check(`every fitting version used before any repeats (the ask, by send: ${allAsks.join('')}; the subject: ${sent.map(c => c._parts.subject).join('')}), but for a piece bent to keep it from reading alike (${bent.length} of ${sent.length} sends: ${bent.map(c => c._partsRelaxed).join(', ') || 'none'})`,
  roundsBroken.length === 0 && bent.length <= Math.ceil(sent.length / 5), roundsBroken.join(', '));
const rounds = [0, 3, 6, 9, 12].map(i => allAsks.slice(i, i + 3)).filter(r => r.length === 3);
const orders = rounds.map(r => r.join(''));
check(`…in shuffled rounds: each round its own order (${orders.join(' ')})`, new Set(orders).size > 1);
const twice = ['@open', '@ask', '@stakes', '@close', 'subject'].filter(f => sent.some((c, i) => i && c._parts[f] === sent[i - 1]._parts[f] && sent[i - 1]._parts[f] !== undefined
  && !(f === '@open')));   // (the opener follows the history: after a run of the same answer it may stay)
check(`…never the same version twice in a row (ask, stakes, close, subject)`, twice.length === 0, twice.join(', '));
const whole = sent.map(c => [c.subject, c.body, c.yesLabel, c.noLabel, c.yesMsg, c.noMsg].join('|'));
check(`…and the whole message never the same twice (${new Set(whole).size} different in ${whole.length} sends)`, new Set(whole).size === whole.length);
// r295 §122.178 the repeat flag: no two sends of a season read alike (the per-save memory keeps them apart)
const R = sent.map(c => wordRuns(`${c.subject} ${c.body}`));
let worst = 0, alikePairs = 0;
for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const x = alike(R[i], R[j]); worst = Math.max(worst, x); if (x >= READ_ALIKE) alikePairs++; }
check(`…and no two sends of the season read alike (${alikePairs} of ${R.length * (R.length - 1) / 2} pairs at ${Math.round(READ_ALIKE * 100)}% or more; the most alike ${Math.round(worst * 100)}%)`, alikePairs === 0);
const usedN = S().partsUsed[FAIR.id].n;
const a = compose(FAIR, S(), clock.get()), b = compose(FAIR, S(), clock.get());
check('the same state chooses the same', JSON.stringify(a) === JSON.stringify(b));
send(VIA.EXPIRED);
check(`one that lapsed unseen doesn't count as used (${usedN} sends counted, then ${S().partsUsed[FAIR.id].n})`, S().partsUsed[FAIR.id].n === usedN);

// ── The history ──
await liveUntil(S().schedule.find(g => !g.isSpring).gameTime - DAY);
const mgr = S().userTeam.coachingStaff.manager;
const mine = [...S().inbox, ...(S().messageHistory || [])].filter(c => c._senderId === mgr.id);
const hm = historyWith(S(), 'staff:manager', clock.get());
check(`a staff member's history is every message from them (${mgr.name}: ${hm.times} of ${mine.length} through spring)`, hm.times === mine.length && hm.times > 0);
const swapped = structuredClone(S());
swapped.userTeam.coachingStaff.manager = { ...mgr, id: 'new-manager', name: 'Someone New' };
check('…someone new in the job starts afresh', historyWith(swapped, 'staff:manager', clock.get()).times === 0);
const before = historyWith(S(), FAIR.from, clock.get());
const trimmed = structuredClone(S());
trimAnswered(trimmed, { keepAnswered: 0, seasons: 3 });
const after = historyWith(trimmed, FAIR.from, clock.get());
check(`a note keeps the history as its message did (${JSON.stringify(before)})`, JSON.stringify(before) === JSON.stringify(after) && trimmed.messageHistory.some(n => n._from === FAIR.from));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
