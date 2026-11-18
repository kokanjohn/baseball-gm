// r200 §122.77 A contract's price counts how the player played (OffseasonEngine.performanceShift):
// the season's Impact, read back as an OVR, pulls the price's OVR toward it — more with a full
// season behind it, less for relievers, never more than MARKET_PERF.maxShift; last season fills in
// for what this one hasn't shown (and is the season that counts once it's been logged). The
// re-sign card says whether the ask is up or down, and why when performance moved it a lot.
//   node tools/harness/check-market-perf.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { performanceShift, marketTerms, applyRelease, signFreeAgent, freeAgents, cutBy } from '../../engine/OffseasonEngine.js';
import { signBlocker } from '../../engine/FreeAgency.js';
import { signToClub } from '../../engine/MarketEngine.js';
import { deliverResignCard, releaseDueCards, getInbox } from '../../engine/CardEngine.js';
import { MARKET_PERF } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(4242);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const base = SM.get();
const L = base.leagueTalentOffset || 0;
const impFor = (ovr) => MARKET_PERF.impAt0 + MARKET_PERF.impPer * (ovr - L);   // plays exactly like this OVR
const pick = (pred) => Object.values(base.players).find(p => p.teamId && pred(p));
const hitter = pick(p => !['SP', 'RP'].includes(p.pos) && p.ovr >= 60 && p.ovr <= 68);
const rp = pick(p => p.pos === 'RP' && p.ovr >= 58 && p.ovr <= 66);

// a state where only `p` has a line: this season's stats/impS, and last season (or none)
function scene(p, { imp = null, ab = 0, ip = 0, last = false } = {}) {
  const st = structuredClone(base);
  const q = st.players[p.id];
  q.stats = { ...(q.stats || {}), ab, bb: 0, ip };
  if (!last) q.seasonLog = [];
  st.impScores = imp == null ? {} : { [p.id]: { impS: imp } };
  return { st, q };
}

console.log('\nNo line, no price change');
{
  const { st, q } = scene(hitter);
  check('a player with no season and no history: shift 0', performanceShift(st, q).shift === 0, JSON.stringify(performanceShift(st, q)));
  const t = marketTerms(st, q), t0 = marketTerms(st, { ...q, seasonLog: [] });
  check('…and the price is the rating\'s price', t.salary === t0.salary);
}

console.log('\nA hitter who plays like his rating: no change');
{
  const { st, q } = scene(hitter, { imp: impFor(hitter.ovr), ab: 520 });
  check('Impact at the rating\'s level: shift ~0', Math.abs(performanceShift(st, q).shift) <= 0.1, performanceShift(st, q).shift);
}

console.log('\nA breakout and a slump');
{
  const up = scene(hitter, { imp: impFor(hitter.ovr + 6), ab: 520 });
  const s = performanceShift(up.st, up.q).shift;
  check('a full season 6 OVR better: shift = 6 × weight', Math.abs(s - 6 * MARKET_PERF.weight.hitter) <= 0.15, s);
  const half = scene(hitter, { imp: impFor(hitter.ovr + 6), ab: 250 });
  const sh = performanceShift(half.st, half.q).shift;
  check('half a season: about half the move', sh > 0 && sh < s * 0.65, `${sh} vs ${s}`);
  const down = scene(hitter, { imp: impFor(hitter.ovr - 6), ab: 520 });
  check('a slump the same size: the same move down', Math.abs(performanceShift(down.st, down.q).shift + s) <= 0.15, performanceShift(down.st, down.q).shift);
  const big = scene(hitter, { imp: impFor(hitter.ovr + 40), ab: 520 });
  check('never past maxShift', performanceShift(big.st, big.q).shift === MARKET_PERF.maxShift, performanceShift(big.st, big.q).shift);
  const pu = marketTerms(up.st, up.q).salary, pd = marketTerms(down.st, down.q).salary, p0 = marketTerms(up.st, { ...up.q, seasonLog: [], id: '_none' }).salary;
  check('the breakout asks more, the slump less', pu > p0 && pd < p0, `${pd} < ${p0} < ${pu}`);
}

console.log('\nRelievers move less on the same gap');
{
  const r = scene(rp, { imp: impFor(rp.ovr + 6), ip: 60 });
  const s = performanceShift(r.st, r.q).shift;
  check('a full reliever season 6 better: shift = 6 × RP weight', Math.abs(s - 6 * MARKET_PERF.weight.RP) <= 0.15, s);
}

console.log('\nLast season fills in');
{
  const withHist = Object.values(base.players).find(p => p.teamId && !['SP', 'RP'].includes(p.pos)
    && (p.seasonLog || []).some(x => x?.stats?.ab >= 300));
  const off = scene(withHist, { last: true });       // no season yet (the offseason, or opening day)
  const r = performanceShift(off.st, off.q);
  check('no season yet: last season sets the move', r.now.sample === 0 && r.last.sample > 0 && r.last.imp != null, JSON.stringify(r));
  const lastOnly = MARKET_PERF.prevWeight * Math.min(1, r.last.sample);
  check('…at its lower weight (never more than prevWeight × weight of the gap)',
    Math.abs(r.shift) <= Math.abs(((r.last.imp - MARKET_PERF.impAt0) / MARKET_PERF.impPer + L - withHist.ovr)) * MARKET_PERF.weight.hitter * lastOnly + 0.1, r.shift);
  const both = scene(withHist, { imp: impFor(withHist.ovr), ab: 520, last: true });
  check('a full season played at the rating outweighs last season', Math.abs(performanceShift(both.st, both.q).shift) <= 0.1, performanceShift(both.st, both.q).shift);
}

console.log('\nThe price never jumps between rating tiers');
{
  let prev = 0, ok = true, at = '';
  for (let d = -12; d <= 12; d += 0.25) {
    const { st, q } = scene(hitter, { imp: impFor(hitter.ovr + d), ab: 520 });
    const sal = marketTerms(st, q).salary;
    if (sal < prev || sal > 6000) { ok = false; at = `${d}: ${prev} → ${sal}`; break; }
    prev = sal;
  }
  check('the ask rises steadily with the season (no tier gaps)', ok, at);
}

console.log('\nThe re-sign card');
{
  SM.mutate(d => {
    const q = Object.values(d.players).find(p => p.teamId === 'user' && !['SP', 'RP'].includes(p.pos) && p.ovr >= 60);
    q.contractSalary = 5000; q.stats = { ...(q.stats || {}), ab: 520, bb: 0 }; delete q._ask;
    d.impScores = { ...(d.impScores || {}), [q.id]: { impS: impFor(q.ovr - 10) } };
    d._testResign = q.id;
  });
  const id = SM.get()._testResign;
  const at = clock.get();
  deliverResignCard(id, at, at + 7 * 86_400_000);
  releaseDueCards();
  const c = getInbox().find(x => x.cardId === 'os_resign' && x._targetPlayerId === id);
  const body = c?.body || '';
  check('a cheaper ask says "down from"', /\(down from \$/.test(body), body.slice(0, 400));
  check('…and says the down season took air out of it', /down season/.test(body));
  check('…and "saves"', /That saves/.test(body));
}

console.log('\nA player we released won\'t sign back with us');
{
  const st = structuredClone(SM.get());
  const q = Object.values(st.players).find(p => p.teamId === 'user' && !['SP', 'RP'].includes(p.pos) && p.id !== st._testResign);
  applyRelease(st, q.id, clock.get());
  check('released: a free agent, from us', q.group === 'freeAgent' && cutBy(q, 'user'));
  check('the sign button is blocked for us', !!signBlocker(st, q.id), String(signBlocker(st, q.id)));
  check('not in the free agents we\'re shown', !freeAgents(st, 'user').some(p => p.id === q.id) && freeAgents(st).some(p => p.id === q.id));
  check('signFreeAgent refuses us', signFreeAgent(st, q.id, 'user', clock.get()) === null && q.group === 'freeAgent');
  check('signToClub refuses us', signToClub(st, q.id, 'user', clock.get()).length === 0 && q.group === 'freeAgent');
  const cpu = st.leagueTeams[0].id;
  check('another club can sign the player', !cutBy(q, cpu) && signToClub(st, q.id, cpu, clock.get()).length > 0 && q.group !== 'freeAgent', q.group);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
