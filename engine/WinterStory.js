/**
 * engine/WinterStory.js
 * r218 §122.97 The winter, a day at a time (message plan, release 5).
 *
 * From the day after our last game (eliminated, or the World Series won) to the eve of spring, each day has a
 * moment at midday (12:00–15:30, after the offseason's morning steps). A quiet day — fewer than two decisions
 * arriving that day — gets one message from data/cards-winter.js (most of the time); a busy one (the contract
 * decisions, free agency opening) gets nothing more.
 *
 *   ourSeasonOver(state)            our last game is played and we're out (or the title is won)
 *   winterDays(state, clockMs)      the winter's moments up to now: [{ key (the day), atMs }]
 *   nextStepAt(state, clockMs)      the next moment due (not yet done), or null
 *   pickCard(state, atMs, pool)     the day's message: a card fitting the day, not yet used up this winter (or null)
 *
 * State: s.winter = { season, done: { [day]: true }, used: { [cardId]: n }, lastLine } (the last series result told). PURE: no StateManager.
 */
import { PHASE, WINTER_STORY } from '../data/constants.js';
import { dice, diceSeed } from './Dice.js';
import { allSeries } from './PlayoffEngine.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const POST = new Set([PHASE.PLAYOFF_BRACKET_BUILD, PHASE.WILD_CARD, PHASE.FIRST_ROUND, PHASE.DIVISION_SERIES, PHASE.WORLD_SERIES]);
const WINTER = new Set([PHASE.SEASON_SUMMARY, PHASE.OFFSEASON]);

const _day0 = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const _next = (ms) => { const d = new Date(ms); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); };
const _key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/** Are we out of it: a series of ours lost, or the bracket done (the summary, the offseason)? */
export function eliminated(state) {
  if (WINTER.has(state.phase)) return true;
  if (!POST.has(state.phase)) return false;
  return allSeries(state.playoffBracket).some(s => s.status === 'final'
    && ((s.winner === 'A' && s.teamB?.id === 'user') || (s.winner === 'B' && s.teamA?.id === 'user')));
}

/** Our season is over: out of it, and none of our games left to play. */
export function ourSeasonOver(state) {
  if (!eliminated(state)) return false;
  return !(state.schedule || []).some(g => !g.cancelled && !g._committed && !g.isSpring && Number.isFinite(g.gameTime) && g.status !== 'final');
}

/** The winter's first day: the day after our last game. */
function _start(state) {
  const ours = (state.schedule || []).filter(g => !g.cancelled && !g.isSpring && Number.isFinite(g.gameTime) && (g._committed || g.status === 'final'));
  if (!ours.length) return null;
  return _next(Math.max(...ours.map(g => g.gameTime)));
}

/** The moments from the winter's first day to now. */
export function winterDays(state, clockMs) {
  if (!ourSeasonOver(state)) return [];
  const start = _start(state);
  if (start == null) return [];
  const season = state.seasonNum || 1;
  const out = [];
  for (let d = start; d <= clockMs; d = _next(d)) {
    const r = dice(diceSeed(state), 'winter', season, _key(d));
    const atMs = d + 12 * HOUR + Math.floor(r() * 210) * MIN;
    if (atMs <= clockMs) out.push({ key: _key(d), atMs });
    if (out.length > 60) break;   // (a winter is never this long)
  }
  return out;
}

export function nextStepAt(state, clockMs) {
  const season = state.seasonNum || 1;
  const done = state.winter?.season === season ? state.winter.done || {} : {};
  return winterDays(state, clockMs).find(x => !done[x.key]) || null;
}

/** Decisions arriving on a moment's day (the inbox and the schedule). */
export function decisionsThatDay(state, atMs) {
  const a = _day0(atMs), b = _next(atMs);
  return [...(state.inbox || []), ...(state.scheduledCards || [])].filter(c => {
    const t = c.arrivedAtMs ?? c.deliverAtMs;
    return Number.isFinite(t) && t >= a && t < b && c.noLabel && !c._toastOnly;
  }).length;
}

/**
 * The day's message: null on a busy day, now and then on a quiet one (WINTER_STORY.chance), or when nothing fits.
 * Otherwise a card from `pool` that fits the day ('out' while the postseason goes on, 'winter' after it), drawn from
 * the day's own dice, decisions first (a news card only when the day's draw says so).
 */
export function pickCard(state, atMs, pool) {
  if (decisionsThatDay(state, atMs) >= WINTER_STORY.busy) return null;
  const season = state.seasonNum || 1;
  const r = dice(diceSeed(state), 'winter-pick', season, _key(atMs));
  if (r() >= WINTER_STORY.chance) return null;
  const used = state.winter?.season === season ? state.winter.used || {} : {};
  const stage = WINTER.has(state.phase) ? 'winter' : 'out';
  const champ = state.playoffBracket?.champion;
  const fits = pool.filter(c => (c._winter === 'any' || c._winter === stage)
    && (used[c.id] || 0) < (c._winterMax || 1)
    && (!c._needsChampion || (champ && champ.id !== 'user'))
    && (!c._needsSeries || (!!seriesLine(state) && seriesLine(state) !== state.winter?.lastLine)));
  if (!fits.length) return null;
  const news = fits.filter(c => c._toastOnly), dec = fits.filter(c => !c._toastOnly);
  const from = (r() < WINTER_STORY.newsShare && news.length) || !dec.length ? news : dec;
  return from[Math.floor(r() * from.length)];
}

const ROUND = { WILD_CARD: 'wild-card game', FIRST_ROUND: 'first round', DIVISION_SERIES: 'division series', WORLD_SERIES: 'World Series' };
/** The latest postseason result we weren't in, in a sentence (or null): "The Gulls beat the Herons in the first round, 3–1." */
export function seriesLine(state) {
  const done = allSeries(state.playoffBracket).filter(s => s.status === 'final' && s.teamA && s.teamB && s.teamA.id !== 'user' && s.teamB.id !== 'user');
  const s = done[done.length - 1];   // (allSeries runs round by round: the last is the latest)
  if (!s) return null;
  const [w, l] = s.winner === 'A' ? [s.teamA, s.teamB] : [s.teamB, s.teamA];
  const [ww, lw] = s.winner === 'A' ? [s.winsA, s.winsB] : [s.winsB, s.winsA];
  return s.round === 'WILD_CARD' ? `The ${w.name} beat the ${l.name} in the wild-card game.`
    : `The ${w.name} beat the ${l.name} in the ${ROUND[s.round] || 'postseason'}, ${ww}–${lw}.`;
}
