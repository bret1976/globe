/**
 * U.S. Drought Monitor proxy (same-origin).
 *
 * Returns capped MultiPolygon-part centroids (not raw 20MB+ GeoJSON).
 *
 *   GET /api/usdm-drought → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import {
  normalizeUsdmDrought,
  USDM_FALLBACK_URL,
  USDM_PRIMARY_URL,
} from '../../src/layers/usdmDrought/parse.js';

const TTL_MS = 6 * 60 * 60_000;
const STALE_MS = 24 * 60 * 60_000;

export function usdmDroughtProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchCollection(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(90_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent':
          'GodsEyeView/0.1 (usdm-drought proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`USDM HTTP ${response.status} @ ${url}`);
    return response.json();
  }

  async function refresh() {
    let collection;
    let used = USDM_PRIMARY_URL;
    try {
      collection = await fetchCollection(USDM_PRIMARY_URL);
    } catch (primaryError) {
      used = USDM_FALLBACK_URL;
      try {
        collection = await fetchCollection(USDM_FALLBACK_URL);
      } catch {
        throw primaryError;
      }
    }
    const features = Array.isArray(collection?.features)
      ? collection.features
      : [];
    const rows = normalizeUsdmDrought(collection);
    const payload = {
      fetchedAt: now(),
      source: 'USDM',
      feedUrl: used,
      attribution:
        'U.S. Drought Monitor (National Drought Mitigation Center, USDA, NOAA)',
      rawCount: features.length,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/usdm-drought', async (req, res, next) => {
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
          error: error?.message || 'USDM drought unavailable',
        });
      }
    });
  }

  return {
    name: 'local-usdm-drought-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
