/**
 * Sensor.Community proxy (same-origin).
 *
 * Open, keyless feed. GET /api/air-quality → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import { AIR_QUALITY_URL, normalizeAirQuality } from '../../src/layers/airQuality/parse.js';

const TTL_MS = 10 * 60_000;
const STALE_MS = 3 * 60 * 60_000;

export function airQualityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const response = await fetchImpl(AIR_QUALITY_URL, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (air-quality proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`Sensor.Community HTTP ${response.status}`);
    const body = await response.json();
    const raw = Array.isArray(body) ? body : Array.isArray(body?.features) ? body.features : [];
    const rows = normalizeAirQuality(body);
    if (!rows.length && raw.length) throw new Error('Sensor.Community returned no usable rows');
    const payload = {
      fetchedAt: now(),
      source: 'Sensor.Community',
      attribution:
        'Particulate readings: Sensor.Community open citizen-science sensor network (sensor.community)',
      rawCount: raw.length,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/air-quality', async (req, res, next) => {
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
          error: error?.message || 'Air quality unavailable',
        });
      }
    });
  }

  return {
    name: 'local-air-quality-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
