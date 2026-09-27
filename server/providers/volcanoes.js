/**
 * USGS Volcano Hazards elevated-volcano proxy (same-origin).
 *
 * Public open data, no API key.
 *
 *   GET /api/volcanoes → { fetchedAt, source, attribution, count, rows }
 */
import { normalizeElevatedVolcanoes } from '../../src/layers/volcanoes/parse.js';

const USGS_URL = 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated';
const TTL_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

export function volcanoesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(USGS_URL, {
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (volcanoes proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`USGS volcanoes HTTP ${response.status}`);
    const raw = await response.json();
    const rows = normalizeElevatedVolcanoes(raw);
    const payload = {
      fetchedAt: now(),
      source: 'USGS Volcano Hazards Program',
      attribution:
        'Elevated volcano alerts courtesy of the U.S. Geological Survey',
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/volcanoes', async (req, res, next) => {
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
          error: error?.message || 'Volcanoes unavailable',
        });
      }
    });
  }

  return {
    name: 'local-volcanoes-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
