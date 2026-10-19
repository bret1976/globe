/**
 * Aviation Weather Center hazards proxy (same-origin).
 *
 * Keyless AWC APIs (U.S. Government work, public domain). Merges SIGMETs,
 * G-AIRMETs, and Center Weather Advisories. One upstream refresh per TTL
 * regardless of viewer count, retried with backoff, stale fallback on outage.
 * GET /api/aviation-hazards → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, families, products, rows[, partial] }
 *
 * Each AWC product is fetched on its own. "Nothing active" is a normal answer:
 * AWC replies 204 No Content (empty body) when, for example, no Center Weather
 * Advisory is in force, and that is read as an empty list rather than a parse
 * failure. A product that genuinely fails on every attempt is served from its
 * last good list (within the stale window) or left empty and named in
 * `partial`, so one bad product never takes down the other two.
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
    // 204 No Content = no active products of this kind; not an error.
    if (response.status === 204) return [];
    if (!response.ok) throw new Error(`AWC HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('AWC body exceeds size cap');
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('AWC body exceeds size cap');
    // An empty 200 body is the same "nothing active" answer as a 204.
    if (!text.trim()) return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`AWC returned a non-JSON body for ${url}`);
    }
  }

  const FEEDS = Object.freeze([
    ['sigmet', AWC_SIGMET_URL],
    ['gairmet', AWC_GAIRMET_URL],
    ['cwa', AWC_CWA_URL],
  ]);
  /** Last good list per product, so a failing product can serve stale. */
  const lastGood = new Map();

  async function refresh() {
    let lastError = null;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
      const wait = BACKOFF_MS[attempt];
      const finalAttempt = attempt === BACKOFF_MS.length - 1;
      if (wait) await sleep(wait);
      try {
        const settled = await Promise.allSettled(
          FEEDS.map(([, url]) => fetchJson(url)),
        );
        const failed = [];
        const lists = {};
        settled.forEach((outcome, i) => {
          const [name] = FEEDS[i];
          if (outcome.status === 'fulfilled') {
            lists[name] = outcome.value;
            return;
          }
          failed.push(name);
          lastError = outcome.reason;
        });
        if (failed.length === FEEDS.length)
          throw lastError || new Error('AWC hazards unavailable');
        // Retry while attempts remain; only the last attempt settles for a
        // partial answer.
        if (failed.length && !finalAttempt)
          throw lastError || new Error(`AWC ${failed.join(', ')} failed`);
        const t = now();
        for (const name of failed) {
          const prior = lastGood.get(name);
          lists[name] = prior && t - prior.at < STALE_MS ? prior.list : [];
        }
        for (const [name] of FEEDS)
          if (!failed.includes(name)) lastGood.set(name, { at: t, list: lists[name] });
        const sigmets = lists.sigmet;
        const gairmets = lists.gairmet;
        const cwas = lists.cwa;
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
          ...(failed.length ? { partial: failed } : {}),
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
