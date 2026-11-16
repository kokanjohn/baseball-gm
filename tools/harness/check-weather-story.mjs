// §122.51 (phase 2) A game's weather story (engine/GameWeatherStory.js): what the grounds crew knows,
// moment by moment — checked against what really happens (the game's plan) across a season in every region.
//   node tools/harness/check-weather-story.mjs
import { regionMap } from '../../engine/WeatherMap.js';
import { localDayStart, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { gameWeatherPlan } from '../../engine/GameWeather.js';
import { gameStory, outlookAt } from '../../engine/GameWeatherStory.js';
import { pickToldAway, awayMessage, awayPostponedMessage, AWAY_SENDER } from '../../engine/WeatherMessages.js';
import { GAME_WEATHER as GW, WEATHER_STORY as WS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const MIN = 60_000, TZ = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
const ctxFor = (region, seed) => ({ seed, region, tzMin: TZ, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] });
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
const START_WORDS = new Set(['start_delayed', 'start_estimate', 'start_doubt']);

const all = [];   // [{ region, ctx, game, plan, ev, ms }]
for (const region of ['north', 'south', 'east', 'west']) {
  const ctx = ctxFor(region, 'wx-story-1');
  const parks = Object.keys(ctx.map.parks);
  for (let d = 0; d < 196; d++) {
    const game = { homeId: parks[(d * 3) % parks.length], gameTime: START + d * MS_DAY + Math.round(((d % 7) === 3 ? 13.08 : 19.08) * MS_HOUR), isSpring: d < 16 };
    const plan = gameWeatherPlan(ctx, game);
    const t0 = performance.now();
    const ev = gameStory(ctx, game, plan);
    all.push({ region, ctx, game, plan, ev, ms: performance.now() - t0 });
  }
}
const told = all.filter(x => x.ev.length);
console.log(`A season of games in each region: ${all.length} games, ${told.length} with a story`);

// The story hangs together.
{
  let bad = 0;
  for (const { ev, game, ctx } of all) {
    const ids = new Set(ev.map(e => e.id));
    if (ids.size !== ev.length) bad++;
    if (ev.some((e, i) => i && e.at < ev[i - 1].at)) bad++;
    if (ev.length && ev[0].at < Math.min(outlookAt(ctx, game.gameTime), game.gameTime - WS.watchBeforeMin * MIN - 60 * MIN)) bad++;
  }
  check('every story is in time order, each moment once, none before the morning of game day', bad === 0, `${bad}`);
}

// What happens is told when it happens.
{
  let bad = 0, n = 0;
  for (const { plan, ev, game } of all) {
    const at = (kind, t) => ev.some(e => e.kind === kind && e.at === t);
    for (const x of plan.tarps || []) { n++; if (!at('tarp_on', x.onT) || !at('tarp_off', x.offT)) bad++; }
    if (plan.outcome === 'postponed') { n++; if (!at('postponed', plan.decidedAt)) bad++; continue; }
    if (plan.startAt > game.gameTime) { n++; if (!at('first_pitch', plan.startAt)) bad++; }
    for (const d of plan.delays.filter(x => x.atPlayMin > 0 && x.atPlayMin < GW.PLAY_MIN)) {
      n++;
      if (!at('delay', d.startT)) bad++;
      const called = plan.outcome === 'called' && plan.decidedAt <= d.endT && plan.decidedAt >= d.startT;
      if (!called && !at('resumed', d.endT)) bad++;
      if (called && !at('called', plan.decidedAt)) bad++;
    }
  }
  check(`what happens is told when it happens: the tarp on and off, first pitch, a postponement, each delay and its end (${n})`, bad === 0 && n > 50, `${bad} missing`);
}

// A held start is announced before first pitch; a postponement never comes without earlier word.
{
  let held = 0, warned = 0, ppd = 0, ppdWarned = 0;
  for (const { plan, ev, game } of all) {
    const sd = plan.delays.find(d => d.atPlayMin === 0);
    if (plan.startAt != null && plan.startAt - game.gameTime >= WS.delayedMin * MIN && (sd?.tarpOnT ?? sd?.startT) <= game.gameTime - 15 * MIN) {
      held++; if (ev.some(e => START_WORDS.has(e.kind) && e.at < game.gameTime)) warned++;
    }
    if (plan.outcome === 'postponed') { ppd++; if (ev.some(e => e.kind !== 'postponed' && e.at < plan.decidedAt)) ppdWarned++; }
  }
  check(`a start the tarp holds up is announced before first pitch (${warned} of ${held})`, held > 5 && warned === held);
  check(`a postponement never comes out of the blue (${ppdWarned} of ${ppd} had earlier word)`, ppd > 5 && ppdWarned === ppd);
}

// The crew's estimates are honest: they firm up as first pitch nears.
{
  const err30 = [], err90 = [];
  let bad = 0;
  for (const { plan, ev, game } of all) {
    let prev = null;
    for (const e of ev) {
      if (e.estStart != null && e.estStart < game.gameTime) bad++;
      if (e.kind === 'start_estimate') { if (prev == null || Math.abs(e.estStart - prev) < WS.estStepMin * MIN || e.prevEst !== prev) bad++; }
      if (e.kind === 'start_delayed' || e.kind === 'start_estimate') prev = e.estStart;
      if (e.kind === 'start_on_time') prev = null;
    }
    if (plan.startAt == null || plan.startAt - game.gameTime < WS.delayedMin * MIN) continue;
    const by = (lead) => ev.filter(e => e.estStart != null && e.at <= plan.startAt - lead * MIN).pop();
    const a = by(30), b = by(75);
    if (a) err30.push(Math.abs(plan.startAt - a.estStart) / MIN);
    if (b) err90.push(Math.abs(plan.startAt - b.estStart) / MIN);
  }
  check(`estimates are on or after the scheduled time, and each revision really moves (by ${WS.estStepMin}+ min)`, bad === 0, `${bad}`);
  check(`first pitch vs the estimate 30 min ahead: median ${q(err30, 0.5).toFixed(0)} min, 90th ${q(err30, 0.9).toFixed(0)} (${err30.length}); 75 min ahead: median ${q(err90, 0.5).toFixed(0)}, 90th ${q(err90, 0.9).toFixed(0)} (${err90.length})`,
        err30.length > 5 && q(err30, 0.5) <= 10 && q(err30, 0.9) <= 30);
}

// Crew trouble moves the estimate when the crew finds it out.
{
  let n = 0, moved = 0;
  for (const { plan, ev } of all) {
    for (const e of ev.filter(x => x.kind === 'crew_trouble')) {
      const before = ev.filter(x => x.at < e.at && (x.estStart != null || x.estResume != null)).pop();
      const now = e.estStart ?? e.estResume, was = before ? before.estStart ?? before.estResume : null;
      if (now == null) continue;   // (the field still ready before first pitch, or no restart in sight: nothing to move)
      n++;
      if (was == null || now > was) moved++;
    }
  }
  check(`crew trouble that holds things up is told when it's found out, and the estimate moves later (${moved} of ${n})`, n > 0 && moved === n);
}

// Quiet when the weather stays away.
{
  let noisy = 0, dry = 0;
  for (const { plan, ev } of all) {
    const touched = plan.outcome !== 'played' || plan.delays.length || (plan.tarps || []).length;
    if (touched) continue;
    dry++;
    if (ev.some(e => !['outlook', 'update', 'clearing', 'late_watch', 'heads_up'].includes(e.kind))) noisy++;
  }
  const quiet = all.filter(x => !x.ev.length).length;
  check(`a day the weather leaves alone has nothing from the field (${dry} untouched games, ${noisy} with field news; ${quiet} of ${all.length} games with no story at all)`, noisy === 0 && quiet > all.length * 0.5);
}

// Under way: a heads-up before most stoppages; a game that's over has no delay after it.
{
  let n = 0, warned = 0;
  for (const { plan, ev } of all) for (const d of plan.delays.filter(x => x.atPlayMin > 0 && x.atPlayMin < GW.PLAY_MIN)) {
    n++; if (ev.some(e => e.kind === 'heads_up' && e.at < d.startT && e.at >= d.startT - 30 * MIN)) warned++;
  }
  check(`the crew warns before rain stops play in most games (${warned} of ${n})`, n > 10 && warned >= n * 0.5);
  const x = all.find(y => y.plan.outcome === 'played' && y.plan.delays.some(d => d.atPlayMin > 0));
  const ev2 = gameStory(x.ctx, x.game, x.plan, { result: { delays: [] } });
  check('once played, only the delays that really happened are told (the sim\'s, not the plan\'s past the last out)', !ev2.some(e => e.kind === 'delay' || e.kind === 'resumed'));
}

// The story so far is the start of the whole story; the same every time, from a separate copy.
{
  const x = told.find(y => y.ev.length >= 4);
  const cut = x.ev[2].at;
  const part = gameStory(x.ctx, x.game, x.plan, { until: cut });
  check('the story so far is the beginning of the whole story', JSON.stringify(part) === JSON.stringify(x.ev.filter(e => e.at <= cut)));
  const M2 = await import('../../engine/GameWeatherStory.js?fresh=1');
  const same = told.slice(0, 12).every(y => JSON.stringify(M2.gameStory(y.ctx, y.game, y.plan)) === JSON.stringify(y.ev));
  check('a game\'s story is the same every time it\'s worked out', same);
}

// §122.58 (phase 4) On the road: the traveling party's word — updates only, the start's every change told, the
// why some of the time, quiet on a dry day.
{
  console.log('On the road');
  const MUST = ['start_delayed', 'start_estimate', 'start_on_time', 'start_doubt', 'delay', 'resume_estimate', 'resumed', 'called'];
  const NEVER = ['tarp_on', 'tarp_off', 'heads_up', 'late_watch', 'gap', 'calloff_ask', 'postponed'];
  let missed = 0, extra = 0, dryNoisy = 0, clearingAlone = 0, badWords = [], per = [], withWhy = 0, whyable = 0, warnNoDoubt = 0;
  for (const x of all) {
    const told = pickToldAway(x.ev, x.ctx.seed);
    for (const k of MUST) if (x.ev.filter(e => e.kind === k).length !== told.filter(e => e.kind === k).length) missed++;
    if (told.some(e => NEVER.includes(e.kind))) extra++;
    const touched = x.plan.outcome !== 'played' || x.plan.delays.length || (x.plan.tarps || []).length;
    if (!touched && told.some(e => e.kind !== 'outlook' && e.kind !== 'update' && e.kind !== 'clearing')) dryNoisy++;
    if (told.some(e => (e.kind === 'outlook' || e.kind === 'update') && e.proj !== 'delayed' && e.proj !== 'doubt')) warnNoDoubt++;
    const c = told.findIndex(e => e.kind === 'clearing');
    if (c >= 0 && !told.slice(0, c).some(e => e.kind === 'outlook' || e.kind === 'update')) clearingAlone++;
    const city = x.ctx.map.parks[x.game.homeId]?.city || 'Somewhere';
    for (const e of told) {
      const m = awayMessage(e, { gameTime: x.game.gameTime, city, seed: x.ctx.seed, ruling: x.plan.outcome === 'called' ? { outcome: 'final', innings: 6 } : null });
      if (!m || /undefined|NaN|null|\{/.test(m.subject + m.body) || m.sender !== AWAY_SENDER || !m.subject.includes(city)) badWords.push(`${e.kind}: ${m?.subject} / ${m?.body}`);
      if (e.kind === 'start_delayed' || e.kind === 'delay') { whyable++; if (/rain|lightning|snow/i.test(m.body) || /^(Rain|Lightning|Snow) delay/.test(m.subject)) withWhy++; }
    }
    const ppdCount = x.plan.outcome === 'postponed' ? 1 : 0;
    if (touched && told.length + ppdCount) per.push(told.length + ppdCount);
  }
  check(`every change to the start, every delay, restart and call is told on the road (${MUST.join(', ')})`, missed === 0, `${missed} missing`);
  check('nothing about their field or tarp, no heads-up during play, nothing to decide', extra === 0, `${extra}`);
  check(`a dry day on the road is quiet (a forecast heads-up at most)`, dryNoisy === 0, `${dryNoisy}`);
  check('a heads-up only when the start is in question; "the weather is missing them" only after one', warnNoDoubt === 0 && clearingAlone === 0, `${warnNoDoubt} / ${clearingAlone}`);
  check(`the words: the host city named, no blanks, from our ${AWAY_SENDER} (${badWords.length} bad)`, badWords.length === 0, badWords.slice(0, 3).join(' | '));
  const share = withWhy / Math.max(1, whyable);
  check(`the why is given some of the time, not always (${withWhy} of ${whyable} delays and held starts say why)`, whyable > 20 && share > 0.3 && share < 0.8);
  check(`a road game the weather touches: median ${q(per, 0.5)}, 90th ${q(per, 0.9)}, most ${q(per, 1)} messages (${per.length} games)`, per.length > 20 && q(per, 0.5) >= 1 && q(per, 0.5) <= 4 && q(per, 0.9) <= 9);
  const pp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => awayPostponedMessage({ city: 'Tideland', reason: 'rain', makeup: 'tomorrow at 1:05 PM, as part of a doubleheader', seed: 's', id: i }));
  check(`a postponement on the road: the city, the makeup; the why some of the time (${pp.filter(m => /for rain/.test(m.body)).length} of 10)`,
        pp.every(m => /Tideland/.test(m.subject) && /made up tomorrow/.test(m.body)) && pp.some(m => /for rain/.test(m.body)) && pp.some(m => !/for rain/.test(m.body)));
}

// Volume and speed.
{
  const counts = told.map(x => x.ev.length), ms = all.map(x => x.ms);
  check(`a story's length: median ${q(counts, 0.5)}, 90th ${q(counts, 0.9)}, most ${q(counts, 1)} moments`, q(counts, 0.9) <= 10 && q(counts, 1) <= 20);
  check(`a story takes ${q(ms, 0.5).toFixed(0)} ms (median), ${q(ms, 0.9).toFixed(0)} ms (90th)`, q(ms, 0.5) < 80 && q(ms, 0.9) < 400);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
