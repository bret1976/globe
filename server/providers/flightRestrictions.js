/**
 * FAA Temporary Flight Restrictions proxy (same-origin).
 *
 * Keyless FAA GeoServer WFS (U.S. Government work, public domain). One
 * upstream request per TTL regardless of viewer count, retried with backoff
 * on network resets, stale fallback on outage.
 * GET /api/flight-restrictions → { fetchedAt, source, attribution, license,
 *   rawCount, count, kinds, rows }
 */
import {
  FLIGHT_RESTRICTIONS_URL,
  normalizeFlightRestrictions,
  countFlightRestrictionKinds,
} from '../../src/layers/flightRestrictions/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];

export function flightRestrictionsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const response = await fetchImpl(FLIGHT_RESTRICTIONS_URL, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'follow',
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'GodsEyeView/0.1 (flight restrictions proxy; +https://github.com/bret1976/globe)',
          },
        });
        if (!response.ok) throw new Error(`FAA TFR HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          throw new Error('FAA TFR body exceeds size cap');
        const body = await response.json();
        const rawCount = Array.isArray(body?.features) ? body.features.length : 0;
        if (!Array.isArray(body?.features)) throw new Error('FAA TFR returned no feature list');
        const rows = normalizeFlightRestrictions(body);
        if (!rows.length && rawCount) throw new Error('FAA TFR returned no usable outlines');
        const payload = {
          fetchedAt: now(),
          source: 'FAA Graphic TFRs',
          attribution: 'Temporary flight restrictions: Federal Aviation Administration (tfr.faa.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Situational awareness only — not for flight planning. Check NOTAMs/tfr.faa.gov.',
          rawCount,
          count: rows.length,
          kinds: countFlightRestrictionKinds(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[flight-restrictions] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('FAA TFR unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/flight-restrictions', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Flight restrictions unavailable' });
      }
    });
  }

  return {
    name: 'local-flight-restrictions-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
