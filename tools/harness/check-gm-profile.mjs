/**
 * tools/harness/check-gm-profile.mjs — r219 §122.98 the GM's profile, felt and never shown.
 *   - how an answer leans it (money, players, trades and signings, the community, development, letting it lapse);
 *   - every answer recorded (a tap, a lapse); news isn't; the record kept in full — older seasons folded into totals,
 *     counting less each season back;
 *   - what it changes: which asks come (a spender gets more priced asks; a month held back, fewer), a delegating GM
 *     told the default, our players' contract asks (loyal lower, transactional higher; another club's unchanged),
 *     the reputation messages (only when it leans that far; their numbers real);
 *   - no message names the profile.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as GMP from '../../engine/GMProfile.js';
import { marketTerms } from '../../engine/OffseasonEngine.js';
import { PROFILE_POOL } from '../../data/cards-profile.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

seedRandom(91);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; s.currentGameIndex = 60; s.gmRecord = null; });
const card = (o) => ({ cardId: 'x', noLabel: 'No', yesLabel: 'Yes', autoResolve: 'no', yesEffect: {}, noEffect: {}, _raw: {}, ...o });

console.log('How an answer leans it');
{
  const L = GMP.decisionLean;
  check('paying for an ask: spender', L(card({ _budgetCost: 20 }), 'yes').spender === 1);
  check('turning one down: saver', L(card({ _budgetCost: 20 }), 'no').spender === -1);
  check('letting it lapse: the staff decide (and nothing else)', JSON.stringify(L(card({ _budgetCost: 20 }), 'auto')) === '{"handsOn":-0.2}');
  check('re-signing our own: loyal', L(card({ _raw: { onYes: 'os_resign' } }), 'yes').loyal === 1);
  check('letting them walk: transactional', L(card({ _raw: { onNo: 'os_walk' } }), 'no').loyal === -1);
  check('making a trade: bold (and a little transactional)', L(card({ _raw: { onYes: 'trade_execute' } }), 'yes').aggressive === 1 && L(card({ _raw: { onYes: 'trade_execute' } }), 'yes').loyal === -0.5);
  check('signing a free agent: bold', L(card({ _raw: { onYes: 'os_fa_sign' } }), 'yes').aggressive === 1);
  check('a development session: patient', L(card({ _raw: { onYes: 'offday_session' } }), 'yes').processDriven === 1);
  check('a community ask said yes to', L(card({ tag: 'MARKETING', yesEffect: { atmo: 3 } }), 'yes').communityFocused === 1);
  check('the money over the fans', L(card({ _revenueK: 100, noEffect: { atmo: 2 } }), 'yes').communityFocused === -1);
  check('news says nothing', Object.keys(L(card({ noLabel: null, _toastOnly: true }), 'yes')).length === 0);
}

console.log('\nEvery answer, recorded');
{
  const a = CE.deliverCardById('od1', buildCardContext());
  CE.resolve(a.instanceId, 'yes');
  const e = S().gmRecord.log.at(-1);
  check(`a tap (od1, yes: ${JSON.stringify(e?.d)}, $${e?.k}K)`, e?.id === 'od1' && e.c === 'yes' && e.d.handsOn === 0.2 && e.d.spender === 1 && e.d.loyal === 0.5 && e.k === a._budgetCost);
  const b = CE.deliverCardById('od4', buildCardContext());
  CE.expire(b.instanceId, clock.get());
  check('a lapse', S().gmRecord.log.at(-1).id === 'od4' && S().gmRecord.log.at(-1).c === 'auto');
  const n = S().gmRecord.log.length;
  const c = CE.deliverCardById('odn1', buildCardContext());
  CE.resolve(c.instanceId, 'yes');
  check('news: not a decision', S().gmRecord.log.length === n);
}

console.log('\nThe record, over seasons');
{
  SM.speculate(() => {
    SM.mutate(s => {
      s.gmRecord = { log: [], seasons: {} };
      for (let k = 0; k < 40; k++) GMP.recordDecision(s, { ...card({ _budgetCost: 10, cardId: `c${k}`, _season: 1 }) }, 'yes', k);
      s.seasonNum = 2;
    });
    const p2 = GMP.profile(SM.get()).spender;
    // Two seasons on, a season of everyday answers (nothing spent, nothing saved).
    SM.mutate(s => { s.seasonNum = 4; for (let k = 0; k < 100; k++) GMP.recordDecision(s, card({ cardId: `z${k}`, _season: 4 }), 'yes', 99 + k); });
    const p4 = GMP.profile(SM.get()).spender;
    const r = SM.get().gmRecord;
    check(`a spender after 40 paid asks (${p2})`, p2 >= 0.6);
    check(`two seasons on, still there but fading (${p4})`, p4 > 0.1 && p4 < p2);
    check('older seasons folded into their totals: the history kept', r.log.every(e => e.s >= 2) && r.seasons[1]?.n === 40 && r.seasons[1].k === 400 && r.seasons[1].ids.c0 === 1);
  });
}

console.log('\nWhat it changes');
{
  const priced = { id: 'q', _budgetCost: 'misc_cost_xs', tag: 'OPERATIONS', yesEffect: {} };
  const neutral = CE.profileWeightForChecks(priced, S());
  SM.speculate(() => {
    SM.mutate(s => { s.gmRecord = { log: [], seasons: {} }; for (let k = 0; k < 40; k++) GMP.recordDecision(s, card({ _budgetCost: 10, cardId: `c${k}` }), 'yes', k); });
    const spender = CE.profileWeightForChecks(priced, SM.get());
    check(`a spender gets more priced asks (×${neutral.toFixed(2)} → ×${spender.toFixed(2)})`, spender > neutral * 1.3);
    // The reputation message: only now.
    let elig = [];
    CE.cardDebug.onEligible = (m, ids) => { if (m === 'between') elig = elig.concat(ids); };
    CE.checkAndDeliver(buildCardContext());
    CE.cardDebug.onEligible = null;
    check('…and Finance\'s word on it comes into play', elig.includes('pf_spend'));
    const f = CE.deliverCardById('pf_spend', buildCardContext());
    const tot = GMP.seasonTotals(SM.get());
    check(`with the real numbers (${f.body.slice(0, 90)}…)`, tot.spentCount >= 40 && f.body.includes(`${tot.spentCount} of the smaller asks`) && f.body.includes(`$${tot.spentK}K`));
    CE.resolve(f.instanceId, 'yes');
    const held = CE.profileWeightForChecks(priced, SM.get());
    check(`hold back for a month: far fewer (×${held.toFixed(2)}), for 30 days`, held < spender * 0.4 && SM.get().userTeam.spendFreezeUntil - clock.get() === 30 * DAY);
  });
  let elig = [];
  CE.cardDebug.onEligible = (m, ids) => { if (m === 'between') elig = elig.concat(ids); };
  SM.speculate(() => { SM.mutate(s => { s.gmRecord = null; }); CE.checkAndDeliver(buildCardContext()); });
  CE.cardDebug.onEligible = null;
  check('a GM with no lean: no reputation messages', !elig.some(id => id.startsWith('pf_')));

  SM.speculate(() => {
    SM.mutate(s => { s.gmRecord = { log: [], seasons: {} }; for (let k = 0; k < 40; k++) GMP.recordDecision(s, card({ cardId: `a${k}` }), 'auto', k); });
    const c = CE.deliverCardById('od2', buildCardContext());
    check(`a GM who lets the staff decide is told the default (…${c.body.slice(-50)})`, c.body.endsWith('If I don\'t hear back, I\'ll go with “Everyone Rests.”'));
    const d = CE.deliverCardById('od4', buildCardContext());
    check('…a department in its own voice', d.body.endsWith('If we don\'t hear back, we\'ll go with “Give Them the Day.”'));
  });
  const plain = CE.deliverCardById('od2', buildCardContext());
  check('a hands-on GM isn\'t', !/hear back/.test(plain.body));

  const ourId = S().userTeam.rosterIds.find(id => !['SP', 'RP'].includes(S().players[id].pos));
  const theirs = S().leagueTeams[0].rosterIds[0];
  const ask = (pid) => marketTerms(S(), S().players[pid]).salary;
  const base = ask(ourId), baseThem = ask(theirs);
  const withRec = (lean) => SM.speculate(() => { SM.mutate(s => { s.gmRecord = { log: [], seasons: {} }; for (let k = 0; k < 40; k++) GMP.recordDecision(s, card({ cardId: `r${k}`, _raw: lean > 0 ? { onYes: 'os_resign' } : { onYes: 'os_walk' } }), 'yes', k); }); return [ask(ourId), ask(theirs), GMP.profile(SM.get()).loyal]; });
  const [loyalAsk, loyalThem, lv] = withRec(1), [transAsk, , tv] = withRec(-1);
  check(`our player's ask: loyal ${loyalAsk} < neutral ${base} < transactional ${transAsk} (loyal ${lv}, ${tv})`, loyalAsk < base && transAsk > base);
  check('another club\'s player: unchanged', loyalThem === baseThem);
}

console.log('\nNo message names the profile');
{
  const words = /\b(profile|reputation score|dimension|spender|transactional)\b/i;
  const bad = PROFILE_POOL.filter(c => words.test(`${c.subject} ${c.preview} ${c.body}`) || voiceProblems(c, (s) => (String(s).match(/^(\{\w+_name\})/) || [])[1] || null).length);
  check('in their own words', bad.length === 0, bad.map(c => c.id).join(', '));
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
