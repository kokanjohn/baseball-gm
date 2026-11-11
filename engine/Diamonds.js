/**
 * engine/Diamonds.js — §122.9 untested players and diamonds in the rough.
 *
 * TRUE AND SHOWN RATINGS. A veteran's ratings are what years of stats prove.
 * An untested player's (a rookie, a player from abroad or from independent
 * ball) are the scouts' estimate: his true sub-ratings are shown + gap
 * (p._ratingGap). Only the games use the truth (SimEngine / PitchingEngine via
 * playingRating); everything a person or a club judges by (OVR, the screens,
 * CPU decisions) sees the shown ratings. As he plays — or works with the
 * coaches — the gap closes and the shown ratings move to the truth
 * (exposeRatings). Development moves the shown ratings, so the truth moves
 * with them (the gap is kept).
 *
 * DIAMONDS. A free agent worth DIAMOND.edge or more above his shown OVR:
 * unproven upside (a big positive gap), or a proven role fit (OVR counts speed
 * and stamina a quarter each; a slugger's at-bats or a one-inning reliever's
 * batters barely use them). When one becomes available he gets a hidden date
 * (p._buzzAt) when word gets around; from then CPU clubs value him at his worth
 * (cpuView). Before it, they see his rating like everyone else.
 *
 * Pure: players in, players mutated (drafts or freshly built objects).
 */

import { computeOVR } from './PlayerFactory.js';
import { DIAMOND, SUB_RATING_MIN, SUB_RATING_MAX, PLAYER_ORIGIN } from '../data/constants.js';

const DAY_MS = 86_400_000;
const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const keysOf = (p) => (isPitcher(p) ? ['stuff', 'control', 'stamina'] : ['contact', 'power', 'speed']);
const clampSR = (v) => Math.max(SUB_RATING_MIN, Math.min(SUB_RATING_MAX, v));

/** The rating the games play him at: the truth (shown + gap). */
export function playingRating(p, key) {
  const v = p?.subRatings?.[key];
  if (v == null) return v;
  const g = p._ratingGap?.[key];
  return g ? clampSR(v + g) : v;
}

/** His true sub-ratings. */
export function trueRatings(p) {
  const sr = { ...(p?.subRatings || {}) };
  for (const k of Object.keys(p?._ratingGap || {})) if (sr[k] != null) sr[k] = playingRating(p, k);
  return sr;
}

export const trueOVR = (p) => computeOVR(trueRatings(p));

/** What his role actually uses: a hitter's bat (speed a little), a reliever's stuff and control. A starter needs it all. */
function _roleValue(sr, p) {
  if (!isPitcher(p)) return Math.round(0.5 * sr.contact + 0.45 * sr.power + 0.05 * sr.speed);
  if (p.pos === 'RP') return Math.round(0.53 * sr.stuff + 0.47 * sr.control);
  return computeOVR(sr);
}

/** What he's really worth to a club, on the OVR scale. */
export function worthOf(p) {
  const sr = trueRatings(p);
  return Math.max(computeOVR(sr), _roleValue(sr, p));
}

export const isDiamond = (p, level = 0) => !!p && worthOf(p) - (p.ovr || 0) >= DIAMOND.edge
  && worthOf(p) - level >= DIAMOND.minWorthRel;

/** How a CPU club sees him: his rating, or — once word has got around — his worth. */
export function cpuView(p, atMs) {
  if (!p) return 0;
  return Number.isFinite(p._buzzAt) && atMs >= p._buzzAt ? Math.max(p.ovr || 0, worthOf(p)) : (p.ovr || 0);
}

/**
 * markAvailable(p, atMs, rand) — he's just become available (the opening pool,
 * a new class, a scouting find, a release). A diamond gets the day word gets
 * around; anyone else loses an old one.
 */
export function markAvailable(p, atMs, rand, level = 0) {
  if (!p) return;
  delete p._tipRolled; delete p._tipAt;   // §122.15 a new chance for our director's tip
  if (isDiamond(p, level)) {
    const [lo, hi] = DIAMOND.buzzDays;
    p._buzzAt = atMs + Math.round((lo + rand() * (hi - lo)) * DAY_MS);
  } else {
    delete p._buzzAt;
  }
}

/** An untested player's estimate error (no-op for a player with a league record). */
export function giveUntestedGap(p, rand) {
  const sigma = DIAMOND.sigma[p?.origin];
  if (!sigma || !p.subRatings) return;
  const gap = {};
  for (const k of keysOf(p)) {
    const g = Math.max(-DIAMOND.gapMax, Math.min(DIAMOND.gapMax, Math.round(_gauss(rand) * sigma)));
    const t = clampSR(p.subRatings[k] + g) - p.subRatings[k];
    if (t) gap[k] = t;
  }
  _setGap(p, gap);
}

function _setGap(p, gap) {
  if (Object.keys(gap).length) { p._ratingGap = gap; p._gap0 = { ...gap }; p._exposure = 0; }
  else { delete p._ratingGap; delete p._gap0; delete p._exposure; }
}

/**
 * exposeRatings(p, n) — he played n PA / batters faced (or the coaches worked
 * with him): the gap closes, the shown ratings move to the truth.
 * @returns {Boolean} whether his shown ratings changed
 */
export function exposeRatings(p, n) {
  if (!p?._ratingGap || !(n > 0)) return false;
  p._exposure = (p._exposure || 0) + n;
  const keep = Math.exp(-p._exposure / DIAMOND.revealN);
  let changed = false;
  for (const k of Object.keys(p._ratingGap)) {
    const g = p._ratingGap[k];
    const g1 = Math.round((p._gap0?.[k] ?? g) * keep);
    if (g1 === g) continue;
    p.subRatings[k] = clampSR(p.subRatings[k] + (g - g1));   // the truth stays put; the estimate moves to it
    p._ratingGap[k] = g1;
    changed = true;
  }
  if (changed) {
    for (const k of Object.keys(p._ratingGap)) if (!p._ratingGap[k]) delete p._ratingGap[k];
    if (!Object.keys(p._ratingGap).length) { delete p._ratingGap; delete p._gap0; }
    p.ovr = computeOVR(p.subRatings);
  }
  return changed;
}

// ─────────────────────────────────────────────────────────────
// SEEDING
// ─────────────────────────────────────────────────────────────

/** Unproven upside: an untested player who is really a lineup or bullpen player (DIAMOND.upsideTrueRel). */
export function makeUpside(p, level, rand) {
  const [lo, hi] = DIAMOND.upsideTrueRel;
  const target = level + lo + Math.floor(rand() * (hi - lo + 1));
  const need = Math.max(0, target - (p.ovr || 0));   // OVR points to find
  const [a, b, c] = keysOf(p);   // the two that matter most carry it (OVR weights .40 / .35)
  const gap = {};
  for (const [k, share] of [[a, 1.05], [b, 1.05], [c, 0.3]]) {
    const g = Math.min(DIAMOND.gapMaxSeeded, Math.round(need * share + (rand() * 2 - 1)));
    const t = clampSR(p.subRatings[k] + g) - p.subRatings[k];
    if (t) gap[k] = t;
  }
  _setGap(p, gap);
}

/**
 * makeRoleFit(p, level, rand) — reshape a proven player into a role fit: the
 * same shown OVR band (DIAMOND.roleShownRel above the league), but the speed
 * (a hitter) or stamina (a reliever) at the floor and the rest in the bat or
 * the arm. Call before his history is written, so his record shows it.
 */
export function makeRoleFit(p, level, rand) {
  const T = level + DIAMOND.roleShownRel + Math.floor(rand() * 2);
  const low = SUB_RATING_MIN + Math.floor(rand() * 3);
  const v = (T - 0.25 * low) / 0.75;   // .4a + .35b = .75v with a = v + x, b = v − (.4/.35)x
  const sr = p.subRatings;
  if (isPitcher(p)) { sr.stamina = low; sr.stuff = clampSR(Math.round(v + 4)); sr.control = clampSR(Math.round(v - 4.57)); }
  else              { sr.speed = low;   sr.power = clampSR(Math.round(v + 4)); sr.contact = clampSR(Math.round(v - 3.5)); }
  p.ovr = computeOVR(sr);
  _setGap(p, {});
}

/**
 * seedOpeningDiamonds(players, level, rand) — the opening pool's diamonds:
 * role fits among the proven depth hitters and relievers, unproven upside
 * among the untested. Role fits first (before the league's past is written);
 * upside after (it needs the origin the past gives).
 */
export function seedRoleFits(players, level, rand, n = DIAMOND.opening.role) {
  const pool = Object.values(players).filter(p => p._marketKind === 'depth' && (p.pos === 'RP' || !isPitcher(p)));
  _pick(pool, n, rand).forEach(p => makeRoleFit(p, level, rand));
}
export function seedUpside(players, level, rand, n = DIAMOND.opening.upside) {
  const pool = Object.values(players).filter(p => p.group === 'freeAgent' && p.origin && p.origin !== PLAYER_ORIGIN.LEAGUE
    && (p.ovr || 0) - level >= DIAMOND.upsideShownMin);
  _pick(pool, n, rand).forEach(p => makeUpside(p, level, rand));
}

function _pick(arr, n, rand) {
  const a = [...arr].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]);
  return out;
}

function _gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
