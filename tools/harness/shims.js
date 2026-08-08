/**
 * tools/harness/shims.js
 * DEV/TEST ONLY — never shipped, never imported by the app.
 *
 * Installs just enough of the browser environment onto globalThis so the REAL
 * store layer (StateManager + DB) and the REAL GameEngine run unmodified in Node:
 *   - in-memory IndexedDB (covers exactly the surface DB.js uses)
 *   - in-memory localStorage
 *   - crypto.randomUUID (polyfilled if the Node build lacks it)
 *   - a seeded Math.random for reproducible runs
 *   - a controllable virtual clock (overrides Date.now)
 *
 * Import this module FIRST, before any app module, for its side effects.
 */

// ── Seeded RNG (mulberry32) — reproducible seasons ───────────────
let _seed = 0x9e3779b9;
export function seedRandom(seed) { _seed = seed >>> 0; }
(function installSeededRandom() {
  Math.random = function () {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

// ── Virtual clock — overrides Date.now() ─────────────────────────
let _vnow = Date.UTC(2400, 0, 1); // far-future anchor so nothing is "in the past" by accident
const _realNow = Date.now.bind(Date);
Date.now = () => _vnow;
export const clock = {
  set(ms)     { _vnow = ms; },
  advance(ms) { _vnow += ms; },
  get()       { return _vnow; },
  real:        _realNow,
};

// ── crypto.randomUUID ────────────────────────────────────────────
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = globalThis.crypto || {};
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = () => nodeCrypto.randomUUID();
  }
}

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

  class FakeStore {
    constructor(rec) { this.rec = rec; } // rec = { keyPath, map }
    _key(value, key) { return this.rec.keyPath ? value[this.rec.keyPath] : key; }
    put(value, key)  { const r = new FakeRequest(); this.rec.map.set(this._key(value, key), value); r._succeed(undefined); return r; }
    get(key)         { const r = new FakeRequest(); r._succeed(this.rec.map.get(key)); return r; }
    getAll()         { const r = new FakeRequest(); r._succeed([...this.rec.map.values()]); return r; }
    delete(key)      { const r = new FakeRequest(); this.rec.map.delete(key); r._succeed(undefined); return r; }
    count(key)       { const r = new FakeRequest(); r._succeed(this.rec.map.has(key) ? 1 : 0); return r; }
  }

  class FakeTx {
    constructor(db, names) { this.db = db; this.names = names; this.onerror = null; this.onabort = null; this.error = null; }
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
