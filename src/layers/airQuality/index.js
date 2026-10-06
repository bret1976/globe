/**
 * Sensor.Community air quality — AQI-colored discs pooled from live PM2.5 sensors.
 * Median PM2.5 per 0.5° cell drives color and size; Weather group toggle.
 */
import * as Cesium from 'cesium';
import { airQualityColorCss } from './parse.js';

export const AIR_QUALITY_LAYER_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_COHORT_LIMIT = 36;
export const AIR_QUALITY_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_RANK = Object.freeze({
  5: 30_000,
  4: 27_000,
  3: 24_000,
  2: 21_000,
  1: 17_000,
  0: 14_000,
});

function colorFor(rank) {
  return Cesium.Color.fromCssColorString(airQualityColorCss(rank));
}

function formatLabel(row) {
  const bits = [`PM2.5 ${Number(row.pm25).toFixed(0)} µg/m³`];
  if (row.category) bits.push(row.category);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatLabel(row),
    accent: airQualityColorCss(row.intensityRank),
    priority:
      1000 +
      (Number(row.intensityRank) || 0) * 1000 +
      Math.min(999, Number(row.pm25) || 0),
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
    .slice(0, AIR_QUALITY_OVERLAY_COHORT_LIMIT);
}

/** Build the Sensor.Community air-quality globe layer. */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: AIR_QUALITY_LAYER_ID,
    name: 'Air Quality (Sensor.Community)',
    icon: '🌫️',
    source: 'Sensor.Community',
    updateInterval: 10 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Air quality layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(AIR_QUALITY_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
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
          const rank = Number(row.intensityRank) || 0;
          const color = colorFor(rank);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_RANK[rank] ?? RADIUS_BY_RANK[0];
          const isBad = rank >= 3;
          nextEntities.push(
            new Cesium.Entity({
              id: `air-quality:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isBad ? 0.45 : 0.3),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: isBad ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                pm25: row.pm25,
                pm10: row.pm10,
                sensors: row.sensors,
                country: row.country,
                category: row.category,
                observedAt: row.observedAt,
                intensityRank: rank,
              },
            }),
          );
          if (rank >= 2) overlayEntries.push(createOverlayEntry(row, position));
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            AIR_QUALITY_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
              collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:AirQuality] Updated: ${count} cells`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:AirQuality] Fetch error:', error);
        lastError = error?.message || 'Air quality source unavailable';
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
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
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

export { createAirQualitySource } from './source.js';
export {
  normalizeAirQuality,
  parseAirQualityRecord,
  airQualityRank,
  airQualityLabel,
  airQualityColorCss,
  AIR_QUALITY_URL,
} from './parse.js';
