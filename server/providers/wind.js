/**
 * Coarse Open-Meteo GFS 10 m wind grid for the globe overlay.
 *
 * No API key. TTL 20 minutes. Serve stale on a transient failure.
 *
 *   GET /api/wind → { fetchedAt, model, valid, samples: [{lat,lon,speed,direction}] }
 *
 * @returns {import('vite').Plugin}
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  WIND_GRID_STEP_DEG,
  WIND_LAT_MAX,
  WIND_LAT_MIN,
  buildPoints,
  parseGrid,
} from '../../src/layers/wind/source.js';

const CHUNK = 80;
const TTL_MS = 20 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'wind.json');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function windProxy() {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;
  let diskChecked = false;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && parsed?.payload?.samples) mem = parsed;
    } catch {
      /* first run */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry));
    } catch (err) {
      console.warn('[wind-proxy] cache write failed:', err?.message || err);
    }
  }

  async function fetchChunk(params, attempt = 0) {
    const response = await fetch(`https://api.open-meteo.com/v1/gfs?${params}`);
    if (response.status === 429 && attempt < 5) {
      await delay(2000 * 2 ** attempt);
      return fetchChunk(params, attempt + 1);
    }
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
    return response.json();
  }

  async function refresh() {
    const points = buildPoints();
    const rows = [];
    for (let i = 0; i < points.length; i += CHUNK) {
      if (i) await delay(400);
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
    const payload = parseGrid({
      latitude: rows.map((row) => row.latitude),
      longitude: rows.map((row) => row.longitude),
      current: {
        time: rows[0]?.current?.time || null,
        wind_speed_10m: rows.map((row) => row.current?.wind_speed_10m),
        wind_direction_10m: rows.map((row) => row.current?.wind_direction_10m),
      },
    });
    mem = { at: Date.now(), payload };
    void writeDisk(mem);
    return payload;
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
      if (!inflight) {
        inflight = refresh()
          .catch((error) => {
            console.warn(
              '[wind-proxy] refresh failed:',
              error?.message || error,
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
      if (inflight) return;
      inflight = refresh()
        .catch((error) => {
          console.warn(
            '[wind-proxy] prefetch failed:',
            error?.message || error,
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
