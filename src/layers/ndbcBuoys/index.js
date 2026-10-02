/**
 * NOAA NDBC latest marine buoy observations — cyan discs on the globe.
 * Wind / wave intensity drives disc size and color; Weather group toggle.
 */
import * as Cesium from 'cesium';
import { ndbcIntensityColorCss } from './parse.js';

export const NDBC_BUOYS_LAYER_ID = 'ndbc-buoys';
export const NDBC_BUOYS_OVERLAY_SOURCE_ID = 'ndbc-buoys';
export const NDBC_BUOYS_OVERLAY_COHORT_LIMIT = 36;
export const NDBC_BUOYS_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_RANK = Object.freeze({
  4: 32_000,
  3: 26_000,
  2: 22_000,
  1: 18_000,
  0: 14_000,
});

function colorFor(rank) {
  return Cesium.Color.fromCssColorString(ndbcIntensityColorCss(rank));
}

function formatLabel(row) {
  const bits = [row.station];
  if (Number.isFinite(row.wspd)) bits.push(`${row.wspd.toFixed(1)} m/s`);
  if (Number.isFinite(row.wvht)) bits.push(`${row.wvht.toFixed(1)} m`);
  if (Number.isFinite(row.wtmp)) bits.push(`${row.wtmp.toFixed(1)}°C`);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  const accent = ndbcIntensityColorCss(row.intensityRank);
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatLabel(row),
    accent,
    priority: 1000 + (Number(row.intensityRank) || 0) * 1000,
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
    .slice(0, NDBC_BUOYS_OVERLAY_COHORT_LIMIT);
}

/** Build the NDBC marine-buoys globe layer. */
export function createNdbcBuoysLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('NDBC buoys require a snapshot source');
  if (!overlayHost) throw new TypeError('NDBC buoys require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: NDBC_BUOYS_LAYER_ID,
    name: 'Marine Buoys (NDBC)',
    icon: '⚓',
    source: 'NOAA NDBC',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('NDBC buoys layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(NDBC_BUOYS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(NDBC_BUOYS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(NDBC_BUOYS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(NDBC_BUOYS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NDBC_BUOYS_OVERLAY_SOURCE_ID, false);
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
              id: `ndbc-buoy:${row.stableId}`,
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
                station: row.station,
                observedAt: row.observedAt,
                wdir: row.wdir,
                wspd: row.wspd,
                gst: row.gst,
                wvht: row.wvht,
                dpd: row.dpd,
                pres: row.pres,
                atmp: row.atmp,
                wtmp: row.wtmp,
                tide: row.tide,
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
            NDBC_BUOYS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: NDBC_BUOYS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: NDBC_BUOYS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:NdbcBuoys] Updated: ${count} buoys`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:NdbcBuoys] Fetch error:', error);
        lastError = error?.message || 'NDBC buoys source unavailable';
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
      overlayHost.clearSource(NDBC_BUOYS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NDBC_BUOYS_OVERLAY_SOURCE_ID, false);
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

export { createNdbcBuoysSource } from './source.js';
export {
  normalizeNdbcBuoys,
  parseNdbcObsLine,
  ndbcIntensityColorCss,
  ndbcIntensityRank,
  NDBC_LATEST_OBS_URL,
} from './parse.js';
