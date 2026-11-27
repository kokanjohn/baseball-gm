/**
 * engine/cards/Helpers.js
 * CardEngine, roster, narrative-flag, budget and text helpers, and utilities.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import { PLAYER_GROUP } from '../../data/constants.js';
import { diceId, eventRand, inEvent } from '../Dice.js';

// ─────────────────────────────────────────────────────────────
// ROSTER HELPERS
// ─────────────────────────────────────────────────────────────






export function _hasBenchSP(state) {
  return (state.userTeam?.rosterIds || []).some(id => {
    const p = state.players[id];
    return p && p.group === PLAYER_GROUP.PITCHER_BENCH && p.pos === 'SP' && !p.isInjured;
  });
}


export function _hasPositionCoverage(state) {
  return (state.userTeam?.rosterIds || []).some(id => {
    const p = state.players[id];
    return p && [PLAYER_GROUP.STARTING_HITTERS, PLAYER_GROUP.BENCH_HITTERS].includes(p.group) && !p.isInjured;
  });
}


// ─────────────────────────────────────────────────────────────
// NARRATIVE FLAG HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * _resolveSubject(flagSubjectTemplate, instance)
 * Resolves a flagSubject template string to an actual ID.
 * Currently supports '{playerId}' — expands to the instance's target player ID.
 * Returns null if the template doesn't resolve to a known value.
 *
 * @param {String} template  — e.g. '{playerId}' or a literal ID string
 * @param {Object} instance  — card instance
 * @returns {String|null}
 */
export function _resolveSubject(template, instance) {
  if (!template) return null;
  if (template === '{playerId}') return instance._targetPlayerId || null;
  // Literal subject ID (already resolved at delivery time)
  return template;
}


// ─────────────────────────────────────────────────────────────
// BUDGET COST HELPERS
// ─────────────────────────────────────────────────────────────


export function _resolveBudgetCost(costK) {
  // Amounts are resolved to $K at delivery (_createInstance), from the same
  // draw the card text shows. Anything else is treated as no cost.
  return typeof costK === 'number' && Number.isFinite(costK) ? costK : 0;
}



// ─────────────────────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

export function _uuid() {
  // r139 §121 inside a world event, from its stream (the look-ahead and the real run make the same id).
  return inEvent() ? diceId(eventRand) : crypto.randomUUID();
}
