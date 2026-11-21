// r238 §122.117 The groundskeeper's weather reply covers the weather at the park between games, not only during them.
//   node tools/harness/check-gk-between.mjs [region=north] [seed=1]
// For home games early in the season (spring and April, when it can snow), asked just after the game before: the
// reply mentions the window's rain or snow exactly when the forecast run shows it and its chance is 30% or more, with that chance, and says what
// it does to the field the way the game's weather will (snow cover → called off; rain close to first pitch → soft).
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { chanceOfPrecip } from '../../engine/WeatherForecast.js';
import { fieldOutlook } from '../../engine/GameWeather.js';
import { fieldFor } from '../../engine/FieldCare.js';
import { precipAt, forecastContext, DBZ_MIN } from '../../engine/WeatherSystems.js';

const REGION = process.argv[2] || 'north';
const SEED = parseInt(process.argv[3] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const H = 3_600_000;

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: REGION });
const st0 = SM.get();
const ctx = weatherContext(st0);
const pk = ctx.map.parks.user;
const sched = (st0.schedule || []).filter(g => Number.isFinite(g.gameTime));
const seen = { said: 0, quiet: 0, snow: 0, cover: 0, soft: 0, drains: 0 }, bad = [];
let asked = 0;
for (let i = 1; i < sched.length && asked < 70; i++) {
  const g = sched[i], prev = sched[i - 1];
  if (!g.isHome || g.gameTime - prev.gameTime > 30 * H) continue;
  asked++;
  const at = prev.gameTime + 4 * H;   // just after the game before
  clock.set(at);
  const st = SM.get();
  const rep = writeComposeReply(st, { topicId: 'gk_weather', channelId: 'groundskeeper', atMs: at });
  const body = rep?.body || '';
  const t0 = Math.max(at, prev.gameTime + 3.5 * H), t1 = g.gameTime - 30 * 60_000;
  const long = t1 - t0 >= 3 * H && t0 - at <= 36 * H;
  // (told when the forecast run shows rain or snow over the park in the window, and the chance is 30% or more)
  let runWet = false;
  if (long) { const run = forecastContext(ctx, at); for (let t = t0 + 15 * 60_000; t < t1 && !runWet; t += 30 * 60_000) { const p = t <= at ? precipAt(ctx, pk.x, pk.y, t) : precipAt(run, pk.x, pk.y, t); runWet = p.dbz > DBZ_MIN && p.rateMmH > 0.1; } }
  const ch = long && runWet ? chanceOfPrecip(ctx, at, pk.x, pk.y, t0, t1) : null;
  const fo = fieldOutlook(ctx, { ...g, venueId: 'user', field: fieldFor(st, 'user', g.gameTime) }, at);
  // (the reply: the opening, then the next home game's line, then its between-games line if it has one)
  const paras = body.split('\n\n');
  const said = /^Between games, there's an? (\d+)% chance of ([a-z ]+) here\./.exec(paras[2] || '');
  const tail = paras[2] || '';
  const want = !!ch && ch.chance >= 30;
  if (want !== !!said) { bad.push(`${g.date}: chance ${ch?.chance ?? '—'} ${ch?.kind ?? ''}, said: ${said?.[0] ?? 'nothing'}`); continue; }
  if (!said) { seen.quiet++; continue; }
  seen.said++;
  if (+said[1] !== ch.chance) bad.push(`${g.date}: said ${said[1]}%, the chance is ${ch.chance}%`);
  const wintry = /snow/.test(said[2]);
  if (wintry && !seen.snow) console.log(`  e.g. ${g.date}: ${paras[1]}\n        ${tail}`);
  if (wintry) seen.snow++;
  if (wintry !== (ch.kind === 'snow' || ch.kind === 'mix' || fo.snowCover)) bad.push(`${g.date}: kind ${ch.kind}, cover ${fo.snowCover}, said "${said[2]}"`);
  const cover = /cover the field/.test(tail), soft = /field will be soft|flood the field/.test(tail), drains = /drains well/.test(tail);
  if (cover) seen.cover++; if (soft) seen.soft++; if (drains) seen.drains++;
  if (cover !== (wintry && fo.snowCover)) bad.push(`${g.date}: cover said ${cover}, outlook ${fo.snowCover}`);
  if (!wintry && soft !== (fo.soggy || fo.washout)) bad.push(`${g.date}: soft said ${soft}, outlook soggy ${fo.soggy} washout ${fo.washout}`);
}
console.log(`  ${asked} home games asked about: ${JSON.stringify(seen)}`);
check('the between-games weather is told exactly when its chance is 30% or more, with that chance', bad.length === 0, bad.slice(0, 5).join(' | '));
check('some windows were told (rain or snow)', seen.said > 0);
check('quiet windows say nothing', seen.quiet > 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
