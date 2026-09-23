/**
 * Coarse Open-Meteo GFS 10 m wind grid for the globe overlay.
 *
 * No API key. TTL 20 minutes. Serve stale on a transient failure.
 *
 *   GET /api/wind → { fetchedAt, model, valid, samples: [{lat,lon,speed,direction}] }
 *
 * @returns {import('vite').Plugin}
 */
import {
  WIND_GRID_STEP_DEG,
  WIND_LAT_MAX,
  WIND_LAT_MIN,
  buildPoints,
  parseGrid,
} from '../../src/layers/wind/source.js';

const CHUNK = 24;
const TTL_MS = 20 * 60_000;
const STALE_MS = 60 * 60_000;

export function windProxy() {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    const points = buildPoints();
    const rows = [];
    for (let i = 0; i < points.length; i += CHUNK) {
      const chunk = points.slice(i, i + CHUNK);
      const params = new URLSearchParams({
        latitude: chunk.map((p) => p.lat.toFixed(2)).join(','),
        longitude: chunk.map((p) => p.lon.toFixed(2)).join(','),
        current: 'wind_speed_10m,wind_direction_10m',
        wind_speed_unit: 'kmh',
      });
      const response = await fetch(
        `https://api.open-meteo.com/v1/gfs?${params}`,
      );
      if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
      const body = await response.json();
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
    return payload;
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/wind', (req, res, next) => {
      if (req.method !== 'GET') return next();
      const now = Date.now();
      if (mem && now - mem.at < TTL_MS) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(mem.payload));
        return;
      }
      const run = inflight || (inflight = refresh().finally(() => {
        inflight = null;
      }));
      run
        .then((payload) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        })
        .catch((error) => {
          if (mem && now - mem.at < STALE_MS) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ...mem.payload, stale: true }));
            return;
          }
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: error?.message || 'Wind unavailable' }),
          );
        });
    });
  }

  return {
    name: 'local-wind-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export { WIND_GRID_STEP_DEG, WIND_LAT_MAX, WIND_LAT_MIN };
