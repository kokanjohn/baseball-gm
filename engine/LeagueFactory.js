/**
 * engine/LeagueFactory.js
 * Builds the full 10-team league from scratch at game creation.
 *
 * Responsibilities:
 *   - Initialize the name registry (shuffle pool, assign draws)
 *   - Generate all 9 CPU team rosters (active + farm)
 *   - Generate the user team roster per archetype parameters
 *   - Apply archetype GM relationship adjustments
 *   - Enforce payroll cap at generation time (proportional salary compression)
 *
 * Rules:
 *   - Pure functions. No state reads or writes. Caller (GameEngine) applies results.
 *   - All UUIDs generated here via the uuid param function — callers supply
 *     crypto.randomUUID so this module stays testable without the Web Crypto API.
 *   - Farm players draw from PLAYER_NAME_POOL (same pool as active players).
 *     No separate farm name pools.
 */

import { PLAYER_NAME_POOL } from '../data/player-names.js';
import { createPlayer, computeOVR, computeAge, clamp, _freshStats } from './PlayerFactory.js';
import {
  PLAYER_GROUP,
  ARCHETYPE,
  ARCHETYPE_GM_REL_ADJUSTMENTS,
  ROSTER_LIMITS,
  GM_RELATIONSHIP_DEFAULT,
  SUB_RATING_MIN,
  SUB_RATING_MAX,
} from '../data/constants.js';

// ─────────────────────────────────────────────────────────────
// LEAGUE TEAM DEFINITIONS
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// LEAGUE TEAMS — REGION-SPECIFIC SETS
// Each region has 9 teams (4 Division A, 5 Division B).
// Team names are completely fictional — no real MLB, MiLB, or
// other professional team names at any level.
// Strength (str) values are fixed regardless of region.
// ─────────────────────────────────────────────────────────────

export const LEAGUE_TEAMS_BY_REGION = Object.freeze({

  north: [
    // Division A — cold-weather, industrial character
    { id: 'IRF', name: 'Ironfield Bears',     abbr: 'IRF', str: 0.56, divisionId: 'A' },
    { id: 'GRS', name: 'Greystone Foxes',     abbr: 'GRS', str: 0.54, divisionId: 'A' },
    { id: 'NHV', name: 'Northhaven Pines',    abbr: 'NHV', str: 0.52, divisionId: 'A' },
    { id: 'RDC', name: 'Ridgecrest Owls',     abbr: 'RDC', str: 0.50, divisionId: 'A' },
    // Division B
    { id: 'HLB', name: 'Hollowbrook Herons',  abbr: 'HLB', str: 0.57, divisionId: 'B' },
    { id: 'CLW', name: 'Coldwater Elk',        abbr: 'CLW', str: 0.53, divisionId: 'B' },
    { id: 'FBG', name: 'Frostburg Lynx',       abbr: 'FBG', str: 0.51, divisionId: 'B' },
    { id: 'ASH', name: 'Ashmont Ravens',       abbr: 'ASH', str: 0.48, divisionId: 'B' },
    { id: 'CLF', name: 'Clearfield Bucks',     abbr: 'CLF', str: 0.45, divisionId: 'B' },
  ],

  south: [
    // Division A — warm, coastal, bayou character
    { id: 'BSY', name: 'Bayside Pelicans',    abbr: 'BSY', str: 0.56, divisionId: 'A' },
    { id: 'PLM', name: 'Palmetto Kings',       abbr: 'PLM', str: 0.54, divisionId: 'A' },
    { id: 'SRG', name: 'Sunridge Hawks',       abbr: 'SRG', str: 0.52, divisionId: 'A' },
    { id: 'CPF', name: 'Copperfield Bulls',    abbr: 'CPF', str: 0.50, divisionId: 'A' },
    // Division B
    { id: 'BYO', name: 'Bayou Herons',         abbr: 'BYO', str: 0.57, divisionId: 'B' },
    { id: 'CRV', name: 'Crestview Gators',     abbr: 'CRV', str: 0.53, divisionId: 'B' },
    { id: 'SCT', name: 'Suncoast Tarpon',      abbr: 'SCT', str: 0.51, divisionId: 'B' },
    { id: 'DLT', name: 'Delta Cranes',         abbr: 'DLT', str: 0.48, divisionId: 'B' },
    { id: 'MSG', name: 'Mossglen Foxes',       abbr: 'MSG', str: 0.45, divisionId: 'B' },
  ],

  east: [
    // Division A — coastal, maritime character
    { id: 'HBR', name: 'Harborview Gulls',    abbr: 'HBR', str: 0.56, divisionId: 'A' },
    { id: 'TDL', name: 'Tideland Anchors',    abbr: 'TDL', str: 0.54, divisionId: 'A' },
    { id: 'SVL', name: 'Seagrove Osprey',     abbr: 'SVL', str: 0.52, divisionId: 'A' },
    { id: 'LSH', name: 'Lightshore Breakers', abbr: 'LSH', str: 0.50, divisionId: 'A' },
    // Division B
    { id: 'MBY', name: 'Millbay Sails',       abbr: 'MBY', str: 0.57, divisionId: 'B' },
    { id: 'CLP', name: 'Cliffport Herons',    abbr: 'CLP', str: 0.53, divisionId: 'B' },
    { id: 'CHP', name: 'Cheswick Skippers',   abbr: 'CHP', str: 0.51, divisionId: 'B' },
    { id: 'RMD', name: 'Reedmont Cranes',     abbr: 'RMD', str: 0.48, divisionId: 'B' },
    { id: 'GLP', name: 'Gulfport Mullets',    abbr: 'GLP', str: 0.45, divisionId: 'B' },
  ],

  west: [
    // Division A — desert, mountain, open country character
    { id: 'MSV', name: 'Mesaview Condors',    abbr: 'MSV', str: 0.56, divisionId: 'A' },
    { id: 'PKS', name: 'Peakstone Pumas',     abbr: 'PKS', str: 0.54, divisionId: 'A' },
    { id: 'CYN', name: 'Canyon Rams',         abbr: 'CYN', str: 0.52, divisionId: 'A' },
    { id: 'DRT', name: 'Dryrock Hawks',       abbr: 'DRT', str: 0.50, divisionId: 'A' },
    // Division B
    { id: 'HGS', name: 'Highgrass Coyotes',   abbr: 'HGS', str: 0.57, divisionId: 'B' },
    { id: 'ARD', name: 'Arroyo Dust Devils',  abbr: 'ARD', str: 0.53, divisionId: 'B' },
    { id: 'RDW', name: 'Ridgeway Eagles',     abbr: 'RDW', str: 0.51, divisionId: 'B' },
    { id: 'SDT', name: 'Sundusted Vipers',    abbr: 'SDT', str: 0.48, divisionId: 'B' },
    { id: 'SLF', name: 'Saltflat Scorpions',  abbr: 'SLF', str: 0.45, divisionId: 'B' },
  ],

});

// Default (north) exported as LEAGUE_TEAMS for backwards compat
// and for any code path that doesn't have a region yet.
export const LEAGUE_TEAMS = LEAGUE_TEAMS_BY_REGION.north;

// Roster slot definitions per group
const ACTIVE_HITTER_POSITIONS  = ['C','1B','2B','3B','SS','OF','OF','OF','DH'];
const BENCH_HITTER_POSITIONS   = ['C','1B','OF','2B/SS','1B/3B'];
const SP_COUNT                 = 5;
const BP_COUNT                 = 5;   // active bullpen (locked: 5 RP)
const PITCHER_BENCH_SP_COUNT   = 2;   // SP bench slots
const PITCHER_BENCH_RP_COUNT   = 2;   // RP bench slots
const FARM_HITTER_POSITIONS    = ['C','1B','2B/SS','1B/3B','SS','OF','OF','OF','2B','3B'];
const FARM_PITCHER_COUNT       = 10;  // 10 hitters + 10 pitchers = 20 farm per team

const SP_HANDS = ['R','R','R','L','R'];
const BP_HANDS = ['R','R','L','R','R'];  // 5 bullpen arms

// ─────────────────────────────────────────────────────────────
// NAME REGISTRY
// ─────────────────────────────────────────────────────────────

/**
 * initNameRegistry(uuidFn)
 * Shuffles PLAYER_NAME_POOL and returns sequential name slices.
 *
 * Allocation:
 *   [0–27]    → user team (28: 9 starters + 5 bench + 5 SP + 5 RP + 2 SP bench + 2 RP bench)
 *   [28–279]  → 9 CPU teams × 28 = 252 (same composition)
 *   [280–479] → 10 farm systems × 20 = 200
 *   [480–615] → card/acquisition reserve (136)
 *   [616+]    → mid-season reserve
 *
 * @returns {{ userNames, cpuNames, farmNames, reserveNames }}
 */
export function initNameRegistry() {
  const shuffled = [...PLAYER_NAME_POOL];
  _shuffle(shuffled);

  return {
    userNames:    shuffled.slice(0,   28),
    cpuNames:     shuffled.slice(28,  280),
    farmNames:    shuffled.slice(280, 480),
    reserveNames: shuffled.slice(480),
  };
}

// ─────────────────────────────────────────────────────────────
// CPU LEAGUE ROSTER GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * buildLeagueRosters(cpuNames, farmNames, seasonNum, uuidFn)
 * Generates all 9 CPU team rosters (active + farm) and returns:
 *   - players: Object — { [playerId]: PlayerObject } for all CPU players
 *   - leagueTeams: LeagueTeamObject[] — team metadata with rosterIds
 *
 * @param {String[]} cpuNames    — 252 names (28 per team)
 * @param {String[]} farmNames   — 200 names (20 per team, first 90 used for CPU farm = 9×10 hitters+10 pitchers)
 * @param {Number}   seasonNum
 * @param {Function} uuidFn      — () => String UUID
 * @returns {{ players: Object, leagueTeams: Object[] }}
 */
export function buildLeagueRosters(cpuNames, farmNames, seasonNum, uuidFn, teamDefs = LEAGUE_TEAMS) {
  const players    = {};
  const leagueTeams = [];

  let cpuNameIdx  = 0;
  let farmNameIdx = 0;

  for (const teamDef of teamDefs) {
    const teamNames = cpuNames.slice(cpuNameIdx, cpuNameIdx + 28);
    cpuNameIdx += 28;

    const teamFarmNames = farmNames.slice(farmNameIdx, farmNameIdx + 20);
    farmNameIdx += 20;

    const { rosterIds, farmIds } = _buildCPURoster(
      teamDef, teamNames, teamFarmNames, seasonNum, uuidFn, players
    );

    // Build initial rotation order from SP playerIds (first 5 SPs in rosterIds)
    const spIds = rosterIds.filter(id => {
      const p = players[id];
      return p && p.group === PLAYER_GROUP.STARTING_PITCHERS;
    });

    leagueTeams.push({
      id:         teamDef.id,
      name:       teamDef.name,
      abbr:       teamDef.abbr,
      str:        teamDef.str,
      divisionId: teamDef.divisionId,
      wins:       0,
      losses:     0,
      streak:     0,
      rosterIds,
      farmIds,
      gmRelationship: GM_RELATIONSHIP_DEFAULT,
      rotation: {
        order:        spIds,
        currentIndex: 0,
      },
    });
  }

  return { players, leagueTeams };
}

function _buildCPURoster(teamDef, teamNames, farmNames, seasonNum, uuidFn, playersOut) {
  const str      = teamDef.str;
  const baseOvr  = Math.round(str * 100);
  const rosterIds = [];
  const farmIds   = [];
  let ni = 0;

  const _make = (name, pos, group, hand, ovrMin, ovrMax, ageMin, ageMax) => {
    const targetOvr = _rng(ovrMin, ovrMax);
    const id = uuidFn();
    const p = createPlayer({
      id, name, pos, group, hand,
      targetOvr, ageMin, ageMax,
      seasonNum, teamId: teamDef.id,
    });
    playersOut[id] = p;
    return id;
  };

  // Active hitters
  const hOvrMin = clamp(baseOvr - 12, SUB_RATING_MIN, SUB_RATING_MAX);
  const hOvrMax = clamp(baseOvr + 10, SUB_RATING_MIN, SUB_RATING_MAX);
  for (const pos of ACTIVE_HITTER_POSITIONS) {
    rosterIds.push(_make(teamNames[ni++], pos, PLAYER_GROUP.STARTING_HITTERS, null, hOvrMin, hOvrMax, 23, 33));
  }

  // Bench hitters
  const bhOvrMin = clamp(baseOvr - 18, SUB_RATING_MIN, SUB_RATING_MAX);
  const bhOvrMax = clamp(baseOvr - 2,  SUB_RATING_MIN, SUB_RATING_MAX);
  for (const pos of BENCH_HITTER_POSITIONS) {
    rosterIds.push(_make(teamNames[ni++], pos, PLAYER_GROUP.BENCH_HITTERS, null, bhOvrMin, bhOvrMax, 22, 34));
  }

  // Starting pitchers
  const spOvrMin = clamp(baseOvr - 10, SUB_RATING_MIN, SUB_RATING_MAX);
  const spOvrMax = clamp(baseOvr + 12, SUB_RATING_MIN, SUB_RATING_MAX);
  for (let i = 0; i < SP_COUNT; i++) {
    rosterIds.push(_make(teamNames[ni++], 'SP', PLAYER_GROUP.STARTING_PITCHERS, SP_HANDS[i], spOvrMin, spOvrMax, 23, 35));
  }

  // Bullpen (5 active RP)
  const bpOvrMin = clamp(baseOvr - 15, SUB_RATING_MIN, SUB_RATING_MAX);
  const bpOvrMax = clamp(baseOvr + 5,  SUB_RATING_MIN, SUB_RATING_MAX);
  for (let i = 0; i < BP_COUNT; i++) {
    rosterIds.push(_make(teamNames[ni++], 'RP', PLAYER_GROUP.BULLPEN, BP_HANDS[i], bpOvrMin, bpOvrMax, 22, 34));
  }

  // Pitcher bench (2 SP bench + 2 RP bench)
  const pbOvrMin = clamp(baseOvr - 18, SUB_RATING_MIN, SUB_RATING_MAX);
  const pbOvrMax = clamp(baseOvr - 2,  SUB_RATING_MIN, SUB_RATING_MAX);
  for (let i = 0; i < PITCHER_BENCH_SP_COUNT; i++) {
    rosterIds.push(_make(teamNames[ni++], 'SP', PLAYER_GROUP.PITCHER_BENCH, Math.random() < 0.8 ? 'R' : 'L', pbOvrMin, pbOvrMax, 23, 35));
  }
  for (let i = 0; i < PITCHER_BENCH_RP_COUNT; i++) {
    rosterIds.push(_make(teamNames[ni++], 'RP', PLAYER_GROUP.PITCHER_BENCH, Math.random() < 0.75 ? 'R' : 'L', pbOvrMin, pbOvrMax, 22, 34));
  }

  // Farm hitters
  const fhOvrMin = clamp(baseOvr - 22, SUB_RATING_MIN, SUB_RATING_MAX);
  const fhOvrMax = clamp(baseOvr - 5,  SUB_RATING_MIN, SUB_RATING_MAX);
  for (let i = 0; i < FARM_HITTER_POSITIONS.length; i++) {
    farmIds.push(_make(farmNames[i], FARM_HITTER_POSITIONS[i], PLAYER_GROUP.PRACTICE_SQUAD, null, fhOvrMin, fhOvrMax, 21, 26));
  }

  // Farm pitchers
  const fpOvrMin = clamp(baseOvr - 22, SUB_RATING_MIN, SUB_RATING_MAX);
  const fpOvrMax = clamp(baseOvr - 5,  SUB_RATING_MIN, SUB_RATING_MAX);
  for (let i = 0; i < FARM_PITCHER_COUNT; i++) {
    const hand = Math.random() < 0.75 ? 'R' : 'L';
    const pos  = i < 4 ? 'SP' : 'RP';
    farmIds.push(_make(farmNames[FARM_HITTER_POSITIONS.length + i], pos, PLAYER_GROUP.PRACTICE_SQUAD, hand, fpOvrMin, fpOvrMax, 21, 26));
  }

  return { rosterIds, farmIds };
}

// ─────────────────────────────────────────────────────────────
// USER TEAM GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * buildUserRoster(archetypeId, userNames, farmNames, seasonNum, uuidFn)
 * Generates the user team's active roster and farm system per archetype parameters.
 * Enforces payroll cap: if total salary exceeds payrollCap, salaries are compressed
 * proportionally. This is a generation constraint, not a runtime patch.
 *
 * @param {String}   archetypeId
 * @param {String[]} userNames    — 28 names for active roster
 * @param {String[]} farmNames    — 20 names for farm system
 * @param {Number}   seasonNum
 * @param {Function} uuidFn
 * @returns {{ players: Object, rosterIds: String[], farmIds: String[], payroll: Number }}
 */
export function buildUserRoster(archetypeId, userNames, farmNames, seasonNum, uuidFn) {
  const arch     = ARCHETYPE[archetypeId];
  if (!arch) throw new Error(`buildUserRoster: unknown archetype '${archetypeId}'`);

  const players   = {};
  const rosterIds = [];
  const farmIds   = [];

  const ovrMin = arch.starterOvrMin;
  const ovrMax = arch.starterOvrMax;

  // Age skew per archetype
  const { hitterAgeMin, hitterAgeMax, pitcherAgeMin, pitcherAgeMax, farmAgeMin, farmAgeMax }
    = _archetypeAgeRanges(archetypeId);

  let ni = 0;

  const _make = (name, pos, group, hand, targetOvrMin, targetOvrMax, ageMin, ageMax, contractLengthOverride = null) => {
    const targetOvr = _rng(targetOvrMin, targetOvrMax);
    const id = uuidFn();
    const p  = createPlayer({
      id, name, pos, group, hand,
      targetOvr, ageMin, ageMax,
      seasonNum,
      contractLengthOverride,
      teamId: 'user',
    });
    players[id] = p;
    return id;
  };

  // Active hitters
  const benchOvrMin = Math.max(ovrMin - 10, SUB_RATING_MIN);
  const benchOvrMax = Math.max(ovrMin + 5,  SUB_RATING_MIN);
  for (const pos of ACTIVE_HITTER_POSITIONS) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], pos, PLAYER_GROUP.STARTING_HITTERS, null, ovrMin, ovrMax, hitterAgeMin, hitterAgeMax, cLen));
  }

  // Bench hitters
  for (const pos of BENCH_HITTER_POSITIONS) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], pos, PLAYER_GROUP.BENCH_HITTERS, null, benchOvrMin, benchOvrMax, hitterAgeMin, hitterAgeMax + 3, cLen));
  }

  // Starting pitchers
  for (let i = 0; i < SP_COUNT; i++) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], 'SP', PLAYER_GROUP.STARTING_PITCHERS, SP_HANDS[i], ovrMin, ovrMax, pitcherAgeMin, pitcherAgeMax, cLen));
  }

  // Bullpen (5 active RP)
  const bpOvrMin = Math.max(ovrMin - 8, SUB_RATING_MIN);
  const bpOvrMax = Math.max(ovrMax - 4, SUB_RATING_MIN);
  for (let i = 0; i < BP_COUNT; i++) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], 'RP', PLAYER_GROUP.BULLPEN, BP_HANDS[i], bpOvrMin, bpOvrMax, pitcherAgeMin, pitcherAgeMax + 2, cLen));
  }

  // Pitcher bench (2 SP bench + 2 RP bench)
  const pbOvrMin = Math.max(ovrMin - 12, SUB_RATING_MIN);
  const pbOvrMax = Math.max(ovrMin - 2,  SUB_RATING_MIN);
  for (let i = 0; i < PITCHER_BENCH_SP_COUNT; i++) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], 'SP', PLAYER_GROUP.PITCHER_BENCH, Math.random() < 0.8 ? 'R' : 'L', pbOvrMin, pbOvrMax, pitcherAgeMin, pitcherAgeMax, cLen));
  }
  for (let i = 0; i < PITCHER_BENCH_RP_COUNT; i++) {
    const cLen = _archetypeContractLength(archetypeId);
    rosterIds.push(_make(userNames[ni++], 'RP', PLAYER_GROUP.PITCHER_BENCH, Math.random() < 0.75 ? 'R' : 'L', pbOvrMin, pbOvrMax, pitcherAgeMin, pitcherAgeMax + 2, cLen));
  }

  // Farm — always younger, always shorter deals
  for (let i = 0; i < FARM_HITTER_POSITIONS.length; i++) {
    farmIds.push(_make(farmNames[i], FARM_HITTER_POSITIONS[i], PLAYER_GROUP.PRACTICE_SQUAD, null,
      SUB_RATING_MIN, Math.max(ovrMin - 8, SUB_RATING_MIN), farmAgeMin, farmAgeMax));
  }
  for (let i = 0; i < FARM_PITCHER_COUNT; i++) {
    const hand = Math.random() < 0.75 ? 'R' : 'L';
    const pos  = i < 4 ? 'SP' : 'RP';
    farmIds.push(_make(farmNames[FARM_HITTER_POSITIONS.length + i], pos, PLAYER_GROUP.PRACTICE_SQUAD, hand,
      SUB_RATING_MIN, Math.max(ovrMin - 8, SUB_RATING_MIN), farmAgeMin, farmAgeMax));
  }

  // Enforce payroll cap: compress salaries proportionally if needed
  const payrollCap = arch.payrollCap;
  const activeIds  = rosterIds; // farm doesn't count against payroll cap at generation
  let totalPayroll = activeIds.reduce((sum, id) => sum + players[id].contractSalary, 0);

  if (totalPayroll > payrollCap) {
    const ratio = payrollCap / totalPayroll;
    for (const id of activeIds) {
      players[id].contractSalary = Math.max(1, Math.round(players[id].contractSalary * ratio));
    }
    totalPayroll = activeIds.reduce((sum, id) => sum + players[id].contractSalary, 0);
  }

  return { players, rosterIds, farmIds, payroll: totalPayroll };
}

// ─────────────────────────────────────────────────────────────
// USER TEAM INITIALIZATION (applies archetype values to userTeam object)
// ─────────────────────────────────────────────────────────────

/**
 * applyArchetypeToUserTeam(userTeam, archetypeId, leagueTeams)
 * Mutates the userTeam object in-place with archetype-specific starting values.
 * Also applies GM relationship adjustments to league teams.
 *
 * Called after buildUserRoster — works on the userTeam object from schema.js.
 *
 * @param {Object}   userTeam      — from state.userTeam
 * @param {String}   archetypeId
 * @param {Object[]} leagueTeams   — from state.leagueTeams (mutated in-place)
 * @returns {void}
 */
export function applyArchetypeToUserTeam(userTeam, archetypeId, leagueTeams) {
  const arch = ARCHETYPE[archetypeId];
  if (!arch) throw new Error(`applyArchetypeToUserTeam: unknown archetype '${archetypeId}'`);

  // Financial parameters
  userTeam.finances.payrollCap      = arch.payrollCap;
  userTeam.finances.operatingBudget = arch.operatingBudget;

  // Soft metrics
  userTeam.ownerTrust        = arch.ownerTrustStart;
  userTeam.managerConfidence = arch.managerConfStart;

  if (arch.id === 'gambler') {
    userTeam.morale      = _rng(arch.moraleStartMin, arch.moraleStartMax);
    userTeam.atmosphere  = arch.atmosphereStart;
  } else {
    userTeam.morale      = arch.moraleStart;
    userTeam.atmosphere  = arch.atmosphereStart;
  }

  // Win target
  if (arch.id === 'gambler') {
    userTeam._ownerWinTarget = _rng(arch.winTargetMin, arch.winTargetMax);
  } else {
    userTeam._ownerWinTarget = arch.winTargetSeason1;
  }

  // GM relationship adjustments to league teams (Section 16.6)
  const adjustments = ARCHETYPE_GM_REL_ADJUSTMENTS[archetypeId] || [];
  const teamIds     = leagueTeams.map(t => t.id);
  const usedIndices = new Set();

  for (const adj of adjustments) {
    let applied = 0;
    while (applied < adj.count) {
      const idx = _rng(0, teamIds.length - 1);
      if (!usedIndices.has(idx)) {
        usedIndices.add(idx);
        leagueTeams[idx].gmRelationship = clamp(
          GM_RELATIONSHIP_DEFAULT + adj.amount, 0, 100
        );
        applied++;
      }
    }
  }

  // Initialize userTeam gmRelationships map
  for (const team of leagueTeams) {
    userTeam.gmRelationships[team.id] = team.gmRelationship;
  }
}

// ─────────────────────────────────────────────────────────────
// FULL LEAGUE BUILD — convenience wrapper
// ─────────────────────────────────────────────────────────────

/**
 * buildFullLeague(config)
 * Orchestrates the entire league generation sequence.
 * Returns everything needed to populate a fresh game state.
 *
 * config: { archetypeId, seasonNum, uuidFn, userTeam (from state) }
 *
 * @returns {{
 *   players:    Object,        // all players keyed by id
 *   leagueTeams: Object[],
 *   rosterIds:  String[],      // user team active roster
 *   farmIds:    String[],      // user team farm
 *   payroll:    Number,
 * }}
 */
export function buildFullLeague({ archetypeId, seasonNum, uuidFn, userTeam, region }) {
  const { userNames, cpuNames, farmNames } = initNameRegistry();

  // Split farmNames: first 180 for CPU teams (9×20), next 20 for user team
  const cpuFarmNames  = farmNames.slice(0, 180);
  const userFarmNames = farmNames.slice(180, 200);

  // Select team set for this region — falls back to north if unknown
  const regionTeams = LEAGUE_TEAMS_BY_REGION[region] || LEAGUE_TEAMS_BY_REGION.north;

  // Build CPU rosters using region-specific team definitions
  const { players: cpuPlayers, leagueTeams } = buildLeagueRosters(
    cpuNames, cpuFarmNames, seasonNum, uuidFn, regionTeams
  );

  // Build user roster
  const { players: userPlayers, rosterIds, farmIds, payroll } = buildUserRoster(
    archetypeId, userNames, userFarmNames, seasonNum, uuidFn
  );

  // Merge all players into one registry
  const players = { ...cpuPlayers, ...userPlayers };

  // Apply archetype values to userTeam object
  applyArchetypeToUserTeam(userTeam, archetypeId, leagueTeams);
  userTeam.finances.payroll = payroll;

  return { players, leagueTeams, rosterIds, farmIds, payroll };
}

// ─────────────────────────────────────────────────────────────
// ARCHETYPE HELPERS
// ─────────────────────────────────────────────────────────────

function _archetypeAgeRanges(archetypeId) {
  const ranges = {
    ember:       { hitterAgeMin:22, hitterAgeMax:27, pitcherAgeMin:22, pitcherAgeMax:28, farmAgeMin:20, farmAgeMax:24 },
    contender:   { hitterAgeMin:24, hitterAgeMax:32, pitcherAgeMin:24, pitcherAgeMax:32, farmAgeMin:21, farmAgeMax:25 },
    empire:      { hitterAgeMin:28, hitterAgeMax:35, pitcherAgeMin:27, pitcherAgeMax:35, farmAgeMin:22, farmAgeMax:26 },
    gambler:     { hitterAgeMin:23, hitterAgeMax:34, pitcherAgeMin:23, pitcherAgeMax:34, farmAgeMin:21, farmAgeMax:26 },
    lab:         { hitterAgeMin:22, hitterAgeMax:29, pitcherAgeMin:22, pitcherAgeMax:29, farmAgeMin:20, farmAgeMax:24 },
    institution: { hitterAgeMin:27, hitterAgeMax:34, pitcherAgeMin:27, pitcherAgeMax:34, farmAgeMin:22, farmAgeMax:26 },
  };
  return ranges[archetypeId] || ranges.contender;
}

function _archetypeContractLength(archetypeId) {
  const r = Math.random();
  switch (archetypeId) {
    case 'ember':       return r < 0.55 ? 1 : 2;
    case 'contender':   return r < 0.30 ? 1 : r < 0.75 ? 2 : 3;
    case 'empire':      return r < 0.15 ? 2 : r < 0.60 ? 3 : 4;
    case 'gambler':     return r < 0.25 ? 1 : r < 0.55 ? 2 : r < 0.80 ? 3 : 4;
    case 'lab':         return r < 0.50 ? 1 : 2;
    case 'institution': return r < 0.25 ? 1 : r < 0.65 ? 2 : 3;
    default:            return r < 0.33 ? 1 : r < 0.75 ? 2 : 3;
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL UTILITIES
// ─────────────────────────────────────────────────────────────

function _rng(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
