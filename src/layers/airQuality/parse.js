/**
 * Normalize Sensor.Community live particulate readings into pooled globe cells.
 *
 * Feed: https://data.sensor.community/static/v2/data.dust.min.json
 * (5-minute averages from the citizen-science sensor network; open data,
 * attribution "Sensor.Community"). No API key.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const AIR_QUALITY_URL =
  'https://data.sensor.community/static/v2/data.dust.min.json';

/** Grid size (degrees) used to pool dense sensor clusters. */
export const AIR_QUALITY_CELL_DEG = 0.5;
export const AIR_QUALITY_MAX_ROWS = 2500;
/** Low-cost optical sensors saturate near 999.9 µg/m³; above this is junk. */
const MAX_PLAUSIBLE_PM = 990;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * PM2.5 (µg/m³) → 0..5 rank using U.S. EPA 24-h AQI breakpoints.
 * @param {number} pm25
 */
export function airQualityRank(pm25) {
  const v = Number(pm25);
  if (!Number.isFinite(v)) return 0;
  if (v > 250.4) return 5;
  if (v > 150.4) return 4;
  if (v > 55.4) return 3;
  if (v > 35.4) return 2;
  if (v > 12.0) return 1;
  return 0;
}

const RANK_LABELS = Object.freeze([
  'Good',
  'Moderate',
  'Unhealthy for sensitive groups',
  'Unhealthy',
  'Very unhealthy',
  'Hazardous',
]);

/** @param {number} rank */
export function airQualityLabel(rank) {
  return RANK_LABELS[Number(rank) || 0] || RANK_LABELS[0];
}

/** AQI-style colors (green → maroon). @param {number} rank */
export function airQualityColorCss(rank) {
  switch (Number(rank) || 0) {
    case 5:
      return '#7E0023';
    case 4:
      return '#8F3F97';
    case 3:
      return '#FF0000';
    case 2:
      return '#FF7E00';
    case 1:
      return '#FFFF00';
    default:
      return '#00E400';
  }
}

/**
 * Pull one outdoor reading {lat, lon, pm25, pm10, country, at} from a raw record.
 * @param {any} record
 */
export function parseAirQualityRecord(record) {
  const loc = record?.location;
  if (!loc || Number(loc.indoor) === 1) return null;
  const lat = parseNum(loc.latitude);
  const lon = parseNum(loc.longitude);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  let pm25 = null;
  let pm10 = null;
  for (const entry of Array.isArray(record.sensordatavalues)
    ? record.sensordatavalues
    : []) {
    const value = parseNum(entry?.value);
    if (value == null || value < 0 || value > MAX_PLAUSIBLE_PM) continue;
    if (entry.value_type === 'P2') pm25 = value;
    else if (entry.value_type === 'P1') pm10 = value;
  }
  if (pm25 == null) return null;
  return {
    lat,
    lon,
    pm25,
    pm10,
    country: typeof loc.country === 'string' ? loc.country : '',
    at: typeof record.timestamp === 'string' ? record.timestamp : '',
  };
}

/**
 * Pool readings into AIR_QUALITY_CELL_DEG cells (median PM per cell).
 * @param {unknown} payload raw feed array
 * @param {{cellDeg?: number, maxRows?: number}} [options]
 */
export function normalizeAirQuality(
  payload,
  { cellDeg = AIR_QUALITY_CELL_DEG, maxRows = AIR_QUALITY_MAX_ROWS } = {},
) {
  const records = Array.isArray(payload) ? payload : [];
  /** @type {Map<string, any>} */
  const cells = new Map();
  const seen = new Set();
  for (const record of records) {
    const reading = parseAirQualityRecord(record);
    if (!reading) continue;
    // One reading per physical location (multiple sensors can share a site).
    const siteKey = record?.location?.id ?? `${reading.lat},${reading.lon}`;
    if (seen.has(siteKey)) continue;
    seen.add(siteKey);
    const row = Math.floor((reading.lat + 90) / cellDeg);
    const col = Math.floor((reading.lon + 180) / cellDeg);
    const key = `${row}:${col}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, lat: 0, lon: 0, pm25: [], pm10: [], countries: new Set(), latest: '' };
      cells.set(key, cell);
    }
    cell.lat += reading.lat;
    cell.lon += reading.lon;
    cell.pm25.push(reading.pm25);
    if (reading.pm10 != null) cell.pm10.push(reading.pm10);
    if (reading.country) cell.countries.add(reading.country);
    if (reading.at > cell.latest) cell.latest = reading.at;
  }
  const rows = [];
  for (const cell of cells.values()) {
    const n = cell.pm25.length;
    const pm25 = median(cell.pm25);
    const pm10 = median(cell.pm10);
    const rank = airQualityRank(pm25);
    rows.push({
      stableId: `aq-${cell.key}`,
      lat: Math.round((cell.lat / n) * 1e4) / 1e4,
      lon: Math.round((cell.lon / n) * 1e4) / 1e4,
      pm25: Math.round(pm25 * 10) / 10,
      pm10: pm10 == null ? null : Math.round(pm10 * 10) / 10,
      sensors: n,
      country: [...cell.countries].slice(0, 3).join('/'),
      observedAt: cell.latest ? `${cell.latest.replace(' ', 'T')}Z` : '',
      intensityRank: rank,
      category: airQualityLabel(rank),
    });
  }
  // Keep the worst air first, then the best-covered cells, under the cap.
  rows.sort(
    (a, b) =>
      b.intensityRank - a.intensityRank || b.sensors - a.sensors || b.pm25 - a.pm25,
  );
  return rows.slice(0, maxRows);
}
