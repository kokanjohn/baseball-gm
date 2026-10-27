/**
 * engine/CardTokens.js
 * Card {token} vocabulary — one token map per card instance (§60).
 *
 * Why one map per instance: every text field of a card (subject, preview, body,
 * sender, labels, outcome messages) must name the SAME player, the SAME sponsor
 * and the SAME dollar amount. Resolving each field separately re-rolled every
 * random pick, so a subject could name one player and the body another, and the
 * cost shown in the text differed from the cost charged on resolve.
 *
 * Money tokens are drawn once here and returned in `amountsK` so CardEngine
 * charges/credits exactly what the card says.
 *
 * PURE: takes state as input, never imports StateManager.
 */

import {
  PLAYER_GROUP,
  PITCHER_HAND_DISPLAY,
  CARD_COST_XS,
  CARD_COST_SM,
  CARD_COST_CAPPED,
  CARD_COST_LG,
  CARD_COST_EXT,
  REGULAR_SEASON_GAME_COUNT,
  SPRING_TRAINING_GAME_COUNT,
  PHASE,
} from '../data/constants.js';
import { STAFF_NAMES } from '../data/player-names.js';
import { isAvailable } from './PlayerFactory.js';
import { eligibleSlotsFor } from './RosterEngine.js';
import {
  CARD_TOKEN_POOLS,
  CARD_TOKEN_MONEY,
  BROADCAST_MARKET_MULTIPLIER,
} from '../data/card-tokens.js';

// Matches any {token}. Digits are allowed (e.g. {sp2_items}, {bg11_team}).
export const TOKEN_PATTERN = /\{([a-z0-9_]+)\}/gi;

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * buildTokenMap(cardDef, context, state)
 * @returns {{ values: Object<string,string>, amountsK: Object<string,number> }}
 */
export function buildTokenMap(cardDef, context, state) {
  const ctx      = context || {};
  const userTeam = state.userTeam || {};
  const staff    = userTeam.coachingStaff || {};
  const values   = {};
  const amountsK = {};

  // ── Money (drawn once; text and effect share the number) ──────────────
  const money = (key, range) => {
    const k = _randInt(range.min, range.max);
    amountsK[key] = k;
    values[key]   = formatK(k);
    return k;
  };
  money('misc_cost_xs',      CARD_COST_XS);
  money('misc_cost_sm',      CARD_COST_SM);
  money('misc_cost_capped',  CARD_COST_CAPPED);
  money('misc_cost_lg',      CARD_COST_LG);
  money('ext_cost',          CARD_COST_EXT);
  money('grounds_crew_cost', CARD_COST_SM);
  money('nri_cost',          CARD_COST_XS);
  for (const [key, range] of Object.entries(CARD_TOKEN_MONEY)) money(key, range);
  // Broadcast renewal: market value and gap derive from the offered amount.
  const market = Math.round(amountsK.rev_amount *
    _randFloat(BROADCAST_MARKET_MULTIPLIER.min, BROADCAST_MARKET_MULTIPLIER.max));
  amountsK.broadcast_market = market;
  amountsK.broadcast_gap    = market - amountsK.rev_amount;
  values.broadcast_market   = formatK(market);
  values.broadcast_gap      = formatK(amountsK.broadcast_gap);
  values.payroll_count      = String(_randInt(2, 6));
  // Game counts a card's action uses (§71) — the text and the absence agree.
  const counts = { susp_hitter_games: _randInt(2, 5), susp_pitcher_games: _randInt(3, 7) };
  for (const [k, v] of Object.entries(counts)) values[k] = String(v);

  // ── Staff and front office ─────────────────────────────────────────────
  values.manager_name        = staff.manager?.name       || 'The manager';
  values.pitching_coach_name = staff.pitchingCoach?.name || 'The pitching coach';
  values.hitting_coach_name  = staff.hittingCoach?.name  || 'The hitting coach';
  values.bench_coach_name    = staff.benchCoach?.name    || 'The bench coach';
  values.bullpen_coach_name  = staff.bullpenCoach?.name  || 'The bullpen coach';
  values.physician_name      = 'The team physician';
  values.cfo_name            = 'The CFO';
  values.owner_name          = userTeam.ownerName || 'Ownership';
  values.scout_name          = _pickPerson(state);

  // One-off outside people — distinct names within this card.
  const people = _shuffle(_outsideNames(state));
  values.coach_name     = people[0] || 'A veteran coach';
  values.attendant_name = people[1] || 'Our head attendant';
  values.legend_name    = people[2] || 'A franchise legend';

  // ── Schedule / league context ──────────────────────────────────────────
  const teams    = state.leagueTeams || [];
  const nextGame = ctx.nextGame || null;
  values.next_opponent    = nextGame?.opponent || 'the next opponent';
  values.road_trip_length = String(ctx.consecutiveRoadGames || 3);
  values.rival_team       = _teamName(_pick(teams)) || 'a rival club';
  values.bg11_team        = _teamName(_pick(teams)) || 'A division rival';
  values.next_home_opp    = _nextHomeOpponent(state) || values.next_opponent;
  values.road_city        = _nextRoadCity(state, nextGame) || 'on the road';

  // ── Season / streak context ────────────────────────────────────────────
  values.streak_context_clause       = _streakClause(userTeam.streak || 0);
  values.season_context              = _seasonContext(state);
  values.prior_season_context_clause = _priorSeasonClause(state);

  // ── Players ────────────────────────────────────────────────────────────
  const used = new Set();
  const take = (p) => { if (p) used.add(p.id); return p; };

  // A card that only makes sense for certain players picks among them (§72):
  // an extension demand from a player in his contract year, a reliever with
  // a starter's stamina, a fielder who could DH, a starter with a bench option.
  const fit = _cardFit(cardDef, state);
  const activeSP      = take(_pickActivePitcher(state, 'SP', used, fit.pitcher));
  const activeBP      = take(_pickActivePitcher(state, 'RP', used, fit.bp || fit.pitcher));
  const anyPitcher    = take(_pickAnyActivePitcher(state, used, fit.pitcher));
  const activeHitter  = take(_pickActiveHitter(state, used, fit.hitter));
  const secondHitter  = take(_pickActiveHitter(state, used));
  const thirdHitter   = take(_pickActiveHitter(state, used));
  const veteran       = take(_pickVeteranHitter(state, used));
  const leader        = take(_pickLeader(state, used));
  const plPlayer      = take(_pickActivePlayer(state, used));
  const farmPitcher   = _pickFarm(state, true);
  const farmHitter    = _pickFarm(state, false);
  const activeCatcher = _pickActivePlayerByPos(state, 'C');

  _setPitcher(values, 'active_sp',      activeSP,   'our starter');
  _setPitcher(values, 'active_bp',      activeBP,   'a reliever');
  _setPitcher(values, 'active_pitcher', anyPitcher, 'one of our pitchers');
  _setPitcher(values, 'farm_pitcher',   farmPitcher, 'a farm pitcher');
  _setHitter(values,  'active_hitter',  activeHitter, 'one of our hitters');
  _setHitter(values,  'farm_hitter',    farmHitter,   'a farm hitter');
  _setHitter(values,  'leader_player',  leader,       'a clubhouse leader');
  values.act_hi               = values.active_hitter_name;
  values.active_catcher_name  = activeCatcher?.name || 'our catcher';
  values.active_catcher_pos   = 'C';
  values.active_farm_name     = farmHitter?.name || farmPitcher?.name || 'our top prospect';
  values.d4_second_player     = veteran?.name || secondHitter?.name || 'a veteran';
  values.bg9_player           = secondHitter?.name || 'one of the regulars';
  values.bg12_player          = thirdHitter?.name  || values.active_hitter_name;
  values.pl_player_name       = plPlayer?.name || 'One of our players';

  // Roster-move roles (§72): the farm's best bat / arm, the bench bat who'd
  // lose his spot (drop), and the bench bat who could take the named
  // starter's place (audition).
  const prospectHitter = _bestFarm(state, false);
  const prospectPitcher = _bestFarm(state, true);
  const dropHitter     = _weakestBenchHitter(state, used);
  const auditionHitter = _benchAlternative(state, activeHitter, used);
  _setHitter(values,  'prospect_hitter',  prospectHitter,  'our top prospect');
  _setPitcher(values, 'prospect_pitcher', prospectPitcher, 'our top pitching prospect');
  _setHitter(values,  'drop_hitter',      dropHitter,      'our last bench bat');
  _setHitter(values,  'audition_hitter',  auditionHitter,  'a bench player');
  for (const [k, pl] of [['prospect_hitter', prospectHitter], ['drop_hitter', dropHitter], ['audition_hitter', auditionHitter]]) {
    values[`${k}_desc`] = pl ? `${pl.name} (${pl.nativePos || pl.pos}, OVR ${pl.ovr})` : values[`${k}_name`];
  }

  // ── Phrase pools (one pick per token per card) ────────────────────────
  for (const [key, pool] of Object.entries(CARD_TOKEN_POOLS)) {
    if (key === 'person_name') continue;
    values[key] = _pick(pool) ?? '';
  }

  // Which player each role token names (§71) — a card's action acts on the
  // same man its text is about.
  const players = {
    active_sp: activeSP?.id || null, active_bp: activeBP?.id || null,
    active_pitcher: anyPitcher?.id || null, active_hitter: activeHitter?.id || null,
    active_catcher: activeCatcher?.id || null, farm_pitcher: farmPitcher?.id || null,
    farm_hitter: farmHitter?.id || null, leader_player: leader?.id || null,
    pl_player: plPlayer?.id || null,
    prospect_hitter: prospectHitter?.id || null, prospect_pitcher: prospectPitcher?.id || null,
    drop_hitter: dropHitter?.id || null, audition_hitter: auditionHitter?.id || null,
  };

  return { values, amountsK, players, counts };
}

/**
 * applyTokens(text, values)
 * Substitutes every known {token}. Unknown tokens are left in place so callers
 * can detect them with hasUnresolvedTokens().
 */
export function applyTokens(text, values) {
  if (!text) return '';
  return String(text).replace(TOKEN_PATTERN, (match, key) =>
    values[key] !== undefined ? values[key] : match);
}

/** True when the text still contains a {token}. */
export function hasUnresolvedTokens(text) {
  if (!text) return false;
  return new RegExp(TOKEN_PATTERN.source, 'i').test(String(text));
}

/** $K → display string ("$45K", "$1.2M"). */
export function formatK(amountK) {
  const k = Math.round(amountK || 0);
  return k >= 1000
    ? `$${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 1)}M`
    : `$${k}K`;
}

// ─────────────────────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────────────────────

function _streakClause(streak) {
  if (streak >= 5)  return ` — riding a ${streak}-game win streak`;
  if (streak >= 3)  return ` — off a ${streak}-game win streak`;
  if (streak <= -5) return ` — in the middle of a ${Math.abs(streak)}-game losing skid`;
  if (streak <= -3) return ` — after dropping ${Math.abs(streak)} straight`;
  return '';
}

function _traitNote(trait) {
  const notes = {
    veteran:          ' The veteran has seen this before.',
    youngGun:         ' Young player — this kind of clarity matters early.',
    clubhouseLeader:  ' As a clubhouse leader, the message carries weight.',
    volatile:         ' Worth noting: this player can be unpredictable.',
    consistent:       ' Reliable player — should handle it professionally.',
  };
  return notes[trait] || '';
}

// Reads as a sentence opener: "With the club at 34–28 and 70 games left, …"
function _seasonContext(state) {
  const w = state.userTeam?.wins   || 0;
  const l = state.userTeam?.losses || 0;
  if (state.phase === PHASE.SPRING_TRAINING) return 'With spring camp in full swing';
  const played    = Math.max(0, (state.currentGameIndex || 0) - SPRING_TRAINING_GAME_COUNT);
  const remaining = Math.max(0, REGULAR_SEASON_GAME_COUNT - played);
  return remaining > 0
    ? `With the club at ${w}–${l} and ${remaining} games left`
    : `With the club at ${w}–${l}`;
}

function _priorSeasonClause(state) {
  const hist = state.seasonHistory || [];
  const last = hist[hist.length - 1];
  if (!last) return '';
  return ` after last season's ${last.wins}–${last.losses} finish`;
}

function _teamName(team) {
  if (!team) return null;
  return team.name || [team.city, team.nickname].filter(Boolean).join(' ') || null;
}

function _nextHomeOpponent(state) {
  const sched = state.schedule || [];
  for (let i = state.currentGameIndex || 0; i < sched.length; i++) {
    if (sched[i]?.isHome) return sched[i].opponent || null;
  }
  return null;
}

function _nextRoadCity(state, nextGame) {
  const sched = state.schedule || [];
  let g = nextGame && !nextGame.isHome ? nextGame : null;
  for (let i = state.currentGameIndex || 0; !g && i < sched.length; i++) {
    if (sched[i] && !sched[i].isHome) g = sched[i];
  }
  if (!g) return null;
  const team = (state.leagueTeams || []).find(t => t.name === g.opponent);
  return team?.city || null;
}

function _outsideNames(state) {
  const taken = new Set(Object.values(state.userTeam?.coachingStaff || {}).map(s => s?.name));
  if (state.userTeam?.ownerName) taken.add(state.userTeam.ownerName);
  return (CARD_TOKEN_POOLS.person_name || []).filter(n => !taken.has(n));
}

function _pickPerson(state) {
  const taken = new Set(Object.values(state.userTeam?.coachingStaff || {}).map(s => s?.name));
  const pool  = STAFF_NAMES.filter(n => !taken.has(n));
  return _pick(pool) || 'Our lead scout';
}

// ─────────────────────────────────────────────────────────────
// PLAYER PICKERS (healthy, rostered, not already used on this card)
// ─────────────────────────────────────────────────────────────

const PITCHER_GROUPS = [PLAYER_GROUP.STARTING_PITCHERS, PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH];
const HITTER_GROUPS  = [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS];

function _roster(state, used) {
  return (state.userTeam?.rosterIds || [])
    .map(id => state.players?.[id])
    .filter(p => p && isAvailable(p) && !used?.has(p.id));
}

const _all = () => true;
function _pickActivePitcher(state, role, used, ok = _all) {
  return _pick(_roster(state, used).filter(p => p.pos === role && PITCHER_GROUPS.includes(p.group) && ok(p)));
}
function _pickAnyActivePitcher(state, used, ok = _all) {
  return _pick(_roster(state, used).filter(p => PITCHER_GROUPS.includes(p.group) && ok(p)));
}
function _pickActiveHitter(state, used, ok = _all) {
  return _pick(_roster(state, used).filter(p => HITTER_GROUPS.includes(p.group) && ok(p)));
}

/** Which players a card can be about (§72). Unflagged cards: anyone. */
function _cardFit(cardDef, state) {
  const d = cardDef || {};
  const u = state.userTeam || {};
  const season = state.seasonNum || 1;
  const starting = new Set((u.lineupSlots || []).map(s => s.playerId).filter(Boolean));
  const out = {};
  if (d._requiresContractYear) {
    const ok = (p) => (p.contractExpiry ?? season + 2) - season <= 1 && !p.pendingContract && !p._willWalk
      && (!d._minRating || (p.ovr || 0) - (state.leagueTalentOffset || 0) >= d._minRating);
    out.hitter = ok; out.pitcher = ok;
  }
  if (d._requiresBPtoSP) out.bp = (p) => p.group === PLAYER_GROUP.BULLPEN && (p.subRatings?.stamina || 0) >= 55;
  if (d._requiresDHSwap) {
    const dh = (u.lineupSlots || []).find(s => s.slot === 'DH');
    out.hitter = (p) => starting.has(p.id) && dh?.playerId !== p.id;
  }
  if (d._requiresPositionMatch) {
    out.hitter = (p) => starting.has(p.id) && !!_benchAlternative(state, p, new Set());
  }
  return out;
}

/** The farm's best healthy player on one side. */
function _bestFarm(state, pitchers) {
  return (state.userTeam?.farmIds || []).map(id => state.players?.[id])
    .filter(p => p && isAvailable(p) && ['SP', 'RP'].includes(p.pos) === pitchers)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
}

/** The weakest healthy bench bat (not in the lineup). */
function _weakestBenchHitter(state, used) {
  const starting = new Set((state.userTeam?.lineupSlots || []).map(s => s.playerId));
  return _roster(state, used).filter(p => HITTER_GROUPS.includes(p.group) && !starting.has(p.id))
    .sort((a, b) => (a.ovr || 0) - (b.ovr || 0))[0] || null;
}

/** The best healthy bench bat who can play `starter`'s lineup spot. */
function _benchAlternative(state, starter, used) {
  if (!starter) return null;
  const u = state.userTeam || {};
  const slot = (u.lineupSlots || []).find(s => s.playerId === starter.id)?.slot;
  if (!slot) return null;
  const starting = new Set((u.lineupSlots || []).map(s => s.playerId));
  return _roster(state, used).filter(p => HITTER_GROUPS.includes(p.group) && !starting.has(p.id)
      && p.id !== starter.id && eligibleSlotsFor(p).includes(slot))
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
}
function _pickActivePlayer(state, used) {
  return _pick(_roster(state, used).filter(p =>
    PITCHER_GROUPS.includes(p.group) || HITTER_GROUPS.includes(p.group)));
}
function _pickVeteranHitter(state, used) {
  const hitters = _roster(state, used).filter(p => HITTER_GROUPS.includes(p.group));
  return _pick(hitters.filter(p => p.trait === 'veteran'))
      || hitters.sort((a, b) => (a.dob || '').localeCompare(b.dob || ''))[0] || null; // oldest
}
function _pickLeader(state, used) {
  const all = _roster(state, used).filter(p =>
    PITCHER_GROUPS.includes(p.group) || HITTER_GROUPS.includes(p.group));
  return _pick(all.filter(p => p.trait === 'clubhouseLeader'))
      || _pick(all.filter(p => p.trait === 'veteran'))
      || all.sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0] || null;
}
function _pickActivePlayerByPos(state, pos) {
  return _roster(state).find(p => (p.nativePos || p.pos) === pos) || null;
}
function _pickFarm(state, pitchers) {
  const farm = (state.userTeam?.farmIds || []).map(id => state.players?.[id]).filter(Boolean);
  return _pick(farm.filter(p => ['SP', 'RP'].includes(p.pos) === pitchers));
}

function _setPitcher(values, prefix, p, fallback) {
  const hand = p ? (PITCHER_HAND_DISPLAY[p.hand] || '(R)') : '';
  values[`${prefix}_name`]       = p ? `${p.name} ${hand}` : fallback;
  values[`${prefix}_pos`]        = p?.pos || 'P';
  values[`${prefix}_trait_note`] = p ? _traitNote(p.trait) : '';
  values[`${prefix}_name_tr`]    = values[`${prefix}_name`];
  values[`${prefix}_pos_tr`]     = values[`${prefix}_pos`];
}
function _setHitter(values, prefix, p, fallback) {
  values[`${prefix}_name`]       = p?.name || fallback;
  values[`${prefix}_pos`]        = p ? (p.nativePos || p.pos) : 'position player';
  values[`${prefix}_trait_note`] = p ? _traitNote(p.trait) : '';
  values[`${prefix}_name_tr`]    = values[`${prefix}_name`];
  values[`${prefix}_pos_tr`]     = values[`${prefix}_pos`];
}

// ─────────────────────────────────────────────────────────────
// RANDOM HELPERS
// ─────────────────────────────────────────────────────────────

function _pick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
function _shuffle(arr) {
  return arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
function _randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function _randFloat(min, max) {
  return min + Math.random() * (max - min);
}
