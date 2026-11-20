/**
 * tools/harness/check-deadline-story.mjs — r215 §122.94 the trade deadline as a story.
 *   - the moments: 14/10/7/5/4/3/2 games out, deadline day, the morning after; staff hours; in order; the clock's next;
 *   - buying: the owner's direction, the market (ahead of it), a regular asking, the manager's need, the shortlist (an
 *     offer ready to make, fitting the need), a rival GM, the owner's payroll room; deadline day; the morning after
 *     (the clubhouse, the owner's verdict, the new player's hello, the goodbye, the paper's grade — a broken promise
 *     in all of it);
 *   - selling: ahead of it, a buyer calls for one of our veterans; the owner wants salary moved; standing pat: no
 *     shortlist, no rival, no money;
 *   - every message in its sender's voice, gender-neutral, no raw tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { storyMoments, nextStepAt, deadlineOf } from '../../engine/DeadlineStory.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const say = (c) => console.log(`    ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}${c._choices ? `\n      [${c._choices.map(x => x.label).join(' / ')} / ${c.noLabel}]` : c.noLabel ? `\n      [${c.yesLabel} / ${c.noLabel}]` : `\n      [${c.yesLabel}]`}`);
const voiceOk = (c) => voiceProblems(c, (s) => (String(s).match(/^(.+?) \(/) || [])[1] || (Object.values(S().userTeam.coachingStaff).some(x => x?.name === s) || s === S().userTeam.ownerName ? s : null))
  .filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(`${c.body} ${c.preview}`) && !/\{[a-z_]+\}/.test(`${c.subject} ${c.body}`);

seedRandom(41);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
// Mid-season: the regular season under way, a few clubs buying and a few selling.
SM.mutate(s => {
  s.phase = PHASE.REGULAR_SEASON;
  s.userTeam.wins = 44; s.userTeam.losses = 34;
  s.leagueTeams.forEach((t, i) => { t.wins = [55, 52, 50, 40, 38, 30, 28, 45, 41][i % 9]; t.losses = 78 - t.wins; });
});

console.log('The moments');
const M = storyMoments(S());
{
  for (const m of M) console.log(`    ${m.key.padEnd(9)} ${new Date(m.atMs).toString().slice(0, 21)}`);
  const dl = deadlineOf(S());
  check(`nine moments, in order, from two weeks out to the morning after (${M.map(m => m.key).join(', ')})`,
        M.length === 9 && M[0].key === 'owner' && M[M.length - 1].key === 'after' && M.find(m => m.key === 'final').atMs < dl.gameTime && M.find(m => m.key === 'after').atMs > dl.endsAt);
  check('each in staff hours (9am–1pm)', M.every(m => { const h = new Date(m.atMs).getHours(); return h >= 9 && h < 13; }));
  check('the clock\'s next: the owner first, at its moment', nextStepAt(S(), M[0].atMs)?.key === 'owner' && nextStepAt(S(), M[0].atMs - 60_000) == null);
}

const step = (key) => {
  const m = M.find(x => x.key === key);
  clock.set(m.atMs);
  const got = CE.deliverDeadlineStep(m.atMs, buildCardContext());
  return got.map(c => CE.getInbox().find(x => x.instanceId === c.instanceId) || c);
};
const all = [];
const take = (cs) => { all.push(...cs); cs.forEach(say); return cs; };

console.log('\nBuying');
let snap;
{
  const [o] = take(step('owner'));
  check('the owner: buy, sell, or stand pat (no answer: stand pat)', o?._choices?.map(x => x.key).join() === 'buy,sell' && o.noLabel === 'We Stand Pat' && o._raw.onNo === 'dl_hold');
  CE.resolve(o.instanceId, 'yes', { pick: 'buy' });
  check('…buying', S().deadline.stance === 'buy');
  snap = structuredClone(S());
  const [mk] = take(step('market'));
  check('the market: sellers and buyers counted, the best rentals named, a cost to get ahead of it', /\d club(s)? selling, \d buying/.test(mk.body) && mk._budgetCost > 0);
  CE.resolve(mk.instanceId, 'yes');
  const [pl] = take(step('player'));
  check('a regular on an expiring deal asks', !!pl && !!pl._targetPlayerId);
  CE.resolve(pl.instanceId, 'no');
  check('…told they\'re staying (remembered)', S().deadline.reassured === pl._targetPlayerId);
  const [mg] = take(step('manager'));
  check('the manager: a bat or an arm (the softer spot first), or nothing', mg?._choices?.length === 2 && mg.noLabel === 'This Group Is Enough');
  CE.resolve(mg.instanceId, 'yes', { pick: 'arm' });
  const [sl] = take(step('shortlist'));
  const sp = sl && S().players[sl._ideaOffer?.incomingIds?.[0]];
  check(`the shortlist: an arm, an offer ready to make (${sp?.name}, OVR ${sp?.ovr})`, !!sl && ['SP', 'RP'].includes(sp?.pos) && sl._raw.onYes === 'lt_offer_send' && sl._reviseOffer);
  const [rv] = take(step('rival'));
  const r0 = rv ? S().userTeam.gmRelationships?.[rv._dlTeamId] ?? 50 : null;
  check('a rival GM is after the same player', !!rv && rv.body.includes(sp.name) && /, .+ GM$/.test(senderLabel(rv, S())));
  CE.resolve(rv.instanceId, 'yes');
  check(`…backing off: our standing with them +5 (${r0} → ${S().userTeam.gmRelationships?.[rv._dlTeamId]})`, (S().userTeam.gmRelationships?.[rv._dlTeamId] ?? 50) - r0 === 5);
  const p0 = S().userTeam.finances.payrollTarget;
  const [mo] = take(step('money'));
  CE.resolve(mo.instanceId, 'yes');
  check(`the owner's payroll room: taken (${p0} → ${S().userTeam.finances.payrollTarget})`, S().userTeam.finances.payrollTarget === p0 + mo._dlMoneyK);
  const [fi] = take(step('final'));
  check('deadline day: news, the clock', !!fi && !fi.noLabel && /deadline is today/.test(fi.body));
  // We traded: the reassured regular out, the arm in.
  const m0 = M.find(x => x.key === 'owner').atMs;
  SM.mutate(s => { s.transactions = [...(s.transactions || []),
    { reason: 'trade', teamId: 'user', fromTeamId: s.leagueTeams[6].id, playerId: sp.id, createdAt: m0 + 3 * 86_400_000 },
    { reason: 'trade', teamId: s.leagueTeams[6].id, fromTeamId: 'user', playerId: pl._targetPlayerId, createdAt: m0 + 3 * 86_400_000 }]; });
  const t0 = S().userTeam.ownerTrust ?? null;
  const after = take(step('after'));
  const by = (k) => after.find(c => c._deadlineStory === `after:${k}`);
  check(`the morning after: ${after.map(c => c._deadlineStory.split(':')[1]).join(', ')}`, ['room', 'owner', 'hello', 'goodbye', 'grade'].every(k => by(k)));
  check('…the broken promise is in it (the clubhouse, the goodbye)', /told .+ they were staying/.test(by('room').body) && /I was told I was staying/.test(by('goodbye').body));
  check('…the owner: you said buying, and you did', /You said we were buying, and you did/.test(by('owner').body) && by('owner').yesEffect.ownerTrust === 2);
  check('…the paper: a B+', /a B\+/.test(by('grade').subject));
  check('…spread out, not all at once', new Set(after.map(c => c.deliverAtMs)).size === after.length);
}

console.log('\nSelling');
{
  SM.speculate(() => {
    SM.adopt(structuredClone(snap));
    SM.mutate(s => { s.deadline = { ...s.deadline, stance: 'sell', ahead: true }; });
    const before = new Set((S().inbox || []).map(c => c.instanceId));
    const m = M.find(x => x.key === 'shortlist');
    clock.set(m.atMs);
    CE.deliverDeadlineStep(m.atMs, buildCardContext());
    clock.set(m.atMs + 3 * 3_600_000); CE.releaseDueCards(clock.get());
    const call = CE.getInbox().find(c => !before.has(c.instanceId) && c._tradeOffer);
    if (call) say(call);
    check('ahead of it, selling: a buyer calls for one of our veterans', !!call);
    const [mo] = take(step('money'));
    check('the owner wants salary moved', !!mo && /payroll lighter/.test(mo.body));
  });
}

console.log('\nStanding pat');
{
  SM.speculate(() => {
    SM.adopt(structuredClone(snap));
    SM.mutate(s => { s.deadline = { ...s.deadline, stance: 'hold', ahead: true }; });
    const got = ['shortlist', 'rival', 'money'].flatMap(k => step(k));
    check('no shortlist, no rival, no money', got.length === 0);
  });
}

check(`every message in its sender's voice, gender-neutral, no raw tokens (${all.length})`, all.every(voiceOk), all.filter(c => !voiceOk(c)).map(c => `${c._deadlineStory}: ${JSON.stringify(voiceProblems(c, () => null))}`).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
