// §120 (r138) Game pushes from the look-ahead.
//   node tools/harness/check-game-pushes.mjs [ourGames=70] [seed=1]
// For each of our games: 10 hours before first pitch, the push schedule is
// built from the look-ahead (as the app does when it goes to the background).
// Then the real game is played. Every game push must be a real event at its
// exact moment (no stale or invented push), and every real event — start held,
// delay, play resuming, postponed, suspended, our player hurt, the final —
// must have had its push. Then: the Settings toggles, and the reminder for a
// game already called off.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards, getPushSchedule } from '../../engine/CardEngine.js';
import { lookAhead } from '../../engine/LookAhead.js';
import { GAME_STATUS } from '../../data/constants.js';
import { gamePushes } from '../../engine/GamePushes.js';

const N = parseInt(process.argv[2] || '70', 10);
const SEED = parseInt(process.argv[3] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GAME_KINDS = new Set(['weather', 'calledOff', 'injury', 'final']);

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
// No quiet hours here (a one-minute window at 03:00): every push at its moment.
SM.mutate(s => { s.push = { ...(s.push || {}), quietStart: '03:00', quietEnd: '03:01' }; });
clock.set(SM.get().schedule[0].gameTime - 20 * 3600_000);
tick(); releaseDueCards();

const bad = [], tally = {}, samples = {};
let games = 0, toggled = null, moot = null;
for (let n = 0; n < N; n++) {
  const st = SM.get();
  const g0 = st.schedule[st.currentGameIndex];
  if (!g0) break;
  const T0 = g0.gameTime, opp = g0.opponent;
  const from = Math.max(clock.get(), T0 - 10 * 3600_000);
  clock.set(from); tick(); releaseDueCards();
  const L = lookAhead(clock.get());
  const items = getPushSchedule(SM.get(), clock.get(), L).filter(i => GAME_KINDS.has(i.kind));
  // The toggles, once: all off → no game pushes; final off → no final.
  if (!toggled && items.length) {
    const off = structuredClone(SM.get()); off.push.alerts = { weather: false, calledOff: false, injury: false, final: false };
    const noFinal = structuredClone(SM.get()); noFinal.push.alerts = { final: false };
    const msgOff = structuredClone(SM.get()); msgOff.push.alerts = { messages: false };
    toggled = {
      allOff: getPushSchedule(off, clock.get(), L).filter(i => GAME_KINDS.has(i.kind)).length,
      noFinal: getPushSchedule(noFinal, clock.get(), L).filter(i => i.kind === 'final').length,
      othersKept: getPushSchedule(noFinal, clock.get(), L).filter(i => GAME_KINDS.has(i.kind)).length === items.filter(i => i.kind !== 'final').length,
      msgs: getPushSchedule(msgOff, clock.get(), L).filter(i => i.kind === 'messages').length,
    };
  }

  // ── The real game ───────────────────────────────────────────
  const find = () => {
    const s = SM.get().schedule;
    return s.find(x => x.gameTime === T0 && x.opponent === opp && !x.postponements?.some(p => p.gameTime === T0))
        || s.find(x => x.opponent === opp && x.postponements?.some(p => p.gameTime === T0))
        || s.find(x => x.opponent === opp && x.suspension?.gameTime === T0);
  };
  let g = null, plays = null;
  for (let guard = 0; guard < 4000; guard++) {
    g = find();
    if (!g) break;
    if (g.plays?.length) plays = g.plays;
    if (g.postponements?.some(p => p.gameTime === T0) || g.status === GAME_STATUS.SUSPENDED || g.status === GAME_STATUS.FINAL || g._committed) break;
    if (g.status === GAME_STATUS.LIVE) { const np = g.plays?.[g.livePlayIndex]; clock.set(Math.max(clock.get() + 1000, np?._timestamp ? np._timestamp + 1000 : clock.get() + 60_000)); }
    else clock.set(Math.max(clock.get() + 10 * 60_000, Math.min(T0, clock.get() + 3 * 3600_000)));
    tick(); releaseDueCards();
  }
  games++; if (process.env.DBG) console.log(n, g0.index, new Date(T0).toISOString(), g?.status, g?._committed, (plays||[]).length, items.length, SM.get().currentGameIndex);
  // Real events (ours), each with its moment.
  const real = [];
  const ppd = g?.postponements?.find(p => p.gameTime === T0);
  if (ppd) {
    if (ppd.decidedAt > T0) real.push({ kind: 'weather', at: T0, what: 'start held' });
    real.push({ kind: 'calledOff', at: ppd.decidedAt, what: 'postponed', makeup: g.cancelled ? null : g.gameTime });
  } else for (const p of (plays || [])) {
    if (!Number.isFinite(p._timestamp)) continue;
    if (p.type === 'weather_delay' || p.type === 'weather_resume') real.push({ kind: 'weather', at: p._timestamp, what: p.type + (p._wx?.pre ? ' (pre)' : '') });
    if (p.type === 'injury' && SM.get().players[p._injury.playerId]?.teamId === 'user') real.push({ kind: 'injury', at: p._timestamp, what: `hurt ${p._injury.playerId}` });
    if (p.type === 'game_suspended') real.push({ kind: 'calledOff', at: p._timestamp, what: 'suspended', resume: g.status === GAME_STATUS.SUSPENDED ? g.gameTime : null });
    if (p.type === 'game_end') real.push({ kind: 'final', at: p._timestamp, what: `final ${p.cumOurScore}-${p.cumTheirScore}` });
  }
  const future = real.filter(r => r.at > from);
  for (const r of future) {
    tally[r.what.split(' ')[0]] = (tally[r.what.split(' ')[0]] || 0) + 1;
    const it = items.find(i => i.kind === r.kind && i.deliverAt === r.at);
    if (!it) { bad.push(`game ${g0.index}: no push for the real ${r.what} at ${new Date(r.at).toISOString()}`); continue; }
    samples[r.what.split(' ')[0]] ||= `${it.title} — ${it.body}`;
    if (r.makeup && !it.body.includes(new Date(r.makeup).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))) bad.push(`game ${g0.index}: postponed push without the real makeup date (${it.body})`);
    if (r.resume && !it.body.includes(new Date(r.resume).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))) bad.push(`game ${g0.index}: suspended push without the real resume date (${it.body})`);
    if (r.kind === 'final') {
      const [u, t] = r.what.split(' ')[1].split('-');
      if (!it.title.includes(` ${u}, `) || !it.title.endsWith(` ${t}`)) bad.push(`game ${g0.index}: final push ${it.title} vs real ${u}-${t}`);
    }
  }
  for (const it of items) {
    if (!future.some(r => r.kind === it.kind && r.at === it.deliverAt)) bad.push(`game ${g0.index}: a push for something that didn't happen: ${it.title} @ ${new Date(it.deliverAt).toISOString()}`);
  }
  // The reminder for a game called off before it.
  if (!moot && ppd && ppd.decidedAt <= T0 - 30 * 60_000) moot = { ok: !items.some(i => i.id === `game-reminder-${T0}`) && !getPushSchedule(SM.get(), from, L).some(i => i.id === `game-reminder-${T0}`) };
  // On: finish it (a suspended game waits for its day) and commit.
  if (g && (g.status === GAME_STATUS.FINAL || g.status === GAME_STATUS.POSTPONED) && !g._committed) await commitGame(g.index);
  clock.set(clock.get() + 60_000); tick(); releaseDueCards();
}

console.log(`\n${games} of our games; real events foreseen: ${JSON.stringify(tally)}`);
for (const [k, v] of Object.entries(samples)) console.log(`    ${k}: ${v}`);
check('every game push is a real event at its exact moment, and every real event had its push', bad.length === 0, bad.slice(0, 5).join(' | '));
check('the look-ahead foresaw finals, our injuries and weather', (tally.final || 0) > 20 && (tally.hurt || 0) > 0 && ((tally.weather_delay || 0) + (tally.start || 0) + (tally.postponed || 0)) > 0, JSON.stringify(tally));
check('Settings: all game kinds off → no game pushes; Final Score off → no final, the rest kept; Messages off → no inbox pushes',
      !!toggled && toggled.allOff === 0 && toggled.noFinal === 0 && toggled.othersKept && toggled.msgs === 0, JSON.stringify(toggled));
if (moot) check('no "first pitch in 30 minutes" for a game already postponed', moot.ok);
else console.log('    (no game postponed before its reminder in this run)');
// ── The rare ones, on a made-up look-ahead (none may come up in a run) ──
{
  const st = structuredClone(SM.get());
  const T = Date.UTC(2031, 5, 10, 23, 5);   // 7:05 PM Eastern
  const opp = st.leagueTeams[0].name;
  const P = (o) => ({ inning: 1, half: 'TOP', cumOurScore: 0, cumTheirScore: 0, ...o });
  const wx = (startT, endT, pre, reason = 'lightning') => ({ startT, endT, minutes: Math.round((endT - startT) / 60000), reason, pre });
  const L = { gameTime: T, opponent: opp, isHome: true, postponed: null, boxScore: null,
              suspended: { atMs: T + 4 * 3600_000, resumeDate: '2031-06-11', resumeTime: T + 86_400_000 - 6 * 3600_000 },
              plays: [
                P({ type: 'weather_delay', _timestamp: T, description: 'The start is delayed — lightning in the area.', _wx: wx(T, T + 45 * 60_000, true) }),
                P({ type: 'weather_resume', _timestamp: T + 45 * 60_000, description: '', _wx: wx(T, T + 45 * 60_000, true) }),
                P({ type: 'single', _timestamp: T + 50 * 60_000, inning: 6, half: 'BOT', cumOurScore: 3, cumTheirScore: 1 }),
                P({ type: 'weather_delay', _timestamp: T + 3 * 3600_000, inning: 6, half: 'BOT', description: 'The rain picks up — the tarp is coming out.', _wx: wx(T + 3 * 3600_000, T + 4 * 3600_000, false, 'rain') }),
                P({ type: 'game_suspended', _timestamp: T + 4 * 3600_000, inning: 6, half: 'BOT', cumOurScore: 3, cumTheirScore: 1, description: 'The game is suspended in the bottom of the 6th.' }),
              ] };
  st.push.quietStart = '03:00'; st.push.quietEnd = '03:01';
  const all = gamePushes(st, L, T - 3600_000);
  console.log('\nThe rare ones (a made-up game):');
  all.forEach(i => console.log(`    ${new Date(i.deliverAt).toISOString().slice(11, 16)}  ${i.title} — ${i.body}`));
  const titles = all.map(i => i.title.split(':')[0]);
  check('a held start, the first pitch after it, a delay and a suspension each get their push, in order', JSON.stringify(titles) === JSON.stringify(['Start delayed', 'Under way', 'Rain delay', 'Suspended']), JSON.stringify(titles));
  check('…the suspension names the score and when it resumes', /Testers lead 3–1/.test(all[3]?.body || '') && /resumes/.test(all[3]?.body || ''), all[3]?.body);
  // Quiet hours over the evening: the delays are dropped; the suspension waits for the morning.
  st.push.quietStart = '21:00'; st.push.quietEnd = '08:00';
  const q = gamePushes(st, L, T - 3600_000);
  const susp = q.find(i => i.title.startsWith('Suspended'));
  check('quiet hours: a delay inside them is not sent; the suspension waits until they end',
        !q.some(i => i.title.startsWith('Rain delay')) && !!susp && susp.deliverAt > T + 4 * 3600_000 && new Date(susp.deliverAt).getHours() === 8,
        JSON.stringify(q.map(i => [i.title, new Date(i.deliverAt).toString().slice(16, 21)])));
  // A held start, then called off.
  const L2 = { gameTime: T, opponent: opp, isHome: false, plays: [], boxScore: null, suspended: null,
               postponed: { decidedAt: T + 2 * 3600_000, reason: 'rain', calledBy: 'limit', startHeld: true, cancelled: false,
                            makeupTime: T + 2 * 86_400_000, doubleheader: true } };
  st.push.quietStart = '03:00'; st.push.quietEnd = '03:01';
  const p2 = gamePushes(st, L2, T - 3600_000);
  p2.forEach(i => console.log(`    ${new Date(i.deliverAt).toISOString().slice(11, 16)}  ${i.title} — ${i.body}`));
  check('a start held then called off: "Start delayed" at first pitch, then "Postponed" with the makeup doubleheader',
        p2.length === 2 && p2[0].deliverAt === T && p2[1].deliverAt === T + 2 * 3600_000 && /doubleheader/.test(p2[1].body), JSON.stringify(p2.map(i => i.title)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
