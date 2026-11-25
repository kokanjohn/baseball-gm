/**
 * engine/SimEngine.js
 * Full base-state game simulation, play-by-play generation, and stat accumulation.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies results.
 *   - Every numeric value imported from constants — nothing hardcoded.
 *   - computeWinProbability() is the single place win prob is ever calculated.
 *   - generatePlays() produces the complete play array before first pitch.
 *   - accumulateStats() attributes stats to individual players from the play array.
 *   - All sub-rating → outcome mappings are in simulateAtBat() — single source.
 *
 * Section references: Section 7 (sim design), Section 8 (live game), Section 22.5 (gmRel)
 */

import {
  SIM_BASE_WIN_PROB,
  SIM_OVR_DIFF_WEIGHT,
  SIM_HITTER_OVR_WEIGHT,
  SIM_SP_OVR_WEIGHT,
  SIM_BP_OVR_WEIGHT,
  SIM_SP_INNINGS_BASE,
  SIM_SP_INNINGS_QUALITY_SCALE,
  SIM_HOME_FIELD_BONUS,
  SIM_WIN_PROB_MIN,
  SIM_WIN_PROB_MAX,
  SIM_WEATHER_ADJ,
  SIM_RATING_AVG,
  SIM_PA_WALK_BASE, SIM_PA_WALK_PER_PT, SIM_PA_WALK_MIN, SIM_PA_WALK_MAX,
  SIM_PA_K_BASE, SIM_PA_K_PER_CONTACT_PT, SIM_PA_K_PER_STUFF_PT, SIM_PA_K_MIN, SIM_PA_K_MAX,
  SIM_PA_HIT_BASE, SIM_PA_HIT_PER_CONTACT_PT, SIM_PA_HIT_PER_STUFF_PT, SIM_PA_HIT_MIN, SIM_PA_HIT_MAX,
  SIM_PA_INFIELD_HIT_PER_SPEED_PT,
  SIM_HIT_HR_SHARE_BASE, SIM_HIT_HR_SHARE_PER_PT, SIM_HIT_HR_SHARE_MIN, SIM_HIT_HR_SHARE_MAX,
  SIM_HIT_XBH_SHARE_BASE, SIM_HIT_XBH_SHARE_PER_PT, SIM_HIT_XBH_SHARE_MIN, SIM_HIT_XBH_SHARE_MAX,
  SIM_HIT_TRIPLE_SHARE,
  SIM_MAX_INNINGS_GUARD,
  ALLSTAR_STARTER_INNINGS,
  SIM_H_SPEED_SB_THRESHOLD,
  SIM_H_SPEED_STRETCH_THRESHOLD,
  SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD,
  SIM_THROWOUT_PLATE_BASE,
  SIM_THROWOUT_EXTRA_BASE,
  SIM_SPEED_THROWOUT_DIVISOR,
  SIM_SB_BASE_SUCCESS,
  SIM_SB_SPEED_BONUS_DIVISOR,
  SIM_SB_ATTEMPT_PROB,
  SIM_FC_PROB,
  SIM_DP_PROB,
  SIM_ERROR_PROB,
  POSITION_RULES,
  SIM_SAC_BUNT_POWER_MAX,
  SIM_SAC_BUNT_INNING_MIN,
  SIM_SAC_BUNT_PROB,
  SIM_P_CONTROL_HBP_THRESHOLD,
  SIM_P_STAMINA_INNINGS_DIVISOR,
  SIM_P_FATIGUE_HIT_QUALITY_BONUS,
  SIM_P_FATIGUE_K_PENALTY,
  SIM_P_FATIGUE_WALK_BONUS,
  SIM_GM_REL_LOW_VARIANCE,
  SIM_GM_REL_HIGH_CONSISTENCY,
  SIM_GM_REL_LOW_THRESHOLD,
  SIM_GM_REL_HIGH_THRESHOLD,
  GAME_TICK_MS,
  PLAYER_GROUP,
  PHASE,
  PLAYOFF_HOME_FIELD_BONUS,
  PLAYOFF_VARIANCE_MULTIPLIER,
  REGIONS,
  REGION_DEFAULT,
  SIM_WEATHER_ENV, GAME_WEATHER,
} from '../data/constants.js';

import { computeOVR, isAvailable, computeAge } from './PlayerFactory.js';
import { playingRating, trueRatings } from './Diamonds.js';
import { injuryChancePerExposure } from './InjuryEngine.js';
import {
  ROLE, bullpenRoles, chooseReliever, starterRested, armStatus, armLoad, tireAfterBF, reliefInnings, springStarterInnings, seasonStarterInnings,
} from './PitchingEngine.js';
import { PITCH_HOOK_EXTRA_BF, PITCH_SHELLED_RUNS, PITCH_SHELLED_EARLY_RUNS, WEAR } from '../data/constants.js';
import { canPlay, primaryPos, posLabel, defenseOf, reliefBoost, exposure } from './Positions.js';
import { DEFENSE_SIM as DS, TAG_UP, GROUND_ADV, WILD_PITCH, IBB } from '../data/constants.js';   // r205 §122.83, r227 §122.106, r228 §122.107
import { battingOrder, strategyOf, runStyle, hookStyle } from './Strategy.js';   // r169
import { lateClosePoints } from './ManagerEngine.js';   // §122.64
import { dice } from './Dice.js';   // r226 §122.105 where the ball went: its own stream, never the game's

// ─────────────────────────────────────────────────────────────
// WIN PROBABILITY — single source of truth
// ─────────────────────────────────────────────────────────────

/**
 * computeWinProbability(userRoster, opponentTeam, players, context)
 * Returns the user team's probability of winning this game (0.20–0.80).
 *
 * @param {String[]} userRoster   — rosterIds of healthy user players
 * @param {Object}   opponentTeam — league team object { rosterIds, str }
 * @param {Object}   players      — state.players registry
 * @param {Object}   context      — { morale, atmosphere, game, phase }
 * @returns {Number} winProbability
 */
export function computeWinProbability(userRoster, opponentTeam, players, context) {
  const {
    morale = 50,
    atmosphere = 50,
    game,
    phase,
    consecutiveRoadGames = 0,
    region = REGION_DEFAULT,
  } = context;

  const ourOvr  = _teamOvr(userRoster, players);
  const oppOvr  = _opponentOvr(opponentTeam, players);
  const ovrDiff = ourOvr - oppOvr;

  const moraleAdj  = (morale     - 50) * 0.001;
  const atmosAdj   = (atmosphere - 50) * 0.0006;
  const weatherCond = game?.weather?.label || 'Clear';
  const weatherAdj = SIM_WEATHER_ADJ[weatherCond] ?? 0;

  // Home field: stronger in playoffs
  const isHome = game?.isHome ?? false;
  const homeBonus = isHome
    ? (phase === PHASE.WILD_CARD || phase === PHASE.DIVISION_SERIES ||
       phase === PHASE.CHAMPIONSHIP_SERIES || phase === PHASE.WORLD_SERIES
       ? PLAYOFF_HOME_FIELD_BONUS : SIM_HOME_FIELD_BONUS)
    : 0;

  // West altitude scoring bonus — ball carries further at home (Section 8.13)
  const regionCfg = REGIONS[region] ?? REGIONS[REGION_DEFAULT];
  const altitudeBonus = (isHome && regionCfg.altitudeScoringBonus)
    ? regionCfg.altitudeScoringBonus
    : 0;

  // Travel fatigue — penalty for deep road trips (Section 8.13)
  // Applied only on road games beyond the region's fatigue threshold.
  // Negative modifier reduces win probability when fatigued on the road.
  const travelFatigueAdj = _computeTravelFatigue(isHome, consecutiveRoadGames, regionCfg);

  let winProb = SIM_BASE_WIN_PROB
    + (ovrDiff * SIM_OVR_DIFF_WEIGHT)
    + moraleAdj
    + atmosAdj
    + weatherAdj
    + homeBonus
    + altitudeBonus
    + travelFatigueAdj;

  // Playoff variance multiplier — upsets more likely
  if (phase === PHASE.WILD_CARD || phase === PHASE.DIVISION_SERIES ||
      phase === PHASE.CHAMPIONSHIP_SERIES || phase === PHASE.WORLD_SERIES) {
    // Pull win prob toward 0.5 by the variance multiplier
    winProb = 0.5 + (winProb - 0.5) / PLAYOFF_VARIANCE_MULTIPLIER;
  }

  return _clamp(winProb, SIM_WIN_PROB_MIN, SIM_WIN_PROB_MAX);
}

// ─────────────────────────────────────────────────────────────
// PLAY GENERATION — pre-game, full base-state
// ─────────────────────────────────────────────────────────────

/**
 * generatePlays(game, userTeam, opponentTeam, players, context)
 * Generates the complete play-by-play array before first pitch.
 * Returns plays[] — stored in game.plays, revealed by tick().
 *
 * @param {Object}   game         — game object from schedule
 * @param {Object}   userTeam     — state.userTeam
 * @param {Object}   opponentTeam — league team object or null for user-vs-CPU
 * @param {Object}   players      — state.players registry
 * @param {Object}   context      — { phase, isSpring, winProb }
 * @returns {Object} { plays, boxScore }
 */
export function generatePlays(game, userTeam, opponentTeam, players, context) {
  return _withDice(context, 'generatePlays', () => _generatePlays(game, userTeam, opponentTeam, players, context));
}

// §118 Every draw in a game comes from that game's own stream (Dice.dice — the
// caller names it), so the same game plays out the same way whenever it's
// simulated: the look-ahead and the real first pitch agree.
let _rand = null;
function _withDice(context, who, fn) {
  if (typeof context?.rand !== 'function') throw new Error(`SimEngine.${who}: context.rand (the game's Dice stream) is required`);
  const prev = _rand;
  _rand = context.rand;
  try { return fn(); } finally { _rand = prev; }
}

function _generatePlays(game, userTeam, opponentTeam, players, context) {
  _ballKey = `g:${game?.id ?? ''}:${game?.gameTime ?? ''}`;   // r226 §122.105
  const { isSpring = false, phase = PHASE.REGULAR_SEASON, norms = null, exhibition = false, scout = null, staff = null } = context;
  _requireInjuryYear(context, exhibition, 'generatePlays');
  // §102.2 the weather this game is played in: its plan (GameWeather.gameWeatherPlan)
  // and the park report through it (GameWeather.gameConditions). Optional.
  const wx = _weatherSetup(context.weather, game);

  // When opponentTeam is null (lookup failed), build a synthetic CPU opponent
  // from any available league team so the game can still produce scoring plays.
  // Without this, _buildCPULineup returns empty slots and every game ends 0-0.
  const effectiveOppTeam = opponentTeam || _buildSyntheticCPUTeam(players);

  // Build active lineups
  const userLineup = _buildLineup(userTeam, players, false);
  const oppLineup  = _buildLineup(effectiveOppTeam, players, true);

  // Snapshot the STARTING batting orders (away/home) before simulation mutates
  // slots via pinch-hits. Seeds the box score's full 9-man hitter lineup and is
  // stored on the game as liveLineups for the live box.
  const _userIsHome = !!game.isHome;
  const _awayOrder = (_userIsHome ? oppLineup : userLineup).slots.map(s => s.id);
  const _homeOrder = (_userIsHome ? userLineup : oppLineup).slots.map(s => s.id);

  // Select starting pitchers from rotation
  // §76: the starter in turn, if he's had his rest (else the next who has).
  const atMs    = game.gameTime || 0;
  // §102.5 the GM can name this game's starter (a bullpen game in a doubleheader).
  // (§122.70 only a pitcher on our club: a name left on a game is never a reason to start someone who's gone)
  const named   = game.userStarterId && players[game.userStarterId] && isAvailable(players[game.userStarterId])
                  && (userTeam.rosterIds || []).includes(game.userStarterId) ? { id: game.userStarterId } : null;
  const userSP  = named || _getRotationSP(userTeam, players, atMs);
  const oppSP   = _getRotationSP(effectiveOppTeam, players, atMs) || _findHealthySP(effectiveOppTeam.rosterIds || [], players);

  // Field condition modifiers
  // Offense environment = field condition × the weather. Both act inside every
  // at-bat (hit probability / HR share), never on the final score. With the
  // weather plan, the temperature, wind and rain come an inning at a time from
  // the park report (§102.2); without it, the legacy single scoring modifier.
  const scoringMod = wx ? 1.0 : (game.weather?.scoringMod ?? 1.0);
  const fieldMod   = _clamp(_fieldConditionMod(game.fieldCondition, !!wx) * scoringMod, 0.85, 1.15);

  // Run the full game simulation
  const gameState = _simulateFullGame(
    userLineup, oppLineup,
    userSP, oppSP,
    players,
    { game, fieldMod, isHome: game.isHome, phase, isSpring, norms, atMs, scout, wx, staff: exhibition ? null : staff,
      injuryYear: exhibition ? null : context.injuryYear,
      holdIds: exhibition ? [] : (context.holdIds || []),   // r200 saved to start a later game today
      // §75 All-Star Game: both starters work ALLSTAR_STARTER_INNINGS, every
      // other arm one inning; the reserves come in on the squads' plan.
      exhibition: exhibition ? { starterIds: new Set([userSP?.id, oppSP?.id].filter(Boolean)) } : null }
  );

  // Prepend a game_start announcement play — first thing shown in PBP.
  // Only announces the starting pitcher for the user's team — either the
  // user's SP taking the mound (if user is away) or the opponent's SP
  // (if user is home). Clean single-line announcement.
  const userSPPlayer = userSP ? players[userSP.id] : null;
  const oppSPPlayer  = oppSP  ? players[oppSP.id]  : null;
  const homeSPPlayer = game.isHome ? userSPPlayer : oppSPPlayer;

  // The HOME team pitches the top of the 1st (the away team bats first), so the
  // first pitcher to take the mound is the home starter. When the user is away
  // this is correctly the opponent's starter.
  const moundSP    = homeSPPlayer;
  const moundName  = moundSP?.name || 'SP';
  const preMins     = wx?.pre.length ? Math.round((wx.startAt - wx.pre[0].startT) / 60_000) : 0;
  const announcement = preMins ? `After a ${_delayLength(preMins)} delay, ${moundName} takes the mound.` : `${moundName} takes the mound.`;

  const announcementPlay = {
    playIndex:     0,
    _halfInning:   'TOP_1',
    inning:        1,
    half:          'TOP',
    batterId:      null,
    pitcherId:     moundSP?.id || null,
    type:          'game_start',
    description:   announcement,
    rbi:           0,
    isScoring:     false,
    isBigPlay:     false,
    outsAfter:     0,
    _basesAfter:   { first: null, second: null, third: null },
    cumOurScore:   0,
    cumTheirScore: 0,
    _timestamp:    game.gameTime || 0,
    _statDeltas:   {},
  };

  // A delayed start: the delay is the first thing shown, first pitch follows it.
  if (wx) announcementPlay._timestamp = wx.startAt;
  const prePlays = wx ? wx.pre.map(d => _weatherPlay('weather_delay', d, { inning: 1, half: 'TOP', outs: 0, bases: null, pitcherId: null, pre: true })) : [];

  // Assign real-world timestamps to each play: paced by the game's progress,
  // with the weather's delays on the clock (§102.2).
  const allPlays = _assignTimestamps([...prePlays, announcementPlay, ...gameState.plays], game, wx, gameState);

  // Post-process: assign W/L/SV/HD decisions to user team pitchers
  // These are game-outcome stats that can't be determined mid-play.
  // (A called game's innings that don't count are left out; in a game of five
  // innings a starter needs four for the win — official scoring 9.17(b).)
  const decisionDeltas = _assignPitcherDecisions(
    allPlays.filter(p => !p._reverted), gameState.userScore, gameState.oppScore, game.isHome,
    gameState.ruling?.outcome === 'final' && gameState.ruling.innings <= 5 ? 12 : 15
  );
  // Attach decision deltas to the game_end play so accumulateStats picks them up
  const gameEndPlay = allPlays.find(p => p.type === 'game_end');
  if (gameEndPlay && Object.keys(decisionDeltas).length > 0) {
    gameEndPlay._statDeltas = decisionDeltas;
  }
  // A suspended game (§109): what's played today; the rest is simulated when it
  // resumes (generateResumption), from where it stands (resumeState).
  const plays       = allPlays;
  const resumeState = gameState.suspended || null;

  // Build box score via the shared accumulator (single source of truth).
  // Home roster ids: who is on which side, independent of who the user is.
  const homeTeamObj = _userIsHome ? userTeam : effectiveOppTeam;
  const homeIds     = [...new Set([...(homeTeamObj.rosterIds || []),
                                   ...(_userIsHome ? userLineup : oppLineup).slots.map(s => s.id)])];
  const boxScore    = accumulateBox(allPlays, players, { awayOrder: _awayOrder, homeOrder: _homeOrder, userIsHome: _userIsHome, homeIds });
  const liveLineups = { away: _awayOrder, home: _homeOrder, homeIds };

  // What the weather did (§102.2): the delays that happened, and how a called
  // game came out ('final' — official; 'suspended' — finished another day).
  const weather = wx ? {
    startAt: wx.startAt,
    delays: [...wx.pre, ...wx.log].map(d => ({ startT: d.startT, endT: d.endT, reason: d.reason, atPlayMin: d.atPlayMin,
                                                 inning: d.inning ?? null, half: d.half ?? null, outs: d.outs ?? null })),
    ruling: gameState.ruling || null,
    conditions: wx.env,
  } : null;

  return { plays, boxScore, liveLineups, resumeState, weather };
}

// ─────────────────────────────────────────────────────────────
// A SUSPENDED GAME, FINISHED ANOTHER DAY (§109)
// ─────────────────────────────────────────────────────────────

// What a game in progress keeps through a suspension (the rest of gs is the day's: the weather, the
// scouting report, the league's norms, the bullpens — rebuilt from the rosters when it resumes).
const _SNAP_SKIP = new Set(['norms', 'scout', 'exhibition', 'wx', 'env', 'bullpens', 'userRoles', 'oppRoles', 'wxStop', 'ruling', 'suspendSnap', 'atMs', 'isSpring']);

/** Where a suspended game stands: plain data, kept on the game until it resumes. */
function _snapshotForResume(gs, plays, { isTop, outs, bases, halfRuns, userBatsBottom, fieldMod, slots }) {
  const g = {};
  for (const [k, v] of Object.entries(gs)) {
    if (_SNAP_SKIP.has(k) || typeof v === 'function') continue;
    if (v instanceof Set) g[k] = { __set: [...v] };
    else if (typeof v === 'number') g[k] = Number.isFinite(v) ? v : 1e9;
    else if (v === null || ['string', 'boolean'].includes(typeof v)) g[k] = v;
    else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 4) g[k] = JSON.parse(JSON.stringify(v));   // { id } pitchers
  }
  // Everyone who has batted for each side (they can't come back in once replaced).
  const appeared = { user: [], opp: [] };
  for (const p of plays) {
    if (!p.batterId || (p.half !== 'TOP' && p.half !== 'BOT')) continue;
    const side = (p.half === 'BOT') === userBatsBottom ? 'user' : 'opp';
    if (!appeared[side].includes(p.batterId)) appeared[side].push(p.batterId);
  }
  return {
    v: 1, isTop, outs, bases: { ...bases }, halfRuns, fieldMod, gs: g, appeared,
    slots: { user: slots.user.map(x => ({ id: x.id, subbed: !!x.subbed, sub: !!x.sub })), opp: slots.opp.map(x => ({ id: x.id, subbed: !!x.subbed, sub: !!x.sub })) },
  };
}

function _restoreForResume(gs, R) {
  for (const [k, v] of Object.entries(R.gs || {})) gs[k] = v && typeof v === 'object' && v.__set ? new Set(v.__set) : v;
}

/** Playing minutes left in a suspended game, about (for the resumption's weather plan): the halves still to come. */
export function resumeMinutesLeft(R) {
  if (!R) return 0;
  const halfIdx = (R.gs.inning - 1) * 2 + (R.isTop ? 0 : 1);
  const HALF = GAME_WEATHER.HALF_MIN;
  return Math.max(HALF, (Math.max(18, halfIdx + 1) - halfIdx) * HALF - R.outs * HALF / 3);
}

/**
 * generateResumption(game, userTeam, opponentTeam, players, context) — §109 a
 * suspended game finished on the day it resumes: from exactly where it
 * stopped (inning, outs, runners, score, the batting orders, the pitchers
 * used), with each club's roster as it is now. A player who has left the club
 * or can't play (traded, injured, sent down) is replaced in the lineup by a
 * bench player — one who can play the position first — and can't come back
 * in; a runner who has left gets a pinch runner. The bullpens are today's.
 *   context: { resumeState, partOne (the game's plays so far), liveLineups, phase, isSpring, norms }
 * → { plays (the rest, each with _resumeMin: playing minutes after the stop — resumeTimeline
 *     puts them on the day's clock), boxScore (the whole game), liveLineups }
 */
export function generateResumption(game, userTeam, opponentTeam, players, context) {
  return _withDice(context, 'generateResumption', () => _generateResumption(game, userTeam, opponentTeam, players, context));
}

function _generateResumption(game, userTeam, opponentTeam, players, context) {
  _ballKey = `r:${game?.id ?? ''}:${game?.gameTime ?? ''}`;   // r226 §122.105
  _requireInjuryYear(context, false, 'generateResumption');
  const { resumeState: R, partOne = [], liveLineups = {}, phase = PHASE.REGULAR_SEASON, isSpring = false, norms = null, staff = null } = context;
  const effOpp = opponentTeam || _buildSyntheticCPUTeam(players);
  const clubs = { user: userTeam, opp: effOpp };
  const fresh = { user: _buildLineup(userTeam, players, false), opp: _buildLineup(effOpp, players, true) };
  const userBatsBottom = !!game.isHome;
  const sp = partOne[partOne.length - 1];
  const half = R.isTop ? 'TOP' : 'BOT';
  const where = { inning: R.gs.inning, half, outsAfter: R.outs };
  const pre = [];
  const replaced = {};   // who left → who took his place
  const lineups = {};
  for (const side of ['user', 'opp']) {
    const roster = new Set(clubs[side]?.rosterIds || []);
    const can = (id) => roster.has(id) && players[id] && isAvailable(players[id]) && players[id].group !== PLAYER_GROUP.IL;
    const slots = R.slots[side].map(x => ({ ...x }));
    const out = new Set([...(R.appeared[side] || []), ...slots.map(x => x.id)]);
    const bench = fresh[side].bench.filter(b => !out.has(b.id));
    for (const sl of slots) {
      if (can(sl.id)) continue;
      const gone = players[sl.id];
      const fits = (b) => { const q = players[b.id]; return q && gone && canPlay(q, sl.pos || primaryPos(gone)); };   // r163 Positions
      const sub = bench.filter(b => !b.used).sort((a, b) => (fits(b) - fits(a)) || ((players[b.id]?.ovr || 0) - (players[a.id]?.ovr || 0)))[0];
      if (!sub) continue;   // (no one left on the bench: the spot stays as it was)
      sub.used = true;
      replaced[sl.id] = sub.id;
      pre.push({
        playIndex: 0, _halfInning: `${half}_${where.inning}`, inning: where.inning, half, batterId: null, pitcherId: null,
        type: 'lineup_change', description: `${players[sub.id]?.name || 'A substitute'} takes ${gone?.name || 'a starter'}'s place in the lineup (${!roster.has(sl.id) ? 'no longer with the club' : 'unavailable'}).`,
        rbi: 0, isScoring: false, isBigPlay: false, outsAfter: R.outs, _basesAfter: { ...R.bases },
        cumOurScore: sp?.cumOurScore ?? 0, cumTheirScore: sp?.cumTheirScore ?? 0, _timestamp: 0, _statDeltas: {},
      });
      sl.id = sub.id; sl.subbed = false; sl.sub = true;
    }
    lineups[side] = { slots, bench, bullpen: fresh[side].bullpen, roles: fresh[side].roles, mgr: fresh[side].mgr };
  }
  // A runner who has left: whoever took his place in the order runs for him.
  const bases = { ...R.bases };
  for (const b of ['first', 'second', 'third']) if (bases[b] && replaced[bases[b]]) bases[b] = replaced[bases[b]];
  const gameState = _simulateFullGame(lineups.user, lineups.opp, R.gs.userPitcher || null, R.gs.oppPitcher || null, players, {
    game, fieldMod: R.fieldMod ?? 1, isHome: game.isHome, phase, isSpring, norms, atMs: game.gameTime || 0, scout: null, wx: null, staff,
    injuryYear: context.injuryYear,
    resume: { ...R, bases },
  });
  gameState.plays.forEach(p => { p._basesAfter ??= { first: null, second: null, third: null }; });
  // On the clock: the playing minutes after the stop.
  const timed = _assignTimestamps([...partOne, ...pre, ...gameState.plays], game, null, gameState);
  const rest = timed.slice(partOne.length);
  // The decisions, over the whole game.
  const all = timed.filter(p => !p._reverted);
  const dec = _assignPitcherDecisions(all, gameState.userScore, gameState.oppScore, game.isHome, 15);
  const end = rest.find(p => p.type === 'game_end');
  if (end && Object.keys(dec).length) end._statDeltas = dec;
  const homeTeam = userBatsBottom ? userTeam : effOpp;
  const homeIds = [...new Set([...(liveLineups.homeIds || []), ...(homeTeam?.rosterIds || []), ...lineups[userBatsBottom ? 'user' : 'opp'].slots.map(x => x.id)])];
  const lineupsOut = { ...liveLineups, homeIds };
  const boxScore = accumulateBox(timed, players, { awayOrder: liveLineups.away || [], homeOrder: liveLineups.home || [], userIsHome: userBatsBottom, homeIds });
  return { plays: rest, boxScore, liveLineups: lineupsOut };
}

// ─────────────────────────────────────────────────────────────
// FULL GAME SIMULATION
// ─────────────────────────────────────────────────────────────

function _simulateFullGame(userLineup, oppLineup, userSP, oppSP, players, ctx) {
  const { game, fieldMod, isHome, phase, isSpring, norms = null, exhibition = null, atMs = 0, scout = null, wx = null, staff = null } = ctx;
  // §112.2 the GM's coaching staff, for this game (our players only).
  _staff = staff || null;
  _simAt = atMs || null;   // r161 §122.33 the arms' workload as of first pitch
  const isGM = (lu) => (lu?.slots || []).some(sl => players[sl.id]?.teamId === 'user');
  const userIsGM = isGM(userLineup), oppIsGM = isGM(oppLineup);

  const plays = [];

  // Game state
  const gs = {
    inning:       1,
    maxInnings:   9,
    isSpring:     !!isSpring,
    userScore:    0,
    oppScore:     0,
    userLineupIdx:  0,  // batting order position (cycles through slots)
    oppLineupIdx:   0,
    userPitcher:  userSP,
    oppPitcher:   oppSP,
    userPitchCount: 0,
    oppPitchCount:  0,
    userPitcherInnings: 0, // innings by the user's CURRENT pitcher (reset on change)
    oppPitcherInnings:  0,
    userFatigued: false,
    oppFatigued:  false,
    userBullpenIdx: 0,
    oppBullpenIdx:  0,
    norms,          // league averages the PA model measures against (§65)
    scout,          // §90 an advance scouting report on this opponent: { bat, pitch } hit-rate factors (null otherwise)
    exhibition,     // §75: All-Star Game workloads / substitutions (null otherwise)
    // §76 the manager's pitching: the bullpen's roles, who has pitched, and the
    // current pitcher's role, batters before he tires, innings wanted, runs allowed.
    atMs,
    userRoles: userLineup.roles || null, oppRoles: oppLineup.roles || null,
    // (r200 an arm named to start a later game today counts as used: never in relief before it)
    userUsed:  new Set([userSP?.id, ...(ctx.holdIds || [])].filter(Boolean)), oppUsed: new Set([oppSP?.id].filter(Boolean)),
    userRole:  ROLE.STARTER, oppRole: ROLE.STARTER,
    // (r169 the hook moves a starter's innings and batters, never a spring build-up or the All-Star Game)
    userTireAt: exhibition ? Infinity : tireAfterBF(userSP && players[userSP.id], true) + (isSpring ? 0 : userLineup.hook?.bf || 0),
    oppTireAt:  exhibition ? Infinity : tireAfterBF(oppSP && players[oppSP.id], true) + (isSpring ? 0 : oppLineup.hook?.bf || 0),
    userTarget: _hooked(_pitcherTargetInnings(userSP && players[userSP.id], { exhibition, isSpring, springNum: game?.index }), exhibition || isSpring ? null : userLineup.hook),
    oppTarget:  _hooked(_pitcherTargetInnings(oppSP && players[oppSP.id], { exhibition, isSpring, springNum: game?.index }), exhibition || isSpring ? null : oppLineup.hook),
    userRuns: 0, oppRuns: 0,
    mgr: { user: userLineup.mgr || 0, opp: oppLineup.mgr || 0 },   // §122.64 each manager's late, close-game points
    // §118 injuries on the field: the season year (for age), and who has already left hurt.
    injuryYear: ctx.injuryYear ?? null,
    hurt: new Set(),
  };

  gs.wx       = wx || null;           // §102.2 the weather's plan for this game (null: none)
  gs.halfIdx  = 0;                    // half-innings begun − 1: the clock's playing minutes run 10 a half
  gs.env      = null;
  gs.bullpens = { user: userLineup.bullpen, opp: oppLineup.bullpen };

  // User team bats in bottom (home) or top (away)
  const userBatsBottom = isHome;
  const homeScore = () => (userBatsBottom ? gs.userScore : gs.oppScore);
  const awayScore = () => (userBatsBottom ? gs.oppScore  : gs.userScore);

  // One half-inning: the batting side's lineup against the fielding side's
  // pitcher, in this inning's weather. `resume` continues a half stopped by
  // the weather (a suspended game).
  const runHalf = (isTop, walkoffRuns = Infinity, resume = null) => {
    const userBats = isTop ? !userBatsBottom : userBatsBottom;
    _userFielding = userBats ? oppIsGM : userIsGM;
    _fieldDef = (userBats ? oppLineup : userLineup)?.defense || null;   // r165 the fielding side's defense
    _fielders = _fieldersOf(userBats ? oppLineup : userLineup, players, gs.norms);   // r205 §122.83 who's where, and the gloves
    _runBat = (userBats ? userLineup : oppLineup)?.run || null;         // r169 the batting side's running game
    gs.halfIdx = (gs.inning - 1) * 2 + (isTop ? 0 : 1);
    gs.env = _envFor(gs.wx, gs.halfIdx);
    const hp = _simulateHalfInning(
      userBats ? userLineup.slots : oppLineup.slots, userBats ? userLineup.bench : oppLineup.bench,
      userBats ? gs.oppPitcher : gs.userPitcher, gs, players, fieldMod * gs.env.hitMod,
      userBats, isSpring, `${isTop ? 'TOP' : 'BOT'}_${gs.inning}`, userBats ? 'userLineupIdx' : 'oppLineupIdx',
      gs.inning, walkoffRuns, resume);
    // r229 §122.108 who was where in the field this half (the Live View): on the half's first play. A label only.
    if (hp.length && _fielders) hp[0]._field = _fieldIds(_fielders);
    plays.push(...hp);
    _stampRunningScore(hp, gs.userScore, gs.oppScore, userBats);
    const runs = hp.reduce((sum, p) => sum + playRuns(p), 0);
    if (userBats) gs.userScore += runs; else gs.oppScore += runs;
    gs[userBats ? 'oppRuns' : 'userRuns'] += runs;   // off the fielding side's pitcher
  };

  // The weather stopped play for good: the ruling (official → the game is
  // over; otherwise suspended → the rest of it is played now, for the day it
  // resumes). Returns true when the game is over.
  const afterStop = (isTop, walkoffRuns) => {
    if (!gs.wxStop || gs.wxStop.handled) return false;
    const st = gs.wxStop;
    st.handled = true;
    // A pitcher brought in as his side took the field, before the stop, never threw a pitch: the change didn't happen.
    const iDelay = plays.length - 1;
    if (plays[iDelay]?.type === 'weather_delay' && plays[iDelay - 1]?.type === 'pitching_change') plays.splice(iDelay - 1, 1);
    gs.ruling = _calledRuling(gs, plays, { isTop, userBatsBottom, exhibition: !!(isSpring || exhibition), playoff: !!game?.isPlayoff });
    if (gs.ruling.outcome === 'final') return true;
    // Suspended (§109): the game stops here. Where it stands is kept, and the
    // rest is played when it resumes (generateResumption) — with each club's
    // roster as it is that day, as the rules have it. Nobody pitches on
    // through a suspension: both clubs start the resumption with fresh arms.
    plays.push(_suspendedPlay(st, gs, plays));
    for (const side of ['user', 'opp']) { gs[`${side}Fatigued`] = true; gs[`${side}MustGo`] = true; }
    gs.suspendSnap = _snapshotForResume(gs, plays, {
      isTop, outs: st.outs, bases: st.bases, halfRuns: st.halfRuns, userBatsBottom, fieldMod,
      slots: { user: userLineup.slots, opp: oppLineup.slots },
    });
    return true;
  };

  // A suspended game picked up (§109): where it stood, and the half it stopped in comes first.
  let pending = null;
  if (ctx.resume) { _restoreForResume(gs, ctx.resume); pending = ctx.resume; }
  const resumeHalf = (isTop, walkoffRuns) => {
    const userBats = isTop ? !userBatsBottom : userBatsBottom;
    _midHalfChange(gs, players, userBats ? 'opp' : 'user', plays, gs.inning, isTop ? 'TOP' : 'BOT', pending.outs, pending.bases);
    runHalf(isTop, walkoffRuns, { outs: pending.outs, bases: pending.bases, halfRuns: pending.halfRuns });
  };

  while (pending || !_gameOver(gs)) {
    const resumeTop = !!pending && pending.isTop, resumeBot = !!pending && !pending.isTop;
    if (!resumeBot) {
      // Top of inning — away team bats. The home side takes the field: a tired
      // pitcher is replaced now, as he walks out (never at the end of his last
      // inning — the game may be over before he'd have pitched again).
      if (resumeTop) resumeHalf(true, Infinity);
      else {
        _checkPitcherChange(gs, players, userBatsBottom ? 'user' : 'opp', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning, 'TOP');
        runHalf(true);
      }
      if (afterStop(true, Infinity)) break;

      _accrueInningAndFatigue(gs, players, userBatsBottom ? 'user' : 'opp');

      // 9th inning or later: if the HOME team already leads after the top half,
      // the bottom half is not played (home team wins).
      if (gs.inning >= 9 && homeScore() > awayScore()) break;
    }

    // 9th inning or later: the bottom half ends the moment the home team takes
    // the lead (walk-off). Pass the number of runs that wins it (counted from
    // the start of the half — a resumed half has some of its runs in already).
    const walkoffRuns = gs.inning >= 9 ? (awayScore() - (homeScore() - (resumeBot ? pending.halfRuns : 0)) + 1) : Infinity;
    if (resumeBot) resumeHalf(false, walkoffRuns);
    else {
      // Bottom of inning — home team bats; the away side takes the field.
      _checkPitcherChange(gs, players, userBatsBottom ? 'opp' : 'user', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning, 'BOT');
      runHalf(false, walkoffRuns);
    }
    pending = null;
    if (afterStop(false, walkoffRuns)) break;

    // Walk-off: home team leads after its half of the 9th or later — game over.
    if (gs.inning >= 9 && homeScore() > awayScore()) break;

    _accrueInningAndFatigue(gs, players, userBatsBottom ? 'opp' : 'user');

    gs.inning++;

    // Spring training: end after 9 innings regardless of score (ties allowed).
    // Regular season: play extra innings until someone wins — no ties.
    if (isSpring) {
      if (gs.inning > 9) break;
    } else {
      if (gs.inning > 9 && gs.userScore !== gs.oppScore) break;
      if (gs.inning > SIM_MAX_INNINGS_GUARD) {
        // Pathological guard only (never reached with a realistic run
        // environment). The score is NEVER changed outside the plays — that
        // used to add a phantom run the box score could not account for.
        console.error('[SimEngine] extra-innings guard reached with the score tied');
        break;
      }
    }
  }

  // Suspended: it ends here for now (no final), and keeps where it stands.
  if (gs.suspendSnap) return { plays, userScore: gs.userScore, oppScore: gs.oppScore, ruling: gs.ruling, suspended: gs.suspendSnap };

  // A game called and official: the plays that don't count (a score that
  // reverts to the last complete inning) stay in the record of what happened
  // but carry nothing into the box score or the stats.
  const ruled = gs.ruling?.outcome === 'final' ? gs.ruling : null;
  if (ruled && ruled.revertIdx != null) for (let k = ruled.revertIdx; k < plays.length; k++) plays[k]._reverted = true;
  if (ruled) { gs.userScore = ruled.userScore; gs.oppScore = ruled.oppScore; }

  // Record the true last inning played. The loop increments gs.inning before the
  // end check, so on a non-walk-off finish gs.inning is one ahead; derive the
  // real final inning from the plays so game_end never claims a phantom 10th.
  const lastPlayedInning = plays.reduce(
    (m, p) => (p.type !== 'game_end' && !p._reverted && (p.inning || 0) > m ? p.inning : m), 1);

  plays.push({
    playIndex:    plays.length,
    _halfInning:  `END`,
    inning:       lastPlayedInning,
    half:         'END',
    batterId:     null,
    pitcherId:    null,
    type:         'game_end',
    description:  ruled ? ruled.text : 'Final',
    _called:      ruled ? { innings: ruled.innings, reason: ruled.reason, reverted: ruled.revertIdx != null } : undefined,
    rbi:          0,
    isScoring:    false,
    isBigPlay:    false,
    outsAfter:    3,
    _basesAfter:  { first: null, second: null, third: null },
    cumOurScore:   gs.userScore,
    cumTheirScore: gs.oppScore,
    _timestamp:   0,
    _statDeltas:  {},
  });

  return { plays, userScore: gs.userScore, oppScore: gs.oppScore, ruling: gs.ruling || null };
}

// ─────────────────────────────────────────────────────────────
// STOLEN BASE ATTEMPT
// ─────────────────────────────────────────────────────────────

/**
 * _attemptStolenBase(bases, players, outs, inning, gs)
 * Returns a stolen_base or caught_stealing play object, or null if no attempt.
 * Only the lead runner attempts (second takes priority over first if both on).
 */
/** r165 §122.35 a non-catcher behind the plate: runners go more often. */
const _runMore = () => (1 + POSITION_RULES.oop.sbAttempt * (_fieldDef?.catcher || 0)) * (_runBat?.attempt ?? 1);
/** r169 the speed a runner needs to go, by the batting side's running game. */
const _runSpeed = () => SIM_H_SPEED_SB_THRESHOLD + (_runBat?.speedShift || 0);

/**
 * r165 §122.35 a passed ball: a non-catcher behind the plate lets one by — every runner moves up a
 * base (a runner on third scores, unearned). Returns the play, or null.
 */
function _passedBall(bases, players, outs, pitcher) {
  const x = _fieldDef?.catcher || 0;
  if (!x || !(bases.first || bases.second || bases.third) || _roll() >= POSITION_RULES.oop.passedBall * x) return null;
  const scored = bases.third ? [bases.third] : [];
  const deltas = {};
  for (const id of scored) (deltas[id] ||= []).push({ stat: 'r', delta: 1 });
  const lead = players[bases.third || bases.second || bases.first];
  return {
    playIndex: 0, batterId: null, pitcherId: pitcher?.id || null,
    type: 'passed_ball',
    description: scored.length ? `Passed ball — ${lead?.name || 'the runner'} scores` : 'Passed ball — the runners move up',
    runs: scored.length, rbi: 0, isScoring: scored.length > 0, isBigPlay: false, outsAfter: outs,
    _basesAfter: { first: null, second: bases.first || null, third: bases.second || null },
    cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: deltas,
  };
}

/**
 * r228 §122.107 a wild pitch: with anyone on base, now and then (WILD_PITCH, by the pitcher's control) — every runner
 * moves up a base; a runner on third scores (earned). Returns the play, or null.
 */
function _wildPitch(bases, players, outs, pitcher) {
  if (!pitcher || !(bases.first || bases.second || bases.third)) return null;
  const ctl = _effectiveSR(pitcher, 'control', playingRating(pitcher, 'control')) || 50;
  if (_roll() >= WILD_PITCH.perPA * Math.max(WILD_PITCH.minMult, 1 + WILD_PITCH.perControl * (50 - ctl))) return null;
  const scored = bases.third ? [bases.third] : [];
  const deltas = {};
  for (const id of scored) (deltas[id] ||= []).push({ stat: 'r', delta: 1 });
  if (scored.length) (deltas[pitcher.id] ||= []).push({ stat: 'er', delta: scored.length });
  const lead = players[bases.third || bases.second || bases.first];
  return {
    playIndex: 0, batterId: null, pitcherId: pitcher.id,
    type: 'wild_pitch',
    description: scored.length ? `Wild pitch by ${pitcher.name} — ${lead?.name || 'the runner'} scores` : `Wild pitch by ${pitcher.name} — the runners move up`,
    runs: scored.length, rbi: 0, isScoring: scored.length > 0, isBigPlay: false, outsAfter: outs,
    _basesAfter: { first: null, second: bases.first || null, third: bases.second || null },
    cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: deltas,
  };
}

/**
 * r228 §122.107 an intentional walk, when the game calls for it (IBB — no manager's decision): first base open, a runner
 * on second or third, the batter clearly better than the one on deck; late and close, or with two outs.
 */
function _intentionalWalk(batter, onDeck, bases, outs, inning, batRuns, fieldRuns) {
  if (!batter || !onDeck) return false;
  // r229 §122.108 any time is allowed (MLB has no rule against it); the base state is how often managers choose it:
  // first base open with a runner in scoring position the usual case, first taken rare, bases empty rare and only for
  // a much better hitter, bases loaded (walking in a run) almost never.
  const gap = (batter.ovr || 0) - (onDeck.ovr || 0);
  const late = inning >= IBB.lateInning && Math.abs(batRuns - fieldRuns) <= IBB.closeRuns;
  const base = late ? IBB.late : outs === 2 ? IBB.early : 0;
  if (!base) return false;
  const loaded = bases.first && bases.second && bases.third;
  const empty = !bases.first && !bases.second && !bases.third;
  const w = loaded ? IBB.loaded : empty ? IBB.empty : bases.first ? IBB.firstTaken : 1;
  const need = loaded ? IBB.gapLoaded : empty ? IBB.gapEmpty : bases.first ? IBB.gapFirstTaken : IBB.gap;
  return gap >= need && _roll() < base * w;
}

function _attemptStolenBase(bases, players, outs, inning, gs) {
  // Pick the lead runner eligible for stealing
  // Runner on second stealing third is slightly less common than 1st→2nd
  let runnerId   = null;
  let fromBase   = null;
  let toBase     = null;

  if (bases.second && !bases.third) {
    const runner = players[bases.second];
    const spd    = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
    if (spd >= _runSpeed() && _roll() < SIM_SB_ATTEMPT_PROB * 0.7 * _runMore()) {
      runnerId = bases.second; fromBase = 'second'; toBase = 'third';
    }
  } else if (bases.first && !bases.second) {
    const runner = players[bases.first];
    const spd    = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
    if (spd >= _runSpeed() && _roll() < SIM_SB_ATTEMPT_PROB * _runMore()) {
      runnerId = bases.first; fromBase = 'first'; toBase = 'second';
    }
  }

  if (!runnerId) return null;

  const runner   = players[runnerId];
  const spd      = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
  const cat = _fielders?.byPos?.C || null;   // r205 §122.83 the catcher's throw
  const success  = _roll() < (SIM_SB_BASE_SUCCESS + (spd / SIM_SB_SPEED_BONUS_DIVISOR) + POSITION_RULES.oop.sbSuccess * (_fieldDef?.catcher || 0) + (_runBat?.success || 0)
    - DS.catcherSb * (cat?.d || 0));   // r165, r169 the running game

  const newBases = { ...bases };

  if (success) {
    newBases[fromBase] = null;
    newBases[toBase]   = runnerId;
    return {
      playIndex:    0,
      batterId:     null,
      pitcherId:    null,
      type:         'stolen_base',
      description:  `${runner?.name || 'Runner'} steals ${toBase}`,
      rbi:          0,
      isScoring:    false,
      isBigPlay:    false,
      outsAfter:    outs,
      _basesAfter:  newBases,
      cumOurScore:   0,
      cumTheirScore: 0,
      _timestamp:   0,
      _statDeltas:  runnerId ? { [runnerId]: [{ stat: 'sb', delta: 1 }] } : {},
    };
  } else {
    newBases[fromBase] = null; // runner out, no advancement
    return {
      playIndex:    0,
      batterId:     null,
      pitcherId:    null,
      type:         'caught_stealing',
      description:  `${runner?.name || 'Runner'} caught stealing ${toBase}${cat && cat.d >= 0.5 ? ` — ${cat.name}'s throw beats the runner` : ''}`,
      rbi:          0,
      isScoring:    false,
      isBigPlay:    false,
      outsAfter:    outs + 1,
      _basesAfter:  newBases,
      cumOurScore:   0,
      cumTheirScore: 0,
      _timestamp:   0,
      _statDeltas:  runnerId ? { [runnerId]: [{ stat: 'cs', delta: 1 }] } : {},
    };
  }
}

// ─────────────────────────────────────────────────────────────
// HALF-INNING SIMULATION
// ─────────────────────────────────────────────────────────────

function _simulateHalfInning(slots, bench, pitcherObj, gs, players, fieldMod, isUserBatting, isSpring, halfKey, batIdxKey, inning, walkoffRuns = Infinity, resume = null) {
  const plays  = [];
  // (resume: a half the weather stopped, picked up where it left off — §102.2)
  let outs     = resume ? resume.outs : 0;
  let halfRuns = resume ? resume.halfRuns : 0;       // runs scored so far this half
  let walkedOff = false;  // home team took the lead in the 9th+ — game ends now
  let bases    = resume ? { ...resume.bases } : { first: null, second: null, third: null };
  const fieldSide = isUserBatting ? 'opp' : 'user';
  // The pitcher can change mid-half only when the weather sends him to the clubhouse.
  let pitcher = resume ? players[gs[`${fieldSide}Pitcher`]?.id] || null : pitcherObj ? players[pitcherObj.id] : null;
  const half  = halfKey.startsWith('TOP') ? 'TOP' : 'BOT';

  // Guard: empty lineup (all players injured, or no starters at all)
  // Produce a valid but empty half-inning rather than infinite loop or NaN
  if (!slots || slots.length === 0) {
    plays.push({
      playIndex: 0, _halfInning: halfKey,
      inning: parseInt(halfKey.split('_')[1]) || 1,
      half: halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
      batterId: null, pitcherId: pitcher?.id || null,
      type: 'inning_end', description: `End of inning`, rbi: 0,
      isScoring: false, isBigPlay: false, outsAfter: 3,
      _basesAfter: { first: null, second: null, third: null },
      cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: {},
    });
    return plays;
  }

  while (outs < 3 && !walkedOff) {

    // ── The weather (§102.2): a delay due at this point of the game ──
    if (gs.wx) {
      const w = _weatherCheck(gs, players, plays, inning, half, outs, bases, fieldSide);
      if (w === 'stop') { gs.wxStop = { inning, half, outs, bases: { ...bases }, halfRuns, at: plays.length }; return plays; }
      if (w === 'arm')  pitcher = players[gs[`${fieldSide}Pitcher`].id] || pitcher;
    }

    // ── r165 a passed ball (a non-catcher behind the plate), between at-bats ──
    {
      const pb = _passedBall(bases, players, outs, pitcher);
      if (pb) {
        pb._halfInning = halfKey;
        pb.inning = parseInt(halfKey.split('_')[1]) || 1;
        pb.half = half;
        let runs = pb.runs;
        if (halfRuns + runs >= walkoffRuns) { walkedOff = true; runs = Math.max(0, walkoffRuns - halfRuns); pb.runs = runs; pb.isScoring = runs > 0; }
        halfRuns += runs;
        plays.push(pb);
        bases = pb._basesAfter;
        if (walkedOff) break;
        continue;
      }
    }

    // ── r228 §122.107 a wild pitch, between batters (anyone on base) ──
    if (!isSpring) {
      const wp = _wildPitch(bases, players, outs, pitcher);
      if (wp) {
        wp._halfInning = halfKey;
        wp.inning = parseInt(halfKey.split('_')[1]) || 1;
        wp.half = half;
        let runs = wp.runs;
        if (halfRuns + runs >= walkoffRuns) { walkedOff = true; runs = Math.max(0, walkoffRuns - halfRuns); wp.runs = runs; wp.isScoring = runs > 0; }
        halfRuns += runs;
        plays.push(wp);
        bases = wp._basesAfter;
        if (walkedOff) break;
        continue;
      }
    }

    // ── Stolen base attempt (between at-bats) ─────────────────
    if (outs < 2 && (bases.first || bases.second) && !isSpring) {
      const sbPlay = _attemptStolenBase(bases, players, outs, inning, gs);
      if (sbPlay) {
        const prev = plays[plays.length - 1];
        sbPlay.cumOurScore   = prev?.cumOurScore   ?? 0;
        sbPlay.cumTheirScore = prev?.cumTheirScore ?? 0;
        sbPlay._halfInning   = halfKey;
        sbPlay.inning        = parseInt(halfKey.split('_')[1]) || 1;
        sbPlay.half          = halfKey.startsWith('TOP') ? 'TOP' : 'BOT';
        if (sbPlay.type === 'caught_stealing' && pitcher) {
          // The out is the pitcher's: charge it to him like any other.
          sbPlay.pitcherId = pitcher.id;
          (sbPlay._statDeltas[pitcher.id] ||= []).push({ stat: 'ip', delta: 0.333 });
        }
        plays.push(sbPlay);
        bases = sbPlay._basesAfter;
        if (sbPlay.type === 'caught_stealing') {
          outs++;
          if (outs >= 3) break;
        }
        continue;
      }
    }

    const slotIdx    = gs[batIdxKey] % slots.length;
    let   slot       = slots[slotIdx];
    const batter     = slot ? players[slot.id] : null;
    gs[batIdxKey]++;

    if (!batter || !pitcher) {
      outs++;
      continue;
    }

    // ── Substitution check ────────────────────────────────────
    const subPlay = gs.exhibition
      ? _plannedSubstitution(slots, slotIdx, batter, players, inning)
      : _checkBenchSubstitution(
          slots, bench, slotIdx, batter, players,
          inning, isSpring, gs.userScore, gs.oppScore, isUserBatting
        );

    if (subPlay) {
      const prev = plays[plays.length - 1];
      subPlay.cumOurScore   = prev?.cumOurScore   ?? 0;
      subPlay.cumTheirScore = prev?.cumTheirScore ?? 0;
      subPlay._halfInning   = halfKey;
      subPlay.inning        = parseInt(halfKey.split('_')[1]) || 1;
      subPlay.half          = halfKey.startsWith('TOP') ? 'TOP' : 'BOT';
      subPlay.outsAfter     = outs;          // a substitution changes neither
      subPlay._basesAfter   = { ...bases };
      plays.push(subPlay);
      slot = slots[slotIdx];
    }

    const activeBatter = players[slots[slotIdx].id];
    if (!activeBatter) { outs++; continue; }

    // §7.4 / §76: past the batters his stamina carries (or already tired from
    // recent days), the pitcher is laboring until the manager gets him.
    const pSide = isUserBatting ? 'opp' : 'user';
    let pitcherTired = gs[`${pSide}PitchCount`] >= gs[`${pSide}TireAt`];
    // §118 the pitcher hurt on a pitch: the bullpen now, before this batter.
    if (gs.injuryYear != null) {
      const relief = _pitcherHurt(gs, players, plays, pitcher, pSide, pitcherTired, inning, outs, bases, halfKey);
      if (relief) { pitcher = relief; pitcherTired = false; }
    }
    // r167 §122.35 a starter working in relief: the short-stint boost (by age)
    const shortStint = gs[`${pSide}Role`] !== ROLE.STARTER && pitcher ? reliefBoost(pitcher, gs.injuryYear != null ? computeAge(pitcher.dob, gs.injuryYear) : null) : null;
    // §122.64 the 7th on, within two runs: each side's manager has a hand in it.
    const batRuns = (isUserBatting ? gs.userScore : gs.oppScore) + halfRuns, fieldRuns = isUserBatting ? gs.oppScore : gs.userScore;
    const mgr = !isSpring && !gs.exhibition && inning >= 7 && Math.abs(batRuns - fieldRuns) <= 2
      ? { bat: gs.mgr?.[isUserBatting ? 'user' : 'opp'] || 0, pitch: gs.mgr?.[isUserBatting ? 'opp' : 'user'] || 0 } : null;
    // r228 §122.107 an intentional walk when the game calls for it; otherwise the at-bat
    const ibb = !isSpring && _intentionalWalk(activeBatter, players[slots[gs[batIdxKey] % slots.length]?.id], bases, outs, inning, batRuns, fieldRuns);
    const atBat = ibb ? { type: 'walk', ibb: true } : simulateAtBat(activeBatter, pitcher, bases, outs, players, fieldMod,
      { inning, isSpring, norms: gs.norms, pitcherTired, relief: shortStint, mgr,
        scoutHit: gs.scout ? (isUserBatting ? gs.scout.bat : gs.scout.pitch) : 1,
        hrMod: gs.env?.hrMod, hitEnv: gs.env?.hitMod, walkMod: gs.env?.walkMod });
    // Increment the THROWING pitcher's batters-faced count. When the user is
    // batting the opponent is pitching (and vice-versa) — this must match the
    // fatigue check below, which reads the same throwing-pitcher counter.
    gs[isUserBatting ? 'oppPitchCount' : 'userPitchCount']++;

    // r205 §122.83 the ball in play goes to a fielder: hit or out, an error, the arms
    let fieldedAB = _fielders ? _fieldPlay(atBat, isUserBatting) : atBat;
    // r227 §122.106 a caught fly's spot first (its own stream, as r226): how deep it was decides the tag-ups
    const ballKey = `${halfKey}|${plays.length}|${activeBatter.id}`;
    if (fieldedAB.type === 'flyout' && !fieldedAB.error) fieldedAB = { ...fieldedAB, _pre: _placeBall(fieldedAB, 'flyout', dice(_ballKey || 'game', 'ball', ballKey)) };
    let { newBases, runsScored, runnerIds, extraOuts, playMod, thrownOut } =
      _advanceBases(bases, fieldedAB, activeBatter, players, outs);
    bases = newBases;

    // Walk-off (home half, 9th+): the game ends the instant the winning run
    // scores. On anything but a home run only the runs needed to win count
    // (official scoring rule); the remaining runners are simply stranded.
    if (halfRuns + runsScored >= walkoffRuns) {
      walkedOff = true;
      if (atBat.type !== 'hr') {
        const needed = Math.max(0, walkoffRuns - halfRuns);
        runsScored = needed;
        runnerIds  = runnerIds.slice(0, needed);
      }
    }
    halfRuns += runsScored;

    const effectiveType = playMod || fieldedAB.type;
    // Runs that scored on the play vs the batter's official RBI: no RBI when
    // he grounds into a double play or the run scores on an error.
    const rbi           = (effectiveType === 'double_play' || effectiveType === 'error') ? 0 : runsScored;
    const isScoring     = runsScored > 0;
    const isBigPlay     = atBat.type === 'hr'
      || rbi >= 3
      || (isScoring && Math.abs((gs.userScore + (isUserBatting ? runsScored : 0)) -
                                 (gs.oppScore  + (isUserBatting ? 0 : runsScored))) <= 1);

    // Errors and fielder's choice: batter reaches safely (no out on batter)
    const batterIsOut = effectiveType !== 'error'
      && effectiveType !== 'fielders_choice'
      && _isOut(fieldedAB.type);
    const outsBefore = outs;
    if (batterIsOut) outs++;
    if (extraOuts > 0) outs = Math.min(3, outs + extraOuts);

    const deltas = _buildStatDeltas(fieldedAB, activeBatter, pitcher, rbi, runsScored,
      runnerIds, effectiveType, outs - outsBefore);
    // r205 §122.83 the fielder's record: an error, a hit taken away, a hit let through
    const fd = fieldedAB.fielder;
    if (fd) {
      const add = (stat) => (deltas[fd.id] ||= []).push({ stat, delta: 1 });
      if (effectiveType === 'error') add('e');
      if (fieldedAB.conv === 'save') add('dSave');
      if (fieldedAB.conv === 'cost') add('dCost');
    }

    plays.push({
      playIndex:    0,
      _halfInning:  halfKey,
      inning:       parseInt(halfKey.split('_')[1]) || 1,
      half:         halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
      batterId:     activeBatter.id,
      pitcherId:    pitcher.id,
      type:         effectiveType,
      description:  _buildDescription(fieldedAB, activeBatter, pitcher, playMod, { rbi, runs: runsScored, thrownOut, players }),
      ...(fd ? { _fielderId: fd.id } : {}),
      ...(_ballOf(fieldedAB, effectiveType, ballKey, pitcher, thrownOut)),   // r226 §122.105
      runs:         runsScored,
      rbi,
      isScoring,
      isBigPlay,
      outsAfter:    outs,
      // The half is over on the third out: the runners are stranded, not on base.
      _basesAfter:  outs >= 3 ? { first: null, second: null, third: null } : { ...bases },
      cumOurScore:   0,
      cumTheirScore: 0,
      _timestamp:   0,
      _statDeltas:  deltas,
    });

    // (Pitcher fatigue is evaluated per-inning in _simulateFullGame, keyed to
    // innings pitched rather than batters faced so the hook is independent of
    // how much offense a given game produces.)

    // §118 an injury on the play: the batter leaves the game.
    if (gs.injuryYear != null && !walkedOff) {
      bases = _batterHurt(gs, players, plays, slots, bench, slotIdx, activeBatter, pitcher, outs, bases, halfKey);
    }
  }

  // Inning end play
  plays.push({
    playIndex:    0,
    _halfInning:  halfKey,
    inning:       parseInt(halfKey.split('_')[1]) || 1,
    half:         halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
    batterId:     null,
    pitcherId:    pitcher?.id || null,
    type:         'inning_end',
    description:  `End of ${halfKey.startsWith('TOP') ? 'top' : 'bottom'} ${parseInt(halfKey.split('_')[1])}`,
    rbi:          0,
    isScoring:    false,
    isBigPlay:    false,
    outsAfter:    walkedOff ? outs : 3,
    _walkoff:     walkedOff || undefined,
    _basesAfter:  { first: null, second: null, third: null },
    cumOurScore:   0,
    cumTheirScore: 0,
    _timestamp:   0,
    _statDeltas:  {},
  });

  return plays;
}

/**
 * leagueNorms(teams, players)
 * The league's current average active hitter (contact / power / speed — the
 * nine in every lineup) and active pitcher (stuff / control — every rotation
 * and bullpen arm), from effective sub-ratings. Pure; GameEngine computes it
 * when a game starts and passes it in as context.norms.
 *
 * @param {Object[]} teams   — user team + league teams
 * @param {Object}   players — registry
 * @returns {{ contact, power, speed, stuff, control }}
 */
/**
 * liveSituation(revealed, nextPlay)
 * The on-field situation after the last revealed play — the single derivation
 * behind every live diamond (the user's game and the league viewer).
 *   - inning/half: from the last play that carries them (not game_end)
 *   - outs/bases:  from the last play's outsAfter / _basesAfter
 *   - once the third out is revealed the half is over: the next half is shown
 *     with 0 outs and empty bases — unless the game ends instead.
 * @param {Object[]} revealed — plays revealed so far, in order
 * @param {Object|null} nextPlay — the first unrevealed play, if any
 * @returns {{ inning, half, outs, bases, final }}
 */
export function liveSituation(revealed, nextPlay = null) {
  const EMPTY = { first: null, second: null, third: null };
  let inning = 1, half = 'TOP', outs = 0, bases = EMPTY;
  for (let i = revealed.length - 1; i >= 0; i--) {
    const p = revealed[i];
    if (p.inning && p.half && p.type !== 'game_end') { inning = p.inning; half = p.half; break; }
  }
  for (let i = revealed.length - 1; i >= 0; i--) {
    if (Number.isFinite(revealed[i].outsAfter)) { outs = revealed[i].outsAfter; break; }
  }
  for (let i = revealed.length - 1; i >= 0; i--) {
    if (revealed[i]._basesAfter) { bases = revealed[i]._basesAfter; break; }
  }
  const final = revealed.some(p => p.type === 'game_end');
  if (outs >= 3) {
    bases = EMPTY;
    if (!final && nextPlay?.type !== 'game_end') {
      if (half === 'TOP') half = 'BOT'; else { half = 'TOP'; inning += 1; }
    }
    outs = final || nextPlay?.type === 'game_end' ? 3 : 0;
  }
  return { inning, half, outs, bases: { ...EMPTY, ...bases }, final };
}

// Innings a pitcher counts for in the league norms before he has thrown any.
const NORM_PITCHER_PRIOR_IP = Object.freeze({
  [PLAYER_GROUP.STARTING_PITCHERS]: 30, [PLAYER_GROUP.BULLPEN]: 10, [PLAYER_GROUP.PITCHER_BENCH]: 5,
});

export function leagueNorms(teams, players) {
  const sum = { contact: 0, power: 0, speed: 0, stuff: 0, control: 0, defense: 0 };
  let nh = 0, np = 0, nd = 0;
  const dBy = {}, nBy = {};   // r205 §122.83 the glove by position
  const ok = (p) => p && isAvailable(p);
  for (const t of teams || []) {
    for (const sl of t.lineupSlots || []) {
      const p = players[sl.playerId];
      if (!ok(p)) continue;
      sum.contact += _effectiveSR(p, 'contact', playingRating(p, 'contact'), { coached: false });
      sum.power   += _effectiveSR(p, 'power',   playingRating(p, 'power'), { coached: false });
      sum.speed   += _effectiveSR(p, 'speed',   playingRating(p, 'speed'), { coached: false });
      nh++;
      // r205 §122.83 the league's glove: its fielders' (not the DHs'), at their own positions
      if (sl.slot !== 'DH' && p.subRatings?.defense != null) {
        const g = _effectiveSR(p, 'defense', playingRating(p, 'defense'), { coached: false });
        sum.defense += g; nd++;
        dBy[sl.slot] = (dBy[sl.slot] || 0) + g; nBy[sl.slot] = (nBy[sl.slot] || 0) + 1;
      }
    }
    // Pitchers: the league average a batter FACES — weighted by the innings
    // each arm actually throws (§76: the manager's best relievers pitch more
    // than the last man in the pen). Before a pitcher has innings, his role's
    // usual share stands in.
    for (const id of t.rosterIds || []) {
      const p = players[id];
      const prior = NORM_PITCHER_PRIOR_IP[p?.group];
      if (!ok(p) || prior == null) continue;
      const w = (p.stats?.ip || 0) + prior;
      sum.stuff   += w * _effectiveSR(p, 'stuff',   playingRating(p, 'stuff'), { coached: false });
      sum.control += w * _effectiveSR(p, 'control', playingRating(p, 'control'), { coached: false });
      np += w;
    }
  }
  if (!nh || !np) return null;
  return {
    contact: sum.contact / nh, power: sum.power / nh, speed: sum.speed / nh,
    stuff:   sum.stuff / np,   control: sum.control / np,
    ...(nd ? { defense: sum.defense / nd, defenseBy: Object.fromEntries(Object.keys(dBy).map(k => [k, dBy[k] / nBy[k]])) } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// AT-BAT RESOLUTION — all sub-rating → outcome mappings
// ─────────────────────────────────────────────────────────────

/**
 * simulateAtBat(batter, pitcher, bases, outs, players, fieldMod?)
 * Resolves a single plate appearance using full sub-rating mappings.
 * This is the single function where individual sub-ratings drive outcomes.
 *
 * @param {Object} batter
 * @param {Object} pitcher
 * @param {Object} bases    — { first, second, third }
 * @param {Number} outs     — current outs
 * @param {Object} players  — full registry (for runner speed lookups)
 * @param {Number} fieldMod — field condition modifier (0.9–1.1)
 * @returns {Object} { type, subType? }
 */
export function simulateAtBat(batter, pitcher, bases, outs, players, fieldMod = 1.0, context = {}) {
  const { inning = 1, isSpring = false } = context;
  // §122.9 the games play the truth (an untested player's estimate may be off).
  const sr  = trueRatings(batter);
  const psr = trueRatings(pitcher);

  // Apply injury penalty if active
  const mb = context.mgr?.bat || 0, mp = context.mgr?.pitch || 0;   // §122.64 the managers, late and close
  const contact  = _effectiveSR(batter,  'contact',  sr.contact) + mb;
  const power    = _effectiveSR(batter,  'power',    sr.power) + mb;
  const speed    = _effectiveSR(batter,  'speed',    sr.speed);
  const stuff    = _effectiveSR(pitcher, 'stuff',    psr.stuff) + mp + (context.relief?.stuff || 0);      // r167 short stint
  const control  = _effectiveSR(pitcher, 'control',  psr.control) + mp + (context.relief?.control || 0);

  // ── Sacrifice bunt check ──────────────────────────────────────
  // Eligible when: low-power batter, runner(s) on, < 2 outs, late inning
  const hasRunners = bases.first || bases.second;
  if (
    !isSpring &&
    outs < 2 &&
    hasRunners &&
    inning >= SIM_SAC_BUNT_INNING_MIN &&
    power <= SIM_SAC_BUNT_POWER_MAX &&
    _roll() < SIM_SAC_BUNT_PROB
  ) {
    // Sac bunt: 85% success (batter out, runners advance), 15% fielded for DP
    if (_roll() < 0.85) {
      return { type: 'sac_bunt', subType: 'success' };
    } else {
      return { type: 'sac_bunt', subType: 'fail' }; // treated as groundout with DP chance
    }
  }

  // gmRelationship variance
  const batterMod  = _gmRelVariance(batter.gmRelationship);
  const pitcherMod = _gmRelVariance(pitcher.gmRelationship);

  // Pitcher fatigue modifiers (multipliers on the pitcher-driven rates, §7.4):
  // the simulation says when he's tired (context.pitcherTired, §76).
  const fatigueFlag    = !!context.pitcherTired;
  const fatigueHitMod  = fatigueFlag ? (1 + SIM_P_FATIGUE_HIT_QUALITY_BONUS) : 1;
  const fatigueKMod    = fatigueFlag ? (1 - SIM_P_FATIGUE_K_PENALTY)        : 1;
  const fatigueWalkMod = fatigueFlag ? (1 + SIM_P_FATIGUE_WALK_BONUS)       : 1;

  // Offense environment: field condition × weather (temperature, wind, rain).
  // It moves hit probability inside the at-bat, so the plays ARE the score —
  // nothing is rescaled after the game (§60).
  const envMod = fieldMod;

  // Rating gaps from the league average (§60 plate-appearance model). The
  // average is the CURRENT league's (§65, leagueNorms): baseball rates are
  // relative to the league. Injuries, call-ups and aging move every team's
  // talent, and a club full of replacement players does worse than the
  // others — but the league's run environment stays where baseball is.
  // Without norms (tests, previews) the fixed SIM_RATING_AVG is used.
  const N  = context.norms || {};
  const r = _roll();

  const R = plateAppearanceRates({ contact, power, speed, stuff, control }, N, {
    walk: [fatigueWalkMod, pitcherMod, context.walkMod ?? 1],   // §102.2 a wet or cold ball
    k:    [fatigueKMod, pitcherMod, batterMod],
    hit:  [fatigueHitMod, batterMod, envMod, context.scoutHit ?? 1],   // §90 advance scouting: our hitters know what's coming
    hr:   [context.hrMod != null ? context.hrMod * (envMod / (context.hitEnv ?? envMod)) : envMod],   // §102.2 temperature and wind carry the ball
  });

  // 1. Walk — control below average → more walks
  if (r < R.walk) return { type: 'walk' };
  let pos = R.walk;

  // 2. HBP
  if (r < pos + R.hbp) return { type: 'hbp' };
  pos += R.hbp;

  // 3. Strikeout — stuff vs contact
  if (r < pos + R.k) return { type: 'strikeout' };
  pos += R.k;

  // 4. Hit vs out — contact vs stuff, plus speed-driven infield hits
  if (r >= pos + R.hit) {
    // Out — groundout vs flyout split
    const groundoutProb = 0.55; // slight groundout lean
    return { type: _roll() < groundoutProb ? 'groundout' : 'flyout' };
  }

  // 5. Hit type: HR / triple / double / single — power sets the extra-base share
  const hrShare = R.hrShare, tripleShare = R.tripleShare, xbhShare = R.xbhShare;

  const hitRoll = _roll();
  if (hitRoll < hrShare)                          return { type: 'hr' };
  if (hitRoll < hrShare + tripleShare)            return { type: 'triple' };
  if (hitRoll < hrShare + tripleShare + xbhShare) return { type: 'double' };
  return { type: 'single' };
}

/**
 * plateAppearanceRates(ratings, norms?, mods?)
 * The plate-appearance model's probabilities (§60), shared by simulateAtBat
 * and anything that needs a player's expected line without playing a game
 * (§122.9 the league's past). Pure: no rolls.
 *   ratings — { contact, power, speed, stuff, control } (effective values)
 *   norms   — the league's averages (leagueNorms); SIM_RATING_AVG without
 *   mods    — { walk, k, hit, hr }: lists of multipliers, applied in order
 * @returns {{ walk, hbp, k, hit, hrShare, tripleShare, xbhShare }}
 *   (each step's probability, in the order simulateAtBat tests them; `hit` is
 *    the chance of a hit including infield hits; the shares split the hits)
 */
export function plateAppearanceRates({ contact, power, speed, stuff, control }, N = {}, mods = {}) {
  const mul = (x, fs) => (fs || []).reduce((a, f) => a * f, x);
  const A  = SIM_RATING_AVG;
  const Ac = N.contact ?? A, Ap = N.power ?? A, As = N.speed ?? A;
  const Ast = N.stuff ?? A, Act = N.control ?? A;

  const walk = mul(_clamp(SIM_PA_WALK_BASE + (Act - control) * SIM_PA_WALK_PER_PT,
                          SIM_PA_WALK_MIN, SIM_PA_WALK_MAX), mods.walk);
  const hbp  = control < SIM_P_CONTROL_HBP_THRESHOLD ? 0.012 : 0.008;
  const k    = mul(_clamp(SIM_PA_K_BASE
                          + (Ac - contact) * SIM_PA_K_PER_CONTACT_PT
                          + (stuff - Ast)  * SIM_PA_K_PER_STUFF_PT,
                          SIM_PA_K_MIN, SIM_PA_K_MAX), mods.k);
  const hitProb = mul(_clamp(SIM_PA_HIT_BASE
                             + (contact - Ac) * SIM_PA_HIT_PER_CONTACT_PT
                             - (stuff - Ast)  * SIM_PA_HIT_PER_STUFF_PT,
                             SIM_PA_HIT_MIN, SIM_PA_HIT_MAX), mods.hit);
  const infieldBonus = Math.max(0, (speed - As) * SIM_PA_INFIELD_HIT_PER_SPEED_PT);
  const hit = Math.min(0.45, hitProb + infieldBonus);

  const hrShare  = mul(_clamp(SIM_HIT_HR_SHARE_BASE + (power - Ap) * SIM_HIT_HR_SHARE_PER_PT,
                              SIM_HIT_HR_SHARE_MIN, SIM_HIT_HR_SHARE_MAX), mods.hr);
  const xbhShare = _clamp(SIM_HIT_XBH_SHARE_BASE + (power - Ap) * SIM_HIT_XBH_SHARE_PER_PT,
                          SIM_HIT_XBH_SHARE_MIN, SIM_HIT_XBH_SHARE_MAX);
  const tripleShare = SIM_HIT_TRIPLE_SHARE * _clamp(speed / As, 0.5, 1.8);
  return { walk, hbp, k, hit, hrShare, tripleShare, xbhShare };
}

// ─────────────────────────────────────────────────────────────
// BASE ADVANCEMENT
// ─────────────────────────────────────────────────────────────

/**
 * _advanceBases(bases, atBat, batter, players, outs)
 * Full runner advancement model with throw-out probabilities,
 * double plays, fielder's choice, and sac fly/bunt handling.
 *
 * Returns:
 *   newBases    — base state after the play
 *   runsScored  — number of runs scored
 *   runnerIds   — IDs of players who scored (for R stat)
 *   extraOuts   — additional outs beyond the primary batter out (e.g. DP = 1 extra)
 *   playMod     — override play type for display (e.g. 'fielders_choice', 'sac_fly')
 */
/**
 * r227 §122.106 the chance a runner on third is sent home on a caught outfield fly (TAG_UP.home): how deep (feet), the
 * runner's speed, the batting club's running game (STRATEGY.run[…]). Exported for the checks.
 */
export function tagSendChance(dist, speed, run = null) {
  const pts = TAG_UP.home.send;
  let v = pts[pts.length - 1][1];
  if (dist <= pts[0][0]) v = pts[0][1];
  else for (let i = 1; i < pts.length; i++) if (dist <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; v = va + (vb - va) * (dist - a) / (b - a); break; }
  return Math.max(0, Math.min(1, v + TAG_UP.home.sendPerSpeed * ((speed || 50) - 50) + (run?.tagSend || 0)));
}

/** r228 §122.107 a runner who isn't forced moves up on a groundout (GROUND_ADV): by where it was fielded, speed, the running game. */
function _groundAdv(to, atBat, runnerId, players) {
  const at = atBat.at && GROUND_ADV[to][atBat.at] != null ? atBat.at : 'SS';
  const spd = _effectiveSR(players[runnerId], 'speed', playingRating(players[runnerId], 'speed')) || 50;
  const p = GROUND_ADV[to][at] + GROUND_ADV[`${to}PerSpeed`] * (spd - 50) + (_runBat?.tagSend || 0);
  return _roll() < Math.max(0, Math.min(1, p));
}

function _advanceBases(bases, atBat, batter, players, outs = 0) {
  const speed = _effectiveSR(batter, 'speed', playingRating(batter, 'speed'));
  let newBases   = { first: bases.first, second: bases.second, third: bases.third };
  let runsScored = 0;
  const runnerIds = [];
  let extraOuts  = 0;
  let playMod    = null; // override play type if needed

  // Helper: probability of being thrown out based on runner speed (r205 §122.83 and the fielder's arm)
  const arm = atBat.armMult || 1;
  const throwoutProb = (baseProb, runnerSpeed) =>
    Math.max(0.05, baseProb - (runnerSpeed / SIM_SPEED_THROWOUT_DIVISOR)) * arm;
  let thrownOut = null;   // r205 a runner thrown out on the play: { id, at }

  switch (atBat.type) {

    // ── HOME RUN — everyone scores, no advancement complexity ──
    case 'hr':
      runsScored = 1 + (bases.first ? 1 : 0) + (bases.second ? 1 : 0) + (bases.third ? 1 : 0);
      if (bases.first)  runnerIds.push(bases.first);
      if (bases.second) runnerIds.push(bases.second);
      if (bases.third)  runnerIds.push(bases.third);
      newBases = { first: null, second: null, third: null };
      break;

    // ── TRIPLE — all runners score ──────────────────────────────
    case 'triple':
      if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
      if (bases.second) { runsScored++; runnerIds.push(bases.second); }
      if (bases.first)  { runsScored++; runnerIds.push(bases.first); }
      newBases = { first: null, second: null, third: batter.id };
      break;

    // ── DOUBLE ──────────────────────────────────────────────────
    case 'double': {
      // Third always scores
      if (bases.third) { runsScored++; runnerIds.push(bases.third); newBases.third = null; }
      // Second always scores
      if (bases.second) { runsScored++; runnerIds.push(bases.second); newBases.second = null; }
      // First: tries to score — throw-out check based on speed
      if (bases.first) {
        const runner = players[bases.first];
        const rs     = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
        if (rs >= SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD) {
          if (_roll() < throwoutProb(SIM_THROWOUT_PLATE_BASE, rs)) {
            // Thrown out at plate — runner out, batter ends on second
            newBases = { first: null, second: batter.id, third: null };
            thrownOut = { id: bases.first, at: 'home' };
            extraOuts++;
            playMod = 'double'; // still a double, just runner thrown out
          } else {
            runsScored++;
            runnerIds.push(bases.first);
            newBases = { first: null, second: null, third: null };
          }
        } else {
          // Runner stops at third
          newBases = { first: null, second: batter.id, third: bases.first };
        }
      } else {
        newBases = { first: null, second: batter.id, third: newBases.third };
      }
      break;
    }

    // ── SINGLE ──────────────────────────────────────────────────
    case 'single': {
      // Third always scores on a single
      if (bases.third) { runsScored++; runnerIds.push(bases.third); newBases.third = null; }

      // Second: tries to score — throw-out check
      if (bases.second) {
        const runner = players[bases.second];
        const rs     = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
        if (_roll() < throwoutProb(SIM_THROWOUT_PLATE_BASE, rs)) {
          extraOuts++;         // thrown out at plate
          thrownOut = { id: bases.second, at: 'home' };
          newBases.second = null;
        } else {
          runsScored++;
          runnerIds.push(bases.second);
          newBases.second = null;
        }
      }

      // First: advances to second (normal) or tries for third (fast runner)
      if (bases.first) {
        const runner = players[bases.first];
        const rs     = _effectiveSR(runner, 'speed', playingRating(runner, 'speed')) || 50;
        if (rs >= SIM_H_SPEED_STRETCH_THRESHOLD) {
          // Tries for third — throw-out check
          if (_roll() < throwoutProb(SIM_THROWOUT_EXTRA_BASE, rs)) {
            extraOuts++;         // thrown out at third
            thrownOut = thrownOut || { id: bases.first, at: 'third' };
            newBases.first = batter.id;
          } else {
            newBases.third  = runner ? bases.first : null;
            newBases.second = null;
            newBases.first  = batter.id;
          }
        } else {
          newBases.second = bases.first;
          newBases.first  = batter.id;
        }
      } else {
        newBases.first = batter.id;
      }
      break;
    }

    // ── WALK / HBP — force advance, no outs ─────────────────────
    case 'walk':
    case 'hbp':
      if (bases.third && bases.second && bases.first) {
        runsScored++;
        runnerIds.push(bases.third);
        newBases = { first: batter.id, second: bases.first, third: bases.second };
      } else if (bases.second && bases.first) {
        newBases = { first: batter.id, second: bases.first, third: bases.second };
      } else if (bases.first) {
        newBases = { first: batter.id, second: bases.first, third: bases.third };
      } else {
        newBases = { first: batter.id, second: bases.second, third: bases.third };
      }
      break;

    // ── GROUNDOUT ────────────────────────────────────────────────
    case 'groundout': {
      // Possible paths:
      //   1. Error (batter reaches, no out on batter)
      //   2. Fielder's choice (lead runner out, batter reaches)
      //   3. Double play (batter out + lead runner out)
      //   4. Standard groundout (batter out, runners advance one base)

      const hasFirst  = !!bases.first;

      // Error check — before anything else (r205 §122.83 decided by the fielder, _fieldPlay; else the old rate)
      if (atBat.fielded ? !!atBat.error : _roll() < SIM_ERROR_PROB * (_userFielding && _staff ? _staff.errorMult : 1) * (_fieldDef?.errorMult || 1)) {   // r165 fielders out of position
        playMod = 'error';
        // Batter reaches first (no out charged)
        // Runners advance one base
        if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
        newBases = {
          first:  batter.id,
          second: bases.first  || null,
          third:  bases.second || null,
        };
        // extraOuts = 0, batter not out — signal via playMod
        break;
      }

      if (hasFirst && outs < 2) {
        if (_roll() < SIM_DP_PROB * (atBat.dpMult || 1)) {   // r205 the middle infield turns it
          // Double play — batter out at first, lead runner out at second
          extraOuts = 1; // batter counts as primary out, this is the extra
          newBases = {
            first:  null,
            second: bases.second || null,
            third:  bases.third  || null,
          };
          // Runner on third scores if less than 2 outs already (before DP)
          if (bases.third && outs === 0) {
            runsScored++;
            runnerIds.push(bases.third);
            newBases.third = null;
          }
          playMod = 'double_play';
        } else if (_roll() < SIM_FC_PROB) {
          // Fielder's choice — the runner from first is forced out at second, the batter reaches first. The batter is
          // not out (playMod tells the half-inning loop), but the play records ONE out: the runner's. Runners ahead
          // move up on the force.
          playMod   = 'fielders_choice';
          extraOuts = 1;
          // r228 §122.107 the runner on third: forced home only with second taken too; otherwise by the grounder
          const r3home = bases.third && (bases.second || _groundAdv('home', atBat, bases.third, players));
          if (r3home) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  batter.id,
            second: null,
            third:  bases.second || (bases.third && !r3home ? bases.third : null),
          };
          break;
        } else {
          // Standard groundout — batter out at first, the forced runners move up a base; r228 §122.107 a runner on
          // third not forced (second open) scores by the grounder, or holds
          const r3home = bases.third && (bases.second || _groundAdv('home', atBat, bases.third, players));
          if (r3home) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  null,
            second: bases.first,
            third:  bases.second || (bases.third && !r3home ? bases.third : null),
          };
        }
      } else if (outs < 2) {
        // r228 §122.107 no one on first, nobody forced: the runner on third scores by the grounder (where it was
        // fielded, speed), or holds; then the runner on second takes an open third the same way, or holds
        newBases = { ...bases };
        if (bases.third && _groundAdv('home', atBat, bases.third, players)) {
          runsScored++; runnerIds.push(bases.third); newBases.third = null;
        }
        if (bases.second && !newBases.third && _groundAdv('third', atBat, bases.second, players)) {
          newBases.third = bases.second; newBases.second = null;
        }
      } else {
        // the third out: nobody moves
        newBases = { ...bases };
      }
      break;
    }

    // ── FLYOUT ───────────────────────────────────────────────────
    case 'flyout': {
      // r205 §122.83 dropped: the batter reaches, the runners move up a base
      if (atBat.error) {
        playMod = 'error';
        if (bases.third) { runsScored++; runnerIds.push(bases.third); }
        newBases = { first: batter.id, second: bases.first || null, third: bases.second || null };
        break;
      }
      // r227 §122.106 tag-ups after the catch (TAG_UP): none on the inning's third out, none on an infield pop; by how
      // deep it was caught, the runner's speed, the batting club's running game, and the outfielder's arm.
      const ball = atBat._pre;
      if (outs >= 2 || !ball || !['LF', 'CF', 'RF'].includes(ball.at)) break;
      const run = _runBat || {};
      const spd = (id) => _effectiveSR(players[id], 'speed', playingRating(players[id], 'speed')) || 50;
      const p01 = (x) => Math.max(0, Math.min(1, x));
      const along = (pts, x) => {
        if (x <= pts[0][0]) return pts[0][1];
        for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * (x - a) / (b - a); }
        return pts[pts.length - 1][1];
      };
      const sendMod = run.tagSend || 0, outMod = (run.tagOut || 1) * arm;   // (tagSendChance: the same, exported)
      const caught = outs + 1;   // (the catch is an out)
      // third to home: a sacrifice fly, or thrown out at the plate
      if (bases.third) {
        const H = TAG_UP.home, s3 = spd(bases.third);
        if (_roll() < tagSendChance(ball.dist, s3, run)) {
          const safe = 1 - (1 - p01(along(H.safe, ball.dist) + H.safePerSpeed * (s3 - 50))) * outMod;
          if (_roll() < safe) { runsScored++; runnerIds.push(bases.third); newBases.third = null; playMod = 'sac_fly'; }
          else { extraOuts++; thrownOut = { id: bases.third, at: 'home' }; newBases.third = null; }
        }
      }
      // second to third: only to an open third, while the inning goes on
      if (bases.second && !newBases.third && caught + extraOuts < 3) {
        const T = TAG_UP.third, s2 = spd(bases.second);
        const depth = Math.max(0, Math.min(1.6, 1 + (ball.dist - T.atDist) * T.perFoot));
        if (_roll() < p01(T.field[ball.at] * depth + T.sendPerSpeed * (s2 - 50) + sendMod)) {
          if (_roll() < p01(T.out - T.outPerSpeed * (s2 - 50)) * outMod) { extraOuts++; thrownOut = thrownOut || { id: bases.second, at: 'third' }; newBases.second = null; }
          else { newBases.third = bases.second; newBases.second = null; }
        }
      }
      // first to second: only on the deepest
      if (bases.first && !newBases.second && caught + extraOuts < 3 && ball.dist >= fenceAt(ball.angle) - TAG_UP.second.fromFence) {
        const F = TAG_UP.second, s1 = spd(bases.first);
        if (_roll() < p01(F.send + F.sendPerSpeed * (s1 - 50) + sendMod)) {
          if (_roll() < p01(F.out - F.outPerSpeed * (s1 - 50)) * outMod) { extraOuts++; thrownOut = thrownOut || { id: bases.first, at: 'second' }; newBases.first = null; }
          else { newBases.second = bases.first; newBases.first = null; }
        }
      }
      break;
    }

    // ── SAC BUNT ─────────────────────────────────────────────────
    case 'sac_bunt': {
      if (atBat.subType === 'success') {
        // Batter out, all runners advance one base
        if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
        newBases = {
          first:  null,
          second: bases.first  || null,
          third:  bases.second || null,
        };
        // Primary out = batter (handled by _isOut returning true for sac_bunt)
      } else {
        // Failed bunt — treated as a weak groundout with possible DP
        if (bases.first && outs < 2 && _roll() < SIM_DP_PROB * 0.6) {
          extraOuts = 1;
          newBases  = { first: null, second: bases.second || null, third: bases.third || null };
          playMod   = 'double_play';
        } else {
          newBases = { ...bases };
        }
      }
      break;
    }

    default:
      break;
  }

  return { newBases, runsScored, runnerIds, extraOuts, playMod, thrownOut };
}

// ─────────────────────────────────────────────────────────────
// STAT ACCUMULATION
// ─────────────────────────────────────────────────────────────

/**
 * accumulateStats(plays, userTeam, opponentTeam, players, isSpring)
 * Applies stat increments from the play array to player.stats or player.springStats.
 * Returns a mutations object: { players: { [id]: { stats: {...} } } }
 *
 * @param {Object[]} plays
 * @param {Object}   userTeam
 * @param {Object}   opponentTeam
 * @param {Object}   players
 * @param {Boolean}  isSpring
 * @returns {Object} mutations
 */
export function accumulateStats(plays, userTeam, opponentTeam, players, isSpring = false) {
  // 5th arg: a stat-line key ('stats' | 'springStats' | 'postseasonStats'),
  // or the legacy spring boolean.
  const statKey = typeof isSpring === 'string' ? isSpring : (isSpring ? 'springStats' : 'stats');
  const deltas  = {}; // { [playerId]: { [statField]: delta } }

  for (const play of plays) {
    // (A called game's plays that don't count — the score reverted — carry nothing. §102.2)
    if (!play._statDeltas || play._reverted || play.type === 'pinch_hit' || play.type === 'game_start') continue;
    // game_end plays carry W/L/SV/HD decision deltas — allow them through
    for (const [playerId, statList] of Object.entries(play._statDeltas)) {
      if (!deltas[playerId]) deltas[playerId] = {};
      for (const { stat, delta } of statList) {
        deltas[playerId][stat] = (deltas[playerId][stat] || 0) + delta;
      }
    }
  }

  // Starts: each side's starter is the first pitcher to face a batter in the
  // halves his side fields (TOP = the home side pitching). A quality start is
  // 6+ innings with 3 or fewer earned runs.
  const starterBy = {};
  for (const play of plays) {
    if (!play.pitcherId || play._reverted || !play._statDeltas?.[play.pitcherId] || (play.half !== 'TOP' && play.half !== 'BOT')) continue;
    if (!starterBy[play.half]) starterBy[play.half] = play.pitcherId;
    if (starterBy.TOP && starterBy.BOT) break;
  }
  for (const id of new Set(Object.values(starterBy))) {
    const d = deltas[id] || (deltas[id] = {});
    d.gs = (d.gs || 0) + 1;
    if (Math.round((d.ip || 0) * 3) >= 18 && (d.er || 0) <= 3) d.qs = (d.qs || 0) + 1;
  }

  // Build mutations
  const playerMutations = {};
  for (const [playerId, statDeltas] of Object.entries(deltas)) {
    const player = players[playerId];
    if (!player) continue;
    const currentStats = { ...(player[statKey] || {}) };
    for (const [stat, delta] of Object.entries(statDeltas)) {
      currentStats[stat] = (currentStats[stat] || 0) + delta;
    }
    // Increment games played on first appearance
    if (!playerMutations[playerId]) {
      currentStats.g = (currentStats.g || 0) + 1;
    }
    playerMutations[playerId] = { [statKey]: currentStats };
  }

  return { players: playerMutations };
}

// ─────────────────────────────────────────────────────────────
// SHARED BOX-SCORE ACCUMULATOR
// ─────────────────────────────────────────────────────────────

/**
 * accumulateBox(plays, players, opts)
 * The SINGLE source of truth for box scores. Consumes each play's `_statDeltas`
 * — the same data season stats use (accumulateStats) — so the live box, the
 * committed box, and season totals can never drift.
 *
 * Team-agnostic: produces away/home boxes (TOP = away batting). The caller maps
 * user<->home via opts.userIsHome. Runs are read from the runners' `r` deltas
 * (correct even when no RBI is credited) and pitcher innings are counted as
 * integer outs (no 0.333 float drift). Output is self-contained (names/pos
 * snapshotted) so it survives play-stripping at commit.
 *
 * @param {Object[]} plays                          revealed subset (live) or full array (commit)
 * @param {Object}   players                        state.players
 * @param {Object}   opts  { awayOrder:[id], homeOrder:[id], userIsHome:bool }
 *                         awayOrder/homeOrder seed the full 9-man hitter order (0/0 until they bat)
 * @returns {Object} { linescore, away, home, userIsHome }
 */
export function accumulateBox(plays, players, opts = {}) {
  const { awayOrder = [], homeOrder = [], userIsHome = false, homeIds = null } = opts;
  // Which side a player is on: the explicit home roster when given (every
  // game type, incl. CPU vs CPU — §66), else the user/opponent convention.
  const homeSet = homeIds ? new Set(homeIds) : null;
  const sideFor = (pid, home, away) => homeSet
    ? (homeSet.has(pid) ? home : away)
    : (((players[pid]?.teamId === 'user') === userIsHome) ? home : away);

  const HIT0 = () => ({ ab:0, r:0, h:0, doubles:0, hr:0, tb:0, rbi:0, bb:0, hbp:0, k:0, sb:0, cs:0, sf:0, sac:0 });
  const PIT0 = () => ({ outs:0, h:0, hr:0, bb:0, k:0, er:0, w:0, l:0, sv:0, hld:0, bs:0 });
  const mkSide = () => ({ hit:{}, pit:{}, hitSeen:[], pitSeen:[] });

  const away = mkSide();
  const home = mkSide();
  const linescore = {};
  const hurt = new Set();   // §118 left the game hurt (a box score notes it)

  const ensureHit = (side, id) => { if (!side.hit[id]) { side.hit[id] = HIT0(); side.hitSeen.push(id); } return side.hit[id]; };
  const ensurePit = (side, id) => { if (!side.pit[id]) { side.pit[id] = PIT0(); side.pitSeen.push(id); } return side.pit[id]; };

  // §102.2 once a called game is over, the plays that don't count (its score
  // reverted to the last complete inning) drop out — live, they showed as played.
  const over = (plays || []).some(p => p.type === 'game_end');
  for (const play of (plays || [])) {
    if (over && play._reverted) continue;
    // A pitching change carries the incoming pitcher but no stat deltas — register
    // them on their side immediately so they appear in the box the instant they
    // enter (previously they surfaced only when they faced their first batter).
    if (play.type === 'pitching_change' && play.pitcherId) {
      const pid  = play.pitcherId;
      const side = sideFor(pid, home, away);
      ensurePit(side, pid);
      continue;
    }
    // §118 the player who took a hurt hitter's place is in the box from that moment.
    if (play.type === 'injury' && play._injury) {
      hurt.add(play._injury.playerId);
      if (play._injury.subId) ensureHit(play.half === 'TOP' ? away : home, play._injury.subId);
      continue;
    }
    if (!play._statDeltas) continue;
    const isTop        = play.half === 'TOP';
    const battingSide  = isTop ? away : home;   // TOP = away bats
    const fieldingSide = isTop ? home : away;

    // r205 §122.83 an error counts against the side in the field (the fielder's own line isn't a hitter's)
    if (play.type === 'error') fieldingSide.errors = (fieldingSide.errors || 0) + 1;
    for (const [pid, statList] of Object.entries(play._statDeltas)) {
      if (play._fielderId === pid && pid !== play.batterId) continue;   // (the fielder's e / dSave / dCost: the season's stats, not the box)
      const isPitcher = (play.pitcherId && pid === play.pitcherId) || play.type === 'game_end';

      if (isPitcher) {
        // game_end decision deltas belong to a pitcher who already appeared —
        // route to whichever side already holds them (fall back to teamId).
        let side = fieldingSide;
        if (play.type === 'game_end') {
          side = away.pit[pid] ? away
               : home.pit[pid] ? home
               : sideFor(pid, home, away);
        }
        const line = ensurePit(side, pid);
        for (const { stat, delta } of statList) {
          if      (stat === 'ip')          line.outs += Math.max(1, Math.round((delta || 0) / 0.333));
          else if (stat === 'h_allowed')   line.h   += delta;
          else if (stat === 'hr_allowed')  line.hr  += delta;
          else if (stat === 'er')          line.er  += delta;
          else if (stat === 'bb')          line.bb  += delta;
          else if (stat === 'k')           line.k   += delta;
          else if (stat === 'w')           line.w   += delta;
          else if (stat === 'l')           line.l   += delta;
          else if (stat === 'sv')          line.sv  += delta;
          else if (stat === 'hld')         line.hld += delta;
          else if (stat === 'bs')          line.bs  += delta;
        }
      } else {
        const line = ensureHit(battingSide, pid);
        for (const { stat, delta } of statList) {
          if (stat in line) line[stat] += delta;
          if (stat === 'r' && play.inning) {
            if (!linescore[play.inning]) linescore[play.inning] = { top:0, bot:0 };
            linescore[play.inning][isTop ? 'top' : 'bot'] += delta;
          }
        }
      }
    }
  }

  const ipFromOuts = (o) => `${Math.floor(o / 3)}.${o % 3}`;

  const finalizeSide = (side, seedOrder) => {
    const seen = new Set();
    const order = [];
    for (const id of seedOrder) { if (!seen.has(id)) { order.push(id); seen.add(id); } }        // full 9, even at 0/0
    for (const id of side.hitSeen) { if (!seen.has(id)) { order.push(id); seen.add(id); } }      // pinch hitters appended
    const hitters = order.map(id => {
      const s = side.hit[id] || HIT0();
      const p = players[id] || {};
      return { id, name: p.name || '—', pos: posLabel(p) || '', ...s, ...(hurt.has(id) ? { hurt: true } : {}) };
    });
    const pitchers = side.pitSeen.map(id => {
      const s = side.pit[id];
      const p = players[id] || {};
      const dec = s.w ? 'W' : s.l ? 'L' : s.sv ? 'S' : s.hld ? 'H' : s.bs ? 'BS' : null;
      return { id, name: p.name || '—', ip: ipFromOuts(s.outs), ipOuts: s.outs, h: s.h, er: s.er, bb: s.bb, k: s.k, hr: s.hr, dec, ...(hurt.has(id) ? { hurt: true } : {}) };
    });
    return {
      runs:   hitters.reduce((a, h) => a + h.r, 0),
      hits:   hitters.reduce((a, h) => a + h.h, 0),
      errors: side.errors || 0,   // r205 §122.83 the errors this side made in the field
      hitters,
      pitchers,
    };
  };

  return {
    linescore,
    away: finalizeSide(away, awayOrder),
    home: finalizeSide(home, homeOrder),
    userIsHome,
  };
}

// ─────────────────────────────────────────────────────────────
// BENCH SUBSTITUTION
// ─────────────────────────────────────────────────────────────

/**
 * _plannedSubstitution(slots, slotIdx, batter, players, inning)
 * §75 All-Star Game: each starter has a reserve paired with him (the squad's
 * plan, AllStarEngine.prepareForGame), who takes his place the first time the
 * spot comes up from the planned inning on — so every All-Star plays.
 */
function _plannedSubstitution(slots, slotIdx, batter, players, inning) {
  const slot = slots[slotIdx];
  if (!slot?.subIn || inning < (slot.subInning || 99)) return null;
  const sub = players[slot.subIn];
  if (!sub || !isAvailable(sub)) return null;
  slots[slotIdx] = { id: sub.id, subbed: false, sub: true };
  return {
    playIndex: 0, batterId: sub.id, pitcherId: null, type: 'pinch_hit', _for: batter?.id || null,   // (r229 whom)
    description: `${sub.name} pinch hits for ${batter?.name || 'the starter'}`,
    rbi: 0, isScoring: false, isBigPlay: false,
    cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: {},
  };
}

/**
 * _checkBenchSubstitution(slots, bench, slotIdx, batter, players,
 *                          inning, isSpring, userScore, oppScore, isUserBatting)
 *
 * Decides whether a bench hitter should pinch hit for the current batter.
 * Mutates slots[slotIdx].id in-place (permanent for rest of game) and
 * marks the bench player as used.
 *
 * Returns a pinch_hit play object if a substitution happens, null otherwise.
 *
 * Rules:
 *   Spring training (inning >= 5):
 *     - Each available bench player gets weighted consideration based on OVR.
 *     - Higher-rated bench players have higher probability of being chosen.
 *     - Probability per slot per inning: 30% base, scaled by relative OVR.
 *     - Ensures most bench hitters get 2-4 PA across a spring game.
 *
 *   Regular season (inning >= 7):
 *     - Only substitute if game is within 2 runs.
 *     - Only substitute if best available bench player OVR > starter OVR by 5+.
 *     - 20% base chance — keeps it situational, not every game.
 *
 *   Never substitutes:
 *     - CPU batters (only user team bench logic applied)
 *     - If no bench players are available (all used or empty bench)
 *     - If already past the point where subs make sense (extra innings)
 */
function _checkBenchSubstitution(slots, bench, slotIdx, batter, players,
  inning, isSpring, userScore, oppScore, isUserBatting) {

  // Only apply substitution logic to user team
  if (!isUserBatting) return null;

  // No bench available
  const availBench = bench.filter(b => !b.used);
  if (!availBench.length) return null;

  // Don't sub in extra innings — preserve lineup stability
  if (inning > 9) return null;

  // Don't sub out a player who is already a sub (bench player already in).
  // r137 §118: the slot says so — every active hitter carries BENCH_HITTERS
  // (lineupSlots decide who starts), so the group check never let anyone pinch-hit.
  const currentPlayer = players[slots[slotIdx].id];
  if (!currentPlayer) return null;
  if (slots[slotIdx].sub) return null;

  let shouldSub = false;
  let benchCandidate = null;

  if (isSpring) {
    // Spring training: start subs in inning 5+
    if (inning < 5) return null;

    // Weight by OVR: higher-rated bench players get higher base probability.
    // Each bench player contributes a weighted chance.
    // We pick one bench player (the highest available OVR) and compute their prob.
    benchCandidate = availBench[0]; // already sorted by OVR desc
    const benchOvr   = players[benchCandidate.id]?.ovr || 55;
    const starterOvr = currentPlayer.ovr || 55;

    // Base probability 30% in inning 5, scaling up each inning
    // +5% per inning beyond 5, +2% if bench player OVR > starter OVR
    const inningBonus = (inning - 5) * 0.05;
    const ovrBonus    = benchOvr > starterOvr ? 0.08 : 0;
    const prob        = Math.min(0.75, 0.30 + inningBonus + ovrBonus);
    shouldSub         = _roll() < prob;

  } else {
    // Regular season: inning 7+, close game, bench upgrade required
    if (inning < 7) return null;
    const runDiff = Math.abs(userScore - oppScore);
    if (runDiff > 2) return null;

    benchCandidate = availBench[0];
    const benchOvr   = players[benchCandidate.id]?.ovr || 55;
    const starterOvr = currentPlayer.ovr || 55;

    // Only pinch hit if bench player is meaningfully better
    if (benchOvr <= starterOvr + 4) return null;

    shouldSub = _roll() < 0.20;
  }

  if (!shouldSub || !benchCandidate) return null;

  // Execute the substitution — mutate lineup slot in place
  const starterName = currentPlayer.name || 'Batter';
  const subPlayer   = players[benchCandidate.id];
  const subName     = subPlayer?.name || 'Sub';

  slots[slotIdx]    = { id: benchCandidate.id, subbed: false, sub: true };
  benchCandidate.used = true;

  // Return a pinch_hit play — displayed in PBP, no stat deltas
  return {
    playIndex:    0,
    batterId:     benchCandidate.id,
    pitcherId:    null,
    type:         'pinch_hit',
    _for:         currentPlayer.id || null,   // r229 §122.108 whom (the Live View's batting order)
    description:  `${subName} pinch hits for ${starterName}`,
    rbi:          0,
    isScoring:    false,
    isBigPlay:    false,
    // outsAfter / _basesAfter are stamped by the caller from the live half-inning.
    cumOurScore:   0,
    cumTheirScore: 0,
    _timestamp:   0,
    _statDeltas:  {},
  };
}

// ─────────────────────────────────────────────────────────────
// INJURIES ON THE FIELD (§118)
// ─────────────────────────────────────────────────────────────

function _requireInjuryYear(context, exhibition, who) {
  if (!exhibition && !Number.isFinite(context?.injuryYear)) {
    throw new Error(`SimEngine.${who}: context.injuryYear (the season year, for injuries on the field) is required`);
  }
}

const _HURT_HITTER = [
  'pulled up on the play and left the game with the trainer',
  'was slow to get up after the play and left the game with the trainer',
  'came up hurt on the play and left the game',
];
const _HURT_PITCHER = [
  'called for the trainer after a pitch and left the game',
  'grimaced after a pitch and walked off with the trainer',
  'came out of the game after a visit from the trainer',
];

/** An injury play: who left, and (a hitter) who took the spot. Stamped like a substitution. */
function _injuryPlay(halfKey, fields) {
  return {
    playIndex: 0, _halfInning: halfKey,
    inning: parseInt(halfKey.split('_')[1]) || 1,
    half: halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
    type: 'injury', rbi: 0, runs: 0, isScoring: false, isBigPlay: false,
    cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: {},
    ...fields,
  };
}

/**
 * The batter who just batted gets hurt on the play: a bench player takes the
 * spot in the order (one at the same position if there is one) and, if the
 * batter is on base, runs for them. With nobody left on the bench the batter
 * stays in (no injury). Returns the bases.
 */
function _batterHurt(gs, players, plays, slots, bench, slotIdx, batter, pitcher, outs, bases, halfKey) {
  if (gs.hurt.has(batter.id)) return bases;
  if (_roll() >= injuryChancePerExposure(batter, 'hitter', gs.injuryYear, (batter?.wear || 0) >= WEAR.tired)) return bases;   // r159 worn down: likelier hurt
  const inGame = new Set(slots.map(s => s.id));
  const avail = (bench || []).filter(b => !b.used && !inGame.has(b.id) && !gs.hurt.has(b.id) && players[b.id] && isAvailable(players[b.id]));
  // (r163 §122.35 one who can play the hurt player's spot first — Positions)
  const spot = slots[slotIdx]?.pos || primaryPos(batter);
  const sub = avail.find(b => canPlay(players[b.id], spot)) || avail[0];
  if (!sub) return bases;
  const phrase = _HURT_HITTER[Math.floor(_roll() * _HURT_HITTER.length)];
  gs.hurt.add(batter.id);
  slots[slotIdx] = { id: sub.id, subbed: false, sub: true };
  sub.used = true;
  const onBase = ['first', 'second', 'third'].find(k => bases[k] === batter.id);
  const next = { ...bases };
  if (onBase && outs < 3) next[onBase] = sub.id;
  const subName = players[sub.id].name;
  plays.push(_injuryPlay(halfKey, {
    batterId: batter.id, pitcherId: pitcher?.id || null,
    description: `${batter.name} ${phrase}. ${subName} ${onBase && outs < 3 ? 'runs for' : 'takes over for'} ${batter.name}.`,
    _injury: { playerId: batter.id, subId: sub.id, role: 'hitter' },
    outsAfter: outs,
    _basesAfter: outs >= 3 ? { first: null, second: null, third: null } : { ...next },
  }));
  return outs >= 3 ? bases : next;
}

/**
 * The pitcher gets hurt on a pitch (checked as each batter steps in, so every
 * batter faced carries the risk): the manager has to go to the bullpen now —
 * a forced change. With nobody able to come in, the pitcher stays in (no
 * injury). Returns the new pitcher, or null.
 */
function _pitcherHurt(gs, players, plays, pitcher, side, tired, inning, outs, bases, halfKey) {
  if (!pitcher || gs.hurt.has(pitcher.id)) return null;
  const role = gs[`${side}Role`] === ROLE.STARTER ? 'starter' : 'reliever';
  // (r161 §122.33 a worn arm — its workload — is likelier hurt, like a tired one in the game)
  if (_roll() >= injuryChancePerExposure(pitcher, role, gs.injuryYear, tired || (_simAt && armLoad(pitcher, _simAt) >= WEAR.tired))) return null;
  const phrase = _HURT_PITCHER[Math.floor(_roll() * _HURT_PITCHER.length)];
  const was = { fatigued: gs[`${side}Fatigued`], mustGo: gs[`${side}MustGo`] };
  gs[`${side}Fatigued`] = true;
  gs[`${side}MustGo`]   = true;
  const at = plays.length;
  const half = halfKey.startsWith('TOP') ? 'TOP' : 'BOT';
  if (!_midHalfChange(gs, players, side, plays, inning, half, outs, bases)) {
    gs[`${side}Fatigued`] = was.fatigued;
    gs[`${side}MustGo`]   = was.mustGo;
    return null;
  }
  gs.hurt.add(pitcher.id);
  plays.splice(at, 0, _injuryPlay(halfKey, {
    batterId: null, pitcherId: pitcher.id,
    description: `${pitcher.name} ${phrase}.`,
    _injury: { playerId: pitcher.id, role },
    outsAfter: outs, _basesAfter: { ...bases },
  }));
  return players[gs[`${side}Pitcher`].id] || null;
}

// ─────────────────────────────────────────────────────────────
// PITCHER CHANGE LOGIC
// ─────────────────────────────────────────────────────────────

// Target innings for the current pitcher, by role + stamina. Starters ~5–8 IP,
// relievers ~1–2 IP. Keyed to innings (not batters) so the hook doesn't drift
// with how much offense a game happens to produce.
/** r169 a starter's innings wanted, moved by the hook (never under three; untouched without one). */
function _hooked(innings, hook) {
  return hook?.innings ? Math.max(3, innings + hook.innings) : innings;
}

function _pitcherTargetInnings(pitcher, gs = null) {
  if (gs?.exhibition) return gs.exhibition.starterIds.has(pitcher?.id) ? ALLSTAR_STARTER_INNINGS : 1;
  const stam = playingRating(pitcher, 'stamina') ?? 60;
  const isRP = pitcher?.group === PLAYER_GROUP.BULLPEN
            || pitcher?.group === PLAYER_GROUP.PITCHER_BENCH;
  if (isRP) return Math.max(1, Math.round(1 + (stam - 40) / 25)); // ~1–2 IP
  // r154 spring: a starter is building up. r272 §122.151 an inning or two short of his regular-season length.
  if (gs?.isSpring) return springStarterInnings(gs.springNum, seasonStarterInnings(pitcher));
  return seasonStarterInnings(pitcher);                             // ~5–8 IP
}

// Credit the current pitcher with a completed inning; decide whether he's done
// (§76): his innings are in, he's past the batters his stamina carries (or well
// past them), or — a starter — he's been hit hard early. The change itself
// waits until his side next takes the field (_checkPitcherChange).
function _accrueInningAndFatigue(gs, players, team) {
  const isUser = team === 'user';
  const side   = isUser ? 'user' : 'opp';
  gs[`${side}PitcherInnings`]++;
  const innings = gs[`${side}PitcherInnings`];
  const bf      = gs[`${side}PitchCount`];
  const tireAt  = gs[`${side}TireAt`];
  const runs    = gs[`${side}Runs`];
  const starter = gs[`${side}Role`] === ROLE.STARTER;
  const shelled = starter && !gs.exhibition && ((runs >= PITCH_SHELLED_RUNS && gs.inning <= 6)
                                             || (runs >= PITCH_SHELLED_EARLY_RUNS && gs.inning <= 3));
  // Why he's done matters: a pitcher whose innings are simply in can be asked
  // for one more when the pen is taxed; a tired or shelled one can't.
  gs[`${side}MustGo`] = bf >= tireAt || shelled;
  if (innings >= gs[`${side}Target`] || gs[`${side}MustGo`]) gs[`${side}Fatigued`] = true;
}

/**
 * _checkPitcherChange(gs, players, team, userBullpen, oppBullpen, plays, inning, half)
 * As his side takes the field: a pitcher who is done is replaced — by the
 * manager's choice for the situation (PitchingEngine.chooseReliever) — and in
 * a 9th-inning save a starter still going makes way for a rested closer.
 * With nobody left to bring in, he stays out there.
 */
function _checkPitcherChange(gs, players, team, userBullpen, oppBullpen, plays, inning, half) {
  const isUser = team === 'user';
  const side   = isUser ? 'user' : 'opp';
  const lead   = isUser ? gs.userScore - gs.oppScore : gs.oppScore - gs.userScore;
  const roles  = gs[`${side}Roles`];
  let   done   = gs[`${side}Fatigued`];

  if (!done && !gs.exhibition && roles?.closer && inning >= 9 && lead >= 1 && lead <= 3
      && gs[`${side}Role`] !== ROLE.CLOSER && !gs[`${side}Used`].has(roles.closer)
      && armStatus(players[roles.closer], gs.atMs).status !== 'down') {
    done = true;   // the closer gets the save
  }
  if (!done) return;
  const closerCall = !gs[`${side}Fatigued`];   // done only because the closer comes in

  let reliever = null, role = ROLE.MIDDLE, carriedTired = false;
  if (gs.exhibition) {
    // §75 All-Star Game: the squad's plan, one inning each.
    const bullpen = (isUser ? userBullpen : oppBullpen) || [];
    const idx = gs[`${side}BullpenIdx`];
    reliever = bullpen[idx % bullpen.length] || null;
  } else {
    const pick = chooseReliever({ roles, players, used: gs[`${side}Used`], atMs: gs.atMs, inning, lead });
    // A taxed pen: the man out there isn't tired and nobody rested is left —
    // the manager asks him for another inning.
    // r154 Never a spring starter: his innings are his build-up.
    const springStarter = gs.isSpring && gs[`${side}Role`] === ROLE.STARTER;
    if (pick && !pick.wanted && !gs[`${side}MustGo`] && !closerCall && !springStarter) {
      gs[`${side}Target`] += 1;
      gs[`${side}Fatigued`] = false;
      return;
    }
    if (pick) { reliever = { id: pick.id }; role = pick.role; carriedTired = pick.carriedTired; }
  }
  if (!reliever) return;   // no one left — the current pitcher stays in

  gs[`${side}Pitcher`]        = reliever;
  gs[`${side}Fatigued`]       = false;
  gs[`${side}MustGo`]         = false;
  gs[`${side}BullpenIdx`]++;
  gs[`${side}PitchCount`]     = 0;      // a fresh count for the new arm
  gs[`${side}PitcherInnings`] = 0;
  gs[`${side}Runs`]           = 0;
  gs[`${side}Role`]           = role;
  gs[`${side}Used`].add(reliever.id);
  const rp = players[reliever.id];
  gs[`${side}TireAt`] = gs.exhibition ? Infinity : tireAfterBF(rp, false, carriedTired);
  gs[`${side}Target`] = gs.exhibition ? _pitcherTargetInnings(rp, gs) : reliefInnings(role, _roll);

  // The first play of the half the new pitcher works: nobody out, bases empty.
  const prev = plays[plays.length - 1];
  plays.push({
    playIndex:    0,
    _halfInning:  `${half}_${inning}`,
    inning,
    half,
    batterId:     null,
    pitcherId:    reliever.id,
    type:         'pitching_change',
    description:  `Pitching change: ${rp?.name || 'Reliever'} enters`,
    _role:        role,
    rbi:          0,
    isScoring:    false,
    isBigPlay:    false,
    outsAfter:    0,
    _basesAfter:  { first: null, second: null, third: null },
    // (The first play of a resumed game has none before it in this run: the score it stands at — §109.)
    cumOurScore:   prev?.cumOurScore   ?? gs.userScore ?? 0,
    cumTheirScore: prev?.cumTheirScore ?? gs.oppScore  ?? 0,
    _timestamp:   0,
    _statDeltas:  {},
  });
}

// ─────────────────────────────────────────────────────────────
// PITCHER DECISIONS — W / L / SV / HD
// Run once after simulation, adds deltas to the game_end play.
// ─────────────────────────────────────────────────────────────

/**
 * _assignPitcherDecisions(plays, userScore, oppScore, isHome)
 *
 * Scans the completed play array and adds W/L/SV/HD stat deltas
 * to a synthetic `pitcher_decisions` play appended after game_end.
 * Only applies to user-team pitchers (we don't track CPU pitcher stats).
 *
 * Rules:
 *   Win:  The user pitcher who was on the mound the inning the user team
 *         took the lead for good (and their team won).
 *   Loss: The user pitcher who was on the mound when the opponent scored
 *         the go-ahead run that held (and the user team lost).
 *   Save: The last user pitcher to pitch, if:
 *         - user team won, AND
 *         - pitcher entered with lead ≤ 3, AND
 *         - pitcher recorded ≥ 1 out
 *   Hold: Any user reliever (not the winning/saving pitcher) who:
 *         - entered in a save situation (lead ≤ 3), recorded ≥ 1 out,
 *           and left with the lead still intact
 *
 * @param {Object[]} plays
 * @param {Number}   userScore  — final
 * @param {Number}   oppScore   — final
 * @param {Boolean}  isHome     — whether user team is home
 * @returns {Object} statDeltas map { [pitcherId]: [{stat, delta}] }
 */
function _assignPitcherDecisions(plays, userScore, oppScore, isHome, starterOuts = 15) {
  // Decisions for BOTH teams (§66): W/L/SV/HLD by the scoring rules, so CPU
  // pitchers — and the user's opponents — carry real records too.
  // Side 'A' is the team generatePlays received as userTeam (cumOurScore).
  if (userScore === oppScore) return {};              // spring ties: no decision
  const homeIsA  = !!isHome;
  const pitchSide = (half) => ((half === 'TOP') === homeIsA ? 'A' : 'B'); // TOP: home pitches
  const lead = (p, side) => side === 'A'
    ? (p.cumOurScore ?? 0) - (p.cumTheirScore ?? 0)
    : (p.cumTheirScore ?? 0) - (p.cumOurScore ?? 0);
  const winner = userScore > oppScore ? 'A' : 'B';
  const loser  = winner === 'A' ? 'B' : 'A';

  // Pitching spans per side, in order, with outs recorded and entry lead.
  const spans = { A: [], B: [] };
  let prevOuts = 0, prevHalf = null, prevPlay = null;
  for (const play of plays) {
    if (!play.pitcherId || play.type === 'game_start' || play.type === 'game_end') { prevPlay = play; continue; }
    const half = `${play.half}${play.inning}`;
    if (half !== prevHalf) { prevOuts = 0; prevHalf = half; }
    const side = pitchSide(play.half);
    const list = spans[side];
    let cur = list[list.length - 1];
    if (!cur || cur.id !== play.pitcherId) {
      const entry = prevPlay ? lead(prevPlay, side) : 0;
      cur = { id: play.pitcherId, outs: 0, entryLead: entry, minLead: entry, firstIdx: play.playIndex };
      list.push(cur);
    }
    const outsAfter = Number.isFinite(play.outsAfter) ? play.outsAfter : prevOuts;
    cur.outs += Math.max(0, outsAfter - prevOuts);
    cur.lastIdx = play.playIndex;
    cur.exitLead = lead(play, side);
    cur.minLead = Math.min(cur.minLead, cur.exitLead);
    prevOuts = outsAfter >= 3 ? 0 : outsAfter;
    prevPlay = play;
  }
  if (!spans.A.length || !spans.B.length) return {};

  // The play on which the winner took the lead for good.
  let goAhead = null;
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i];
    if (lead(p, winner) <= 0) break;
    if (playRuns(p) > 0) goAhead = p;
  }
  if (!goAhead) goAhead = plays.find(p => lead(p, winner) > 0) || plays[plays.length - 1];
  const at = goAhead.playIndex ?? 0;
  const onMound = (side) => {
    const list = spans[side];
    return list.filter(s => s.firstIdx <= at).pop() || list[0];
  };

  const out = {};
  const add = (id, stat) => { (out[id] = out[id] || []).push({ stat, delta: 1 }); };

  // W: winner's pitcher of record at the go-ahead — a starter needs 15 outs,
  // otherwise the scorer gives it to the first reliever who followed him.
  let w = onMound(winner);
  if (w === spans[winner][0] && w.outs < starterOuts) w = spans[winner][1] || w;
  add(w.id, 'w');
  // L: loser's pitcher on the mound for the go-ahead run.
  add(onMound(loser).id, 'l');
  // SV: winner's last pitcher, not the W, finished it, entered leading by ≤3
  // (or pitched 3+ innings with any lead) and recorded an out.
  const last = spans[winner][spans[winner].length - 1];
  const sv = last.id !== w.id && last.outs >= 1 && last.entryLead > 0
    && (last.entryLead <= 3 || last.outs >= 9);
  if (sv) add(last.id, 'sv');
  // HLD: winner's middle relievers who entered in a save situation, got an
  // out and handed the lead on intact.
  for (const sp of spans[winner].slice(1)) {
    if (sp.id === w.id || (sv && sp.id === last.id)) continue;
    if (sp.entryLead > 0 && sp.entryLead <= 3 && sp.outs >= 1 && sp.exitLead > 0) add(sp.id, 'hld');
  }
  // §112 BS: a reliever on either side who came in with a lead of three or
  // fewer and let the tying run score while he was out there (his club can
  // still come back and win). SVO: every save and every blown save.
  if (sv) add(last.id, 'svo');
  for (const side of ['A', 'B']) {
    for (const sp of spans[side].slice(1)) {
      if (sp.entryLead > 0 && sp.entryLead <= 3 && sp.minLead <= 0) { add(sp.id, 'bs'); add(sp.id, 'svo'); }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP ASSIGNMENT
// ─────────────────────────────────────────────────────────────

/**
 * _assignTimestamps(plays, game, wx, gameState)
 * The clock for every play (§102.2). A game is paced by its progress: ten
 * playing minutes a half-inning, spread by outs (nine innings ≈ three hours;
 * a walk-off ends early, extra innings run long; r257 each game at its own pace, `tempo`). The weather's delays sit at
 * exactly the moments its plan has them, and add their length to everything
 * after. Each play also gets `_playMin` (playing minutes). A suspended game's
 * plays after the suspension get no clock here (`_resumeMin` instead): it's
 * set when the game resumes.
 */
function _assignTimestamps(plays, game, wx, gameState) {
  const HALF = GAME_WEATHER.HALF_MIN, MIN = 60_000;
  const startAt = wx ? wx.startAt : (game.gameTime || 0);
  const tempo = wx?.tempo || 1;   // r257 §122.136 the game's own pace (its weather plan's)
  const n = plays.length;
  const m = new Array(n).fill(null);
  const isAnchor = (p) => !!(p._wx && !p._wx.pre);

  // 1. Playing minutes from the half-inning and the outs.
  const groups = new Map();
  let curHalf = null, outsBefore = 0;
  for (let i = 0; i < n; i++) {
    const p = plays[i];
    if (isAnchor(p)) { m[i] = p._wx.atPlayMin; continue; }
    if (p.type === 'game_start' || p._wx?.pre) { m[i] = 0; continue; }
    if (p.type === 'game_end' || p.type === 'game_suspended' || p.type === 'inning_end') continue;   // placed below
    if (p.half !== 'TOP' && p.half !== 'BOT') continue;
    const hk = `${p.half}_${p.inning}`;
    if (hk !== curHalf) { curHalf = hk; outsBefore = 0; }
    const hIdx = (p.inning - 1) * 2 + (p.half === 'TOP' ? 0 : 1);
    const key = hIdx * 4 + Math.min(outsBefore, 2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
    if (Number.isFinite(p.outsAfter)) outsBefore = Math.min(3, p.outsAfter);
  }
  for (const [key, idx] of groups) {
    const base = Math.floor(key / 4) * HALF + (key % 4) * (HALF / 3), span = HALF / 3;
    idx.forEach((i, k) => { m[i] = base + span * (k + 1) / (idx.length + 1); });
  }
  // 2. The markers: a half ends just after its last out; the game just after its last play.
  const nextEvent = wx && wx.next < wx.events.length ? wx.events[wx.next].atPlayMin : Infinity;
  for (let i = 0; i < n; i++) {
    const p = plays[i], prev = i ? m[i - 1] : 0;
    if (p.type === 'inning_end') m[i] = prev + 0.15;
    else if (p.type === 'game_suspended') m[i] = prev;
    else if (p.type === 'game_end') m[i] = Math.max(prev, Math.min(prev + 0.3, nextEvent - 0.01));   // never into a delay that never came
    else if (m[i] == null) m[i] = prev;
  }
  // 3. Everything before a delay happens before it; then never backwards.
  for (let a = 0; a < n; a++) {
    if (!isAnchor(plays[a])) continue;
    const A = m[a];
    for (let j = a - 1, k = 1; j >= 0 && !isAnchor(plays[j]) && m[j] > A - 0.02 * k; j--, k++) m[j] = A - 0.02 * k;
  }
  for (let i = 1; i < n; i++) if (m[i] < m[i - 1]) m[i] = m[i - 1];

  // 4. The clock.
  const callT = gameState?.ruling ? (wx?.log[wx.log.length - 1]?.endT ?? null) : null;
  let add = 0, split = false, mSplit = 0;
  return plays.map((play, i) => {
    const p = { ...play, playIndex: i, _playMin: Math.round(m[i] * 100) / 100 };
    if (play._wx?.pre) { p._timestamp = play._wx.startT; return p; }
    if (split) { p._timestamp = null; p._resumeMin = Math.round((m[i] - mSplit) * 100) / 100; return p; }
    if (play.type === 'weather_resume') add += play._wx.endT - play._wx.startT;
    let t = startAt + m[i] * MIN * tempo + add;
    if (play.type === 'weather_delay') t = play._wx.startT;   // the plan's moment (the same, by construction)
    if (play.type === 'game_suspended') { t = callT ?? t; split = true; mSplit = m[i]; }
    if (play.type === 'game_end' && gameState?.ruling?.outcome === 'final' && callT != null) t = callT;
    p._timestamp = Math.round(t);
    return p;
  });
}

// ─────────────────────────────────────────────────────────────
// WEATHER (§102.2) — the plan's delays and calls, and how the
// temperature, wind and rain play, inning by inning
// ─────────────────────────────────────────────────────────────

/** The plan, as the sim uses it (null when there's no plan or the game was postponed). */
function _weatherSetup(weather, game) {
  const plan = weather?.plan;
  if (!plan || plan.startAt == null) return null;
  const events = plan.delays.filter(d => d.startT >= plan.startAt).map(d => ({ ...d }));
  if (plan.outcome === 'called' && events.length) Object.assign(events[events.length - 1], { call: true, calledBy: plan.calledBy });
  return { startAt: plan.startAt, pre: plan.delays.filter(d => d.startT < plan.startAt), events, next: 0,
           env: weather.conditions || [], log: [], tempo: plan.tempo || 1 };   // r257 the game's pace
}

/**
 * weatherEnv(c) — how a park report plays (SIM_WEATHER_ENV): multipliers on
 * the home run share, the hit rate and the walk rate.
 */
export function weatherEnv(c) {
  if (!c) return { hitMod: 1, hrMod: null, walkMod: 1 };
  const E = SIM_WEATHER_ENV;
  const dT = (c.tempF ?? E.BASE_TEMP_F) - E.BASE_TEMP_F, out = (c.windOutMph ?? E.BASE_WIND_OUT) - E.BASE_WIND_OUT;
  const rain = c.kind === 'rain' && c.rateMmH >= E.RAIN_MIN_MMH ? c.rateMmH : 0;
  return {
    hrMod:   _clamp((1 + E.HR_PER_DEG * dT) * (1 + E.HR_PER_MPH_OUT * out), E.HR_MIN, E.HR_MAX),
    hitMod:  _clamp(1 + E.HIT_PER_DEG * dT + E.HIT_PER_MPH_OUT * out - E.HIT_PER_MMH_RAIN * rain, E.HIT_MIN, E.HIT_MAX),
    walkMod: 1 + Math.min(E.WALK_RAIN_MAX, E.WALK_PER_MMH * rain) + ((c.tempF ?? 72) < E.COLD_F ? E.WALK_COLD : 0),
  };
}

/** This half-inning's weather: the park report nearest its middle. */
function _envFor(wx, halfIdx) {
  if (!wx || !wx.env.length) return { hitMod: 1, hrMod: null, walkMod: 1, c: null };
  const mid = (halfIdx + 0.5) * GAME_WEATHER.HALF_MIN;
  let c = wx.env[0];
  for (const e of wx.env) if (Math.abs(e.playMin - mid) < Math.abs(c.playMin - mid)) c = e;
  return { ...weatherEnv(c), c };
}

const _WX_REASON_WORD = { lightning: 'lightning', rain: 'rain', snow: 'snow', 'wet field': 'a wet field' };
function _delayLength(mins) {
  if (mins < 60) return `${mins}-minute`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return r ? `${h} hr ${r} min` : `${h}-hour`;
}

function _weatherText(type, d, mins, pre) {
  const r = d.reason;
  if (type === 'weather_resume') return `Play resumes after a ${_delayLength(mins)} ${r === 'snow' ? 'snow' : 'rain'} delay.`;
  if (pre) {
    return r === 'lightning' ? 'The start is delayed — lightning in the area.'
         : r === 'snow' ? 'The start is delayed by snow.'
         : r === 'wet field' ? 'The start is delayed — the grounds crew is working on a wet field.'
         : 'The start is delayed by rain — the tarp is on the field.';
  }
  return r === 'lightning' ? 'Lightning in the area — the players head off the field.'
       : r === 'snow' ? 'Snow is coming down — play is stopped.'
       : 'The rain picks up — the tarp is coming out.';
}

function _weatherPlay(type, d, at) {
  const mins = Math.round((d.endT - d.startT) / 60_000);
  return {
    playIndex: 0, _halfInning: `${at.half}_${at.inning}`, inning: at.inning, half: at.half,
    batterId: null, pitcherId: null, type, description: _weatherText(type, d, mins, at.pre),
    rbi: 0, isScoring: false, isBigPlay: false,
    outsAfter: at.outs, _basesAfter: at.bases ? { ...at.bases } : { first: null, second: null, third: null },
    cumOurScore: 0, cumTheirScore: 0, _timestamp: 0, _statDeltas: {},
    _wx: { startT: d.startT, endT: d.endT, atPlayMin: d.atPlayMin, reason: d.reason, minutes: mins, pre: !!at.pre, call: !!d.call },
  };
}

/**
 * Before each plate appearance: the plan's next delay, if the game has
 * reached it (by its progress — ten playing minutes a half, a third of that
 * an out). A delay of ARM_COOL_MIN or more and neither pitcher goes back out.
 * Returns 'stop' (play is over for the day), 'arm' (a new pitcher is in), or null.
 */
function _weatherCheck(gs, players, plays, inning, half, outs, bases, fieldSide) {
  const wx = gs.wx;
  const est = gs.halfIdx * GAME_WEATHER.HALF_MIN + outs * (GAME_WEATHER.HALF_MIN / 3);
  let arm = false;
  while (wx.next < wx.events.length && wx.events[wx.next].atPlayMin <= est) {
    const ev = wx.events[wx.next++];
    const at = { inning, half, outs, bases };
    wx.log.push({ ...ev, inning, half, outs });
    plays.push(_weatherPlay('weather_delay', ev, at));
    if (ev.call) return 'stop';
    plays.push(_weatherPlay('weather_resume', ev, at));
    if (ev.endT - ev.startT >= GAME_WEATHER.ARM_COOL_MIN * 60_000) {
      // (A pitcher who came in and hasn't faced a batter yet stays: he's the one who warms up again.)
      for (const side of ['user', 'opp']) if (gs[`${side}PitchCount`] > 0) { gs[`${side}Fatigued`] = true; gs[`${side}MustGo`] = true; }
      if (_midHalfChange(gs, players, fieldSide, plays, inning, half, outs, bases)) {
        arm = true;
        const pc = plays[plays.length - 1];
        pc.description = `After the delay: ${pc.description.replace(/^Pitching change: /, 'pitching change, ')}`;
      }
    }
  }
  return arm ? 'arm' : null;
}

/** A pitching change in the middle of a half (after a long delay): the situation carries on. */
function _midHalfChange(gs, players, side, plays, inning, half, outs, bases) {
  const before = plays.length;
  _checkPitcherChange(gs, players, side, gs.bullpens?.user, gs.bullpens?.opp, plays, inning, half);
  if (plays.length === before) return false;
  const pc = plays[plays.length - 1];
  pc.outsAfter = outs;
  pc._basesAfter = { ...bases };
  return true;
}

const _ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/**
 * A game the weather has stopped for good (MLB's rules, regular season):
 *   - official after 5 innings, or 4½ with the home team ahead; before that
 *     it's suspended, to be finished another day;
 *   - an official game called in an unfinished inning: if the visitors tied
 *     or went ahead in it and the home team hasn't answered, suspended;
 *     if the home team went ahead in its half, the score stands; otherwise
 *     it goes back to the end of the last complete inning (a tie there:
 *     suspended);
 *   - spring and the All-Star Game simply end; postseason games are never
 *     shortened — always suspended.
 * → { outcome: 'final'|'suspended', reason, inning, half, outs, innings (complete), text, userScore, oppScore, revertIdx }
 */
function _calledRuling(gs, plays, o) {
  const st = gs.wxStop, I = st.inning, H = st.half;
  const reason = gs.wx?.log[gs.wx.log.length - 1]?.reason || 'rain';
  const word = _WX_REASON_WORD[reason] || reason;
  const homeOf = (p) => (o.userBatsBottom ? p.cumOurScore : p.cumTheirScore) ?? 0;
  const awayOf = (p) => (o.userBatsBottom ? p.cumTheirScore : p.cumOurScore) ?? 0;
  const toUser = (h, a) => (o.userBatsBottom ? { userScore: h, oppScore: a } : { userScore: a, oppScore: h });
  const hN = o.userBatsBottom ? gs.userScore : gs.oppScore, aN = o.userBatsBottom ? gs.oppScore : gs.userScore;
  // The end of the last complete inning.
  let prevIdx = 0, hP = 0, aP = 0, aTop = aN;
  for (let k = plays.length - 1; k >= 0; k--) {
    const p = plays[k];
    if (H === 'BOT' && p.half === 'TOP' && p.inning === I && aTop === aN) aTop = awayOf(p);
    if (p.type === 'inning_end' && p.half === 'BOT' && p.inning === I - 1) { prevIdx = k + 1; hP = homeOf(p); aP = awayOf(p); break; }
  }
  const where = `${H === 'TOP' ? 'top' : 'bottom'} of the ${_ordinal(I)}`;
  const base = { reason, inning: I, half: H, outs: st.outs };
  const final = (h, a, innings, text, revertIdx = null) => ({ ...base, outcome: 'final', innings, text, ...toUser(h, a), revertIdx });
  const suspended = () => ({ ...base, outcome: 'suspended', innings: I - 1, ...toUser(hN, aN), revertIdx: null,
                             text: `Suspended (${word}) in the ${where} — to be completed later` });

  if (o.exhibition) return final(hN, aN, I - 1, `Final — called (${word}) in the ${where}`);
  if (o.playoff) return suspended();
  const official = I - 1 >= 5 || (H === 'BOT' && I >= 5 && hN > aN);
  if (!official) return suspended();
  // Visitors tied it or went ahead in this inning, and the home team hasn't answered.
  if (aTop >= hP && aP < hP && hN <= aN) return suspended();
  // The home team went ahead in its half: the score stands.
  if (H === 'BOT' && hN > aN && hN > hP && hP <= aN) return final(hN, aN, I - 1, `Final — called (${word}) after ${I - 1}½ innings`);
  // Back to the end of the last complete inning.
  if (hP === aP) return suspended();
  const changed = hP !== hN || aP !== aN;
  return final(hP, aP, I - 1, changed
    ? `Final — called (${word}) in the ${_ordinal(I)}; the score goes back to the end of the ${_ordinal(I - 1)}`
    : `Final — called (${word}) after ${I - 1}${H === 'BOT' ? '½' : ''} innings`, changed ? prevIdx : null);
}

/**
 * resumeTimeline(resumePlays, plan, suspendedPlay) — a suspended game picked
 * up (§102.3): the rest of its plays on the resumption day's clock. First the
 * resumption's own delayed start, if any; then "the suspended game resumes";
 * then the plays, each at the resumption's first pitch plus its playing
 * minutes, with that day's delays (from the resumption's weather plan) on
 * the clock between them. (A long delay in a resumption doesn't change
 * pitchers — the rest of the game was played out at the suspension.)
 */
export function resumeTimeline(resumePlays, plan, suspendedPlay) {
  const sp = suspendedPlay?._suspended || { inning: 1, half: 'TOP', outs: 0, bases: null };
  const at = { inning: sp.inning, half: sp.half, outs: sp.outs, bases: sp.bases };
  const startAt = plan.startAt;
  const out = [];
  for (const d of plan.delays.filter(x => x.startT < startAt)) out.push({ ..._weatherPlay('weather_delay', d, { ...at, pre: true }), cumOurScore: suspendedPlay?.cumOurScore ?? 0, cumTheirScore: suspendedPlay?.cumTheirScore ?? 0, _timestamp: d.startT });
  const where = `${sp.half === 'TOP' ? 'top' : 'bottom'} of the ${_ordinal(sp.inning)}, ${sp.outs} out`;
  out.push({
    playIndex: 0, _halfInning: `${sp.half}_${sp.inning}`, inning: sp.inning, half: sp.half, batterId: null, pitcherId: null,
    type: 'game_resumed', description: `The suspended game picks up where it stopped: ${where}.`,
    rbi: 0, isScoring: false, isBigPlay: false, outsAfter: sp.outs, _basesAfter: sp.bases ? { ...sp.bases } : { first: null, second: null, third: null },
    cumOurScore: suspendedPlay?.cumOurScore ?? 0, cumTheirScore: suspendedPlay?.cumTheirScore ?? 0, _timestamp: startAt, _statDeltas: {},
  });
  const mid = plan.delays.filter(x => x.startT >= startAt);
  let k = 0, add = 0;
  for (const p of resumePlays) {
    const m = p._resumeMin ?? 0;
    while (k < mid.length && mid[k].atPlayMin <= m) {
      const d = mid[k++], prev = out[out.length - 1];
      const here = { inning: prev.inning, half: prev.half, outs: prev.outsAfter ?? 0, bases: prev._basesAfter };
      out.push({ ..._weatherPlay('weather_delay', d, here), cumOurScore: prev.cumOurScore, cumTheirScore: prev.cumTheirScore, _timestamp: d.startT });
      out.push({ ..._weatherPlay('weather_resume', d, here), cumOurScore: prev.cumOurScore, cumTheirScore: prev.cumTheirScore, _timestamp: d.endT });
      add += d.endT - d.startT;
    }
    out.push({ ...p, _timestamp: Math.round(startAt + m * 60_000 * (plan.tempo || 1) + add) });
  }
  return out;
}

/** The moment a game is suspended: where it stands, and that it will be finished another day. */
function _suspendedPlay(st, gs, plays) {
  const prev = plays[plays.length - 1];
  return {
    playIndex: 0, _halfInning: `${st.half}_${st.inning}`, inning: st.inning, half: st.half,
    batterId: null, pitcherId: null, type: 'game_suspended', description: gs.ruling.text,
    rbi: 0, isScoring: false, isBigPlay: false, outsAfter: st.outs, _basesAfter: { ...st.bases },
    cumOurScore: prev?.cumOurScore ?? 0, cumTheirScore: prev?.cumTheirScore ?? 0, _timestamp: 0, _statDeltas: {},
    _suspended: { inning: st.inning, half: st.half, outs: st.outs, bases: { ...st.bases }, reason: gs.ruling.reason },
  };
}

// ─────────────────────────────────────────────────────────────
// CUMULATIVE SCORE UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * _stampRunningScore(plays, userStart, oppStart, battingIsUser)
 * The score AFTER each play of a half-inning: the score entering the half plus
 * the runs scored so far in it. The live scoreboard reads the last revealed
 * play's running score, so a run appears the moment it scores — never at the
 * first pitch of the half.
 */
function _stampRunningScore(plays, userStart, oppStart, battingIsUser) {
  let user = userStart, opp = oppStart;
  for (const play of plays) {
    if (battingIsUser) user += playRuns(play); else opp += playRuns(play);
    play.cumOurScore   = user;
    play.cumTheirScore = opp;
  }
}

/**
 * _buildSyntheticCPUTeam(players)
 * When opponentTeam lookup fails (name mismatch after rename, etc.),
 * build a synthetic team from all available non-user players so the
 * game can still produce real scoring plays instead of ending 0-0.
 *
 * Uses players from any league team roster detected in the players registry.
 * Not perfect but far better than an empty lineup.
 */
function _buildSyntheticCPUTeam(players) {
  // Find all players that appear to belong to CPU teams
  // (heuristic: not in user roster — we don't have that info here,
  //  so just grab a reasonable set of players sorted by OVR)
  const allPlayers = Object.values(players).filter(p =>
    p && isAvailable(p)
  );

  // Active hitters carry BENCH_HITTERS under the lineupSlots model (STARTING_HITTERS
  // is no longer assigned), so pull hitters from that group — filtering by
  // STARTING_HITTERS here is what produced 0 hitters and 0-0 fallback games.
  const hitters  = allPlayers.filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS)
    .sort((a,b) => b.ovr - a.ovr);
  const pitchers = allPlayers.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS)
    .sort((a,b) => b.ovr - a.ovr).slice(0, 5);
  const bullpen  = allPlayers.filter(p => p.group === PLAYER_GROUP.BULLPEN)
    .sort((a,b) => b.ovr - a.ovr).slice(0, 5);

  // Seat 9 hitters into the canonical lineupSlots by position eligibility so the
  // synthetic team has the length-9 lineupSlots that _buildLineup requires.
  const SLOTS = ['C','1B','2B','3B','SS','OF','OF','OF','DH'];
  const eligible = (p, label) => canPlay(p, label);   // r163 §122.35 Positions (DH: anyone)
  const used = new Set();
  const lineupSlots = SLOTS.map(label => {
    const pick = hitters.find(p => !used.has(p.id) && eligible(p, label));
    if (pick) { used.add(pick.id); return { slot: label, playerId: pick.id }; }
    return { slot: label, playerId: null };
  });
  // Fill any remaining vacancy with the best leftover hitter.
  for (const s of lineupSlots) {
    if (s.playerId) continue;
    const pick = hitters.find(p => !used.has(p.id));
    if (pick) { used.add(pick.id); s.playerId = pick.id; }
  }
  const starterIds = lineupSlots.map(s => s.playerId).filter(Boolean);

  return {
    rosterIds: [...starterIds, ...pitchers.map(p => p.id), ...bullpen.map(p => p.id)],
    lineupSlots,
    rotation:  {
      order:        pitchers.map(p => p.id),
      currentIndex: 0,
    },
    name:   'CPU',
    abbr:   'CPU',
  };
}

// ─────────────────────────────────────────────────────────────
// LINEUP BUILDERS
// ─────────────────────────────────────────────────────────────

function _buildLineup(team, players, isCPU) {
  const rosterIds  = team.rosterIds || [];
  const lineupSlots = team.lineupSlots || [];

  // Build starters from lineupSlots — the source of truth for who's active.
  // Filter out injured/suspended players; they'll be skipped in the sim.
  let starterPlayers;

  if (lineupSlots.length === 9) {
    // New model — read directly from lineupSlots
    starterPlayers = lineupSlots
      .map(s => s.playerId ? players[s.playerId] : null)
      .filter(p => p && isAvailable(p));
  } else {
    // Fallback: old saves that haven't migrated yet
    starterPlayers = rosterIds
      .map(id => players[id])
      .filter(p =>
        p &&
        isAvailable(p) &&
        p.group === PLAYER_GROUP.STARTING_HITTERS
      );
  }

  // Batting order: CPU uses OVR sort, user team uses sub-rating derivation.
  // lineupSlots defines WHO is in the lineup; batting order defines SEQUENCE.
  // An All-Star squad's manager builds a real order too (§75).
  // r169 our club's order by the GM's style (Strategy); an All-Star squad's the traditional one.
  const orderedStarters = isCPU && !team.isAllStar
    ? [...starterPlayers].sort((a,b) => b.ovr - a.ovr)
    : battingOrder(starterPlayers, team.isAllStar ? 'classic' : strategyOf(team).order);

  // §75 All-Star squad: the bench and staff are the squad's own (named), not
  // roster groups — selected starters and relievers both pitch in relief.
  if (team.isAllStar) {
    const ok = (id) => players[id] && isAvailable(players[id]);
    const subs = team.simSubs || {};
    return {
      field:   _fieldMap(lineupSlots.length === 9 ? lineupSlots : [], orderedStarters),   // r205 §122.83
      slots:   orderedStarters.map(p => ({ id: p.id, subbed: false,
                                           subIn: subs[p.id]?.inId || null, subInning: subs[p.id]?.inning || null })),
      bench:   (team.simBench || []).filter(ok).map(id => ({ id, used: false })),
      bullpen: (team.simBullpen || []).filter(ok).map(id => ({ id })),
    };
  }

  // The bench: every available rostered hitter who isn't in today's nine.
  // (r137 §118: lineupSlots decide who starts — every active hitter carries
  // BENCH_HITTERS, the nine included — so the group alone put the starters on
  // the bench too.)
  const starting = new Set(orderedStarters.map(p => p.id));
  const bench = rosterIds
    .map(id => players[id])
    .filter(p =>
      p &&
      isAvailable(p) &&
      p.group === PLAYER_GROUP.BENCH_HITTERS &&
      !starting.has(p.id)
    )
    .sort((a, b) => b.ovr - a.ovr);

  // Bullpen — healthy rostered relievers (BULLPEN + PITCHER_BENCH) in the
  // manager's roles (§76): closer, setup, middle, long. _checkPitcherChange
  // picks by the situation and each arm's rest (PitchingEngine).
  const roles = bullpenRoles(team, players);
  const bullpen = [roles.closer, ...roles.setup, ...roles.middle, ...roles.long].filter(Boolean);

  return {
    slots:   orderedStarters.map(p => ({ id: p.id, subbed: false })),
    bench:   bench.map(p => ({ id: p.id, used: false })),
    bullpen: bullpen.map(id => ({ id })),
    roles,
    defense: lineupSlots.length === 9 ? defenseOf(lineupSlots, players) : null,   // r165 §122.35 who's out of position
    field: _fieldMap(lineupSlots, orderedStarters),   // r205 §122.83 who plays where
    run: runStyle(team), hook: hookStyle(team),   // r169 how the club plays (Strategy)
    mgr: lateClosePoints(team),                   // §122.64 the manager's edge in a late, close game
  };
}

function _buildCPULineup(team, players) {
  if (!team) return { slots: [], bench: [] };
  return _buildLineup(team, players, true);
}

function _getRotationSP(team, players, atMs = null) {
  if (team.simStarter && players[team.simStarter] && isAvailable(players[team.simStarter])) return { id: team.simStarter };
  // §122.70 the rotation's starters are the club's own: one no longer on it (traded, released) is never in turn.
  const onClub = (id) => !team.rosterIds || team.rosterIds.includes(id);
  const rotation = team.rotation;
  if (!rotation || !rotation.order || rotation.order.length === 0) {
    // Fallback: find any healthy SP
    return _findHealthySP(team.rosterIds || [], players);
  }
  // The starter in turn — unless he hasn't had his four days (a doubleheader,
  // a makeup game): then the next man in the rotation who has (§76).
  const n = rotation.order.length;
  const ready = (id) => players[id] && isAvailable(players[id]) && onClub(id) && (atMs == null || starterRested(players[id], atMs));
  for (let k = 0; k < n; k++) {
    const id = rotation.order[(rotation.currentIndex + k) % n];
    if (ready(id)) return { id };
  }
  // §108 nobody in the rotation has had four days (doubleheaders, makeups): a spot starter — a
  // starter on the pitcher bench or in the bullpen, rested and fresh — before a tired regular.
  if (atMs != null) {
    const inRot = new Set(rotation.order);
    const spot = (team.rosterIds || []).map(id => players[id])
      .filter(p => p && p.pos === 'SP' && !inRot.has(p.id) && isAvailable(p)
                && (p.group === PLAYER_GROUP.PITCHER_BENCH || p.group === PLAYER_GROUP.BULLPEN)
                && starterRested(p, atMs) && armStatus(p, atMs).status === 'fresh')
      .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    if (spot) return { id: spot.id };
  }
  const spId = rotation.order[rotation.currentIndex % n];
  if (players[spId] && isAvailable(players[spId]) && onClub(spId)) return { id: spId };
  return _findHealthySP(team.rosterIds || [], players);
}

/**
 * rotationStarter(team, players, atMs) — who starts for a club at a moment by
 * its rotation (the one in turn, or the next who has had the rest): the same
 * choice the sim makes at first pitch.
 */
export function rotationStarter(team, players, atMs) {
  return _getRotationSP(team, players, atMs)?.id || null;
}

function _getCPUSP(team, players) {
  if (!team) return null;
  return _getRotationSP(team, players);
}

function _findHealthySP(rosterIds, players) {
  const sp = rosterIds
    .map(id => players[id])
    .filter(p => p && p.group === PLAYER_GROUP.STARTING_PITCHERS && isAvailable(p))
    .sort((a, b) => b.ovr - a.ovr)[0];
  return sp ? { id: sp.id } : null;
}

// ─────────────────────────────────────────────────────────────
// STAT DELTA BUILDER
// ─────────────────────────────────────────────────────────────

function _buildStatDeltas(atBat, batter, pitcher, rbi, runsScored, runnerIds, effectiveType = null, outsRecorded = null) {
  const deltas = {};
  const type   = effectiveType || atBat.type;

  const addDelta = (id, stat, delta) => {
    if (!id) return;
    if (!deltas[id]) deltas[id] = [];
    deltas[id].push({ stat, delta });
  };

  // ── Batter stats ─────────────────────────────────────────────
  // AB: not charged on walk, HBP, sac fly, or sac bunt
  const noAB = ['walk','hbp','sac_fly','sac_bunt'].includes(type)
    || (atBat.type === 'flyout' && type === 'sac_fly')
    || (atBat.type === 'groundout' && type === 'sac_bunt');
  if (!noAB) addDelta(batter.id, 'ab', 1);

  if (['single','double','triple','hr'].includes(atBat.type)) {
    addDelta(batter.id, 'h', 1);
    if (atBat.type === 'double') {
      addDelta(batter.id, 'doubles', 1);
      addDelta(batter.id, 'tb', 2);
    } else if (atBat.type === 'triple') {
      addDelta(batter.id, 'tb', 3);
    } else if (atBat.type === 'hr') {
      addDelta(batter.id, 'hr', 1);
      addDelta(batter.id, 'tb', 4);
    } else {
      addDelta(batter.id, 'tb', 1);
    }
  }

  if (atBat.type === 'walk' || atBat.type === 'hbp') {
    addDelta(batter.id, 'bb', 1);
    if (atBat.type === 'hbp') addDelta(batter.id, 'hbp', 1);
  }
  if (atBat.type === 'strikeout') addDelta(batter.id, 'k', 1);

  // Sac fly and sac bunt counters
  if (type === 'sac_fly')  addDelta(batter.id, 'sf',  1);
  if (type === 'sac_bunt') addDelta(batter.id, 'sac', 1);

  if (rbi > 0) addDelta(batter.id, 'rbi', rbi);
  if (atBat.type === 'hr') addDelta(batter.id, 'r', 1); // batter scores on HR

  // Runners who scored
  for (const runnerId of runnerIds) {
    addDelta(runnerId, 'r', 1);
  }

  // ── Pitcher stats ────────────────────────────────────────────
  // IP: every out recorded on the play is charged to the pitcher — the
  // batter's, a double play's second out, the runner forced on a fielder's
  // choice. The caller passes the play's total; the batter's out alone is
  // the fallback.
  const batterOut = type !== 'error' && type !== 'fielders_choice' && _isOut(atBat.type);
  const outsOnPlay = Number.isFinite(outsRecorded) ? outsRecorded : (batterOut ? 1 : 0);
  if (outsOnPlay > 0) addDelta(pitcher.id, 'ip', +(0.333 * outsOnPlay).toFixed(3));
  if (['single','double','triple','hr'].includes(atBat.type)) addDelta(pitcher.id, 'h_allowed', 1);
  if (atBat.type === 'hr') addDelta(pitcher.id, 'hr_allowed', 1);
  if (atBat.type === 'walk' || atBat.type === 'hbp') addDelta(pitcher.id, 'bb', 1);
  if (atBat.type === 'strikeout') addDelta(pitcher.id, 'k', 1);
  // Earned runs: every run that scored, except on an error (unearned) — a
  // run in on a double play is earned though the batter gets no RBI.
  const earned = type === 'error' ? 0 : runsScored;
  if (earned > 0) addDelta(pitcher.id, 'er', earned);

  return deltas;
}

// ─────────────────────────────────────────────────────────────
// PLAY DESCRIPTION BUILDER
// ─────────────────────────────────────────────────────────────

/**
 * Runs that scored on a play (the score and the linescore count these; the
 * batter's RBI can be fewer). Plays saved before r73 carried only `rbi`.
 */
export function playRuns(p) {
  return p?.runs ?? p?.rbi ?? 0;
}

const _HR_CALL = { 1: 'hits a solo home run', 2: 'hits a two-run home run',
                   3: 'hits a three-run home run', 4: 'hits a grand slam' };

/**
 * The play-by-play line: what happened, then the runs it drove in — a
 * home run named for how many it brought home, any other play followed by
 * its RBI (or, with none credited, that a run scored).
 */
function _buildDescription(atBat, batter, pitcher, playMod = null, { rbi = 0, runs = 0, thrownOut = null, players = null } = {}) {
  const bn = batter?.name || 'Batter';
  const type = playMod || atBat.type;
  if (type === 'hr') return `${bn} ${_HR_CALL[runs] || 'homers'}`;
  let base = (atBat.fielder && _fieldCall(atBat, batter, type)) || _basePlayCall(atBat, batter, pitcher, type);
  // r205 §122.83 a runner thrown out on the play: by whom
  if (thrownOut && players?.[thrownOut.id]) {
    const f = atBat.fielder;
    base += ` — ${players[thrownOut.id].name} thrown out at ${thrownOut.at}${f?.slot === 'OF' ? ` by ${f.name}` : ''}`;
  }
  if (rbi > 0)  return `${base}, ${rbi === 1 ? 'RBI' : `${rbi} RBI`}`;
  if (runs > 0) return `${base}, ${runs === 1 ? 'a run scores' : `${runs} runs score`}`;
  return base;
}

/**
 * r205 §122.83 a ball in play, called with its fielder: the out ("grounds out to Ramirez at short"), the
 * error and whose, the double play's relay, and the standout plays — a hit taken away or let through.
 */
function _fieldCall(atBat, batter, type) {
  const bn = batter?.name || 'Batter', f = atBat.fielder, fn = f.name, at = _atWords(f);
  const mid = { SS: ['SS', '2B'], '2B': ['2B', 'SS'], '3B': ['3B', '2B'], '1B': ['1B', 'SS'] }[f.slot];
  switch (type) {
    case 'error': return `${bn} reaches on ${atBat.error === 'throwing' ? `a throwing error by ${fn}` : `an error by ${fn}`} ${at}`;
    case 'groundout':
      if (atBat.conv === 'save' && atBat.gem) { atBat._gemDir = Math.floor(_roll() * 3); return `${fn} ranges ${['far to the right', 'deep into the hole', 'to the left'][atBat._gemDir]} and throws out ${bn} — a hit taken away`; }
      return `${bn} grounds out to ${fn} ${at}`;
    case 'flyout':
      if (atBat.conv === 'save' && atBat.gem) return f.slot === 'OF'
        ? (atBat.was === 'double' ? `${fn} runs it down at the wall — ${bn} robbed of extra bases` : `${fn} makes a diving catch ${at} to rob ${bn}`)
        : `${fn} makes a leaping grab ${at} to rob ${bn}`;
      return f.slot === 'OF' ? `${bn} flies out to ${fn} ${at}` : `${bn} pops out to ${fn} ${at}`;
    case 'double_play': {
      const relay = mid ? [_fielders?.byPos[mid[0]]?.name, _fielders?.byPos[mid[1]]?.name, _fielders?.byPos['1B']?.name] : null;
      return relay && relay.every(Boolean) && new Set(relay).size === 3
        ? `${bn} grounds into a double play — ${relay[0]} to ${relay[1]} to ${relay[2]}` : `${bn} grounds into a double play`;
    }
    case 'single':
      if (atBat.conv === 'cost' && atBat.gem) return f.slot === 'OF' ? `${bn} singles — it drops in front of ${fn}` : `${bn} singles — it gets past a diving ${fn}`;
      return null;
    case 'double':
      if (atBat.conv === 'cost' && atBat.gem) return `${bn} doubles — it gets over ${fn}'s head ${at}`;
      return null;
    default: return null;
  }
}

function _basePlayCall(atBat, batter, pitcher, type) {
  const bn = batter?.name  || 'Batter';
  const pn = pitcher?.name || 'Pitcher';
  switch (type) {
    case 'triple':          return `${bn} triples`;
    case 'double':          return `${bn} doubles`;
    case 'single':          return `${bn} singles`;
    case 'walk':            return atBat.ibb ? `${bn} is intentionally walked` : `${bn} walks`;
    case 'hbp':             return `${bn} hit by pitch`;
    case 'strikeout':       return `${bn} strikeout — ${pn}`;
    case 'groundout':       return `${bn} grounds out`;
    case 'flyout':          return `${bn} flies out`;
    case 'double_play':     return `${bn} — double play`;
    case 'fielders_choice': return `${bn} reaches on fielder's choice`;
    case 'sac_fly':         return `${bn} sacrifice fly`;
    case 'sac_bunt':
      return atBat.subType === 'success'
        ? `${bn} sacrifice bunt`
        : `${bn} bunt — ${pn}`;
    case 'error':           return `${bn} reaches on error`;
    default:                return `${bn} out`;
  }
}

// ─────────────────────────────────────────────────────────────
// TEAM OVR CALCULATORS
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// r205 §122.83 DEFENSE — who's where, and the ball in play
// ─────────────────────────────────────────────────────────────

const _OF_WHERE = ['left', 'center', 'right'];

/**
 * _fieldMap(lineupSlots, starters) — who plays where: { [playerId]: { slot, where } } (the outfielders
 * left, center, right in the lineup's order). Without a lineup's slots (an All-Star squad), each
 * starter takes a position by primary position, the rest DH.
 */
function _fieldMap(lineupSlots, starters) {
  const map = {};
  let of = 0;
  const put = (id, slot) => { map[id] = { slot, where: slot === 'OF' ? _OF_WHERE[of++] || 'center' : null }; };
  if ((lineupSlots || []).length === 9) {
    for (const sl of lineupSlots) if (sl.playerId && sl.slot !== 'DH') put(sl.playerId, sl.slot);
    return map;
  }
  const need = ['C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF'];
  const left = [...(starters || [])];
  for (const slot of need) {
    const i = left.findIndex(p => primaryPos(p) === slot);
    const j = i >= 0 ? i : left.findIndex(p => canPlay(p, slot));
    if (j >= 0) { put(left[j].id, slot); left.splice(j, 1); }
  }
  return map;
}

/**
 * _fieldersOf(lineup, players, norms) — the fielding side now: { byPos: { C, '1B', '2B', '3B', SS, OF: [] } }
 * of { id, name, slot, where, x (exposure), d }. A player who came in for a starter takes the position
 * left open. d = (glove − the league's) / scale, out of position the glove less oopDrop × exposure.
 */
function _fieldersOf(lineup, players, norms) {
  const field = lineup?.field;
  if (!field || !lineup.slots?.length) return null;
  // (against the league's glove at that position: an average first baseman is average)
  const avgAt = (slot) => norms?.defenseBy?.[slot] ?? norms?.defense ?? SIM_RATING_AVG;
  const ids = lineup.slots.map(s => s.id);
  const taken = new Set(), byPos = { OF: [] };
  const place = (p, at) => {
    const A = avgAt(at.slot);
    const glove = _effectiveSR(p, 'defense', playingRating(p, 'defense') ?? A, { coached: false });
    const x = exposure(p, at.slot);
    const d = Math.max(-DS.dMax, Math.min(DS.dMax, (glove - DS.oopDrop * x - A) / DS.scale));
    const f = { id: p.id, name: p.name, slot: at.slot, where: at.where, x, d };
    if (at.slot === 'OF') byPos.OF.push(f); else byPos[at.slot] = f;
  };
  const open = Object.entries(field).filter(([id]) => !ids.includes(id)).map(([, at]) => at);
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    if (field[id]) { place(p, field[id]); taken.add(id); }
  }
  for (const id of ids) {   // (in for a starter: the position the starter left)
    const p = players[id];
    if (!p || taken.has(id) || !open.length) continue;
    // (a DH stays a DH: only someone who took a fielder's spot in the order fields)
    const at = open.shift();
    place(p, at);
  }
  return { byPos };
}

/** A fielder for a ball: the position by the weights (P: the pitcher — nobody's glove), an outfielder at random. */
function _pickFielder(weights) {
  let r = _roll();
  _pickedPos = null;
  for (const [pos, w] of Object.entries(weights)) {
    if ((r -= w) > 0) continue;
    _pickedPos = pos;   // (r226 the pitcher's ball has no fielder object: the spot is kept)
    if (pos === 'P') return null;
    if (pos === 'OF') { const of = _fielders.byPos.OF; return of.length ? of[Math.floor(_roll() * of.length)] : null; }
    return _fielders.byPos[pos] || null;
  }
  return null;
}

/**
 * _fieldPlay(atBat, isUserBatting) — the ball in play goes to a fielder (DEFENSE_SIM): a good glove takes
 * some hits away, a poor one lets some outs through; the outs to it may be errors; the middle infield
 * turns double plays; an outfielder's arm holds or throws out runners. → the at-bat, with { fielder,
 * fielded, error, conv ('save' a hit taken away, 'cost' one let through), gem, dpMult, armMult }.
 */
function _fieldPlay(atBat, isUserBatting) {
  const t = atBat.type;
  if (!['single', 'double', 'groundout', 'flyout'].includes(t)) {
    if (t === 'triple') { const f = _pickFielder({ OF: 1 }); return f ? { ...atBat, fielder: f, at: _spotOf(f) } : atBat; }
    return atBat;
  }
  const ground = t === 'groundout' || (t === 'single' && _roll() < DS.groundSingle);
  const f = t === 'groundout' ? _pickFielder(DS.grounder) : t === 'flyout' ? _pickFielder(DS.fly)
    : t === 'double' ? _pickFielder(DS.double) : _pickFielder(ground ? DS.infieldSingle : { OF: 1 });
  const out = { ...atBat, fielded: true, fielder: f, at: _spotOf(f), ground };   // (r226 where, and on the ground or not)
  const mid = [_fielders.byPos.SS, _fielders.byPos['2B']].filter(Boolean);
  out.dpMult = mid.length ? Math.max(0.75, Math.min(1.25, 1 + DS.dp * mid.reduce((a, x) => a + x.d, 0) / mid.length)) : 1;
  if (!f) return out;
  if (f.slot === 'OF') out.armMult = Math.max(0.75, Math.min(1.3, 1 + DS.arm * f.d));   // (a good arm throws more runners out)
  // Range: hits taken away, or let through.
  if ((t === 'single' || t === 'double') && f.d > 0 && _roll() < DS.range[t] * f.d) {
    out.type = ground && t === 'single' ? 'groundout' : 'flyout';
    out.conv = 'save'; out.was = t; out.gem = _roll() < DS.gem;
  } else if ((t === 'groundout' || t === 'flyout') && f.d < 0 && _roll() < DS.range.out * -f.d) {
    out.type = t === 'flyout' && f.slot === 'OF' && _roll() < 0.25 ? 'double' : 'single';
    out.conv = 'cost'; out.was = t; out.gem = _roll() < DS.gem;
  }
  // Errors: on the outs (the fielder's glove, out of position more, our bench coach).
  if (out.type === 'groundout' || out.type === 'flyout') {
    const k = Math.max(DS.errMin, Math.min(DS.errMax, 1 - DS.errPerD * f.d)) * (1 + DS.oopErr * f.x)
      * (_userFielding && _staff ? _staff.errorMult : 1);   // (our bench coach, with our club in the field)
    if (_roll() < DS.err[out.type] * k) {
      out.error = out.type === 'groundout' && _roll() < 0.45 ? 'throwing' : 'fielding';
      out.conv = null; out.gem = false;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// r226 §122.105 WHERE THE BALL WENT — saved on the play, for the Live View
// ─────────────────────────────────────────────────────────────
// Everything the sim decided is kept as it was decided (who fielded it, which outfielder, on the ground or in the
// air, the gem and its direction, the error, the runner thrown out and where, the double play's relay). Only the
// exact spot is placed — inside what was decided: that fielder's area, the depth the outcome needs (a double to
// the gap or the wall, a sacrifice fly deep enough, a home run over the fence) — from the ball's own stream
// (Dice: the game and the play), so no roll that decides the game is touched.
//   _ball = { at ('P'|'C'|'1B'|'2B'|'3B'|'SS'|'LF'|'CF'|'RF'|null), flight ('ground'|'line'|'fly'|'pop'|'bunt'),
//             angle (degrees from straight away: −45 the third-base line … +45 the first-base line), dist (feet),
//             gem? ('right'|'hole'|'left'|'wall'|'dive'|'leap'|'front'|'over'|'past'), err? ('throwing'|'fielding') }
//   _out  = { id, base } a runner thrown out;  _relay = [ids] the double play's relay

const _OF_SPOT = { left: 'LF', center: 'CF', right: 'RF' };
/** r229 §122.108 the fielders by position, as ids: { C, 1B, 2B, 3B, SS, LF, CF, RF }. */
function _fieldIds(F) {
  const out = {};
  for (const k of ['C', '1B', '2B', '3B', 'SS']) if (F.byPos?.[k]) out[k] = F.byPos[k].id;
  for (const f of F.byPos?.OF || []) out[_OF_SPOT[f.where] || 'CF'] = f.id;
  return out;
}
function _spotOf(f) { return f ? (f.slot === 'OF' ? _OF_SPOT[f.where] || 'CF' : f.slot) : (_pickedPos === 'P' ? 'P' : null); }
const _ANG = { P: 0, C: 0, '1B': 34, '2B': 13, SS: -13, '3B': -34, LF: -28, CF: 0, RF: 28 };
const _IFD = { P: 58, C: 14, '1B': 108, '2B': 142, SS: 142, '3B': 108 };
const _OFS = ['LF', 'CF', 'RF'];
/**
 * The fence at an angle: 330 down the lines, 405 to center. r231 §122.111 a smooth arc (about 383 in the gaps) — it had
 * been straight from each pole to a point in center.
 */
export function fenceAt(angle) { return 330 + 75 * Math.cos(2 * rad2(Math.min(45, Math.abs(angle)))); }
const rad2 = (a) => a * Math.PI / 180;
const _clampA = (a) => Math.max(-44, Math.min(44, a));

function _ballOf(ab, type, key, pitcher, thrownOut) {
  const ball = ab._pre || _placeBall(ab, type, dice(_ballKey || 'game', 'ball', key));   // (r227 a caught fly: placed before the tag-ups)
  const out = {};
  if (ball) out._ball = ball;
  if (thrownOut) out._out = { id: thrownOut.id, base: thrownOut.at };
  if (type === 'double_play' && ab.fielder) {
    const mid = { SS: ['SS', '2B'], '2B': ['2B', 'SS'], '3B': ['3B', '2B'], '1B': ['1B', 'SS'] }[ab.fielder.slot];
    const relay = mid ? [_fielders?.byPos[mid[0]]?.id, _fielders?.byPos[mid[1]]?.id, _fielders?.byPos['1B']?.id] : null;
    if (relay && relay.every(Boolean) && new Set(relay).size === 3) out._relay = relay;
  }
  return out;
}

function _placeBall(ab, type, r) {
  const span = (lo, hi) => lo + r() * (hi - lo);
  const pickW = (w) => { let x = r() * Object.values(w).reduce((a, b) => a + b, 0); for (const [k, v] of Object.entries(w)) { if ((x -= v) <= 0) return k; } return Object.keys(w)[0]; };
  const of = () => _OFS[Math.floor(r() * 3)];
  const keep = (b) => ({ ...b, angle: Math.round(_clampA(b.angle)), dist: Math.round(b.dist),
    ...(ab.error ? { err: ab.error } : {}) });
  if (type === 'hr') {
    const base = pickW({ '-28': 0.37, '0': 0.26, '28': 0.37 });
    const angle = _clampA(Number(base) + span(-12, 12));
    return keep({ at: null, flight: r() < 0.25 ? 'line' : 'fly', angle, dist: fenceAt(angle) + span(8, 55) });
  }
  if (type === 'sac_bunt' || ab.type === 'sac_bunt') {   // (r228 a bunt that went wrong — a double play — is still a bunt)
    const at = pickW({ P: 0.4, '3B': 0.3, '1B': 0.3 });
    return keep({ at, flight: 'bunt', angle: _ANG[at] * 0.7 + span(-4, 4), dist: span(25, 55) });
  }
  // what the ball was before any range or error changed the call
  const t = ab.type;
  if (!['single', 'double', 'triple', 'groundout', 'flyout'].includes(t) && !['double_play', 'fielders_choice', 'sac_fly', 'error'].includes(type)) return null;
  let at = ab.at ?? null;
  const ground = ab.ground ?? (t === 'groundout');
  const isOF = (x) => _OFS.includes(x);
  // ── on the ground, fielded in the infield (an out, a double play, a fielder's choice, an infield single, an error)
  if ((t === 'groundout' || (t === 'single' && ground && !isOF(at) && ab.conv !== 'cost')) && type !== 'sac_fly') {
    at = at || pickW(DS.grounder);
    let angle = _ANG[at] + span(-7, 7), dist = _IFD[at] + span(-10, 10) + (t === 'single' ? 8 : 0);
    let gem = null;
    if (ab.conv === 'save' && ab.gem && ab._gemDir != null) {
      gem = ['right', 'hole', 'left'][ab._gemDir];
      const leftSide = at === 'SS' || at === '3B';
      if (gem === 'right') angle -= 11; else if (gem === 'left') angle += 11; else { angle += leftSide ? -8 : 8; dist += 15; }
    }
    return keep({ at, flight: 'ground', angle, dist, ...(gem ? { gem } : {}) });
  }
  // ── on the ground, through the infield (a single through a hole, or one past a diving infielder — the words say
  //    "gets past a diving …", so on the ground, even when the sim had it in the air)
  if (t === 'single' && (ground || (ab.conv === 'cost' && at && !isOF(at)))) {
    const past = ab.conv === 'cost' && !isOF(at) ? at : null;
    const spot = isOF(at) ? at : past ? ({ SS: 'LF', '3B': 'LF', '2B': 'RF', '1B': 'RF' }[past] || 'CF') : of();
    const angle = past ? _ANG[past] + span(-6, 6) : _ANG[spot] + span(-12, 12);
    return keep({ at: isOF(at) ? at : spot, flight: 'ground', angle, dist: span(150, 205), ...(past && ab.gem ? { gem: 'past' } : {}) });
  }
  // ── in the air
  if (t === 'single') {
    if (!isOF(at) && at) return keep({ at, flight: 'pop', angle: _ANG[at] + span(-8, 8), dist: _IFD[at] + span(15, 45) });
    at = at || of();
    const front = ab.conv === 'cost' && ab.gem;
    const bloop = front || r() < 0.3;
    return keep({ at, flight: bloop ? 'fly' : 'line', angle: _ANG[at] + span(-12, 12), dist: front ? span(185, 215) : bloop ? span(170, 210) : span(180, 240), ...(front ? { gem: 'front' } : {}) });
  }
  if (t === 'flyout' || type === 'sac_fly') {
    at = at || (pickW(DS.fly) === 'OF' ? of() : pickW({ SS: 0.3, '2B': 0.3, '3B': 0.25, '1B': 0.1, C: 0.05 }));
    if (!isOF(at)) {
      const leap = ab.conv === 'save' && ab.gem;
      return keep({ at, flight: leap ? 'line' : 'pop', angle: _ANG[at] + span(-8, 8), dist: at === 'C' ? span(12, 35) : _IFD[at] + span(-10, 30), ...(leap ? { gem: 'leap' } : {}) });
    }
    let angle = _ANG[at] + span(-12, 12);
    const fence = fenceAt(angle);
    if (ab.conv === 'save' && ab.gem) return ab.was === 'double'
      ? keep({ at, flight: 'fly', angle, dist: fence - span(2, 8), gem: 'wall' })
      : keep({ at, flight: 'line', angle, dist: span(195, 240), gem: 'dive' });
    return keep({ at, flight: 'fly', angle, dist: span(225, fence - 10) });   // (r227 caught anywhere from shallow to the track)
  }
  if (t === 'double') {
    if (at && !isOF(at)) {   // down the line, past the corner infielder
      const angle = at === '3B' ? -42 + span(-2, 1) : 42 + span(-1, 2);
      return keep({ at, flight: 'line', angle, dist: span(265, 315) });
    }
    at = at || of();
    const over = ab.conv === 'cost' && ab.gem;
    const line = at !== 'CF' && r() < 0.4;
    const angle = at === 'LF' ? (line ? -41 : -16) + span(-3, 3) : at === 'RF' ? (line ? 41 : 16) + span(-3, 3) : (r() < 0.5 ? -15 : 15) + span(-4, 4);
    const fence = fenceAt(angle);
    return keep({ at, flight: r() < 0.5 ? 'line' : 'fly', angle, dist: over ? fence - span(2, 12) : fence - span(5, 45), ...(over ? { gem: 'over' } : {}) });
  }
  if (t === 'triple') {
    at = at || of();
    const corner = at !== 'CF' && r() < 0.5;
    const angle = at === 'LF' ? (corner ? -42 : -17) + span(-2, 2) : at === 'RF' ? (corner ? 42 : 17) + span(-2, 2) : (r() < 0.5 ? -14 : 14) + span(-4, 4);
    return keep({ at, flight: r() < 0.5 ? 'line' : 'fly', angle, dist: fenceAt(angle) - span(2, 25) });
  }
  return null;
}

/** Where a fielder plays, in words: "at short", "in center". */
function _atWords(f) {
  return f.slot === 'OF' ? `in ${f.where || 'the outfield'}` : ({ C: 'behind the plate', '1B': 'at first', '2B': 'at second', '3B': 'at third', SS: 'at short' })[f.slot] || '';
}

// ─────────────────────────────────────────────────────────────
// TRAVEL FATIGUE (Section 8.13 — Geographic Region)
// ─────────────────────────────────────────────────────────────

/**
 * _computeTravelFatigue(isHome, consecutiveRoadGames, regionCfg)
 * Returns a negative win probability adjustment for road trip fatigue.
 *
 * Fatigue accumulates after travelFatigueThreshold consecutive road games.
 * The per-game penalty and threshold are region-specific constants.
 * West: longer trips, more fatigue. East: shorter hops, less fatigue.
 *
 * Returns 0 on home games or when below the threshold.
 *
 * @param {Boolean} isHome
 * @param {Number}  consecutiveRoadGames
 * @param {Object}  regionCfg  — from REGIONS[region]
 * @returns {Number} win probability adjustment (0 or negative)
 */
function _computeTravelFatigue(isHome, consecutiveRoadGames, regionCfg) {
  if (isHome) return 0;
  const threshold   = regionCfg.travelFatigueThreshold ?? 4;
  const perGame     = regionCfg.travelFatiguePerGame   ?? 0.002;
  const gamesOverThreshold = Math.max(0, consecutiveRoadGames - threshold);
  // Penalty increases linearly per game beyond threshold — negative modifier
  return -(gamesOverThreshold * perGame);
}

function _teamOvr(rosterIds, players) {
  const active = rosterIds
    .map(id => players[id])
    .filter(p => p && isAvailable(p));

  const hitters  = active.filter(p => [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group));
  const starters = active.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS);
  const bullpen  = active.filter(p => [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(p.group));

  const avg = arr => arr.length ? arr.reduce((s, p) => s + (p.ovr || 55), 0) / arr.length : 55;

  return (avg(hitters)  * SIM_HITTER_OVR_WEIGHT)
       + (avg(starters) * SIM_SP_OVR_WEIGHT)
       + (avg(bullpen)  * SIM_BP_OVR_WEIGHT);
}

function _opponentOvr(team, players) {
  if (!team || !team.rosterIds) return 55;
  return _teamOvr(team.rosterIds, players);
}

// ─────────────────────────────────────────────────────────────
// FIELD CONDITION MODIFIER
// ─────────────────────────────────────────────────────────────

function _fieldConditionMod(fieldCondition, weatherPlays = false) {
  if (!fieldCondition) return 1.0;
  // (With the weather plan the temperature comes in through the park report, §102.2.)
  const { infieldSoftness = 0, moundFirmness = 1 } = fieldCondition;
  const temperature = weatherPlays ? 72 : (fieldCondition.temperature ?? 72);
  // Soft infield: slightly more groundout outs, less offense
  // Hot: more offense (ball carries)
  // Cold: less offense
  let mod = 1.0;
  if (infieldSoftness > 0.3) mod -= 0.02;
  if (moundFirmness < 0.7)   mod -= 0.01;
  if (temperature > 85)      mod += 0.03;
  if (temperature < 50)      mod -= 0.03;
  return _clamp(mod, 0.90, 1.10);
}

// ─────────────────────────────────────────────────────────────
// gmRelationship VARIANCE
// ─────────────────────────────────────────────────────────────

function _gmRelVariance(gmRel) {
  if (gmRel === null || gmRel === undefined) return 1.0;
  if (gmRel < SIM_GM_REL_LOW_THRESHOLD) {
    // Increased variance: random ±15% on outcomes
    return 1.0 + (_roll() < 0.5 ? SIM_GM_REL_LOW_VARIANCE : -SIM_GM_REL_LOW_VARIANCE);
  }
  if (gmRel > SIM_GM_REL_HIGH_THRESHOLD) {
    // Consistency bonus: −15% variance (closer to 1.0)
    return 1.0 - (SIM_GM_REL_HIGH_CONSISTENCY * (_roll() * 0.5));
  }
  return 1.0;
}

// ─────────────────────────────────────────────────────────────
// EFFECTIVE SUB-RATING (applies injury penalty)
// ─────────────────────────────────────────────────────────────

// §112.2 The GM's coaching staff in this game (CoachEngine.staffEffects), set
// when a game is simulated: rating points our players get from their coaches.
let _staff = null;
let _simAt = null;   // r161 the game's first pitch (a pitcher's workload is read as of then)
let _fieldDef = null;          // r165 §122.35 the fielding side's defense this half (defenseOf)
let _runBat = null;            // r169 the batting side's running game this half (Strategy.runStyle)
let _userFielding = false;   // our club is in the field this half (the bench coach's defense)
let _fielders = null;        // r205 §122.83 the fielding side this half: { C: f, SS: f, …, OF: [f, f, f] } (_fieldersOf)
let _ballKey = '';           // r226 §122.105 this game, for the ball's own stream (_placeBall)
let _pickedPos = null;       // r226 the spot _pickFielder chose (the pitcher has no fielder object)
function _coachPoints(player, key) {
  if (!_staff || player?.teamId !== 'user') return 0;
  if (key === 'contact' || key === 'power' || key === 'speed') return _staff.bat?.[key] || 0;
  return (player.pos === 'RP' ? _staff.rp : _staff.sp)?.[key] || 0;
}

function _effectiveSR(player, subRatingKey, baseValue, { coached = true } = {}) {
  if (baseValue === null || baseValue === undefined) return 55; // neutral fallback
  let v = baseValue;
  if (coached) v += _coachPoints(player, subRatingKey);
  if (player?.injuryPenalty?.subRating === subRatingKey) v -= player.injuryPenalty.amount || 0;
  // §71: playing sick or hurt — a temporary dip for a few games.
  if (player?.condition?.subRating === subRatingKey) v -= player.condition.amount || 0;
  // r159 §122.31 a worn-down hitter (every club alike): the bat slows.
  if ((subRatingKey === 'contact' || subRatingKey === 'power') && (player?.wear || 0) >= WEAR.tired)
    v -= Math.min(WEAR.dipMax, WEAR.dip + Math.floor((player.wear - WEAR.tired) / WEAR.dipStep));
  // r161 §122.33 a worn arm (every club alike): stuff and control dip the same way.
  if ((subRatingKey === 'stuff' || subRatingKey === 'control') && player?.load && _simAt) {
    const load = armLoad(player, _simAt);
    if (load >= WEAR.tired) v -= Math.min(WEAR.dipMax, WEAR.dip + Math.floor((load - WEAR.tired) / WEAR.dipStep));
  }
  return Math.max(40, v);
}

// ─────────────────────────────────────────────────────────────
// GAME OVER CHECK
// ─────────────────────────────────────────────────────────────

function _gameOver(gs) {
  // While-guard, evaluated BEFORE an inning is played: gs.inning is the inning
  // about to start. Regulation is 9 complete innings, so the game can only be
  // over once inning 10+ is about to start. (This used to test `< 9`, which ended
  // every spring game — and every non-tied regular game — after 8 innings.)
  // Primary termination is the loop breaks; this mirrors them.
  if (gs.inning <= 9) return false;
  if (gs.isSpring) return true;
  if (gs.userScore !== gs.oppScore) return true;
  return gs.inning > SIM_MAX_INNINGS_GUARD;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _isOut(type) {
  // Types where the BATTER is put out (not counting extraOuts from runners)
  return ['groundout','flyout','strikeout','sac_bunt','caught_stealing'].includes(type);
}

function _roll() {
  return _rand();
}

function _rng(lo, hi) {
  return lo + Math.floor(_rand() * (hi - lo + 1));
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
