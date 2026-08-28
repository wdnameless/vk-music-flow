(() => {
  if (window.__VKMF__) return;
  window.__VKMF__ = true;

  const post = (t, p) => window.postMessage({ src: 'VKMF', t, p }, '*');
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  const stats = { responses: 0, parsed: 0, found: 0, embedded: 0 };
  window.__vkmfStats = stats;

  const samples = [];
  function pushSample(url, req, text) {
    if (!text) return;
    if (!(text.includes('"artist"') || text.includes('"main_artists"') || text.includes('"audios_ids"') || text.includes('"duration"'))) return;
    samples.push({ url: String(url).slice(0, 200), req: String(req || '').slice(0, 3000), text: text.slice(0, 300000) });
    if (samples.length > 3) samples.shift();
  }

  function collectUrls(node, acc, d = 0) {
    if (!node || d > 6) return acc;
    if (typeof node === 'string') {
      if (/^https?:\/\//.test(node) && /(vk-cdn|userapi|mycdn|vkuser|\.mp3|\.m3u8|\/audio)/i.test(node)) acc.push(node);
      return acc;
    }
    if (typeof node === 'object') for (const k in node) collectUrls(node[k], acc, d + 1);
    return acc;
  }

  function harvest(root) {
    const out = [];
    const lyr = {};
    (function walk(n, d = 0) {
      if (!n || d > 12) return;
      if (typeof n === 'string') {
        if (n.length > 20 && (n[0] === '{' || n[0] === '[')) {
          try { walk(JSON.parse(n), d + 1); } catch { }
        }
        return;
      }
      if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return; }
      if (typeof n !== 'object') return;
      let artist = str(n.artist);
      if (!artist && Array.isArray(n.main_artists) && n.main_artists[0]) artist = str(n.main_artists[0].name);
      if (!artist && Array.isArray(n.mainArtists) && n.mainArtists[0]) artist = str(n.mainArtists[0].name);
      const title = str(n.title);
      if (artist && title && (n.duration || n.url || n.hls)) {
        const id = n.id ?? n.audio_id ?? n.audioId;
        const owner = n.owner_id ?? n.ownerId;
        if (id != null && owner != null) {
          const urls = [...new Set(collectUrls(n, []))];
          const covers = [];
          const al = n.album ?? (Array.isArray(n.albums) ? n.albums[0] : null);
          if (al) {
            const th = al.thumbs ?? al.thumb ?? al.covers;
            if (Array.isArray(th)) th.forEach(x => x && x.src && covers.push(x.src));
            else if (th && th.src) covers.push(th.src);
            const px = (u) => { const m = u.match(/(\d+)x(\d+)/); return m ? (+m[1]) * (+m[2]) : 0; };
            covers.sort((a, b) => px(b) - px(a));
          }
          out.push({
            key: `${owner}_${id}`,
            id: String(id),
            owner: String(owner),
            artist,
            title,
            album: str(al && al.title),
            year: n.year ?? (al && al.year) ?? null,
            duration: n.duration ?? null,
            urls,
            covers
          });
        }
      }
      const lid = n.id ?? n.audio_id ?? n.audioId;
      if (typeof n.lyrics === 'string' && n.lyrics.length > 30 && lid != null) {
        lyr[String(lid)] = n.lyrics;
      }
      for (const k in n) walk(n[k], d + 1);
    })(root);
    return { out, lyr };
  }

  const seen = new Set();
  let buf = [];
  let flushT = null;
  function emit(items) {
    for (const a of items) {
      if (!seen.has(a.key)) { seen.add(a.key); buf.push(a); }
    }
    clearTimeout(flushT);
    flushT = setTimeout(() => {
      if (buf.length) { post('AUDIOS', buf); buf = []; }
    }, 300);
  }

  function handleText(url, req, text) {
    stats.responses++;
    if (!text || text.length < 50 || text.length > 8e6) return;
    pushSample(url, req, text);
    try {
      const j = JSON.parse(text);
      const { out, lyr } = harvest(j);
      stats.parsed++;
      if (out.length) { stats.found += out.length; emit(out); }
      if (Object.keys(lyr).length) post('LYRICS', lyr);
    } catch { }
  }

  function balancedFrom(text, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function extractEmbedded(text) {
    const found = [];
    const needle = '"artist"';
    let i = 0;
    let guard = 0;
    while ((i = text.indexOf(needle, i)) !== -1 && guard < 2000) {
      guard++;
      let s = -1;
      for (let j = i; j >= Math.max(0, i - 300); j--) {
        if (text[j] === '{') { s = j; break; }
      }
      if (s !== -1) {
        const frag = balancedFrom(text, s);
        if (frag && frag.length < 100000) {
          try {
            const { out, lyr } = harvest(JSON.parse(frag));
            found.push(...out);
            if (Object.keys(lyr).length) post('LYRICS', lyr);
          } catch { }
        }
      }
      i += needle.length;
    }
    return found;
  }

  function scanEmbeddedScripts() {
    let n = 0;
    document.querySelectorAll('script').forEach(s => {
      const t = s.textContent || '';
      if (t.length > 100 && t.length < 6e6 && t.includes('"artist"')) {
        const items = extractEmbedded(t);
        n += items.length;
        if (items.length) { stats.found += items.length; emit(items); }
      }
    });
    stats.embedded = n;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.src !== 'VKMF_REQ') return;
    if (e.data.t === 'EMBEDDED') {
      scanEmbeddedScripts();
      post('STATS', { ...stats });
    } else if (e.data.t === 'SAMPLES') {
      post('SAMPLES', samples);
    }
  });

  const of = window.fetch;
  if (of) {
    window.fetch = async (...a) => {
      const r = await of.apply(window, a);
      try {
        const reqBody = a[1] && (a[1].body || a[1].params) || '';
        r.clone().text().then(t => handleText(a[0] && a[0].url || String(a[0]), reqBody, t)).catch(() => { });
      } catch { }
      return r;
    };
  }

  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__vkmfUrl = String(u);
    return oo.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        const rt = this.responseType;
        if (rt === '' || rt === 'text') handleText(this.__vkmfUrl, a[0], this.responseText);
        else if (rt === 'json' && this.response) handleText(this.__vkmfUrl, a[0], JSON.stringify(this.response));
      } catch { }
    });
    return os.apply(this, a);
  };
})();
