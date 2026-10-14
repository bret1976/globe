/**
 * NOAA Coral Reef Watch — Daily 5km Regional Virtual Stations.
 *
 * Normalizes the keyless CRW `vs_polygons.json` GeoJSON (one Point + one
 * Polygon/MultiPolygon per station, ~214 reef regions worldwide) into compact
 * station rows: centroid, simplified region outline, current bleaching alert
 * level, SST, SST anomaly, HotSpot, Degree Heating Weeks and the 7-day trend
 * encoded in CRW's gauge filename.
 *
 * U.S. Government work (public domain). Original Bret/GodsEye code.
 */

export const CRW_VS_URL =
  'https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json';

/** Outline vertices kept per ring. */
export const MAX_CORAL_RING_POINTS = 64;
/** Outline parts kept per station (largest first; island groups ship many). */
export const MAX_CORAL_PARTS = 6;
/** Hard cap on stations served to the globe. */
export const MAX_CORAL_STATIONS = 400;

/**
 * Heritage CRW Regional Virtual Station alert scale (still used by the RVS
 * product): 0 No Stress, 1 Bleaching Watch, 2 Bleaching Warning,
 * 3 Alert Level 1, 4 Alert Level 2.
 */
const LEVELS = Object.freeze([
  { name: 'No Stress', short: 'NO STRESS', color: '#7fd3ff' },
  { name: 'Bleaching Watch', short: 'WATCH', color: '#ffee58' },
  { name: 'Bleaching Warning', short: 'WARNING', color: '#ffa726' },
  { name: 'Alert Level 1', short: 'ALERT 1', color: '#ff3b3b' },
  { name: 'Alert Level 2', short: 'ALERT 2', color: '#a3001b' },
]);

export function coralAlertLevel(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(LEVELS.length - 1, n));
}

export function coralAlertName(level) {
  return LEVELS[level]?.name || 'Unknown';
}

export function coralAlertShort(level) {
  return LEVELS[level]?.short || '?';
}

export function coralAlertColorCss(level) {
  return LEVELS[level]?.color || '#9e9e9e';
}

function num(value, digits = 2) {
  const n = Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * Parse CRW's gauge filename `Coral_Bleaching_Alert_Level_<prev>_to_<now>.bmp`
 * into { from, to, trend } where trend ∈ rising | falling | steady.
 */
export function parseCoralGauge(gauge) {
  const m = /Level_(\d)_to_(\d)/i.exec(String(gauge || ''));
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return {
    from,
    to,
    trend: to > from ? 'rising' : to < from ? 'falling' : 'steady',
  };
}

/** Finite [lon,lat] ring, closing point dropped, evenly decimated. */
export function simplifyCoralRing(ring, maxPoints = MAX_CORAL_RING_POINTS) {
  if (!Array.isArray(ring)) return [];
  const pts = [];
  let prevLon = null;
  for (const p of ring) {
    if (!Array.isArray(p)) continue;
    let lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) continue;
    if (prevLon != null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([round4(lon), round4(lat)]);
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

/** Shoelace area in degrees² (only used to rank parts). */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Outer rings of a Polygon / MultiPolygon, largest first, capped. */
export function coralOutlineRings(geometry, maxParts = MAX_CORAL_PARTS) {
  if (!geometry || typeof geometry !== 'object') return [];
  let polys = [];
  if (geometry.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
  else return [];
  if (!Array.isArray(polys)) return [];
  const rings = [];
  for (const poly of polys) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
    const ring = simplifyCoralRing(poly[0]);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings
    .map((ring) => ({ ring, area: ringArea(ring) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, maxParts)
    .map(({ ring }) => ring);
}

function ringCentroid(ring) {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function wrapLon(lon) {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return round4(x);
}

/**
 * Merge CRW features into one row per station (keyed by name): the Point
 * gives the marker, the (Multi)Polygon gives the outline, properties repeat
 * on both. Sorted most severe first, then by DHW.
 */
export function normalizeCoralStations(geojson, { limit = MAX_CORAL_STATIONS } = {}) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const feature of features) {
    const props = feature?.properties;
    const name = String(props?.name || '').trim();
    if (!name) continue;
    const level = coralAlertLevel(props.alert);
    if (level == null) continue;
    let row = byName.get(name);
    if (!row) {
      const gauge = parseCoralGauge(props.gauge);
      row = {
        stableId: name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
        name,
        date: String(props.date || '').trim() || null,
        level,
        levelName: coralAlertName(level),
        sst: num(props.sst),
        ssta: num(props.ssta),
        hotspot: num(props.hs),
        dhw: num(props.dhw),
        prevLevel: gauge ? gauge.from : null,
        trend: gauge ? gauge.trend : null,
        page: props.gauge_page
          ? `https://coralreefwatch.noaa.gov/product/vs/gauges/${String(props.gauge_page).replace(/[^A-Za-z0-9_.-]/g, '')}`
          : null,
        lat: null,
        lon: null,
        rings: [],
      };
      byName.set(name, row);
    }
    const geometry = feature.geometry;
    if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) {
      const lon = Number(geometry.coordinates[0]);
      const lat = Number(geometry.coordinates[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90) {
        row.lon = wrapLon(lon);
        row.lat = round4(lat);
      }
    } else if (!row.rings.length) {
      row.rings = coralOutlineRings(geometry);
    }
  }
  const rows = [];
  for (const row of byName.values()) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
      if (!row.rings.length) continue;
      const [lon, lat] = ringCentroid(row.rings[0]);
      row.lon = wrapLon(lon);
      row.lat = round4(lat);
    }
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      b.level - a.level ||
      (b.dhw ?? -1) - (a.dhw ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return rows.slice(0, Math.max(0, limit));
}

/** { '0': n, '1': n, ... } histogram of alert levels. */
export function countCoralLevels(rows) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row.level);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
