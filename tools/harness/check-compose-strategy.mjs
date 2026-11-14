// r169 Compose: how the club plays, and the cleaned-up menu.
//   - the batting order (Manager): three styles; the sim and the Manager's reply use the same order
//   - the running game (Bench Coach): run more / less moves steal attempts, and who goes
//   - the hook (Manager): a quick hook shortens starts, a long leash lengthens them
//   - a reliever's role (Bullpen Coach): the GM's closer gets the ninth
//   - a promotion (Ticket Office): starts the promotion, charges its cost, lifts the crowd
//   - Media Relations, Community Affairs and Facilities are gone; the duplicate topics are merged
//   node tools/harness/check-compose-strategy.mjs [games]
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import { bullpenRoles } from '../../engine/PitchingEngine.js';
import { COMPOSE_TOPICS } from '../../engine/ComposeReplies.js';
import * as Strat from '../../engine/Strategy.js';
import { crowdFor } from '../../engine/FinanceEngine.js';
import { liveUntil } from './drive.mjs';
import { voiceProblems } from './voice-rules.mjs';
import { PROMOTIONS, PLAYER_GROUP } from '../../data/constants.js';

const N = parseInt(process.argv[2] || '500', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

// ── The menu ────────────────────────────────────────────────────
console.log('The Compose menu');
const gone = ['mgr_matchup', 'mgr_rotation', 'pc_reliever', 'hc_lineup', 'fac_status', 'tix_renewals', 'mr_narrative', 'ca_event', 'bc_morale'];
check('the removed and merged topics are gone', gone.every(t => !COMPOSE_TOPICS.includes(t)));
check('the new ones are there', ['mgr_hook', 'bc_tactics', 'bpc_roles', 'tix_promo'].every(t => COMPOSE_TOPICS.includes(t)));
const inbox = (await import('node:fs')).readFileSync(new URL('../../ui/screens/InboxScreen.js', import.meta.url), 'utf8');
check('Media Relations, Community Affairs, Facilities: no longer recipients', !/id:\s+'(media_relations|community|facilities)'/.test(inbox));

// ── A club, three weeks in ──────────────────────────────────────
seedRandom(169);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id], U = () => S().userTeam;
const first = S().schedule.find(g => !g.isSpring).gameTime;
await liveUntil(first + 20 * DAY);

/** Ask a topic through Compose; the reply as it lands. */
function ask(topicId, channelId, arg = null) {
  CE.deliverComposeCard(topicId, channelId, { topicLabel: 'test', arg, nowMs: clock.get() });
  const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === topicId).sort((a, b) => b._sentAtMs - a._sentAtMs)[0];
  clock.set(Math.max(clock.get(), pending.deliverAtMs + 1000));
  CE.releaseDueCards(clock.get());
  return CE.getInbox().find(c => c.instanceId === pending.instanceId);
}
const voiceOk = (c) => !!c && !GEN.test(c.body) && voiceProblems(c, () => null).filter(([r]) => r !== 'deptSelf').length === 0;

// ── The batting order ───────────────────────────────────────────
console.log('The batting order (Manager)');
const nine = U().lineupSlots.map(s => P(s.playerId));
const orders = Object.fromEntries(Object.keys(Strat.ORDER_STYLES).map(k => [k, Strat.battingOrder(nine, k).map(p => p.id)]));
check('every style is all nine, once', Object.values(orders).every(o => o.length === 9 && new Set(o).size === 9));
check('"best bats at the top": the four best overall hit first through fourth', new Set(orders.best.slice(0, 4)).size === 4
      && [...nine].sort((a, b) => b.ovr - a.ovr).slice(0, 4).every(p => orders.best.slice(0, 4).includes(p.id)));
const lineupCard = ask('mgr_lineup', 'manager');
console.log(`    “${lineupCard?.subject}” — ${lineupCard?.body?.split('\n').slice(0, 3).join(' / ')}`);
console.log(`      [${(lineupCard?._choices || []).map(c => c.label).join(' | ')}]`);
check('the Manager\'s reply: the order now, three choices (recommended first)', !!lineupCard && lineupCard._choices?.length === 3 && lineupCard._choices.every(c => /^order:/.test(c.key)) && voiceOk(lineupCard));
const pickOrder = lineupCard._choices.find(c => c.key === 'order:best');
CE.resolve(lineupCard.instanceId, 'yes', { pick: pickOrder.key });
check('tapped "Best Bats at the Top": the club\'s order style is set', Strat.strategyOf(U()).order === 'best');
const st0 = S();
const norms = leagueNorms([st0.userTeam, ...st0.leagueTeams], st0.players);
const opp = st0.leagueTeams[0];
const one = generatePlays({ isHome: true, gameTime: clock.get() + DAY, weather: null, fieldCondition: null }, st0.userTeam, opp, st0.players,
                          { phase: st0.phase, isSpring: false, norms, rand: dice('strategy-order', 1), injuryYear: baseballYear(st0) });
const firstBatters = [];
for (const p of one.plays) if (p.half === 'BOT' && p.batterId && !firstBatters.includes(p.batterId)) firstBatters.push(p.batterId);
const avail = Strat.battingOrder(nine.filter(p => !p.unavailable && !p.isInjured), 'best').map(p => p.id);
check('…and the sim bats them in that order', firstBatters.slice(0, 4).join() === avail.slice(0, 4).join(), `${firstBatters.slice(0, 4).map(id => P(id)?.name)} vs ${avail.slice(0, 4).map(id => P(id)?.name)}`);

// ── The sim, by style ───────────────────────────────────────────
const run = (mut, label, watch = null) => {
  const st = structuredClone(S());
  st._watch = watch;
  mut(st.userTeam);
  const r0 = { sbA: 0, sb: 0, spOuts: 0, games: 0, closerSv: 0, saves: 0 };
  seedRandom(7);
  for (let i = 0; i < N; i++) {
    const o = st.leagueTeams[i % st.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: clock.get() + i * DAY, weather: null, fieldCondition: null };
    // (each game on fresh arms: the style, not the workload, is what's measured)
    for (const id of st.userTeam.rosterIds) { const p = st.players[id]; if (p) { p.arm = []; p.load = 0; } }
    const r = generatePlays(g, st.userTeam, o, st.players, { phase: st.phase, isSpring: false, norms, rand: dice('strategy', label, i), injuryYear: baseballYear(st) });
    const ours = (id) => id && st.players[id]?.teamId === 'user';
    let starter = null;
    for (const p of r.plays) {
      if ((p.type === 'stolen_base' || p.type === 'caught_stealing') && ours(Object.keys(p._statDeltas || {})[0])) { r0.sbA++; if (p.type === 'stolen_base') r0.sb++; }
      if (ours(p.pitcherId) && !starter) starter = p.pitcherId;
      if (p.pitcherId === starter) for (const d of p._statDeltas?.[starter] || []) if (d.stat === 'ip') r0.spOuts += Math.round(d.delta * 3);
      for (const [id, ds] of Object.entries(p._statDeltas || {})) for (const d of ds) if (d.stat === 'sv' && ours(id)) { r0.saves++; if (id === (st.userTeam.penRoles?.closer || st._watch)) r0.closerSv++; }
    }
    r0.games++;
  }
  return r0;
};
console.log(`The running game (${N} games each)`);
const rLess = run(u => { u.strategy = { run: 'less' }; }, 'less'), rNorm = run(u => { u.strategy = { run: 'normal' }; }, 'normal'), rMore = run(u => { u.strategy = { run: 'more' }; }, 'more');
const f = (r) => `${(r.sbA / N).toFixed(2)} tries a game, ${(r.sb / Math.max(1, r.sbA) * 100).toFixed(0)}% safe`;
console.log(`    less: ${f(rLess)} · normal: ${f(rNorm)} · more: ${f(rMore)}`);
check("run less: fewer tries, the rate as good or better", rLess.sbA < rNorm.sbA * 0.75 && rLess.sb / rLess.sbA >= rNorm.sb / rNorm.sbA - 0.05);
check('run more: more tries, a worse rate (slower runners go)', rMore.sbA > rNorm.sbA * 1.3 && rMore.sb / rMore.sbA < rNorm.sb / rNorm.sbA);

console.log(`The hook (${N} games each)`);
const hQ = run(u => { u.strategy = { hook: 'quick' }; }, 'q'), hN = run(u => { u.strategy = { hook: 'normal' }; }, 'n'), hL = run(u => { u.strategy = { hook: 'long' }; }, 'l');
const ipS = (r) => (r.spOuts / 3 / N).toFixed(2);
console.log(`    the starter's innings: quick ${ipS(hQ)} · normal ${ipS(hN)} · long ${ipS(hL)}`);
check('a quick hook: shorter starts', hQ.spOuts < hN.spOuts * 0.93);
check('a long leash: longer starts', hL.spOuts > hN.spOuts * 1.04);

// ── A reliever's role ───────────────────────────────────────────
console.log('A reliever\'s role (Bullpen Coach)');
const auto = bullpenRoles(U(), S().players);
const pick = U().rosterIds.map(P).filter(p => p.group === PLAYER_GROUP.BULLPEN && p.id !== auto.closer && p.pos === 'RP').sort((a, b) => a.ovr - b.ovr)[0];
const roleCard = ask('bpc_roles', 'bullpen_coach', { playerId: pick.id, skill: 'closer', label: pick.name });
console.log(`    “${roleCard?.subject}” — ${roleCard?.body?.replace(/\n+/g, ' / ')}  [${roleCard?.yesLabel} / ${roleCard?.noLabel}]`);
check('the coach\'s read (who closes now, who the manager would pick), a decision', !!roleCard && roleCard._raw?.onYes === 'pen_role' && /the manager would go with/i.test(roleCard.body) && voiceOk(roleCard));
CE.resolve(roleCard.instanceId, 'yes');
const now = bullpenRoles(U(), S().players);
check(`yes: ${pick.name} closes (the manager's pick, ${P(auto.closer)?.name}, goes back in the pen)`, now.closer === pick.id && (now.setup.includes(auto.closer) || now.middle.includes(auto.closer)));
const sv = run(u => { u.penRoles = { closer: pick.id, setup: [] }; u.strategy = {}; }, 'closer');
const sv0 = run(u => { u.penRoles = null; u.strategy = {}; }, 'closer', pick.id);
check(`…and gets the saves in the sim (${sv.closerSv} of ${sv.saves}; ${sv0.closerSv} of ${sv0.saves} when the manager picks)`, sv.saves > 10 && sv.closerSv / sv.saves >= 0.5 && sv.closerSv / sv.saves > 3 * sv0.closerSv / Math.max(1, sv0.saves));
const back = ask('bpc_roles', 'bullpen_coach', { playerId: pick.id, skill: 'auto', label: pick.name });
CE.resolve(back.instanceId, 'yes');
check('"Back to the Manager\'s Call": the manager picks again', bullpenRoles(U(), S().players).closer === auto.closer);

// ── The running game and the hook through Compose ──────────────
console.log('The running game (Bench Coach) and the hook (Manager)');
const runCard = ask('bc_tactics', 'bench_coach');
console.log(`    “${runCard?.subject}” — ${runCard?.body?.split('\n').filter(Boolean).slice(-2).join(' / ')}  [${(runCard?._choices || []).map(c => c.label).join(' | ')}]`);
check('the Bench Coach: the record on the bases, three choices', !!runCard && runCard._choices?.length === 3 && voiceOk(runCard));
CE.resolve(runCard.instanceId, 'yes', { pick: 'run:less' });
check('tapped "Run Less": set', Strat.strategyOf(U()).run === 'less');
const hookCard = ask('mgr_hook', 'manager');
console.log(`    “${hookCard?.subject}” — ${hookCard?.body?.split('\n').filter(Boolean)[1]}  [${(hookCard?._choices || []).map(c => c.label).join(' | ')}]`);
check('the Manager on the hook: three choices', !!hookCard && hookCard._choices?.length === 3 && voiceOk(hookCard));
CE.resolve(hookCard.instanceId, 'yes', { pick: 'hook:long' });
check('tapped "Long Leash": set (the batting order kept)', Strat.strategyOf(U()).hook === 'long' && Strat.strategyOf(U()).order === 'best');

// ── A promotion ─────────────────────────────────────────────────
console.log('A promotion (Ticket Office)');
const promoCard = ask('tix_promo', 'ticket_office');
console.log(`    “${promoCard?.subject}” — ${promoCard?.body?.split('\n').filter(Boolean).slice(1).join(' / ')}`);
check('the Ticket Office: what each would do, a choice of three', !!promoCard && promoCard._choices?.length === 3 && promoCard._choices.every(c => /^promo:/.test(c.key)) && voiceOk(promoCard));
const g = S().schedule.find(x => !x._committed && x.isHome && x.gameTime > clock.get());
const before = crowdFor(S(), 'user', { atMs: g.gameTime, expected: true }).attendance;
const funds0 = U().finances.funds, atmo0 = U().atmosphere;
CE.resolve(promoCard.instanceId, 'yes', { pick: 'promo:giveaway' });
const pr = PROMOTIONS.giveaway;
const after = crowdFor(S(), 'user', { atMs: g.gameTime, expected: true }).attendance;
check(`giveaway nights: on for ${pr.games} home games, ${pr.costPerGameK * pr.games}K paid, the crowd up (${before} → ${after})`,
      U().finances.promo?.gamesLeft === pr.games && Math.round(funds0 - U().finances.funds) === pr.costPerGameK * pr.games && after > before && U().atmosphere > atmo0);
const again = ask('tix_promo', 'ticket_office');
check('asked again while it runs: one at a time, no decision', !!again && !again._choices && /already have a promotion running/.test(again.body));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
