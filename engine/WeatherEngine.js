/**
 * engine/WeatherEngine.js
 * Weather time series generation, game status transitions, and field impact.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - One source of truth: state.weatherBuffer. Every system reads from it.
 *   - Game status transitions are the engine's primary output — GameEngine
 *     calls applyWeatherDelay(), suspendGame(), resumeSuspendedGame() to act.
 *   - Does NOT generate inbox cards. Fires event objects that CardEngine reads.
 *
 * Section references: Section 8.8 (weather system), Section 8.9 (groundskeeper)
 */

import {
  GAME_STATUS,
  WEATHER_BUFFER_HOURS_FREE,
  WEATHER_BUFFER_HOURS_PREMIUM,
  WEATHER_BUFFER_REFRESH_AHEAD,
  WEATHER_WATCH_WINDOW_HIGH_REL_MIN,
  WEATHER_WATCH_WINDOW_DEFAULT_MIN,
  WEATHER_CARD_EXPIRY_WATCH_MIN,
  WEATHER_CARD_EXPIRY_DELAY_MIN,
  WEATHER_CARD_EXPIRY_DELAY_EXT_MIN,
  WEATHER_CARD_EXPIRY_POSTPONED_HOURS,
  WEATHER_IGNORE_WATCH_MORALE_PENALTY,
  WEATHER_IGNORE_WATCH_ATMOS_PENALTY,
  WEATHER_IGNORE_DELAY_MORALE_PENALTY,
  WEATHER_PRECIP_MODERATE_MIN,
  WEATHER_PRECIP_MODERATE_MAX,
  WEATHER_PRECIP_HEAVY_MIN,
  WEATHER_PRECIP_HEAVY_MAX,
  WEATHER_PRECIP_SEVERE_MIN,
  WEATHER_DELAY_PROB_MODERATE,
  WEATHER_POSTPONE_PROB_MODERATE,
  WEATHER_DELAY_PROB_HEAVY,
  WEATHER_POSTPONE_PROB_HEAVY,
  WEATHER_DELAY_PROB_SEVERE,
  WEATHER_POSTPONE_PROB_SEVERE,
  WEATHER_TEMP_AUTO_POSTPONE_F,
  WEATHER_TEMP_COLD_PRECIP_F,
  WEATHER_TEMP_COLD_POSTPONE_BONUS,
  WEATHER_SUSPEND_INTENSITY,
  WEATHER_OFFICIAL_INNINGS,
  GROUNDSKEEPER_REL_HIGH,
  GROUNDSKEEPER_REL_LOW,
  SIM_WEATHER_ADJ,
  REGIONS,
  REGION_DEFAULT,
} from '../data/constants.js';

const MS_PER_HOUR   = 3_600_000;
const MS_PER_MINUTE = 60_000;

// ─────────────────────────────────────────────────────────────
// WEATHER CONDITIONS
// ─────────────────────────────────────────────────────────────

// Conditions in escalating severity order
const CONDITIONS = ['Clear', 'Overcast', 'Hot', 'Cold', 'Rain', 'Storm'];

// Probability weights for condition generation (by season segment)
const CONDITION_WEIGHTS = Object.freeze({
  spring: { Clear: 0.45, Overcast: 0.20, Hot: 0.05, Cold: 0.15, Rain: 0.12, Storm: 0.03 },
  summer: { Clear: 0.50, Overcast: 0.15, Hot: 0.20, Cold: 0.00, Rain: 0.10, Storm: 0.05 },
  fall:   { Clear: 0.40, Overcast: 0.25, Hot: 0.02, Cold: 0.15, Rain: 0.13, Storm: 0.05 },
});

// Which conditions are threatening (trigger PRE_GAME_WATCH)
const THREATENING_CONDITIONS = new Set(['Rain', 'Storm']);

// Which conditions delay a game (transition SCHEDULED/PRE_GAME_WATCH → DELAYED)
const DELAY_CONDITIONS = new Set(['Rain', 'Storm']);

// Which conditions force postponement if present at first pitch
const POSTPONE_CONDITIONS = new Set(['Storm']);

// Which conditions can cause mid-game suspension
const SUSPEND_CONDITIONS = new Set(['Storm', 'Rain']);

// ─────────────────────────────────────────────────────────────
// BUFFER GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * generateWeatherBuffer(fromTimestamp, seasonSegment, isPremium?)
 * Creates a 48-hour (free) or 168-hour (premium) hourly frame array.
 * Each frame represents conditions at that hour.
 *
 * Frames are correlated — weather systems persist and evolve, not random per hour.
 *
 * @param {Number}  fromTimestamp  — Unix ms to start from (usually Date.now())
 * @param {String}  seasonSegment  — 'spring'|'summer'|'fall'
 * @param {Boolean} isPremium
 * @returns {Object} weatherBuffer { generatedAt, hourlyFrames }
 */
export function generateWeatherBuffer(fromTimestamp, seasonSegment = 'summer', isPremium = true, region = REGION_DEFAULT) {
  // isPremium defaults to true — full buffer always generated during development.
  // Free/premium gating is a UI display concern handled in Phase 18 (monetization),
  // not a data generation concern. Section 1.11b.
  const hours  = isPremium ? WEATHER_BUFFER_HOURS_PREMIUM : WEATHER_BUFFER_HOURS_FREE;
  const frames = [];

  // Region config — drives climate character (Section 8.13)
  const regionCfg = REGIONS[region] ?? REGIONS[REGION_DEFAULT];

  // Build region-adjusted condition weights for this season segment
  const baseWeights = { ...(CONDITION_WEIGHTS[seasonSegment] ?? CONDITION_WEIGHTS.summer) };
  const adjustedWeights = _applyRegionWeights(baseWeights, regionCfg, seasonSegment);

  // Generate correlated weather system
  // Storm cells last 4–12 hours, clear periods last 8–24 hours
  let currentCondition = _pickConditionWeighted(adjustedWeights);
  let conditionHoursRemaining = _rng(6, 18);

  for (let h = 0; h < hours; h++) {
    const timestamp = fromTimestamp + (h * MS_PER_HOUR);

    // Transition condition when current period expires
    if (conditionHoursRemaining <= 0) {
      currentCondition = _nextConditionWeighted(currentCondition, adjustedWeights);
      conditionHoursRemaining = currentCondition === 'Storm' ? _rng(2, 6)
        : currentCondition === 'Rain'    ? _rng(3, 8)
        : currentCondition === 'Clear'   ? _rng(8, 24)
        : _rng(4, 12);
    }
    conditionHoursRemaining--;

    // Intensity 0–1 (higher = more severe within condition type)
    const intensity = currentCondition === 'Clear'    ? 0.0
      : currentCondition === 'Overcast'  ? _rollFloat(0.1, 0.4)
      : currentCondition === 'Hot'       ? _rollFloat(0.4, 1.0)
      : currentCondition === 'Cold'      ? _rollFloat(0.3, 0.8)
      : currentCondition === 'Rain'      ? _rollFloat(0.3, 0.8)
      : _rollFloat(0.6, 1.0); // Storm

    const temp = _generateTemp(currentCondition, h, fromTimestamp, regionCfg);

    frames.push({
      timestamp,
      condition:       currentCondition,
      intensity,
      precipChance:    _precipChance(currentCondition, intensity),
      windSpeed:       _windSpeed(currentCondition),
      windDir:         _windDir(),
      temp,
      fieldImpact:     _computeFieldImpact(currentCondition, intensity, temp),
      scoringMod:      SIM_WEATHER_ADJ[currentCondition] ?? 0,
      // Radar cell position (0–1 on a 2D grid, moves across the frame)
      radarCellX:      _rollFloat(0, 1),
      radarCellY:      _rollFloat(0, 1),
    });
  }

  return {
    generatedAt:  fromTimestamp,
    hourlyFrames: frames,
  };
}

/**
 * needsRefresh(weatherBuffer, isPremium?)
 * Returns true if the buffer's leading edge is within WEATHER_BUFFER_REFRESH_AHEAD hours.
 *
 * @param {Object}  weatherBuffer
 * @param {Boolean} isPremium
 * @returns {Boolean}
 */
export function needsRefresh(weatherBuffer, isPremium = true) {
  // isPremium defaults to true — Section 1.11b.
  if (!weatherBuffer || !weatherBuffer.hourlyFrames?.length) return true;
  const hours    = isPremium ? WEATHER_BUFFER_HOURS_PREMIUM : WEATHER_BUFFER_HOURS_FREE;
  const lastFrame = weatherBuffer.hourlyFrames[weatherBuffer.hourlyFrames.length - 1];
  const now       = Date.now();
  const hoursLeft = (lastFrame.timestamp - now) / MS_PER_HOUR;
  return hoursLeft <= WEATHER_BUFFER_REFRESH_AHEAD;
}

// ─────────────────────────────────────────────────────────────
// FRAME LOOKUP
// ─────────────────────────────────────────────────────────────

/**
 * getFrameForTime(weatherBuffer, timestamp)
 * Returns the weather frame closest to the given timestamp.
 * Returns null if timestamp is outside the buffer window.
 *
 * @param {Object} weatherBuffer
 * @param {Number} timestamp — Unix ms
 * @returns {Object|null} WeatherFrame
 */
export function getFrameForTime(weatherBuffer, timestamp) {
  if (!weatherBuffer?.hourlyFrames?.length) return null;
  const frames = weatherBuffer.hourlyFrames;

  // Binary search for closest frame
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frames[mid].timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }

  const frame = frames[lo];
  if (!frame) return null;

  // Return null if more than 1 hour outside buffer
  if (Math.abs(frame.timestamp - timestamp) > MS_PER_HOUR * 1.5) return null;

  return frame;
}

/**
 * getRadarFrames(weatherBuffer, fromTime, hours)
 * Returns up to `hours` hourly frames starting from fromTime.
 * Used by the radar widget slider.
 *
 * @param {Object} weatherBuffer
 * @param {Number} fromTime  — Unix ms
 * @param {Number} hours     — number of frames to return (max 48 free, 168 premium)
 * @returns {Object[]} frames
 */
export function getRadarFrames(weatherBuffer, fromTime, hours = 12) {
  if (!weatherBuffer?.hourlyFrames?.length) return [];
  const startFrame = getFrameForTime(weatherBuffer, fromTime);
  if (!startFrame) return [];

  const startIdx = weatherBuffer.hourlyFrames.indexOf(startFrame);
  return weatherBuffer.hourlyFrames.slice(startIdx, startIdx + hours);
}

// ─────────────────────────────────────────────────────────────
// GAME WEATHER EVALUATION
// ─────────────────────────────────────────────────────────────

/**
 * evaluateGameWeather(game, weatherBuffer, groundskeeperRel, now?, region?)
 * Evaluates current conditions for a scheduled game.
 * Returns a transition event if the game status should change, null otherwise.
 *
 * Region modifier is applied multiplicatively to postponement probability
 * per the thresholds in Section 8.8 and the REGIONS constant (Section 8.13).
 *
 * Transition events: { type, game, frame, payload }
 * Types: 'PRE_GAME_WATCH' | 'DELAYED' | 'POSTPONED' | 'CLEAR_TO_LIVE'
 *
 * @param {Object} game
 * @param {Object} weatherBuffer
 * @param {Number} groundskeeperRel  — 0-100
 * @param {Number} now               — Unix ms (defaults to Date.now())
 * @param {String} region            — 'north'|'south'|'east'|'west'
 * @returns {Object|null} transition event
 */
export function evaluateGameWeather(game, weatherBuffer, groundskeeperRel = 50, now = Date.now(), region = REGION_DEFAULT) {
  if (!game || !weatherBuffer) return null;

  const frame = getFrameForTime(weatherBuffer, now);
  if (!frame) return null;

  const regionCfg   = REGIONS[region] ?? REGIONS[REGION_DEFAULT];
  const gameTime    = game.gameTime || 0;
  const minsToGame  = (gameTime - now) / MS_PER_MINUTE;
  const watchWindow = groundskeeperRel >= GROUNDSKEEPER_REL_HIGH
    ? WEATHER_WATCH_WINDOW_HIGH_REL_MIN
    : WEATHER_WATCH_WINDOW_DEFAULT_MIN;

  switch (game.status) {
    case GAME_STATUS.SCHEDULED:
      // Enter PRE_GAME_WATCH if threatening conditions within the watch window
      if (THREATENING_CONDITIONS.has(frame.condition) && minsToGame <= watchWindow && minsToGame > 0) {
        return _makeEvent('PRE_GAME_WATCH', game, frame, {
          expiryMs: WEATHER_CARD_EXPIRY_WATCH_MIN * MS_PER_MINUTE,
          moraleOnIgnore:  WEATHER_IGNORE_WATCH_MORALE_PENALTY,
          atmosOnIgnore:   WEATHER_IGNORE_WATCH_ATMOS_PENALTY,
        });
      }
      // Evaluate postponement probability at first-pitch window (within 15 min)
      if (Math.abs(minsToGame) < 15) {
        const postponeProb = _computePostponeProb(frame, regionCfg);
        if (postponeProb > 0 && Math.random() < postponeProb) {
          return _makeEvent('POSTPONED', game, frame, {
            expiryMs: WEATHER_CARD_EXPIRY_POSTPONED_HOURS * MS_PER_HOUR,
          });
        }
      }
      break;

    case GAME_STATUS.PRE_GAME_WATCH:
      // Escalate to DELAYED if conditions haven't improved at game time
      if (DELAY_CONDITIONS.has(frame.condition) && minsToGame <= 0) {
        return _makeEvent('DELAYED', game, frame, {
          expiryMs: WEATHER_CARD_EXPIRY_DELAY_MIN * MS_PER_MINUTE,
          moraleOnIgnore: WEATHER_IGNORE_DELAY_MORALE_PENALTY,
        });
      }
      // Conditions cleared — back to SCHEDULED
      if (!THREATENING_CONDITIONS.has(frame.condition) && minsToGame > 0) {
        return _makeEvent('CLEAR_TO_SCHEDULED', game, frame, {});
      }
      break;

    case GAME_STATUS.DELAYED: {
      // Check if conditions have cleared
      const delayDuration = (now - (game._delayStartedAt || now)) / MS_PER_MINUTE;
      if (!DELAY_CONDITIONS.has(frame.condition)) {
        // Conditions cleared — resume
        return _makeEvent('CLEAR_TO_LIVE', game, frame, {
          delayMs: delayDuration * MS_PER_MINUTE,
        });
      }
      // If delayed more than 2 hours — postpone
      if (delayDuration > 120) {
        return _makeEvent('POSTPONED', game, frame, {
          expiryMs: WEATHER_CARD_EXPIRY_POSTPONED_HOURS * MS_PER_HOUR,
        });
      }
      // Extended delay card (fires at 60 min delay mark)
      if (delayDuration > 60 && !game._extendedDelayCardFired) {
        return _makeEvent('DELAY_EXTENDED', game, frame, {
          expiryMs: WEATHER_CARD_EXPIRY_DELAY_EXT_MIN * MS_PER_MINUTE,
          delayMinutes: Math.round(delayDuration),
        });
      }
      break;
    }

    case GAME_STATUS.LIVE:
      // Check for mid-game suspension conditions
      if (SUSPEND_CONDITIONS.has(frame.condition) && frame.intensity > 0.7) {
        return _makeEvent('SUSPEND', game, frame, {});
      }
      break;

    case GAME_STATUS.SUSPENDED: {
      // Check if conditions cleared for resume
      if (!SUSPEND_CONDITIONS.has(frame.condition) || frame.intensity < 0.4) {
        const sameDay = _isSameDay(now, game.gameTime || now);
        if (sameDay) {
          return _makeEvent('RESUME_SAME_DAY', game, frame, {
            resumeTimestamp: now,
          });
        } else {
          return _makeEvent('RESUME_NEXT_DAY', game, frame, {
            resumeTimestamp: now,
          });
        }
      }
      break;
    }

    default:
      break;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// FIELD IMPACT APPLICATION
// ─────────────────────────────────────────────────────────────

/**
 * applyWeatherToGame(game, frame)
 * Returns a partial game object update with weather and fieldCondition
 * derived from the given weather frame.
 * Called at game generation time and refreshed on each tick when weather changes.
 *
 * @param {Object} game
 * @param {Object} frame  — WeatherFrame from weatherBuffer
 * @returns {Object} partial game update
 */
export function applyWeatherToGame(game, frame) {
  if (!frame) return {};

  return {
    weather: {
      label:      frame.condition,
      icon:       _conditionIcon(frame.condition),
      scoringMod: 1.0 + (frame.scoringMod || 0),
      intensity:  frame.intensity,
    },
    fieldCondition: _deriveFieldCondition(frame),
  };
}

/**
 * computeFieldConditionCarryover(previousFrames)
 * Field conditions from recent weather persist into future games.
 * Heavy rain 48h ago → elevated infieldSoftness.
 * Used when generating a game's field condition at schedule time.
 *
 * @param {Object[]} previousFrames  — last 48 frames before game time
 * @returns {Object} fieldCondition
 */
export function computeFieldConditionCarryover(previousFrames) {
  if (!previousFrames?.length) {
    return { infieldSoftness: 0, moundFirmness: 1, trackCondition: 1, temperature: 72 };
  }

  // Count recent precipitation events
  const recentRain = previousFrames.filter(f =>
    (f.condition === 'Rain' || f.condition === 'Storm') && f.intensity > 0.3
  ).length;

  const lastTemp = previousFrames[previousFrames.length - 1]?.temp || 72;

  const infieldSoftness = Math.min(1, recentRain * 0.08);
  const moundFirmness   = Math.max(0, 1 - (recentRain * 0.05));
  const trackCondition  = Math.max(0, 1 - (recentRain * 0.04));

  return {
    infieldSoftness: Math.round(infieldSoftness * 100) / 100,
    moundFirmness:   Math.round(moundFirmness   * 100) / 100,
    trackCondition:  Math.round(trackCondition  * 100) / 100,
    temperature:     lastTemp,
  };
}

// ─────────────────────────────────────────────────────────────
// AUTO-RESOLVE PENALTIES (for ignored weather cards)
// ─────────────────────────────────────────────────────────────

/**
 * getAutoResolvePenalties(eventType)
 * Returns the soft metric penalties applied when a weather card expires
 * without user action (Section 8.8 — no-action penalty).
 *
 * @param {String} eventType
 * @returns {Object} { morale, atmosphere }
 */
export function getAutoResolvePenalties(eventType) {
  switch (eventType) {
    case 'PRE_GAME_WATCH':
      return {
        morale:     WEATHER_IGNORE_WATCH_MORALE_PENALTY,
        atmosphere: WEATHER_IGNORE_WATCH_ATMOS_PENALTY,
      };
    case 'DELAYED':
      return { morale: WEATHER_IGNORE_DELAY_MORALE_PENALTY, atmosphere: 0 };
    default:
      return { morale: 0, atmosphere: 0 };
  }
}

// ─────────────────────────────────────────────────────────────
// SEASON SEGMENT DETECTION
// ─────────────────────────────────────────────────────────────

/**
 * getSeasonSegment(date?)
 * Returns the weather generation profile for the current time of year.
 * Spring training + early season = spring, midsummer = summer, late season = fall.
 *
 * @param {Date} [date]
 * @returns {String} 'spring'|'summer'|'fall'
 */
export function getSeasonSegment(date = new Date()) {
  const month = date.getMonth(); // 0-indexed
  if (month <= 4) return 'spring'; // Mar-May
  if (month <= 7) return 'summer'; // Jun-Aug
  return 'fall';                   // Sep-Oct
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _makeEvent(type, game, frame, payload) {
  return { type, gameIndex: game.index, frame, payload };
}

// ─────────────────────────────────────────────────────────────
// REGION-AWARE CONDITION HELPERS (Phase 13.5)
// ─────────────────────────────────────────────────────────────

/**
 * _applyRegionWeights(baseWeights, regionCfg, seasonSegment)
 * Adjusts condition probability weights based on regional climate character.
 *
 * North: boosts Cold/Overcast weight in spring/fall.
 * South: boosts Hot weight, afternoon thunderstorm pattern (handled at game eval).
 * East:  boosts Rain weight across all segments.
 * West:  reduces Rain/Storm weight, increases Clear.
 *
 * @param {Object} baseWeights  — from CONDITION_WEIGHTS[segment]
 * @param {Object} regionCfg    — from REGIONS[region]
 * @param {String} seasonSegment
 * @returns {Object} adjusted weights (normalized to sum to 1)
 */
function _applyRegionWeights(baseWeights, regionCfg, seasonSegment) {
  const w = { ...baseWeights };

  switch (regionCfg.id) {
    case 'north':
      // Colder springs and falls — boost Cold and Overcast
      if (seasonSegment === 'spring' || seasonSegment === 'fall') {
        w.Cold     = (w.Cold     || 0) + regionCfg.coldSeasonWeightBonus;
        w.Overcast = (w.Overcast || 0) + 0.08;
        w.Clear    = Math.max(0.10, (w.Clear || 0) - 0.20);
        w.Hot      = Math.max(0,    (w.Hot   || 0) - 0.05);
      }
      break;

    case 'south':
      // Warm all season — boost Hot, suppress Cold
      w.Hot  = (w.Hot  || 0) + 0.12;
      w.Cold = Math.max(0, (w.Cold || 0) - 0.10);
      w.Rain = (w.Rain || 0) + 0.03; // afternoon storms
      break;

    case 'east':
      // Highest rain frequency
      w.Rain     = (w.Rain     || 0) + 0.10;
      w.Overcast = (w.Overcast || 0) + 0.05;
      w.Clear    = Math.max(0.10, (w.Clear || 0) - 0.12);
      break;

    case 'west':
      // Driest — boost Clear, suppress Rain/Storm
      w.Clear   = (w.Clear   || 0) + 0.15;
      w.Rain    = Math.max(0, (w.Rain  || 0) - 0.08);
      w.Storm   = Math.max(0, (w.Storm || 0) - 0.03);
      break;
  }

  // Normalize so weights sum to 1.0
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total <= 0) return baseWeights;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
}

/**
 * _pickConditionWeighted(weights)
 * Picks a random condition from the adjusted weight table.
 *
 * @param {Object} weights  — { condition: probability }
 * @returns {String}
 */
function _pickConditionWeighted(weights) {
  const r = Math.random();
  let cum = 0;
  for (const [cond, w] of Object.entries(weights)) {
    cum += w;
    if (r < cum) return cond;
  }
  return 'Clear';
}

/**
 * _nextConditionWeighted(current, weights)
 * Conditions transition to adjacent conditions (same logic as before),
 * but biased by the adjusted weight table so regional patterns persist.
 *
 * @param {String} current
 * @param {Object} weights
 * @returns {String}
 */
function _nextConditionWeighted(current, weights) {
  const transitions = {
    Clear:    ['Clear', 'Clear', 'Overcast', 'Hot'],
    Overcast: ['Clear', 'Overcast', 'Rain', 'Overcast'],
    Hot:      ['Hot', 'Clear', 'Hot', 'Overcast'],
    Cold:     ['Cold', 'Cold', 'Overcast', 'Clear'],
    Rain:     ['Overcast', 'Rain', 'Rain', 'Storm'],
    Storm:    ['Rain', 'Rain', 'Storm', 'Overcast'],
  };
  const opts = transitions[current] || ['Clear'];
  // Pick from adjacency list — weighted sampling adds regional bias for long-term pattern
  const candidate = opts[Math.floor(Math.random() * opts.length)];
  // 30% chance: override candidate with a weighted-random pick (regional drift)
  if (Math.random() < 0.30) return _pickConditionWeighted(weights);
  return candidate;
}

/**
 * _computePostponeProb(frame, regionCfg)
 * Computes the probability of game postponement from a weather frame.
 * Uses named threshold constants (Section 8.8 — no magic numbers).
 * Applies regional modifier multiplicatively (Section 8.13).
 *
 * @param {Object} frame      — weather frame at game time
 * @param {Object} regionCfg  — from REGIONS[region]
 * @returns {Number} probability 0–1
 */
function _computePostponeProb(frame, regionCfg) {
  const { condition, intensity, temp } = frame;

  // Only Rain and Storm can postpone
  if (!DELAY_CONDITIONS.has(condition)) return 0;

  // Base postpone probability from intensity tier
  let baseProb;
  if (intensity < WEATHER_PRECIP_MODERATE_MIN) {
    // Light — play through
    baseProb = 0;
  } else if (intensity <= WEATHER_PRECIP_MODERATE_MAX) {
    baseProb = WEATHER_POSTPONE_PROB_MODERATE;
  } else if (intensity <= WEATHER_PRECIP_HEAVY_MAX) {
    baseProb = WEATHER_POSTPONE_PROB_HEAVY;
  } else {
    // Severe
    baseProb = WEATHER_POSTPONE_PROB_SEVERE;
  }

  // Temperature modifier
  if (baseProb > 0) {
    if (temp <= WEATHER_TEMP_AUTO_POSTPONE_F) {
      // Below 35°F with any precipitation → auto-postpone
      return 1.0;
    }
    if (temp <= WEATHER_TEMP_COLD_PRECIP_F) {
      baseProb = Math.min(1, baseProb + WEATHER_TEMP_COLD_POSTPONE_BONUS);
    }
  }

  // Regional modifier (multiplicative, per Section 8.13)
  const regionMod = regionCfg.postponeModifier ?? 1.0;
  return Math.min(1, baseProb * regionMod);
}

// Kept as alias — existing internal callers use the old names during transition
function _pickCondition(segment) {
  return _pickConditionWeighted(CONDITION_WEIGHTS[segment] || CONDITION_WEIGHTS.summer);
}

function _nextCondition(current, segment) {
  return _nextConditionWeighted(current, CONDITION_WEIGHTS[segment] || CONDITION_WEIGHTS.summer);
}

function _generateTemp(condition, hourOffset, fromTimestamp, regionCfg = null) {
  const date  = new Date(fromTimestamp + hourOffset * MS_PER_HOUR);
  const month = date.getMonth();
  // Base temp by month (°F)
  const baseTemps = [45, 50, 58, 65, 74, 82, 86, 85, 78, 68, 56, 47];
  const base      = baseTemps[month] || 72;
  const condAdj   = condition === 'Hot' ? 12 : condition === 'Cold' ? -15 : condition === 'Storm' ? -8 : 0;
  const dailyAdj  = Math.sin((hourOffset / 24) * Math.PI * 2) * 8; // ±8°F daily cycle
  // Regional temperature offset shifts the baseline climate (Section 8.13)
  const regionAdj = regionCfg?.tempOffset ?? 0;
  return Math.round(base + condAdj + dailyAdj + regionAdj + _rng(-3, 3));
}

function _precipChance(condition, intensity) {
  if (condition === 'Rain')    return 0.5 + intensity * 0.4;
  if (condition === 'Storm')   return 0.8 + intensity * 0.2;
  return 0;
}

function _windSpeed(condition) {
  if (condition === 'Storm')   return _rng(20, 45);
  if (condition === 'Rain')    return _rng(8,  20);
  if (condition === 'Overcast') return _rng(5, 15);
  return _rng(2, 12);
}

function _windDir() {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.floor(Math.random() * dirs.length)];
}

function _computeFieldImpact(condition, intensity, temp) {
  return {
    infieldSoftness: condition === 'Rain'  ? intensity * 0.6
      : condition === 'Storm' ? intensity * 0.8 : 0,
    moundFirmness:   condition === 'Rain'  ? 1 - intensity * 0.4
      : condition === 'Storm' ? 1 - intensity * 0.6 : 1,
    trackCondition:  condition === 'Rain'  ? 1 - intensity * 0.3
      : condition === 'Storm' ? 1 - intensity * 0.5 : 1,
    temperature:     temp,
  };
}

function _deriveFieldCondition(frame) {
  return _computeFieldImpact(frame.condition, frame.intensity, frame.temp);
}

function _conditionIcon(condition) {
  const icons = {
    Clear: '☀️', Overcast: '⛅', Hot: '🌡️', Cold: '🥶', Rain: '🌧️', Storm: '⛈️',
  };
  return icons[condition] || '🌤️';
}

function _isSameDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getFullYear() === d2.getFullYear()
      && d1.getMonth()    === d2.getMonth()
      && d1.getDate()     === d2.getDate();
}

function _rollFloat(min, max) {
  return min + Math.random() * (max - min);
}

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
