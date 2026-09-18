/** Cesium-free planner for operator-centric Data Layer focus. */
import {
  haversineKm,
  isDefaultSpawnLocation,
} from '../data/operatorLocation.js';

export const LAYER_FOCUS_HEIGHT_M = Object.freeze({
  flights: 80_000,
  military: 80_000,
  'ais-live-vessels': 40_000,
  // Street Traffic clears dots when camera height is > 8000 m. Cesium setView
  // at exactly 8000 m lands a few meters above the gate. Stay under that, but
  // above the 4500 m cutoff so the first paint uses the faster major-roads query.
  traffic: 5_200,
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
  // computeViewRectangle at 80 km / -42° hits the horizon and exceeds the
  // 10° Overpass cap, so the layer stays on a zoom-in prompt.
  'military-installations': 10_000,
  directions: 6_000,
  radio: 80_000,
});

/** Degrees below horizon. Steeper than -42 keeps city-scale viewport queries bounded. */
export const LAYER_FOCUS_PITCH_DEG = Object.freeze({
  traffic: -70,
  transit: -60,
  bikeshare: -60,
  cctv: -55,
  'alpr-cameras': -70,
  'military-installations': -78,
});

export const DEFAULT_LAYER_FOCUS_PITCH_DEG = -42;

/** Do not teleport CCTV Nearest to another metro when the operator is elsewhere. */
export const MAX_CCTV_NEAREST_KM = 120;

export function isNearbyOperatorFocus(distKm, maxKm = MAX_CCTV_NEAREST_KM) {
  return Number.isFinite(distKm) && distKm <= maxKm;
}

export const SPACE_VIEW_HEIGHT_M = 500_000;

/** Viewport feeds must sit over the operator so the first query is local. */
export const LOCAL_VIEWPORT_LAYER_IDS = Object.freeze([
  'traffic',
  'transit',
  'bikeshare',
  'cctv',
  'alpr-cameras',
  'military-installations',
  'directions',
  'radio',
  'flights',
  'military',
]);

const LOCAL_VIEWPORT_LAYER_SET = new Set(LOCAL_VIEWPORT_LAYER_IDS);

/** Global / water / orbit layers must not park on empty inland terrain. */
export const LAYER_VENUE_FALLBACK = Object.freeze({
  'ais-live-vessels': Object.freeze({
    lat: 33.754,
    lon: -118.216,
    heightM: 40_000,
  }),
  satellites: Object.freeze({ lat: 0, lon: -30, heightM: 8_000_000 }),
  'telegeography-submarine-cables': Object.freeze({
    lat: 32,
    lon: -32,
    heightM: 4_000_000,
  }),
  'rocket-launches': Object.freeze({
    lat: 28.573,
    lon: -80.649,
    heightM: 80_000,
  }),
});

export function shouldSnapOperatorBeforeEnable(layerId) {
  return LOCAL_VIEWPORT_LAYER_SET.has(layerId);
}

export function layerVenueFallback(layerId) {
  const venue = LAYER_VENUE_FALLBACK[layerId];
  if (!venue) return null;
  return { mode: 'venue', ...venue };
}

/** Inland operators must search from the coast, not the desert. */
export const INLAND_VESSEL_ANCHOR_KM = 150;

export function pickVesselFocusAnchor(location, venue = LAYER_VENUE_FALLBACK['ais-live-vessels']) {
  if (!venue) return location || null;
  if (
    !location ||
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lon)
  ) {
    return venue;
  }
  return haversineKm(location.lat, location.lon, venue.lat, venue.lon) >
    INLAND_VESSEL_ANCHOR_KM
    ? venue
    : location;
}

export async function waitForLayerFocusObjects({
  collect,
  timeoutMs = 4_500,
  intervalMs = 200,
} = {}) {
  const started = Date.now();
  let objects = collect?.() || [];
  while (!objects.length && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
    objects = collect?.() || [];
  }
  return objects;
}

export function layerFocusHeightM(layerId) {
  return LAYER_FOCUS_HEIGHT_M[layerId] ?? 50_000;
}

export function layerFocusPitchDeg(layerId) {
  return LAYER_FOCUS_PITCH_DEG[layerId] ?? DEFAULT_LAYER_FOCUS_PITCH_DEG;
}

/**
 * Prefer a full position list over viewport-culled detectables so inland
 * operators still fly to the nearest real ship / contact, not an empty city.
 */
export function collectLayerFocusObjects({
  detectable = [],
  positions = [],
} = {}) {
  const mapped = [];
  for (const entry of positions || []) {
    mapped.push({
      id: entry?.id ?? entry?.sourceId ?? null,
      lat: entry?.latitude ?? entry?.lat,
      lon: entry?.longitude ?? entry?.lon,
      position: entry?.position,
    });
  }
  if (mapped.length > (detectable?.length || 0)) return mapped;
  return Array.isArray(detectable) ? detectable : [];
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
  if (
    isUsableOperatorCameraHeight(cameraHeightM) &&
    hasLatLon(camera) &&
    !isDefaultSpawnLocation(camera)
  ) {
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
  nearestCameraDistKm = null,
  hasAlprFocus = false,
  nearestObject = null,
} = {}) {
  if (!location) return { mode: 'skip' };
  if (
    layerId === 'cctv' &&
    nearestCameraId &&
    isNearbyOperatorFocus(nearestCameraDistKm)
  ) {
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
  const venue = layerVenueFallback(layerId);
  if (venue) return venue;
  return { mode: 'operator', heightM: layerFocusHeightM(layerId) };
}
