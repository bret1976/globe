/**
 * Normalize U.S. Drought Monitor GeoJSON into globe point rows (part centroids).
 *
 * Primary: https://droughtmonitor.unl.edu/data/json/usdm_current.json
 * Fallback: https://mesonet.agron.iastate.edu/geojson/usdm.py
 * Attribution: U.S. Drought Monitor (NDMC / USDA / NOAA).
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const USDM_PRIMARY_URL =
  'https://droughtmonitor.unl.edu/data/json/usdm_current.json';

export const USDM_FALLBACK_URL =
  'https://mesonet.agron.iastate.edu/geojson/usdm.py';

const MAX_ROWS = 800;
const DM_LABELS = Object.freeze({
  0: 'D0 Abnormally Dry',
  1: 'D1 Moderate',
  2: 'D2 Severe',
  3: 'D3 Extreme',
  4: 'D4 Exceptional',
});

/** @param {unknown} value */
function parseNum(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number} dm
 */
export function usdmLabel(dm) {
  const key = Number(dm);
  return DM_LABELS[key] || `D${key}`;
}

/**
 * CSS color by drought category (amber→red; distinct from GDACS floods).
 * @param {number} dm
 */
export function usdmColorCss(dm) {
  switch (Number(dm) || 0) {
    case 4:
      return '#730000';
    case 3:
      return '#E60000';
    case 2:
      return '#FFAA00';
    case 1:
      return '#FCD37F';
    default:
      return '#FFFF00';
  }
}

/**
 * Simple exterior-ring centroid (mean of vertices). Returns null if unusable.
 * @param {number[][]} ring
 * @returns {{lat: number, lon: number}|null}
 */
export function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const coord of ring) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const lon = parseNum(coord[0]);
    const lat = parseNum(coord[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    sumLat += lat;
    sumLon += lon;
    n += 1;
  }
  if (n < 3) return null;
  const lat = sumLat / n;
  const lon = sumLon / n;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/**
 * Yield centroids for every polygon part in a (Multi)Polygon geometry.
 * @param {object} geometry
 * @returns {{lat: number, lon: number}[]}
 */
export function geometryPartCentroids(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  /** @type {number[][][][]} */
  let polygons = [];
  if (geometry.type === 'Polygon') {
    polygons = [geometry.coordinates];
  } else if (geometry.type === 'MultiPolygon') {
    polygons = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  } else {
    return [];
  }
  /** @type {{lat: number, lon: number}[]} */
  const out = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) continue;
    const exterior = polygon[0];
    const c = ringCentroid(exterior);
    if (c) out.push(c);
  }
  return out;
}

/**
 * @param {object} feature
 * @param {number} featureIndex
 * @returns {object[]}
 */
export function parseUsdmFeature(feature, featureIndex = 0) {
  if (!feature || typeof feature !== 'object') return [];
  const props = feature.properties || {};
  const dm = parseNum(props.DM ?? props.dm ?? props.drought_class);
  if (!Number.isFinite(dm) || dm < 0 || dm > 4) return [];
  const centroids = geometryPartCentroids(feature.geometry);
  /** @type {object[]} */
  const rows = [];
  for (let i = 0; i < centroids.length; i += 1) {
    const { lat, lon } = centroids[i];
    rows.push({
      stableId: `usdm-${dm}-${featureIndex}-${i}`,
      dm,
      label: usdmLabel(dm),
      lat,
      lon,
      intensityRank: dm,
    });
  }
  return rows;
}

/**
 * Prefer higher DM categories; cap for globe performance.
 * @param {object|unknown} collection
 * @param {{ maxRows?: number }} [options]
 */
export function normalizeUsdmDrought(collection, options = {}) {
  const maxRows = Math.max(40, Number(options.maxRows) || MAX_ROWS);
  const features = Array.isArray(collection?.features)
    ? collection.features
    : Array.isArray(collection)
      ? collection
      : [];

  /** @type {object[]} */
  const rows = [];
  features.forEach((feature, index) => {
    rows.push(...parseUsdmFeature(feature, index));
  });

  rows.sort((a, b) => {
    const dm = (b.dm || 0) - (a.dm || 0);
    if (dm) return dm;
    return String(a.stableId).localeCompare(String(b.stableId));
  });

  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

export { MAX_ROWS, DM_LABELS };
