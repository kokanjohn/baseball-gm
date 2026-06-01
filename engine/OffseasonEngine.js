/**
 * engine/OffseasonEngine.js
 * 6-day offseason sequencing, gate management, and spring training transition.
 *
 * The offseason lasts exactly 6 real calendar days. Each day has a primary
 * focus and distinct card pools. Hard gates must resolve before spring training
 * can begin — if still unresolved at Day 6, they auto-resolve on the
 * conservative path with a penalty.
 *
 * Rules:
 *   - Pure functions. No state reads or writes. GameEngine applies mutations.
 *   - advanceOffseasonDay() is called once per real calendar day by GameEngine.
 *   - checkHardGates() determines whether spring training can begin.
 *   - autoResolveHardGates() fires on Day 6 for any unresolved hard gates.
 *   - The 12-step processing sequence (Section 13.2) is orchestrated here,
 *     not scattered across GameEngine.
 *
 * Section references: Section 13.2 (offseason processing), Section 23 (offseason structure)
 */

import {
  PHASE,
  PLAYER_GROUP,
  SALARY_BY_OVR,
  RETIREMENT_AGE_HARD,
  RETIREMENT_AGE_SOFT,
  RETIREMENT_OVR_SOFT,
} from '../data/constants.js';

import { computeAge } from './PlayerFactory.js';

// ─────────────────────────────────────────────────────────────
// OFFSEASON CONSTANTS
// ─────────────────────────────────────────────────────────────

const OFFSEASON_DURATION_DAYS = 6;
const MS_PER_DAY              = 86_400_000;

// Card pools active on each day (day 1-6)
export const OFFSEASON_DAY_POOLS = Object.freeze({
  1: ['DECISIONS_POOL'],                                          // Season summary, ownership card
  2: ['DECISIONS_POOL'],                                         // Expiring contracts, CPU poaching
  3: ['DECISIONS_POOL','MANAGER_CONTRACT_POOL','COACHING_CONTRACT_POOL'], // Staff renewals, trades
  4: ['DECISIONS_POOL'],                                         // Facilities, farm, free agency
  5: ['DECISIONS_POOL'],                                         // Final reminder, urgent notifications
  6: ['DECISIONS_POOL'],                                         // Auto-resolve day, spring begins
});

// Hard gate descriptions for notification text
const HARD_GATE_LABELS = Object.freeze({
  ownership:  'Ownership evaluation',
  contracts:  'Expiring player contracts',
  manager:    'Manager contract',
});

// ─────────────────────────────────────────────────────────────
// OFFSEASON INITIALIZATION
// ─────────────────────────────────────────────────────────────

/**
 * initOffseason(state, now?)
 * Sets up the offseason state at the start of the OFFSEASON phase.
 * Called by GameEngine when entering OFFSEASON.
 * Returns mutations.
 *
 * @param {Object} state
 * @param {Number} now    — Unix ms
 * @returns {Object} mutations
 */
export function initOffseason(state, now = Date.now()) {
  return {
    offseasonDay:             1,
    offseasonStartedAt:       now,
    offseasonHardGatesCleared: false,
    _offseasonGate:            'AWAITING_OWNERSHIP_CARD',
  };
}

// ─────────────────────────────────────────────────────────────
// DAY ADVANCEMENT
// ─────────────────────────────────────────────────────────────

/**
 * getOffseasonDay(state, now?)
 * Returns the current offseason day based on real time elapsed.
 * Day advances every 24 hours from offseasonStartedAt.
 * Capped at OFFSEASON_DURATION_DAYS — does not advance past Day 6
 * until hard gates are cleared.
 *
 * @param {Object} state
 * @param {Number} now
 * @returns {Number} current day (1-6)
 */
export function getOffseasonDay(state, now = Date.now()) {
  const started = state.offseasonStartedAt || now;
  const elapsed = now - started;
  const dayByTime = Math.floor(elapsed / MS_PER_DAY) + 1;
  return Math.min(dayByTime, OFFSEASON_DURATION_DAYS);
}

/**
 * advanceOffseasonDay(state, now?)
 * Returns mutations if the offseason day should advance.
 * Returns null if no advancement needed.
 *
 * @param {Object} state
 * @param {Number} now
 * @returns {Object|null} mutations or null
 */
export function advanceOffseasonDay(state, now = Date.now()) {
  if (state.phase !== PHASE.OFFSEASON) return null;

  const newDay     = getOffseasonDay(state, now);
  const currentDay = state.offseasonDay || 1;

  if (newDay <= currentDay) return null;

  return { offseasonDay: newDay };
}

// ─────────────────────────────────────────────────────────────
// HARD GATE MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * checkHardGates(state)
 * Returns the current state of all three hard gates.
 * Spring training cannot begin until all hard gates are cleared.
 *
 * Hard gates:
 *   1. Ownership evaluation card (sets financial params for new season)
 *   2. All expiring player contracts on active roster
 *   3. Manager contract renewal
 *
 * @param {Object} state
 * @returns {Object} { cleared: Boolean, gates: { ownership, contracts, manager } }
 */
export function checkHardGates(state) {
  const inbox = state.inbox || [];

  // Ownership: no unresolved ownership card in inbox
  const ownershipPending = inbox.some(
    c => !c.resolved && (c.tag === 'OWNERSHIP' || c.tag === 'FINANCIAL_PARAMS')
  );

  // Contracts: no unresolved re-sign cards for active roster players
  const contractsPending = inbox.some(
    c => !c.resolved && c.tag === 'CONTRACT_EXPIRY'
  );

  // Manager: no unresolved manager contract card
  const managerPending = inbox.some(
    c => !c.resolved && (c.tag === 'MANAGER_CONTRACT' || c.cardId?.startsWith('mc'))
  );

  const gates = {
    ownership: !ownershipPending,
    contracts: !contractsPending,
    manager:   !managerPending,
  };

  const cleared = gates.ownership && gates.contracts && gates.manager;

  return { cleared, gates };
}

/**
 * autoResolveHardGates(state)
 * Called on Day 6 — auto-resolves any unresolved hard gates on
 * the conservative path with a penalty.
 * Returns { mutations, penalties: String[] }
 *
 * @param {Object} state
 * @returns {Object} { mutations, penalties }
 */
export function autoResolveHardGates(state) {
  const { gates } = checkHardGates(state);
  const mutations = { userTeam: {}, inbox: [...(state.inbox || [])] };
  const penalties = [];

  if (!gates.ownership) {
    // Conservative ownership resolution: tightest financial offer
    mutations.userTeam.finances = {
      ...(state.userTeam?.finances || {}),
      payrollCap:      Math.max(8000, (state.userTeam?.finances?.payrollCap || 10000) - 1000),
      operatingBudget: Math.max(300,  (state.userTeam?.finances?.operatingBudget || 500)  - 100),
    };
    mutations.userTeam.ownerTrust = Math.max(0, (state.userTeam?.ownerTrust || 50) - 8);
    penalties.push('Ownership made financial decisions in your absence. Budget reduced.');

    // Auto-resolve ownership cards
    mutations.inbox = mutations.inbox.map(c =>
      (!c.resolved && (c.tag === 'OWNERSHIP' || c.tag === 'FINANCIAL_PARAMS'))
        ? { ...c, resolved: true, choice: 'auto', resolvedAt: state.currentGameIndex || 0 }
        : c
    );
  }

  if (!gates.contracts) {
    // Let all expiring players walk (conservative = cheapest)
    const expiringIds = _getExpiringPlayerIds(state);
    const playerMutations = {};
    for (const id of expiringIds) {
      playerMutations[id] = {
        contractExpired: true,
        teamId:          null,
        group:           'freeAgent',
        tier:            'farm',
      };
      // Remove from active roster
      if (!mutations.userTeam.rosterIds) {
        mutations.userTeam.rosterIds = [...(state.userTeam?.rosterIds || [])];
      }
      mutations.userTeam.rosterIds = mutations.userTeam.rosterIds.filter(rid => rid !== id);
    }
    if (expiringIds.length > 0) {
      mutations.players = playerMutations;
      penalties.push(`${expiringIds.length} expiring contract(s) auto-resolved. Players walked.`);
    }
    mutations.userTeam.morale = Math.max(0, (state.userTeam?.morale || 50) - 5);
    mutations.inbox = mutations.inbox.map(c =>
      (!c.resolved && c.tag === 'CONTRACT_EXPIRY')
        ? { ...c, resolved: true, choice: 'auto', resolvedAt: state.currentGameIndex || 0 }
        : c
    );
  }

  if (!gates.manager) {
    // Auto-renew manager at current salary
    mutations.userTeam.coachingStaff = {
      ...(state.userTeam?.coachingStaff || {}),
      manager: {
        ...(state.userTeam?.coachingStaff?.manager || {}),
        contractExpiry: (state.seasonNum || 1) + 2,
      },
    };
    mutations.userTeam.managerConfidence = Math.max(0, (state.userTeam?.managerConfidence || 60) - 5);
    penalties.push('Manager contract auto-renewed. Manager confidence reduced.');
    mutations.inbox = mutations.inbox.map(c =>
      (!c.resolved && (c.tag === 'MANAGER_CONTRACT' || c.cardId?.startsWith('mc')))
        ? { ...c, resolved: true, choice: 'auto', resolvedAt: state.currentGameIndex || 0 }
        : c
    );
  }

  mutations.offseasonHardGatesCleared = true;

  return { mutations, penalties };
}

// ─────────────────────────────────────────────────────────────
// 12-STEP OFFSEASON PROCESSING (Section 13.2)
// ─────────────────────────────────────────────────────────────

/**
 * processOffseasonStep1(state)
 * Step 1: Lock the season record and archive.
 * Called immediately when OFFSEASON phase begins.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processOffseasonStep1(state) {
  return {
    seasonHistory: [
      ...(state.seasonHistory || []),
      {
        seasonNum:  state.seasonNum,
        wins:       state.userTeam.wins   || 0,
        losses:     state.userTeam.losses || 0,
        phase:      state.phase,
        lockedAt:   Date.now(),
      },
    ],
  };
}

/**
 * processOffseasonSteps2to5(state)
 * Steps 2-5: Archive stats, apply aging + development, flag contract expiry.
 * These run silently on Day 1 before card delivery.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processOffseasonSteps2to5(state) {
  const playerMutations = {};
  const seasonNum = state.seasonNum || 1;

  for (const [playerId, player] of Object.entries(state.players || {})) {
    if (!player || player.tier === 'retired') continue;

    const isPitcher = ['SP', 'RP'].includes(player.pos);
    const updates   = {};

    // Step 2: Archive season stats → career
    const stats = player.stats || {};
    const career = { ...(player.careerStats || {}) };
    const statKeys = Object.keys(stats);
    for (const k of statKeys) {
      if (typeof stats[k] === 'number' && typeof career[k] === 'number') {
        career[k] = (career[k] || 0) + (stats[k] || 0);
      }
    }
    career.seasons = (career.seasons || 0) + 1;
    if ((player.ovr || 55) > (career.peakOvr || 0)) {
      career.peakOvr    = player.ovr;
      career.peakSeason = seasonNum;
    }
    updates.careerStats = career;

    // Reset season stats
    const freshStats = {};
    for (const k of statKeys) freshStats[k] = 0;
    updates.stats       = freshStats;
    updates.springStats = Object.fromEntries(
      Object.keys(player.springStats || {}).map(k => [k, 0])
    );

    // Clear IMP game log (new season)
    updates._impGameLog = [];

    // Step 5: Contract expiry flags
    const expiry = player.contractExpiry || 0;
    if (expiry <= seasonNum) {
      updates.contractExpired       = true;
      updates._contractExpiringNext = false;
    } else if (expiry === seasonNum + 1) {
      updates._contractExpiringNext = true;
      updates.contractExpired       = false;
    } else {
      updates._contractExpiringNext = false;
      updates.contractExpired       = false;
    }

    // Clear injury penalty (new season)
    updates.injuryPenalty = null;

    playerMutations[playerId] = updates;
  }

  return { players: playerMutations };
}

/**
 * processOffseasonStep7(state)
 * Step 7: CPU team roster turnover.
 * CPU teams process expired contracts, release or re-sign players.
 * Called after user re-sign decisions are complete (Day 2+).
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processOffseasonStep7(state) {
  const playerMutations = {};
  const leagueTeams     = state.leagueTeams ? [...state.leagueTeams] : [];
  const freeAgentPool   = [...(state.freeAgentPool || [])];

  for (let i = 0; i < leagueTeams.length; i++) {
    const team        = { ...leagueTeams[i] };
    const newRosterIds = [];

    for (const playerId of (team.rosterIds || [])) {
      const player = state.players[playerId];
      if (!player) continue;

      if (player.contractExpired) {
        // CPU re-signs if OVR >= 60 and 65% chance
        if (player.ovr >= 60 && Math.random() < 0.65) {
          const newYears = 1 + Math.floor(Math.random() * 3);
          playerMutations[playerId] = {
            contractExpired:       false,
            _contractExpiringNext: false,
            contractExtended:      false,
            contractYears:         newYears,
            contractExpiry:        state.seasonNum + newYears,
            contractSalary:        _marketSalary(player.ovr),
          };
          newRosterIds.push(playerId);
        } else {
          // Release to free agency
          playerMutations[playerId] = {
            contractExpired: false,
            teamId:          null,
            group:           'freeAgent',
            tier:            'farm',
          };
          freeAgentPool.push(playerId);
        }
      } else {
        newRosterIds.push(playerId);
      }
    }

    leagueTeams[i] = { ...team, rosterIds: newRosterIds };
  }

  return { players: playerMutations, leagueTeams, freeAgentPool };
}

/**
 * processOffseasonStep8(state)
 * Step 8: Payroll recalculation and financial reset for new season.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processOffseasonStep8(state) {
  // Recalculate payroll from active roster
  const rosterIds = state.userTeam?.rosterIds || [];
  const payroll   = rosterIds.reduce((sum, id) => {
    const p = state.players[id];
    return sum + (p?.contractSalary || 0);
  }, 0);

  return {
    userTeam: {
      finances: {
        payroll,
        operatingSpent:  0,
        revenueHistory: [
          ...(state.userTeam?.finances?.revenueHistory || []),
          { seasonNum: state.seasonNum, revenue: state.userTeam?.finances?.revenue || 0 },
        ],
        revenue: 0,
      },
    },
  };
}

/**
 * processOffseasonStep11to12(state)
 * Steps 11-12: Season number increment, schedule generation setup.
 * Returns partial mutations — GameEngine handles actual schedule generation
 * since it requires access to SeasonEngine.
 *
 * @param {Object} state
 * @returns {Object} mutations
 */
export function processOffseasonStep11to12(state) {
  return {
    seasonNum:           (state.seasonNum || 1) + 1,
    currentGameIndex:    0,
    offseasonDay:        0,
    offseasonStartedAt:  null,
    offseasonHardGatesCleared: false,
    _offseasonGate:      null,
    userTeam: {
      wins:   0,
      losses: 0,
      streak: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// SPRING TRAINING READINESS
// ─────────────────────────────────────────────────────────────

/**
 * canBeginSpringTraining(state, now?)
 * Returns true if spring training can begin.
 * Requires: all hard gates cleared AND (Day 6 reached OR all gates cleared early).
 *
 * @param {Object} state
 * @param {Number} now
 * @returns {Boolean}
 */
export function canBeginSpringTraining(state, now = Date.now()) {
  if (state.phase !== PHASE.OFFSEASON) return false;
  if (state.offseasonHardGatesCleared) return true;

  const { cleared } = checkHardGates(state);
  return cleared;
}

/**
 * getSoftGateAutoResolveDay(cardTag)
 * Returns the day number on which a soft gate auto-resolves.
 * Section 23.2:
 *   - Coaching staff renewals: Day 4 + 4 days = auto after 4 days
 *   - CPU poaching: 4 days
 *   - Free agency signings: 3 days
 *
 * @param {String} cardTag
 * @returns {Number} offseason day to auto-resolve
 */
export function getSoftGateAutoResolveDay(cardTag) {
  const map = {
    COACHING_CONTRACT: 4,
    CPU_POACHING:      4,
    FREE_AGENCY:       3,
  };
  return map[cardTag] || 5;
}

// ─────────────────────────────────────────────────────────────
// OFFSEASON STATUS SUMMARY
// ─────────────────────────────────────────────────────────────

/**
 * getOffseasonStatus(state, now?)
 * Returns a summary of the current offseason state for the UI.
 *
 * @param {Object} state
 * @param {Number} now
 * @returns {Object} status summary
 */
export function getOffseasonStatus(state, now = Date.now()) {
  const day         = getOffseasonDay(state, now);
  const { cleared, gates } = checkHardGates(state);
  const daysLeft    = Math.max(0, OFFSEASON_DURATION_DAYS - day);
  const isDay6      = day >= OFFSEASON_DURATION_DAYS;
  const pools       = OFFSEASON_DAY_POOLS[Math.min(day, 6)] || ['DECISIONS_POOL'];

  const blockers = Object.entries(gates)
    .filter(([, v]) => !v)
    .map(([k]) => HARD_GATE_LABELS[k] || k);

  return {
    day,
    daysLeft,
    isDay6,
    hardGatesCleared: cleared,
    blockers,
    activePools:      pools,
    canBeginSpring:   cleared,
    autoResolvesFiring: isDay6 && !cleared,
  };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _getExpiringPlayerIds(state) {
  const seasonNum = state.seasonNum || 1;
  return (state.userTeam?.rosterIds || []).filter(id => {
    const p = state.players[id];
    return p && (p.contractExpiry <= seasonNum || p.contractExpired);
  });
}

function _marketSalary(ovr) {
  for (const tier of Object.values(SALARY_BY_OVR)) {
    if (ovr >= tier.ovrMin && ovr <= tier.ovrMax) {
      return Math.round((tier.salMin + tier.salMax) / 2);
    }
  }
  return 100; // fallback $100K
}
