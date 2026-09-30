/**
 * GDACS floods & droughts proxy (same-origin).
 *
 * Public Orange/Red FL+DR events; no API key.
 * Filters out EQ/WF/TC/VO which overlap existing globe layers.
 *
 *   GET /api/floods → { fetchedAt, source, attribution, count, rows }
 */
import { normalizeGdacsFloodDroughts } from '../../src/layers/floods/parse.js';

const GDACS_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange;Red&eventlist=FL;DR';
const TTL_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

export function floodsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(GDACS_URL, {
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (floods proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`GDACS floods HTTP ${response.status}`);
    const raw = await response.json();
    const rows = normalizeGdacsFloodDroughts(raw);
    const payload = {
      fetchedAt: now(),
      source: 'GDACS',
      attribution:
        'Flood and drought alerts courtesy of the Global Disaster Alert and Coordination System (GDACS)',
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/floods', async (req, res, next) => {
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
          error: error?.message || 'Floods unavailable',
        });
      }
    });
  }

  return {
    name: 'local-floods-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
