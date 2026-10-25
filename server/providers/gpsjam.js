/**
 * gpsjam.org GNSS interference proxy (same-origin).
 *
 * Public daily CSV (no key). Converts H3 res-4 hexes to lat/lon + boundary
 * rings so the client stays free of h3-js. Original code — does not copy
 * AGPL consumers of the same feed.
 *
 *   GET /api/gpsjam              → latest day
 *   GET /api/gpsjam?date=YYYY-MM-DD → that day, only if the manifest lists it
 *   GET /api/gpsjam/dates        → { fetchedAt, provider, latest, dates }
 *   → { fetchedAt, provider, date, source, attribution, count, stats, rows }
 */
import { cellToLatLng, cellToBoundary } from 'h3-js';
import {
  parseGpsjamCsv,
  gpsjamManifestDates,
} from '../../src/layers/gpsInterference/parse.js';

const MANIFEST_URL = 'https://gpsjam.org/data/manifest.csv';
const TTL_MS = 60 * 60_000; // daily feed; refresh hourly
const STALE_MS = 24 * 60 * 60_000;
/** Past days kept in memory at once (each is a few hundred KB). */
export const GPSJAM_DATED_CACHE_LIMIT = 8;
/** How many of the newest manifest dates the timeline offers. */
export const GPSJAM_TIMELINE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csvUrlForDate(date) {
  return `https://gpsjam.org/data/${date}-h3_4.csv`;
}

function enrichRow(row) {
  let lat;
  let lon;
  let ring;
  try {
    const [cellLat, cellLon] = cellToLatLng(row.h3);
    lat = cellLat;
    lon = cellLon;
    ring = cellToBoundary(row.h3).map(([la, lo]) => [lo, la]);
  } catch {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    stableId: row.h3,
    h3: row.h3,
    lat,
    lon,
    level: row.level,
    pct: row.pct,
    good: row.good,
    bad: row.bad,
    total: row.total,
    ring,
  };
}

export function gpsjamProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** Latest-day payload (unchanged behaviour for `/api/gpsjam`). */
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;
  /** @type {?{at: number, dates: string[]}} */
  let manifest = null;
  /** @type {?Promise<string[]>} */
  let manifestInflight = null;
  /** Past days, insertion-ordered for LRU eviction. Published days never change. */
  /** @type {Map<string, object>} */
  const dated = new Map();
  /** @type {Map<string, Promise<object>>} */
  const datedInflight = new Map();

  async function fetchText(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'text/csv,text/plain,*/*',
        'User-Agent': 'GodsEyeView/0.1 (gpsjam proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`gpsjam HTTP ${response.status} for ${url}`);
    return response.text();
  }

  async function manifestDates({ force = false } = {}) {
    if (!force && manifest && now() - manifest.at < TTL_MS) return manifest.dates;
    if (!manifestInflight) {
      manifestInflight = fetchText(MANIFEST_URL)
        .then((text) => {
          const dates = gpsjamManifestDates(text);
          if (!dates.length) throw new Error('gpsjam manifest has no dates');
          manifest = { at: now(), dates };
          return dates;
        })
        .catch((error) => {
          if (manifest) return manifest.dates;
          throw error;
        })
        .finally(() => {
          manifestInflight = null;
        });
    }
    return manifestInflight;
  }

  async function buildPayload(date) {
    const csv = await fetchText(csvUrlForDate(date));
    const parsed = parseGpsjamCsv(csv);
    const rows = [];
    for (const row of parsed.rows) {
      const enriched = enrichRow(row);
      if (enriched) rows.push(enriched);
    }
    const highCount = rows.filter((r) => r.level === 'high').length;
    const mediumCount = rows.filter((r) => r.level === 'medium').length;
    return {
      fetchedAt: now(),
      provider: 'gpsjam.org',
      date,
      source: 'gpsjam.org',
      attribution:
        'Data derived from airplanes.live and ADS-B Exchange via gpsjam.org',
      count: rows.length,
      stats: {
        totalRows: parsed.totalRows,
        highCount,
        mediumCount,
        skippedLowSample: parsed.skippedLowSample,
        skippedLow: parsed.skippedLow,
      },
      rows,
    };
  }

  async function refresh() {
    const dates = await manifestDates({ force: true });
    const date = dates[dates.length - 1];
    const payload = await buildPayload(date);
    mem = { at: now(), payload };
    return payload;
  }

  async function loadDate(date) {
    const cached = dated.get(date);
    if (cached) {
      dated.delete(date);
      dated.set(date, cached);
      return cached;
    }
    let run = datedInflight.get(date);
    if (!run) {
      run = buildPayload(date)
        .then((payload) => {
          dated.set(date, payload);
          while (dated.size > GPSJAM_DATED_CACHE_LIMIT)
            dated.delete(dated.keys().next().value);
          return payload;
        })
        .finally(() => datedInflight.delete(date));
      datedInflight.set(date, run);
    }
    return run;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/gpsjam', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const send = (status, body, stale = false) => {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(stale ? { 'X-Data-Stale': 'true' } : {}),
        });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url || '/', 'http://local');
      const path = url.pathname.replace(/\/+$/, '');
      if (path === '/dates') {
        try {
          const dates = await manifestDates();
          send(200, {
            fetchedAt: manifest?.at ?? now(),
            provider: 'gpsjam.org',
            latest: dates[dates.length - 1] || null,
            dates: dates.slice(-GPSJAM_TIMELINE_DAYS),
          });
        } catch (error) {
          send(502, { error: error?.message || 'gpsjam manifest unavailable' });
        }
        return;
      }
      if (path !== '' && path !== '/') return next();
      const requested = url.searchParams.get('date');
      if (requested != null && requested !== '') {
        if (!DATE_RE.test(requested)) {
          send(400, { error: 'invalid_date', detail: 'Use YYYY-MM-DD.' });
          return;
        }
        let dates;
        try {
          dates = await manifestDates();
        } catch (error) {
          send(502, { error: error?.message || 'gpsjam manifest unavailable' });
          return;
        }
        if (!dates.includes(requested)) {
          send(404, {
            error: 'date_not_published',
            detail: 'gpsjam.org has not published that day.',
            first: dates[0] || null,
            latest: dates[dates.length - 1] || null,
          });
          return;
        }
        if (requested !== dates[dates.length - 1]) {
          try {
            send(200, await loadDate(requested));
          } catch (error) {
            send(502, { error: error?.message || 'GPS interference unavailable' });
          }
          return;
        }
        // The latest day falls through to the normal hourly-refresh path.
      }
      const t = now();
      if (mem && t - mem.at < TTL_MS) {
        send(200, mem.payload);
        return;
      }
      try {
        const run =
          inflight ||
          (inflight = refresh().finally(() => {
            inflight = null;
          }));
        const payload = await run;
        send(200, payload);
      } catch (error) {
        if (mem && t - mem.at < STALE_MS) {
          send(200, { ...mem.payload, stale: true }, true);
          return;
        }
        send(502, {
          error: error?.message || 'GPS interference unavailable',
        });
      }
    });
  }

  return {
    name: 'local-gpsjam-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
