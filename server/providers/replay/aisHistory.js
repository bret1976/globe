/**
 * Historical AIS from NOAA / BOEM MarineCadastre daily US AIS files
 * (https://coast.noaa.gov/htdata/CMSP/AISDataHandler/<year>/AIS_<y>_<m>_<d>.zip,
 * public domain, US waters only, published with a long delay — currently
 * through 2024). We stream the zip, inflate the single CSV member on the fly
 * and keep rows in bbox/time. Recorded positions only; nothing interpolated.
 */
import zlib from 'node:zlib';

export function marineCadastreUrl(date) {
  const [y, m, d] = date.split('-');
  return `https://coast.noaa.gov/htdata/CMSP/AISDataHandler/${y}/AIS_${y}_${m}_${d}.zip`;
}

export async function extractMarineCadastreDay({ date, bbox, t0, t1, minStep = 20, maxVessels = 800, onProgress, signal, fetchImpl = fetch }) {
  const url = marineCadastreUrl(date);
  const res = await fetchImpl(url, { signal, redirect: 'follow' });
  if (res.status === 404) return { ok: false, reason: `NOAA MarineCadastre has no AIS file for ${date} (published through 2024 at time of writing)` };
  if (!res.ok || !res.body) throw new Error(`AIS download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const [w, s, e, n] = bbox;
  const vessels = new Map();
  let head = Buffer.alloc(0);
  let inflater = null;
  let tail = '';
  let header = null;
  let seen = 0;
  let lastReport = 0;
  let done = false;
  const onLines = (text) => {
    const lines = (tail + text).split('\n');
    tail = lines.pop();
    for (const line of lines) {
      if (!header) { header = line.trim().split(','); continue; }
      const c = line.split(',');
      const lat = +c[2], lon = +c[3];
      if (!(lat >= s && lat <= n && lon >= w && lon <= e)) continue;
      const t = Date.parse(c[1] + 'Z') / 1000;
      if (!(t >= t0 && t <= t1)) continue;
      const mmsi = c[0];
      let v = vessels.get(mmsi);
      if (!v) {
        if (vessels.size >= maxVessels) continue;
        v = { mmsi, name: c[7] || null, imo: c[8] || null, cs: c[9] || null, vtype: c[10] ? +c[10] : null, len: c[12] ? +c[12] : null, pts: [], _last: -1e9 };
        vessels.set(mmsi, v);
      }
      if (t - v._last < minStep) continue;
      v._last = t;
      v.pts.push([Math.round(t - t0), +lat.toFixed(5), +lon.toFixed(5), c[4] === '' ? null : +c[4], c[5] === '' ? null : +c[5], c[6] === '' || c[6] === '511' ? null : +c[6]]);
    }
  };
  await new Promise((resolve, reject) => {
    (async () => {
      try {
        for await (const chunk of res.body) {
          seen += chunk.length;
          if (onProgress && seen - lastReport > 25e6) { lastReport = seen; onProgress({ bytes: seen, total, vessels: vessels.size }); }
          let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (!inflater) {
            head = Buffer.concat([head, buf]);
            if (head.length < 30) continue;
            if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('AIS zip: bad local header');
            const start = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
            if (head.length < start) continue;
            inflater = zlib.createInflateRaw();
            inflater.setEncoding('utf8');
            inflater.on('data', onLines);
            inflater.on('error', (err) => (err.code === 'Z_DATA_ERROR' ? resolve() : reject(err)));
            inflater.on('end', () => { done = true; resolve(); });
            buf = head.subarray(start);
          }
          if (done) break;
          if (!inflater.write(buf)) await new Promise((r) => inflater.once('drain', r));
        }
        if (!done) inflater?.end();
        if (!inflater) resolve();
      } catch (err) { reject(err); }
    })();
  });
  const out = [...vessels.values()].filter((v) => v.pts.length >= 2).map(({ _last, ...v }) => v);
  return {
    ok: true,
    source: { name: 'NOAA/BOEM MarineCadastre AIS', url, license: 'Public domain (US Government)' },
    truncated: vessels.size >= maxVessels, vessels: out,
  };
}
