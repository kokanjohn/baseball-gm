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
  SIM_H_CONTACT_HIT_DIVISOR,
  SIM_H_CONTACT_K_DIVISOR,
  SIM_H_POWER_HR_DIVISOR,
  SIM_H_POWER_XBH_DIVISOR,
  SIM_H_SPEED_SB_THRESHOLD,
  SIM_H_SPEED_INFIELD_DIVISOR,
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
  SIM_P_STUFF_K_BONUS_DIVISOR,
  SIM_P_STUFF_HIT_QUALITY_DIVISOR,
  SIM_P_CONTROL_WALK_BASELINE,
  SIM_P_CONTROL_WALK_DIVISOR,
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
} from '../data/constants.js';

import { computeOVR } from './PlayerFactory.js';

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
  const { isSpring = false, phase = PHASE.REGULAR_SEASON } = context;

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
  const userSP  = _getRotationSP(userTeam, players);
  const oppSP   = _getRotationSP(effectiveOppTeam, players) || _findHealthySP(effectiveOppTeam.rosterIds || [], players);

  // Field condition modifiers
  const fieldMod = _fieldConditionMod(game.fieldCondition);
  const scoringMod = game.weather?.scoringMod ?? 1.0;

  // Run the full game simulation
  const gameState = _simulateFullGame(
    userLineup, oppLineup,
    userSP, oppSP,
    players,
    { game, fieldMod, scoringMod, isHome: game.isHome, phase, isSpring }
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
  const announcement = `${moundName} takes the mound.`;

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

  // Assign real-world timestamps to each play
  const plays = _assignTimestamps(
    [announcementPlay, ...gameState.plays],
    game.gameTime, game._tickOffset || 0
  );

  // Post-process: assign W/L/SV/HD decisions to user team pitchers
  // These are game-outcome stats that can't be determined mid-play.
  const decisionDeltas = _assignPitcherDecisions(
    plays, gameState.userScore, gameState.oppScore, game.isHome
  );
  // Attach decision deltas to the game_end play so accumulateStats picks them up
  const gameEndPlay = plays.find(p => p.type === 'game_end');
  if (gameEndPlay && Object.keys(decisionDeltas).length > 0) {
    gameEndPlay._statDeltas = decisionDeltas;
  }

  // Build box score via the shared accumulator (single source of truth).
  const boxScore    = accumulateBox(plays, players, { awayOrder: _awayOrder, homeOrder: _homeOrder, userIsHome: _userIsHome });
  const liveLineups = { away: _awayOrder, home: _homeOrder };

  return { plays, boxScore, liveLineups };
}

// ─────────────────────────────────────────────────────────────
// FULL GAME SIMULATION
// ─────────────────────────────────────────────────────────────

function _simulateFullGame(userLineup, oppLineup, userSP, oppSP, players, ctx) {
  const { game, fieldMod, scoringMod, isHome, phase, isSpring } = ctx;

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
  };

  // User team bats in bottom (home) or top (away)
  const userBatsBottom = isHome;

  while (!_gameOver(gs)) {
    // Top of inning — away team bats
    const topSlots   = userBatsBottom ? oppLineup.slots  : userLineup.slots;
    const topBench   = userBatsBottom ? oppLineup.bench  : userLineup.bench;
    const topIsUser  = !userBatsBottom;
    const topPitcher = userBatsBottom ? gs.userPitcher : gs.oppPitcher;
    const topBatIdx  = userBatsBottom ? 'oppLineupIdx' : 'userLineupIdx';

    const topPlays = _simulateHalfInning(
      topSlots, topBench, topPitcher, gs, players, fieldMod,
      topIsUser, isSpring, `TOP_${gs.inning}`, topBatIdx,
      gs.inning
    );
    plays.push(...topPlays);

    const topRuns = topPlays.reduce((s, p) => s + (p.rbi || 0), 0);
    if (userBatsBottom) gs.oppScore += topRuns;
    else                gs.userScore += topRuns;

    _updateCumulativeScores(topPlays, gs.userScore, gs.oppScore, isHome);

    _accrueInningAndFatigue(gs, players, userBatsBottom ? 'user' : 'opp');
    _checkPitcherChange(gs, players, userBatsBottom ? 'user' : 'opp', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning);

    if (gs.inning >= 9 && !userBatsBottom && gs.userScore > gs.oppScore) break;

    // Bottom of inning — home team bats
    const botSlots   = userBatsBottom ? userLineup.slots  : oppLineup.slots;
    const botBench   = userBatsBottom ? userLineup.bench  : oppLineup.bench;
    const botIsUser  = userBatsBottom;
    const botPitcher = userBatsBottom ? gs.oppPitcher : gs.userPitcher;
    const botBatIdx  = userBatsBottom ? 'userLineupIdx' : 'oppLineupIdx';

    const botPlays = _simulateHalfInning(
      botSlots, botBench, botPitcher, gs, players, fieldMod,
      botIsUser, isSpring, `BOT_${gs.inning}`, botBatIdx,
      gs.inning
    );
    plays.push(...botPlays);

    const botRuns = botPlays.reduce((s, p) => s + (p.rbi || 0), 0);
    if (userBatsBottom) gs.userScore += botRuns;
    else                gs.oppScore  += botRuns;

    _updateCumulativeScores(botPlays, gs.userScore, gs.oppScore, isHome);

    if (gs.inning >= 9 && userBatsBottom && gs.userScore > gs.oppScore) break;

    _accrueInningAndFatigue(gs, players, userBatsBottom ? 'opp' : 'user');
    _checkPitcherChange(gs, players, userBatsBottom ? 'opp' : 'user', userLineup.bullpen, oppLineup.bullpen, plays, gs.inning);

    gs.inning++;

    // Spring training: end after 9 innings regardless of score (ties allowed).
    // Regular season: play extra innings until someone wins — no ties. A high
    // safety cap only guards against a pathological non-scoring loop.
    if (isSpring) {
      if (gs.inning > 9) break;
    } else {
      if (gs.inning > 9 && gs.userScore !== gs.oppScore) break;
      if (gs.inning > 30) break; // safety valve — effectively never reached
    }
  }

  if (scoringMod !== 1.0) {
    gs.userScore = Math.max(0, Math.round(gs.userScore * scoringMod));
    gs.oppScore  = Math.max(0, Math.round(gs.oppScore  * scoringMod));
  }

  // Regular season must never tie. If the safety cap was reached still level
  // (pathological — effectively never with real offense), award the home team a
  // walk-off run so the game always has a winner.
  if (!isSpring && gs.userScore === gs.oppScore) {
    if (userBatsBottom) gs.userScore += 1; else gs.oppScore += 1;
  }

  // Record the true last inning played. The loop increments gs.inning before the
  // end check, so on a non-walk-off finish gs.inning is one ahead; derive the
  // real final inning from the plays so game_end never claims a phantom 10th.
  const lastPlayedInning = plays.reduce(
    (m, p) => (p.type !== 'game_end' && (p.inning || 0) > m ? p.inning : m), 1);

  plays.push({
    playIndex:    plays.length,
    _halfInning:  `END`,
    inning:       lastPlayedInning,
    half:         'END',
    batterId:     null,
    pitcherId:    null,
    type:         'game_end',
    description:  'Final',
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

  return { plays, userScore: gs.userScore, oppScore: gs.oppScore };
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

function _simulateHalfInning(slots, bench, pitcherObj, gs, players, fieldMod, isUserBatting, isSpring, halfKey, batIdxKey, inning) {
  const plays  = [];
  let outs     = 0;
  let bases    = { first: null, second: null, third: null };
  const pitcher = pitcherObj ? players[pitcherObj.id] : null;

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

  while (outs < 3) {

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
    const subPlay = _checkBenchSubstitution(
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
      plays.push(subPlay);
      slot = slots[slotIdx];
    }

    const activeBatter = players[slots[slotIdx].id];
    if (!activeBatter) { outs++; continue; }

    const atBat = simulateAtBat(activeBatter, pitcher, bases, outs, players, fieldMod,
      { inning, isSpring });
    // Increment the THROWING pitcher's batters-faced count. When the user is
    // batting the opponent is pitching (and vice-versa) — this must match the
    // fatigue check below, which reads the same throwing-pitcher counter.
    gs[isUserBatting ? 'oppPitchCount' : 'userPitchCount']++;

    const { newBases, runsScored, runnerIds, extraOuts, playMod } =
      _advanceBases(bases, atBat, activeBatter, players, outs);
    bases = newBases;

    const effectiveType = playMod || atBat.type;
    const rbi           = runsScored;
    const isScoring     = runsScored > 0;
    const isBigPlay     = atBat.type === 'hr'
      || rbi >= 3
      || (isScoring && Math.abs((gs.userScore + (isUserBatting ? runsScored : 0)) -
                                 (gs.oppScore  + (isUserBatting ? 0 : runsScored))) <= 1);

    const deltas = _buildStatDeltas(atBat, activeBatter, pitcher, rbi, runsScored,
      runnerIds, effectiveType);

    // Errors and fielder's choice: batter reaches safely (no out on batter)
    const batterIsOut = effectiveType !== 'error'
      && effectiveType !== 'fielders_choice'
      && _isOut(atBat.type);

    if (batterIsOut) outs++;
    if (extraOuts > 0) outs = Math.min(3, outs + extraOuts);

    plays.push({
      playIndex:    0,
      _halfInning:  halfKey,
      inning:       parseInt(halfKey.split('_')[1]) || 1,
      half:         halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
      batterId:     activeBatter.id,
      pitcherId:    pitcher.id,
      type:         effectiveType,
      description:  _buildDescription(atBat, activeBatter, pitcher, playMod),
      rbi,
      isScoring,
      isBigPlay,
      outsAfter:    outs,
      _basesAfter:  { ...bases },
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
    outsAfter:    3,
    _basesAfter:  { first: null, second: null, third: null },
    cumOurScore:   0,
    cumTheirScore: 0,
    _timestamp:   0,
    _statDeltas:  {},
  });

  return plays;
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

  // Pitcher fatigue modifiers — applied to pitcher-driven probabilities
  const fatigueFlag = pitcher._simFatigued || false;
  const fatigueHitQual = fatigueFlag ? SIM_P_FATIGUE_HIT_QUALITY_BONUS : 0;
  const fatigueKMod    = fatigueFlag ? (1 - SIM_P_FATIGUE_K_PENALTY)   : 1;
  const fatigueWalkMod = fatigueFlag ? SIM_P_FATIGUE_WALK_BONUS         : 0;

  const r = _roll();

  // 1. Walk
  const walkProb = Math.max(0,
    ((SIM_P_CONTROL_WALK_BASELINE - control) / SIM_P_CONTROL_WALK_DIVISOR + fatigueWalkMod)
    * pitcherMod * fieldMod
  );
  if (r < walkProb) return { type: 'walk' };

  let pos = walkProb;

  // 2. HBP
  const hbpProb = control < SIM_P_CONTROL_HBP_THRESHOLD ? 0.008 : 0.003;
  if (r < pos + hbpProb) return { type: 'hbp' };
  pos += hbpProb;

  // 3. Strikeout
  const kBase   = (100 - contact) / SIM_H_CONTACT_K_DIVISOR;
  const kBonus  = (stuff - 50) / SIM_P_STUFF_K_BONUS_DIVISOR;
  const kProb   = Math.max(0, (kBase + kBonus) * fatigueKMod * pitcherMod * batterMod * fieldMod);
  if (r < pos + kProb) return { type: 'strikeout' };
  pos += kProb;

  // 4. Hit vs out
  const hitBase  = (contact / SIM_H_CONTACT_HIT_DIVISOR) * batterMod;
  const hitQPen  = (stuff / SIM_P_STUFF_HIT_QUALITY_DIVISOR + fatigueHitQual);
  const hitProb  = Math.max(0, (hitBase - hitQPen) * fieldMod);

  // Infield hit bonus
  const infieldBonus = speed / SIM_H_SPEED_INFIELD_DIVISOR;
  const adjHitProb   = Math.min(0.45, hitProb + infieldBonus);

  if (r >= pos + adjHitProb) {
    // Out — groundout vs flyout split
    const groundoutProb = 0.55; // slight groundout lean
    return { type: Math.random() < groundoutProb ? 'groundout' : 'flyout' };
  }
  pos += adjHitProb;

  // 5. Hit type: single, double, triple, HR
  const hrProb  = (power / SIM_H_POWER_HR_DIVISOR) * batterMod;
  const xbhProb = (power / SIM_H_POWER_XBH_DIVISOR) * batterMod;

  const hitRoll = _roll();
  if (hitRoll < hrProb)               return { type: 'hr' };
  if (hitRoll < hrProb + 0.01)        return { type: 'triple' }; // rare
  if (hitRoll < hrProb + 0.01 + xbhProb) return { type: 'double' };
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
          // Fielder's choice — lead runner (on first) thrown out at second, batter reaches first
          playMod = 'fielders_choice';
          // Runner on third scores
          if (bases.third) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  batter.id,
            second: bases.second || null,
            third:  null,
          };
          // Batter is NOT out on FC — signal via playMod (no primary out either)
          // We use the trick: return extraOuts = 0, playMod = 'fielders_choice'
          // The half-inning loop checks playMod to know not to increment outs for batter
          break;
        } else {
          // Standard groundout — force lead runner to second, batter out
          if (bases.third) { runsScored++; runnerIds.push(bases.third); }
          newBases = {
            first:  null,
            second: batter.id || bases.first,
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
  const statKey = isSpring ? 'springStats' : 'stats';
  const deltas  = {}; // { [playerId]: { [statField]: delta } }

  for (const play of plays) {
    if (!play._statDeltas || play.type === 'pinch_hit' || play.type === 'game_start') continue;
    // game_end plays carry W/L/SV/HD decision deltas — allow them through
    for (const [playerId, statList] of Object.entries(play._statDeltas)) {
      if (!deltas[playerId]) deltas[playerId] = {};
      for (const { stat, delta } of statList) {
        deltas[playerId][stat] = (deltas[playerId][stat] || 0) + delta;
      }
    }
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
  const { awayOrder = [], homeOrder = [], userIsHome = false } = opts;

  const HIT0 = () => ({ ab:0, r:0, h:0, doubles:0, hr:0, tb:0, rbi:0, bb:0, hbp:0, k:0, sb:0, cs:0, sf:0, sac:0 });
  const PIT0 = () => ({ outs:0, h:0, hr:0, bb:0, k:0, er:0, w:0, l:0, sv:0, hld:0 });
  const mkSide = () => ({ hit:{}, pit:{}, hitSeen:[], pitSeen:[] });

  const away = mkSide();
  const home = mkSide();
  const linescore = {};

  const ensureHit = (side, id) => { if (!side.hit[id]) { side.hit[id] = HIT0(); side.hitSeen.push(id); } return side.hit[id]; };
  const ensurePit = (side, id) => { if (!side.pit[id]) { side.pit[id] = PIT0(); side.pitSeen.push(id); } return side.pit[id]; };

  for (const play of (plays || [])) {
    // A pitching change carries the incoming pitcher but no stat deltas — register
    // them on their side immediately so they appear in the box the instant they
    // enter (previously they surfaced only when they faced their first batter).
    if (play.type === 'pitching_change' && play.pitcherId) {
      const pid  = play.pitcherId;
      const side = ((players[pid]?.teamId === 'user') === userIsHome) ? home : away;
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
               : ((players[pid]?.teamId === 'user') === userIsHome ? home : away);
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
    outsAfter:    0,   // will be overwritten from previous play context
    _basesAfter:  null,
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
function _pitcherTargetInnings(pitcher) {
  const stam = pitcher?.subRatings?.stamina ?? 60;
  const isRP = pitcher?.group === PLAYER_GROUP.BULLPEN
            || pitcher?.group === PLAYER_GROUP.PITCHER_BENCH;
  if (isRP) return Math.max(1, Math.round(1 + (stam - 40) / 25)); // ~1–2 IP
  return Math.max(4, Math.round(5 + (stam - 50) / 12));           // ~5–8 IP
}

// Credit the current pitcher with a completed inning and flag fatigue once they
// reach their target workload. Called after each half-inning, before the change.
function _accrueInningAndFatigue(gs, players, team) {
  const isUser = team === 'user';
  const pObj   = isUser ? gs.userPitcher : gs.oppPitcher;
  const p      = pObj ? players[pObj.id] : null;
  if (isUser) gs.userPitcherInnings++; else gs.oppPitcherInnings++;
  const innings = isUser ? gs.userPitcherInnings : gs.oppPitcherInnings;
  if (innings >= _pitcherTargetInnings(p)) {
    if (isUser) gs.userFatigued = true; else gs.oppFatigued = true;
  }
}

function _checkPitcherChange(gs, players, team, userBullpen, oppBullpen, plays, inning) {
  const isUser   = team === 'user';
  const fatigued = isUser ? gs.userFatigued : gs.oppFatigued;
  if (!fatigued) return;

  // Relievers come from the team's actual bullpen (BULLPEN + PITCHER_BENCH),
  // supplied by _buildLineup — NOT the batting lineup, which never contains
  // pitchers (that was the bug: bullpen was always empty, so no one ever subbed).
  const bullpen = (isUser ? userBullpen : oppBullpen) || [];

  const bpIdx    = isUser ? gs.userBullpenIdx : gs.oppBullpenIdx;
  const reliever = bullpen[bpIdx % bullpen.length];
  if (!reliever) return; // no relievers available — leave the starter in

  if (isUser) {
    gs.userPitcher    = reliever;
    gs.userFatigued   = false;
    gs.userBullpenIdx++;
    gs.userPitchCount = 0; // fresh arm — reset workload so it doesn't instantly re-tire
    gs.userPitcherInnings = 0;
  } else {
    gs.oppPitcher   = reliever;
    gs.oppFatigued  = false;
    gs.oppBullpenIdx++;
    gs.oppPitchCount = 0;
    gs.oppPitcherInnings = 0;
  }

  const prev = plays[plays.length - 1];
  plays.push({
    playIndex:    0,
    _halfInning:  prev?._halfInning || `TOP_${inning}`,
    inning,
    half:         prev?.half || 'TOP',
    batterId:     null,
    pitcherId:    reliever.id,
    type:         'pitching_change',
    description:  `Pitching change: ${players[reliever.id]?.name || 'Reliever'} enters`,
    rbi:          0,
    isScoring:    false,
    isBigPlay:    false,
    outsAfter:    prev?.outsAfter ?? 0,
    _basesAfter:  prev?._basesAfter ?? { first: null, second: null, third: null },
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
function _assignPitcherDecisions(plays, userScore, oppScore, isHome) {
  const userWon  = userScore > oppScore;
  const userLost = oppScore  > userScore;

  // Collect user pitchers in order of appearance with their pitch spans
  // Each entry: { id, firstPlayIdx, lastPlayIdx, outsRecorded, entryUserScore, entryOppScore }
  const pitcherSpans = [];
  let currentPitcher = null;

  for (const play of plays) {
    if (!play.pitcherId) continue;
    if (play.type === 'inning_end' || play.type === 'game_end') continue;

    // Is this a user-team pitcher? User pitches in TOP half if home, BOT half if away.
    const isUserPitching = isHome
      ? play.half === 'TOP'
      : play.half === 'BOT';
    if (!isUserPitching) continue;

    if (!currentPitcher || currentPitcher.id !== play.pitcherId) {
      currentPitcher = {
        id:             play.pitcherId,
        firstPlayIdx:   play.playIndex,
        lastPlayIdx:    play.playIndex,
        outsRecorded:   0,
        entryUserScore: play.cumOurScore   ?? 0,
        entryOppScore:  play.cumTheirScore ?? 0,
        exitUserScore:  play.cumOurScore   ?? 0,
        exitOppScore:   play.cumTheirScore ?? 0,
      };
      pitcherSpans.push(currentPitcher);
    }
    currentPitcher.lastPlayIdx   = play.playIndex;
    currentPitcher.exitUserScore = play.cumOurScore   ?? 0;
    currentPitcher.exitOppScore  = play.cumTheirScore ?? 0;

    if (_isOut(play.type)) currentPitcher.outsRecorded++;
  }

  if (!pitcherSpans.length) return {};

  const decisions = {}; // { pitcherId: { w, l, sv, hd } }
  const get = id => { if (!decisions[id]) decisions[id] = { w:0, l:0, sv:0, hd:0 }; return decisions[id]; };

  // ── WIN ──────────────────────────────────────────────────────
  // Find the pitcher who was on mound when user took the lead for good.
  // Scan plays in order — find last time the lead changed to user advantage
  // and which user pitcher was active then.
  if (userWon && pitcherSpans.length > 0) {
    let winningPitcherId = null;
    let leadTakenIdx = -1;

    for (const play of plays) {
      if (!play.pitcherId) continue;
      const isUserPitching = isHome ? play.half === 'TOP' : play.half === 'BOT';
      if (!isUserPitching) continue;
      const our   = play.cumOurScore   ?? 0;
      const their = play.cumTheirScore ?? 0;
      if (our > their) {
        // User has lead — check if this is the play that gave them the lead
        const prevPlay = plays[play.playIndex - 1];
        const prevOur   = prevPlay?.cumOurScore   ?? 0;
        const prevTheir = prevPlay?.cumTheirScore ?? 0;
        // Actually, WIN goes to the pitcher who was pitching for the user team
        // when user took the lead they kept — but W goes to the pitcher on the
        // OFFENSIVE side (their team scored). In baseball, win goes to the
        // pitcher of record for the WINNING team — the user team pitcher who
        // was pitching when the WINNING team's offense put them ahead.
        // Simplification: give W to the first pitcher who had ≥ 5 outs recorded,
        // or the SP if they went ≥ 5 innings, else the pitcher on mound when
        // user took the lead.
      }
    }

    // Simplified win rule: W goes to the SP if they pitched ≥ 5 full outs (based on outsRecorded >= 15)
    // otherwise to the user pitcher who was on mound when the user's offense took the final lead.
    // We detect "took final lead" by scanning the score progression.
    let finalLeadPitcherIdx = -1;
    for (let pi = 0; pi < plays.length; pi++) {
      const play = plays[pi];
      if (!play.rbi || play.rbi <= 0) continue;
      // User scored — check if this scoring play put them in a lead they kept
      const our   = play.cumOurScore   ?? 0;
      const their = play.cumTheirScore ?? 0;
      if (our > their) {
        // User has lead after this scoring play
        // Check if any subsequent play shows them losing the lead
        let keptLead = true;
        for (let pj = pi + 1; pj < plays.length; pj++) {
          const later = plays[pj];
          if ((later.cumOppScore ?? later.cumTheirScore ?? 0) >= (later.cumOurScore ?? 0)) {
            // Tie or opp takes lead later
            if (!isHome ? later.half === 'BOT' : later.half === 'TOP') {
              // Opponent scored to tie/lead
              keptLead = false;
              break;
            }
          }
        }
        if (keptLead) { finalLeadPitcherIdx = pi; break; }
      }
    }

    // Find which user pitcher was on mound for the user team at that point
    // (actually the W goes to the pitcher on the OPPOSING half — they were pitching
    //  when they were losing and the user was batting. But conventionally W goes to
    //  the pitcher of the winning team who was pitching when that team took the lead.)
    // We'll assign to the SP if ≥ 15 outs recorded, else last reliever active.
    const sp = pitcherSpans[0];
    if (sp.outsRecorded >= 15) {
      get(sp.id).w = 1;
    } else {
      // Find pitcher who was pitching (for user) at the time user's offense scored the go-ahead
      // This is the pitcher who was LAST active on user's side when user took the permanent lead
      const winPitcher = pitcherSpans[pitcherSpans.length - 1];
      get(winPitcher.id).w = 1;
    }
  }

  // ── LOSS ─────────────────────────────────────────────────────
  if (userLost) {
    // L goes to the user pitcher who gave up the go-ahead run that held
    // Find the first play where opponent took a lead the user never overcame
    for (let pi = 0; pi < plays.length; pi++) {
      const play = plays[pi];
      if (!play.rbi || play.rbi <= 0) continue;
      // Check if opponent scored on this play (rbi goes to batting team)
      const isOppBatting = isHome ? play.half === 'BOT' : play.half === 'TOP';
      if (!isOppBatting) continue;
      const our   = play.cumOurScore   ?? 0;
      const their = play.cumTheirScore ?? 0;
      if (their > our) {
        // Opponent has lead — check if user ever ties/leads again
        let userTiedBack = false;
        for (let pj = pi + 1; pj < plays.length; pj++) {
          const later = plays[pj];
          if ((later.cumOurScore ?? 0) >= (later.cumTheirScore ?? later.cumOppScore ?? 0)) {
            userTiedBack = true;
            break;
          }
        }
        if (!userTiedBack) {
          // This play gave opp the permanent lead — find user pitcher active then
          const lossPitcher = pitcherSpans.find(s =>
            s.firstPlayIdx <= pi && s.lastPlayIdx >= pi
          ) || pitcherSpans[pitcherSpans.length - 1];
          if (lossPitcher) get(lossPitcher.id).l = 1;
          break;
        }
      }
    }
  }

  // ── SAVE ─────────────────────────────────────────────────────
  if (userWon && pitcherSpans.length >= 2) {
    const closer = pitcherSpans[pitcherSpans.length - 1];
    const lead   = closer.entryUserScore - closer.entryOppScore;
    const alreadyHasW = decisions[closer.id]?.w;
    if (!alreadyHasW && lead > 0 && lead <= 3 && closer.outsRecorded >= 1) {
      get(closer.id).sv = 1;
    }
  }

  // ── HOLDS ────────────────────────────────────────────────────
  if (userWon && pitcherSpans.length >= 2) {
    const saveOrWinIds = new Set(
      Object.entries(decisions)
        .filter(([, d]) => d.sv || d.w)
        .map(([id]) => id)
    );
    // Middle relievers who pitched in a save situation and kept the lead
    for (let i = 1; i < pitcherSpans.length - 1; i++) {
      const span = pitcherSpans[i];
      if (saveOrWinIds.has(span.id)) continue;
      const lead = span.entryUserScore - span.entryOppScore;
      if (lead > 0 && lead <= 3 && span.outsRecorded >= 1
          && span.exitUserScore > span.exitOppScore) {
        get(span.id).hd = 1;
      }
    }
  }

  // Convert to stat delta format
  const result = {};
  for (const [pitcherId, dec] of Object.entries(decisions)) {
    result[pitcherId] = [];
    if (dec.w)  result[pitcherId].push({ stat: 'w',  delta: 1 });
    if (dec.l)  result[pitcherId].push({ stat: 'l',  delta: 1 });
    if (dec.sv) result[pitcherId].push({ stat: 'sv', delta: 1 });
    if (dec.hd) result[pitcherId].push({ stat: 'hld', delta: 1 });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP ASSIGNMENT
// ─────────────────────────────────────────────────────────────

function _assignTimestamps(plays, gameTime, tickOffset) {
  const GAME_DURATION_MS = 10_800_000; // 3 hours
  const total = plays.length;

  return plays.map((play, i) => ({
    ...play,
    playIndex:  i,
    _timestamp: gameTime + tickOffset + Math.round((i / total) * GAME_DURATION_MS) + _rng(-15000, 15000),
  }));
}

// ─────────────────────────────────────────────────────────────
// CUMULATIVE SCORE UPDATE
// ─────────────────────────────────────────────────────────────

function _updateCumulativeScores(plays, userScore, oppScore, isHome) {
  for (const play of plays) {
    play.cumOurScore   = userScore;
    play.cumTheirScore = oppScore;
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
    p && !p.isInjured && !p.isSuspended && !p.onPersonalLeave
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
      .filter(p => p && !p.isInjured && !p.isSuspended && !p.onPersonalLeave);
  } else {
    // Fallback: old saves that haven't migrated yet
    starterPlayers = rosterIds
      .map(id => players[id])
      .filter(p =>
        p &&
        !p.isInjured &&
        !p.isSuspended &&
        !p.onPersonalLeave &&
        p.group === PLAYER_GROUP.STARTING_HITTERS
      );
  }

  // Batting order: CPU uses OVR sort, user team uses sub-rating derivation.
  // lineupSlots defines WHO is in the lineup; batting order defines SEQUENCE.
  const orderedStarters = isCPU
    ? [...starterPlayers].sort((a,b) => b.ovr - a.ovr)
    : _simDeriveBattingOrder(starterPlayers);

  const bench = rosterIds
    .map(id => players[id])
    .filter(p =>
      p &&
      !p.isInjured &&
      !p.isSuspended &&
      !p.onPersonalLeave &&
      p.group === PLAYER_GROUP.BENCH_HITTERS
    )
    .sort((a, b) => b.ovr - a.ovr);

  // Bullpen — healthy rostered relievers (BULLPEN + PITCHER_BENCH), sorted
  // weakest→best so lower-leverage arms enter first and the best arm (closer)
  // finishes. Used by _checkPitcherChange when the current pitcher tires.
  const bullpen = rosterIds
    .map(id => players[id])
    .filter(p =>
      p &&
      !p.isInjured &&
      !p.isSuspended &&
      !p.onPersonalLeave &&
      (p.group === PLAYER_GROUP.BULLPEN || p.group === PLAYER_GROUP.PITCHER_BENCH)
    )
    .sort((a, b) => a.ovr - b.ovr);

  return {
    slots:   orderedStarters.map(p => ({ id: p.id, subbed: false })),
    bench:   bench.map(p => ({ id: p.id, used: false })),
    bullpen: bullpen.map(p => ({ id: p.id })),
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

function _getRotationSP(team, players) {
  const rotation = team.rotation;
  if (!rotation || !rotation.order || rotation.order.length === 0) {
    // Fallback: find any healthy SP
    return _findHealthySP(team.rosterIds || [], players);
  }
  const spId = rotation.order[rotation.currentIndex % rotation.order.length];
  const sp   = players[spId];
  if (!sp || sp.isInjured || sp.isSuspended) {
    return _findHealthySP(team.rosterIds || [], players);
  }
  return { id: spId };
}

function _getCPUSP(team, players) {
  if (!team) return null;
  return _getRotationSP(team, players);
}

function _findHealthySP(rosterIds, players) {
  const sp = rosterIds
    .map(id => players[id])
    .filter(p => p && p.group === PLAYER_GROUP.STARTING_PITCHERS && !p.isInjured && !p.isSuspended)
    .sort((a, b) => b.ovr - a.ovr)[0];
  return sp ? { id: sp.id } : null;
}

// ─────────────────────────────────────────────────────────────
// STAT DELTA BUILDER
// ─────────────────────────────────────────────────────────────

function _buildStatDeltas(atBat, batter, pitcher, rbi, runsScored, runnerIds, effectiveType = null) {
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
  // IP: charged for all outs including ones created by runner advancement
  // (extraOuts are handled elsewhere — pitcher only charged for batter outs here)
  const batterOut = type !== 'error' && type !== 'fielders_choice' && _isOut(atBat.type);
  if (batterOut) addDelta(pitcher.id, 'ip', 0.333);
  if (['single','double','triple','hr'].includes(atBat.type)) addDelta(pitcher.id, 'h_allowed', 1);
  if (atBat.type === 'hr') addDelta(pitcher.id, 'hr_allowed', 1);
  if (atBat.type === 'walk' || atBat.type === 'hbp') addDelta(pitcher.id, 'bb', 1);
  if (atBat.type === 'strikeout') addDelta(pitcher.id, 'k', 1);
  if (rbi > 0) addDelta(pitcher.id, 'er', rbi);

  return deltas;
}

// ─────────────────────────────────────────────────────────────
// PLAY DESCRIPTION BUILDER
// ─────────────────────────────────────────────────────────────

function _buildDescription(atBat, batter, pitcher, playMod = null) {
  const bn = batter?.name  || 'Batter';
  const pn = pitcher?.name || 'Pitcher';
  const type = playMod || atBat.type;

  switch (type) {
    case 'hr':              return `${bn} homers`;
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
    .filter(p => p && !p.isInjured && !p.isSuspended);

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

function _fieldConditionMod(fieldCondition) {
  if (!fieldCondition) return 1.0;
  const { infieldSoftness = 0, moundFirmness = 1, temperature = 72 } = fieldCondition;
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
  if (player?.injuryPenalty?.subRating === subRatingKey) {
    return Math.max(40, baseValue - (player.injuryPenalty.amount || 0));
  }
  return baseValue;
}

// ─────────────────────────────────────────────────────────────
// GAME OVER CHECK
// ─────────────────────────────────────────────────────────────

function _gameOver(gs) {
  // Primary termination is handled by the loop breaks; this is the while-guard.
  // Spring: done after 9 innings (ties allowed). Regular: play until scores
  // differ — no ties — with a high safety cap that is effectively never reached.
  if (gs.inning < 9) return false;
  if (gs.isSpring) return true;
  if (gs.userScore !== gs.oppScore) return true;
  return gs.inning >= 30;
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
