/**
 * NOAA CO-OPS tide-gauge proxy (same-origin).
 *
 * U.S. government public domain JSON; no API key.
 *
 *   GET /api/tide-gauges → { fetchedAt, source, attribution, rawCount, count, rows }
 */
import {
  normalizeTideGauges,
  parseTideLevelPayload,
  parseTideStation,
  tideGaugeLatestUrl,
  TIDE_STATIONS_URL,
} from '../../src/layers/tideGauges/parse.js';

const TTL_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const CONCURRENCY = 28;
const LEVEL_TIMEOUT_MS = 12_000;

export function tideGaugesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function fetchStations() {
    const response = await fetchImpl(TIDE_STATIONS_URL, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'GodsEyeView/0.1 (tide-gauges proxy; +https://github.com/bret1976/globe)',
      },
    });
    if (!response.ok) throw new Error(`CO-OPS stations HTTP ${response.status}`);
    return response.json();
  }

  async function fetchLevel(stationId) {
    try {
      const response = await fetchImpl(tideGaugeLatestUrl(stationId), {
        signal: AbortSignal.timeout(LEVEL_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'GodsEyeView/0.1 (tide-gauges proxy; +https://github.com/bret1976/globe)',
        },
      });
      if (!response.ok) return null;
      const body = await response.json();
      return parseTideLevelPayload(body);
    } catch {
      return null;
    }
  }

  async function fetchLevelsPool(ids) {
    /** @type {Map<string, {waterLevelFt: ?number, observedAt: string}>} */
    const levels = new Map();
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        const level = await fetchLevel(id);
        if (level && Number.isFinite(level.waterLevelFt)) {
          levels.set(id, level);
        }
      }
    }
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, ids.length)) },
      () => worker(),
    );
    await Promise.all(workers);
    return levels;
  }

  async function refresh() {
    const collection = await fetchStations();
    const stations = Array.isArray(collection?.stations)
      ? collection.stations
      : [];
    const ids = [];
    for (const station of stations) {
      const parsed = parseTideStation(station);
      if (parsed) ids.push(parsed.id);
    }
    const levels = await fetchLevelsPool(ids);
    const rows = normalizeTideGauges(collection, levels);
    const payload = {
      fetchedAt: now(),
      source: 'NOAA CO-OPS',
      attribution:
        'Water-level observations courtesy of NOAA Center for Operational Oceanographic Products and Services (tidesandcurrents.noaa.gov)',
      rawCount: stations.length,
      levelCount: levels.size,
      count: rows.length,
      rows,
    };
    mem = { at: now(), payload };
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/tide-gauges', async (req, res, next) => {
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
        const payload = await run;
        send(200, payload);
      } catch (error) {
        if (mem && t - mem.at < STALE_MS) {
          send(200, { ...mem.payload, stale: true }, true);
          return;
        }
        send(502, {
          error: error?.message || 'Tide gauges unavailable',
        });
      }
    });
  }

  return {
    name: 'local-tide-gauges-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
