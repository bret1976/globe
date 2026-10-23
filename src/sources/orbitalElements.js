import { json2satrec, twoline2satrec } from 'satellite.js';

/**
 * Orbital element sets for SGP4. CelesTrak serves catalog numbers above
 * 99999 (assigned since mid-2026) only as OMM JSON, so the satellite proxy
 * now forwards OMM; TLE text stays accepted for caches written before the
 * switch and for the TLE-only fallback sources. Adapted from upstream
 * gods-eye-view #1191 (Marco Scheffler, MIT).
 */

function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 '))
      result.push({ name, line1, line2 });
  }
  return result;
}

/**
 * Parse a GP catalog into `{ name, omm }` or `{ name, line1, line2 }`
 * entries. A JSON array holds OMM records; an item carrying `TLE_LINE1` /
 * `TLE_LINE2` (written when a fallback source refreshed a five-digit object)
 * becomes a TLE entry. Records without a catalog number or epoch are skipped
 * without dropping the ones that follow.
 */
export function parseOrbitalElements(text) {
  const body = String(text ?? '').trim();
  if (!body.startsWith('[')) return parseTleText(body);
  let records;
  try {
    records = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    if (!record || typeof record !== 'object') return [];
    const name = String(record.OBJECT_NAME ?? '').trim();
    if (
      typeof record.TLE_LINE1 === 'string' &&
      typeof record.TLE_LINE2 === 'string' &&
      record.TLE_LINE1.startsWith('1 ') &&
      record.TLE_LINE2.startsWith('2 ')
    )
      return [{ name, line1: record.TLE_LINE1, line2: record.TLE_LINE2 }];
    return Number.isSafeInteger(record.NORAD_CAT_ID) &&
      typeof record.EPOCH === 'string'
      ? [{ name, omm: record }]
      : [];
  });
}

/** The SGP4 record for a parsed entry; callers check `satrec.error`. */
export function satrecFromElements(entry) {
  try {
    return entry.omm
      ? json2satrec(entry.omm)
      : twoline2satrec(entry.line1, entry.line2);
  } catch {
    return null; // malformed record: skip it, keep the rest of the catalog
  }
}

/** The NORAD catalog number of a parsed entry, or null. */
export function elementsCatalogNumber(entry) {
  if (entry.omm) return entry.omm.NORAD_CAT_ID;
  const id = Number(String(entry.line1 || '').slice(2, 7));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The launch year from a parsed entry's international designator, or null. */
export function elementsLaunchYear(entry) {
  if (entry.omm) {
    const match = /^(\d{4})-/.exec(String(entry.omm.OBJECT_ID ?? ''));
    return match ? Number(match[1]) : null;
  }
  const field = String(entry.line1 || '').slice(9, 11);
  if (!/^\d{2}$/.test(field)) return null;
  const shortYear = Number(field);
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}
