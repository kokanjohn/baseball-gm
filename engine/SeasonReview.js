/**
 * engine/SeasonReview.js
 * §112 The season, looked back on, the morning after it ends: how it went
 * (the record, where it finished, the postseason, against the owner's
 * target), what worked and what didn't (where the club ranked in runs scored
 * and allowed; the rotation and the bullpen), who carried it and who let it
 * down, and what the winter has to fix (the two biggest holes). Every
 * offseason message reads from it, so its tone fits the year the club had.
 *
 * Pure: reads a state (after the season is locked and the stats archived —
 * OffseasonEngine.beginOffseason), returns plain data for state.offseason.review.
 */

import { PLAYER_GROUP } from '../data/constants.js';
import { clubNeeds, leagueNorms } from './LeagueTrades.js';
import { computeAge, baseballYear } from './PlayerFactory.js';
import { seasonTarget } from './FinanceEngine.js';
import { contractIsUp } from './OffseasonEngine.js';
import { lastSeasonIMP } from './IMPEngine.js';
import { scoutSpecFor } from './CoachEngine.js';

const isPitcher = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const era = (er, ip) => (ip > 0 ? (9 * er) / ip : null);
const ops = (s) => {
  const pa = (s.ab || 0) + (s.bb || 0) + (s.hbp || 0);
  const obp = pa ? ((s.h || 0) + (s.bb || 0) + (s.hbp || 0)) / pa : 0;
  const slg = s.ab ? (s.tb || 0) / s.ab : 0;
  return { obp, slg, ops: obp + slg, avg: s.ab ? (s.h || 0) / s.ab : 0 };
};

/** Runs scored and allowed by every club in the regular season (from the results). */
function _runs(state) {
  const by = {};
  const add = (id, rs, ra) => { const r = by[id] || (by[id] = { rs: 0, ra: 0, g: 0 }); r.rs += rs; r.ra += ra; r.g++; };
  for (const g of state.schedule || []) {
    if (!g._committed || g.isSpring || g.isPlayoff || g.result === 'postponed' || !g.score) continue;
    add('user', g.score.us || 0, g.score.them || 0);
    if (g.opponentId) add(g.opponentId, g.score.them || 0, g.score.us || 0);
  }
  for (const games of Object.values(state.leagueSchedule?.dayMap || {})) {
    for (const g of games) {
      if (!g.played || g.isSpring || g.isPlayoff || g.isAllStar || g.cancelled || g._void) continue;
      add(g.homeId, g.homeScore || 0, g.awayScore || 0);
      add(g.awayId, g.awayScore || 0, g.homeScore || 0);
    }
  }
  return by;
}

/** A player's line for the season just finished (archived into seasonLog). */
function _line(p, season) {
  return (p.seasonLog || []).filter(x => x.season === season).pop()?.stats || null;
}

/** "shortstop (Ju, 58)" — a need in words. */
function needWords(state, n) {
  const p = state.players[n.incumbentId];
  const who = p ? `${p.name}, ${p.ovr}` : 'nobody established';
  const slot = { C: 'catcher', '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', OF: 'the outfield', LF: 'left field', CF: 'center field', RF: 'right field', DH: 'designated hitter' };
  if (n.kind === 'sp') return { short: 'starting pitching', long: `the back of the rotation (${who})` };
  if (n.kind === 'rp') return { short: 'the bullpen', long: `the bullpen (${who})` };
  return { short: slot[n.slot] || n.slot, long: `${slot[n.slot] || n.slot} (${who})` };
}

export function seasonReview(state) {
  const season = state.seasonNum || 1;
  const u = state.userTeam || {};
  const hist = (state.seasonHistory || []).filter(h => h.seasonNum === season).pop() || {};
  const w = hist.wins ?? u.wins ?? 0, l = hist.losses ?? u.losses ?? 0;
  const pct = w + l ? w / (w + l) : 0.5;
  const target = hist.winTarget ?? u._ownerWinTarget ?? null;
  const post = hist.postseason?.result || 'Did not qualify';

  // Where it finished: the division, and the gap to the last playoff spot (five go).
  const div = (hist.standings || []).filter(t => t.divisionId === (u.divisionId || 'A'))
    .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses));
  const place = div.findIndex(t => t.id === 'user') + 1 || null;
  const cut = div[4];
  const gamesOut = cut && place > 5 ? ((cut.wins - w) + (l - cut.losses)) / 2 : 0;

  // §112.6 All five clubs in a division play in October (§26.1, LOCKED), so a
  // playoff trip alone says little: the year is judged by how far the club
  // went and its record. A real run is a series won or a strong record; an
  // early exit after a .500 year is a middling one ('near'); a losing year is
  // 'missed' whatever the bracket says; under .420, a disaster.
  const wonRound = /Division Series|World Series|Champions/.test(post);
  const outcome = post === 'Champions' ? 'champion'
    : post === 'Lost in the World Series' ? 'pennant'
    : pct < 0.42 ? 'disaster'
    : (wonRound || pct >= 0.55) && post !== 'Did not qualify' ? 'playoffs'
    : pct >= 0.49 ? 'near' : 'missed';

  // What worked: the league's ranks in runs scored (1 = most) and allowed (1 = fewest).
  const runs = _runs(state);
  const clubs = Object.entries(runs).filter(([, r]) => r.g >= 20);
  const rank = (key, asc) => 1 + clubs.filter(([id, r]) => id !== 'user' && (asc ? r[key] < (runs.user?.[key] ?? 0) : r[key] > (runs.user?.[key] ?? 0))).length;
  const offense = { runs: runs.user?.rs || 0, rank: rank('rs', false), of: clubs.length };
  const pitching = { runs: runs.user?.ra || 0, rank: rank('ra', true), of: clubs.length };

  // The staff, split: the rotation and the bullpen.
  const mine = Object.values(state.players || {}).filter(p => (p.seasonLog || []).some(x => x.season === season && x.teamId === 'user'));
  let spIp = 0, spEr = 0, rpIp = 0, rpEr = 0, bs = 0, sv = 0;
  const arms = [], bats = [];
  for (const p of mine) {
    const s = _line(p, season);
    if (!s) continue;
    if (isPitcher(p)) {
      const starter = (s.gs || 0) >= Math.max(1, (s.g || 0) / 2);
      if (starter) { spIp += s.ip || 0; spEr += s.er || 0; } else { rpIp += s.ip || 0; rpEr += s.er || 0; }
      bs += s.bs || 0; sv += s.sv || 0;
      arms.push({ p, s, starter, era: era(s.er || 0, s.ip || 0) });
    } else if ((s.ab || 0) > 0) bats.push({ p, s, ...ops(s) });
  }
  const rotation = { era: era(spEr, spIp), ip: Math.round(spIp) };
  const bullpen = { era: era(rpEr, rpIp), ip: Math.round(rpIp), blownSaves: bs, saves: sv };

  // Who carried it, and who let it down.
  const hitters = bats.filter(x => (x.s.ab || 0) >= 250).sort((a, b) => b.ops - a.ops);
  const starters = arms.filter(x => x.starter && (x.s.ip || 0) >= 100).sort((a, b) => a.era - b.era);
  const relievers = arms.filter(x => !x.starter && (x.s.ip || 0) >= 40).sort((a, b) => a.era - b.era);
  const stars = [];
  if (hitters[0]) stars.push({ id: hitters[0].p.id, kind: 'bat', line: `${fmt3(hitters[0].avg)}/${fmt3(hitters[0].obp)}/${fmt3(hitters[0].slg)}${hitters[0].s.hr ? `, ${hitters[0].s.hr} HR` : ''}` });
  if (starters[0]) stars.push({ id: starters[0].p.id, kind: 'arm', line: `${starters[0].era.toFixed(2)} ERA in ${Math.round(starters[0].s.ip)} innings` });
  if (relievers[0] && relievers[0].era < 2.8) stars.push({ id: relievers[0].p.id, kind: 'pen', line: `${relievers[0].era.toFixed(2)} ERA${relievers[0].s.sv ? `, ${relievers[0].s.sv} saves` : ''}` });
  const ovrs = mine.map(p => p.ovr || 0).sort((a, b) => a - b);
  const median = ovrs[Math.floor(ovrs.length / 2)] || 60;
  const letdowns = [
    ...bats.filter(x => (x.s.ab || 0) >= 200 && x.ops < 0.640 && (x.p.ovr || 0) >= median + 3).map(x => ({ id: x.p.id, kind: 'bat', line: `${fmt3(x.avg)}/${fmt3(x.obp)}/${fmt3(x.slg)}` , score: 0.64 - x.ops })),
    ...arms.filter(x => x.starter && (x.s.ip || 0) >= 70 && x.era > 5.2 && (x.p.ovr || 0) >= median + 3).map(x => ({ id: x.p.id, kind: 'arm', line: `${x.era.toFixed(2)} ERA`, score: (x.era - 5.2) / 4 })),
  ].sort((a, b) => b.score - a.score).slice(0, 1);

  // What the winter has to fix: the two biggest holes, on the roster as it stands now.
  const needs = clubNeeds(state, 'user', leagueNorms(state), { all: true })
    .filter((n, i, all) => all.findIndex(x => (x.kind === 'slot' ? x.slot : x.kind) === (n.kind === 'slot' ? n.slot : n.kind)) === i)
    .slice(0, 2).map(n => ({ kind: n.kind, slot: n.slot || null, incumbentId: n.incumbentId, ovr: n.ovr, gap: Math.round(n.gap * 10) / 10, ...needWords(state, n) }));

  // The money and the contracts.
  const year = baseballYear(state);
  const fin = u.finances || {};
  const expiring = (u.rosterIds || []).map(id => state.players[id])
    .filter(p => p && contractIsUp(p, season) && p.group !== PLAYER_GROUP.RETIRED).map(p => p.id);
  const core = (u.rosterIds || []).map(id => state.players[id])
    .filter(p => p && computeAge(p.dob, year) <= 26 && (p.ovr || 0) >= median + 4).sort((a, b) => b.ovr - a.ovr).slice(0, 3).map(p => p.id);

  return {
    season, year, w, l, pct: Math.round(pct * 1000) / 1000, target, vsTarget: target == null ? null : w - target,
    post, outcome, place, of: div.length || null, gamesOut,
    offense, pitching, rotation, bullpen, stars, letdowns, needs,
    payroll: fin.payroll || 0, payrollTarget: fin.payrollTarget ? seasonTarget(fin) : null,
    units: _units(state, season),
    gate: _gate(state),
    expiring, core, injuries: (state.history || []).filter(h => h.type === 'injury' && h.season === season).length,
  };
}

/**
 * §112.2 Each coach's side of the game, against the league: the rotation and
 * the bullpen (ERA rank, walks and strikeouts per nine, blown saves), the
 * lineup (OPS rank, on-base and slugging against the league), the bases
 * (steals and caught stealing), one-run games, and how the club's young
 * players grew over the winter (the day-1 development, by side).
 * Clubs are built from each player's archived line for the season (where he
 * finished it).
 */
function _units(state, season) {
  const by = {};
  const T = (id) => by[id] || (by[id] = { spIp: 0, spEr: 0, rpIp: 0, rpEr: 0, ip: 0, bbA: 0, kA: 0, ab: 0, h: 0, bb: 0, hbp: 0, tb: 0, sb: 0, cs: 0, bs: 0, svo: 0 });
  for (const p of Object.values(state.players || {})) {
    const e = (p?.seasonLog || []).filter(x => x.season === season).pop();
    if (!e || !e.teamId) continue;
    const s = e.stats || {}, t = T(e.teamId);
    if (isPitcher(p)) {
      const starter = (s.gs || 0) >= Math.max(1, (s.g || 0) / 2);
      if (starter) { t.spIp += s.ip || 0; t.spEr += s.er || 0; } else { t.rpIp += s.ip || 0; t.rpEr += s.er || 0; }
      t.ip += s.ip || 0; t.bbA += s.bb || 0; t.kA += s.k || 0; t.bs += s.bs || 0; t.svo += s.svo || 0;
    } else {
      t.ab += s.ab || 0; t.h += s.h || 0; t.bb += s.bb || 0; t.hbp += s.hbp || 0; t.tb += s.tb || 0;
      t.sb += s.sb || 0; t.cs += s.cs || 0;
    }
  }
  const clubs = Object.entries(by).filter(([, t]) => t.ip >= 300 && t.ab >= 1500);
  const of = clubs.length;
  const val = {
    spEra: (t) => era(t.spEr, t.spIp), rpEra: (t) => era(t.rpEr, t.rpIp),
    ops: (t) => ops(t).ops, obp: (t) => ops(t).obp, slg: (t) => ops(t).slg,
    bb9: (t) => (t.ip ? 9 * t.bbA / t.ip : null), k9: (t) => (t.ip ? 9 * t.kA / t.ip : null),
    sb: (t) => t.sb, sbPct: (t) => (t.sb + t.cs ? t.sb / (t.sb + t.cs) : null),
  };
  const lowIsGood = new Set(['spEra', 'rpEra', 'bb9']);
  const u = by.user || T('user');
  const out = { of };
  for (const [k, f] of Object.entries(val)) {
    const mine = f(u);
    const xs = clubs.map(([, t]) => f(t)).filter(x => x != null);
    const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const rank = mine == null ? null : 1 + clubs.filter(([id, t]) => id !== 'user' && f(t) != null
      && (lowIsGood.has(k) ? f(t) < mine : f(t) > mine)).length;
    out[k] = { v: mine, avg, rank };
  }
  out.bs = u.bs; out.svo = u.svo; out.sbN = u.sb; out.csN = u.cs;
  // One-run games.
  let w1 = 0, l1 = 0;
  for (const g of state.schedule || []) {
    if (!g._committed || g.isSpring || g.isPlayoff || !g.score) continue;
    const d = (g.score.us || 0) - (g.score.them || 0);
    if (d === 1) w1++; else if (d === -1) l1++;
  }
  out.oneRun = { w: w1, l: l1 };
  // The winter's growth on our side (OffseasonEngine._develop, day 1), for the
  // young players — what a teacher shows in.
  const year = baseballYear(state) + 1;
  const grow = { arms: 0, bats: 0, armsN: 0, batsN: 0 };
  for (const id of state.userTeam?.rosterIds || []) {
    const p = state.players[id];
    if (!p || computeAge(p.dob, year) > 26 || !Number.isFinite(p._ovrChange)) continue;
    if (isPitcher(p)) { grow.arms += p._ovrChange; grow.armsN++; } else { grow.bats += p._ovrChange; grow.batsN++; }
  }
  out.growth = grow;
  out.scouting = _scouting(state, season);
  return out;
}

/**
 * §122.15 the scouting director's year: the market's diamonds that went
 * somewhere this season (word got around), how many the scouts were onto first
 * (a tip or a report before the word), the ones that went to other clubs
 * without us knowing (by the specialty that reads them), and the players we
 * signed off the scouts' work.
 */
function _scouting(state, season) {
  const starts = (state.schedule || []).map(g => g.gameTime).filter(Number.isFinite);
  const from = (starts.length ? Math.min(...starts) : 0) - 60 * 86_400_000;
  let onto = 0, missed = 0, found = 0, imp = 0, impN = 0;
  const missedBy = { pro: 0, intl: 0, amateur: 0 };
  for (const p of Object.values(state.players || {})) {
    if (!p) continue;
    if (p._scoutFound === season && p.teamId === 'user') {
      found++;
      const e = (p.seasonLog || []).filter(x => x.season === season && x.stats).pop();
      const v = e ? lastSeasonIMP({ ...p, seasonLog: [e] }) : null;
      if (v != null) { imp += v; impN++; }
    }
    if (!Number.isFinite(p._buzzAt) || p._buzzAt < from || !p.teamId) continue;
    const knew = [p._tipAt, p._scoutedAt].some(t => Number.isFinite(t) && t < p._buzzAt);
    if (knew) onto++;
    else if (p.teamId !== 'user') { missed++; missedBy[scoutSpecFor(p)]++; }
  }
  return { onto, missed, missedBy, found, foundImp: impN ? Math.round(imp * 10) / 10 : null };
}

/** §112.4 The ballpark's season: average attendance and share of seats, sellouts, the gate. */
function _gate(state) {
  const cap = state.userTeam?.finances?.market?.capacity || 0;
  const home = (state.schedule || []).filter(g => g.isHome && !g.isSpring && !g.isPlayoff && g._committed && g.attendance > 0);
  if (!home.length || !cap) return { games: 0, capacity: cap, avg: 0, fill: null, sellouts: 0, gateK: 0 };
  const avg = home.reduce((a, g) => a + g.attendance, 0) / home.length;
  return { games: home.length, capacity: cap, avg: Math.round(avg), fill: Math.round(avg / cap * 1000) / 1000,
           sellouts: home.filter(g => g.sellout).length, gateK: home.reduce((a, g) => a + (g.gateK || 0), 0) };
}

function fmt3(x) { return x >= 1 ? x.toFixed(3) : x.toFixed(3).replace(/^0/, ''); }

/** "out in the wild-card game" / "out in the first round" (everyone plays in October). */
function _early(post) {
  if (/Wild Card/.test(post)) return 'out in the wild-card game';
  if (/First Round/.test(post)) return 'out in the first round';
  if (/Division Series/.test(post)) return 'out in the Division Series';
  return 'and no October';
}

/** The review in a sentence or two, for the owner and the manager. */
export function reviewWords(state, R) {
  const P = (id) => state.players[id];
  const ord = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] || 'th'}`;
  const rec = `${R.w}–${R.l}`;
  const how = {
    champion: `${rec}, and champions`,
    pennant: `${rec}, and a trip to the World Series`,
    playoffs: `${rec}, and a playoff run that ended ${R.post.replace(/^Lost in the /, 'in the ')}`,
    near: `${rec}, ${R.place ? `${ord(R.place)} in the division, ` : ''}${_early(R.post)}`,
    missed: `${rec}, a losing year${R.place ? `, ${ord(R.place)} in the division` : ''}${R.post !== 'Did not qualify' ? `, ${_early(R.post)}` : ''}`,
    disaster: `${rec}, a season to forget`,
  }[R.outcome];
  const worked = [], didnt = [];
  const rk = (x) => `${ord(x.rank)} of ${x.of}`;
  if (R.offense.rank <= 3) worked.push(`the offense (${R.offense.runs} runs, ${rk(R.offense)})`);
  else if (R.offense.rank >= R.offense.of - 2) didnt.push(`the offense (${R.offense.runs} runs, ${rk(R.offense)})`);
  if (R.pitching.rank <= 3) worked.push(`run prevention (${R.pitching.runs} allowed, ${rk(R.pitching)})`);
  else if (R.pitching.rank >= R.pitching.of - 2) didnt.push(`run prevention (${R.pitching.runs} allowed, ${rk(R.pitching)})`);
  if (R.rotation.era != null && R.rotation.era < 3.6) worked.push(`the rotation (${R.rotation.era.toFixed(2)} ERA)`);
  if (R.rotation.era != null && R.rotation.era > 4.9) didnt.push(`the rotation (${R.rotation.era.toFixed(2)} ERA)`);
  if (R.bullpen.era != null && R.bullpen.era < 3.4) worked.push(`the bullpen (${R.bullpen.era.toFixed(2)} ERA)`);
  if (R.bullpen.era != null && (R.bullpen.era > 4.8 || R.bullpen.blownSaves >= 25)) didnt.push(`the bullpen (${R.bullpen.era.toFixed(2)} ERA${R.bullpen.blownSaves ? `, ${R.bullpen.blownSaves} blown saves` : ''})`);
  const stars = R.stars.map(s => `${P(s.id)?.name} (${s.line})`).filter(x => !x.startsWith('undefined'));
  const letdown = R.letdowns.map(s => `${P(s.id)?.name} (${s.line})`)[0] || null;
  return { how, worked, didnt, stars, letdown, needs: R.needs.map(n => n.long) };
}
