/**
 * store/StateManager.js
 * The single source of truth for all game state.
 *
 * Rules (from Section 1.10 and 3.2):
 *   - Nothing outside this module writes to state directly.
 *   - All state reads go through get(). All writes go through set() or mutate().
 *   - mutate(fn) batches multiple field changes into one save operation.
 *   - Engines receive state values as arguments; they return new values.
 *     StateManager applies the results. No engine imports StateManager directly —
 *     GameEngine orchestrates the call and passes the result back here.
 *   - The active slot ID is persisted in localStorage (survives app close,
 *     independent of game state).
 *
 * UUID generation uses crypto.randomUUID() — guaranteed unique, no collisions
 * across clients (required by the multiplayer-informed architecture, Section 1.7).
 */

import * as DB from './DB.js';
import {
  createGameState,
  createSlotEnvelope,
  migrate,
  needsMigration,
  ensureScoutingDirector,
} from './schema.js';
import { SAVE_SLOT_LIMIT_FREE } from '../data/constants.js';
import { split, join, SAVE_FORMAT, PART_NAMES, partKey, boxKey, slotPrefix } from './SaveParts.js';   // r293 §122.175

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const ACTIVE_SLOT_KEY = 'bgm_activeSlotId';

// ─────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────

let _state      = null;   // The active game state object in memory
let _activeSlotId = null; // The slotId of the currently loaded slot
let _saveTimer  = null;   // Debounce handle for auto-save
let _isPremium  = false;  // Premium flag — set by app bootstrap
let _speculating = false; // §118 inside speculate(): a scratch copy, never saved
let _rev = 0;             // r138 bumped on every real change
let _inputRev = 0;        // r139 bumped only by changes from outside the world's clock: the GM's inputs (§121)
let _world = 0;           // r139 inside world(): the clock, the game, due cards — what a look-ahead replays

const SAVE_DEBOUNCE_MS = 2000; // Auto-save delay after last mutation

// r293 §122.175 the save in parts (store/SaveParts.js): for the active slot, what's already in the database —
// the last text written of each part, the box scores stored, and each box score's key (so it's hashed once).
let _memo = null;
const _memoFor = (slotId) => (_memo?.slotId === slotId ? _memo
  : (_memo = { slotId, last: {}, written: new Set(), boxKeyOf: new WeakMap() }));

/** Write `state` as slot `slotId`: the main state, each part that changed, new box scores; one transaction. */
async function _write(slotId, state) {
  const memo = _memoFor(slotId);
  const { main, parts, boxRefs, newBoxes } = split(state, memo);
  const puts = [], dels = [], gone = [];
  for (const name of PART_NAMES) if (parts[name] !== memo.last[name]) puts.push([partKey(slotId, name), parts[name]]);
  for (const [k, text] of newBoxes) puts.push([boxKey(slotId, k), text]);
  for (const k of memo.written) if (!boxRefs.has(k)) { gone.push(k); dels.push(boxKey(slotId, k)); }
  await DB.saveSlotWithParts({ ...createSlotEnvelope(slotId, main), format: SAVE_FORMAT }, puts, dels);
  for (const name of PART_NAMES) memo.last[name] = parts[name];
  for (const k of newBoxes.keys()) memo.written.add(k);
  for (const k of gone) memo.written.delete(k);
}

/** Read slot `slotId` back into one state (a save from before parts is the whole state already). */
async function _read(slotId) {
  const envelope = await DB.loadSlot(slotId);
  if (!envelope) return null;
  _memo = null;
  const memo = _memoFor(slotId);
  if (envelope.format !== SAVE_FORMAT) return envelope;   // (written whole; its first save writes it in parts)
  const prefix = slotPrefix(slotId), parts = {}, boxes = new Map();
  for (const [k, v] of await DB.loadParts(prefix)) {
    const rest = k.slice(prefix.length);
    if (rest.startsWith('part|')) parts[rest.slice(5)] = v;
    else if (rest.startsWith('box|')) boxes.set(rest.slice(4), v);
  }
  const state = join(envelope.state, parts, boxes, memo);
  for (const name of PART_NAMES) if (parts[name] != null) memo.last[name] = parts[name];
  memo.written = new Set(boxes.keys());
  return { ...envelope, state };
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────

/**
 * init()
 * Must be called once at app startup (from app.js).
 * Restores the previously active slot if one exists.
 * @param {{ isPremium?: Boolean }} options
 * @returns {Promise<Boolean>} true if a slot was restored, false if fresh start
 */
export async function init({ isPremium = false } = {}) {
  _isPremium = isPremium;

  const savedSlotId = localStorage.getItem(ACTIVE_SLOT_KEY);
  if (!savedSlotId) return false;

  try {
    await load(savedSlotId);
    return true;
  } catch {
    // Saved slot ID no longer exists in DB — clean up and start fresh
    localStorage.removeItem(ACTIVE_SLOT_KEY);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * get(path?)
 * Returns a value from the active state.
 *   get()             → the entire state object (read-only reference)
 *   get('phase')      → state.phase
 *   get('userTeam.wins') → state.userTeam.wins
 *
 * Returns undefined if the path doesn't exist.
 * Does NOT return a deep clone — callers must not mutate the returned value.
 * Use mutate() for writes.
 *
 * @param {String} [path]
 * @returns {*}
 */
export function get(path) {
  _assertLoaded();
  if (path === undefined) return _state;

  return path.split('.').reduce((obj, key) => {
    return obj !== undefined && obj !== null ? obj[key] : undefined;
  }, _state);
}

/**
 * getActiveSlotId()
 * Returns the slotId of the currently loaded slot, or null.
 * @returns {String|null}
 */
export function getActiveSlotId() {
  return _activeSlotId;
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * set(path, value)
 * Sets a single field and triggers an auto-save.
 *   set('phase', 'REGULAR_SEASON')
 *   set('userTeam.wins', 42)
 *
 * For multiple related changes, use mutate() instead to batch them
 * into a single save operation.
 *
 * @param {String} path   — dot-separated path
 * @param {*}      value  — must be JSON-serializable
 * @returns {void}
 */
export function set(path, value) {
  _assertLoaded();
  _setPath(_state, path, value);
  if (!_speculating) { _rev++; if (!_world) _inputRev++; }
  _scheduleSave();
}

/**
 * mutate(fn)
 * Applies a batch of changes in a single transaction and triggers one save.
 *
 * fn receives the state object and may modify it directly.
 * The save fires once after fn returns — not once per field.
 *
 * Example:
 *   StateManager.mutate(state => {
 *     state.userTeam.wins++;
 *     state.userTeam.streak = 3;
 *     state.inbox.push(newCard);
 *   });
 *
 * @param {Function} fn  — (state: Object) => void
 * @returns {void}
 */
export function mutate(fn) {
  _assertLoaded();
  fn(_state);
  if (!_speculating) { _rev++; if (!_world) _inputRev++; _scheduleSave(); }
}

/**
 * speculate(fn)
 * §118 The look-ahead: run engine code against a scratch copy of the active
 * state. Inside fn, get() and mutate() see and change only the copy; nothing
 * is saved; the real state is back untouched afterwards (even on a throw).
 * fn must be synchronous — an await inside would let the app run against the
 * copy. Returns fn's result (which must not hold references into the copy
 * that the caller then mutates).
 * @param {Function} fn — () => any
 * @returns {any}
 */
export function speculate(fn) {
  _assertLoaded();
  if (_speculating) throw new Error('StateManager.speculate: already speculating');
  const real = _state;
  _state = _speculativeCopy(real);
  _speculating = true;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('StateManager.speculate: fn must be synchronous');
    return out;
  } finally {
    _state = real;
    _speculating = false;
  }
}

/**
 * r203 §122.81 _speculativeCopy(real) — a deep copy, except what nothing changes once written, which the
 * copy shares: the box scores of games already over (ours and the league's), and each player's game log
 * and season log (always replaced, never edited — IMPEngine.appendGameLog, the winter's archive). Together
 * about half a season's state, and every look-ahead copies it. (Each is set aside while the rest is copied,
 * then put back on both, in the same places — even when the copy throws.)
 */
const _SHARED_PLAYER_KEYS = ['_impGameLog', 'seasonLog'];
function _speculativeCopy(real) {
  const parked = [], held = [];
  for (const [id, p] of Object.entries(real.players || {})) {
    for (const k of _SHARED_PLAYER_KEYS) if (p && Array.isArray(p[k]) && p[k].length) { held.push([id, k, p[k]]); p[k] = null; }
  }
  const park = (list) => {
    for (let i = 0; i < (list?.length || 0); i++) {
      const g = list[i];
      if (g && g.boxScore && (g._committed || g.played) && !g.plays) { parked.push([list, i, g.boxScore]); g.boxScore = null; }
    }
  };
  park(real.schedule);
  for (const games of Object.values(real.leagueSchedule?.dayMap || {})) park(games);
  let copy;
  try {
    copy = structuredClone(real);
  } finally {
    for (const [list, i, box] of parked) list[i].boxScore = box;
    for (const [id, k, v] of held) real.players[id][k] = v;
  }
  for (const [id, k, v] of held) if (copy.players?.[id]) copy.players[id][k] = v;
  // The copy's lists are in the same order: the same game at the same place.
  const day = copy.leagueSchedule?.dayMap || {};
  const realDay = real.leagueSchedule?.dayMap || {};
  const twin = new Map([[real.schedule, copy.schedule], ...Object.keys(realDay).map(k => [realDay[k], day[k]])]);
  for (const [list, i, box] of parked) { const g = twin.get(list)?.[i]; if (g) g.boxScore = box; }
  return copy;
}

/** Is a look-ahead running? (engines don't need to ask; the app's guards do) */
export function isSpeculating() { return _speculating; }

/**
 * adopt(state) — r139 §121 the look-ahead's worker holds a copy of the save
 * the page sent it: it's the state here, never saved (only speculate() runs on it).
 */
export function adopt(state) {
  _state = state; _activeSlotId = null; _rev++; _inputRev++;
}

/** r138 a number that changes whenever the real state does (loads included). */
export function revision() { return _rev; }

/**
 * r139 §121 a number that changes only when something outside the world's own
 * clock changes the save — a GM's answer, a roster move, a setting, a load.
 * The world moving on (the clock, our game, cards coming due) is exactly what
 * a look-ahead already played, so it leaves a look-ahead valid; an input doesn't.
 */
export function inputRevision() { return _inputRev; }

/**
 * world(fn) — r139 run the world's own work (GameEngine.advanceClock, tick,
 * commitGameNow; CardEngine.releaseDueCards): its changes don't count as inputs.
 * fn must be synchronous.
 */
export function world(fn) {
  _world++;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('StateManager.world: fn must be synchronous');
    return out;
  } finally { _world--; }
}

// ─────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────

/**
 * save()
 * Immediately persists the active state to IndexedDB.
 * Cancels any pending debounced save.
 * @returns {Promise<void>}
 */
export async function save() {
  _assertLoaded();
  if (_speculating) return;            // §118 a scratch copy is never saved
  _cancelScheduledSave();

  _state._savedAt = Date.now();

  await _write(_activeSlotId, _state);   // r293 §122.175 in parts
}

/**
 * load(slotId)
 * Loads a slot from IndexedDB and makes it the active state.
 * Flushes any in-progress state first if a slot is currently loaded.
 *
 * The flush covers RELOADING THE SAME SLOT too, not only switching slots.
 * mutate() persists on a 2s debounce, so any mutation made shortly before a
 * reload of the same slot (e.g. startNewGame seeding the inbox, then
 * App.init → StateManager.init → load) would otherwise be discarded: the stale
 * DB copy replaces memory, then the pending timer saves that stale copy back.
 * @param {String} slotId
 * @returns {Promise<void>}
 */
export async function load(slotId) {
  // Flush the current slot before replacing it in memory — whether switching
  // slots or reloading the same one — so no pending mutation is lost.
  if (_state && _activeSlotId) {
    await save();
  }

  const envelope = await _read(slotId);   // r293 §122.175 the parts joined
  if (!envelope) throw new Error(`StateManager.load: slot '${slotId}' not found`);

  let loadedState = envelope.state;

  // Migrate if needed
  if (needsMigration(loadedState)) {
    loadedState = migrate(loadedState);
    // Save the migrated state immediately
    await _write(slotId, loadedState);
  }

  // §122.15 one-time repairs that a same-version save needs (saved with the next save).
  ensureScoutingDirector(loadedState);

  _state        = loadedState; _rev++; _inputRev++;
  _activeSlotId = slotId;
  localStorage.setItem(ACTIVE_SLOT_KEY, slotId);
}

// ─────────────────────────────────────────────────────────────
// SLOT MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * listSlots()
 * Returns all save slot envelopes sorted by lastPlayed descending.
 * Does not load any slot into memory.
 * @returns {Promise<Object[]>}
 */
export async function listSlots() {
  return DB.listSlots();
}

/**
 * createSlot(config)
 * Creates a new save slot, saves it to IndexedDB, and loads it as the active slot.
 *
 * config: see createGameState() in schema.js
 *
 * Enforces the free-tier slot limit. Throws if limit is reached.
 * @param {Object} config
 * @returns {Promise<String>} the new slotId
 */
export async function createSlot(config = {}) {
  // Enforce slot limit for free tier
  if (!_isPremium) {
    const existing = await DB.listSlots();
    if (existing.length >= SAVE_SLOT_LIMIT_FREE) {
      throw new Error(
        `StateManager.createSlot: free tier limit of ${SAVE_SLOT_LIMIT_FREE} slot reached`
      );
    }
  }

  // Enforce one-per-archetype rule (Section 16.3)
  if (config.archetype) {
    const existing = await DB.listSlots();
    const duplicate = existing.find(s => s.archetype === config.archetype);
    if (duplicate) {
      throw new Error(
        `StateManager.createSlot: archetype '${config.archetype}' already has a save slot`
      );
    }
  }

  const slotId      = _uuid();
  const freshState  = createGameState(config);

  _memo = null;
  await _write(slotId, freshState);   // r293 §122.175 in parts

  // Load the new slot as active
  _state        = freshState; _rev++; _inputRev++;
  _activeSlotId = slotId;
  localStorage.setItem(ACTIVE_SLOT_KEY, slotId);

  return slotId;
}

/**
 * deleteSlot(slotId)
 * Permanently deletes a save slot.
 * If the deleted slot is currently active, clears the active state.
 * @param {String} slotId
 * @returns {Promise<void>}
 */
export async function deleteSlot(slotId) {
  await DB.deleteSlot(slotId);   // (its parts too)
  if (_memo?.slotId === slotId) _memo = null;

  if (_activeSlotId === slotId) {
    _state        = null; _rev++; _inputRev++;
    _activeSlotId = null;
    localStorage.removeItem(ACTIVE_SLOT_KEY);
    _cancelScheduledSave();
  }
}

/**
 * reset()
 * Wipes the active slot's state back to a fresh game state (same config).
 * Does NOT delete the slot from IndexedDB — just resets its contents.
 * Used for "Start Over" functionality.
 * @returns {Promise<void>}
 */
export async function reset() {
  _assertLoaded();
  const config = {
    archetype:   _state.archetype,
    gmName:      _state.userTeam.gmName,
    city:        _state.userTeam.city,
    nickname:    _state.userTeam.nickname,
    abbr:        _state.userTeam.abbr,
    icon:        _state.userTeam.icon,
    bannerColor: _state.userTeam.bannerColor,
  };

  _state = createGameState(config); _rev++; _inputRev++;
  await save();
}

// ─────────────────────────────────────────────────────────────
// PREMIUM FLAG
// ─────────────────────────────────────────────────────────────

/**
 * setPremium(value)
 * Sets the premium flag. Called by the app when purchase is confirmed.
 * @param {Boolean} value
 */
export function setPremium(value) {
  _isPremium = Boolean(value);
}

/**
 * isPremium()
 * @returns {Boolean}
 */
export function isPremium() {
  return _isPremium;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _assertLoaded() {
  if (!_state) {
    throw new Error('StateManager: no slot loaded — call load() or createSlot() first');
  }
}

/**
 * _setPath(obj, path, value)
 * Sets obj[key1][key2]... = value, creating intermediate objects if needed.
 */
function _setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') {
      o[k] = {};
    }
    return o[k];
  }, obj);
  target[last] = value;
}

/**
 * _scheduleSave()
 * Debounces the auto-save so rapid sequential mutations only trigger one write.
 */
function _scheduleSave() {
  _cancelScheduledSave();
  _saveTimer = setTimeout(() => {
    save().catch(err => {
      console.error('StateManager: auto-save failed —', err);
    });
  }, SAVE_DEBOUNCE_MS);
}

function _cancelScheduledSave() {
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}

/**
 * _uuid()
 * Generates a UUID using the Web Crypto API.
 * Guaranteed unique across clients — required for multiplayer-informed architecture.
 */
function _uuid() {
  return crypto.randomUUID();
}

// ─────────────────────────────────────────────────────────────
// NAMED EXPORTS
// ─────────────────────────────────────────────────────────────

export default {
  init,
  get,
  getActiveSlotId,
  set,
  mutate,
  save,
  load,
  listSlots,
  createSlot,
  deleteSlot,
  reset,
  setPremium,
  isPremium,
};
