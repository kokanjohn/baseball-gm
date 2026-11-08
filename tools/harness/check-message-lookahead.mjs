// §121 (r139) The messages, known ahead.
//   node tools/harness/check-message-lookahead.mjs [windows=40] [seed=1] [hours=24]
// At moments through a season (and the offseason): look ahead `hours`, then
// SCRAMBLE the global random source (any draw on the world's path that isn't
// seeded now changes the real run), then play the real world through the same
// window — alternately as one reopen at its end (app closed) and in 5-minute
// steps (app open). Every message that reached Messages in the window must be
// the one foreseen: same id, card, sender, subject and moment.
// Between windows a simple GM answers what's waiting (inputs; never inside a window).
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { resolve as resolveCard } from '../../engine/CardEngine.js';
import { lookAheadMessages, catchUp } from '../../engine/LookAhead.js';
import { runAt, setClock } from '../../engine/Clock.js';

const W = parseInt(process.argv[2] || '40', 10);
const SEED = parseInt(process.argv[3] || '1', 10);
const H = parseFloat(process.argv[4] || '24') * 3600_000;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
let t = SM.get().schedule[0].gameTime - 30 * 3600_000;
clock.set(t); catchUp(t);

const sig = (m) => `${m.instanceId}|${m.cardId}|${m.sender}|${m.subject}|${m.arrivedAtMs}`;
const arrivals = (from, to) => (SM.get().inbox || []).filter(c => !c._seed && c.arrivedAtMs > from && c.arrivedAtMs <= to)
  .map(c => ({ instanceId: c.instanceId, cardId: c.cardId, sender: c.sender || null, subject: c.subject || null, arrivedAtMs: c.arrivedAtMs }));
const gm = () => {   // answer what's waiting: the first choice (an input, between windows)
  for (const c of (SM.get().inbox || []).filter(c => !c.resolved && !c.isCompose)) {
    try { resolveCard(c.instanceId, 'yes'); } catch { try { resolveCard(c.instanceId, 'no'); } catch { /* not answerable */ } }
  }
};

const bad = [];
let seen = 0, total = 0, ms = [], byCard = {};
for (let w = 0; w < W; w++) {
  const st = SM.get();
  if (!st.schedule?.length) break;
  gm(); catchUp(clock.get());
  // A window starts at a moment the dice choose (not on the hour).
  t += Math.floor((2 + (w * 7919 % 11)) * 3600_000 + (w * 104729 % 3600_000));
  clock.set(t); catchUp(t); gm();
  catchUp(t);   // the app runs the clock at the moment of an input (App: card:resolved → _runTick)
  const t0 = clock.get();
  const a = performance.now();
  const L = lookAheadMessages(t0, t0 + H);
  ms.push(performance.now() - a);
  seedRandom(SEED * 1000 + w + 7);   // scramble: unseeded draws now differ
  const open = w % 2 === 1;
  if (process.env.DUMPW && +process.env.DUMPW === w) {
    const s0 = SM.get();
    console.log('DUMP t0', new Date(t0).toISOString(), 'rosterStepAt', s0.rosterStepAt && new Date(s0.rosterStepAt).toISOString());
    for (const tx of (s0.transactions || []).filter(t => t.status !== 'done' && t.status !== 'applied')) console.log('  tx', JSON.stringify({ kind: tx.kind, type: tx.type, status: tx.status, eff: new Date(tx.effectiveAt).toISOString(), created: tx.createdAt && new Date(tx.createdAt).toISOString(), team: tx.teamId, from: tx.fromTeamId, to: tx.toTeamId }));
  }
  let trace = [];
  if (process.env.DBG2 && open && (!process.env.DBGW || +process.env.DBGW === w)) {
    // What changes, step by step, when a condition card appears (on a scratch copy).
    const sum = () => { const s = SM.get(); return {
      tx: (s.transactions || []).filter(t => t.status === 'pending').map(t => `${t.kind || t.type}:${t.playerId?.slice(0, 4)}@${new Date(t.effectiveAt).toISOString().slice(11, 16)}`).join(','),
      inj: Object.values(s.players).filter(p => p.teamId === 'user' && p.injury).map(p => `${p.name}:${p.injury.status}${p.isInjured ? '*' : ''}`).join(','),
      q: (s.ilReturnQueue || []).join(','), dl: s.userTeam.vacancyDeadlineAt, ros: (s.userTeam.rosterIds || []).length,
      rot: (s.userTeam.rotation?.order || []).join(',').slice(0, 40), cur: s.currentGameIndex, gst: s.schedule[s.currentGameIndex]?.status,
      cards: [...(s.inbox || []), ...(s.scheduledCards || [])].map(c => c.cardId).filter(x => /roster_need|lineup_return/.test(x)).length,
      rsa: s.rosterStepAt ? new Date(s.rosterStepAt).toISOString().slice(11, 19) : '',
      lost: Object.values(s.players).filter(p => p.teamId === 'user' && p._lostSlot).map(p => `${p.name}:${p.group}:${p.isInjured ? 'inj' : ''}${p.unavailable ? 'unav' : ''}${p.onPersonalLeave ? 'leave' : ''}${p.isSuspended ? 'susp' : ''}${p.away ? 'away:' + JSON.stringify(p.away) : ''}`).join(','),
      slots: (s.userTeam.lineupSlots || []).map(x => s.players[x.playerId]?.name || '-').join(',') }; };
    SM.speculate(() => runAt(t0, () => {
      let prev = sum();
      for (let x = t0 + 5 * 60_000; x < t0 + H; x += 5 * 60_000) {
        setClock(x); catchUp(x);
        const now = sum();
        if (now.cards > prev.cards) {
          trace.push(`   STEP ${new Date(x).toISOString().slice(5, 19)} new condition card(s)`);
          for (const k of Object.keys(now)) if (now[k] !== prev[k]) trace.push(`      ${k}: ${prev[k]}  →  ${now[k]}`);
        }
        prev = now;
      }
    }));
  }
  if (open) { for (let x = t0 + 5 * 60_000; x < t0 + H; x += 5 * 60_000) { clock.set(x); catchUp(x); } }
  clock.set(t0 + H); catchUp(t0 + H);
  const real = arrivals(t0, t0 + H);
  total += real.length; seen += L.messages.length;
  for (const m of real) byCard[m.cardId] = (byCard[m.cardId] || 0) + 1;
  const A = new Set(L.messages.map(sig)), B = new Set(real.map(sig));
  const missing = real.filter(m => !A.has(sig(m))), extra = L.messages.filter(m => !B.has(sig(m)));
  if (missing.length || extra.length) {
    const near = (m, list) => list.find(x => x.cardId === m.cardId);
    for (const m of missing.slice(0, 3)) { const n = near(m, extra); bad.push(`w${w} ${open ? 'open' : 'closed'} ${SM.get().phase}: real ${m.cardId} "${m.subject}" @${new Date(m.arrivedAtMs).toISOString().slice(5, 16)}${n ? ` vs foreseen "${n.subject}" @${new Date(n.arrivedAtMs).toISOString().slice(5, 16)}${n.instanceId !== m.instanceId ? ' (other id)' : ''}` : ' — not foreseen'}`); }
    for (const m of extra.filter(x => !missing.some(y => y.cardId === x.cardId)).slice(0, 2)) bad.push(`w${w} ${open ? 'open' : 'closed'}: foreseen ${m.cardId} "${m.subject}" never came`);
  }
  t = t0 + H;
  if (process.env.DBG) console.log(`w${w} ${open ? 'open  ' : 'closed'} ${SM.get().phase} ${real.length} real / ${L.messages.length} foreseen, ${Math.round(ms.at(-1))} ms${missing.length || extra.length ? '  MISMATCH' : ''}`);
  if (process.env.DBG && (missing.length || extra.length)) {
    for (const l of trace) console.log(l);
    for (const m of missing) console.log(`     real     ${m.cardId} ${m.instanceId.slice(0, 8)} @${new Date(m.arrivedAtMs).toISOString().slice(5, 19)} ${m.sender}: ${m.subject}`);
    for (const m of extra)   console.log(`     foreseen ${m.cardId} ${m.instanceId.slice(0, 8)} @${new Date(m.arrivedAtMs).toISOString().slice(5, 19)} ${m.sender}: ${m.subject}`);
  }
}
console.log(`\n${W} windows of ${H / 3600_000}h: ${total} messages arrived, ${seen} foreseen. Look-ahead ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms average, ${Math.round(Math.max(...ms))} max.`);
console.log('    by card:', Object.entries(byCard).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} ${v}`).join(', '));
check('every message that arrived was foreseen exactly (id, card, sender, subject, moment), app closed or open', bad.length === 0, `${bad.length} — ` + bad.slice(0, 6).join(' | '));
check('messages came in the windows', total > W);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
