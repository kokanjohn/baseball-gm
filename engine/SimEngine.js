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
  SIM_P_STUFF_K_BONUS_DIVISOR,
  SIM_P_STUFF_HIT_QUALITY_DIVISOR,
  SIM_P_CONTROL_WALK_BASELINE,
  SIM_P_CONTROL_WALK_DIVISOR,
  SIM_P_CONTROL_HBP_THRESHOLD,
  SIM_P_STAMINA_INNINGS_DIVISOR,
  SIM_P_FATIGUE_MULTIPLIER,
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
  const userLineup = _buildLineup(userTeam.rosterIds, players, false);
  const oppLineup  = _buildLineup(effectiveOppTeam.rosterIds || [], players, true);

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

  // Prepend a game_start announcement play — first thing shown in PBP
  const userSPPlayer = userSP ? players[userSP.id] : null;
  const oppSPPlayer  = oppSP  ? players[oppSP.id]  : null;
  const awaySPPlayer = game.isHome ? oppSPPlayer : userSPPlayer;
  const homeSPPlayer = game.isHome ? userSPPlayer : oppSPPlayer;

  const announcementPlay = {
    playIndex:     0,
    _halfInning:   'TOP_1',
    inning:        1,
    half:          'TOP',
    batterId:      null,
    pitcherId:     awaySPPlayer?.id || null,
    type:          'game_start',
    description:   `${awaySPPlayer?.name || 'SP'} takes the mound. ${homeSPPlayer?.name || 'SP'} starts for the home team.`,
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

  // Build box score
  const boxScore = _buildBoxScore(plays, userLineup, oppLineup, players);

  return { plays, boxScore };
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
    userScore:    0,
    oppScore:     0,
    userLineupIdx:  0,  // batting order position (cycles through slots)
    oppLineupIdx:   0,
    userPitcher:  userSP,
    oppPitcher:   oppSP,
    userPitchCount: 0,
    oppPitchCount:  0,
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

    _checkPitcherChange(gs, players, userBatsBottom ? 'user' : 'opp', userLineup.slots, oppLineup.slots, plays, gs.inning);

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

    _checkPitcherChange(gs, players, userBatsBottom ? 'opp' : 'user', userLineup.slots, oppLineup.slots, plays, gs.inning);

    gs.inning++;

    // Spring training: end after 9 innings regardless of score (ties allowed).
    // Regular season: continue until scores differ, hard cap at 14 innings.
    if (isSpring && gs.inning > 9) break;
    const maxInning = 14;
    if (gs.inning > maxInning) break;
    if (!isSpring && gs.inning > 9 && gs.userScore !== gs.oppScore) break;
  }

  if (scoringMod !== 1.0) {
    gs.userScore = Math.max(0, Math.round(gs.userScore * scoringMod));
    gs.oppScore  = Math.max(0, Math.round(gs.oppScore  * scoringMod));
  }

  plays.push({
    playIndex:    plays.length,
    _halfInning:  `END`,
    inning:       gs.inning,
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
    const slotIdx    = gs[batIdxKey] % slots.length;
    let   slot       = slots[slotIdx];
    const batter     = slot ? players[slot.id] : null;
    gs[batIdxKey]++;

    if (!batter || !pitcher) {
      outs++;
      continue;
    }

    // ── Substitution check ────────────────────────────────────
    // Only substitute user team batters (CPU bench logic not needed).
    // Check before this at-bat whether a bench player should enter.
    const subPlay = _checkBenchSubstitution(
      slots, bench, slotIdx, batter, players,
      inning, isSpring, gs.userScore, gs.oppScore, isUserBatting
    );

    if (subPlay) {
      // Wire cumulative scores from previous play
      const prev = plays[plays.length - 1];
      subPlay.cumOurScore   = prev?.cumOurScore   ?? 0;
      subPlay.cumTheirScore = prev?.cumTheirScore ?? 0;
      subPlay._halfInning   = halfKey;
      subPlay.inning        = parseInt(halfKey.split('_')[1]) || 1;
      subPlay.half          = halfKey.startsWith('TOP') ? 'TOP' : 'BOT';
      plays.push(subPlay);

      // Use the new batter for this at-bat
      slot = slots[slotIdx]; // updated in-place by _checkBenchSubstitution
    }

    // Re-read batter after possible substitution
    const activeBatter = players[slots[slotIdx].id];
    if (!activeBatter) { outs++; continue; }

    const atBat = simulateAtBat(activeBatter, pitcher, bases, outs, players, fieldMod);
    gs[isUserBatting ? 'userPitchCount' : 'oppPitchCount']++;

    const { newBases, runsScored, runnerIds } = _advanceBases(bases, atBat, activeBatter, players);
    bases = newBases;

    const rbi       = runsScored;
    const isScoring = runsScored > 0;
    const isBigPlay = atBat.type === 'hr'
      || rbi >= 3
      || (isScoring && Math.abs((gs.userScore + (isUserBatting ? runsScored : 0)) -
                                 (gs.oppScore  + (isUserBatting ? 0 : runsScored))) <= 1);

    const deltas = _buildStatDeltas(atBat, activeBatter, pitcher, rbi, runsScored, runnerIds);

    plays.push({
      playIndex:    0,
      _halfInning:  halfKey,
      inning:       parseInt(halfKey.split('_')[1]) || 1,
      half:         halfKey.startsWith('TOP') ? 'TOP' : 'BOT',
      batterId:     activeBatter.id,
      pitcherId:    pitcher.id,
      type:         atBat.type,
      description:  _buildDescription(atBat, activeBatter, pitcher),
      rbi,
      isScoring,
      isBigPlay,
      outsAfter:    _isOut(atBat.type) ? outs + 1 : outs,
      _basesAfter:  { ...bases },
      cumOurScore:   0,
      cumTheirScore: 0,
      _timestamp:   0,
      _statDeltas:  deltas,
    });

    if (_isOut(atBat.type)) outs++;

    const maxBatters = Math.round((pitcher.subRatings?.stamina || 60) * SIM_P_FATIGUE_MULTIPLIER);
    if (gs[isUserBatting ? 'oppPitchCount' : 'userPitchCount'] >= maxBatters) {
      if (isUserBatting) gs.oppFatigued  = true;
      else               gs.userFatigued = true;
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
export function simulateAtBat(batter, pitcher, bases, outs, players, fieldMod = 1.0) {
  const sr  = batter.subRatings  || {};
  const psr = pitcher.subRatings || {};

  // Apply injury penalty if active
  const contact  = _effectiveSR(batter,  'contact',  sr.contact);
  const power    = _effectiveSR(batter,  'power',    sr.power);
  const speed    = _effectiveSR(batter,  'speed',    sr.speed);
  const stuff    = _effectiveSR(pitcher, 'stuff',    psr.stuff);
  const control  = _effectiveSR(pitcher, 'control',  psr.control);

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

function _advanceBases(bases, atBat, batter, players) {
  const speed = _effectiveSR(batter, 'speed', batter.subRatings?.speed);
  let newBases = { ...bases };
  let runsScored = 0;
  const runnerIds = [];

  switch (atBat.type) {
    case 'hr':
      // Clear all bases, batter scores
      runsScored = 1 + (bases.first ? 1 : 0) + (bases.second ? 1 : 0) + (bases.third ? 1 : 0);
      if (bases.first)  runnerIds.push(bases.first);
      if (bases.second) runnerIds.push(bases.second);
      if (bases.third)  runnerIds.push(bases.third);
      newBases = { first: null, second: null, third: null };
      break;

    case 'triple':
      if (bases.first)  { runsScored++; runnerIds.push(bases.first); }
      if (bases.second) { runsScored++; runnerIds.push(bases.second); }
      if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
      newBases = { first: null, second: null, third: batter.id };
      break;

    case 'double':
      if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
      if (bases.second) { runsScored++; runnerIds.push(bases.second); }
      if (bases.first) {
        // Speed determines if runner scores from first
        if (speed >= SIM_H_SPEED_DOUBLE_SCORE_THRESHOLD) {
          runsScored++;
          runnerIds.push(bases.first);
          newBases = { first: null, second: null, third: batter.id };
        } else {
          newBases = { first: null, second: batter.id, third: null };
        }
      } else {
        newBases = { first: null, second: batter.id, third: null };
      }
      break;

    case 'single':
      if (bases.third)  { runsScored++; runnerIds.push(bases.third); }
      if (bases.second) { runsScored++; runnerIds.push(bases.second); }
      // Runner on first: advance 1 (or 2 if fast)
      const advTo = speed >= SIM_H_SPEED_STRETCH_THRESHOLD ? 'third' : 'second';
      newBases = {
        first:  batter.id,
        second: advTo === 'second' ? (bases.first || null) : null,
        third:  advTo === 'third'  ? (bases.first || null) : newBases.third,
      };
      break;

    case 'walk':
    case 'hbp':
      // Force advance
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

    case 'groundout':
      // Force play if runners on base and < 2 outs
      if (bases.first && _rng(0, 1) < 1) { // groundout always forces runner at second
        // Check for double play
        if (bases.first && _roll() < 0.40) {
          // Double play — lead runner out at second, batter out at first
          newBases = { first: null, second: bases.second, third: bases.third };
          // Extra out handled by caller doubling outs... simplified: just 1 out here
        } else {
          newBases = { first: null, second: batter.id || bases.first, third: bases.second };
          if (bases.third) { runsScored++; runnerIds.push(bases.third); }
        }
      }
      break;

    case 'flyout':
      // Tag up: runner on third can score if speed > threshold
      if (bases.third) {
        const runner3 = players[bases.third];
        const r3speed = _effectiveSR(runner3, 'speed', runner3?.subRatings?.speed);
        if (r3speed >= SIM_H_SPEED_TAG_THRESHOLD) {
          runsScored++;
          runnerIds.push(bases.third);
          newBases = { first: bases.first, second: bases.second, third: null };
        }
      }
      break;

    default:
      break;
  }

  return { newBases, runsScored, runnerIds };
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
// BOX SCORE BUILDER
// ─────────────────────────────────────────────────────────────

/**
 * buildBoxScore(plays, userLineup, oppLineup, players)
 * Builds the final box score object from the play array.
 * Called at commit time — pre-gen fields stripped, box score kept.
 *
 * @returns {Object} boxScore
 */
export function buildBoxScore(plays, userLineup, oppLineup, players) {
  return _buildBoxScore(plays, userLineup, oppLineup, players);
}

function _buildBoxScore(plays, userLineup, oppLineup, players) {
  const linescore = {}; // { inning: { top: runs, bot: runs } }
  const hittersBox = {};
  const pitchersBox = {};

  for (const play of plays) {
    if (!play.inning || play.type === 'inning_end' || play.type === 'game_end'
        || play.type === 'pinch_hit' || play.type === 'game_start') continue;

    const inn = play.inning;
    if (!linescore[inn]) linescore[inn] = { top: 0, bot: 0 };
    if (play.rbi > 0) {
      if (play.half === 'TOP') linescore[inn].top += play.rbi;
      else                     linescore[inn].bot += play.rbi;
    }

    // Batter line
    if (play.batterId) {
      if (!hittersBox[play.batterId]) {
        hittersBox[play.batterId] = { ab:0, h:0, hr:0, rbi:0, r:0, bb:0, k:0 };
      }
      const hb = hittersBox[play.batterId];
      if (!['walk','hbp'].includes(play.type)) hb.ab++;
      if (['single','double','triple','hr'].includes(play.type)) hb.h++;
      if (play.type === 'hr') hb.hr++;
      if (play.type === 'walk' || play.type === 'hbp') hb.bb++;
      if (play.type === 'strikeout') hb.k++;
      hb.rbi += play.rbi;
    }

    // Pitcher line
    if (play.pitcherId) {
      if (!pitchersBox[play.pitcherId]) {
        pitchersBox[play.pitcherId] = { ip:0, er:0, h:0, bb:0, k:0, hr:0 };
      }
      const pb = pitchersBox[play.pitcherId];
      if (_isOut(play.type)) pb.ip = Math.round((pb.ip + 0.333) * 1000) / 1000;
      if (['single','double','triple','hr'].includes(play.type)) pb.h++;
      if (play.type === 'hr') pb.hr++;
      if (play.type === 'walk' || play.type === 'hbp') pb.bb++;
      if (play.type === 'strikeout') pb.k++;
      pb.er += play.rbi; // simplified: all runs earned
    }
  }

  const finalPlay = plays[plays.length - 1];
  return {
    linescore,
    userScore:  finalPlay?.cumOurScore   ?? 0,
    oppScore:   finalPlay?.cumTheirScore ?? 0,
    hittersBox,
    pitchersBox,
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

function _checkPitcherChange(gs, players, team, userSlots, oppSlots, plays, inning) {
  const isUser   = team === 'user';
  const fatigued = isUser ? gs.userFatigued : gs.oppFatigued;
  if (!fatigued) return;

  const slots  = isUser ? userSlots : oppSlots;
  const bullpen = slots.filter(s => {
    const pl = players[s.id];
    return pl && [PLAYER_GROUP.BULLPEN, PLAYER_GROUP.PITCHER_BENCH].includes(pl.group);
  });

  const bpIdx    = isUser ? gs.userBullpenIdx : gs.oppBullpenIdx;
  const reliever = bullpen[bpIdx % bullpen.length];
  if (!reliever) return;

  if (isUser) {
    gs.userPitcher    = reliever;
    gs.userFatigued   = false;
    gs.userBullpenIdx++;
  } else {
    gs.oppPitcher   = reliever;
    gs.oppFatigued  = false;
    gs.oppBullpenIdx++;
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

  // Pick 9 starters and 1 SP from the available pool by OVR
  const hitters  = allPlayers.filter(p => p.group === PLAYER_GROUP.STARTING_HITTERS)
    .sort((a,b) => b.ovr - a.ovr).slice(0, 9);
  const pitchers = allPlayers.filter(p => p.group === PLAYER_GROUP.STARTING_PITCHERS)
    .sort((a,b) => b.ovr - a.ovr).slice(0, 5);
  const bullpen  = allPlayers.filter(p => p.group === PLAYER_GROUP.BULLPEN)
    .sort((a,b) => b.ovr - a.ovr).slice(0, 5);

  return {
    rosterIds: [...hitters.map(p => p.id), ...pitchers.map(p => p.id), ...bullpen.map(p => p.id)],
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

function _buildLineup(rosterIds, players, isCPU) {
  // Batting order: starters by position, then bench
  const starters = rosterIds
    .map(id => ({ id, player: players[id] }))
    .filter(({ player }) =>
      player &&
      !player.isInjured &&
      !player.isSuspended &&
      !player.onPersonalLeave &&
      player.group === PLAYER_GROUP.STARTING_HITTERS
    )
    .sort((a, b) => b.player.ovr - a.player.ovr); // simplified: sort by OVR

  // Bench hitters available for substitution — sorted by OVR desc so
  // higher-rated bench players get opportunities first
  const bench = rosterIds
    .map(id => ({ id, player: players[id] }))
    .filter(({ player }) =>
      player &&
      !player.isInjured &&
      !player.isSuspended &&
      !player.onPersonalLeave &&
      player.group === PLAYER_GROUP.BENCH_HITTERS
    )
    .sort((a, b) => b.player.ovr - a.player.ovr);

  return {
    slots: starters.map(({ id }) => ({ id, subbed: false })),
    bench: bench.map(({ id }) => ({ id, used: false })),
  };
}

function _buildCPULineup(team, players) {
  if (!team) return { slots: [], bench: [] };
  return _buildLineup(team.rosterIds || [], players, true);
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

function _buildStatDeltas(atBat, batter, pitcher, rbi, runsScored, runnerIds) {
  const deltas = {};

  const addDelta = (id, stat, delta) => {
    if (!id) return;
    if (!deltas[id]) deltas[id] = [];
    deltas[id].push({ stat, delta });
  };

  // Batter stats
  if (!['walk','hbp'].includes(atBat.type)) addDelta(batter.id, 'ab', 1);
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
  if (rbi > 0) addDelta(batter.id, 'rbi', rbi);
  if (atBat.type === 'hr') addDelta(batter.id, 'r', 1); // batter scores on HR

  // Runners who scored
  for (const runnerId of runnerIds) {
    addDelta(runnerId, 'r', 1);
  }

  // Pitcher stats
  if (_isOut(atBat.type)) addDelta(pitcher.id, 'ip', 0.333); // accumulated, rounded at display
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

function _buildDescription(atBat, batter, pitcher) {
  const bn = batter?.name  || 'Batter';
  const pn = pitcher?.name || 'Pitcher';
  switch (atBat.type) {
    case 'hr':         return `${bn} homers`;
    case 'triple':     return `${bn} triples`;
    case 'double':     return `${bn} doubles`;
    case 'single':     return `${bn} singles`;
    case 'walk':       return `${bn} walks`;
    case 'hbp':        return `${bn} hit by pitch`;
    case 'strikeout':  return `${bn} strikeout — ${pn}`;
    case 'groundout':  return `${bn} grounds out`;
    case 'flyout':     return `${bn} flies out`;
    default:           return `${bn} out`;
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
  // Spring training ends after exactly 9 innings (handled by break in loop above).
  // Regular season: ends when scores differ after 9, or at inning 14 cap.
  // This function is a safety guard — the loop breaks handle primary termination.
  if (gs.inning < 9) return false;
  if (gs.userScore !== gs.oppScore) return true;
  return gs.inning >= 14;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _isOut(type) {
  return ['groundout','flyout','strikeout'].includes(type);
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
