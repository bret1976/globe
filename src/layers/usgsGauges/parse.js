/**
 * Normalize USGS Water Data OGCAPI latest-continuous streamflow into globe rows.
 *
 * Feed: https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items
 *   ?f=json&parameter_code=00060
 * U.S. government public domain — no API key.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const USGS_LATEST_CONTINUOUS_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items';

/** Discharge (ft³/s) parameter. */
export const USGS_STREAMFLOW_PARAMETER = '00060';

const MAX_ROWS = 1000;
const MAX_PAGES = 20;
const PAGE_LIMIT = 1000;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Discharge intensity rank for coloring (0–4), log-ish buckets in cfs.
 * @param {?number} cfs
 */
export function usgsGaugeIntensityRank(cfs) {
  const v = Number(cfs);
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v >= 50_000) return 4;
  if (v >= 10_000) return 3;
  if (v >= 2_000) return 2;
  if (v >= 200) return 1;
  return 0;
}

/**
 * CSS color by streamflow intensity (blue family; distinct from NDBC cyan).
 * @param {number} rank
 */
export function usgsGaugeIntensityColorCss(rank) {
  switch (Number(rank) || 0) {
    case 4:
      return '#44AAFF';
    case 3:
      return '#3388EE';
    case 2:
      return '#2A6ECC';
    case 1:
      return '#3A5A9A';
    default:
      return '#4A5A78';
  }
}

/**
 * @param {object} feature GeoJSON Feature from latest-continuous
 * @returns {object|null}
 */
export function parseUsgsGaugeFeature(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const props = feature.properties || {};
  const geom = feature.geometry;
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates))
    return null;
  const lon = parseNum(geom.coordinates[0]);
  const lat = parseNum(geom.coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;

  const siteId = String(
    props.monitoring_location_id || feature.id || '',
  ).trim();
  if (!siteId) return null;

  const parameter = String(props.parameter_code || '').trim();
  if (parameter && parameter !== USGS_STREAMFLOW_PARAMETER) return null;

  const cfs = parseNum(props.value);
  if (!Number.isFinite(cfs) || cfs < 0) return null;

  const observedAt = String(props.time || '').trim();
  const unit = String(props.unit_of_measure || 'ft^3/s').trim();
  const siteNumber = siteId.replace(/^USGS-/i, '');
  const intensityRank = usgsGaugeIntensityRank(cfs);

  return {
    stableId: siteId,
    siteId,
    siteNumber,
    lat,
    lon,
    cfs,
    unit,
    observedAt,
    intensityRank,
  };
}

/**
 * @param {object|unknown} collection GeoJSON FeatureCollection (one page or merged)
 * @param {{ maxRows?: number }} [options]
 */
export function normalizeUsgsGauges(collection, options = {}) {
  const maxRows = Math.max(20, Number(options.maxRows) || MAX_ROWS);
  const features = Array.isArray(collection?.features)
    ? collection.features
    : Array.isArray(collection)
      ? collection
      : [];

  /** @type {Map<string, ReturnType<typeof parseUsgsGaugeFeature>>} */
  const byId = new Map();
  for (const feature of features) {
    const row = parseUsgsGaugeFeature(feature);
    if (!row) continue;
    const prev = byId.get(row.stableId);
    if (!prev || row.cfs > prev.cfs) byId.set(row.stableId, row);
  }

  const rows = [...byId.values()];
  rows.sort((a, b) => {
    const rank = (b.intensityRank || 0) - (a.intensityRank || 0);
    if (rank) return rank;
    const flow = (b.cfs || 0) - (a.cfs || 0);
    if (flow) return flow;
    return String(a.siteNumber).localeCompare(String(b.siteNumber));
  });

  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

/**
 * Extract the OGCAPI "next" page href, if any.
 * @param {object} collection
 * @returns {?string}
 */
export function usgsGaugesNextHref(collection) {
  const links = Array.isArray(collection?.links) ? collection.links : [];
  for (const link of links) {
    if (link?.rel === 'next' && typeof link.href === 'string' && link.href)
      return link.href;
  }
  return null;
}

/**
 * Build the first-page request URL for streamflow latest-continuous.
 * @param {{ limit?: number }} [options]
 */
export function usgsGaugesFirstPageUrl(options = {}) {
  const limit = Math.min(
    PAGE_LIMIT,
    Math.max(50, Number(options.limit) || PAGE_LIMIT),
  );
  const params = new URLSearchParams({
    f: 'json',
    parameter_code: USGS_STREAMFLOW_PARAMETER,
    limit: String(limit),
  });
  return `${USGS_LATEST_CONTINUOUS_URL}?${params.toString()}`;
}

export { MAX_ROWS, MAX_PAGES, PAGE_LIMIT };
