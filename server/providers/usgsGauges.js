/**
 * USGS Water Data latest-continuous streamflow proxy (same-origin).
 *
 * U.S. government public domain GeoJSON; no API key.
 *
 *   GET /api/usgs-gauges → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import {
  normalizeUsgsGauges,
  usgsGaugesFirstPageUrl,
  usgsGaugesNextHref,
  MAX_PAGES,
} from '../../src/layers/usgsGauges/parse.js';

const TTL_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;

export function usgsGaugesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchPage(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent':
          'GodsEyeView/0.1 (usgs-gauges proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`USGS latest-continuous HTTP ${response.status}`);
    return response.json();
  }

  async function refresh() {
    /** @type {object[]} */
    const features = [];
    let url = usgsGaugesFirstPageUrl();
    let pages = 0;
    while (url && pages < MAX_PAGES) {
      const collection = await fetchPage(url);
      const pageFeatures = Array.isArray(collection?.features)
        ? collection.features
        : [];
      features.push(...pageFeatures);
      pages += 1;
      url = usgsGaugesNextHref(collection);
      // Enough raw features to fill the ranked top-N after normalize.
      if (features.length >= 12_000) break;
    }
    const rows = normalizeUsgsGauges({
      type: 'FeatureCollection',
      features,
    });
    const payload = {
      fetchedAt: now(),
      source: 'USGS',
      attribution:
        'Streamflow observations courtesy of U.S. Geological Survey Water Data for the Nation (waterdata.usgs.gov)',
      rawCount: features.length,
      count: rows.length,
      pages,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/usgs-gauges', async (req, res, next) => {
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
          error: error?.message || 'USGS gauges unavailable',
        });
      }
    });
  }

  return {
    name: 'local-usgs-gauges-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
