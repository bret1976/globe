/**
 * Safecast radiation layer — CPM-colored discs on the globe.
 * Green (normal) → yellow → orange → red (hot). Toggleable; off by default.
 */
import * as Cesium from 'cesium';
import { radiationColorCss, radiationBand } from './parse.js';

export const RADIATION_LAYER_ID = 'radiation';
export const RADIATION_OVERLAY_SOURCE_ID = 'radiation';
export const RADIATION_OVERLAY_COHORT_LIMIT = 40;
export const RADIATION_OVERLAY_COLLISION_CAPACITY = 26;

function colorFor(cpm) {
  return Cesium.Color.fromCssColorString(radiationColorCss(cpm));
}

function radiusFor(cpm) {
  const v = Number(cpm) || 0;
  if (v >= 150) return 55_000;
  if (v >= 80) return 42_000;
  if (v >= 40) return 32_000;
  return 24_000;
}

function createOverlayEntry(row, position) {
  const accent = radiationColorCss(row.cpm);
  const band = row.band || radiationBand(row.cpm);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: `Radiation ${band} · ${row.cpm} ${row.unit || 'cpm'}`,
    accent,
    priority: 1000 + Number(row.cpm || 0),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

function selectOverlayCohort(entries) {
  return [...entries]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, RADIATION_OVERLAY_COHORT_LIMIT);
}

/** Build the Safecast radiation globe layer. */
export function createRadiationLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Radiation requires a snapshot source');
  if (!overlayHost) throw new TypeError('Radiation requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: RADIATION_LAYER_ID,
    name: 'Radiation (Safecast)',
    icon: '☢️',
    source: 'Safecast',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Radiation layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(RADIATION_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(RADIATION_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(RADIATION_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(RADIATION_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RADIATION_OVERLAY_SOURCE_ID, false);
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
        const nextEntities = [];
        const overlayEntries = [];
        for (const row of rows) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const cpm = Number(row.cpm);
          if (!Number.isFinite(cpm)) continue;
          const color = colorFor(cpm);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = radiusFor(cpm);
          const isHot = cpm >= 80;
          nextEntities.push(
            new Cesium.Entity({
              id: `radiation:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isHot ? 0.48 : 0.34),
                outline: true,
                outlineColor: color.withAlpha(0.85),
                outlineWidth: isHot ? 2 : 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                cpm,
                unit: row.unit || 'cpm',
                band: row.band || radiationBand(cpm),
                capturedAt: row.capturedAt || null,
              },
            }),
          );
          if (cpm >= 40) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            RADIATION_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: RADIATION_OVERLAY_COHORT_LIMIT,
              collisionCapacity: RADIATION_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Radiation] Updated: ${count} cells`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Radiation] Fetch error:', error);
        lastError = error?.message || 'Radiation source unavailable';
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
      overlayHost.clearSource(RADIATION_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RADIATION_OVERLAY_SOURCE_ID, false);
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return {
        count,
        lastUpdate,
        lastError,
        enabled,
      };
    },
  };

  return layer;
}

export { createSafecastRadiationSource } from './source.js';
export {
  normalizeSafecastMeasurements,
  radiationColorCss,
  radiationBand,
  SAFECAST_MEASUREMENTS_URL,
} from './parse.js';
