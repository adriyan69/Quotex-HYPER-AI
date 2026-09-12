/**
 * historyStore — persistent signal log (spec Section 11), backed by
 * IndexedDB. No filesystem/SQLite exists on the web, so IndexedDB is the
 * durable, offline-capable, no-server option — and unlike most web
 * storage, it's usable from BOTH the main thread and a Web Worker, so the
 * worker can log directly without round-tripping through the UI thread.
 *
 * Each record: { id, timestamp, asset, timeframe, signalState, strength,
 * buyScore, sellScore, entryPrice, reason, indicators, structure, outcome }
 *
 * `outcome` is always null as of Phase 8 — there's no live execution to
 * grade against yet. Phases 9-10 (backtesting + performance dashboard)
 * are what will eventually populate it from replayed/graded results; the
 * field exists now so those phases don't need a schema migration later.
 */

const DB_NAME = 'market-ai-history';
const DB_VERSION = 1;
const STORE_NAME = 'signals';
const MAX_RECORDS = 5000; // soft cap so a very long session doesn't grow forever

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('signalState', 'signalState', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** Add one signal record. Resolves with the new record's id. */
export async function addSignal(record) {
  const db = await openDB();
  const id = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add({ ...record, outcome: record.outcome ?? null });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  trimIfNeeded(db).catch(() => {}); // best-effort, never block the write path on this
  return id;
}

/**
 * Fetch recent signals, newest first.
 * @param {{limit?: number, stateFilter?: string|null, minStrength?: number}} options
 */
export async function getSignals(options = {}) {
  const { limit = 200, stateFilter = null, minStrength = 0 } = options;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = [];
    const req = store.openCursor(null, 'prev'); // newest id first
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      const record = cursor.value;
      const matchesState =
        !stateFilter ||
        stateFilter === 'ALL' ||
        (stateFilter === 'BUY_SIDE' && (record.signalState === 'BUY' || record.signalState === 'STRONG_BUY')) ||
        (stateFilter === 'SELL_SIDE' && (record.signalState === 'SELL' || record.signalState === 'STRONG_SELL')) ||
        record.signalState === stateFilter;
      const matchesStrength = record.strength >= minStrength;
      if (matchesState && matchesStrength) results.push(record);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function countSignals() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Aggregate descriptive stats over the FULL logged history (not filtered) —
 * total count, a breakdown by signal state, and the average strength.
 * Computed in a single cursor pass rather than materializing every record
 * into an array just to count them.
 *
 * NOTE: this describes signals actually logged from real app sessions
 * (Start/replay runs you've done) — it has no outcome/win-rate data,
 * because live-logged ticks were never graded against a future price.
 * For actual win-rate numbers, see the Backtest engine (Phase 9), which
 * the performance dashboard also draws on.
 */
export async function getStats() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const counts = { STRONG_BUY: 0, BUY: 0, WAIT: 0, SELL: 0, STRONG_SELL: 0, NO_TRADE: 0 };
    let total = 0;
    let strengthSum = 0;

    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve({ total, counts, averageStrength: total ? strengthSum / total : null });
        return;
      }
      const r = cursor.value;
      total += 1;
      if (counts[r.signalState] !== undefined) counts[r.signalState] += 1;
      strengthSum += r.strength || 0;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function trimIfNeeded(db) {
  const total = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (total <= MAX_RECORDS) return;

  const excess = total - MAX_RECORDS;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let deleted = 0;
    const req = store.openCursor(null, 'next'); // oldest first
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || deleted >= excess) {
        resolve();
        return;
      }
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
