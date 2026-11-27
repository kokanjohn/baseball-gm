/**
 * engine/MessageHistory.js
 * r292 §122.174 (foundation step 4) — the message history: what an answered message leaves behind once it drops off.
 *
 * Messages keeps the newest MESSAGE_HISTORY.keepAnswered answered messages. An older one leaves a note here
 * (state.messageHistory): what it was, when, the answer, and the few fields that later code reads (§122.173 lists
 * them). A note is about a tenth of a message. Notes from before MESSAGE_HISTORY.seasons seasons are cleared at
 * a new season, except a message marked to keep (`_keep: true`): it is never trimmed, and its note never cleared.
 *
 *   noteOf(card)              the note an answered message leaves
 *   withHistory(state)        the history's notes, then the inbox: for code that asks "was this ever sent / answered"
 *   isNote(c)                 a note, not a message
 *   trimAnswered / toHistory  the trim (inside a mutate); watchTrim(fn) lets a check see what leaves, in full
 *
 * PURE: no StateManager.
 */

/** The note an answered message leaves (fields read by §122.173's readers, nothing else). */
export function noteOf(c) {
  // only what the message has: a missing field reads the same as an empty one to every reader
  const n = { _note: true, instanceId: c.instanceId, resolved: true };
  const pick = (k, v = c[k]) => { if (v != null && v !== '') n[k] = v; };
  pick('cardId'); pick('tag'); pick('subject'); pick('choice'); pick('autoChoice'); if (c.noLabel) n.noLabel = true;   // (arcs read only whether it had one)
  pick('arrivedAtMs'); pick('deliverAtMs'); pick('resolvedAtMs', c.resolvedAtMs ?? c.resolvedAt);
  pick('_season'); pick('_expiredSeason');
  pick('_rosterKey'); pick('_family'); pick('_targetPlayerId'); pick('_gmTeamId'); pick('_gmSeason');
  pick('_wxDecision'); pick('_wxGameTime'); pick('_keep');
  if (c.isCompose) {
    n.isCompose = true; pick('_composeTopic'); pick('_sentAtMs');
    if (c._composeArg) n._composeArg = { key: c._composeArg.key ?? null, ...(c._composeArg.season != null ? { season: c._composeArg.season } : {}) };
  }
  if (Array.isArray(c._coachCands) && c._coachCands.length) n._coachCands = c._coachCands.map(x => ({ name: x?.name ?? null }));
  const raw = {};
  if (c._raw?._fieldNote) raw._fieldNote = c._raw._fieldNote;
  if (c._raw?.starterId != null) raw.starterId = c._raw.starterId;
  if (Object.keys(raw).length) n._raw = raw;
  return n;
}

export const isNote = (c) => !!c?._note;

/** The history's notes (oldest first), then the inbox. */
export function withHistory(state) {
  const h = state?.messageHistory;
  return h?.length ? [...h, ...(state.inbox || [])] : (state?.inbox || []);
}

/** Newest decision first: the order Completed shows (CardEngine.getHistory). */
export const newestFirst = (a, b) => ((b.resolvedAtMs || 0) - (a.resolvedAtMs || 0)) || ((b.resolvedAt || 0) - (a.resolvedAt || 0));

const _trimWatchers = [];
/** For checks: fn(messages) with each batch of messages as they leave Messages (in full, before they're notes). */
export function watchTrim(fn) {
  _trimWatchers.push(fn);
  return () => { const i = _trimWatchers.indexOf(fn); if (i >= 0) _trimWatchers.splice(i, 1); };
}

/** Move `cards` (answered messages, in the inbox) to the history as notes. Inside a mutate. */
export function toHistory(draft, cards) {
  if (!cards.length) return;
  const ids = new Set(cards.map(c => c.instanceId));
  const season = draft.seasonNum || 1;
  const going = (draft.inbox || []).filter(c => ids.has(c.instanceId));   // (in the inbox's order: the history runs oldest first)
  draft.inbox = (draft.inbox || []).filter(c => !ids.has(c.instanceId));
  draft.messageHistory = [...(draft.messageHistory || []), ...going.map(c => ({ ...noteOf(c), _noteSeason: season }))];
  for (const fn of _trimWatchers) fn(going);
}

/** Whether trimAnswered has anything to do (read-only, to skip the mutate). */
export function trimDue(state, { keepAnswered, seasons }) {
  const cur = state?.seasonNum || 1;
  let answered = 0;
  for (const c of state?.inbox || []) if (c.resolved && !c._keep && ++answered > keepAnswered) return true;
  return (state?.messageHistory || []).some(n => !n._keep && (n._noteSeason ?? cur) <= cur - seasons);
}

/**
 * Keep the newest `keepAnswered` answered messages (a message marked `_keep` is never trimmed, nor counted); the
 * rest leave notes. Notes from `seasons` seasons ago and before are cleared, unless marked `_keep`. Inside a mutate.
 */
export function trimAnswered(draft, { keepAnswered, seasons }) {
  const answered = (draft.inbox || []).filter(c => c.resolved && !c._keep);
  if (answered.length > keepAnswered) toHistory(draft, [...answered].sort(newestFirst).slice(keepAnswered));
  const cur = draft.seasonNum || 1;
  const h = draft.messageHistory || [];
  if (h.some(n => !n._keep && (n._noteSeason ?? cur) <= cur - seasons)) draft.messageHistory = h.filter(n => n._keep || (n._noteSeason ?? cur) > cur - seasons);
}
