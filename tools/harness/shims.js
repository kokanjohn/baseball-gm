/**
 * tools/harness/shims.js
 * DEV/TEST ONLY — never shipped, never imported by the app.
 *
 * Installs just enough of the browser environment onto globalThis so the REAL
 * store layer (StateManager + DB) and the REAL GameEngine run unmodified in Node:
 *   - in-memory IndexedDB (covers exactly the surface DB.js uses)
 *   - in-memory localStorage
 *   - crypto.randomUUID (seeded: the same ids every run)
 *   - a seeded Math.random for reproducible runs
 *   - a controllable virtual clock (overrides Date.now and new Date())
 *
 * Import this module FIRST, before any app module, for its side effects.
 */

// ── Seeded RNG (mulberry32) — reproducible seasons ───────────────
let _seed = 0x9e3779b9;
let _uuidBase = 0x9e3779b9, _uuidN = 0;
export function seedRandom(seed) { _seed = seed >>> 0; _uuidBase = seed >>> 0; _uuidN = 0; }
(function installSeededRandom() {
  Math.random = function () {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

// ── Virtual clock — overrides Date.now() and new Date() ──────────
let _vnow = Date.UTC(2400, 0, 1); // far-future anchor so nothing is "in the past" by accident
const _realNow = Date.now.bind(Date);
// §122.56 r181 `new Date()` (no arguments) reads the virtual clock too. Before, only Date.now() did, so code that
// asks `new Date()` for "now" (startNewGame anchors the schedule to the next 1:05 PM that way) read the real
// wall clock: every check's schedule depended on the day and time it ran.
const _RealDate = Date;
class _VirtualDate extends _RealDate {
  constructor(...args) { if (args.length === 0) super(_vnow); else super(...args); }
  static now() { return _vnow; }
}
globalThis.Date = _VirtualDate;
export const clock = {
  set(ms)     { _vnow = ms; },
  advance(ms) { _vnow += ms; },
  get()       { return _vnow; },
  real:        _realNow,
};

// ── crypto.randomUUID — seeded ───────────────────────────────────
// §122.56 r181 ids come from their own seeded stream (reset by seedRandom), so a run is the same every time:
// before, they were truly random, and anything ordered or hashed by an id (the schedule's club order, for one)
// changed from run to run. Their own stream, so Math.random's sequence is as it was.
function _seededUuid() {
  const word = (k) => {
    let t = (_uuidBase ^ Math.imul(_uuidN + 1, 0x9E3779B1) ^ Math.imul(k + 1, 0x85EBCA77)) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, '0');
  };
  const h = word(0) + word(1) + word(2) + word(3);
  _uuidN++;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {};
try { Object.defineProperty(globalThis.crypto, 'randomUUID', { value: _seededUuid, configurable: true, writable: true }); }
catch { globalThis.crypto.randomUUID = _seededUuid; }

// ── in-memory localStorage ───────────────────────────────────────
if (typeof globalThis.localStorage === 'undefined') {
  const _ls = new Map();
  globalThis.localStorage = {
    getItem:    (k) => (_ls.has(k) ? _ls.get(k) : null),
    setItem:    (k, v) => { _ls.set(k, String(v)); },
    removeItem: (k) => { _ls.delete(k); },
    clear:      () => { _ls.clear(); },
  };
}

// ── in-memory IndexedDB (covers only what DB.js uses) ────────────
if (typeof globalThis.indexedDB === 'undefined') {
  const fire = (obj, prop, ev) => { if (typeof obj[prop] === 'function') obj[prop](ev); };

  class FakeRequest {
    constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
    _succeed(result) { this.result = result; queueMicrotask(() => fire(this, 'onsuccess', { target: this })); }
  }

  // r293 §122.175 key ranges (IDBKeyRange.bound), as the saves' parts use them; globalThis.__idbLog (an array) sees
  // every put and delete, for check-save-parts
  class FakeKeyRange {
    constructor(lower, upper) { this.lower = lower; this.upper = upper; }
    static bound(lower, upper) { return new FakeKeyRange(lower, upper); }
    includes(k) { return k >= this.lower && k <= this.upper; }
  }
  if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = FakeKeyRange;
  const inRange = (q) => (k) => (q === undefined || q === null ? true : q instanceof FakeKeyRange ? q.includes(k) : k === q);
  const sortedKeys = (map, q) => [...map.keys()].filter(inRange(q)).sort();   // (IndexedDB returns keys in order)

  class FakeStore {
    constructor(rec) { this.rec = rec; } // rec = { keyPath, map }
    _key(value, key) { return this.rec.keyPath ? value[this.rec.keyPath] : key; }
    put(value, key)  { const r = new FakeRequest(); const k = this._key(value, key); globalThis.__idbLog?.push(['put', k]); this.rec.map.set(k, structuredClone(value)); r._succeed(undefined); return r; }
    get(key)         { const r = new FakeRequest(); r._succeed(structuredClone(this.rec.map.get(key))); return r; }
    getAll(q)        { const r = new FakeRequest(); r._succeed(sortedKeys(this.rec.map, q).map(k => structuredClone(this.rec.map.get(k)))); return r; }
    getAllKeys(q)    { const r = new FakeRequest(); r._succeed(sortedKeys(this.rec.map, q)); return r; }
    delete(q)        { const r = new FakeRequest(); for (const k of sortedKeys(this.rec.map, q)) { globalThis.__idbLog?.push(['del', k]); this.rec.map.delete(k); } r._succeed(undefined); return r; }
    count(key)       { const r = new FakeRequest(); r._succeed(this.rec.map.has(key) ? 1 : 0); return r; }
  }

  class FakeTx {
    constructor(db, names) {
      this.db = db; this.names = names; this.onerror = null; this.onabort = null; this.oncomplete = null; this.error = null;
      // complete after the requests made now have answered (each answers on a microtask)
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => fire(this, 'oncomplete', { target: this }))));
    }
    objectStore(name) { return new FakeStore(this.db._stores.get(name)); }
  }

  class FakeDB {
    constructor() {
      this._stores = new Map(); // name -> { keyPath, map }
      this.onversionchange = null;
      this.objectStoreNames = { contains: (n) => this._stores.has(n) };
    }
    createObjectStore(name, opts = {}) { this._stores.set(name, { keyPath: opts.keyPath || null, map: new Map() }); }
    transaction(names) { return new FakeTx(this, names); }
    close() {}
  }

  const _databases = new Map();
  globalThis.indexedDB = {
    open(name) {
      const req = {};
      req.onupgradeneeded = null; req.onsuccess = null; req.onerror = null; req.onblocked = null;
      const isNew = !_databases.has(name);
      const db = isNew ? new FakeDB() : _databases.get(name);
      if (isNew) _databases.set(name, db);
      queueMicrotask(() => {
        if (isNew) fire(req, 'onupgradeneeded', { target: { result: db } });
        fire(req, 'onsuccess', { target: { result: db } });
      });
      return req;
    },
  };
}
