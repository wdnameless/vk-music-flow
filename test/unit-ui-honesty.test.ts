import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it } from 'vitest';
import type { PlayerState, PlayerTrack } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf-8');

interface MockEvent {
  type: string;
  target?: unknown;
}

// Lightweight DOM node shim for Node test environment
class FakeClassList {
  private classes = new Set<string>();
  constructor(initial = '') {
    initial.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
  }
  add(...names: string[]) {
    names.forEach((n) => this.classes.add(n));
  }
  remove(...names: string[]) {
    names.forEach((n) => this.classes.delete(n));
  }
  toggle(name: string, force?: boolean): boolean {
    if (force !== undefined) {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }
  contains(name: string): boolean {
    return this.classes.has(name);
  }
  toString(): string {
    return [...this.classes].join(' ');
  }
}

class FakeElement {
  tagName: string;
  id = '';
  className = '';
  classList: FakeClassList;
  dataset: Record<string, string> = {};
  style: { setProperty: (k: string, v: string) => void; [k: string]: string | ((k: string, v: string) => void) } = {
    setProperty: (k: string, v: string) => {
      (this.style as Record<string, string>)[k] = v;
    },
  };
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  listeners: Record<string, ((e: MockEvent) => void)[]> = {};
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  private _textContent = '';
  private _innerHTML = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
  }

  get textContent(): string {
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = String(v);
    this._innerHTML = String(v);
    this.children = [];
  }

  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
    this._textContent = v.replace(/<[^>]+>/g, '');
    this.children = [];
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'class') {
      this.className = value;
      this.classList = new FakeClassList(value);
    }
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, g: string) => g.toUpperCase());
      this.dataset[key] = value;
    }
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(type: string, fn: (e: MockEvent) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(event: MockEvent): void {
    event.target = event.target || this;
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
    if (this.parentNode) {
      this.parentNode.dispatchEvent(event);
    }
  }

  click(): void {
    this.dispatchEvent({ type: 'click', target: this });
  }

  appendChild(child: FakeElement): void {
    child.parentNode = this;
    this.children.push(child);
  }

  insertBefore(child: FakeElement, before: FakeElement | null): void {
    child.parentNode = this;
    const idx = before ? this.children.indexOf(before) : -1;
    if (idx >= 0) this.children.splice(idx, 0, child);
    else this.children.push(child);
  }

  prepend(child: FakeElement): void {
    child.parentNode = this;
    this.children.unshift(child);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 ? this.parentNode.children[idx + 1] ?? null : null;
  }

  closest(selector: string): FakeElement | null {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.classList.contains(cls)) return this;
    } else if (selector.startsWith('[')) {
      const attr = selector.replace(/[[\]]/g, '').split('=')[0]!;
      if (this.attributes[attr] !== undefined || this.dataset[attr.replace(/^data-/, '')] !== undefined) return this;
    }
    return this.parentNode ? this.parentNode.closest(selector) : null;
  }

  querySelector(selector: string): FakeElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const check = (el: FakeElement) => {
      if (selector.startsWith('#')) {
        if (el.id === selector.slice(1)) result.push(el);
      } else if (selector.startsWith('.')) {
        const parts = selector.split('.').filter(Boolean);
        if (parts.every((p) => el.classList.contains(p))) result.push(el);
      } else if (selector.startsWith('[')) {
        const attr = selector.replace(/[[\]]/g, '').split('=')[0]!;
        if (el.attributes[attr] !== undefined || el.dataset[attr.replace(/^data-/, '')] !== undefined) result.push(el);
      } else if (el.tagName.toLowerCase() === selector.toLowerCase()) {
        result.push(el);
      }
      for (const c of el.children) check(c);
    };
    for (const c of this.children) check(c);
    return result;
  }
}

function parseHtmlIntoElements(html: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  const regex = /<([a-zA-Z0-9]+)\s+([^>]*id="([^"]+)"[^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const tagName = m[1]!;
    const attrs = m[2]!;
    const id = m[3]!;
    const el = new FakeElement(tagName);
    el.id = id;
    const classMatch = /class="([^"]+)"/.exec(attrs);
    if (classMatch?.[1]) {
      el.className = classMatch[1];
      el.classList = new FakeClassList(classMatch[1]);
    }
    const datasetMatches = attrs.matchAll(/data-([a-zA-Z0-9-]+)="([^"]+)"/g);
    for (const dm of datasetMatches) {
      if (dm[1] && dm[2]) el.setAttribute(`data-${dm[1]}`, dm[2]);
    }
    elements.set(id, el);
  }
  // The flat regex loses nesting and the .view-notice <p> tags carry no id,
  // so create one FakeElement per notice and attach it to its <section>.
  const sectionRe = /<section[^>]*id="(view-[^"]+)"[^>]*>([\s\S]*?)(?=<section[^>]*id="view-|$)/g;
  let sm: RegExpExecArray | null;
  while ((sm = sectionRe.exec(html)) !== null) {
    const section = elements.get(sm[1]!);
    if (!section) continue;
    const count = (sm[2]!.match(/view-notice/g) || []).length;
    for (let i = 0; i < count; i++) {
      const p = new FakeElement('p');
      p.classList = new FakeClassList('view-notice meta');
      p.hidden = true;
      section.appendChild(p);
    }
  }
  return elements;
}

interface SentMessage {
  t?: string;
  kind?: string;
  id?: string;
  key?: string;
  liked?: boolean;
}

let sentMessages: SentMessage[] = [];
const elementsMap = parseHtmlIntoElements(POPUP_HTML);
const documentBody = new FakeElement('body');
for (const el of elementsMap.values()) {
  documentBody.appendChild(el);
}

// Add nav-item elements with dataset.view
['home', 'my', 'explore', 'search', 'radio', 'updates', 'downloads', 'settings'].forEach((v) => {
  const nav = new FakeElement('button');
  nav.className = 'nav-item' + (v === 'home' ? ' active' : '');
  nav.classList = new FakeClassList(nav.className);
  nav.setAttribute('data-view', v);
  documentBody.appendChild(nav);
});

// Setup global mock DOM
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis as unknown as Record<string, unknown>;
(g.window as Record<string, unknown>).addEventListener = () => {};
g.location = { search: '' };
g.document = {
  body: documentBody,
  getElementById: (id: string) => elementsMap.get(id) ?? null,
  querySelector: (sel: string) => documentBody.querySelector(sel),
  querySelectorAll: (sel: string) => documentBody.querySelectorAll(sel),
  createElement: (tag: string) => new FakeElement(tag),
  addEventListener: () => {},
  activeElement: null,
};
g.chrome = {
  runtime: {
    sendMessage: (msg: SentMessage) => {
      sentMessages.push(msg);
      if (msg.t === 'P_PLATFORMS') {
        return Promise.resolve({ ok: true, platforms: [{ id: 'vk', label: 'ВКонтакте', available: true }] });
      }
      if (msg.t === 'P_AUTH') {
        return Promise.resolve({ ok: true, status: { signedIn: true, userId: 123456 } });
      }
      if (msg.t === 'P_LIST') {
        return Promise.resolve({ ok: true, tracks: [] });
      }
      if (msg.t === 'GET_BLOCK_RULES') {
        return Promise.resolve({ ok: true, rules: { blockedArtists: [], disliked: ['123_456'] } });
      }
      if (msg.t === 'P_LIKE') {
        return Promise.resolve({ ok: true });
      }
      if (msg.t === 'TOGGLE_DISLIKE') {
        return Promise.resolve({ ok: true, disliked: true });
      }
      if (msg.t === 'GET_STORAGE_STATE') {
        return Promise.resolve({ ok: true, journal: { queued: 0, downloading: 0 }, doneCount: 0, queue: [], failed: [], playlists: {} });
      }
      if (msg.t === 'GET_PROXY_STATE') {
        return Promise.resolve({ ok: true, settings: { mode: 'off', entries: [], activeId: null }, applied: { mode: 'off', proxyFor: null, error: null } });
      }
    },
    onMessage: { addListener: () => {} },
  },
  windows: { getCurrent: () => Promise.resolve({ id: 1 }), create: () => Promise.resolve({}) },
  sidePanel: { open: () => Promise.resolve({}) },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve({}) },
  extension: { getViews: () => [] },
};

// Dynamic import required because mock DOM globals must be in place before popup module evaluation
let popup: typeof import('../src/popup/popup.js');

beforeAll(async () => {
  popup = await import('../src/popup/popup.js');
});

describe('S1 UI-Honesty (T1.1 - T1.4)', () => {
  it('T1.1: openView("my") sends exactly one default list request and handles tracks/empty state [R01]', async () => {
    sentMessages = [];
    await popup.openView('my');

    const listRequests = sentMessages.filter((m) => m.t === 'P_LIST');
    assert.equal(listRequests.length, 1, 'openView("my") must issue exactly one list request');
    assert.equal(listRequests[0]?.kind, 'my-tracks', 'default list for my is my-tracks');

    const viewMy = elementsMap.get('view-my');
    assert.ok(viewMy?.classList.contains('active'), 'view-my is active');

    const myTracks = elementsMap.get('myTracks');
    assert.ok(myTracks?.innerHTML.includes('meta'), 'empty tracks render empty state meta message');
  });

  it('T1.1: openView("radio") sends exactly one default list request and handles empty state [R02]', async () => {
    sentMessages = [];
    await popup.openView('radio');

    const listRequests = sentMessages.filter((m) => m.t === 'P_LIST');
    assert.equal(listRequests.length, 1, 'openView("radio") must issue exactly one list request');
    assert.equal(listRequests[0]?.kind, 'recommendations', 'default list for radio is recommendations');
    assert.equal(listRequests[0]?.id, 'mix', 'default radio query is mix');

    const viewRadio = elementsMap.get('view-radio');
    assert.ok(viewRadio?.classList.contains('active'), 'view-radio is active');

    const radioTracks = elementsMap.get('radioTracks');
    assert.ok(radioTracks?.innerHTML.includes('meta'), 'empty radio tracks render empty state meta message');
  });

  it('T1.2: Mix and Recs buttons make distinct queries and toggle active chip [R04]', async () => {
    sentMessages = [];
    const btnMix = elementsMap.get('btnMix')!;
    const btnRecs = elementsMap.get('btnRecs')!;

    btnMix.click();
    await Promise.resolve();
    assert.ok(btnMix.classList.contains('active'), 'btnMix has active class');
    assert.ok(!btnRecs.classList.contains('active'), 'btnRecs lost active class');

    const mixReq = sentMessages[sentMessages.length - 1];
    assert.equal(mixReq?.kind, 'recommendations');
    assert.equal(mixReq?.id, 'mix', 'btnMix query id is mix');

    sentMessages = [];
    btnRecs.click();
    await Promise.resolve();
    assert.ok(btnRecs.classList.contains('active'), 'btnRecs has active class');
    assert.ok(!btnMix.classList.contains('active'), 'btnMix lost active class');

    const recsReq = sentMessages[sentMessages.length - 1];
    assert.equal(recsReq?.kind, 'recommendations');
    assert.equal(recsReq?.id, 'recs', 'btnRecs query id is recs');
    assert.notEqual(mixReq?.id, recsReq?.id, 'queries must be distinct');
  });

  it('T1.2: homeHero listener is attached once and does not duplicate on repeated loadHome [R03]', async () => {
    const hero = elementsMap.get('homeHero')!;
    const beforeListeners = hero.listeners['click']?.length || 0;

    await popup.loadHome();
    await popup.loadHome();
    await popup.loadHome();

    const afterListeners = hero.listeners['click']?.length || 0;
    assert.equal(afterListeners, beforeListeners, 'loadHome does not accumulate click listeners on homeHero');
  });

  it('T1.3: showNotice displays error in active view and leaves #dlNote untouched [R05]', () => {
    const dlNote = elementsMap.get('dlNote')!;
    dlNote.textContent = 'download-specific note';

    popup.showNotice('home', 'Ошибка сети');
    const viewHome = elementsMap.get('view-home')!;
    const noticeHome = viewHome.querySelector('.view-notice');
    assert.ok(noticeHome, 'view-home has a notice element');
    assert.equal(noticeHome?.textContent, 'Ошибка сети');
    assert.equal(noticeHome?.hidden, false, 'notice is visible');
    assert.equal(dlNote.textContent, 'download-specific note', '#dlNote is preserved for downloads only');

    popup.showNotice('my', 'Трек недоступен');
    const viewMy = elementsMap.get('view-my')!;
    const noticeMy = viewMy.querySelector('.view-notice');
    assert.equal(noticeMy?.textContent, 'Трек недоступен');
  });

  it('T1.4: pLike toggles via provider setLiked and updates indicator [R06]', async () => {
    const pLike = elementsMap.get('pLike')!;
    const sampleTrack: PlayerTrack = {
      key: 'vk_999_111',
      id: '111',
      owner: '999',
      artist: 'Artist',
      title: 'Title',
      url: 'https://example.com/audio.mp3',
      duration: 180,
      cover: null,
    };

    popup.setPlayerStateForTest({
      track: sampleTrack,
      index: 0,
      total: 1,
      playing: true,
      currentTime: 0,
      duration: 180,
      volume: 1,
      eqEnabled: false,
      eqBands: [],
      shuffle: false,
      repeat: 'off',
      normGainDb: 0,
      trackLufs: null,
      trackPeakDb: null,
      albumLufs: null,
      level: 0,
      levels: [0, 0],
      clipped: false,
      limiterDb: 0,
      correlation: 1,
      outputDeviceId: '',
      outputDevices: [],
      queue: [sampleTrack],
      order: [0],
    });

    // Initially unliked
    assert.equal(popup.isTrackLiked(sampleTrack), false);
    assert.ok(!pLike.classList.contains('liked'));

    // Press like -> sends liked: true
    sentMessages = [];
    pLike.click();
    await Promise.resolve();
    const likeCall = sentMessages.find((m) => m.t === 'P_LIKE');
    assert.ok(likeCall);
    assert.equal(likeCall?.liked, true, 'first click likes track');
    assert.equal(popup.isTrackLiked(sampleTrack), true);
    assert.ok(pLike.classList.contains('liked'), 'button indicates liked');

    // Press like again -> sends liked: false
    sentMessages = [];
    pLike.click();
    await Promise.resolve();
    const unlikeCall = sentMessages.find((m) => m.t === 'P_LIKE');
    assert.ok(unlikeCall);
    assert.equal(unlikeCall?.liked, false, 'second click unlikes track');
    assert.equal(popup.isTrackLiked(sampleTrack), false);
    assert.ok(!pLike.classList.contains('liked'), 'button indicates unliked');
  });

  it('T1.4: both like and dislike indicators sync on track change [R07]', () => {
    const pLike = elementsMap.get('pLike')!;
    const pDislike = elementsMap.get('pDislike')!;

    const trackLiked: PlayerTrack = {
      key: 'vk_123456_1', // userId is 123456 in auth mock -> liked
      id: '1',
      owner: '123456',
      artist: 'A',
      title: 'T1',
      url: 'https://example.com/1.mp3',
      duration: 100,
      cover: null,
    };

    const trackDisliked: PlayerTrack = {
      key: 'vk_123_456', // in disliked mock -> disliked
      id: '456',
      owner: '123',
      artist: 'B',
      title: 'T2',
      url: 'https://example.com/2.mp3',
      duration: 100,
      cover: null,
    };

    const dummyState: PlayerState = {
      track: trackLiked,
      index: 0,
      total: 2,
      playing: true,
      currentTime: 0,
      duration: 100,
      volume: 1,
      eqEnabled: false,
      eqBands: [],
      shuffle: false,
      repeat: 'off',
      normGainDb: 0,
      trackLufs: null,
      trackPeakDb: null,
      albumLufs: null,
      level: 0,
      levels: [0, 0],
      clipped: false,
      limiterDb: 0,
      correlation: 1,
      outputDeviceId: '',
      outputDevices: [],
      queue: [trackLiked, trackDisliked],
      order: [0, 1],
    };

    // Playing trackLiked
    popup.setPlayerStateForTest(dummyState);
    assert.ok(pLike.classList.contains('liked'), 'pLike is active for user track');
    assert.ok(!pDislike.classList.contains('liked'), 'pDislike is inactive');

    // Switch to trackDisliked
    popup.setPlayerStateForTest({ ...dummyState, track: trackDisliked, index: 1 });
    assert.ok(!pLike.classList.contains('liked'), 'pLike is inactive for disliked track');
    assert.ok(pDislike.classList.contains('liked'), 'pDislike is active for disliked track');

    // Switch to null
    popup.setPlayerStateForTest({ ...dummyState, track: null });
    assert.ok(!pLike.classList.contains('liked'), 'pLike is inactive when null');
    assert.ok(!pDislike.classList.contains('liked'), 'pDislike is inactive when null');
  });
});
