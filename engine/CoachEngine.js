/**
 * engine/CoachEngine.js
 * §112.2 Coaches with real abilities.
 *
 *   Every coach on the GM's staff has a quality (about 40–90; 60 is a
 *   league-typical coach) and a specialty. Together they move:
 *     - in-season development (DevelopmentEngine.gainMultiplier: devFactor)
 *     - the winter's growth for our players (OffseasonEngine._develop: winterBonus)
 *     - the coach's own part of the game, a little (SimEngine: staffEffects —
 *       rating points added to our players' effective ratings in the sim)
 *
 *   Roles and specialties:
 *     pitchingCoach  command (control) · power (stuff) · youth (young arms grow faster)
 *     hittingCoach   contact · power · youth (young hitters grow faster)
 *     bullpenCoach   command (relievers' control) · late (relievers in the 8th and later)
 *     benchCoach     baserunning (speed on the bases) · defense (fewer errors)
 *
 *   The offseason (§112.2): day 2 evaluates each coach on their side of the
 *   game (evaluate — from the season review's units); a coach whose deal is up
 *   is renewed or let go, a coach under contract whose unit struggled can be
 *   fired (the rest of the deal is paid out). A vacancy brings a hiring card
 *   with two candidates (candidates) fitted to what the unit needs.
 *
 *   CPU clubs' staffs are not modelled person by person: their coaching is
 *   league-typical (no effect). An empty chair coaches like a weak coach.
 *
 * Pure: never imports StateManager. Randomness comes from the `rand` passed in
 * (Math.random by default).
 */

import { STAFF_NAMES } from '../data/player-names.js';
import { computeAge, baseballYear } from './PlayerFactory.js';

export const COACH_ROLES = ['pitchingCoach', 'hittingCoach', 'bullpenCoach', 'benchCoach'];

export const ROLE_INFO = {
  pitchingCoach: { label: 'Pitching Coach', title: 'pitching coach', base: 125, specialties: ['command', 'power', 'youth'] },
  hittingCoach:  { label: 'Hitting Coach',  title: 'hitting coach',  base: 125, specialties: ['contact', 'power', 'youth'] },
  bullpenCoach:  { label: 'Bullpen Coach',  title: 'bullpen coach',  base: 75,  specialties: ['command', 'late'] },
  benchCoach:    { label: 'Bench Coach',    title: 'bench coach',    base: 75,  specialties: ['baserunning', 'defense'] },
};

const SPEC_WORDS = {
  pitchingCoach: {
    command: 'a command teacher: fewer walks',
    power:   'a power-pitching teacher: more swing-and-miss',
    youth:   'a development coach: young arms grow faster',
  },
  hittingCoach: {
    contact: 'a contact teacher: more balls in play, more hits',
    power:   'a power coach: more extra-base hits',
    youth:   'a development coach: young hitters grow faster',
  },
  bullpenCoach: {
    command: 'a strike-thrower: relievers who don\'t walk people',
    late:    'a late-innings specialist: sharper arms in the eighth and ninth',
  },
  benchCoach: {
    baserunning: 'a baserunning coach: more steals, more extra bases',
    defense:     'a defensive coach: cleaner fielding, fewer errors',
  },
};
const SPEC_SHORT = { command: 'command', power: 'power', youth: 'young players', contact: 'contact', late: 'late innings', baserunning: 'baserunning', defense: 'defense' };

export const specialtyWords = (role, spec) => SPEC_WORDS[role]?.[spec] || '';
export const specialtyShort = (spec) => SPEC_SHORT[spec] || spec || '';

export function qualityWord(q) {
  return q >= 82 ? 'elite' : q >= 72 ? 'very good' : q >= 62 ? 'solid' : q >= 52 ? 'average' : 'below-average';
}

const QUALITY_MIN = 40, QUALITY_MAX = 90;
const VACANT_QUALITY = 45;              // nobody in the chair: the job gets done, badly
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';

/** A coach's quality (an empty chair, or an old save's coach before §112.2). */
export const qualityOf = (c) => (!c || c.vacant ? VACANT_QUALITY : Number.isFinite(c.quality) ? c.quality : 60);
const _off = (c) => (qualityOf(c) - 60) / 30;          // −0.67 (40) … 0 (60) … +1 (90)
const _spec = (c, k) => (c && !c.vacant && c.specialty === k ? 1 : 0);

/** What a coach of this quality earns ($K a year). */
export function salaryFor(role, q) {
  const b = ROLE_INFO[role]?.base || 75;
  return Math.round(b * (0.7 + 0.6 * clamp((q - QUALITY_MIN) / (QUALITY_MAX - QUALITY_MIN), 0, 1)) / 5) * 5;
}

/** A quality around `mean` (the sum of three rolls: most coaches are near it). */
export function rollQuality(rand = Math.random, mean = 58, spread = 12) {
  const r = (rand() + rand() + rand()) / 3 - 0.5;          // −0.5…0.5, bunched in the middle
  return Math.round(clamp(mean + r * 2 * spread * 1.5, QUALITY_MIN, QUALITY_MAX));
}

const _pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

/** Give every coach on the staff a quality and a specialty (new franchises; saves from before §112.2). */
export function ensureAbilities(staff, rand = Math.random) {
  for (const role of COACH_ROLES) {
    const c = staff?.[role];
    if (!c || c.vacant) continue;
    if (!Number.isFinite(c.quality)) c.quality = rollQuality(rand);
    if (!ROLE_INFO[role].specialties.includes(c.specialty)) c.specialty = _pick(ROLE_INFO[role].specialties, rand);
  }
  return staff;
}

// ─────────────────────────────────────────────────────────────
// EFFECTS
// ─────────────────────────────────────────────────────────────

/**
 * staffEffects(staff) — rating points the sim adds to OUR players' effective
 * ratings (SimEngine._effectiveSR), and the error rate behind our fielders.
 * A 90 coach is worth about +0.3 on their unit (+0.25 more on the specialty);
 * a 40 coach about −0.2; an empty chair −0.15. Calibrated (check-coaches.mjs):
 * an elite staff against a poor one is a few wins a season.
 */
export function staffEffects(staff) {
  if (!staff) return null;
  const pc = staff.pitchingCoach, hc = staff.hittingCoach, bp = staff.bullpenCoach, bc = staff.benchCoach;
  // A specialty is worth more in a better coach's hands.
  const S = (c, k) => _spec(c, k) * clamp((qualityOf(c) - 30) / 60, 0, 1);
  const P = _off(pc) * 0.3, H = _off(hc) * 0.3, B = _off(bp) * 0.3, R = _off(bc);
  const spStuff = P + 0.25 * S(pc, 'power'), spControl = P + 0.25 * S(pc, 'command');
  return {
    bat:  { contact: H + 0.25 * S(hc, 'contact'), power: H + 0.25 * S(hc, 'power'), speed: 0.4 * R + 1.5 * S(bc, 'baserunning') },
    sp:   { stuff: spStuff, control: spControl },
    rp:   { stuff: 0.5 * spStuff + B, control: 0.5 * spControl + B + 0.25 * S(bp, 'command') },
    late: 0.6 * S(bp, 'late'),                        // relievers' stuff and control from the eighth on
    errorMult: clamp(1 - 0.12 * R - 0.3 * S(bc, 'defense'), 0.6, 1.2),
  };
}

const _coachFor = (staff, p) => staff?.[isPitcher(p) ? 'pitchingCoach' : 'hittingCoach'];

/** In-season development: how much of a plan's gain the coach gets out of the player (0.8–1.2; youth ×1.2 at 25 and under). */
export function devFactor(staff, player, age) {
  const c = _coachFor(staff, player);
  let m = 0.8 + 0.4 * clamp((qualityOf(c) - QUALITY_MIN) / (QUALITY_MAX - QUALITY_MIN), 0, 1);
  if (_spec(c, 'youth') && age <= 25) m *= 1.2;
  return m;
}

const _KEY_SPEC = { control: 'command', stuff: 'power', contact: 'contact', power: 'power' };

/** The winter's growth: points added to one sub-rating's yearly change (about −0.4 to +1.1). */
export function winterBonus(staff, player, key, age) {
  const c = _coachFor(staff, player);
  let b = _off(c) * 0.6;
  if (_KEY_SPEC[key] && _spec(c, _KEY_SPEC[key])) b += 0.5;
  if (_spec(c, 'youth') && age <= 25) b += 0.6;
  return b;
}

// ─────────────────────────────────────────────────────────────
// THE OFFSEASON — evaluation, candidates, decisions
// ─────────────────────────────────────────────────────────────

const ord = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] || 'th'}`;
const f2 = (x) => (x == null ? '—' : x.toFixed(2));
const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const f3 = (x) => (x == null ? '—' : x.toFixed(3).replace(/^0/, ''));

/** 1 = best in the league, 0 = worst (null rank: the middle). */
function _rankScore(m, of) {
  if (!m || m.rank == null || !of || of < 2) return 0.5;
  return 1 - (m.rank - 1) / (of - 1);
}

/**
 * evaluate(role, U) — how the coach's side of the game went (U: the season
 * review's units). Returns { verdict: 'good'|'fair'|'poor', score, facts[] }
 * with each fact a phrase ("the rotation's 3.85 ERA, 4th of 16").
 */
export function evaluate(role, U) {
  if (!U) return { verdict: 'fair', score: 0.5, facts: [] };
  const of = U.of;
  const rk = (m) => (m?.rank ? `${ord(m.rank)} of ${of}` : '');
  const facts = [];
  let score = 0.5;
  if (role === 'pitchingCoach') {
    score = 0.6 * _rankScore(U.spEra, of) + 0.2 * _rankScore(U.bb9, of) + 0.2 * _rankScore(U.k9, of);
    if (U.spEra?.v != null) facts.push(`the rotation's ${f2(U.spEra.v)} ERA (${rk(U.spEra)})`);
    if (U.bb9?.v != null) facts.push(`${f1(U.bb9.v)} walks per nine (league ${f1(U.bb9.avg)})`);
    if (U.k9?.v != null) facts.push(`${f1(U.k9.v)} strikeouts per nine (league ${f1(U.k9.avg)})`);
    const g = U.growth;
    if (g?.armsN >= 2) {
      const avg = g.arms / g.armsN;
      score += avg >= 1.5 ? 0.08 : avg <= -0.5 ? -0.08 : 0;
      facts.push(`our young arms ${avg >= 0.5 ? `gained ${f1(avg)} points each` : avg <= -0.5 ? `slipped ${f1(-avg)} points each` : 'held steady'} over the winter`);
    }
  } else if (role === 'hittingCoach') {
    score = 0.8 * _rankScore(U.ops, of) + 0.1 * _rankScore(U.obp, of) + 0.1 * _rankScore(U.slg, of);
    if (U.ops?.v != null) facts.push(`a ${f3(U.ops.v)} team OPS (${rk(U.ops)})`);
    if (U.obp?.v != null) facts.push(`a ${f3(U.obp.v)} on-base percentage (league ${f3(U.obp.avg)})`);
    if (U.slg?.v != null) facts.push(`${f3(U.slg.v)} slugging (league ${f3(U.slg.avg)})`);
    const g = U.growth;
    if (g?.batsN >= 2) {
      const avg = g.bats / g.batsN;
      score += avg >= 1.5 ? 0.08 : avg <= -0.5 ? -0.08 : 0;
      facts.push(`our young hitters ${avg >= 0.5 ? `gained ${f1(avg)} points each` : avg <= -0.5 ? `slipped ${f1(-avg)} points each` : 'held steady'} over the winter`);
    }
  } else if (role === 'bullpenCoach') {
    const rate = U.svo ? U.bs / U.svo : null;
    score = 0.7 * _rankScore(U.rpEra, of) + 0.3 * (rate == null ? 0.5 : clamp(1 - (rate - 0.2) / 0.3, 0, 1));
    if (U.rpEra?.v != null) facts.push(`a ${f2(U.rpEra.v)} relief ERA (${rk(U.rpEra)})`);
    if (U.svo) facts.push(`${U.bs} blown save${U.bs === 1 ? '' : 's'} in ${U.svo} chances`);
  } else if (role === 'benchCoach') {
    const one = U.oneRun || { w: 0, l: 0 };
    const onePct = one.w + one.l >= 8 ? one.w / (one.w + one.l) : null;
    score = 0.5 * _rankScore(U.sbPct, of) + 0.5 * (onePct == null ? 0.5 : clamp((onePct - 0.35) / 0.3, 0, 1));
    if (U.sbN + U.csN > 0) facts.push(`${U.sbN} steals in ${U.sbN + U.csN} tries${U.sbPct?.rank ? ` (success rate ${rk(U.sbPct)})` : ''}`);
    if (one.w + one.l) facts.push(`a ${one.w}–${one.l} record in one-run games`);
  }
  score = clamp(score, 0, 1);
  const verdict = score >= 0.62 ? 'good' : score <= 0.38 ? 'poor' : 'fair';
  return { verdict, score: Math.round(score * 100) / 100, facts };
}

/** The specialty the unit needs most, from the review's units. */
export function neededSpecialty(role, U, state) {
  const half = (U?.of || 16) / 2;
  const bad = (m) => m?.rank != null && m.rank > half;
  const young = (pitch) => {
    if (!state) return 0;
    const year = baseballYear(state) + 1;
    return (state.userTeam?.rosterIds || []).map(id => state.players[id])
      .filter(p => p && isPitcher(p) === pitch && computeAge(p.dob, year) <= 25).length;
  };
  if (role === 'pitchingCoach') return bad(U?.bb9) ? 'command' : bad(U?.k9) ? 'power' : young(true) >= 4 ? 'youth' : 'command';
  if (role === 'hittingCoach')  return bad(U?.obp) ? 'contact' : bad(U?.slg) ? 'power' : young(false) >= 4 ? 'youth' : 'contact';
  if (role === 'bullpenCoach')  return U?.svo && U.bs / U.svo > 0.3 ? 'late' : 'command';
  if (role === 'benchCoach')    return bad(U?.sbPct) ? 'baserunning' : 'defense';
  return ROLE_INFO[role]?.specialties[0];
}

const BACKGROUNDS = {
  pitchingCoach: ['pitched eleven years in the majors', 'ran a farm system\'s pitching program', 'was a college pitching coach with a national title', 'came up through the minors as a pitching coordinator', 'was a pitching analyst before moving to the dugout'],
  hittingCoach:  ['hit .280 over a long big-league career', 'was the assistant hitting coach on a pennant winner', 'ran a hitting lab that pro players use in the winter', 'coached hitters in the minors for a decade', 'was a scout before turning to coaching'],
  bullpenCoach:  ['closed games for six seasons', 'caught for nine years and handled a lot of bullpens', 'was a minor-league pitching coach', 'ran a club\'s relief-pitcher program'],
  benchCoach:    ['managed in the minors for eight years', 'was a utility infielder known for reading the game', 'ran a club\'s defensive positioning', 'coached third base on two playoff teams'],
};

/**
 * candidates(state, role, U, { rand, taken }) — two people for the job.
 * The first fits what the unit needs (its specialty) and costs more; the
 * second brings something else, usually for less. Either can be the better
 * coach: the qualities are rolled, not promised.
 */
export function candidates(state, role, U, { rand = Math.random, taken = new Set() } = {}) {
  const info = ROLE_INFO[role];
  const need = neededSpecialty(role, U, state);
  const other = _pick(info.specialties.filter(s => s !== need), rand) || need;
  const free = STAFF_NAMES.filter(n => !taken.has(n));
  const names = [];
  while (names.length < 2 && free.length) names.push(free.splice(Math.floor(rand() * free.length) % free.length, 1)[0]);
  const bg = [...BACKGROUNDS[role]];
  const mk = (i, specialty, mean, premium) => {
    const quality = rollQuality(rand, mean, 10);
    return {
      name: names[i] || `Coach ${i + 1}`, role, specialty, quality,
      salary: Math.round(salaryFor(role, quality) * premium / 5) * 5,
      background: bg.splice(Math.floor(rand() * bg.length) % bg.length, 1)[0] || '',
      fits: specialty === need,
    };
  };
  return [mk(0, need, 68, 1.1), mk(1, other, 60, 0.95)];
}

/** What a coach whose deal is up asks for to stay (two more years). */
export function renewalAsk(role, coach, verdict) {
  const base = salaryFor(role, qualityOf(coach));
  const k = verdict === 'good' ? 1.1 : verdict === 'poor' ? 0.95 : 1.0;
  return Math.max(Math.round(base * k / 5) * 5, Math.round((coach?.salary || 0) * (verdict === 'good' ? 1.05 : 1) / 5) * 5);
}

export const coachContractIsUp = (coach, nextSeason) => !!coach && !coach.vacant && (coach.contractExpiry ?? 99) <= nextSeason;

/** What's still owed on a coach's deal, from next season through its last year ($K). */
export function buyoutOwed(coach, nextSeason) {
  if (!coach || coach.vacant) return 0;
  return Math.max(0, (coach.contractExpiry ?? nextSeason) - nextSeason) * (coach.salary || 0);
}

/** Renew a coach for two more years at `salary`. */
export function renewCoach(staff, role, salary, nextSeason) {
  const c = staff?.[role];
  if (!c || c.vacant) return null;
  c.contractExpiry = nextSeason + 2;
  c.salary = salary;
  c.relationship = Math.min(100, (c.relationship ?? 50) + 5);
  return c;
}

/** The chair is empty (let go, or fired). */
export function vacate(staff, role) {
  const c = staff?.[role];
  if (!c) return null;
  staff[role] = { vacant: true, name: '', salary: 0, contractExpiry: null, relationship: 50, prev: c.vacant ? c.prev : c.name };
  return staff[role];
}

/** Hire a candidate on a two-year deal. */
export function hire(staff, role, cand, nextSeason) {
  staff[role] = {
    name: cand.name, salary: cand.salary, contractExpiry: nextSeason + 2, relationship: 50,
    quality: cand.quality, specialty: cand.specialty, background: cand.background || '', hiredSeason: nextSeason,
  };
  return staff[role];
}

/** Why the unit needs that specialty, in last season's numbers ("command: we walked 3.6 per nine, the league 3.2"). */
export function needReason(role, spec, U) {
  const g = (m, f) => (m?.v != null ? f(m.v) : '—');
  const lg = (m, f) => (m?.avg != null ? f(m.avg) : '—');
  if (role === 'pitchingCoach') {
    if (spec === 'command') return `command: our pitchers walked ${g(U?.bb9, f1)} per nine innings, the league ${lg(U?.bb9, f1)}`;
    if (spec === 'power')   return `swing-and-miss: ${g(U?.k9, f1)} strikeouts per nine, the league ${lg(U?.k9, f1)}`;
    return 'a teacher for the young arms on the staff';
  }
  if (role === 'hittingCoach') {
    if (spec === 'contact') return `contact: a ${g(U?.obp, f3)} on-base percentage, the league ${lg(U?.obp, f3)}`;
    if (spec === 'power')   return `power: ${g(U?.slg, f3)} slugging, the league ${lg(U?.slg, f3)}`;
    return 'a teacher for the young hitters in the lineup';
  }
  if (role === 'bullpenCoach') {
    if (spec === 'late') return `the late innings: ${U?.bs ?? 0} blown saves in ${U?.svo ?? 0} chances`;
    return 'strike-throwing out of the bullpen';
  }
  if (role === 'benchCoach') {
    if (spec === 'baserunning') return `baserunning: ${U?.sbN ?? 0} steals in ${(U?.sbN ?? 0) + (U?.csN ?? 0)} tries`;
    return 'defense and positioning';
  }
  return specialtyShort(spec);
}
