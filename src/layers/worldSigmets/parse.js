/**
 * Aviation Weather Center international SIGMETs — normalize the keyless
 * `isigmet` feed (volcanic ash, tropical cyclone, thunderstorm, turbulence,
 * icing) into compact outline rows for the globe.
 *
 * Distinct from the domestic `aviation-hazards` layer (airsigmet / gairmet /
 * cwa). U.S. Government work (public domain). Keyless aviationweather.gov API.
 * Situational awareness only — not for flight planning.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const AWC_ISIGMET_URL =
  'https://aviationweather.gov/api/data/isigmet?format=json';

/** Hard cap on outlines served to the globe. */
export const MAX_WORLD_SIGMETS = 250;
/** Outline vertices kept per ring (isigmet polygons ship ~4–80 points). */
export const MAX_RING_POINTS = 72;

const FAMILY_COLORS = Object.freeze({
  ash: '#c084fc',
  cyclone: '#ff4fd8',
  convective: '#ff3b3b',
  turb: '#ff8c1a',
  ice: '#2ee6c8',
  other: '#9e9e9e',
});

const FAMILY_NAMES = Object.freeze({
  ash: 'Volcanic ash',
  cyclone: 'Tropical cyclone',
  convective: 'Thunderstorms',
  turb: 'Turbulence',
  ice: 'Icing',
  other: 'Hazard',
});

/** Map a raw isigmet hazard token to a color family. */
export function worldSigmetFamily(hazard) {
  const h = String(hazard || '')
    .trim()
    .toUpperCase();
  if (h === 'VA') return 'ash';
  if (h === 'TC') return 'cyclone';
  if (h === 'TS' || h === 'CONVECTIVE' || h === 'TSGR') return 'convective';
  if (h === 'TURB' || h === 'MTW') return 'turb';
  if (h === 'ICE') return 'ice';
  return 'other';
}

export function worldSigmetFamilyName(family) {
  return FAMILY_NAMES[family] || FAMILY_NAMES.other;
}

export function worldSigmetColorCss(hazardOrFamily) {
  const family =
    FAMILY_COLORS[hazardOrFamily] != null
      ? hazardOrFamily
      : worldSigmetFamily(hazardOrFamily);
  return FAMILY_COLORS[family] || FAMILY_COLORS.other;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Keep a ring valid and compact: finite lon/lat pairs, longitudes unwrapped
 * across the antimeridian so Cesium draws the short way, evenly decimated.
 */
export function simplifyRing(ring, maxPoints = MAX_RING_POINTS) {
  if (!Array.isArray(ring)) return [];
  const pts = [];
  let prevLon = null;
  for (const p of ring) {
    if (!Array.isArray(p)) continue;
    let lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (prevLon != null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([round(lon, 4), round(lat, 4)]);
  }
  if (pts.length > 1) {
    const [a0, a1] = pts[0];
    const [b0, b1] = pts[pts.length - 1];
    if (a0 === b0 && a1 === b1) pts.pop();
  }
  if (pts.length < 2) return [];
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(pts[Math.floor(i * step)]);
  return out;
}

/** Convert AWC `[{lat,lon},...]` (numbers or strings) → [[lon,lat],...]. */
export function coordsToRing(coords) {
  if (!Array.isArray(coords)) return [];
  const raw = [];
  for (const c of coords) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const lon = Number(c.lon);
    const lat = Number(c.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    raw.push([lon, lat]);
  }
  return simplifyRing(raw);
}

/**
 * isigmet `coords` is one ring for `geom: AREA`, or an array of rings for
 * `geom: AREAS`. Always return a list of rings.
 */
export function coordsToRings(coords) {
  if (!Array.isArray(coords) || !coords.length) return [];
  if (coords.some((c) => Array.isArray(c))) {
    return coords
      .filter((c) => Array.isArray(c))
      .map((c) => coordsToRing(c))
      .filter((r) => r.length >= 2);
  }
  const ring = coordsToRing(coords);
  return ring.length >= 2 ? [ring] : [];
}

function normalizeLon(lon) {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function ringCenter(ring) {
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return {
    lat: round(lat / ring.length, 4),
    lon: round(normalizeLon(lon / ring.length), 4),
  };
}

/** Approximate ring radius (km) from center — for sizing / sorting only. */
function ringRadiusKm(ring, center) {
  let max = 0;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  for (const [x, y] of ring) {
    let dLon = x - center.lon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const dx = dLon * 111.32 * cosLat;
    const dy = (y - center.lat) * 110.57;
    max = Math.max(max, Math.hypot(dx, dy));
  }
  return Math.round(max * 10) / 10;
}

/** Unix seconds or ISO → ISO string. */
export function toIsoTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function snippet(text, max = 400) {
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shortText(value, max = 48) {
  if (value == null) return null;
  const s = String(value).trim().slice(0, max);
  return s || null;
}

/**
 * Parse one isigmet item → zero or more rows (one per ring for AREAS).
 * @param {object} item
 * @returns {object[]}
 */
export function parseWorldSigmet(item) {
  if (!item || typeof item !== 'object') return [];
  const rings = coordsToRings(item.coords);
  if (!rings.length) return [];
  const hazard =
    String(item.hazard || '')
      .trim()
      .toUpperCase() || 'OTHER';
  const family = worldSigmetFamily(hazard);
  const seriesId = shortText(item.seriesId, 24);
  const fir = shortText(item.firId, 12);
  const firName = shortText(item.firName, 64);
  const tag = [fir, seriesId].filter(Boolean).join(' ') || null;
  const qualifier = shortText(item.qualifier, 48);
  const validFrom = toIsoTime(item.validTimeFrom ?? item.receiptTime);
  const validTo = toIsoTime(item.validTimeTo);
  const raw = snippet(item.rawSigmet) || snippet(item.rawText) || null;
  const top = finiteOrNull(item.top);
  const base = finiteOrNull(item.base);
  const dir = shortText(item.dir, 8);
  const spd = finiteOrNull(item.spd);
  const icaoId = shortText(item.icaoId, 8);

  const out = [];
  rings.forEach((ring, index) => {
    const geometryType = ring.length >= 3 ? 'area' : 'line';
    const center = ringCenter(ring);
    const stableId = [
      'isigmet',
      fir || icaoId || 'x',
      seriesId || 'x',
      hazard,
      validFrom || String(item.receiptTime || ''),
      String(index),
      String(center.lat),
      String(center.lon),
    ]
      .join(':')
      .replace(/\s+/g, '_');
    out.push({
      stableId,
      product: 'isigmet',
      hazard,
      family,
      seriesId,
      tag,
      qualifier,
      fir,
      firName,
      icaoId,
      raw,
      validFrom,
      validTo,
      lat: center.lat,
      lon: center.lon,
      radiusKm: ringRadiusKm(ring, center),
      geometryType,
      ring,
      top,
      base,
      dir,
      spd,
    });
  });
  return out;
}

const FAMILY_RANK = Object.freeze({
  ash: 6,
  cyclone: 5,
  convective: 4,
  turb: 3,
  ice: 2,
  other: 0,
});

export function worldSigmetRank(family) {
  return FAMILY_RANK[family] || 0;
}

/**
 * isigmet JSON array → outline rows, VA and TC first when capping.
 * @param {unknown} list
 */
export function normalizeWorldSigmets(
  list,
  { limit = MAX_WORLD_SIGMETS } = {},
) {
  if (!Array.isArray(list)) return [];
  const rows = [];
  const seen = new Set();
  for (const item of list) {
    for (const row of parseWorldSigmet(item)) {
      if (seen.has(row.stableId)) continue;
      seen.add(row.stableId);
      rows.push(row);
    }
  }
  rows.sort(
    (a, b) =>
      worldSigmetRank(b.family) - worldSigmetRank(a.family) ||
      a.radiusKm - b.radiusKm,
  );
  return rows.slice(0, limit);
}

/** Count rows per hazard family, for the API payload summary. */
export function countWorldSigmetFamilies(rows) {
  const out = {};
  for (const row of rows) out[row.family] = (out[row.family] || 0) + 1;
  return out;
}

export function countWorldSigmetHazards(rows) {
  const out = {};
  for (const row of rows) out[row.hazard] = (out[row.hazard] || 0) + 1;
  return out;
}
