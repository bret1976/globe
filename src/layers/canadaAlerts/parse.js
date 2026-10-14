/**
 * Environment and Climate Change Canada (ECCC) public weather alerts —
 * normalize the keyless MSC GeoMet OGC API `weather-alerts` collection
 * (warnings, watches, advisories, statements) into compact outline rows.
 *
 * Complements the U.S.-only NWS alerts layer. Licence: ECCC Data Servers
 * End-use Licence (commercial use allowed with attribution "Data Source:
 * Environment and Climate Change Canada"). Original Bret/GodsEye code.
 */

export const ECCC_ALERTS_URL =
  'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=2000';

/** Hard cap on outlines served to the globe. */
export const MAX_CANADA_ALERTS = 500;
/** Outline vertices kept per ring (ECCC regions ship 10–600 points). */
export const MAX_ALERT_RING_POINTS = 72;
/** Outline parts kept per alert region. */
export const MAX_ALERT_PARTS = 4;
/** Alert text kept for the card (first paragraph, trimmed). */
const MAX_SUMMARY_CHARS = 180;

const TYPE_RANK = Object.freeze({
  warning: 3,
  watch: 2,
  advisory: 1,
  statement: 0,
});

const RISK_COLORS = Object.freeze({
  red: '#ff3b3b',
  orange: '#ff8c1a',
  yellow: '#ffd400',
});

const TYPE_COLORS = Object.freeze({
  warning: '#ff3b3b',
  watch: '#ff8c1a',
  advisory: '#ffd400',
  statement: '#7fb2ff',
});

export function canadaAlertTypeRank(type) {
  return TYPE_RANK[String(type || '').toLowerCase()] ?? 0;
}

export function canadaAlertColorCss(row) {
  const risk = String(row?.risk || '').toLowerCase();
  if (RISK_COLORS[risk]) return RISK_COLORS[risk];
  const type = String(row?.type || '').toLowerCase();
  return TYPE_COLORS[type] || '#9e9e9e';
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/** Finite [lon,lat] ring, unwrapped, closing point dropped, decimated. */
export function simplifyAlertRing(ring, maxPoints = MAX_ALERT_RING_POINTS) {
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
export function alertOutlineRings(geometry, maxParts = MAX_ALERT_PARTS) {
  if (!geometry || typeof geometry !== 'object') return [];
  let polys = [];
  if (geometry.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
  else return [];
  if (!Array.isArray(polys)) return [];
  const rings = [];
  for (const poly of polys) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
    const ring = simplifyAlertRing(poly[0]);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings
    .map((ring) => ({ ring, area: ringArea(ring) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, maxParts)
    .map(({ ring }) => ring);
}

function centroid(ring) {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [round4(lon / ring.length), round4(lat / ring.length)];
}

function isoOrNull(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** First paragraph of the alert text, trimmed for a card line. */
export function summarizeAlertText(text) {
  const para = String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!para) return null;
  return para.length > MAX_SUMMARY_CHARS
    ? `${para.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`
    : para;
}

/** Normalize one OGC API feature → row, or null when unusable/expired. */
export function parseCanadaAlert(feature, nowMs = Date.now()) {
  const p = feature?.properties;
  if (!p || typeof p !== 'object') return null;
  const status = String(p.status_en || '').toLowerCase();
  if (status === 'ended' || status === 'cancelled') return null;
  const expires = isoOrNull(p.expiration_datetime);
  if (expires && Date.parse(expires) < nowMs) return null;
  const rings = alertOutlineRings(feature.geometry);
  if (!rings.length) return null;
  const [lon, lat] = centroid(rings[0]);
  const type = String(p.alert_type || '').toLowerCase() || 'statement';
  const id = String(feature.id ?? p.feature_id ?? '').trim();
  if (!id) return null;
  return {
    stableId: id.replace(/[^A-Za-z0-9_-]+/g, '-'),
    type,
    rank: canadaAlertTypeRank(type),
    name: String(p.alert_name_en || p.alert_short_name_en || 'weather alert').trim(),
    shortName: String(p.alert_short_name_en || p.alert_name_en || '').trim() || null,
    code: String(p.alert_code || '').trim() || null,
    risk: String(p.risk_colour_en || '').toLowerCase() || null,
    confidence: String(p.confidence_en || '').trim() || null,
    impact: String(p.impact_en || '').trim() || null,
    area: String(p.feature_name_en || '').trim() || null,
    province: String(p.province || '').trim() || null,
    status: status || null,
    issued: isoOrNull(p.publication_datetime),
    effective: isoOrNull(p.validity_datetime),
    eventEnd: isoOrNull(p.event_end_datetime),
    expires,
    summary: summarizeAlertText(p.alert_text_en),
    lat,
    lon,
    rings,
  };
}

const RISK_RANK = Object.freeze({ red: 3, orange: 2, yellow: 1 });

/** Normalize a FeatureCollection, most severe first, capped. */
export function normalizeCanadaAlerts(
  geojson,
  { nowMs = Date.now(), limit = MAX_CANADA_ALERTS } = {},
) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const seen = new Set();
  const rows = [];
  for (const feature of features) {
    const row = parseCanadaAlert(feature, nowMs);
    if (!row || seen.has(row.stableId)) continue;
    seen.add(row.stableId);
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      b.rank - a.rank ||
      (RISK_RANK[b.risk] || 0) - (RISK_RANK[a.risk] || 0) ||
      String(a.name).localeCompare(String(b.name)) ||
      String(a.area).localeCompare(String(b.area)),
  );
  return rows.slice(0, Math.max(0, limit));
}

/** { warning: n, watch: n, ... } */
export function countCanadaAlertTypes(rows) {
  const out = {};
  for (const row of rows || []) out[row.type] = (out[row.type] || 0) + 1;
  return out;
}

/** { 'wind warning': n, ... } */
export function countCanadaAlertNames(rows) {
  const out = {};
  for (const row of rows || []) out[row.name] = (out[row.name] || 0) + 1;
  return out;
}
