// r205 §122.83 Defense: a fourth hitter rating, in OVR by position, and on the field — each ball in play goes
// to a fielder, whose glove takes hits away or lets them through, makes (or doesn't make) errors, turns double
// plays, throws runners out. Errors stay near baseball's (about half a game a side) unless fielders are out of
// position. The play-by-play names the fielder; the box score counts the errors.
//   node tools/harness/check-defense.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { computeOVR, ovrFor, baseballYear } from '../../engine/PlayerFactory.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import { migrate } from '../../store/schema.js';
import { dice } from '../../engine/Dice.js';
import { OVR_DEF_WEIGHT, DEF_IMP } from '../../data/constants.js';
import { valueAt } from '../../engine/Positions.js';
import { computePlayerIMP } from '../../engine/IMPEngine.js';
import { adviceFor } from '../../engine/RosterAdvice.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const S = () => SM.get();
const DAY = 86_400_000, N = 400;

seedRandom(205);
await startNewGame({ archetypeId: 'lab', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const all = Object.values(S().players);
const hitters = all.filter(p => !['SP', 'RP'].includes(p.pos)), pitchers = all.filter(p => ['SP', 'RP'].includes(p.pos));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const prim = (p) => p.positions?.primary || p.pos;

console.log('\nThe rating');
check(`every hitter has a glove (${hitters.length}), no pitcher does`, hitters.every(p => p.subRatings.defense >= 40 && p.subRatings.defense <= 99) && pitchers.every(p => p.subRatings.defense == null));
check('every OVR counts it by the primary position', all.every(p => p.ovr === ovrFor(p)), all.filter(p => p.ovr !== ovrFor(p)).slice(0, 3).map(p => `${p.name} ${p.ovr}/${ovrFor(p)}`).join());
{
  const at = (pos) => mean(hitters.filter(p => prim(p) === pos).map(p => p.subRatings.defense - p.ovr));
  check(`shortstops and catchers field better than first basemen, DHs least (SS ${at('SS').toFixed(1)}, C ${at('C').toFixed(1)}, 1B ${at('1B').toFixed(1)}, DH ${at('DH').toFixed(1)} vs OVR)`,
        at('SS') > at('1B') && at('C') > at('1B') && at('1B') > at('DH'));
  const bat = { contact: 60, power: 60, speed: 60 };
  check('a great glove lifts a shortstop\'s OVR, not a DH\'s', computeOVR({ ...bat, defense: 90 }, null, 'SS') === Math.round(60 * (1 - OVR_DEF_WEIGHT.SS) + 90 * OVR_DEF_WEIGHT.SS)
        && computeOVR({ ...bat, defense: 90 }, null, 'DH') === 60 && computeOVR({ ...bat, defense: 90 }, null, '1B') < computeOVR({ ...bat, defense: 90 }, null, 'SS'));
}
{
  const st = structuredClone(S());
  delete st._defenseSeeded;
  const q = Object.values(st.players).find(p => !['SP', 'RP'].includes(p.pos));
  delete q.subRatings.defense;
  const m = migrate(st);
  check('an older save: every hitter gets a glove, once', m._defenseSeeded === true && m.players[q.id].subRatings.defense >= 40 && m.players[q.id].ovr === ovrFor(m.players[q.id]));
}

// ── On the field ───────────────────────────────────────────────
console.log(`\nOn the field: ${N} games`);
const st0 = S();
const norms = leagueNorms([st0.userTeam, ...st0.leagueTeams], st0.players);
check(`the league's glove by position (${Object.entries(norms.defenseBy || {}).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')})`, ['C', '1B', '2B', '3B', 'SS', 'OF'].every(k => norms.defenseBy?.[k] > 40));
const T0 = st0.schedule.find(g => !g.isSpring)?.gameTime;
const run = (players, user, label) => {
  const r0 = { games: 0, err: 0, errPlays: [], boxErr: 0, hitsAllowed: 0, named: 0, outs: 0, gems: 0, dp: 0, relay: 0, texts: [] };
  for (let i = 0; i < N; i++) {
    const opp = st0.leagueTeams[i % st0.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * DAY, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st0.phase, isSpring: false, norms, rand: dice('check-def', i), injuryYear: baseballYear(st0) });
    r0.games++;
    const ours = (id) => players[id]?.teamId === 'user';
    for (const p of r.plays) {
      if (p.type === 'error') { r0.err++; r0.errPlays.push(p); }
      if (!ours(p.batterId) && ['single', 'double', 'triple', 'hr'].includes(p.type)) r0.hitsAllowed++;
      if (['groundout', 'flyout'].includes(p.type)) { r0.outs++; if (/ to \w+ (at|in|behind) /.test(p.description)) r0.named++; }
      if (/takes a hit away|robbed|to rob|gets past a diving|drops in front of|over .*'s head/.test(p.description)) { r0.gems++; if (r0.texts.length < 6) r0.texts.push(p.description); }
      if (p.type === 'double_play') { r0.dp++; if (/ to .* to /.test(p.description)) r0.relay++; }
    }
    const box = r.boxScore;
    r0.boxErr += (box.away.errors || 0) + (box.home.errors || 0);
  }
  console.log(`    ${label.padEnd(18)} errors ${(r0.err / r0.games / 2).toFixed(2)} a side a game, hits allowed ${(r0.hitsAllowed / r0.games).toFixed(2)}, standout plays ${(r0.gems / r0.games).toFixed(2)} a game`);
  return r0;
};
seedRandom(9);
const base = run(st0.players, st0.userTeam, 'as built');
check(`errors near baseball's: ${(base.err / base.games / 2).toFixed(2)} a side a game (0.35–0.8)`, base.err / base.games / 2 >= 0.35 && base.err / base.games / 2 <= 0.8);
check('the box score counts every error', base.boxErr === base.err, `${base.boxErr} vs ${base.err}`);
check('each error names its fielder, on the side in the field', base.errPlays.every(p => p._fielderId && /error by /.test(p.description)
  && (st0.players[p._fielderId]?.teamId === 'user') !== (st0.players[p.batterId]?.teamId === 'user')), base.errPlays.find(p => !/error by /.test(p.description))?.description);
check(`outs name the fielder (${base.named} of ${base.outs})`, base.named > base.outs * 0.85);
check(`double plays name the relay (${base.relay} of ${base.dp})`, base.dp > 0 && base.relay > base.dp * 0.6);
check(`standout plays, now and then (${(base.gems / base.games).toFixed(2)} a game): ${base.texts.slice(0, 3).join(' | ')}`, base.gems / base.games > 0.1 && base.gems / base.games < 1.2);

// Our fielders' gloves: all great vs all poor (the same games, the same bats).
const glove = (v) => {
  const st = structuredClone(st0);
  for (const sl of st.userTeam.lineupSlots) if (sl.slot !== 'DH' && sl.playerId) st.players[sl.playerId].subRatings.defense = v;
  return st;
};
seedRandom(9); const great = run(glove(85).players, glove(85).userTeam, 'gloves 85');
seedRandom(9); const poor = run(glove(42).players, glove(42).userTeam, 'gloves 42');
check(`great gloves allow fewer hits than poor ones (${(great.hitsAllowed / N).toFixed(2)} vs ${(poor.hitsAllowed / N).toFixed(2)})`, great.hitsAllowed < poor.hitsAllowed * 0.97);
check(`…and make fewer errors (${(great.err / N).toFixed(2)} vs ${(poor.err / N).toFixed(2)} a game, both sides)`, great.err < poor.err);

// ── r206 §122.84 phase 2: value at a spot, Impact ──────────────────
console.log('\nValue at a spot');
{
  const bat = (c, d, pos) => ({ id: 'x' + c + d + pos, pos, positions: { primary: pos, elig: [pos], fam: {} }, subRatings: { contact: c, power: c, speed: c, defense: d } });
  const mk = (c, d, pos) => { const p = bat(c, d, pos); p.ovr = computeOVR(p.subRatings, null, pos); return p; };
  const glove = mk(55, 85, 'SS'), stick = mk(70, 45, 'SS');
  check(`at short, the glove can outweigh the bat (${valueAt(glove, 'SS')} vs ${valueAt(stick, 'SS')})`, valueAt(glove, 'SS') >= valueAt(stick, 'SS') - 2);
  check(`at DH, the bat alone (${valueAt(glove, 'DH')} vs ${valueAt(stick, 'DH')})`, valueAt(stick, 'DH') > valueAt(glove, 'DH') + 10);
  const ofAtSS = mk(65, 70, 'OF');
  check(`out of position, the glove counts less (${valueAt(ofAtSS, 'SS')} at SS vs ${valueAt({ ...ofAtSS, positions: { primary: 'OF', elig: ['OF', 'SS'], fam: {} } }, 'SS')} if eligible)`,
        valueAt(ofAtSS, 'SS') < valueAt({ ...ofAtSS, positions: { primary: 'OF', elig: ['OF', 'SS'], fam: {} } }, 'SS'));
  check('a player at the primary position: the OVR', valueAt(glove, 'SS') === glove.ovr && valueAt(stick, 'SS') === stick.ovr);
}
console.log('\nImpact');
{
  const line = { ab: 520, h: 140, tb: 210, hr: 15, rbi: 60, bb: 50, k: 100, sb: 5, cs: 2, g: 140 };
  const p = (pos, field) => ({ id: 'imp' + pos, pos, positions: { primary: pos, elig: [pos], fam: {} }, subRatings: { contact: 60, power: 60, speed: 60, defense: 60 },
    stats: { ...line, ...field }, careerStats: {}, _impGameLog: [] });
  const imp = (q) => computePlayerIMP(q, 140)?.impS ?? computePlayerIMP(q, 140)?.imp_s ?? null;
  const usual = (pos) => Math.round(DEF_IMP.eRate[pos] * 570);
  const avg = imp(p('SS', { e: usual('SS'), dSave: 5, dCost: 5 }));
  const gold = imp(p('SS', { e: usual('SS') - 6, dSave: 14, dCost: 3 }));
  const iron = imp(p('SS', { e: usual('SS') + 8, dSave: 2, dCost: 13 }));
  check(`a shortstop's glove counts: ${gold} (great) > ${avg} (average) > ${iron} (poor)`, gold > avg + 0.5 && avg > iron + 0.5, JSON.stringify(computePlayerIMP(p('SS', {}), 140)));
  const dhA = imp(p('DH', { e: 0, dSave: 14, dCost: 3 })), dhB = imp(p('DH', { e: 0, dSave: 0, dCost: 0 }));
  check(`a DH's doesn't (${dhA} = ${dhB})`, dhA === dhB);
  const fbGold = imp(p('1B', { e: usual('1B') - 6, dSave: 14, dCost: 3 })), fbAvg = imp(p('1B', { e: usual('1B'), dSave: 5, dCost: 5 }));
  check(`a first baseman's counts less than a shortstop's (${(fbGold - fbAvg).toFixed(1)} vs ${(gold - avg).toFixed(1)})`, fbGold - fbAvg < gold - avg && fbGold > fbAvg);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
