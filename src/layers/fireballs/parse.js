/**
 * NASA JPL fireball events — normalize the SSD Fireball API into globe rows.
 *
 * Public domain NASA data (ssd-api.jpl.nasa.gov/fireball.api). Keyless.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const FIREBALLS_URL = 'https://ssd-api.jpl.nasa.gov/fireball.api';
export const FIREBALLS_URL_LIMITED =
  'https://ssd-api.jpl.nasa.gov/fireball.api?limit=250';

/** Cap on events with coordinates served to the globe. */
export const MAX_FIREBALLS = 250;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Signed degrees from magnitude + N/S or E/W.
 * @param {unknown} mag
 * @param {unknown} dir
 * @param {'lat'|'lon'} axis
 */
export function signedDegree(mag, dir, axis) {
  const n = parseNum(mag);
  if (n == null) return null;
  const d = String(dir || '')
    .trim()
    .toUpperCase();
  if (axis === 'lat') {
    if (d === 'S') return -Math.abs(n);
    if (d === 'N' || d === '') return Math.abs(n);
    return null;
  }
  if (d === 'W') return -Math.abs(n);
  if (d === 'E' || d === '') return Math.abs(n);
  return null;
}

/** CSS color by energy (kt TNT equivalent scale as given by JPL). */
export function fireballColorCss(energyKt) {
  const e = Number(energyKt);
  if (!Number.isFinite(e) || e < 1) return '#ffcc80';
  if (e < 5) return '#ffab40';
  if (e < 20) return '#ff6d00';
  if (e < 100) return '#ff3d00';
  return '#ff1744';
}

/** Pixel size hint by energy. */
export function fireballPixelSize(energyKt) {
  const e = Number(energyKt);
  if (!Number.isFinite(e) || e <= 0) return 6;
  return Math.min(22, Math.max(6, 5 + Math.log10(e + 1) * 6));
}

/**
 * One fireball data row (positional array) + field names → globe row, or null.
 * @param {unknown[]} values
 * @param {string[]} fields
 */
export function parseFireball(values, fields) {
  if (!Array.isArray(values) || !Array.isArray(fields)) return null;
  const get = (name) => {
    const i = fields.indexOf(name);
    return i >= 0 ? values[i] : null;
  };
  const dateRaw = get('date');
  const dateStr = typeof dateRaw === 'string' ? dateRaw.trim() : '';
  // JPL uses "YYYY-MM-DD HH:MM:SS" (UTC, space separator).
  const isoCandidate = dateStr.includes('T')
    ? dateStr
    : dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z');
  const t = Date.parse(isoCandidate);
  if (!Number.isFinite(t)) return null;
  const lat = signedDegree(get('lat'), get('lat-dir'), 'lat');
  const lon = signedDegree(get('lon'), get('lon-dir'), 'lon');
  if (lat == null || lon == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const energy = parseNum(get('energy'));
  const impactE = parseNum(get('impact-e'));
  const altKm = parseNum(get('alt'));
  const vel = parseNum(get('vel'));
  const altM =
    altKm == null || altKm < 0 || altKm > 200
      ? 30_000
      : Math.round(altKm * 1000);
  const observedAt = new Date(t).toISOString();
  const stableId = `fb-${observedAt}-${lat.toFixed(2)}-${lon.toFixed(2)}`;
  return {
    stableId,
    observedAt,
    lat,
    lon,
    altM,
    altKm: altKm == null ? null : Math.round(altKm * 10) / 10,
    energyKt: energy == null ? null : Math.round(energy * 1000) / 1000,
    impactEj: impactE == null ? null : Math.round(impactE * 1000) / 1000,
    velKms: vel == null ? null : Math.round(vel * 10) / 10,
  };
}

/**
 * Normalize the Fireball API payload → rows, newest first, capped.
 * @param {unknown} body
 * @param {{limit?: number}} [options]
 */
export function normalizeFireballs(body, { limit = MAX_FIREBALLS } = {}) {
  const fields = Array.isArray(body?.fields) ? body.fields : [];
  const data = Array.isArray(body?.data) ? body.data : [];
  const rows = [];
  const seen = new Set();
  for (const values of data) {
    const row = parseFireball(values, fields);
    if (!row) continue;
    if (seen.has(row.stableId)) continue;
    seen.add(row.stableId);
    rows.push(row);
  }
  rows.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return rows.slice(0, limit);
}
