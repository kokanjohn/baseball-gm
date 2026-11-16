// §122.64 Managers with a rating and a style — checks.
//   node tools/harness/check-managers.mjs [games=3000]
// Every club has a manager (rating, style) and plays the style; the same
// schedule played with an elite, a league-typical and a poor manager of ours
// (the CPU managers held at 60): the late, close games move the wins about
// ±2 a season. Overruling the style halves the edge and wears on the
// relationship. The winter: CPU clubs let losing managers go, the market,
// our search's two candidates, the hire.
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import * as M from '../../engine/ManagerEngine.js';
import { strategyOf } from '../../engine/Strategy.js';
import * as CardEngine from '../../engine/CardEngine.js';
import { hardGates } from '../../engine/OffseasonEngine.js';

const N = parseInt(process.argv[2] || '3000', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(2);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const st = SM.get();
const players = st.players, user = st.userTeam;

console.log('The managers');
const ours = user.coachingStaff.manager;
console.log(`    ours: ${ours.name}, ${ours.quality} ${ours.style}, ${ours.salary}K`);
for (const t of st.leagueTeams) console.log(`    ${t.abbr}: ${t.manager?.name}, ${t.manager?.quality} ${t.manager?.style}`);
const all = [ours, ...st.leagueTeams.map(t => t.manager)];
check('every club has a manager with a rating (40–90) and a style', all.every(m => m?.name && m.quality >= 40 && m.quality <= 90 && M.MANAGER_STYLES[m.style]));
check('no two managers share a name, and none is one of our staff', new Set(all.map(m => m.name)).size === all.length
      && !Object.entries(user.coachingStaff).some(([k, c]) => k !== 'manager' && all.some(m => m.name === c?.name)));
check('ours is paid by the rating', ours.salary === M.salaryFor(ours.quality));
check('every club starts on its manager\'s style (no one overruled)', [user, ...st.leagueTeams].every(t => !M.overruled(t)));
const styles = new Set(all.map(m => m.style));
check(`the CPU clubs play different styles (${[...styles].join(', ')})`, styles.size >= 3);

// The same schedule, our manager's rating changed (CPU managers at 60).
const norms = leagueNorms([user, ...st.leagueTeams], players);
const T0 = st.schedule.find(g => !g.isSpring)?.gameTime;
for (const t of st.leagueTeams) t.manager.quality = 60;
const run = (q, label, { overrule = false } = {}) => {
  ours.quality = q;
  M.applyStyle(user);
  if (overrule) { const s = M.styleOf(ours); user.strategy = { ...strategyOf(user), [s.part]: 'normal' }; }
  const t = { w: 0, close: 0, closeW: 0, us: 0, them: 0 };
  for (let i = 0; i < N; i++) {
    const opp = st.leagueTeams[i % st.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st.phase, isSpring: false, norms, staff: null, rand: dice('check-managers', i), injuryYear: baseballYear(st) });
    const end = r.plays.filter(p => p.cumOurScore != null).pop();
    const won = end.cumOurScore > end.cumTheirScore;
    t.us += end.cumOurScore; t.them += end.cumTheirScore; if (won) t.w++;
    if (Math.abs(end.cumOurScore - end.cumTheirScore) <= 2) { t.close++; if (won) t.closeW++; }
  }
  console.log(`    ${label.padEnd(10)} win ${(t.w / N).toFixed(3)}, runs ${(t.us / N).toFixed(2)}–${(t.them / N).toFixed(2)}, close games ${t.closeW}/${t.close}`);
  return t;
};
console.log(`\nThe same schedule, ${N} games each (our manager's rating)`);
seedRandom(77); const elite = run(90, 'elite 90');
seedRandom(77); const avg = run(60, 'typical 60');
seedRandom(77); const poor = run(40, 'poor 40');
seedRandom(77); const over = run(90, 'elite, overruled', { overrule: true });
const per162 = (a, b) => ((a.w - b.w) / N) * 162;
check(`an elite manager wins more than a typical one: +${per162(elite, avg).toFixed(1)} a season (1–3.5)`, per162(elite, avg) >= 1 && per162(elite, avg) <= 3.5);
check(`a poor manager wins fewer: ${per162(poor, avg).toFixed(1)} a season (−0.5 to −3)`, per162(poor, avg) <= -0.5 && per162(poor, avg) >= -3);
check(`overruled, the elite manager's edge is about half (${per162(over, avg).toFixed(1)} vs ${per162(elite, avg).toFixed(1)})`,
      per162(over, avg) < per162(elite, avg) && per162(over, avg) > 0);
check('the late, close points: 90 → +2, 60 → 0, 40 → −1.3, halved when overruled', (() => {
  const team = (q, s, set) => ({ manager: { quality: q, style: s }, strategy: { run: set, hook: 'normal' } });
  return Math.abs(M.lateClosePoints(team(90, 'runner', 'more')) - 2) < 1e-9 && M.lateClosePoints(team(60, 'runner', 'more')) === 0
    && Math.abs(M.lateClosePoints(team(40, 'runner', 'more')) + 4 / 3) < 1e-9 && Math.abs(M.lateClosePoints(team(90, 'runner', 'less')) - 1) < 1e-9
    && M.lateClosePoints({}) === 0;
})());

console.log('\nThe relationship');
M.applyStyle(user); ours.relationship = 50;
check('played the manager\'s way: no wear', !M.afterGame(user) && ours.relationship === 50);
const s0 = M.styleOf(ours); user.strategy = { ...strategyOf(user), [s0.part]: 'normal' };
for (let i = 0; i < 20; i++) M.afterGame(user);
check(`20 games against the style: 50 → ${ours.relationship}`, ours.relationship === 40);
for (let i = 0; i < 200; i++) M.afterGame(user);
check(`it bottoms out (${ours.relationship})`, ours.relationship === 15);

console.log('\nThe winter');
for (const [i, t] of st.leagueTeams.entries()) { t.wins = [55, 60, 66, 70, 75, 80, 85, 90, 95][i % 9]; t.losses = 162 - t.wins; }
const before = Object.fromEntries(st.leagueTeams.map(t => [t.id, t.manager.name]));
let ev = [], tries = 0;
while (!ev.length && tries++ < 5) ev = M.cpuWinter(st, 0, dice('mgr-winter', tries));
console.log(`    ${ev.map(e => `${e.teamId} ${e.out} → ${e.in} (${e.record}${e.fired ? ', let go' : ''})`).join(' | ')}`);
check('a losing club let its manager go; the club has a new one, on the new style', ev.length > 0 && ev.every(e => {
  const t = st.leagueTeams.find(x => x.id === e.teamId);
  return before[e.teamId] === e.out && t.manager.name === e.in && e.in !== e.out && !M.overruled(t);
}));
check('the managers let go are on the market, or already managing another club', ev.every(e => (st.managerPool || []).some(m => m.name === e.out) || st.leagueTeams.some(t => t.manager.name === e.out && t.id !== e.teamId)));
const names = [user.coachingStaff.manager.name, ...st.leagueTeams.map(t => t.manager.name)];
check('still no two managers with one name', new Set(names).size === names.length);
const [A, B] = M.candidates(st, { rand: dice('mgr-cands', 1) });
console.log(`    candidates: ${A.name} ${A.quality} ${A.style} ${A.salary}K (${A.background}) | ${B.name} ${B.quality} ${B.style} ${B.salary}K (${B.background})`);
check('two candidates: the first from the market, the second another style, different names, neither managing a club',
      (st.managerPool || []).some(m => m.name === A.name) && A.style !== B.style && A.name !== B.name && !names.includes(A.name) && !names.includes(B.name));
const GENDERED = /\b(he|him|his|she|her|guys?|men|man)\b/i;
check('the backgrounds and styles are gender-neutral', ![A.background, B.background, ...Object.values(M.MANAGER_STYLES).flatMap(s => [s.label, s.words])].some(x => GENDERED.test(x)));
user.strategy = { run: 'normal', hook: 'normal', order: 'classic' };
M.hire(st, A, 2);
const m2 = user.coachingStaff.manager;
check(`hired ${A.name}: two years, the club on the new style, off the market`,
      m2.name === A.name && m2.contractExpiry === 4 && m2.quality === A.quality && !M.overruled(user) && !(st.managerPool || []).some(m => m.name === A.name));

console.log('\nOur search (the cards)');
{
  const now = Date.now(), spring = now + 5 * 86_400_000;
  SM.mutate(s => { s.offseason = { springAt: spring }; s.userTeam.coachingStaff.manager.contractExpiry = (s.seasonNum || 1) + 1; s.userTeam.strategy = { order: 'classic', run: 'normal', hook: 'normal' }; });
  const prev = SM.get().userTeam.coachingStaff.manager;
  const c1 = CardEngine.deliverManagerContractCard(now, spring);
  CardEngine.releaseDueCards(now + 1000);
  const body = SM.get().inbox.find(c => c.instanceId === c1.instanceId)?.body || '';
  check('the contract card reads the manager: rating and style', new RegExp(`${prev.name} is an? [a-z -]+ manager \\(rated ${prev.quality}\\) who ${M.styleWords(prev)}`).test(body), body);
  CardEngine.resolve(c1.instanceId, 'no');
  const hireCard = (SM.get().scheduledCards || []).find(c => c.cardId === 'os_mgr_hire');
  check('a search: the manager stays through the winter; the candidates card comes, holding the manager gate',
        SM.get().userTeam.coachingStaff.manager.name === prev.name && SM.get().userTeam.coachingStaff.manager.searching && !!hireCard && hardGates(SM.get()).manager === false);
  CardEngine.releaseDueCards(spring - 1000);
  const card = SM.get().inbox.find(c => c.cardId === 'os_mgr_hire' && !c.resolved);
  console.log(`    ${card?.preview}\n    ${card?.body}\n    contract card: ${body}`);
  check('the candidates card: two names with ratings and styles, the second hired by default', !!card && /rated \d+/.test(card.body) && card._raw.onAuto === 'os_mgr_hire_b');
  const A2 = card._mgrCands[0];
  CardEngine.resolve(card.instanceId, 'yes');
  const now2 = SM.get().userTeam.coachingStaff.manager;
  check(`hired ${A2.name}: ours now, the club on the new style, the gate cleared`, now2.name === A2.name && !now2.searching && !M.overruled(SM.get().userTeam) && hardGates(SM.get()).manager === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
