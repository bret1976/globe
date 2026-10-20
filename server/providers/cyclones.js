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
  const UA =
    'GodsEyeView/0.1 (cyclones proxy; +https://github.com/bret1976/globe)';

  /** One feed: 20 s per attempt, up to 3 attempts; failures are logged. */
  async function fetchFeed(key, url) {
    let lastError = null;
    for (const wait of [0, 1500, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { Accept: 'application/json', 'User-Agent': UA },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    console.warn(
      `[cyclones] ${key} unavailable:`,
      lastError?.cause?.code || lastError?.name || lastError?.message,
    );
    throw lastError;
  }

  async function readFeed(key, url, empty, feeds) {
    try {
      const body = await fetchFeed(key, url);
      lastGood[key] = { at: Date.now(), body };
      feeds[key] = 'ok';
      return body;
    } catch {
      const last = lastGood[key];
      if (last && Date.now() - last.at < STALE_MS) {
        feeds[key] = 'stale';
        return last.body;
      }
      feeds[key] = 'down';
      return empty;
    }
  }

  async function refresh() {
    const feeds = {};
    const [nhc, eonet] = await Promise.all([
      readFeed('nhc', NHC_URL, { activeStorms: [] }, feeds),
      readFeed('eonet', EONET_URL, { events: [] }, feeds),
    ]);
    const payload = { ...mergeCycloneSnapshots(nhc, eonet), feeds };
    // A refresh where every feed is down is cached briefly (60 s) so the
    // browser-direct fallback kicks in quickly and we retry soon.
    const down = feeds.nhc === 'down' && feeds.eonet === 'down';
    mem = { at: down ? Date.now() - TTL_MS + 60_000 : Date.now(), payload };
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
