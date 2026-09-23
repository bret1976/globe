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
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function normalizeNhc(payload) {
  const storms = [];
  for (const raw of payload?.activeStorms || []) {
    const id = text(raw?.id, 16)?.toLowerCase();
    const name = text(raw?.name || raw?.id, 40);
    const lon = number(raw?.longitude ?? raw?.lon, -180, 180);
    const lat = number(raw?.latitude ?? raw?.lat, -90, 90);
    if (!id || !name || lon == null || lat == null) continue;
    storms.push({
      id: `nhc:${id}`,
      name,
      basin: text(raw?.basin, 8) || id.slice(0, 2).toUpperCase(),
      classification: text(raw?.classification, 8) || 'TC',
      windKt: number(raw?.intensity ?? raw?.windSpeed, 0, 250),
      lon,
      lat,
      movement: text(raw?.movement, 40),
      advisory: text(raw?.advNum || raw?.advisory, 8),
      link: typeof raw?.url === 'string' ? raw.url : null,
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
    const duplicate = storms.some(
      (existing) =>
        Math.abs(existing.lon - storm.lon) < 1.5 &&
        Math.abs(existing.lat - storm.lat) < 1.5,
    );
    if (!duplicate) storms.push(storm);
  }
  return { fetchedAt: Date.now(), storms };
}

/** Fetch NHC + EONET cyclone context. */
export function createCycloneSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/cyclones',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(endpoint, { signal });
        if (response.ok) {
          const payload = await response.json();
          if (Array.isArray(payload?.storms)) return payload;
        }
      } catch {
        /* fall through to browser-direct */
      }
      const [nhcRes, eonetRes] = await Promise.allSettled([
        fetchImpl(NHC_URL, { signal }),
        fetchImpl(EONET_URL, { signal }),
      ]);
      const nhc =
        nhcRes.status === 'fulfilled' && nhcRes.value.ok
          ? await nhcRes.value.json()
          : { activeStorms: [] };
      const eonet =
        eonetRes.status === 'fulfilled' && eonetRes.value.ok
          ? await eonetRes.value.json()
          : { events: [] };
      return mergeCycloneSnapshots(nhc, eonet);
    },
  };
}

export { NHC_URL, EONET_URL, normalizeNhc, normalizeEonet };
