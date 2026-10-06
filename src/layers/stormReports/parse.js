/**
 * Normalize NWS Local Storm Reports (LSR) into globe point rows.
 *
 * Feed: Iowa Environmental Mesonet LSR GeoJSON (public domain; republishes
 * National Weather Service local storm reports — tornado, hail, wind damage,
 * flooding, heavy rain/snow — as spotters and offices file them). No API key.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const STORM_REPORTS_HOURS = 48;
export const STORM_REPORTS_URL = `https://mesonet.agron.iastate.edu/geojson/lsr.php?hours=${STORM_REPORTS_HOURS}`;
export const STORM_REPORTS_MAX_ROWS = 1500;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coarse report kind from the NWS LSR type text.
 * @param {string} typetext
 */
export function stormReportKind(typetext) {
  const t = String(typetext || '').toUpperCase();
  if (/TORNADO|FUNNEL|WATERSPOUT/.test(t)) return 'tornado';
  if (/HAIL/.test(t)) return 'hail';
  if (/FLOOD/.test(t)) return 'flood';
  if (/WND|WIND|DOWNBURST|GUSTNADO/.test(t)) return 'wind';
  if (/SNOW|BLIZZARD|ICE|SLEET|FREEZING|WINTER|AVALANCHE/.test(t)) return 'winter';
  if (/RAIN/.test(t)) return 'rain';
  if (/FIRE|SMOKE/.test(t)) return 'fire';
  if (/LIGHTNING/.test(t)) return 'lightning';
  if (/SURF|SURGE|TIDE|RIP|TSUNAMI|SEICHE/.test(t)) return 'marine';
  return 'other';
}

/**
 * 0..4 severity rank from kind + magnitude (hail inches, wind mph).
 * @param {string} typetext
 * @param {?number} magnitude
 */
export function stormReportRank(typetext, magnitude) {
  const t = String(typetext || '').toUpperCase();
  const kind = stormReportKind(t);
  const m = Number(magnitude);
  switch (kind) {
    case 'tornado':
      return /FUNNEL/.test(t) ? 3 : 4;
    case 'hail':
      if (m >= 2) return 4;
      if (m >= 1) return 3;
      return 2;
    case 'wind':
      if (m >= 75) return 4;
      if (/DMG|DAMAGE/.test(t) || m >= 58) return 3;
      return 2;
    case 'flood':
      return /FLASH/.test(t) ? 3 : 2;
    case 'winter':
    case 'fire':
    case 'marine':
      return 2;
    case 'rain':
    case 'lightning':
      return 1;
    default:
      return 1;
  }
}

/** CSS color by report kind. @param {string} kind */
export function stormReportColorCss(kind) {
  switch (kind) {
    case 'tornado':
      return '#FF1744';
    case 'hail':
      return '#00E676';
    case 'wind':
      return '#FFC400';
    case 'flood':
      return '#2979FF';
    case 'rain':
      return '#4FC3F7';
    case 'winter':
      return '#E0E0E0';
    case 'fire':
      return '#FF6D00';
    case 'lightning':
      return '#D500F9';
    case 'marine':
      return '#1DE9B6';
    default:
      return '#B0BEC5';
  }
}

/**
 * @param {any} feature GeoJSON feature from the IEM LSR service
 */
export function parseStormReport(feature, index = 0) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;
  const lon = parseNum(Array.isArray(coords) ? coords[0] : p.lon);
  const lat = parseNum(Array.isArray(coords) ? coords[1] : p.lat);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const typetext = String(p.typetext || '').trim();
  if (!typetext) return null;
  const magnitude = parseNum(p.magf ?? p.magnitude);
  const kind = stormReportKind(typetext);
  const valid = typeof p.valid === 'string' ? p.valid : '';
  const remark = typeof p.remark === 'string' ? p.remark.slice(0, 280) : '';
  return {
    stableId: `lsr-${p.product_id || 'x'}-${feature?.id ?? index}-${lat}-${lon}`,
    lat,
    lon,
    type: typetext,
    kind,
    magnitude,
    unit: typeof p.unit === 'string' ? p.unit : '',
    city: typeof p.city === 'string' ? p.city : '',
    county: typeof p.county === 'string' ? p.county : '',
    state: typeof p.st === 'string' ? p.st : typeof p.state === 'string' ? p.state : '',
    wfo: typeof p.wfo === 'string' ? p.wfo : '',
    reporter: typeof p.source === 'string' ? p.source : '',
    observedAt: valid,
    remark,
    intensityRank: stormReportRank(typetext, magnitude),
  };
}

/**
 * @param {unknown} collection GeoJSON FeatureCollection
 * @param {{maxRows?: number}} [options]
 */
export function normalizeStormReports(
  collection,
  { maxRows = STORM_REPORTS_MAX_ROWS } = {},
) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  const rows = [];
  for (let i = 0; i < features.length; i += 1) {
    const row = parseStormReport(features[i], i);
    if (row) rows.push(row);
  }
  rows.sort(
    (a, b) =>
      b.intensityRank - a.intensityRank ||
      String(b.observedAt).localeCompare(String(a.observedAt)),
  );
  return rows.slice(0, maxRows);
}
