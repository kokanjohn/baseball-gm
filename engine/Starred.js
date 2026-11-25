/**
 * engine/Starred.js — r274 §122.153 the players the GM has starred: any player in the league (ours, another
 * club's, a free agent, on waivers), hitters and pitchers alike. Starred on the player card; marked with a star
 * on the League list, which can show only them.
 *
 *   state.starred = { [playerId]: sinceMs }
 *
 * Pure: takes the state (or a draft to change); no StateManager.
 */

/** Is this player starred? */
export function isStarred(state, playerId) {
  return !!state?.starred?.[playerId];
}

/** The starred players still in the game, newest first. */
export function starredIds(state) {
  return Object.entries(state?.starred || {})
    .filter(([id]) => state.players?.[id])
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/** Star or unstar a player. @returns {Boolean} whether the player is now starred */
export function toggleStar(draft, playerId, atMs) {
  if (!draft.players?.[playerId]) return false;
  draft.starred = draft.starred || {};
  if (draft.starred[playerId]) { delete draft.starred[playerId]; return false; }
  draft.starred[playerId] = atMs;
  return true;
}
