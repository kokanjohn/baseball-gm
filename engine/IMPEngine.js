/**
 * engine/IMPEngine.js
 * Impact Rating (IMP) calculation across four rolling windows.
 *
 * IMP is the game's proprietary player value metric — a single decimal number
 * representing how much a player contributes relative to their position average.
 * Positive = above average, zero = replacement level, negative = below average.
 *
 * Four windows, same formula:
 *   IMP-7  (last 7 days)  — volatile, pure hot/cold signal
 *   IMP-15 (last 15 days) — short-term form trend
 *   IMP-30 (last 30 days) — most actionable for roster decisions
 *   IMP-S  (full season)  — most stable, true season value
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies results.
 *   - All weights and thresholds imported from constants — nothing hardcoded.
 *   - Returns null for any window with insufficient sample (below IMP_MIN_PA/IP).
 *   - Position normalization applied to all delta calculations.
 *
 * Section reference: Section 30 (Impact Rating — LOCKED)
 */

import {
  IMP_WINDOW_7,
  IMP_WINDOW_15,
  IMP_WINDOW_30,
  IMP_H_OPS_WEIGHT,
  IMP_H_HR_WEIGHT,
  IMP_H_RBI_WEIGHT,
  IMP_H_SB_WEIGHT,
  IMP_H_DISCIPLINE_WEIGHT,
  IMP_H_STRIKEOUT_PENALTY,
  IMP_H_BABIP_ADJ_TRIGGER,
  IMP_H_BABIP_ADJ_WEIGHT,
  IMP_P_ERA_WEIGHT,
  IMP_P_WHIP_WEIGHT,
  IMP_P_K9_WEIGHT,
  IMP_P_WALK_PENALTY,
  IMP_P_HR_PENALTY,
  IMP_P_QS_BONUS,
  IMP_P_SAVE_BONUS,
  IMP_P_HOLD_BONUS,
  IMP_P_IP_LOG_SCALE,
  IMP_HOT_THRESHOLD,
  IMP_COLD_THRESHOLD,
  IMP_ELITE_THRESHOLD,
  IMP_BELOW_REPLACEMENT,
  IMP_POS_AVG_OPS,
  IMP_POS_AVG_HR_RATE,
  IMP_LEAGUE_AVG_ERA,
  IMP_LEAGUE_AVG_WHIP,
  IMP_LEAGUE_AVG_K9,
  IMP_LEAGUE_AVG_BB9,
  IMP_LEAGUE_AVG_HR9,
  IMP_LEAGUE_AVG_OPS,
  IMP_LEAGUE_AVG_BB_PCT,
  IMP_LEAGUE_AVG_K_PCT,
  IMP_MIN_PA_7,
  IMP_MIN_PA_15,
  IMP_MIN_PA_30,
  IMP_MIN_PA_SEASON,
  IMP_MIN_IP_7,
  IMP_MIN_IP_15,
  IMP_MIN_IP_30,
  IMP_MIN_IP_SEASON,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * computeAllIMP(state, gameIndex)
 * Recalculates IMP scores for all active roster players on all 10 teams.
 * Returns mutations: { impScores: { [playerId]: IMPScore } }
 *
 * Called by GameEngine after each game commit.
 *
 * @param {Object} state
 * @param {Number} gameIndex  — current game index
 * @returns {Object} mutations
 */
export function computeAllIMP(state, gameIndex) {
  const impScores = { ...(state.impScores || {}) };

  // Collect all active roster player IDs
  const allRosterIds = new Set([
    ...(state.userTeam?.rosterIds || []),
    ...(state.leagueTeams || []).flatMap(t => t.rosterIds || []),
  ]);

  for (const playerId of allRosterIds) {
    const player = state.players[playerId];
    if (!player) continue;

    const score = computePlayerIMP(player, gameIndex);
    if (score) {
      impScores[playerId] = { ...score, updatedAtGame: gameIndex };
    }
  }

  return { impScores };
}

/**
 * computePlayerIMP(player, gameIndex)
 * Calculates all four IMP windows for a single player.
 * Returns null if the player has no game log (e.g. just called up).
 *
 * @param {Object} player
 * @param {Number} gameIndex
 * @returns {Object|null} { imp7, imp15, imp30, impS }
 */
export function computePlayerIMP(player, gameIndex) {
  const isPitcher = _isPitcher(player);
  const gameLog   = player._impGameLog || [];

  if (gameLog.length === 0 && !_hasSeasonStats(player, isPitcher)) return null;

  return {
    imp7:  _computeWindow(player, gameLog, IMP_WINDOW_7,  gameIndex, isPitcher,
                          IMP_MIN_PA_7,  IMP_MIN_IP_7),
    imp15: _computeWindow(player, gameLog, IMP_WINDOW_15, gameIndex, isPitcher,
                          IMP_MIN_PA_15, IMP_MIN_IP_15),
    imp30: _computeWindow(player, gameLog, IMP_WINDOW_30, gameIndex, isPitcher,
                          IMP_MIN_PA_30, IMP_MIN_IP_30),
    impS:  _computeSeasonIMP(player, isPitcher),
  };
}

// ─────────────────────────────────────────────────────────────
// GAME LOG MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * appendGameLog(player, gameIndex, date, gameStats)
 * Appends a game's stat contribution to the player's rolling log.
 * Trims entries older than IMP_WINDOW_30 days.
 * Returns a partial player mutation.
 *
 * Called by GameEngine/accumulateStats after each game commit.
 *
 * @param {Object} player
 * @param {Number} gameIndex
 * @param {String} date       — 'YYYY-MM-DD'
 * @param {Object} gameStats  — { ab, h, doubles, hr, rbi, r, bb, k, sb, cs, ip, er, ... }
 * @returns {Object} { _impGameLog: [...] }
 */
export function appendGameLog(player, gameIndex, date, gameStats) {
  const log = [...(player._impGameLog || [])];

  // Add this game's entry
  log.push({
    gameIndex,
    date,
    stats: { ...gameStats },
  });

  // Trim to last 30 entries (approximately 30 days)
  // Exact day-based trimming done at window calculation time
  const trimmed = log.length > 45 ? log.slice(log.length - 45) : log;

  return { _impGameLog: trimmed };
}

// ─────────────────────────────────────────────────────────────
// HOT/COLD INDICATOR
// ─────────────────────────────────────────────────────────────

/**
 * getHotColdIndicator(impScore)
 * Returns a display indicator based on IMP-7 value.
 * Used on roster screen player rows.
 *
 * @param {Object|null} impScore
 * @returns {String} '🔥'|'❄️'|''
 */
export function getHotColdIndicator(impScore) {
  const imp7 = impScore?.imp7;
  if (imp7 === null || imp7 === undefined) return '';
  if (imp7 >= IMP_HOT_THRESHOLD)   return '🔥';
  if (imp7 <= IMP_COLD_THRESHOLD)  return '❄️';
  return '';
}

/**
 * getImpLabel(impS)
 * Returns a qualitative label for a season IMP value.
 * Used in trade card text (Section 30.6).
 *
 * @param {Number|null} impS
 * @returns {String}
 */
export function getImpLabel(impS) {
  if (impS === null || impS === undefined) return 'limited sample';
  if (impS >= IMP_ELITE_THRESHOLD)   return 'elite contributor';
  if (impS >= 3.0)                   return 'solid starter';
  if (impS >= 1.0)                   return 'average starter';
  if (impS >= IMP_BELOW_REPLACEMENT) return 'replacement level';
  return 'below replacement';
}

// ─────────────────────────────────────────────────────────────
// IMP LEADERBOARD
// ─────────────────────────────────────────────────────────────

/**
 * getImpLeaderboard(state, topN?)
 * Returns top N hitters and top N pitchers by IMP-S.
 * Used on League screen stat leaders section.
 *
 * @param {Object} state
 * @param {Number} topN
 * @returns {{ hitters: LeaderEntry[], pitchers: LeaderEntry[] }}
 */
export function getImpLeaderboard(state, topN = 5) {
  const allRosterIds = [
    ...(state.userTeam?.rosterIds || []),
    ...(state.leagueTeams || []).flatMap(t => t.rosterIds || []),
  ];

  const entries = allRosterIds
    .map(id => ({
      playerId: id,
      player:   state.players[id],
      impScore: state.impScores?.[id] || null,
    }))
    .filter(e => e.player && e.impScore?.impS !== null && e.impScore?.impS !== undefined);

  const hitters  = entries
    .filter(e => !_isPitcher(e.player))
    .sort((a, b) => (b.impScore.impS || 0) - (a.impScore.impS || 0))
    .slice(0, topN)
    .map(e => _leaderEntry(e));

  const pitchers = entries
    .filter(e => _isPitcher(e.player))
    .sort((a, b) => (b.impScore.impS || 0) - (a.impScore.impS || 0))
    .slice(0, topN)
    .map(e => _leaderEntry(e));

  return { hitters, pitchers };
}

function _leaderEntry({ playerId, player, impScore }) {
  return {
    playerId,
    name:   player.name,
    pos:    player.pos,
    teamId: player.teamId,
    ovr:    player.ovr,
    impS:   impScore.impS,
    imp7:   impScore.imp7,
    hot:    getHotColdIndicator(impScore),
  };
}

// ─────────────────────────────────────────────────────────────
// WINDOW CALCULATION
// ─────────────────────────────────────────────────────────────

function _computeWindow(player, gameLog, windowDays, gameIndex, isPitcher, minPA, minIP) {
  // Collect entries within the window
  const windowStart = gameIndex - windowDays;
  const entries     = gameLog.filter(e => e.gameIndex >= windowStart);

  if (entries.length === 0) return null;

  // Sum stats across window entries
  const windowed = _sumLogEntries(entries);

  // Check minimum sample
  if (isPitcher) {
    if ((windowed.ip || 0) < minIP) return null;
    return _pitcherIMP(windowed);
  } else {
    if ((windowed.ab || 0) < minPA) return null;
    return _hitterIMP(windowed, player);
  }
}

function _computeSeasonIMP(player, isPitcher) {
  const stats = player.stats || {};
  if (isPitcher) {
    if ((stats.ip || 0) < IMP_MIN_IP_SEASON) return null;
    return _pitcherIMP(stats);
  } else {
    if ((stats.ab || 0) < IMP_MIN_PA_SEASON) return null;
    return _hitterIMP(stats, player);
  }
}

function _sumLogEntries(entries) {
  const sum = {};
  for (const entry of entries) {
    for (const [key, val] of Object.entries(entry.stats || {})) {
      sum[key] = (sum[key] || 0) + (val || 0);
    }
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────
// HITTER IMP FORMULA (Section 30.3)
// ─────────────────────────────────────────────────────────────

function _hitterIMP(stats, player) {
  const ab  = stats.ab  || 0;
  const h   = stats.h   || 0;
  const hr  = stats.hr  || 0;
  const rbi = stats.rbi || 0;
  const bb  = stats.bb  || 0;
  const k   = stats.k   || 0;
  const sb  = stats.sb  || 0;
  const cs  = stats.cs  || 0;
  const tb  = stats.tb  || h; // total bases — fallback to hits if missing

  if (ab === 0) return null;

  const pa  = ab + bb;

  // Core rate stats
  const avg     = h / ab;
  const obp     = (h + bb) / pa;
  const slg     = tb / ab;
  const ops     = obp + slg;
  const hrRate  = hr / ab;
  const rbiRate = rbi / ab;
  const bbPct   = bb / pa;
  const kPct    = k  / pa;
  const sbNet   = sb - (cs * 1.5);

  // BABIP (used for luck adjustment)
  const babip = (h - hr) / Math.max(1, ab - k - hr);

  // Position normalization
  const pos         = player?.nativePos || player?.pos || 'OF';
  const posAvgOPS   = IMP_POS_AVG_OPS[pos]     || IMP_LEAGUE_AVG_OPS;
  const posAvgHR    = IMP_POS_AVG_HR_RATE[pos]  || 0.030;

  // Delta values
  const opsDelta    = ops     - posAvgOPS;
  const hrDelta     = hrRate  - posAvgHR;
  const rbiDelta    = rbiRate - (posAvgHR * 2.5); // rough RBI rate proxy
  const bbDelta     = bbPct   - IMP_LEAGUE_AVG_BB_PCT;
  const kDelta      = kPct    - IMP_LEAGUE_AVG_K_PCT;

  // BABIP luck adjustment
  const careerBabip = player?.careerStats?.babip || 0.300;
  let babipAdj = 0;
  if (babip - careerBabip > IMP_H_BABIP_ADJ_TRIGGER) {
    babipAdj = (babip - careerBabip - IMP_H_BABIP_ADJ_TRIGGER) * IMP_H_BABIP_ADJ_WEIGHT;
  }

  const imp = (opsDelta   * IMP_H_OPS_WEIGHT)
            + (hrDelta    * IMP_H_HR_WEIGHT)
            + (rbiDelta   * IMP_H_RBI_WEIGHT)
            + (sbNet      * IMP_H_SB_WEIGHT)
            + (bbDelta    * IMP_H_DISCIPLINE_WEIGHT)
            - (kDelta     * IMP_H_STRIKEOUT_PENALTY)
            - babipAdj;

  return _round(imp);
}

// ─────────────────────────────────────────────────────────────
// PITCHER IMP FORMULA (Section 30.4)
// ─────────────────────────────────────────────────────────────

function _pitcherIMP(stats) {
  const ip    = stats.ip  || 0;
  const er    = stats.er  || 0;
  const h     = stats.h_allowed || 0;
  const bb    = stats.bb  || 0;
  const k     = stats.k   || 0;
  const hr    = stats.hr_allowed || 0;
  const qs    = stats.qs  || 0;
  const gs    = stats.gs  || 0;
  const sv    = stats.sv  || 0;
  const svo   = stats.svo || sv; // save opportunities
  const hld   = stats.hld || 0;
  const bs    = stats.bs  || 0; // blown saves

  if (ip <= 0) return null;

  // Per-9-innings rates
  const era    = (er / ip) * 9;
  const whip   = (h + bb) / ip;
  const k9     = (k  / ip) * 9;
  const bb9    = (bb / ip) * 9;
  const hr9    = (hr / ip) * 9;

  // Delta values (positive = better than league average)
  const eraDelta  = IMP_LEAGUE_AVG_ERA  - era;   // lower ERA = positive delta
  const whipDelta = IMP_LEAGUE_AVG_WHIP - whip;  // lower WHIP = positive delta
  const k9Delta   = k9   - IMP_LEAGUE_AVG_K9;    // higher K/9 = positive
  const bb9Delta  = bb9  - IMP_LEAGUE_AVG_BB9;   // higher BB/9 = negative
  const hr9Delta  = hr9  - IMP_LEAGUE_AVG_HR9;   // higher HR/9 = negative

  // Role-specific bonuses
  const qsRate  = gs > 0 ? qs / gs : 0;
  const svPct   = svo > 0 ? sv / svo : 0;
  const hldRate = (hld + bs) > 0 ? hld / (hld + bs) : 0;

  // Durability bonus — logarithmic so volume helps without dominating
  const ipBonus = ip > 0 ? Math.log(ip) * IMP_P_IP_LOG_SCALE : 0;

  const imp = (eraDelta  * IMP_P_ERA_WEIGHT)
            + (whipDelta * IMP_P_WHIP_WEIGHT)
            + (k9Delta   * IMP_P_K9_WEIGHT)
            - (bb9Delta  * IMP_P_WALK_PENALTY)
            - (hr9Delta  * IMP_P_HR_PENALTY)
            + (qsRate    * IMP_P_QS_BONUS)
            + (svPct     * IMP_P_SAVE_BONUS)
            + (hldRate   * IMP_P_HOLD_BONUS)
            + ipBonus;

  return _round(imp);
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function _isPitcher(player) {
  return ['SP', 'RP'].includes(player?.pos);
}

function _hasSeasonStats(player, isPitcher) {
  const stats = player?.stats || {};
  return isPitcher ? (stats.ip || 0) > 0 : (stats.ab || 0) > 0;
}

function _round(val) {
  return Math.round(val * 100) / 100;
}
