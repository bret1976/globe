/**
 * USGS all-day earthquake GeoJSON proxy (same-origin).
 *
 * No API key. TTL 60s. Serve stale on a transient failure.
 *
 *   GET /api/earthquakes → { fetchedAt, stale?, count, rows }
 *
 * rows match normalizeEarthquakeSnapshot() from src/layers/earthquakes/records.js
 * so the client layer can swap transports without a reshape.
 *
 * @returns {import('vite').Plugin}
 */
import { normalizeEarthquakeSnapshot } from '../../src/layers/earthquakes/records.js';

const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const TTL_MS = 60_000;
const STALE_MS = 15 * 60_000;

export function earthquakesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(USGS_URL, {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
    const geojson = await response.json();
    const rows = normalizeEarthquakeSnapshot(geojson);
    if (!rows) throw new Error('Malformed USGS response');
    const payload = {
      fetchedAt: now(),
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/earthquakes', async (req, res, next) => {
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
          error: error?.message || 'Earthquakes unavailable',
        });
      }
    });
  }

  return {
    name: 'local-earthquakes-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
