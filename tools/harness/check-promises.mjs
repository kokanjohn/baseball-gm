// r147 a decision whose words say something will happen later makes it happen.
//   node tools/harness/check-promises.mjs
// 1. The lint: every choice whose label or outcome talks about later has a
//    promise, a follow-up, an action, or a reason it doesn't need one.
// 2. Each promise, driven: it waits for its moment, lands, and does what it said.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { marketTerms } from '../../engine/OffseasonEngine.js';
import { newFreeAgentClass } from '../../engine/OffseasonEngine.js';
import { PROMISE_KINDS } from '../../engine/Promises.js';
import { DECISIONS_POOL, FOLLOWUP_POOL } from '../../data/cards-pool.js';
import { MOMENT_CARDS } from '../../data/cards-moments.js';
import { MONEY_BETWEEN, MONEY_PREGAME } from '../../data/cards-money.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const DAY = 86_400_000;

// ── 1. The lint ───────────────────────────────────────────────
console.log('Every "later" has something behind it');
const seen = new Set(), cards = [];
const walk = (v) => {
  if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') {
    if (v.id && v.yesLabel) { if (!seen.has(v.id)) { seen.add(v.id); cards.push(v); } }
    else Object.values(v).forEach(walk);
  }
};
walk([DECISIONS_POOL, FOLLOWUP_POOL, MONEY_BETWEEN, MONEY_PREGAME, MOMENT_CARDS]);
// Words that promise a consequence later (not "this week" or "the later innings").
const LATER = /\b(a month|next month|next (season|spring|winter|negotiation|time)|until (the )?(offseason|october|winter|spring)|will remember|remember (it|this)|hold (you|us) to|watching (closely|to see)|flagging this for later|revisit|come up again|try again|takes a few weeks|in the winter|promise|scouts will be watching)\b/i;
// Choices that say "later" in a way that needs nothing more, with why.
const ALLOW = {
  'mo_spo_starter_pitch_count:no': 'the pitcher is off form at once (ovr −1 dip on this card)',
  'f1:no': 'the card itself comes back (_requeueOnNo)',
  'o1_followup:no': 'it is the follow-up',
};
const hollow = [];
let promising = 0;
for (const c of cards.filter(c => !c._retired && c.noLabel !== undefined)) {
  for (const side of ['yes', 'no']) {
    const text = `${c[`${side}Label`] || ''} | ${c[`${side}Msg`] || ''}`;
    if (!LATER.test(text)) continue;
    promising++;
    const backed = c._promise?.[side] || (c._followup && (!c._followup.on || c._followup.on === side))
      || (side === 'yes' ? c.onYes : c.onNo) || (side === 'no' && c._requeueOnNo) || ALLOW[`${c.id}:${side}`];
    if (!backed) hollow.push(`${c.id} [${side}] "${text.slice(0, 90)}" (${text.match(LATER)[0]})`);
  }
}
check(`${promising} choices talk about later; every one has a promise, a follow-up, an action or a reason`, hollow.length === 0, hollow.join(' | '));
const kinds = new Set(cards.flatMap(c => Object.values(c._promise || {}).map(p => p.kind)));
check(`every promise kind on a card has a writer (${[...kinds].join(', ')})`, [...kinds].every(k => PROMISE_KINDS.includes(k) || k === 'agent_grudge' || k === 'redeal'));

// ── 2. Each promise, driven ───────────────────────────────────
seedRandom(9);
clock.set(clock.real());
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const S = () => SM.get(), U = () => SM.get().userTeam;
const t0 = clock.get();
const deal = (id) => CE.deliverCardById(id);
const answer = (inst, choice) => CE.resolve(inst.instanceId, choice);
const landed = (kind) => CE.getInbox().filter(c => c._promiseKind === kind);
const releaseAt = (ms) => { clock.set(ms); CE.releaseDueCards(ms); };

console.log('Ownership dinner (option C): the target moves');
let inst = deal('mo_take_owner_dinner');
const target0 = U()._ownerWinTarget;
console.log(`    “${inst.subject}” — ${inst.body}`);
check('the card says what the target is and what each answer does to it', inst.body.includes(`${target0} wins`) && inst.body.includes(String(target0 + 3)));
answer(inst, 'yes');
check(`"Tell ownership we're here to win" raises the win target ${target0} → ${U()._ownerWinTarget}`, U()._ownerWinTarget === target0 + 3);

console.log('A podium promise, judged at the season\'s end');
inst = deal('mo_take_presser');
answer(inst, 'yes');
check('the promise waits for the season\'s end', (S().promises || []).some(r => r.kind === 'presser_winner' && r.when === 'season_end'));
SM.mutate(s => { s.userTeam.wins = 70; s.userTeam.losses = 92; });
const atmo0 = U().atmosphere, trust0 = U().ownerTrust;
CE.keepPromises('season_end', t0 + DAY);
releaseAt(t0 + DAY + 3600_000);
let m = landed('presser_winner')[0];
console.log(`    “${m?.subject}” — ${m?.body}`);
check('a losing season: the fans remember it, and ownership noticed', !!m && /70–92/.test(m.body) && U().atmosphere < atmo0 && U().ownerTrust < trust0);
check('it is gone from the waiting list', !(S().promises || []).some(r => r.kind === 'presser_winner'));

console.log('A starting role promised, checked two weeks on');
inst = deal('sp12');
const who = inst._tokenPlayers?.active_hitter;
answer(inst, 'yes');
SM.mutate(s => { s.userTeam.lineupSlots = s.userTeam.lineupSlots.map(sl => sl.playerId === who ? { ...sl, playerId: s.userTeam.rosterIds.find(x => !['SP', 'RP'].includes(s.players[x].pos) && !s.userTeam.lineupSlots.some(z => z.playerId === x)) } : sl); });
const mor0 = U().morale;
releaseAt(t0 + 16 * DAY);
m = landed('starter_role')[0];
console.log(`    “${m?.subject}” — ${m?.body}`);
check(`benched instead: the room noticed (morale ${mor0} → ${U().morale})`, !!m && /isn't in the lineup/.test(m.body) && U().morale < mor0 && !GEN.test(m.body));

console.log('An agent turned down remembers');
inst = deal('mon_bonus_ask');
const hitter = inst._tokenPlayers?.active_hitter;
const ask0 = marketTerms(S(), S().players[hitter]).salary;
answer(inst, 'no');
const ask1 = marketTerms(S(), S().players[hitter]).salary;
check(`the next ask from ${S().players[hitter]?.name}'s agent is about 10% higher (${ask0}K → ${ask1}K)`, S().players[hitter]?._agentGrudge && ask1 > ask0 && ask1 <= Math.ceil(ask0 * 1.1 / 5) * 5 + 5);

console.log('Work put off comes back in the winter, costing more');
inst = deal('bg7');
const cost = inst._budgetCost;
answer(inst, 'no');
CE.keepPromises('winter', t0 + 20 * DAY, t0 + 30 * DAY);
releaseAt(t0 + 20 * DAY + 3600_000);
m = landed('deferred_work')[0];
console.log(`    “${m?.subject}” — ${m?.body} [${m?.yesLabel} / ${m?.noLabel}]`);
const want = Math.round(cost * 1.25 / 5) * 5;
check(`a decision: do the work for ${want}K (was ${cost}K) or put it off again`, !!m && m.noLabel && m._budgetCost === want && m.expiresAtMs === t0 + 30 * DAY);
const funds0 = U().finances.funds ?? U().finances.cash;
answer(m, 'yes');
const funds1 = U().finances.funds ?? U().finances.cash;
check('doing it charges the new price', Math.round(funds0 - funds1) === want, `${funds0} → ${funds1}`);

console.log('An insurance claim pays out weeks later');
inst = CE.getInbox().length && deal('rv2_clubhouse_issue');
if (inst) {
  const f0 = U().finances.funds ?? U().finances.cash;
  answer(inst, 'yes');
  releaseAt(t0 + 45 * DAY);
  m = landed('insurance')[0];
  check(`three weeks on, the money comes back (${m?.body?.match(/\$\d+K/)?.[0]})`, !!m && (U().finances.funds ?? U().finances.cash) > f0 - (inst._budgetCost || 0) + 1);
}

console.log('The boosters come back next spring');
inst = deal('fr1');
answer(inst, 'no');
check('waiting for next spring', (S().promises || []).some(r => r.redeal === 'fr1'));
SM.mutate(s => { s.seasonNum = (s.seasonNum || 1) + 1; });
CE.keepPromises('spring', t0 + 50 * DAY);
releaseAt(t0 + 50 * DAY + 3600_000);
check('spring: the booster club\'s card is back', CE.getInbox().some(c => c.cardId === 'fr1' && !c.resolved && (c.arrivedAtMs || 0) >= t0 + 50 * DAY));
SM.mutate(s => { s.seasonNum -= 1; });

console.log('A player the scouts saw at the college game, in the winter class');
inst = deal('rv3');
answer(inst, 'yes');
SM.mutate(s => { newFreeAgentClass(s, t0 + 60 * DAY); });
CE.keepPromises('fa_opens', t0 + 60 * DAY);
releaseAt(t0 + 60 * DAY + 3600_000);
m = landed('college_look')[0];
const pid = m?._playerIds?.[0] || Object.values(S().players).find(p => p._scoutedAt === t0 + 60 * DAY)?.id;
console.log(`    “${m?.subject}” — ${m?.body}`);
check('the scouting director names a real rookie in the class, marked as scouted', !!m && !!pid && S().players[pid]?._classOf === (S().seasonNum || 1) + 1 && Number.isFinite(S().players[pid]?._scoutedAt));

console.log('A catcher kept playing: the workload catches up, or the luck holds');
inst = deal('hr1');
const catcher = inst._tokenPlayers?.active_hitter;
answer(inst, 'no');
releaseAt(clock.get() + 7 * DAY);
const hurt = S().players[catcher]?.isInjured;
const act2 = [...CE.getInbox(), ...(S().scheduledCards || [])].some(c => c.cardId === 'injury_act2' && c._targetPlayerId === catcher);
check(`six days on, ${S().players[catcher]?.name} ${hurt ? 'is hurt, with the diagnosis card' : 'held up (it does 40% of the time)'}`, hurt ? act2 : true);
check('either way, nothing is left scheduled for it', !(S().scheduledCards || []).some(c => c._promiseRec?.kind === 'worn_down'));

console.log('Riding the good feeling at camp: the manager judges the first three weeks');
inst = deal('mo_camp_win_hangover');
answer(inst, 'no');
SM.mutate(s => {   // three weeks of results after the answer: a losing start
  let n = 0;
  for (const g of s.schedule) if (g.gameTime > clock.get() && g.gameTime < clock.get() + 20 * DAY && n < 12) { g.result = n % 3 === 0 ? 'win' : 'loss'; n++; }
});
const mc0 = U().managerConfidence ?? U().manConf;
releaseAt(clock.get() + 22 * DAY);
m = landed('hangover')[0];
console.log(`    “${m?.subject}” — ${m?.body}`);
check('a losing start: the manager says so', !!m && /risk/.test(m.body));

console.log('The rest land with what they said');
for (const [id, choice, kind, at] of [['ls1', 'no', 'tired_regular', 70], ['ig_suite_complaint', 'no', 'suite_sponsor', null], ['mon_post_bonus', 'yes', 'staff_remembers', null], ['mon_profit_empire', 'no', 'discipline', null]]) {
  const c = deal(id);
  if (!c) { check(`${id} dealt`, false); continue; }
  answer(c, choice);
  if (at) releaseAt(clock.get() + 8 * DAY);
}
const tEnd = clock.get() + DAY;
CE.keepPromises('winter', tEnd);
CE.keepPromises('season_end', tEnd);
SM.mutate(s => { s.seasonNum = (s.seasonNum || 1) + 1; });
CE.keepPromises('spring', tEnd);
releaseAt(tEnd + DAY);
for (const k of ['tired_regular', 'suite_sponsor', 'staff_remembers', 'discipline']) {
  const c = landed(k)[0];
  check(`${k}: “${c?.subject}”`, !!c && !GEN.test(c.body), c?.body);
}
check('nothing is left waiting', !(S().promises || []).length, JSON.stringify((S().promises || []).map(r => r.kind)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
