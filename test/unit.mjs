import assert from 'node:assert/strict';
import { sanitize, pad, sniffExt, concatBytes } from '../src/lib/util.js';
import { buildTag, stripTag } from '../src/lib/id3.js';
import { parseM3U8 } from '../src/lib/m3u8.js';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('util.js');
ok('sanitize заменяет недопустимые символы', () => {
  assert.equal(sanitize('AC/DC: "Greatest" <Hits>?'), 'AC_DC_ _Greatest_ _Hits__');
});
ok('sanitize убирает точки/пробелы в конце', () => {
  assert.equal(sanitize('Track. .. '), 'Track');
});
ok('sanitize обрезает до 120', () => {
  assert.ok(sanitize('x'.repeat(500)).length <= 120);
});
ok('pad', () => {
  assert.equal(pad(5, 2), '05');
  assert.equal(pad(123, 2), '123');
});
ok('sniffExt: ID3 -> mp3', () => {
  assert.equal(sniffExt(new Uint8Array([0x49, 0x44, 0x33, 4])), 'mp3');
});
ok('sniffExt: ADTS F1/F9/F0 -> aac', () => {
  assert.equal(sniffExt(new Uint8Array([0xff, 0xf1, 0x50, 0x80])), 'aac');
  assert.equal(sniffExt(new Uint8Array([0xff, 0xf9, 0x50, 0x80])), 'aac');
  assert.equal(sniffExt(new Uint8Array([0xff, 0xf0, 0x50, 0x80])), 'aac');
});
ok('sniffExt: MP3 frame FB -> mp3', () => {
  assert.equal(sniffExt(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 'mp3');
});
ok('sniffExt: MPEG-TS 188', () => {
  const b = new Uint8Array(200); b[0] = 0x47; b[188] = 0x47;
  assert.equal(sniffExt(b), 'ts');
});
ok('sniffExt: мусор -> bin', () => {
  assert.equal(sniffExt(new Uint8Array([1, 2, 3, 4])), 'bin');
});
ok('concatBytes', () => {
  assert.deepEqual([...concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])], [1, 2, 3]);
});

console.log('id3.js');
ok('buildTag: заголовок ID3v2.4 + syncsafe размер', () => {
  const tag = buildTag({ title: 'T', artist: 'A' }, null, '');
  assert.equal(String.fromCharCode(...tag.slice(0, 3)), 'ID3');
  assert.equal(tag[3], 4); assert.equal(tag[4], 0); assert.equal(tag[5], 0);
  const size = ((tag[6] & 127) << 21) | ((tag[7] & 127) << 14) | ((tag[8] & 127) << 7) | (tag[9] & 127);
  assert.equal(10 + size, tag.length);
});
ok('buildTag: все фреймы на месте и в правильной кодировке UTF-8', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(1)]);
  const tag = buildTag({ title: 'Тест', artist: 'Артист', album: 'Альбом', track: 7, year: 2024 }, png, 'Слова песни');
  const ids = [];
  let off = 10;
  while (off < tag.length - 10) {
    const id = String.fromCharCode(...tag.slice(off, off + 4));
    const sz = ((tag[off + 4] & 127) << 21) | ((tag[off + 5] & 127) << 14) | ((tag[off + 6] & 127) << 7) | (tag[off + 7] & 127);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    ids.push(id);
    if (id === 'TIT2') {
      assert.equal(tag[off + 10], 3);
      assert.equal(new TextDecoder().decode(tag.slice(off + 11, off + 10 + sz - 1)), 'Тест');
    }
    if (id === 'APIC') {
      const mimeEnd = tag.indexOf(0, off + 11);
      assert.equal(new TextDecoder().decode(tag.slice(off + 11, mimeEnd)), 'image/png');
    }
    off += 10 + sz;
  }
  assert.deepEqual(ids, ['TIT2', 'TPE1', 'TALB', 'TRCK', 'TDRC', 'USLT', 'APIC']);
});
ok('buildTag: jpeg mime определяется верно', () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
  const tag = buildTag({ title: 'x' }, jpg, '');
  const i = tag.indexOf(0x00);
  void i;
  const s = new TextDecoder().decode(tag);
  assert.ok(s.includes('image/jpeg'));
});
ok('stripTag: round-trip возвращает исходное тело', () => {
  const body = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(50).fill(0xaa)]);
  const tag = buildTag({ title: 'R', artist: 'R' }, null, '');
  const combined = concatBytes([tag, body]);
  const stripped = stripTag(combined);
  assert.equal(stripped.length, body.length);
  assert.deepEqual([...stripped], [...body]);
});
ok('stripTag: без тега тело не трогается', () => {
  const body = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
  assert.deepEqual([...stripTag(body)], [...body]);
});

console.log('m3u8.js');
const base = 'https://cdn.example/a/list.m3u8';
ok('медиа-плейлист: сегменты с резолвом относительных путей', () => {
  const p = parseM3U8('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXTINF:9,\nseg1.ts\n', base);
  assert.equal(p.variant, null);
  assert.deepEqual(p.segments, ['https://cdn.example/a/seg0.ts', 'https://cdn.example/a/seg1.ts']);
});
ok('мастер-плейлист: выбирается вариант с максимальным BANDWIDTH', () => {
  const p = parseM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nhi.m3u8\n', base);
  assert.equal(p.variant, 'https://cdn.example/a/hi.m3u8');
  assert.equal(p.segments.length, 0);
});
ok('EXT-X-MAP: init-сегмент извлекается', () => {
  const p = parseM3U8('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\ns.ts\n', base);
  assert.equal(p.init, 'https://cdn.example/a/init.mp4');
});
ok('не-m3u8 бросает ошибку', () => {
  assert.throws(() => parseM3U8('<html>404</html>', base), /не m3u8/);
});

console.log(`\n${passed} тестов пройдено`);
