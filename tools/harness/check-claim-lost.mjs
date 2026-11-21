// §122.66 A waiver claim lost to another club: the message is a decision, not an "Understood".
//   node tools/harness/check-claim-lost.mjs
// The next-best fit for the same role, within 5 of the player we lost: another player on
// waivers (Claim — the claim goes in), else a free agent (Sign — signed), else Pro Scouting
// keeps watching the trade market (Keep Watching / Drop It).
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(5);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const st0 = SM.get();
const [A, B] = st0.leagueTeams;
const RP = (t) => t.rosterIds.map(id => st0.players[id]).filter(p => p.pos === 'RP').sort((a, b) => b.ovr - a.ovr);
const waive = (s, id, team, now) => {
  const t = s.leagueTeams.find(x => x.id === team.id);
  t.rosterIds = t.rosterIds.filter(x => x !== id);
  Object.assign(s.players[id], { group: 'waivers', tier: 'waivers', onWaivers: true, waiverStartTime: now, teamId: null, _waivedBy: t.id });
  s.waiverPool = [...(s.waiverPool || []), id];
};
// The lost one goes to club B (claimed); `alt` set as needed.
const lose = (lostId, now) => {
  SM.mutate(s => {
    s.waiverPool = (s.waiverPool || []).filter(x => x !== lostId);
    const p = s.players[lostId];
    Object.assign(p, { onWaivers: false, waiverStartTime: null, _waivedBy: null, group: 'bullpen', teamId: B.id });
    s.leagueTeams.find(t => t.id === B.id).rosterIds.push(lostId);
  });
  CE.syncRosterCards([{ type: 'WAIVER_CLAIMED', playerId: lostId, teamId: B.id, atMs: now, userClaimed: true }], now);
  CE.releaseDueCards(now + 60_000);
  return SM.get().inbox.filter(c => c.cardId === 'claim_lost' && !c.resolved).pop();
};
const clearMarket = () => SM.mutate(s => {
  const rp = (id) => s.players[id]?.pos === 'RP';
  s.freeAgentPool = (s.freeAgentPool || []).filter(id => !rp(id));
  s.waiverPool = (s.waiverPool || []).filter(id => !rp(id));
});

let now = Date.now();
const [lost1, alt1] = RP(A).slice(0, 2);
console.log(`    lost ${lost1.name} (RP ${lost1.ovr}); on waivers too: ${alt1.name} (RP ${alt1.ovr})`);
clearMarket();
SM.mutate(s => { waive(s, lost1.id, A, now - 3600_000); waive(s, alt1.id, A, now - 3600_000); s.players[lost1.id]._userClaim = true; });
let c = lose(lost1.id, now);
console.log(`    ${c?.subject} — ${c?.body}`);
check('lost, another reliever on waivers: a decision to claim the next-best fit', !!c && c.yesLabel === `Claim ${alt1.name}` && c._raw.onYes === 'claim_next'
      && new RegExp(`${B.name} had priority`).test(c.body) && !/Understood/.test(c.yesLabel || ''), JSON.stringify(c && { y: c.yesLabel, n: c.noLabel }));
CE.resolve(c.instanceId, 'yes');
check('Claim: our claim on the next one is in', SM.get().players[alt1.id]._userClaim === true);

now += 86_400_000;
const lost2 = RP(A).filter(p => p.id !== lost1.id && p.id !== alt1.id)[0];
clearMarket();
const fa = Object.values(SM.get().players).filter(p => p.group === 'freeAgent' && p.pos === 'RP').sort((a, b) => b.ovr - a.ovr)[0]
  || null;
SM.mutate(s => {
  waive(s, lost2.id, A, now - 3600_000); s.players[lost2.id]._userClaim = true;
  // a free agent reliever as good as the one we lose
  const f = fa ? s.players[fa.id] : null;
  if (f) { f.ovr = s.players[lost2.id].ovr; s.freeAgentPool = [...new Set([...(s.freeAgentPool || []), f.id])]; }
});
c = lose(lost2.id, now);
console.log(`    ${c?.subject} — ${c?.body}`);
check('lost, nobody on waivers: a decision to sign the best free agent who fits', !!fa && !!c && c.yesLabel === `Sign ${fa.name}` && c._raw.onYes === 'fa_pos_sign', JSON.stringify(c && { y: c.yesLabel }));
if (c) CE.resolve(c.instanceId, 'yes');
check('Sign: the free agent is ours', SM.get().players[fa?.id]?.teamId === 'user', SM.get().players[fa?.id]?.teamId);

now += 86_400_000;
const lost3 = RP(A).filter(p => ![lost1.id, alt1.id, lost2.id].includes(p.id))[0];
clearMarket();
SM.mutate(s => { waive(s, lost3.id, A, now - 3600_000); s.players[lost3.id]._userClaim = true; });
c = lose(lost3.id, now);
console.log(`    ${c?.subject} — ${c?.body}`);
check('lost, nobody on waivers or in free agency: Pro Scouting offers to keep watching', !!c && c.yesLabel === 'Keep Watching' && c.noLabel === 'Drop It' && c.sender === 'Scouting', JSON.stringify(c && { y: c.yesLabel, s: c.sender }));

const GENDERED = /\b(he|him|his|she|her|guys?|men|man)\b/i;
check('gender-neutral', !SM.get().inbox.filter(x => x.cardId === 'claim_lost').some(x => GENDERED.test(x.body)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
