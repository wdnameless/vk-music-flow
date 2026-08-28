/**
 * Tiny IndexedDB accessor that persists File System Access directory handles
 * (Phase 1 slice A). chrome.storage cannot hold a FileSystemDirectoryHandle;
 * structured clone into IndexedDB can (Chromium).
 *
 * Dependency-free; the sw-harness installs a minimal fake global `indexedDB`
 * to exercise this code path under Vitest (node env). The queue journal was
 * deliberately NOT placed here — it lives in chrome.storage.local
 * (src/lib/journal.ts), which keeps it seedable/observable in tests.
 */

const DB_NAME = 'vkmf-storage';
const DB_VERSION = 1;

/** Object store holding handles. */
export const STORE_HANDLES = 'handles';
/** Key under which the user-picked root directory handle is stored. */
export const ROOT_KEY = 'root';

export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

export function idbStore(storeName: string): KvStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const db = await openDb();
      try {
        return await new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () => reject(req.error ?? new Error('idb get failed'));
        });
      } finally {
        db.close();
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const req = tx.objectStore(storeName).put(value, key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error('idb put failed'));
        });
      } finally {
        db.close();
      }
    },
    async del(key: string): Promise<void> {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const req = tx.objectStore(storeName).delete(key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error('idb del failed'));
        });
      } finally {
        db.close();
      }
    },
  };
}

export const handlesStore: KvStore = idbStore(STORE_HANDLES);
