/**
 * engine/Emergencies.js
 * r213 §122.91 After-hours emergencies, planned: 2–4 a season, each in the night before one of our regular-season
 * games (between 11:30pm and 4:30am local), spread out across the season. Which one comes is picked when the
 * night comes, from the club as it stands (our next game home or away; a situation not used this season; a
 * version not seen before until the bank runs out).
 *
 * State: s.emergencies = { season, plan: [{ atMs, done }], used: [card ids, ever], situations: [this season] }
 *
 * PURE: no StateManager. The caller passes the state and a random source.
 */
import { EMERGENCY } from '../data/constants.js';
import { EMERGENCIES } from '../data/cards-emergency.js';
import { rainHolds } from './FieldCare.js';   // r256 §122.135 a storm only on a night it stormed

const MIN = 60_000, HOUR = 60 * MIN;

/** Local midnight that starts the day of `ms`. */
function _midnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

/**
 * This season's nights: [{ atMs, done: false }], sorted. Our regular-season games still to come, the night before
 * each (a random moment in the window), at least `minGapGames` of our games apart and `minLeadH` before first pitch.
 */
export function planEmergencies(state, nowMs, rand) {
  const [lo, hi] = EMERGENCY.perSeason;
  const n = lo + Math.floor(rand() * (hi - lo + 1));
  const games = (state.schedule || []).filter(g => g && !g.isSpring && !g.isPlayoff && !g._committed && Number.isFinite(g.gameTime));
  const out = [];
  const idx = [];
  for (let tries = 0; tries < 400 && out.length < n && games.length; tries++) {
    const i = Math.floor(rand() * games.length);
    if (idx.some(j => Math.abs(j - i) < EMERGENCY.minGapGames)) continue;
    const g = games[i];
    const at = _midnight(g.gameTime) + Math.round((EMERGENCY.nightFromMin + rand() * (EMERGENCY.nightToMin - EMERGENCY.nightFromMin)) * MIN);
    if (at <= nowMs + HOUR || g.gameTime - at < EMERGENCY.minLeadH * HOUR) continue;
    idx.push(i);
    out.push({ atMs: at, done: false });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The next planned night not yet come (its moment), or null. */
export function nextEmergencyAt(state, clockMs) {
  const p = (state.emergencies?.plan || []).find(x => !x.done && x.atMs <= clockMs);
  return p ? p.atMs : null;
}

/** Our next game after a moment (not yet played). */
export function nextGameAfter(state, atMs) {
  return (state.schedule || []).find(g => g && !g._committed && Number.isFinite(g.gameTime) && g.gameTime > atMs) || null;
}

/**
 * Which emergency comes tonight: one that fits (home or away next), a situation not used this season, a version not
 * seen before (until every version of the fitting ones has been). Returns the card definition, or null.
 */
export function pickEmergency(state, atMs, rand) {
  const g = nextGameAfter(state, atMs);
  if (!g) return null;
  const used = new Set(state.emergencies?.used || []);
  const sits = new Set(state.emergencies?.situations || []);
  const fits = EMERGENCIES.filter(d => (!d._needs || (d._needs === 'home') === !!g.isHome) && rainHolds(state, d._needsRain, atMs));
  let pool = fits.filter(d => !sits.has(d._situation) && !used.has(d.id));
  if (!pool.length) pool = fits.filter(d => !sits.has(d._situation));
  if (!pool.length) pool = fits;
  return pool[Math.floor(rand() * pool.length)] || null;
}

/** When an answer is due: by morning, and before first pitch. */
export function answerBy(state, atMs) {
  const g = nextGameAfter(state, atMs);
  const morning = atMs + EMERGENCY.answerH * HOUR;
  return g ? Math.min(morning, g.gameTime - EMERGENCY.beforeGameH * HOUR) : morning;
}
