/**
 * Normalize NOAA SWPC OVATION aurora grid into downsampled globe rows.
 *
 * Feed: https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
 * Public US government open data (no key). Original Bret/GodsEye code —
 * does not copy third-party AGPL consumers of the same feed.
 *
 * Raw grid is ~65k cells (1° lon × 1° lat). We max-pool into BIN_DEG° bins
 * keeping only aurora >= MIN_AURORA so the client paints a few thousand
 * discs instead of tens of thousands of entities.
 */

export const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/** Minimum raw aurora value kept before binning. */
export const MIN_AURORA = 2;

/** Spatial bin size in degrees (max-pool). */
export const BIN_DEG = 2;

/** Hard cap on returned rows (raise threshold if still over). */
export const MAX_ROWS = 2500;

/**
 * Convert SWPC longitude (0..360) to standard lon (-180..180).
 * @param {number} lon
 */
export function normalizeLon(lon) {
  let x = Number(lon);
  if (!Number.isFinite(x)) return NaN;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * CSS color for an aurora intensity (OVATION units, typically 0–100).
 * @param {number} aurora
 */
export function auroraColorCss(aurora) {
  const a = Number(aurora) || 0;
  if (a >= 15) return '#FF66FF';
  if (a >= 10) return '#66FFCC';
  if (a >= 5) return '#33FF88';
  return '#22AA66';
}

/**
 * Band label for overlays / properties.
 * @param {number} aurora
 */
export function auroraBand(aurora) {
  const a = Number(aurora) || 0;
  if (a >= 15) return 'intense';
  if (a >= 10) return 'strong';
  if (a >= 5) return 'moderate';
  return 'weak';
}

/**
 * @param {unknown} payload NOAA OVATION JSON
 * @param {{
 *   minAurora?: number,
 *   binDeg?: number,
 *   maxRows?: number,
 * }} [options]
 * @returns {{
 *   observationTime: string,
 *   forecastTime: string,
 *   rawCount: number,
 *   keptBeforeCap: number,
 *   minAuroraUsed: number,
 *   binDeg: number,
 *   rows: Array<{
 *     stableId: string,
 *     lat: number,
 *     lon: number,
 *     aurora: number,
 *     band: string,
 *   }>,
 * }}
 */
export function normalizeOvationAurora(payload, options = {}) {
  const binDeg = Math.max(1, Number(options.binDeg) || BIN_DEG);
  let minAurora = Math.max(0, Number(options.minAurora) || MIN_AURORA);
  const maxRows = Math.max(100, Number(options.maxRows) || MAX_ROWS);

  const empty = {
    observationTime: '',
    forecastTime: '',
    rawCount: 0,
    keptBeforeCap: 0,
    minAuroraUsed: minAurora,
    binDeg,
    rows: [],
  };

  if (!payload || typeof payload !== 'object') return empty;
  const coordinates = payload.coordinates;
  if (!Array.isArray(coordinates)) return empty;

  const observationTime = String(payload['Observation Time'] || '').trim();
  const forecastTime = String(payload['Forecast Time'] || '').trim();
  const rawCount = coordinates.length;

  /** @type {Map<string, {lat: number, lon: number, aurora: number}>} */
  function pool(threshold) {
    const bins = new Map();
    for (const cell of coordinates) {
      if (!Array.isArray(cell) || cell.length < 3) continue;
      const lonRaw = Number(cell[0]);
      const lat = Number(cell[1]);
      const aurora = Number(cell[2]);
      if (!Number.isFinite(lonRaw) || !Number.isFinite(lat) || !Number.isFinite(aurora))
        continue;
      if (aurora < threshold) continue;
      if (lat < -90 || lat > 90) continue;
      const lon = normalizeLon(lonRaw);
      if (!Number.isFinite(lon)) continue;
      // Bin in 0..360 space then re-normalize center for stable keys near antimeridian.
      const lon360 = ((lonRaw % 360) + 360) % 360;
      const lonBin = Math.floor(lon360 / binDeg) * binDeg;
      const latBin = Math.floor(lat / binDeg) * binDeg;
      const key = `${lonBin}:${latBin}`;
      const centerLon = normalizeLon(lonBin + binDeg / 2);
      const centerLat = latBin + binDeg / 2;
      if (centerLat < -90 || centerLat > 90) continue;
      const prev = bins.get(key);
      if (!prev || aurora > prev.aurora) {
        bins.set(key, { lat: centerLat, lon: centerLon, aurora });
      }
    }
    return bins;
  }

  let bins = pool(minAurora);
  // If still too dense, raise the intensity floor until under the cap.
  while (bins.size > maxRows && minAurora < 50) {
    minAurora += 1;
    bins = pool(minAurora);
  }

  const rows = [...bins.values()]
    .map((cell) => ({
      stableId: `${cell.lon.toFixed(2)}:${cell.lat.toFixed(2)}`,
      lat: cell.lat,
      lon: cell.lon,
      aurora: cell.aurora,
      band: auroraBand(cell.aurora),
    }))
    .sort((a, b) => b.aurora - a.aurora || a.lat - b.lat);

  return {
    observationTime,
    forecastTime,
    rawCount,
    keptBeforeCap: rows.length,
    minAuroraUsed: minAurora,
    binDeg,
    rows,
  };
}
