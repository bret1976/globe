/**
 * Aviation Weather Center international SIGMET proxy (same-origin).
 *
 * Keyless AWC `isigmet` API (U.S. Government work, public domain): volcanic
 * ash, tropical cyclone, thunderstorm, turbulence and icing SIGMETs worldwide.
 * One upstream refresh per TTL regardless of viewer count, retried with
 * backoff, stale fallback on outage.
 * GET /api/world-sigmets → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, families, hazards, rows }
 */
import {
  AWC_ISIGMET_URL,
  normalizeWorldSigmets,
  countWorldSigmetFamilies,
  countWorldSigmetHazards,
} from '../../src/layers/worldSigmets/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (world-sigmets proxy; +https://github.com/bret1976/globe)';

export function worldSigmetsProxy({
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
        const list = await fetchJson(AWC_ISIGMET_URL);
        if (!Array.isArray(list))
          throw new Error('AWC isigmet returned no list');
        const rows = normalizeWorldSigmets(list);
        if (!rows.length && list.length)
          throw new Error('AWC isigmet returned no usable outlines');
        const payload = {
          fetchedAt: now(),
          source: 'Aviation Weather Center',
          attribution:
            'World SIGMETs: NOAA/NWS Aviation Weather Center international SIGMETs (aviationweather.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Situational awareness only — not for flight planning. Check official NOTAMs/AWC/VAAC products.',
          rawCount: list.length,
          count: rows.length,
          families: countWorldSigmetFamilies(rows),
          hazards: countWorldSigmetHazards(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[world-sigmets] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('AWC international SIGMETs unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/world-sigmets', async (req, res, next) => {
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
        send(502, { error: error?.message || 'World SIGMETs unavailable' });
      }
    });
  }

  return {
    name: 'local-world-sigmets-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
