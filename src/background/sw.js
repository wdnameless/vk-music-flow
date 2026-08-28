import { buildTag, stripTag } from '../lib/id3.js';
import { parseM3U8 } from '../lib/m3u8.js';
import { sanitize, pad, sniffExt, concatBytes, sanitizePath } from '../lib/util.js';

const SKEY = 'vmf_state_v1';

let S = {
  audios: {},
  lyrics: {},
  playlists: {},
  queue: [],
  failed: [],
  done: {},
  settings: { conc: 2, gapMs: 450, baseDir: 'VK Music' }
};

let pumping = false;
let stopFlag = false;

async function load() {
  try {
    const o = await chrome.storage.local.get(SKEY);
    if (o[SKEY]) S = { ...S, ...o[SKEY] };
    if (!S.settings) S.settings = { conc: 2, gapMs: 450, baseDir: 'VK Music' };
    if (!S.settings.baseDir) S.settings.baseDir = 'VK Music';
  } catch { }
}

let saveT = null;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    chrome.storage.local.set({ [SKEY]: JSON.parse(JSON.stringify(S)) }).catch(() => { });
  }, 400);
}

function mergeAudio(a) {
  const ex = S.audios[a.key];
  if (!ex) { S.audios[a.key] = a; return true; }
  let ch = false;
  for (const u of a.urls || []) if (!ex.urls.includes(u)) { ex.urls.push(u); ch = true; }
  for (const c of a.covers || []) if (!ex.covers.includes(c)) { ex.covers.push(c); ch = true; }
  if (!ex.artist && a.artist) { ex.artist = a.artist; ch = true; }
  if (!ex.title && a.title) { ex.title = a.title; ch = true; }
  if (!ex.album && a.album) { ex.album = a.album; ch = true; }
  if (!ex.duration && a.duration) { ex.duration = a.duration; ch = true; }
  return ch;
}

function attachToPlaylist(name, key) {
  if (!name) return;
  if (!S.playlists[name]) S.playlists[name] = [];
  const arr = S.playlists[name];
  if (!arr.includes(key)) arr.push(key);
}

async function handle(m) {
  switch (m.t) {
    case 'AUDIOS': {
      let ch = false;
      for (const a of m.audios || []) {
        if (mergeAudio(a)) ch = true;
        if (m.scanning && m.pl) { attachToPlaylist(m.pl, a.key); ch = true; }
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
      const names = m.names || [];
      for (const name of names) {
        const arr = S.playlists[name] || [];
        const w = String(Math.max(1, arr.length)).length;
        arr.forEach((key, i) => {
          const idx = i + 1;
          const doneKey = name + '/' + key;
          if (S.done[doneKey]) return;
          if (S.queue.some(q => q.pl === name && q.key === key)) return;
          S.queue.push({ key, pl: name, idx, w });
        });
      }
      persist();
      pump();
      return { queued: S.queue.length };
    }
    case 'CANCEL': {
      stopFlag = true;
      S.queue = [];
      persist();
      return { ok: true };
    }
    case 'RETRY_FAILED': {
      stopFlag = false;
      const f = S.failed.splice(0, S.failed.length);
      for (const it of f) {
        const doneKey = it.pl + '/' + it.key;
        delete S.done[doneKey];
        if (!S.queue.some(q => q.pl === it.pl && q.key === it.key)) S.queue.push(it);
      }
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
      S = { audios: {}, lyrics: {}, playlists: {}, queue: [], failed: [], done: {}, settings: S.settings };
      persist();
      return { ok: true };
    }
    case 'GET_STATE': {
      return snap();
    }
  }
  return null;
}

function snap() {
  return {
    playlists: Object.fromEntries(Object.entries(S.playlists).map(([k, v]) => [k, v.length])),
    queue: S.queue.map(q => ({ pl: q.pl, idx: q.idx, a: S.audios[q.key] ? { artist: S.audios[q.key].artist, title: S.audios[q.key].title } : null })),
    failed: S.failed.map(f => ({ pl: f.pl, err: f.error, a: S.audios[f.key] ? { artist: S.audios[f.key].artist, title: S.audios[f.key].title } : null })),
    doneCount: Object.keys(S.done).length,
    settings: S.settings,
    totalAudios: Object.keys(S.audios).length
  };
}

function fail(item, err) {
  S.done[item.pl + '/' + item.key] && delete S.done[item.pl + '/' + item.key];
  if (!S.failed.some(f => f.key === item.key && f.pl === item.pl)) {
    S.failed.push({ key: item.key, pl: item.pl, idx: item.idx, w: item.w, error: String(err).slice(0, 200), ts: Date.now() });
  } else {
    const f = S.failed.find(f => f.key === item.key && f.pl === item.pl);
    f.error = String(err).slice(0, 200);
    f.ts = Date.now();
  }
  persist();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const slots = Math.min(5, Math.max(1, +S.settings.conc || 2));
    await Promise.all(Array.from({ length: slots }, () => workerLoop()));
  } finally {
    pumping = false;
  }
}

async function workerLoop() {
  while (true) {
    if (stopFlag) break;
    const item = S.queue.shift();
    if (!item) break;
    persist();
    try {
      await runItem(item);
    } catch (e) {
      fail(item, e && e.message || e);
    }
    await sleep(+S.settings.gapMs || 400);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runItem(item) {
  const a = S.audios[item.key];
  if (!a) throw new Error('трек не найден в каталоге');
  const doneKey = item.pl + '/' + item.key;
  if (S.done[doneKey]) return;

  let body = await getAudioBytes(a);
  const ext = sniffExt(body);

  if (ext === 'mp3') {
    body = stripTag(body);
    const cover = await getCover(a);
    const lyrics = S.lyrics[String(a.id)] || '';
    const tag = buildTag(
      { title: a.title, artist: a.artist, album: a.album, year: a.year, track: item.idx },
      cover, lyrics
    );
    if (tag) body = concatBytes([tag, body]);
  }

  const base = sanitizePath(S.settings.baseDir) || 'VK Music';
  const fname = `${base}/${sanitize(item.pl)}/${pad(item.idx, item.w)} ${sanitize(`${a.artist} - ${a.title}`)}.${ext}`;
  await saveBlob(body, fname);

  S.done[doneKey] = Date.now();
  const fi = S.failed.findIndex(f => f.key === item.key && f.pl === item.pl);
  if (fi !== -1) S.failed.splice(fi, 1);
  persist();
}

async function rawFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function getAudioBytes(a) {
  const direct = (a.urls || []).find(u => !/\.m3u8/i.test(u));
  if (direct) {
    const b = await rawFetch(direct);
    if (!(b[0] === 0x23 && b[1] === 0x45 && b[2] === 0x58)) return b;
    const txt = new TextDecoder().decode(b);
    return assembleHls(txt, direct);
  }
  const hls = (a.urls || []).find(u => /\.m3u8/i.test(u)) || (a.urls || [])[0];
  if (!hls) throw new Error('нет доступных ссылок');
  const txt = await (await fetch(hls)).text();
  return assembleHls(txt, hls);
}

async function assembleHls(txt, baseUrl) {
  let p = parseM3U8(txt, baseUrl);
  if (p.variant) {
    const r = await fetch(p.variant);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p = parseM3U8(await r.text(), p.variant);
  }
  if (!p.segments.length) throw new Error('плейлист без сегментов');
  const parts = [];
  if (p.init) parts.push(await rawFetch(p.init));
  let i = 0;
  for (const s of p.segments) {
    if (i > 5000) break;
    let seg = await rawFetch(s);
    if (seg[0] === 0x23 && seg[1] === 0x45 && seg[2] === 0x58) {
      seg = await assembleHls(new TextDecoder().decode(seg), s);
    }
    parts.push(seg);
    i++;
  }
  const out = concatBytes(parts);
  if (!out.length) throw new Error('пустой результат');
  return out;
}

async function getCover(a) {
  for (const c of (a.covers || []).slice(0, 3)) {
    try {
      const b = await rawFetch(c);
      if (b.length > 1024 && b.length < 4e6) return b;
    } catch { }
  }
  return null;
}

const pendingDl = new Map();

chrome.downloads.onChanged.addListener(d => {
  const w = pendingDl.get(d.id);
  if (!w) return;
  if (d.state) {
    if (d.state.current === 'complete') { pendingDl.delete(d.id); w.res(); }
    else if (d.state.current === 'interrupted') { pendingDl.delete(d.id); w.rej(new Error(d.error || 'прервано')); }
  }
});

function waitDone(id, timeoutMs) {
  return new Promise((res, rej) => {
    pendingDl.set(id, { res, rej });
    setTimeout(() => {
      if (pendingDl.delete(id)) rej(new Error('таймаут загрузки'));
    }, timeoutMs || 900000);
  });
}

async function saveBlob(bytes, fname) {
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: fname, conflictAction: 'uniquify' });
    await waitDone(id);
  } finally {
    try { URL.revokeObjectURL(url); } catch { }
  }
}

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  handle(m).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
  return true;
});

chrome.alarms.create('vmf-pump', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(al => {
  if (al.name === 'vmf-pump') { load().then(pump); }
});
chrome.runtime.onStartup.addListener(() => load().then(pump));
chrome.runtime.onInstalled.addListener(() => load().then(pump));

load().then(pump);
