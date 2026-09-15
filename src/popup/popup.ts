import type {
  BlockRules,
  EqBand,
  LastfmAuth,
  PlayerState,
  PlayerTrack,
  ProxyCheckResult,
  ProxyEntry,
  ProxyRoutingMode,
  ProxyStateResult,
  ResponseSample,
  RuntimeMessage,
  ScanResult,
  StateSnapshot,
  StorageStateResult,
  VkAudio,
  VkAuthState,
  VkCatalogResult,
} from '../types.js';
import { persistRootHandle, pickDirectory } from '../storage/fs.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const $in = (id: string) => document.getElementById(id) as HTMLInputElement;
const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement;

let state: StateSnapshot | null = null;
let storageState: StorageStateResult | null = null;
const selected = new Set<string>();

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

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
  const mainFile = contentScripts.find((cs) => (cs as { world?: string }).world === 'MAIN')
    ?.js?.[0];
  const isoFile = contentScripts.find((cs) => !(cs as { world?: string }).world)?.js?.[0];
  if (mainFile) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId! },
      world: 'MAIN',
      files: [mainFile],
    });
  }
  if (isoFile) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId! },
      files: [isoFile],
    });
  }
}

async function refresh(): Promise<void> {
  try {
    state = await send<StateSnapshot>({ t: 'GET_STATE' });
  } catch {
    state = null;
  }
  render();
}

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
  if (!qShow.length) {
    qList.innerHTML = '<div class="empty">Очередь пуста</div>';
  }
  for (const q of qShow) {
    const li = document.createElement('li');
    li.textContent = `[${String(q.idx).padStart(2, '0')}] ${q.pl} — ${q.a ? q.a.artist + ' — ' + q.a.title : '?'}`;
    qList.appendChild(li);
  }

  const fList = $('fList');
  fList.innerHTML = '';
  const fShow = state.failed.slice(0, 30);
  if (!fShow.length) {
    fList.innerHTML = '<div class="empty">Нет ошибок</div>';
  }
  for (const f of fShow) {
    const li = document.createElement('li');
    li.className = 'err';
    const t = document.createElement('span');
    t.textContent = `${f.pl} — ${f.a ? f.a.artist + ' — ' + f.a.title : '?'}`;
    const e = document.createElement('span');
    e.className = 'err-msg';
    e.textContent = f.err;
    li.append(t, e);
    fList.appendChild(li);
  }

  const plList = $('plList');
  plList.innerHTML = '';
  const names = Object.keys(state.playlists).sort((a, b) => a.localeCompare(b));
  $('libTotal').textContent = names.length ? `${names.length} плейл.` : '';
  if (!names.length) {
    plList.innerHTML =
      '<div class="empty">Плейлисты не собраны. Вкладка «Скан» → открой плейлист в VK и сканируй.</div>';
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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

/* ---------------- Wave 2: VK catalog (tabless) ---------------- */

let vkTracks: VkAudio[] = [];
const vkSelected = new Set<string>();

/** Key for a VK track, matching how the SW names catalog entries. */
const vkKey = (a: VkAudio): string => `${a.owner_id}_${a.id}`;

function vkTrackHtml(a: VkAudio): string {
  const key = vkKey(a);
  const restricted = a.content_restricted === 2 || a.content_restricted === 3;
  const dur = typeof a.duration === 'number'
    ? `${Math.floor(a.duration / 60)}:${String(a.duration % 60).padStart(2, '0')}`
    : '';
  return (
    `<li data-key="${key}"${restricted ? ' class="muted"' : ''}>` +
    `<input type="checkbox" data-key="${key}"${vkSelected.has(key) ? ' checked' : ''}${restricted ? ' disabled' : ''}/> ` +
    `<b>${escapeHtml(a.artist || '')}</b> — ${escapeHtml(a.title || '')} ` +
    `<span class="muted">${dur}</span>` +
    `${restricted ? ' <span class="bad">недоступен (VK)</span>' : ''}` +
    '</li>'
  );
}

function renderVkList(): void {
  const list = $('vkList');
  list.innerHTML = vkTracks.length
    ? vkTracks.map(vkTrackHtml).join('')
    : '<li class="muted">Пусто. Нажми «Моя музыка», «Рекомендации» или найди треки.</li>';
  const sel = vkSelected.size;
  const restricted = vkTracks.filter((a) => a.content_restricted === 2 || a.content_restricted === 3).length;
  $('vkCount').textContent = vkTracks.length
    ? `${vkTracks.length} треков, выбрано ${sel}${restricted ? `, недоступно ${restricted}` : ''}`
    : '';
  $btn('btnVkDownload').disabled = sel === 0;
}

async function refreshVkAuth(): Promise<void> {
  try {
    const s = await send<VkAuthState>({ t: 'GET_VK_AUTH' });
    $('vkAuth').textContent = s.signedIn
      ? `Вошёл в VK (id ${s.userId}).`
      : s.reason || 'Не удалось войти в VK.';
  } catch {
    $('vkAuth').textContent = 'Не удалось проверить сессию VK.';
  }
}

async function loadVk(
  msg: RuntimeMessage,
): Promise<void> {
  $('vkList').innerHTML = '<li class="muted">Загружаю…</li>';
  try {
    const r = await send<VkCatalogResult<VkAudio>>(msg);
    vkTracks = r.items ?? [];
    vkSelected.clear();
    if (!r.ok) $('vkNote').textContent = r.reason || 'Не удалось получить треки.';
    else $('vkNote').textContent = '';
  } catch (e) {
    vkTracks = [];
    $('vkNote').textContent = 'Ошибка: ' + ((e as Error).message || e);
  }
  renderVkList();
}

$('btnVkMine').addEventListener('click', () => void loadVk({ t: 'VK_MY_AUDIOS', count: 100 }));
$('btnVkRecs').addEventListener('click', () => void loadVk({ t: 'VK_RECOMMENDATIONS' }));

$('btnVkSearch').addEventListener('click', () => {
  const q = $in('vkQuery').value.trim();
  if (!q) return;
  void loadVk({ t: 'VK_SEARCH', q });
});

$('vkList').addEventListener('click', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.tagName !== 'INPUT') return;
  const key = el.dataset.key;
  if (!key) return;
  if (el.checked) vkSelected.add(key);
  else vkSelected.delete(key);
  const sel = vkSelected.size;
  $btn('btnVkDownload').disabled = sel === 0;
  $('vkCount').textContent = `${vkTracks.length} треков, выбрано ${sel}`;
});

$('btnVkAll').addEventListener('click', () => {
  // Restricted tracks can never be downloaded, so "select all" must not pretend
  // otherwise — they stay unticked and are reported by the download button.
  for (const a of vkTracks) {
    if (a.content_restricted === 2 || a.content_restricted === 3) continue;
    vkSelected.add(vkKey(a));
  }
  renderVkList();
});

$('btnVkNone').addEventListener('click', () => {
  vkSelected.clear();
  renderVkList();
});

$('btnVkDownload').addEventListener('click', async () => {
  const picked = vkTracks.filter((a) => vkSelected.has(vkKey(a)));
  if (!picked.length) return;
  const name = $in('vkPlaylistName').value.trim() || 'VK Музыка';
  $('vkNote').textContent = 'Ставлю в очередь…';
  try {
    const r = await send<{ ok: boolean; queued: number; skipped: number; total: number }>({
      t: 'VK_ENQUEUE',
      name,
      audios: picked,
    });
    $('vkNote').textContent = r.skipped
      ? `В очередь: ${r.queued}. Пропущено недоступных: ${r.skipped}.`
      : `В очередь: ${r.queued}.`;
    switchTab('dl');
  } catch (e) {
    $('vkNote').textContent = 'Ошибка: ' + ((e as Error).message || e);
  }
});

/* ---------------- Wave 2: player bar + equalizer ---------------- */

let pState: PlayerState | null = null;
/** True while the user drags the seek bar, so polling does not fight them. */
let seeking = false;

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
  const bar = $('playerBar');
  const s = pState;
  if (!s || !s.track) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('pTitle').textContent = s.track.title || '—';
  $('pArtist').textContent = s.track.artist || '';
  const toggle = $btn('pToggle');
  toggle.textContent = s.playing ? '⏸' : '▶';
  toggle.classList.toggle('playing', s.playing);
  $('pTime').textContent = `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`;
  if (!seeking) {
    const seek = $in('pSeek');
    seek.value = s.duration > 0 ? String(Math.round((s.currentTime / s.duration) * 1000)) : '0';
  }
  const eqOn = $in('eqOn') as HTMLInputElement;
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
  const gains = [...$('eqBands').querySelectorAll<HTMLInputElement>('input[data-hz]')].map((i) =>
    Number(i.value),
  );
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'EQ_SET',
    enabled: true,
    gains,
  });
  pState = r.state;
  renderPlayer();
});

$('eqReset').addEventListener('click', async () => {
  const gains = (pState?.eqBands ?? []).map(() => 0);
  const r = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'EQ_SET',
    enabled: true,
    gains,
  });
  pState = r.state;
  renderPlayer();
});

/** Play the currently ticked catalog tracks in the offscreen player. */
$('btnVkPlay').addEventListener('click', async () => {
  const picked = vkTracks.filter((a) => vkSelected.has(vkKey(a)));
  if (!picked.length) return;
  $('vkNote').textContent = 'Готовлю треки…';
  const tracks: PlayerTrack[] = [];
  for (const a of picked) {
    // Stream URLs expire, so resolve each one right before playback.
    const r = await send<{ ok: boolean; urls: string[]; restricted?: boolean }>({
      t: 'RESOLVE_TRACK',
      key: vkKey(a),
      owner: String(a.owner_id),
      id: String(a.id),
      accessKey: a.access_key,
      artist: a.artist || '',
      title: a.title || '',
      duration: typeof a.duration === 'number' ? a.duration : null,
      cover: null,
    });
    if (r.ok && r.urls[0]) {
      tracks.push({
        key: vkKey(a),
        id: String(a.id),
        owner: String(a.owner_id),
        artist: a.artist || '',
        title: a.title || '',
        url: r.urls[0],
        duration: typeof a.duration === 'number' ? a.duration : null,
        cover: null,
      });
    }
  }
  if (!tracks.length) {
    $('vkNote').textContent = 'Не удалось получить ссылки для воспроизведения.';
    return;
  }
  const res = await send<{ ok: boolean; state: PlayerState | null }>({
    t: 'PLAY_LIST',
    key: vkKey(picked[0]!),
    tracks,
  });
  pState = res.state;
  $('vkNote').textContent = `Играю: ${tracks.length} треков.`;
  renderPlayer();
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

$('btnClearDir').addEventListener('click', async () => {
  try {
    storageState = await send<StorageStateResult>({ t: 'CLEAR_DIR' });
  } catch {
    /* keep last view */
  }
  renderStorage();
});

$('storageMode').addEventListener('change', (e) => {
  const target = e.target as HTMLSelectElement;
  const mode = target.value === 'fsa' ? 'fsa' : 'downloads';
  void (async () => {
    await send({ t: 'SETTINGS', patch: { storageMode: mode } });
    await refreshStorage();
  })();
});

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
      switchTab('lib');
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
  switchTab('dl');
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

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab((t as HTMLElement).dataset.tab));
});

function switchTab(name?: string): void {
  document
    .querySelectorAll('.tab')
    .forEach((x) => x.classList.toggle('active', (x as HTMLElement).dataset.tab === name));
  document
    .querySelectorAll('.pane')
    .forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

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
    }
  } catch {
    /* state may be unavailable */
  }
  void refreshStorage();
  void refresh();
  void refreshProxy();
  void refreshDnr();
  void refreshVkAuth();
  void refreshPlayer();
  void refreshRules();
  void refreshLastfm();
  setInterval(refresh, 800);
  // The player lives in the offscreen document, so poll it on its own cadence.
  setInterval(() => void refreshPlayer(), 700);
})();
