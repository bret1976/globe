/**
 * Aviation Weather Center hazards proxy (same-origin).
 *
 * Keyless AWC APIs (U.S. Government work, public domain). Merges SIGMETs,
 * G-AIRMETs, and Center Weather Advisories. One upstream refresh per TTL
 * regardless of viewer count, retried with backoff, stale fallback on outage.
 * GET /api/aviation-hazards → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, families, products, rows }
 */
import {
  AWC_SIGMET_URL,
  AWC_GAIRMET_URL,
  AWC_CWA_URL,
  normalizeAviationHazards,
  countAviationHazardFamilies,
  countAviationHazardProducts,
} from '../../src/layers/aviationHazards/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (aviation hazards proxy; +https://github.com/bret1976/globe)';

export function aviationHazardsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`AWC HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('AWC body exceeds size cap');
    return response.json();
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const [sigmets, gairmets, cwas] = await Promise.all([
          fetchJson(AWC_SIGMET_URL),
          fetchJson(AWC_GAIRMET_URL),
          fetchJson(AWC_CWA_URL),
        ]);
        const rawCount =
          (Array.isArray(sigmets) ? sigmets.length : 0) +
          (Array.isArray(gairmets) ? gairmets.length : 0) +
          (Array.isArray(cwas) ? cwas.length : 0);
        if (!Array.isArray(sigmets) && !Array.isArray(gairmets) && !Array.isArray(cwas))
          throw new Error('AWC returned no hazard lists');
        const rows = normalizeAviationHazards({ sigmets, gairmets, cwas });
        if (!rows.length && rawCount)
          throw new Error('AWC returned no usable outlines');
        const payload = {
          fetchedAt: now(),
          source: 'Aviation Weather Center',
          attribution:
            'Aviation hazards: NOAA/NWS Aviation Weather Center (aviationweather.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Situational awareness only — not for flight planning. Check official NOTAMs/AWC products.',
          rawCount,
          count: rows.length,
          families: countAviationHazardFamilies(rows),
          products: countAviationHazardProducts(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[aviation-hazards] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('AWC hazards unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/aviation-hazards', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Aviation hazards unavailable' });
      }
    });
  }

  return {
    name: 'local-aviation-hazards-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
