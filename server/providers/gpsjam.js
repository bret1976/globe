/**
 * gpsjam.org GNSS interference proxy (same-origin).
 *
 * Public daily CSV (no key). Converts H3 res-4 hexes to lat/lon + boundary
 * rings so the client stays free of h3-js. Original code — does not copy
 * AGPL consumers of the same feed.
 *
 *   GET /api/gpsjam → { fetchedAt, date, source, attribution, count, stats, rows }
 */
import { cellToLatLng, cellToBoundary } from 'h3-js';
import {
  parseGpsjamCsv,
  latestGpsjamDate,
} from '../../src/layers/gpsInterference/parse.js';

const MANIFEST_URL = 'https://gpsjam.org/data/manifest.csv';
const TTL_MS = 60 * 60_000; // daily feed; refresh hourly
const STALE_MS = 24 * 60 * 60_000;

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
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

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

  async function refresh() {
    const manifest = await fetchText(MANIFEST_URL);
    const date = latestGpsjamDate(manifest);
    if (!date) throw new Error('gpsjam manifest has no dates');
    const csv = await fetchText(csvUrlForDate(date));
    const parsed = parseGpsjamCsv(csv);
    const rows = [];
    for (const row of parsed.rows) {
      const enriched = enrichRow(row);
      if (enriched) rows.push(enriched);
    }
    const highCount = rows.filter((r) => r.level === 'high').length;
    const mediumCount = rows.filter((r) => r.level === 'medium').length;
    const payload = {
      fetchedAt: now(),
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
    mem = { at: now(), payload };
    return payload;
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
