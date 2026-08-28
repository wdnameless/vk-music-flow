import type { FsPermissionStatus, RootDirHandle, WrittenFile } from '../types.js';
import { handlesStore, ROOT_KEY } from './idb.js';

/**
 * File System Access slice (Phase 1, slice A).
 *
 * - pickDirectory() must run in the popup (user gesture); the returned handle
 *   is persisted to IndexedDB so the service worker can load and use it later.
 * - The SW path only *queries* permission (it has no gesture); a non-granted
 *   state surfaces as a StoragePermissionError -> per-item failed entry with
 *   `storage-permission-needed` — never a silent fallback to chrome.downloads.
 */

export class StoragePermissionError extends Error {
  constructor(message = 'storage-permission-needed') {
    super(message);
    this.name = 'StoragePermissionError';
  }
}

type PickerWindow = Window & {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<unknown>;
};

/** Open the native folder picker. Popup-only (requires a user gesture). */
export async function pickDirectory(): Promise<RootDirHandle> {
  if (typeof window === 'undefined') throw new Error('showDirectoryPicker: no window');
  const w = window as PickerWindow;
  if (typeof w.showDirectoryPicker !== 'function') {
    throw new Error('File System Access API недоступен в этом браузере');
  }
  const handle = await w.showDirectoryPicker({ id: 'vkmf-root', mode: 'readwrite' });
  return handle as RootDirHandle;
}

export async function persistRootHandle(handle: RootDirHandle): Promise<void> {
  await handlesStore.set(ROOT_KEY, handle);
}

/** Load the persisted root handle (usable from the SW). Null if none/unavailable. */
export async function loadRootHandle(): Promise<RootDirHandle | null> {
  try {
    const h = await handlesStore.get<RootDirHandle>(ROOT_KEY);
    return h ?? null;
  } catch {
    /* no indexedDB in this context or storage refused */
    return null;
  }
}

export async function clearRootHandle(): Promise<void> {
  try {
    await handlesStore.del(ROOT_KEY);
  } catch {
    /* nothing persisted */
  }
}

/**
 * Query (and optionally request) readwrite permission for a handle.
 * `request=true` needs a user gesture — from the SW always pass false and
 * just report the state.
 */
export async function ensurePermission(
  handle: Pick<RootDirHandle, 'queryPermission' | 'requestPermission'>,
  request: boolean,
): Promise<FsPermissionStatus> {
  try {
    const q = await handle.queryPermission({ mode: 'readwrite' });
    if (q === 'granted') return 'granted';
    if (!request) return q === 'denied' ? 'denied' : 'prompt';
    const r = await handle.requestPermission({ mode: 'readwrite' });
    return r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'denied';
  }
}

/**
 * Write bytes into `relPath` ("A/B/file.ext") under a granted root handle,
 * creating intermediate directories. Returns the normalized path + file handle.
 */
export async function writeToRoot(
  root: RootDirHandle,
  relPath: string,
  bytes: Uint8Array,
): Promise<WrittenFile> {
  const segs = relPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  if (!segs.length) throw new Error('пустой путь записи');
  let dir: RootDirHandle = root;
  for (const seg of segs.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  const name = segs[segs.length - 1] as string;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes as unknown as BlobPart]));
  await writable.close();
  return { path: segs.join('/'), handle };
}
