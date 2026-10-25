/**
 * Coarse GFS 10 m wind grid for the globe overlay.
 *
 * No API key. TTL 20 minutes. Serve stale on a transient failure.
 *
 * Primary: NOAA NCEP GFS u/v wind from the PacIOOS ERDDAP — one request for
 * the whole lattice. Fallback: Open-Meteo GFS in paced batches. Open-Meteo
 * counts every grid point as one API call, so the old 765-point burst every
 * 20 minutes blew through its 600/minute and 10,000/day free limits on the
 * shared Railway egress address and the proxy stayed "warming" for days.
 *
 *   GET /api/wind → { fetchedAt, model, valid, samples: [{lat,lon,speed,direction}] }
 *
 * @returns {import('vite').Plugin}
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  buildErddapWindUrl,
  parseErddapWind,
  WIND_GRID_STEP_DEG,
  WIND_LAT_MAX,
  WIND_LAT_MIN,
  buildPoints,
  parseGrid,
} from '../../src/layers/wind/source.js';

const CHUNK = 80;
/** Gap between Open-Meteo fallback batches: 80 points per 9 s ≈ 530/minute,
 * under the free 600/minute limit. */
const OPEN_METEO_CHUNK_GAP_MS = 9_000;
const ERDDAP_TIMEOUT_MS = 30_000;
const TTL_MS = 20 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');

/** After a refresh fails (e.g. Open-Meteo 429 on the shared egress address),
 * no new refresh starts for this long; stale data (or the warming payload,
 * which makes browsers fetch the grid directly) is served meanwhile. Retrying
 * every request only spends more of the address's quota. */
const FAILURE_BACKOFF_MS = 30 * 60_000;
/** 429 retries inside one refresh (2 s, 4 s). */
const MAX_429_RETRIES = 2;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ cacheDir?: string, fetchImpl?: typeof fetch, chunkGapMs?: number }} [options]
 *   cacheDir, fetchImpl and chunkGapMs are for tests.
 */
export function windProxy({
  cacheDir = CACHE_DIR,
  fetchImpl = (...args) => globalThis.fetch(...args),
  chunkGapMs = OPEN_METEO_CHUNK_GAP_MS,
} = {}) {
  const cachePath = path.join(cacheDir, 'wind.json');
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;
  let diskChecked = false;
  /** No refresh starts before this time (epoch ms) after a failed one. */
  let retryAfterAt = 0;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && parsed?.payload?.samples) mem = parsed;
    } catch {
      /* first run */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry));
    } catch (err) {
      console.warn('[wind-proxy] cache write failed:', err?.message || err);
    }
  }

  async function fetchChunk(params, attempt = 0) {
    const response = await fetchImpl(
      `https://api.open-meteo.com/v1/gfs?${params}`,
    );
    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      await response.body?.cancel().catch(() => {});
      await delay(2000 * 2 ** attempt);
      return fetchChunk(params, attempt + 1);
    }
    if (!response.ok) {
      let reason = '';
      try {
        const body = await response.json();
        reason = String(body?.reason || '').slice(0, 120);
      } catch {
        /* no JSON reason */
      }
      throw new Error(
        `Open-Meteo ${response.status}${reason ? ` (${reason})` : ''}`,
      );
    }
    return response.json();
  }

  async function fetchErddap() {
    const response = await fetchImpl(buildErddapWindUrl(Date.now()), {
      signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`ERDDAP GFS ${response.status}`);
    }
    return parseErddapWind(await response.json());
  }

  async function refresh() {
    let payload;
    try {
      payload = await fetchErddap();
    } catch (error) {
      console.warn(
        '[wind-proxy] NOAA GFS (ERDDAP) failed, using Open-Meteo:',
        error?.message || error,
      );
      payload = await fetchOpenMeteo();
    }
    mem = { at: Date.now(), payload };
    void writeDisk(mem);
    return payload;
  }

  async function fetchOpenMeteo() {
    const points = buildPoints();
    const rows = [];
    for (let i = 0; i < points.length; i += CHUNK) {
      if (i) await delay(chunkGapMs);
      const chunk = points.slice(i, i + CHUNK);
      const params = new URLSearchParams({
        latitude: chunk.map((p) => p.lat.toFixed(2)).join(','),
        longitude: chunk.map((p) => p.lon.toFixed(2)).join(','),
        current: 'wind_speed_10m,wind_direction_10m',
        wind_speed_unit: 'kmh',
      });
      const body = await fetchChunk(params);
      if (Array.isArray(body)) rows.push(...body);
      else rows.push(body);
    }
    return {
      ...parseGrid({
        latitude: rows.map((row) => row.latitude),
        longitude: rows.map((row) => row.longitude),
        current: {
          time: rows[0]?.current?.time || null,
          wind_speed_10m: rows.map((row) => row.current?.wind_speed_10m),
          wind_direction_10m: rows.map(
            (row) => row.current?.wind_direction_10m,
          ),
        },
      }),
      provider: 'open-meteo',
    };
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/wind', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      await readDiskOnce();
      const now = Date.now();
      const send = (payload) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (mem && now - mem.at < TTL_MS) {
        send(mem.payload);
        return;
      }
      if (!inflight && now >= retryAfterAt) {
        inflight = refresh()
          .catch((error) => {
            retryAfterAt = Date.now() + FAILURE_BACKOFF_MS;
            console.warn(
              '[wind-proxy] refresh failed:',
              error?.message || error,
              '— next attempt in 30 min',
            );
            return null;
          })
          .finally(() => {
            inflight = null;
          });
      }
      // Never block the globe on Open-Meteo (first fill is ~40s). Serve stale
      // immediately, or an empty warming payload while the grid fills.
      if (mem && now - mem.at < STALE_MS) {
        send({ ...mem.payload, stale: true });
        return;
      }
      send({
        fetchedAt: null,
        model: 'gfs',
        valid: null,
        samples: [],
        warming: true,
      });
    });
  }

  function prefetch() {
    void readDiskOnce().then(() => {
      const now = Date.now();
      if (mem && now - mem.at < TTL_MS) return;
      if (inflight || now < retryAfterAt) return;
      inflight = refresh()
        .catch((error) => {
          retryAfterAt = Date.now() + FAILURE_BACKOFF_MS;
          console.warn(
            '[wind-proxy] prefetch failed:',
            error?.message || error,
            '— next attempt in 30 min',
          );
          return null;
        })
        .finally(() => {
          inflight = null;
        });
    });
  }

  return {
    name: 'local-wind-proxy',
    configureServer(server) {
      prefetch();
      installMiddleware(server);
    },
    configurePreviewServer(server) {
      prefetch();
      installMiddleware(server);
    },
  };
}

export { WIND_GRID_STEP_DEG, WIND_LAT_MAX, WIND_LAT_MIN };
