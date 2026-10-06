/**
 * Normalize Open-Meteo Marine surface ocean currents into globe arrow rows.
 *
 * Feed: Open-Meteo Marine API (`current=ocean_current_velocity,ocean_current_direction`),
 * keyless, CC BY 4.0 data (composited from Copernicus Marine / ECMWF ocean
 * analyses). Direction is the heading the water flows TOWARDS.
 * Idea from FlightXCaptain/Gods-Eye (MIT) ocean-currents layer; this is
 * original Bret/GodsEye code — no third-party application source copied.
 */

export const OCEAN_CURRENTS_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const OCEAN_CURRENTS_STEP_DEG = 8;
export const OCEAN_CURRENTS_LAT_MIN = -72;
export const OCEAN_CURRENTS_LAT_MAX = 72;
/** Open-Meteo free tier allows ~600 location-calls per minute; stay under it. */
export const OCEAN_CURRENTS_BATCH = 250;
export const OCEAN_CURRENTS_BATCH_GAP_MS = 30_000;

/** Global sample grid (lat/lon degrees), coarse enough for the free tier. */
export function oceanCurrentsGrid(step = OCEAN_CURRENTS_STEP_DEG) {
  const pts = [];
  for (
    let lat = OCEAN_CURRENTS_LAT_MIN;
    lat <= OCEAN_CURRENTS_LAT_MAX;
    lat += step
  ) {
    for (let lon = -180; lon < 180; lon += step) pts.push([lat, lon]);
  }
  return pts;
}

/** Build one batched Open-Meteo Marine request URL. */
export function oceanCurrentsBatchUrl(points) {
  const lats = points.map((p) => p[0]).join(',');
  const lons = points.map((p) => p[1]).join(',');
  return (
    `${OCEAN_CURRENTS_URL}?latitude=${lats}&longitude=${lons}` +
    '&current=ocean_current_velocity,ocean_current_direction&timezone=UTC'
  );
}

/** Speed band (km/h) → 0..4 rank. */
export function oceanCurrentRank(kmh) {
  const v = Number(kmh);
  if (!Number.isFinite(v)) return 0;
  if (v >= 3.6) return 4; // ≥ 1 m/s (Gulf Stream, Kuroshio, Agulhas cores)
  if (v >= 2) return 3;
  if (v >= 1) return 2;
  if (v >= 0.4) return 1;
  return 0;
}

const COLORS = ['#5b8cff', '#2fd3ff', '#3dffb0', '#ffd23d', '#ff5a3d'];

/** CSS color for a speed rank. */
export function oceanCurrentColorCss(rank) {
  return COLORS[Math.max(0, Math.min(4, Number(rank) || 0))];
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one batch response (array or single object) using the requested
 * grid points as the authoritative anchor positions.
 */
export function normalizeOceanCurrents(body, points = []) {
  const list = Array.isArray(body) ? body : body ? [body] : [];
  const rows = [];
  list.forEach((loc, i) => {
    const cur = loc?.current;
    const speed = num(cur?.ocean_current_velocity);
    const dir = num(cur?.ocean_current_direction);
    if (speed == null || dir == null || speed <= 0) return;
    const lat = num(points[i]?.[0] ?? loc?.latitude);
    const lon = num(points[i]?.[1] ?? loc?.longitude);
    if (lat == null || lon == null) return;
    const rank = oceanCurrentRank(speed);
    rows.push({
      stableId: `oc:${lat}:${lon}`,
      lat,
      lon,
      speedKmh: Math.round(speed * 100) / 100,
      directionDeg: ((dir % 360) + 360) % 360,
      rank,
      observedAt: cur?.time ? `${cur.time}Z` : null,
    });
  });
  return rows;
}

/**
 * Arrow end point: move from (lat, lon) toward bearing by `km` (spherical).
 * Returns [lat, lon].
 */
export function offsetByBearing(lat, lon, bearingDeg, km) {
  const R = 6371;
  const d = km / R;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  let lonOut = (l2 * 180) / Math.PI;
  lonOut = ((lonOut + 540) % 360) - 180;
  return [(p2 * 180) / Math.PI, lonOut];
}

/** Arrow length on the globe (km) for a given speed. */
export function oceanCurrentArrowKm(kmh) {
  const v = Math.max(0, Number(kmh) || 0);
  return Math.min(520, 110 + v * 95);
}
