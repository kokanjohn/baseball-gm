/**
 * engine/AllStarEngine.js
 * The All-Star Game (§75) — PURE: takes state (or an in-place draft) and
 * returns results; never imports StateManager.
 *
 * Every season:
 *   - the league names the host around games 45–55 (§17.2, a same-season
 *     announcement). The user's club hosts only when the league's impression of
 *     its ballpark (the hosting score) clears the bar for its next hosting and
 *     the prestige / cooldown / atmosphere rules are met; otherwise the CPU club
 *     that has gone longest without one hosts (a rotation with history);
 *   - after the user's 58th regular game, both divisions' squads are picked
 *     from first-half performance (a fan vote for the nine starters, then
 *     reserves and a pitching staff, every club represented);
 *   - on day 2 of the break the game is played on the league calendar like any
 *     league game — live, in the host's ballpark (the host's division bats
 *     last). It's an exhibition: no stats, standings or rotations move.
 *
 * state.allStar = {
 *   hostingScore, hostedCount, lastHostedSeason,
 *   hosts:   [{ year, seasonNum|null, teamId }],     // the league's hosting history
 *   season:  { seasonNum, announceAfterGame, hostId, announcedAtMs,
 *              homeAtmo: { sum, n }, influence, selectedAtMs,
 *              squads: { ASA, ASB }, replacements: [], result },
 *   history: [{ seasonNum, year, hostId, homeId, awayId, homeScore, awayScore,
 *               mvpId, userAllStars }],
 * }
 */

import {
  PLAYER_GROUP, LINEUP_SLOTS,
  ALLSTAR_ANNOUNCE_GAME_MIN, ALLSTAR_ANNOUNCE_GAME_MAX,
  ALLSTAR_SQUAD_IDS, ALLSTAR_SQUAD_SIZE, ALLSTAR_MIN_PA, ALLSTAR_MIN_IP,
  ALLSTAR_SUBS_FROM_INNING, ALLSTAR_INFLUENCE_BOOST, ALLSTAR_MAX_PER_CLUB,
  ALLSTAR_HOSTING_THRESHOLD_BASE, ALLSTAR_HOSTING_THRESHOLD_SECOND, ALLSTAR_HOSTING_THRESHOLD_THIRD,
  ALLSTAR_HOSTING_MIN_SEASONS_BETWEEN, ALLSTAR_HOSTING_MIN_SEASONS_THIRD, ALLSTAR_HOSTING_MIN_ATMOSPHERE,
  ALLSTAR_HOSTING_REVENUE_BONUS_MIN, ALLSTAR_HOSTING_REVENUE_BONUS_MAX,
  ALLSTAR_HOSTING_ATMOS_BUMP, ALLSTAR_HOSTING_OWNER_TRUST_BUMP, ALLSTAR_HOSTING_GM_REL_BUMP,
  HOSTING_PTS_PER_ATMO_POINT, HOSTING_ATMO_FLOOR, HOSTING_SEASON_ATMO_TARGET,
  HOSTING_SEASON_ATMO_BONUS, HOSTING_SCORE_CARRYOVER,
} from '../data/constants.js';
import { eligibleSlotsFor } from './RosterEngine.js';
import { isAvailable } from './PlayerFactory.js';

const SQUAD_IDS = new Set(Object.values(ALLSTAR_SQUAD_IDS));
const HOST_TIER  = [2, 3, 5];                 // prestige tier for 1st / 2nd / 3rd+ hosting
const HOST_BAR   = [ALLSTAR_HOSTING_THRESHOLD_BASE, ALLSTAR_HOSTING_THRESHOLD_SECOND, ALLSTAR_HOSTING_THRESHOLD_THIRD];
const HOST_WAIT  = [0, ALLSTAR_HOSTING_MIN_SEASONS_BETWEEN, ALLSTAR_HOSTING_MIN_SEASONS_THIRD];

// A big-league roster spot: the lineup, the bench, the rotation, the bullpen and
// the extra arms. Not the farm, the IL, or a player between clubs.
const ACTIVE = new Set([PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS, PLAYER_GROUP.STARTING_PITCHERS,
                        PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH]);
// The share of a regular's playing time (a lineup regular's PA, a rotation
// starter's innings) a player needs for his numbers to carry his vote — and
// below which his case weakens: an All-Star half is a full half (a swingman's
// 20 good innings, a part-timer's hot month, are not one).
const REGULAR_SHARE = 0.6;
// A player with no playing time at all keeps this much of his case (a star back
// from an early injury can still be voted in on reputation).
const PLAYING_TIME_FLOOR = 0.5;
const playingTime = (share) => PLAYING_TIME_FLOOR + (1 - PLAYING_TIME_FLOOR) * clamp(share, 0, 1);

const rnd   = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

/** A season's All-Star record before anything has happened. */
export function newSeason(seasonNum) {
  return {
    seasonNum,
    announceAfterGame: rnd(ALLSTAR_ANNOUNCE_GAME_MIN, ALLSTAR_ANNOUNCE_GAME_MAX),
    hostId: null, announcedAtMs: null,
    homeAtmo: { sum: 0, n: 0 },
    influence: null,
    selectedAtMs: null, squads: null, replacements: [],
    result: null,
  };
}

/**
 * createAllStarState(state, baseYear)
 * A new franchise joins a league with a hosting history: each CPU club hosted
 * once in the nine seasons before this one, in a random order.
 */
export function createAllStarState(state, baseYear) {
  const ids = (state.leagueTeams || []).map(t => t.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return {
    hostingScore: 0, hostedCount: 0, lastHostedSeason: null,
    hosts: ids.map((teamId, i) => ({ year: baseYear - ids.length + i, seasonNum: null, teamId })),
    season: newSeason(state.seasonNum || 1),
    history: [],
  };
}

/** The current season's record (created for a new season if needed). */
export function seasonOf(draft) {
  const a = draft.allStar;
  if (!a.season || a.season.seasonNum !== (draft.seasonNum || 1)) a.season = newSeason(draft.seasonNum || 1);
  return a.season;
}

export const isSquadId = (id) => SQUAD_IDS.has(id);
export const squadIdFor = (divisionId) => (divisionId === 'B' ? ALLSTAR_SQUAD_IDS.B : ALLSTAR_SQUAD_IDS.A);
export const userSquadId = (state) => squadIdFor(state.userTeam?.divisionId || 'A');

/** Every club, the user's included, in one list. */
function _clubs(state) { return [state.userTeam, ...(state.leagueTeams || [])].filter(Boolean); }
const _teamId = (state, t) => (t === state.userTeam ? 'user' : t.id);

/**
 * clubFor(state, id) — a league club or this season's All-Star squad, as the
 * team object SimEngine and the screens read (name, abbr, rosterIds, …).
 */
export function clubFor(state, id) {
  if (id === 'user') return state.userTeam;
  if (isSquadId(id)) return state.allStar?.season?.squads?.[id] || _blankSquad(id);
  return (state.leagueTeams || []).find(t => t.id === id) || null;
}
function _blankSquad(id) {
  const div = id === ALLSTAR_SQUAD_IDS.B ? 'B' : 'A';
  return { id, abbr: `${div}★`, name: `Division ${div} All-Stars`, divisionId: div, isAllStar: true, rosterIds: [] };
}

/** This season's game on the league calendar. */
export function gameEntry(state) {
  const seasonNum = state.seasonNum || 1;
  for (const [date, games] of Object.entries(state.leagueSchedule?.dayMap || {})) {
    const i = games.findIndex(g => g.isAllStar && g.id === `asg-${seasonNum}`);
    if (i >= 0) return { date, i, game: games[i] };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// HOSTING SCORE — the league's impression of the ballpark
// ─────────────────────────────────────────────────────────────

/** A home game in front of our crowd. */
export function accrueHomeGame(draft) {
  const atmo = draft.userTeam.atmosphere ?? 50;
  draft.allStar.hostingScore += Math.max(0, atmo - HOSTING_ATMO_FLOOR) * HOSTING_PTS_PER_ATMO_POINT;
  const s = seasonOf(draft);
  s.homeAtmo.sum += atmo; s.homeAtmo.n += 1;
}

/** A card decision about the ballpark (`_hosting: { yes, no }` on the card). */
export function accrueCard(draft, hosting, choice) {
  const pts = hosting?.[choice === 'yes' ? 'yes' : 'no'] || 0;
  if (pts) draft.allStar.hostingScore = Math.max(0, draft.allStar.hostingScore + pts);
}

/**
 * closeSeason(draft) — at the end of the season: a full season of lively home
 * crowds is a bonus; then the league's memory fades a little.
 */
export function closeSeason(draft) {
  const a = draft.allStar;
  const s = a.season;
  if (s?.homeAtmo?.n && s.homeAtmo.sum / s.homeAtmo.n >= HOSTING_SEASON_ATMO_TARGET) a.hostingScore += HOSTING_SEASON_ATMO_BONUS;
  a.hostingScore = Math.round(a.hostingScore * HOSTING_SCORE_CARRYOVER);
  if (s) {
    const e = gameEntry(draft)?.game;
    a.history = [...(a.history || []), {
      seasonNum: s.seasonNum, year: (draft.baseYear || 0) + s.seasonNum - 1, hostId: s.hostId,
      homeId: e?.homeId ?? null, awayId: e?.awayId ?? null,
      homeScore: e?.homeScore ?? null, awayScore: e?.awayScore ?? null,
      mvpId: s.result?.mvpId ?? null,
      userAllStars: _userSelections(draft).map(x => x.id),
    }];
  }
}

/**
 * hostingStatus(state) — whether the league would give the user's club the
 * game this season, and what stands in the way. `bar` is the score needed.
 */
export function hostingStatus(state) {
  const a    = state.allStar || {};
  const n    = Math.min(a.hostedCount || 0, 2);
  const tier = state.prestigeTier || 1;
  const reasons = [];
  if (tier < HOST_TIER[n]) reasons.push('prestige');
  if (a.lastHostedSeason && (state.seasonNum || 1) - a.lastHostedSeason < HOST_WAIT[n]) reasons.push('recently');
  if ((state.userTeam?.atmosphere ?? 50) < ALLSTAR_HOSTING_MIN_ATMOSPHERE) reasons.push('atmosphere');
  if ((a.hostingScore || 0) < HOST_BAR[n]) reasons.push('ballpark');
  return { eligible: reasons.length === 0, reasons, bar: HOST_BAR[n], score: a.hostingScore || 0,
           progress: clamp((a.hostingScore || 0) / HOST_BAR[n], 0, 1), tierNeeded: HOST_TIER[n] };
}

/**
 * nameHost(draft, atMs) — the league names this season's host. The host's
 * division's squad is the home side. Returns { hostId, status }.
 */
export function nameHost(draft, atMs) {
  const s = seasonOf(draft);
  if (s.hostId) return { hostId: s.hostId, status: null };
  const status = hostingStatus(draft);
  let hostId;
  if (status.eligible) {
    hostId = 'user';
  } else {
    // The CPU club that has waited longest (never hosted = longest of all).
    const last = new Map((draft.leagueTeams || []).map(t => [t.id, -Infinity]));
    for (const h of draft.allStar.hosts || []) if (last.has(h.teamId)) last.set(h.teamId, Math.max(last.get(h.teamId), h.year));
    const oldest = Math.min(...last.values());
    const pool = [...last.entries()].filter(([, y]) => y === oldest).map(([id]) => id);
    hostId = pool[Math.floor(Math.random() * pool.length)];
  }
  s.hostId = hostId;
  s.announcedAtMs = atMs;
  draft.allStar.hosts = [...(draft.allStar.hosts || []),
    { year: (draft.baseYear || 0) + (draft.seasonNum || 1) - 1, seasonNum: draft.seasonNum || 1, teamId: hostId }];
  const hostDiv = hostId === 'user' ? (draft.userTeam.divisionId || 'A')
                : (draft.leagueTeams.find(t => t.id === hostId)?.divisionId || 'A');
  const e = gameEntry(draft);
  if (e) {
    e.game.homeId = squadIdFor(hostDiv);
    e.game.awayId = squadIdFor(hostDiv === 'A' ? 'B' : 'A');
    e.game.hostId = hostId;
  }
  if (hostId === 'user') _hostingPayoff(draft);
  return { hostId, status };
}

/** §17.3 — what hosting delivers, the day the league names us. */
function _hostingPayoff(draft) {
  const u = draft.userTeam;
  const a = draft.allStar;
  const atmo = u.atmosphere ?? 50;
  const tier = draft.prestigeTier || 1;
  const scale = clamp(0.5 * (atmo / 100) + 0.5 * (tier / 5), 0, 1);
  const bonus = Math.round(ALLSTAR_HOSTING_REVENUE_BONUS_MIN + (ALLSTAR_HOSTING_REVENUE_BONUS_MAX - ALLSTAR_HOSTING_REVENUE_BONUS_MIN) * scale);
  u.finances.revenue = (u.finances.revenue || 0) + bonus;
  u.atmosphere = clamp(atmo + ALLSTAR_HOSTING_ATMOS_BUMP, 0, 100);
  u.ownerTrust = clamp((u.ownerTrust ?? 60) + ALLSTAR_HOSTING_OWNER_TRUST_BUMP, 0, 100);
  const rels = { ...(u.gmRelationships || {}) };
  for (const t of draft.leagueTeams || []) {
    rels[t.id] = clamp((rels[t.id] ?? t.gmRelationship ?? 50) + ALLSTAR_HOSTING_GM_REL_BUMP, 0, 100);
    t.gmRelationship = rels[t.id];
  }
  u.gmRelationships = rels;
  u._hostedAllStarThisSeason = true;
  u._hostedAllStar = true;
  a.hostedCount = (a.hostedCount || 0) + 1;
  a.lastHostedSeason = draft.seasonNum || 1;
  seasonOf(draft).hostBonusK = bonus;
}

// ─────────────────────────────────────────────────────────────
// THE VOTE — first-half performance, with reputation
// ─────────────────────────────────────────────────────────────

const _isPitcher = (p) => p.pos === 'SP' || p.pos === 'RP';

/** A division's big-leaguers who are healthy enough to be voted in. */
function _pool(state, divisionId) {
  const out = [];
  for (const t of _clubs(state)) {
    if ((t.divisionId || 'A') !== divisionId) continue;
    const teamId = _teamId(state, t);
    for (const id of t.rosterIds || []) {
      const p = state.players[id];
      if (!p || !ACTIVE.has(p.group) || p.isInjured) continue;
      out.push({ p, teamId });
    }
  }
  return out;
}

/** League baselines the vote measures against. */
function _norms(state) {
  let ab = 0, h = 0, bb = 0, hbp = 0, tb = 0, er = 0, ip = 0, hOvr = 0, hN = 0, pOvr = 0, pN = 0;
  const rotationIp = [], bullpenIp = [], regularPa = [];
  for (const t of _clubs(state)) for (const sl of t.lineupSlots || []) {
    const s = state.players[sl?.playerId]?.stats;
    if (s) regularPa.push((s.ab || 0) + (s.bb || 0) + (s.hbp || 0));
  }
  for (const t of _clubs(state)) for (const id of t.rosterIds || []) {
    const p = state.players[id]; if (!p || !ACTIVE.has(p.group)) continue;   // big-leaguers only
    const s = p.stats || {};
    if (p.group === PLAYER_GROUP.STARTING_PITCHERS && (s.gs || 0) > 0) rotationIp.push(s.ip || 0);
    if (p.group === PLAYER_GROUP.BULLPEN && (s.g || 0) > 0) bullpenIp.push(s.ip || 0);
    if (_isPitcher(p)) { er += s.er || 0; ip += s.ip || 0; pOvr += p.ovr || 0; pN++; }
    else { ab += s.ab || 0; h += s.h || 0; bb += s.bb || 0; hbp += s.hbp || 0; tb += s.tb || 0; hOvr += p.ovr || 0; hN++; }
  }
  const pa = ab + bb + hbp;
  const ops = (pa ? (h + bb + hbp) / pa : 0.32) + (ab ? tb / ab : 0.4);
  const median = (xs) => { xs.sort((x, y) => x - y); return xs.length ? xs[Math.floor(xs.length / 2)] : 0; };
  const spIp = median(rotationIp);    // a regular starter's innings so far
  const rpIp = median(bullpenIp);     // a regular reliever's innings so far
  const regPa = median(regularPa);    // a lineup regular's plate appearances so far
  return { ops: ops || 0.72, era: ip ? (er * 9) / ip : 4.2, hOvr: hN ? hOvr / hN : 60, pOvr: pN ? pOvr / pN : 60, spIp, rpIp, pa: regPa };
}

/** A hitter's vote: production when he has played enough, reputation always. */
export function hitterVote(p, n) {
  const s = p.stats || {};
  const pa = (s.ab || 0) + (s.bb || 0) + (s.hbp || 0);
  const ops = (pa ? ((s.h || 0) + (s.bb || 0) + (s.hbp || 0)) / pa : 0) + ((s.ab || 0) ? (s.tb || 0) / s.ab : 0);
  const perf = 100 * ops / n.ops + 0.8 * (s.hr || 0) + 0.2 * (s.sb || 0);
  const rep  = 100 + ((p.ovr || 0) - n.hOvr) * 2;
  const share = pa / Math.max(ALLSTAR_MIN_PA, REGULAR_SHARE * (n.pa || 0));
  const w    = 0.75 * clamp(share, 0, 1);
  return (w * perf + (1 - w) * rep) * playingTime(share);
}

/** A pitcher's vote: run prevention and workload (starters) or saves (relievers). */
export function pitcherVote(p, n) {
  const s = p.stats || {};
  const ip = s.ip || 0;
  const era = ip ? ((s.er || 0) * 9) / ip : n.era;
  const prevent = 100 * n.era / Math.max(1.5, era);
  const perf = p.pos === 'SP'
    ? prevent + 0.15 * (s.k || 0) + 1.5 * (s.w || 0)
    : prevent + 2 * (s.sv || 0) + 1 * (s.hld || 0) + 0.2 * (s.k || 0);
  const minIp = p.pos === 'SP' ? Math.max(ALLSTAR_MIN_IP, REGULAR_SHARE * (n.spIp || 0))
                               : Math.max(ALLSTAR_MIN_IP / 2, REGULAR_SHARE * (n.rpIp || 0));
  const rep  = 100 + ((p.ovr || 0) - n.pOvr) * 2;
  const share = ip / minIp;
  const w    = 0.75 * clamp(share, 0, 1);
  return (w * Math.min(perf, 220) + (1 - w) * rep) * playingTime(share);
}

/**
 * _pickSquad(state, divisionId, { boostId }) — the division's squad:
 *   9 starters by position (the fan vote), reserves (a second catcher, a
 *   middle infielder, an outfielder, then the best left), 6 SP + 5 RP, and at
 *   least one player from every club.
 */
function _pickSquad(state, divisionId, { boostId = null } = {}) {
  const n = _norms(state);
  const pool = _pool(state, divisionId).map(({ p, teamId }) => {
    const v = _isPitcher(p) ? pitcherVote(p, n) : hitterVote(p, n);
    return { id: p.id, p, teamId, vote: v * (p.id === boostId ? 1 + ALLSTAR_INFLUENCE_BOOST : 1) };
  }).sort((a, b) => b.vote - a.vote);
  const hitters = pool.filter(x => !_isPitcher(x.p));
  const used = new Set();
  const perClub = {};
  // The fan vote names the starters outright; after that a club sends at most
  // ALLSTAR_MAX_PER_CLUB (the rest of the league gets its turn).
  const room = (c, capped) => !capped || (perClub[c.teamId] || 0) < ALLSTAR_MAX_PER_CLUB;
  const take = (list, pred, capped = true) => {
    const x = list.find(c => !used.has(c.id) && room(c, capped) && pred(c));
    if (x) { used.add(x.id); perClub[x.teamId] = (perClub[x.teamId] || 0) + 1; }
    return x || null;
  };
  const plays = (slot) => (c) => eligibleSlotsFor(c.p).includes(slot);

  // Starters: the field first (scarce positions), then the DH.
  const starters = LINEUP_SLOTS.map(slot => ({ slot, pick: null }));
  for (const st of starters) if (st.slot !== 'DH') st.pick = take(hitters, plays(st.slot), false);
  const dh = starters.find(st => st.slot === 'DH');
  dh.pick = take(hitters, () => true, false);

  // Reserves: the backups a manager needs, then the best bats left.
  const nRes = ALLSTAR_SQUAD_SIZE.HITTERS - LINEUP_SLOTS.length;
  const reserves = [];
  for (const need of [plays('C'), (c) => plays('SS')(c) || plays('2B')(c), plays('OF')]) {
    if (reserves.length < nRes) { const x = take(hitters, need); if (x) reserves.push({ ...x, need: true }); }
  }
  while (reserves.length < nRes) { const x = take(hitters, () => true); if (!x) break; reserves.push(x); }

  const sp = [], rp = [];
  while (sp.length < ALLSTAR_SQUAD_SIZE.SP) { const x = take(pool, (c) => c.p.pos === 'SP'); if (!x) break; sp.push(x); }
  while (rp.length < ALLSTAR_SQUAD_SIZE.RP) { const x = take(pool, (c) => c.p.pos === 'RP'); if (!x) break; rp.push(x); }

  // Every club sends at least one: its best player takes the place of the
  // lowest vote-getter of his kind (never a starter or a required backup).
  const clubsHere = _clubs(state).filter(t => (t.divisionId || 'A') === divisionId).map(t => _teamId(state, t));
  for (const teamId of clubsHere) {
    const all = [...starters.map(s => s.pick), ...reserves, ...sp, ...rp].filter(Boolean);
    if (all.some(x => x.teamId === teamId)) continue;
    const best = pool.find(x => x.teamId === teamId && !used.has(x.id));
    if (!best) continue;
    const list = !_isPitcher(best.p) ? reserves : best.p.pos === 'SP' ? sp : rp;
    const out = [...list].filter(x => !x.need && all.filter(y => y.teamId === x.teamId).length > 1)
      .sort((a, b) => a.vote - b.vote)[0];
    if (!out) continue;
    list[list.indexOf(out)] = best;
    used.delete(out.id); used.add(best.id);
  }

  return {
    starters: starters.filter(s => s.pick).map(s => ({ slot: s.slot, id: s.pick.id, teamId: s.pick.teamId })),
    reserves: reserves.map(x => ({ id: x.id, teamId: x.teamId })),
    // The role each arm was picked for (a reliever moved to the rotation since is still a relief All-Star).
    sp: sp.map(x => ({ id: x.id, teamId: x.teamId, pos: 'SP' })),
    rp: rp.map(x => ({ id: x.id, teamId: x.teamId, pos: 'RP' })),
    votes: Object.fromEntries(pool.map(x => [x.id, Math.round(x.vote * 10) / 10])),
  };
}

/**
 * bubblePlayer(state) — the user's best player who would just miss the squad
 * (for the host's lobbying card). Null when there isn't one close enough.
 */
export function bubblePlayer(state) {
  const div = state.userTeam.divisionId || 'A';
  const sq = _pickSquad(state, div);
  const picked = new Set([...sq.starters, ...sq.reserves, ...sq.sp, ...sq.rp].map(x => x.id));
  const cut = (kind) => {
    const list = kind === 'H' ? [...sq.starters, ...sq.reserves] : kind === 'SP' ? sq.sp : sq.rp;
    return Math.min(...list.map(x => sq.votes[x.id]));
  };
  let best = null;
  for (const id of state.userTeam.rosterIds || []) {
    const p = state.players[id];
    if (!p || picked.has(id) || sq.votes[id] == null) continue;
    const kind = !_isPitcher(p) ? 'H' : p.pos;
    const gap = (cut(kind) - sq.votes[id]) / cut(kind);
    if (gap <= ALLSTAR_INFLUENCE_BOOST && (!best || gap < best.gap)) best = { id, gap };
  }
  return best?.id || null;
}

/**
 * selectSquads(draft, atMs) — names both squads. Marks each player's All-Star
 * season. Returns the user's selections.
 */
export function selectSquads(draft, atMs) {
  const s = seasonOf(draft);
  if (s.squads) return _userSelections(draft);
  const boostId = s.influence?.choice === 'yes' ? s.influence.playerId : null;
  s.squads = {};
  for (const div of ['A', 'B']) {
    const id = squadIdFor(div);
    const pick = _pickSquad(draft, div, { boostId });
    s.squads[id] = { ..._blankSquad(id), ...pick, rosterIds: _members(pick) };
    for (const pid of s.squads[id].rosterIds) {
      const p = draft.players[pid];
      if (p) p.allStarSeasons = [...new Set([...(p.allStarSeasons || []), draft.seasonNum || 1])];
    }
  }
  s.selectedAtMs = atMs;
  return _userSelections(draft);
}

const _members = (sq) => [...sq.starters, ...sq.reserves, ...sq.sp, ...sq.rp].map(x => x.id);

/** The user's All-Stars this season: [{ id, role: 'starter'|'reserve'|'pitcher', slot }]. */
function _userSelections(state) {
  const sq = state.allStar?.season?.squads?.[userSquadId(state)];
  if (!sq) return [];
  const mine = (x) => x.teamId === 'user';
  return [
    ...sq.starters.filter(mine).map(x => ({ id: x.id, role: 'starter', slot: x.slot })),
    ...sq.reserves.filter(mine).map(x => ({ id: x.id, role: 'reserve' })),
    ...[...sq.sp, ...sq.rp].filter(mine).map(x => ({ id: x.id, role: 'pitcher' })),
  ];
}
export const userSelections = _userSelections;

// ─────────────────────────────────────────────────────────────
// GAME DAY
// ─────────────────────────────────────────────────────────────

/**
 * prepareForGame(draft) — at first pitch: anyone hurt (or gone) since the
 * vote is replaced by the next in line, then each squad's game plan is set —
 * the starting nine (lineupSlots), each reserve paired with a starter he
 * replaces from the 5th–7th inning, the starter (best-voted SP) and the order
 * the rest of the staff comes in (one inning each; the best reliever closes).
 * Returns [{ squadId, outId, inId }] replacements.
 */
export function prepareForGame(draft) {
  const s = seasonOf(draft);
  if (!s.squads) selectSquads(draft, Date.now());
  const n = _norms(draft);
  const out = [];
  // Still a big-leaguer and able to play (a player traded this week, between
  // clubs for a day, still comes).
  const fit = (id) => { const p = draft.players[id]; return p && p.teamId && isAvailable(p)
    && (ACTIVE.has(p.group) || p.group === PLAYER_GROUP.IN_TRANSIT); };

  for (const [sqId, sq] of Object.entries(s.squads)) {
    const div = sq.divisionId;
    const taken = new Set(Object.values(s.squads).flatMap(q => q.rosterIds));
    const candidates = _pool(draft, div).filter(({ p }) => !taken.has(p.id) && isAvailable(p));
    const next = (pred) => {
      const best = candidates.filter(c => !taken.has(c.p.id) && pred(c.p))
        .map(c => ({ ...c, vote: _isPitcher(c.p) ? pitcherVote(c.p, n) : hitterVote(c.p, n) }))
        .sort((a, b) => b.vote - a.vote)[0];
      if (best) taken.add(best.p.id);
      return best ? { id: best.p.id, teamId: best.teamId } : null;
    };
    const swap = (list, i, pred) => {
      if (fit(list[i].id)) return;
      const r = next(pred);
      if (!r) return;
      out.push({ squadId: sqId, outId: list[i].id, inId: r.id });
      list[i] = { ...list[i], ...r };
    };
    sq.starters.forEach((st, i) => swap(sq.starters, i, (p) => !_isPitcher(p) && (st.slot === 'DH' || eligibleSlotsFor(p).includes(st.slot))));
    sq.reserves.forEach((_, i) => swap(sq.reserves, i, (p) => !_isPitcher(p)));
    sq.sp.forEach((_, i) => swap(sq.sp, i, (p) => p.pos === 'SP'));
    sq.rp.forEach((_, i) => swap(sq.rp, i, (p) => p.pos === 'RP'));
    sq.rosterIds = _members(sq);

    // The game plan (read by SimEngine's exhibition mode).
    sq.lineupSlots = sq.starters.map(st => ({ slot: st.slot, playerId: st.id }));
    const openStarters = sq.starters.filter(st => fit(st.id)).map(st => ({ ...st }));
    const subs = {};
    for (const r of sq.reserves.filter(r => fit(r.id))) {
      const rp = draft.players[r.id];
      const can = (st) => !subs[st.id] && (st.slot === 'DH' || eligibleSlotsFor(rp).includes(st.slot));
      const st = openStarters.find(can) || openStarters.find(x => !subs[x.id] && x.slot === 'DH')
              || openStarters.find(x => !subs[x.id]);
      if (st) subs[st.id] = { inId: r.id, inning: ALLSTAR_SUBS_FROM_INNING + Math.floor(Math.random() * 3) };
    }
    sq.simSubs = subs;
    const staff = [...sq.sp, ...sq.rp].filter(x => fit(x.id));
    const starter = staff.find(x => draft.players[x.id]?.pos === 'SP') || staff[0];
    sq.simStarter = starter?.id || null;
    const closer = [...sq.rp].filter(x => fit(x.id)).sort((a, b) => (draft.players[b.id]?.stats?.sv || 0) - (draft.players[a.id]?.stats?.sv || 0))[0];
    const rest = staff.filter(x => x.id !== sq.simStarter && x.id !== closer?.id).map(x => x.id);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    sq.simBullpen = [...rest.slice(0, 7), ...(closer ? [closer.id] : []), ...rest.slice(7)];
    sq.simBench = sq.reserves.filter(r => fit(r.id)).map(r => r.id);
  }
  s.replacements = [...(s.replacements || []), ...out];
  return out;
}

/**
 * recordResult(draft, game) — after the final out: the MVP (best game on the
 * winning side) and the result. Exhibition: nothing else moves.
 */
export function recordResult(draft, game) {
  const s = seasonOf(draft);
  const box = game.boxScore;
  const winSide = (game.homeScore ?? 0) > (game.awayScore ?? 0) ? 'home' : 'away';
  let mvp = null;
  for (const h of box?.[winSide]?.hitters || []) {
    const v = (h.h || 0) + 2 * (h.hr || 0) + (h.rbi || 0) + 0.5 * (h.r || 0) + 0.5 * (h.bb || 0);
    if (!mvp || v > mvp.v) mvp = { id: h.id, v };
  }
  for (const p of box?.[winSide]?.pitchers || []) {
    const outs = p.ipOuts || 0;
    const v = outs / 3 * 1.2 + (p.k || 0) * 0.5 - (p.er || 0) * 2;
    if (v > 3 && (!mvp || v > mvp.v)) mvp = { id: p.id, v };
  }
  s.result = { homeId: game.homeId, awayId: game.awayId, homeScore: game.homeScore, awayScore: game.awayScore,
               winnerId: winSide === 'home' ? game.homeId : game.awayId, mvpId: mvp?.id || null };
  const p = mvp && draft.players[mvp.id];
  if (p) p.allStarMvps = [...new Set([...(p.allStarMvps || []), draft.seasonNum || 1])];
  return s.result;
}
