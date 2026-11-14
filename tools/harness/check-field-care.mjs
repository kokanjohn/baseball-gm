// r170 the field at our ballpark: the groundskeeper's extra crew for a wet home game, and the drainage.
//   - the numbers: drainage (0–3) and a game's prep move GameWeather's thresholds
//   - a season of our home games in the real weather, planned four ways: fewer postponements, shorter
//     delays and a firmer infield with drainage; shorter delays with the crew
//   - the groundskeeper's message before a wet home game (on the clock), and Compose → "Get the field
//     ready": yes books the crew, charges it, and the game's weather is planned with it
//   - the mid-season drainage pitch after a wet stretch, done over a road trip; the winter offer
//   node tools/harness/check-field-care.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { gameWeatherPlan, fieldParams, gameRecord, gameConditions, PLAN_OUTCOME } from '../../engine/GameWeather.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { gameTeams } from '../../engine/WeatherSchedule.js';
import * as FC from '../../engine/FieldCare.js';
import { facilityOffer, applyFacility } from '../../engine/FrontOffice.js';
import { liveUntil } from './drive.mjs';
import { voiceProblems } from './voice-rules.mjs';
import { FIELD_CARE, GAME_WEATHER as GW } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000, H = 3_600_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

// ── The numbers ─────────────────────────────────────────────────
console.log('The field\'s numbers');
const f0 = fieldParams(null), f3 = fieldParams({ drainage: 3 }), fp = fieldParams({ drainage: 0, prep: true });
check(`no field: the league's numbers (soggy ${f0.soggyIn} in, washout ${f0.washoutIn} in, crew ${f0.prepMin}+${f0.prepPerMm}/mm)`, f0.soggyIn === GW.SOGGY_IN && f0.washoutIn === GW.WASHOUT_IN && f0.prepMin === GW.PREP_MIN);
check(`drainage 3: soggy ${f3.soggyIn} in, washout ${f3.washoutIn} in, steady rain ${f3.soakMin} min, crew ${f3.prepPerMm.toFixed(2)}/mm`, f3.soggyIn > f0.soggyIn && f3.washoutIn > f0.washoutIn && f3.soakMin > f0.soakMin && f3.prepPerMm < f0.prepPerMm && f3.softIn > f0.softIn);
check(`the crew: a wet field ready in ${fp.soggyWorkMin} min (not ${f0.soggyWorkMin}), back on the field in ${fp.prepMin}+ min (not ${f0.prepMin}+)`, fp.soggyWorkMin < f0.soggyWorkMin && fp.prepMin < f0.prepMin && fp.prepMax < f0.prepMax);
check(`the price by the forecast: 40% ${FC.prepCostK(40)}K, 70% ${FC.prepCostK(70)}K, 95% ${FC.prepCostK(95)}K, 95% and wet ${FC.prepCostK(95, 1)}K`,
      FC.prepCostK(40) === FIELD_CARE.prep.costMinK && FC.prepCostK(70) > FC.prepCostK(40) && FC.prepCostK(95, 1) <= FIELD_CARE.prep.costMaxK);

// ── A club ──────────────────────────────────────────────────────
seedRandom(170);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), U = () => S().userTeam;

// ── A season of home games, four ways ───────────────────────────
console.log('Our home games in this season\'s weather, planned four ways');
const ctx = weatherContext(S());
const homes = S().schedule.filter(g => g.isHome && !g.isSpring);
const planOf = (g, field) => gameWeatherPlan(ctx, { gameTime: g.gameTime, ...gameTeams(g, true), ...(field ? { field } : {}) });
const minutes = (p) => p.outcome === PLAN_OUTCOME.POSTPONED ? Infinity : p.delays.reduce((a, d) => a + (d.endT - d.startT) / 60_000, 0);
const soft = (p) => p.outcome === PLAN_OUTCOME.POSTPONED ? 1 : gameRecord(ctx, p, gameConditions(ctx, p)).fieldCondition.infieldSoftness;
/** Game by game against the field as built: shorter or no delay / longer (more than 5 minutes either way: a delay
 *  that ends sooner can run the game into the next band of rain), postponements, softness. */
const compare = (field) => {
  const t = { better: 0, worse: 0, same: 0, ppd: 0, ppd0: 0, soft: 0, soft0: 0, wet: 0 };
  for (const g of homes) {
    const a = planOf(g, null), b = planOf(g, field);
    const ma = minutes(a), mb = minutes(b);
    if (a.outcome === PLAN_OUTCOME.POSTPONED) t.ppd0++;
    if (b.outcome === PLAN_OUTCOME.POSTPONED) t.ppd++;
    t.soft0 += soft(a); t.soft += soft(b);
    if (!ma && !mb) continue;
    t.wet++;
    if (mb < ma - 5 || (ma === Infinity && mb !== Infinity)) t.better++; else if (mb > ma + 5) t.worse++; else t.same++;
  }
  return t;
};
const C1 = compare({ drainage: 1 }), C3 = compare({ drainage: 3 }), CP = compare({ drainage: 0, prep: true });
const row = (n, t) => `    ${n.padEnd(16)} ${t.wet} home games with weather: ${t.better} better, ${t.same} about the same, ${t.worse} worse · postponed ${t.ppd0} → ${t.ppd} · infield softness ${t.soft0.toFixed(1)} → ${t.soft.toFixed(1)}`;
console.log(row('drainage 1', C1)); console.log(row('drainage 3', C3)); console.log(row('the crew', CP));
check('there was weather to work with this season', C3.wet >= 4, `${C3.wet} home games with weather`);
check('drainage: never more postponements, a firmer infield, better more often than worse', C3.ppd <= C3.ppd0 && C3.soft < C3.soft0 && C1.soft <= C1.soft0 && C3.better >= C3.worse);
check('the crew: never more postponements, a firmer infield, better more often than worse', CP.ppd <= CP.ppd0 && CP.soft < CP.soft0 && CP.better >= CP.worse);

// ── The groundskeeper's message before a wet home game ─────────
console.log('The groundskeeper\'s message, on the clock');
const first = S().schedule.find(g => !g.isSpring).gameTime;
const seen = [];
CE.onRelease((st, cards) => { for (const c of cards) if (c.cardId === 'field_prep') seen.push(c); });
await liveUntil(first + 50 * DAY);
const asked = homes.filter(g => g.gameTime < clock.get()).length;
console.log(`    ${seen.length} of ${asked} home games: ${seen.slice(0, 3).map(c => `“${c.subject}”`).join(', ')}`);
const msg = seen[0];
check('a message before some of the wet home games (not every game)', seen.length >= 1 && seen.length < asked);
if (msg) {
  console.log(`    ${msg.sender}: ${msg.body}  [${msg.yesLabel} / ${msg.noLabel}]`);
  check(`…a day ahead, answered ${FIELD_CARE.prep.closeH} hours before first pitch (before the game's weather is settled)`,
        Math.abs(msg.deliverAtMs - (msg._fieldGameTime - FIELD_CARE.prep.leadH * H)) < H && msg.expiresAtMs === msg._fieldGameTime - FIELD_CARE.prep.closeH * H
        && msg.expiresAtMs < msg._fieldGameTime - GW.PLAN_AHEAD_MIN * 60_000);
  check('…in the groundskeeper\'s voice, gender-neutral', !GEN.test(msg.body) && voiceProblems(msg, () => null).filter(([r]) => r !== 'deptSelf').length === 0);
}

// ── Compose: get the field ready ────────────────────────────────
console.log('Compose → Head Groundskeeper → "Get the field ready"');
function ask(topicId, channelId) {
  CE.deliverComposeCard(topicId, channelId, { topicLabel: 'test', nowMs: clock.get() });
  const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === topicId).sort((a, b) => b._sentAtMs - a._sentAtMs)[0];
  clock.set(Math.max(clock.get(), pending.deliverAtMs + 1000));
  CE.releaseDueCards(clock.get());
  return CE.getInbox().find(c => c.instanceId === pending.instanceId);
}
// (on a homestand day: the next home game a day or two out)
const target = S().schedule.find(g => g.isHome && !g._committed && !g.isSpring && g.gameTime > clock.get() + 30 * H);
clock.set(target.gameTime - 30 * H);
// (the game the groundskeeper means: the first home game there's still time to get a crew in for)
const nextHome = S().schedule.find(g => g.isHome && !g._committed && !g.isSpring && !g.cancelled && g.gameTime - FIELD_CARE.prep.closeH * H - clock.get() >= 2 * H);
SM.mutate(s => { s.fieldPrep = {}; });
const card = ask('gk_prep', 'groundskeeper');
console.log(`    “${card?.subject}” — ${card?.body?.replace(/\n+/g, ' / ')}  [${card?.yesLabel} / ${card?.noLabel}]`);
if (process.env.DBG) console.log('    dbg', card?._raw?.onYes, card?._fieldGameTime, nextHome.gameTime, card?.expiresAtMs - (nextHome.gameTime - FIELD_CARE.prep.closeH * H));
check('the reply: the forecast, the price, a decision answered before the weather is settled', !!card && card._raw?.onYes === 'field_prep' && /Bring In the Crew/.test(card.yesLabel)
      && card._fieldGameTime === nextHome.gameTime && card.expiresAtMs === nextHome.gameTime - FIELD_CARE.prep.closeH * H && !GEN.test(card.body));
const funds0 = U().finances.funds;
CE.resolve(card.instanceId, 'yes');
check(`yes: the crew is booked (${card._fieldCostK}K paid)`, !!S().fieldPrep?.[nextHome.gameTime] && Math.round(funds0 - U().finances.funds) === card._fieldCostK);
await liveUntil(nextHome.gameTime - 60 * 60_000);
const g1 = S().schedule.find(g => g.gameTime === nextHome.gameTime) || S().schedule.find(g => (g.postponements || []).some(p => p.gameTime === nextHome.gameTime));
check(`…and that game's weather is planned with the crew ("${g1?.wx?.fieldKey}")`, !!g1 && (g1.wx?.fieldKey === 'd0p' || g1.gameTime !== nextHome.gameTime));

// ── The drainage, mid-season ────────────────────────────────────
console.log('The groundskeeper\'s drainage pitch, after a wet stretch');
SM.mutate(s => {
  // three home games lost to the weather in the last few weeks
  const past = s.schedule.filter(g => g.isHome && g._committed && !g.isSpring && g.gameTime < clock.get()).slice(-3);
  for (const g of past) g.postponements = [...(g.postponements || []), { gameTime: g.gameTime, venueId: 'user', reason: 'rain' }];
  delete s.userTeam.fieldPitchAt; delete s.userTeam.fieldWork;
  s.userTeam.finances.funds = Math.max(s.userTeam.finances.funds, 2000);
});
check(`${FC.wetHomeGames(S(), clock.get() - 42 * DAY, clock.get())} wet home games in the last six weeks`, FC.wetHomeGames(S(), clock.get() - 42 * DAY, clock.get()) >= 3);
const win = FC.roadWindow(S(), clock.get());
check(`a road trip long enough for the work (${FIELD_CARE.drainage.workDays} days, done before we're home)`, !!win && win.readyAt <= win.homeAt - DAY);
await liveUntil(clock.get() + 2 * DAY);
const dr = [...(S().inbox || [])].find(c => c.cardId === 'field_drainage' && !c.resolved);
if (!dr && process.env.DBG) { const st = S(); console.log('    dbg', st.phase, st.userTeam.fieldPitchAt, !!st.userTeam.fieldWork, FC.drainageLevel(st), JSON.stringify(FC.roadWindow(st, clock.get())), (st.inbox || []).filter(c => c.cardId === 'field_drainage').map(c => `${c.resolved}:${c.choice}`)); }
console.log(`    “${dr?.subject}” — ${dr?.body}  [${dr?.yesLabel} / ${dr?.noLabel}]`);
check('the pitch: what it does, the price, done on the road', !!dr && /drainage/i.test(dr.body) && /road/.test(dr.body) && !GEN.test(dr.body));
if (dr) {
  const f1 = U().finances.funds;
  CE.resolve(dr.instanceId, 'yes');
  const w = U().fieldWork;
  check(`yes: the work is booked (level ${w?.level}), ${dr._drainage.costK}K paid`, !!w && w.level === 1 && Math.round(f1 - U().finances.funds) === dr._drainage.costK);
  check('…it counts once it\'s done: before, nothing; after, level 1', FC.drainageAt(S(), w.readyAt - H) === 0 && FC.drainageAt(S(), w.readyAt) === 1
        && FC.fieldFor(S(), 'user', w.readyAt + DAY)?.drainage === 1 && FC.fieldFor(S(), 'other', w.readyAt + DAY) === null);
}

// ── The winter offer ────────────────────────────────────────────
console.log('The winter: drainage first after a wet year');
const wetYear = structuredClone(S());
for (const g of wetYear.schedule.filter(g => g.isHome && !g.isSpring).slice(0, 7)) g.postponements = [...(g.postponements || []), { gameTime: g.gameTime, venueId: 'user' }];
delete wetYear.userTeam.fieldWork;
const o = facilityOffer(wetYear);
check(`a wet year (${FC.wetHomeGames(wetYear, -Infinity, Infinity)} home games): the offer is the drainage (${o?.kind}, level ${o?.level}, ${o?.cost}K)`, o?.kind === 'field' && o.level === 1 && o.cost === FC.drainageCostK(0));
applyFacility(wetYear, o, clock.get());
check('built: the park\'s drainage is level 1', wetYear.userTeam.facilities.field === 1 && FC.drainageAt(wetYear, clock.get()) === 1);
const dry = structuredClone(S());
for (const g of dry.schedule) { g.postponements = []; if (g.wxResult) g.wxResult.delays = []; }
check(`a dry year: the usual offer (${facilityOffer(dry)?.kind})`, ['concourse', 'training'].includes(facilityOffer(dry)?.kind));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
