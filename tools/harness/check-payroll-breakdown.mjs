/**
 * tools/harness/check-payroll-breakdown.mjs — r224 §122.103 the payroll, person by person.
 *   - the player rows and the shares on players traded away add up to the payroll; highest paid first; no staff (r225);
 *   - a share another club keeps paying (a trade): we pay the rest, and it says who pays what;
 *   - a share we keep paying on a player we traded away: its own row;
 *   - how long: this season only / N seasons left; a player who has told us they're retiring: this season only, and
 *     nothing next season; one who hasn't told us yet counts as usual; one more year (both kinds) counts again;
 *   - the winter counts from next season.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import * as Retirement from '../../engine/Retirement.js';
import { CARD_ACTIONS } from '../../engine/CardActions.js';
import { PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const B = () => Finance.payrollBreakdown(S());

seedRandom(224);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; Retirement.settlePlans(s); for (const p of Object.values(s.players)) if (p?.retireIntent) p.retireIntent.retiring = false; });

console.log('The sheet');
{
  const b = B();
  const sum = b.players.reduce((a, x) => a + x.pays, 0) + b.away.reduce((a, x) => a + x.pays, 0);
  check(`the rows add up to the payroll (${sum} vs ${b.totals.players})`, Math.abs(sum - b.totals.players) <= b.players.length);
  check(`everyone paid is listed (${b.players.length})`, b.players.length === S().userTeam.rosterIds.filter(id => Finance.isPaid(S().players[id])).length);
  check('highest paid first', b.players.every((x, i, a) => i === 0 || a[i - 1].pays >= x.pays));
  check('no staff (r225: paid apart from the payroll)', !('staff' in b) && !('staff' in b.totals));
}

console.log('\nTrades');
{
  SM.speculate(() => {
    const other = S().leagueTeams[0];
    const ours = B().players[0].id;
    SM.mutate(s => { Finance.retainSalary(s, other.id, ours, 0.3); });
    const x = B().players.find(r => r.id === ours);
    check(`a share the other club keeps paying: we pay 70% (${x.pays} of ${x.salary})`, x.keptBy?.teamId === other.id && x.keptBy.pct === 0.3 && x.pays === Math.round(x.salary * 0.7));
    const theirs = other.rosterIds[0];
    SM.mutate(s => { Finance.retainSalary(s, 'user', theirs, 0.5); });
    const a = B().away.find(r => r.id === theirs);
    check(`a share we keep paying on a player we traded away: its own row (${a?.pays})`, a && a.teamId === other.id && a.pct === 0.5 && a.pays === Math.round((S().players[theirs].contractSalary || 0) * 0.5));
    const b = B();
    const sum = b.players.reduce((s, r) => s + r.pays, 0) + b.away.reduce((s, r) => s + r.pays, 0);
    check('…and it all still adds up to the payroll', Math.abs(sum - b.totals.players) <= b.players.length + b.away.length);
  });
}

console.log('\nHow long, and next season');
{
  SM.speculate(() => {
    const season = S().seasonNum || 1;
    const [a, b2, c] = B().players.slice(0, 3).map(x => x.id);
    SM.mutate(s => {
      s.players[a].contractExpiry = season + 1;   // this season only
      s.players[b2].contractExpiry = season + 3;  // this one and two more
      s.players[c].contractExpiry = season + 2;
    });
    const row = (id) => B().players.find(r => r.id === id);
    check('this season only: left 1', row(a).left === 1);
    check('three seasons: left 3', row(b2).left === 3);
    const base = B().totals.nextSeason;
    const salB = S().players[b2].contractSalary;
    check('next season counts a deal that runs on, not one that ends', base >= salB);
    SM.mutate(s => { s.players[b2].retireIntent = { season, retiring: true, tell: 999 }; });
    check('retiring but hasn\'t told us yet: counted as usual', !row(b2).retiring && B().totals.nextSeason === base);
    SM.mutate(s => { s.players[b2].retireIntent.told = true; });
    check('told us they\'re retiring: this season only', row(b2).retiring === true);
    check(`…and nothing next season (${base} → ${B().totals.nextSeason})`, B().totals.nextSeason === base - salB);
    // one more year, with years left: the deal they have counts again
    SM.mutate(s => { s.userTeam.finances.payrollTarget = 1e9; Retirement.stayOneMore(s, s.players[b2]); });
    check('one more year (years left): next season counts the deal again', !row(b2).retiring && B().totals.nextSeason === base);
    // one more year on an expiring deal: a one-year extension
    SM.mutate(s => { s.players[a].retireIntent = { season, retiring: true, tell: 10, told: true }; });
    const before = B().totals.nextSeason;
    let said = null;
    SM.mutate(s => { CARD_ACTIONS.arc_one_more.apply(s, { _targetPlayerId: a }); said = s.players[a]._oneMore.yes; });
    const r = row(a);
    if (said) check(`one more year (expiring), yes: the new deal from next season (${r.next?.salary} for ${r.next?.years})`, r.next?.years === 1 && B().totals.nextSeason === before + r.next.salary);
    else check('one more year (expiring), no: still this season only, nothing next season', r.retiring && !r.next && B().totals.nextSeason === before);
  });
}

{
  // one more year on an expiring deal, a player who says yes (their own dice): the new deal counts next season
  let done = false;
  for (const id of S().userTeam.rosterIds) {
    if (done) break;
    SM.speculate(() => {
      const season = S().seasonNum || 1;
      SM.mutate(s => { s.userTeam.finances.payrollTarget = 1e9; const p = s.players[id]; p.contractExpiry = season + 1; delete p.pendingContract; p.retireIntent = { season, retiring: true, tell: 10, told: true }; });
      const before = B().totals.nextSeason;
      let yes = false;
      SM.mutate(s => { CARD_ACTIONS.arc_one_more.apply(s, { _targetPlayerId: id }); yes = !!s.players[id]._oneMore?.yes; });
      if (!yes) return;
      done = true;
      const r = B().players.find(x => x.id === id);
      check(`one more year (expiring), yes: the new deal from next season (${r.next?.salary} for ${r.next?.years}; ${before} → ${B().totals.nextSeason})`,
        !r.retiring && r.next?.years === 1 && B().totals.nextSeason === before + r.next.salary);
    });
  }
  check('…a player said yes', done);
}

console.log('\nThe winter');
{
  SM.speculate(() => {
    const season = S().seasonNum || 1;
    const id = B().players[0].id;
    SM.mutate(s => { s.phase = PHASE.OFFSEASON; s.players[id].contractExpiry = season + 3; });
    const b = B();
    check('the winter: counted from next season (2 seasons left)', b.winter && b.players.find(r => r.id === id).left === 2 && b.totals.nextSeason == null);
  });
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
