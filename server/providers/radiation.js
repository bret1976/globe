/**
 * Safecast radiation measurements proxy (same-origin).
 *
 * Public CC0 citizen science data, no API key.
 * Pages recent measurements and downsamples spatially for Cesium.
 *
 *   GET /api/radiation → { fetchedAt, source, attribution, lookbackHours,
 *                          rawCount, count, binDeg, pagesFetched, rows }
 */
import {
  normalizeSafecastMeasurements,
  SAFECAST_MEASUREMENTS_URL,
  LOOKBACK_MS,
  PAGE_SIZE,
  MAX_PAGES,
} from '../../src/layers/radiation/parse.js';

const TTL_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;

export function radiationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchPage(capturedAfter, page) {
    const url = new URL(SAFECAST_MEASUREMENTS_URL);
    url.searchParams.set('captured_after', capturedAfter);
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (radiation proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`Safecast HTTP ${response.status}`);
    const raw = await response.json();
    return Array.isArray(raw) ? raw : [];
  }

  async function refresh() {
    const t = now();
    const capturedAfter = new Date(t - LOOKBACK_MS).toISOString();
    /** @type {any[]} */
    const merged = [];
    let pagesFetched = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await fetchPage(capturedAfter, page);
      pagesFetched += 1;
      if (!batch.length) break;
      let fresh = 0;
      for (const item of batch) {
        const ts = Date.parse(String(item?.captured_at || ''));
        if (!Number.isFinite(ts) || (ts >= t - LOOKBACK_MS - 3_600_000 && ts <= t + 3_600_000)) {
          merged.push(item);
          fresh += 1;
        }
      }
      // Later pages often contain far-future junk; stop once a page is mostly bad.
      if (fresh < batch.length * 0.25) break;
      if (batch.length < PAGE_SIZE) break;
    }
    const normalized = normalizeSafecastMeasurements(merged, {
      nowMs: t,
      lookbackMs: LOOKBACK_MS,
    });
    const payload = {
      fetchedAt: t,
      source: 'Safecast',
      attribution:
        'Radiation measurements courtesy of Safecast (CC0 public domain)',
      lookbackHours: Math.round(LOOKBACK_MS / 3_600_000),
      rawCount: normalized.rawCount,
      count: normalized.rows.length,
      binDeg: normalized.binDeg,
      pagesFetched,
      rows: normalized.rows,
    };
    mem = { at: t, payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/radiation', async (req, res, next) => {
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
          error: error?.message || 'Radiation unavailable',
        });
      }
    });
  }

  return {
    name: 'local-radiation-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
