/**
 * engine/Opponents.js — r282 §122.161 our games know their opponent by the club's id (`game.opponentId`); the name
 * on a game (`game.opponent`) is only for showing. A club renamed in Settings (or any two names alike) can't send a
 * lookup to the wrong club or to none.
 *
 *   opponentOf(state, game)   the opposing club (null: none, e.g. a game with no opponent)
 *   sameOpponent(a, b)        two of our games against the same club
 *
 * Pure.
 */

/** The club our game is against. */
export function opponentOf(state, game) {
  if (!game?.opponentId) return null;
  return (state?.leagueTeams || []).find(t => t.id === game.opponentId) || null;
}

/** Two of our games against the same club (a series runs while this holds and home/away doesn't change). */
export function sameOpponent(a, b) {
  return !!a && !!b && !!a.opponentId && a.opponentId === b.opponentId;
}
