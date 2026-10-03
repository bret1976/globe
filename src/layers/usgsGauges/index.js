/**
 * USGS stream-gauge discharge observations — blue discs on the globe.
 * Discharge intensity drives disc size and color; Weather group toggle.
 */
import * as Cesium from 'cesium';
import { usgsGaugeIntensityColorCss } from './parse.js';

export const USGS_GAUGES_LAYER_ID = 'usgs-gauges';
export const USGS_GAUGES_OVERLAY_SOURCE_ID = 'usgs-gauges';
export const USGS_GAUGES_OVERLAY_COHORT_LIMIT = 36;
export const USGS_GAUGES_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_RANK = Object.freeze({
  4: 36_000,
  3: 28_000,
  2: 22_000,
  1: 16_000,
  0: 12_000,
});

function colorFor(rank) {
  return Cesium.Color.fromCssColorString(usgsGaugeIntensityColorCss(rank));
}

function formatCfs(cfs) {
  if (!Number.isFinite(cfs)) return '';
  if (cfs >= 10_000) return `${Math.round(cfs).toLocaleString('en-US')} cfs`;
  if (cfs >= 100) return `${Math.round(cfs)} cfs`;
  return `${cfs.toFixed(1)} cfs`;
}

function formatLabel(row) {
  const bits = [row.siteNumber || row.siteId];
  const flow = formatCfs(row.cfs);
  if (flow) bits.push(flow);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  const accent = usgsGaugeIntensityColorCss(row.intensityRank);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatLabel(row),
    accent,
    priority: 1000 + (Number(row.intensityRank) || 0) * 1000 + Math.min(999, Number(row.cfs) || 0) / 100,
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
    .slice(0, USGS_GAUGES_OVERLAY_COHORT_LIMIT);
}

/** Build the USGS stream-gauges globe layer. */
export function createUsgsGaugesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('USGS gauges require a snapshot source');
  if (!overlayHost) throw new TypeError('USGS gauges require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: USGS_GAUGES_LAYER_ID,
    name: 'Stream Gauges (USGS)',
    icon: '💧',
    source: 'USGS Water Data',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('USGS gauges layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(USGS_GAUGES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(USGS_GAUGES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(USGS_GAUGES_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(USGS_GAUGES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(USGS_GAUGES_OVERLAY_SOURCE_ID, false);
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
              id: `usgs-gauge:${row.stableId}`,
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
                siteId: row.siteId,
                siteNumber: row.siteNumber,
                observedAt: row.observedAt,
                cfs: row.cfs,
                unit: row.unit,
                intensityRank: rank,
              },
            }),
          );
          if (rank >= 2) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            USGS_GAUGES_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: USGS_GAUGES_OVERLAY_COHORT_LIMIT,
              collisionCapacity: USGS_GAUGES_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:UsgsGauges] Updated: ${count} gauges`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:UsgsGauges] Fetch error:', error);
        lastError = error?.message || 'USGS gauges source unavailable';
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
      overlayHost.clearSource(USGS_GAUGES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(USGS_GAUGES_OVERLAY_SOURCE_ID, false);
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

export { createUsgsGaugesSource } from './source.js';
export {
  normalizeUsgsGauges,
  parseUsgsGaugeFeature,
  usgsGaugeIntensityColorCss,
  usgsGaugeIntensityRank,
  usgsGaugesFirstPageUrl,
  usgsGaugesNextHref,
  USGS_LATEST_CONTINUOUS_URL,
  USGS_STREAMFLOW_PARAMETER,
} from './parse.js';
