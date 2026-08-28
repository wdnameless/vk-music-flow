import type { ResponseSample, RuntimeMessage, ScanResult, StateSnapshot } from '../types.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const $in = (id: string) => document.getElementById(id) as HTMLInputElement;

let state: StateSnapshot | null = null;
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

  $('qCount').textContent = String(state.queue.length);
  $('dCount').textContent = String(state.doneCount);
  $('fCount').textContent = String(state.failed.length);

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
  await send({ t: 'ENQUEUE', names: [...selected] });
  switchTab('dl');
});
$('btnRetry').addEventListener('click', () => void send({ t: 'RETRY_FAILED' }));
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
    '/<плейлист>/01. Artist - Title.mp3';
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
        'Загрузки/' + ($in('baseDir').value || 'VK Music') + '/<плейлист>/01. Artist - Title.mp3';
    }
  } catch {
    /* state may be unavailable */
  }
  void refresh();
  setInterval(refresh, 800);
})();
