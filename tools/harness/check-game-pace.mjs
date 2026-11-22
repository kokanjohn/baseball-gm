/**
 * tools/harness/check-game-pace.mjs — r257 §122.136 each game at its own pace.
 *   - A day's games that start together end at different times (they used to end within a minute or two of each
 *     other: ten minutes a half-inning, every game), and Recent lists each final at its own time.
 *   - Nine innings take between about 2:30 and 3:40 with no weather; the pace is the game's (the same every time).
 *   - The weather plan's clock and the game's agree: a delay sits where the plan has it.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { gameTempo } from '../../engine/GameWeather.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { GAME_WEATHER as GW } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const H = 3_600_000, MIN = 60_000;

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(257);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const ours = S().schedule;
const stopAt = ours[3].gameTime + 6 * H;
for (let t = clock.get(); t < stopAt; t += 5 * MIN) {
  clock.set(t); tick();
  for (const g of S().schedule) if (g.status === 'final' && !g._committed && g.liveLineups) await commitGame(S().schedule.indexOf(g));
}

// Every finished game in those days: ours and the league's.
const games = [];
for (const g of S().schedule) if (g._committed && g.endedAt) games.push({ g, start: g.weather?.startAt ?? g.wx?.startAt ?? g.gameTime, user: true });
for (const list of Object.values(S().leagueSchedule?.dayMap || {})) for (const g of list) if (g.played && g.endedAt) games.push({ g, start: g.wx?.startAt ?? g.gameTime });
const clean = games.filter(({ g }) => !(g.wx?.delays || []).length && !g.weather?.delays?.length);
const mins = clean.map(({ g, start }) => (g.endedAt - start) / MIN);
const fmt = (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
check(`games played (${games.length}; ${clean.length} with no weather)`, clean.length >= 12);
check(`no-weather games take ${fmt(Math.min(...mins))} to ${fmt(Math.max(...mins))} (2:25–3:50, extra innings aside)`,
  mins.filter(m => m < 145).length === 0 && mins.filter(m => m > 230).length <= Math.ceil(clean.length * 0.1) && Math.max(...mins) - Math.min(...mins) >= 30);

// Games that started together end apart.
const byStart = new Map();
for (const x of games) { const k = x.g.gameTime; if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(x); }
const groups = [...byStart.values()].filter(a => a.length >= 3);
const spreads = groups.map(a => { const e = a.map(x => x.g.endedAt); return { n: a.length, distinct: new Set(e.map(t => Math.round(t / MIN))).size, spread: (Math.max(...e) - Math.min(...e)) / MIN }; });
check(`games that start together end at their own times (${spreads.map(s => `${s.n} games over ${Math.round(s.spread)} min`).join('; ')})`,
  spreads.length > 0 && spreads.every(s => s.distinct >= s.n - 1 && s.spread >= 12));

// Recent lists each final at its own time.
const feed = (S().activityFeed || []).filter(e => e.type === 'result');
const fStamps = feed.map(e => Math.round(e.timestamp / MIN));
check(`Recent: each final at its own time (${feed.length} finals, ${new Set(fStamps).size} different minutes)`, feed.length >= 8 && new Set(fStamps).size >= feed.length - 2);

// The pace is the game's: its plan's tempo, the same every time it's asked.
const ctx = weatherContext(S());
const withPlan = games.filter(({ g }) => g.wx?.tempo);
check(`every game's pace is its plan's (${withPlan.length}), within ${GW.TEMPO_MIN}–${GW.TEMPO_MAX}`,
  withPlan.length >= games.length - 2 && withPlan.every(({ g }) => g.wx.tempo >= GW.TEMPO_MIN && g.wx.tempo <= GW.TEMPO_MAX && g.wx.tempo === gameTempo(ctx, g.wx.venueId, g.wx.gameTime)));

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
