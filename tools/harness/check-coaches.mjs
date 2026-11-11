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
check('every coach has a quality (40–90), a specialty of the role, and a salary by quality',
      Coach.COACH_ROLES.every(r => { const c = staff0[r]; return c.quality >= 40 && c.quality <= 90 && Coach.ROLE_INFO[r].specialties.includes(c.specialty) && c.salary === Coach.salaryFor(r, c.quality); }));
check('two coaches on one-year deals (a decision the first winter)', Coach.COACH_ROLES.filter(r => staff0[r].contractExpiry === (st.seasonNum || 1) + 1).length === 2);

const mkStaff = (q, specs) => Object.fromEntries(Coach.COACH_ROLES.map(r => [r, { name: r, quality: q, specialty: specs[r] }]));
const SPEC = { pitchingCoach: 'command', hittingCoach: 'contact', bullpenCoach: 'late', benchCoach: 'baserunning' };
const run = (staff, label) => {
  const t = { us: 0, them: 0, w: 0, bb: 0, sb: 0, err: 0, bs: 0, svo: 0 };
  for (let i = 0; i < N; i++) {
    const opp = st.leagueTeams[i % st.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st.phase, isSpring: false, norms, staff: staff && Coach.staffEffects(staff), rand: dice('check-coaches', i), injuryYear: baseballYear(st) });   // §118 the same dice for every staff, game by game: only the coach differs
    const end = r.plays.filter(p => p.cumOurScore != null).pop();
    t.us += end.cumOurScore; t.them += end.cumTheirScore; if (end.cumOurScore > end.cumTheirScore) t.w++;
    for (const p of r.plays) {
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
  console.log(`    ${label.padEnd(8)} runs ${f(t.us)} – ${f(t.them)} allowed, win ${(t.w / N).toFixed(3)}, walks ${f(t.bb)}, steals ${f(t.sb)}, errors ${f(t.err)}, BS ${t.bs}/${t.svo}`);
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
check(`a baserunning bench coach brings more steals (${(elite.sb / N).toFixed(2)} vs ${(poor.sb / N).toFixed(2)})`, elite.sb >= poor.sb);
{
  const v = Coach.staffEffects(Object.fromEntries(Coach.COACH_ROLES.map(r => [r, { vacant: true }])));
  check(`an empty chair coaches like a weak coach (every rating point ≤ 0, errors ×${v.errorMult.toFixed(2)}; vacant won ${empty.w}, neutral ${none.w} — noise at this size)`,
        [...Object.values(v.bat), ...Object.values(v.sp), ...Object.values(v.rp), v.late].every(x => x <= 0) && v.errorMult >= 1);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
