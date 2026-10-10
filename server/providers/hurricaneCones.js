/**
 * NOAA/NHC forecast cone + track + points proxy (same-origin).
 *
 * Keyless NHC/CPHC tropical weather summary GIS (U.S. Government work,
 * public domain). NHC does not advertise CORS, so the browser reads this
 * route. One upstream refresh per TTL, stale fallback on outage.
 * Idea and GIS layer choice from bilawalsidhu/gods-eye-view v0.2.0 (MIT).
 *
 * GET /api/hurricane-cones → { fetchedAt, source, attribution, license,
 *   note, count, rows }
 */
import {
  NHC_LAYERS,
  nhcLayerQueryUrl,
  normalizeHurricaneCones,
} from '../../src/layers/hurricaneCones/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 3 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (hurricane cones proxy; +https://github.com/bret1976/globe)';

export function hurricaneConesProxy({
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
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`NHC GIS HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('NHC GIS body exceeds size cap');
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES)
      throw new Error('NHC GIS body exceeds size cap');
    const json = JSON.parse(body);
    if (json?.error) throw new Error('NHC GIS query error');
    if (!Array.isArray(json?.features))
      throw new Error('NHC GIS returned no feature list');
    return json;
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const [points, track, cone] = await Promise.all([
          fetchJson(nhcLayerQueryUrl(NHC_LAYERS.points)),
          fetchJson(nhcLayerQueryUrl(NHC_LAYERS.track)),
          fetchJson(nhcLayerQueryUrl(NHC_LAYERS.cone)),
        ]);
        const rows = normalizeHurricaneCones({ points, track, cone });
        const payload = {
          fetchedAt: now(),
          source: 'NOAA/NWS National Hurricane Center',
          attribution:
            'Hurricane cones: NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center (nhc.noaa.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Official forecast cone, track and points for active Atlantic / East + Central Pacific storms. The cone is track uncertainty, not storm size.',
          rawCount: {
            points: points.features.length,
            track: track.features.length,
            cone: cone.features.length,
          },
          count: rows.length,
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[hurricane-cones] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('Hurricane cones unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/hurricane-cones', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Hurricane cones unavailable' });
      }
    });
  }

  return {
    name: 'local-hurricane-cones-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
