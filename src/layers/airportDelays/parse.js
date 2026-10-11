/**
 * FAA NAS airport status — normalize airport-status-information XML into
 * compact point rows for the globe (closures, ground stops, delays).
 *
 * U.S. Government work (public domain). Keyless nasstatus.faa.gov XML.
 * Original Bret/GodsEye code — does not copy third-party application source.
 * Situational awareness only — not for flight planning.
 */

export const FAA_AIRPORT_STATUS_URL =
  'https://nasstatus.faa.gov/api/airport-status-information';

export const AWC_AIRPORT_LOOKUP_URL =
  'https://aviationweather.gov/api/data/airport';

/** Hard cap on airports served to the globe. */
export const MAX_AIRPORT_DELAYS = 200;

// `restriction` (a partial closure NOTAM, e.g. "AD AP CLSD TO NON SKED
// TRANSIENT GA" or "CLSD EXC HEL") reuses the existing ground-delay amber —
// no new palette entry.
const KIND_COLORS = Object.freeze({
  closure: '#ff3b3b',
  restriction: '#ffd21a',
  ground_stop: '#ff8c1a',
  ground_delay: '#ffd21a',
  delay: '#38b6ff',
  other: '#d0d0d0',
});

const KIND_RANK = Object.freeze({
  closure: 4,
  ground_stop: 3,
  ground_delay: 2,
  delay: 1,
  restriction: 0.5,
  other: 0,
});

/** Map a Delay_type Name string to a compact kind. */
export function airportDelayKind(delayTypeName) {
  const t = String(delayTypeName || '').toUpperCase();
  if (t.includes('CLOSURE')) return 'closure';
  if (t.includes('GROUND STOP') || t.includes('GROUNDSTOP')) return 'ground_stop';
  if (t.includes('GROUND DELAY') || t.includes('GROUNDDELAY')) return 'ground_delay';
  if (t.includes('DELAY')) return 'delay';
  return 'other';
}

// FAA lists partial-closure NOTAMs under "Airport Closures"; a closure
// whose text carves out traffic ("CLSD TO <class>", "... EXC <class>") is
// a restriction, not a full closure.
const RESTRICTION_RE = /\bCL(?:SD|OSED)\s+TO\b|\bEXC(?:EPT)?\b/i;

/**
 * Refine a Delay_type kind with the NOTAM reason text.
 * @param {string} kind - Result of airportDelayKind().
 * @param {?string} reason - FAA Reason text.
 */
export function refineAirportDelayKind(kind, reason) {
  if (kind === 'closure' && RESTRICTION_RE.test(String(reason || '')))
    return 'restriction';
  return kind;
}

const pad2 = (n) => String(n).padStart(2, '0');

function notamStamp(stamp) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 24 || minute > 59) return null;
  const ms = Date.UTC(2000 + year, month - 1, day, hour, minute);
  const d = new Date(ms);
  // Reject roll-overs such as Feb 31 (2400 is a valid end-of-day stamp).
  if (hour < 24 && d.getUTCDate() !== day) return null;
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Parse the NOTAM effective range at the end of an FAA closure reason,
 * e.g. "2605271826-2705281600" or "2610101339-2610102200EST" or
 * "2601011200-PERM", into full UTC ISO timestamps (with year).
 * @param {?string} reason
 * @returns {{startIso: ?string, endIso: ?string, endEstimated: boolean, permanent: boolean}}
 */
export function parseNotamRange(reason) {
  const empty = {
    startIso: null,
    endIso: null,
    endEstimated: false,
    permanent: false,
  };
  const text = String(reason || '');
  const re = /(?:^|[^\d])(\d{10})-(\d{10}|PERM)(EST)?/g;
  let last = null;
  let m;
  while ((m = re.exec(text))) last = m;
  if (!last) return empty;
  const startIso = notamStamp(last[1]);
  if (!startIso) return empty;
  const permanent = last[2] === 'PERM';
  const endIso = permanent ? null : notamStamp(last[2]);
  if (!permanent && !endIso) return empty;
  if (endIso && endIso < startIso) return empty;
  return { startIso, endIso, endEstimated: Boolean(last[3]), permanent };
}

export function airportDelayColorCss(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.other;
}

export function airportDelayRank(kind) {
  return KIND_RANK[kind] || 0;
}

/**
 * Map a 3-letter US ARPT code to ICAO by prefixing K; leave 4-letter as-is.
 * @param {string} code
 */
export function arptToIcao(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!c) return null;
  if (c.length === 4) return c;
  if (c.length === 3) return `K${c}`;
  return null;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#xd;/gi, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  return decodeXmlEntities(m[1]).trim() || null;
}

/**
 * Parse FAA airport-status-information XML into raw airport records
 * (no coordinates yet).
 * @param {string} xml
 * @returns {{arpt: string, icao: string, reason: ?string, start: ?string, reopen: ?string, end: ?string, delayType: string, kind: string}[]}
 */
export function parseAirportStatusXml(xml) {
  const text = String(xml || '');
  if (!text.includes('<AIRPORT_STATUS_INFORMATION') && !text.includes('<Airport'))
    return [];
  const out = [];
  const delayTypeRe = /<Delay_type>([\s\S]*?)<\/Delay_type>/gi;
  let dtMatch;
  while ((dtMatch = delayTypeRe.exec(text))) {
    const block = dtMatch[1];
    const delayType = tagText(block, 'Name') || 'Unknown';
    const baseKind = airportDelayKind(delayType);
    const airportRe = /<Airport>([\s\S]*?)<\/Airport>/gi;
    let aMatch;
    while ((aMatch = airportRe.exec(block))) {
      const aBlock = aMatch[1];
      const arpt = tagText(aBlock, 'ARPT');
      if (!arpt) continue;
      const icao = arptToIcao(arpt);
      if (!icao) continue;
      const reason = tagText(aBlock, 'Reason');
      out.push({
        arpt: arpt.toUpperCase(),
        icao,
        reason,
        start: tagText(aBlock, 'Start'),
        reopen: tagText(aBlock, 'Reopen'),
        end: tagText(aBlock, 'End'),
        ...parseNotamRange(reason),
        delayType,
        kind: refineAirportDelayKind(baseKind, reason),
      });
    }
  }
  return out;
}

/**
 * Build AWC airport lookup URL for a batch of ICAO ids.
 * @param {string[]} icaos
 */
export function awcAirportLookupUrl(icaos) {
  const ids = [...new Set(icaos.filter(Boolean))].join(',');
  return `${AWC_AIRPORT_LOOKUP_URL}?ids=${encodeURIComponent(ids)}&format=json`;
}

/**
 * Index AWC airport JSON into icao → {lat, lon, name}.
 * @param {unknown} body
 */
export function indexAwcAirports(body) {
  const list = Array.isArray(body) ? body : [];
  /** @type {Map<string, {lat: number, lon: number, name: ?string}>} */
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const icao = String(item.icaoId || item.icao || '')
      .trim()
      .toUpperCase();
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!icao || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    map.set(icao, {
      lat,
      lon,
      name: item.name ? String(item.name).trim().slice(0, 80) : null,
    });
  }
  return map;
}

/**
 * Attach coordinates from an AWC index map; skip rows without coords.
 * @param {ReturnType<typeof parseAirportStatusXml>} records
 * @param {Map<string, {lat: number, lon: number, name: ?string}>} coordByIcao
 */
export function attachAirportCoords(records, coordByIcao) {
  const rows = [];
  const seen = new Set();
  for (const rec of records) {
    const coords = coordByIcao?.get(rec.icao);
    if (!coords) continue;
    const stableId = [
      'ad',
      rec.kind,
      rec.icao,
      (rec.start || '').slice(0, 24),
      (rec.reason || '').slice(0, 24),
    ]
      .join(':')
      .replace(/\s+/g, '_');
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    rows.push({
      stableId,
      arpt: rec.arpt,
      icao: rec.icao,
      kind: rec.kind,
      delayType: rec.delayType,
      reason: rec.reason ? rec.reason.slice(0, 400) : null,
      start: rec.start,
      reopen: rec.reopen,
      end: rec.end,
      startIso: rec.startIso ?? null,
      endIso: rec.endIso ?? null,
      endEstimated: Boolean(rec.endEstimated),
      permanent: Boolean(rec.permanent),
      name: coords.name,
      lat: coords.lat,
      lon: coords.lon,
    });
  }
  rows.sort(
    (a, b) =>
      airportDelayRank(b.kind) - airportDelayRank(a.kind) ||
      a.icao.localeCompare(b.icao),
  );
  return rows;
}

/**
 * Full normalize: XML + optional pre-resolved coord map.
 * @param {string} xml
 * @param {Map<string, {lat: number, lon: number, name: ?string}>} [coordByIcao]
 */
export function normalizeAirportDelays(
  xml,
  coordByIcao = new Map(),
  { limit = MAX_AIRPORT_DELAYS } = {},
) {
  const records = parseAirportStatusXml(xml);
  return attachAirportCoords(records, coordByIcao).slice(0, limit);
}

export function countAirportDelayKinds(rows) {
  const out = {};
  for (const row of rows) out[row.kind] = (out[row.kind] || 0) + 1;
  return out;
}
