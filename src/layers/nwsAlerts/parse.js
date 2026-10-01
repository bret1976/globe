/**
 * Normalize NWS active weather alerts GeoJSON into globe rows.
 *
 * Feed: https://api.weather.gov/alerts/active (U.S. government public domain)
 * Only features with plottable geometry (Point / Polygon / MultiPolygon) are
 * kept; zone-only alerts without geometry are skipped (no extra zone lookups).
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';

const SEVERITY_RANK = Object.freeze({
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
});

const MAX_ROWS = 400;

/**
 * CSS color by NWS severity.
 * @param {string} severity
 */
export function nwsSeverityColorCss(severity) {
  switch (String(severity || '')) {
    case 'Extreme':
      return '#FF1144';
    case 'Severe':
      return '#FF6600';
    case 'Moderate':
      return '#EECC22';
    case 'Minor':
      return '#44AADD';
    default:
      return '#8899AA';
  }
}

/**
 * Average lon/lat of a ring [[lon,lat], ...] (skip closing duplicate).
 * @param {unknown} ring
 * @returns {{lon: number, lat: number}|null}
 */
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 1) return null;
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  const limit =
    ring.length > 1 &&
    Number(ring[0]?.[0]) === Number(ring[ring.length - 1]?.[0]) &&
    Number(ring[0]?.[1]) === Number(ring[ring.length - 1]?.[1])
      ? ring.length - 1
      : ring.length;
  for (let i = 0; i < limit; i += 1) {
    const pt = ring[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    sumLon += lon;
    sumLat += lat;
    n += 1;
  }
  if (!n) return null;
  return { lon: sumLon / n, lat: sumLat / n };
}

/**
 * @param {unknown} geometry GeoJSON geometry
 * @returns {{lon: number, lat: number}|null}
 */
export function geometryCentroid(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const type = String(geometry.type || '');
  const coords = geometry.coordinates;
  if (type === 'Point' && Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { lon, lat };
  }
  if (type === 'Polygon' && Array.isArray(coords) && coords.length >= 1) {
    return ringCentroid(coords[0]);
  }
  if (type === 'MultiPolygon' && Array.isArray(coords) && coords.length >= 1) {
    // Use the first polygon's exterior ring (good enough for disc placement).
    const first = coords[0];
    if (Array.isArray(first) && first.length >= 1) return ringCentroid(first[0]);
  }
  return null;
}

/**
 * @param {unknown} payload GeoJSON FeatureCollection or features array
 * @param {{ maxRows?: number }} [options]
 * @returns {Array<{
 *   stableId: string,
 *   event: string,
 *   severity: string,
 *   urgency: string,
 *   certainty: string,
 *   headline: string,
 *   areaDesc: string,
 *   sent: string,
 *   onset: string,
 *   ends: string,
 *   lat: number,
 *   lon: number,
 *   severityRank: number,
 * }>}
 */
export function normalizeNwsAlerts(payload, options = {}) {
  const maxRows = Math.max(20, Number(options.maxRows) || MAX_ROWS);
  const features = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.features)
      ? payload.features
      : [];
  /** @type {ReturnType<typeof normalizeNwsAlerts>} */
  const rows = [];
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    const props = feature.properties;
    if (!props || typeof props !== 'object') continue;

    const centroid = geometryCentroid(feature.geometry);
    if (!centroid) continue;
    const { lat, lon } = centroid;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const event = String(props.event || '').trim();
    if (!event) continue;

    const severity = String(props.severity || 'Unknown').trim() || 'Unknown';
    const id = String(props.id || feature.id || '').trim();
    const stableId =
      id ||
      `${event}:${lat.toFixed(3)}:${lon.toFixed(3)}:${String(props.sent || '').slice(0, 19)}`;

    rows.push({
      stableId,
      event,
      severity,
      urgency: String(props.urgency || '').trim(),
      certainty: String(props.certainty || '').trim(),
      headline: String(props.headline || props.event || '').trim(),
      areaDesc: String(props.areaDesc || '').trim(),
      sent: String(props.sent || '').trim(),
      onset: String(props.onset || props.effective || '').trim(),
      ends: String(props.ends || props.expires || '').trim(),
      lat,
      lon,
      severityRank: SEVERITY_RANK[severity] ?? 0,
    });
  }

  rows.sort((a, b) => {
    const rank = b.severityRank - a.severityRank;
    if (rank) return rank;
    if (a.event !== b.event) return a.event.localeCompare(b.event);
    return a.stableId.localeCompare(b.stableId);
  });

  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}
