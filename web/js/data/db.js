// IndexedDB connection helper. Single function: openDb().
// Creates / upgrades the schema declared in schema.js.

import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export function openDb(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(storeName)) continue;
        const store = db.createObjectStore(storeName, {
          keyPath: def.keyPath,
          autoIncrement: !!def.autoIncrement,
        });
        for (const idx of def.indexes) {
          const [idxName, keyPath] = idx;
          store.createIndex(idxName, keyPath ?? idxName);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
