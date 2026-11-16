// §122.58 (§122.51 phase 5) The weather on screen — checks, in real leagues:
//   1. The first-pitch card follows what's been told (startStatus): on time, watching, the tarp, delayed with its
//      estimate and each revision, in doubt, the tarp coming off, back on schedule — the estimate it shows is always
//      the latest one told by then (never the plan's real start).
//   2. Reading it changes nothing (a screen draws without touching the game).
//   3. The live conditions line moves half-inning by half-inning, and reads the park as the game is played.
//   4. Scores: a league game the weather holds up shows its park's estimate; a game it leaves alone reads nothing.
//   5. A game postponed today: the card says so, with the makeup.
//   6. The conditions words: the full vocabulary, no fog.
//   node tools/harness/check-weather-screens.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, weatherStoryOf, weatherToldOf, leagueWeatherToldOf } from '../../engine/GameEngine.js';
import { startStatus, startNote, postponedToday, liveWeatherLine, weatherLine } from '../../ui/components/WeatherStatus.js';
import { regionMap } from '../../engine/WeatherMap.js';
import { localDayStart, MS_DAY } from '../../engine/WeatherClimate.js';
import { parkConditions } from '../../engine/WeatherConditions.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const MIN = 60_000, HOUR = 60 * MIN;

console.log('The first-pitch card, step by step');
{
  const T = Date.UTC(2031, 5, 10, 23, 5);
  const g = { gameTime: T, isHome: true, opponent: 'Gulls' };
  const e = (kind, at, x = {}) => ({ id: `${kind}:${at}`, kind, at: T + at * MIN, ...x });
  const seq = [
    e('outlook', -540, { proj: 'delayed', chance: 70, wx: 'rain', rainAt: T - 60 * MIN, estStart: T + 30 * MIN }),
    e('tarp_on', -80),
    e('start_delayed', -40, { estStart: T + 35 * MIN }),
    e('start_estimate', 10, { estStart: T + 60 * MIN, prevEst: T + 35 * MIN }),
    e('tarp_off', 40, { estStart: T + 60 * MIN }),
  ];
  const at = (k, now) => startStatus(seq.slice(0, k), g, T + now * MIN);
  check('nothing told: the countdown, on time', at(0, -600).kind === 'ontime' && at(0, -600).label === 'First Pitch');
  const w = at(1, -500);
  check(`the morning look: watching the weather ("${w.sub}")`, w.kind === 'watch' && /rain around/.test(w.sub) && /70%/.test(w.sub));
  check('the tarp on, no estimate yet: "Tarp on"', at(2, -70).kind === 'tarp');
  const d = at(3, -30);
  check(`delayed: the estimate, and the scheduled time ("${d.label}" ${new Date(d.estStart).toISOString().slice(11, 16)}, "${d.sub}")`, d.kind === 'delayed' && d.estStart === T + 35 * MIN && !d.revised);
  const r = at(4, 15);
  check(`a revision: "New estimate", the time it replaced ("${r.sub}")`, r.kind === 'delayed' && r.revised && r.estStart === T + 60 * MIN && r.wasStart === T + 35 * MIN && /Was/.test(r.sub));
  check('the tarp coming off for a late start', at(5, 45).kind === 'starting' && at(5, 45).estStart === T + 60 * MIN);
  check('back on schedule clears it', startStatus([...seq.slice(0, 3), e('start_on_time', -20)], g, T - 10 * MIN).kind === 'ontime');
  check('the rain sliding past clears a watch', startStatus([seq[0], e('clearing', -300)], g, T - 200 * MIN).kind === 'ontime');
  check('in doubt', startStatus([e('start_doubt', -30)], g, T - 20 * MIN).kind === 'doubt');
  check('play under way is not the start\'s business (an in-game tarp, a delay)', startStatus([e('tarp_on', 60, { inGame: true }), e('delay', 60)], g, T + 70 * MIN).kind === 'ontime');
  check('a schedule row says it in a few words', /Delayed · est\. first pitch/.test(startNote(d, g)) && startNote(at(0, -600), g) === '');
}

console.log('In a real league: told, as the messages tell it; read only');
let league = null;
for (const [region, seed] of [['south', 51], ['east', 52], ['north', 53], ['south', 54]]) {
  for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId ?? sl.id);
  seedRandom(seed);
  clock.set(Date.UTC(2400, 0, 1));
  await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers', abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region });
  const sched = SM.get().schedule;
  const held = [];
  for (const g of sched.slice(0, 140)) {
    const ev = weatherStoryOf(g);
    if (ev.some(x => x.kind === 'start_delayed' && x.at < g.gameTime)) held.push({ g, ev });
  }
  if (held.length >= 2) { league = { region, held }; break; }
}
check(`games whose start the weather holds up, found (${league?.held.length ?? 0} in ${league?.region})`, !!league);
if (league) {
  let bad = [], shown = 0;
  for (const { g, ev } of league.held) {
    const T = g.gameTime;
    for (let t = T - 6 * HOUR; t <= T; t += 10 * MIN) {
      const told = weatherToldOf(g, t);
      const st = startStatus(told, g, t);
      const lastEst = [...told].reverse().find(x => !x.inGame && ['start_delayed', 'start_estimate', 'crew_trouble', 'tarp_on', 'tarp_off'].includes(x.kind) && x.estStart != null);
      if ((st.kind === 'delayed' || st.kind === 'starting') && st.estStart !== lastEst?.estStart) bad.push(`${new Date(t).toISOString().slice(11, 16)} shows ${st.estStart} vs told ${lastEst?.estStart}`);
      if (st.kind === 'delayed') shown++;
      if (told.some(x => x.at > t)) bad.push('a moment from the future');
    }
    // Before the first word about the start, never a delay on the card.
    const first = ev.find(x => x.kind === 'start_delayed');
    const pre = startStatus(weatherToldOf(g, first.at - MIN), g, first.at - MIN);
    if (pre.kind === 'delayed') bad.push('delayed before it was told');
  }
  check(`the card shows the latest estimate told, never one not yet told (${shown} moments shown delayed)`, bad.length === 0 && shown > 0, bad.slice(0, 3).join(' | '));
  const st0 = JSON.stringify(SM.get().schedule.map(g => [g.wxPatience, g.wx?.decidedAt]));
  const v0 = SM.get()._version ?? null;
  for (const g of SM.get().schedule.slice(0, 60)) weatherToldOf({ ...g, wxPatience: undefined }, g.gameTime);
  check('reading what\'s been told changes nothing in the game', JSON.stringify(SM.get().schedule.map(g => [g.wxPatience, g.wx?.decidedAt])) === st0 && (SM.get()._version ?? null) === v0);
}

console.log('The live conditions line');
{
  const st = SM.get();
  const g = st.schedule.find(x => !x.isSpring);
  const T = g.gameTime;
  const P = (inning, half, at) => ({ type: 'single', inning, half, _timestamp: T + at * MIN });
  const plays = [P(1, 'TOP', 0), P(1, 'TOP', 4), P(1, 'BOT', 12), P(1, 'BOT', 15), P(2, 'TOP', 24)];
  const venue = g.isHome ? 'user' : g.opponentId;
  const L = (k) => liveWeatherLine(st, g, plays.slice(0, k), venue);
  check('before play: the weather at first pitch', liveWeatherLine(st, g, [], venue) === weatherLine(g));
  check('within a half-inning the line holds (read at its start)', L(1) === L(2) && L(3) === L(4));
  const c = parkConditions({ ...(await import('../../engine/WeatherClimate.js')).weatherContext(st) }, venue, T + 12 * MIN);
  check(`it reads the park at the half-inning's start ("${L(4)}")`, L(4).startsWith(`${Math.round(c.tempF)}° ${c.label}`));
  // Over a long evening the line moves (the temperature at least): a span of half-innings across three hours.
  const long = Array.from({ length: 18 }, (_, k) => P(1 + (k >> 1), k % 2 ? 'BOT' : 'TOP', k * 11));
  const lines = new Set(long.map((_, k) => liveWeatherLine(st, g, long.slice(0, k + 1), venue)));
  check(`over a game the line moves half-inning by half-inning (${lines.size} different readings in 18 halves)`, lines.size >= 2);
}

console.log('Scores: league games');
{
  // (the engine plans a league game's weather a little ahead of it: here, the first 300 planned at once)
  const { gameWeatherPlan } = await import('../../engine/GameWeather.js');
  const { weatherContext } = await import('../../engine/WeatherClimate.js');
  const ctx = weatherContext(SM.get());
  SM.mutate(s => {
    const all = Object.values(s.leagueSchedule?.dayMap || {}).flat().filter(cg => Number.isFinite(cg.gameTime) && !cg.isAllStar).slice(0, 300);
    for (const cg of all) cg.wx = gameWeatherPlan(ctx, { gameTime: cg.gameTime, homeId: cg.homeId, awayId: cg.awayId, venueId: cg.venueId || cg.homeId, ...(cg.isSpring ? { isSpring: true } : {}) });
  });
  const st = SM.get();
  const cpu = Object.values(st.leagueSchedule?.dayMap || {}).flat().filter(cg => Number.isFinite(cg.gameTime) && !cg.isAllStar);
  let held = 0, withEst = 0, dryBad = 0;
  for (const cg of cpu.slice(0, 300)) {
    if (!cg.wx) continue;
    const affected = cg.wx.outcome === 'postponed' || (cg.wx.startAt ?? cg.gameTime) > cg.gameTime;
    const told = leagueWeatherToldOf(cg, cg.gameTime + 10 * MIN);
    if (!affected) { if (told.length) dryBad++; continue; }
    held++;
    const s = startStatus(told, cg, cg.gameTime + 10 * MIN);
    if (s.estStart || s.kind === 'doubt') withEst++;
  }
  check(`a league game the weather leaves alone reads nothing (${dryBad} did)`, dryBad === 0);
  check(`a league game it holds up shows an estimate or "in doubt" ten minutes past its time (${withEst} of ${held})`, held > 3 && withEst >= held * 0.6);
}

console.log('Postponed today');
{
  const T = Date.UTC(2031, 5, 10, 23, 5);
  const sched = [{ date: '2031-06-12', gameTime: T + 42 * HOUR, opponent: 'Gulls', isHome: true, makeup: { how: 'dh' },
                   postponements: [{ date: '2031-06-10', gameTime: T, decidedAt: T - 3 * HOUR, reason: 'rain' }] }];
  const p = postponedToday(sched, T - HOUR);
  check('our game called off today: the makeup, the doubleheader', p && p.makeupMs === T + 42 * HOUR && p.dh && p.opp === 'Gulls');
  check('…and gone the morning after', !postponedToday(sched, T + 10 * HOUR));
  check('…and not before the call', !postponedToday(sched, T - 4 * HOUR));
}

console.log('The words for the conditions');
{
  const TZ = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
  const seen = new Set();
  for (const region of ['north', 'south', 'east', 'west']) {
    const ctx = { seed: 'scr', region, tzMin: TZ, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] };
    for (let d = 0; d < 200; d += 0.29) for (const id of Object.keys(ctx.map.parks).slice(0, 5)) seen.add(parkConditions(ctx, id, START + d * MS_DAY).label);
  }
  const words = [...seen];
  const want = ['Drizzle', 'Light Rain', 'Showers', 'Steady Rain', 'Thunderstorms', 'Muggy', 'Raw'];
  check(`the vocabulary in use (${words.length} labels): ${want.join(', ')} among them`, want.every(w => words.some(x => x.includes(w))), words.join(', '));
  check('no fog', !words.some(x => /fog/i.test(x)));
  check('one add-on at most ("Light Rain, Raw", never "Raw, Windy")', words.every(x => x.split(',').length <= 2));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
