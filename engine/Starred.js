/**
 * engine/Starred.js — r274 §122.153 the players the GM has starred: another club's, a free agent or on waivers
 * (r275 never one of ours: a player who joins us is no longer starred), hitters and pitchers alike. Starred on
 * the player card; marked with a star on the League list, which can show only them. r275 the Scouting Director
 * reports on them (ComposeReplies sc_starred).
 *
 *   state.starred = { [playerId]: sinceMs }
 *
 * Pure: takes the state (or a draft to change); no StateManager.
 */

/** r275 can this player be starred (a league player, not one of ours)? */
export function canStar(state, playerId) {
  const p = state?.players?.[playerId];
  return !!p && p.teamId !== 'user' && !(state.userTeam?.rosterIds || []).includes(playerId) && p.group !== 'retired';
}

/** Is this player starred? */
export function isStarred(state, playerId) {
  return !!state?.starred?.[playerId] && canStar(state, playerId);
}

/** The starred players still in the game, newest first. */
export function starredIds(state) {
  return Object.entries(state?.starred || {})
    .filter(([id]) => canStar(state, id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/** Star or unstar a player. @returns {Boolean} whether the player is now starred */
export function toggleStar(draft, playerId, atMs) {
  draft.starred = draft.starred || {};
  if (draft.starred[playerId] || !canStar(draft, playerId)) { delete draft.starred[playerId]; return false; }
  draft.starred[playerId] = atMs;
  return true;
}
