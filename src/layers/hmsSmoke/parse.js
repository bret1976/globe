/**
 * NOAA Hazard Mapping System (HMS) smoke polygons — normalize daily KML into
 * compact ring rows for the globe.
 *
 * U.S. Government work (public domain). Keyless satepsanone.nesdis.noaa.gov KML.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

/** Prefer today UTC; fall back one day when today's product is still empty. */
export function hmsSmokeKmlUrlForDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/${y}/${m}/hms_smoke${y}${m}${d}.kml`;
}

export const MAX_HMS_SMOKE = 120;
export const MAX_RING_POINTS = 64;

const DENSITY_COLORS = Object.freeze({
  LIGHT: '#c4b5a0',
  MEDIUM: '#d97706',
  HEAVY: '#7c2d12',
});

const DENSITY_RANK = Object.freeze({
  LIGHT: 1,
  MEDIUM: 2,
  HEAVY: 3,
});

export function hmsSmokeColorCss(density) {
  const key = String(density || '').trim().toUpperCase();
  return DENSITY_COLORS[key] || '#a8a29e';
}

export function hmsSmokeRank(density) {
  const key = String(density || '').trim().toUpperCase();
  return DENSITY_RANK[key] || 0;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

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

function parseDensity(description) {
  const text = String(description || '');
  const m = text.match(/Density:\s*(Light|Medium|Heavy)/i);
  return m ? m[1].toUpperCase() : null;
}

function parseSatellite(description) {
  const text = String(description || '');
  const m = text.match(/Satellite:\s*([^<\n]+)/i);
  return m ? m[1].trim().slice(0, 40) : null;
}

function parseWindow(description) {
  const text = String(description || '');
  const start = text.match(/Start Time:\s*([^<\n]+)/i);
  const end = text.match(/End Time:\s*([^<\n]+)/i);
  return {
    start: start ? start[1].trim().slice(0, 40) : null,
    end: end ? end[1].trim().slice(0, 40) : null,
  };
}

function parseCoordinatesBlock(block) {
  const pts = [];
  for (const token of String(block || '').trim().split(/\s+/)) {
    if (!token) continue;
    const [lonS, latS] = token.split(',');
    const lon = Number(lonS);
    const lat = Number(latS);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    pts.push([lon, lat]);
  }
  return pts;
}

/**
 * Parse HMS smoke KML text into globe rows (density Light/Medium/Heavy).
 * @param {string} kmlText
 * @param {{dateKey?: string}} [opts]
 * @returns {object[]}
 */
export function normalizeHmsSmokeKml(kmlText, { dateKey = '' } = {}) {
  const text = String(kmlText || '');
  if (!text.includes('<Placemark')) return [];
  const rows = [];
  const placemarkRe = /<Placemark>([\s\S]*?)<\/Placemark>/gi;
  let match;
  let index = 0;
  while ((match = placemarkRe.exec(text)) && rows.length < MAX_HMS_SMOKE) {
    const body = match[1];
    const descMatch = body.match(
      /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i,
    ) || body.match(/<description>([\s\S]*?)<\/description>/i);
    const description = descMatch ? descMatch[1] : '';
    const density = parseDensity(description);
    if (!density) continue;
    const coordMatch = body.match(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (!coordMatch) continue;
    const rawRing = parseCoordinatesBlock(coordMatch[1]);
    const ring = simplifyRing(rawRing);
    if (ring.length < 3) continue;
    const center = ringCenter(ring);
    const window = parseWindow(description);
    const satellite = parseSatellite(description);
    const stableId = `hms-${dateKey || 'd'}-${density.toLowerCase()}-${index}`;
    rows.push({
      stableId,
      density,
      lat: center.lat,
      lon: center.lon,
      ring,
      satellite,
      start: window.start,
      end: window.end,
      dateKey: dateKey || null,
    });
    index += 1;
  }
  // Prefer heavier plumes when capping.
  rows.sort((a, b) => hmsSmokeRank(b.density) - hmsSmokeRank(a.density));
  return rows.slice(0, MAX_HMS_SMOKE);
}

export function countHmsSmokeDensities(rows) {
  const counts = { LIGHT: 0, MEDIUM: 0, HEAVY: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.density || '').toUpperCase();
    if (key in counts) counts[key] += 1;
  }
  return counts;
}
