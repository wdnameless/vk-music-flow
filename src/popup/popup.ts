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
import { EQ_BANDS, PLATFORM_LABELS } from '../types.js';
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

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmtDur = (s: number | null): string =>
  typeof s === 'number' && s > 0
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : '';

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
  host.innerHTML = '<li class="muted">Загружаю…</li>';
  try {
    const r = await send<{ ok: boolean; tracks?: Track[]; playlists?: PlaylistRef[]; sections?: CatalogSection[]; reason?: string }>({
      t: 'P_LIST',
      platform: activePlatform,
      kind,
      id,
    });
    if (!r.ok) {
      host.innerHTML = `<li class="muted">${escapeHtml(r.reason || 'не удалось получить данные')}</li>`;
      return;
    }
    if (r.sections) {
      host.innerHTML = '';
      $('exploreSections').innerHTML = r.sections.length
        ? r.sections.map((s) => `<button class="chip" data-section="${escapeHtml(s.id)}">${escapeHtml(s.title)}</button>`).join('')
        : '<span class="muted">Разделов нет.</span>';
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
    host.innerHTML = '<li class="muted">Плейлистов нет.</li>';
    return;
  }
  host.innerHTML = items
    .map(
      (p) =>
        `<li class="pl" data-pl="${escapeHtml(p.key)}">` +
        `<div class="pl-cover"${p.cover ? ` style="background-image:url('${escapeHtml(p.cover)}')"` : ''}></div>` +
        `<div class="pl-body"><b>${escapeHtml(p.title)}</b>` +
        `<span class="tiny muted">${p.trackCount ?? '?'} треков</span></div></li>`,
    )
    .join('');
}

function trackRow(t: Track, opts: { tick?: boolean; play?: boolean } = {}): string {
  const isTicked = ticked.has(t.key);
  return (
    `<li data-key="${escapeHtml(t.key)}" class="track${t.restricted ? ' muted' : ''}">` +
    (opts.tick !== false
      ? `<input type="checkbox" data-tick="${escapeHtml(t.key)}"${isTicked ? ' checked' : ''}${t.restricted ? ' disabled' : ''}/>`
      : '') +
    `<div class="t-cover"${t.cover ? ` style="background-image:url('${escapeHtml(t.cover)}')"` : ''}></div>` +
    `<div class="t-body"><b>${escapeHtml(t.title || '—')}</b><span class="tiny muted">${escapeHtml(t.artist)}</span></div>` +
    `<span class="tiny muted t-dur">${fmtDur(t.duration)}</span>` +
    `${t.restricted ? ' <span class="bad">недоступен</span>' : `<button class="mini" data-play="${escapeHtml(t.key)}">▶</button>`}` +
    '</li>'
  );
}

function renderTracks(target: string): void {
  const host = $(target);
  if (!listTracks.length) {
    host.innerHTML = '<li class="muted">Пусто.</li>';
    return;
  }
  host.innerHTML = listTracks.map((t) => trackRow(t)).join('');
  updateCount();
}

function updateCount(): void {
  const el = $('libTotal');
  if (el) el.textContent = listTracks.length ? `${listTracks.length} треков, выбрано ${ticked.size}` : '';
  const dl = document.getElementById('btnDownload') as HTMLButtonElement | null;
  if (dl) dl.disabled = ticked.size === 0;
}

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
    if (playKey) await playTracks([playKey]);
    const plKey = (el.closest('.pl') as HTMLElement | null)?.dataset.pl;
    if (plKey) {
      // Opening a playlist replaces the platform list. The queue labels its
      // folder with the playlist title, so carry the human name over rather
      // than the opaque key.
      const title = el.closest('.pl')?.querySelector('b')?.textContent;
      await loadList('playlist', plKey, target);
      if (title) $in('scanName').value = title;
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
  if (!qShow.length) qList.innerHTML = '<li class="muted">Очередь пуста</li>';
  for (const q of qShow) {
    const li = document.createElement('li');
    li.textContent = `[${String(q.idx).padStart(2, '0')}] ${q.pl} — ${q.a ? q.a.artist + ' — ' + q.a.title : '?'}`;
    qList.appendChild(li);
  }

  const fList = $('fList');
  fList.innerHTML = '';
  const fShow = state.failed.slice(0, 30);
  if (!fShow.length) fList.innerHTML = '<li class="muted">Нет ошибок</li>';
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
      '<li class="muted">Плейлисты не собраны. Открой плейлист в VK и нажми «Сканировать».</li>';
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
  $btn('btnDownload').disabled = !selected.size;
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
async function playTracks(keys: string[]): Promise<void> {
  const picked = listTracks.filter((t) => keys.includes(t.key) && !t.restricted);
  if (!picked.length) return;
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
    key: tracks[0]!.key,
    tracks,
  });
  pState = res.state;
  renderPlayer();
}

let pState: PlayerState | null = null;
/** True while the user drags the seek bar, so polling does not fight them. */
let seeking = false;
/** Last known equalizer curve, so the panel can render before a track plays. */
let pEqGains: number[] | null = null;

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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
    $btn('pToggle').textContent = '▶';
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
  toggle.textContent = s.playing ? '⏸' : '▶';
  toggle.classList.toggle('playing', s.playing);
  $('pTime').textContent = fmtTime(s.currentTime);
  $('pDur').textContent = fmtTime(s.duration);
  if (!seeking) {
    $in('pSeek').value = s.duration > 0 ? String(Math.round((s.currentTime / s.duration) * 1000)) : '0';
  }
  const vol = $in('pVolume');
  if (document.activeElement !== vol) vol.value = String(Math.round(s.volume * 100));
  const eqOn = $in('eqOn');
  if (document.activeElement !== eqOn) eqOn.checked = s.eqEnabled;
  renderEqBands(s.eqBands);
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

/* ---------------- Equalizer overlay ---------------- */

$('pEq').addEventListener('click', () => {
  const panel = $('eqPanel');
  panel.hidden = !panel.hidden;
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

$('btnAll').addEventListener('click', () => {
  Object.keys(state?.playlists ?? {}).forEach((n) => selected.add(n));
  render();
});
$('btnNone').addEventListener('click', () => {
  selected.clear();
  render();
});
$('btnDownload').addEventListener('click', async () => {
  const r = await send<{ queued: number; skipped: number }>({ t: 'ENQUEUE', names: [...selected] });
  showView('downloads');
  const note = $('dlNote');
  note.textContent = r?.skipped
    ? `Пропущено без ссылки: ${r.skipped}. Проиграй эти треки в плеере, чтобы получить ссылку, и повтори.`
    : r
      ? `В очередь: ${r.queued}`
      : '';
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
  $('homeHero').innerHTML = listTracks
    .slice(0, 3)
    .map(
      (t) =>
        `<div class="hero" data-play="${escapeHtml(t.key)}">` +
        `<div class="hero-cover"${t.cover ? ` style="background-image:url('${escapeHtml(t.cover)}')"` : ''}></div>` +
        `<div class="t-body"><b>${escapeHtml(t.title)}</b><span class="tiny muted">${escapeHtml(t.artist)}</span></div></div>`,
    )
    .join('');
  $('homeHero').addEventListener('click', (e) => {
    const hero = (e.target as HTMLElement).closest('.hero') as HTMLElement | null;
    const key = hero?.dataset.play;
    if (key) void playTracks([key]);
  });
}

async function openView(name: string): Promise<void> {
  showView(name);
  if (name === 'home') await loadHome();
  if (name === 'explore') await loadList('sections', undefined, 'exploreTracks');
}

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

$('btnAll').addEventListener('click', () => {
  Object.keys(state!.playlists).forEach((n) => selected.add(n));
  render();
});
$('btnNone').addEventListener('click', () => {
  selected.clear();
  render();
});
$('btnDownload').addEventListener('click', async () => {
  const r = await send<{ queued: number; skipped: number }>({ t: 'ENQUEUE', names: [...selected] });
  showView('downloads');
  const note = $('dlNote');
  if (r && r.skipped) {
    note.textContent =
      `Пропущено без ссылки: ${r.skipped}. Открой треки в плеере (проиграй их), чтобы хук получил ссылку, и повтори.`;
  } else {
    note.textContent = r ? `В очередь: ${r.queued}` : '';
  }
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
    'Загрузки/' +
    v
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/') +
    '/<плейлист>/01 Artist - Title.mp3';
  void send({ t: 'SETTINGS', patch: { baseDir: v } });
});
