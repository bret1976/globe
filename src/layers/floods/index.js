/**
 * GDACS Orange/Red floods & droughts — alert-colored discs on the globe.
 * Blue-cyan for floods, amber-brown for droughts; Red/Orange severity rings.
 */
import * as Cesium from 'cesium';
import { gdacsAlertColorCss } from './parse.js';

export const FLOODS_LAYER_ID = 'floods';
export const FLOODS_OVERLAY_SOURCE_ID = 'floods';
export const FLOODS_OVERLAY_COHORT_LIMIT = 40;
export const FLOODS_OVERLAY_COLLISION_CAPACITY = 28;

const RADIUS_BY_ALERT = Object.freeze({
  RED: 70_000,
  ORANGE: 52_000,
  GREEN: 36_000,
});

function fillColorFor(row) {
  if (row.eventType === 'DR') {
    // Drought: earthy amber distinct from flood cyan
    return row.alertLevel === 'RED'
      ? Cesium.Color.fromCssColorString('#C45A12')
      : Cesium.Color.fromCssColorString('#D4892A');
  }
  // Flood: cyan/teal family, intensity by alert
  return row.alertLevel === 'RED'
    ? Cesium.Color.fromCssColorString('#1E90FF')
    : Cesium.Color.fromCssColorString('#33B5E5');
}

function outlineColorFor(row) {
  return Cesium.Color.fromCssColorString(gdacsAlertColorCss(row.alertLevel));
}

function createOverlayEntry(row, position) {
  const accent = gdacsAlertColorCss(row.alertLevel);
  const title = `${row.eventTypeLabel} · ${row.alertLevel}${row.country ? ` · ${row.country}` : ''}`;
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title,
    accent,
    priority:
      row.alertLevel === 'RED'
        ? 4000
        : row.alertLevel === 'ORANGE'
          ? 3000
          : 2000,
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
    .slice(0, FLOODS_OVERLAY_COHORT_LIMIT);
}

/** Build the GDACS floods & droughts globe layer. */
export function createFloodsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Floods require a snapshot source');
  if (!overlayHost) throw new TypeError('Floods require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: FLOODS_LAYER_ID,
    name: 'Floods & Droughts (GDACS)',
    icon: '🌊',
    source: 'GDACS',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Floods layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(FLOODS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(FLOODS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(FLOODS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(FLOODS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLOODS_OVERLAY_SOURCE_ID, false);
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
          const fill = fillColorFor(row);
          const outline = outlineColorFor(row);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_ALERT[row.alertLevel] || RADIUS_BY_ALERT.ORANGE;
          const isHigh = row.alertLevel === 'RED' || row.alertLevel === 'ORANGE';
          nextEntities.push(
            new Cesium.Entity({
              id: `flood:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: fill.withAlpha(isHigh ? 0.4 : 0.3),
                outline: true,
                outlineColor: outline.withAlpha(0.92),
                outlineWidth: isHigh ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                eventType: row.eventType,
                eventTypeLabel: row.eventTypeLabel,
                eventId: row.eventId,
                name: row.name,
                country: row.country,
                alertLevel: row.alertLevel,
                alertScore: row.alertScore,
                fromDate: row.fromDate,
                toDate: row.toDate,
                reportUrl: row.reportUrl,
                geometryUrl: row.geometryUrl,
                detailsUrl: row.detailsUrl,
              },
            }),
          );
          overlayEntries.push(createOverlayEntry(row, position));
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            FLOODS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: FLOODS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: FLOODS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Floods] Updated: ${count} GDACS FL/DR`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Floods] Fetch error:', error);
        lastError = error?.message || 'Floods source unavailable';
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
      overlayHost.clearSource(FLOODS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLOODS_OVERLAY_SOURCE_ID, false);
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
