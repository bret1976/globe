import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WSDOT_CCTV_URL,
  WSDOT_IMAGE_ORIGIN,
  DEFAULT_WSDOT_MAX_SOURCES,
  WSDOT_MAX_CATALOG_BYTES,
  WSDOT_ANCHORS,
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

function isRetryableNetworkError(error) {
  return error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message));
}

export function describeFetchError(error) {
  const cause = error?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
  return detail ? `${error?.message || error} (${detail})` : String(error?.message || error);
}

async function fetchCatalogWithRetry(endpoint, { attempts = 3, pauseMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(endpoint, {
        headers: { Accept: 'application/json,application/geo+json,*/*', 'User-Agent': CATALOG_USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) throw error;
      console.warn(
        '[CCTV] WSDOT catalog fetch retry',
        attempt,
        describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** Washington state rectangle with slack for Columbia River / border bridges. */
export function isLikelyWashingtonCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 45.54 &&
    lat <= 49.1 &&
    lon >= -125.0 &&
    lon <= -116.7
  );
}

/**
 * Pin one WSDOT still URL to images.wsdot.wa.gov.
 * Drop tripcheck.com / Oregon TripCheck URLs (already in the oregon pack) and
 * every other off-host still. Credentials, query strings, ports, and .. paths
 * are refused. http is upgraded to https.
 *
 * @param {unknown} raw
 * @returns {?string}
 */
export function normalizeWsdotImageUrl(raw) {
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
  if (parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'images.wsdot.wa.gov') return null;
  parsed.protocol = 'https:';
  parsed.hostname = 'images.wsdot.wa.gov';
  if (!/^\/[A-Za-z0-9_./-]+\.jpe?g$/i.test(parsed.pathname)) return null;
  if (parsed.pathname.includes('..')) return null;
  const href = parsed.toString();
  if (!href.startsWith(WSDOT_IMAGE_ORIGIN)) return null;
  return href;
}

/**
 * One WSDOT GeoJSON feature / snapshot row → catalog source, or null.
 * @param {object} feature
 * @returns {?object}
 */
export function wsdotCameraToSource(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const props = feature.properties && typeof feature.properties === 'object'
    ? feature.properties
    : feature;
  const coords = feature.geometry?.coordinates;
  const lat = toFiniteNumber(
    props.latitude ?? props.Latitude ?? (Array.isArray(coords) ? coords[1] : null),
  );
  const lon = toFiniteNumber(
    props.longitude ?? props.Longitude ?? (Array.isArray(coords) ? coords[0] : null),
  );
  if (!isLikelyWashingtonCoordinate(lat, lon)) return null;
  const imageUrl = normalizeWsdotImageUrl(props.ImageURL ?? props.imageURL);
  if (!imageUrl) return null;
  const title = String(props.CameraTitle || props.cameraTitle || '').trim();
  if (!title || title.length > 140) return null;
  const objectId = props.OBJECTID ?? props.objectId ?? props.ObjectID;
  let cameraId;
  if (Number.isFinite(Number(objectId))) {
    cameraId = `us-wsdot-${Math.trunc(Number(objectId))}`;
  } else {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (!slug) return null;
    cameraId = `us-wsdot-${slug}`;
  }
  const compass = String(props.CompassDirection || '').trim().toUpperCase();
  const headingFromCompass = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  }[compass];
  return {
    id: cameraId,
    name: title.slice(0, 140),
    city: 'Washington',
    cityId: 'wsdot',
    provider: 'WSDOT',
    lat,
    lon,
    headingDeg: Number.isFinite(headingFromCompass)
      ? headingFromCompass
      : fallbackHeadingFromId(cameraId),
    headingConfidence: Number.isFinite(headingFromCompass) ? 'medium' : 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 160,
    mountHeightM: 12,
    groundElevationM: 50,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'wsdot-travel-info',
    license:
      'Washington State Department of Transportation — Travel Info cameras (public)',
    code: cameraDisplayCode(title.toUpperCase()),
  };
}

function sourcesFromWsdotRows(rows) {
  const cameras = [];
  const seen = new Set();
  for (const item of Array.isArray(rows) ? rows : []) {
    const camera = wsdotCameraToSource(item);
    if (!camera || seen.has(camera.id)) continue;
    seen.add(camera.id);
    cameras.push(camera);
  }
  return cameras;
}

function loadWsdotSnapshotRows() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, 'wsdot.snapshot.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function capWsdotSources(cameras) {
  const maxRaw = Number(
    process.env.CCTV_WSDOT_MAX_SOURCES || DEFAULT_WSDOT_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
    : DEFAULT_WSDOT_MAX_SOURCES;
  return prioritizeSources(cameras, maxCount, WSDOT_ANCHORS);
}

/**
 * Fetch WSDOT Travel Info cameras from the keyless ArcGIS FeatureServer.
 * Falls back to the bundled snapshot when Railway Asia (or similar) cannot
 * reach data.wsdot.wa.gov. TripCheck / Oregon URLs in the same feed are dropped.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadWsdotSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_WSDOT_URL || DEFAULT_WSDOT_CCTV_URL;
    const resp = await fetchCatalogWithRetry(endpoint);
    const discardBody = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] WSDOT catalog redirected; redirects are not followed',
      );
      await discardBody();
    } else if (!resp.ok) {
      console.warn('[CCTV] WSDOT camera download failed:', resp.status);
      await discardBody();
    } else {
      const payload = await readResponseJsonCapped(
        resp,
        WSDOT_MAX_CATALOG_BYTES,
      );
      const features = Array.isArray(payload?.features) ? payload.features : [];
      const cameras = sourcesFromWsdotRows(features);
      if (cameras.length) {
        const prioritized = capWsdotSources(cameras);
        console.log(
          `[CCTV] Loaded WSDOT camera sources: ${cameras.length} live (using nearest ${prioritized.length})`,
        );
        return prioritized;
      }
      console.warn('[CCTV] WSDOT live catalog was empty');
    }
  } catch (error) {
    console.warn(
      '[CCTV] WSDOT camera download error:',
      describeFetchError(error),
    );
  }
  const snapshot = sourcesFromWsdotRows(loadWsdotSnapshotRows());
  if (snapshot.length) {
    const prioritized = capWsdotSources(snapshot);
    console.warn(
      `[CCTV] WSDOT using bundled snapshot: ${snapshot.length} cameras (using nearest ${prioritized.length})`,
    );
    return prioritized;
  }
  return [];
}
