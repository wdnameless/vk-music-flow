import { buildTag, stripTag } from '../lib/id3.js';
import { parseM3U8, type M3U8ParseResult } from '../lib/m3u8.js';
import { sanitize, pad, sniffExt, concatBytes, sanitizePath } from '../lib/util.js';
import { computeBackoff, computeStartDelay } from '../lib/backoff.js';
import { chromeStorageJournalKv, Journal, journalId } from '../lib/journal.js';
import {
  clearRootHandle,
  ensurePermission,
  loadRootHandle,
  StoragePermissionError,
  writeToRoot,
} from '../storage/fs.js';
import {
  DEFAULT_BLOCK_RULES,
  PLATFORM_LABELS,
  DEFAULT_PROXY_SETTINGS,
  DEFAULT_SETTINGS,
  type AudioMeta,
  type FailedItem,
  type FlowState,
  type JournalResponse,
  type ProxyCheckResult,
  type ProxySettings,
  type ProxyStateResult,
  type QueueItem,
  type RuntimeMessage,
  type BlockRules,
  type LastfmAuth,
  type LyricsResult,
  type PlatformId,
  type PlayerCommand,
  type PlayerState,
  type PlayerTrack,
  type ScrobbleQueueItem,
  type StateSnapshot,
  type StorageStateResult,
  type StreamRef,
  type Track,
  type VkAudio,
  type VkAuthState,
  type VkCatalogBlock,
  type VkCatalogResult,
  type CatalogSection,
  type VkCatalogSection,
  type VkPlaylist,
} from '../types.js';
import { applyProxy, checkProxy, installProxyAuth, normalizeProxySettings, pickActiveEntry, readApplied } from '../lib/proxy.js';
import { installDnrRules, readDnrRules, toDnrRules } from '../lib/dnr.js';
import { provider, providerForKey, platformStatus } from '../platforms/registry.js';
import { parseTrackKey } from '../platforms/provider.js';
import { RestrictedTrackError, resolveTrackUrls } from '../lib/resolve.js';
import {
  playerSnapshot,
  rememberPlayerState,
  sendToPlayer,
} from '../lib/player-bridge.js';
import {
  fetchLyrics,
  filterPlayable,
  normalizeBlockRules,
  parseLyricsResponse,
} from '../lib/integrations.js';
import {
  authorizeUrl,
  exchangeToken,
  isLinked,
  isSessionInvalid,
  normalizeLastfm,
  nowPlaying as lastfmNowPlaying,
  requestToken,
  scrobbleBatch,
  shouldScrobble,
} from '../lib/lastfm.js';
import { audioMetaListFromVk } from '../lib/vk-track.js';
import {
  authState,
  vkCall,
  getCatalogSection,
  getCatalogSections,
  getMyAudios,
  getStreamMix,
  getPlaylistAudios,
  getPlaylists,
  getRecommendations,
  searchAudios,
} from '../lib/vk-api.js';
import { clearToken } from '../lib/vk-auth.js';

const SKEY = 'vmf_state_v1';
const PKEY = 'vmf_proxy_v1';
const RKEY = 'vmf_rules_v1';
const LKEY = 'vmf_lastfm_v1';
const SKEY_SCROBBLE = 'vmf_scrobble_queue_v1';
const SKEY_LF_TOKEN = 'vmf_lastfm_token_v1';

let S: FlowState = {
  audios: {},
  lyrics: {},
  playlists: {},
  queue: [],
  failed: [],
  done: {},
  settings: { ...DEFAULT_SETTINGS },
};

/** Proxy routing config, persisted separately from the download catalog. */
let P: ProxySettings = { ...DEFAULT_PROXY_SETTINGS, entries: [] };

/** Listening preferences (block list / dislikes), persisted separately. */
let R: BlockRules = { ...DEFAULT_BLOCK_RULES, blockedArtists: [], disliked: [] };

/** Last.fm credentials, persisted separately. */
let L: LastfmAuth = { apiKey: '', secret: '', sessionKey: null, username: null };
/** Plays waiting to be scrobbled (Last.fm is often unreachable). */
let scrobbleQ: ScrobbleQueueItem[] = [];
/** Pending desktop-auth token, between "get token" and "user authorised". */
let lfPendingToken: string | null = null;

let pumping = false;
let stopFlag = false; // CANCEL: stop loops + drop pending
let paused = false; // PAUSE: stop new starts, keep in-flight running
/** Journal ids executing in THIS SW instance — rehydrate must never re-queue them. */
const inFlight = new Set<string>();
/** Cold-start hydration, resolved exactly once per SW instance. Every boot
 *  trigger below must reuse it: load() merges persisted state over live state,
 *  so a second call rolls back settings changed since boot and resurrects
 *  queue lines the workers are executing right now. */
let booted: Promise<void> | undefined;
let lastStartAt = 0; // rate limiter anchor (time of last download start)

/** Persistent queue journal in chrome.storage.local (survives SW termination). */
const journal = new Journal(chromeStorageJournalKv());

async function load(): Promise<void> {
  try {
    const o = await chrome.storage.local.get(SKEY);
    if (o[SKEY]) S = { ...S, ...(o[SKEY] as Partial<FlowState>) };
    // defaults-fill: pre-Phase-1 persisted states lack the new settings keys
    S.settings = { ...DEFAULT_SETTINGS, ...S.settings };
    if (!S.settings.baseDir) S.settings.baseDir = 'VK Music';
  } catch {
    /* keep defaults */
  }
  try {
    await journal.hydrate();
    await rehydrateQueueFromJournal();
  } catch {
    /* journal unavailable — plain in-session queueing still works */
  }
  // Wave 1 network layer: hydrate proxy config, install header rules, then push
  // the routing into Chromium. DNR must go in first: VK rejects token minting
  // from an extension origin until the Origin header is spoofed.
  try {
    const o = await chrome.storage.local.get([PKEY, RKEY, LKEY, SKEY_SCROBBLE, SKEY_LF_TOKEN]);
    P = normalizeProxySettings(o[PKEY]);
    R = normalizeBlockRules(o[RKEY]);
    L = normalizeLastfm(o[LKEY]);
    scrobbleQ = normalizeScrobbleQueue(o[SKEY_SCROBBLE]);
    lfPendingToken = typeof o[SKEY_LF_TOKEN] === 'string' ? o[SKEY_LF_TOKEN] : null;
    await installDnrRules();
    await applyProxy(P);
  } catch {
    /* no network permissions — downloads still work direct */
  }
}

/** Re-pump every journal line still pending (resume after SW death). */
async function rehydrateQueueFromJournal(): Promise<void> {
  let ch = false;
  for (const e of journal.pendingEntries()) {
    const id = journalId(e);
    const doneKey = e.pl + '/' + e.key;
    if (S.done[doneKey]) {
      await journal.setStatus(id, 'done');
      continue;
    }
    // A 'downloading' line only means "interrupted" for a COLD start. In a live
    // SW the worker holds it in flight; re-queueing it would download a twin.
    if (inFlight.has(id)) continue;
    if (
      !S.queue.some((q) => q.pl === e.pl && q.key === e.key) &&
      !S.failed.some((f) => f.key === e.key && f.pl === e.pl)
    ) {
      S.queue.push({ key: e.key, pl: e.pl, idx: e.idx, w: e.w });
      ch = true;
    }
  }
  if (ch) persist();
}

let saveT: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    chrome.storage.local.set({ [SKEY]: JSON.parse(JSON.stringify(S)) }).catch(() => {
      /* best-effort */
    });
  }, 400);
}

let saveRT: number | undefined;
function persistRules(): void {
  clearTimeout(saveRT);
  saveRT = setTimeout(() => {
    chrome.storage.local.set({ [RKEY]: JSON.parse(JSON.stringify(R)) }).catch(() => {
      /* best-effort */
    });
  }, 200) as unknown as number;
}

let saveLT: number | undefined;
function persistLastfm(): void {
  clearTimeout(saveLT);
  saveLT = setTimeout(() => {
    chrome.storage.local
      .set({
        [LKEY]: JSON.parse(JSON.stringify(L)),
        [SKEY_SCROBBLE]: JSON.parse(JSON.stringify(scrobbleQ)),
        [SKEY_LF_TOKEN]: lfPendingToken,
      })
      .catch(() => {
        /* best-effort */
      });
  }, 200) as unknown as number;
}

let savePT: number | undefined;
function persistProxy(): void {
  clearTimeout(savePT);
  savePT = setTimeout(() => {
    chrome.storage.local.set({ [PKEY]: JSON.parse(JSON.stringify(P)) }).catch(() => {
      /* best-effort */
    });
  }, 200) as unknown as number;
}

/** Proxy settings + what Chromium actually has installed. */
async function proxyState(): Promise<ProxyStateResult> {
  const applied = await readApplied();
  const entry = pickActiveEntry(P);
  return { ok: true, settings: P, applied: { ...applied, proxyFor: applied.error ? null : (entry?.host ?? null) } };
}

/** Sanitize a stored scrobble backlog. */
function normalizeScrobbleQueue(raw: unknown): ScrobbleQueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is ScrobbleQueueItem => {
      const o = x as Partial<ScrobbleQueueItem> | null;
      return (
        !!o &&
        typeof o.artist === 'string' &&
        typeof o.title === 'string' &&
        typeof o.startedAt === 'number' &&
        o.artist.trim().length > 0 &&
        o.title.trim().length > 0
      );
    })
    .slice(-500)
    .map((x) => ({
      artist: x.artist,
      title: x.title,
      duration: typeof x.duration === 'number' ? x.duration : null,
      startedAt: x.startedAt,
    }));
}

/** True when Last.fm has everything needed to scrobble. */
function lastfmReady(): boolean {
  return isLinked(L);
}

/**
 * Flush the scrobble backlog.
 *
 * Last.fm is commonly unreachable (it is blocked in the same networks that block
 * VK), so failures keep the queue instead of dropping plays. A dead session key
 * is different: retrying it forever would never succeed, so the backlog is kept
 * but the session is surfaced as broken for the user to re-link.
 */
async function flushScrobbles(): Promise<{ ok: boolean; sent: number; pending: number; error?: string }> {
  if (!lastfmReady() || !scrobbleQ.length) {
    return { ok: true, sent: 0, pending: scrobbleQ.length };
  }
  let sent = 0;
  while (scrobbleQ.length) {
    const batch = scrobbleQ.slice(0, 50);
    const r = await scrobbleBatch(batch, L);
    if (!r.ok) {
      const code = (r as { code?: number }).code;
      if (isSessionInvalid(code)) {
        // Session is dead: keep the backlog, but stop pretending it will work.
        return { ok: false, sent, pending: scrobbleQ.length, error: r.error ?? 'сессия Last.fm недействительна' };
      }
      return { ok: false, sent, pending: scrobbleQ.length, error: r.error };
    }
    scrobbleQ.splice(0, batch.length);
    sent += r.accepted ?? batch.length;
    persistLastfm();
  }
  return { ok: true, sent, pending: 0 };
}

/** Queue a finished play and try to send it right away. */
async function enqueueScrobble(item: ScrobbleQueueItem): Promise<void> {
  scrobbleQ.push(item);
  // Bound the backlog so a long offline stretch cannot grow it without limit.
  if (scrobbleQ.length > 500) scrobbleQ = scrobbleQ.slice(-500);
  persistLastfm();
  await flushScrobbles();
}

function mergeAudio(a: AudioMeta): boolean {
  const ex = S.audios[a.key];
  if (!ex) {
    S.audios[a.key] = a;
    return true;
  }
  let ch = false;
  for (const u of a.urls || [])
    if (!ex.urls.includes(u)) {
      ex.urls.push(u);
      ch = true;
    }
  for (const c of a.covers || [])
    if (!ex.covers.includes(c)) {
      ex.covers.push(c);
      ch = true;
    }
  if (!ex.artist && a.artist) {
    ex.artist = a.artist;
    ch = true;
  }
  if (!ex.title && a.title) {
    ex.title = a.title;
    ch = true;
  }
  if (!ex.album && a.album) {
    ex.album = a.album;
    ch = true;
  }
  if (!ex.duration && a.duration) {
    ex.duration = a.duration;
    ch = true;
  }
  return ch;
}

function attachToPlaylist(name: string | undefined | null, key: string): void {
  if (!name) return;
  if (!S.playlists[name]) S.playlists[name] = [];
  const arr = S.playlists[name]!;
  if (!arr.includes(key)) arr.push(key);
}

type HandlerResult =
  | StateSnapshot
  | { ok: boolean }
  | { queued: number; skipped: number }
  | JournalResponse
  | StorageStateResult
  | ProxyStateResult
  | ProxyCheckResult
  | { ok: boolean; ids: number[]; rules: number; error: string | null }
  | VkAuthState
  | VkCatalogResult<VkAudio>
  | VkCatalogResult<VkPlaylist>
  | { ok: boolean; queued: number; skipped: number; total: number }
  | { ok: boolean; state: PlayerState | null; skipped?: number }
  | { ok: boolean; urls: string[]; via?: string; restricted?: boolean; reason?: string }
  | { ok: boolean; sections: VkCatalogSection[] }
  | { ok: boolean; platforms: ReturnType<typeof platformStatus> }
  | { ok: boolean; status?: unknown }
  | { ok: boolean; tracks?: Track[]; playlists?: unknown[]; sections?: CatalogSection[] }
  | { ok: boolean; streams: Record<string, StreamRef> }
  | { ok: boolean; presets: Record<string, number[]> }
  | { ok: boolean; queued: number; skipped: number; total?: number; reason?: string }
  | { ok: boolean; blocks: VkCatalogBlock[] }
  | { ok: boolean; rules: BlockRules; disliked?: boolean }
  | { ok: boolean; lyrics: LyricsResult | null; error?: string }
  | {
      ok: boolean;
      auth?: LastfmAuth;
      enabled?: boolean;
      pending?: number;
      error?: string;
      authorizeUrl?: string | null;
      url?: string | null;
      token?: string | null;
      sent?: number;
    }
  | null;

async function handle(m: RuntimeMessage): Promise<HandlerResult> {
  switch (m.t) {
    case 'AUDIOS': {
      let ch = false;
      for (const a of m.audios || []) {
        if (mergeAudio(a)) ch = true;
        if (m.scanning && m.pl) {
          attachToPlaylist(m.pl, a.key);
          ch = true;
        }
      }
      if (ch) persist();
      return { ok: true };
    }
    case 'LYRICS': {
      Object.assign(S.lyrics, m.map || {});
      persist();
      return { ok: true };
    }
    case 'ENQUEUE': {
      stopFlag = false;
      paused = false;
      const names = m.names || [];
      let skipped = 0;
      for (const name of names) {
        const arr = S.playlists[name] || [];
        const w = String(Math.max(1, arr.length)).length;
        arr.forEach((key, i) => {
          const idx = i + 1;
          const doneKey = name + '/' + key;
          if (S.done[doneKey]) return;
          if (S.queue.some((q) => q.pl === name && q.key === key)) return;
          // DOM-only finds have no playable URL yet (the network hook supplies it
          // when the track is seen). Queueing them would fail instantly with
          // "нет доступных ссылок" and pollute the journal with 100+ errors that
          // can never succeed — report how many were left out instead.
          if (!(S.audios[key]?.urls || []).length) {
            skipped++;
            return;
          }
          S.queue.push({ key, pl: name, idx, w });
        });
      }
      for (const qj of S.queue) await journal.ensure(qj);
      persist();
      pump();
      return { queued: S.queue.length, skipped };
    }
    case 'CANCEL': {
      stopFlag = true;
      paused = false;
      S.queue = [];
      await journal.dropPending();
      persist();
      return { ok: true };
    }
    case 'PAUSE': {
      paused = true;
      persist();
      return { ok: true };
    }
    case 'RESUME': {
      paused = false;
      stopFlag = false;
      await rehydrateQueueFromJournal();
      persist();
      pump();
      return { ok: true };
    }
    case 'GET_JOURNAL': {
      return journalSnap();
    }
    case 'GET_STORAGE_STATE': {
      return await storageState();
    }
    // ---- Wave 1: proxy routing + header rules ----
    case 'GET_PROXY_STATE': {
      return await proxyState();
    }
    case 'SET_PROXY_ENTRIES': {
      P = normalizeProxySettings({ ...P, entries: m.entries });
      persistProxy();
      await applyProxy(P);
      return await proxyState();
    }
    case 'SET_PROXY_MODE': {
      P = { ...P, mode: m.mode };
      persistProxy();
      await applyProxy(P);
      return await proxyState();
    }
    case 'SET_PROXY_ACTIVE': {
      P = { ...P, activeId: m.id };
      persistProxy();
      await applyProxy(P);
      return await proxyState();
    }
    case 'CHECK_PROXY': {
      const entry = m.id ? (P.entries.find((e) => e.id === m.id) ?? null) : pickActiveEntry(P);
      const res = await checkProxy();
      if (entry) {
        P = {
          ...P,
          entries: P.entries.map((e) =>
            e.id === entry.id ? { ...e, lastCheckTs: Date.now(), lastCheckOk: res.ok } : e,
          ),
        };
        persistProxy();
      }
      return { ok: res.ok, status: res.status, latencyMs: res.latencyMs, error: res.error };
    }
    case 'GET_DNR_STATE': {
      const r = await readDnrRules();
      return { ok: r.ok, ids: r.ids, rules: toDnrRules().length, error: r.error };
    }
    case 'INSTALL_DNR': {
      const r = await installDnrRules();
      return { ok: r.ok, ids: r.ids, rules: toDnrRules().length, error: r.error };
    }
    // ---- Wave 2: VK session + catalog ----
    case 'GET_VK_AUTH': {
      return await authState();
    }
    case 'VK_LOGIN': {
      await clearToken();
      return await authState();
    }
    case 'VK_LOGOUT': {
      await clearToken();
      return await authState();
    }
    case 'VK_MY_AUDIOS': {
      const s = await authState();
      if (!s.signedIn || !s.userId) return { ok: false, items: [], reason: s.reason };
      const items = await getMyAudios(s.userId, m.count ?? 50, m.offset ?? 0);
      return { ok: true, items };
    }
    case 'VK_PLAYLISTS': {
      const s = await authState();
      if (!s.signedIn || !s.userId) return { ok: false, items: [], reason: s.reason };
      return { ok: true, items: await getPlaylists(s.userId) };
    }
    case 'VK_PLAYLIST_AUDIOS': {
      const items = await getPlaylistAudios(m.ownerId, m.playlistId, m.accessKey);
      return { ok: true, items };
    }
    case 'VK_SEARCH': {
      return { ok: true, items: await searchAudios(m.q) };
    }
    case 'VK_RECOMMENDATIONS': {
      const s = await authState();
      if (!s.signedIn || !s.userId) return { ok: false, items: [], reason: s.reason };
      return { ok: true, items: await getRecommendations(s.userId) };
    }
    case 'VK_SECTIONS': {
      const s = await authState();
      if (!s.signedIn || !s.userId) return { ok: false, items: [], reason: s.reason };
      return { ok: true, sections: await getCatalogSections(s.userId) };
    }
    case 'VK_SECTION': {
      return { ok: true, blocks: await getCatalogSection(m.sectionId) };
    }
    case 'VK_MIX': {
      const s = await authState();
      if (!s.signedIn || !s.userId) return { ok: false, items: [], reason: s.reason };
      return { ok: true, items: await getStreamMix(s.userId) };
    }
    // ---- Platform-neutral routing (any registered provider) ----
    case 'P_PLATFORMS': {
      return { ok: true, platforms: platformStatus() };
    }
    case 'P_AUTH': {
      const p = provider(m.platform);
      if (!p) return { ok: false, reason: PLATFORM_LABELS[m.platform] + ': ещё не поддерживается' };
      return { ok: true, status: await p.auth() };
    }
    case 'P_LIST': {
      // One entry point for every provider, so the popup never branches on the
      // platform. `kind` selects which provider method answers.
      const p = provider(m.platform ?? 'vk');
      if (!p) return { ok: false, items: [], reason: 'платформа не поддерживается' };
      switch (m.kind) {
        case 'my-tracks':
          return { ok: true, tracks: await p.myTracks() };
        case 'playlists':
          return { ok: true, playlists: await p.playlists() };
        case 'playlist': {
          // Resolve the playlist ref by key; a stale UI could send an id that no
          // longer exists, which must not throw inside the message handler.
          const all = await p.playlists();
          const ref = all.find((x) => x.key === m.id);
          return { ok: !!ref, tracks: ref ? await p.playlistTracks(ref) : [] };
        }
        case 'recommendations':
          return { ok: true, tracks: await p.recommendations() };
        case 'sections':
          return { ok: true, sections: await p.sections() };
        case 'section':
          return { ok: true, tracks: m.id ? await p.sectionTracks(m.id) : [] };
        case 'search':
          return { ok: true, tracks: (await p.search(m.id ?? '')).tracks };
        default:
          return { ok: false, tracks: [], reason: 'неизвестный запрос' };
      }
    }
    case 'P_ENQUEUE': {
      // Downloading a selection the user made in a list (my music, search,
      // recommendations, a playlist). Entries go through the platform's
      // catalogEntry so the downloader has the token it needs to re-resolve a
      // stream later, which a bare Track does not carry.
      stopFlag = false;
      paused = false;
      const name = (m.name || '').trim() || 'Загрузки';
      let skipped = 0;
      const usable: AudioMeta[] = [];
      for (const t of m.tracks) {
        if (t.restricted) {
          skipped++;
          continue;
        }
        const p = providerForKey(t.key);
        const meta = p?.catalogEntry?.(t) ?? null;
        if (!meta) {
          skipped++;
          continue;
        }
        mergeAudio(meta);
        usable.push(meta);
      }
      if (!usable.length) {
        return { ok: false, queued: 0, skipped, reason: skipped ? 'все выбранные треки недоступны' : 'ничего не выбрано' };
      }
      // The queue is keyed by the CATALOG key, not the UI's `Track.key`: the
      // downloader looks entries up in `S.audios`, which stores them under the
      // platform's own id (`<owner>_<id>`), so a `vk:`-prefixed key would never
      // resolve and every item failed with "трек не найден в каталоге".
      for (const meta of usable) attachToPlaylist(name, meta.key);
      persist();
      const width = String(Math.max(1, usable.length)).length;
      let queued = 0;
      usable.forEach((meta, i) => {
        const doneKey = name + '/' + meta.key;
        if (S.done[doneKey]) return;
        if (S.queue.some((q) => q.pl === name && q.key === meta.key)) return;
        S.queue.push({ key: meta.key, pl: name, idx: i + 1, w: width });
        queued++;
      });
      for (const qj of S.queue) await journal.ensure(qj);
      persist();
      pump();
      return { ok: true, queued, skipped, total: m.tracks.length };
    }
    case 'P_LIKE': {
      const p = providerForKey(m.key);
      if (!p?.setLiked) {
        return { ok: false, reason: PLATFORM_LABELS[parseTrackKey(m.key).platform] + ': лайки не поддерживаются' };
      }
      // The UI sends the full track, but a minimal one is enough: providers
      // only need the platform and native id to call their library endpoint.
      const parsed = parseTrackKey(m.key);
      const track: Track = m.track ?? {
        key: m.key,
        platform: parsed.platform,
        nativeId: parsed.nativeId,
        artist: '',
        title: '',
        album: '',
        duration: null,
        cover: null,
        restricted: false,
      };
      // VK distinguishes "already in the library" from a real failure, and a
      // duplicate add is not an error worth showing the user.
      try {
        await p.setLiked(track, m.liked);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/already/i.test(msg)) return { ok: true };
        return { ok: false, reason: msg };
      }
      return { ok: true };
    }
    case 'GET_PRESETS': {
      return { ok: true, presets: S.settings.eqPresets ?? {} };
    }
    case 'SAVE_PRESET': {
      S.settings.eqPresets = { ...(S.settings.eqPresets ?? {}), [m.name]: m.gains };
      persist();
      return { ok: true, presets: S.settings.eqPresets };
    }
    case 'APPLY_PRESET': {
      const gains = (S.settings.eqPresets ?? {})[m.name];
      if (!gains) return { ok: false, state: playerSnapshot() };
      S.settings.playerEqEnabled = true;
      S.settings.playerEqGains = gains.slice();
      persist();
      const s = await sendToPlayer({ t: 'P_EQ_ENABLED', enabled: true });
      let live = s;
      if (gains.length) live = await sendToPlayer({ t: 'P_EQ_BANDS', gains });
      if (live) rememberPlayerState(live as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'P_RESOLVE': {
      // Resolve keys across whatever providers own them, so a mixed queue works.
      const out: Record<string, StreamRef> = {};
      const byPlatform = new Map<PlatformId, Track[]>();
      for (const key of m.keys) {
        const p = providerForKey(key);
        if (!p) continue;
        const parsed = parseTrackKey(key);
        const list = byPlatform.get(parsed.platform) ?? [];
        list.push({ key, platform: parsed.platform, nativeId: parsed.nativeId, artist: '', title: '', album: '', duration: null, cover: null, restricted: false });
        byPlatform.set(parsed.platform, list);
      }
      for (const [pid, tracks] of byPlatform) {
        const p = provider(pid);
        if (!p) continue;
        Object.assign(out, await p.resolveMany(tracks));
      }
      return { ok: true, streams: out };
    }
    case 'VK_ENQUEUE': {
      // Convert API tracks into catalog entries, then reuse the normal queue
      // path so journal/rehydrate/pause semantics all stay identical.
      const metas = audioMetaListFromVk(m.audios);
      let ch = false;
      for (const meta of metas) if (mergeAudio(meta)) ch = true;
      if (ch) persist();
      for (const meta of metas) attachToPlaylist(m.name, meta.key);
      let skipped = 0;
      const arr = S.playlists[m.name] || [];
      const w = String(Math.max(1, arr.length)).length;
      arr.forEach((key, i) => {
        const doneKey = m.name + '/' + key;
        if (S.done[doneKey]) return;
        if (S.queue.some((q) => q.pl === m.name && q.key === key)) return;
        const meta = S.audios[key];
        // Restricted tracks have no URL anywhere — do not queue them at all.
        if (!meta || (meta.restricted === 2 || meta.restricted === 3)) {
          skipped++;
          return;
        }
        S.queue.push({ key, pl: m.name, idx: i + 1, w });
      });
      for (const qj of S.queue) await journal.ensure(qj);
      persist();
      pump();
      return { ok: true, queued: S.queue.length, skipped, total: metas.length };
    }
    // ---- Wave 2: playback via the offscreen document ----
    case 'PLAY_LIST': {
      // Block list / dislikes are applied here so every entry point (catalog,
      // playlist, search) gets the same behaviour without repeating the check.
      const allowed = filterPlayable(m.tracks, R);
      const skipped = m.tracks.length - allowed.length;
      const started = allowed.length
        ? await sendToPlayer({ t: 'P_PLAY_QUEUE', tracks: allowed, startIndex: m.startIndex ?? 0 })
        : null;
      if (started) rememberPlayerState(started as PlayerState);
      return { ok: started !== null, state: playerSnapshot(), skipped };
    }
    case 'PLAY_TOGGLE': {
      // The offscreen document owns the authoritative playing flag; ask before
      // deciding, otherwise the worker would guess from a possibly stale copy.
      const now = (await sendToPlayer({ t: 'P_STATE' })) as PlayerState | null;
      const cmd: PlayerCommand = now?.playing ? { t: 'P_PAUSE' } : { t: 'P_PLAY' };
      const next = await sendToPlayer(cmd);
      if (next) rememberPlayerState(next as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'PLAY_NEXT': {
      const s = await sendToPlayer({ t: 'P_NEXT' });
      if (s) rememberPlayerState(s as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'PLAY_PREV': {
      const s = await sendToPlayer({ t: 'P_PREV' });
      if (s) rememberPlayerState(s as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'PLAY_SEEK': {
      const s = await sendToPlayer({ t: 'P_SEEK', seconds: m.seconds });
      if (s) rememberPlayerState(s as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'PLAY_VOLUME': {
      // Persisted so a recreated offscreen document does not jump back to full
      // volume — the previous behaviour restarted playback at 100%.
      S.settings.playerVolume = Math.max(0, Math.min(1, m.volume));
      persist();
      const s = await sendToPlayer({ t: 'P_VOLUME', volume: m.volume });
      if (s) rememberPlayerState(s as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'EQ_SET': {
      S.settings.playerEqEnabled = m.enabled;
      if (m.gains.length) S.settings.playerEqGains = m.gains.slice();
      persist();
      // Enabled must be applied BEFORE the curve: the player zeroes every filter
      // while disabled, so sending only the bands would look like a no-op.
      let s = await sendToPlayer({ t: 'P_EQ_ENABLED', enabled: m.enabled });
      if (m.gains.length) s = await sendToPlayer({ t: 'P_EQ_BANDS', gains: m.gains });
      if (s) rememberPlayerState(s as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'GET_PLAYER_STATE': {
      const live = await sendToPlayer({ t: 'P_STATE' });
      if (live) rememberPlayerState(live as PlayerState);
      return { ok: true, state: playerSnapshot() };
    }
    case 'RESOLVE_TRACK': {
      // One track, resolved on demand. Used by the player (which must not play a
      // stale URL) and available to the downloader for the same reason.
      try {
        const outcome = await resolveTrackUrls({
          key: m.key,
          id: m.id,
          owner: m.owner,
          artist: m.artist,
          title: m.title,
          album: '',
          year: null,
          duration: m.duration,
          urls: m.urls ?? [],
          covers: m.cover ? [m.cover] : [],
          access_key: m.accessKey,
          restricted: m.restricted,
        });
        return { ok: true, urls: outcome.urls, via: outcome.via, restricted: outcome.restricted };
      } catch (e) {
        return {
          ok: false,
          urls: [],
          reason: e instanceof Error ? e.message : String(e),
          restricted: e instanceof RestrictedTrackError,
        };
      }
    }
    // ---- Wave 3: listening preferences + integrations ----
    case 'GET_BLOCK_RULES': {
      return { ok: true, rules: R };
    }
    case 'SET_BLOCKED_ARTISTS': {
      R = { ...R, blockedArtists: m.artists.filter((a) => a.trim().length > 0) };
      persistRules();
      return { ok: true, rules: R };
    }
    case 'TOGGLE_DISLIKE': {
      const key = `${m.owner}_${m.id}`;
      const has = R.disliked.includes(key);
      R = { ...R, disliked: has ? R.disliked.filter((k) => k !== key) : [...R.disliked, key] };
      persistRules();
      return { ok: true, rules: R, disliked: !has };
    }
    case 'GET_LYRICS': {
      // VK's own endpoint is unreachable (it needs a lyrics_id VK no longer
      // returns), so the fallback provider is the real path. The VK attempt is
      // kept first so it resumes automatically if that field comes back.
      if (m.lyricsId) {
        const r = await vkCall<{ lyrics?: { text?: string; lyrics_id?: number } }>('audio.getLyrics', {
          lyrics_id: m.lyricsId,
        });
        const parsed = r.ok ? parseLyricsResponse(r.data) : null;
        if (parsed) return { ok: true, lyrics: parsed };
      }
      const meta = S.audios[`${m.owner}_${m.id}`];
      const res = await fetchLyrics(meta?.artist ?? '', meta?.title ?? '');
      return { ok: res.ok, lyrics: res.lyrics, error: res.error };
    }
    case 'GET_LASTFM': {
      return {
        ok: true,
        auth: L,
        enabled: lastfmReady(),
        pending: scrobbleQ.length,
        authorizeUrl: lfPendingToken ? authorizeUrl(L.apiKey, lfPendingToken) : null,
      };
    }
    case 'SET_LASTFM': {
      L = normalizeLastfm({
        apiKey: m.apiKey,
        secret: m.secret,
        sessionKey: m.sessionKey ?? L.sessionKey,
        username: m.username ?? L.username,
      });
      persistLastfm();
      return { ok: true, auth: L, enabled: lastfmReady(), pending: scrobbleQ.length };
    }
    case 'LASTFM_GET_TOKEN': {
      // Step 1 of desktop auth: mint a request token and hand back the URL the
      // user must open. A redirect flow is impossible from an extension (no
      // stable callback URL), so the token is exchanged explicitly afterwards.
      if (!L.apiKey || !L.secret) {
        return { ok: false, error: 'сначала сохрани API key и secret', url: null, token: null };
      }
      const r = await requestToken(L);
      if (!r.ok || !r.token) return { ok: false, error: r.error ?? 'токен не получен', url: null, token: null };
      lfPendingToken = r.token;
      persistLastfm();
      return { ok: true, url: authorizeUrl(L.apiKey, r.token), token: r.token };
    }
    case 'LASTFM_LINK': {
      // Step 2: exchange the (now authorised) token for a session key.
      const token = m.token?.trim() || lfPendingToken;
      if (!token) return { ok: false, enabled: false, error: 'нет токена — начни вход заново' };
      const r = await exchangeToken(token, L);
      if (!r.ok || !r.sessionKey) {
        return { ok: false, enabled: false, error: r.error ?? 'сессия не получена' };
      }
      L = { ...L, sessionKey: r.sessionKey, username: r.username ?? null };
      lfPendingToken = null;
      persistLastfm();
      // A successful link is the natural moment to push any backlog.
      const flushed = await flushScrobbles();
      return { ok: true, enabled: true, auth: L, pending: flushed.pending };
    }
    case 'LASTFM_UNLINK': {
      L = { ...L, sessionKey: null, username: null };
      lfPendingToken = null;
      persistLastfm();
      return { ok: true, auth: L, enabled: false, pending: scrobbleQ.length };
    }
    case 'LASTFM_FLUSH': {
      const f = await flushScrobbles();
      return { ok: f.ok, sent: f.sent, pending: scrobbleQ.length, error: f.error };
    }
    case 'LASTFM_NOW_PLAYING': {
      if (!lastfmReady()) return { ok: false, error: 'Last.fm не подключён' };
      const r = await lastfmNowPlaying(m.track, L);
      return { ok: r.ok, error: r.error };
    }
    case 'CLEAR_DIR': {
      await clearRootHandle();
      S.settings = { ...S.settings, rootName: undefined };
      persist();
      return await storageState();
    }
    case 'PICK_DIR_RESULT': {
      if (m.ok && m.rootName) {
        S.settings = { ...S.settings, rootName: m.rootName, storageMode: 'fsa' };
      }
      persist();
      return await storageState();
    }
    case 'RETRY_FAILED': {
      stopFlag = false;
      paused = false;
      const f = S.failed.splice(0, S.failed.length);
      for (const it of f) {
        const doneKey = it.pl + '/' + it.key;
        delete S.done[doneKey];
        if (!S.queue.some((q) => q.pl === it.pl && q.key === it.key)) S.queue.push(it);
      }
      for (const it of f) await journal.ensure(it);
      persist();
      pump();
      return { ok: true };
    }
    case 'CLEAR_FAILED': {
      S.failed = [];
      persist();
      return { ok: true };
    }
    case 'SETTINGS': {
      S.settings = { ...S.settings, ...m.patch };
      persist();
      return { ok: true };
    }
    case 'RESET': {
      S = {
        audios: {},
        lyrics: {},
        playlists: {},
        queue: [],
        failed: [],
        done: {},
        settings: S.settings,
      };
      await journal.clear();
      persist();
      return { ok: true };
    }
    case 'GET_STATE': {
      return snap();
    }
  }
  return null;
}

function journalSnap(): JournalResponse {
  return { ok: true, paused, counts: journal.counts(), entries: journal.list() };
}

async function storageState(): Promise<StorageStateResult> {
  const h = await loadRootHandle();
  const permission = h ? await ensurePermission(h, false) : 'none';
  return { mode: S.settings.storageMode, rootName: S.settings.rootName ?? null, permission };
}

function snap(): StateSnapshot {
  return {
    playlists: Object.fromEntries(Object.entries(S.playlists).map(([k, v]) => [k, v.length])),
    queue: S.queue.map((q) => {
      const au = S.audios[q.key];
      return { pl: q.pl, idx: q.idx, a: au ? { artist: au.artist, title: au.title } : null };
    }),
    failed: S.failed.map((f) => {
      const au = S.audios[f.key];
      return { pl: f.pl, err: f.error, a: au ? { artist: au.artist, title: au.title } : null };
    }),
    doneCount: Object.keys(S.done).length,
    settings: S.settings,
    totalAudios: Object.keys(S.audios).length,
    journal: journal.counts(),
    paused,
  };
}

function fail(item: QueueItem | FailedItem, err: unknown): void {
  const doneKey = item.pl + '/' + item.key;
  if (S.done[doneKey]) delete S.done[doneKey];
  if (!S.failed.some((f) => f.key === item.key && f.pl === item.pl)) {
    S.failed.push({
      key: item.key,
      pl: item.pl,
      idx: item.idx,
      w: item.w,
      error: String(err).slice(0, 200),
      ts: Date.now(),
    });
  } else {
    const f = S.failed.find((f) => f.key === item.key && f.pl === item.pl)!;
    f.error = String(err).slice(0, 200);
    f.ts = Date.now();
  }
  persist();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const slots = Math.min(5, Math.max(1, +S.settings.conc || 2));
    await Promise.all(Array.from({ length: slots }, () => workerLoop()));
  } finally {
    pumping = false;
  }
}

/** Rate limiter: keep >= minIntervalMs (+ anti-ban jitter) between download starts. */
async function gateStart(): Promise<void> {
  const wait = computeStartDelay(
    lastStartAt,
    Math.max(0, +S.settings.minIntervalMs || 0),
    Math.max(0, +S.settings.jitterMs || 0),
  );
  if (wait > 0) await sleep(wait);
  lastStartAt = Date.now();
}

async function workerLoop(): Promise<void> {
  while (true) {
    if (stopFlag || paused) break;
    const item = S.queue.shift();
    if (!item) break;
    await gateStart();
    if (stopFlag || paused) {
      S.queue.unshift(item);
      break;
    }
    persist();
    const id = journalId(item);
    inFlight.add(id);
    await journal.setStatus(id, 'downloading');
    let attempts = journal.attemptCount(id);
    const max = Math.max(1, Math.floor(+S.settings.maxAttempts || DEFAULT_SETTINGS.maxAttempts));
    try {
      for (;;) {
        try {
          await runItem(item);
          await journal.setStatus(id, 'done');
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof StoragePermissionError) {
            // surface per-item, no silent downloads-fallback, no retry storm
            await journal.noteError(id, msg);
            await journal.setStatus(id, 'failed');
            fail(item, msg);
            break;
          }
          if (e instanceof RestrictedTrackError) {
            // VK serves no URL for this track from any endpoint (measured), so
            // retrying only burns time and pollutes the journal with a permanent
            // error. Fail it once, immediately.
            await journal.noteError(id, msg);
            await journal.setStatus(id, 'failed');
            fail(item, msg);
            break;
          }
          attempts++;
          await journal.bumpAttempt(id, msg);
          if (attempts >= max) {
            await journal.setStatus(id, 'failed');
            fail(item, msg);
            break;
          }
          await sleep(
            computeBackoff(
              attempts,
              Math.max(0, +S.settings.baseBackoffMs || DEFAULT_SETTINGS.baseBackoffMs),
              Math.max(0, +S.settings.maxBackoffMs || DEFAULT_SETTINGS.maxBackoffMs),
              Math.max(0, +S.settings.jitterMs),
            ),
          );
          if (stopFlag || paused) {
            await journal.setStatus(id, 'queued');
            S.queue.unshift(item);
            break;
          }
        }
      }
    } finally {
      // requeued items leave the set with the line already back to 'queued',
      // so rehydration may pick them up; finished ones stay out of it forever
      inFlight.delete(id);
    }
    await sleep(+S.settings.gapMs || 400);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runItem(item: QueueItem): Promise<void> {
  const a = S.audios[item.key];
  if (!a) throw new Error('трек не найден в каталоге');
  const doneKey = item.pl + '/' + item.key;
  if (S.done[doneKey]) return;

  let body = await getAudioBytes(a);
  const ext = sniffExt(body);
  // MPEG-TS and MP3 both accept a leading ID3v2 tag (and players skip it); the
  // AAC/ADTS container does not, so those stay untagged.
  if (ext === 'mp3' || ext === 'ts') {
    body = stripTag(body);
    const cover = await getCover(a);
    const lyrics = S.lyrics[String(a.id)] || '';
    const tag = buildTag(
      { title: a.title, artist: a.artist, album: a.album, year: a.year, track: item.idx },
      cover,
      lyrics,
    );
    if (tag) body = concatBytes([tag, body]);
  }

  const label = `${pad(item.idx, item.w)} ${sanitize(`${a.artist} - ${a.title}`)}.${ext}`;
  if (S.settings.storageMode === 'fsa') {
    // Write straight into the user-picked folder: <Playlist>/NN Artist - Title.ext
    const root = await loadRootHandle();
    if (!root) throw new StoragePermissionError();
    const perm = await ensurePermission(root, false);
    if (perm !== 'granted') {
      throw new StoragePermissionError(`storage-permission-needed (${perm})`);
    }
    await writeToRoot(root, `${sanitize(item.pl)}/${label}`, body);
  } else {
    const base = sanitizePath(S.settings.baseDir) || 'VK Music';
    await saveBlob(body, `${base}/${sanitize(item.pl)}/${label}`);
  }

  S.done[doneKey] = Date.now();
  const fi = S.failed.findIndex((f) => f.key === item.key && f.pl === item.pl);
  if (fi !== -1) S.failed.splice(fi, 1);
  persist();
}

async function rawFetch(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Fetch a track's bytes, resolving a fresh stream URL first.
 *
 * VK stream URLs expire, so the catalog's copy is a fallback, not the primary
 * source: `resolveTrackUrls` asks the API (via `access_key`) and only then falls
 * back to whatever the page hook captured. A track VK marks restricted throws
 * `RestrictedTrackError`, which the queue treats as terminal.
 */
async function getAudioBytes(a: AudioMeta): Promise<Uint8Array> {
  const outcome = await resolveTrackUrls(a);
  let lastErr: Error | null = null;
  for (const url of outcome.urls) {
    try {
      return await fetchStream(url);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error('нет доступных ссылок');
}

/** Fetch one resolved URL, assembling HLS when the payload is a playlist. */
async function fetchStream(url: string): Promise<Uint8Array> {
  const direct = !/\.m3u8/i.test(url);
  if (direct) {
    const b = await rawFetch(url);
    // An .m3u8 can also arrive at a non-.m3u8 URL; EXT-X magic means playlist.
    if (!(b[0] === 0x23 && b[1] === 0x45 && b[2] === 0x58)) return b;
    return assembleHls(new TextDecoder().decode(b), url);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return assembleHls(await r.text(), url);
}

/**
 * AES-128-CBC HLS segment decryption (RFC 8216 §5.2).
 *
 * VK switched its audio CDN to encrypted HLS: `#EXT-X-KEY:METHOD=AES-128` with a
 * 16-byte key URL and no explicit IV, so the IV is the segment's media sequence
 * number as a big-endian 128-bit integer. Without this the segments were
 * concatenated still encrypted and every file landed as unsniffable garbage.
 */
async function hlsKeyBytes(uri: string): Promise<Uint8Array> {
  const b = await rawFetch(uri);
  if (b.length !== 16) throw new Error(`ожидался 16-байтный ключ, получено ${b.length}`);
  return b;
}

function sequenceIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
  return iv;
}

async function decryptAes128(
  seg: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-CBC', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    key,
    seg as BufferSource,
  );
  return new Uint8Array(plain);
}

async function assembleHls(txt: string, baseUrl: string): Promise<Uint8Array> {
  let p: M3U8ParseResult = parseM3U8(txt, baseUrl);
  if (p.variant) {
    const r = await fetch(p.variant);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p = parseM3U8(await r.text(), p.variant);
  }
  if (!p.segments.length) throw new Error('плейлист без сегментов');
  const parts: Uint8Array[] = [];
  if (p.init) parts.push(await rawFetch(p.init));
  const keys = new Map<string, Uint8Array>();
  let i = 0;
  for (const s of p.segments) {
    if (i > 5000) break;
    let seg = await rawFetch(s.url);
    if (s.key?.method === 'AES-128' && s.key.uri) {
      let kb = keys.get(s.key.uri);
      if (!kb) {
        kb = await hlsKeyBytes(s.key.uri);
        keys.set(s.key.uri, kb);
      }
      seg = await decryptAes128(seg, kb, s.key.iv ?? sequenceIv(s.seq));
    }
    if (seg[0] === 0x23 && seg[1] === 0x45 && seg[2] === 0x58) {
      seg = await assembleHls(new TextDecoder().decode(seg), s.url);
    }
    parts.push(seg);
    i++;
  }
  const out = concatBytes(parts);
  if (!out.length) throw new Error('пустой результат');
  return out;
}

async function getCover(a: AudioMeta): Promise<Uint8Array | null> {
  for (const c of (a.covers || []).slice(0, 3)) {
    try {
      const b = await rawFetch(c);
      if (b.length > 1024 && b.length < 4e6) return b;
    } catch {
      /* try next cover */
    }
  }
  return null;
}

const pendingDl = new Map<number, { res: () => void; rej: (err: Error) => void }>();

chrome.downloads.onChanged.addListener((d) => {
  const w = pendingDl.get(d.id);
  if (!w) return;
  if (d.state) {
    if (d.state.current === 'complete') {
      pendingDl.delete(d.id);
      w.res();
    } else if (d.state.current === 'interrupted') {
      pendingDl.delete(d.id);
      w.rej(new Error((d.error as unknown as string) || 'прервано'));
    }
  }
});

function waitDone(id: number, timeoutMs?: number): Promise<void> {
  return new Promise((res, rej) => {
    pendingDl.set(id, { res, rej });
    setTimeout(() => {
      if (pendingDl.delete(id)) rej(new Error('таймаут загрузки'));
    }, timeoutMs || 900000);
  });
}

/**
 * Hand bytes to chrome.downloads as a `data:` URL.
 *
 * MV3 service workers have no `URL.createObjectURL` — it is a Window/Dedicated-
 * Worker API and is `undefined` here, so the old blob-URL path threw
 * "URL.createObjectURL is not a function" on every download. `FileReader` IS
 * available in workers, so it does the base64 encoding natively.
 *
 * Cost: the payload lives once as bytes and once as a ~1.33x base64 string.
 * VK tracks are single-digit MB; verified working to 30 MB in real Chromium.
 */
async function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(fr.error ?? new Error('не удалось закодировать данные'));
    fr.readAsDataURL(blob);
  });
}

async function saveBlob(bytes: Uint8Array, fname: string): Promise<void> {
  const mime = fname.endsWith('.mp3') ? 'audio/mpeg' : 'audio/aac';
  const id = await chrome.downloads.download({
    url: await bytesToDataUrl(bytes, mime),
    filename: fname,
    conflictAction: 'uniquify',
  });
  await waitDone(id);
}

/** Reuse the one cold-start hydration for all four boot triggers below. */
const boot = (): Promise<void> => (booted ??= load());

// Answer proxy credential challenges for the configured entries. Registered at
// module scope (not inside boot()) because MV3 requires listeners to exist
// synchronously on every worker start, even when it only wakes for an event.
installProxyAuth(() => P);

/** Track the offscreen document is currently playing, for scrobbling. */
let nowPlaying: { track: PlayerTrack; startedAt: number; scrobbled: boolean } | null = null;

chrome.commands?.onCommand.addListener((cmd) => {
  void (async () => {
    switch (cmd) {
      case 'play-pause':
        await handle({ t: 'PLAY_TOGGLE' } as RuntimeMessage);
        break;
      case 'next':
        await handle({ t: 'PLAY_NEXT' } as RuntimeMessage);
        break;
      case 'prev':
        await handle({ t: 'PLAY_PREV' } as RuntimeMessage);
        break;
      case 'volume-up':
      case 'volume-down': {
        const s = playerSnapshot();
        const delta = cmd === 'volume-up' ? 0.1 : -0.1;
        const next = Math.max(0, Math.min(1, (s?.volume ?? 1) + delta));
        await handle({ t: 'PLAY_VOLUME', volume: next } as RuntimeMessage);
        break;
      }
    }
  })();
});

chrome.runtime.onMessage.addListener((m: unknown, _sender, sendResponse) => {
  const msg = m as { t?: string };
  // Messages the OFFSCREEN document pushes to us. These must not go through
  // handle(), which is typed for popup-originated commands.
  if (msg?.t === 'PLAYER_STATE') {
    const state = (m as { state: PlayerState }).state;
    rememberPlayerState(state);
    // A new track starts our scrobble window; the offscreen document owns
    // advancing, so we only observe here.
    if (state.track && state.track.key !== nowPlaying?.track.key) {
      nowPlaying = { track: state.track, startedAt: Date.now(), scrobbled: false };
      if (lastfmReady()) void lastfmNowPlaying(state.track, L);
    }
    // Scrobble once the play qualifies, without waiting for the track to end
    // (Last.fm's rule is about elapsed play time, not completion). The play goes
    // through the queue so a Last.fm outage does not lose it.
    if (
      nowPlaying &&
      !nowPlaying.scrobbled &&
      shouldScrobble(state.currentTime, state.duration || nowPlaying.track.duration, lastfmReady())
    ) {
      nowPlaying.scrobbled = true;
      void enqueueScrobble({
        artist: nowPlaying.track.artist,
        title: nowPlaying.track.title,
        duration: nowPlaying.track.duration,
        startedAt: nowPlaying.startedAt,
      });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.t === 'PLAYER_ENDED') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.t === 'PLAYER_READY') {
    // A fresh offscreen document starts at full volume with a flat equalizer,
    // so the saved preferences are pushed back in before anything plays.
    void (async () => {
      const vol = S.settings.playerVolume;
      if (typeof vol === 'number') await sendToPlayer({ t: 'P_VOLUME', volume: vol });
      if (S.settings.playerEqEnabled) {
        await sendToPlayer({ t: 'P_EQ_ENABLED', enabled: true });
        const gains = S.settings.playerEqGains;
        if (gains?.length) await sendToPlayer({ t: 'P_EQ_BANDS', gains });
      }
    })();
    sendResponse({ ok: true });
    return false;
  }
  handle(m as RuntimeMessage)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.alarms.create('vmf-pump', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((al) => {
  if (al.name === 'vmf-pump') {
    void boot().then(pump);
  }
});
chrome.runtime.onStartup.addListener(() => {
  stopFlag = false;
  paused = false;
  void boot().then(pump);
});
chrome.runtime.onInstalled.addListener(() => {
  void boot().then(pump);
});

void boot().then(pump);
