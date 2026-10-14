/**
 * Utility-scale power plants (WRI GPPD, ≥ 250 MW) — points colored by fuel,
 * sized by capacity. Infrastructure group toggle.
 */
import * as Cesium from 'cesium';

/** Largest plants keep exact ground clamping; see update(). */
export const MAX_CLAMPED_PLANTS = 1500;
import { powerPlantColorCss, powerPlantPixelSize } from './parse.js';

export const POWER_PLANTS_LAYER_ID = 'power-plants';

/** Build the power plants globe layer. */
export function createPowerPlantsLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Power plants requires a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let loaded = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: POWER_PLANTS_LAYER_ID,
    name: 'Power Plants (WRI)',
    icon: '⚡',
    source: 'WRI Global Power Plant Database',
    updateInterval: 24 * 60 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Power plants layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(POWER_PLANTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      if (loaded) return true;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const payload = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const next = [];
        // Ground-clamping re-queries the photoreal mesh for every clamped
        // point on every tile load; ~4.8k clamped points pinned the main
        // thread. Clamp only the largest plants; the rest draw unclamped and
        // ignore depth so they read the same from regional/global altitude.
        const clampIds = new Set(
          rows
            .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
            .sort(
              (x, y) =>
                (Number(y.capacityMw) || 0) - (Number(x.capacityMw) || 0),
            )
            .slice(0, MAX_CLAMPED_PLANTS)
            .map((r) => r.stableId),
        );
        for (const row of rows) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const clamped = clampIds.has(row.stableId);
          const color = Cesium.Color.fromCssColorString(
            powerPlantColorCss(row.kind),
          );
          next.push(
            new Cesium.Entity({
              id: `power-plant:${row.stableId}`,
              name: row.name,
              position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
              point: {
                pixelSize: powerPlantPixelSize(row.capacityMw),
                color: color.withAlpha(0.85),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
                heightReference: clamped
                  ? Cesium.HeightReference.CLAMP_TO_GROUND
                  : Cesium.HeightReference.NONE,
                disableDepthTestDistance: clamped
                  ? undefined
                  : Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(
                  2.0e5,
                  1.4,
                  1.5e7,
                  0.6,
                ),
              },
              properties: {
                name: row.name,
                capacityMw: row.capacityMw,
                fuel: row.fuel,
                country: row.country,
                commissioned: row.commissioned,
                owner: row.owner,
              },
            }),
          );
        }
        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of next) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        loaded = next.length > 0;
        count = next.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:PowerPlants] Updated: ${count} plants`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:PowerPlants] Fetch error:', error);
        lastError = error?.message || 'Power plants source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      viewer = null;
      enabled = false;
      loaded = false;
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

export { createPowerPlantsSource } from './source.js';
export {
  normalizePowerPlants,
  powerPlantKind,
  powerPlantColorCss,
  POWER_PLANTS_URL,
} from './parse.js';
