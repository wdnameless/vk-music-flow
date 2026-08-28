import type {
  JournalCounts,
  JournalEntry,
  JournalRecord,
  JournalStatus,
  QueueItem,
} from '../types.js';

/**
 * Persistent queue journal (Phase 1 slice B).
 *
 * Lives in chrome.storage.local under JOURNAL_KEY so it survives MV3 service
 * worker termination. The Journal class is storage-agnostic (pluggable kv) —
 * the codec (serialize/deserialize) is pure for unit tests.
 */

export const JOURNAL_KEY = 'vmf_journal_v1';

const STATUSES: readonly JournalStatus[] = ['queued', 'downloading', 'done', 'failed', 'skipped'];

/** Stable identity for a queue/journal item within a playlist. */
export function journalId(item: { pl: string; key: string }): string {
  return `${item.pl}/${item.key}`;
}

/** Entries -> storage-safe tagged record. */
export function serializeJournal(entries: JournalEntry[]): JournalRecord {
  const items: Record<string, JournalEntry> = {};
  for (const e of entries) items[journalId(e)] = e;
  return { v: 1, items };
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<JournalEntry>;
  return (
    typeof e.key === 'string' &&
    typeof e.pl === 'string' &&
    typeof e.idx === 'number' &&
    Number.isFinite(e.idx) &&
    typeof e.w === 'number' &&
    Number.isFinite(e.w) &&
    typeof e.status === 'string' &&
    (STATUSES as readonly string[]).includes(e.status) &&
    typeof e.attempts === 'number' &&
    Number.isFinite(e.attempts) &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    (e.lastError === null || typeof e.lastError === 'string')
  );
}

/** Record -> validated entries; malformed junk (or wrong schema) yields []. */
export function deserializeJournal(data: unknown): JournalEntry[] {
  if (typeof data !== 'object' || data === null) return [];
  const rec = data as Partial<JournalRecord>;
  if (rec.v !== 1 || typeof rec.items !== 'object' || rec.items === null) return [];
  const out: JournalEntry[] = [];
  for (const v of Object.values(rec.items)) {
    if (isEntry(v)) {
      out.push({
        key: v.key,
        pl: v.pl,
        idx: v.idx,
        w: v.w,
        status: v.status,
        attempts: v.attempts,
        lastError: v.lastError ?? null,
        ts: v.ts,
      });
    }
  }
  return out;
}

/** Minimal persistence surface the journal needs (chrome.storage.local by default). */
export interface JournalKv {
  load(): Promise<unknown>;
  save(v: unknown): Promise<void>;
}

export const chromeStorageJournalKv = (): JournalKv => ({
  load: async () => {
    const o = await chrome.storage.local.get(JOURNAL_KEY);
    return o[JOURNAL_KEY];
  },
  save: async (v) => {
    await chrome.storage.local.set({ [JOURNAL_KEY]: v });
  },
});

/** In-memory journal with eager, awaited persistence. */
export class Journal {
  private map = new Map<string, JournalEntry>();

  constructor(private kv: JournalKv) {}

  async hydrate(): Promise<void> {
    const data = await this.kv.load();
    this.map = new Map(deserializeJournal(data).map((e) => [journalId(e), e]));
  }

  private async save(): Promise<void> {
    try {
      await this.kv.save(serializeJournal([...this.map.values()]));
    } catch {
      /* best-effort persistence; memory stays authoritative for this session */
    }
  }

  get(id: string): JournalEntry | undefined {
    return this.map.get(id);
  }

  /** Create (or reset a terminal entry to) a fresh queued line. */
  async ensure(item: QueueItem): Promise<void> {
    const id = journalId(item);
    const ex = this.map.get(id);
    if (!ex || ex.status === 'done' || ex.status === 'failed' || ex.status === 'skipped') {
      this.map.set(id, {
        key: item.key,
        pl: item.pl,
        idx: item.idx,
        w: item.w,
        status: 'queued',
        attempts: 0,
        lastError: null,
        ts: Date.now(),
      });
      await this.save();
    }
  }

  async setStatus(id: string, status: JournalStatus): Promise<void> {
    const ex = this.map.get(id);
    if (!ex) return;
    ex.status = status;
    ex.ts = Date.now();
    await this.save();
  }

  /** Failed attempt: records the error and bumps the counter. */
  async bumpAttempt(id: string, err: string): Promise<void> {
    const ex = this.map.get(id);
    if (!ex) return;
    ex.attempts++;
    ex.lastError = err.slice(0, 200);
    ex.ts = Date.now();
    await this.save();
  }

  /** Terminal error without consuming an attempt (e.g. permission needed). */
  async noteError(id: string, err: string): Promise<void> {
    const ex = this.map.get(id);
    if (!ex) return;
    ex.lastError = err.slice(0, 200);
    ex.ts = Date.now();
    await this.save();
  }

  attemptCount(id: string): number {
    return this.map.get(id)?.attempts ?? 0;
  }

  pendingEntries(): JournalEntry[] {
    return [...this.map.values()].filter(
      (e) => e.status === 'queued' || e.status === 'downloading',
    );
  }

  /** Cancel: drop lines not started/finished (done + failed history stay). */
  async dropPending(): Promise<void> {
    let ch = false;
    for (const [id, e] of this.map) {
      if (e.status === 'queued' || e.status === 'downloading') {
        this.map.delete(id);
        ch = true;
      }
    }
    if (ch) await this.save();
  }

  /** Clear the whole journal (RESET). */
  async clear(): Promise<void> {
    if (this.map.size) {
      this.map.clear();
      await this.save();
    }
  }

  list(): JournalEntry[] {
    return [...this.map.values()];
  }

  counts(): JournalCounts {
    const c: JournalCounts = { queued: 0, downloading: 0, done: 0, failed: 0, skipped: 0 };
    for (const e of this.map.values()) c[e.status]++;
    return c;
  }
}
