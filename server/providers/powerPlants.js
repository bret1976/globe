/**
 * WRI Global Power Plant Database proxy (same-origin).
 *
 * CC BY 4.0, keyless. GET /api/power-plants → { fetchedAt, source, attribution, count, rows }
 * Upstream is a ~12 MB versioned CSV, so it is fetched once and cached a week.
 */
import {
  POWER_PLANTS_URL,
  normalizePowerPlants,
} from '../../src/layers/powerPlants/parse.js';

const TTL_MS = 7 * 24 * 60 * 60_000;

export function powerPlantsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object, body: string}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(POWER_PLANTS_URL, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: 'text/csv, text/plain',
        'User-Agent':
          'GodsEyeView/0.1 (power-plants proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`WRI GPPD HTTP ${response.status}`);
    const rows = normalizePowerPlants(await response.text());
    if (!rows.length) throw new Error('WRI GPPD returned no usable rows');
    const payload = {
      fetchedAt: now(),
      source: 'WRI Global Power Plant Database',
      attribution:
        'Power plants: World Resources Institute, Global Power Plant Database (CC BY 4.0)',
      minCapacityMw: 250,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload, body: JSON.stringify(payload) };
    return mem;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/power-plants', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const send = (status, body) => {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (mem && now() - mem.at < TTL_MS) return send(200, mem.body);
      try {
        const run =
          inflight ||
          (inflight = refresh().finally(() => {
            inflight = null;
          }));
        const entry = await run;
        send(200, entry.body);
      } catch (error) {
        if (mem) return send(200, mem.body);
        send(502, { error: error?.message || 'Power plants unavailable' });
      }
    });
  }

  return {
    name: 'local-power-plants-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
