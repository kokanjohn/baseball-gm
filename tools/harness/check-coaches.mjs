// §112.2 Coaches with real abilities — checks.
//   node tools/harness/check-coaches.mjs [games=1500]
// A real league; the same matchup played with no staff effect, an elite staff
// and a poor staff (CoachEngine.staffEffects): runs, walks, steals, errors and
// win share move the right way and by a believable amount. Blown saves and
// save chances are recorded. Development and winter growth scale with quality.
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms, accumulateBox } from '../../engine/SimEngine.js';
import * as Coach from '../../engine/CoachEngine.js';

const N = parseInt(process.argv[2] || '1500', 10);   // fewer games: the run gaps are noise
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(2);   // (a typical club — a lopsided one saturates the win effect)
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const st = SM.get();
const players = st.players, user = st.userTeam;
const norms = leagueNorms([user, ...st.leagueTeams], players);
const T0 = st.schedule.find(g => !g.isSpring)?.gameTime;

console.log('The new staff');
const staff0 = user.coachingStaff;
for (const r of Coach.COACH_ROLES) console.log(`    ${r}: ${staff0[r].name}, ${staff0[r].quality} ${staff0[r].specialty}, ${staff0[r].salary}K, through ${staff0[r].contractExpiry}`);
check('every coach has a quality (40–90), a specialty of the role, and a salary by quality (±12% for the market)',
      Coach.COACH_ROLES.every(r => { const c = staff0[r], b = Coach.salaryFor(r, c.quality); return c.quality >= 40 && c.quality <= 90 && Coach.ROLE_INFO[r].specialties.includes(c.specialty) && c.salary >= b * 0.87 - 5 && c.salary <= b * 1.13 + 5; }));
check('no bullpen coach (r196): the pitching coach has the whole staff', !Coach.COACH_ROLES.includes('bullpenCoach') && !('bullpenCoach' in staff0));
{ // r196 pay varies: the same job at the same quality isn't always the same number
  const pays = Array.from({ length: 30 }, () => Coach.salaryFor('pitchingCoach', 60, Math.random));
  const lo = Math.min(...pays), hi = Math.max(...pays), base = Coach.salaryFor('pitchingCoach', 60);
  check(`a pitching coach's pay varies at the same quality (60: ${lo}K–${hi}K, going rate ${base}K, ${new Set(pays).size} different)`, new Set(pays).size >= 4 && lo >= base * 0.87 - 5 && hi <= base * 1.13 + 5);
}
check('two coaches on one-year deals (a decision the first winter)', Coach.COACH_ROLES.filter(r => staff0[r].contractExpiry === (st.seasonNum || 1) + 1).length === 2);

const mkStaff = (q, specs) => Object.fromEntries(Coach.COACH_ROLES.map(r => [r, { name: r, quality: q, specialty: specs[r] }]));
const SPEC = { pitchingCoach: 'command', hittingCoach: 'contact', benchCoach: 'baserunning' };
const run = (staff, label) => {
  const t = { us: 0, them: 0, w: 0, bb: 0, sb: 0, tag: 0, err: 0, bs: 0, svo: 0 };
  for (let i = 0; i < N; i++) {
    const opp = st.leagueTeams[i % st.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st.phase, isSpring: false, norms, staff: staff && Coach.staffEffects(staff), rand: dice('check-coaches', i), injuryYear: baseballYear(st) });   // §118 the same dice for every staff, game by game: only the coach differs
    const end = r.plays.filter(p => p.cumOurScore != null).pop();
    t.us += end.cumOurScore; t.them += end.cumTheirScore; if (end.cumOurScore > end.cumTheirScore) t.w++;
    let pb = { first: null, second: null, third: null }, ph = null;   // (r227 the bases before each play: tag-ups)
    for (const p of r.plays) {
      if (p._halfInning !== ph) { pb = { first: null, second: null, third: null }; ph = p._halfInning; }
      // r227 §122.106 a base taken on a caught fly (a tag-up) by one of ours
      if (p.type === 'flyout' || p.type === 'sac_fly') {
        const a = p._basesAfter || {};
        for (const [from, to] of [['third', null], ['second', 'third'], ['first', 'second']]) {
          const id = pb[from]; if (!id || players[id]?.teamId !== 'user') continue;
          if (to ? a[to] === id : (p.type === 'sac_fly' && !Object.values(a).includes(id))) t.tag++;
        }
      }
      if (p._basesAfter) pb = p._basesAfter;
      if (p.type === 'walk' && players[p.pitcherId]?.teamId === 'user') t.bb++;
      if (p.type === 'stolen_base' && players[p.runnerId || Object.keys(p._statDeltas || {})[0]]?.teamId === 'user') t.sb++;
      if ((p.type === 'error' || p.playMod === 'error' || /reaches on error/.test(p.description || '')) && players[p.batterId]?.teamId !== 'user') t.err++;
      for (const [id, ds] of Object.entries(p._statDeltas || {})) for (const d of ds) {
        if (players[id]?.teamId !== 'user') continue;
        if (d.stat === 'bs') t.bs += d.delta;
        if (d.stat === 'svo') t.svo += d.delta;
      }
    }
  }
  const f = (x) => (x / N).toFixed(2);
  console.log(`    ${label.padEnd(8)} runs ${f(t.us)} – ${f(t.them)} allowed, win ${(t.w / N).toFixed(3)}, walks ${f(t.bb)}, steals ${f(t.sb)}, tag-ups ${f(t.tag)}, errors ${f(t.err)}, BS ${t.bs}/${t.svo}`);
  return t;
};

console.log(`\nThe same schedule, ${N} games each`);
seedRandom(77); const none = run(null, 'neutral');
seedRandom(77); const elite = run(mkStaff(90, SPEC), 'elite');
seedRandom(77); const poor = run(mkStaff(40, SPEC), 'poor');
seedRandom(77); const empty = run(Object.fromEntries(Coach.COACH_ROLES.map(r => [r, { vacant: true }])), 'vacant');
const per162 = (a, b) => ((a.w - b.w) / N) * 162;
check(`an elite staff scores more and allows fewer than a poor one (+${((elite.us - poor.us) / N).toFixed(2)} runs, −${((poor.them - elite.them) / N).toFixed(2)} allowed a game)`,
      elite.us > poor.us && elite.them < poor.them);
check(`the effect is real but modest: elite vs poor ≈ ${per162(elite, poor).toFixed(1)} wins a season (2–9)`, per162(elite, poor) >= 2 && per162(elite, poor) <= 9);
check(`neutral sits between (wins: poor ${poor.w}, neutral ${none.w}, elite ${elite.w})`, poor.w <= none.w + N * 0.01 && none.w <= elite.w + N * 0.01);
check(`a command pitching coach cuts walks (${(elite.bb / N).toFixed(2)} vs ${(poor.bb / N).toFixed(2)})`, elite.bb < poor.bb);
// (r227 the coach's speed shows on the tag-ups too — a runner who tagged to third has no steal to try: bases taken, both)
check(`a baserunning bench coach takes more bases: steals and tag-ups (${((elite.sb + elite.tag) / N).toFixed(2)} vs ${((poor.sb + poor.tag) / N).toFixed(2)} a game)`, elite.sb + elite.tag >= poor.sb + poor.tag);
{
  const v = Coach.staffEffects(Object.fromEntries(Coach.COACH_ROLES.map(r => [r, { vacant: true }])));
  check(`an empty chair coaches like a weak coach (every rating point ≤ 0, errors ×${v.errorMult.toFixed(2)}; vacant won ${empty.w}, neutral ${none.w} — noise at this size)`,
        [...Object.values(v.bat), ...Object.values(v.sp), ...Object.values(v.rp)].every(x => x <= 0) && v.errorMult >= 1);
}
check(`blown saves and save chances recorded (${none.bs} blown in ${none.svo} chances)`, none.bs > 0 && none.svo > none.bs);

console.log('\nDevelopment');
const kid = Object.values(players).find(p => p.teamId === 'user' && p.pos !== 'SP' && p.pos !== 'RP');
const e = mkStaff(90, { ...SPEC, hittingCoach: 'youth' }), w = mkStaff(40, SPEC);
check(`in-season plans: elite youth coach ${Coach.devFactor(e, kid, 23).toFixed(2)}×, poor ${Coach.devFactor(w, kid, 23).toFixed(2)}×`,
      Coach.devFactor(e, kid, 23) > 1.3 && Coach.devFactor(w, kid, 23) < 0.85);
check(`winter growth: elite contact coach +${Coach.winterBonus(mkStaff(90, SPEC), kid, 'contact', 29).toFixed(2)} on contact, poor ${Coach.winterBonus(w, kid, 'power', 29).toFixed(2)} on power`,
      Coach.winterBonus(mkStaff(90, SPEC), kid, 'contact', 29) > 1 && Coach.winterBonus(w, kid, 'power', 29) < 0);

console.log('\nEvaluation');
const U = (rk, extra = {}) => ({ of: 16, spEra: { v: 4, rank: rk }, bb9: { v: 3, avg: 3.2, rank: rk }, k9: { v: 8, avg: 8, rank: rk },
  ops: { v: .7, rank: rk }, obp: { v: .32, avg: .32, rank: rk }, slg: { v: .4, avg: .4, rank: rk }, rpEra: { v: 4, rank: rk },
  sbPct: { v: .7, rank: rk }, bs: 10, svo: 50, sbN: 80, csN: 30, oneRun: { w: 20, l: 20 }, growth: { arms: 0, bats: 0, armsN: 0, batsN: 0 }, ...extra });
check('a top unit grades good, a bottom one poor', Coach.COACH_ROLES.filter(r => r !== 'benchCoach' && !Coach.ROLE_INFO[r].scout).every(r => Coach.evaluate(r, U(1)).verdict === 'good' && Coach.evaluate(r, U(16)).verdict === 'poor'));
const cands = Coach.candidates(st, 'pitchingCoach', U(14), { taken: new Set(Object.values(staff0).map(c => c.name)) });
console.log(`    candidates: ${cands.map(c => `${c.name} ${c.quality} ${c.specialty} ${c.salary}K (${c.background})`).join(' | ')}`);
check('two candidates: the first fits the need (command — walks ranked 14th), different names, not on the staff',
      cands[0].specialty === 'command' && cands[0].fits && cands[0].name !== cands[1].name && !Object.values(staff0).some(c => c.name === cands[0].name || c.name === cands[1].name));
const GENDERED = /\b(he|him|his|she|her|guys?|men|man)\b/i;
check('candidate backgrounds are gender-neutral', Object.values(Coach.ROLE_INFO).length && !cands.some(c => GENDERED.test(c.background)));

console.log('\nA save from before r196');
{
  const { migrate } = await import('../../store/schema.js');
  const old = JSON.parse(JSON.stringify(SM.get()));
  delete old._bullpenCoachFolded;
  old.userTeam.coachingStaff.bullpenCoach = { name: 'Oldpen', quality: 60, specialty: 'late', salary: 75, contractExpiry: 3 };
  old.scheduledCards = [...(old.scheduledCards || []),
    { instanceId: 'x1', isCompose: true, _composeTopic: 'bpc_roles', _composeChannel: 'bullpen_coach', deliverAtMs: 1 },
    { instanceId: 'x2', cardId: 'os_coach_hire', _coachRole: 'bullpenCoach', deliverAtMs: 1 }];
  old.inbox = [...(old.inbox || []), { instanceId: 'x3', cardId: 'os_coach_review', _coachRole: 'bullpenCoach' }];
  const m = migrate(old);
  const x1 = m.scheduledCards.find(c => c.instanceId === 'x1');
  check('the bullpen coach is gone, and the salary with them', !('bullpenCoach' in m.userTeam.coachingStaff));
  check(`a message asked of the bullpen coach is the pitching coach's (${x1?._composeTopic}, ${x1?._composeChannel})`, x1?._composeTopic === 'pc_roles' && x1?._composeChannel === 'pitching_coach');
  check('a review or hire for the job is withdrawn', !m.scheduledCards.some(c => c.instanceId === 'x2') && !m.inbox.some(c => c.instanceId === 'x3'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
