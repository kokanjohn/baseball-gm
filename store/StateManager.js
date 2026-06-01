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
} from './schema.js';
import { SAVE_SLOT_LIMIT_FREE } from '../data/constants.js';

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

const SAVE_DEBOUNCE_MS = 2000; // Auto-save delay after last mutation

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
  _scheduleSave();
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
  _cancelScheduledSave();

  _state._savedAt = Date.now();

  const envelope = createSlotEnvelope(_activeSlotId, _state);
  await DB.saveSlot(envelope);
}

/**
 * load(slotId)
 * Loads a slot from IndexedDB and makes it the active state.
 * Saves any in-progress state first if a slot is currently loaded.
 * @param {String} slotId
 * @returns {Promise<void>}
 */
export async function load(slotId) {
  // Save current slot before switching
  if (_state && _activeSlotId && _activeSlotId !== slotId) {
    await save();
  }

  const envelope = await DB.loadSlot(slotId);
  if (!envelope) throw new Error(`StateManager.load: slot '${slotId}' not found`);

  let loadedState = envelope.state;

  // Migrate if needed
  if (needsMigration(loadedState)) {
    loadedState = migrate(loadedState);
    // Save the migrated state immediately
    await DB.saveSlot({ ...envelope, state: loadedState });
  }

  _state        = loadedState;
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
  const envelope    = createSlotEnvelope(slotId, freshState);

  await DB.saveSlot(envelope);

  // Load the new slot as active
  _state        = freshState;
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
  await DB.deleteSlot(slotId);

  if (_activeSlotId === slotId) {
    _state        = null;
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

  _state = createGameState(config);
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
