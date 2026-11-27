/**
 * engine/cards/Pools.js
 * CardEngine, the card pools, keyed by pool name.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import { PERSONAL_LEAVE_POOL, MANAGER_CONTRACT_POOL, COACHING_CONTRACT_POOL, DECISIONS_POOL, FOLLOWUP_POOL, PREGAME_POOL, PREGAME30_POOL, INGAME_POOL, BETWEEN_GAMES_POOL } from '../../data/cards-pool.js';
import { OFFDAY_POOL, ROAD_POOL, AWAY_FOLLOWUPS } from '../../data/cards-away.js';
import { PROFILE_POOL } from '../../data/cards-profile.js';
import { PHASE } from '../../data/constants.js';
import { MONEY_BETWEEN, MONEY_PREGAME } from '../../data/cards-money.js';
        // r256 §122.135 a message that says it rained comes only when it did

// ─────────────────────────────────────────────────────────────
// CARD POOLS — keyed by pool name for lookup
// ─────────────────────────────────────────────────────────────

export const ALL_POOLS = {
  // §83 the Club Funds families join the moments they belong to.
  DECISIONS_POOL: [...DECISIONS_POOL, ...MONEY_BETWEEN, ...PROFILE_POOL],   // (r219 the GM's reputation, said)
  // §122.57 r182 the half hour before first pitch joins the pre-game moment (it had never been wired).
  PREGAME_POOL:   [...PREGAME_POOL, ...PREGAME30_POOL, ...MONEY_PREGAME],
  INGAME_POOL,
  BETWEEN_GAMES_POOL,
  // r217 §122.96 how a ballpark booking went (CardActions park_event) joins the follow-ups.
  FOLLOWUP_POOL: [...FOLLOWUP_POOL, ...AWAY_FOLLOWUPS],
  PERSONAL_LEAVE_POOL,
  // r217 §122.96 the off day and the road, each a moment of its own
  OFFDAY_POOL,
  ROAD_POOL,
  MANAGER_CONTRACT_POOL,
  COACHING_CONTRACT_POOL,
};


// Per-phase active pools
export const PHASE_POOLS = Object.freeze({
  // §80: spring game days have their own pre-game and in-game moments
  // (media at the first spring game, a visiting bus, a TV crew in the tunnel).
  [PHASE.SPRING_TRAINING]:       ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  // §74 (D2): life happens — bereavement, paternity, family emergencies.
  [PHASE.REGULAR_SEASON]:        ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL', 'BETWEEN_GAMES_POOL', 'PERSONAL_LEAVE_POOL', 'OFFDAY_POOL', 'ROAD_POOL'],
  [PHASE.ALL_STAR_BREAK]:        ['DECISIONS_POOL', 'BETWEEN_GAMES_POOL'],
  [PHASE.TRADE_DEADLINE]:        ['DECISIONS_POOL', 'PREGAME_POOL', 'OFFDAY_POOL', 'ROAD_POOL'],
  [PHASE.WILD_CARD]:             ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.FIRST_ROUND]:           ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.DIVISION_SERIES]:       ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.WORLD_SERIES]:          ['DECISIONS_POOL', 'PREGAME_POOL', 'INGAME_POOL'],
  [PHASE.SEASON_SUMMARY]:        ['DECISIONS_POOL'],
  // §70: the manager's contract is a data-driven card (only when it is up);
  // coaches are kept on. The generic contract pools no longer fire here.
  [PHASE.OFFSEASON]:             ['DECISIONS_POOL'],
});


export const MAX_INBOX_SIZE       = 12;


// §80 Game-day moments: each pool belongs to a moment of the day, and every
// moment draws from its own pools (they used to share three slots in a fixed
// order, so the general pool always filled them and the game-day pools never
// got a turn).
export const POOL_MOMENT = Object.freeze({
  DECISIONS_POOL: 'between', BETWEEN_GAMES_POOL: 'between',
  PREGAME_POOL: 'pregame', INGAME_POOL: 'ingame', PERSONAL_LEAVE_POOL: 'leave',
  OFFDAY_POOL: 'offday', ROAD_POOL: 'road',   // r217 §122.96
});
