import type {
  ProxyCheckResult,
  ProxyEntry,
  ProxyRoutingMode,
  ProxyStateResult,
  ResponseSample,
  RuntimeMessage,
  ScanResult,
  StateSnapshot,
  StorageStateResult,
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
  setInterval(refresh, 800);
})();
