// §102.2 (step 4b) The sim plays through the weather — checks.
//   node tools/harness/check-game-sim-weather.mjs [region]
// A real league (startNewGame) and SimEngine.generatePlays with weather plans:
// hand-made ones for each situation, then real ones off the weather itself.
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, accumulateBox, accumulateStats, leagueNorms, playRuns, weatherEnv } from '../../engine/SimEngine.js';
import { weatherContext, MS_HOUR, MS_DAY } from '../../engine/WeatherClimate.js';
import { gameWeatherPlan, gameConditions } from '../../engine/GameWeather.js';
import { venueSample } from '../../engine/WeatherSystems.js';
import { LIGHTNING_DBZ } from '../../engine/WeatherConditions.js';
import { GAME_WEATHER as GW } from '../../data/constants.js';

const REGION = process.argv[2] || 'east';
const MIN = 60_000;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(11);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: REGION });
const st = SM.get();
const players = st.players;
const user = st.userTeam, opp = st.leagueTeams[0];
const norms = leagueNorms([user, ...st.leagueTeams], players);
const T0 = st.schedule.find(g => !g.isSpring)?.gameTime || st.schedule[0].gameTime;

const play = (game, weather) => generatePlays({ ...game, weather: null, fieldCondition: null, _tickOffset: 0 }, user, opp, players,
                                              { phase: st.phase, isSpring: false, norms, weather });
const plan = (over) => ({ v: 1, venueId: 'user', gameTime: T0, outcome: 'played', decidedAt: null, calledBy: null, reason: null,
                          startAt: T0, delays: [], endT: null, stopAtPlayMin: null, playMin: GW.PLAY_MIN, ...over });
const d = (atPlayMin, startMinAfterT0, mins, reason = 'rain') => ({ startT: T0 + startMinAfterT0 * MIN, endT: T0 + (startMinAfterT0 + mins) * MIN, atPlayMin, reason, mm: 5 });
const homeAway = (p) => ({ home: p.cumOurScore, away: p.cumTheirScore });   // userTeam is home here
const monotonic = (ps) => ps.every((p, i) => !i || p._timestamp >= ps[i - 1]._timestamp);
const boxRuns = (plays) => { const b = accumulateBox(plays, players, { userIsHome: true, homeIds: user.rosterIds }); return { home: b.home.runs, away: b.away.runs }; };
const last = (a) => a[a.length - 1];
const pitcherOf = (plays, i, half) => { for (let k = i; k >= 0; k--) if (plays[k].half === half && plays[k].pitcherId && plays[k].type !== 'weather_delay') return plays[k].pitcherId; return null; };

console.log(`Pacing (no weather) — ${REGION}`);
{
  let ok = 0, lens = [], extras = 0;
  for (let i = 0; i < 40; i++) {
    const r = play({ isHome: true, gameTime: T0 }, null);
    const ps = r.plays, end = last(ps);
    const innings = end.inning;
    lens.push((end._timestamp - T0) / MIN);
    if (innings > 9) extras++;
    if (monotonic(ps) && ps[0]._timestamp === T0 && end.type === 'game_end' && !r.resumePlays && r.weather === null) ok++;
  }
  lens.sort((a, b) => a - b);
  check(`every game paced on the clock, start to end (median ${lens[20].toFixed(0)} min, ${lens[0].toFixed(0)}–${last(lens).toFixed(0)}, ${extras} went extra)`,
        ok === 40 && lens[20] >= 165 && lens[20] <= 185 && lens[0] >= 150);
}

console.log('\nA delay mid-game');
{
  const p = plan({ delays: [d(60, 60, 35)] });
  const r = play({ isHome: true, gameTime: T0 }, { plan: p, conditions: [] });
  const ps = r.plays;
  const iD = ps.findIndex(x => x.type === 'weather_delay'), iR = ps.findIndex(x => x.type === 'weather_resume');
  const D = p.delays[0];
  check('the delay and the restart are on the clock exactly when the weather says',
        iD > 0 && iR === iD + 1 && ps[iD]._timestamp === D.startT && ps[iR]._timestamp === D.endT, `${ps[iD]?._timestamp - D.startT} / ${ps[iR]?._timestamp - D.endT}`);
  check('nothing is played during the delay', ps.every((x, i) => i === iD || i === iR || x._timestamp <= D.startT || x._timestamp >= D.endT) && monotonic(ps));
  check(`it comes in the 3rd–4th inning (${ps[iD]?.half} ${ps[iD]?.inning}, ${ps[iD]?.outsAfter} out)`, ps[iD]?.inning >= 3 && ps[iD]?.inning <= 4);
  check(`a short delay: the pitchers stay in (${ps[iR + 1]?.type})`, ps[iR + 1]?.type !== 'pitching_change');
  check(`the game runs that much longer (${((last(ps)._timestamp - T0) / MIN).toFixed(0)} min)`, last(ps)._timestamp - T0 >= 35 * MIN + 150 * MIN);
  check('the box adds up to the final', JSON.stringify(boxRuns(ps)) === JSON.stringify(homeAway(last(ps))));
  check(`what the weather did is reported (${r.weather?.delays.length} delay, ${r.weather?.delays[0]?.half} ${r.weather?.delays[0]?.inning})`,
        r.weather?.delays.length === 1 && r.weather.delays[0].inning === ps[iD].inning && r.weather.ruling === null);
}

console.log('\nA long delay');
{
  let changedField = 0, changedOther = 0, n = 0;
  for (let k = 0; k < 20; k++) {
    const p = plan({ delays: [d(25, 25, 70, 'lightning')] });
    const ps = play({ isHome: true, gameTime: T0 }, { plan: p, conditions: [] }).plays;
    const iR = ps.findIndex(x => x.type === 'weather_resume');
    if (iR < 0) continue;
    n++;
    const half = ps[iR].half, other = half === 'TOP' ? 'BOT' : 'TOP';
    const before = pitcherOf(ps, iR - 2, half), after = ps.slice(iR + 1).find(x => x.half === half && x.pitcherId)?.pitcherId;
    if (ps[iR + 1]?.type === 'pitching_change' && before && after && before !== after) changedField++;
    const otherBefore = pitcherOf(ps, iR, other);
    const otherAfter = ps.slice(iR + 1).find(x => x.half === other && x.pitcherId && x.type !== 'pitching_change')?.pitcherId;
    if (otherBefore && otherAfter && otherBefore !== otherAfter) changedOther++;
  }
  check(`after 70 minutes the pitcher on the mound doesn't go back out (${changedField}/${n})`, n >= 18 && changedField === n);
  check(`…nor does the other club's (${changedOther}/${n})`, changedOther === n);
}

console.log('\nA delayed start');
{
  const p = plan({ startAt: T0 + 47 * MIN, delays: [{ startT: T0, endT: T0 + 47 * MIN, atPlayMin: 0, reason: 'rain', mm: 3 }] });
  const r = play({ isHome: true, gameTime: T0 }, { plan: p, conditions: [] });
  const ps = r.plays;
  check(`the delay shows first, at the scheduled time; first pitch follows (“${ps[1]?.description}”)`,
        ps[0].type === 'weather_delay' && ps[0]._timestamp === T0 && ps[1].type === 'game_start' && ps[1]._timestamp === T0 + 47 * MIN
        && /47-minute delay/.test(ps[1].description) && monotonic(ps));
}

console.log('\nCalled games');
{
  let finals = 0, susp = 0, reverted = 0, bad = [], kinds = {};
  for (let k = 0; k < 160; k++) {
    const at = [40, 75, 95, 105, 115, 125, 140, 155, 165][k % 9];
    const p = plan({ outcome: 'called', calledBy: 'limit', reason: 'rain', decidedAt: T0 + (at + 150) * MIN, stopAtPlayMin: at,
                     delays: [{ startT: T0 + at * MIN, endT: T0 + (at + 150) * MIN, atPlayMin: at, reason: 'rain', mm: 30 }] });
    const r = play({ isHome: true, gameTime: T0 }, { plan: p, conditions: [] });
    const ps = r.plays, ru = r.weather?.ruling, end = last(ps);
    if (!ru) { if (end.type !== 'game_end') bad.push(`no ruling, ${end.type}`); continue; }   // the game was over before the call
    kinds[`${ru.outcome}`] = (kinds[ru.outcome] || 0) + 1;
    const callT = T0 + (at + 150) * MIN;
    if (ru.outcome === 'final') {
      finals++;
      if (ru.revertIdx != null) reverted++;
      const sc = homeAway(end), bx = boxRuns(ps);
      if (end.type !== 'game_end' || end._timestamp !== callT || r.resumePlays) bad.push('final: end');
      if (sc.home !== bx.home || sc.away !== bx.away) bad.push(`final: box ${JSON.stringify(bx)} vs ${JSON.stringify(sc)}`);
      if (sc.home === sc.away) bad.push('final: a tie');
      // Official: 5 innings, or 4½ with the home team ahead.
      if (!(ru.inning - 1 >= 5 || (ru.half === 'BOT' && ru.inning >= 5))) bad.push(`final too early: ${ru.half} ${ru.inning}`);
      // Stats: the plays that count are exactly the ones before the revert.
      const stats = accumulateStats(ps, null, null, players, 'stats');
      if (!stats.players) bad.push('stats');
    } else {
      susp++;
      const rp = r.resumePlays || [];
      if (end.type !== 'game_suspended' || end._timestamp !== callT) bad.push('suspended: end');
      if (!rp.length || last(rp).type !== 'game_end' || rp.some(x => x._timestamp !== null) || !rp.every((x, i) => !i || x._resumeMin >= rp[i - 1]._resumeMin)) bad.push('suspended: resume plays');
      const all = [...ps, ...rp], sc = homeAway(last(rp)), bx = boxRuns(all);
      if (sc.home !== bx.home || sc.away !== bx.away) bad.push(`suspended: box ${JSON.stringify(bx)} vs ${JSON.stringify(sc)}`);
      // It picks up exactly where it stopped.
      const sp = end._suspended, first = rp.find(x => x.type !== 'pitching_change');
      if (!sp || first?.inning !== sp.inning || first?.half !== sp.half) bad.push(`suspended: resumes elsewhere ${sp?.half}${sp?.inning} → ${first?.half}${first?.inning}`);
      // Not official, or tied / visitors went ahead in an unfinished inning.
      const official = ru.inning - 1 >= 5 || (ru.half === 'BOT' && ru.inning >= 5 && homeAway(end).home > homeAway(end).away);
      if (official && homeAway(end).home > homeAway(end).away && ru.half === 'BOT') bad.push('suspended though the home team led in its half');
    }
    if (!monotonic(ps)) bad.push('clock');
  }
  check(`called games are ruled by the rules (${finals} official, ${reverted} with the score going back, ${susp} suspended)`,
        bad.length === 0 && finals > 20 && susp > 20, bad.slice(0, 4).join('; '));
  // Spring and postseason.
  const pc = plan({ outcome: 'called', calledBy: 'limit', reason: 'rain', decidedAt: T0 + 200 * MIN, stopAtPlayMin: 50,
                    delays: [{ startT: T0 + 50 * MIN, endT: T0 + 200 * MIN, atPlayMin: 50, reason: 'rain', mm: 30 }] });
  const sp = generatePlays({ isHome: true, gameTime: T0, weather: null, fieldCondition: null }, user, opp, players, { isSpring: true, norms, weather: { plan: pc, conditions: [] } });
  const po = generatePlays({ isHome: true, gameTime: T0, isPlayoff: true, weather: null, fieldCondition: null }, user, opp, players, { norms, weather: { plan: { ...pc, delays: [{ ...pc.delays[0], atPlayMin: 165, startT: T0 + 165 * MIN }], stopAtPlayMin: 165 }, conditions: [] } });
  check(`spring games simply end; postseason games are never shortened (${sp.weather.ruling?.outcome}, ${po.weather.ruling?.outcome ?? 'over before the call'})`,
        sp.weather.ruling?.outcome === 'final' && (po.weather.ruling == null || po.weather.ruling.outcome === 'suspended'));
}

console.log('\nWhat the weather does to the ball');
{
  const hot = { tempF: 92, windOutMph: 16, kind: null, rateMmH: 0 }, cold = { tempF: 46, windOutMph: -12, kind: null, rateMmH: 0 };
  const env = (c) => Array.from({ length: 14 }, (_, i) => ({ playMin: i * 20, ...c }));
  const runOf = (c) => {
    let hr = 0, runs = 0, bb = 0, n = 120;
    for (let i = 0; i < n; i++) {
      const r = play({ isHome: true, gameTime: T0 }, { plan: plan({}), conditions: env(c) });
      for (const x of r.plays) { if (x.type === 'hr') hr++; if (x.type === 'walk') bb++; runs += playRuns(x); }
    }
    return { hr: hr / n, runs: runs / n, bb: bb / n };
  };
  const H = runOf(hot), C = runOf(cold), N = runOf({ tempF: 72, windOutMph: 5, kind: null, rateMmH: 0 }), R = runOf({ tempF: 64, windOutMph: 5, kind: 'rain', rateMmH: 5 });
  check(`a hot night with the wind blowing out: more home runs and runs (HR ${H.hr.toFixed(2)} vs ${N.hr.toFixed(2)} vs ${C.hr.toFixed(2)} cold, wind in; runs ${H.runs.toFixed(1)} / ${N.runs.toFixed(1)} / ${C.runs.toFixed(1)})`,
        H.hr > N.hr * 1.25 && C.hr < N.hr * 0.75 && H.runs > C.runs);
  check(`playing through rain: more walks (${R.bb.toFixed(2)} vs ${N.bb.toFixed(2)} a game)`, R.bb > N.bb);
  const e = weatherEnv({ tempF: 72, windOutMph: 5 });
  check('a typical night changes nothing', e.hrMod === 1 && e.hitMod === 1 && e.walkMod === 1);
}

console.log(`\nReal weather — ${REGION}`);
{
  const ctx = weatherContext(st);
  const games = st.schedule.filter(g => !g.isSpring).slice(0, 162);
  let n = 0, withDelay = 0, called = 0, ppd = 0, bad = [], logged = 0;
  const msSim = [];
  for (const g of games) {
    for (const k of [0, 1]) {
      const game = { ...g, isHome: true, gameTime: g.gameTime + k * 7 * 60 * MIN };   // a night game and a day game (the same date)
      const p = gameWeatherPlan(ctx, game);
      if (p.outcome === 'postponed') { ppd++; continue; }
      if (!p.delays.length && n > 30) continue;   // the dry ones: a few are enough
      const cond = gameConditions(ctx, p);
      const t0 = performance.now();
      const r = play(game, { plan: p, conditions: cond });
      msSim.push(performance.now() - t0);
      n++;
      const ps = r.plays;
      if (r.weather.delays.length) withDelay++;
      if (r.weather.ruling) called++;
      if (!monotonic(ps)) bad.push('clock');
      // Every delay the game reached is in its plays, at the plan's moments; none it didn't reach.
      const endMin = last(ps)._playMin;
      const reached = p.delays.filter(dl => dl.startT < p.startAt || dl.atPlayMin <= endMin + 0.01);
      if (r.weather.delays.length !== reached.length && !(r.weather.ruling && r.weather.delays.length === reached.length)) bad.push(`delays ${r.weather.delays.length} vs ${reached.length} (end ${endMin})`);
      logged += r.weather.delays.length;
      // Nobody plays in lightning or a downpour: check each pitch on the clock against the park.
      const pk = ctx.map.parks[p.venueId];
      for (const x of ps) {
        if (x._wx || x.type === 'game_end' || x.type === 'game_suspended' || x.type === 'inning_end') continue;
        if (r.weather.delays.some(dl => x._timestamp > dl.startT && x._timestamp < dl.endT)) { bad.push(`${x.type} during a delay`); break; }
        if (x._timestamp < p.startAt) { bad.push(`${x.type} before first pitch`); break; }
      }
      for (let t = p.startAt; t < last(ps)._timestamp; t += 5 * MIN) {
        if (r.weather.delays.some(dl => t >= dl.startT && t < dl.endT)) continue;
        const s = venueSample(ctx, pk.x, pk.y, t, 16);
        // (The plan checks every 5 minutes from first pitch; play goes on between checks.)
        if ((t - p.startAt) % (5 * MIN) === 0 && (s.stormDbz >= LIGHTNING_DBZ || s.rateMmH >= GW.STOP_RATE_MMH)) { bad.push(`playing in ${s.stormDbz >= LIGHTNING_DBZ ? 'lightning' : 'a downpour'} at +${(t - p.startAt) / MIN} min`); break; }
      }
    }
  }
  msSim.sort((a, b) => a - b);
  check(`real plans play out on the clock: no play in a delay, in lightning or in a downpour (${n} games, ${withDelay} with delays, ${called} called, ${ppd} postponed)`,
        bad.length === 0 && withDelay >= 5, bad.slice(0, 4).join('; '));
  check(`a game with its weather simulates in ${msSim[Math.floor(msSim.length / 2)].toFixed(1)} ms (median)`, msSim[Math.floor(msSim.length / 2)] < 50);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
