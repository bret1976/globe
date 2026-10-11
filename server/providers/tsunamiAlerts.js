/**
 * NOAA/NWS tsunami.gov Atom proxy (same-origin).
 *
 * Keyless public-domain geo Atom from NTWC (PAAQ) + PTWC (PHEB).
 * GET /api/tsunami-alerts → { fetchedAt, source, attribution, license,
 * rawCount, count, rows, centers }
 */
import {
  mergeTsunamiRows,
  normalizeTsunamiAtom,
  TSUNAMI_FEED_URLS,
} from '../../src/layers/tsunamiAlerts/parse.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BACKOFF_MS = [0, 1200, 3000];
const UA =
  'GodsEyeView/0.1 (tsunami-alerts proxy; +https://github.com/bret1976/globe)';

export function tsunamiAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchAtom(url) {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'follow',
          headers: {
            Accept: 'application/atom+xml, application/xml, text/xml, */*',
            'User-Agent': UA,
          },
        });
        if (!response.ok) throw new Error(`tsunami.gov HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          throw new Error('tsunami.gov Atom body exceeds size cap');
        const text = await response.text();
        if (!text || text.length > MAX_BODY_BYTES)
          throw new Error('tsunami.gov Atom body empty or oversized');
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('tsunami.gov Atom unavailable');
  }

  async function refresh() {
    const lists = [];
    const centers = [];
    let rawCount = 0;
    const errors = [];
    for (const feed of TSUNAMI_FEED_URLS) {
      try {
        const xml = await fetchAtom(feed.url);
        const rows = normalizeTsunamiAtom(xml, { center: feed.center });
        lists.push(rows);
        centers.push({
          center: feed.center,
          url: feed.url,
          count: rows.length,
        });
        rawCount += rows.length;
      } catch (error) {
        errors.push(`${feed.center}: ${error?.message || error}`);
        console.warn(
          '[tsunami-alerts] feed failed:',
          feed.center,
          error?.message || error,
        );
      }
    }
    if (!lists.length) {
      throw new Error(
        errors.join('; ') || 'tsunami.gov Atom feeds unavailable',
      );
    }
    const rows = mergeTsunamiRows(lists);
    const payload = {
      fetchedAt: now(),
      source: 'NOAA/NWS tsunami.gov Atom (PAAQ + PHEB)',
      attribution:
        'Tsunami bulletins courtesy of the National Tsunami Warning Center (PAAQ) and Pacific Tsunami Warning Center (PHEB) at tsunami.gov',
      license: 'U.S. Government work (public domain)',
      rawCount,
      count: rows.length,
      centers,
      ...(errors.length ? { feedWarnings: errors } : {}),
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/tsunami-alerts', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Tsunami alerts unavailable' });
      }
    });
  }

  return {
    name: 'local-tsunami-alerts-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
