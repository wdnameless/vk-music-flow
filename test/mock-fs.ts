/**
 * Shared Phase 1 test doubles (not a test file itself):
 *  - makeFakeFsRoot: a mock FileSystemDirectoryHandle tree per spec:
 *    getDirectoryHandle/getFileHandle/createWritable recording paths + bytes.
 *  - createFakeIndexedDB: minimal global indexedDB shim supporting exactly the
 *    surface used by src/storage/idb.ts (open/onupgradeneeded, transaction ->
 *    objectStore -> get/put/delete requests with success events).
 */

export type FsPerm = 'granted' | 'prompt' | 'denied';

const norm = (prefix: string, child: string): string => (prefix ? `${prefix}/${child}` : child);

export interface FakeFsRoot {
  /** Use as `RootDirHandle` (structural cast). */
  handle: unknown;
  /** Full relative path -> written bytes (populated on writable.close()). */
  writes: Map<string, Uint8Array>;
  /** Every getDirectoryHandle as `<path>:create|:noop`. */
  dirCreates: string[];
  /** Every getFileHandle as `<path>:create|:noop`. */
  fileCreates: string[];
  /** Mutable permission answers for query/requestPermission. */
  perms: { query: FsPerm; request: FsPerm };
}

export function makeFakeFsRoot(name = 'FakeRoot'): FakeFsRoot {
  const writes = new Map<string, Uint8Array>();
  const dirCreates: string[] = [];
  const fileCreates: string[] = [];
  const perms = { query: 'granted' as FsPerm, request: 'granted' as FsPerm };

  const toBlob = (d: Blob | Uint8Array | ArrayBuffer): Blob =>
    d instanceof Blob ? d : new Blob([d as unknown as BlobPart]);

  const mkFile = (full: string): unknown => ({
    kind: 'file',
    name: full.split('/').pop(),
    createWritable: async () => {
      const parts: Blob[] = [];
      return {
        write: async (d: Blob | Uint8Array | ArrayBuffer): Promise<void> => {
          parts.push(toBlob(d));
        },
        close: async (): Promise<void> => {
          const bufs = await Promise.all(parts.map((b) => b.arrayBuffer()));
          const total = bufs.reduce((n, b) => n + b.byteLength, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const b of bufs) {
            out.set(new Uint8Array(b), off);
            off += b.byteLength;
          }
          writes.set(full, out);
        },
      };
    },
  });

  const mkDir = (prefix: string): unknown => ({
    kind: 'directory',
    name: prefix ? prefix.split('/').pop() : name,
    queryPermission: async (): Promise<FsPerm> => perms.query,
    requestPermission: async (): Promise<FsPerm> => perms.request,
    getDirectoryHandle: async (child: string, opts?: { create?: boolean }): Promise<unknown> => {
      const full = norm(prefix, child);
      dirCreates.push(`${full}:${opts?.create ? 'create' : 'noop'}`);
      return mkDir(full);
    },
    getFileHandle: async (child: string, opts?: { create?: boolean }): Promise<unknown> => {
      const full = norm(prefix, child);
      fileCreates.push(`${full}:${opts?.create ? 'create' : 'noop'}`);
      return mkFile(full);
    },
  });

  return { handle: mkDir(''), writes, dirCreates, fileCreates, perms };
}

interface FakeReq {
  result: unknown;
  error: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
}

/** Fresh fake indexedDB backend; assign to globalThis.indexedDB in tests. */
export function createFakeIndexedDB(): unknown {
  interface FakeDbRec {
    version: number;
    stores: Map<string, Map<string, unknown>>;
  }
  const dbs = new Map<string, FakeDbRec>();
  const fire = (fn: (() => void) | undefined): void => {
    setTimeout(() => fn?.(), 0);
  };
  const mkReq = (): FakeReq => ({ result: undefined, error: undefined });

  const mkStoreApi = (data: Map<string, unknown>): unknown => ({
    get: (key: string): FakeReq => {
      const req = mkReq();
      fire(() => {
        req.result = data.get(key);
        req.onsuccess?.();
      });
      return req;
    },
    put: (value: unknown, key: string): FakeReq => {
      const req = mkReq();
      fire(() => {
        data.set(key, value);
        req.result = key;
        req.onsuccess?.();
      });
      return req;
    },
    delete: (key: string): FakeReq => {
      const req = mkReq();
      fire(() => {
        data.delete(key);
        req.onsuccess?.();
      });
      return req;
    },
  });

  const mkDbApi = (db: FakeDbRec): unknown => ({
    objectStoreNames: { contains: (s: string): boolean => db.stores.has(s) },
    createObjectStore: (s: string): unknown => {
      if (!db.stores.has(s)) db.stores.set(s, new Map());
      return mkStoreApi(db.stores.get(s) as Map<string, unknown>);
    },
    transaction: (s: string): unknown => ({
      objectStore: (): unknown => mkStoreApi(db.stores.get(s) as Map<string, unknown>),
    }),
    close: (): void => undefined,
  });

  return {
    open: (name: string, version: number): FakeReq => {
      const req = mkReq();
      const exists = dbs.get(name);
      if (!exists) {
        const db: FakeDbRec = { version, stores: new Map() };
        dbs.set(name, db);
        fire(() => {
          req.result = mkDbApi(db);
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
      } else {
        fire(() => {
          req.result = mkDbApi(exists);
          req.onsuccess?.();
        });
      }
      return req;
    },
  };
}

/** Install/remove the fake on globalThis; returns an uninstaller. */
export function installFakeIndexedDB(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = g.indexedDB;
  g.indexedDB = createFakeIndexedDB();
  return () => {
    if (prev === undefined) delete g.indexedDB;
    else g.indexedDB = prev;
  };
}
