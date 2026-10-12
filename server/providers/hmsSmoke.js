/**
 * NOAA NESDIS HMS smoke plume proxy (same-origin).
 *
 * Keyless daily KML (U.S. Government work, public domain).
 * Prefer today's UTC product; fall back to yesterday when today is empty
 * (common early in the UTC day before analysts publish).
 * GET /api/hms-smoke → { fetchedAt, source, attribution, license, note,
 *   dateKey, rawCount, count, densities, rows }
 */
import {
  hmsSmokeKmlUrlForDate,
  normalizeHmsSmokeKml,
  countHmsSmokeDensities,
} from '../../src/layers/hmsSmoke/parse.js';

const TTL_MS = 30 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (hms-smoke proxy; +https://github.com/bret1976/globe)';

function dateKeyUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function hmsSmokeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchKml(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/vnd.google-earth.kml+xml, application/xml, text/xml, */*',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`HMS HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('HMS body exceeds size cap');
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('HMS body exceeds size cap');
    return text;
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const today = new Date(now());
        const yesterday = new Date(today.getTime() - 24 * 60 * 60_000);
        const todayKey = dateKeyUtc(today);
        const yesterdayKey = dateKeyUtc(yesterday);
        let kml = await fetchKml(hmsSmokeKmlUrlForDate(today));
        let dateKey = todayKey;
        let rows = normalizeHmsSmokeKml(kml, { dateKey });
        if (!rows.length) {
          kml = await fetchKml(hmsSmokeKmlUrlForDate(yesterday));
          dateKey = yesterdayKey;
          rows = normalizeHmsSmokeKml(kml, { dateKey });
        }
        const payload = {
          fetchedAt: now(),
          source: 'NOAA NESDIS Hazard Mapping System',
          attribution:
            'Smoke Plumes: NOAA NESDIS HMS (satepsanone.nesdis.noaa.gov)',
          license: 'U.S. Government work (public domain)',
          note:
            'Analyst-drawn multisatellite smoke polygons (Light/Medium/Heavy). Situational awareness only.',
          dateKey,
          rawCount: rows.length,
          count: rows.length,
          densities: countHmsSmokeDensities(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[hms-smoke] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('HMS smoke unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/hms-smoke', async (req, res, next) => {
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
      try {
        const age = mem ? now() - mem.at : Infinity;
        if (mem && age < TTL_MS) {
          send(200, mem.payload);
          return;
        }
        if (!inflight) inflight = refresh().finally(() => { inflight = null; });
        const payload = await inflight;
        send(200, payload);
      } catch (error) {
        if (mem && now() - mem.at < STALE_MS) {
          send(200, mem.payload, true);
          return;
        }
        send(502, {
          error: 'hms_smoke_unavailable',
          message: error?.message || 'HMS smoke unavailable',
        });
      }
    });
  }

  return {
    name: 'local-hms-smoke-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
