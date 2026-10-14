/**
 * Environment and Climate Change Canada weather alerts proxy (same-origin).
 *
 * Keyless MSC GeoMet OGC API `weather-alerts` collection: active public
 * warnings, watches, advisories and statements as region polygons. ECCC Data
 * Servers End-use Licence (commercial use OK with attribution). One upstream
 * refresh per TTL regardless of viewer count, retried with backoff, stale
 * fallback on outage. Expired / ended alerts are dropped.
 * GET /api/canada-alerts → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, types, names, rows }
 */
import {
  ECCC_ALERTS_URL,
  normalizeCanadaAlerts,
  countCanadaAlertTypes,
  countCanadaAlertNames,
} from '../../src/layers/canadaAlerts/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (canada-alerts proxy; +https://github.com/bret1976/globe)';

export function canadaAlertsProxy({
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
    if (!response.ok) throw new Error(`ECCC HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('ECCC body exceeds size cap');
    return response.json();
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const geojson = await fetchJson(ECCC_ALERTS_URL);
        const features = Array.isArray(geojson?.features)
          ? geojson.features
          : null;
        if (!features) throw new Error('ECCC weather-alerts returned no features');
        const rows = normalizeCanadaAlerts(geojson, { nowMs: now() });
        const payload = {
          fetchedAt: now(),
          source: 'Environment and Climate Change Canada',
          attribution:
            'Data Source: Environment and Climate Change Canada (MSC GeoMet weather alerts)',
          license:
            'Environment and Climate Change Canada Data Servers End-use Licence',
          note: 'Official alerts: check weather.gc.ca for the full, current text.',
          rawCount: features.length,
          count: rows.length,
          types: countCanadaAlertTypes(rows),
          names: countCanadaAlertNames(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[canada-alerts] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('ECCC weather alerts unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/canada-alerts', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Canada weather alerts unavailable' });
      }
    });
  }

  return {
    name: 'local-canada-alerts-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
