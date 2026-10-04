/**
 * U.S. Drought Monitor — amber/red discs at MultiPolygon part centroids.
 * DM 0–4 intensity; Events group toggle (distinct from GDACS flood/drought points).
 */
import * as Cesium from 'cesium';
import { usdmColorCss } from './parse.js';

export const USDM_DROUGHT_LAYER_ID = 'usdm-drought';
export const USDM_DROUGHT_OVERLAY_SOURCE_ID = 'usdm-drought';
export const USDM_DROUGHT_OVERLAY_COHORT_LIMIT = 40;
export const USDM_DROUGHT_OVERLAY_COLLISION_CAPACITY = 28;

const RADIUS_BY_DM = Object.freeze({
  4: 48_000,
  3: 40_000,
  2: 32_000,
  1: 26_000,
  0: 20_000,
});

function colorFor(dm) {
  return Cesium.Color.fromCssColorString(usdmColorCss(dm));
}

function createOverlayEntry(row, position) {
  const accent = usdmColorCss(row.dm);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: row.label || `D${row.dm}`,
    accent,
    priority: 1000 + (Number(row.dm) || 0) * 1000,
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
    .slice(0, USDM_DROUGHT_OVERLAY_COHORT_LIMIT);
}

/** Build the USDM drought globe layer. */
export function createUsdmDroughtLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('USDM drought requires a snapshot source');
  if (!overlayHost) throw new TypeError('USDM drought requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: USDM_DROUGHT_LAYER_ID,
    name: 'Drought Monitor (USDM)',
    icon: '🏜️',
    source: 'U.S. Drought Monitor',
    updateInterval: 6 * 60 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('USDM drought layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(USDM_DROUGHT_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(USDM_DROUGHT_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(USDM_DROUGHT_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(USDM_DROUGHT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(USDM_DROUGHT_OVERLAY_SOURCE_ID, false);
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
          const dm = Number(row.dm) || 0;
          const color = colorFor(dm);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_DM[dm] ?? RADIUS_BY_DM[0];
          const isHigh = dm >= 3;
          nextEntities.push(
            new Cesium.Entity({
              id: `usdm:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isHigh ? 0.45 : 0.32),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: isHigh ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                dm,
                label: row.label,
                intensityRank: dm,
              },
            }),
          );
          if (dm >= 2) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            USDM_DROUGHT_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: USDM_DROUGHT_OVERLAY_COHORT_LIMIT,
              collisionCapacity: USDM_DROUGHT_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:UsdmDrought] Updated: ${count} drought centroids`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:UsdmDrought] Fetch error:', error);
        lastError = error?.message || 'USDM drought source unavailable';
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
      overlayHost.clearSource(USDM_DROUGHT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(USDM_DROUGHT_OVERLAY_SOURCE_ID, false);
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

export { createUsdmDroughtSource } from './source.js';
export {
  normalizeUsdmDrought,
  parseUsdmFeature,
  usdmColorCss,
  usdmLabel,
  USDM_PRIMARY_URL,
  USDM_FALLBACK_URL,
} from './parse.js';
