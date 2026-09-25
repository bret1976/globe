/**
 * Cyclone context proxy — NOAA NHC current storms plus NASA EONET
 * severeStorms so Western Pacific typhoons appear alongside Atlantic /
 * East Pacific advisories.
 *
 * No API keys. TTL 3 minutes. Serve stale on a transient failure.
 *
 *   GET /api/cyclones → { fetchedAt, storms: Array }
 *
 * @returns {import('vite').Plugin}
 */
import {
  EONET_URL,
  NHC_URL,
  mergeCycloneSnapshots,
} from '../../src/layers/cyclones/source.js';

const TTL_MS = 3 * 60_000;
const STALE_MS = 20 * 60_000;

export function cyclonesProxy() {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const [nhcRes, eonetRes] = await Promise.allSettled([
      fetch(NHC_URL),
      fetch(EONET_URL),
    ]);
    const nhc =
      nhcRes.status === 'fulfilled' && nhcRes.value.ok
        ? await nhcRes.value.json()
        : { activeStorms: [] };
    const eonet =
      eonetRes.status === 'fulfilled' && eonetRes.value.ok
        ? await eonetRes.value.json()
        : { events: [] };
    const payload = mergeCycloneSnapshots(nhc, eonet);
    mem = { at: Date.now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/cyclones', (req, res, next) => {
      if (req.method !== 'GET') return next();
      const now = Date.now();
      if (mem && now - mem.at < TTL_MS) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(mem.payload));
        return;
      }
      const run = inflight || (inflight = refresh().finally(() => {
        inflight = null;
      }));
      run
        .then((payload) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        })
        .catch((error) => {
          if (mem && now - mem.at < STALE_MS) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ...mem.payload, stale: true }));
            return;
          }
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: error?.message || 'Cyclones unavailable',
            }),
          );
        });
    });
  }

  return {
    name: 'local-cyclones-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
