(() => {
  if (window.__VKMF_COLLECTOR__) return;
  window.__VKMF_COLLECTOR__ = true;

  let scanning = false;
  let scanName = null;
  let lastStats = null;
  let lastSamples = [];

  const relay = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => { }); } catch { }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.src !== 'VKMF') return;
    if (e.data.t === 'AUDIOS') {
      const extra = scanning && scanName ? { pl: scanName, scanning: true } : {};
      relay({ t: 'AUDIOS', audios: e.data.p, ...extra });
    } else if (e.data.t === 'LYRICS') {
      relay({ t: 'LYRICS', map: e.data.p });
    } else if (e.data.t === 'STATS') {
      lastStats = e.data.p;
    } else if (e.data.t === 'SAMPLES') {
      lastSamples = e.data.p;
    }
  });

  function domNormalize(d) {
    const idRaw = String(d.id ?? '');
    const m = idRaw.match(/^(-?\d+)_(\d+)/);
    const artist = String(d.artist || '').trim();
    const title = String(d.title || '').trim();
    if (!m || !artist || !title) return null;
    const urls = Array.isArray(d.urls)
      ? d.urls.filter(u => /^https?:\/\//.test(u))
      : (typeof d.url === 'string' && /^https?:\/\//.test(d.url) ? [d.url] : []);
    return {
      key: `${m[1]}_${m[2]}`,
      id: m[2],
      owner: m[1],
      artist,
      title,
      album: '',
      year: null,
      duration: d.duration ?? null,
      urls,
      covers: typeof d.cover_url === 'string' ? [d.cover_url] : []
    };
  }

  function domAudios() {
    const out = [];
    document.querySelectorAll('[data-audio]').forEach(el => {
      try {
        const a = domNormalize(JSON.parse(el.getAttribute('data-audio')));
        if (a) out.push(a);
      } catch { }
    });
    return out;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function bestScroller(probe) {
    let node = probe.parentElement;
    let best = null;
    let bestScore = 0;
    while (node && node !== document.body) {
      const s = node.scrollHeight - node.clientHeight;
      if (s >= 20 && (best === null || s > bestScore)) { bestScore = s; best = node; }
      node = node.parentElement;
    }
    if (best) return best;
    return document.scrollingElement;
  }

  function pageName() {
    const el = document.querySelector('[class*="playlist_title"], [data-testid="audio_page_title"], h1');
    let name = el ? el.textContent.trim() : '';
    if (!name) name = document.title.replace(/\s*\|\s*ВКонтакте.*$/i, '').trim();
    return name || 'Плейлист';
  }

  async function scan(overrideName) {
    scanName = overrideName || pageName();
    scanning = true;
    lastStats = null;
    window.postMessage({ src: 'VKMF_REQ', t: 'EMBEDDED' }, '*');
    const seenKeys = new Set();
    const probe = () => document.querySelector('[data-audio], .audio_row');
    let prev = -1;
    let stable = 0;
    const t0 = Date.now();
    try {
      while (stable < 5 && Date.now() - t0 < 240000) {
        for (const a of domAudios()) {
          if (!seenKeys.has(a.key)) {
            seenKeys.add(a.key);
            relay({ t: 'AUDIOS', audios: [a], pl: scanName, scanning: true });
          }
        }
        const p = probe();
        if (p) {
          const sc = bestScroller(p);
          try { sc.scrollTop = sc.scrollHeight; } catch { }
          window.scrollTo(0, document.documentElement.scrollHeight);
        }
        await sleep(650);
        if (seenKeys.size === prev) stable++; else stable = 0;
        prev = seenKeys.size;
      }
    } finally {
      scanning = false;
    }
    await sleep(400);
    return { count: seenKeys.size, name: scanName, stats: lastStats };
  }

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.cmd === 'PING') { reply(true); return false; }
    if (m.cmd === 'SCAN') {
      scan(m.name).then(reply).catch(e => reply({ error: String(e) }));
      return true;
    }
    if (m.cmd === 'SAMPLES') {
      window.postMessage({ src: 'VKMF_REQ', t: 'SAMPLES' }, '*');
      setTimeout(() => reply({ samples: lastSamples }), 200);
      return true;
    }
    return false;
  });

  setInterval(() => {
    if (scanning) return;
    const a = domAudios();
    if (a.length) relay({ t: 'AUDIOS', audios: a });
  }, 4000);
})();
