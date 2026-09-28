/**
 * NOAA SWPC OVATION aurora forecast layer — intensity-colored discs on the globe.
 * Soft green → cyan → magenta by OVATION intensity. Toggleable; off by default.
 */
import * as Cesium from 'cesium';
import { auroraColorCss, auroraBand } from './parse.js';

export const AURORA_LAYER_ID = 'aurora';
export const AURORA_OVERLAY_SOURCE_ID = 'aurora';
export const AURORA_OVERLAY_COHORT_LIMIT = 48;
export const AURORA_OVERLAY_COLLISION_CAPACITY = 28;

function colorFor(aurora) {
  return Cesium.Color.fromCssColorString(auroraColorCss(aurora));
}

function radiusFor(aurora) {
  const a = Number(aurora) || 0;
  if (a >= 15) return 55_000;
  if (a >= 10) return 42_000;
  if (a >= 5) return 32_000;
  return 24_000;
}

function createOverlayEntry(row, position) {
  const accent = auroraColorCss(row.aurora);
  const band = row.band || auroraBand(row.aurora);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: `Aurora ${band} · ${row.aurora}`,
    accent,
    priority: 1000 + Number(row.aurora || 0) * 10,
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
    .slice(0, AURORA_OVERLAY_COHORT_LIMIT);
}

/** Build the OVATION aurora globe layer. */
export function createAuroraLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aurora requires a snapshot source');
  if (!overlayHost) throw new TypeError('Aurora requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let forecastTime = null;

  const layer = {
    id: AURORA_LAYER_ID,
    name: 'Aurora (OVATION)',
    icon: '🌌',
    source: 'NOAA SWPC OVATION',
    updateInterval: 10 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Aurora layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(AURORA_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(AURORA_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
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
          const aurora = Number(row.aurora);
          if (!Number.isFinite(aurora)) continue;
          const color = colorFor(aurora);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = radiusFor(aurora);
          const isHot = aurora >= 10;
          nextEntities.push(
            new Cesium.Entity({
              id: `aurora:${row.stableId}`,
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
                aurora,
                band: row.band || auroraBand(aurora),
                observationTime: payload.observationTime || null,
                forecastTime: payload.forecastTime || null,
              },
            }),
          );
          if (aurora >= 8) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            AURORA_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: AURORA_OVERLAY_COHORT_LIMIT,
              collisionCapacity: AURORA_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        forecastTime = payload.forecastTime || null;
        lastUpdate = Date.now();
        lastError = null;
        console.log(
          `[Data:Aurora] Updated: ${count} cells (forecast ${forecastTime || 'n/a'})`,
        );
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Aurora] Fetch error:', error);
        lastError = error?.message || 'Aurora source unavailable';
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
      overlayHost.clearSource(AURORA_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
      forecastTime = null;
    },

    getStats() {
      return {
        count,
        lastUpdate,
        lastError,
        enabled,
        forecastTime,
      };
    },
  };

  return layer;
}

export { createOvationAuroraSource } from './source.js';
export {
  normalizeOvationAurora,
  auroraColorCss,
  auroraBand,
  OVATION_URL,
} from './parse.js';
