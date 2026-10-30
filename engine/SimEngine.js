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
  SIM_H_SPEED_TAG_THRESHOLD,
  SIM_THROWOUT_PLATE_BASE,
  SIM_THROWOUT_EXTRA_BASE,
  SIM_SPEED_THROWOUT_DIVISOR,
  SIM_SB_BASE_SUCCESS,
  SIM_SB_SPEED_BONUS_DIVISOR,
  SIM_SB_ATTEMPT_PROB,
  SIM_FC_PROB,
  SIM_DP_PROB,
  SIM_ERROR_PROB,
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

import { computeOVR, isAvailable } from './PlayerFactory.js';
import {
  ROLE, bullpenRoles, chooseReliever, starterRested, armStatus, tireAfterBF, reliefInnings,
} from './PitchingEngine.js';
import { PITCH_HOOK_EXTRA_BF, PITCH_SHELLED_RUNS, PITCH_SHELLED_EARLY_RUNS } from '../data/constants.js';

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
  const { isSpring = false, phase = PHASE.REGULAR_SEASON, norms = null, exhibition = false, scout = null } = context;
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
  const userSP  = _getRotationSP(userTeam, players, atMs);
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
    { game, fieldMod, isHome: game.isHome, phase, isSpring, norms, atMs, scout, wx,
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
  // A suspended game: what's played today, and the rest — played when it
  // resumes (its clock is set then; GameEngine).
  const split = allPlays.findIndex(p => p.type === 'game_suspended');
  const plays       = split >= 0 ? allPlays.slice(0, split + 1) : allPlays;
  const resumePlays = split >= 0 ? allPlays.slice(split + 1) : null;

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

  return { plays, boxScore, liveLineups, resumePlays, weather };
}

// ─────────────────────────────────────────────────────────────
// FULL GAME SIMULATION
// ─────────────────────────────────────────────────────────────

function _simulateFullGame(userLineup, oppLineup, userSP, oppSP, players, ctx) {
  const { game, fieldMod, isHome, phase, isSpring, norms = null, exhibition = null, atMs = 0, scout = null, wx = null } = ctx;

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
    userUsed:  new Set([userSP?.id].filter(Boolean)), oppUsed: new Set([oppSP?.id].filter(Boolean)),
    userRole:  ROLE.STARTER, oppRole: ROLE.STARTER,
    userTireAt: exhibition ? Infinity : tireAfterBF(userSP && players[userSP.id], true),
    oppTireAt:  exhibition ? Infinity : tireAfterBF(oppSP && players[oppSP.id], true),
    userTarget: _pitcherTargetInnings(userSP && players[userSP.id], { exhibition }),
    oppTarget:  _pitcherTargetInnings(oppSP && players[oppSP.id], { exhibition }),
    userRuns: 0, oppRuns: 0,
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
    gs.halfIdx = (gs.inning - 1) * 2 + (isTop ? 0 : 1);
    gs.env = _envFor(gs.wx, gs.halfIdx);
    const hp = _simulateHalfInning(
      userBats ? userLineup.slots : oppLineup.slots, userBats ? userLineup.bench : oppLineup.bench,
      userBats ? gs.oppPitcher : gs.userPitcher, gs, players, fieldMod * gs.env.hitMod,
      userBats, isSpring, `${isTop ? 'TOP' : 'BOT'}_${gs.inning}`, userBats ? 'userLineupIdx' : 'oppLineupIdx',
      gs.inning, walkoffRuns, resume);
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
    gs.ruling = _calledRuling(gs, plays, { isTop, userBatsBottom, exhibition: !!(isSpring || exhibition), playoff: !!game?.isPlayoff });
    if (gs.ruling.outcome === 'final') return true;
    // Suspended. Nobody pitches on through a suspension: both clubs start the
    // resumption with fresh arms. It picks up exactly where it stopped.
    plays.push(_suspendedPlay(st, gs, plays));
    gs.wx = null;
    for (const side of ['user', 'opp']) { gs[`${side}Fatigued`] = true; gs[`${side}MustGo`] = true; }
    const userBats = isTop ? !userBatsBottom : userBatsBottom;
    const fieldSide = userBats ? 'opp' : 'user';
    _midHalfChange(gs, players, fieldSide, plays, gs.inning, isTop ? 'TOP' : 'BOT', st.outs, st.bases);
    runHalf(isTop, walkoffRuns, { outs: st.outs, bases: st.bases, halfRuns: st.halfRuns });
    return false;
  };

  while (!_gameOver(gs)) {
    // Top of inning — away team bats. The home side takes the field: a tired
    // pitcher is replaced now, as he walks out (never at the end of his last
    // inning — the game may be over before he'd have pitched again).
    _checkPitcherChange(gs, players, userBatsBottom ? 'user' : 'opp', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning, 'TOP');
    runHalf(true);
    if (afterStop(true, Infinity)) break;

    _accrueInningAndFatigue(gs, players, userBatsBottom ? 'user' : 'opp');

    // 9th inning or later: if the HOME team already leads after the top half,
    // the bottom half is not played (home team wins).
    if (gs.inning >= 9 && homeScore() > awayScore()) break;

    // Bottom of inning — home team bats; the away side takes the field.
    _checkPitcherChange(gs, players, userBatsBottom ? 'opp' : 'user', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning, 'BOT');

    // 9th inning or later: the bottom half ends the moment the home team takes
    // the lead (walk-off). Pass the number of runs that wins it.
    const walkoffRuns = gs.inning >= 9 ? (awayScore() - homeScore() + 1) : Infinity;
    runHalf(false, walkoffRuns);
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
function _attemptStolenBase(bases, players, outs, inning, gs) {
  // Pick the lead runner eligible for stealing
  // Runner on second stealing third is slightly less common than 1st→2nd
  let runnerId   = null;
  let fromBase   = null;
  let toBase     = null;

  if (bases.second && !bases.third) {
    const runner = players[bases.second];
    const spd    = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
    if (spd >= SIM_H_SPEED_SB_THRESHOLD && _roll() < SIM_SB_ATTEMPT_PROB * 0.7) {
      runnerId = bases.second; fromBase = 'second'; toBase = 'third';
    }
  } else if (bases.first && !bases.second) {
    const runner = players[bases.first];
    const spd    = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
    if (spd >= SIM_H_SPEED_SB_THRESHOLD && _roll() < SIM_SB_ATTEMPT_PROB) {
      runnerId = bases.first; fromBase = 'first'; toBase = 'second';
    }
  }

  if (!runnerId) return null;

  const runner   = players[runnerId];
  const spd      = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
  const success  = _roll() < (SIM_SB_BASE_SUCCESS + (spd / SIM_SB_SPEED_BONUS_DIVISOR));

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
      description:  `${runner?.name || 'Runner'} caught stealing ${toBase}`,
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
    const pitcherTired = gs[`${pSide}PitchCount`] >= gs[`${pSide}TireAt`];
    const atBat = simulateAtBat(activeBatter, pitcher, bases, outs, players, fieldMod,
      { inning, isSpring, norms: gs.norms, pitcherTired,
        scoutHit: gs.scout ? (isUserBatting ? gs.scout.bat : gs.scout.pitch) : 1,
        hrMod: gs.env?.hrMod, hitEnv: gs.env?.hitMod, walkMod: gs.env?.walkMod });
    // Increment the THROWING pitcher's batters-faced count. When the user is
    // batting the opponent is pitching (and vice-versa) — this must match the
    // fatigue check below, which reads the same throwing-pitcher counter.
    gs[isUserBatting ? 'oppPitchCount' : 'userPitchCount']++;

    let { newBases, runsScored, runnerIds, extraOuts, playMod } =
      _advanceBases(bases, atBat, activeBatter, players, outs);
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

    const effectiveType = playMod || atBat.type;
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
      && _isOut(atBat.type);
    const outsBefore = outs;
    if (batterIsOut) outs++;
    if (extraOuts > 0) outs = Math.min(3, outs + extraOuts);

    const deltas = _buildStatDeltas(atBat, activeBatter, pitcher, rbi, runsScored,
      runnerIds, effectiveType, outs - outsBefore);

    plays.push({
      playIndex:    0,
      _halfInning:  halfKey,
      inning:       parseInt(halfKey.split('_')[1]) || 1,
      half:         halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
      batterId:     activeBatter.id,
      pitcherId:    pitcher.id,
      type:         effectiveType,
      description:  _buildDescription(atBat, activeBatter, pitcher, playMod, { rbi, runs: runsScored }),
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
  const sum = { contact: 0, power: 0, speed: 0, stuff: 0, control: 0 };
  let nh = 0, np = 0;
  const ok = (p) => p && isAvailable(p);
  for (const t of teams || []) {
    for (const sl of t.lineupSlots || []) {
      const p = players[sl.playerId];
      if (!ok(p)) continue;
      sum.contact += _effectiveSR(p, 'contact', p.subRatings?.contact);
      sum.power   += _effectiveSR(p, 'power',   p.subRatings?.power);
      sum.speed   += _effectiveSR(p, 'speed',   p.subRatings?.speed);
      nh++;
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
      sum.stuff   += w * _effectiveSR(p, 'stuff',   p.subRatings?.stuff);
      sum.control += w * _effectiveSR(p, 'control', p.subRatings?.control);
      np += w;
    }
  }
  if (!nh || !np) return null;
  return {
    contact: sum.contact / nh, power: sum.power / nh, speed: sum.speed / nh,
    stuff:   sum.stuff / np,   control: sum.control / np,
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
  const sr  = batter.subRatings  || {};
  const psr = pitcher.subRatings || {};

  // Apply injury penalty if active
  const contact  = _effectiveSR(batter,  'contact',  sr.contact);
  const power    = _effectiveSR(batter,  'power',    sr.power);
  const speed    = _effectiveSR(batter,  'speed',    sr.speed);
  const stuff    = _effectiveSR(pitcher, 'stuff',    psr.stuff);
  const control  = _effectiveSR(pitcher, 'control',  psr.control);

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
  const A  = SIM_RATING_AVG;
  const Ac = N.contact ?? A, Ap = N.power ?? A, As = N.speed ?? A;
  const Ast = N.stuff ?? A, Act = N.control ?? A;
  const r = _roll();

  // 1. Walk — control below average → more walks
  const walkProb = _clamp(SIM_PA_WALK_BASE + (Act - control) * SIM_PA_WALK_PER_PT,
                          SIM_PA_WALK_MIN, SIM_PA_WALK_MAX) * fatigueWalkMod * pitcherMod
                 * (context.walkMod ?? 1);   // §102.2 a wet or cold ball
  if (r < walkProb) return { type: 'walk' };

  let pos = walkProb;

  // 2. HBP
  const hbpProb = control < SIM_P_CONTROL_HBP_THRESHOLD ? 0.012 : 0.008;
  if (r < pos + hbpProb) return { type: 'hbp' };
  pos += hbpProb;

  // 3. Strikeout — stuff vs contact
  const kProb = _clamp(SIM_PA_K_BASE
                       + (Ac - contact) * SIM_PA_K_PER_CONTACT_PT
                       + (stuff - Ast)  * SIM_PA_K_PER_STUFF_PT,
                       SIM_PA_K_MIN, SIM_PA_K_MAX) * fatigueKMod * pitcherMod * batterMod;
  if (r < pos + kProb) return { type: 'strikeout' };
  pos += kProb;

  // 4. Hit vs out — contact vs stuff, plus speed-driven infield hits
  const hitProb = _clamp(SIM_PA_HIT_BASE
                         + (contact - Ac) * SIM_PA_HIT_PER_CONTACT_PT
                         - (stuff - Ast)  * SIM_PA_HIT_PER_STUFF_PT,
                         SIM_PA_HIT_MIN, SIM_PA_HIT_MAX) * fatigueHitMod * batterMod * envMod
                         * (context.scoutHit ?? 1);   // §90 advance scouting: our hitters know what's coming
  const infieldBonus = Math.max(0, (speed - As) * SIM_PA_INFIELD_HIT_PER_SPEED_PT);
  const adjHitProb   = Math.min(0.45, hitProb + infieldBonus);

  if (r >= pos + adjHitProb) {
    // Out — groundout vs flyout split
    const groundoutProb = 0.55; // slight groundout lean
    return { type: Math.random() < groundoutProb ? 'groundout' : 'flyout' };
  }

  // 5. Hit type: HR / triple / double / single — power sets the extra-base share
  const hrShare  = _clamp(SIM_HIT_HR_SHARE_BASE + (power - Ap) * SIM_HIT_HR_SHARE_PER_PT,
                          SIM_HIT_HR_SHARE_MIN, SIM_HIT_HR_SHARE_MAX)
                   * (context.hrMod != null ? context.hrMod * (envMod / (context.hitEnv ?? envMod)) : envMod);   // §102.2 temperature and wind carry the ball
  const xbhShare = _clamp(SIM_HIT_XBH_SHARE_BASE + (power - Ap) * SIM_HIT_XBH_SHARE_PER_PT,
                          SIM_HIT_XBH_SHARE_MIN, SIM_HIT_XBH_SHARE_MAX);
  const tripleShare = SIM_HIT_TRIPLE_SHARE * _clamp(speed / As, 0.5, 1.8);

  const hitRoll = _roll();
  if (hitRoll < hrShare)                          return { type: 'hr' };
  if (hitRoll < hrShare + tripleShare)            return { type: 'triple' };
  if (hitRoll < hrShare + tripleShare + xbhShare) return { type: 'double' };
  return { type: 'single' };
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
function _advanceBases(bases, atBat, batter, players, outs = 0) {
  const speed = _effectiveSR(batter, 'speed', batter.subRatings?.speed);
  let newBases   = { first: bases.first, second: bases.second, third: bases.third };
  let runsScored = 0;
  const runnerIds = [];
  let extraOuts  = 0;
  let playMod    = null; // override play type if needed

  // Helper: probability of being thrown out based on runner speed
  const throwoutProb = (baseProb, runnerSpeed) =>
    Math.max(0.05, baseProb - (runnerSpeed / SIM_SPEED_THROWOUT_DIVISOR));

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
        const rs     = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
        if (rs >= SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD) {
          if (_roll() < throwoutProb(SIM_THROWOUT_PLATE_BASE, rs)) {
            // Thrown out at plate — runner out, batter ends on second
            newBases = { first: null, second: batter.id, third: null };
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
        const rs     = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
        if (_roll() < throwoutProb(SIM_THROWOUT_PLATE_BASE, rs)) {
          extraOuts++;         // thrown out at plate
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
        const rs     = _effectiveSR(runner, 'speed', runner?.subRatings?.speed) || 50;
        if (rs >= SIM_H_SPEED_STRETCH_THRESHOLD) {
          // Tries for third — throw-out check
          if (_roll() < throwoutProb(SIM_THROWOUT_EXTRA_BASE, rs)) {
            extraOuts++;         // thrown out at third
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

      // Error check — before anything else
      if (_roll() < SIM_ERROR_PROB) {
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
        if (_roll() < SIM_DP_PROB) {
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
          // Fielder's choice — the runner from first is forced out at second,
          // the batter reaches first. The batter is not out (playMod tells the
          // half-inning loop), but the play records ONE out: the runner's.
          // Runners ahead move up on the force; the runner on third scores
          // (fewer than two outs here).
          playMod   = 'fielders_choice';
          extraOuts = 1;
          if (bases.third) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  batter.id,
            second: null,
            third:  bases.second || null,
          };
          break;
        } else {
          // Standard groundout — batter out at first, every runner moves up a base
          if (bases.third) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  null,
            second: bases.first,
            third:  bases.second || null,
          };
        }
      } else {
        // No one on first — standard groundout
        if (bases.third && outs < 2) { runsScored++; runnerIds.push(bases.third); }
        // Runners hold (no force)
        newBases = { ...bases };
      }
      break;
    }

    // ── FLYOUT ───────────────────────────────────────────────────
    case 'flyout': {
      // Tag-up logic: runners can advance after catch if fast enough
      // Third: tag-up to score (sac fly)
      if (bases.third) {
        const runner3 = players[bases.third];
        const rs3 = _effectiveSR(runner3, 'speed', runner3?.subRatings?.speed) || 50;
        if (rs3 >= SIM_H_SPEED_TAG_THRESHOLD) {
          runsScored++;
          runnerIds.push(bases.third);
          newBases.third = null;
          if (runsScored > 0) playMod = 'sac_fly'; // will be used for stat purposes
        }
      }
      // Second: can tag up to third on a deep fly
      if (bases.second && outs < 2) {
        const runner2 = players[bases.second];
        const rs2 = _effectiveSR(runner2, 'speed', runner2?.subRatings?.speed) || 50;
        // 50% chance runner on second tries to advance to third on deep fly
        if (rs2 >= 60 && _roll() < 0.50) {
          if (_roll() < throwoutProb(SIM_THROWOUT_EXTRA_BASE, rs2)) {
            extraOuts++; // thrown out at third
            newBases.second = null;
          } else {
            newBases.third  = bases.second;
            newBases.second = null;
          }
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

  return { newBases, runsScored, runnerIds, extraOuts, playMod };
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
  const PIT0 = () => ({ outs:0, h:0, hr:0, bb:0, k:0, er:0, w:0, l:0, sv:0, hld:0 });
  const mkSide = () => ({ hit:{}, pit:{}, hitSeen:[], pitSeen:[] });

  const away = mkSide();
  const home = mkSide();
  const linescore = {};

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
    if (!play._statDeltas) continue;
    const isTop        = play.half === 'TOP';
    const battingSide  = isTop ? away : home;   // TOP = away bats
    const fieldingSide = isTop ? home : away;

    for (const [pid, statList] of Object.entries(play._statDeltas)) {
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
      return { id, name: p.name || '—', pos: p.pos || p.nativePos || '', ...s };
    });
    const pitchers = side.pitSeen.map(id => {
      const s = side.pit[id];
      const p = players[id] || {};
      const dec = s.w ? 'W' : s.l ? 'L' : s.sv ? 'S' : s.hld ? 'H' : null;
      return { id, name: p.name || '—', ip: ipFromOuts(s.outs), ipOuts: s.outs, h: s.h, er: s.er, bb: s.bb, k: s.k, hr: s.hr, dec };
    });
    return {
      runs:   hitters.reduce((a, h) => a + h.r, 0),
      hits:   hitters.reduce((a, h) => a + h.h, 0),
      errors: 0,
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
  slots[slotIdx] = { id: sub.id, subbed: false };
  return {
    playIndex: 0, batterId: sub.id, pitcherId: null, type: 'pinch_hit',
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

  // Don't sub out a player who is already a sub (bench player already in)
  const currentPlayer = players[slots[slotIdx].id];
  if (!currentPlayer) return null;
  if (currentPlayer.group === PLAYER_GROUP.BENCH_HITTERS) return null;

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

  slots[slotIdx]    = { id: benchCandidate.id, subbed: false };
  benchCandidate.used = true;

  // Return a pinch_hit play — displayed in PBP, no stat deltas
  return {
    playIndex:    0,
    batterId:     benchCandidate.id,
    pitcherId:    null,
    type:         'pinch_hit',
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
// PITCHER CHANGE LOGIC
// ─────────────────────────────────────────────────────────────

// Target innings for the current pitcher, by role + stamina. Starters ~5–8 IP,
// relievers ~1–2 IP. Keyed to innings (not batters) so the hook doesn't drift
// with how much offense a game happens to produce.
function _pitcherTargetInnings(pitcher, gs = null) {
  if (gs?.exhibition) return gs.exhibition.starterIds.has(pitcher?.id) ? ALLSTAR_STARTER_INNINGS : 1;
  const stam = pitcher?.subRatings?.stamina ?? 60;
  const isRP = pitcher?.group === PLAYER_GROUP.BULLPEN
            || pitcher?.group === PLAYER_GROUP.PITCHER_BENCH;
  if (isRP) return Math.max(1, Math.round(1 + (stam - 40) / 25)); // ~1–2 IP
  return Math.max(4, Math.round(5 + (stam - 50) / 12));           // ~5–8 IP
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
    if (pick && !pick.wanted && !gs[`${side}MustGo`] && !closerCall) {
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
  gs[`${side}Target`] = gs.exhibition ? _pitcherTargetInnings(rp, gs) : reliefInnings(role);

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
    cumOurScore:   prev?.cumOurScore   ?? 0,
    cumTheirScore: prev?.cumTheirScore ?? 0,
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
      cur = { id: play.pitcherId, outs: 0, entryLead: prevPlay ? lead(prevPlay, side) : 0, firstIdx: play.playIndex };
      list.push(cur);
    }
    const outsAfter = Number.isFinite(play.outsAfter) ? play.outsAfter : prevOuts;
    cur.outs += Math.max(0, outsAfter - prevOuts);
    cur.lastIdx = play.playIndex;
    cur.exitLead = lead(play, side);
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
  return out;
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP ASSIGNMENT
// ─────────────────────────────────────────────────────────────

/**
 * _assignTimestamps(plays, game, wx, gameState)
 * The clock for every play (§102.2). A game is paced by its progress: ten
 * playing minutes a half-inning, spread by outs (nine innings ≈ three hours;
 * a walk-off ends early, extra innings run long). The weather's delays sit at
 * exactly the moments its plan has them, and add their length to everything
 * after. Each play also gets `_playMin` (playing minutes). A suspended game's
 * plays after the suspension get no clock here (`_resumeMin` instead): it's
 * set when the game resumes.
 */
function _assignTimestamps(plays, game, wx, gameState) {
  const HALF = GAME_WEATHER.HALF_MIN, MIN = 60_000;
  const startAt = wx ? wx.startAt : (game.gameTime || 0);
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
    let t = startAt + m[i] * MIN + add;
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
           env: weather.conditions || [], log: [] };
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
      for (const side of ['user', 'opp']) { gs[`${side}Fatigued`] = true; gs[`${side}MustGo`] = true; }
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
  const eligible = (p, label) => {
    if (label === 'DH') return true;               // anyone can DH
    const nat = p.nativePos || p.pos;
    return nat === label || (nat.includes('/') && nat.split('/').includes(label));
  };
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
  const orderedStarters = isCPU && !team.isAllStar
    ? [...starterPlayers].sort((a,b) => b.ovr - a.ovr)
    : _simDeriveBattingOrder(starterPlayers);

  // §75 All-Star squad: the bench and staff are the squad's own (named), not
  // roster groups — selected starters and relievers both pitch in relief.
  if (team.isAllStar) {
    const ok = (id) => players[id] && isAvailable(players[id]);
    const subs = team.simSubs || {};
    return {
      slots:   orderedStarters.map(p => ({ id: p.id, subbed: false,
                                           subIn: subs[p.id]?.inId || null, subInning: subs[p.id]?.inning || null })),
      bench:   (team.simBench || []).filter(ok).map(id => ({ id, used: false })),
      bullpen: (team.simBullpen || []).filter(ok).map(id => ({ id })),
    };
  }

  const bench = rosterIds
    .map(id => players[id])
    .filter(p =>
      p &&
      isAvailable(p) &&
      p.group === PLAYER_GROUP.BENCH_HITTERS
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
  };
}

/**
 * _simDeriveBattingOrder(players)
 * Baseball-realistic batting order for the sim lineup.
 * Mirrors DashboardScreen._deriveBattingOrder — kept separate to avoid
 * cross-module import (SimEngine is a pure engine with no UI dependencies).
 */
function _simDeriveBattingOrder(pool) {
  if (!pool || !pool.length) return [];
  const p9 = pool.slice(0, 9);

  const leadoffScore = p => ((p.subRatings?.contact || p.ovr) * 0.55)
                           + ((p.subRatings?.speed   || 50)   * 0.45);
  const powerScore   = p =>   p.subRatings?.power   || p.ovr;
  const overallScore = p =>   p.ovr;

  const byLeadoff = [...p9].sort((a,b) => leadoffScore(b) - leadoffScore(a));
  const byPower   = [...p9].sort((a,b) => powerScore(b)   - powerScore(a));
  const byOverall = [...p9].sort((a,b) => overallScore(b) - overallScore(a));

  const used = new Set();
  const pick = arr => { const p = arr.find(x => !used.has(x.id)); if (p) used.add(p.id); return p; };

  const s1 = pick(byLeadoff);
  const s2 = pick(byLeadoff);
  const s3 = pick(byOverall);
  const s4 = pick(byPower);
  const s5 = pick(byPower);
  const rest = byOverall.filter(p => !used.has(p.id));

  return [s1, s2, s3, s4, s5, ...rest].filter(Boolean);
}

function _buildCPULineup(team, players) {
  if (!team) return { slots: [], bench: [] };
  return _buildLineup(team, players, true);
}

function _getRotationSP(team, players, atMs = null) {
  if (team.simStarter && players[team.simStarter] && isAvailable(players[team.simStarter])) return { id: team.simStarter };
  const rotation = team.rotation;
  if (!rotation || !rotation.order || rotation.order.length === 0) {
    // Fallback: find any healthy SP
    return _findHealthySP(team.rosterIds || [], players);
  }
  // The starter in turn — unless he hasn't had his four days (a doubleheader,
  // a makeup game): then the next man in the rotation who has (§76).
  const n = rotation.order.length;
  const ready = (id) => players[id] && isAvailable(players[id]) && (atMs == null || starterRested(players[id], atMs));
  for (let k = 0; k < n; k++) {
    const id = rotation.order[(rotation.currentIndex + k) % n];
    if (ready(id)) return { id };
  }
  const spId = rotation.order[rotation.currentIndex % n];
  if (players[spId] && isAvailable(players[spId])) return { id: spId };
  return _findHealthySP(team.rosterIds || [], players);
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
function _buildDescription(atBat, batter, pitcher, playMod = null, { rbi = 0, runs = 0 } = {}) {
  const bn = batter?.name || 'Batter';
  const type = playMod || atBat.type;
  if (type === 'hr') return `${bn} ${_HR_CALL[runs] || 'homers'}`;
  const base = _basePlayCall(atBat, batter, pitcher, type);
  if (rbi > 0)  return `${base}, ${rbi === 1 ? 'RBI' : `${rbi} RBI`}`;
  if (runs > 0) return `${base}, ${runs === 1 ? 'a run scores' : `${runs} runs score`}`;
  return base;
}

function _basePlayCall(atBat, batter, pitcher, type) {
  const bn = batter?.name  || 'Batter';
  const pn = pitcher?.name || 'Pitcher';
  switch (type) {
    case 'triple':          return `${bn} triples`;
    case 'double':          return `${bn} doubles`;
    case 'single':          return `${bn} singles`;
    case 'walk':            return `${bn} walks`;
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

function _effectiveSR(player, subRatingKey, baseValue) {
  if (baseValue === null || baseValue === undefined) return 55; // neutral fallback
  let v = baseValue;
  if (player?.injuryPenalty?.subRating === subRatingKey) v -= player.injuryPenalty.amount || 0;
  // §71: playing sick or hurt — a temporary dip for a few games.
  if (player?.condition?.subRating === subRatingKey) v -= player.condition.amount || 0;
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
  return Math.random();
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
