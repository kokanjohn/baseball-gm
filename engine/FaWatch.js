/**
 * engine/FaWatch.js — r204 §122.82 free agents the scouting director keeps an eye on for us.
 *
 * Pure: takes the state (or a draft to change) and returns answers; no StateManager.
 *
 *   state.faWatch = { [playerId]: { sinceMs, untilMs } }   — at most FA_WATCH.max at once, for FA_WATCH.days
 *   p._watchClaim = { teamId, madeAtMs, atMs, displaceId } — a club moved to sign a player we watch: it
 *       signs at `atMs` (FA_WATCH.warnMs later) unless we sign first. The director's message comes now.
 *
 * A CPU club that would sign a watched player puts in a claim instead (claimInstead); clubs leave a
 * claimed player alone (held), and the claiming club signs at the deadline (TransactionEngine.completeWatchClaim,
 * from the message: Let Go, or no answer).
 */
import { PLAYER_GROUP, FA_WATCH } from '../data/constants.js';

const _fa = (p) => !!p && p.group === PLAYER_GROUP.FREE_AGENT;

/** The players we're watching now (free agents, inside the watch's 30 days), oldest first. */
export function watching(state, atMs) {
  return Object.entries(state.faWatch || {})
    .filter(([id, w]) => _fa(state.players?.[id]) && !(w.untilMs <= atMs))
    .sort((a, b) => a[1].sinceMs - b[1].sinceMs)
    .map(([id]) => id);
}

export function isWatched(state, playerId, atMs) {
  const w = state.faWatch?.[playerId];
  return !!w && _fa(state.players?.[playerId]) && !(w.untilMs <= atMs);
}

/** Why we can't watch this player (null when we can). */
export function watchBlocker(state, playerId, atMs) {
  const p = state.players?.[playerId];
  if (!_fa(p)) return 'not a free agent any more';
  if (isWatched(state, playerId, atMs)) return 'already watching';
  const d = state.userTeam?.coachingStaff?.scoutingDirector;
  if (!d || d.vacant) return 'no scouting director to do it';
  if (watching(state, atMs).length >= FA_WATCH.max) return `watching ${FA_WATCH.max} already, the most at once`;
  return null;
}

/** Watch a player (draft). → true, or the reason we can't. */
export function addWatch(draft, playerId, atMs) {
  const why = watchBlocker(draft, playerId, atMs);
  if (why) return why;
  draft.faWatch = { ...(draft.faWatch || {}), [playerId]: { sinceMs: atMs, untilMs: atMs + FA_WATCH.days * 86_400_000 } };
  return true;
}

/** Stop watching (draft): signed, let go, or the watch ran out. */
export function endWatch(draft, playerId) {
  if (!draft.faWatch?.[playerId]) return;
  const { [playerId]: _gone, ...rest } = draft.faWatch;
  draft.faWatch = rest;
}

/** Watches over (the player signed, or 30 days): dropped (draft). */
export function pruneWatches(draft, atMs) {
  for (const [id, w] of Object.entries(draft.faWatch || {})) {
    if (!_fa(draft.players?.[id]) || w.untilMs <= atMs) endWatch(draft, id);
  }
}

/** A club (not the one claiming) leaves a claimed player alone until the claim is settled. */
export function held(p) {
  return !!p?._watchClaim;
}

/**
 * claimInstead(draft, p, teamId, atMs, { displaceId }) — a CPU club is about to sign `p`. If we're
 * watching `p` (and nobody has claimed yet), it puts in a claim instead: it signs at the deadline unless
 * we sign first. → true when it did (the club doesn't sign now).
 */
export function claimInstead(draft, p, teamId, atMs, { displaceId = null } = {}) {
  if (!p || teamId === 'user' || p._watchClaim || !isWatched(draft, p.id, atMs)) return false;
  p._watchClaim = { teamId, madeAtMs: atMs, atMs: atMs + FA_WATCH.warnMs, displaceId };
  return true;
}

// ── The free-agent report (r204 §122.82): the players it named, as things stand ──

/**
 * reportRows(state, card, atMs) — each player the report named: 'signed' (ours), 'gone' (signed with
 * another club: `team`), 'watching', or 'open' (still a decision). → [{ id, p, status, team }]
 */
export function reportRows(state, card, atMs) {
  return (card?._faRows || []).map(id => {
    const p = state.players?.[id];
    if (!p) return null;
    if (p.teamId === 'user') return { id, p, status: 'signed' };
    if (!_fa(p)) return { id, p, status: 'gone', team: (state.leagueTeams || []).find(t => t.id === p.teamId)?.name || 'another club' };
    if (isWatched(state, id, atMs)) return { id, p, status: 'watching' };
    return { id, p, status: 'open' };
  }).filter(Boolean);
}

/** The report, closed, in one line: "Signed Ortiz · Watching Vega · Lee signed with Boston · Passed on Ruiz". */
export function reportSummary(state, card, atMs) {
  const rows = reportRows(state, card, atMs);
  const names = (st) => rows.filter(r => r.status === st).map(r => r.p.name);
  const parts = [];
  if (names('signed').length) parts.push(`Signed ${names('signed').join(', ')}`);
  if (names('watching').length) parts.push(`Watching ${names('watching').join(', ')}`);
  for (const r of rows.filter(x => x.status === 'gone')) parts.push(`${r.p.name} signed with ${r.team}`);
  if (names('open').length) parts.push(`Passed on ${names('open').join(', ')}`);
  return parts.join(' · ') || 'Done';
}
