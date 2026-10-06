/**
 * Surface ocean currents — arrows on a global 6° grid, colored and sized by
 * speed, pointing where the water flows. Weather group toggle.
 */
import * as Cesium from 'cesium';
import {
  oceanCurrentArrowKm,
  oceanCurrentColorCss,
  offsetByBearing,
} from './parse.js';

export const OCEAN_CURRENTS_LAYER_ID = 'ocean-currents';

const WIDTH_BY_RANK = Object.freeze({ 4: 14, 3: 12, 2: 10, 1: 8, 0: 7 });
const ARROW_HEIGHT_M = 2_000;

/** Build the surface ocean currents globe layer. */
export function createOceanCurrentsLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ocean currents requires a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let partialRetry = null;

  const layer = {
    id: OCEAN_CURRENTS_LAYER_ID,
    name: 'Ocean Currents',
    icon: '🌊',
    source: 'Open-Meteo Marine',
    updateInterval: 60 * 60_000,

    init(nextViewer) {
      if (viewer)
        throw new Error('Ocean currents layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(OCEAN_CURRENTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      clearTimeout(partialRetry);
      partialRetry = null;
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const payload = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const next = [];
        for (const row of rows) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const [lat2, lon2] = offsetByBearing(
            row.lat,
            row.lon,
            row.directionDeg,
            oceanCurrentArrowKm(row.speedKmh),
          );
          const rank = Number(row.rank) || 0;
          const color = Cesium.Color.fromCssColorString(
            oceanCurrentColorCss(rank),
          );
          next.push(
            new Cesium.Entity({
              id: `ocean-current:${row.stableId}`,
              position: Cesium.Cartesian3.fromDegrees(
                row.lon,
                row.lat,
                ARROW_HEIGHT_M,
              ),
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                  row.lon,
                  row.lat,
                  ARROW_HEIGHT_M,
                  lon2,
                  lat2,
                  ARROW_HEIGHT_M,
                ]),
                width: WIDTH_BY_RANK[rank] ?? 7,
                arcType: Cesium.ArcType.GEODESIC,
                material: new Cesium.PolylineArrowMaterialProperty(
                  color.withAlpha(rank >= 3 ? 0.95 : 0.75),
                ),
              },
              properties: {
                speedKmh: row.speedKmh,
                directionDeg: row.directionDeg,
                rank,
                observedAt: row.observedAt,
              },
            }),
          );
        }
        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of next) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        count = next.length;
        lastUpdate = Date.now();
        clearTimeout(partialRetry);
        partialRetry = null;
        if (payload?.partial)
          partialRetry = setTimeout(() => {
            partialRetry = null;
            layer.update();
          }, 45_000);
        lastError = null;
        console.log(`[Data:OceanCurrents] Updated: ${count} arrows`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:OceanCurrents] Fetch error:', error);
        lastError = error?.message || 'Ocean currents source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      clearTimeout(partialRetry);
      partialRetry = null;
      request?.abort();
      request = null;
      viewer = null;
      enabled = false;
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return { count, lastUpdate, lastError, enabled };
    },
  };

  return layer;
}

export { createOceanCurrentsSource } from './source.js';
export {
  normalizeOceanCurrents,
  oceanCurrentRank,
  oceanCurrentColorCss,
  offsetByBearing,
  OCEAN_CURRENTS_URL,
} from './parse.js';
