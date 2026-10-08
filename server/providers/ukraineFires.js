/**
 * Ukraine War Fires — every NASA FIRMS VIIRS (NOAA-20) fire detection inside
 * Ukraine's internationally recognised borders (incl. Crimea) since
 * 2022-01-01, day by day. Inspired by Bilawal Sidhu's reel "All 4.5 years of
 * the war in Ukraine through satellite fire detections" (2026-10-07).
 *
 * Sources (NASA FIRMS, public domain; satellites see heat, not causes):
 *  1. Keyless yearly country archive (standard processing, includes the FIRMS
 *     `type` flag): data/country/viirs-jpss1/{YEAR}/viirs-jpss1_{YEAR}_Ukraine.csv
 *     Static land sources (type 2, industrial heat) and offshore (type 3) are
 *     excluded, and their 2 km cells mask the same hotspots in NRT data.
 *  2. Gap since the archive ends (FIRMS_MAP_KEY on the server): area API over
 *     Ukraine's bbox, VIIRS_NOAA20_SP while available, then VIIRS_NOAA20_NRT,
 *     5-day chunks, backfilled in the background and cached.
 *  3. Keyless last 7 days: active_fire/noaa-20-viirs-c2 Europe + Russia_Asia.
 *
 * GET /api/ukraine-fires → { epoch, today, count, complete, coverage,
 *   points: [latE3-44000, lonE3-22000, dayIndex, ...] , ... }
 * Responses are pre-gzipped (~5 MB raw JSON → ~1.5 MB on the wire).
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import zlib from 'node:zlib';
import { UKRAINE_RINGS } from './ukraineFires/boundary.js';

export const UKRAINE_FIRES_EPOCH = '2022-01-01';
const EPOCH_MS = Date.UTC(2022, 0, 1);
const DAY_MS = 86_400_000;
const FIRMS = 'https://firms.modaps.eosdis.nasa.gov';
const BBOX = '22,44,40.3,52.5'; // W,S,E,N
const LAT0 = 44_000;
const LON0 = 22_000;
const NRT_TTL_MS = 30 * 60_000;
const ARCHIVE_TTL_MS = 24 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 45_000;
const HEADERS = {
  Accept: 'text/csv, text/plain, */*',
  'User-Agent':
    'GodsEyeView/0.1 (ukraine fires proxy; +https://github.com/bret1976/globe)',
};

// ---------- geometry ----------
const RING_BOXES = UKRAINE_RINGS.map((ring) => {
  let w = 180,
    s = 90,
    e = -180,
    n = -90;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return { ring, w, s, e, n };
});

export function insideUkraine(lat, lon) {
  let inside = false;
  for (const { ring, w, s, e, n } of RING_BOXES) {
    if (lon < w || lon > e || lat < s || lat > n) continue;
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      )
        hit = !hit;
    }
    if (hit) inside = !inside;
  }
  return inside;
}

// ---------- csv ----------
/** Parse a FIRMS CSV into rows {lat, lon, date, time, type}. */
export function parseFirmsRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = (lines.shift() || '')
    .split(',')
    .map((h) => h.trim().toLowerCase());
  const iLat = header.indexOf('latitude');
  const iLon = header.indexOf('longitude');
  const iDate = header.indexOf('acq_date');
  const iTime = header.indexOf('acq_time');
  const iType = header.indexOf('type');
  if (iLat < 0 || iLon < 0 || iDate < 0) {
    if (/^\s*$/.test(text)) return [];
    throw new Error('Not a FIRMS CSV');
  }
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const c = line.split(',');
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const date = c[iDate];
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    )
      continue;
    rows.push({
      lat,
      lon,
      date,
      time: iTime >= 0 ? c[iTime] : '',
      type: iType >= 0 && c[iType] !== '' ? Number(c[iType]) : null,
    });
  }
  return rows;
}

export function dayIndex(date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - EPOCH_MS) / DAY_MS);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const maskKey = (lat, lon) => `${Math.round(lat * 50)}:${Math.round(lon * 50)}`; // 0.02° cells

export function ukraineFiresProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim(),
  startBackground = true,
} = {}) {
  const archivePath = path.join(cacheDir, 'ukraine-fires-archive.json');
  const backfillPath = path.join(cacheDir, 'ukraine-fires-backfill.json');
  /** detections keyed `${latE3},${lonE3},${date},${time}` → [latQ, lonQ, day] */
  let archive = null; // { at, years: [], through: 'YYYY-MM-DD', points: Map, mask: Set, excluded }
  let archivePromise = null;
  const backfill = {
    points: new Map(),
    doneChunks: new Set(),
    total: 0,
    running: false,
    error: null,
    through: null,
  };
  let nrt = { at: 0, points: new Map(), error: null };
  let nrtPromise = null;
  let built = null; // { key, json, gz }
  let diskLoaded = false;

  async function getText(url, label) {
    const response = await fetchImpl(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    return response.text();
  }

  async function withRetry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw last;
  }

  function addDetection(map, row) {
    if (!insideUkraine(row.lat, row.lon)) return false;
    const day = dayIndex(row.date);
    if (!(day >= 0)) return false;
    const latQ = Math.round(row.lat * 1000) - LAT0;
    const lonQ = Math.round(row.lon * 1000) - LON0;
    map.set(`${latQ},${lonQ},${day},${row.time}`, [latQ, lonQ, day]);
    return true;
  }

  async function loadDisk() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const saved = JSON.parse(await fsp.readFile(archivePath, 'utf8'));
      if (saved?.v === 1 && Array.isArray(saved.points)) {
        const points = new Map();
        for (const p of saved.points) points.set(p.join(','), p.slice(0, 3));
        archive = {
          at: saved.at,
          years: saved.years,
          through: saved.through,
          points,
          mask: new Set(saved.mask),
          excluded: saved.excluded,
        };
      }
    } catch {
      /* no archive cache yet */
    }
    try {
      const saved = JSON.parse(await fsp.readFile(backfillPath, 'utf8'));
      if (saved?.v === 1 && Array.isArray(saved.points)) {
        for (const p of saved.points)
          backfill.points.set(p.join(','), p.slice(0, 3));
        for (const c of saved.doneChunks || []) backfill.doneChunks.add(c);
      }
    } catch {
      /* no backfill cache yet */
    }
  }

  async function saveDisk(file, body) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(body));
    } catch (error) {
      console.warn(
        '[ukraine-fires] cache write failed:',
        error?.message || error,
      );
    }
  }

  async function loadArchive() {
    await loadDisk();
    if (archive && now() - archive.at < ARCHIVE_TTL_MS) return archive;
    const thisYear = new Date(now()).getUTCFullYear();
    const points = new Map();
    const mask = new Set();
    const years = [];
    let through = null;
    let excluded = 0;
    for (let year = 2022; year <= thisYear; year++) {
      const url = `${FIRMS}/data/country/viirs-jpss1/${year}/viirs-jpss1_${year}_Ukraine.csv`;
      const text = await withRetry(() => getText(url, `FIRMS ${year} archive`));
      if (!text) break; // yearly archive not published yet → NRT covers the rest
      const rows = parseFirmsRows(text);
      if (!rows.length) break;
      for (const row of rows) {
        if (row.type === 2 || row.type === 3) {
          mask.add(maskKey(row.lat, row.lon));
          excluded++;
          continue;
        }
        addDetection(points, row);
        if (!through || row.date > through) through = row.date;
      }
      years.push(year);
    }
    if (!years.length) throw new Error('FIRMS Ukraine archive unavailable');
    archive = { at: now(), years, through, points, mask, excluded };
    void saveDisk(archivePath, {
      v: 1,
      at: archive.at,
      years,
      through,
      excluded,
      mask: [...mask],
      points: [...points.entries()].map(([key, p]) => [
        ...p,
        key.split(',')[3],
      ]),
    });
    built = null;
    return archive;
  }

  function ensureArchive() {
    if (archive && now() - archive.at < ARCHIVE_TTL_MS)
      return Promise.resolve(archive);
    if (!archivePromise) {
      archivePromise = loadArchive()
        .catch((error) => {
          if (archive) return archive; // keep serving the previous archive
          throw error;
        })
        .finally(() => {
          archivePromise = null;
        });
    }
    return archivePromise;
  }

  function masked(row) {
    if (!archive) return false;
    return archive.mask.has(maskKey(row.lat, row.lon));
  }

  async function refreshNrt() {
    const points = new Map();
    const errors = [];
    for (const region of ['Europe', 'Russia_Asia']) {
      try {
        const text = await withRetry(
          () =>
            getText(
              `${FIRMS}/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_${region}_7d.csv`,
              `FIRMS NRT ${region}`,
            ),
          2,
        );
        for (const row of parseFirmsRows(text || '')) {
          if (row.lat < 44 || row.lat > 52.5 || row.lon < 22 || row.lon > 40.3)
            continue;
          if (masked(row)) continue;
          addDetection(points, row);
        }
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
    if (errors.length === 2 && nrt.points.size) {
      nrt = { ...nrt, error: errors.join('; ') };
      return nrt;
    }
    nrt = {
      at: now(),
      points,
      error: errors.length === 2 ? errors.join('; ') : null,
    };
    built = null;
    return nrt;
  }

  function ensureNrt() {
    if (now() - nrt.at < NRT_TTL_MS) return Promise.resolve(nrt);
    if (!nrtPromise)
      nrtPromise = refreshNrt().finally(() => (nrtPromise = null));
    return nrtPromise;
  }

  async function firmsAvailability(key, source) {
    try {
      const text = await getText(
        `${FIRMS}/api/data_availability/csv/${key}/${source}`,
        'FIRMS availability',
      );
      const line = String(text || '')
        .split(/\r?\n/)
        .find((l) => l.startsWith(source));
      const [, min, max] = (line || '').split(',');
      return { min: min?.trim() || null, max: max?.trim() || null };
    } catch {
      return { min: null, max: null };
    }
  }

  /** Background: fill archive-end → 7 days ago with the keyed FIRMS area API. */
  async function runBackfill() {
    const key = mapKey();
    if (!key || backfill.running || !archive?.through) return;
    backfill.running = true;
    backfill.error = null;
    try {
      const sp = await firmsAvailability(key, 'VIIRS_NOAA20_SP');
      const startMs = Date.parse(`${archive.through}T00:00:00Z`) + DAY_MS;
      const endMs = now() - 6 * DAY_MS; // keyless 7-day files cover the rest
      const chunks = [];
      for (let t = startMs; t <= endMs; t += 5 * DAY_MS) chunks.push(isoDay(t));
      backfill.total = chunks.length;
      let failures = 0;
      for (const start of chunks) {
        if (backfill.doneChunks.has(start)) continue;
        const source =
          sp.max && start <= sp.max ? 'VIIRS_NOAA20_SP' : 'VIIRS_NOAA20_NRT';
        try {
          const text = await withRetry(
            () =>
              getText(
                `${FIRMS}/api/area/csv/${key}/${source}/${BBOX}/5/${start}`,
                `FIRMS ${source}`,
              ),
            2,
          );
          if (
            text &&
            /invalid|error/i.test(text.slice(0, 200)) &&
            !/latitude/i.test(text.slice(0, 200))
          )
            throw new Error(`FIRMS ${source} rejected the request`);
          for (const row of parseFirmsRows(text || '')) {
            if (row.type === 2 || row.type === 3 || masked(row)) continue;
            addDetection(backfill.points, row);
            if (!backfill.through || row.date > backfill.through)
              backfill.through = row.date;
          }
          backfill.doneChunks.add(start);
          built = null;
        } catch (error) {
          failures++;
          backfill.error = error?.message || String(error);
          if (failures >= 6) break;
        }
        if (backfill.doneChunks.size % 10 === 0) void persistBackfill();
        await new Promise((r) => setTimeout(r, 250));
      }
      void persistBackfill();
    } finally {
      backfill.running = false;
    }
  }

  function persistBackfill() {
    return saveDisk(backfillPath, {
      v: 1,
      doneChunks: [...backfill.doneChunks],
      points: [...backfill.points.entries()].map(([k, p]) => [
        ...p,
        k.split(',')[3],
      ]),
    });
  }

  function build() {
    const todayIdx = dayIndex(isoDay(now()));
    const key = `${archive?.at}|${nrt.at}|${backfill.points.size}|${backfill.doneChunks.size}|${todayIdx}`;
    if (built?.key === key) return built;
    const all = new Map();
    for (const source of [archive?.points, backfill.points, nrt.points]) {
      if (!source) continue;
      for (const [k, p] of source) all.set(k, p);
    }
    const rows = [...all.values()].sort((a, b) => a[2] - b[2]);
    const flat = new Array(rows.length * 3);
    rows.forEach((p, i) => {
      flat[i * 3] = p[0];
      flat[i * 3 + 1] = p[1];
      flat[i * 3 + 2] = p[2];
    });
    const keyed = Boolean(mapKey());
    const pending = keyed
      ? Math.max(0, backfill.total - backfill.doneChunks.size)
      : 0;
    const nrtFrom = rows.length ? null : null;
    const firstNrtDay = (() => {
      let min = Infinity;
      for (const p of nrt.points.values()) min = Math.min(min, p[2]);
      return Number.isFinite(min) ? min : null;
    })();
    const archiveThroughIdx = archive?.through
      ? dayIndex(archive.through)
      : null;
    const backfillThroughIdx = backfill.through
      ? dayIndex(backfill.through)
      : null;
    const coveredThrough = Math.max(
      archiveThroughIdx ?? -1,
      keyed ? (backfillThroughIdx ?? -1) : -1,
    );
    const gap =
      firstNrtDay != null &&
      coveredThrough >= 0 &&
      firstNrtDay - coveredThrough > 2
        ? { from: coveredThrough + 1, to: firstNrtDay - 1 }
        : null;
    const payload = {
      fetchedAt: now(),
      epoch: UKRAINE_FIRES_EPOCH,
      today: todayIdx,
      origin: { lat: LAT0, lon: LON0, scale: 1000 },
      count: rows.length,
      complete: pending === 0 && !backfill.running,
      backfill: keyed
        ? {
            done: backfill.doneChunks.size,
            total: backfill.total,
            running: backfill.running,
            error: backfill.error,
          }
        : null,
      coverage: {
        archiveYears: archive?.years || [],
        archiveThrough: archive?.through || null,
        backfillThrough: backfill.through,
        nrtDays: 7,
        gap,
        keyed,
      },
      industrialExcluded: archive?.excluded || 0,
      nrtError: nrt.error,
      source: 'NASA FIRMS VIIRS NOAA-20 (375 m)',
      attribution:
        'NASA FIRMS (LANCE/EOSDIS), VIIRS NOAA-20 375 m active fire detections',
      license: 'NASA open data (public domain)',
      note: 'Satellites see heat, not causes: shelling, field burning and wildfires all register.',
      points: flat,
    };
    void nrtFrom;
    const json = Buffer.from(JSON.stringify(payload));
    built = { key, json, gz: zlib.gzipSync(json, { level: 6 }), payload };
    return built;
  }

  async function snapshot() {
    await ensureArchive();
    await ensureNrt().catch(() => nrt);
    if (
      startBackground &&
      mapKey() &&
      !backfill.running &&
      (backfill.total === 0 || backfill.doneChunks.size < backfill.total)
    ) {
      void runBackfill().catch((error) => {
        backfill.error = error?.message || String(error);
      });
    }
    return build();
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/ukraine-fires', async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      try {
        const out = await snapshot();
        const gzip = /\bgzip\b/.test(
          String(req.headers['accept-encoding'] || ''),
        );
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Vary: 'Accept-Encoding',
          ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
          'Content-Length': String((gzip ? out.gz : out.json).length),
        });
        res.end(req.method === 'HEAD' ? undefined : gzip ? out.gz : out.json);
      } catch (error) {
        if (res.headersSent) return;
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: error?.message || 'Ukraine fires unavailable',
          }),
        );
      }
    });
  }

  return {
    name: 'local-ukraine-fires-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
    // test seams
    _snapshot: snapshot,
    _state: () => ({ archive, backfill, nrt }),
  };
}
