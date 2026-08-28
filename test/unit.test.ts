import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { sanitize, pad, sniffExt, concatBytes } from '../src/lib/util.js';
import { buildTag, stripTag } from '../src/lib/id3.js';
import { parseM3U8 } from '../src/lib/m3u8.js';

describe('util.js', () => {
  it('sanitize заменяет недопустимые символы', () => {
    assert.equal(sanitize('AC/DC: "Greatest" <Hits>?'), 'AC_DC_ _Greatest_ _Hits__');
  });
  it('sanitize убирает точки/пробелы в конце', () => {
    assert.equal(sanitize('Track. .. '), 'Track');
  });
  it('sanitize обрезает до 120', () => {
    assert.ok(sanitize('x'.repeat(500)).length <= 120);
  });
  it('pad', () => {
    assert.equal(pad(5, 2), '05');
    assert.equal(pad(123, 2), '123');
  });
  it('sniffExt: ID3 -> mp3', () => {
    assert.equal(sniffExt(new Uint8Array([0x49, 0x44, 0x33, 4])), 'mp3');
  });
  it('sniffExt: ADTS F1/F9/F0 -> aac', () => {
    assert.equal(sniffExt(new Uint8Array([0xff, 0xf1, 0x50, 0x80])), 'aac');
    assert.equal(sniffExt(new Uint8Array([0xff, 0xf9, 0x50, 0x80])), 'aac');
    assert.equal(sniffExt(new Uint8Array([0xff, 0xf0, 0x50, 0x80])), 'aac');
  });
  it('sniffExt: MP3 frame FB -> mp3', () => {
    assert.equal(sniffExt(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  });
  it('sniffExt: MPEG-TS 188', () => {
    const b = new Uint8Array(200);
    b[0] = 0x47;
    b[188] = 0x47;
    assert.equal(sniffExt(b), 'ts');
  });
  it('sniffExt: мусор -> bin', () => {
    assert.equal(sniffExt(new Uint8Array([1, 2, 3, 4])), 'bin');
  });
  it('concatBytes', () => {
    assert.deepEqual([...concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])], [1, 2, 3]);
  });
});

describe('id3.js', () => {
  it('buildTag: заголовок ID3v2.4 + syncsafe размер', () => {
    const tag = buildTag({ title: 'T', artist: 'A' }, null, '');
    assert.ok(tag);
    assert.equal(String.fromCharCode(...tag.slice(0, 3)), 'ID3');
    assert.equal(tag[3], 4);
    assert.equal(tag[4], 0);
    assert.equal(tag[5], 0);
    const size =
      (((tag[6] ?? 0) & 127) << 21) |
      (((tag[7] ?? 0) & 127) << 14) |
      (((tag[8] ?? 0) & 127) << 7) |
      ((tag[9] ?? 0) & 127);
    assert.equal(10 + size, tag.length);
  });
  it('buildTag: все фреймы на месте и в правильной кодировке UTF-8', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(1)]);
    const tag = buildTag(
      { title: 'Тест', artist: 'Артист', album: 'Альбом', track: 7, year: 2024 },
      png,
      'Слова песни',
    );
    assert.ok(tag);
    const ids: string[] = [];
    let off = 10;
    while (off < tag.length - 10) {
      const id = String.fromCharCode(...tag.slice(off, off + 4));
      const sz: number =
        (((tag[off + 4] ?? 0) & 127) << 21) |
        (((tag[off + 5] ?? 0) & 127) << 14) |
        (((tag[off + 6] ?? 0) & 127) << 7) |
        ((tag[off + 7] ?? 0) & 127);
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
  it('buildTag: jpeg mime определяется верно', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
    const tag = buildTag({ title: 'x' }, jpg, '');
    assert.ok(tag);
    const s = new TextDecoder().decode(tag);
    assert.ok(s.includes('image/jpeg'));
  });
  it('stripTag: round-trip возвращает исходное тело', () => {
    const body = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(50).fill(0xaa)]);
    const tag = buildTag({ title: 'R', artist: 'R' }, null, '');
    assert.ok(tag);
    const combined = concatBytes([tag, body]);
    const stripped = stripTag(combined);
    assert.equal(stripped.length, body.length);
    assert.deepEqual([...stripped], [...body]);
  });
  it('stripTag: без тега тело не трогается', () => {
    const body = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
    assert.deepEqual([...stripTag(body)], [...body]);
  });
});

describe('m3u8.js', () => {
  const base = 'https://cdn.example/a/list.m3u8';
  it('медиа-плейлист: сегменты с резолвом относительных путей', () => {
    const p = parseM3U8(
      '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXTINF:9,\nseg1.ts\n',
      base,
    );
    assert.equal(p.variant, null);
    assert.deepEqual(p.segments, [
      'https://cdn.example/a/seg0.ts',
      'https://cdn.example/a/seg1.ts',
    ]);
  });
  it('мастер-плейлист: выбирается вариант с максимальным BANDWIDTH', () => {
    const p = parseM3U8(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nhi.m3u8\n',
      base,
    );
    assert.equal(p.variant, 'https://cdn.example/a/hi.m3u8');
    assert.equal(p.segments.length, 0);
  });
  it('EXT-X-MAP: init-сегмент извлекается', () => {
    const p = parseM3U8('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\ns.ts\n', base);
    assert.equal(p.init, 'https://cdn.example/a/init.mp4');
  });
  it('не-m3u8 бросает ошибку', () => {
    assert.throws(() => parseM3U8('<html>404</html>', base), /не m3u8/);
  });
});
