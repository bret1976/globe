import {
  DEFAULT_VEGAGERDIN_CCTV_URL,
  VEGAGERDIN_IMAGE_ORIGIN,
  DEFAULT_VEGAGERDIN_MAX_SOURCES,
  VEGAGERDIN_MAX_CATALOG_BYTES,
  ICELAND_ANCHORS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
  isPlausibleLatLon,
  cameraDisplayCode,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';

/** Network-level failure worth one more try (reset, refused, DNS, TLS), as
 * opposed to an HTTP answer or a timeout, which are final for this refresh. */
function isRetryableNetworkError(error) {
  return error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message));
}

/** "fetch failed (ECONNRESET: socket hang up)" — undici hides the cause. */
export function describeFetchError(error) {
  const cause = error?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
  return detail ? `${error?.message || error} (${detail})` : String(error?.message || error);
}

/**
 * Catalog GET with one retry after a short pause on a network-level failure:
 * a fresh container's first connections to some hosts are reset.
 */
async function fetchCatalogWithRetry(endpoint, { attempts = 3, pauseMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(endpoint, {
        headers: { Accept: 'application/json', 'User-Agent': CATALOG_USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) throw error;
      console.warn(
        '[CCTV] Vegagerðin catalog fetch retry', attempt, describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** Iceland and its near-shore islands (Vestmannaeyjar, Grímsey). */
export function isLikelyIcelandCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 63.2 &&
    lat <= 66.7 &&
    lon >= -24.7 &&
    lon <= -13.2
  );
}

/**
 * Pin one Vegagerðin still to the agency's camera folder: exactly
 * `https://www.vegagerdin.is/vgdata/vefmyndavelar/<name>.jpg`.
 *
 * @param {unknown} raw
 * @returns {?{href: string, name: string}}
 */
export function normalizeVegagerdinImageUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port)
    return null;
  parsed.protocol = 'https:';
  const href = parsed.toString();
  if (!href.startsWith(VEGAGERDIN_IMAGE_ORIGIN)) return null;
  const name = href.slice(VEGAGERDIN_IMAGE_ORIGIN.length);
  const match = /^([A-Za-z0-9_-]{1,60})\.jpe?g$/i.exec(name);
  if (!match) return null;
  return { href, name: match[1] };
}

/**
 * One gagnaveita record (one image of one station) -> one catalog source.
 * `Skyring` says which way the image looks ("Hellisheiði séð til vesturs" =
 * looking west); it goes into the name, and the heading uses the id-hash
 * fallback at low confidence like the other packs without bearings.
 *
 * @param {object} record
 * @returns {?object}
 */
export function vegagerdinCameraToSource(record) {
  if (!record || typeof record !== 'object') return null;
  const lat = toFiniteNumber(record.Breidd);
  const lon = toFiniteNumber(record.Lengd);
  if (!isLikelyIcelandCoordinate(lat, lon)) return null;
  const image = normalizeVegagerdinImageUrl(record.Slod);
  if (!image) return null;
  const cameraId = `is-vegagerdin-${image.name.toLowerCase()}`;
  const station = String(record.Myndavel ?? '').trim().slice(0, 60);
  const view = String(record.Skyring ?? '').trim().slice(0, 100);
  const road = String(record.NrVegur ?? '').trim().slice(0, 8);
  const place = station || image.name;
  const label = view && view !== place ? view : place;
  return {
    id: cameraId,
    name: road ? `${road} ${label}` : label,
    city: 'Iceland',
    cityId: 'iceland',
    provider: 'Vegagerðin',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -15,
    fovDeg: 50,
    rangeM: 200,
    mountHeightM: 6,
    // KNOWN LIMITATION: one flat prior for a country whose road cameras run
    // from sea level to mountain passes near 700 m; the client's ground snap
    // corrects it wherever 3D tiles resolve.
    groundElevationM: 150,
    feedType: 'image',
    url: image.href,
    snapshotUrl: image.href,
    sourceKind: 'vegagerdin-gagnaveita',
    license:
      'Vegagerðin (Icelandic Road and Coastal Administration) web cameras, CC BY 4.0, retrieved live',
    code: cameraDisplayCode(place.toUpperCase()),
  };
}

/**
 * Fetch Icelandic road cameras from Vegagerðin's keyless gagnaveita service.
 * Frames are stills on www.vegagerdin.is.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadVegagerdinSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_VEGAGERDIN_URL || DEFAULT_VEGAGERDIN_CCTV_URL;
    const resp = await fetchCatalogWithRetry(endpoint);
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn('[CCTV] Vegagerðin catalog redirected; redirects are not followed');
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Vegagerðin camera download failed:', resp.status);
      return discard();
    }
    const payload = await readResponseJsonCapped(resp, VEGAGERDIN_MAX_CATALOG_BYTES);
    const records = Array.isArray(payload) ? payload : [];
    const cameras = [];
    const seen = new Set();
    for (const record of records) {
      const camera = vegagerdinCameraToSource(record);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      process.env.CCTV_VEGAGERDIN_MAX_SOURCES || DEFAULT_VEGAGERDIN_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
      : DEFAULT_VEGAGERDIN_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, ICELAND_ANCHORS);
    console.log(
      `[CCTV] Loaded Vegagerðin camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Vegagerðin camera download error:', describeFetchError(error));
    return [];
  }
}
