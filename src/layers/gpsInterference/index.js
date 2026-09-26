/**
 * GPS / GNSS interference layer — medium/high hexes from gpsjam.org.
 * Renders H3 res-4 polygons on the globe (yellow = medium, red = high).
 */
import * as Cesium from 'cesium';

export const GPS_INTERFERENCE_LAYER_ID = 'gps-interference';
export const GPS_INTERFERENCE_OVERLAY_SOURCE_ID = 'gps-interference';
export const GPS_INTERFERENCE_OVERLAY_COHORT_LIMIT = 64;
export const GPS_INTERFERENCE_OVERLAY_COLLISION_CAPACITY = 32;

const LEVEL_COLORS = {
  high: Cesium.Color.fromCssColorString('#FF2244'),
  medium: Cesium.Color.fromCssColorString('#FFCC33'),
  low: Cesium.Color.fromCssColorString('#44AA66'),
};

function levelColor(level) {
  return LEVEL_COLORS[level] || LEVEL_COLORS.medium;
}

function createOverlayEntry(row, position) {
  const color = levelColor(row.level);
  const title =
    row.level === 'high'
      ? `GPS jam HIGH · ${row.pct}%`
      : `GPS jam MED · ${row.pct}%`;
  return {
    id: String(row.stableId || row.h3),
    position,
    variant: 'label',
    title,
    accent: color.toCssColorString(),
    priority: row.level === 'high' ? 3000 + row.pct : 1000 + row.pct,
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
    .slice(0, GPS_INTERFERENCE_OVERLAY_COHORT_LIMIT);
}

/** Build the GPS interference globe layer. */
export function createGpsInterferenceLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GPS interference requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('GPS interference requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let feedDate = null;

  const layer = {
    id: GPS_INTERFERENCE_LAYER_ID,
    name: 'GPS Interference',
    icon: '📡',
    source: 'gpsjam.org · ADS-B accuracy',
    updateInterval: 60 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('GPS interference layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(GPS_INTERFERENCE_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(GPS_INTERFERENCE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(GPS_INTERFERENCE_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(GPS_INTERFERENCE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GPS_INTERFERENCE_OVERLAY_SOURCE_ID, false);
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

        const nextEntities = [];
        const overlayEntries = [];
        for (const row of payload.rows || []) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const color = levelColor(row.level);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const hierarchy =
            Array.isArray(row.ring) && row.ring.length >= 3
              ? Cesium.Cartesian3.fromDegreesArray(row.ring.flat())
              : null;

          const entity = new Cesium.Entity({
            id: `gpsjam:${row.stableId || row.h3}`,
            position,
            properties: {
              h3: row.h3,
              level: row.level,
              pct: row.pct,
              good: row.good,
              bad: row.bad,
              total: row.total,
              date: payload.date || null,
            },
          });

          if (hierarchy) {
            entity.polygon = {
              hierarchy,
              material: color.withAlpha(row.level === 'high' ? 0.45 : 0.32),
              outline: true,
              outlineColor: color.withAlpha(0.85),
              outlineWidth: row.level === 'high' ? 2 : 1,
              height: 0,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            };
          } else {
            // Fallback disc if a hex boundary failed server-side.
            const radiusM = row.level === 'high' ? 45_000 : 35_000;
            entity.ellipse = {
              semiMajorAxis: radiusM,
              semiMinorAxis: radiusM,
              material: color.withAlpha(0.4),
              outline: true,
              outlineColor: color.withAlpha(0.8),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            };
          }

          nextEntities.push(entity);
          if (row.level === 'high') {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            GPS_INTERFERENCE_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: GPS_INTERFERENCE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: GPS_INTERFERENCE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        feedDate = payload.date || null;
        lastUpdate = Date.now();
        lastError = null;
        console.log(
          `[Data:GpsInterference] Updated: ${count} hexes (${feedDate || 'unknown date'})`,
        );
        return true;
      } catch (err) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        lastError = err?.message || 'GPS interference unavailable';
        console.warn('[Data:GpsInterference] Fetch error:', err);
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      overlayHost.clearSource(GPS_INTERFERENCE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GPS_INTERFERENCE_OVERLAY_SOURCE_ID, false);
      if (dataSource && nextViewer) {
        nextViewer.dataSources.remove(dataSource, true);
      }
      dataSource = null;
      viewer = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
      feedDate = null;
    },

    getStats() {
      return {
        count,
        lastUpdate,
        error: lastError,
        date: feedDate,
      };
    },
  };

  return layer;
}

export { createGpsjamSource } from './source.js';
export {
  parseGpsjamCsv,
  latestGpsjamDate,
} from './parse.js';
