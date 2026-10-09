/**
 * NASA JPL fireball events proxy (same-origin).
 *
 * Keyless SSD Fireball API (public domain NASA). One upstream request per TTL,
 * stale fallback on outage. GET /api/fireballs → { fetchedAt, source,
 * attribution, license, rawCount, count, rows }
 */
import {
  FIREBALLS_URL_LIMITED,
  normalizeFireballs,
} from '../../src/layers/fireballs/parse.js';

const TTL_MS = 60 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (fireballs proxy; +https://github.com/bret1976/globe)';

export function fireballsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const response = await fetchImpl(FIREBALLS_URL_LIMITED, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'follow',
          headers: {
            Accept: 'application/json',
            'User-Agent': UA,
          },
        });
        if (!response.ok) throw new Error(`JPL fireball HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          throw new Error('JPL fireball body exceeds size cap');
        const body = await response.json();
        const rawCount = Array.isArray(body?.data) ? body.data.length : 0;
        if (!Array.isArray(body?.data))
          throw new Error('JPL fireball returned no data list');
        const rows = normalizeFireballs(body);
        if (!rows.length && rawCount)
          throw new Error('JPL fireball returned no usable rows');
        const payload = {
          fetchedAt: now(),
          source: 'NASA/JPL Fireball Data API',
          attribution:
            'Fireballs: NASA Jet Propulsion Laboratory Center for Near Earth Object Studies (ssd-api.jpl.nasa.gov)',
          license: 'U.S. Government work (public domain)',
          rawCount,
          count: rows.length,
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[fireballs] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('JPL fireballs unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/fireballs', async (req, res, next) => {
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
        send(200, await run);
      } catch (error) {
        if (mem && t - mem.at < STALE_MS) {
          send(200, { ...mem.payload, stale: true }, true);
          return;
        }
        send(502, { error: error?.message || 'Fireballs unavailable' });
      }
    });
  }

  return {
    name: 'local-fireballs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
