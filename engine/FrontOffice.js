/**
 * engine/FrontOffice.js
 * §112.4 The front office's winter (offseason day 9; a champion's parade on
 * day 1): next season's ticket prices, a season-ticket campaign, a ballpark
 * or facility upgrade, and how the club meets its fans after the year it had
 * (a parade, an appreciation weekend, a winter caravan, or an apology).
 *
 * Each offer is built from the season review (the outcome, the gate: average
 * attendance, share of seats, sellouts) and the books, so it fits the club's
 * situation; each apply* carries out the GM's choice on the draft.
 *
 *   Ticket price  fin.ticketPrice (× the gate per fan, kept season to season);
 *                 demand answers it (FIN_PRICE_ELASTICITY, in crowdFor)
 *   Campaign      fin.campaign = { season, fill } — a base of season tickets:
 *                 + share of seats at every regular-season home game next season
 *   Facilities    userTeam.facilities = { concourse, training } (levels 0–3):
 *                 concourse +1.5% of seats a level (crowdFor) and atmosphere;
 *                 training center: development ×(1 + 0.05 a level)
 *                 (DevelopmentEngine) and +0.15 a level on the winter's growth
 *                 r170 field drainage (levels 0–3, FieldCare): offered first after a wet year at home
 *   Fan event     atmosphere, owner trust, sponsors (local income)
 *
 * Pure: never imports StateManager.
 */

import { REGULAR_SEASON_GAME_COUNT, FIN_PRICE_ELASTICITY, FIELD_CARE } from '../data/constants.js';
import * as Finance from './FinanceEngine.js';
import { drainageLevel, drainageCostK, wetHomeGames, settleDrainage } from './FieldCare.js';   // r170

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r5 = (k) => Math.max(5, Math.round(k / 5) * 5);
const target = (state) => Finance.seasonTarget(state.userTeam?.finances) || state.userTeam?.finances?.payrollTarget || 10000;
const FAC_MAX = 3;

/** The gate per home game at a price and a share of seats ($K). */
function _gatePerGame(fin, tp, fill) {
  return (fin.market?.capacity || 0) * fill * (fin.market?.perFan || 0) * tp / 1000;
}

/**
 * ticketOffer(state) — the Ticket Office's proposal for next season's prices:
 * raise into strong demand (sellouts, a title), cut into weak demand (empty
 * seats after a hard year), a small raise otherwise. With the gate it projects
 * at last season's crowds.
 */
export function ticketOffer(state) {
  const R = state.offseason?.review || {};
  const G = R.gate || {};
  const fin = state.userTeam?.finances || {};
  const tp = fin.ticketPrice || 1;
  const fill = G.fill ?? 0.7;
  const soldOutShare = G.games ? G.sellouts / G.games : 0;
  let pct, why;
  if (fill >= 0.92 || soldOutShare >= 0.3 || ['champion', 'pennant'].includes(R.outcome)) {
    pct = 0.08;
    why = soldOutShare >= 0.3 ? `we sold out ${G.sellouts} of ${G.games} home games` : R.outcome === 'champion' ? 'the demand after a title' : `the park was ${Math.round(fill * 100)}% full`;
  } else if (fill < 0.62 || R.outcome === 'disaster') {
    pct = -0.10;
    why = `the park was only ${Math.round(fill * 100)}% full${R.outcome === 'disaster' ? ' in a hard year' : ''}`;
  } else if (fill < 0.7 && ['missed', 'near'].includes(R.outcome)) {
    pct = -0.05;
    why = `the park was ${Math.round(fill * 100)}% full in a year without much to sell`;
  } else {
    pct = R.outcome === 'playoffs' ? 0.05 : 0.03;
    why = `the park was ${Math.round(fill * 100)}% full${R.outcome === 'playoffs' ? ' and we played in October' : ''}`;
  }
  // Demand at last season's crowds: a sold-out park had more of it than it could seat.
  const demand = fill >= 0.99 ? 1 + 0.05 + 0.15 * soldOutShare : fill;
  const newFill = clamp(demand * (1 - FIN_PRICE_ELASTICITY * pct), 0, 1);
  const games = REGULAR_SEASON_GAME_COUNT / 2;
  const before = _gatePerGame(fin, tp, Math.min(1, fill)) * games;
  const after = _gatePerGame(fin, tp * (1 + pct), newFill) * games;
  return {
    pct, why, fill, newFill: Math.round(newFill * 1000) / 1000, price: tp,
    gateDeltaK: Math.round(after - before),
    fansPerGame: Math.round((newFill - Math.min(1, fill)) * (fin.market?.capacity || 0)),
    // Fans notice a raise after a losing year; they appreciate a cut.
    atmo: pct < 0 ? 2 : (['missed', 'disaster'].includes(R.outcome) ? -2 : 0),
  };
}

export function applyTicketPrice(draft, offer) {
  const u = draft.userTeam, fin = u?.finances;
  if (!fin) return null;
  fin.ticketPrice = Math.round((fin.ticketPrice || 1) * (1 + offer.pct) * 1000) / 1000;
  if (offer.atmo) u.atmosphere = clamp((u.atmosphere ?? 50) + offer.atmo, 0, 100);
  fin.ticketHistory = [...(fin.ticketHistory || []), { seasonNum: (draft.seasonNum || 1) + 1, price: fin.ticketPrice, pct: offer.pct }];
  return { price: fin.ticketPrice };
}

/**
 * campaignOffer(state) — a season-ticket drive for next season: what it costs,
 * the base it builds (share of seats at every home game), and the gate that
 * base is worth at next season's prices. An easy sell after a title, a hard
 * one after a hard year.
 */
export function campaignOffer(state) {
  const R = state.offseason?.review || {};
  const fin = state.userTeam?.finances || {};
  const fill = R.gate?.fill ?? 0.7;
  const lift = { champion: 0.05, pennant: 0.045, playoffs: 0.04, near: 0.035, missed: 0.025, disaster: 0.02 }[R.outcome] ?? 0.03;
  const room = Math.max(0, 1 - fill);                       // a park that's already full has little to add
  const fillAdd = Math.round(Math.min(lift, room * 0.6) * 1000) / 1000;
  const cost = r5(target(state) * 0.015);
  const worthK = Math.round(_gatePerGame(fin, fin.ticketPrice || 1, fillAdd) * REGULAR_SEASON_GAME_COUNT / 2);
  return { cost, fill: fillAdd, worthK, seats: Math.round(fillAdd * (fin.market?.capacity || 0)) };
}

export function applyCampaign(draft, offer, atMs) {
  const fin = draft.userTeam?.finances;
  if (!fin) return null;
  Finance.post(fin, -offer.cost, 'marketing', 'Season-ticket campaign', atMs);
  fin.campaign = { season: (draft.seasonNum || 1) + 1, fill: offer.fill };
  return fin.campaign;
}

/**
 * facilityOffer(state) — one upgrade, where the club needs it most: the
 * concourse when the park's atmosphere or crowds lag; otherwise the training
 * center (development: coaches and young players get more out of the work).
 * Null when both are built out.
 */
export function facilityOffer(state) {
  const u = state.userTeam || {};
  const R = state.offseason?.review || {};
  const f = { ...(u.facilities || {}), field: drainageLevel(state) };
  const lowCrowd = (u.atmosphere ?? 50) < 62 || (R.gate?.fill ?? 1) < 0.72;
  // r170 a wet year at home (games postponed or delayed): the field's drainage first
  const wet = wetHomeGames(state, -Infinity, Infinity);
  const order = [...(wet >= FIELD_CARE.drainage.winterWet ? ['field'] : []), lowCrowd ? 'concourse' : 'training', lowCrowd ? 'training' : 'concourse'];
  const kind = order.find(k => (f[k] || 0) < FAC_MAX);
  if (!kind) return null;
  const level = f[kind] || 0;
  const cost = kind === 'field' ? drainageCostK(level) : r5(target(state) * (kind === 'concourse' ? 0.06 : 0.05) * (1 + 0.25 * level));
  if (kind === 'field') return { kind, level: level + 1, cost, why: `${wet} home games were postponed or delayed by the weather this year`, wet };
  const why = kind === 'concourse'
    ? ((u.atmosphere ?? 50) < 62 ? `the atmosphere at the park is ${u.atmosphere ?? 50} out of 100, and a flat park costs us crowds` : `the park was ${Math.round((R.gate?.fill ?? 0) * 100)}% full`)
    : `${R.core?.length ? `the young core (${R.core.length} player${R.core.length === 1 ? '' : 's'}) is where our future is` : 'development is where clubs like ours win'}`;
  return { kind, level: level + 1, cost, why };
}

export function applyFacility(draft, offer, atMs) {
  const u = draft.userTeam, fin = u?.finances;
  if (!fin) return null;
  Finance.post(fin, -offer.cost, 'facilities', offer.kind === 'concourse' ? 'Ballpark concourse upgrade' : offer.kind === 'field' ? 'Field drainage' : 'Training center upgrade', atMs);
  settleDrainage(draft, Infinity);   // (r170 a job done in the season is the park's now)
  u.facilities = { concourse: 0, training: 0, field: 0, ...(u.facilities || {}) };
  u.facilities[offer.kind] = Math.min(FAC_MAX, (u.facilities[offer.kind] || 0) + 1);
  if (offer.kind === 'concourse') u.atmosphere = clamp((u.atmosphere ?? 50) + 3, 0, 100);
  return u.facilities;
}

/** The training center's effect on development (DevelopmentEngine). */
export const trainingDevFactor = (u) => 1 + 0.05 * (u?.facilities?.training || 0);
/** …and on the winter's growth (OffseasonEngine._develop), per rating. */
export const trainingWinterBonus = (u) => 0.15 * (u?.facilities?.training || 0);

/**
 * eventOffer(state) — how the club meets its fans after the year it had.
 * `yes`/`no`: the effects of each choice ({ atmo, trust, local }).
 */
export function eventOffer(state) {
  const R = state.offseason?.review || {};
  const t = target(state);
  switch (R.outcome) {
    case 'champion': return { kind: 'parade', cost: r5(t * 0.012),
      yes: { atmo: 5, trust: 3, local: 0.03 }, no: { atmo: 1 } };
    case 'pennant':
    case 'playoffs': return { kind: 'appreciation', cost: r5(t * 0.006),
      yes: { atmo: 3, trust: 1 }, no: {} };
    case 'disaster': return { kind: 'outreach', cost: r5(t * 0.008),
      yes: { atmo: 4, trust: 1 }, no: { atmo: -3 } };
    default: return { kind: 'caravan', cost: r5(t * 0.004),
      yes: { atmo: 2 }, no: { atmo: -1 } };
  }
}

export function applyEvent(draft, offer, yes, atMs) {
  const u = draft.userTeam, fin = u?.finances;
  if (!fin) return null;
  const fx = yes ? offer.yes : offer.no;
  if (yes) Finance.post(fin, -offer.cost, 'events', EVENT_LABEL[offer.kind] || 'Fan event', atMs);
  if (fx.atmo) u.atmosphere = clamp((u.atmosphere ?? 50) + fx.atmo, 0, 100);
  if (fx.trust) u.ownerTrust = clamp((u.ownerTrust ?? 60) + fx.trust, 0, 100);
  if (fx.local) Finance.adjustLocalIncome(fin, fx.local);
  return fx;
}
const EVENT_LABEL = { parade: 'Championship parade', appreciation: 'Fan appreciation weekend', caravan: 'Winter caravan', outreach: 'Fan outreach' };
