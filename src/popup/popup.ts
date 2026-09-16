import type {
  BlockRules,
  CatalogSection,
  EqBand,
  LastfmAuth,
  PlayerState,
  PlatformId,
  PlaylistRef,
  ProxyCheckResult,
  ProxyEntry,
  ProxyRoutingMode,
  ProxyStateResult,
  ResponseSample,
  RuntimeMessage,
  ScanResult,
  StateSnapshot,
  StorageStateResult,
  Track,
  VkAuthState,
} from '../types.js';
import { DEFAULT_AUDIO_FX, EQ_BANDS, PLATFORM_LABELS } from '../types.js';
import { persistRootHandle, pickDirectory } from '../storage/fs.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const $in = (id: string) => document.getElementById(id) as HTMLInputElement;
const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement;

let state: StateSnapshot | null = null;
let storageState: StorageStateResult | null = null;
const selected = new Set<string>();

/** Source platform currently shown. VK only until the others are implemented. */
let activePlatform: PlatformId = 'vk';

/** Tracks currently rendered in the platform list, and the ticked subset. */
let listTracks: Track[] = [];
const ticked = new Set<string>();
/** Host element of the list currently on screen, so a repaint knows where to go. */
let lastListTarget = 'homeTracks';

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmtDur = (s: number | null): string => {
  if (typeof s !== 'number' || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/* ---------------- Host mode ----------------
   The same page runs as the toolbar popup, as a standalone window and as the
   side panel. Only the popup has a fixed size, so the host is recorded on
   <body> and the CSS adapts from there. */

const HOST: 'popup' | 'window' | 'panel' = (() => {
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode === 'window' || mode === 'panel') return mode;

  // The popup is the only host whose size Chrome derives from the page, so it
  // must be identified positively rather than guessed. Doing it by viewport
  // width was wrong: at the moment the popup's script runs its width is still
  // 0, so it declared itself the side panel, never applied the fixed size, and
  // Chrome then sized the popup to the collapsed content — an empty window.
  try {
    const views = chrome.extension?.getViews?.({ type: 'popup' }) ?? [];
    if (views.includes(window)) return 'popup';
  } catch {
    /* getViews is not available everywhere; fall through */
  }

  // The side panel with no query parameter (the manifest's default path) and a
  // page in a tab both land here. Both fill their viewport, and the narrow
  // layout is driven by a width media query rather than by the host, so this
  // default is safe for either.
  return 'window';
})();

document.body.dataset.host = HOST;

/** Open the player in its own window. */
$('btnOpenWindow').addEventListener('click', async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL('src/popup/popup.html?mode=window'),
    type: 'popup',
    width: 1100,
    height: 760,
  });
  // A popup cannot stay open once a window steals focus; closing is cleaner
  // than leaving a dead panel behind.
  if (HOST === 'popup') window.close();
});

$('btnOpenPanel').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id! });
    if (HOST === 'popup') window.close();
  } catch (e) {
    $('platformState').textContent = 'Панель недоступна: ' + ((e as Error).message || e);
  }
});

/* ---------------- Navigation ---------------- */

function showView(name: string): void {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.view === name),
  );
}

document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => void openView((b as HTMLElement).dataset.view || 'home'));
});

/* ---------------- Platform (source) ---------------- */

async function refreshPlatforms(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; platforms: { id: PlatformId; label: string; available: boolean }[] }>({
      t: 'P_PLATFORMS',
    });
    // Spotify/YouTube are shown but disabled: the source picker must not offer
    // a service that would silently return nothing.
    $sel('platformPick').innerHTML = r.platforms
      .map((p) => `<option value="${p.id}"${p.available ? '' : ' disabled'}>${escapeHtml(p.label)}${p.available ? '' : ' (скоро)'}</option>`)
      .join('');
    $sel('platformPick').value = activePlatform;
    const cur = r.platforms.find((p) => p.id === activePlatform);
    $('platformState').textContent = cur?.available ? '' : 'источник ещё не подключён';
  } catch {
    /* keep the last view */
  }
}

$sel('platformPick').addEventListener('change', (e) => {
  activePlatform = (e.target as HTMLSelectElement).value as PlatformId;
  listTracks = [];
  ticked.clear();
  void refreshPlatformAuth();
  void loadHome();
});

async function refreshPlatformAuth(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; status?: VkAuthState; reason?: string }>({
      t: 'P_AUTH',
      platform: activePlatform,
    });
    const el = $('platformState');
    if (!r.ok || !r.status) {
      el.textContent = r.reason || 'не удалось проверить сессию';
      return;
    }
    el.textContent = r.status.signedIn
      ? `${PLATFORM_LABELS[activePlatform]}: вошёл${r.status.userId ? ' (id ' + r.status.userId + ')' : ''}`
      : `${PLATFORM_LABELS[activePlatform]}: ` + (r.status.reason || 'не удалось войти');
  } catch {
    $('platformState').textContent = 'не удалось проверить сессию';
  }
}

/** One list request for every platform; `kind` picks the provider method. */
async function loadList(
  kind: 'my-tracks' | 'playlists' | 'recommendations' | 'sections' | 'section' | 'playlist' | 'search',
  id: string | undefined,
  target: string,
): Promise<void> {
  const host = $(target);
  host.innerHTML = '<li class="meta">Загружаю…</li>';
  try {
    const r = await send<{ ok: boolean; tracks?: Track[]; playlists?: PlaylistRef[]; sections?: CatalogSection[]; reason?: string }>({
      t: 'P_LIST',
      platform: activePlatform,
      kind,
      id,
    });
    if (!r.ok) {
      host.innerHTML = `<li class="meta">${escapeHtml(r.reason || 'не удалось получить данные')}</li>`;
      return;
    }
    if (r.sections) {
      host.innerHTML = '';
      $('exploreSections').innerHTML = r.sections.length
        ? r.sections.map((s) => `<button class="chip" data-section="${escapeHtml(s.id)}">${escapeHtml(s.title)}</button>`).join('')
        : '<span class="meta">Разделов нет.</span>';
      return;
    }
    if (r.playlists) {
      renderPlaylists(r.playlists, target);
      return;
    }
    listTracks = r.tracks ?? [];
    ticked.clear();
    renderTracks(target);
  } catch (e) {
    host.innerHTML = `<li class="muted">Ошибка: ${escapeHtml((e as Error).message || String(e))}</li>`;
  }
}

function renderPlaylists(items: PlaylistRef[], target: string): void {
  const host = $(target);
  if (!items.length) {
    host.innerHTML = '<li class="meta">Плейлистов нет.</li>';
    return;
  }
  host.innerHTML = items
    .map(
      (p) =>
        `<li class="pl" data-pl="${escapeHtml(p.key)}">` +
        `<div class="pl-cover"${p.cover ? ` style="background-image:url('${escapeHtml(p.cover)}')"` : ''}></div>` +
        `<div class="pl-body"><b>${escapeHtml(p.title)}</b>` +
        `<span class="meta">${p.trackCount ?? '?'} треков</span></div></li>`,
    )
    .join('');
}

function trackRow(t: Track, opts: { tick?: boolean; index?: number } = {}): string {
  const isTicked = ticked.has(t.key);
  // The play affordance sits on the artwork, so the row keeps one hover target.
  const play = `<span class="t-play" data-play="${escapeHtml(t.key)}" role="button" aria-label="Играть"><svg class="ic"><use href="#i-play"/></svg></span>`;
  // Queue actions live on the row so a track can be queued without playing it.
  const queueActions =
    `<button class="mini" data-next="${escapeHtml(t.key)}" title="Играть следующим"><svg class="ic"><use href="#i-next"/></svg></button>` +
    `<button class="mini" data-enqueue="${escapeHtml(t.key)}" title="В очередь"><svg class="ic"><use href="#i-download"/></svg></button>`;
  return (
    `<li data-key="${escapeHtml(t.key)}" class="track${t.restricted ? ' muted' : ''}" style="--i:${opts.index ?? 0}">` +
    (opts.tick !== false
      ? `<input type="checkbox" data-tick="${escapeHtml(t.key)}"${isTicked ? ' checked' : ''}${t.restricted ? ' disabled' : ''}/>`
      : '') +
    // Artwork and play overlay share one box, so the cover can act as the button.
    `<span class="t-wrap">` +
    `<span class="t-cover"${t.cover ? ` style="background-image:url('${escapeHtml(t.cover)}')"` : ''}></span>` +
    (t.restricted ? '' : play) +
    `</span>` +
    `<div class="t-body"><b>${escapeHtml(t.title || '—')}</b><span>${escapeHtml(t.artist)}</span></div>` +
    `<span class="t-dur">${fmtDur(t.duration)}</span>` +
    (t.restricted ? '<span class="bad">недоступен</span>' : queueActions) +
    '</li>'
  );
}

function renderTracks(target: string): void {
  lastListTarget = target;
  const host = $(target);
  if (!listTracks.length) {
    host.innerHTML = '<li class="meta">Ничего нет.</li>';
    updateCount();
    return;
  }
  host.innerHTML = listTracks.map((t, i) => trackRow(t, { index: i })).join('');
  updateCount();
}

/** Keep the tray and the download button honest about what will be queued. */
function updateCount(): void {
  const el = $('libTotal');
  if (el) {
    el.textContent = listTracks.length
      ? `${listTracks.length} треков · выбрано ${ticked.size}`
      : '';
  }
  const tray = $('selTray');
  if (tray) {
    tray.hidden = ticked.size === 0;
    $('selCount').textContent = `Выбрано ${ticked.size}`;
  }
  const dl = $btn('btnDownload');
  if (dl) dl.disabled = ticked.size === 0 && selected.size === 0;
}

/* ---------------- Selection tray ---------------- */

$('selClear').addEventListener('click', () => {
  ticked.clear();
  renderTracks(lastListTarget);
});
$('selPlay').addEventListener('click', () => {
  const keys = listTracks.filter((t) => ticked.has(t.key) && !t.restricted).map((t) => t.key);
  if (keys.length) void playTracks(keys, keys[0]);
});
$('selDownload').addEventListener('click', async () => {
  showView('downloads');
  await queueTicked();
  void refresh();
});

/** Shared click handling for every track list: tick and play. */
function wireTrackList(target: string): void {
  const host = $(target);
  host.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const tickKey = el.dataset.tick;
    if (tickKey) {
      if ((el as HTMLInputElement).checked) ticked.add(tickKey);
      else ticked.delete(tickKey);
      updateCount();
      return;
    }
    const playKey = el.dataset.play;
    if (playKey) {
      await playTracks([playKey], playKey);
      return;
    }
    const nextKey = el.dataset.next;
    if (nextKey) {
      await queueTracks([nextKey], true);
      return;
    }
    const enqKey = el.dataset.enqueue;
    if (enqKey) {
      await queueTracks([enqKey], false);
      return;
    }
    // Shift-click a playlist card opens it; a plain click on the card body does
    // the same, which is the only affordance that reads as "this is a folder".
    if (el.closest('.pl') && !el.closest('button')) {
      const card = el.closest('.pl') as HTMLElement;
      const key = card.dataset.pl;
      if (key) {
        const title = card.querySelector('b')?.textContent;
        await loadList('playlist', key, target);
        if (title) $in('scanName').value = title;
      }
      return;
    }

  });
}

['myTracks', 'exploreTracks', 'radioTracks', 'searchResults', 'homeTracks'].forEach(wireTrackList);

/* ---------------- My music ---------------- */

$('btnMyTracks').addEventListener('click', () => {
  $('myTracks').hidden = false;
  $('myPlaylists').hidden = true;
  $('btnMyTracks').classList.add('active');
  $('btnMyPlaylists').classList.remove('active');
  void loadList('my-tracks', undefined, 'myTracks');
});

$('btnMyPlaylists').addEventListener('click', () => {
  $('myTracks').hidden = true;
  $('myPlaylists').hidden = false;
  $('btnMyPlaylists').classList.add('active');
  $('btnMyTracks').classList.remove('active');
  void loadList('playlists', undefined, 'myPlaylists');
});

/* ---------------- Explore / search / radio ---------------- */

$('exploreSections').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-section]') as HTMLElement | null;
  if (btn?.dataset.section) void loadList('section', btn.dataset.section, 'exploreTracks');
});

$('btnSearch').addEventListener('click', () => {
  const q = $in('q').value.trim();
  if (q) void loadList('search', q, 'searchResults');
});
$('q').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $btn('btnSearch').click();
});

$('btnMix').addEventListener('click', () => void loadList('recommendations', undefined, 'radioTracks'));
$('btnRecs').addEventListener('click', () => void loadList('recommendations', undefined, 'radioTracks'));

/* ---------------- Downloads: queue and library ---------------- */

function render(): void {
  if (!state) return;

  $('qCount').textContent = String(state.journal.queued);
  $('zCount').textContent = String(state.journal.downloading);
  $('dCount').textContent = String(state.doneCount);
  $('fCount').textContent = String(state.failed.length);
  $('pausedFlag').textContent = state.paused ? 'пауза' : '';
  $btn('btnPause').disabled = state.paused;
  $btn('btnResume').disabled = !state.paused;

  const qList = $('qList');
  qList.innerHTML = '';
  const qShow = state.queue.slice(0, 30);
  if (!qShow.length) qList.innerHTML = '<li class="meta">Очередь пуста</li>';
  for (const q of qShow) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 't-dur';
    num.textContent = String(q.idx).padStart(2, '0');
    const body = document.createElement('div');
    body.className = 't-body';
    const title = document.createElement('b');
    title.textContent = q.a ? q.a.title || '?' : '?';
    const sub = document.createElement('span');
    sub.textContent = (q.a?.artist ? q.a.artist + ' · ' : '') + q.pl;
    body.append(title, sub);
    li.append(num, body);
    qList.appendChild(li);
  }

  const fList = $('fList');
  fList.innerHTML = '';
  const fShow = state.failed.slice(0, 30);
  if (!fShow.length) fList.innerHTML = '<li class="meta">Ошибок нет</li>';
  for (const f of fShow) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.textContent = `${f.pl} — ${f.a ? f.a.artist + ' — ' + f.a.title : '?'}`;
    const err = document.createElement('span');
    err.className = 'err-msg';
    err.textContent = f.err;
    li.append(t, err);
    fList.appendChild(li);
  }

  const plList = $('plList');
  plList.innerHTML = '';
  const names = Object.keys(state.playlists).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    plList.innerHTML =
      '<li class="meta">Плейлисты не собраны. Открой плейлист во ВКонтакте и нажми «Сканировать вкладку».</li>';
  }
  for (const name of names) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(name);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(name);
      else selected.delete(name);
      updateDlBtn();
    });
    const label = document.createElement('span');
    label.textContent = name;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = String(state!.playlists[name]);
    li.append(cb, label, cnt);
    plList.appendChild(li);
  }
  updateDlBtn();
}

function updateDlBtn(): void {
  $btn('btnDownload').disabled = !selected.size && !ticked.size;
}

async function refresh(): Promise<void> {
  try {
    state = await send<StateSnapshot>({ t: 'GET_STATE' });
  } catch {
    state = null;
  }
  render();
}

/* ---------------- Playback ---------------- */

/** Resolve fresh URLs (VK links expire) then hand the list to the player. */
/**
 * Add tracks to the playing queue without interrupting the current track.
 *
 * `next` inserts right after the cursor; otherwise they land at the end. Each
 * track needs a fresh URL, so it is resolved here rather than stored.
 */
async function queueTracks(keys: string[], next: boolean): Promise<void> {
  const wanted = new Set(keys);
  const picked = listTracks.filter((t) => wanted.has(t.key) && !t.restricted);
  if (!picked.length) return;
  const r = await send<{ ok: boolean; streams: Record<string, { url: string }> }>({
    t: 'P_RESOLVE',
    keys: picked.map((t) => t.key),
  });
  const tracks = picked
    .map((t) => {
      const st = r.streams[t.key];
      if (!st) return null;
      return {
        key: t.key,
        id: t.nativeId.split('_')[1] ?? t.nativeId,
        owner: t.nativeId.split('_')[0] ?? '0',
        artist: t.artist,
        title: t.title,
        url: st.url,
        duration: t.duration,
        cover: t.cover,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!tracks.length) return;
  const res = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_INSERT',
    tracks,
    next,
  });
  pState = res.state;
  renderPlayer();
  if (!$('queuePanel').hidden) renderQueue();
  $('dlNote').textContent = next
    ? `Играет следующим: ${tracks.length}.`
    : `В очередь добавлено: ${tracks.length}.`;
}

/**
 * Play the given tracks, in list order.
 *
 * `startKey` is the row the user clicked: the queue is built from that row
 * onwards, so pressing play on track 20 of a list plays the rest of the list
 * rather than a single track.
 */
async function playTracks(keys: string[], startKey?: string): Promise<void> {
  const wanted = new Set(keys);
  let picked = listTracks.filter((t) => wanted.has(t.key) && !t.restricted);
  if (startKey && picked.length === 1) {
    const at = listTracks.findIndex((t) => t.key === startKey);
    if (at >= 0) picked = listTracks.slice(at).filter((t) => !t.restricted);
  }
  if (!picked.length) {
    $('dlNote').textContent = 'Эти треки недоступны для воспроизведения.';
    return;
  }
  if (picked.length < keys.length) {
    $('dlNote').textContent = `Пропущено недоступных: ${keys.length - picked.length}.`;
  }
  const r = await send<{ ok: boolean; streams: Record<string, { url: string }> }>({
    t: 'P_RESOLVE',
    keys: picked.map((t) => t.key),
  });
  const tracks = picked
    .map((t) => {
      const s = r.streams[t.key];
      return s
        ? {
            key: t.key,
            id: t.nativeId.split('_')[1] ?? t.nativeId,
            owner: t.nativeId.split('_')[0] ?? '0',
            artist: t.artist,
            title: t.title,
            url: s.url,
            duration: t.duration,
            cover: t.cover,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!tracks.length) {
    $('dlNote').textContent = 'Не удалось получить ссылки для воспроизведения.';
    return;
  }
  const res = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_LIST',
    key: startKey ?? tracks[0]!.key,
    tracks,
  });
  pState = res.state;
  renderPlayer();
  if (!$('queuePanel').hidden) renderQueue();
}

let pState: PlayerState | null = null;
/** True while the user drags the seek bar, so polling does not fight them. */
let seeking = false;
/** Last known equalizer curve, so the panel can render before a track plays. */
let pEqGains: number[] | null = null;

/**
 * Show play or pause on the main transport button.
 *
 * The button holds an <svg><use href="#i-…">, so assigning textContent would
 * delete the icon and leave a raw glyph in its place.
 */
function setPlayIcon(playing: boolean): void {
  const use = $btn('pToggle').querySelector('use');
  use?.setAttribute('href', playing ? '#i-pause' : '#i-play');
}

/** Clock for the transport. Past an hour the minutes field would read "96:02",
 *  which looks like a typo, so long tracks get an hours field. */
const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

function renderEqBands(bands: EqBand[]): void {
  const host = $('eqBands');
  if (host.children.length !== bands.length) {
    host.innerHTML = bands
      .map(
        (b) =>
          `<div class="band"><span class="db" data-db="${b.hz}">0</span>` +
          `<input type="range" min="-12" max="12" step="1" value="0" data-hz="${b.hz}" />` +
          `<span class="hz">${b.hz >= 1000 ? b.hz / 1000 + 'k' : b.hz}</span></div>`,
      )
      .join('');
  }
  for (const b of bands) {
    const input = host.querySelector<HTMLInputElement>(`input[data-hz="${b.hz}"]`);
    const label = host.querySelector<HTMLElement>(`[data-db="${b.hz}"]`);
    if (input && !input.matches(':active')) input.value = String(b.gain);
    if (label) label.textContent = String(Math.round(b.gain));
  }
}

function renderPlayer(): void {
  const s = pState;
  const cover = $('pCover');
  if (!s || !s.track) {
    $('pTitle').textContent = 'Ничего не играет';
    $('pArtist').textContent = '';
    cover.style.backgroundImage = '';
    setPlayIcon(false);
    // Bands are a property of the player, not of the current track, so the
    // equalizer must still be usable with nothing playing.
    if (s) {
      if (document.activeElement !== $in('eqOn')) $in('eqOn').checked = s.eqEnabled;
      renderEqBands(s.eqBands);
    } else if (pEqGains) {
      // Nothing playing yet, but the saved curve is known: draw it so the panel
      // is usable as soon as it opens.
      renderEqBands(pEqGains.map((gain, i) => ({ hz: EQ_BANDS[i] ?? 0, gain })));
    }
    return;
  }
  $('pTitle').textContent = s.track.title || '—';
  $('pArtist').textContent = s.track.artist || '';
  cover.style.backgroundImage = s.track.cover ? `url('${s.track.cover}')` : '';
  const toggle = $btn('pToggle');
  setPlayIcon(s.playing);
  toggle.classList.toggle('playing', s.playing);
  $('pTime').textContent = fmtTime(s.currentTime);
  $('pDur').textContent = fmtTime(s.duration);
  if (!seeking) {
    $in('pSeek').value = s.duration > 0 ? String(Math.round((s.currentTime / s.duration) * 1000)) : '0';
  }
  const vol = $in('pVolume');
  if (document.activeElement !== vol) vol.value = String(Math.round(s.volume * 100));
  // Silence while a track plays is indistinguishable from a broken player, so
  // the bar states it explicitly.
  vol.classList.toggle('muted', s.volume === 0);
  vol.title = s.volume === 0 ? 'Звук выключен' : `Громкость ${Math.round(s.volume * 100)}%`;
  const eqOn = $in('eqOn');
  if (document.activeElement !== eqOn) eqOn.checked = s.eqEnabled;
  renderEqBands(s.eqBands);
  // The level is a ring around the artwork: the loudest thing on screen should
  // be the music itself. It scales a pseudo-element rather than the artwork.
  const level = Math.min(1, Math.max(0, s.level ?? 0));
  $('pLevel').style.setProperty('--lvl', level.toFixed(3));
  // Per-channel meters: a collapsed stereo image is otherwise invisible.
  const lv = s.levels ?? [level, level];
  $('pMeterL').style.setProperty('--v', Math.min(1, Math.max(0, lv[0])).toFixed(3));
  $('pMeterR').style.setProperty('--v', Math.min(1, Math.max(0, lv[1])).toFixed(3));
  $('pClip').hidden = !s.clipped;
  if (!$('fxPanel').hidden) {
    drawSpectrum();
    renderReadout();
  }
  // Repaint the queue only while it is visible: a hidden panel costs nothing.
  if (!$('queuePanel').hidden && !dragFrom) renderQueue();
}

async function refreshPlayer(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'GET_PLAYER_STATE' });
    pState = r.state;
  } catch {
    /* keep the last snapshot */
  }
  renderPlayer();
}



/* ---------------- Player bar controls ---------------- */

$('pToggle').addEventListener('click', async () => {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_TOGGLE' });
  pState = r.state;
  renderPlayer();
});
$('pNext').addEventListener('click', async () => {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_NEXT' });
  pState = r.state;
  renderPlayer();
});
$('pPrev').addEventListener('click', async () => {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_PREV' });
  pState = r.state;
  renderPlayer();
});

$('pSeek').addEventListener('input', () => {
  seeking = true;
});
$('pSeek').addEventListener('change', async (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  const d = pState?.duration ?? 0;
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_SEEK',
    seconds: d > 0 ? (v / 1000) * d : 0,
  });
  pState = r.state;
  seeking = false;
  renderPlayer();
});

let volTimer: ReturnType<typeof setTimeout> | null = null;
$('pVolume').addEventListener('input', (e) => {
  // Dragging fires continuously; coalesce so the player is not flooded.
  const volume = Number((e.target as HTMLInputElement).value) / 100;
  if (volTimer) clearTimeout(volTimer);
  volTimer = setTimeout(() => void send({ t: 'PLAY_VOLUME', volume }), 120);
});

/** Like/dislike the playing track. VK's own library is the target. */
$('pLike').addEventListener('click', async () => {
  const t = pState?.track;
  if (!t) return;
  const key = `${t.owner}_${t.id}`;
  const track = listTracks.find((x) => x.key === key) ?? {
    key,
    platform: 'vk' as const,
    nativeId: key,
    artist: t.artist,
    title: t.title,
    album: '',
    duration: t.duration,
    cover: t.cover,
    restricted: false,
  };
  try {
    const r = await send<{ ok: boolean; reason?: string }>({ t: 'P_LIKE', key, liked: true, track });
    $('pLike').classList.toggle('liked', !!r.ok);
    if (!r.ok) $('dlNote').textContent = r.reason || 'не удалось добавить в «Мою музыку»';
  } catch (e) {
    $('dlNote').textContent = 'Ошибка: ' + ((e as Error).message || e);
  }
});

$('pDislike').addEventListener('click', async () => {
  const t = pState?.track;
  if (!t) return;
  await send({ t: 'TOGGLE_DISLIKE', owner: t.owner, id: t.id });
  $('pDislike').classList.toggle('liked');
});

/* ---------------- Sound panel ---------------- */

/**
 * Sound processing controls.
 *
 * Every change is sent as a partial patch, so the worker keeps one merged
 * `AudioFx` and a control that is never touched keeps its stored value.
 */
async function pushFx(patch: Record<string, unknown>): Promise<void> {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_FX',
    fx: patch as never,
  });
  pState = r.state;
  renderPlayer();
}

function renderFxPanel(): void {
  // The panel reflects the stored settings, not the player's copy, so it is
  // correct before anything has played.
  void (async () => {
    const st = await send<StateSnapshot | null>({ t: 'GET_STATE' });
    const fx = { ...DEFAULT_AUDIO_FX, ...(st?.settings?.audioFx ?? {}) };
    $sel('fxNormMode').value = fx.normalize;
    $in('fxNight').checked = fx.nightMode;
    $in('fxNightAmount').value = String(Math.round(fx.nightAmount * 100));
    $('fxNightVal').textContent = String(Math.round(fx.nightAmount * 100));
    $in('fxBass').value = String(fx.bassDb);
    $('fxBassVal').textContent = String(fx.bassDb);
    $in('fxPreamp').value = String(fx.preampDb);
    $('fxPreampVal').textContent = String(fx.preampDb);
    $in('fxCross').value = String(fx.crossfadeSec);
    $('fxCrossVal').textContent = fx.crossfadeSec ? `${fx.crossfadeSec} с` : 'выкл';
    await refreshDevices(st?.settings?.outputDeviceId ?? '');
  })();
}

async function refreshDevices(selected: string): Promise<void> {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'GET_DEVICES' });
  pState = r.state ?? pState;
  const list = pState?.outputDevices ?? [];
  const sel = $sel('fxOutput');
  // Device labels are empty until the page has audio permission, so a plain
  // "Системный" entry plus whatever Chrome exposes is all that can be shown.
  sel.innerHTML =
    '<option value="">Системный (по умолчанию)</option>' +
    list.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}</option>`).join('');
  sel.value = selected;
}

$('pFx').addEventListener('click', () => {
  const panel = $('fxPanel');
  panel.hidden = !panel.hidden;
  // Frames are only streamed while the panel is open: pushing twenty a second
  // to a hidden canvas would wake the popup for nothing.
  void send({ t: 'PLAY_SPECTRUM', on: !panel.hidden });
  if (!panel.hidden) {
    $('queuePanel').hidden = true;
    $('eqPanel').hidden = true;
    renderFxPanel();
  }
});
$('fxClose').addEventListener('click', () => {
  $('fxPanel').hidden = true;
  void send({ t: 'PLAY_SPECTRUM', on: false });
});
// A closed popup must not leave the stream running.
window.addEventListener('pagehide', () => void send({ t: 'PLAY_SPECTRUM', on: false }));

$sel('fxNormMode').addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value as 'off' | 'track' | 'album';
  void pushFx({ normalize: mode });
});
$('fxNight').addEventListener('change', (e) =>
  void pushFx({ nightMode: (e.target as HTMLInputElement).checked }),
);
$('fxNightAmount').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('fxNightVal').textContent = String(v);
});
$('fxNightAmount').addEventListener('change', (e) =>
  void pushFx({ nightAmount: Number((e.target as HTMLInputElement).value) / 100 }),
);
$('fxBass').addEventListener('input', (e) => {
  $('fxBassVal').textContent = String((e.target as HTMLInputElement).value);
});
$('fxBass').addEventListener('change', (e) =>
  void pushFx({ bassDb: Number((e.target as HTMLInputElement).value) }),
);
$('fxPreamp').addEventListener('input', (e) => {
  $('fxPreampVal').textContent = String((e.target as HTMLInputElement).value);
});
$('fxPreamp').addEventListener('change', (e) =>
  void pushFx({ preampDb: Number((e.target as HTMLInputElement).value) }),
);
$('fxCross').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('fxCrossVal').textContent = v ? `${v} с` : 'выкл';
});
$('fxCross').addEventListener('change', (e) =>
  void pushFx({ crossfadeSec: Number((e.target as HTMLInputElement).value) }),
);
$sel('fxOutput').addEventListener('change', async (e) => {
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_OUTPUT',
    deviceId: (e.target as HTMLSelectElement).value,
  });
  pState = r.state;
});
$('fxReset').addEventListener('click', async () => {
  await pushFx({ ...DEFAULT_AUDIO_FX });
  renderFxPanel();
});

/* ---------------- Spectrum ----------------
   Drawn from frames the offscreen document pushes, so the analysis happens
   where the audio is and the popup only paints. */

let spectrumFrame: { left: number[]; right: number[] } | null = null;

function drawSpectrum(): void {
  const canvas = document.getElementById('fxCanvas') as HTMLCanvasElement | null;
  if (!canvas || !spectrumFrame) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const bands = spectrumFrame.left.length;
  const barW = w / bands;
  for (let i = 0; i < bands; i++) {
    const l = spectrumFrame.left[i] ?? 0;
    const r = spectrumFrame.right[i] ?? 0;
    // Left grows up from the middle, right grows down: the stereo picture is
    // readable at a glance, which a stacked pair of bars is not.
    const half = h / 2;
    ctx.fillStyle = `rgba(244,244,245,${0.35 + l * 0.65})`;
    ctx.fillRect(i * barW, half - l * half * 0.94, Math.max(1, barW - 1), l * half * 0.94);
    ctx.fillStyle = `rgba(244,244,245,${0.22 + r * 0.5})`;
    ctx.fillRect(i * barW, half, Math.max(1, barW - 1), r * half * 0.94);
  }
  // Centre line: the reference the two halves are read against.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, h / 2 - 0.5, w, 1);
}

function renderReadout(): void {
  const el = $('fxReadout');
  const p = pState;
  if (!p) return;
  const parts: string[] = [];
  if (p.trackLufs !== null && p.trackLufs !== undefined) parts.push(`${p.trackLufs.toFixed(1)} LUFS`);
  if (p.trackPeakDb !== null && p.trackPeakDb !== undefined) parts.push(`пик ${p.trackPeakDb.toFixed(1)} дБ`);
  if (p.trackLufs !== null && p.trackPeakDb !== null && p.trackLufs !== undefined && p.trackPeakDb !== undefined) {
    parts.push(`DR ${(p.trackPeakDb - p.trackLufs).toFixed(1)} дБ`);
  }
  if (p.albumLufs !== null && p.albumLufs !== undefined) parts.push(`альбом ${p.albumLufs.toFixed(1)} LUFS`);
  if (p.normGainDb) parts.push(`коррекция ${p.normGainDb > 0 ? '+' : ''}${p.normGainDb.toFixed(1)} дБ`);
  el.textContent = parts.length ? parts.join('  ·  ') : 'Трек ещё не измерен — слушаю…';
}

/* ---------------- Queue panel ---------------- */

/**
 * The queue panel renders the play order, not the raw list, so what the user
 * sees is exactly what will play next.
 *
 * Dragging reorders the underlying list (`P_MOVE`) rather than the order array,
 * and the player translates that through the shuffle: a drag stays meaningful
 * even while shuffled.
 */
let dragFrom: number | null = null;

function renderQueue(): void {
  const st = pState;
  const list = $('qItems');
  const empty = $('qEmpty');
  if (!st || !st.queue?.length) {
    list.innerHTML = '';
    empty.hidden = false;
    $btn('qShuffle').classList.remove('on');
    return;
  }
  empty.hidden = true;
  $btn('qShuffle').classList.toggle('on', !!st.shuffle);
  const repeat = st.repeat ?? 'off';
  const rbtn = $btn('qRepeat');
  rbtn.classList.toggle('on', repeat !== 'off');
  $('qRepeatOne').hidden = repeat !== 'one';
  rbtn.title = repeat === 'off' ? 'Повтор выключен' : repeat === 'all' ? 'Повтор всей очереди' : 'Повтор одного трека';

  const currentQueueIndex = st.order?.[st.index] ?? -1;
  // Render in play order; each row knows both its order slot and its list slot.
  list.innerHTML = (st.order ?? []).map((qi, slot) => {
    const t = st.queue[qi];
    if (!t) return '';
    const cur = qi === currentQueueIndex;
    return (
      `<li class="q-item${cur ? ' cur' : ''}" draggable="true" data-slot="${slot}" data-qi="${qi}" style="--i:${slot}">` +
      `<span class="q-grip"><svg class="ic"><use href="#i-grip"/></svg></span>` +
      `<span class="q-cover"${t.cover ? ` style="background-image:url('${escapeHtml(t.cover)}')"` : ''}></span>` +
      `<span class="t-body"><b>${escapeHtml(t.title || '—')}</b><span>${escapeHtml(t.artist)}</span></span>` +
      `<span class="t-dur">${fmtDur(t.duration)}</span>` +
      `<button class="mini q-remove" data-remove="${qi}" title="Убрать"><svg class="ic"><use href="#i-cross"/></svg></button>` +
      '</li>'
    );
  }).join('');
}

$('pQueue').addEventListener('click', () => {
  const panel = $('queuePanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('eqPanel').hidden = true;
    if (!$('fxPanel').hidden) {
      $('fxPanel').hidden = true;
      void send({ t: 'PLAY_SPECTRUM', on: false });
    }
    renderQueue();
  }
});
$('qClose').addEventListener('click', () => ($('queuePanel').hidden = true));

$('qShuffle').addEventListener('click', async () => {
  const on = !pState?.shuffle;
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_SHUFFLE', on });
  pState = r.state;
  renderQueue();
});
$('qRepeat').addEventListener('click', async () => {
  const cur = pState?.repeat ?? 'off';
  const mode = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_REPEAT', mode });
  pState = r.state;
  renderQueue();
});

$('qItems').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  const rm = el.closest('[data-remove]') as HTMLElement | null;
  if (rm) {
    const r = await send<{ ok: boolean; state: PlayerState | null }>({
      t: 'PLAY_REMOVE',
      index: Number(rm.dataset.remove),
    });
    pState = r.state;
    renderQueue();
    renderPlayer();
    return;
  }
  const row = el.closest('.q-item') as HTMLElement | null;
  if (!row) return;
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_JUMP',
    index: Number(row.dataset.slot),
  });
  pState = r.state;
  renderQueue();
  renderPlayer();
});

// Drag to reorder. The drag carries the LIST index, because that is what the
// player moves; the drop target's list index is read from the same data.
$('qItems').addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest('.q-item') as HTMLElement | null;
  if (!row) return;
  dragFrom = Number(row.dataset.slot);
  row.classList.add('dragging');
  e.dataTransfer?.setData('text/plain', String(dragFrom));
});
$('qItems').addEventListener('dragend', () => {
  dragFrom = null;
  $('qItems').querySelectorAll('.q-item').forEach((r) => r.classList.remove('dragging', 'drop-above'));
});
$('qItems').addEventListener('dragover', (e) => {
  const row = (e.target as HTMLElement).closest('.q-item') as HTMLElement | null;
  if (!row || dragFrom === null) return;
  e.preventDefault();
  $('qItems').querySelectorAll('.q-item').forEach((r) => r.classList.remove('drop-above'));
  row.classList.add('drop-above');
});
$('qItems').addEventListener('drop', async (e) => {
  const row = (e.target as HTMLElement).closest('.q-item') as HTMLElement | null;
  if (!row || dragFrom === null) return;
  e.preventDefault();
  const to = Number(row.dataset.slot);
  const from = dragFrom;
  dragFrom = null;
  if (from === to) return;
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'PLAY_MOVE', from, to });
  pState = r.state;
  renderQueue();
});

/* ---------------- Equalizer overlay ---------------- */

$('pEq').addEventListener('click', () => {
  const panel = $('eqPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('queuePanel').hidden = true;
    if (!$('fxPanel').hidden) {
      $('fxPanel').hidden = true;
      void send({ t: 'PLAY_SPECTRUM', on: false });
    }
  }
});

$('eqOn').addEventListener('change', async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  const gains = (pState?.eqBands ?? []).map((b) => b.gain);
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'EQ_SET', enabled, gains });
  pState = r.state;
  renderPlayer();
});

$('eqBands').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.tagName !== 'INPUT') return;
  const label = $('eqBands').querySelector<HTMLElement>(`[data-db="${el.dataset.hz}"]`);
  if (label) label.textContent = el.value;
});
$('eqBands').addEventListener('change', async () => {
  const gains = [...$('eqBands').querySelectorAll<HTMLInputElement>('input[data-hz]')].map((i) => Number(i.value));
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'EQ_SET', enabled: true, gains });
  pState = r.state;
  renderPlayer();
});

$('eqReset').addEventListener('click', async () => {
  const gains = (pState?.eqBands ?? []).map(() => 0);
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'EQ_SET', enabled: true, gains });
  pState = r.state;
  renderPlayer();
});

/** Named equalizer presets, kept in storage so they survive a restart. */
async function refreshPresets(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; presets: Record<string, number[]> }>({ t: 'GET_PRESETS' });
    $sel('eqPreset').innerHTML =
      '<option value="">— пресеты —</option>' +
      Object.keys(r.presets).map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  } catch {
    /* presets are optional */
  }
}

$sel('eqPreset').addEventListener('change', async (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (!name) return;
  const r = await send<{ ok: boolean; state: PlayerState | null }>({ t: 'APPLY_PRESET', name });
  pState = r.state;
  renderPlayer();
});

$('eqSave').addEventListener('click', async () => {
  const name = prompt('Название пресета');
  if (!name) return;
  const gains = (pState?.eqBands ?? []).map((b) => b.gain);
  await send({ t: 'SAVE_PRESET', name, gains });
  await refreshPresets();
});

/* ---------------- Download selection ---------------- */

/**
 * Two independent selections feed the download button:
 *  - `ticked` — individual tracks picked in any list (my music, search, radio,
 *    catalogue, an opened playlist);
 *  - `selected` — whole playlists collected by the page scanner.
 *
 * They are queued through different paths because a scanned playlist is the
 * downloader's own catalog, while a ticked track arrives as a Track and needs
 * the platform to convert it into a catalog entry first.
 */
async function queueTicked(): Promise<number> {
  const picked = listTracks.filter((t) => ticked.has(t.key));
  if (!picked.length) return 0;
  // Label the folder after the open playlist when there is one, so a download
  // from inside a playlist lands under that playlist's name.
  const name = $in('scanName').value.trim() || 'Загрузки';
  const r = await send<{ ok: boolean; queued: number; skipped: number; reason?: string }>({
    t: 'P_ENQUEUE',
    tracks: picked,
    name,
  });
  if (!r?.ok) {
    $('dlNote').textContent = r?.reason || 'не удалось поставить в очередь';
    return 0;
  }
  $('dlNote').textContent = r.skipped
    ? `В очередь: ${r.queued}. Пропущено недоступных: ${r.skipped}.`
    : `В очередь: ${r.queued}.`;
  return r.queued;
}

$('btnAll').addEventListener('click', () => {
  // Scan results and ticked tracks are separate: this button belongs to the
  // scanner block, so it selects playlists, and the track lists have their own
  // "выбрать всё" behaviour below.
  Object.keys(state?.playlists ?? {}).forEach((n) => selected.add(n));
  render();
});
$('btnNone').addEventListener('click', () => {
  selected.clear();
  ticked.clear();
  render();
  if (listTracks.length) renderTracks(lastListTarget);
});
$('btnDownload').addEventListener('click', async () => {
  showView('downloads');
  const fromTracks = await queueTicked();
  let fromPlaylists = 0;
  if (selected.size) {
    const r = await send<{ queued: number; skipped: number }>({ t: 'ENQUEUE', names: [...selected] });
    fromPlaylists = r?.queued ?? 0;
    if (!fromTracks && r?.skipped) {
      $('dlNote').textContent =
        `Пропущено без ссылки: ${r.skipped}. Проиграй эти треки в плеере, чтобы получить ссылку, и повтори.`;
    } else if (!fromTracks) {
      $('dlNote').textContent = `В очередь: ${r?.queued ?? 0}`;
    }
    selected.clear();
  }
  if (!fromTracks && !fromPlaylists) {
    $('dlNote').textContent = 'Нечего скачивать: отметь треки галочками или плейлист ниже.';
  }
  refresh();
});
$('btnRetry').addEventListener('click', () => void send({ t: 'RETRY_FAILED' }));
$('btnPause').addEventListener('click', () => void send({ t: 'PAUSE' }));
$('btnResume').addEventListener('click', () => void send({ t: 'RESUME' }));
$('btnCancel').addEventListener('click', () => void send({ t: 'CANCEL' }));
$('btnReset').addEventListener('click', async () => {
  if (confirm('Удалить весь собранный каталог?')) {
    await send({ t: 'RESET' });
    selected.clear();
    void refresh();
  }
});
$('conc').addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  $('concVal').textContent = target.value;
  void send({ t: 'SETTINGS', patch: { conc: +target.value } });
});
$('gap').addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  void send({ t: 'SETTINGS', patch: { gapMs: +target.value } });
});
$('baseDir').addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  const v = target.value.trim() || 'VK Music';
  $('pathExample').textContent =
    'Загрузки/' + v.split(/[\\/]+/).filter(Boolean).join('/') + '/<плейлист>/01 Artist - Title.mp3';
  void send({ t: 'SETTINGS', patch: { baseDir: v } });
});

/* ---------------- Home ---------------- */

async function loadHome(): Promise<void> {
  // The home shelf mirrors what VK itself puts first: the account's own music.
  await loadList('my-tracks', undefined, 'homeTracks');
  const playable = listTracks.filter((t) => !t.restricted);
  const head = playable[0];
  // One dominant artwork, the way the reference lays out its hero: the cover
  // carries the page and the text stays subordinate to it.
  $('homeHero').innerHTML = head
    ? `<div class="feat-art"${head.cover ? ` style="background-image:url('${escapeHtml(head.cover)}')"` : ''}>` +
      `<button class="feat-play" data-play="${escapeHtml(head.key)}" aria-label="Играть">` +
      `<svg class="ic"><use href="#i-play"/></svg></button></div>` +
      `<div class="feat-body">` +
      `<span class="feat-kicker">Продолжить слушать</span>` +
      `<h2 class="feat-title">${escapeHtml(head.title)}</h2>` +
      `<p class="feat-artist">${escapeHtml(head.artist)}</p>` +
      `<div class="feat-meta mono">${fmtDur(head.duration) || '—'} · ${escapeHtml(head.album || 'ВКонтакте')}</div>` +
      `</div>`
    : '';
  $('homeCount').textContent = listTracks.length
    ? `${listTracks.length} треков` + (playable.length < listTracks.length ? ` · ${playable.length} играбельных` : '')
    : '';
  $('homeHero').addEventListener('click', (e) => {
    const hero = (e.target as HTMLElement).closest('[data-play]') as HTMLElement | null;
    const key = hero?.dataset.play;
    if (key) void playTracks([key], key);
  });
}

async function openView(name: string): Promise<void> {
  showView(name);
  if (name === 'home') await loadHome();
  if (name === 'explore') await loadList('sections', undefined, 'exploreTracks');
}

/* ---------------- Keyboard ---------------- */

/**
 * Transport shortcuts, active while the popup has focus.
 *
 * Keys are ignored while typing and while a range slider is focused, otherwise
 * a space in the search box or an arrow on the seek bar would jump tracks.
 */
chrome.runtime.onMessage.addListener((m: unknown) => {
  const msg = m as { t?: string; left?: number[]; right?: number[] };
  if (msg?.t === 'SPECTRUM' && msg.left && msg.right) {
    spectrumFrame = { left: msg.left, right: msg.right };
    if (!$('fxPanel').hidden) drawSpectrum();
  }
  return false;
});

document.addEventListener('keydown', async (e) => {
  const el = document.activeElement as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) {
    // Only the seek/volume sliders swallow arrows; text fields keep their keys.
    if (!(tag === 'INPUT' && (el as HTMLInputElement).type === 'range')) return;
  }
  const isRange = tag === 'INPUT' && (el as HTMLInputElement).type === 'range';
  switch (e.key) {
    case ' ':
      if (isRange) return;
      e.preventDefault();
      $btn('pToggle').click();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) $btn('pNext').click();
      else await send({ t: 'PLAY_SEEK', seconds: (pState?.currentTime ?? 0) + 10 });
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) $btn('pPrev').click();
      else await send({ t: 'PLAY_SEEK', seconds: Math.max(0, (pState?.currentTime ?? 0) - 10) });
      break;
    case 's':
    case 'S':
    case 'ы':
      $btn('qShuffle').click();
      break;
    case 'r':
    case 'R':
    case 'к':
      $btn('qRepeat').click();
      break;
    case 'q':
    case 'Q':
    case 'й':
      $btn('pQueue').click();
      break;
    default:
      return;
  }
  void refreshPlayer();
});

/* ---------------- Init ---------------- */

void (async function init() {
  try {
    const s = await send<StateSnapshot | null>({ t: 'GET_STATE' });
    if (s && s.settings) {
      $in('conc').value = String(s.settings.conc);
      $('concVal').textContent = String(s.settings.conc);
      $in('gap').value = String(s.settings.gapMs);
      $in('baseDir').value = s.settings.baseDir || 'VK Music';
      $('pathExample').textContent =
        'Загрузки/' + ($in('baseDir').value || 'VK Music') + '/<плейлист>/01 Artist - Title.mp3';
      // Show the saved volume straight away; without this the slider reads 100%
      // until the offscreen player reports its state.
      if (typeof s.settings.playerVolume === 'number') {
        $in('pVolume').value = String(Math.round(s.settings.playerVolume * 100));
      }
      if (s.settings.playerEqGains?.length) {
        pEqGains = s.settings.playerEqGains.slice();
      }
    }
  } catch {
    /* state may be unavailable */
  }
  await refreshPlatforms();
  void refreshPlatformAuth();
  void refreshStorage();
  void refresh();
  void refreshProxy();
  void refreshDnr();
  void refreshPlayer();
  void refreshRules();
  void refreshLastfm();
  void refreshPresets();
  void loadHome();
  setInterval(refresh, 800);
  // Progress lives in the offscreen document, so poll it on its own cadence.
  setInterval(() => void refreshPlayer(), 700);
})();

/* ---------------- Phase 1 slice A: storage (FSA) ---------------- */

function renderStorage(): void {
  const el = $('dirState');
  if (!storageState) {
    el.textContent = 'Статус хранилища недоступен.';
    return;
  }
  const s = storageState;
  $sel('storageMode').value = s.mode;
  const permText: Record<StorageStateResult['permission'], string> = {
    granted: 'доступ разрешён',
    prompt: 'нужно подтверждение — открой расширения и разреши',
    denied: 'доступ запрещён',
    none: 'папка не выбрана',
  };
  const modeText = s.mode === 'fsa' ? 'выбранная папка' : '«Загрузки»';
  el.textContent = `Режим: ${modeText} · Папка: ${s.rootName ?? '—'} · ${permText[s.permission]}`;
}

async function refreshStorage(): Promise<void> {
  try {
    storageState = await send<StorageStateResult>({ t: 'GET_STORAGE_STATE' });
  } catch {
    storageState = null;
  }
  renderStorage();
}

// Both of these were dropped when this file was rebuilt, which left the mode
// dropdown and the reset button doing nothing at all.
$('storageMode').addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value === 'fsa' ? 'fsa' : 'downloads';
  void (async () => {
    await send({ t: 'SETTINGS', patch: { storageMode: mode } });
    await refreshStorage();
  })();
});

$('btnClearDir').addEventListener('click', async () => {
  try {
    storageState = await send<StorageStateResult>({ t: 'CLEAR_DIR' });
  } catch {
    /* keep the last view */
  }
  renderStorage();
});

// Must run from a click handler: showDirectoryPicker() requires a user gesture.
$('btnPickDir').addEventListener('click', async () => {
  const el = $('dirState');
  el.textContent = 'Открываю выбор папки…';
  try {
    const handle = await pickDirectory();
    await persistRootHandle(handle);
    storageState = await send<StorageStateResult>({
      t: 'PICK_DIR_RESULT',
      ok: true,
      rootName: handle.name,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    el.textContent = /abort/i.test(msg) ? 'Выбор папки отменён.' : 'Ошибка: ' + msg;
    void refreshStorage();
  }
  renderStorage();
});

/* ---------------- Wave 1: proxy for VK ---------------- */

let proxyState: ProxyStateResult | null = null;

function proxyRowHtml(e: ProxyEntry): string {
  const used = proxyState?.settings.activeId === e.id || (!proxyState?.settings.activeId && e.enabled);
  const stamp = e.lastCheckTs
    ? new Date(e.lastCheckTs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : null;
  const status = e.lastCheckOk === null || e.lastCheckOk === undefined
    ? ''
    : e.lastCheckOk
      ? '<span class="ok">доступен</span>'
      : '<span class="bad">недоступен</span>';
  return (
    `<li data-id="${e.id}"${used ? ' class="cur"' : ''}>` +
    `<b>${escapeHtml(e.label || e.host)}</b> ` +
    `<span class="mono">${escapeHtml(e.scheme)}://${escapeHtml(e.host)}:${e.port}</span> ` +
    `${e.username ? '<span class="muted">с логином</span> ' : ''}${status}` +
    `${stamp ? ` <span class="muted">· ${stamp}</span>` : ''}` +
    `<button data-act="use" data-id="${e.id}">${used ? 'активен' : 'использовать'}</button>` +
    `<button data-act="del" data-id="${e.id}">удалить</button>` +
    '</li>'
  );
}


function renderProxy(): void {
  if (!proxyState) return;
  const s = proxyState.settings;
  ($('proxyMode') as HTMLSelectElement).value = s.mode;
  const a = proxyState.applied;
  $('proxyApplied').textContent = a.error
    ? 'Прокси не применён: ' + a.error
    : s.mode === 'off'
      ? 'Прокси выключен — прямое соединение.'
      : `${s.mode === 'vk-only' ? 'Только VK' : 'Весь браузер'} → ${a.proxyFor ?? '—'}`;

  $('proxyList').innerHTML = s.entries.length
    ? s.entries.map(proxyRowHtml).join('')
    : '<li class="muted">Прокси не добавлены. Без них VK недоступен из-за рубежа напрямую.</li>';
}

async function refreshProxy(): Promise<void> {
  try {
    proxyState = await send<ProxyStateResult>({ t: 'GET_PROXY_STATE' });
  } catch {
    proxyState = null;
  }
  renderProxy();
}

async function refreshDnr(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; ids: number[]; rules: number; error: string | null }>({
      t: 'GET_DNR_STATE',
    });
    const text = r.error
      ? 'Правила недоступны: ' + r.error
      : `Установлено правил: ${r.ids.length} (Origin-спуф, Genius, снятие фрейм-запретов).`;
    $('dnrState').textContent = text;
    $('dnrState').dataset.text = text;
  } catch {
    $('dnrState').textContent = 'Не удалось прочитать состояние правил.';
  }
}

$('proxyMode').addEventListener('change', async (e) => {
  const mode = (e.target as HTMLSelectElement).value as ProxyRoutingMode;
  proxyState = await send<ProxyStateResult>({ t: 'SET_PROXY_MODE', mode });
  renderProxy();
});

$('proxyList').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (!act || !id || !proxyState) return;
  if (act === 'use') {
    proxyState = await send<ProxyStateResult>({ t: 'SET_PROXY_ACTIVE', id });
  } else if (act === 'del') {
    const entries = proxyState.settings.entries.filter((x) => x.id !== id);
    proxyState = await send<ProxyStateResult>({ t: 'SET_PROXY_ENTRIES', entries });
  }
  renderProxy();
});

$('btnProxyAdd').addEventListener('click', async () => {
  const raw = prompt('Прокси (scheme://host:port), например socks5://1.2.3.4:1080');
  if (!raw) return;
  let parsed: URL;
  try {
    parsed = new URL(raw.includes('://') ? raw : 'http://' + raw);
  } catch {
    alert('Не похоже на адрес прокси.');
    return;
  }
  const scheme = (parsed.protocol.replace(':', '') || 'http') as ProxyEntry['scheme'];
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) {
    alert('Поддерживаются http, https, socks4, socks5.');
    return;
  }
  const user = prompt('Логин (оставь пустым, если не нужен)') ?? '';
  const pass = user ? (prompt('Пароль') ?? '') : '';
  const entry: ProxyEntry = {
    id: crypto.randomUUID(),
    label: parsed.hostname + ':' + parsed.port,
    scheme,
    host: parsed.hostname,
    port: Number(parsed.port) || (scheme.startsWith('socks') ? 1080 : 8080),
    username: user || undefined,
    password: pass || undefined,
    enabled: true,
    lastCheckTs: null,
    lastCheckOk: null,
  };
  proxyState = await send<ProxyStateResult>({
    t: 'SET_PROXY_ENTRIES',
    entries: [...(proxyState?.settings.entries ?? []), entry],
  });
  renderProxy();
  void checkActiveProxy();
});

async function checkActiveProxy(): Promise<void> {
  const el = $('proxyApplied');
  const prev = el.textContent;
  el.textContent = 'Проверяю прокси…';
  try {
    const r = await send<ProxyCheckResult>({ t: 'CHECK_PROXY' });
    el.textContent = r.ok
      ? `Прокси отвечает (${r.latencyMs} мс, HTTP ${r.status}).`
      : `Прокси не отвечает: ${r.error ?? 'ошибка'}`;
  } catch {
    el.textContent = prev ?? '';
  }
  await refreshProxy();
}

$('btnProxyCheck').addEventListener('click', () => void checkActiveProxy());

$('btnDnrInstall').addEventListener('click', async () => {
  $('dnrState').textContent = 'Переустанавливаю правила…';
  await send({ t: 'INSTALL_DNR' });
  await refreshDnr();
});

/* ---------------- Wave 3: Last.fm ---------------- */

interface LastfmState {
  ok: boolean;
  auth: LastfmAuth;
  enabled: boolean;
  pending: number;
  authorizeUrl?: string | null;
  error?: string;
}

let lfAuthUrl: string | null = null;

async function refreshLastfm(): Promise<void> {
  try {
    const r = await send<LastfmState>({ t: 'GET_LASTFM' });
    const k = $in('lfApiKey');
    const s = $in('lfSecret');
    if (document.activeElement !== k) k.value = r.auth.apiKey;
    if (document.activeElement !== s) s.value = r.auth.secret;

    $('lfState').textContent = r.enabled
      ? `Подключён${r.auth.username ? ' как ' + r.auth.username : ''}.`
      : r.auth.apiKey && r.auth.secret
        ? 'Ключи сохранены. Нажми «Войти».'
        : 'Ключи не заданы.';

    lfAuthUrl = r.authorizeUrl ?? null;
    // "Готово" only appears once a token exists — that is the step that needs
    // the user to have visited Last.fm and approved it.
    $btn('btnLfDone').hidden = !r.enabled ? !lfAuthUrl : true;
    $btn('btnLfUnlink').hidden = !r.enabled;
    $btn('btnLfFlush').hidden = !r.enabled || r.pending === 0;

    $('lfPending').textContent = r.pending
      ? `Отложено скробблов: ${r.pending} (Last.fm был недоступен).`
      : '';
  } catch {
    /* keep the last view */
  }
}

$('btnLfSave').addEventListener('click', async () => {
  const r = await send<LastfmState>({
    t: 'SET_LASTFM',
    apiKey: $in('lfApiKey').value.trim(),
    secret: $in('lfSecret').value.trim(),
  });
  if (r.error) $('lfState').textContent = r.error;
  await refreshLastfm();
});

$('btnLfLogin').addEventListener('click', async () => {
  const r = await send<{ ok: boolean; url: string | null; error?: string }>({ t: 'LASTFM_GET_TOKEN' });
  if (!r.ok || !r.url) {
    $('lfState').textContent = r.error || 'Не удалось получить токен.';
    return;
  }
  // The user authorises on Last.fm, then returns and confirms with «Готово» —
  // an extension has no stable callback URL, so the flow is completed manually
  // rather than by redirect.
  window.open(r.url, '_blank');
  $('lfState').textContent = 'Открыл Last.fm. Авторизуй доступ и нажми «Готово».';
  await refreshLastfm();
});

$('btnLfDone').addEventListener('click', async () => {
  const r = await send<LastfmState>({ t: 'LASTFM_LINK' });
  $('lfState').textContent = r.enabled
    ? `Подключён${r.auth.username ? ' как ' + r.auth.username : ''}.`
    : r.error || 'Не удалось получить сессию. Повтори «Войти».';
  await refreshLastfm();
});

$('btnLfUnlink').addEventListener('click', async () => {
  await send({ t: 'LASTFM_UNLINK' });
  await refreshLastfm();
});

$('btnLfFlush').addEventListener('click', async () => {
  $('lfPending').textContent = 'Отправляю…';
  const r = await send<{ ok: boolean; sent: number; pending: number; error?: string }>({
    t: 'LASTFM_FLUSH',
  });
  $('lfPending').textContent = r.ok
    ? `Отправлено: ${r.sent}. Осталось: ${r.pending}.`
    : `Не удалось: ${r.error ?? 'ошибка'}. Осталось: ${r.pending}.`;
  await refreshLastfm();
});

async function refreshRules(): Promise<void> {
  try {
    const r = await send<{ ok: boolean; rules: BlockRules }>({ t: 'GET_BLOCK_RULES' });
    const el = $in('blockedArtists');
    if (document.activeElement !== el) el.value = r.rules.blockedArtists.join(', ');
    $('blockedState').textContent = r.rules.blockedArtists.length
      ? `Заблокировано артистов: ${r.rules.blockedArtists.length}. Дизлайков: ${r.rules.disliked.length}.`
      : 'Список пуст.';
  } catch {
    /* keep the last view */
  }
}

$('blockedArtists').addEventListener('change', async (e) => {
  const artists = (e.target as HTMLInputElement).value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await send({ t: 'SET_BLOCKED_ARTISTS', artists });
  await refreshRules();
});


/* ---------------- VK tab helpers (page scanning) ---------------- */

async function activeVkTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(\w+\.)?vk\.(com|ru)\//.test(tab.url || '')) return null;
  return tab;
}

async function ensureInjected(tabId: number | undefined): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId!, { cmd: 'PING' });
    return;
  } catch {
    /* collector not present yet */
  }
  // Resolve the bundled content-script paths from the built manifest so the
  // injection targets stay identical even after the bundler renames outputs.
  const manifest = chrome.runtime.getManifest();
  const contentScripts = manifest.content_scripts ?? [];
  const mainFile = contentScripts.find((cs) => (cs as { world?: string }).world === 'MAIN')?.js?.[0];
  const isoFile = contentScripts.find((cs) => !(cs as { world?: string }).world)?.js?.[0];
  if (mainFile) {
    await chrome.scripting.executeScript({ target: { tabId: tabId! }, world: 'MAIN', files: [mainFile] });
  }
  if (isoFile) {
    await chrome.scripting.executeScript({ target: { tabId: tabId! }, files: [isoFile] });
  }
}

/* ---------------- scan / library / downloads buttons ---------------- */

$('btnScan').addEventListener('click', async () => {
  const btn = $btn('btnScan');
  btn.disabled = true;
  $('scanResult').textContent = 'Сканирую… (не закрывай вкладку)';
  try {
    const tab = await activeVkTab();
    if (!tab) {
      $('scanResult').textContent = 'Открой вкладку vk.com / vk.ru и попробуй снова.';
      return;
    }
    await ensureInjected(tab.id);
    const res = (await chrome.tabs.sendMessage(tab.id!, {
      cmd: 'SCAN',
      name: $in('scanName').value.trim() || undefined,
    })) as ScanResult;
    if (res && res.error) throw new Error(res.error);
    const s = res.stats
      ? ` | сеть: ${res.stats.responses} отв. / ${res.stats.found} тр., скрипты: ${res.stats.embedded}`
      : '';
    $('scanResult').textContent = `Найдено: ${res.count} → «${res.name}»${s}`;
    if (!res.count) {
      $('scanResult').innerHTML =
        `Найдено 0. Пришли разработчику:<br>` +
        `1) F12 → Console → выполни <b>copy(JSON.stringify(__vkmfStats))</b><br>` +
        `2) F12 → Network → обнови страницу → найди ответ со словом "artist" и скопируй его`;
    } else {
      await refresh();
      showView('downloads');
    }
  } catch (e) {
    $('scanResult').textContent = 'Ошибка: ' + ((e as Error).message || e);
  } finally {
    btn.disabled = false;
  }
});

$('btnDiag').addEventListener('click', async () => {
  const btn = $btn('btnDiag');
  btn.disabled = true;
  $('diagResult').textContent = 'Собираю…';
  try {
    const tab = await activeVkTab();
    if (!tab) {
      $('diagResult').textContent = 'Открой вкладку vk.com / vk.ru.';
      return;
    }
    await ensureInjected(tab.id);
    const res = (await chrome.tabs.sendMessage(tab.id!, {
      cmd: 'SAMPLES',
    })) as { samples?: ResponseSample[] } | undefined;
    const samples = (res && res.samples) || [];
    if (!samples.length) {
      $('diagResult').textContent =
        'Ответов пока нет. Открой страницу плейлиста (не «Моя музыка»), подожди 2-3 сек и нажми снова.';
      return;
    }
    const text = samples
      .map((s) => 'URL: ' + s.url + '\nREQ: ' + s.req + '\n' + s.text)
      .join('\n\n=====\n\n');
    await navigator.clipboard.writeText(text);
    $('diagResult').textContent =
      `Скопировано ${samples.length} ответов (${Math.round(text.length / 1024)} КБ). Вставь их в чат.`;
  } catch (e) {
    $('diagResult').textContent = 'Ошибка: ' + ((e as Error).message || e);
  } finally {
    btn.disabled = false;
  }
});
