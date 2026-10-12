import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OREGON_CCTV_URL,
  OREGON_IMAGE_ORIGIN,
  DEFAULT_OREGON_MAX_SOURCES,
  OREGON_MAX_CATALOG_BYTES,
  OREGON_ANCHORS,
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
        headers: { Accept: 'application/json', 'User-Agent': CATALOG_USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) throw error;
      console.warn(
        '[CCTV] Oregon TripCheck catalog fetch retry',
        attempt,
        describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** Oregon rectangle with slack for Columbia River / border bridges. */
export function isLikelyOregonCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 41.8 &&
    lat <= 46.4 &&
    lon >= -124.8 &&
    lon <= -116.4
  );
}

/**
 * Pin one TripCheck still URL to the roadcams tree.
 * Upstream often serves http://www.TripCheck.com/...; we upgrade to https and
 * normalize host case. Credentials, query strings, ports, and off-tree paths
 * are refused.
 *
 * @param {unknown} raw
 * @returns {?string}
 */
export function normalizeOregonImageUrl(raw) {
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
  if (host !== 'www.tripcheck.com' && host !== 'tripcheck.com') return null;
  parsed.protocol = 'https:';
  parsed.hostname = 'www.tripcheck.com';
  if (!/^\/roadcams\/cams\/[A-Za-z0-9_.-]+\.jpe?g$/i.test(parsed.pathname))
    return null;
  if (parsed.pathname.includes('..')) return null;
  const href = parsed.toString();
  if (!href.startsWith(OREGON_IMAGE_ORIGIN)) return null;
  return href;
}

/**
 * One ArcGIS attributes row → catalog source, or null.
 * @param {object} feature
 * @returns {?object}
 */
export function oregonCameraToSource(feature) {
  const a = feature?.attributes ?? feature;
  if (!a || typeof a !== 'object') return null;
  const lat = toFiniteNumber(a.latitude);
  const lon = toFiniteNumber(a.longitude);
  if (!isLikelyOregonCoordinate(lat, lon)) return null;
  const imageUrl = normalizeOregonImageUrl(a.cctv_url);
  if (!imageUrl) return null;
  const rawName = String(a.device_name || '').trim();
  if (!rawName || rawName.length > 120) return null;
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) return null;
  const cameraId = `us-oregon-${slug}`;
  const route = String(a.route_designator || '').trim();
  const name = route ? `${rawName} (${route})` : rawName;
  const codeText = route || rawName;
  return {
    id: cameraId,
    name: name.slice(0, 140),
    city: 'Oregon',
    cityId: 'oregon',
    provider: 'Oregon TripCheck',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 160,
    mountHeightM: 12,
    groundElevationM: 150,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'oregon-tripcheck-open-data',
    license: 'Oregon Department of Transportation — TripCheck public highway cameras',
    code: cameraDisplayCode(codeText.toUpperCase()),
  };
}

function sourcesFromOregonRows(rows) {
  const cameras = [];
  const seen = new Set();
  for (const item of Array.isArray(rows) ? rows : []) {
    const camera = oregonCameraToSource(
      item?.attributes ? item : { attributes: item },
    );
    if (!camera || seen.has(camera.id)) continue;
    seen.add(camera.id);
    cameras.push(camera);
  }
  return cameras;
}

function loadOregonSnapshotRows() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, 'oregon.snapshot.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function capOregonSources(cameras) {
  const maxRaw = Number(
    process.env.CCTV_OREGON_MAX_SOURCES || DEFAULT_OREGON_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
    : DEFAULT_OREGON_MAX_SOURCES;
  return prioritizeSources(cameras, maxCount, OREGON_ANCHORS);
}

/**
 * Fetch Oregon TripCheck cameras from the keyless ODOT ArcGIS inventory.
 * Falls back to the bundled snapshot when Railway Asia (or similar) cannot
 * reach gis.odot.state.or.us.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadOregonSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_OREGON_URL || DEFAULT_OREGON_CCTV_URL;
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
        '[CCTV] Oregon TripCheck catalog redirected; redirects are not followed',
      );
      await discardBody();
    } else if (!resp.ok) {
      console.warn('[CCTV] Oregon TripCheck camera download failed:', resp.status);
      await discardBody();
    } else {
      const payload = await readResponseJsonCapped(
        resp,
        OREGON_MAX_CATALOG_BYTES,
      );
      const features = Array.isArray(payload?.features) ? payload.features : [];
      const cameras = sourcesFromOregonRows(features);
      if (cameras.length) {
        const prioritized = capOregonSources(cameras);
        console.log(
          `[CCTV] Loaded Oregon TripCheck camera sources: ${cameras.length} live (using nearest ${prioritized.length})`,
        );
        return prioritized;
      }
      console.warn('[CCTV] Oregon TripCheck live catalog was empty');
    }
  } catch (error) {
    console.warn(
      '[CCTV] Oregon TripCheck camera download error:',
      describeFetchError(error),
    );
  }
  const snapshot = sourcesFromOregonRows(loadOregonSnapshotRows());
  if (snapshot.length) {
    const prioritized = capOregonSources(snapshot);
    console.warn(
      `[CCTV] Oregon TripCheck using bundled snapshot: ${snapshot.length} cameras (using nearest ${prioritized.length})`,
    );
    return prioritized;
  }
  return [];
}
