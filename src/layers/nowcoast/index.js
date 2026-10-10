/**
 * NOAA nowCOAST observed weather drapes — MRMS radar, lightning density and
 * GOES infrared — as keyless WMS imagery on the active map stack.
 *
 * Sources (U.S. Government, public; credit NOAA/NWS nowCOAST):
 *   weather_radar/ows      conus_base_reflectivity_mosaic (MRMS, ~1 km, ~4 min)
 *   lightning_detection/ows ldn_lightning_strike_density (15-min, derived
 *                           from Vaisala NLDN/GLD360; NOAA Level-5 product)
 *   satellite/ows          goes_longwave_imagery (GOES-19/18 Band 14, ~5 min)
 * nowCOAST answers `Access-Control-Allow-Origin: *`, so tiles go straight
 * from NOAA to the browser — no proxy, no key.
 *
 * Product choice (layers, styles, coverage, WMS 1.1.1 EPSG:4326 capped at
 * level 6) follows bilawalsidhu/gods-eye-view v0.2.0 (MIT, © 2026 Bilawal
 * Sidhu) `server/providers/weather.js` + DATA_SOURCES.md. The drape lifecycle
 * mirrors GodsEye's Observed Weather layer (src/layers/weather).
 */
import * as Cesium from 'cesium';
import { resolveImageryHost, NO_IMAGERY_HOST } from '../../maps/imageryHost.js';

const NOWCOAST = 'https://nowcoast.noaa.gov/geoserver/observations';
const REFRESH_MS = 5 * 60_000;
/** Keep the outgoing frame until the new one has had time to paint. */
const SWAP_HOLD_MS = 6000;

export const NOWCOAST_PRODUCTS = Object.freeze({
  'weather-radar': Object.freeze({
    name: 'Weather Radar',
    icon: '🌧',
    source: 'NOAA nowCOAST · MRMS radar (CONUS)',
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    alpha: 0.8,
    maxLevel: 6,
    rectangle: { west: -130, south: 20, east: -60, north: 55 },
  }),
  'weather-lightning': Object.freeze({
    name: 'Lightning',
    icon: '⚡',
    source: 'NOAA nowCOAST · 15-min lightning density',
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    alpha: 0.9,
    maxLevel: 6,
    // Advertised extent (Pacific/Americas network coverage inside it).
    rectangle: { west: -180, south: -25.5, east: 180, north: 80.5 },
  }),
  'weather-satellite': Object.freeze({
    name: 'Satellite Clouds',
    icon: '🛰',
    source: 'NOAA nowCOAST · GOES-East/West infrared',
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    alpha: 0.55,
    maxLevel: 6,
    // Advertised GOES regional extent (checked 2026-10-10).
    rectangle: { west: -180, south: 10.5, east: -50.5, north: 51 },
  }),
});

/** Five-minute bucket so Cesium's tile cache picks up the newest frame. */
export function frameBucket(nowMs) {
  return Math.floor(nowMs / REFRESH_MS);
}

function createProvider(cesium, product, bucket, rect) {
  return new cesium.WebMapServiceImageryProvider({
    url: `${NOWCOAST}/${product.service}/ows`,
    layers: product.layer,
    parameters: {
      service: 'WMS',
      version: '1.1.1',
      styles: product.style || '',
      format: 'image/png',
      transparent: 'true',
      // Ignored by GeoServer; keys the browser/Cesium tile cache per frame.
      gev: String(bucket),
    },
    tilingScheme: new cesium.GeographicTilingScheme(),
    maximumLevel: product.maxLevel,
    enablePickFeatures: false,
    credit: 'NOAA nowCOAST',
    ...(rect
      ? {
          rectangle: cesium.Rectangle.fromDegrees(
            rect.west,
            rect.south,
            rect.east,
            rect.north,
          ),
        }
      : {}),
  });
}

/** Create one nowCOAST observed-weather drape layer. */
export function createNowcoastLayer({
  id,
  cesium = Cesium,
  host = resolveImageryHost,
  now = () => Date.now(),
} = {}) {
  const product = NOWCOAST_PRODUCTS[id];
  if (!product) throw new TypeError(`Unknown nowCOAST product: ${id}`);
  let viewer = null;
  let tileset = null;
  let enabled = false;
  let destroyed = false;
  let lastUpdate = null;
  let error = null;
  /** @type {{bucket: number, collection: object, layers: object[]}|null} */
  let current = null;
  /** Outgoing frames waiting for SWAP_HOLD_MS. */
  const retiring = new Set();

  function removeFrame(frame) {
    for (const imagery of frame.layers.splice(0)) {
      try {
        frame.collection?.remove(imagery, true);
      } catch {
        /* host already gone */
      }
    }
  }

  function clearAll() {
    for (const entry of retiring) {
      clearTimeout(entry.timer);
      removeFrame(entry.frame);
    }
    retiring.clear();
    if (current) removeFrame(current);
    current = null;
  }

  function sync({ force = false } = {}) {
    if (!enabled || destroyed || !viewer) {
      clearAll();
      return false;
    }
    const resolved = host({ viewer, tileset });
    if (!resolved.collection) {
      clearAll();
      error = NO_IMAGERY_HOST;
      return false;
    }
    const bucket = frameBucket(now());
    if (
      !force &&
      current &&
      current.collection === resolved.collection &&
      current.bucket === bucket
    ) {
      return true;
    }
    const rects = [product.rectangle || null];
    const frame = { bucket, collection: resolved.collection, layers: [] };
    for (const rect of rects) {
      const imagery = new cesium.ImageryLayer(
        createProvider(cesium, product, bucket, rect),
        { alpha: product.alpha },
      );
      resolved.collection.add(imagery);
      frame.layers.push(imagery);
    }
    const previous = current;
    current = frame;
    if (previous) {
      if (previous.collection !== frame.collection) removeFrame(previous);
      else {
        const entry = { frame: previous, timer: null };
        entry.timer = setTimeout(() => {
          retiring.delete(entry);
          removeFrame(previous);
        }, SWAP_HOLD_MS);
        retiring.add(entry);
      }
    }
    lastUpdate = Date.now();
    error = null;
    return true;
  }

  return {
    id,
    name: product.name,
    icon: product.icon,
    source: product.source,
    updateInterval: REFRESH_MS,
    init(nextViewer) {
      if (viewer) throw new Error(`${id} layer is already initialized`);
      viewer = nextViewer;
    },
    attachTileset(next) {
      tileset = next || null;
      if (enabled) sync({ force: true });
    },
    attachMapStackController(controller) {
      controller?.subscribe?.(() => {
        if (enabled) sync({ force: true });
      });
    },
    enable() {
      enabled = true;
      sync();
    },
    disable() {
      enabled = false;
      clearAll();
    },
    async update() {
      if (!enabled) return false;
      return sync();
    },
    destroy() {
      if (destroyed) return;
      enabled = false;
      clearAll();
      viewer = null;
      tileset = null;
      destroyed = true;
    },
    getStats() {
      return {
        count: current ? current.layers.length : 0,
        lastUpdate,
        error,
      };
    },
  };
}
