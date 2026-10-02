/**
 * Normalize NOAA NDBC latest buoy observations into globe rows.
 *
 * Feed: https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * U.S. government public domain — no API key.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

export const NDBC_LATEST_OBS_URL =
  'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';

const MAX_ROWS = 1000;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s === 'MM' || s === 'N/A' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wind/wave intensity rank for coloring (0–4).
 * @param {{wspd: ?number, wvht: ?number}} row
 */
export function ndbcIntensityRank(row) {
  const wspd = row?.wspd;
  const wvht = row?.wvht;
  let rank = 0;
  if (Number.isFinite(wspd)) {
    if (wspd >= 20) rank = Math.max(rank, 4);
    else if (wspd >= 15) rank = Math.max(rank, 3);
    else if (wspd >= 10) rank = Math.max(rank, 2);
    else if (wspd >= 5) rank = Math.max(rank, 1);
  }
  if (Number.isFinite(wvht)) {
    if (wvht >= 4) rank = Math.max(rank, 4);
    else if (wvht >= 2.5) rank = Math.max(rank, 3);
    else if (wvht >= 1.5) rank = Math.max(rank, 2);
    else if (wvht >= 0.5) rank = Math.max(rank, 1);
  }
  return rank;
}

/**
 * CSS color by marine intensity (cyan/teal family).
 * @param {number} rank
 */
export function ndbcIntensityColorCss(rank) {
  switch (Number(rank) || 0) {
    case 4:
      return '#00EEFF';
    case 3:
      return '#22CCEE';
    case 2:
      return '#2AA8C8';
    case 1:
      return '#3A88A8';
    default:
      return '#4A7088';
  }
}

/**
 * Parse one whitespace-separated latest_obs data line.
 * @param {string} line
 * @returns {object|null}
 */
export function parseNdbcObsLine(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(/\s+/);
  // STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
  if (parts.length < 8) return null;
  const station = String(parts[0] || '').trim();
  if (!station) return null;
  const lat = parseNum(parts[1]);
  const lon = parseNum(parts[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Skip placeholder 0,0 (rare invalid)
  if (lat === 0 && lon === 0) return null;

  const year = parseNum(parts[3]);
  const month = parseNum(parts[4]);
  const day = parseNum(parts[5]);
  const hour = parseNum(parts[6]);
  const minute = parseNum(parts[7]);
  const wdir = parseNum(parts[8]);
  const wspd = parseNum(parts[9]);
  const gst = parseNum(parts[10]);
  const wvht = parseNum(parts[11]);
  const dpd = parseNum(parts[12]);
  const apd = parseNum(parts[13]);
  const mwd = parseNum(parts[14]);
  const pres = parseNum(parts[15]);
  const ptdy = parseNum(parts[16]);
  const atmp = parseNum(parts[17]);
  const wtmp = parseNum(parts[18]);
  const dewp = parseNum(parts[19]);
  const vis = parseNum(parts[20]);
  const tide = parseNum(parts[21]);

  // Prefer stations with at least one useful observation field
  const hasObs = [wspd, gst, wvht, atmp, wtmp, pres, tide, dewp, vis].some(
    (v) => Number.isFinite(v),
  );
  if (!hasObs) return null;

  let observedAt = '';
  if (
    Number.isFinite(year) &&
    Number.isFinite(month) &&
    Number.isFinite(day) &&
    Number.isFinite(hour) &&
    Number.isFinite(minute)
  ) {
    observedAt = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  }

  const intensityRank = ndbcIntensityRank({ wspd, wvht });
  return {
    stableId: station,
    station,
    lat,
    lon,
    observedAt,
    wdir,
    wspd,
    gst,
    wvht,
    dpd,
    apd,
    mwd,
    pres,
    ptdy,
    atmp,
    wtmp,
    dewp,
    vis,
    tide,
    intensityRank,
  };
}

/**
 * @param {string|unknown} text NDBC latest_obs.txt body
 * @param {{ maxRows?: number }} [options]
 */
export function normalizeNdbcBuoys(text, options = {}) {
  const maxRows = Math.max(20, Number(options.maxRows) || MAX_ROWS);
  const body = typeof text === 'string' ? text : String(text ?? '');
  /** @type {ReturnType<typeof parseNdbcObsLine>[]} */
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const row = parseNdbcObsLine(line);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => {
    const rank = (b.intensityRank || 0) - (a.intensityRank || 0);
    if (rank) return rank;
    return String(a.station).localeCompare(String(b.station));
  });

  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}
