/**
 * Normalize NOAA CO-OPS tide-gauge stations + latest water levels into globe rows.
 *
 * Stations: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels
 * Levels:   https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json&station={id}
 * U.S. government public domain — no API key.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const TIDE_STATIONS_URL =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=english';

export const TIDE_DATAGETTER_BASE =
  'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

const MAX_ROWS = 400;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Water-level intensity rank for coloring (0–4), absolute feet MLLW.
 * @param {?number} ft
 */
export function tideGaugeIntensityRank(ft) {
  const v = Number(ft);
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a >= 8) return 4;
  if (a >= 5) return 3;
  if (a >= 3) return 2;
  if (a >= 1.5) return 1;
  return 0;
}

/**
 * CSS color by tide intensity (teal/green family; distinct from NDBC cyan / USGS blue).
 * @param {number} rank
 */
export function tideGaugeIntensityColorCss(rank) {
  switch (Number(rank) || 0) {
    case 4:
      return '#00FFAA';
    case 3:
      return '#22DDBB';
    case 2:
      return '#2ABBA0';
    case 1:
      return '#3A9988';
    default:
      return '#4A7870';
  }
}

/**
 * Build the latest water-level request URL for one station.
 * @param {string} stationId
 */
export function tideGaugeLatestUrl(stationId) {
  const params = new URLSearchParams({
    date: 'latest',
    station: String(stationId),
    product: 'water_level',
    datum: 'MLLW',
    units: 'english',
    time_zone: 'gmt',
    format: 'json',
  });
  return `${TIDE_DATAGETTER_BASE}?${params.toString()}`;
}

/**
 * @param {object} station CO-OPS mdapi station object
 * @returns {object|null}
 */
export function parseTideStation(station) {
  if (!station || typeof station !== 'object') return null;
  const id = String(station.id || '').trim();
  if (!id) return null;
  const lat = parseNum(station.lat);
  const lon = parseNum(station.lng ?? station.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const name = String(station.name || id).trim();
  const state = String(station.state || '').trim();
  return {
    stableId: id,
    id,
    name,
    state,
    lat,
    lon,
  };
}

/**
 * Extract latest water level (ft MLLW) from a datagetter JSON body.
 * @param {object} body
 * @returns {{waterLevelFt: ?number, observedAt: string}}
 */
export function parseTideLevelPayload(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (!rows.length) return { waterLevelFt: null, observedAt: '' };
  const first = rows[0] || {};
  const waterLevelFt = parseNum(first.v);
  const observedAt = String(first.t || '').trim();
  return {
    waterLevelFt: Number.isFinite(waterLevelFt) ? waterLevelFt : null,
    observedAt,
  };
}

/**
 * Merge stations with optional level map into ranked globe rows.
 * @param {object[]|unknown} stations
 * @param {Map<string, {waterLevelFt: ?number, observedAt: string}>|object} [levelsById]
 * @param {{ maxRows?: number }} [options]
 */
export function normalizeTideGauges(stations, levelsById = new Map(), options = {}) {
  const maxRows = Math.max(20, Number(options.maxRows) || MAX_ROWS);
  const list = Array.isArray(stations)
    ? stations
    : Array.isArray(stations?.stations)
      ? stations.stations
      : [];
  const levelMap =
    levelsById instanceof Map
      ? levelsById
      : new Map(Object.entries(levelsById || {}));

  /** @type {object[]} */
  const rows = [];
  for (const station of list) {
    const base = parseTideStation(station);
    if (!base) continue;
    const level = levelMap.get(base.id) || {};
    const waterLevelFt = Number.isFinite(level.waterLevelFt)
      ? level.waterLevelFt
      : null;
    const observedAt = String(level.observedAt || '').trim();
    const intensityRank = tideGaugeIntensityRank(waterLevelFt);
    rows.push({
      ...base,
      waterLevelFt,
      observedAt,
      datum: 'MLLW',
      unit: 'ft',
      intensityRank,
    });
  }

  rows.sort((a, b) => {
    const aHas = Number.isFinite(a.waterLevelFt) ? 1 : 0;
    const bHas = Number.isFinite(b.waterLevelFt) ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    const rank = (b.intensityRank || 0) - (a.intensityRank || 0);
    if (rank) return rank;
    const level =
      Math.abs(Number(b.waterLevelFt) || 0) - Math.abs(Number(a.waterLevelFt) || 0);
    if (level) return level;
    return String(a.id).localeCompare(String(b.id));
  });

  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

export { MAX_ROWS };
