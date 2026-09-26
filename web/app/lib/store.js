/**
 * Where the browser build keeps its state: one IndexedDB database on this
 * origin. The vault record is sealed exactly as the desktop vault.json is, and
 * the ledger and receipts are kept as the same line records.
 *
 * A store is anything with get(key) and put(key, value), so the tests run the
 * same code against memoryStore() in Node.
 */

export function memoryStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
  };
}

export function idbStore(name = 'noai') {
  const db = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const d = await db;
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
  };
}
