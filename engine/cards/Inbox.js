/**
 * engine/cards/Inbox.js
 * CardEngine, inbox sorting and counts.
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */


// ─────────────────────────────────────────────────────────────
// INBOX SORTING
// ─────────────────────────────────────────────────────────────

const TYPE_PRIORITY = { urgent: 0, normal: 1, good: 2 };


export function _sortComparator(a, b) {
  const pa = TYPE_PRIORITY[a.type] ?? 1;
  const pb = TYPE_PRIORITY[b.type] ?? 1;
  if (pa !== pb) return pa - pb;
  return (b.deliveredAt || 0) - (a.deliveredAt || 0);
}


export function _sortInbox(inbox) {
  inbox.sort(_sortComparator);
}
