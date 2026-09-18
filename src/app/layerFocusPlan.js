/** Cesium-free planner for operator-centric Data Layer focus. */

export const LAYER_FOCUS_HEIGHT_M = Object.freeze({
  flights: 80_000,
  military: 80_000,
  'ais-live-vessels': 40_000,
  traffic: 8_000,
  transit: 6_000,
  bikeshare: 4_000,
  cctv: 2_500,
  'alpr-cameras': 2_500,
  satellites: 2_000_000,
  'telegeography-submarine-cables': 4_000_000,
  earthquakes: 1_200_000,
  'rocket-launches': 800_000,
  'local-firms': 80_000,
  'local-datacenters': 40_000,
  'local-dams': 40_000,
  'military-installations': 80_000,
  directions: 6_000,
  radio: 80_000,
});

export const SPACE_VIEW_HEIGHT_M = 500_000;

export function layerFocusHeightM(layerId) {
  return LAYER_FOCUS_HEIGHT_M[layerId] ?? 50_000;
}

export function isUsableOperatorCameraHeight(heightM) {
  return Number.isFinite(heightM) && heightM < SPACE_VIEW_HEIGHT_M;
}

function hasLatLon(value) {
  return (
    Number.isFinite(value?.lat) &&
    Number.isFinite(value?.lon) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    value.lon >= -180 &&
    value.lon <= 180
  );
}

/** Snap immediately from GPS cache or a terrestrial camera, never a space leftover. */
export function pickImmediateOperatorFocus({
  cached = null,
  camera = null,
  cameraHeightM = null,
} = {}) {
  if (hasLatLon(cached)) {
    return {
      lat: cached.lat,
      lon: cached.lon,
      source: cached.source || 'cache',
    };
  }
  if (isUsableOperatorCameraHeight(cameraHeightM) && hasLatLon(camera)) {
    return {
      lat: camera.lat,
      lon: camera.lon,
      source: camera.source || 'viewer',
    };
  }
  return null;
}

/** Panel clicks pass origin=user and focus=true. Shorts / first-run do not. */
export function shouldFocusUserEnabledLayer(enabled, options = {}) {
  return Boolean(
    enabled && options.origin === 'user' && options.focus === true,
  );
}

/**
 * Decide how to move the camera after a user enables a Data Layer row.
 * @returns {{ mode: 'cctv'|'alpr'|'object'|'operator'|'skip', id?: *, heightM?: number }}
 */
export function planEnabledLayerFocus({
  layerId,
  location,
  nearestCameraId = null,
  hasAlprFocus = false,
  nearestObject = null,
} = {}) {
  if (!location) return { mode: 'skip' };
  if (layerId === 'cctv' && nearestCameraId) {
    return { mode: 'cctv', id: nearestCameraId };
  }
  if (layerId === 'alpr-cameras' && hasAlprFocus) {
    return { mode: 'alpr', heightM: layerFocusHeightM(layerId) };
  }
  if (nearestObject) {
    return {
      mode: 'object',
      id: nearestObject.id ?? nearestObject.sourceId ?? null,
      heightM: layerFocusHeightM(layerId),
    };
  }
  return { mode: 'operator', heightM: layerFocusHeightM(layerId) };
}
