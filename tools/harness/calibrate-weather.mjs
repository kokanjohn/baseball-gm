// §100 (step 1g) Generates data/weather-calibration.js: for each region and
// month, the rain-rate factor that brings rainfall to the normal, and the
// temperature correction (by hour) that brings the surface weather's average
// back to the background climate. Measured with the corrections off, over
// several seeds and places, then smoothed across months.
//   node tools/harness/calibrate-weather.mjs [seeds]   (writes the file)
import fs from 'node:fs';
import { precipAt, rainRate } from '../../engine/WeatherSystems.js';
import { conditionsAt } from '../../engine/WeatherConditions.js';
import { regionMap } from '../../engine/WeatherMap.js';
import { localDayStart, airAt, normalsOnDay, useCalibration, MS_DAY, MS_HOUR } from '../../engine/WeatherClimate.js';
import { REGION_CLIMATE } from '../../data/region-climate.js';

useCalibration(false);
const tz = -240, START = localDayStart(Date.UTC(2026, 9, 30, 12), tz);
const seeds = (process.argv[2] || 'cal-a,cal-b,cal-c,cal-d,cal-e,cal-f').split(',');
const MID = [74, 105, 135, 166, 196, 227, 258, 288, 319];   // mid-month, Mar–Nov
const HOURS = [0, 4, 8, 12, 16, 20];
const POINTS = [[0, 0], [140, -90], [-150, 110]];
const STEP = 15 * 60_000;
const out = {};
for (const region of ['north', 'south', 'east', 'west']) {
  const rainK = [], tempBias = [];
  for (let mi = 0; mi < 9; mi++) {
    let mm = 0, n = 0;
    const tb = HOURS.map(() => ({ s: 0, n: 0 }));
    for (const seed of seeds) {
      const ctx = { seed, region, tzMin: tz, map: regionMap(region), cal: [{ kind: 'season', season: 1, realStartMs: START, dispIso: '2027-03-14' }] };
      for (let d = -14; d < 16; d += 1) {
        const t0 = START + (MID[mi] - 72 + d) * MS_DAY;
        for (const [x, y] of POINTS) {
          for (let t = t0 + STEP / 2; t < t0 + MS_DAY; t += STEP) mm += precipAt(ctx, x, y, t, { kind: false }).rateMmH * 0.25;
          n++;
          if (d % 2 === 0) HOURS.forEach((h, k) => {
            const t = t0 + h * MS_HOUR;
            tb[k].s += conditionsAt(ctx, x, y, t).tempF - airAt(ctx, x, y, t).tempF; tb[k].n++;
          });
        }
      }
    }
    const inches = (mm / 25.4) / n * 30.4;
    const target = REGION_CLIMATE[region].months[mi].inches;
    rainK.push(Math.max(0.4, Math.min(2.5, target / Math.max(0.05, inches))));
    tempBias.push(tb.map(v => v.s / v.n));
    console.log(region, ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'][mi], `${inches.toFixed(2)}" vs ${target}" → ×${rainK[mi].toFixed(2)}`, 'bias', tempBias[mi].map(v => v.toFixed(1)).join(' '));
  }
  // Smooth across months (in log space for the rain factor): one storm shouldn't set a month.
  const sm = (arr, f, g) => arr.map((_, i) => {
    const a = arr[Math.max(0, i - 1)], b = arr[i], c = arr[Math.min(arr.length - 1, i + 1)];
    return g((f(a) + 2 * f(b) + f(c)) / 4);
  });
  out[region] = {
    rainK: sm(rainK, Math.log, Math.exp).map(v => Math.round(v * 100) / 100),
    tempBias: tempBias.map((_, i) => HOURS.map((__, k) => {
      const a = tempBias[Math.max(0, i - 1)][k], b = tempBias[i][k], c = tempBias[Math.min(8, i + 1)][k];
      return Math.round(((a + 2 * b + c) / 4) * 10) / 10;
    })),
  };
}
const file = new URL('../../data/weather-calibration.js', import.meta.url);
const src = fs.readFileSync(file, 'utf8');
const head = src.slice(0, src.indexOf(' * Neutral until generated.'));
fs.writeFileSync(file, `${head} * Generated ${new Date().toISOString().slice(0, 10)} from seeds ${seeds.join(', ')}.\n */\nexport const WEATHER_CALIBRATION = Object.freeze(${JSON.stringify(out, null, 2)});\n`);
console.log('wrote data/weather-calibration.js');
