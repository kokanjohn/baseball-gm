// §122.51 (phase 3b) The weather's decisions at home do what they say — checks, in a real league.
//   node tools/harness/check-weather-decisions.mjs
//   1. Call it off: postponed at that moment, made up, the crew says so.
//   2. Wait it out and lose it late: the crew's overtime and the crowd's goodwill.
//   3. Batting practice: in the cages the field never takes more work than on the field.
//   4. A held start, decided: going ahead in light rain, or extra hands — the game is played again from the
//      new plan, sooner; the crew's word still to come is redone (nothing told twice).
//   5. Left unanswered in a held start: it times out on the game's clock, the default and its cost.
//   6. The owner: three poor calls in a month.
//   7. A season of our home games: decisions only at home, never in spring.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame, advanceClock, weatherGameOf, weatherStoryOf } from '../../engine/GameEngine.js';
import * as CardEngine from '../../engine/CardEngine.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { gameWeatherPlan, fieldKey } from '../../engine/GameWeather.js';
import { GAME_STATUS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const HOUR = 3_600_000, MIN = 60_000;
const ledger = (label) => (SM.get().userTeam.finances?.ledger || []).filter(e => e.label === label);
const crewFor = (T) => [...(SM.get().inbox || []), ...(SM.get().scheduledCards || [])].filter(c => c.tag === 'WEATHER' && String(c._rosterKey || '').includes(`:${T}:`));
/** Make the game at `idx` our next one (the ones before it set aside: no weather, no result). */
function skipTo(idx) {
  SM.mutate(s => {
    for (let i = s.currentGameIndex; i < idx; i++) { const g = s.schedule[i]; g._committed = true; g.cancelled = true; g.result = 'postponed'; g.status = GAME_STATUS.POSTPONED; }
    s.currentGameIndex = idx;
  });
}
async function league(region, seed) {
  for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId ?? sl.id);   // (one club at a time)
  seedRandom(seed);
  clock.set(Date.UTC(2400, 0, 1));
  await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers', abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region });
}
const homeRegular = () => SM.get().schedule.map((g, i) => ({ g, i })).filter(({ g }) => g.isHome && !g.isSpring && !g.isPlayoff && !g._committed && !g.cancelled);

await league('east', 31);

console.log('Call it off');
{
  const { g, i } = homeRegular()[2];
  const T = g.gameTime;   // (the game object moves with the makeup)
  skipTo(i);
  clock.set(T - 3 * HOUR);
  advanceClock(clock.get());
  const card = CardEngine.deliverWeatherDecision({ key: `wx:dec:1:${T}:calloff`, kind: 'calloff', gameTime: T, subject: 'Call off today\'s game?', body: 'x',
                                                   yesLabel: 'Call It Off', noLabel: 'Wait It Out', expiresAtMs: clock.get() + 45 * MIN, chance: 80 }, clock.get());
  CardEngine.releaseDueCards(clock.get());
  CardEngine.resolve(card.instanceId, 'yes');
  advanceClock(clock.get() + 60_000);
  const x = SM.get().schedule.find(y => (y.postponements || []).some(p => p.gameTime === T));
  const p = x?.postponements?.find(q => q.gameTime === T);
  check(`postponed at the moment of the call (${p?.calledBy}), made up ${x?.date}`, p?.calledBy === 'gm' && Math.abs(p.decidedAt - (clock.get() - 60_000)) <= 60_000 && !x.cancelled && x.gameTime > T);
  check('the crew says so', crewFor(T).some(c => c._rosterKey.endsWith(':ppd')));
  check('a call with an 80% forecast isn\'t a poor one', !(SM.get().userTeam.wxCalls || []).some(c => c.kind === 'calloff' && c.poor));
}

console.log('\nWait it out, and lose it late');
{
  const { g: g0, i } = homeRegular()[0];
  const g = { gameTime: g0.gameTime };   // (the game object moves with the makeup)
  skipTo(i);
  // (the day caught up first: a question it brings — batting practice — would plan the game again over the hand-made plan)
  clock.set(g.gameTime - 35 * MIN); advanceClock(clock.get()); tick();
  const atmo0 = SM.get().userTeam.atmosphere ?? 50, ot0 = ledger('Grounds crew overtime').length;
  // (its weather by hand: the start held, then called off 90 minutes past first pitch)
  SM.mutate(s => { const x = s.schedule[i]; x.wxWaited = { atMs: x.gameTime - 3 * HOUR, chance: 90, auto: false };
    x.wx = { v: 1, venueId: 'user', gameTime: x.gameTime, playMin: 180, fieldKey: fieldKey(weatherGameOf(s, x).field || null), /* (no planKey: taken as given) */ outcome: 'postponed', decidedAt: x.gameTime + 90 * MIN, calledBy: 'limit', reason: 'rain', startAt: null, tarps: [], delays: [], endT: null, stopAtPlayMin: null }; });
  for (let t = g.gameTime - 30 * MIN; t <= g.gameTime + 100 * MIN; t += 5 * MIN) { clock.set(t); advanceClock(t); tick(); }
  const x = SM.get().schedule.find(y => (y.postponements || []).some(p => p.gameTime === g.gameTime));
  check(`postponed late (${x ? 'yes' : 'no'}): overtime charged, the crowd's goodwill down (${atmo0} → ${SM.get().userTeam.atmosphere})`,
        !!x && ledger('Grounds crew overtime').length === ot0 + 1 && (SM.get().userTeam.atmosphere ?? 50) < atmo0);
  check('waiting out a 90% forecast and losing it late is a poor call', (SM.get().userTeam.wxCalls || []).some(c => c.kind === 'calloff' && c.choice === 'no' && c.poor));
}

console.log('\nBatting practice');
{
  const st = SM.get(), ctx = weatherContext(st);
  let n = 0, later = 0, worse = 0, softer = 0;
  for (const { g } of homeRegular()) {
    const vg = weatherGameOf(st, g);
    const cg = gameWeatherPlan(ctx, { ...vg, bp: 'cages' }), fg = gameWeatherPlan(ctx, { ...vg, bp: 'field' });
    if (!(cg.tarps?.length || fg.tarps?.length || cg.startAt !== g.gameTime)) continue;
    n++;
    const s1 = cg.startAt ?? Infinity, s2 = fg.startAt ?? Infinity;
    if (s2 < s1) worse++;
    if (s2 > s1) later++;
    const mm = (p) => (p.tarps || []).reduce((a, t) => a + t.mm, 0) + (p.delays || []).filter(d => d.atPlayMin === 0).reduce((a, d) => a + d.mm, 0);
    if (mm(fg) > mm(cg)) softer++;
  }
  check(`in the cages the field is never slower to be ready than on the field (${n} wet game days; on the field: ${later} started later, ${softer} more work)`, worse === 0 && n > 3);
}

console.log('\nA held start, decided');
let found = null;
for (const [region, seed] of [['south', 41], ['east', 42], ['south', 43], ['north', 44], ['east', 45], ['south', 46]]) {
  await league(region, seed);
  for (const { g, i } of homeRegular()) {
    const ev = weatherStoryOf(g);
    const gap = ev.find(e => e.kind === 'gap'), trouble = ev.find(e => e.kind === 'crew_trouble' && !e.inGame && e.estStart != null && e.at >= g.gameTime);
    if (gap || trouble) { found = { region, i, g, kind: gap ? 'rain' : 'hands', at: (gap || trouble).at }; break; }
  }
  if (found) break;
}
check(`a held start with a decision in it (${found ? `${found.region}, ${found.kind}` : 'none found'})`, !!found);
if (found) {
  const { i, kind } = found, g = { gameTime: found.g.gameTime };
  skipTo(i);
  const key = `wx:dec:${SM.get().seasonNum || 1}:${g.gameTime}:${kind}`;
  const asked = () => (SM.get().inbox || []).find(c => c._rosterKey === key && !c.resolved);
  let before = null;
  for (let t = g.gameTime - 6 * HOUR; t <= g.gameTime + 4 * HOUR && !asked(); t += 5 * MIN) {
    clock.set(t); advanceClock(t); tick(); CardEngine.releaseDueCards(t);
    if (before == null && asked() == null) before = SM.get().schedule[i]?.wx?.startAt ?? before;
  }
  const card = asked();
  before = SM.get().schedule[i]?.wx?.startAt ?? gameWeatherPlan(weatherContext(SM.get()), weatherGameOf(SM.get(), SM.get().schedule[i])).startAt;
  check(`the question arrives at its moment (${kind}: “${card?.subject}”)`, !!card);
  if (card) {
    const atMs = clock.get();
    CardEngine.resolve(card.instanceId, 'yes');
    for (let t = atMs; t <= atMs + 4 * HOUR && !SM.get().schedule[i]?.plays?.some(p => !p._wx?.pre && p.type !== 'weather_delay' && p.type !== 'weather_resume' && p._timestamp <= t); t += 5 * MIN) { clock.set(t); advanceClock(t); tick(); }
    const g2 = SM.get().schedule[i];
    const firstReal = (g2.plays || []).find(p => !p._wx?.pre && p.type !== 'weather_delay' && p.type !== 'weather_resume');
    // (r205 the plan may have had no first pitch at all — the rain would have washed it out: then any start counts)
    check(`the game goes from the new plan: first pitch ${before == null ? 'none' : new Date(before).toISOString().slice(11, 16)} → ${new Date(g2.wx?.startAt).toISOString().slice(11, 16)} (never before the call)`,
          (before == null || g2.wx?.startAt < before) && g2.wx.startAt >= atMs + 5 * MIN && firstReal?._timestamp >= g2.wx.startAt);
    const crew = crewFor(g.gameTime), keys = crew.map(c => c._rosterKey);
    check(`the crew's word follows the new plan: nothing told twice (${crew.length} messages)`, new Set(keys).size === keys.length);
    if (kind === 'hands') check('extra hands are paid for', ledger('Extra grounds crew').length > 0);
  }
}

console.log('\nLeft unanswered in a held start');
{
  const atmo0 = SM.get().userTeam.atmosphere ?? 50;
  const st = SM.get(), g = st.schedule[st.currentGameIndex];
  const T = g.gameTime, now = clock.get();
  const card = CardEngine.deliverWeatherDecision({ key: `wx:dec:1:${T}:comps-check`, kind: 'comps', gameTime: T, subject: 'A long wait for the crowd', body: 'x',
                                                   yesLabel: 'Feed the Crowd ($9K)', noLabel: 'No', expiresAtMs: now + 20 * MIN, costK: 9 }, now);
  CardEngine.releaseDueCards(now);
  clock.set(now + 21 * MIN); tick();
  const c = SM.get().inbox.find(x => x.instanceId === card?.instanceId);
  if (process.env.DBG) console.log('DBG comps', { T, cur: SM.get().currentGameIndex, gt: SM.get().schedule[SM.get().currentGameIndex]?.gameTime, now, clk: clock.get(), card: !!card, c: c && { resolved: c.resolved, choice: c.choice, exp: c.expiresAtMs }, sched: (SM.get().scheduledCards || []).some(x => x.instanceId === card?.instanceId) });
  check(`it times out on the game's clock: the default (no giveaway), and the crowd's goodwill down twice (${atmo0} → ${SM.get().userTeam.atmosphere})`,
        c?.resolved && c.choice === 'auto' && (SM.get().userTeam.atmosphere ?? 50) === Math.max(0, atmo0 - 2));
  check('…and it counts as a poor call', (SM.get().userTeam.wxCalls || []).some(x => x.kind === 'comps' && x.choice === 'auto' && x.poor));
}

console.log('\nThe crowd during a delay (§122.56)');
{
  const st = SM.get(), T = st.schedule[st.currentGameIndex].gameTime, now = clock.get();
  const u = () => SM.get().userTeam;
  const funds = () => u().finances?.funds ?? 0;
  const ask = (kind, extra = {}) => {
    const c = CardEngine.deliverWeatherDecision({ key: `wx:dec:1:${T}:${kind}-crowd`, kind, gameTime: T, subject: kind, body: 'x', yesLabel: 'Yes', noLabel: 'No', expiresAtMs: now + 20 * MIN, ...extra }, now);
    CardEngine.releaseDueCards(now);
    return c;
  };
  // The crowd: three answers on one card.
  const c1 = ask('comps', { costK: 9, revenueK: 4, choices: [{ key: 'free', label: 'Free Food and Drink ($9K)' }, { key: 'sell', label: 'Keep the Stands Open' }] });
  const card1 = SM.get().inbox.find(c => c.instanceId === c1.instanceId);
  const f0 = funds(), a0 = u().atmosphere;
  CardEngine.resolve(c1.instanceId, 'yes', { pick: 'sell' });
  check(`the crowd: one card, three answers (${card1._choices.map(c => c.label).join(' / ')} / ${card1.noLabel}); "keep the stands open" brings in the sales`,
        card1._choices.length === 2 && !!card1.noLabel && Math.round(funds() - f0) === 4 && u().atmosphere === a0);
  // An upset season-ticket holder.
  const c2 = ask('sth', { costK: 2 });
  const f1 = funds(), a1 = u().atmosphere;
  CardEngine.resolve(c2.instanceId, 'yes');
  check('a season-ticket holder\'s credit: paid, the goodwill kept', Math.round(f1 - funds()) === 2 && u().atmosphere === a1 + 1);
  const c3 = ask('sth', { key: `wx:dec:1:${T}:sth-check2`, costK: 2 });
  const a2 = u().atmosphere;
  CardEngine.resolve(c3.instanceId, 'no');
  check('…declined: the goodwill drops', u().atmosphere === a2 - 2);
  // Rain checks after a game called official early.
  const c4 = ask('raincheck', { costK: 40 });
  const f2 = funds(), a3 = u().atmosphere;
  CardEngine.resolve(c4.instanceId, 'yes');
  check('rain checks honored: the gate given back, the crowd pleased', Math.round(f2 - funds()) === 40 && u().atmosphere === a3 + 2);
  // The TV booth.
  const c5 = ask('booth', { revenueK: 2 });
  const f3 = funds(), m0 = u().morale ?? 50;
  CardEngine.resolve(c5.instanceId, 'yes');
  check('the TV booth: the sponsor pays, the clubhouse grumbles', Math.round(funds() - f3) === 2 && (u().morale ?? 50) === m0 - 1);
  // The players and the crowd: the manager asks the GM's blessing.
  const c6 = ask('antics');
  const card6 = SM.get().inbox.find(c => c.instanceId === c6.instanceId);
  const a4 = u().atmosphere;
  CardEngine.resolve(c6.instanceId, 'yes');
  check(`the players and the crowd: asked by the manager (${card6.sender}), the crowd loves it`, card6.sender !== 'Head Groundskeeper' && u().atmosphere === a4 + 2);
  // Poor calls make season-ticket holders complain more.
  check(`poor weather calls in the last two weeks raise the season-ticket complaints (${CardEngine.recentPoorCalls(SM.get(), clock.get())} counted)`, CardEngine.recentPoorCalls(SM.get(), clock.get()) >= 1);
  // "Drag the infield?" never comes in a weather hold.
  SM.mutate(s => { s.scheduledCards = [...(s.scheduledCards || []), { instanceId: 'ig-test', cardId: 'ig_grounds_crew', deliverAtMs: T + 90 * MIN, subject: 'x' }]; });
  CardEngine.withdrawNoWeatherHold(T);
  check('"drag the infield?" is withdrawn from a game the weather holds up', !(SM.get().scheduledCards || []).some(c => c.instanceId === 'ig-test'));
}

console.log('\nRetired cards (§122.56)');
{
  const retired = ['pg_lineup_tip', 'pg_bullpen_check', 'pg_weather_prep', 'r6', 'hr1', 'hr3', 'hr4', 'b3', 'r3', 'r5'];
  // (the pools' selection never deals a retired card — CardEngine._filterEligible; deliverCardById is the debug injector)
  const Pools = await import('../../data/cards-pool.js');
  const defs = Object.values(Pools).flatMap(v => (Array.isArray(v) ? v : [])).map(e => e?.card || e).filter(d => d && retired.includes(d.id));
  const live = retired.filter(id => !defs.some(d => d.id === id && d._retired));
  check(`the manager's calls, the random weather and the random rest cards are retired (${defs.length} of ${retired.length})`, live.length === 0 && defs.length === retired.length, live.join(','));
}

console.log('\nThe owner');
{
  const trust0 = SM.get().userTeam.ownerTrust ?? 60;
  const n0 = (SM.get().inbox || []).filter(c => c.tag === 'OWNER' && /weather calls/.test(c.subject || '')).length;
  for (let k = 0; k < 3; k++) CardEngine.noteWeatherCall({ kind: 'hands', choice: 'auto', poor: true }, clock.get() + k * 3 * 86_400_000);
  CardEngine.releaseDueCards(clock.get() + 10 * 86_400_000);
  const owner = (SM.get().inbox || []).filter(c => c.tag === 'OWNER' && /weather calls/.test(c.subject || ''));
  check(`three poor calls in a month: the owner says so, and trusts us less (${trust0} → ${SM.get().userTeam.ownerTrust}): “${owner.at(-1)?.body?.slice(0, 90)}…”`,
        owner.length >= n0 + 1 && (SM.get().userTeam.ownerTrust ?? 60) < trust0);
}

console.log('\nOnly at home, never in spring');
{
  await league('south', 47);
  const st = SM.get();
  let springDec = 0, awayDec = 0, homeDec = 0, homeGames = 0;
  for (const g of st.schedule.slice(0, 120)) {
    const ev = weatherStoryOf(g);
    // §122.58 on the road the traveling party tells the host club's word — never a question for the GM.
    if (!g.isHome) { if (ev.some(e => e.kind === 'calloff_ask' || e.kind === 'gap') || weatherGameOf(st, g).gmCalls) awayDec++; continue; }
    homeGames++;
    const vg = weatherGameOf(st, g);
    if (g.isSpring && (vg.gmCalls || ev.some(e => e.kind === 'calloff_ask'))) springDec++;
    if (!g.isSpring && ev.some(e => e.kind === 'calloff_ask' || e.kind === 'gap')) homeDec++;
  }
  check(`no call-off question in spring (${springDec}) or on the road (${awayDec}); ${homeDec} of ${homeGames} home games had a call-off or light-rain question`, springDec === 0 && awayDec === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
