import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NYCTMC_CCTV_URL,
  NYCTMC_IMAGE_ORIGIN,
  DEFAULT_NYCTMC_MAX_SOURCES,
  NYCTMC_MAX_CATALOG_BYTES,
  NYC_ANCHORS,
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

const NYCTMC_SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'nyctmc.snapshot.json',
);

function isRetryableNetworkError(error) {
  return (
    error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message))
  );
}

export function describeFetchError(error) {
  const cause = error?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
  return detail
    ? `${error?.message || error} (${detail})`
    : String(error?.message || error);
}

async function fetchCatalogWithRetry(
  endpoint,
  { attempts = 3, pauseMs = 1500 } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          'User-Agent': CATALOG_USER_AGENT,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) throw error;
      console.warn(
        '[CCTV] NYC TMC catalog fetch retry',
        attempt,
        describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** NYC five-borough box with slack for bridges/tunnels. */
export function isLikelyNycCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 40.45 &&
    lat <= 41.0 &&
    lon >= -74.35 &&
    lon <= -73.65
  );
}

/**
 * Pin one NYC TMC still URL to the agency image API.
 * Accepts the catalog imageUrl or rebuilds from the camera UUID.
 *
 * @param {unknown} raw
 * @param {string} [cameraUuid]
 * @returns {?string}
 */
export function normalizeNycTmcImageUrl(raw, cameraUuid = '') {
  const value = String(raw ?? '').trim();
  if (value) {
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
    if (parsed.hostname !== 'webcams.nyctmc.org') return null;
    if (
      !/^\/api\/cameras\/[0-9a-f-]{36}\/image$/i.test(parsed.pathname)
    )
      return null;
    if (parsed.pathname.includes('..')) return null;
    return parsed.toString();
  }
  const id = String(cameraUuid || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return `${NYCTMC_IMAGE_ORIGIN}${id}/image`;
}

/**
 * One NYC TMC camera object → catalog source, or null.
 * @param {object} camera
 */
export function nycTmcCameraToSource(camera) {
  if (!camera || typeof camera !== 'object') return null;
  const lat = toFiniteNumber(camera.latitude);
  const lon = toFiniteNumber(camera.longitude);
  if (!isLikelyNycCoordinate(lat, lon)) return null;
  const rawId = String(camera.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(rawId)) return null;
  const imageUrl = normalizeNycTmcImageUrl(camera.imageUrl, rawId);
  if (!imageUrl) return null;
  const name = String(camera.name || '').trim().slice(0, 140) || `NYC TMC ${rawId.slice(0, 8)}`;
  const area = String(camera.area || '').trim().slice(0, 40);
  const online =
    camera.isOnline === true ||
    String(camera.isOnline || '').toLowerCase() === 'true';
  const cameraId = `us-nyctmc-${rawId.toLowerCase()}`;
  return {
    id: cameraId,
    name: area ? `${name} (${area})` : name,
    city: 'New York City',
    cityId: 'nyc',
    provider: 'NYC TMC',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 140,
    mountHeightM: 10,
    // NYC street level ~0–50 m; client ground snap corrects with 3D tiles.
    groundElevationM: 15,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'nyctmc-open-data',
    license:
      'NYC DOT Traffic Management Center — public traffic camera stills (webcams.nyctmc.org)',
    code: cameraDisplayCode(name.toUpperCase()),
    online,
  };
}

/**
 * Fetch NYC TMC traffic cameras from the keyless JSON catalog.
 * Frames are still JPEGs on webcams.nyctmc.org.
 *
 * @returns {Promise<Array<object>>}
 */

/** Cap + prioritize a normalized NYC camera list. */
function capNycTmcSources(cameras) {
  const maxRaw = Number(
    process.env.CCTV_NYCTMC_MAX_SOURCES || DEFAULT_NYCTMC_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(8, Math.min(1200, Math.floor(maxRaw)))
    : DEFAULT_NYCTMC_MAX_SOURCES;
  return prioritizeSources(cameras, maxCount, NYC_ANCHORS);
}

/**
 * Read the shipped NYC TMC catalog snapshot (used when Railway/Asia cannot
 * reach webcams.nyctmc.org). Same shape as the live API rows.
 */
export function loadNycTmcSnapshotRows() {
  try {
    if (!fs.existsSync(NYCTMC_SNAPSHOT_PATH)) return [];
    const raw = fs.readFileSync(NYCTMC_SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] NYC TMC snapshot read failed:',
      error?.message || error,
    );
    return [];
  }
}

/** Normalize a list of raw NYC TMC camera objects into catalog sources. */
export function sourcesFromNycTmcRows(rows) {
  const cameras = [];
  const seen = new Set();
  for (const item of Array.isArray(rows) ? rows : []) {
    const camera = nycTmcCameraToSource(item);
    if (!camera || seen.has(camera.id)) continue;
    seen.add(camera.id);
    cameras.push(camera);
  }
  cameras.sort((a, b) => Number(b.online) - Number(a.online));
  return cameras;
}

export async function loadNycTmcSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_NYCTMC_URL || DEFAULT_NYCTMC_CCTV_URL;
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
        '[CCTV] NYC TMC catalog redirected; redirects are not followed',
      );
      await discardBody();
    } else if (!resp.ok) {
      console.warn('[CCTV] NYC TMC camera download failed:', resp.status);
      await discardBody();
    } else {
      const payload = await readResponseJsonCapped(
        resp,
        NYCTMC_MAX_CATALOG_BYTES,
      );
      const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.cameras)
          ? payload.cameras
          : [];
      const cameras = sourcesFromNycTmcRows(list);
      if (cameras.length) {
        const prioritized = capNycTmcSources(cameras);
        console.log(
          `[CCTV] Loaded NYC TMC camera sources: ${cameras.length} live (using nearest ${prioritized.length})`,
        );
        return prioritized;
      }
      console.warn('[CCTV] NYC TMC live catalog was empty');
    }
  } catch (error) {
    console.warn(
      '[CCTV] NYC TMC camera download error:',
      describeFetchError(error),
    );
  }
  // Railway Asia (and some other egress regions) often cannot open a TCP
  // session to webcams.nyctmc.org — same class of failure as Vegagerðin.
  // Fall back to the shipped catalog so NYC still appears on the globe;
  // frame fetches may still miss from those regions, but markers remain.
  const snapshot = sourcesFromNycTmcRows(loadNycTmcSnapshotRows());
  if (snapshot.length) {
    const prioritized = capNycTmcSources(snapshot);
    console.warn(
      `[CCTV] NYC TMC using bundled snapshot: ${snapshot.length} cameras (using nearest ${prioritized.length})`,
    );
    return prioritized;
  }
  return [];
}
