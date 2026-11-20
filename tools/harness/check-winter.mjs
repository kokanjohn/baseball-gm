/**
 * tools/harness/check-winter.mjs — r218 §122.97 the winter, a day at a time.
 *   - nothing while we're still playing; from the day after our last game, a moment each day at midday;
 *   - while the postseason goes on without us: its own messages (and a real series result); after it: the winter's;
 *   - a quiet day gets one most of the time; a day with two decisions already gets nothing more;
 *   - each card at most its limit a winter; the champion named when it isn't us; a decision waits three days;
 *   - every winter message reads right with real tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as W from '../../engine/WinterStory.js';
import { WINTER_POOL } from '../../data/cards-winter.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000, HOUR = 3_600_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const hr = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || (Object.values(S().userTeam.coachingStaff).some(x => x?.name === s) || s === S().userTeam.ownerName ? s : null);
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview} ${c.yesMsg || ''} ${c.noMsg || ''}`)
  && !/\{[a-z0-9_]+\}|undefined|NaN/.test(`${c.subject} ${c.preview} ${c.body} ${c.yesMsg || ''} ${c.noMsg || ''}`);
const say = (c) => console.log(`    ${new Date(c.deliverAtMs ?? c.arrivedAtMs).toString().slice(0, 21)}  ${senderLabel(c, S())} — ${c.subject}`);

seedRandom(71);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const T = (name) => S().leagueTeams.find(t => t.name === name) || S().leagueTeams[0];
const [a, b, c2, d] = S().leagueTeams;
const ser = (id, round, A, B, winner, wA, wB) => ({ id, round, status: 'final', teamA: A, teamB: B, winner, winsA: wA, winsB: wB, games: [] });
const me = { id: 'user', name: S().userTeam.name };
// Our season: every regular-season game played; we lost the wild-card game; another series is done.
SM.mutate(s => {
  s.phase = PHASE.FIRST_ROUND;
  for (const g of s.schedule) if (!g.isSpring) g._committed = true;
  s.playoffBracket = {
    divA: { WILD_CARD: { series: [ser('divA_WILD_CARD_0', 'WILD_CARD', { id: a.id, name: a.name }, me, 'A', 1, 0)] },
            FIRST_ROUND: { series: [ser('divA_FIRST_ROUND_1', 'FIRST_ROUND', { id: b.id, name: b.name }, { id: c2.id, name: c2.name }, 'B', 1, 3)] }, DIVISION_SERIES: { series: [] } },
    divB: { WILD_CARD: { series: [] }, FIRST_ROUND: { series: [] }, DIVISION_SERIES: { series: [] } },
    WORLD_SERIES: { series: [] }, round: 'FIRST_ROUND', champion: null,
  };
  s.inbox = []; s.scheduledCards = [];
});
const lastGame = Math.max(...S().schedule.filter(g => !g.isSpring).map(g => g.gameTime));
const day1 = new Date(lastGame + DAY); day1.setHours(0, 0, 0, 0);

console.log('The days after our last game');
{
  SM.speculate(() => { SM.mutate(s => { s.phase = PHASE.WILD_CARD; s.playoffBracket.divA.WILD_CARD.series[0].status = 'active'; }); check('nothing while we are still alive', W.winterDays(SM.get(), lastGame + 5 * DAY).length === 0); });
  check('out of it: our season is over', W.ourSeasonOver(S()));
  const days = W.winterDays(S(), day1.getTime() + 4 * DAY + 23 * HOUR);
  check(`a moment each day from the day after our last game (${days.length} in five days)`, days.length === 5 && new Date(days[0].atMs).getDate() === day1.getDate());
  check('each at midday (12:00–15:30)', days.every(x => hr(x.atMs) >= 12 && hr(x.atMs) <= 15.5));
  check(`a real series result (${W.seriesLine(S())})`, W.seriesLine(S()) === `The ${c2.name} beat the ${b.name} in the first round, 3–1.`);
}

/** Run the winter's moments from `fromMs` through `days` days; returns the cards parked. */
const run = (fromMs, days) => {
  const got = [];
  for (let k = 0; k < days; k++) {
    const end = fromMs + (k + 1) * DAY - 1;
    for (let guard = 0; guard < 5; guard++) {
      const m = W.nextStepAt(S(), end);
      if (!m) break;
      clock.set(m.atMs);
      got.push(...CE.deliverWinterStep(m.atMs, buildCardContext()));
    }
  }
  return got;
};

console.log('\nWhile the postseason goes on without us');
let out = [];
{
  out = run(day1.getTime(), 12);
  out.forEach(say);
  const ids = out.map(c => c.cardId);
  const defs = Object.fromEntries(WINTER_POOL.map(x => [x.id, x]));
  check(`most quiet days get one (${out.length} in 12)`, out.length >= 9);
  check('only messages for this stretch (out, or any)', ids.every(id => ['out', 'any'].includes(defs[id]._winter)));
  check('none past its limit', Object.entries(ids.reduce((m, id) => ({ ...m, [id]: (m[id] || 0) + 1 }), {})).every(([id, n]) => n <= (defs[id]._winterMax || 1)));
  const dec = out.find(c => !c._raw?._toastOnly);
  check('a decision waits three days', !!dec && dec.expiresAtMs - dec.deliverAtMs === 3 * DAY);
  const sl = out.find(c => c.cardId === 'wtn_series');
  check('the series result, when it came, is the real one', !sl || sl.body.startsWith(`The ${c2.name} beat`));
}

console.log('\nA busy day');
{
  const t = day1.getTime() + 12 * DAY;
  SM.speculate(() => {
    SM.mutate(s => { for (let i = 0; i < 2; i++) s.scheduledCards.push({ instanceId: `busy${i}`, cardId: `busy${i}`, noLabel: 'No', deliverAtMs: t + 9 * HOUR, _rosterKey: `busy${i}` }); });
    const m = W.nextStepAt(SM.get(), t + DAY - 1);
    clock.set(m.atMs);
    check('two decisions due already: nothing more', CE.deliverWinterStep(m.atMs, buildCardContext()).length === 0 && SM.get().winter.done[m.key]);
  });
}

console.log('\nAfter the postseason');
{
  SM.mutate(s => { s.phase = PHASE.OFFSEASON; s.playoffBracket.champion = { id: d.id, name: d.name }; s.winter.done = { ...s.winter.done }; });
  const got = run(day1.getTime() + 12 * DAY, 10);
  got.forEach(say);
  const defs = Object.fromEntries(WINTER_POOL.map(x => [x.id, x]));
  check(`the winter's messages (${got.length} in 10 days)`, got.length >= 7 && got.every(c => ['winter', 'any'].includes(defs[c.cardId]._winter)));
  const used = S().winter.used;
  check('a message used up while we were out isn\'t sent again', Object.entries(used).every(([id, n]) => n <= (defs[id]._winterMax || 1)));
}

console.log('\nEvery winter message, with real tokens');
{
  const bad = [];
  for (const def of WINTER_POOL) {
    const filled = Object.fromEntries(Object.entries(def).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('{champion_name}', d.name).replaceAll('{series_line}', W.seriesLine(S())) : v]));
    const c = CE.deliverCardById(def.id, buildCardContext());
    const view = c ? { ...c, subject: filled.subject && c.subject.replaceAll('{champion_name}', d.name), body: c.body.replaceAll('{champion_name}', d.name).replaceAll('{series_line}', W.seriesLine(S())), preview: c.preview.replaceAll('{series_line}', W.seriesLine(S())) } : null;
    if (!view && !/\{(champion_name|series_line)\}/.test(def.body + def.subject + def.preview)) bad.push(`${def.id}: not made`);
    else if (view && !readsRight(view)) bad.push(`${def.id}: ${view.subject} / ${view.body}`);
  }
  check(`all ${WINTER_POOL.length} read right`, bad.length === 0, bad.join('\n      '));
  // The champion's news, as delivered.
  SM.speculate(() => {
    SM.mutate(s => { s.winter.used = Object.fromEntries(WINTER_POOL.filter(x => x.id !== 'wtn_champ').map(x => [x.id, 9])); s.inbox = []; s.scheduledCards = []; });
    let champ = null;
    for (let k = 0; k < 6 && !champ; k++) champ = run(day1.getTime() + (22 + k) * DAY, 1).find(c => c.cardId === 'wtn_champ');
    check(`the champion named (${champ?.subject})`, !!champ && champ.subject === `The ${d.name} won it all` && readsRight(champ));
  });
  SM.speculate(() => {
    SM.mutate(s => { s.playoffBracket.champion = { id: 'user', name: me.name }; });
    check('no "they won it all" when we won it', !WINTER_POOL.filter(x => x._needsChampion).some(x => W.pickCard({ ...SM.get(), winter: { season: SM.get().seasonNum, used: Object.fromEntries(WINTER_POOL.filter(y => !y._needsChampion).map(y => [y.id, 9])) } }, day1.getTime() + 30 * DAY + 13 * HOUR, WINTER_POOL)?.id === x.id));
  });
}

console.log('\nSpring');
{
  SM.mutate(s => { s.phase = PHASE.SPRING_TRAINING; });
  check('nothing once spring starts', W.nextStepAt(S(), day1.getTime() + 40 * DAY) == null);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
