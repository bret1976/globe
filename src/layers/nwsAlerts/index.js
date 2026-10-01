/**
 * NWS active weather alerts — severity-colored discs on the globe.
 * Extreme/Severe/Moderate/Minor; US polygon + point alerts only.
 */
import * as Cesium from 'cesium';
import { nwsSeverityColorCss } from './parse.js';

export const NWS_ALERTS_LAYER_ID = 'nws-alerts';
export const NWS_ALERTS_OVERLAY_SOURCE_ID = 'nws-alerts';
export const NWS_ALERTS_OVERLAY_COHORT_LIMIT = 40;
export const NWS_ALERTS_OVERLAY_COLLISION_CAPACITY = 28;

const RADIUS_BY_SEVERITY = Object.freeze({
  Extreme: 70_000,
  Severe: 55_000,
  Moderate: 40_000,
  Minor: 28_000,
  Unknown: 24_000,
});

function colorFor(severity) {
  return Cesium.Color.fromCssColorString(nwsSeverityColorCss(severity));
}

function createOverlayEntry(row, position) {
  const accent = nwsSeverityColorCss(row.severity);
  const title = `${row.event} · ${row.severity}`;
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title,
    accent,
    priority: 1000 + (Number(row.severityRank) || 0) * 1000,
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
    .slice(0, NWS_ALERTS_OVERLAY_COHORT_LIMIT);
}

/** Build the NWS weather-alerts globe layer. */
export function createNwsAlertsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('NWS alerts require a snapshot source');
  if (!overlayHost) throw new TypeError('NWS alerts require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: NWS_ALERTS_LAYER_ID,
    name: 'Weather Alerts (NWS)',
    icon: '⚠️',
    source: 'NWS api.weather.gov',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('NWS alerts layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(NWS_ALERTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(NWS_ALERTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(NWS_ALERTS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(NWS_ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NWS_ALERTS_OVERLAY_SOURCE_ID, false);
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
          const color = colorFor(row.severity);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM =
            RADIUS_BY_SEVERITY[row.severity] || RADIUS_BY_SEVERITY.Unknown;
          const isHigh =
            row.severity === 'Extreme' || row.severity === 'Severe';
          nextEntities.push(
            new Cesium.Entity({
              id: `nws-alert:${row.stableId}`,
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
                event: row.event,
                severity: row.severity,
                urgency: row.urgency,
                certainty: row.certainty,
                headline: row.headline,
                areaDesc: row.areaDesc,
                sent: row.sent,
                onset: row.onset,
                ends: row.ends,
              },
            }),
          );
          if (isHigh || row.severity === 'Moderate') {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            NWS_ALERTS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: NWS_ALERTS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: NWS_ALERTS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:NwsAlerts] Updated: ${count} alerts`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:NwsAlerts] Fetch error:', error);
        lastError = error?.message || 'NWS alerts source unavailable';
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
      overlayHost.clearSource(NWS_ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NWS_ALERTS_OVERLAY_SOURCE_ID, false);
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

export { createNwsAlertsSource } from './source.js';
export {
  normalizeNwsAlerts,
  nwsSeverityColorCss,
  geometryCentroid,
  NWS_ALERTS_URL,
} from './parse.js';
