/**
 * NWS active weather alerts proxy (same-origin).
 *
 * U.S. government public domain GeoJSON; no API key (User-Agent required).
 *
 *   GET /api/nws-alerts → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import {
  normalizeNwsAlerts,
  NWS_ALERTS_URL,
} from '../../src/layers/nwsAlerts/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;

export function nwsAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(NWS_ALERTS_URL, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/geo+json',
        'User-Agent':
          'GodsEyeView/0.1 (nws-alerts proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`NWS alerts HTTP ${response.status}`);
    const raw = await response.json();
    const features = Array.isArray(raw?.features) ? raw.features : [];
    const rows = normalizeNwsAlerts(raw);
    const payload = {
      fetchedAt: now(),
      source: 'NWS',
      attribution:
        'Weather alerts courtesy of the National Weather Service (api.weather.gov)',
      rawCount: features.length,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/nws-alerts', async (req, res, next) => {
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
          error: error?.message || 'NWS alerts unavailable',
        });
      }
    });
  }

  return {
    name: 'local-nws-alerts-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
