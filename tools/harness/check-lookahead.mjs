// §118 The look-ahead must match what really happens.
//   node tools/harness/check-lookahead.mjs [gameDays=30] [seed=1]
// For each of our games: at a random moment before it (sometimes the evening
// before, sometimes the morning of), LookAhead.lookAhead() plays the world
// forward on a scratch copy. Then the global random source is scrambled — any
// draw that still bypasses the seeded dice changes the real run and shows up
// as a mismatch — and the real day is played one of three ways:
//   open       the app is open: the clock steps every 5 minutes to first pitch
//   reopened   the app reopens during the game (one catch-up jump)
//   next day   the app reopens the next morning (the silent catch-up path)
// Our game's play-by-play must be identical, play for play, to the look-ahead.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { lookAhead } from '../../engine/LookAhead.js';
import { GAME_STATUS } from '../../data/constants.js';

const DAYS = parseInt(process.argv[2] || '30', 10);
const SEED = parseInt(process.argv[3] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const sig = (p) => `${p.type}|${p.batterId || ''}|${p.pitcherId || ''}|${p.inning}${p.half}|${p._timestamp}|${p.cumOurScore}-${p.cumTheirScore}|${p.description || ''}`;
const fmt = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: process.env.REGION || 'east' });
clock.set(SM.get().schedule[0].gameTime - 20 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

const MODES = ['open', 'reopened', 'next day'];
const tally = { open: 0, reopened: 0, 'next day': 0 };
const bad = [];
let prevEnd = clock.get();

for (let d = 0; d < DAYS; d++) {
  const st = SM.get();
  const g0 = st.schedule[st.currentGameIndex];
  if (!g0 || !Number.isFinite(g0.gameTime)) break;
  const idx = g0.index, T = g0.gameTime;
  // A moment to look from: between the last game and an hour before this one.
  const lo = Math.max(prevEnd, clock.get()), hi = g0.gameTime - 3600_000;
  const t0 = hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : lo;
  // The real world up to that moment (the app open then, 15-minute steps).
  for (let t = clock.get(); t < t0; ) { t = Math.min(t0, t + 15 * 60_000); clock.set(t); advanceClock(t); releaseDueCards(); }
  const L = lookAhead(clock.get());
  if (!L) break;

  // Scramble the global random source: a draw that isn't seeded now differs.
  seedRandom(SEED * 7919 + d * 104729 + 17);

  const mode = MODES[d % MODES.length];
  tally[mode]++;
  let real = null;
  const grab = () => { const g = SM.get().schedule[idx]; if (g?.plays?.length && !real) real = g.plays.map(sig); };
  if (mode === 'open') {
    for (let t = clock.get(); t < g0.gameTime; ) { t = Math.min(g0.gameTime, t + 5 * 60_000); clock.set(t); tick(); releaseDueCards(); }
  } else if (mode === 'reopened') {
    clock.set(g0.gameTime + 30 * 60_000 + Math.floor(Math.random() * 90 * 60_000)); tick(); releaseDueCards();
  } else {
    clock.set(g0.gameTime + 15 * 3600_000); tick(); releaseDueCards();
  }
  grab();
  // Play it out and commit.
  for (let guard = 0; guard < 4000; guard++) {
    const g = SM.get().schedule[idx];
    grab();
    if (!g || g._committed) break;
    if (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.POSTPONED || g.cancelled) { await commitGame(idx); break; }
    if (g.status === GAME_STATUS.LIVE) { const np = g.plays?.[g.livePlayIndex]; clock.set(Math.max(clock.get(), np ? np._timestamp + 1000 : clock.get() + 60_000)); }
    else clock.set(clock.get() + 10 * 60_000);
    tick(); releaseDueCards();
  }
  const gEnd = SM.get().schedule[idx];
  prevEnd = clock.get();

  const look = L.plays.map(sig);
  // The committed box is kept (plays are dropped at commit, §8.1): it must match in every mode;
  // the plays must match wherever the real run showed them before the commit.
  const boxSame = !!L.boxScore && JSON.stringify(L.boxScore) === JSON.stringify(gEnd?.boxScore);
  const same = boxSame && (!real || (look.length === real.length && look.every((s, i) => s === real[i])));
  // No game at all: both must be the same postponement, called at the same moment.
  const postponedBoth = (!L.plays.length && !real && L.wx?.outcome === gEnd?.wx?.outcome && L.wx?.decidedAt === gEnd?.wx?.decidedAt
    && (gEnd?.status === GAME_STATUS.POSTPONED || gEnd?.cancelled))
    // …or moved to a makeup the look-ahead named (it then plays that day — another game, looked at on its own).
    || (!!L.postponed && !L.plays.length && L.postponed.makeupTime === gEnd?.gameTime
        && (gEnd?.postponements || []).some(p => p.gameTime === T && p.decidedAt === L.postponed.decidedAt && p.reason === L.postponed.reason));
  const note = `${fmt(g0.gameTime)} vs ${g0.opponent} · looked from ${((g0.gameTime - t0) / 3600_000).toFixed(1)}h before · ${mode}`;
  if (same || postponedBoth) {
    console.log(`  ✓ ${note} · ${look.length} plays${real ? '' : ' (box only: plays dropped at commit)'}${postponedBoth ? ` (postponed — called ${fmt(L.wx?.decidedAt ?? L.postponed.decidedAt)}${L.postponed?.makeupTime ? `, made up ${fmt(L.postponed.makeupTime)}` : ''}, as foreseen)` : ''}`);
  } else {
    const i = real ? look.findIndex((s, k) => s !== real[k]) : -1;
    bad.push(note);
    console.log(`  ✗ ${note} · box ${boxSame ? 'same' : 'differs'} · look-ahead ${look.length} plays, real ${real?.length ?? 'not seen'}${i >= 0 ? ` · first difference at play ${i}:\n      look: ${look[i]}\n      real: ${real[i]}` : ''}`);
  }
}

console.log('');
check(`every look-ahead matched the real game, play for play (${DAYS} games: ${Object.entries(tally).map(([m, n]) => `${n} ${m}`).join(', ')})`,
      bad.length === 0, `${bad.length} differed`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
