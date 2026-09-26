/**
 * Parse gpsjam.org daily H3 CSV into interference hex rows.
 *
 * Source formula (gpsjam.org/faq): percent_bad =
 *   100 * (num_bad_aircraft - 1) / (num_good_aircraft + num_bad_aircraft)
 * Levels: low <2%, medium 2–10%, high >10%.
 *
 * This module is original Bret/GodsEye code. It does not copy AGPL projects
 * that also consume gpsjam.org; it only reads the public CSV schema.
 */

export const GPSJAM_MIN_AIRCRAFT = 3;
export const GPSJAM_LEVEL_MEDIUM = 'medium';
export const GPSJAM_LEVEL_HIGH = 'high';

/**
 * @param {string} csv
 * @param {{ minAircraft?: number, includeLow?: boolean }} [options]
 * @returns {{ rows: Array<{h3:string,good:number,bad:number,total:number,pct:number,level:string}>, totalRows: number, skippedLowSample: number, skippedLow: number }}
 */
export function parseGpsjamCsv(csv, options = {}) {
  const minAircraft =
    Number.isFinite(options.minAircraft) && options.minAircraft > 0
      ? options.minAircraft
      : GPSJAM_MIN_AIRCRAFT;
  const includeLow = options.includeLow === true;
  const text = String(csv || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) {
    return { rows: [], totalRows: 0, skippedLowSample: 0, skippedLow: 0 };
  }
  const header = lines[0].toLowerCase();
  if (!header.includes('hex') || !header.includes('bad')) {
    throw new Error(`Unexpected gpsjam CSV header: ${lines[0].slice(0, 80)}`);
  }

  const rows = [];
  let skippedLowSample = 0;
  let skippedLow = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 3) continue;
    const h3 = String(parts[0] || '').trim().toLowerCase();
    const good = Number(parts[1]);
    const bad = Number(parts[2]);
    if (!/^[0-9a-f]+$/.test(h3)) continue;
    if (!Number.isFinite(good) || !Number.isFinite(bad) || good < 0 || bad < 0)
      continue;
    const total = good + bad;
    if (total < minAircraft) {
      skippedLowSample++;
      continue;
    }
    // Match gpsjam.org FAQ denoising: subtract 1 from bad before percent.
    const pctRaw = (100 * Math.max(0, bad - 1)) / total;
    const pct = Math.round(pctRaw * 10) / 10;
    let level;
    if (pctRaw > 10) level = GPSJAM_LEVEL_HIGH;
    else if (pctRaw >= 2) level = GPSJAM_LEVEL_MEDIUM;
    else {
      skippedLow++;
      if (!includeLow) continue;
      level = 'low';
    }
    rows.push({ h3, good, bad, total, pct, level });
  }
  return {
    rows,
    totalRows: Math.max(0, lines.length - 1),
    skippedLowSample,
    skippedLow,
  };
}

/**
 * Pick the newest YYYY-MM-DD from a gpsjam manifest.csv body.
 * @param {string} manifestCsv
 * @returns {string|null}
 */
export function latestGpsjamDate(manifestCsv) {
  const text = String(manifestCsv || '').replace(/^\uFEFF/, '');
  let latest = null;
  for (const line of text.split(/\r?\n/)) {
    const date = String(line.split(',')[0] || '')
      .trim()
      .replace(/[^0-9-]/g, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}
