/**
 * Aviation Weather Center hazards — normalize SIGMETs, G-AIRMETs, and Center
 * Weather Advisories into compact outline rows for the globe.
 *
 * U.S. Government work (public domain). Keyless aviationweather.gov APIs.
 * Situational awareness only — not for flight planning.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const AWC_SIGMET_URL =
  'https://aviationweather.gov/api/data/airsigmet?format=json';
export const AWC_GAIRMET_URL =
  'https://aviationweather.gov/api/data/gairmet?format=json';
export const AWC_CWA_URL =
  'https://aviationweather.gov/api/data/cwa?format=json';

/** Hard cap on outlines served to the globe. */
export const MAX_AVIATION_HAZARDS = 400;
/** Outline vertices kept per ring (AWC polygons ship ~5–100 points). */
export const MAX_RING_POINTS = 72;

const FAMILY_COLORS = Object.freeze({
  turb: '#ff8c1a',
  ice: '#2ee6c8',
  convective: '#ff3b3b',
  ifr: '#b06cff',
  wind: '#ffd21a',
  other: '#9e9e9e',
});

/** Map a raw AWC hazard token to a color family. */
export function aviationHazardFamily(hazard) {
  const h = String(hazard || '').toUpperCase();
  if (h === 'TURB' || h === 'TURB-HI' || h === 'TURB-LO') return 'turb';
  if (h === 'ICE' || h === 'FZLVL' || h === 'M_FZLVL') return 'ice';
  if (h === 'CONVECTIVE' || h === 'TS') return 'convective';
  if (h === 'IFR' || h === 'MT_OBSC') return 'ifr';
  if (h === 'LLWS' || h === 'SFC_WND') return 'wind';
  return 'other';
}

export function aviationHazardColorCss(hazardOrFamily) {
  const family =
    FAMILY_COLORS[hazardOrFamily] != null
      ? hazardOrFamily
      : aviationHazardFamily(hazardOrFamily);
  return FAMILY_COLORS[family] || FAMILY_COLORS.other;
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
    if (!c || typeof c !== 'object') continue;
    const lon = Number(c.lon);
    const lat = Number(c.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    raw.push([lon, lat]);
  }
  return simplifyRing(raw);
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

/** Approximate ring radius (km) from center — for sizing / sorting only. */
function ringRadiusKm(ring, center) {
  let max = 0;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  for (const [x, y] of ring) {
    const dx = (x - center.lon) * 111.32 * cosLat;
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

function snippet(text, max = 280) {
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

function isClosedRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  return true;
}

/**
 * @param {object} item
 * @param {'sigmet'|'gairmet'|'cwa'} product
 */
export function parseAviationHazard(item, product) {
  if (!item || typeof item !== 'object') return null;
  const ring = coordsToRing(item.coords);
  if (ring.length < 2) return null;
  const hazard = String(item.hazard || '').trim().toUpperCase() || 'OTHER';
  const family = aviationHazardFamily(hazard);
  const geomRaw = String(item.geometryType || item.geom || '').toUpperCase();
  const geometryType =
    geomRaw === 'LINE' || (!isClosedRing(ring) && product === 'gairmet')
      ? 'line'
      : 'area';
  // Lines need ≥2 pts; filled areas need ≥3.
  if (geometryType === 'area' && ring.length < 3) return null;

  const seriesId = String(
    item.seriesId || item.tag || item.name || item.icaoId || '',
  )
    .trim()
    .slice(0, 48);
  const validFrom = toIsoTime(
    item.validTimeFrom ?? item.validTime ?? item.issueTime,
  );
  const validTo = toIsoTime(item.validTimeTo ?? item.expireTime);
  const raw =
    snippet(item.rawAirSigmet) ||
    snippet(item.rawText) ||
    snippet(item.due_to) ||
    '';
  const center = ringCenter(ring);
  const stableId = [
    product,
    seriesId || 'x',
    hazard,
    validFrom || String(item.receiptTime || item.issueTime || ''),
    String(center.lat),
    String(center.lon),
  ]
    .join(':')
    .replace(/\s+/g, '_');

  return {
    stableId,
    product,
    hazard,
    family,
    seriesId: seriesId || null,
    tag: item.tag ? String(item.tag).slice(0, 32) : null,
    raw: raw || null,
    validFrom,
    validTo,
    lat: center.lat,
    lon: center.lon,
    radiusKm: ringRadiusKm(ring, center),
    geometryType,
    ring,
  };
}

const PRODUCT_RANK = Object.freeze({ sigmet: 3, cwa: 2, gairmet: 1 });
const FAMILY_RANK = Object.freeze({
  convective: 5,
  turb: 4,
  ice: 3,
  ifr: 2,
  wind: 1,
  other: 0,
});

/**
 * Merge SIGMET / G-AIRMET / CWA arrays → outline rows.
 * @param {{sigmets?: unknown, gairmets?: unknown, cwas?: unknown}} bodies
 */
export function normalizeAviationHazards(
  bodies,
  { limit = MAX_AVIATION_HAZARDS } = {},
) {
  const rows = [];
  const seen = new Set();
  const pushAll = (list, product) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const row = parseAviationHazard(item, product);
      if (!row) continue;
      if (seen.has(row.stableId)) continue;
      seen.add(row.stableId);
      rows.push(row);
    }
  };
  pushAll(bodies?.sigmets, 'sigmet');
  pushAll(bodies?.gairmets, 'gairmet');
  pushAll(bodies?.cwas, 'cwa');
  rows.sort(
    (a, b) =>
      (PRODUCT_RANK[b.product] || 0) - (PRODUCT_RANK[a.product] || 0) ||
      (FAMILY_RANK[b.family] || 0) - (FAMILY_RANK[a.family] || 0) ||
      a.radiusKm - b.radiusKm,
  );
  return rows.slice(0, limit);
}

/** Count rows per hazard family, for the API payload summary. */
export function countAviationHazardFamilies(rows) {
  const out = {};
  for (const row of rows) out[row.family] = (out[row.family] || 0) + 1;
  return out;
}

export function countAviationHazardProducts(rows) {
  const out = {};
  for (const row of rows) out[row.product] = (out[row.product] || 0) + 1;
  return out;
}
