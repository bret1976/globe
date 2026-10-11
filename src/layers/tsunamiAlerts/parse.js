/**
 * NOAA/NWS tsunami.gov Atom feeds (NTWC PAAQ + PTWC PHEB) → globe rows.
 *
 * Public US government work (public domain). Keyless geo Atom with
 * geo:lat / geo:long on each entry. Original Bret/GodsEye code — does not
 * copy third-party application source.
 */

export const TSUNAMI_PAAQ_ATOM_URL =
  'https://www.tsunami.gov/events/xml/PAAQAtom.xml';
export const TSUNAMI_PHEB_ATOM_URL =
  'https://www.tsunami.gov/events/xml/PHEBAtom.xml';

export const TSUNAMI_FEED_URLS = Object.freeze([
  Object.freeze({ center: 'PAAQ', url: TSUNAMI_PAAQ_ATOM_URL }),
  Object.freeze({ center: 'PHEB', url: TSUNAMI_PHEB_ATOM_URL }),
]);

const MAX_ROWS = 80;

const CATEGORY_RANK = Object.freeze({
  Warning: 4,
  Advisory: 3,
  Watch: 2,
  Information: 1,
  Unknown: 0,
});

/** CSS color by tsunami bulletin category. */
export function tsunamiCategoryColorCss(category) {
  switch (String(category || '')) {
    case 'Warning':
      return '#FF1144';
    case 'Advisory':
      return '#FF6600';
    case 'Watch':
      return '#EECC22';
    case 'Information':
      return '#44AADD';
    default:
      return '#8899AA';
  }
}

/** @param {unknown} value */
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the first capture group from Atom/HTML text.
 * @param {string} text
 * @param {RegExp} re
 */
function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? String(m[1] || '').trim() : '';
}

/**
 * Normalize Category text from the summary block.
 * @param {string} raw
 */
export function normalizeTsunamiCategory(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'Unknown';
  const lower = text.toLowerCase();
  if (lower.includes('warning')) return 'Warning';
  if (lower.includes('advisory')) return 'Advisory';
  if (lower.includes('watch')) return 'Watch';
  if (lower.includes('information') || lower.includes('info'))
    return 'Information';
  return 'Unknown';
}

/**
 * Parse one <entry>…</entry> chunk into a globe row, or null.
 * @param {string} entryXml
 * @param {{center?: string}} [meta]
 */
export function parseTsunamiEntry(entryXml, meta = {}) {
  const xml = String(entryXml || '');
  if (!xml.includes('<')) return null;
  const lat = parseNum(firstMatch(xml, /<geo:lat>\s*([^<]+)\s*<\/geo:lat>/i));
  const lon = parseNum(
    firstMatch(xml, /<geo:long>\s*([^<]+)\s*<\/geo:long>/i) ||
      firstMatch(xml, /<geo:lon>\s*([^<]+)\s*<\/geo:lon>/i),
  );
  if (lat == null || lon == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const title = firstMatch(xml, /<title(?:\s[^>]*)?>([^<]*)<\/title>/i);
  const updated = firstMatch(xml, /<updated>([^<]+)<\/updated>/i);
  const id = firstMatch(xml, /<id>([^<]+)<\/id>/i);
  const summary = firstMatch(
    xml,
    /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i,
  );
  const category = normalizeTsunamiCategory(
    firstMatch(summary, /Category:\s*<\/strong>\s*([^<\n]+)/i) ||
      firstMatch(summary, /Category:\s*([^<\n]+)/i),
  );
  const magnitudeRaw =
    firstMatch(
      summary,
      /Preliminary Magnitude:\s*<\/strong>\s*([^<\n]+)/i,
    ) || firstMatch(summary, /Preliminary Magnitude:\s*([^<\n]+)/i);
  const magnitude = parseNum(
    firstMatch(magnitudeRaw, /(-?\d+(?:\.\d+)?)/),
  );
  const region =
    firstMatch(
      summary,
      /Affected Region:\s*<\/strong>\s*([^<\n]+)/i,
    ) ||
    firstMatch(summary, /Affected Region:\s*([^<\n]+)/i) ||
    title ||
    'Tsunami bulletin';
  const bulletinHref = firstMatch(
    xml,
    /href="(https:\/\/www\.tsunami\.gov\/[^"]+\.txt)"/i,
  );
  const t = Date.parse(updated);
  const issuedAt = Number.isFinite(t)
    ? new Date(t).toISOString()
    : new Date(0).toISOString();
  const center = String(meta.center || 'TSUNAMI').toUpperCase();
  const stableId =
    id ||
    `tsu-${center}-${issuedAt}-${lat.toFixed(3)}-${lon.toFixed(3)}`;

  return {
    stableId,
    center,
    title: title || region,
    region: region.trim().slice(0, 160),
    category,
    categoryRank: CATEGORY_RANK[category] ?? 0,
    magnitude,
    magnitudeRaw: magnitudeRaw ? magnitudeRaw.trim().slice(0, 40) : null,
    issuedAt,
    lat,
    lon,
    link: bulletinHref || 'https://www.tsunami.gov/',
  };
}

/**
 * Normalize one Atom document into rows for a center.
 * @param {string} atomXml
 * @param {{center?: string, maxRows?: number}} [options]
 */
export function normalizeTsunamiAtom(atomXml, options = {}) {
  const center = String(options.center || 'TSUNAMI').toUpperCase();
  const maxRows = Math.max(5, Number(options.maxRows) || MAX_ROWS);
  const xml = String(atomXml || '');
  const chunks = xml.split(/<entry[\s>]/i).slice(1);
  const rows = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const end = chunk.indexOf('</entry>');
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    const row = parseTsunamiEntry(body, { center });
    if (!row) continue;
    if (seen.has(row.stableId)) continue;
    seen.add(row.stableId);
    rows.push(row);
  }
  rows.sort((a, b) => {
    const rank = (b.categoryRank || 0) - (a.categoryRank || 0);
    if (rank) return rank;
    return String(b.issuedAt).localeCompare(String(a.issuedAt));
  });
  return rows.slice(0, maxRows);
}

/**
 * Merge PAAQ + PHEB row lists; prefer higher category, then newer issue time.
 * @param {Array<object>} lists
 * @param {{maxRows?: number}} [options]
 */
export function mergeTsunamiRows(lists, options = {}) {
  const maxRows = Math.max(5, Number(options.maxRows) || MAX_ROWS);
  const byKey = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || !Number.isFinite(row.lat) || !Number.isFinite(row.lon))
        continue;
      // Dedupe near-identical epicenters from both centers within ~0.15°.
      const key = `${row.lat.toFixed(1)}:${row.lon.toFixed(1)}:${String(row.issuedAt || '').slice(0, 13)}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, row);
        continue;
      }
      const better =
        (row.categoryRank || 0) > (prev.categoryRank || 0) ||
        ((row.categoryRank || 0) === (prev.categoryRank || 0) &&
          String(row.issuedAt) > String(prev.issuedAt));
      if (better) byKey.set(key, row);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => {
      const rank = (b.categoryRank || 0) - (a.categoryRank || 0);
      if (rank) return rank;
      return String(b.issuedAt).localeCompare(String(a.issuedAt));
    })
    .slice(0, maxRows);
}
