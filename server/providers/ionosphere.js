/**
 * NOAA SWPC GloTEC ionosphere TEC proxy (same-origin).
 *
 * Keyless (U.S. Government work, public domain). Reads the SWPC frame index,
 * fetches the newest 10-minute GeoJSON grid (host- and path-pinned), and
 * serves ~5k compact cells. One upstream refresh per TTL, retries with
 * backoff, stale fallback.
 * GET /api/ionosphere → { fetchedAt, timeTag, source, attribution, license,
 *   rawCount, count, minTec, maxTec, medianTec, rows }
 */
import {
  GLOTEC_INDEX_URL,
  latestGlotecFrame,
  normalizeGlotec,
  glotecStats,
} from '../../src/layers/ionosphere/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const HEADERS = {
  Accept: 'application/json, application/geo+json',
  'User-Agent': 'GodsEyeView/0.1 (ionosphere proxy; +https://github.com/bret1976/globe)',
};

export function ionosphereProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function getJson(url, label) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      headers: HEADERS,
    });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error(`${label} body exceeds size cap`);
    return response.json();
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const frame = latestGlotecFrame(await getJson(GLOTEC_INDEX_URL, 'GloTEC index'));
        if (!frame) throw new Error('GloTEC index has no frames');
        if (mem?.payload?.timeTag === frame.timeTag) {
          mem = { at: now(), payload: { ...mem.payload, fetchedAt: now() } };
          return mem.payload;
        }
        const body = await getJson(frame.url, 'GloTEC frame');
        const rawCount = Array.isArray(body?.features) ? body.features.length : 0;
        const { timeTag, rows } = normalizeGlotec(body);
        if (!rows.length) throw new Error('GloTEC frame returned no usable cells');
        const payload = {
          fetchedAt: now(),
          timeTag: frame.timeTag,
          frameTimeTag: timeTag,
          source: 'NOAA SWPC GloTEC',
          attribution: 'Ionosphere TEC: NOAA Space Weather Prediction Center (GloTEC)',
          license: 'U.S. Government work (public domain)',
          units: { tec: 'TECU', hmF2: 'km', nmF2: 'el/m^3' },
          rawCount,
          count: rows.length,
          ...glotecStats(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[ionosphere] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('GloTEC unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/ionosphere', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Ionosphere unavailable' });
      }
    });
  }

  return {
    name: 'local-ionosphere-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
