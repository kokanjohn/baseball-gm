/**
 * store/SaveParts.js
 * r293 §122.175 (foundation step 5) — the save in parts. PURE: no IndexedDB, no StateManager.
 *
 * A save is the main state plus parts, each written only when it changed:
 *   - 'schedules': state.schedule and state.leagueSchedule, each finished box score replaced by a reference;
 *   - 'completed': the answered messages and the message history (the inbox keeps a marker in each one's place);
 *   - each finished box score on its own, keyed by a hash of its text: a game's box score never changes once the
 *     game is over (the rule StateManager's look-ahead copy already relies on, §122.81), so it is written once.
 * The main state keeps every key where it was (a part's key holds null), so joining gives back the same state,
 * key order included: join(split(s)) serializes exactly as s does (check-save-parts).
 */

export const SAVE_FORMAT = 2;
export const PART_NAMES = Object.freeze(['schedules', 'completed']);

/** A box score that never changes again: its game is over and its plays are gone (as StateManager's copy). */
export const isFinishedBox = (g) => !!(g && g.boxScore && (g._committed || g.played) && !g.plays);

/** A short, stable key for a text: two 32-bit FNV-1a hashes and the length. */
export function hashText(str) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${str.length.toString(36)}`;
}

/**
 * split(state, memo) → { main, parts: { name: text }, boxRefs: Set<key>, newBoxes: Map<key, text> }
 * Doesn't change `state`. `memo` (kept per slot by StateManager):
 *   boxKeyOf  WeakMap(box object → key), so a box score is turned into text once;
 *   written   Set of keys already in the save (a box not in it comes back in newBoxes).
 */
export function split(state, memo) {
  const boxRefs = new Set(), newBoxes = new Map();
  const refOf = (box) => {
    let key = memo.boxKeyOf.get(box), text = null;
    if (!key) { text = JSON.stringify(box); key = hashText(text); memo.boxKeyOf.set(box, key); }
    boxRefs.add(key);
    if (!memo.written.has(key) && !newBoxes.has(key)) newBoxes.set(key, text ?? JSON.stringify(box));
    return { _box: key };
  };
  const games = (list) => Array.isArray(list) ? list.map(g => (isFinishedBox(g) ? { ...g, boxScore: refOf(g.boxScore) } : g)) : list;
  const ls = state.leagueSchedule;
  const schedules = {
    schedule: games(state.schedule),
    leagueSchedule: ls && ls.dayMap
      ? { ...ls, dayMap: Object.fromEntries(Object.entries(ls.dayMap).map(([d, list]) => [d, games(list)])) }
      : ls,
  };
  const inbox = state.inbox || [];
  const answered = inbox.filter(c => c && c.resolved);
  const completed = { answered, messageHistory: state.messageHistory };
  const main = {
    ...state,
    schedule: null, leagueSchedule: null, messageHistory: null,
    inbox: Array.isArray(state.inbox) ? state.inbox.map(c => (c && c.resolved ? { _completed: c.instanceId } : c)) : state.inbox,
  };
  return {
    main,
    parts: { schedules: JSON.stringify(schedules), completed: JSON.stringify(completed) },
    boxRefs, newBoxes,
  };
}

/**
 * join(main, parts, boxes, memo) → the state. `main` is the main state as saved (it's changed in place);
 * `parts` { name: text }; `boxes` Map(key → text). Fills memo.boxKeyOf for the box scores it makes.
 * A box score missing from the save leaves its game without one (warned), rather than losing the save.
 */
export function join(main, parts, boxes, memo) {
  const state = main;
  const sch = parts.schedules != null ? JSON.parse(parts.schedules) : null;
  if (!sch) throw new Error('SaveParts.join: the schedules part is missing');
  let missing = 0;
  const fill = (list) => {
    for (const g of list || []) {
      const key = g?.boxScore?._box;
      if (!key) continue;
      const text = boxes.get(key);
      if (text == null) { g.boxScore = null; missing++; continue; }
      g.boxScore = JSON.parse(text);   // (each game its own copy)
      memo?.boxKeyOf.set(g.boxScore, key);
    }
  };
  fill(sch.schedule);
  for (const list of Object.values(sch.leagueSchedule?.dayMap || {})) fill(list);
  if (missing) console.warn(`[SaveParts] ${missing} box score(s) missing from the save`);
  state.schedule = sch.schedule;
  state.leagueSchedule = sch.leagueSchedule;

  const comp = parts.completed != null ? JSON.parse(parts.completed) : { answered: [], messageHistory: [] };
  const byId = new Map((comp.answered || []).map(c => [c.instanceId, c]));
  if (Array.isArray(state.inbox)) {
    state.inbox = state.inbox.map(c => (c && c._completed !== undefined ? byId.get(c._completed) : c)).filter(Boolean);
  }
  state.messageHistory = comp.messageHistory;
  return state;
}

/** Keys in the database (one store for every slot's parts). */
export const partKey = (slotId, name) => `${slotId}|part|${name}`;
export const boxKey = (slotId, key) => `${slotId}|box|${key}`;
export const slotPrefix = (slotId) => `${slotId}|`;
