import {
  DEFAULT_IOWADOT_CCTV_URL,
  IOWADOT_IMAGE_ORIGIN,
  DEFAULT_IOWADOT_MAX_SOURCES,
  IOWADOT_MAX_CATALOG_BYTES,
  IOWA_ANCHORS,
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
        '[CCTV] Iowa DOT catalog fetch retry', attempt, describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** Iowa's state rectangle, with slack for cameras on a border bridge. */
export function isLikelyIowaCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 40.3 &&
    lat <= 43.6 &&
    lon >= -96.8 &&
    lon <= -90.0
  );
}

/**
 * Pin one Iowa DOT still URL to the agency snapshot tree.
 * The feed mixes `SNAPSHOTS/PUBLIC` and `snapshots/Public` casing and serves
 * both; anything outside that tree, off-host, or carrying credentials is
 * refused. http is upgraded to https.
 *
 * @param {unknown} raw
 * @returns {?string}
 */
export function normalizeIowaDotImageUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    return null;
  parsed.protocol = 'https:';
  if (parsed.port) return null;
  const href = parsed.toString();
  if (!href.startsWith(IOWADOT_IMAGE_ORIGIN)) return null;
  if (!/^\/snapshots\/public\/[A-Za-z0-9_./-]+\.jpe?g$/i.test(parsed.pathname))
    return null;
  if (parsed.pathname.includes('..')) return null;
  return href;
}

/**
 * One Iowa DOT feature (attributes) -> one catalog source, or null.
 * The description names the place ("DM - I-235 @ 42nd St") but no bearing,
 * so the heading is the shared id-hash fallback at low confidence.
 *
 * @param {object} feature - ArcGIS JSON feature `{ attributes }`.
 * @returns {?object}
 */
export function iowaDotCameraToSource(feature) {
  const a = feature?.attributes;
  if (!a || typeof a !== 'object') return null;
  const lat = toFiniteNumber(a.latitude);
  const lon = toFiniteNumber(a.longitude);
  if (!isLikelyIowaCoordinate(lat, lon)) return null;
  const imageUrl = normalizeIowaDotImageUrl(a.ImageURL);
  if (!imageUrl) return null;
  const rawId = String(a.COMMON_ID || a.device_id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(rawId)) return null;
  const cameraId = `us-iowadot-${rawId.toLowerCase()}`;
  const desc = String(a.Desc_ ?? '').trim().slice(0, 120);
  const name = desc || `Iowa DOT ${rawId}`;
  // "DM - I-235 @ 42nd St" -> label code from the part after the region tag.
  const codeText = name.replace(/^[A-Z0-9]{1,4}\s+-\s+/, '');
  return {
    id: cameraId,
    name,
    city: 'Iowa',
    cityId: 'iowa',
    provider: 'Iowa DOT',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 160,
    mountHeightM: 12,
    // Iowa runs ~145 m (Mississippi) to ~510 m (northwest); most cameras sit
    // on metro interstates near 250–350 m. The client's ground snap corrects
    // it wherever 3D tiles are loaded.
    groundElevationM: 290,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'iowadot-open-data',
    license:
      'Iowa Department of Transportation — Traffic Cameras open data, CC BY 4.0',
    code: cameraDisplayCode(codeText.toUpperCase()),
  };
}

/**
 * Fetch Iowa DOT traffic cameras from the keyless open-data feature service.
 * Frames are stills on atmsqf.iowadot.gov.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadIowaDotSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_IOWADOT_URL || DEFAULT_IOWADOT_CCTV_URL;
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
      console.warn('[CCTV] Iowa DOT catalog redirected; redirects are not followed');
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Iowa DOT camera download failed:', resp.status);
      return discard();
    }
    const payload = await readResponseJsonCapped(resp, IOWADOT_MAX_CATALOG_BYTES);
    const features = Array.isArray(payload?.features) ? payload.features : [];
    const cameras = [];
    const seen = new Set();
    for (const feature of features) {
      const camera = iowaDotCameraToSource(feature);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      process.env.CCTV_IOWADOT_MAX_SOURCES || DEFAULT_IOWADOT_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
      : DEFAULT_IOWADOT_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, IOWA_ANCHORS);
    console.log(
      `[CCTV] Loaded Iowa DOT camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Iowa DOT camera download error:', describeFetchError(error));
    return [];
  }
}
