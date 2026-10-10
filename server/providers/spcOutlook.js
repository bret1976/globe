/**
 * NOAA/NWS SPC convective outlook proxy (same-origin).
 *
 * Keyless Day 1/2 categorical GeoJSON (U.S. Government work, public domain).
 * One upstream refresh per TTL, stale fallback on outage.
 * GET /api/spc-outlook → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, labels, days, rows }
 */
import {
  SPC_DAY1_CAT_URL,
  SPC_DAY2_CAT_URL,
  normalizeSpcOutlook,
  countSpcOutlookLabels,
  countSpcOutlookDays,
} from '../../src/layers/spcOutlook/parse.js';

const TTL_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (spc outlook proxy; +https://github.com/bret1976/globe)';

export function spcOutlookProxy({
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
        Accept: 'application/geo+json, application/json',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`SPC HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('SPC body exceeds size cap');
    return response.json();
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const [day1, day2] = await Promise.all([
          fetchJson(SPC_DAY1_CAT_URL),
          fetchJson(SPC_DAY2_CAT_URL),
        ]);
        const rawCount =
          (Array.isArray(day1?.features) ? day1.features.length : 0) +
          (Array.isArray(day2?.features) ? day2.features.length : 0);
        if (!Array.isArray(day1?.features) && !Array.isArray(day2?.features))
          throw new Error('SPC returned no outlook features');
        const rows = normalizeSpcOutlook({ day1, day2 });
        if (!rows.length && rawCount)
          throw new Error('SPC returned no usable polygons');
        const payload = {
          fetchedAt: now(),
          source: 'NOAA/NWS Storm Prediction Center',
          attribution:
            'SPC Outlook: NOAA/NWS Storm Prediction Center (spc.noaa.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Categorical convective outlook (Day 1 + Day 2). Situational awareness only.',
          rawCount,
          count: rows.length,
          labels: countSpcOutlookLabels(rows),
          days: countSpcOutlookDays(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[spc-outlook] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('SPC outlook unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/spc-outlook', async (req, res, next) => {
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
        send(502, { error: error?.message || 'SPC outlook unavailable' });
      }
    });
  }

  return {
    name: 'local-spc-outlook-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
