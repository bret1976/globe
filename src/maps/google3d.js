import { isConstrainedGlobeClient } from '../app/clientCapabilities.js';
const clean = (value) => String(value || '').trim();

/** Sharper than Cesium's default 16 so cockpit windshields stay readable. */
export const PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR = 4;
/** Phones keep a coarser error so fewer tiles fight for GPU memory. */
export const PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR = 12;
/** Desktop ion cache (bytes). Matches prior production budget. */
export const PHOTOREAL_DESKTOP_CACHE_BYTES = 1536 * 1024 * 1024;
export const PHOTOREAL_DESKTOP_CACHE_OVERFLOW_BYTES = 1024 * 1024 * 1024;
/** Phone ion cache — large enough to orbit, small enough for Safari. */
export const PHOTOREAL_MOBILE_CACHE_BYTES = 192 * 1024 * 1024;
export const PHOTOREAL_MOBILE_CACHE_OVERFLOW_BYTES = 64 * 1024 * 1024;

function photorealTilesetOptions({ constrained = false } = {}) {
  if (constrained) {
    return {
      cacheBytes: PHOTOREAL_MOBILE_CACHE_BYTES,
      maximumCacheOverflowBytes: PHOTOREAL_MOBILE_CACHE_OVERFLOW_BYTES,
      enableCollision: true,
      maximumScreenSpaceError: PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR,
    };
  }
  return {
    cacheBytes: PHOTOREAL_DESKTOP_CACHE_BYTES,
    maximumCacheOverflowBytes: PHOTOREAL_DESKTOP_CACHE_OVERFLOW_BYTES,
    enableCollision: true,
    maximumScreenSpaceError: PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR,
  };
}

/**
 * Decide which map provider can deliver the best startup experience.
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {'google-direct'|'google-ion'|'osm'}
 */
export function selectMapStartupRoute({
  googleApiKey = '',
  cesiumToken = '',
} = {}) {
  if (clean(googleApiKey)) return 'google-direct';
  if (clean(cesiumToken)) return 'google-ion';
  return 'osm';
}

/**
 * Load Google Photorealistic 3D Tiles through direct Google access when
 * configured, otherwise through Cesium ion's hosted Google asset. If the
 * direct request fails and an ion token is available, ion is the recovery path.
 *
 * @param {object} Cesium
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {Promise<{tileset: object|null, route: 'google-direct'|'google-ion'|'osm', errors: Error[]}>}
 */
export async function loadPhotorealisticTileset(
  Cesium,
  { googleApiKey = '', cesiumToken = '' } = {},
) {
  const googleKey = clean(googleApiKey);
  const ionToken = clean(cesiumToken);
  const errors = [];

  const attempts = [];
  if (googleKey) attempts.push({ route: 'google-direct', googleKey });
  if (ionToken) attempts.push({ route: 'google-ion', googleKey: undefined });

  const constrained = isConstrainedGlobeClient();
  for (const attempt of attempts) {
    try {
      const tileset = attempt.googleKey
        ? await createGoogleDirectTileset(Cesium, attempt.googleKey, {
            constrained,
          })
        : await createGoogleIonTileset(Cesium, ionToken, { constrained });
      return { tileset, route: attempt.route, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { tileset: null, route: 'osm', errors };
}

/** Pass credentials to the source instead of changing SDK-wide defaults. */
export function createGoogleDirectTileset(Cesium, key, { constrained } = {}) {
  key = clean(key);
  if (!key) throw new Error('Google 3D requires an explicit browser key');
  const isConstrained = constrained ?? isConstrainedGlobeClient();
  return Cesium.createGooglePhotorealistic3DTileset({
    key,
    onlyUsingWithGoogleGeocoder: true,
    maximumScreenSpaceError: isConstrained
      ? PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR
      : PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR,
  });
}

export async function createGoogleIonTileset(
  Cesium,
  accessToken,
  { signal, constrained } = {},
) {
  accessToken = clean(accessToken);
  if (!accessToken)
    throw new Error('Google 3D through ion requires an explicit token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(2275207, {
    accessToken,
  });
  signal?.throwIfAborted();
  const isConstrained = constrained ?? isConstrainedGlobeClient();
  // Desktop keeps the sharp multi-GB cache; phones get a Safari-safe budget.
  return Cesium.Cesium3DTileset.fromUrl(
    resource,
    photorealTilesetOptions({ constrained: isConstrained }),
  );
}
