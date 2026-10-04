/**
 * NOAA CO-OPS tide gauges — teal discs on the globe.
 * Absolute water level (ft MLLW) drives disc size and color; Weather group toggle.
 */
import * as Cesium from 'cesium';
import { tideGaugeIntensityColorCss } from './parse.js';

export const TIDE_GAUGES_LAYER_ID = 'tide-gauges';
export const TIDE_GAUGES_OVERLAY_SOURCE_ID = 'tide-gauges';
export const TIDE_GAUGES_OVERLAY_COHORT_LIMIT = 36;
export const TIDE_GAUGES_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_RANK = Object.freeze({
  4: 34_000,
  3: 28_000,
  2: 22_000,
  1: 16_000,
  0: 12_000,
});

function colorFor(rank) {
  return Cesium.Color.fromCssColorString(tideGaugeIntensityColorCss(rank));
}

function formatFt(ft) {
  if (!Number.isFinite(ft)) return '';
  return `${ft.toFixed(2)} ft`;
}

function formatLabel(row) {
  const bits = [row.name || row.id];
  const level = formatFt(row.waterLevelFt);
  if (level) bits.push(level);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  const accent = tideGaugeIntensityColorCss(row.intensityRank);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatLabel(row),
    accent,
    priority:
      1000 +
      (Number(row.intensityRank) || 0) * 1000 +
      Math.min(999, Math.abs(Number(row.waterLevelFt) || 0) * 10),
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
    .slice(0, TIDE_GAUGES_OVERLAY_COHORT_LIMIT);
}

/** Build the NOAA tide-gauges globe layer. */
export function createTideGaugesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Tide gauges require a snapshot source');
  if (!overlayHost) throw new TypeError('Tide gauges require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: TIDE_GAUGES_LAYER_ID,
    name: 'Tide Gauges (NOAA)',
    icon: '🌊',
    source: 'NOAA CO-OPS',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Tide gauges layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(TIDE_GAUGES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(TIDE_GAUGES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(TIDE_GAUGES_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(TIDE_GAUGES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TIDE_GAUGES_OVERLAY_SOURCE_ID, false);
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
          const isHigh = rank >= 3;
          nextEntities.push(
            new Cesium.Entity({
              id: `tide-gauge:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isHigh ? 0.42 : 0.3),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: isHigh ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                id: row.id,
                name: row.name,
                state: row.state,
                observedAt: row.observedAt,
                waterLevelFt: row.waterLevelFt,
                datum: row.datum,
                intensityRank: rank,
              },
            }),
          );
          if (rank >= 2 && Number.isFinite(row.waterLevelFt)) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            TIDE_GAUGES_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: TIDE_GAUGES_OVERLAY_COHORT_LIMIT,
              collisionCapacity: TIDE_GAUGES_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:TideGauges] Updated: ${count} gauges`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:TideGauges] Fetch error:', error);
        lastError = error?.message || 'Tide gauges source unavailable';
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
      overlayHost.clearSource(TIDE_GAUGES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TIDE_GAUGES_OVERLAY_SOURCE_ID, false);
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

export { createTideGaugesSource } from './source.js';
export {
  normalizeTideGauges,
  parseTideStation,
  parseTideLevelPayload,
  tideGaugeIntensityColorCss,
  tideGaugeIntensityRank,
  tideGaugeLatestUrl,
  TIDE_STATIONS_URL,
  TIDE_DATAGETTER_BASE,
} from './parse.js';
