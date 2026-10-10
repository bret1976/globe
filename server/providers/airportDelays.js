/**
 * FAA NAS airport status proxy (same-origin).
 *
 * Keyless XML from nasstatus.faa.gov; resolves airport lat/lon via AWC
 * airport lookup (cached 24h). U.S. Government work (public domain).
 * GET /api/airport-delays → { fetchedAt, source, attribution, license, note,
 *   rawCount, count, kinds, rows }
 */
import {
  FAA_AIRPORT_STATUS_URL,
  awcAirportLookupUrl,
  parseAirportStatusXml,
  indexAwcAirports,
  attachAirportCoords,
  countAirportDelayKinds,
  MAX_AIRPORT_DELAYS,
} from '../../src/layers/airportDelays/parse.js';

const TTL_MS = 2.5 * 60_000;
const STALE_MS = 60 * 60_000;
const COORD_CACHE_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BACKOFF_MS = [0, 1500, 4000];
const UA =
  'GodsEyeView/0.1 (airport delays proxy; +https://github.com/bret1976/globe)';

export function airportDelaysProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;
  /** @type {Map<string, {lat: number, lon: number, name: ?string, at: number}>} */
  const coordCache = new Map();

  async function fetchText(url, accept) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      headers: {
        Accept: accept,
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`FAA/AWC HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('Airport status body exceeds size cap');
    return response.text();
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`AWC airport HTTP ${response.status}`);
    return response.json();
  }

  function cachedCoords(icaos) {
    const t = now();
    /** @type {Map<string, {lat: number, lon: number, name: ?string}>} */
    const map = new Map();
    /** @type {string[]} */
    const missing = [];
    for (const icao of icaos) {
      const hit = coordCache.get(icao);
      if (hit && t - hit.at < COORD_CACHE_MS) {
        map.set(icao, { lat: hit.lat, lon: hit.lon, name: hit.name });
      } else {
        missing.push(icao);
      }
    }
    return { map, missing };
  }

  async function resolveCoords(icaos) {
    const unique = [...new Set(icaos.filter(Boolean))];
    const { map, missing } = cachedCoords(unique);
    if (!missing.length) return map;
    // AWC accepts comma-separated ids; batch in chunks of 40.
    for (let i = 0; i < missing.length; i += 40) {
      const chunk = missing.slice(i, i + 40);
      const body = await fetchJson(awcAirportLookupUrl(chunk));
      const indexed = indexAwcAirports(body);
      const t = now();
      for (const [icao, coords] of indexed) {
        coordCache.set(icao, { ...coords, at: t });
        map.set(icao, coords);
      }
    }
    return map;
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const xml = await fetchText(FAA_AIRPORT_STATUS_URL, 'application/xml, text/xml, */*');
        const records = parseAirportStatusXml(xml);
        const rawCount = records.length;
        if (!rawCount) {
          const payload = {
            fetchedAt: now(),
            source: 'FAA NAS Status',
            attribution:
              'Airport delays: Federal Aviation Administration NAS Status (nasstatus.faa.gov)',
            license: 'U.S. Government work (public domain)',
            note: 'Situational awareness only — not for flight planning.',
            rawCount: 0,
            count: 0,
            kinds: {},
            rows: [],
          };
          mem = { at: now(), payload };
          return payload;
        }
        const coordByIcao = await resolveCoords(records.map((r) => r.icao));
        const rows = attachAirportCoords(records, coordByIcao).slice(
          0,
          MAX_AIRPORT_DELAYS,
        );
        const payload = {
          fetchedAt: now(),
          source: 'FAA NAS Status',
          attribution:
            'Airport delays: Federal Aviation Administration NAS Status (nasstatus.faa.gov); coords via NOAA/NWS Aviation Weather Center',
          license: 'U.S. Government work (public domain)',
          note: 'Situational awareness only — not for flight planning.',
          rawCount,
          count: rows.length,
          kinds: countAirportDelayKinds(rows),
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[airport-delays] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    throw lastError || new Error('Airport delays unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/airport-delays', async (req, res, next) => {
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
        send(502, { error: error?.message || 'Airport delays unavailable' });
      }
    });
  }

  return {
    name: 'local-airport-delays-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
