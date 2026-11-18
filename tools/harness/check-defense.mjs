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
import { OVR_DEF_WEIGHT, DEF_IMP, DEF_GEN } from '../../data/constants.js';
import { valueAt } from '../../engine/Positions.js';
import { computePlayerIMP } from '../../engine/IMPEngine.js';
import { adviceFor } from '../../engine/RosterAdvice.js';
import * as CE from '../../engine/CardEngine.js';
import * as Dev from '../../engine/DevelopmentEngine.js';
import * as Coach from '../../engine/CoachEngine.js';
import { coachRead } from '../../engine/PlayerWork.js';
import { developForWinter } from '../../engine/OffseasonEngine.js';
import { computeAge } from '../../engine/PlayerFactory.js';
import { voiceProblems } from './voice-rules.mjs';

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

// ── r207 §122.85 phase 3: aging, young players, the bench coach ─────────
console.log('\nAge');
{
  const yr = baseballYear(S());
  const ageOf = (p) => computeAge(p.dob, yr);
  const lead = (lo, hi) => mean(hitters.filter(p => ageOf(p) >= lo && ageOf(p) <= hi).map(p => p.subRatings.defense - computeOVR({ ...p.subRatings, defense: 0 }, null, 'DH') - (DEF_GEN.bias[prim(p)] ?? 0)));
  const [young, prime, old] = [lead(23, 26), lead(27, 30), lead(32, 45)];
  check(`a veteran's glove is behind the bat, a younger player's isn't (23–26 ${young.toFixed(1)}, 27–30 ${prime.toFixed(1)}, 32+ ${old.toFixed(1)})`, young > old + 2 && prime > old + 2);
  // A winter, many times over, at a given age (copies; nothing saved).
  const base = hitters.find(p => (p.positions?.primary || p.pos) === 'SS');
  const winter = (age) => {
    let dDef = 0, dBat = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      const p = structuredClone(base); p.trait = null;
      p.subRatings = { contact: 60, power: 60, speed: 60, defense: 60 };
      const by = Number(String(p.dob).slice(0, 4));
      const nextYear = [by + age, by + age + 1].find(y => computeAge(p.dob, y) === age);
      const b0 = { ...p.subRatings };
      developForWinter(p, nextYear, 2, null, 0, null);
      dDef += p.subRatings.defense - b0.defense; dBat += (p.subRatings.contact + p.subRatings.power + p.subRatings.speed - 180) / 3; n++;
    }
    return { def: dDef / n, bat: dBat / n, n };
  };
  const at = [21, 26, 29, 32, 35].map(winter);
  check(`a winter: the glove grows young and fades sooner (glove/bat at 21 ${at[0].def.toFixed(1)}/${at[0].bat.toFixed(1)}, 26 ${at[1].def.toFixed(1)}/${at[1].bat.toFixed(1)}, 29 ${at[2].def.toFixed(1)}/${at[2].bat.toFixed(1)}, 32 ${at[3].def.toFixed(1)}/${at[3].bat.toFixed(1)}, 35 ${at[4].def.toFixed(1)}/${at[4].bat.toFixed(1)})`,
        at.every(x => x.n > 50) && at[0].def > at[0].bat && at[0].def > 1 && at[2].def < at[2].bat && at[3].def < at[3].bat && at[4].def < -3);
  const p0 = structuredClone(base); p0.subRatings.defense = 60;
  const ny = Number(String(p0.dob).slice(0, 4)) + 30;
  developForWinter(p0, ny, 2, null, 0, null);
  check(`the OVR follows the glove after a winter (${p0.ovr} = ${ovrFor(p0)})`, p0.ovr === ovrFor(p0));
  const staff = (spec, q) => ({ benchCoach: { name: 'B', quality: q, specialty: spec }, hittingCoach: { name: 'H', quality: 60, specialty: 'contact' } });
  check(`our bench coach's winter work: the glove is the bench coach's (defense specialist 80: +${Coach.winterBonus(staff('defense', 80), base, 'defense', 28).toFixed(2)}, baserunning 80: +${Coach.winterBonus(staff('baserunning', 80), base, 'defense', 28).toFixed(2)}, the hitting coach's contact unchanged)`,
        Coach.winterBonus(staff('defense', 80), base, 'defense', 28) > Coach.winterBonus(staff('baserunning', 80), base, 'defense', 28) + 0.4
        && Coach.winterBonus(staff('defense', 40), base, 'defense', 28) < Coach.winterBonus(staff('defense', 80), base, 'defense', 28)
        && Coach.winterBonus(staff('defense', 80), base, 'contact', 28) === Coach.winterBonus(staff('baserunning', 40), base, 'contact', 28));
  check('in-season work: a defense specialist gets more out of it',
        Coach.devFactor(staff('defense', 70), base, 28, 'defense') > Coach.devFactor(staff('baserunning', 70), base, 28, 'defense') * 1.2);
}

console.log('\nYoung players');
{
  const pool = (S().freeAgentPool || []).map(id => S().players[id]).filter(p => p && !['SP', 'RP'].includes(p.pos));
  const farm = Object.values(S().players).filter(p => p && !['SP', 'RP'].includes(p.pos) && computeAge(p.dob, baseballYear(S())) <= 23);
  check(`every young hitter has a glove, and an OVR that counts it (${farm.length} 23 and under, ${pool.length} free agents)`, farm.length > 20 && [...farm, ...pool].every(p => p.subRatings.defense >= 40 && p.ovr === ovrFor(p)));
}

console.log('\nThe bench coach on a hitter\'s glove (Compose)');
{
  const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
  const ask = (topicId, channelId, arg) => {
    const at = clock.get();
    CE.deliverComposeCard(topicId, channelId, { topicLabel: 'test', arg, nowMs: at });
    const pending = (S().scheduledCards || []).filter(c => c.isCompose && c._composeTopic === topicId).sort((a, b) => b._sentAtMs - a._sentAtMs)[0];
    clock.set(pending.deliverAtMs + 1000);
    CE.releaseDueCards(clock.get());
    return CE.getInbox().find(c => c.instanceId === pending.instanceId);
  };
  const ours = S().userTeam.lineupSlots.map(x => S().players[x.playerId]).filter(Boolean);
  const ss = ours.find(p => (p.positions?.primary || p.pos) !== 'DH');
  const arm = S().userTeam.rosterIds.map(id => S().players[id]).find(p => p?.pos === 'SP');
  check('a pitcher has no glove to work on', coachRead(S(), arm.id, 'defense', clock.get()) == null);
  SM.mutate(s => { const q = s.players[ss.id]; q.subRatings.defense = 46; q.ovr = ovrFor(q); });
  const read = coachRead(S(), ss.id, 'defense', clock.get());
  check(`${ss.name}'s glove (46) is the bench coach's call: focused work, ${read?.days} days`, read?.coach === 'benchCoach' && read.kind === 'focused' && read.days > 0);
  // The hitting coach busy with someone else doesn't hold the bench coach up.
  const other = ours.find(p => p.id !== ss.id);
  SM.mutate(s => { Dev.startPlan(s, other.id, { gain: 1, focus: ['contact'], source: 'test', owner: 'hittingCoach' }, clock.get()); });
  const c = ask('bc_defense', 'bench_coach', { playerId: ss.id });
  console.log(`    “${c?.subject}” (${c?.sender}) — ${c?.body?.replace(/\n+/g, ' ')}`);
  check('the reply: the glove where it stands, the days, the cost — a decision, the bench coach\'s', !!c && /defense is 46/.test(c.body) && /days away/.test(c.body)
        && /field and staff time/.test(c.body) && c._raw?.onYes === 'coach_work' && c._raw._workOwner === 'benchCoach' && c._raw._workSkill === 'defense' && c._raw._workSource === 'bc_defense');
  check('…in the coach\'s own voice, gender-neutral', !!c && voiceProblems(c, () => null).filter(([r]) => r !== 'deptSelf').length === 0 && !GEN.test(c.body), c?.body);
  CE.resolve(c.instanceId, 'yes');
  const plan = (S().developmentPlans || []).find(x => x.playerId === ss.id && x.status === 'active');
  check('yes: a plan on the glove runs, the bench coach\'s', !!plan && plan.owner === 'benchCoach' && plan.keys.join() === 'defense' && plan.from.defense === 46);
  check('…and the bench coach takes one player at a time', !!Dev.activeWork(S(), 'benchCoach') && !!Dev.activeWork(S(), 'hittingCoach'));
  const ovr0 = S().players[ss.id].ovr;
  SM.mutate(s => { const pl = s.developmentPlans.find(x => x.id === plan.id); for (const st of pl.steps) st.atMs = clock.get(); });
  SM.mutate(s => { Dev.applyDevelopment(s, clock.get() + 1000); });
  const after = S().players[ss.id];
  check(`the work lands in the glove and the OVR (defense 46 → ${after.subRatings.defense}, OVR ${ovr0} → ${after.ovr})`,
        after.subRatings.defense >= 46 && after.ovr === ovrFor(after) && (after.subRatings.defense === 46 || after.ovr >= ovr0));
  const dh = { ...ss, positions: { primary: 'DH', elig: ['DH'], fam: {} }, pos: 'DH' };
  SM.mutate(s => { s.players[ss.id].positions = { ...s.players[ss.id].positions, primary: 'DH' }; s.players[ss.id].pos = 'DH'; });
  const r2 = ask('bc_defense', 'bench_coach', { playerId: ss.id });
  check('a DH: the coach says it only pays off in the field', !!r2 && /only pays off if/.test(r2.body), r2?.body);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
