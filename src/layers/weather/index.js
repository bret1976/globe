/**
 * Observed Weather layer — keyless NASA GIBS infrared draped on the globe.
 * Global VIIRS brightness-temperature for storm structure (works at night);
 * Himawari clean IR is used as a second drape over the Asia–Pacific basin
 * so the typhoon Shorts pack has a live W. Pacific cloud top.
 */
import * as Cesium from 'cesium';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { utcDay } from '../recentImagery/model.js';

export const WEATHER_LAYER_ID = 'weather';
const GIBS = 'https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best';
const PRODUCTS = Object.freeze([
  // Identifiers / tile-matrix sets are the ones GIBS' epsg3857 WMTS
  // capabilities advertise (checked 2026-10-07). The old Level8 VIIRS and
  // "Himawari_AHI_Band13_CleanInfrared" Level7 URLs answered HTTP 400
  // ("TILEMATRIXSET is invalid for LAYER") for every tile, so the row read
  // NOMINAL while nothing at all was draped on the globe.
  {
    id: 'viirs-ir',
    layer: 'VIIRS_NOAA21_Brightness_Temp_BandI5_Day',
    maxLevel: 9,
    format: 'png',
    alpha: 0.72,
  },
  {
    id: 'himawari-ir',
    layer: 'Himawari_AHI_Band13_Clean_Infrared',
    maxLevel: 6,
    // Sub-daily (10-minute) product that GIBS only retains for ~40 minutes
    // in this endpoint, so a calendar date 400s most of the day. "default"
    // is the WMTS time token for the newest frame.
    time: 'default',
    format: 'png',
    alpha: 0.55,
    rectangle: { west: 80, south: -60, east: -140, north: 60 },
  },
]);

function template(product, day) {
  return `${GIBS}/${product.layer}/default/${product.time || day}/GoogleMapsCompatible_Level${product.maxLevel}/{z}/{y}/{x}.${product.format}`;
}

function addLayer(cesium, collection, product, day) {
  const provider = new cesium.UrlTemplateImageryProvider({
    url: template(product, day),
    subdomains: ['a', 'b', 'c'],
    tilingScheme: new cesium.WebMercatorTilingScheme(),
    maximumLevel: product.maxLevel,
    credit: 'NASA GIBS',
    ...(product.rectangle
      ? {
          rectangle: cesium.Rectangle.fromDegrees(
            product.rectangle.west,
            product.rectangle.south,
            product.rectangle.east,
            product.rectangle.north,
          ),
        }
      : {}),
  });
  const layer = new cesium.ImageryLayer(provider, {
    alpha: product.alpha,
  });
  collection.add(layer);
  return layer;
}

/** Create the observed-weather layer. */
export function createWeatherLayer({
  cesium = Cesium,
  host = resolveImageryHost,
  now = () => new Date(),
} = {}) {
  let viewer = null;
  let tileset = null;
  let enabled = false;
  let destroyed = false;
  let lastUpdate = null;
  let error = null;
  const owned = [];

  function clearOwned() {
    for (const layer of owned.splice(0)) {
      try {
        layer.collection?.remove(layer.imagery, true);
      } catch {
        /* host already gone */
      }
    }
  }

  function sync() {
    clearOwned();
    if (!enabled || destroyed || !viewer) return false;
    const resolved = host({ viewer, tileset });
    if (!resolved.collection) {
      error = 'Hidden by this map source · choose a globe map';
      return false;
    }
    const day = utcDay(now());
    for (const product of PRODUCTS) {
      const imagery = addLayer(cesium, resolved.collection, product, day);
      owned.push({ imagery, collection: resolved.collection });
    }
    lastUpdate = Date.now();
    error = null;
    return true;
  }

  return {
    id: WEATHER_LAYER_ID,
    name: 'Observed Weather',
    icon: '🌩',
    source: 'NASA GIBS · VIIRS + Himawari IR',
    updateInterval: 10 * 60_000,
    init(nextViewer) {
      if (viewer) throw new Error('Weather layer is already initialized');
      viewer = nextViewer;
    },
    attachTileset(next) {
      tileset = next || null;
      if (enabled) sync();
    },
    attachMapStackController(controller) {
      controller?.subscribe?.(() => {
        if (enabled) sync();
      });
    },
    enable() {
      enabled = true;
      sync();
    },
    disable() {
      enabled = false;
      clearOwned();
    },
    async update() {
      if (!enabled) return false;
      return sync();
    },
    destroy() {
      if (destroyed) return;
      this.disable();
      viewer = null;
      tileset = null;
      destroyed = true;
    },
    getStats() {
      return {
        count: owned.length,
        lastUpdate,
        error,
      };
    },
  };
}
