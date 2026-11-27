/**
 * engine/cards/Situation.js
 * CardEngine, the club's situation (§83): what a card's `_when` reads.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import { PHASE } from '../../data/constants.js';
import * as Finance from '../FinanceEngine.js';

// ─────────────────────────────────────────────────────────────
// THE CLUB'S SITUATION (§83) — what a card's `_when` reads
// ─────────────────────────────────────────────────────────────

const POSTSEASON = new Set([PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);


/**
 * cardSituation(state, context) — the club right now, in the words cards use:
 *   archetype, season ('first'|'returning'), last ('winning'|'losing'),
 *   pace ('winning'|'middling'|'losing', after 20 games), race ('in'|'out'),
 *   lossGap, funds ('flush'|'steady'|'tight'), red (projected to finish in
 *   the red), owner (stage), crowd ('packed'|'steady'|'soft', last 5 home
 *   gates), sellouts (of the last 5), postseason, cpuTrouble (a CPU club
 *   whose owner is cutting).
 */
export function cardSituation(state, context = {}) {
  const u = state.userTeam || {};
  const fin = u.finances;
  const n = (u.wins || 0) + (u.losses || 0);
  const pct = n ? u.wins / n : 0.5;
  const last = (state.seasonHistory || [])[(state.seasonHistory || []).length - 1];
  const target = Finance.seasonTarget(fin) || 1;
  const homes = (state.schedule || []).filter(g => g._committed && g.isHome && !g.isSpring && g.attendance).slice(-5);
  const cap = fin?.market?.capacity || 1;
  const fill = homes.length ? homes.reduce((a, g) => a + g.attendance, 0) / homes.length / cap : null;
  const gb = parseFloat(context.gamesBack);
  const regIdx = context.regularSeasonIndex || 0;
  return {
    archetype: state.archetype,
    season:    (state.seasonNum || 1) > 1 ? 'returning' : 'first',
    last:      last ? ((last.wins || 0) > (last.losses || 0) ? 'winning' : 'losing') : null,
    pace:      n < 20 ? null : pct >= 0.55 ? 'winning' : pct <= 0.45 ? 'losing' : 'middling',
    race:      regIdx < 60 ? null : (context.gamesBack === '-' || (Number.isFinite(gb) && gb <= 4)) ? 'in' : 'out',
    lossGap:   (u.losses || 0) - (u.wins || 0),
    funds:     !fin ? null : fin.funds >= target * 0.25 ? 'flush' : fin.funds < target * 0.10 ? 'tight' : 'steady',
    red:       !!fin && Finance.projection(state, 'user') < 0,
    owner:     fin?.owner?.stage || 'content',
    crowd:     fill == null ? null : fill >= 0.95 ? 'packed' : fill <= 0.62 ? 'soft' : 'steady',
    sellouts:  homes.filter(g => g.sellout).length,
    postseason: POSTSEASON.has(state.phase),
    cpuTrouble: (state.leagueTeams || []).some(t => ['concerned', 'cuts'].includes(t.finances?.owner?.stage)),
  };
}


/** Does the situation meet a card's `_when`? Every listed key must hold. */
export function fitsSituation(w, sit) {
  const is = (want, have) => want == null || (Array.isArray(want) ? want.includes(have) : want === have);
  if (!is(w.archetypes, sit.archetype)) return false;
  for (const k of ['season', 'last', 'pace', 'race', 'funds', 'owner', 'crowd']) if (!is(w[k], sit[k])) return false;
  if (w.red != null && w.red !== sit.red) return false;
  if (w.postseason != null && w.postseason !== sit.postseason) return false;
  if (w.cpuTrouble != null && w.cpuTrouble !== sit.cpuTrouble) return false;
  if (w.minSellouts != null && sit.sellouts < w.minSellouts) return false;
  return true;
}
