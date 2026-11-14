/**
 * engine/FieldCare.js
 * r170 the field at our ballpark: the drainage (a ballpark upgrade, levels 0–3) and the extra crew
 * for one wet home game (the groundskeeper's prep). What they do is GameWeather's (fieldParams):
 * the field takes more rain before it stops or delays play, the crew's work after a delay is shorter,
 * the infield softens less.
 *
 *   userTeam.facilities.field        the drainage level built
 *   userTeam.fieldWork               { level, readyAt, startAt } a mid-season job, done over a road trip
 *   state.fieldPrep                  { [gameTime]: { costK, atMs } } the home games the crew preps
 *
 *   drainageAt(state, atMs)          the level that counts at a moment (a job counts once it's done)
 *   drainageLevel(state)             the level built or under way (what an offer builds on)
 *   fieldFor(state, venueId, t)      a game's field (our park only; null when there's nothing to it)
 *   prepCostK(chance, wetIn)         the crew's price, by the forecast
 *   drainageCostK(level)             the next level's price
 *   roadWindow(state, atMs)          the next stretch away long enough for the drainage work
 *
 * Pure: never imports StateManager.
 */

import { FIELD_CARE as FC } from '../data/constants.js';

const DAY = 86_400_000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function drainageAt(state, atMs) {
  const u = state?.userTeam || {};
  const built = u.facilities?.field || 0;
  const w = u.fieldWork;
  return w && Number.isFinite(atMs) && w.readyAt <= atMs ? Math.max(built, w.level) : built;
}

export function drainageLevel(state) {
  const u = state?.userTeam || {};
  return Math.max(u.facilities?.field || 0, u.fieldWork?.level || 0);
}

export function fieldFor(state, venueId, gameTime) {
  if (venueId !== 'user') return null;
  const drainage = drainageAt(state, gameTime), prep = !!state?.fieldPrep?.[gameTime];
  return drainage || prep ? { drainage, prep } : null;
}

/** $8K for a 40% chance, up to $20K for a sure thing (a field already wet costs more to get ready). */
export function prepCostK(chance, wetIn = 0) {
  const P = FC.prep;
  const k = P.costMinK + (P.costMaxK - P.costMinK) * clamp(((chance || 0) - P.minChance) / 50, 0, 1) + (wetIn >= P.wetIn ? 2 : 0);
  return clamp(Math.round(k), P.costMinK, P.costMaxK);
}

export function drainageCostK(level) {
  return FC.drainage.costK[clamp(level, 0, FC.drainage.costK.length - 1)];
}

/**
 * The next stretch with no home game for `workDays` days, starting after our next home game is played
 * (or now, if we're on the road with enough of the trip left): { startAt, readyAt, homeAt } — the job
 * starts the day after the homestand, it's done by `readyAt`, and we're home again at `homeAt`.
 */
export function roadWindow(state, atMs) {
  const need = FC.drainage.workDays * DAY;
  const games = (state?.schedule || []).filter(g => !g.cancelled && Number.isFinite(g.gameTime) && g.gameTime > atMs).sort((a, b) => a.gameTime - b.gameTime);
  let from = atMs;
  for (const g of games) {
    if (!g.isHome) continue;
    if (g.gameTime - from >= need + DAY) return { startAt: from, readyAt: from + need, homeAt: g.gameTime };
    from = g.gameTime + 6 * 3_600_000;   // (after that home game)
  }
  return null;
}

/**
 * The home games the weather got to between two moments: postponed (or suspended) at our park, or
 * played through a delay of 20 minutes or more (a late start included). → count
 */
export function wetHomeGames(state, fromMs, toMs) {
  let n = 0;
  for (const g of state?.schedule || []) {
    if (!Number.isFinite(g.gameTime) || g.isSpring) continue;
    for (const pp of g.postponements || []) {
      const ours = pp.venueId ? pp.venueId === 'user' : g.isHome;
      if (ours && pp.gameTime >= fromMs && pp.gameTime < toMs) n++;
    }
    if (g._committed && g.isHome && g.gameTime >= fromMs && g.gameTime < toMs
        && (g.wxResult?.delays || []).some(d => d.endT - d.startT >= 20 * 60_000)) n++;
  }
  return n;
}

/** The job, on the draft. */
export function startDrainage(draft, { level, startAt, readyAt }) {
  const u = draft.userTeam;
  if (!u) return false;
  u.fieldWork = { level: clamp(level, 1, FC.drainage.max), startAt, readyAt };
  return true;
}

/** A finished job becomes the ballpark's (the winter's tidy-up; the level already counts from readyAt). */
export function settleDrainage(draft, atMs) {
  const u = draft.userTeam, w = u?.fieldWork;
  if (!w || w.readyAt > atMs) return false;
  u.facilities = { concourse: 0, training: 0, ...(u.facilities || {}), field: Math.max(u.facilities?.field || 0, w.level) };
  delete u.fieldWork;
  return true;
}
