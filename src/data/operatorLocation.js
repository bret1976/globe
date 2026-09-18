/** Browser geolocation for operator-centric layer focus. Cesium-free. */

export const OPERATOR_GEO_TIMEOUT_MS = 4_000;
export const OPERATOR_GEO_MAX_AGE_MS = 60_000;
export const OPERATOR_CACHE_MAX_AGE_MS = 5 * 60_000;

let cachedOperatorLocation = null;

export function isFiniteLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearestByHaversine(items, lat, lon, getLatLon) {
  if (!isFiniteLatLon(lat, lon) || !Array.isArray(items) || items.length === 0)
    return null;
  let best = null;
  for (const item of items) {
    const coords = getLatLon?.(item);
    if (!coords || !isFiniteLatLon(coords.lat, coords.lon)) continue;
    const distKm = haversineKm(lat, lon, coords.lat, coords.lon);
    if (!best || distKm < best.distKm) best = { item, distKm };
  }
  return best;
}

export function viewerCameraLatLon(viewer, toDegrees) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto || typeof toDegrees !== 'function') return null;
  const lat = toDegrees(carto.latitude);
  const lon = toDegrees(carto.longitude);
  if (!isFiniteLatLon(lat, lon)) return null;
  return { lat, lon, source: 'viewer' };
}

export function rememberOperatorLocation(location, now = Date.now) {
  if (!location || !isFiniteLatLon(location.lat, location.lon)) return null;
  cachedOperatorLocation = {
    lat: location.lat,
    lon: location.lon,
    source: location.source || 'cache',
    accuracyM: location.accuracyM ?? null,
    cachedAt: now(),
  };
  return cachedOperatorLocation;
}

export function readCachedOperatorLocation(
  maxAgeMs = OPERATOR_CACHE_MAX_AGE_MS,
  now = Date.now,
) {
  if (!cachedOperatorLocation) return null;
  if (now() - cachedOperatorLocation.cachedAt > maxAgeMs) return null;
  return { ...cachedOperatorLocation };
}

export function clearCachedOperatorLocation() {
  cachedOperatorLocation = null;
}

function normalizeFallback(fallback) {
  if (!fallback || !isFiniteLatLon(fallback.lat, fallback.lon)) return null;
  return {
    lat: fallback.lat,
    lon: fallback.lon,
    source: fallback.source || 'fallback',
    accuracyM: fallback.accuracyM ?? null,
  };
}

function readGeolocation(geolocation, timeoutMs, maximumAgeMs) {
  return new Promise((resolve) => {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs + 80);
    try {
      geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timer);
          const lat = position?.coords?.latitude;
          const lon = position?.coords?.longitude;
          finish(
            isFiniteLatLon(lat, lon)
              ? {
                  lat,
                  lon,
                  accuracyM: Number(position.coords?.accuracy) || null,
                  source: 'geolocation',
                }
              : null,
          );
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        {
          enableHighAccuracy: false,
          timeout: timeoutMs,
          maximumAge: maximumAgeMs,
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * Prefer the operator's browser GPS, then a recent cache, then a viewer
 * fallback so CCTV Nearest and Data Layer focus still work without a grant.
 */
export async function resolveOperatorLocation({
  geolocation = globalThis.navigator?.geolocation,
  timeoutMs = OPERATOR_GEO_TIMEOUT_MS,
  maximumAgeMs = OPERATOR_GEO_MAX_AGE_MS,
  fallback = null,
  now = Date.now,
} = {}) {
  const geo = await readGeolocation(geolocation, timeoutMs, maximumAgeMs);
  if (geo) return rememberOperatorLocation(geo, now);
  const cached = readCachedOperatorLocation(OPERATOR_CACHE_MAX_AGE_MS, now);
  if (cached) return cached;
  return normalizeFallback(fallback);
}
