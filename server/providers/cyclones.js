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

  /** Last good answer per feed, reused for STALE_MS when that feed fails so
   * one transient miss (e.g. right after a restart) doesn't blank storms. */
  const lastGood = { nhc: null, eonet: null };

  async function readFeed(key, settled, empty) {
    if (settled.status === 'fulfilled' && settled.value.ok) {
      try {
        const body = await settled.value.json();
        lastGood[key] = { at: Date.now(), body };
        return body;
      } catch {
        /* malformed body: fall back below */
      }
    }
    const last = lastGood[key];
    if (last && Date.now() - last.at < STALE_MS) return last.body;
    return empty;
  }

  async function refresh() {
    const [nhcRes, eonetRes] = await Promise.allSettled([
      fetch(NHC_URL),
      fetch(EONET_URL),
    ]);
    const nhc = await readFeed('nhc', nhcRes, { activeStorms: [] });
    const eonet = await readFeed('eonet', eonetRes, { events: [] });
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
      const run =
        inflight ||
        (inflight = refresh().finally(() => {
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
