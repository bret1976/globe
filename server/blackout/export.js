/** Went-dark rows → JSON / CSV / GeoJSON for the public Blackout API. */
export const DARK_COLUMNS = ['id', 'kind', 'label', 'lat', 'lon', 'lastSeenAt', 'silentMin', 'state', 'flaggedAt', 'reappearedAt', 'speedMps', 'headingDeg', 'altitudeM', 'source'];

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** One normalised row from a live flag or a 24 h log entry. */
export function darkRow(f, { kind, source, nowMs, state = 'dark' }) {
  const silent = Number.isFinite(f.silentMs) ? f.silentMs : Number.isFinite(f.lastAt) ? nowMs - f.lastAt : null;
  return {
    id: String(f.id),
    kind,
    label: f.label == null ? null : String(f.label),
    lat: round(f.lat, 4),
    lon: round(f.lon, 4),
    lastSeenAt: iso(f.lastAt),
    silentMin: silent == null ? null : Math.round(silent / 60_000),
    state: f.reappearedAt ? 'reappeared' : state,
    flaggedAt: iso(f.flaggedAt),
    reappearedAt: iso(f.reappearedAt),
    speedMps: round(f.speed, 1),
    headingDeg: round(f.heading, 0),
    altitudeM: round(f.altitudeM, 0),
    source,
  };
}

export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Spreadsheet formula injection guard.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return [DARK_COLUMNS.join(','), ...rows.map((r) => DARK_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export function toGeoJson(rows, meta = {}) {
  return {
    type: 'FeatureCollection',
    ...meta,
    features: rows
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
      .map((r) => ({ type: 'Feature', id: `${r.kind}:${r.id}`, geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: r })),
  };
}
