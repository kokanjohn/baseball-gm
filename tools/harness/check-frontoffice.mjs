// §112.4 The front office's winter — checks of what each decision does to the crowd and the money.
//   node tools/harness/check-frontoffice.mjs
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as Finance from '../../engine/FinanceEngine.js';
import * as FO from '../../engine/FrontOffice.js';
import * as Dev from '../../engine/DevelopmentEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
seedRandom(4);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const T = SM.get().schedule.find(g => !g.isSpring).gameTime;
const tue = (() => { let t = T; while (new Date(t).getDay() !== 2) t += 86_400_000; return t; })();
const crowd = (over = {}, atmo = 55) => { SM.mutate(s => { Object.assign(s.userTeam.finances, { ticketPrice: 1, campaign: null }, over.fin || {}); s.userTeam.facilities = over.fac || {}; });
  return Finance.crowdFor(SM.get(), 'user', { atMs: tue, expected: true, atmosphere: atmo, wins: 0, losses: 0 }); };

console.log('The crowd and the price');
const base = crowd(), up = crowd({ fin: { ticketPrice: 1.10 } }), down = crowd({ fin: { ticketPrice: 0.90 } });
console.log(`    base ${base.attendance} / ${base.gateK}K · +10% ${up.attendance} / ${up.gateK}K · −10% ${down.attendance} / ${down.gateK}K`);
check('a raise costs fans and earns more per game (an inelastic crowd)', up.attendance < base.attendance && up.gateK > base.gateK);
check('a cut brings fans in', down.attendance > base.attendance);
const full = crowd({}, 170), fullUp = crowd({ fin: { ticketPrice: 1.08 } }, 170);
check(`a sold-out park absorbs a raise (${full.attendance} → ${fullUp.attendance}, gate ${full.gateK}K → ${fullUp.gateK}K)`, full.sellout && fullUp.sellout && fullUp.gateK > full.gateK);
const season = SM.get().seasonNum;
const camp = crowd({ fin: { campaign: { season, fill: 0.04 } } }), campOld = crowd({ fin: { campaign: { season: season - 1, fill: 0.04 } } });
check(`a campaign's base fills seats in its season only (+${camp.attendance - base.attendance}; last season's: +${campOld.attendance - base.attendance})`, camp.attendance > base.attendance && campOld.attendance === base.attendance);
const conc = crowd({ fac: { concourse: 2 } });
check(`the concourse fills more seats (+${conc.attendance - base.attendance} at level 2)`, conc.attendance > base.attendance);

console.log('\nThe offers fit the year');
const setReview = (outcome, gate) => SM.mutate(s => { s.offseason = { seasonNum: 1, review: { outcome, w: 80, l: 52, gate, core: ['x'] } }; });
setReview('champion', { games: 66, avg: 33000, capacity: 34000, fill: 0.97, sellouts: 30, gateK: 9000 });
let t = FO.ticketOffer(SM.get());
check(`after a title in a full park: raise (${Math.round(t.pct * 100)}%, ${t.why}, ${t.gateDeltaK}K)`, t.pct > 0 && t.gateDeltaK > 0);
check('…and the parade', FO.eventOffer(SM.get()).kind === 'parade');
setReview('disaster', { games: 66, avg: 17000, capacity: 34000, fill: 0.5, sellouts: 0, gateK: 4000 });
t = FO.ticketOffer(SM.get());
check(`after a hard year in a half-empty park: cut (${Math.round(t.pct * 100)}%, ${t.why}; ${t.fansPerGame} fans a game)`, t.pct < 0 && t.fansPerGame > 0 && t.atmo > 0);
check('…and the outreach', FO.eventOffer(SM.get()).kind === 'outreach');
const c1 = FO.campaignOffer(SM.get());
setReview('champion', { games: 66, avg: 33000, capacity: 34000, fill: 0.97, sellouts: 30, gateK: 9000 });
const c2 = FO.campaignOffer(SM.get());
check(`a nearly full park has little room for a campaign (${c2.seats} seats) — an emptier one more (${c1.seats})`, c2.seats < c1.seats);
SM.mutate(s => { s.userTeam.atmosphere = 50; s.userTeam.facilities = {}; });
check('a lagging atmosphere gets the concourse', FO.facilityOffer(SM.get()).kind === 'concourse');
SM.mutate(s => { s.userTeam.atmosphere = 80; s.offseason.review.gate.fill = 0.95; });
check('a lively full park gets the training center', FO.facilityOffer(SM.get()).kind === 'training');
SM.mutate(s => { s.userTeam.facilities = { concourse: 3, training: 3 }; });
check('nothing left to build: no offer', FO.facilityOffer(SM.get()) === null);

console.log('\nThe training center');
SM.mutate(s => { s.userTeam.facilities = { training: 0 }; });
const p = Object.values(SM.get().players).find(x => x.teamId === 'user');
const m0 = Dev.gainMultiplier(SM.get(), p);
SM.mutate(s => { s.userTeam.facilities = { training: 2 }; });
const m2 = Dev.gainMultiplier(SM.get(), p);
check(`development plans gain more (${m0.toFixed(3)} → ${m2.toFixed(3)})`, Math.abs(m2 / m0 - 1.1) < 0.001);

console.log('\nThe money');
SM.mutate(s => { s.userTeam.finances.funds = 5000; s.userTeam.atmosphere = 50; s.userTeam.facilities = {}; });
const fo = FO.facilityOffer(SM.get());
SM.mutate(s => { FO.applyFacility(s, fo, Date.now()); });
let fin = SM.get().userTeam.finances;
check(`an upgrade is paid from funds and on the books (${fo.cost}K, "${fin.ledger.slice(-1)[0]?.label}")`, fin.funds === 5000 - fo.cost && fin.season.spend.facilities === fo.cost && SM.get().userTeam.atmosphere === 53);
SM.mutate(s => { s.offseason.review.outcome = 'disaster'; });
const ev = FO.eventOffer(SM.get());
SM.mutate(s => { FO.applyEvent(s, ev, false, Date.now()); });
check('declining the outreach costs goodwill, not money', SM.get().userTeam.finances.funds === 5000 - fo.cost && SM.get().userTeam.atmosphere === 50);
SM.mutate(s => { Finance.seasonEndReview(s, Date.now(), 'user'); });
check('a campaign lasts one season (cleared when the books close)', SM.get().userTeam.finances.campaign === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
