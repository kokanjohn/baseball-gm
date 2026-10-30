// §102.6 (4e) What the weather does to a season, by region and month — from the
// game plans themselves (GameWeather), over several seeds. For tuning against
// real baseball (see the plan doc §102.6 for the benchmarks).
//   node tools/harness/weather-season-rates.mjs [seeds=4] [regions=north,south,east,west]
import { regionMap } from '../../engine/WeatherMap.js';
import { localDayStart, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { gameWeatherPlan } from '../../engine/GameWeather.js';
import { chanceOfPrecip } from '../../engine/WeatherForecast.js';
import { GAME_WEATHER as GW } from '../../data/constants.js';

const SEEDS = +(process.argv[2] || 4);
const REGIONS = (process.argv[3] || 'north,south,east,west').split(',');
const TZ = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), TZ);
const DISP = '2027-03-14';                                    // the first spring day on the baseball calendar
const MONTHS = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const monthOf = (d) => Math.min(6, Math.floor((d + 13) / 30.5));   // day offset → Mar…Sep (Mar 14 + d)

const rows = [];
for (const region of REGIONS) {
  const agg = { n: 0, ppd: 0, ppdForecast: 0, ppdField: 0, ppdWait: 0, delayed: 0, delayedStart: 0, called: 0, calledEarly: 0, delayMin: [], card: 0, byMonth: MONTHS.map(() => ({ n: 0, ppd: 0, delayed: 0 })) };
  for (let k = 0; k < SEEDS; k++) {
    const ctx = { seed: `wx-rates-${k}`, region, tzMin: TZ, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: DISP }] };
    const parks = Object.keys(ctx.map.parks);
    for (let d = 16; d < 196; d++) {                          // the regular season: late March to the end of September
      const dow = (d + 6) % 7;                                 // Mar 14 2027 is a Sunday
      for (let g = 0; g < 5; g++) {
        const home = parks[(d * 3 + g * 2 + k) % parks.length];
        const day = [0, 3, 4, 6].includes(dow) && g < 2;       // a few day games midweek and weekends
        const gameTime = START + d * MS_DAY + Math.round((day ? 13.08 : 19.08) * MS_HOUR);
        const p = gameWeatherPlan(ctx, { homeId: home, gameTime });
        const m = agg.byMonth[monthOf(d)];
        agg.n++; m.n++;
        if (p.outcome === 'postponed') {
          agg.ppd++; m.ppd++;
          if (p.calledBy === 'forecast' && p.decidedAt < gameTime) agg.ppdForecast++;
          else if (p.calledBy === 'field') agg.ppdField++;
          else agg.ppdWait++;
          continue;
        }
        const inGame = p.delays.filter(x => x.startT < p.startAt || x.atPlayMin < GW.PLAY_MIN);
        if (inGame.length) { agg.delayed++; m.delayed++; agg.delayMin.push(inGame.reduce((a, x) => a + (x.endT - x.startT) / 60_000, 0)); }
        if (p.startAt > gameTime) agg.delayedStart++;
        if (p.outcome === 'called' && p.stopAtPlayMin < GW.PLAY_MIN) { agg.called++; if (p.stopAtPlayMin < GW.OFFICIAL_PLAY_MIN) agg.calledEarly++; }
        if (g === 0 && d % 2 === 0) {                          // (a sample: the manager's three-hour look)
          const park = ctx.map.parks[home];
          const ch = chanceOfPrecip(ctx, gameTime - 3 * MS_HOUR, park.x, park.y, gameTime, gameTime + 3 * MS_HOUR);
          agg.cardSampled = (agg.cardSampled || 0) + 1;
          if (ch.chance >= GW.START_CARD_CHANCE) agg.card++;
        }
      }
    }
  }
  rows.push({ region, ...agg });
}

const pct = (a, n) => `${(100 * a / Math.max(1, n)).toFixed(1)}%`;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`Regular season, ${SEEDS} seeds per region, ~900 games per seed (90 home games per club)\n`);
for (const r of rows) {
  const perClub = r.ppd / SEEDS / 10;                          // home postponements per club per season (10 parks)
  console.log(`${r.region.padEnd(6)} postponed ${pct(r.ppd, r.n)} (≈${perClub.toFixed(1)} home games a club a season; ahead ${r.ppdForecast}, field ${r.ppdField}, after waiting ${r.ppdWait})`);
  console.log(`       delayed ${pct(r.delayed, r.n)} (start ${pct(r.delayedStart, r.n)}; median ${med(r.delayMin).toFixed(0)} min, 90th ${[...r.delayMin].sort((a, b) => a - b)[Math.floor(r.delayMin.length * 0.9)]?.toFixed(0)} min)`
            + ` · called before 9 ${pct(r.called, r.n)} (before 5: ${pct(r.calledEarly, r.n)}) · starter question ${pct(r.card, r.cardSampled)} of games`);
  console.log(`       by month: ${r.byMonth.map((m, i) => `${MONTHS[i]} ${pct(m.ppd, m.n)}/${pct(m.delayed, m.n)}`).join('  ')}  (postponed/delayed)`);
}
