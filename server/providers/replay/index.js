/**
 * Historical "replay any place + time" endpoint.
 *
 *   GET /api/replay/custom?bbox=w,s,e,n&t0=<epoch s>&t1=<epoch s>
 *     → 202 {status:'running', progress} while a background job streams the
 *       ADSB.lol daily dump (≈3 GB/day) and, for ≤2024 US dates, NOAA AIS.
 *     → 200 {status:'done', replay:{…}} once cached (disk, survives restarts
 *       within one deploy).
 *
 * Limits: window ≤ 3 h, bbox ≤ 2.5° × 2.5°, date between 2023-01-01 and two
 * days ago (dumps publish the next day), one heavy job at a time.
 */
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { extractAdsbLolDay } from './adsbHistory.js';
import { extractMarineCadastreDay } from './aisHistory.js';
import { fetchHistoricalWind } from './windHistory.js';

const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'replay');
export const REPLAY_LIMITS = { maxWindowS: 3 * 3600, maxSpanDeg: 2.5, minDate: '2023-01-01' };

export function validateReplayRequest({ bbox, t0, t1 }, now = Date.now()) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((x) => !Number.isFinite(x))) return 'bbox must be w,s,e,n';
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n && s >= -85 && n <= 85 && w >= -180 && e <= 180)) return 'bbox out of range';
  if (e - w > REPLAY_LIMITS.maxSpanDeg || n - s > REPLAY_LIMITS.maxSpanDeg) return `area too large (max ${REPLAY_LIMITS.maxSpanDeg}° per side) — zoom in`;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 't0/t1 must be epoch seconds with t1 > t0';
  if (t1 - t0 > REPLAY_LIMITS.maxWindowS) return 'time window too long (max 3 h)';
  if (t0 < Date.parse(REPLAY_LIMITS.minDate) / 1000) return `history starts ${REPLAY_LIMITS.minDate}`;
  if (t1 > now / 1000 - 36 * 3600) return 'too recent — ADSB.lol daily dumps publish ~1–2 days later';
  return null;
}

const utcDays = (t0, t1) => {
  const out = [];
  for (let d = Math.floor(t0 / 86400); d <= Math.floor(t1 / 86400); d++) out.push(new Date(d * 86400e3).toISOString().slice(0, 10));
  return out;
};

export async function buildReplay({ id, title, bbox, t0, t1, onProgress = () => {}, fetchImpl = fetch }) {
  const days = utcDays(t0, t1);
  const gaps = [];
  const sources = [];
  const byHex = new Map();
  for (const [i, date] of days.entries()) {
    const r = await extractAdsbLolDay({
      date, bbox, t0, t1, fetchImpl,
      onProgress: (p) => onProgress({ stage: `ADS-B ${date} (${i + 1}/${days.length})`, pct: Math.round((100 * p.bytes) / (p.total || 1)), tracks: p.tracks }),
    });
    if (!r.ok) { gaps.push(r.reason); continue; }
    sources.push(r.source);
    if (r.truncated) gaps.push('aircraft list truncated at size limit');
    for (const tr of r.tracks) {
      const prev = byHex.get(tr.hex);
      if (prev) { prev.pts = prev.pts.concat(tr.pts).sort((a, b) => a[0] - b[0]); prev.cs ||= tr.cs; }
      else byHex.set(tr.hex, tr);
    }
  }
  let ships = null;
  let shipsNote = null;
  if (+days[0].slice(0, 4) <= 2024) {
    ships = [];
    for (const date of days) {
      onProgress({ stage: `AIS ${date}`, pct: 0 });
      try {
        const a = await extractMarineCadastreDay({ date, bbox, t0, t1, fetchImpl, onProgress: (p) => onProgress({ stage: `AIS ${date}`, pct: Math.round((100 * p.bytes) / (p.total || 1)) }) });
        if (!a.ok) { shipsNote = a.reason; continue; }
        sources.push(a.source);
        ships.push(...a.vessels);
      } catch (err) { shipsNote = `AIS fetch failed: ${err.message}`; }
    }
    if (!ships.length && !shipsNote) shipsNote = 'NOAA AIS has no vessels in this area/time (US waters only)';
  } else {
    shipsNote = 'No ship history: NOAA MarineCadastre AIS (US) is published only through 2024; no free historical AIS for this date.';
  }
  onProgress({ stage: 'wind', pct: 100 });
  const wind = await fetchHistoricalWind({ bbox, t0, t1, fetchImpl }).catch(() => null);
  if (!wind) gaps.push('no historical wind available');
  const aircraft = [...byHex.values()];
  if (!aircraft.length) gaps.push('ADSB.lol recorded no aircraft in this area/time');
  return {
    id, title, kind: 'reconstructed', t0, t1, bbox,
    builtAt: new Date().toISOString(),
    aircraft, ships, shipsNote, wind, sources, gaps,
    credits: 'ADS-B: ADSB.lol (ODbL)' + (ships?.length ? ' · AIS: NOAA MarineCadastre' : '') + (wind ? ` · wind: ${wind.model}` : ''),
  };
}

export function replayProxy({ fetchImpl = fetch } = {}) {
  const jobs = new Map(); // key -> {status, progress, error, startedAt}
  let running = null;

  async function cached(key) {
    try { return JSON.parse(await fsp.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8')); } catch { return null; }
  }

  function install(server) {
    server.middlewares.use('/api/replay/custom', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const send = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
      const q = new URL(req.url, 'http://x').searchParams;
      const wantKey = q.get('key');
      if (wantKey) {
        if (!/^[0-9a-f]{16}$/.test(wantKey)) return send(400, { status: 'error', error: 'bad key' });
        const hit = await cached(wantKey);
        return hit ? send(200, { status: 'done', key: wantKey, replay: hit }) : send(404, { status: 'error', error: 'replay not cached on this server (caches reset on redeploy) — rebuild it from the custom panel' });
      }
      const bbox = (q.get('bbox') || '').split(',').map(Number).map((x) => Math.round(x * 100) / 100);
      const t0 = Math.floor(+q.get('t0') / 60) * 60;
      const t1 = Math.ceil(+q.get('t1') / 60) * 60;
      const err = validateReplayRequest({ bbox, t0, t1 });
      if (err) return send(400, { status: 'error', error: err });
      const key = crypto.createHash('sha1').update(JSON.stringify([bbox, t0, t1])).digest('hex').slice(0, 16);
      const hit = await cached(key);
      if (hit) return send(200, { status: 'done', key, replay: hit });
      const job = jobs.get(key);
      if (job?.status === 'error' && Date.now() - job.at < 60_000) return send(502, { status: 'error', error: job.error });
      if (job?.status === 'running') return send(202, { status: 'running', key, progress: job.progress });
      if (running) return send(429, { status: 'busy', error: 'another replay is being reconstructed — try again in a few minutes', progress: jobs.get(running)?.progress });
      const j = { status: 'running', progress: { stage: 'starting', pct: 0 }, at: Date.now() };
      jobs.set(key, j);
      running = key;
      const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { id: `custom-${key}`, title: 'Custom replay', bbox, t0, t1 } });
      const fail = (e) => { console.warn('[replay] job failed', e); Object.assign(j, { status: 'error', error: String(e?.message || e), at: Date.now() }); running = null; };
      worker.on('message', async (m) => {
        if (m.type === 'progress') j.progress = m.p;
        else if (m.type === 'error') fail(m.error);
        else if (m.type === 'done') {
          try {
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            await fsp.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(m.replay));
            jobs.delete(key);
          } catch (e) { fail(e); }
          running = null;
          worker.terminate();
        }
      });
      worker.on('error', fail);
      worker.on('exit', (code) => { if (running === key) fail(`worker exited (${code})`); });
      return send(202, { status: 'running', key, progress: j.progress });
    });
  }
  return { name: 'gev-replay-proxy', configureServer: install, configurePreviewServer: install };
}
