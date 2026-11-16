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
import * as When from '../../engine/When.js';

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
  const all0 = getPushSchedule(SM.get(), clock.get(), L);
  // (the game's own pushes — the weather's messages push under the same alerts, §122.58, and are checked below)
  const items = all0.filter(i => GAME_KINDS.has(i.kind) && String(i.id).startsWith('g:'));
  // The toggles, once: all off → no game pushes; final off → no final.
  if (!toggled && items.length) {
    const off = structuredClone(SM.get()); off.push.alerts = { weather: false, calledOff: false, injury: false, final: false };
    const noFinal = structuredClone(SM.get()); noFinal.push.alerts = { final: false };
    const msgOff = structuredClone(SM.get()); msgOff.push.alerts = { messages: false };
    toggled = {
      allOff: getPushSchedule(off, clock.get(), L).filter(i => GAME_KINDS.has(i.kind)).length,
      noFinal: getPushSchedule(noFinal, clock.get(), L).filter(i => i.kind === 'final').length,
      othersKept: getPushSchedule(noFinal, clock.get(), L).filter(i => GAME_KINDS.has(i.kind)).length === all0.filter(i => GAME_KINDS.has(i.kind) && i.kind !== 'final').length,
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
  const future0 = real.filter(r => r.at > from);
  // §122.51 at home the grounds crew's messages carry the weather, §122.58 on the road the traveling party's: each
  // delay, restart, held start and call is a message at its moment (pushed under Weather / Called Off), and there's no
  // game push for it.
  {
    const st1 = SM.get();
    const crew = [...(st1.inbox || []), ...(st1.scheduledCards || [])].filter(c => c._wxCrew && (c._wxGameTime === T0 || String(c._rosterKey).includes(`:${T0}:`)));
    const at = (c) => c.arrivedAtMs ?? c.deliverAtMs;
    for (const r of future0.filter(x => x.kind === 'weather' || x.kind === 'calledOff')) {
      tally[`crew_${r.what.split(' ')[0]}`] = (tally[`crew_${r.what.split(' ')[0]}`] || 0) + 1;
      const want = r.what === 'postponed' ? [':ppd'] : r.what === 'suspended' ? [':called:'] : r.what === 'weather_delay' ? [':delay:']
        : r.what === 'weather_resume' ? [':resumed:'] : null;
      if (!want) { if (r.what !== 'weather_resume (pre)' && !crew.some(c => /:(start_delayed|start_estimate|tarp_on|start_doubt):/.test(c._rosterKey) && at(c) <= r.at + 60_000)) bad.push(`game ${g0.index}: no crew word before the held start`); continue; }
      if (!crew.some(c => want.some(w => c._rosterKey.includes(w)) && Math.abs(at(c) - r.at) <= 60_000)) bad.push(`game ${g0.index}: no crew message for the real ${r.what} at ${new Date(r.at).toISOString()}`);
    }
    if (items.some(i => i.kind === 'weather' || i.kind === 'calledOff')) bad.push(`game ${g0.index}: a weather game push (its messages carry it)`);
    // (the message's own push, under the weather's alerts)
    const ids = new Set(crew.map(c => c.instanceId));
    tally.wxPushes = (tally.wxPushes || 0) + all0.filter(i => ids.has(i.id) && (i.kind === 'weather' || i.kind === 'calledOff')).length;
  }
  const future = future0.filter(x => x.kind !== 'weather' && x.kind !== 'calledOff');
  for (const r of future) {
    tally[r.what.split(' ')[0]] = (tally[r.what.split(' ')[0]] || 0) + 1;
    const it = items.find(i => i.kind === r.kind && i.deliverAt === r.at);
    if (!it) { bad.push(`game ${g0.index}: no push for the real ${r.what} at ${new Date(r.at).toISOString()}`); continue; }
    samples[r.what.split(' ')[0]] ||= `${it.title} — ${it.body}`;
    // r149 the makeup reads relative to the push ("tomorrow at 4:05 PM"), never a calendar date.
    if (r.makeup && !it.body.includes(`Makeup: ${When.untilFull(r.makeup, r.at)}`)) bad.push(`game ${g0.index}: postponed push without the real makeup time (${it.body})`);
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
check('every game push is a real event at its exact moment, and every real event had its push (the weather as its messages, home and road)', bad.length === 0, bad.slice(0, 5).join(' | '));
check('the look-ahead foresaw finals, our injuries and weather', (tally.final || 0) > 20 && (tally.hurt || 0) > 0 && ((tally.weather_delay || 0) + (tally.start || 0) + (tally.postponed || 0) + (tally.crew_weather_delay || 0) + (tally.crew_postponed || 0)) > 0, JSON.stringify(tally));
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
  const L = { gameTime: T, opponent: opp, isHome: false, postponed: null, boxScore: null,
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
  {
    // §122.51 the grounds crew near game time gets past quiet hours; the morning look waits for them to end.
    const s2 = structuredClone(st);
    s2.push.quietStart = '19:00'; s2.push.quietEnd = '08:00';
    const T2 = new Date(T); T2.setHours(21, 0, 0, 0);
    const card = (id, at, urgent) => ({ instanceId: id, sender: 'Head Groundskeeper', subject: 'x', deliverAtMs: at, expiresAtMs: at + 86_400_000, _wxCrew: true, ...(urgent ? { _urgent: true } : {}) });
    s2.scheduledCards = [card('crew-near', T2.getTime(), true), card('crew-morning', T2.getTime() + 60_000, false)];
    const ps = getPushSchedule(s2, T2.getTime() - 3600_000);
    const near = ps.find(i => i.id === 'crew-near'), morning = ps.find(i => i.id === 'crew-morning');
    check('quiet hours: the crew\'s word near game time is sent as it happens; other messages wait for the morning',
          near?.deliverAt === T2.getTime() && new Date(morning?.deliverAt).getHours() === 8, JSON.stringify(ps.map(i => [i.id, new Date(i.deliverAt).toString().slice(16, 21)])));
  }
  check('a held start, a delay and a suspension: no game pushes, home or road (their messages carry them)',
        ![false, true].some(h => gamePushes(st, { ...L, isHome: h }, T - 3600_000).some(i => i.kind === 'weather' || i.kind === 'calledOff')), JSON.stringify(titles));
  const L2 = { gameTime: T, opponent: opp, isHome: false, plays: [], boxScore: null, suspended: null,
               postponed: { decidedAt: T + 2 * 3600_000, reason: 'rain', calledBy: 'limit', startHeld: true, cancelled: false, makeupTime: T + 2 * 86_400_000, doubleheader: true } };
  check('a game called off: no game pushes (its message carries it)', gamePushes(st, L2, T - 3600_000).length === 0);
  // §122.58 the weather's messages push under the weather's alerts, and those toggles turn them off.
  {
    const s3 = structuredClone(st);
    const card = (id, extra) => ({ instanceId: id, sender: 'Travel Coordinator', subject: 'x', deliverAtMs: T, expiresAtMs: T + 86_400_000, _wxCrew: true, _urgent: true, ...extra });
    s3.scheduledCards = [card('wx-delay', {}), card('wx-ppd', { _wxCalledOff: true }), { instanceId: 'plain', sender: 'PR Dept.', subject: 'y', deliverAtMs: T, expiresAtMs: T + 86_400_000 }];
    const kinds = (alerts) => { s3.push.alerts = alerts; return Object.fromEntries(getPushSchedule(s3, T - 3600_000).filter(i => ['wx-delay', 'wx-ppd', 'plain'].includes(i.id)).map(i => [i.id, i.kind])); };
    const on = kinds({}), wxOff = kinds({ weather: false }), coOff = kinds({ calledOff: false }), msgOff = kinds({ messages: false });
    check('the weather\'s messages push as Weather, a postponement as Called Off, the rest as Messages — and each toggle turns off its own',
          on['wx-delay'] === 'weather' && on['wx-ppd'] === 'calledOff' && on.plain === 'messages' && !wxOff['wx-delay'] && wxOff['wx-ppd'] && !coOff['wx-ppd'] && coOff['wx-delay'] && !msgOff.plain && msgOff['wx-delay'],
          JSON.stringify({ on, wxOff, coOff, msgOff }));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
