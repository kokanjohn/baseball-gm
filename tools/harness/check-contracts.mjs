// §112.3 Contract day for the GM — checks of the money behind releases and extensions.
//   node tools/harness/check-contracts.mjs
// A real league; a release between seasons takes the whole deal off our books
// at once (§122 — there's no dead money); another club's deal is its own.
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as Offseason from '../../engine/OffseasonEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;

seedRandom(9);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const t0 = Date.now();

// Between seasons: a veteran on a three-more-year deal, paid far over his value after a bad year.
let vet;
SM.mutate(s => {
  s.offseason = { seasonNum: 1, dayStarts: [t0], springAt: t0 + 10 * 86_400_000, done: [] };
  const p = s.userTeam.rosterIds.map(id => s.players[id]).filter(p => p.pos !== 'SP' && p.pos !== 'RP' && !s.userTeam.lineupSlots.some(sl => sl.playerId === p.id))[0];
  Object.assign(p, { contractSalary: 3000, contractExpiry: 5, _ovrChange: -3,
    seasonLog: [{ season: 1, teamId: 'user', stats: { g: 90, ab: 260, h: 52, bb: 18, hbp: 1, tb: 70, hr: 3 } }] });
  vet = p.id;
});
let st = SM.get();
const cands = Offseason.releaseCandidates(st);
const c = cands.find(x => x.player.id === vet);
console.log(`  release candidates: ${cands.map(x => `${x.player.name} ${x.player.contractSalary}K vs ${x.market}K (${x.seasonsLeft} seasons, ${x.owed}K)`).join('; ')}`);
check('an overpaid veteran after a poor season is a release candidate (3 seasons, $9M owed)', !!c && c.seasonsLeft === 3 && c.owed === 9000);
const X = Offseason.contractContext(st, st.players[vet]);
check(`the context reads the season and the role (“${X.line}”, ${X.role})`, /\.200\/.*3 HR in 90 games/.test(X.line || '') && /part-time/.test(X.role));

const room0 = Finance.payrollRoom(st), pay0 = Finance.payrollOf(st, 'user');
SM.mutate(s => { Offseason.applyRelease(s, vet, t0); });
st = SM.get();
// §122 no dead money: a release takes the whole deal off our books at once.
check(`the player is a free agent`, st.players[vet].teamId == null && st.freeAgentPool.includes(vet));
check(`the release takes the salary off our payroll at once (${pay0}K → ${Finance.payrollOf(st, 'user')}K)`,
      pay0 - Finance.payrollOf(st, 'user') === 3000);
check(`…and opens the room by as much (${Math.round(room0)} → ${Math.round(Finance.payrollRoom(st))})`,
      Finance.payrollRoom(st) - room0 >= 2990);
check('nothing is owed on him, now or later', !('dead' in st.userTeam.finances) && !('deadFuture' in st.userTeam.finances));

// Another club signs the player: the new deal is theirs alone.
const club = st.leagueTeams[0].id;
SM.mutate(s => { Offseason.signFreeAgent(s, vet, club, t0 + 3600_000); });
st = SM.get();
check(`a new club signs the player; our payroll doesn't move (${Finance.payrollOf(st, 'user')}K)`,
      st.players[vet].teamId === club && Finance.payrollOf(st, 'user') === pay0 - 3000);

// Extensions: the young core, under contract, terms that start next season.
seedRandom(10);
SM.mutate(s => { s.offseason = { seasonNum: 1, dayStarts: [t0], springAt: t0 + 1, done: [] }; s.seasonNum = 1; });
st = SM.get();
const ext = Offseason.extensionCandidates(st, 3);
console.log(`  extension candidates: ${ext.map(x => `${x.player.name} ${x.player.ovr} (${x.terms.years} yrs, ${x.terms.salary}K; future ${x.future}K)`).join('; ') || 'none'}`);
if (ext.length) {
  const e = ext[0];
  SM.mutate(s => { Offseason.applyExtension(s, e.player.id, e.terms); });
  const q = SM.get().players[e.player.id];
  check(`an extension replaces the deal from next season (${q.name}: through season ${q.contractExpiry - 1})`,
        q.contractSalary === e.terms.salary && q.contractExpiry === 2 + e.terms.years);
  check('an extended player is not offered another one', !Offseason.extensionCandidates(SM.get(), 3).some(x => x.player.id === q.id));
  check('the terms discount today\'s market and the future price is higher', e.terms.salary <= Offseason.marketTerms(st, e.player).salary && e.future > e.terms.salary);
} else check('extension candidates exist on a contender', false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
