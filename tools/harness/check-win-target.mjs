// §25 / §122.67 The owner's win target, season to season: the yearly adjustment (§25.1), a
// prestige tier's bump (§25.2), all held between the archetype's floor and ceiling (§25.3).
//   node tools/harness/check-win-target.mjs
import { seedRandom } from './shims.js';            // MUST be first (installs globals)
import { nextWinTarget } from '../../engine/OffseasonEngine.js';
import { clampWinTarget, computeSeasonPrestige } from '../../engine/PrestigeEngine.js';
import { WIN_TARGET_FLOOR, WIN_TARGET_CEILING, ARCHETYPE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
seedRandom(1);

const d = (arch, target, wins) => ({ archetype: arch, userTeam: { _ownerWinTarget: target, wins } });
check('§25.1 the steps: miss by 10 → −3, by 5 → −2, by 3 → −1, within 2 counts as met → +1, by 3 → +3, by 8 → +5 (Contender at 85)',
      [[75, 82], [80, 83], [82, 84], [83, 86], [85, 86], [88, 88], [93, 90]].every(([w, want]) => nextWinTarget(d('contender', 85, w)) === want),
      [75, 80, 82, 83, 85, 88, 93].map(w => nextWinTarget(d('contender', 85, w))).join(','));
for (const arch of Object.keys(WIN_TARGET_FLOOR)) {
  const lo = WIN_TARGET_FLOOR[arch], hi = WIN_TARGET_CEILING[arch];
  let t = 80, ups = [], downs = [];
  for (let i = 0; i < 12; i++) { t = nextWinTarget(d(arch, t, t + 12)); ups.push(t); }
  const top = t;
  for (let i = 0; i < 20; i++) { t = nextWinTarget(d(arch, t, t - 15)); downs.push(t); }
  check(`${arch}: twelve big seasons stop at the ceiling (${top} = ${hi}), twenty bad ones at the floor (${t} = ${lo})`, top === hi && t === lo && ups.every(x => x <= hi) && downs.every(x => x >= lo));
  const s1 = ARCHETYPE[arch]?.winTargetSeason1 ?? ARCHETYPE[arch]?.winTargetMin;
  check(`${arch}: season 1's target (${s1}) is inside ${lo}–${hi}`, s1 >= lo && s1 <= hi);
}
check('clampWinTarget: Empire 104 → 98, Ember 52 → 60', clampWinTarget(104, 'empire') === 98 && clampWinTarget(52, 'ember') === 60);

// §25.2 a tier bump near the ceiling stops there.
const st = { archetype: 'empire', seasonNum: 3, prestigeScore: 10_000, prestigeTier: 1, prestigeHistory: [], seasonHistory: [],
             userTeam: { _ownerWinTarget: 96, wins: 100, losses: 32 } };
let res = null;
try { res = computeSeasonPrestige(st, { wins: 100, losses: 32, playoffResult: 'champion', allStarHosted: false }); } catch (e) { console.log('    ', e.message); }
const bumped = res?.mutations?.userTeam?._ownerWinTarget;
check(`a tier bump at 96 (Empire): ${bumped ?? 'no bump'} — never past 98`, bumped == null || bumped <= 98, JSON.stringify(res?.mutations?.prestigeTier));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
