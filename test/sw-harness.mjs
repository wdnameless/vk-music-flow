import assert from 'node:assert/strict';

const captured = new Map();
const blobUrls = new Map();
let uid = 0;
let dlId = 1;

const adtsSeg = () => new Uint8Array([0xff, 0xf1, 0x50, 0x80, ...new Array(60).fill(0x11)]);
const mp3Body = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(80).fill(0xaa)]);
const oldTagSize = 24;
const syncsafe = n => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const oldPayload = new Uint8Array(oldTagSize);
oldPayload.set(new TextEncoder().encode('OLDTAG_MARKER').slice(0, oldTagSize - 3));
const oldTag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe(oldTagSize), ...oldPayload]);
const directWithOldTag = new Uint8Array([...oldTag, ...mp3Body]);
const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(1100).fill(0x77)]);

globalThis.fetch = async (url) => {
  const u = String(url);
  const body = (b, type = 'application/octet-stream') => ({
    ok: true, status: 200,
    text: async () => new TextDecoder().decode(b),
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  });
  if (u.includes('/master.m3u8')) return body(new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhi.m3u8\n'));
  if (u.includes('/hi.m3u8') || u.includes('/v.m3u8')) return body(new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.aac\n#EXTINF:4,\nseg1.aac\n#EXTINF:4,\nseg2.aac\n'));
  if (u.endsWith('seg0.aac')) return body(adtsSeg());
  if (u.endsWith('seg1.aac')) return body(adtsSeg());
  if (u.endsWith('seg2.aac')) return body(adtsSeg());
  if (u.includes('/direct.mp3')) return body(directWithOldTag);
  if (u.includes('/cover.jpg')) return body(cover);
  return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
};

URL.createObjectURL = (blob) => { const u = 'blob:mock/' + (++uid); blobUrls.set(u, blob); return u; };
URL.revokeObjectURL = () => { };

const msgListeners = [];
let dlListeners = [];
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => { } } },
  runtime: {
    onMessage: { addListener: f => msgListeners.push(f) },
    onStartup: { addListener: () => { } },
    onInstalled: { addListener: () => { } }
  },
  alarms: { create: () => { }, onAlarm: { addListener: () => { } } },
  downloads: {
    onChanged: {
      addListener: f => dlListeners.push(f),
      emit(d) { for (const f of dlListeners) f(d); }
    },
    async download({ url, filename }) {
      const blob = blobUrls.get(url);
      captured.set(filename, new Uint8Array(await blob.arrayBuffer()));
      const id = dlId++;
      setTimeout(() => chrome.downloads.onChanged.emit({ id, state: { current: 'complete' } }), 15);
      return id;
    }
  }
};

try {
  await import('../src/background/sw.js');
} catch (e) {
  console.error('IMPORT ERROR:', e);
  process.exit(2);
}
await new Promise(r => setTimeout(r, 100));
console.log('registered listeners:', msgListeners.length);

const send = (m) => Promise.all(msgListeners.map(f => new Promise(res => {
  const done = f(m, null, res);
  if (!done) res(null);
})));

const audioA = {
  key: '55_101', id: '101', owner: '55',
  artist: 'Кино', title: 'Группа крови', album: 'Альбом', year: 2024,
  duration: 289, urls: ['https://cdn/direct.mp3'], covers: ['https://cdn/cover.jpg']
};
const audioB = {
  key: '55_102', id: '102', owner: '55',
  artist: 'Мастер', title: 'HLS Track', album: '', year: null,
  duration: 180, urls: ['https://cdn/master.m3u8'], covers: []
};

await send({ t: 'AUDIOS', audios: [audioA, audioB] });
await send({ t: 'LYRICS', map: { 101: 'Группа крови на рукаве...' } });
await send({ t: 'AUDIOS', audios: [audioA], pl: 'Тест', scanning: true });
await send({ t: 'AUDIOS', audios: [audioB], pl: 'Тест', scanning: true });

let passed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log('  ok -', name); } else console.error('  FAIL -', name); };

console.log('service worker: конвейер загрузки');

const st = (await send({ t: 'GET_STATE' }))[0];
ok(st.playlists['Тест'] === 2, `плейлист «Тест» собран из скан-сообщений (${st.playlists['Тест']})`);

await send({ t: 'ENQUEUE', names: ['Тест'] });
for (let i = 0; i < 40 && captured.size < 2; i++) await new Promise(r => setTimeout(r, 250));

const names = [...captured.keys()].sort();
ok(captured.size === 2, `загружено 2 файла, получено: ${captured.size} -> ${JSON.stringify(names)}`);

const f1 = names.find(n => n.endsWith('.mp3'));
const f2 = names.find(n => n.endsWith('.aac'));

ok(f1 === 'VK Music/Тест/01 Кино - Группа крови.mp3', `имя mp3: ${f1}`);
ok(f2 === 'VK Music/Тест/02 Мастер - HLS Track.aac', `имя aac: ${f2}`);

const b1 = captured.get(f1);
const s1 = new TextDecoder().decode(b1);
ok(s1.slice(0, 3) === 'ID3' && b1[3] === 4, 'ID3v2.4 записан в начало файла');
ok(!s1.includes('OLDTAG_MARKER'), 'старый тег срезан');
{
  let off = 10;
  const ids = [];
  while (off < b1.length - 10) {
    const id = String.fromCharCode(...b1.slice(off, off + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ((b1[off + 4] & 127) << 21) | ((b1[off + 5] & 127) << 14) | ((b1[off + 6] & 127) << 7) | (b1[off + 7] & 127);
    ids.push(id);
    off += 10 + sz;
  }
  ok(ids.join(',') === 'TIT2,TPE1,TALB,TRCK,TDRC,USLT,APIC', `фреймы тега: ${ids.join(',')}`);
  const tail = b1.slice(off);
  ok(tail.length === mp3Body.length && [...tail].every((v, i) => v === mp3Body[i]), `аудио-данные не повреждены (хвост ${tail.length}B == исходные ${mp3Body.length}B)`);

  const b2 = captured.get(f2);
  ok(b2.length === 192 && b2[0] === 0xff && b2[1] === 0xf1, `HLS собран из 3 сегментов ADTS (${b2.length}B)`);
}

await send({ t: 'SETTINGS', patch: { baseDir: 'Music\\VK Extra/..' } });
await send({ t: 'AUDIOS', audios: [audioA], pl: 'Тест2', scanning: true });
await send({ t: 'ENQUEUE', names: ['Тест2'] });
for (let i = 0; i < 40 && captured.size < 3; i++) await new Promise(r => setTimeout(r, 250));

const f3 = [...captured.keys()].find(n => n.includes('Тест2'));
ok(f3 === 'Music/VK Extra/Тест2/01 Кино - Группа крови.mp3', `кастомный baseDir + защита от '..': ${f3}`);

console.log(`\n${passed} проверок пройдено`);
process.exit(passed >= 12 ? 0 : 1);
