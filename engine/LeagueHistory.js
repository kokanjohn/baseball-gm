/**
 * engine/LeagueHistory.js — §122.9 the league's past.
 *
 * The GM takes over a club in a league that already existed. When a league is
 * created, every player gets the seasons he has already played: how many
 * depends on his age and how good he was along the way; each season is played
 * from his ratings at that age (worked back along the §4.1 age curves) through
 * the game's own plate-appearance model (SimEngine.plateAppearanceRates), so
 * the history matches how he plays. Seasons only — no clubs.
 *
 * Players with no league record carry an origin (PLAYER_ORIGIN): a rookie,
 * someone who played overseas, or independent ball.
 *
 * Pure: takes players and context, writes their seasonLog / careerStats /
 * origin in place (callers pass drafts or freshly built players). The caller
 * supplies the randomness (`rand`), one stream per player.
 */

import { plateAppearanceRates } from './SimEngine.js';
import { computeOVR, computeAge, _freshStats } from './PlayerFactory.js';
import {
  HISTORY, PLAYER_ORIGIN, AGE_CURVES, AGE_DEVELOPMENT_WINDOWS,
  SUB_RATING_MIN, SUB_RATING_MAX, SIM_RATING_AVG, IMP_LEAGUE_AVG_ERA,
} from '../data/constants.js';

const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const roleOf = (p) => (p.pos === 'SP' ? 'SP' : p.pos === 'RP' ? 'RP' : 'hitter');

/** The origin a market kind implies for a player with no league seasons. */
export function originForKind(kind) {
  return kind === 'intl' ? PLAYER_ORIGIN.OVERSEAS
    : kind === 'indie' ? PLAYER_ORIGIN.INDEPENDENT
    : PLAYER_ORIGIN.ROOKIE;
}

/**
 * writeHistoryForKind(player, ctx) — by the market kind a free agent was made as:
 * a prospect is a rookie, an international player played abroad, an
 * independent-ball player mostly has no league record (some had a short stint);
 * veterans have 3+ seasons and depth players at least one. Anyone else (a
 * rostered player) gets whatever his age and ratings give.
 */
export function writeHistoryForKind(p, ctx) {
  const kind = p?._marketKind;
  const opts = { ...ctx };
  if (kind === 'prospect' || kind === 'intl') opts.origin = originForKind(kind);
  else if (kind === 'indie') { opts.origin = originForKind(kind); opts.someLeague = ctx.rand() < 0.4; }
  else if (kind === 'veteran') opts.atLeast = 3;
  else if (kind === 'depth') opts.atLeast = 1;
  return writeHistory(p, opts);
}

/**
 * writeHistory(player, ctx)
 *   ctx: { year, seasonNum, level, norms, rand,
 *          origin?   — force no league record (rookie / overseas / independent)
 *          atLeast?  — at least this many seasons (an established free agent) }
 * Writes p.seasonLog (oldest first, before any existing entries), adds the
 * seasons to p.careerStats, and sets p.origin. Returns the number of seasons.
 */
export function writeHistory(p, ctx) {
  if (!p?.subRatings || !p.dob) return 0;
  const { year, seasonNum = 1, level = 0, norms = null, rand } = ctx;
  if (ctx.origin && ctx.origin !== PLAYER_ORIGIN.LEAGUE && !(ctx.origin === PLAYER_ORIGIN.INDEPENDENT && ctx.someLeague)) {
    p.origin = ctx.origin;
    return 0;
  }
  const role = roleOf(p);
  const keys = isPitcher(p) ? ['control', 'stuff', 'stamina'] : ['contact', 'power', 'speed'];
  const age  = computeAge(p.dob, year);

  // Walk back a season at a time: his ratings that year, and whether he played.
  const seasons = [];
  let sr = { ...p.subRatings };
  for (let k = 1; age - k >= HISTORY.firstAge; k++) {
    sr = _backOneYear(sr, keys, age - k + 1, p.trait, rand);
    const ovr = computeOVR(sr);
    const rel = ovr - level;
    const pIn = 1 / (1 + Math.exp(-HISTORY.inLeagueSlope * (rel - HISTORY.inLeagueMid[role])));
    if (rand() >= pIn) {
      if (age - k < HISTORY.minorsStopAge) break;   // he hadn't arrived yet
      continue;                                      // a year in the minors (or hurt)
    }
    seasons.push({ k, sr: { ...sr }, ovr, rel });
  }
  // An established player has a record, however thin.
  if (seasons.length < (ctx.atLeast || 0) && age - 1 >= HISTORY.firstAge) {
    while (seasons.length < ctx.atLeast && age - 1 - seasons.length >= HISTORY.firstAge) {
      const k = (seasons.at(-1)?.k || 0) + 1;
      const s0 = seasons.at(-1)?.sr || p.subRatings;
      const s1 = _backOneYear({ ...s0 }, keys, age - k + 1, p.trait, rand);
      seasons.push({ k, sr: s1, ovr: computeOVR(s1), rel: computeOVR(s1) - level, thin: true });
    }
  }
  if (!seasons.length) {
    p.origin = ctx.origin || PLAYER_ORIGIN.ROOKIE;
    return 0;
  }

  const N = norms || {};
  const entries = seasons.reverse().map(({ k, sr: s, ovr, rel, thin }) => ({
    season: seasonNum - k, year: year - k, teamId: null, ovr,
    stats: role === 'hitter' ? _hitterSeason(s, rel, N, rand, thin) : _pitcherSeason(s, rel, role, N, rand, thin),
    postseason: null, past: true,
  }));

  p.seasonLog = [...entries, ...(p.seasonLog || [])];
  const career = { ...(p.careerStats || {}) };
  for (const e of entries) {
    for (const [key, v] of Object.entries(e.stats)) if (typeof v === 'number') career[key] = (career[key] || 0) + v;
    career.seasons = (career.seasons || 0) + 1;
    if (e.ovr > (career.peakOvr || 0)) { career.peakOvr = e.ovr; career.peakSeason = e.season; }
  }
  p.careerStats = career;
  p.origin = ctx.origin === PLAYER_ORIGIN.INDEPENDENT ? PLAYER_ORIGIN.INDEPENDENT : PLAYER_ORIGIN.LEAGUE;
  return entries.length;
}

// ─────────────────────────────────────────────────────────────
// RATINGS A YEAR EARLIER
// ─────────────────────────────────────────────────────────────

/** His ratings the season before the one he played at `ageThen + 1`… i.e. undo that winter's change. */
function _backOneYear(sr, keys, ageAfter, trait, rand) {
  const W = AGE_DEVELOPMENT_WINDOWS;
  const idx = ageAfter <= W.GROWTH.max ? 0 : ageAfter <= W.PEAK.max ? 1 : ageAfter <= W.PRIME.max ? 2 : ageAfter <= W.DECLINE.max ? 3 : 4;
  const out = { ...sr };
  keys.forEach((key, i) => {
    if (out[key] == null) return;
    let change = AGE_CURVES[i][idx];
    if (trait === 'youngGun' && ageAfter < 28) change += 1;
    else if (trait === 'veteran' && ageAfter >= 30 && i === 0 && change < 0) change *= 0.5;
    const spread = trait === 'consistent' ? 1 : trait === 'volatile' ? 4 : 2;
    const variance = Math.floor(rand() * (2 * spread + 1)) - spread;
    const delta = Math.max(-5, Math.min(4, Math.round(change + variance)));
    out[key] = Math.max(SUB_RATING_MIN, Math.min(SUB_RATING_MAX, out[key] - delta));
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// A SEASON'S LINE
// ─────────────────────────────────────────────────────────────

function _playingTime(role, rel, rand, thin) {
  const table = HISTORY.playing[role];
  const [, lo, hi] = thin ? table[table.length - 1] : table.find(([min]) => rel >= min);
  let n = lo + rand() * (hi - lo);
  if (rand() < HISTORY.injuredShare) n *= 0.25 + rand() * 0.45;
  return n;
}

const _eff = (v) => Math.max(40, v ?? 55);   // as SimEngine._effectiveSR (uncoached, healthy)
const _binom = (n, p, rand) => { let x = 0; const q = Math.max(0, Math.min(1, p)); for (let i = 0; i < n; i++) if (rand() < q) x++; return x; };
const _gauss = (rand) => { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** One plate appearance's outcome from the model's rates. */
function _pa(R, rand) {
  let r = rand();
  if (r < R.walk) return 'bb';
  r -= R.walk;
  if (r < R.hbp) return 'hbp';
  r -= R.hbp;
  if (r < R.k) return 'k';
  r -= R.k;
  if (r >= R.hit) return 'out';
  const h = rand();
  if (h < R.hrShare) return 'hr';
  if (h < R.hrShare + R.tripleShare) return '3b';
  if (h < R.hrShare + R.tripleShare + R.xbhShare) return '2b';
  return '1b';
}

/**
 * seasonLine(player, n, norms, rand) — a season from his current ratings with a
 * given playing time (PA for a hitter, IP for a pitcher). For checks: the
 * history's lines should look like the game's own seasons.
 */
export function seasonLine(p, n, norms, rand, level = 0) {
  const rel = (p.ovr || 0) - level;
  return isPitcher(p) ? _pitcherSeason(p.subRatings, rel, roleOf(p), norms || {}, rand, false, n)
                      : _hitterSeason(p.subRatings, rel, norms || {}, rand, false, n);
}

function _hitterSeason(sr, rel, N, rand, thin, fixedPA = null) {
  const A = SIM_RATING_AVG;
  const pa = Math.max(1, Math.round(fixedPA ?? _playingTime('hitter', rel, rand, thin)));
  const R = plateAppearanceRates({
    contact: _eff(sr.contact), power: _eff(sr.power), speed: _eff(sr.speed),
    stuff: N.stuff ?? A, control: N.control ?? A,
  }, N, { walk: [HISTORY.walkMod] });
  const st = _freshStats(false);
  let singles = 0, triples = 0;
  for (let i = 0; i < pa; i++) {
    const o = _pa(R, rand);
    if (o === 'bb') st.bb++;
    else if (o === 'hbp') st.hbp++;
    else if (o === 'k') st.k++;
    else if (o === 'hr') st.hr++;
    else if (o === '3b') triples++;
    else if (o === '2b') st.doubles++;
    else if (o === '1b') singles++;
  }
  const H = HISTORY;
  const sf = _binom(pa, H.sfPerPA, rand);
  st.h  = singles + st.doubles + triples + st.hr;
  st.doubles += triples;                       // (no triples column: they count as extra-base hits, and in TB)
  st.tb = singles + 2 * (st.doubles - triples) + 3 * triples + 4 * st.hr;
  st.ab = Math.max(st.h, pa - st.bb - st.hbp - sf);
  st.sf = sf;
  st.g  = Math.min(H.maxGames, Math.max(1, Math.round(pa * H.gamesPerPA)));
  const As = N.speed ?? A, Ap = N.power ?? A;
  const speed = _eff(sr.speed), power = _eff(sr.power);
  const onBase = st.h + st.bb + st.hbp - st.hr;
  st.r   = st.hr + _binom(onBase, H.runBase + H.runPerSpeed * (speed - As), rand);
  st.rbi = st.hr + _binom(st.h - st.hr, H.rbiBase + H.rbiPerPower * (power - Ap), rand);
  const onFirst = singles + st.bb + st.hbp;
  st.sb = _binom(onFirst, H.sbBase + H.sbPerSpeed * (speed - As), rand);
  st.cs = _binom(onFirst, H.csBase + H.csPerSpeed * (speed - As), rand);
  return st;
}

function _pitcherSeason(sr, rel, role, N, rand, thin, fixedIP = null) {
  const A = SIM_RATING_AVG;
  const H = HISTORY;
  const outsTarget = Math.max(1, Math.round((fixedIP ?? _playingTime(role, rel, rand, thin)) * 3));
  const R = plateAppearanceRates({
    contact: N.contact ?? A, power: N.power ?? A, speed: N.speed ?? A,
    stuff: _eff(sr.stuff), control: _eff(sr.control),
  }, N, { walk: [HISTORY.walkMod] });
  const st = _freshStats(true);
  let outs = 0;
  while (outs < outsTarget) {
    const o = _pa(R, rand);
    if (o === 'bb') st.bb++;
    else if (o === 'hbp') st.hbp++;
    else if (o === 'k') { st.k++; outs++; }
    else if (o === 'out') outs++;
    else { st.h_allowed++; if (o === 'hr') st.hr_allowed++; }
  }
  const ip = Math.round(outs / 3 * 1000) / 1000;
  st.ip = ip;
  const [cH, cW, cHR, cIP] = H.er;
  const erMean = cH * (st.h_allowed - st.hr_allowed) + cW * (st.bb + st.hbp) + cHR * st.hr_allowed + cIP * ip;
  st.er = Math.max(0, Math.round(erMean + _gauss(rand) * Math.sqrt(Math.max(1, erMean)) * 0.6));
  const era = ip > 0 ? st.er / ip * 9 : IMP_LEAGUE_AVG_ERA;
  const good = IMP_LEAGUE_AVG_ERA - era;       // runs a game better than the league
  if (role === 'SP') {
    st.gs = Math.max(1, Math.round(ip / H.ipPerStart));
    st.g  = st.gs + (rand() < 0.3 ? Math.floor(rand() * 4) : 0);
    const dec = _binom(st.gs, 0.72, rand);
    st.w  = _binom(dec, Math.max(0.25, Math.min(0.75, 0.5 + good * 0.06)), rand);
    st.l  = dec - st.w;
    st.qs = _binom(st.gs, Math.max(0.1, Math.min(0.8, 0.43 + good * 0.08)), rand);
  } else {
    st.g = Math.min(75, Math.max(1, Math.round(ip * 0.99)));
    st.w = _binom(st.g, 0.057, rand);
    st.l = _binom(st.g, 0.064, rand);
    // Late-inning work goes to the better arms.
    const closer = rel >= 50 && rand() < 0.45, setup = !closer && rel >= 44;
    st.svo = closer ? _binom(st.g, 0.45, rand) : _binom(st.g, setup ? 0.06 : 0.02, rand);
    st.sv  = _binom(st.svo, Math.max(0.5, Math.min(0.95, 0.78 + good * 0.03)), rand);
    st.hld = setup ? _binom(st.g, 0.24, rand) : _binom(st.g, 0.05, rand);
    st.bs  = (st.svo - st.sv) + _binom(st.hld, 0.08, rand);
  }
  return st;
}
