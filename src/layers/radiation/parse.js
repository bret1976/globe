/**
 * Normalize Safecast citizen radiation measurements into globe rows.
 *
 * Feed: https://api.safecast.org/measurements.json (CC0 public data, no key)
 * Original Bret/GodsEye code — inspired by open globes that expose Safecast,
 * but does not copy third-party application source.
 *
 * Recent measurements are spatially max-pooled so the client paints hundreds
 * of discs instead of thousands of near-duplicate points.
 */

export const SAFECAST_MEASUREMENTS_URL =
  'https://api.safecast.org/measurements.json';

/** Look-back window for captured_after queries. */
export const LOOKBACK_MS = 6 * 60 * 60_000;

/** Page size when paging Safecast. */
export const PAGE_SIZE = 1000;

/** Max pages fetched per refresh (Safecast caps ~1000/page). */
export const MAX_PAGES = 8;

/** Spatial bin size in degrees (max-pool by CPM). */
export const BIN_DEG = 0.25;

/** Hard cap on returned rows. */
export const MAX_ROWS = 2000;

/**
 * CSS color for a CPM reading (Safecast pancake GM typical background ~10–60).
 * @param {number} cpm
 */
export function radiationColorCss(cpm) {
  const v = Number(cpm) || 0;
  if (v >= 150) return '#FF2244';
  if (v >= 80) return '#FF8800';
  if (v >= 40) return '#CCCC33';
  return '#44AA66';
}

/**
 * Band label for overlays / properties.
 * @param {number} cpm
 */
export function radiationBand(cpm) {
  const v = Number(cpm) || 0;
  if (v >= 150) return 'hot';
  if (v >= 80) return 'high';
  if (v >= 40) return 'elevated';
  return 'normal';
}

/**
 * @param {unknown} payload Safecast measurements array (one or more pages merged)
 * @param {{
 *   binDeg?: number,
 *   maxRows?: number,
 * }} [options]
 * @returns {{
 *   rawCount: number,
 *   binDeg: number,
 *   rows: Array<{
 *     stableId: string,
 *     lat: number,
 *     lon: number,
 *     cpm: number,
 *     unit: string,
 *     band: string,
 *     capturedAt: string,
 *   }>,
 * }}
 */
export function normalizeSafecastMeasurements(payload, options = {}) {
  const binDeg = Math.max(0.1, Number(options.binDeg) || BIN_DEG);
  const maxRows = Math.max(50, Number(options.maxRows) || MAX_ROWS);
  const empty = { rawCount: 0, binDeg, rows: [] };

  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.measurements)
      ? payload.measurements
      : null;
  if (!list) return empty;

  /** @type {Map<string, {lat: number, lon: number, cpm: number, unit: string, capturedAt: string, id: string}>} */
  const bins = new Map();
  let rawCount = 0;

  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  const lookbackMs = Math.max(
    60_000,
    Number(options.lookbackMs) || LOOKBACK_MS,
  );
  const earliest = nowMs - lookbackMs - 60 * 60_000;
  const latest = nowMs + 60 * 60_000;

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const lat = Number(item.latitude ?? item.lat);
    const lon = Number(item.longitude ?? item.lon ?? item.lng);
    const cpm = Number(item.value ?? item.cpm);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(cpm))
      continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (cpm < 0) continue;
    const capturedAt = String(item.captured_at || item.capturedAt || '').trim();
    if (capturedAt) {
      const ts = Date.parse(capturedAt);
      // Safecast occasionally returns far-future junk timestamps — drop them.
      if (Number.isFinite(ts) && (ts < earliest || ts > latest)) continue;
    }
    rawCount += 1;

    const latBin = Math.floor(lat / binDeg) * binDeg;
    const lonBin = Math.floor(lon / binDeg) * binDeg;
    const key = `${lonBin.toFixed(4)}:${latBin.toFixed(4)}`;
    const centerLat = latBin + binDeg / 2;
    const centerLon = lonBin + binDeg / 2;
    if (centerLat < -90 || centerLat > 90) continue;

    const unit = String(item.unit || 'cpm').trim() || 'cpm';
    const id = String(item.id || '').trim();
    const prev = bins.get(key);
    if (!prev || cpm > prev.cpm) {
      bins.set(key, {
        lat: centerLat,
        lon: centerLon,
        cpm,
        unit,
        capturedAt,
        id,
      });
    }
  }

  let rows = [...bins.values()]
    .map((cell) => ({
      stableId:
        cell.id ||
        `${cell.lon.toFixed(3)}:${cell.lat.toFixed(3)}:${cell.cpm.toFixed(1)}`,
      lat: cell.lat,
      lon: cell.lon,
      cpm: cell.cpm,
      unit: cell.unit,
      band: radiationBand(cell.cpm),
      capturedAt: cell.capturedAt,
    }))
    .sort((a, b) => b.cpm - a.cpm || a.lat - b.lat);

  if (rows.length > maxRows) rows = rows.slice(0, maxRows);

  return { rawCount, binDeg, rows };
}
