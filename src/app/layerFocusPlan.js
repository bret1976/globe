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
  'au-fire': 800_000,
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

/** Only dive to a CCTV camera that is actually in the operator's metro. */
export const MAX_CCTV_NEAREST_KM = 120;

export function isNearbyOperatorFocus(distKm, maxKm = MAX_CCTV_NEAREST_KM) {
  return Number.isFinite(distKm) && distKm <= maxKm;
}

export const SPACE_VIEW_HEIGHT_M = 500_000;

/**
 * Featured live destinations from the Bilawal shorts (London CCTV / Austin
 * traffic / Long Beach ships / Kennedy / Nellis). GPS-nearest parked Vegas
 * over empty desert and blocked the Data Layer buttons on the geolocation
 * prompt. Clicks now go here unless the operator already has local data.
 */
export const LAYER_LIVE_DESTINATIONS = Object.freeze({
  cctv: Object.freeze({
    lat: 51.5055,
    lon: -0.0754,
    heightM: 12_000,
    pitchDeg: -52,
    label: 'London',
  }),
  traffic: Object.freeze({
    lat: 30.2747,
    lon: -97.7403,
    heightM: 5_200,
    pitchDeg: -70,
    label: 'Austin',
  }),
  transit: Object.freeze({
    lat: 51.5055,
    lon: -0.0754,
    heightM: 6_000,
    pitchDeg: -60,
    label: 'London',
  }),
  bikeshare: Object.freeze({
    lat: 30.2672,
    lon: -97.7431,
    heightM: 4_000,
    label: 'Austin',
  }),
  'alpr-cameras': Object.freeze({
    lat: 30.2672,
    lon: -97.7431,
    heightM: 2_500,
    pitchDeg: -70,
    label: 'Austin',
  }),
  flights: Object.freeze({
    lat: 36.084,
    lon: -115.154,
    heightM: 80_000,
    label: 'Las Vegas',
  }),
  military: Object.freeze({
    lat: 36.236,
    lon: -115.034,
    heightM: 80_000,
    label: 'Nellis',
  }),
  'ais-live-vessels': Object.freeze({
    lat: 33.754,
    lon: -118.216,
    heightM: 40_000,
    label: 'Long Beach',
  }),
  satellites: Object.freeze({
    lat: 0,
    lon: -30,
    heightM: 8_000_000,
    label: 'Atlantic orbit',
  }),
  'telegeography-submarine-cables': Object.freeze({
    lat: 32,
    lon: -32,
    heightM: 4_000_000,
    label: 'Atlantic cables',
  }),
  'rocket-launches': Object.freeze({
    lat: 28.573,
    lon: -80.649,
    heightM: 80_000,
    label: 'Kennedy',
  }),
  earthquakes: Object.freeze({
    lat: 37.5,
    lon: 141.0,
    heightM: 1_200_000,
    label: 'Pacific rim',
  }),
  'local-firms': Object.freeze({
    lat: 39.5,
    lon: -121.0,
    heightM: 80_000,
    label: 'California fires',
  }),
  'au-fire': Object.freeze({
    lat: -35.3,
    lon: 148.0,
    heightM: 800_000,
    label: 'NSW / VIC fires',
  }),
  'military-installations': Object.freeze({
    lat: 36.236,
    lon: -115.034,
    heightM: 10_000,
    pitchDeg: -78,
    label: 'Nellis',
  }),
  radio: Object.freeze({
    lat: 36.1699,
    lon: -115.1398,
    heightM: 80_000,
    label: 'Las Vegas',
  }),
  directions: Object.freeze({
    lat: 36.1699,
    lon: -115.1398,
    heightM: 6_000,
    label: 'Las Vegas',
  }),
  'local-datacenters': Object.freeze({
    lat: 37.4,
    lon: -122.0,
    heightM: 40_000,
    label: 'Bay Area',
  }),
  'local-dams': Object.freeze({
    lat: 36.016,
    lon: -114.737,
    heightM: 40_000,
    label: 'Hoover Dam',
  }),
});

/** Viewport feeds can sit over the operator when GPS is already known. */
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

/** These layers have no useful data over inland GPS. Always use a live venue. */
export const FEATURED_DESTINATION_LAYER_IDS = Object.freeze([
  'cctv',
  'ais-live-vessels',
  'satellites',
  'telegeography-submarine-cables',
  'rocket-launches',
  'earthquakes',
  'local-firms',
  'au-fire',
  'local-datacenters',
  'local-dams',
]);

const FEATURED_DESTINATION_LAYER_SET = new Set(FEATURED_DESTINATION_LAYER_IDS);

/** @deprecated Use LAYER_LIVE_DESTINATIONS. Kept for existing imports/tests. */
export const LAYER_VENUE_FALLBACK = Object.freeze({
  'ais-live-vessels': LAYER_LIVE_DESTINATIONS['ais-live-vessels'],
  satellites: LAYER_LIVE_DESTINATIONS.satellites,
  'telegeography-submarine-cables':
    LAYER_LIVE_DESTINATIONS['telegeography-submarine-cables'],
  'rocket-launches': LAYER_LIVE_DESTINATIONS['rocket-launches'],
});

export function shouldSnapOperatorBeforeEnable(layerId) {
  return (
    LOCAL_VIEWPORT_LAYER_SET.has(layerId) ||
    FEATURED_DESTINATION_LAYER_SET.has(layerId)
  );
}

export function layerLiveDestination(layerId) {
  const dest = LAYER_LIVE_DESTINATIONS[layerId];
  if (!dest) return null;
  return { mode: 'venue', ...dest };
}

export function layerVenueFallback(layerId) {
  return layerLiveDestination(layerId);
}

export function isUsableOperatorLocation(location) {
  if (!location || !hasLatLon(location)) return false;
  if (location.source === 'geolocation' || location.source === 'cache') {
    return true;
  }
  return !isDefaultSpawnLocation(location);
}

/** Street-scale feeds must not inherit an 80 km leftover aviation view. */
const STREET_SCALE_LAYER_SET = new Set([
  'traffic',
  'transit',
  'bikeshare',
  'cctv',
  'alpr-cameras',
  'military-installations',
  'directions',
]);

export function isTrustedStreetOperator(location, layerId) {
  if (!isUsableOperatorLocation(location)) return false;
  if (!STREET_SCALE_LAYER_SET.has(layerId)) return true;
  return location.source === 'geolocation' || location.source === 'cache';
}

/**
 * Pick the camera target for a Data Layer click without waiting on GPS.
 * Local viewport layers use a known operator fix; everything else uses the
 * shorts venue so the first frame has live data.
 */
export function pickLayerFocusAnchor({
  layerId,
  location = null,
  nearestCameraDistKm = null,
} = {}) {
  const featured = layerLiveDestination(layerId);
  if (
    layerId === 'cctv' &&
    isTrustedStreetOperator(location, layerId) &&
    isNearbyOperatorFocus(nearestCameraDistKm)
  ) {
    return {
      mode: 'operator',
      lat: location.lat,
      lon: location.lon,
      heightM: layerFocusHeightM(layerId),
      pitchDeg: layerFocusPitchDeg(layerId),
      source: 'operator',
    };
  }
  if (
    !FEATURED_DESTINATION_LAYER_SET.has(layerId) &&
    LOCAL_VIEWPORT_LAYER_SET.has(layerId) &&
    isTrustedStreetOperator(location, layerId)
  ) {
    return {
      mode: 'operator',
      lat: location.lat,
      lon: location.lon,
      heightM: layerFocusHeightM(layerId),
      pitchDeg: layerFocusPitchDeg(layerId),
      source: 'operator',
    };
  }
  return featured;
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
 * Never parks on empty inland GPS when the layer has a live venue.
 * @returns {{ mode: 'cctv'|'alpr'|'object'|'operator'|'venue'|'skip', id?: *, heightM?: number }}
 */
export function planEnabledLayerFocus({
  layerId,
  location,
  nearestCameraId = null,
  nearestCameraDistKm = null,
  hasAlprFocus = false,
  nearestObject = null,
} = {}) {
  if (
    layerId === 'cctv' &&
    nearestCameraId &&
    isNearbyOperatorFocus(nearestCameraDistKm)
  ) {
    return { mode: 'cctv', id: nearestCameraId };
  }
  if (layerId === 'alpr-cameras' && hasAlprFocus) {
    const anchor = pickLayerFocusAnchor({ layerId, location });
    return {
      mode: 'alpr',
      heightM: anchor?.heightM || layerFocusHeightM(layerId),
      lat: anchor?.lat,
      lon: anchor?.lon,
    };
  }
  if (
    nearestObject &&
    location &&
    !FEATURED_DESTINATION_LAYER_SET.has(layerId)
  ) {
    return {
      mode: 'object',
      id: nearestObject.id ?? nearestObject.sourceId ?? null,
      heightM: layerFocusHeightM(layerId),
    };
  }
  const anchor = pickLayerFocusAnchor({
    layerId,
    location,
    nearestCameraDistKm,
  });
  if (anchor) {
    return {
      mode: anchor.mode || 'venue',
      lat: anchor.lat,
      lon: anchor.lon,
      heightM: anchor.heightM,
      pitchDeg: anchor.pitchDeg,
      label: anchor.label,
    };
  }
  if (nearestObject) {
    return {
      mode: 'object',
      id: nearestObject.id ?? nearestObject.sourceId ?? null,
      heightM: layerFocusHeightM(layerId),
    };
  }
  if (location) return { mode: 'operator', heightM: layerFocusHeightM(layerId) };
  return { mode: 'skip' };
}
