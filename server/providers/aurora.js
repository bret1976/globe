/**
 * NOAA SWPC OVATION aurora forecast proxy (same-origin).
 *
 * Public US government open data, no API key.
 * Downsamples the ~65k-cell grid server-side for Cesium performance.
 *
 *   GET /api/aurora → { fetchedAt, source, attribution, observationTime,
 *                       forecastTime, rawCount, count, minAuroraUsed, binDeg, rows }
 */
import {
  normalizeOvationAurora,
  OVATION_URL,
} from '../../src/layers/aurora/parse.js';

const TTL_MS = 10 * 60_000;
const STALE_MS = 2 * 60 * 60_000;

export function auroraProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(OVATION_URL, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (aurora proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`NOAA OVATION HTTP ${response.status}`);
    const raw = await response.json();
    const normalized = normalizeOvationAurora(raw);
    const payload = {
      fetchedAt: now(),
      source: 'NOAA SWPC OVATION',
      attribution:
        'Aurora 30-minute forecast courtesy of NOAA Space Weather Prediction Center (OVATION)',
      observationTime: normalized.observationTime,
      forecastTime: normalized.forecastTime,
      rawCount: normalized.rawCount,
      count: normalized.rows.length,
      minAuroraUsed: normalized.minAuroraUsed,
      binDeg: normalized.binDeg,
      rows: normalized.rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/aurora', async (req, res, next) => {
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
          error: error?.message || 'Aurora unavailable',
        });
      }
    });
  }

  return {
    name: 'local-aurora-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
