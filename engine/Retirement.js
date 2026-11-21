/**
 * engine/Retirement.js
 * r222 §122.101 The plan to retire, settled once a season.
 *
 * Every player in the league (ours, other clubs', free agents) has a plan for after the season, settled the first
 * time the season reads it — when the season opens (spring), on a save's first tick, or for a player who joins the
 * league later, when they first appear — from the age next season and the rating then, on the player's own dice:
 *   38 or older next season          retires
 *   35–37 and rated under 55         retires 60% of the time
 *   (a pre-r222 veteran told to go out on top, `_retiringAfter`, retires)
 * The plan holds through a trade, a waiver claim or a signing. Only the veteran arc's "one more year", if the player
 * says yes, cancels it (`stayOneMore`). On offseason day 1 the plan is what retires a player (OffseasonEngine).
 *
 * Who knows: a player planning to retire tells their club at their tell game (RETIRE_PLAN.tellGames, regular-season
 * games played). Ours: the manager's word (CardEngine.deliverRetirePlans), and the player card from then on. A player
 * who joins us after their tell game: known on arrival.
 *
 *   planFor(state, p)            the plan for this season ({ season, retiring, tell } — settled if it isn't yet)
 *   settlePlans(draft)           every player's plan for this season (mutates; returns how many were settled)
 *   isRetiring(state, p)         planning to retire after this season
 *   knownRetiring(state, p)      one of ours, planning to retire, and we know it
 *   oneMoreOdds(state, p)        the chance they say yes to one more year
 *   stayOneMore(draft, p)        they said yes: the plan is cancelled
 *   gamesPlayed(state)           our regular-season games played this season
 *   askable(state)               r223 who the scouts can be asked about: other clubs' players and free agents 35+ next season
 *   scoutAccuracy(state)         r223 how often the scouts' answer is right (by the director)
 *   scoutSays(state, p)          r223 what the scouts say: { retiring, right } (the same all season)
 *   tradeYearsLeft(state, p, by) r223 seasons after this one a club counts when valuing a player (none for a player
 *                                of its own it knows is retiring)
 *
 * State: p.retireIntent = { season, retiring, tell, told?, stayed? }.
 * PURE: no StateManager.
 */
import { RETIREMENT_AGE_HARD, RETIREMENT_AGE_SOFT, RETIREMENT_OVR_SOFT, RETIREMENT_SOFT_ODDS, RETIRE_PLAN,
         PLAYER_GROUP } from '../data/constants.js';
import { computeAge, baseballYear } from './PlayerFactory.js';
import { dice, diceSeed, randInt } from './Dice.js';
import { qualityOf } from './CoachEngine.js';

const isP = (p) => p?.pos === 'SP' || p?.pos === 'RP';
const OFF = new Set([PLAYER_GROUP.RETIRED, PLAYER_GROUP.DEPARTED]);

/** Our regular-season games played this season. */
export function gamesPlayed(st) {
  return (st?.schedule || []).filter(g => g._committed && !g.isSpring && !g.isPlayoff && !g.isAllStar).length;
}

/** The plan as the season would settle it now (no state change). */
function _settle(st, p) {
  const season = st.seasonNum || 1;
  const r = dice(diceSeed(st), 'retire-plan', p.id, season);
  const age = computeAge(p.dob, baseballYear(st) + 1);
  const rel = (p.ovr || 50) - (st.leagueTalentOffset || 0);
  const roll = r(), tell = randInt(r, RETIRE_PLAN.tellGames[0], RETIRE_PLAN.tellGames[1]);
  const retiring = age >= RETIREMENT_AGE_HARD || p._retiringAfter === season
    || (age >= RETIREMENT_AGE_SOFT && rel < RETIREMENT_OVR_SOFT && roll < RETIREMENT_SOFT_ODDS);
  return { season, retiring, tell };
}

/** This season's plan for a player (settled now if it isn't yet; the stored one when it is). */
export function planFor(st, p) {
  if (!p) return null;
  const season = st.seasonNum || 1;
  return p.retireIntent?.season === season ? p.retireIntent : _settle(st, p);
}

/** Every player's plan for this season, stored. Returns how many were newly settled. */
export function settlePlans(draft) {
  const season = draft.seasonNum || 1;
  let n = 0;
  for (const p of Object.values(draft.players || {})) {
    if (!p || OFF.has(p.group) || p.retireIntent?.season === season) continue;
    p.retireIntent = _settle(draft, p);
    n++;
  }
  return n;
}

export const isRetiring = (st, p) => !!planFor(st, p)?.retiring;

/** One of ours, planning to retire, and we know it: they told us, or they came to us after telling their club. */
export function knownRetiring(st, p) {
  if (!p || p.teamId !== 'user') return false;
  const plan = planFor(st, p);
  return !!plan?.retiring && (!!plan.told || gamesPlayed(st) >= plan.tell);
}

/** A poor season so far: OPS under .650 over 120 at-bats, or an ERA over 5.00 over 30 innings. */
function _poor(p) {
  const x = p.stats || {};
  if (isP(p)) return (x.ip || 0) >= 30 && 9 * (x.er || 0) / x.ip > 5.0;
  const pa = (x.ab || 0) + (x.bb || 0) + (x.hbp || 0);
  if ((x.ab || 0) < 120 || !pa) return false;
  const tb = x.tb ?? ((x.h || 0) + (x.doubles || x['2b'] || 0) + 2 * (x.triples || x['3b'] || 0) + 3 * (x.hr || 0));
  return ((x.h || 0) + (x.bb || 0) + (x.hbp || 0)) / pa + tb / x.ab < 0.650;
}

/** The chance a player planning to retire says yes to one more year. */
export function oneMoreOdds(st, p) {
  const O = RETIRE_PLAN.oneMore;
  const age = computeAge(p.dob, baseballYear(st) + 1);
  const rel = Math.max(-1, Math.min(1, ((p.gmRelationship ?? 50) - 50) / 50));
  const v = O.base + O.rel * rel + (age >= RETIREMENT_AGE_HARD ? O.old : 0) + (_poor(p) ? O.poor : 0);
  return Math.max(0.05, Math.min(0.95, v));
}

/** They said yes to one more year: the plan is cancelled (mutates). */
export function stayOneMore(draft, p) {
  const plan = planFor(draft, p);
  p.retireIntent = { ...plan, retiring: false, stayed: true };
  delete p._retiringAfter;
}

// ─────────────────────────────────────────────────────────────
// r223 §122.102 ASKING THE SCOUTS; WHAT A CLUB KNOWS IN A TRADE
// ─────────────────────────────────────────────────────────────

/** Who the scouts can be asked about: another club's player or a free agent, 35 or older next season. */
export function askable(st) {
  const clubs = new Set((st.leagueTeams || []).map(t => t.id));
  const yr = baseballYear(st) + 1;
  return Object.values(st.players || {}).filter(p => p && !OFF.has(p.group) && p.teamId !== 'user'
    && (clubs.has(p.teamId) || (!p.teamId && p.group === PLAYER_GROUP.FREE_AGENT))
    && computeAge(p.dob, yr) >= RETIRE_PLAN.askAge);
}

/** How often the scouts' answer is right: 70% (a director of 40) to 90% (90). */
export function scoutAccuracy(st) {
  const q = qualityOf(st.userTeam?.coachingStaff?.scoutingDirector);
  const t = Math.max(0, Math.min(1, (q - 40) / 50));
  return RETIRE_PLAN.scout.worst + (RETIRE_PLAN.scout.best - RETIRE_PLAN.scout.worst) * t;
}

/** What the scouts say about a player's plan: right or wrong on the player's own dice, the same all season. */
export function scoutSays(st, p) {
  const truth = isRetiring(st, p);
  const right = dice(diceSeed(st), 'retire-scout', p.id, st.seasonNum || 1)() < scoutAccuracy(st);
  return { retiring: right ? truth : !truth, right };
}

/** Seasons after this one a club counts when valuing a player: none for one of its own it knows is retiring. */
export function tradeYearsLeft(st, p, byTeamId) {
  const s = st.seasonNum || 1;
  const left = Math.max(0, (p?.contractExpiry ?? s + 1) - s - 1);
  if (!left || !byTeamId || p.teamId !== byTeamId) return left;
  const knows = byTeamId === 'user' ? knownRetiring(st, p) : isRetiring(st, p);
  return knows ? 0 : left;
}
