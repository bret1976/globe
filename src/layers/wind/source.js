/**
 * Open-Meteo GFS wind snapshot — a coarse global 10 m wind grid for the
 * globe overlay. Browser-direct and keyless; the optional `/api/wind`
 * proxy is used when present so Railway deploys share one cache.
 */
export const WIND_GRID_STEP_DEG = 8;
export const WIND_LAT_MIN = -60;
export const WIND_LAT_MAX = 70;

function buildPoints() {
  const points = [];
  for (let lat = WIND_LAT_MIN; lat <= WIND_LAT_MAX; lat += WIND_GRID_STEP_DEG) {
    for (let lon = -180; lon < 180; lon += WIND_GRID_STEP_DEG) {
      points.push({ lat, lon });
    }
  }
  return points;
}

function parseGrid(payload) {
  const lats = payload?.latitude;
  const lons = payload?.longitude;
  const speeds = payload?.current?.wind_speed_10m;
  const dirs = payload?.current?.wind_direction_10m;
  if (
    !Array.isArray(lats) ||
    !Array.isArray(lons) ||
    !Array.isArray(speeds) ||
    !Array.isArray(dirs) ||
    lats.length !== lons.length ||
    lats.length !== speeds.length
  )
    throw new Error('Malformed wind grid');
  const samples = [];
  for (let i = 0; i < lats.length; i += 1) {
    const lat = Number(lats[i]);
    const lon = Number(lons[i]);
    const speed = Number(speeds[i]);
    const direction = Number(dirs[i]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(speed) ||
      !Number.isFinite(direction)
    )
      continue;
    samples.push({ lat, lon, speed, direction });
  }
  if (!samples.length) throw new Error('Empty wind grid');
  return {
    fetchedAt: Date.now(),
    model: 'gfs',
    valid: payload?.current?.time || null,
    samples,
  };
}

const DIRECT_CHUNK = 20;

/** Request a coarse Open-Meteo GFS wind grid. */
export function createWindSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/wind',
} = {}) {
  const points = buildPoints();
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(endpoint, { signal });
        if (response.ok) {
          const payload = await response.json();
          if (Array.isArray(payload?.samples)) return payload;
        }
      } catch {
        /* fall through to browser-direct batches */
      }
      const rows = [];
      for (let i = 0; i < points.length; i += DIRECT_CHUNK) {
        signal?.throwIfAborted();
        const chunk = points.slice(i, i + DIRECT_CHUNK);
        const params = new URLSearchParams({
          latitude: chunk.map((p) => p.lat.toFixed(2)).join(','),
          longitude: chunk.map((p) => p.lon.toFixed(2)).join(','),
          current: 'wind_speed_10m,wind_direction_10m',
          wind_speed_unit: 'kmh',
        });
        const response = await fetchImpl(
          `https://api.open-meteo.com/v1/gfs?${params}`,
          { signal },
        );
        if (!response.ok) throw new Error(`Wind HTTP ${response.status}`);
        const body = await response.json();
        if (Array.isArray(body)) rows.push(...body);
        else rows.push(body);
      }
      signal?.throwIfAborted();
      return parseGrid(aggregate(rows));
    },
  };
}

function aggregate(rows) {
  return {
    latitude: rows.map((row) => row.latitude),
    longitude: rows.map((row) => row.longitude),
    current: {
      time: rows[0]?.current?.time || null,
      wind_speed_10m: rows.map((row) => row.current?.wind_speed_10m),
      wind_direction_10m: rows.map((row) => row.current?.wind_direction_10m),
    },
  };
}

export { parseGrid, buildPoints };
