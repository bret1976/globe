/**
 * Historical ADS-B extraction from the ADSB.lol `globe_history_<year>` daily
 * dumps (https://github.com/adsblol — data ODbL / CC0 per release LICENSE).
 *
 * Each UTC day is published as a GitHub release holding a split tar
 * (`.tar.aa`, `.tar.ab`, …) of readsb `traces/xx/trace_full_<hex>.json`
 * files. We stream the parts in order through a minimal tar reader and keep
 * only rows that fall inside the requested bbox + time window. Nothing is
 * interpolated or invented: every point returned is a recorded position.
 */
import zlib from 'node:zlib';

const UA = { 'User-Agent': 'gods-eye-view-replay (+https://github.com/bret1976/globe)' };

/** Resolve the release assets for one UTC date (YYYY-MM-DD). */
export async function resolveAdsbLolRelease(date, fetchImpl = fetch) {
  const [y, m, d] = date.split('-');
  const repo = `adsblol/globe_history_${y}`;
  for (const suffix of ['0', '1', '2']) {
    const tag = `v${y}.${m}.${d}-planes-readsb-prod-${suffix}`;
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: { ...UA, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub release lookup failed (${res.status})`);
    const rel = await res.json();
    const assets = (rel.assets || [])
      .filter((a) => /\.tar(\.[a-z]{2})?$/.test(a.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
    if (assets.length) return { repo, tag, assets, html: rel.html_url };
  }
  return null;
}

/** Minimal streaming tar reader; calls onFile(name, Buffer) for regular files. */
export function createTarReader(onFile) {
  let buf = Buffer.alloc(0);
  let want = 512; // bytes needed for current state
  let state = 'header';
  let name = '';
  let size = 0;
  let longName = null;
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= want) {
      if (state === 'header') {
        const h = buf.subarray(off, off + 512);
        off += 512;
        if (h[0] === 0) continue; // padding / end blocks
        const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
        const sizeField = h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
        size = parseInt(sizeField || '0', 8) || 0;
        const type = String.fromCharCode(h[156] || 48);
        name = longName || (prefix ? `${prefix}/${rawName}` : rawName);
        longName = null;
        state = type === 'L' ? 'longname' : type === '0' || type === '\0' ? 'file' : 'skip';
        want = Math.ceil(size / 512) * 512;
        if (want === 0) { state = 'header'; want = 512; }
      } else {
        const body = buf.subarray(off, off + size);
        off += want;
        if (state === 'longname') longName = body.toString('utf8').replace(/\0.*$/s, '');
        else if (state === 'file') onFile(name, body);
        state = 'header';
        want = 512;
      }
    }
    buf = off ? buf.subarray(off) : buf;
    if (off && buf.length < 4096) buf = Buffer.from(buf); // drop ref to big chunk
  };
}

function latNeedles(s, n) {
  const out = [];
  for (let d = Math.floor(s); d <= Math.floor(n); d++) out.push(d >= 0 ? `,${d}.` : `,-${-(d + 1)}.`);
  return out;
}

/**
 * Parse one readsb trace_full file and clip it to bbox/time.
 * @returns {?object} compact track or null
 */
export function clipTrace(raw, { bbox, t0, t1, minStep = 4, needles }) {
  let text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  text = text.toString('utf8');
  if (needles && !needles.some((n) => text.includes(n))) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const base = j.timestamp;
  const [w, s, e, n] = bbox;
  const pts = [];
  let cs = '';
  let lastT = -1e9;
  for (const r of j.trace || []) {
    const t = base + r[0];
    if (r[8] && r[8].flight && !cs) cs = String(r[8].flight).trim();
    if (t < t0 || t > t1) continue;
    const lat = r[1], lon = r[2];
    if (lat < s || lat > n || lon < w || lon > e) continue;
    if (r[8] && r[8].flight) cs = String(r[8].flight).trim();
    if (t - lastT < minStep) continue;
    lastT = t;
    const alt = r[3] === 'ground' ? 0 : Number.isFinite(r[3]) ? r[3] : (Number.isFinite(r[10]) ? r[10] : null);
    pts.push([Math.round(t - t0), +lat.toFixed(5), +lon.toFixed(5), alt, r[4] == null ? null : Math.round(r[4]), r[5] == null ? null : Math.round(r[5])]);
  }
  if (pts.length < 2) return null;
  return {
    hex: j.icao, cs: cs || null, reg: j.r || null, type: j.t || null, desc: j.desc || null,
    mil: Boolean((j.dbFlags || 0) & 1), pts,
  };
}

/**
 * Stream one day and return tracks inside bbox [w,s,e,n] between t0..t1 (epoch s).
 */
export async function extractAdsbLolDay({ date, bbox, t0, t1, maxTracks = 1500, onProgress, signal, fetchImpl = fetch }) {
  const rel = await resolveAdsbLolRelease(date, fetchImpl);
  if (!rel) return { ok: false, reason: `ADSB.lol has no globe_history release for ${date}` };
  const total = rel.assets.reduce((a, x) => a + x.size, 0);
  const needles = latNeedles(bbox[1], bbox[3]);
  const tracks = [];
  let files = 0;
  let seen = 0;
  const push = createTarReader((name, body) => {
    if (!name.includes('trace_full_')) return;
    files++;
    if (tracks.length >= maxTracks) return;
    try {
      const tr = clipTrace(body, { bbox, t0, t1, needles });
      if (tr) tracks.push(tr);
    } catch { /* corrupt member: skip */ }
  });
  for (const asset of rel.assets) {
    // GitHub's CDN occasionally drops multi-GB streams; resume with Range.
    let got = 0;
    let lastReport = 0;
    for (let attempt = 0; got < asset.size; attempt++) {
      try {
        const headers = got ? { ...UA, Range: `bytes=${got}-` } : UA;
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        let idle = setTimeout(() => ac.abort(), 30_000);
        const res = await fetchImpl(asset.url, { headers, signal: ac.signal, redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`download ${asset.name} failed (${res.status})`);
        if (got && res.status !== 206) throw new Error('server ignored Range on resume');
        for await (const chunk of res.body) {
          clearTimeout(idle);
          idle = setTimeout(() => ac.abort(), 30_000); // stalled stream → resume
          got += chunk.length;
          seen += chunk.length;
          push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if (onProgress && seen - lastReport > 25e6) { lastReport = seen; onProgress({ bytes: seen, total, files, tracks: tracks.length }); }
        }
        clearTimeout(idle);
        signal?.removeEventListener('abort', onAbort);
        if (got < asset.size) throw new Error('short read');
      } catch (err) {
        if (signal?.aborted || attempt >= 8 || /ignored Range|failed \(4/.test(err.message)) throw err;
        console.warn(`[replay] ${asset.name} interrupted at ${got} (${err.message}); resuming`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  return {
    ok: true,
    source: { name: 'ADSB.lol globe_history', release: rel.tag, url: rel.html, license: 'ODbL 1.0 (ADSB.lol); release LICENSE-cc0' },
    scannedFiles: files, truncated: tracks.length >= maxTracks, tracks,
  };
}
