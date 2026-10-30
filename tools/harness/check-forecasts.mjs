// §102.7 (3d) Game forecasts — what the dashboard, the schedule and the forecast sheet show — checked:
//   - they hang together: a game is at least as likely to rain as any hour of it, a day as any game in it;
//     the words match the number;
//   - they verify: across a season of games in every region, "40%" rains about 40% of the time,
//     three hours, a day and three days out (the shown number, after the nesting rule);
//   - they firm up: closer to the game, better (Brier score).
//   node tools/harness/check-forecasts.mjs [seeds=2]
import { regionMap, REGION_KEYS } from '../../engine/WeatherMap.js';
import { localDayStart, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { forecastForGame } from '../../engine/GameWeather.js';
import { dailyForecastDay, withinDay } from '../../engine/WeatherForecast.js';
import { rainTotal } from '../../engine/WeatherConditions.js';

const SEEDS = +(process.argv[2] || 2);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const TZ = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
const LEADS = [3, 24, 72];
const bins = Object.fromEntries(LEADS.map(L => [L, new Map()]));
const brier = Object.fromEntries(LEADS.map(L => [L, { s: 0, n: 0 }]));
let nest = 0, words = 0, dayNest = 0, n = 0;
const t0 = performance.now();
for (const region of REGION_KEYS) {
  for (let k = 0; k < SEEDS; k++) {
    const ctx = { seed: `wx-fc-${k}`, region, tzMin: TZ, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] };
    const parks = Object.keys(ctx.map.parks);
    for (let d = 16; d < 196; d += 1) {
      const home = parks[(d * 7 + k) % parks.length], pk = ctx.map.parks[home];
      const gameTime = START + d * MS_DAY + Math.round((d % 7 === 3 ? 13.08 : 19.08) * MS_HOUR);
      const game = { homeId: home, gameTime };
      const wet = rainTotal(ctx, pk.x, pk.y, gameTime, gameTime + 3 * MS_HOUR, 10) >= 0.01;
      for (const L of LEADS) {
        const f = forecastForGame(ctx, gameTime - L * MS_HOUR, game);
        n++;
        if (f.hours.some(h => h.chance > f.chance)) nest++;
        const band = f.chance >= 60 ? /likely$/ : f.chance >= 30 ? /^Chance of/ : f.chance >= 10 ? /^Slight chance/ : /^(?!.*chance)(?!.*likely)/i;
        if (!band.test(f.label)) words++;
        const b = Math.min(100, Math.round(f.chance / 10) * 10);
        const cell = bins[L].get(b) || { n: 0, wet: 0 };
        cell.n++; if (wet) cell.wet++;
        bins[L].set(b, cell);
        brier[L].s += (f.chance / 100 - (wet ? 1 : 0)) ** 2; brier[L].n++;
        if (L === 24 && d % 3 === 0) {
          const now = gameTime - L * MS_HOUR;
          const day0 = Math.floor((localDayStart(gameTime, TZ) - localDayStart(now, TZ)) / MS_DAY);
          const day = withinDay(dailyForecastDay(ctx, now, pk.x, pk.y, day0), [f]);
          if (day.chance < f.chance) dayNest++;
        }
      }
    }
  }
}
console.log(`Game forecasts: ${n} (${REGION_KEYS.length} regions × ${SEEDS} seeds × a season × ${LEADS.length} leads), ${((performance.now() - t0) / 1000).toFixed(0)} s`);
check('a game is never less likely to rain than an hour of it', nest === 0, `${nest}`);
check('a day shown beside a game is never less likely to rain than the game', dayNest === 0, `${dayNest}`);
check('the words match the number (likely ≥ 60, chance of ≥ 30, slight ≥ 10)', words === 0, `${words}`);
for (const L of LEADS) {
  const rows = [...bins[L].entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.n >= 25);
  // Within about two standard errors of the bin (at least 10 points), as a reliability diagram is read.
  const off = rows.filter(([b, c]) => Math.abs(100 * c.wet / c.n - b) > Math.max(10, 200 * Math.sqrt(Math.max(0.05, b / 100) * (1 - Math.min(0.95, b / 100)) / c.n)));
  check(`${L} hours out, the shown chance verifies (${rows.map(([b, c]) => `${b}%→${Math.round(100 * c.wet / c.n)}% of ${c.n}`).join(', ')})`,
        off.length === 0, off.map(([b, c]) => `${b}%: ${Math.round(100 * c.wet / c.n)}%`).join(', '));
}
const bs = LEADS.map(L => brier[L].s / brier[L].n);
check(`forecasts firm up toward the game (Brier ${bs.map((b, i) => `${LEADS[i]}h ${b.toFixed(3)}`).join(', ')})`, bs[0] < bs[1] && bs[1] < bs[2]);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
