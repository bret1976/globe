/**
 * NOAA/NWS Storm Prediction Center convective outlook — normalize Day 1/2
 * categorical GeoJSON into compact polygon rows for the globe.
 *
 * U.S. Government work (public domain). Keyless spc.noaa.gov GeoJSON.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const SPC_DAY1_CAT_URL =
  'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson';
export const SPC_DAY2_CAT_URL =
  'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson';

/** Hard cap on outlook polygons served to the globe. */
export const MAX_SPC_OUTLOOK = 80;
/** Outline vertices kept per outer ring. */
export const MAX_RING_POINTS = 96;

/** Risk tier colors: TSTM light green → HIGH magenta. */
const LABEL_COLORS = Object.freeze({
  TSTM: '#9be89b',
  MRGL: '#66cc00',
  SLGT: '#ffe066',
  ENH: '#ff9933',
  MDT: '#ff3300',
  HIGH: '#ff00ff',
});

const LABEL_RANK = Object.freeze({
  TSTM: 1,
  MRGL: 2,
  SLGT: 3,
  ENH: 4,
  MDT: 5,
  HIGH: 6,
});

/** Labels drawn on the globe (keep mobile light — SLGT and above only). */
export const LABELED_SPC_LABELS = Object.freeze(
  new Set(['SLGT', 'ENH', 'MDT', 'HIGH']),
);

export function spcOutlookColorCss(label) {
  const key = String(label || '').trim().toUpperCase();
  return LABEL_COLORS[key] || '#9e9e9e';
}

export function spcOutlookRank(label) {
  const key = String(label || '').trim().toUpperCase();
  return LABEL_RANK[key] || 0;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Keep a ring valid and compact: finite lon/lat pairs, evenly decimated. */
export function simplifyRing(ring, maxPoints = MAX_RING_POINTS) {
  if (!Array.isArray(ring)) return [];
  const pts = [];
  for (const p of ring) {
    if (!Array.isArray(p)) continue;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    pts.push([round(lon, 4), round(lat, 4)]);
  }
  if (pts.length > 1) {
    const [a0, a1] = pts[0];
    const [b0, b1] = pts[pts.length - 1];
    if (a0 === b0 && a1 === b1) pts.pop();
  }
  if (pts.length < 3) return [];
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(pts[Math.floor(i * step)]);
  return out;
}

function ringCenter(ring) {
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return { lat: round(lat / ring.length, 4), lon: round(lon / ring.length, 4) };
}

/**
 * Extract outer rings from a GeoJSON Polygon or MultiPolygon.
 * @param {object} geometry
 * @returns {number[][][]}
 */
export function outerRingsFromGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  const type = String(geometry.type || '');
  const coords = geometry.coordinates;
  if (!Array.isArray(coords)) return [];
  if (type === 'Polygon') {
    const outer = Array.isArray(coords[0]) ? coords[0] : null;
    return outer ? [outer] : [];
  }
  if (type === 'MultiPolygon') {
    const out = [];
    for (const poly of coords) {
      if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
      out.push(poly[0]);
    }
    return out;
  }
  return [];
}

/**
 * One SPC categorical feature polygon → globe row, or null.
 * @param {object} feature
 * @param {1|2} day
 * @param {number} polyIndex
 */
export function parseSpcOutlookFeature(feature, day, polyIndex = 0) {
  if (!feature || typeof feature !== 'object') return null;
  const props = feature.properties && typeof feature.properties === 'object'
    ? feature.properties
    : {};
  const label = String(props.LABEL || '').trim().toUpperCase();
  if (!label) return null;
  const rings = outerRingsFromGeometry(feature.geometry);
  const rawRing = rings[polyIndex];
  if (!rawRing) return null;
  const ring = simplifyRing(rawRing);
  if (ring.length < 3) return null;
  const center = ringCenter(ring);
  const label2 = props.LABEL2 != null ? String(props.LABEL2).trim().slice(0, 64) : '';
  const dnRaw = props.DN;
  const dn =
    dnRaw == null || dnRaw === ''
      ? null
      : Number.isFinite(Number(dnRaw))
        ? Number(dnRaw)
        : String(dnRaw).slice(0, 32);
  const issue =
    props.ISSUE_ISO != null
      ? String(props.ISSUE_ISO).slice(0, 40)
      : props.ISSUE != null
        ? String(props.ISSUE).slice(0, 40)
        : null;
  const valid =
    props.VALID_ISO != null
      ? String(props.VALID_ISO).slice(0, 40)
      : props.VALID != null
        ? String(props.VALID).slice(0, 40)
        : null;
  const dayNum = day === 2 ? 2 : 1;
  const stableId = [
    'spc',
    `d${dayNum}`,
    label,
    String(polyIndex),
    String(center.lat),
    String(center.lon),
    issue || '',
  ]
    .join(':')
    .replace(/\s+/g, '_');

  return {
    stableId,
    day: dayNum,
    label,
    label2: label2 || null,
    dn,
    issue,
    valid,
    lat: center.lat,
    lon: center.lon,
    ring,
  };
}

/**
 * Expand one GeoJSON FeatureCollection for a given day into rows.
 * @param {unknown} body
 * @param {1|2} day
 */
export function rowsFromSpcGeoJson(body, day) {
  const features = Array.isArray(body?.features) ? body.features : [];
  const rows = [];
  for (const feature of features) {
    const rings = outerRingsFromGeometry(feature?.geometry);
    for (let i = 0; i < rings.length; i += 1) {
      const row = parseSpcOutlookFeature(feature, day, i);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/**
 * Merge Day 1 + Day 2 categorical outlooks → polygon rows.
 * @param {{day1?: unknown, day2?: unknown}} bodies
 */
export function normalizeSpcOutlook(bodies, { limit = MAX_SPC_OUTLOOK } = {}) {
  const rows = [];
  const seen = new Set();
  for (const row of [
    ...rowsFromSpcGeoJson(bodies?.day1, 1),
    ...rowsFromSpcGeoJson(bodies?.day2, 2),
  ]) {
    if (seen.has(row.stableId)) continue;
    seen.add(row.stableId);
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      spcOutlookRank(b.label) - spcOutlookRank(a.label) ||
      a.day - b.day ||
      a.label.localeCompare(b.label),
  );
  return rows.slice(0, limit);
}

/** Count rows per LABEL (and optionally day) for the API payload summary. */
export function countSpcOutlookLabels(rows) {
  const out = {};
  for (const row of rows) out[row.label] = (out[row.label] || 0) + 1;
  return out;
}

export function countSpcOutlookDays(rows) {
  const out = { 1: 0, 2: 0 };
  for (const row of rows) {
    if (row.day === 2) out[2] += 1;
    else out[1] += 1;
  }
  return out;
}
