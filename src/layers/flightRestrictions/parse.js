/**
 * FAA Temporary Flight Restrictions (TFRs) — normalize the FAA GeoServer WFS
 * GeoJSON into compact outline rows for the globe.
 *
 * U.S. Government work (public domain). Keyless.
 */

export const FLIGHT_RESTRICTIONS_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature' +
  '&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326';

/** Hard cap on outlines served to the globe. */
export const MAX_FLIGHT_RESTRICTIONS = 600;
/** Outline vertices kept per ring (FAA circles ship ~40–100 points). */
export const MAX_RING_POINTS = 72;

const KIND_COLORS = Object.freeze({
  vip: '#ff3b3b',
  security: '#ff8c1a',
  hazards: '#ffd21a',
  sports: '#38b6ff',
  uas: '#b06cff',
  space: '#2ee6c8',
  other: '#d0d0d0',
});

/** Map an FAA TFR "LEGAL" type to a compact kind. */
export function flightRestrictionKind(type) {
  const t = String(type || '').toUpperCase();
  if (t.includes('VIP')) return 'vip';
  if (t.includes('SECURITY')) return 'security';
  if (t.includes('HAZARD')) return 'hazards';
  if (t.includes('AIR SHOW') || t.includes('SPORT')) return 'sports';
  if (t.includes('UAS')) return 'uas';
  if (t.includes('SPACE')) return 'space';
  return 'other';
}

export function flightRestrictionColorCss(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.other;
}

/** "6/6654-1-FDC-F" → "6/6654". */
export function notamIdFromKey(key) {
  const m = /^(\d+\/\d+)/.exec(String(key || '').trim());
  return m ? m[1] : null;
}

/** Official FAA graphic-TFR detail page for a NOTAM id like "6/6654". */
export function faaTfrDetailUrl(notamId) {
  if (!/^\d+\/\d+$/.test(String(notamId || ''))) return null;
  return `https://tfr.faa.gov/tfr3/?page=detail_${notamId.replace('/', '_')}`;
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

function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (geometry.type === 'MultiPolygon')
    return (geometry.coordinates || []).map((poly) => poly?.[0]);
  return [];
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

/** "202610011551" (UTC) → ISO string. */
export function faaStampToIso(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
}

const KIND_RANK = Object.freeze({
  vip: 6,
  security: 5,
  hazards: 4,
  space: 3,
  sports: 2,
  uas: 1,
  other: 0,
});

/** Normalize the WFS FeatureCollection → outline rows. */
export function normalizeFlightRestrictions(body, { limit = MAX_FLIGHT_RESTRICTIONS } = {}) {
  const features = Array.isArray(body?.features) ? body.features : [];
  const rows = [];
  const seen = new Set();
  for (const feature of features) {
    const p = feature?.properties || {};
    const rings = outerRings(feature?.geometry);
    rings.forEach((raw, index) => {
      const ring = simplifyRing(raw);
      if (!ring.length) return;
      const baseId = String(p.GID ?? feature?.id ?? p.NOTAM_KEY ?? rows.length);
      const stableId = rings.length > 1 ? `${baseId}-${index}` : baseId;
      if (seen.has(stableId)) return;
      seen.add(stableId);
      const center = ringCenter(ring);
      const type = String(p.LEGAL || '').trim() || 'OTHER';
      const kind = flightRestrictionKind(type);
      const notamId = notamIdFromKey(p.NOTAM_KEY);
      rows.push({
        stableId,
        notamId,
        notamKey: p.NOTAM_KEY ? String(p.NOTAM_KEY) : null,
        type,
        kind,
        title: String(p.TITLE || '').trim().slice(0, 240) || notamId || 'TFR',
        state: p.STATE ? String(p.STATE) : null,
        facility: p.CNS_LOCATION_ID ? String(p.CNS_LOCATION_ID) : null,
        modified: faaStampToIso(p.LAST_MODIFICATION_DATETIME),
        faaUrl: faaTfrDetailUrl(notamId),
        lat: center.lat,
        lon: center.lon,
        radiusKm: ringRadiusKm(ring, center),
        ring,
      });
    });
  }
  rows.sort(
    (a, b) => (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0) || a.radiusKm - b.radiusKm,
  );
  return rows.slice(0, limit);
}

/** Count rows per kind, for the API payload summary. */
export function countFlightRestrictionKinds(rows) {
  const out = {};
  for (const row of rows) out[row.kind] = (out[row.kind] || 0) + 1;
  return out;
}
