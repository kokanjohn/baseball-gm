/**
 * engine/PlayoffEngine.js
 * The postseason bracket (Section 26 — LOCKED), as pure data operations.
 *
 *   Per division (all 5 teams qualify):
 *     WILD_CARD        1 game     4th vs 5th            (4th hosts)
 *     FIRST_ROUND      best of 3  1st vs WC winner; 2nd vs 3rd (higher seed hosts)
 *     DIVISION_SERIES  best of 5  First Round winners   (higher seed hosts)
 *   WORLD_SERIES       best of 7  division champions    (better record hosts)
 *
 * Seeding: win % within the division; ties broken by head-to-head, then run
 * differential (Section 19).
 *
 * Series shape (read by PlayoffScreen):
 *   { id, round, divisionId, bestOf, winsNeeded, teamA (host / higher seed),
 *     teamB, winsA, winsB, status: 'upcoming'|'active'|'final', winner,
 *     games: [{ gameId, homeId, awayId, homeScore, awayScore }] }
 *   team: { id, name, abbr, seed, divisionId, wins, losses }
 *
 * Pure: no StateManager. GameEngine schedules the games on the calendar and
 * feeds results back through recordGame().
 */

import {
  PHASE,
  PLAYOFF_WILD_CARD_GAMES,
  PLAYOFF_FIRST_ROUND_BEST_OF,
  PLAYOFF_DIVISION_SERIES_BEST_OF,
  PLAYOFF_WORLD_SERIES_BEST_OF,
} from '../data/constants.js';

export const ROUNDS = Object.freeze(['WILD_CARD', 'FIRST_ROUND', 'DIVISION_SERIES', 'WORLD_SERIES']);
export const ROUND_PHASE = Object.freeze({
  WILD_CARD:       PHASE.WILD_CARD,
  FIRST_ROUND:     PHASE.FIRST_ROUND,
  DIVISION_SERIES: PHASE.DIVISION_SERIES,
  WORLD_SERIES:    PHASE.WORLD_SERIES,
});
export const ROUND_LABEL = Object.freeze({
  WILD_CARD: 'Wild Card', FIRST_ROUND: 'First Round',
  DIVISION_SERIES: 'Division Series', WORLD_SERIES: 'World Series',
});
const BEST_OF = Object.freeze({
  WILD_CARD:       PLAYOFF_WILD_CARD_GAMES,
  FIRST_ROUND:     PLAYOFF_FIRST_ROUND_BEST_OF,
  DIVISION_SERIES: PLAYOFF_DIVISION_SERIES_BEST_OF,
  WORLD_SERIES:    PLAYOFF_WORLD_SERIES_BEST_OF,
});

/** The round that follows `round`, or null after the World Series. */
export function nextRound(round) {
  const i = ROUNDS.indexOf(round);
  return i >= 0 && i < ROUNDS.length - 1 ? ROUNDS[i + 1] : null;
}

/** The round a playoff phase plays, or null. */
export function roundForPhase(phase) {
  return ROUNDS.find(r => ROUND_PHASE[r] === phase) || null;
}

/**
 * seedDivision(entries, results)
 * Orders a division's standings entries 1–5: win %, then head-to-head among
 * the tied clubs, then run differential.
 * @param {Object[]} entries — { id, name, abbr, divisionId, wins, losses }
 * @param {Object[]} results — regular-season finals { homeId, awayId, homeScore, awayScore }
 */
export function seedDivision(entries, results) {
  const pct = (t) => (t.wins + t.losses ? t.wins / (t.wins + t.losses) : 0.5);
  const diff = new Map(entries.map(t => [t.id, 0]));
  for (const r of results) {
    if (diff.has(r.homeId)) diff.set(r.homeId, diff.get(r.homeId) + r.homeScore - r.awayScore);
    if (diff.has(r.awayId)) diff.set(r.awayId, diff.get(r.awayId) + r.awayScore - r.homeScore);
  }
  const h2h = (a, b) => {
    let w = 0, l = 0;
    for (const r of results) {
      const ab = r.homeId === a && r.awayId === b, ba = r.homeId === b && r.awayId === a;
      if (!ab && !ba) continue;
      const aScore = ab ? r.homeScore : r.awayScore, bScore = ab ? r.awayScore : r.homeScore;
      if (aScore > bScore) w++; else if (bScore > aScore) l++;
    }
    return w - l;
  };
  return [...entries]
    .sort((a, b) => (pct(b) - pct(a)) || (h2h(b.id, a.id) - h2h(a.id, b.id)) || (diff.get(b.id) - diff.get(a.id)))
    .map((t, i) => ({ id: t.id, name: t.name, abbr: t.abbr, divisionId: t.divisionId,
                      wins: t.wins, losses: t.losses, seed: i + 1 }));
}

function _series(id, round, divisionId, teamA, teamB) {
  return {
    id, round, divisionId,
    bestOf:     BEST_OF[round],
    winsNeeded: Math.ceil(BEST_OF[round] / 2),
    teamA, teamB,
    winsA: 0, winsB: 0,
    status: 'upcoming',
    winner: null,
    games:  [],
  };
}

/**
 * buildBracket(divA, divB)
 * @param {Object[]} divA — seeded entries (seedDivision)
 * @param {Object[]} divB
 * @returns {Object} bracket
 */
export function buildBracket(divA, divB) {
  const div = (key, seeds) => ({
    seeds,
    WILD_CARD:       { series: [_series(`${key}_WILD_CARD_0`, 'WILD_CARD', seeds[0]?.divisionId, seeds[3], seeds[4])] },
    FIRST_ROUND:     { series: [_series(`${key}_FIRST_ROUND_0`, 'FIRST_ROUND', seeds[0]?.divisionId, seeds[0], null),
                                _series(`${key}_FIRST_ROUND_1`, 'FIRST_ROUND', seeds[0]?.divisionId, seeds[1], seeds[2])] },
    DIVISION_SERIES: { series: [_series(`${key}_DIVISION_SERIES_0`, 'DIVISION_SERIES', seeds[0]?.divisionId, null, null)] },
  });
  return {
    divA: div('divA', divA),
    divB: div('divB', divB),
    WORLD_SERIES: { series: [_series('WORLD_SERIES_0', 'WORLD_SERIES', null, null, null)] },
    round:    null,
    champion: null,
  };
}

/** Every series of a round (both divisions, or the World Series). */
export function roundSeries(bracket, round) {
  if (!bracket) return [];
  if (round === 'WORLD_SERIES') return bracket.WORLD_SERIES.series;
  return [...(bracket.divA[round]?.series || []), ...(bracket.divB[round]?.series || [])];
}

export function allSeries(bracket) {
  return ROUNDS.flatMap(r => roundSeries(bracket, r));
}

export function findSeries(bracket, id) {
  return allSeries(bracket).find(s => s.id === id) || null;
}

/**
 * prepareRound(bracket, round)
 * Places the previous round's winners. Mutates and returns the bracket.
 * Higher seed (or, in the World Series, better record) is teamA and hosts.
 */
export function prepareRound(bracket, round) {
  const winnerOf = (s) => (s?.winner === 'A' ? s.teamA : s?.winner === 'B' ? s.teamB : null);
  const order = (x, y) => ((x.seed || 9) <= (y.seed || 9) ? [x, y] : [y, x]);
  if (round === 'FIRST_ROUND') {
    for (const d of ['divA', 'divB']) bracket[d].FIRST_ROUND.series[0].teamB = winnerOf(bracket[d].WILD_CARD.series[0]);
  } else if (round === 'DIVISION_SERIES') {
    for (const d of ['divA', 'divB']) {
      const [a, b] = order(winnerOf(bracket[d].FIRST_ROUND.series[0]), winnerOf(bracket[d].FIRST_ROUND.series[1]));
      Object.assign(bracket[d].DIVISION_SERIES.series[0], { teamA: a, teamB: b });
    }
  } else if (round === 'WORLD_SERIES') {
    const a = winnerOf(bracket.divA.DIVISION_SERIES.series[0]);
    const b = winnerOf(bracket.divB.DIVISION_SERIES.series[0]);
    const pct = (t) => (t.wins + t.losses ? t.wins / (t.wins + t.losses) : 0);
    const [host, visitor] = pct(b) > pct(a) ? [b, a] : [a, b];
    Object.assign(bracket.WORLD_SERIES.series[0], { teamA: host, teamB: visitor });
  }
  bracket.round = round;
  for (const s of roundSeries(bracket, round)) if (s.teamA && s.teamB && s.status === 'upcoming') s.status = 'active';
  return bracket;
}

/**
 * recordGame(bracket, seriesId, game)
 * Adds a final to its series. Mutates the bracket.
 * @returns {{ series, clinched: Boolean, winnerId: String|null, loserId: String|null }}
 */
export function recordGame(bracket, seriesId, game) {
  const s = findSeries(bracket, seriesId);
  if (!s || s.status === 'final' || s.games.some(g => g.gameId === game.gameId)) {
    return { series: s, clinched: false, winnerId: null, loserId: null };
  }
  s.games.push({ gameId: game.gameId, homeId: game.homeId, awayId: game.awayId,
                 homeScore: game.homeScore, awayScore: game.awayScore });
  const winId = game.homeScore > game.awayScore ? game.homeId : game.awayId;
  if (winId === s.teamA?.id) s.winsA++; else s.winsB++;
  if (s.winsA >= s.winsNeeded || s.winsB >= s.winsNeeded) {
    s.winner = s.winsA >= s.winsNeeded ? 'A' : 'B';
    s.status = 'final';
    const w = s.winner === 'A' ? s.teamA : s.teamB, l = s.winner === 'A' ? s.teamB : s.teamA;
    if (s.round === 'WORLD_SERIES') bracket.champion = w;
    return { series: s, clinched: true, winnerId: w.id, loserId: l.id };
  }
  return { series: s, clinched: false, winnerId: null, loserId: null };
}

export function roundComplete(bracket, round) {
  const list = roundSeries(bracket, round);
  return list.length > 0 && list.every(s => s.status === 'final');
}

/** Home team of game N (1-based) of a series: the host plays them all. */
export function seriesGames(series) {
  return Array.from({ length: series.bestOf }, (_, i) => ({
    gameNo: i + 1, homeId: series.teamA.id, awayId: series.teamB.id,
  }));
}

/** Is `teamId` still alive (not eliminated) in the bracket? */
export function stillAlive(bracket, teamId) {
  if (!bracket) return true;
  for (const s of allSeries(bracket)) {
    if (s.status !== 'final') continue;
    const loser = s.winner === 'A' ? s.teamB : s.teamA;
    if (loser?.id === teamId) return false;
  }
  return true;
}
