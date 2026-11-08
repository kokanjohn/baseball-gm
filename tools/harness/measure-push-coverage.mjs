/**
 * tools/harness/measure-push-coverage.mjs
 * DEV/TEST ONLY — which messages can reach the phone while the app is closed?
 *
 * A push needs the card to exist (in state.scheduledCards, synced to the
 * worker) BEFORE its delivery moment, while the app is closed. Whether it can
 * depends on WHAT made it:
 *   commit   — our game's commit plans the next window's pool cards: ahead. Pushable.
 *   decision — a card answered (follow-ups, trade answers decided at send): ahead. Pushable.
 *   clock    — GameEngine.advanceClock: the trade desk, offseason days, roster
 *              events, CPU games, weather, paydays. The clock only runs while
 *              the app is open; closed, it replays on reopen. NOT pushable today.
 *   tick     — our live game's play reveal (in-game cards). Only while open.
 * Plays one season, the postseason and the offseason to spring, with a simple
 * GM, and attributes every card that reaches the inbox to the step that made it.
 *
 *   node tools/harness/measure-push-coverage.mjs [seed=1]     ARCH=contender
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve as resolveCard, getInbox } from '../../engine/CardEngine.js';
import { GAME_STATUS, PHASE, OFFSEASON_DAYS } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
const ARCH = process.env.ARCH || 'contender';

// ── Attribution ──────────────────────────────────────────────────
let op = 'setup';
const born = new Map();      // instanceId → { op, seenAt, deliverAt, cardId, phase }
const arrived = new Map();   // instanceId → record (reached the inbox)
function observe() {
  const st = SM.get();
  const ph = st.phase;
  for (const c of st.scheduledCards || []) {
    if (!born.has(c.instanceId)) born.set(c.instanceId, { op, seenAt: clock.get(), deliverAt: c.deliverAtMs, ...who(c), phase: ph, seed: !!c._seed });
  }
  for (const c of st.inbox || []) {
    if (!born.has(c.instanceId)) born.set(c.instanceId, { op, seenAt: clock.get(), deliverAt: c.arrivedAtMs, ...who(c), phase: ph, seed: !!c._seed, direct: true });
    if (!arrived.has(c.instanceId)) arrived.set(c.instanceId, { ...born.get(c.instanceId), arrivedAt: c.arrivedAtMs, compose: !!c.isCompose });
  }
}
/** What a card is: its id (or roster key / sender when it has none), pool, kind. */
function who(c) {
  const id = c.cardId || (c._tradeOffer ? 'trade_offer' : null) || (c._rosterKey ? 'rk:' + c._rosterKey.split(':')[0] : null) || 'sender:' + (c.sender || '?');
  return { cardId: id, pool: c._pool || null, roster: !!c._rosterKey, moment: c._moment || null, subject: c.subject };
}
const run = (label, fn) => { op = label; const r = fn(); observe(); return r; };
const runAsync = async (label, fn) => { op = label; const r = await fn(); observe(); return r; };

// ── A simple GM (as multi-season.mjs) ────────────────────────────
const seen = new Set();
function gmActs() {
  for (let guard = 0; guard < 60; guard++) {
    const c = getInbox().find(x => !seen.has(x.instanceId) && !(x._seed && x._tradeOffer)
      && (x.autoResolve === 'roster' || !!x._rosterKey || (!!x._tradeOffer && !x._seed) || x._choices || x.yesLabel));
    if (!c) break;
    seen.add(c.instanceId);
    const r = Math.random();
    let ans = r < 0.45 ? 'yes' : r < 0.78 ? 'no' : null;
    let pick = null;
    if (c.cardId === 'il_return') { ans = r < 0.9 ? 'yes' : 'no'; pick = c._choices?.[0]?.key ?? null; }
    if (ans) run('decision', () => { try { resolveCard(c.instanceId, ans, { pick }); } catch { /* a card the GM can't take */ } });
  }
}
const live = () => { run('clock', () => advanceClock(clock.get())); run('release', () => releaseDueCards()); gmActs(); };

function stepTo(t) {
  for (let guard = 0; guard < 400; guard++) {
    const next = (SM.get().scheduledCards || []).map(c => c.deliverAtMs).filter(x => x > clock.get() && x < t).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    clock.set(next + 1000); live();
  }
}

function playToFinal(idx) {
  for (let guard = 0; guard < 6000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g) return false;
    if (g.status === GAME_STATUS.FINAL) return true;
    if (g.status === GAME_STATUS.POSTPONED && g.cancelled) return true;
    if (g.status === GAME_STATUS.SCHEDULED || g.status === GAME_STATUS.PRE_GAME_WATCH
        || (g.status === GAME_STATUS.SUSPENDED && g.gameTime > clock.get())) {
      live();
      const id0 = g.id, t0 = g.gameTime;
      stepTo(t0 || clock.get());
      const now = SM.get().schedule[idx];
      if (!now || now.id !== id0 || now.gameTime !== t0) continue;
      clock.set((t0 || clock.get()) + 60_000);
    } else if (g.status === GAME_STATUS.LIVE) {
      const np = g.plays?.[g.livePlayIndex];
      if (np && np._timestamp) clock.set(np._timestamp + (g._tickOffset || 0) + 1_000);
      else clock.advance(60_000);
    } else clock.advance(60 * 60_000);
    run('tick', () => tick()); run('release', () => releaseDueCards());
  }
  return false;
}

// ── Main: a season, the postseason, the offseason ────────────────
seedRandom(SEED);
await startNewGame({ archetypeId: ARCH, gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: process.env.REGION || 'east' });
observe();
let games = 0;
for (let guard = 0; guard < 8000; guard++) {
  const st = SM.get();
  if (st.phase === PHASE.SEASON_SUMMARY || st.phase === PHASE.OFFSEASON) break;
  const idx = st.currentGameIndex;
  const g = st.schedule[idx];
  if (g && !g._committed) {
    if (!playToFinal(idx)) break;
    await runAsync('commit', () => commitGame(idx)); run('release', () => releaseDueCards()); gmActs(); games++;
    continue;
  }
  let next = Infinity;
  for (const cg of Object.values(st.leagueSchedule?.dayMap || {}).flat()) {
    if (cg.played) continue;
    const t = cg.status === GAME_STATUS.LIVE && cg.plays?.length ? cg.plays[cg.plays.length - 1]._timestamp : cg.gameTime;
    if (t > clock.get() - 1 && t < next) next = t;
  }
  const sched = (st.scheduledCards || []).map(c => c.deliverAtMs).filter(t => t > clock.get());
  if (sched.length) next = Math.min(next, ...sched);
  if (!Number.isFinite(next)) clock.advance(6 * 3600_000); else clock.set(next + 1000);
  live();
}
for (let g = 0; g < 200 && SM.get().phase !== PHASE.SEASON_SUMMARY && SM.get().phase !== PHASE.OFFSEASON; g++) { clock.advance(3600_000); live(); }
const tSeasonEnd = clock.get();
for (let h = 0; h < 24 * (OFFSEASON_DAYS + 4); h++) {
  clock.advance(3600_000); live();
  if (SM.get().phase === PHASE.SPRING_TRAINING) break;
}
const tEnd = clock.get();

// ── Report ───────────────────────────────────────────────────────
const recs = [...arrived.values()].filter(r => !r.seed && r.op !== 'setup');
const t0 = Math.min(...recs.map(r => r.arrivedAt));
import('node:fs').then(fs => fs.writeFileSync(`/tmp/cov-${ARCH}-${SEED}.json`, JSON.stringify({ recs, tSeasonEnd, tEnd })));
const days = (a, b) => (b - a) / 86_400_000;
const family = (r) => r.compose ? 'compose reply' : r.cardId.replace(/[:\-].*$/, '');
const inOffseason = (r) => r.arrivedAt >= tSeasonEnd;
// tick() runs the roster clock first, so its cards are clock cards. A commit
// both plans the next window's pool cards (ahead) and settles the final out
// (injuries, roster moves: made at that moment, only when the commit runs).
const bucket = (r) => {
  if (r.op === 'clock' || r.op === 'tick') return 'clock (made on reopen)';
  if (r.op === 'commit') return lead(r) >= 30 * 60_000 && !r.roster ? 'game commit: planned ahead' : 'game commit: final out (on reopen)';
  if (r.op === 'decision') return 'a decision (planned)';
  return r.op;
};
const lead = (r) => (r.deliverAt ?? r.arrivedAt) - r.seenAt;

function table(title, list, ndays) {
  console.log(`\n${title}: ${list.length} messages over ${ndays.toFixed(0)} days (${(list.length / ndays).toFixed(1)}/day)`);
  const by = {};
  for (const r of list) (by[bucket(r)] = by[bucket(r)] || []).push(r);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    const pct = (100 * v.length / list.length).toFixed(0);
    const fam = {};
    for (const r of v) fam[family(r)] = (fam[family(r)] || 0) + 1;
    const top = Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, n]) => `${f} ${n}`).join(', ');
    const leads = v.map(lead).filter(Number.isFinite).sort((a, b) => a - b);
    const med = leads.length ? leads[Math.floor(leads.length / 2)] : null;
    console.log(`  ${k.padEnd(28)} ${String(v.length).padStart(4)}  ${pct.padStart(3)}%   median lead ${med == null ? '—' : (med / 3600_000).toFixed(1) + 'h'}`);
    console.log(`      ${top}`);
  }
}
table('Season (spring, regular season, postseason)', recs.filter(r => !inOffseason(r)), days(t0, tSeasonEnd));
table('Offseason', recs.filter(inOffseason), days(tSeasonEnd, tEnd));
console.log(`\n${ARCH} seed ${SEED}: ${games} of our games; ${recs.length} messages reached the inbox.`);
