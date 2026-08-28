const $ = (id) => document.getElementById(id);

let state = null;
let selected = new Set();

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function activeVkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(\w+\.)?vk\.(com|ru)\//.test(tab.url || '')) return null;
  return tab;
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { cmd: 'PING' });
    return;
  } catch { }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['src/content/hook-main.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/collector.js']
  });
}

async function refresh() {
  try {
    state = await send({ t: 'GET_STATE' });
  } catch {
    state = null;
  }
  render();
}

function render() {
  if (!state) return;

  $('qCount').textContent = state.queue.length;
  $('dCount').textContent = state.doneCount;
  $('fCount').textContent = state.failed.length;

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
    plList.innerHTML = '<div class="empty">Плейлисты не собраны. Вкладка «Скан» → открой плейлист в VK и сканируй.</div>';
  }
  for (const name of names) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(name);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(name); else selected.delete(name);
      updateDlBtn();
    });
    const label = document.createElement('span');
    label.textContent = name;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = state.playlists[name];
    li.append(cb, label, cnt);
    plList.appendChild(li);
  }
  updateDlBtn();
}

function updateDlBtn() {
  $('btnDownload').disabled = !selected.size;
}

$('btnScan').addEventListener('click', async () => {
  const btn = $('btnScan');
  btn.disabled = true;
  $('scanResult').textContent = 'Сканирую… (не закрывай вкладку)';
  try {
    const tab = await activeVkTab();
    if (!tab) {
      $('scanResult').textContent = 'Открой вкладку vk.com / vk.ru и попробуй снова.';
      return;
    }
    await ensureInjected(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, {
      cmd: 'SCAN',
      name: $('scanName').value.trim() || undefined
    });
    if (res && res.error) throw new Error(res.error);
    const s = res.stats ? ` | сеть: ${res.stats.responses} отв. / ${res.stats.found} тр., скрипты: ${res.stats.embedded}` : '';
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
    $('scanResult').textContent = 'Ошибка: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
});

$('btnDiag').addEventListener('click', async () => {
  const btn = $('btnDiag');
  btn.disabled = true;
  $('diagResult').textContent = 'Собираю…';
  try {
    const tab = await activeVkTab();
    if (!tab) { $('diagResult').textContent = 'Открой вкладку vk.com / vk.ru.'; return; }
    await ensureInjected(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'SAMPLES' });
    const samples = (res && res.samples) || [];
    if (!samples.length) {
      $('diagResult').textContent = 'Ответов пока нет. Открой страницу плейлиста (не «Моя музыка»), подожди 2-3 сек и нажми снова.';
      return;
    }
    const text = samples.map(s => 'URL: ' + s.url + '\nREQ: ' + s.req + '\n' + s.text).join('\n\n=====\n\n');
    await navigator.clipboard.writeText(text);
    $('diagResult').textContent = `Скопировано ${samples.length} ответов (${Math.round(text.length / 1024)} КБ). Вставь их в чат.`;
  } catch (e) {
    $('diagResult').textContent = 'Ошибка: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
});

$('btnAll').addEventListener('click', () => {
  Object.keys(state.playlists).forEach(n => selected.add(n));
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
$('btnRetry').addEventListener('click', () => send({ t: 'RETRY_FAILED' }));
$('btnCancel').addEventListener('click', () => send({ t: 'CANCEL' }));
$('btnReset').addEventListener('click', async () => {
  if (confirm('Удалить весь собранный каталог?')) {
    await send({ t: 'RESET' });
    selected.clear();
    refresh();
  }
});
$('conc').addEventListener('input', (e) => {
  $('concVal').textContent = e.target.value;
  send({ t: 'SETTINGS', patch: { conc: +e.target.value } });
});
$('gap').addEventListener('change', (e) => {
  send({ t: 'SETTINGS', patch: { gapMs: +e.target.value } });
});
$('baseDir').addEventListener('input', (e) => {
  const v = e.target.value.trim() || 'VK Music';
  $('pathExample').textContent = 'Загрузки/' + v.split(/[\\/]+/).filter(Boolean).join('/') + '/<плейлист>/01. Artist - Title.mp3';
  send({ t: 'SETTINGS', patch: { baseDir: v } });
});

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

(async function init() {
  try {
    const s = await send({ t: 'GET_STATE' });
    if (s && s.settings) {
      $('conc').value = s.settings.conc;
      $('concVal').textContent = s.settings.conc;
      $('gap').value = s.settings.gapMs;
      $('baseDir').value = s.settings.baseDir || 'VK Music';
      $('pathExample').textContent = 'Загрузки/' + ($('baseDir').value || 'VK Music') + '/<плейлист>/01. Artist - Title.mp3';
    }
  } catch { }
  refresh();
  setInterval(refresh, 800);
})();
