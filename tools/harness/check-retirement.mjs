/**
 * tools/harness/check-retirement.mjs — r222 §122.101 the plan to retire, settled once a season.
 *   - every player's plan, settled once and kept (the same dice give the same plan); the rules (38+ next season;
 *     35–37 rated under 55, about 60%; nobody younger);
 *   - the plan holds through a change of club; day 1 retires on the plan (years left or not), and nobody else;
 *     the notice says what they walked away from;
 *   - ours: the manager's word at the tell game (the next morning, 10:00–11:30), once; one who came to us after
 *     telling their old club is known without a word; the card line (knownRetiring);
 *   - the routine extension messages skip a player planning to retire; the arc's one more year (both answers; with
 *     years left, no new deal); the odds move with how they feel about the GM and with age; voice.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Offseason from '../../engine/OffseasonEngine.js';
import * as Retirement from '../../engine/Retirement.js';
import { CARD_ACTIONS } from '../../engine/CardActions.js';
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, PLAYER_GROUP } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || null;
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview}`) && !/\{[a-z0-9_]+\}|undefined|NaN|null/.test(`${c.subject} ${c.body} ${c.preview}`);
const say = (c) => console.log(`    ${new Date(c.deliverAtMs ?? c.arrivedAtMs).toString().slice(0, 21)}  ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}`);
const plan = (season, retiring, extra = {}) => ({ season, retiring, tell: 10, ...extra });

seedRandom(222);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const sched = S().schedule;
const reg = sched.map((g, i) => i).filter(i => !sched[i].isSpring && !sched[i].isPlayoff);
const after = (n) => {
  const i = reg[n];
  SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; s.currentGameIndex = i; s.schedule.forEach((g, k) => { g._committed = k < i; }); });
  const end = sched[i - 1].gameTime + 3 * HOUR; clock.set(end); return end;
};
const season = () => S().seasonNum || 1;
const nextAge = (p) => computeAge(p.dob, baseballYear(S()) + 1);
const rel = (p) => (p.ovr || 50) - (S().leagueTalentOffset || 0);

console.log('The plan');
{
  SM.speculate(() => {
    SM.mutate(s => { for (const p of Object.values(s.players)) delete p.retireIntent; });
    let n = 0; SM.mutate(s => { n = Retirement.settlePlans(s); });
    const live = Object.values(S().players).filter(p => p && ![PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED].includes(p.group));
    check(`every player has a plan for this season (${n})`, n === live.length && live.every(p => p.retireIntent?.season === season()));
    const first = Object.fromEntries(live.map(p => [p.id, p.retireIntent.retiring]));
    SM.mutate(s => { for (const p of Object.values(s.players)) delete p.retireIntent; Retirement.settlePlans(s); });
    check('the same dice, the same plans', live.every(p => S().players[p.id].retireIntent.retiring === first[p.id]));
    let again = 0; SM.mutate(s => { again = Retirement.settlePlans(s); });
    check('settled once: a second pass changes nothing', again === 0);
    const tells = live.map(p => S().players[p.id].retireIntent.tell);
    check('each tells their club between games 10 and 50', tells.every(t => t >= 10 && t <= 50));
    // the rules, over a made-up range of ages and ratings (every player, re-dated)
    const yr = baseballYear(S()) + 1;
    const counts = { old: [0, 0], young: [0, 0], softLow: [0, 0], softHigh: [0, 0] };
    for (const [kind, age, ovr] of [['old', 38, 80], ['young', 33, 40], ['softLow', 36, 45], ['softHigh', 36, 70]]) {
      SM.mutate(s => {
        for (const p of Object.values(s.players)) {
          if (!p || [PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED].includes(p.group)) continue;
          p.dob = `${yr - age}-01-01`; p.ovr = ovr + (s.leagueTalentOffset || 0); delete p.retireIntent;
        }
        Retirement.settlePlans(s);
      });
      for (const p of live) { counts[kind][0]++; if (S().players[p.id].retireIntent.retiring) counts[kind][1]++; }
    }
    const share = (k) => counts[k][1] / counts[k][0];
    check('38 or older next season: all retire', share('old') === 1);
    check('34 or younger next season: none retire', share('young') === 0);
    check(`35–37 rated under 55: about 60% (${Math.round(share('softLow') * 100)}%)`, share('softLow') > 0.5 && share('softLow') < 0.7);
    check('35–37 rated 55 or better: none', share('softHigh') === 0);
  });
}

console.log('\nDay 1 follows the plan');
{
  SM.speculate(() => {
    const ids = S().userTeam.rosterIds.filter(id => !['SP', 'RP'].includes(S().players[id].pos));
    const [a, b, c] = ids, other = S().leagueTeams[0];
    const cpu = other.rosterIds[0];
    SM.mutate(s => {
      for (const p of Object.values(s.players)) if (p) p.retireIntent = plan(s.seasonNum || 1, false);
      const pa = s.players[a]; pa.retireIntent = plan(s.seasonNum || 1, true); pa.contractExpiry = (s.seasonNum || 1) + 3; pa.contractSalary = 2000;
      const pb = s.players[b]; pb.dob = `${baseballYear(s) - 40}-01-01`;   // 41 next season, but the plan says stay (one more year)
      s.players[cpu].retireIntent = plan(s.seasonNum || 1, true);
    });
    // a change of club keeps the plan
    SM.mutate(s => { s.players[c].retireIntent = plan(s.seasonNum || 1, true); });
    const before = S().players[c].retireIntent.retiring;
    SM.mutate(s => { s.players[c].teamId = other.id; });
    check('a change of club keeps the plan', Retirement.isRetiring(S(), S().players[c]) === before && before === true);
    SM.mutate(s => { s.players[c].teamId = 'user'; s.players[c].retireIntent = plan(s.seasonNum || 1, false); });
    let ev = [];
    SM.mutate(s => { ev = Offseason.beginOffseason(s, clock.get()); });
    const ret = ev.filter(e => e.type === 'RETIRED');
    check('a player planning to retire retires, with years left on the deal', S().players[a].group === PLAYER_GROUP.RETIRED);
    const ea = ret.find(e => e.playerId === a);
    check(`…the years and money left go with the event (${ea?.owedYears} years, $${ea?.owedK}K)`, ea?.owedYears === 2 && ea?.owedK === 4000);
    check('…and their salary is off our payroll (no longer on the roster)', !S().userTeam.rosterIds.includes(a));
    check('a 41-year-old whose plan is to stay plays on', S().players[b].group !== PLAYER_GROUP.RETIRED);
    check('another club\'s player retires on their plan', S().players[cpu].group === PLAYER_GROUP.RETIRED);
    check('nobody retires without a plan to', ret.every(e => [a, cpu].includes(e.playerId)), ret.map(e => S().players[e.playerId]?.name).join(', '));
    CE.deliverRetirementNotice(a, 37, clock.get() + HOUR, ea?.owedYears, ea?.owedK);
    CE.releaseDueCards(clock.get() + 2 * HOUR);
    const n = CE.getInbox().find(x => x.subject === `${S().players[a].name} is retiring`);
    if (n) say(n);
    check('the notice: what they walked away from', n && /walked away from 2 years and \$4M left on the deal/.test(n.body) && readsRight(n));
  });
}

console.log('\nOurs: the manager\'s word');
{
  SM.speculate(() => {
    SM.mutate(s => { s.inbox = []; s.scheduledCards = []; for (const p of Object.values(s.players)) if (p) p.retireIntent = plan(s.seasonNum || 1, false); });
    const [a, b] = S().userTeam.rosterIds.filter(id => !['SP', 'RP'].includes(S().players[id].pos));
    SM.mutate(s => {
      s.players[a].retireIntent = plan(s.seasonNum || 1, true, { tell: 20 });
      s.players[a].contractExpiry = (s.seasonNum || 1) + 2;
    });
    after(19);
    check('before their tell game: not known (no card line)', !Retirement.knownRetiring(S(), S().players[a]));
    check('…no word yet', CE.deliverRetirePlans(clock.get(), buildCardContext()).length === 0);
    const end = after(20);
    const got = CE.deliverRetirePlans(end, buildCardContext());
    const w = got[0];
    if (w) say(w);
    const h = w ? new Date(w.deliverAtMs).getHours() + new Date(w.deliverAtMs).getMinutes() / 60 : -1;
    check('at the tell game: the manager\'s word', got.length === 1 && w.subject === `${S().players[a].name} plans to retire` && /last season/.test(w.body));
    check('…the next morning, 10:00–11:30', h >= 10 && h <= 11.5 && w.deliverAtMs > end);
    check('…with the year left on the deal', /walk away from the last year of the deal/.test(w.body));
    check('…reads right', readsRight(w));
    check('…known from then on (the card line)', Retirement.knownRetiring(S(), S().players[a]));
    after(21);
    check('…once', CE.deliverRetirePlans(clock.get(), buildCardContext()).length === 0);
    // one who joins us after telling their old club: known, no word
    SM.mutate(s => { s.players[b].retireIntent = plan(s.seasonNum || 1, true, { tell: 12 }); });
    after(30);
    check('one who came to us after telling their old club: known on arrival', Retirement.knownRetiring(S(), S().players[b]));
    check('…without a word', CE.deliverRetirePlans(clock.get(), buildCardContext()).length === 0);
    const cpu = S().leagueTeams[0].rosterIds[0];
    SM.mutate(s => { s.players[cpu].retireIntent = plan(s.seasonNum || 1, true, { tell: 12 }); });
    check('another club\'s player: not shown as known to us', !Retirement.knownRetiring(S(), S().players[cpu]));
  });
}

console.log('\nExtensions');
{
  SM.speculate(() => {
    after(60);
    const ids = S().userTeam.rosterIds.filter(id => !['SP', 'RP'].includes(S().players[id].pos));
    const a = ids[0];
    SM.mutate(s => {
      for (const p of Object.values(s.players)) if (p) p.retireIntent = plan(s.seasonNum || 1, false);
      const p = s.players[a]; p.contractExpiry = (s.seasonNum || 1) + 1; delete p.pendingContract; delete p._willWalk;
      s.userTeam.finances.payrollTarget = 1e9;
    });
    const card = { _targetPlayerId: a };
    const okBefore = CARD_ACTIONS.retain_active_hitter.feasible(S(), card);
    SM.mutate(s => { s.players[a].retireIntent = plan(s.seasonNum || 1, true); });
    check('the contract-year extension: not for a player planning to retire', okBefore && !CARD_ACTIONS.retain_active_hitter.feasible(S(), card));
    const asks = Offseason.breakoutAsks(S(), 99).map(x => x.player.id);
    check('the agent\'s ask: not for a player planning to retire', !asks.includes(a));

    // the arc's one more year: both answers, on many players (their own dice)
    let yes = 0, no = 0, okYes = true, okNo = true, kept = true;
    for (const id of ids) {
      const saved = JSON.parse(JSON.stringify(S().players[id]));
      {
        SM.mutate(s => {
          const p = s.players[id]; p.retireIntent = plan(s.seasonNum || 1, true); delete p.pendingContract;
          p.contractExpiry = (s.seasonNum || 1) + 1; p.gmRelationship = 50;
        });
        let ev = [];
        SM.mutate(s => { ev = CARD_ACTIONS.arc_one_more.apply(s, { _targetPlayerId: id }); });
        const p = S().players[id];
        if (p._oneMore.yes) { yes++; okYes = okYes && p.pendingContract?.years === 1 && p.retireIntent.retiring === false && ev[0]?.type === 'EXTENDED'; }
        else { no++; okNo = okNo && !p.pendingContract && p.retireIntent.retiring === true; }
        // the same player asked with years left: no new deal
        SM.mutate(s => { const q = s.players[id]; q.retireIntent = plan(s.seasonNum || 1, true); delete q.pendingContract; delete q._oneMore; q.contractExpiry = (s.seasonNum || 1) + 2; });
        SM.mutate(s => { CARD_ACTIONS.arc_one_more.apply(s, { _targetPlayerId: id }); });
        const q = S().players[id];
        if (q._oneMore.yes) kept = kept && !q.pendingContract && q.retireIntent.retiring === false;
        SM.mutate(s => { s.players[id] = saved; });
      }
    }
    check(`one more year: some say yes, some no (${yes} yes, ${no} no)`, yes > 0 && no > 0);
    check('…yes on an expiring deal: a one-year extension, the plan cancelled', okYes);
    check('…no: no new deal, they retire as planned', okNo);
    check('…yes with years left: no new deal, the plan cancelled', kept);
    const p = S().players[a];
    const at = (r, age) => { const q = { ...p, gmRelationship: r, dob: `${baseballYear(S()) + 1 - age}-01-01`, stats: {} }; return Retirement.oneMoreOdds(S(), q); };
    check(`the odds: 50% at neutral, 36 (${at(50, 36)})`, Math.abs(at(50, 36) - 0.5) < 1e-9);
    check(`…higher when they like the GM (${at(100, 36).toFixed(2)}), lower when they don't (${at(0, 36).toFixed(2)})`, at(100, 36) > 0.65 && at(0, 36) < 0.35);
    check(`…lower at 38 or older (${at(50, 38).toFixed(2)})`, at(50, 38) < 0.4);
  });
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
