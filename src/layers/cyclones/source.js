/**
 * Cyclone snapshot: NOAA NHC current storms (Atlantic / E+C Pacific) plus
 * NASA EONET severe-storm events so Western Pacific typhoons appear for
 * Bret's Shorts pack. Fetched through `/api/cyclones` when hosted.
 */
const NHC_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const EONET_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open&limit=40';

function text(value, max = 80) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function number(value, min, max) {
  // Number(null) and Number('') are 0; a missing field is not a zero.
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// NHC CurrentStorms.json writes positions as hemisphere strings ("12.4N",
// "102.8W") and puts the decimals in latitudeNumeric / longitudeNumeric, so a
// plain Number() of `latitude` drops every NHC storm. Read the numeric fields
// first, then a plain number, then the hemisphere string.
function coordinate(numeric, raw, positive, negative, limit) {
  const direct = number(numeric, -limit, limit);
  if (direct != null) return direct;
  if (typeof raw === 'number') return number(raw, -limit, limit);
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z])?$/);
  if (!match) return null;
  const value = Number(match[1]);
  const hemisphere = match[2]?.toUpperCase();
  if (hemisphere && hemisphere !== positive && hemisphere !== negative)
    return null;
  return number(
    hemisphere === negative ? -Math.abs(value) : value,
    -limit,
    limit,
  );
}

// NHC Tropical Cyclone Status JSON classification codes (PTC is
// post-tropical, PC a potential tropical cyclone; subtropical systems are STS
// and STD). Meanings follow upstream gods-eye-view #1349 (rudycelekli, MIT).
const NHC_CLASSIFICATIONS = {
  TD: 'Tropical depression',
  TS: 'Tropical storm',
  HU: 'Hurricane',
  MH: 'Major hurricane',
  TY: 'Typhoon',
  STD: 'Subtropical depression',
  STS: 'Subtropical storm',
  PTC: 'Post-tropical cyclone',
  PC: 'Potential tropical cyclone',
  TC: 'Tropical cyclone',
};

export function classificationLabel(code) {
  return NHC_CLASSIFICATIONS[String(code || '').toUpperCase()] || null;
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

// CurrentStorms.json gives movementSpeed in miles per hour while intensity is
// in knots (upstream gods-eye-view #1350, rudycelekli, MIT); report knots.
function nhcMovement(raw) {
  const legacy = text(raw?.movement, 40);
  const direction = number(raw?.movementDir, 0, 360);
  const mph = number(raw?.movementSpeed, 0, 200);
  const speedKt = mph == null ? null : Math.round(mph * 0.868976);
  if (direction == null && speedKt == null)
    return { movement: legacy, movementDir: null, movementSpeedKt: null };
  const parts = [];
  if (direction != null && speedKt !== 0)
    parts.push(COMPASS[Math.round(direction / 22.5) % 16]);
  if (speedKt != null)
    parts.push(speedKt === 0 ? 'stationary' : `${speedKt} kt`);
  return {
    movement: parts.join(' at '),
    movementDir: direction,
    movementSpeedKt: speedKt,
  };
}

function nhcLink(raw) {
  for (const value of [raw?.publicAdvisory?.url, raw?.url]) {
    if (
      typeof value === 'string' &&
      /^https:\/\/www\.nhc\.noaa\.gov\//.test(value)
    )
      return value;
  }
  return 'https://www.nhc.noaa.gov/';
}

function normalizeNhc(payload) {
  const storms = [];
  for (const raw of payload?.activeStorms || []) {
    const id = text(raw?.id, 16)?.toLowerCase();
    const name = text(raw?.name || raw?.id, 40);
    const lon = coordinate(
      raw?.longitudeNumeric,
      raw?.longitude ?? raw?.lon,
      'E',
      'W',
      180,
    );
    const lat = coordinate(
      raw?.latitudeNumeric,
      raw?.latitude ?? raw?.lat,
      'N',
      'S',
      90,
    );
    if (!id || !name || lon == null || lat == null) continue;
    const classification = text(raw?.classification, 8)?.toUpperCase() || 'TC';
    storms.push({
      id: `nhc:${id}`,
      name,
      basin: text(raw?.basin, 8) || id.slice(0, 2).toUpperCase(),
      classification,
      classificationLabel: classificationLabel(classification),
      windKt: number(raw?.intensity ?? raw?.windSpeed, 0, 250),
      pressureMb: number(raw?.pressure, 850, 1100),
      lon,
      lat,
      ...nhcMovement(raw),
      advisory: text(
        raw?.publicAdvisory?.advNum || raw?.advNum || raw?.advisory,
        8,
      ),
      updatedAt: text(raw?.lastUpdate || raw?.publicAdvisory?.issuance, 40),
      link: nhcLink(raw),
      source: 'NHC',
    });
  }
  return storms;
}

function normalizeEonet(payload) {
  const storms = [];
  for (const event of payload?.events || []) {
    const id = text(event?.id, 40);
    const name = text(event?.title, 80);
    const geometry = event?.geometry;
    const last = Array.isArray(geometry) ? geometry[geometry.length - 1] : null;
    const coords = last?.coordinates;
    const lon = number(coords?.[0], -180, 180);
    const lat = number(coords?.[1], -90, 90);
    if (!id || !name || lon == null || lat == null) continue;
    const already = storms.some(
      (storm) =>
        Math.abs(storm.lon - lon) < 1.2 && Math.abs(storm.lat - lat) < 1.2,
    );
    if (already) continue;
    storms.push({
      id: `eonet:${id}`,
      name,
      basin: 'GLOBAL',
      classification: 'TC',
      windKt: null,
      lon,
      lat,
      movement: null,
      advisory: null,
      link: event?.sources?.[0]?.url || event?.link || null,
      source: 'EONET',
      track: Array.isArray(geometry)
        ? geometry
            .map((point) => ({
              lon: number(point?.coordinates?.[0], -180, 180),
              lat: number(point?.coordinates?.[1], -90, 90),
            }))
            .filter((point) => point.lon != null && point.lat != null)
        : [],
    });
  }
  return storms;
}

export function mergeCycloneSnapshots(nhc, eonet) {
  const storms = [...normalizeNhc(nhc)];
  for (const storm of normalizeEonet(eonet)) {
    const duplicate = storms.find(
      (existing) =>
        Math.abs(existing.lon - storm.lon) < 1.5 &&
        Math.abs(existing.lat - storm.lat) < 1.5,
    );
    if (!duplicate) {
      storms.push(storm);
      continue;
    }
    // NHC has no past positions; keep EONET's track behind the NHC storm,
    // ending at NHC's (newer) advisory position.
    if (
      duplicate.source === 'NHC' &&
      !duplicate.track &&
      Array.isArray(storm.track) &&
      storm.track.length >= 1
    ) {
      duplicate.track = [
        ...storm.track,
        { lon: duplicate.lon, lat: duplicate.lat },
      ];
    }
  }
  return { fetchedAt: Date.now(), storms };
}

/** Fetch NHC + EONET cyclone context. */
export function createCycloneSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/cyclones',
} = {}) {
  async function direct(signal) {
    const [nhcRes, eonetRes] = await Promise.allSettled([
      fetchImpl(NHC_URL, { signal }),
      fetchImpl(EONET_URL, { signal }),
    ]);
    const read = async (settled, empty) => {
      if (settled.status !== 'fulfilled' || !settled.value.ok) return empty;
      try {
        return await settled.value.json();
      } catch {
        return empty;
      }
    };
    const nhc = await read(nhcRes, { activeStorms: [] });
    const eonet = await read(eonetRes, { events: [] });
    return { ...mergeCycloneSnapshots(nhc, eonet), browserDirect: true };
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      let proxied = null;
      try {
        const response = await fetchImpl(endpoint, { signal });
        if (response.ok) {
          const payload = await response.json();
          if (Array.isArray(payload?.storms)) proxied = payload;
        }
      } catch {
        /* fall through to browser-direct */
      }
      signal?.throwIfAborted();
      const feeds = proxied?.feeds;
      const degraded =
        !proxied ||
        (feeds && Object.values(feeds).some((state) => state === 'down'));
      if (!degraded) return proxied;
      // The server couldn't reach a feed (EONET answers CORS from browsers),
      // so ask directly and keep whichever answer has more storms.
      const browser = await direct(signal).catch(() => null);
      if (!proxied) return browser || mergeCycloneSnapshots({}, {});
      if (browser && browser.storms.length > proxied.storms.length)
        return browser;
      return proxied;
    },
  };
}

export { NHC_URL, EONET_URL, normalizeNhc, normalizeEonet };
