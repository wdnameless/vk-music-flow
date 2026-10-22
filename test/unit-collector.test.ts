import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { domNormalize, parseTrackRow } from '../src/content/collector.js';
import {
  balancedFrom,
  extractEmbedded,
  harvest,
  shouldProcessResponse,
} from '../src/content/hook-main.js';

// Minimal mock element for DOM tests in Node/Vitest
class MockElement {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: MockElement[];
  parent: MockElement | null = null;

  constructor(
    tag: string,
    attrs: Record<string, string> = {},
    text = '',
    children: MockElement[] = [],
  ) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.textContent = text;
    this.children = [...children];
    for (const c of this.children) {
      c.parent = this;
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  closest(sel: string): MockElement | null {
    if (sel.includes('data-audio-id') && this.attrs['data-audio-id']) return this;
    return this.parent ? this.parent.closest(sel) : null;
  }

  querySelector(sel: string): MockElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): MockElement[] {
    const res: MockElement[] = [];
    const check = (el: MockElement) => {
      const tid = el.attrs['data-testid'] || '';
      const cls = el.attrs['class'] || '';
      const role = el.attrs['role'] || '';
      const tag = el.tagName.toLowerCase();

      if (sel.includes('MusicTrackRow_Title') && tid === 'MusicTrackRow_Title') res.push(el);
      else if (sel.includes('MusicTrackRow_Artist') && tid === 'MusicTrackRow_Artist') res.push(el);
      else if (sel.includes('MusicTrackRow_Info') && tid === 'MusicTrackRow_Info') res.push(el);
      else if (sel.includes('MusicTrackRow') && tid === 'MusicTrackRow') res.push(el);
      else if (sel.includes('audio_row__title') && cls.includes('audio_row__title')) res.push(el);
      else if (sel.includes('audio_row__performers') && cls.includes('audio_row__performers'))
        res.push(el);
      else if (
        (sel.includes('badge') || sel.includes('Explicit') || sel.includes('button')) &&
        (cls.includes('badge') ||
          tid.includes('Badge') ||
          tid.includes('Explicit') ||
          cls.includes('explicit') ||
          role === 'button' ||
          tag === 'button' ||
          tag === 'svg')
      ) {
        res.push(el);
      }

      for (const c of el.children) check(c);
    };

    for (const c of this.children) check(c);
    return res;
  }

  cloneNode(deep?: boolean): MockElement {
    const clone = new MockElement(
      this.tagName,
      this.attrs,
      this.textContent,
      deep ? this.children.map((c) => c.cloneNode(deep)) : [],
    );
    return clone;
  }

  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((x) => x !== this);
    }
  }
}

describe('T5.1: Collector DOM rows & badges (R19)', () => {
  it('парсит строку по именованным селекторам MusicTrackRow_Title и MusicTrackRow_Artist', () => {
    const row = new MockElement(
      'div',
      { 'data-testid': 'MusicTrackRow', 'data-audio-id': '100_200' },
      '',
      [
        new MockElement('div', { 'data-testid': 'MusicTrackRow_Info' }, '', [
          new MockElement('div', { 'data-testid': 'MusicTrackRow_Title' }, 'Название песни', []),
          new MockElement('div', { 'data-testid': 'MusicTrackRow_Artist' }, 'Исполнитель', []),
        ]),
      ],
    );

    const meta = parseTrackRow(row as unknown as Element);
    assert.ok(meta);
    assert.equal(meta.key, '100_200');
    assert.equal(meta.title, 'Название песни');
    assert.equal(meta.artist, 'Исполнитель');
  });

  it('игнорирует бейджи (E, Explicit) и кнопки внутри строки и вложенных элементов', () => {
    const row = new MockElement(
      'div',
      { 'data-testid': 'MusicTrackRow', 'data-audio-id': '100_201' },
      '',
      [
        new MockElement('div', { 'data-testid': 'MusicTrackRow_Info' }, '', [
          new MockElement('div', { 'data-testid': 'MusicTrackRow_Title' }, 'Track Title', [
            new MockElement('span', { class: 'badge', 'data-testid': 'badge' }, 'E', []),
          ]),
          new MockElement(
            'span',
            { class: 'AudioTrackBadge', 'data-testid': 'MusicTrackRow_Explicit' },
            '18+',
            [],
          ),
          new MockElement('button', { role: 'button' }, 'Play', []),
          new MockElement('div', { 'data-testid': 'MusicTrackRow_Artist' }, 'Main Artist', []),
        ]),
      ],
    );

    const meta = parseTrackRow(row as unknown as Element);
    assert.ok(meta);
    assert.equal(meta.title, 'Track Title');
    assert.equal(meta.artist, 'Main Artist');
  });

  it('фолбэк на unnamed children (поведение mock/collector.html) сохраняет работоспособность', () => {
    const row = new MockElement(
      'div',
      { 'data-testid': 'MusicTrackRow', 'data-audio-id': '77_0' },
      '',
      [
        new MockElement('div', { 'data-testid': 'MusicTrackRow_Info' }, '', [
          new MockElement('div', {}, 'Песня 0', []),
          new MockElement('div', {}, 'Артист 0', []),
        ]),
      ],
    );

    const meta = parseTrackRow(row as unknown as Element);
    assert.ok(meta);
    assert.equal(meta.key, '77_0');
    assert.equal(meta.title, 'Песня 0');
    assert.equal(meta.artist, 'Артист 0');
  });

  it('domNormalize пропускает неполные или битые данные', () => {
    assert.equal(domNormalize({ id: 'bad' }), null);
    assert.equal(domNormalize({ id: '1_2', title: '' }), null);
    assert.equal(domNormalize({ id: '1_2', title: 'T', artist: '' }), null);
  });
});

describe('T5.1: Hook extractEmbedded с парсингом вперёд (R20)', () => {
  it('не обрезает вложенные свойства (album, year) перед "artist"', () => {
    const scriptText = `
      window.__initialData = {
        "status": 200,
        "track": {
          "id": 1001,
          "owner_id": 2002,
          "album": {
            "title": "A Night at the Opera",
            "year": 1975
          },
          "artist": "Queen",
          "title": "Bohemian Rhapsody",
          "duration": 354,
          "access_key": "q123",
          "content_restricted": 2
        }
      };
    `;

    const res = extractEmbedded(scriptText);
    assert.equal(res.length, 1);
    const item = res[0]!;
    assert.equal(item.key, '2002_1001');
    assert.equal(item.artist, 'Queen');
    assert.equal(item.title, 'Bohemian Rhapsody');
    assert.equal(item.album, 'A Night at the Opera');
    assert.equal(item.year, 1975);
    assert.equal(item.access_key, 'q123');
    assert.equal(item.restricted, 2);
  });

  it('извлекает массив треков из обёрток ajax.preload', () => {
    const scriptText = `
      ajax.preload("/al_audio.php", 0, [
        {
          "id": 11,
          "owner_id": 22,
          "artist": "The Beatles",
          "title": "Yesterday",
          "duration": 125,
          "access_key": "beatles1"
        },
        {
          "id": 33,
          "owner_id": 44,
          "artist": "Pink Floyd",
          "title": "Time",
          "duration": 425,
          "restricted": 3
        }
      ]);
    `;

    const res = extractEmbedded(scriptText);
    assert.equal(res.length, 2);
    assert.equal(res[0]!.key, '22_11');
    assert.equal(res[0]!.access_key, 'beatles1');
    assert.equal(res[1]!.key, '44_33');
    assert.equal(res[1]!.restricted, 3);
  });

  it('balancedFrom проверяет баланс фигурных и квадратных скобок со строками', () => {
    const json = '{"a": [1, {"b": "}"}], "c": 3}';
    assert.equal(balancedFrom(json, 0), json);
    assert.equal(balancedFrom('invalid', 0), null);
  });
});

describe('T5.1: Hook harvest сохраняет access_key и restricted (R21)', () => {
  it('сохраняет access_key и content_restricted', () => {
    const data = {
      id: 50,
      owner_id: 60,
      artist: 'Kino',
      title: 'Gruppa Krovi',
      duration: 285,
      access_key: 'kino_secret',
      content_restricted: 2,
    };

    const { out } = harvest(data);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.access_key, 'kino_secret');
    assert.equal(out[0]!.restricted, 2);
  });

  it('поддерживает camelCase поля accessKey и restricted', () => {
    const data = {
      id: 51,
      owner_id: 60,
      artist: 'Kino',
      title: 'Pachka Sigaret',
      duration: 268,
      accessKey: 'kino_key_2',
      restricted: 3,
    };

    const { out } = harvest(data);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.access_key, 'kino_key_2');
    assert.equal(out[0]!.restricted, 3);
  });
});

describe('T5.1: shouldProcessResponse фильтрует бинарные тела (R22)', () => {
  it('пропускает бинарные content-type (аудио, видео, изображения, stream)', () => {
    assert.equal(shouldProcessResponse('audio/mpeg', 'https://example.com/audio.mp3'), false);
    assert.equal(shouldProcessResponse('audio/mp4', 'https://example.com/segment.m4s'), false);
    assert.equal(shouldProcessResponse('video/mp2t', 'https://example.com/chunk.ts'), false);
    assert.equal(shouldProcessResponse('image/jpeg', 'https://example.com/cover.jpg'), false);
    assert.equal(shouldProcessResponse('image/webp', 'https://example.com/cover.webp'), false);
    assert.equal(
      shouldProcessResponse('application/octet-stream', 'https://example.com/stream'),
      false,
    );
    assert.equal(
      shouldProcessResponse('application/wasm', 'https://example.com/module.wasm'),
      false,
    );
  });

  it('пропускает ответы размером более 8 МБ', () => {
    assert.equal(
      shouldProcessResponse('application/json', 'https://api.vk.com/big.json', 10_000_000),
      false,
    );
  });

  it('пропускает URL с бинарными расширениями даже при пустом content-type', () => {
    assert.equal(shouldProcessResponse(null, 'https://cs.vk.com/chunk.ts'), false);
    assert.equal(shouldProcessResponse('', 'https://cs.vk.com/track.mp3'), false);
    assert.equal(shouldProcessResponse(undefined, 'https://cs.vk.com/audio.aac'), false);
  });

  it('обрабатывает текстовые и JSON ответы в пределах лимита', () => {
    assert.equal(
      shouldProcessResponse(
        'application/json; charset=utf-8',
        'https://api.vk.com/method/audio.get',
      ),
      true,
    );
    assert.equal(shouldProcessResponse('text/html', 'https://vk.com/al_audio.php'), true);
    assert.equal(shouldProcessResponse('application/x-javascript', 'https://vk.com/data.js'), true);
  });
});
