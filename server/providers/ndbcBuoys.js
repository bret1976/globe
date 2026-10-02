/**
 * NOAA NDBC latest buoy observations proxy (same-origin).
 *
 * U.S. government public domain text feed; no API key.
 *
 *   GET /api/ndbc-buoys → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import {
  normalizeNdbcBuoys,
  NDBC_LATEST_OBS_URL,
} from '../../src/layers/ndbcBuoys/parse.js';

const TTL_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;

export function ndbcBuoysProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(NDBC_LATEST_OBS_URL, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'text/plain',
        'User-Agent':
          'GodsEyeView/0.1 (ndbc-buoys proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`NDBC latest_obs HTTP ${response.status}`);
    const text = await response.text();
    const rawLines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    const rows = normalizeNdbcBuoys(text);
    const payload = {
      fetchedAt: now(),
      source: 'NDBC',
      attribution:
        'Marine buoy observations courtesy of NOAA National Data Buoy Center (ndbc.noaa.gov)',
      rawCount: rawLines.length,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/ndbc-buoys', async (req, res, next) => {
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
          error: error?.message || 'NDBC buoys unavailable',
        });
      }
    });
  }

  return {
    name: 'local-ndbc-buoys-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
