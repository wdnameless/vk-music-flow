import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { transform } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Port of the browser-level checks that passed against the v0.2.2 prototype:
// drives test/mock/hook.html and test/mock/collector.html in a local Chromium
// with the (TypeScript) content scripts compiled on the fly via esbuild.
// 13 checks total (9 hook + 4 collector), behavior parity with baseline.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOCK_DIR = path.join(HERE, 'mock');

const CHROMIUM_EXE =
  process.env.VMF_CHROMIUM_EXE || 'D:\\progg\\pw-browsers\\chromium-1234\\chrome-win64\\chrome.exe';
const hasChromium = existsSync(CHROMIUM_EXE);
const isCI = !!process.env.CI;

interface HookAudio {
  key: string;
  id: string;
  owner: string;
  artist: string;
  title: string;
  album: string;
  duration: number | null;
  urls: string[];
  covers: string[];
}

interface HookSnapshot {
  installed: boolean;
  audios: HookAudio[];
  lyrics: Record<string, string> | null;
  stats: { responses: number; parsed: number; found: number; embedded: number } | null;
  statsReply: { responses: number; parsed: number; found: number; embedded: number } | null;
}

interface CollectorSnapshot {
  installed: boolean;
  scan: { count?: number; name?: string; error?: string } | null;
  sent: Array<{ t?: string; pl?: string; scanning?: boolean; audios?: HookAudio[] }>;
}

const hook: HookSnapshot = {
  installed: false,
  audios: [],
  lyrics: null,
  stats: null,
  statsReply: null,
};
const collector: CollectorSnapshot = { installed: false, scan: null, sent: [] };

let server: Server;
let port = 0;
let browser: Browser | null = null;

async function compiledScript(name: 'hook-main' | 'collector'): Promise<string> {
  const src = await readFile(path.join(ROOT, 'src', 'content', `${name}.ts`), 'utf8');
  const out = await transform(src, { loader: 'ts', format: 'iife', target: 'es2020' });
  return out.code;
}

const compiled: Record<string, string> = {};

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        const p = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
        if (p === '/src/content/hook-main.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(compiled['hook-main']);
          return;
        }
        if (p === '/src/content/collector.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(compiled['collector']);
          return;
        }
        const file = path.basename(p);
        if (file.endsWith('.html')) {
          const html = await readFile(path.join(MOCK_DIR, file));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      } catch {
        res.writeHead(500);
        res.end('error');
      }
    });
    server.on('error', reject);
    // dynamic, free port (never assume defaults)
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

const describeB = hasChromium
  ? describe
  : // On CI the browser suite must actually run: provisioning lives in
    // .github/workflows/ci.yml, and a missing binary is a hard failure there,
    // never a silent skip. Locally (binary at the default path absent) skip.
    isCI
    ? describe
    : describe.skip;

describeB('browser: acquisition on real Chromium (mocks)', () => {
  beforeAll(async () => {
    if (!hasChromium) {
      // only reachable on CI (locally the suite is describe.skip'd)
      throw new Error(
        `CI must run the 13 browser checks, but no Chromium binary found at ` +
          `"${CHROMIUM_EXE}" (VMF_CHROMIUM_EXE=${process.env.VMF_CHROMIUM_EXE ?? '<unset>'}). ` +
          `Check the "Provision Chromium" CI step.`
      );
    }
    compiled['hook-main'] = await compiledScript('hook-main');
    compiled['collector'] = await compiledScript('collector');
    await startServer();
    browser = await chromium.launch({ executablePath: CHROMIUM_EXE, headless: true });

    // --- hook.html ---
    const ctx: BrowserContext = await browser.newContext();
    const page: Page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/hook.html`, { waitUntil: 'load' });
    // wait until the hook debounces its AUDIOS emit (300ms) and bridge records
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __got?: { audios: unknown[] } };
        return !!w.__got && w.__got.audios.length >= 2;
      },
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(400);
    Object.assign(
      hook,
      await page.evaluate(() => {
        const w = window as unknown as {
          __VKMF__?: boolean;
          __vkmfStats?: HookSnapshot['stats'];
          __got: { audios: HookAudio[]; lyrics: Record<string, string> | null };
        };
        return {
          installed: w.__VKMF__ === true,
          audios: w.__got.audios,
          lyrics: w.__got.lyrics,
          stats: w.__vkmfStats ? { ...w.__vkmfStats } : null,
        };
      }),
    );
    // request the EMBEDDED scan round-trip (STATS reply via postMessage)
    hook.statsReply = await page.evaluate(
      () =>
        new Promise<{ responses: number; parsed: number; found: number; embedded: number } | null>(
          (resolve) => {
            const on = (e: MessageEvent) => {
              const d = e.data;
              if (d && d.src === 'VKMF' && d.t === 'STATS') {
                window.removeEventListener('message', on);
                resolve(d.p);
              }
            };
            window.addEventListener('message', on);
            window.postMessage({ src: 'VKMF_REQ', t: 'EMBEDDED' }, '*');
            setTimeout(() => resolve(null), 5000);
          },
        ),
    );
    await ctx.close();

    // --- collector.html ---
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(`http://127.0.0.1:${port}/collector.html`, { waitUntil: 'load' });
    collector.installed = await page2.evaluate(
      () => (window as unknown as { __VKMF_COLLECTOR__?: boolean }).__VKMF_COLLECTOR__ === true,
    );
    collector.scan = await page2.evaluate(
      () =>
        (
          window as unknown as { __runScan?: () => Promise<CollectorSnapshot['scan']> }
        ).__runScan?.() ?? Promise.resolve(null),
    );
    collector.sent = await page2.evaluate(() =>
      ((window as unknown as { __sent?: CollectorSnapshot['sent'] }).__sent ?? []).map((m) => ({
        ...m,
        audios: m.audios ? [...m.audios] : undefined,
      })),
    );
    await ctx2.close();
  }, 120_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  // ----- hook checks (9) -----
  it('B1: hook установлен и не дублируется', () => {
    expect(hook.installed).toBe(true);
  });

  it('B2: обе сетки перехвачены (fetch + XHR) — responses >= 2', () => {
    expect(hook.stats).toBeTruthy();
    expect(hook.stats!.responses).toBeGreaterThanOrEqual(2);
    expect(hook.stats!.parsed).toBeGreaterThanOrEqual(2);
  });

  it('B3: собраны ровно два трека (дедуп по key)', () => {
    const keys = hook.audios.map((a) => a.key).sort();
    expect(keys).toEqual(['55_101', '55_102']);
  });

  it('B4: 55_101 — artist/title/album из плоскового поля', () => {
    const a = hook.audios.find((x) => x.key === '55_101');
    expect(a).toBeTruthy();
    expect([a!.artist, a!.title, a!.album]).toEqual(['Кино', 'Группа крови', 'Альбом']);
    expect(a!.duration).toBe(289);
  });

  it('B5: 55_101 — прямой mp3 url собран', () => {
    const a = hook.audios.find((x) => x.key === '55_101');
    expect(a!.urls.some((u) => u === 'https://cs1-1.vk-cdn.net/mp3/x.mp3')).toBe(true);
  });

  it('B6: 55_101 — обложки отсортированы по размеру (крупная первой)', () => {
    const a = hook.audios.find((x) => x.key === '55_101');
    expect(a!.covers.length).toBe(2);
    expect(a!.covers[0]).toContain('big_600x600');
    expect(a!.covers[1]).toContain('small_300x300');
  });

  it('B7: 55_102 — fallback на main_artists и сбор hls url', () => {
    const a = hook.audios.find((x) => x.key === '55_102');
    expect(a!.artist).toBe('Мастер');
    expect(a!.duration).toBe(180);
    expect(a!.urls.some((u) => u === 'https://userapi.com/hls/index.m3u8')).toBe(true);
  });

  it('B8: тексты песен мостятся через LYRICS', () => {
    expect(hook.lyrics).toBeTruthy();
    expect(hook.lyrics!['101']).toContain('текст песни длиннее тридцати символов');
  });

  it('B9: STATS answer на EMBEDDED-запрос', () => {
    expect(hook.statsReply).toBeTruthy();
    expect(hook.statsReply!.responses).toBeGreaterThanOrEqual(2);
    expect(hook.statsReply!.found).toBeGreaterThanOrEqual(2);
    expect(hook.statsReply!.embedded).toBe(0); // in this fixture no inline '"artist"' payload scripts
  });

  // ----- collector checks (4) -----
  it('B10: collector установлен', () => {
    expect(collector.installed).toBe(true);
  });

  it('B11: имя плейлиста взято со страницы', () => {
    expect(collector.scan).toBeTruthy();
    expect(collector.scan!.error).toBeUndefined();
    expect(collector.scan!.name).toBe('Рок классика');
  });

  it('B12: автоскролл досканировал все 40 строк', () => {
    expect(collector.scan!.count).toBe(40);
  });

  it('B13: все ключи 77_0..77_39 релеятся в SW сообщениями AUDIOS с pl+scanning', () => {
    const scanRelays = collector.sent.filter(
      (m) => m.t === 'AUDIOS' && m.pl === 'Рок классика' && m.scanning === true,
    );
    const keys = new Set(scanRelays.flatMap((m) => (m.audios ?? []).map((a) => a.key)));
    expect(keys.size).toBe(40);
    expect(keys.has('77_0') && keys.has('77_39')).toBe(true);
  });
});
