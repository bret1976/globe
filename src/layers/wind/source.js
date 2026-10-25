/**
 * GFS wind snapshot — a coarse global 10 m wind grid for the globe overlay.
 * Keyless. The optional `/api/wind` proxy is used when present so Railway
 * deploys share one cache.
 *
 * Primary feed: NOAA NCEP GFS 10 m u/v wind served by the PacIOOS ERDDAP
 * (`ncep_global`, 0.5°). One request returns the whole 8° lattice, so it is
 * not subject to Open-Meteo's per-location quotas (each of the 765 grid points
 * counts as one Open-Meteo call, which tripped the 600/minute and 10,000/day
 * free limits on the shared hosting egress address). Open-Meteo GFS stays as
 * the fallback.
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

export const ERDDAP_WIND_DATASET =
  'https://pae-paha.pacioos.hawaii.edu/erddap/griddap/ncep_global';
/** 0.5° native grid → stride 16 = 8°, matching WIND_GRID_STEP_DEG. */
const ERDDAP_STRIDE = Math.round(WIND_GRID_STEP_DEG / 0.5);

/**
 * ERDDAP griddap URL for the 10 m u/v wind lattice nearest `now`. Longitudes
 * start at 4°E so that, wrapped to −180…180, they land on the same −180 + 8k
 * points as {@link buildPoints}; latitudes span the same −60…68 rows.
 */
export function buildErddapWindUrl(now = Date.now()) {
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000)
    .toISOString()
    .replace('.000Z', 'Z');
  const latTop = WIND_LAT_MIN +
    Math.floor((WIND_LAT_MAX - WIND_LAT_MIN) / WIND_GRID_STEP_DEG) * WIND_GRID_STEP_DEG;
  const lon0 = ((-180 % 360) + 360) % 360 % WIND_GRID_STEP_DEG;
  const dims =
    `[(${hour})][(${latTop}):${ERDDAP_STRIDE}:(${WIND_LAT_MIN})]` +
    `[(${lon0}):${ERDDAP_STRIDE}:(359.5)]`;
  const query = `ugrd10m${dims},vgrd10m${dims}`;
  return `${ERDDAP_WIND_DATASET}.json?${encodeURIComponent(query)
    .replace(/%2C/g, ',')
    .replace(/%3A/g, ':')}`;
}

/** Meteorological direction (degrees the wind blows FROM) of a u/v vector. */
export function windFromDirection(u, v) {
  const deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/**
 * Parse an ERDDAP griddap JSON table of `time, latitude, longitude, ugrd10m,
 * vgrd10m` (m/s) into the same snapshot shape as {@link parseGrid}: speed in
 * km/h, direction in degrees-from, longitudes wrapped to −180…180.
 */
export function parseErddapWind(body) {
  const table = body?.table;
  const cols = table?.columnNames;
  const rows = table?.rows;
  if (!Array.isArray(cols) || !Array.isArray(rows))
    throw new Error('Malformed ERDDAP wind table');
  const at = (name) => cols.indexOf(name);
  const iTime = at('time');
  const iLat = at('latitude');
  const iLon = at('longitude');
  const iU = at('ugrd10m');
  const iV = at('vgrd10m');
  if ([iLat, iLon, iU, iV].some((index) => index < 0))
    throw new Error('Malformed ERDDAP wind table');
  const samples = [];
  let valid = null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const lat = Number(row[iLat]);
    let lon = Number(row[iLon]);
    const u = row[iU] == null ? NaN : Number(row[iU]);
    const v = row[iV] == null ? NaN : Number(row[iV]);
    if (![lat, lon, u, v].every(Number.isFinite)) continue;
    // ERDDAP fill value for missing cells.
    if (Math.abs(u) > 200 || Math.abs(v) > 200) continue;
    if (lon >= 180) lon -= 360;
    const speed = Math.round(Math.hypot(u, v) * 3.6 * 10) / 10;
    samples.push({ lat, lon, speed, direction: windFromDirection(u, v) });
    if (!valid && iTime >= 0 && typeof row[iTime] === 'string')
      valid = row[iTime].replace(/:00Z$/, '').replace(/Z$/, '');
  }
  if (!samples.length) throw new Error('Empty wind grid');
  return {
    fetchedAt: Date.now(),
    model: 'gfs',
    provider: 'noaa-gfs-pacioos',
    valid,
    samples,
  };
}

const DIRECT_CHUNK = 20;

/** Request a coarse GFS wind grid (proxy → NOAA GFS ERDDAP → Open-Meteo). */
export function createWindSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/wind',
  now = () => Date.now(),
} = {}) {
  const points = buildPoints();
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(endpoint, { signal });
        if (response.ok) {
          const payload = await response.json();
          // A warming or empty proxy payload has no wind to draw. The hosted
          // proxy can stay warming for hours when Open-Meteo rate-limits the
          // shared server egress address (429), so fetch the grid directly
          // instead of showing an empty layer.
          if (Array.isArray(payload?.samples) && payload.samples.length)
            return payload;
        }
      } catch {
        /* fall through to browser-direct feeds */
      }
      // One keyless ERDDAP request for the whole lattice (CORS-enabled).
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(buildErddapWindUrl(now()), { signal });
        if (response.ok) return parseErddapWind(await response.json());
      } catch (error) {
        if (signal?.aborted) throw error;
        /* fall through to Open-Meteo batches */
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
