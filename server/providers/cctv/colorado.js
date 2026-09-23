import {
  DEFAULT_COLORADO_ROWS_URL,
  COLORADO_IMAGE_ORIGIN,
  DEFAULT_COLORADO_MAX_SOURCES,
  COLORADO_ANCHORS,
  COLORADO_MAX_CATALOG_BYTES,
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

/** Colorado's state rectangle, with slack at each edge for cameras sited on an
 * interstate a little past the line. */
export function isLikelyColoradoCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 36.8 &&
    lat <= 41.2 &&
    lon >= -109.3 &&
    lon <= -101.9
  );
}

/**
 * Pin one Colorado view's still-frame URL to the CARS frame host.
 *
 * A `WMP` view streams HLS from one of several publicstreamer hosts and carries
 * its still separately as `videoPreviewUrl`; a `STILL_IMAGE` view has no
 * preview and carries the still as `url`. Taking the preview first is what
 * keeps both shapes on the one pinned origin — reading `url` first would hand
 * an .m3u8 playlist to an image pipeline.
 *
 * @param {object} view - One entry from a feature's `views` array.
 * @returns {?string} Pinned HTTPS still URL, or null when unusable.
 */
export function normalizeColoradoImageUrl(view) {
  const raw = String(view?.videoPreviewUrl || view?.url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.protocol = 'https:';
  const upgraded = parsed.toString();
  return upgraded.startsWith(COLORADO_IMAGE_ORIGIN) ? upgraded : null;
}

/**
 * Stable camera id from a pinned still URL.
 *
 * The frame filename is CDOT's own camera code ("025S21695CAM1ML2" =
 * I-25 southbound, milepost 216.95), which is stable across catalog refreshes
 * and unique per view. The numeric feature `id` is NOT usable here: 161
 * features publish more than one view, and each view is its own camera in the
 * catalog, so keying on the feature would collapse them.
 *
 * @param {string} imageUrl - A normalized Colorado frame URL.
 * @returns {?string} Provider-stable id, or null when underivable.
 */
export function coloradoCameraId(imageUrl) {
  const text = String(imageUrl ?? '').trim();
  if (!text) return null;
  let pathname;
  try {
    pathname = new URL(text).pathname;
  } catch {
    return null;
  }
  const slug = pathname
    .replace(/^.*\//, '')
    .replace(/\.[a-z0-9.]+$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
  return slug ? `colorado-${slug}` : null;
}

/**
 * Label for one Colorado camera. CDOT's names are already operator-readable
 * ("I-70 MP 192.10 WB : 1.8 miles E Vail Pass Summit"); the per-view name is
 * preferred because a multi-view feature gives each view its own.
 *
 * @param {object} feature - The GeoJSON feature.
 * @param {object} view - The view within that feature.
 * @param {string} cameraId - Derived stable id.
 * @returns {string}
 */
export function coloradoCameraName(feature, view, cameraId) {
  const viewName = String(view?.name ?? '').trim();
  if (viewName) return viewName;
  const featureName = String(feature?.properties?.name ?? '').trim();
  if (featureName) return featureName;
  return `Colorado Camera ${String(cameraId).replace(/^colorado-/, '')}`;
}

/**
 * One COtrip GeoJSON feature -> one catalog source per usable view.
 *
 * NO HEADING IS DERIVED FROM THE RECORD. Names carry a travel direction ("WB",
 * "SB") and the feature carries a `route`, but that is the direction of the
 * ROADWAY the camera watches, not the bearing the camera faces — a WB-signed
 * camera is usually aimed back along the road, and plenty are aimed across it.
 * Handing that token to directionToHeading() would return a confident bearing
 * for nearly every row and most would be wrong, so headings use the shared
 * id-hash fallback at low confidence, as the Calgary and TfL packs do, and the
 * operator corrects them with the calibration gizmo.
 *
 * @param {object} feature - Raw GeoJSON feature.
 * @returns {Array<object>} Zero or more camera source objects.
 */
export function coloradoFeatureToSources(feature) {
  if (!feature || typeof feature !== 'object') return [];
  const properties = feature.properties;
  if (!properties || properties.public === false) return [];
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const lon = toFiniteNumber(coordinates[0]);
  const lat = toFiniteNumber(coordinates[1]);
  if (!isLikelyColoradoCoordinate(lat, lon)) return [];

  const views = Array.isArray(properties.views) ? properties.views : [];
  const sources = [];
  for (const view of views) {
    if (!view || view.broken === true) continue;
    const imageUrl = normalizeColoradoImageUrl(view);
    if (!imageUrl) continue;
    const cameraId = coloradoCameraId(imageUrl);
    if (!cameraId) continue;
    const name = coloradoCameraName(feature, view, cameraId);
    const owner = String(properties.cameraOwner ?? '').trim();

    sources.push({
      id: cameraId,
      name,
      city: 'Colorado',
      cityId: 'colorado',
      provider: owner || 'Colorado DOT',
      lat,
      lon,
      headingDeg: fallbackHeadingFromId(cameraId),
      headingConfidence: 'low',
      pitchDeg: -18,
      fovDeg: 44,
      rangeM: 145,
      mountHeightM: 8,
      // Colorado spans roughly 1,000 m on the eastern plains to over 3,500 m on
      // the I-70 passes, so no single prior is close everywhere. This is the
      // Front Range corridor, where most of the cameras are; the client's
      // one-shot ground snap corrects it wherever 3D tiles are loaded.
      groundElevationM: 1650,
      feedType: 'image',
      url: imageUrl,
      snapshotUrl: imageUrl,
      sourceKind: 'colorado-cotrip',
      license: 'Colorado Department of Transportation / COtrip public feed',
      code: cameraDisplayCode(name.toUpperCase()),
    });
  }
  return sources;
}

/**
 * Fetch Colorado (CDOT) traffic cameras from the keyless COtrip 511 GeoJSON
 * feed. Frames are stills on cocam.carsprogram.org.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadColoradoSourcesFromOpenData() {
  try {
    const endpoint =
      process.env.CCTV_COLORADO_ROWS_URL || DEFAULT_COLORADO_ROWS_URL;
    const resp = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    // A response this loader will not read still owns its transport until the
    // body is released, so every rejection path cancels before returning.
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Colorado catalog redirected; redirects are not followed',
      );
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Colorado camera download failed:', resp.status);
      return discard();
    }
    const payload = await readResponseJsonCapped(
      resp,
      COLORADO_MAX_CATALOG_BYTES,
    );
    const features = Array.isArray(payload?.features) ? payload.features : null;
    if (!features) return [];
    const cameras = [];
    const seen = new Set();
    for (const feature of features) {
      for (const camera of coloradoFeatureToSources(feature)) {
        if (seen.has(camera.id)) continue;
        seen.add(camera.id);
        cameras.push(camera);
      }
    }
    const maxRaw = Number(
      process.env.CCTV_COLORADO_MAX_SOURCES || DEFAULT_COLORADO_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1400, Math.floor(maxRaw)))
      : DEFAULT_COLORADO_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, COLORADO_ANCHORS);
    console.log(
      `[CCTV] Loaded Colorado camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Colorado camera download error:',
      error?.message || error,
    );
    return [];
  }
}
