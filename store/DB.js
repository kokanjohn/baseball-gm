/**
 * store/DB.js
 * Thin IndexedDB wrapper. No game logic. No state references.
 *
 * Knows about two stores:
 *   'saveSlots'  — keyed by slotId (String UUID)
 *   'appMeta'    — keyed by string key, for small app-level persisted values
 *
 * All methods return Promises. Callers (StateManager) handle errors.
 *
 * Design rule: this module never inspects the shape of what it stores.
 * It serializes and deserializes via JSON and that is all.
 */

const DB_NAME    = 'BaseballGM';
const DB_VERSION = 1;
const STORE_SLOTS = 'saveSlots';
const STORE_META  = 'appMeta';

// ─────────────────────────────────────────────────────────────
// OPEN / INIT
// ─────────────────────────────────────────────────────────────

let _db = null;

/**
 * open()
 * Opens (or reuses) the IndexedDB connection.
 * Called automatically by every public method — callers never need to call it directly.
 * @returns {Promise<IDBDatabase>}
 */
function open() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_SLOTS)) {
        db.createObjectStore(STORE_SLOTS, { keyPath: 'slotId' });
      }

      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;

      // Handle unexpected connection close (e.g. browser version upgrade)
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('DB.open: blocked — close other tabs'));
  });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function _tx(storeName, mode, fn) {
  return open().then((db) => {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);

      tx.onerror   = () => reject(tx.error);
      tx.onabort   = () => reject(tx.error || new Error('DB: transaction aborted'));

      fn(store, resolve, reject);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SAVE SLOTS
// ─────────────────────────────────────────────────────────────

/**
 * saveSlot(envelope)
 * Writes (or overwrites) a save slot envelope.
 * envelope must have a slotId string.
 * @param {Object} envelope
 * @returns {Promise<void>}
 */
export function saveSlot(envelope) {
  if (!envelope || !envelope.slotId) {
    return Promise.reject(new Error('DB.saveSlot: envelope must have a slotId'));
  }

  // Serialize to JSON and back to strip any non-serializable values (functions, etc.)
  // This enforces the JSON-round-trip rule from the architecture.
  let serialized;
  try {
    serialized = JSON.parse(JSON.stringify(envelope));
  } catch (e) {
    return Promise.reject(new Error(`DB.saveSlot: state is not JSON-serializable — ${e.message}`));
  }

  return _tx(STORE_SLOTS, 'readwrite', (store, resolve, reject) => {
    const req    = store.put(serialized);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * loadSlot(slotId)
 * Returns the save slot envelope for the given slotId, or null if not found.
 * @param {String} slotId
 * @returns {Promise<Object|null>}
 */
export function loadSlot(slotId) {
  return _tx(STORE_SLOTS, 'readonly', (store, resolve, reject) => {
    const req    = store.get(slotId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * listSlots()
 * Returns all save slot envelopes, sorted by lastPlayed descending (most recent first).
 * Only returns the envelope metadata — state is included but callers should
 * use loadSlot() when they need to actually load a slot into memory.
 * @returns {Promise<Object[]>}
 */
export function listSlots() {
  return _tx(STORE_SLOTS, 'readonly', (store, resolve, reject) => {
    const req    = store.getAll();
    req.onsuccess = () => {
      const slots = (req.result || []).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
      resolve(slots);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * deleteSlot(slotId)
 * Permanently deletes a save slot. Cannot be undone.
 * @param {String} slotId
 * @returns {Promise<void>}
 */
export function deleteSlot(slotId) {
  return _tx(STORE_SLOTS, 'readwrite', (store, resolve, reject) => {
    const req    = store.delete(slotId);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * slotExists(slotId)
 * Returns true if a slot with this ID is stored.
 * @param {String} slotId
 * @returns {Promise<Boolean>}
 */
export function slotExists(slotId) {
  return _tx(STORE_SLOTS, 'readonly', (store, resolve, reject) => {
    const req    = store.count(slotId);
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror   = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────
// APP META (small key-value store for app-level preferences)
// ─────────────────────────────────────────────────────────────

/**
 * getMeta(key)
 * Returns the stored value for key, or null if not found.
 * @param {String} key
 * @returns {Promise<any|null>}
 */
export function getMeta(key) {
  return _tx(STORE_META, 'readonly', (store, resolve, reject) => {
    const req    = store.get(key);
    req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * setMeta(key, value)
 * Stores a value at key. Value must be JSON-serializable.
 * @param {String} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export function setMeta(key, value) {
  return _tx(STORE_META, 'readwrite', (store, resolve, reject) => {
    const req    = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * deleteMeta(key)
 * Removes the value at key.
 * @param {String} key
 * @returns {Promise<void>}
 */
export function deleteMeta(key) {
  return _tx(STORE_META, 'readwrite', (store, resolve, reject) => {
    const req    = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────
// CLOSE (for testing / cleanup)
// ─────────────────────────────────────────────────────────────

/**
 * close()
 * Closes the database connection. Primarily for testing.
 */
export function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export default { saveSlot, loadSlot, listSlots, deleteSlot, slotExists, getMeta, setMeta, deleteMeta, close };
