// §122.15 the scouting director: on the staff (archetype's at a new club, hired
// once by an old save), what quality and specialty change (the reads, the looks,
// how fast our untested players show what they are, the tips on a diamond before
// word gets around), the winter's review and hiring.
//   node tools/harness/check-scouting-director.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, deliverCoachHireCard, deliverCoachReviewCard, directorTips } from '../../engine/CardEngine.js';
import * as Coach from '../../engine/CoachEngine.js';
import { ensureScoutingDirector } from '../../store/schema.js';
import { isDiamond } from '../../engine/Diamonds.js';
import { writeComposeReply } from '../../engine/ComposeReplies.js';
import { PLAYER_ORIGIN } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const DAY = 86_400_000;
const setDirector = (fields) => SM.mutate(s => { Object.assign(s.userTeam.coachingStaff.scoutingDirector, fields); });

// ── The archetype's director ──────────────────────────────────
console.log('On the staff');
const quality = {};
for (const arch of ['lab', 'contender']) {
  const qs = [];
  for (let i = 0; i < 12; i++) qs.push(Coach.startingDirector(arch, (() => { let x = (i + 1) * 0.0731; return () => (x = (x * 9301 + 0.4927) % 1); })()).quality);
  quality[arch] = qs.reduce((a, b) => a + b, 0) / qs.length;
}
check(`an analytics club starts with a better director (lab ${quality.lab.toFixed(0)}, contender ${quality.contender.toFixed(0)})`, quality.lab > quality.contender + 10);
check('…and a pro scout', Coach.startingDirector('lab', Math.random).specialty === 'pro');

seedRandom(7);
clock.set(clock.real());
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const S = () => SM.get(), staff = () => S().userTeam.coachingStaff;
const d0 = staff().scoutingDirector;
check(`a new club has a director: ${d0?.name}, rated ${d0?.quality}, ${d0?.specialty}, ${d0?.salary}K a year`,
      !!d0 && Number.isFinite(d0.quality) && Coach.ROLE_INFO.scoutingDirector.specialties.includes(d0.specialty) && d0.salary === Coach.salaryFor('scoutingDirector', d0.quality));
check('the name is nobody else\'s on the staff', Object.entries(staff()).filter(([k, v]) => k !== 'scoutingDirector' && v?.name === d0.name).length === 0 && d0.name !== S().userTeam.ownerName);
const old = structuredClone(S()); delete old.userTeam.coachingStaff.scoutingDirector;
check('an old save hires one once (and only once)', ensureScoutingDirector(old) && !!old.userTeam.coachingStaff.scoutingDirector?.name && !ensureScoutingDirector(old));

// ── What quality and specialty change ─────────────────────────
console.log('What the director changes');
const st0 = { scoutingDirector: { quality: 40, specialty: 'pro' } }, st9 = { scoutingDirector: { quality: 90, specialty: 'pro' } };
const vet = { origin: PLAYER_ORIGIN.LEAGUE }, abroad = { origin: PLAYER_ORIGIN.OVERSEAS };
check(`sharper reads: eye ${Coach.scoutEye(st0, abroad).toFixed(2)} (40) → ${Coach.scoutEye(st9, abroad).toFixed(2)} (90)`, Coach.scoutEye(st9, abroad) > 2 * Coach.scoutEye(st0, abroad));
check('the specialty sharpens its own players only', Coach.scoutEye(st9, vet) > Coach.scoutEye(st9, abroad));
check(`more looks: ${Coach.scoutLooks(st0)} a week (40) → ${Coach.scoutLooks(st9)} (90)`, Coach.scoutLooks(st0) === 2 && Coach.scoutLooks(st9) === 5);
check('faster reads on our untested players', Coach.scoutExposure(st9, abroad) > Coach.scoutExposure(st0, abroad) && Coach.scoutExposure(st9, vet) > Coach.scoutExposure(st9, abroad));
check(`tips: ${Coach.tipChance(st0, abroad).toFixed(2)} (40) → ${Coach.tipChance(st9, abroad).toFixed(2)} (90), sooner (${Coach.tipLeadDays(st0)} → ${Coach.tipLeadDays(st9)} days)`,
      Coach.tipChance(st9, abroad) > 4 * Coach.tipChance(st0, abroad) && Coach.tipLeadDays(st9) < Coach.tipLeadDays(st0));
check('an empty chair sends no tips', Coach.tipChance({ scoutingDirector: { vacant: true } }, vet) === 0);

// The weekly report: its size and its signature.
setDirector({ quality: 85 });
const rep = writeComposeReply(S(), { topicId: 'sc_free_agents', channelId: 'scouting', atMs: clock.get() });
check(`the report is signed by the director (${rep?.sender})`, rep?.sender?.startsWith(staff().scoutingDirector.name));
check(`a top director looks at up to 5 a week (${rep?.memo?.playerIds?.length})`, (rep?.memo?.playerIds?.length || 0) <= 5 && (rep?.memo?.playerIds?.length || 0) >= 3);

// ── Tips ──────────────────────────────────────────────────────
console.log('Tips on a diamond');
const L = S().leagueTalentOffset || 0;
const spring = S().schedule.find(g => g.isSpring) || S().schedule[0];
const tipsOver = (q) => SM.speculate(() => {
  setDirector({ quality: q, specialty: 'pro' });
  const from = clock.get(), to = from + 24 * DAY;
  let seen = 0;
  // (the daily look, run directly: the world clock waits on our games, which this check doesn't play;
  //  the season sim covers the hook in the clock)
  for (let t = from; t <= to; t += DAY / 2) {
    clock.set(t); directorTips(t); releaseDueCards(t);
    const open = getInbox().filter(c => c.cardId === 'scout_tip' && !c.resolved);
    for (const c of open) { seen++; resolve(c.instanceId, 'no'); }
  }
  return seen;
});
const t0 = clock.get();
const good = tipsOver(90), weak = tipsOver(40);
clock.set(t0);
check(`a great director tips us to more diamonds over three weeks (${good} against ${weak})`, good > weak && good >= 2);

// One tip, read and signed.
let tip = null;
SM.speculate(() => {
  setDirector({ quality: 90 });
  for (let t = clock.get(); t <= clock.get() + 24 * DAY && !tip; t += DAY / 2) {
    clock.set(t); directorTips(t); releaseDueCards(t);
    tip = getInbox().find(c => c.cardId === 'scout_tip' && !c.resolved) || null;
  }
  if (!tip) return;
  const p = S().players[tip._targetPlayerId];
  console.log(`    “${tip.subject}” — ${tip.body}`);
  check('the tip is about a real diamond, before word gets around', isDiamond(p, L) && tip.expiresAtMs === p._buzzAt && clock.get() < p._buzzAt);
  check('signed by the director, gender-neutral', tip.sender.startsWith(staff().scoutingDirector.name) && !GEN.test(tip.body + tip.preview), (tip.body.match(GEN) || []).join());
  resolve(tip.instanceId, 'yes', tip._choices?.length ? { pick: tip._choices[0].key } : {});
  advanceClock(clock.get());
  const q = S().players[p.id];
  check(`signing it: ${p.name} joins us, counted as the scouts' find`,
        (q.teamId === 'user' || S().transactions.some(x => x.status === 'pending' && x.playerId === p.id && x.teamId === 'user')) && q._scoutFound === (S().seasonNum || 1));
});
check('a tip came within three weeks from a great director', !!tip);
clock.set(t0);

// ── The winter ────────────────────────────────────────────────
console.log('The winter');
const U = { of: 16, scouting: { onto: 5, missed: 2, missedBy: { pro: 0, intl: 2, amateur: 0 }, found: 2, foundImp: 3.4 } };
const ev = Coach.evaluate('scoutingDirector', U);
check(`evaluated on the market's finds (${ev.verdict}: ${ev.facts.join('; ')})`, ev.verdict === 'good' && /5 of the 7/.test(ev.facts[0]) && /signed 2/.test(ev.facts[1]));
check('a poor year is poor', Coach.evaluate('scoutingDirector', { of: 16, scouting: { onto: 0, missed: 6, missedBy: { pro: 6 }, found: 0 } }).verdict === 'poor');
check('the job needs where the misses came from', Coach.neededSpecialty('scoutingDirector', U, S()) === 'intl');
check('in the staff roles (renew, fire, hire, settle like the coaches)', Coach.COACH_ROLES.includes('scoutingDirector'));
SM.mutate(s => { s.offseason = { review: { units: U } }; });
const rv = deliverCoachReviewCard('scoutingDirector', 'up', clock.get(), clock.get() + 3 * DAY);
check(`the review comes from the front office and calls the director a scout (“${rv?.subject}”)`,
      rv?.sender === 'Front Office' && / scout \(rated/.test(rv?.body || '') && !/ coach \(rated/.test(rv?.body || ''), rv?.body);
SM.mutate(s => { Coach.vacate(s.userTeam.coachingStaff, 'scoutingDirector'); });
const hc = deliverCoachHireCard('scoutingDirector', clock.get(), clock.get() + 3 * DAY);
console.log(`    “${hc?.subject}” — ${hc?.body}`);
check('the hiring card: two scouts, the first for what the job needs, the front office picks by default',
      !!hc && hc._coachCands?.length === 2 && hc._coachCands[0].specialty === 'intl' && /the front office picks/.test(hc.body) && / scout \(rated/.test(hc.body));
check('gender-neutral', !GEN.test(hc.body + rv.body), ((hc.body + rv.body).match(GEN) || []).join());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
